/**
 * 🗂️ 卡片自动分组：执行器 + 回滚（S2/S3/S4）
 * ═════════════════════════════════════════════════════════════════
 * 设计文档：`docs/技术支持/方案-卡片自动分组.md`（v2.0）
 * 实现规格：`docs/规格与计划/卡片自动分组-实现规格.md`
 *
 * 职责边界：
 *   · 判定（谁该去哪）→ `js/utils/autoGroup.js`（纯函数，已单测）
 *   · 落地（怎么搬）  → **必须复用 `useCardGroups.moveCardToGroup`**（它会迁移三类按 path 派生的键：
 *                       覆盖层 / 测卡会话与变量树 / 长期记忆）。**禁止**在此另写移动逻辑。
 *   · 本文件只做编排：扫描 → 预览 → 执行 → 写日志 → 回滚 + 空分组清理提示。
 *
 * 安全约定（方案 §3.10 / §4）：
 *   1. 没有扫描结果不许执行；执行前有原生二次确认。
 *   2. 默认只处理「未分类」卡片（includeGrouped=false）；勾选才碰已分组卡。
 *   3. 执行可中止（已完成的不回退；日志记录到哪一步）。
 *   4. 日志按「卡名 + fromGroup + toGroup」记录（不记绝对路径）；回滚**按卡名在当前库定位**，
 *      并将卡片变动（被移动/删除/分组改名）**单独列出**，不静默跳过、不中断整批。
 *   5. 回滚逆序处理日志（多轮移动时先还原最近一次），且同样走 `moveCardToGroup`（含空分组自动重建）。
 */
import { ref, computed } from 'vue';
import {
    normalizeGroupProfiles,
    buildAutoGroupPlan,
    normalizeAutoGroupLastRun,
    resolveRollbackCard,
    sanitizeFolderName,
    AUTO_GROUP_ROOT_GROUP
} from '../utils/autoGroup.js';
import {
    buildLlmGroupSpecs, llmSpecsSignature, llmCardCacheKey, collectLlmCandidates,
    buildLlmMessages, parseLlmJudgement, assignJudgements, LLM_DEFAULT_BATCH_SIZE
} from '../utils/autoGroupLLM.js'; // 🤖 LLM 判定层（纯函数）

export function useAutoGroup({
    // —— App.vue 持有并持久化的状态（随 app_config.json 落盘）——
    autoGroupProfiles,
    autoGroupLastRun,
    // —— 共享状态 ——
    library, allCategories, customCategories, currentCategoryKey, currentFolderPath, sanitizeImportedTags,
    // —— 工具 ——
    moveCardToGroup, buildGroupOptions, nativeAlert, confirmDialog, addLog, syncConfigToDiskDebounced,
    // —— 🤖 LLM 判定层：统一 API 通道（sendChatMessage：渲染层直接 fetch 会被 CORS 拦）——
    apiEndpoint, apiKey, apiType, resolveApiModel, extractReplyContent
}) {
    const showAutoGroupModal = ref(false);
    /** 最近一次扫描：{ at, includeGrouped, plan }（内存态；plan.moves 含卡片活引用，禁止序列化） */
    const autoGroupScan = ref(null);
    /** 执行进度/结果（一次性；弹窗展示） */
    const autoGroupExec = ref({ running: false, done: 0, total: 0, moved: 0, failed: 0, aborted: false, failures: [], finishedAt: 0 });
    /** 回滚进度/结果 */
    const autoGroupRollback = ref({ running: false, done: 0, total: 0, rolled: 0, failed: [], finishedAt: 0 });
    let execAbort = false;

    /** 可移动目标分组（与侧边栏同序——顺序即优先级） */
    const autoGroupGroupOptions = computed(() => {
        try { return buildGroupOptions() || []; } catch (e) { return []; }
    });

    // ==================== 🤖 LLM 判定层状态（建议默认不勾选；只喂未命中/冲突卡） ====================

    /** LLM 分辨进度/结果（一次性；弹窗展示） */
    const autoGroupLlm = ref({ running: false, done: 0, total: 0, requested: 0, suggested: 0, unmatched: 0, errors: [], lastAt: 0 });
    /** LLM 建议缓存（会话级；key 含规格签名 → 改分组/改标准即失效） */
    const llmCache = new Map();
    const LLM_CACHE_MAX = 800;
    let llmAbort = false;

    /** 重建计划的「目标分组汇总 + 计数」（LLM 合并后调用） */
    const rebuildPlanTargets = (plan) => {
        const counts = new Map();
        for (const m of plan.moves) counts.set(m.toGroup, (counts.get(m.toGroup) || 0) + 1);
        const known = new Set([
            ...autoGroupGroupOptions.value.map(o => o.value),
            ...library.value.map(c => c && c.subFolder).filter(Boolean)
        ]);
        plan.targetGroups = Array.from(counts.entries())
            .map(([name, count]) => {
                const folder = sanitizeFolderName(name);
                return { name, folder, renamed: folder !== name, isNew: !known.has(name) && !known.has(folder), count };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        plan.counters.willMove = plan.moves.length;
        plan.counters.skipped = plan.skipped.length;
        plan.counters.newFolders = plan.targetGroups.filter(g => g.isNew).length;
    };

    /** 把 LLM 建议合并进扫描计划（去重；规则命中行保持规则归属） */
    const mergeSuggestionsIntoPlan = (plan, suggestions) => {
        if (!plan || !Array.isArray(suggestions) || !suggestions.length) return plan;
        for (const s of suggestions) {
            const card = s.card;
            if (!card) continue;
            const current = card.subFolder || card.category || AUTO_GROUP_ROOT_GROUP;
            if (plan.moves.some(m => m.card === card)) continue; // 已有去向（规则命中优先）
            const si = plan.skipped.findIndex(x => x.cardId === card.id);
            if (si >= 0) plan.skipped.splice(si, 1);
            if (current === s.group) {
                plan.skipped.push({ cardId: card.id, cardName: String(card.name || '(未命名卡片)'), currentGroup: current, reason: `🤖 AI 判定：已在「${s.group}」` });
                continue;
            }
            plan.moves.push({
                cardId: card.id, cardName: String(card.name || '(未命名卡片)'),
                fromGroup: current, toGroup: s.group,
                reason: `🤖 AI 判定（置信度 ${Math.round((s.confidence || 0) * 100)}%）：${s.reason || '按判定标准归类'}`,
                profileId: `llm_${s.group}`, card,
                source: 'llm', llm: { confidence: s.confidence || 0, reason: s.reason || '' }
            });
        }
        rebuildPlanTargets(plan);
        return plan;
    };

    /** 扫描计划生成后：把缓存中的 LLM 建议自动合并（重扫/重开弹窗后建议不丢） */
    const mergeCachedSuggestions = (plan, profiles) => {
        try {
            const specs = buildLlmGroupSpecs(profiles);
            if (!specs.length) return;
            const sig = llmSpecsSignature(specs);
            const cands = collectLlmCandidates({ plan, cards: library.value });
            const sug = [];
            for (const cnd of cands) {
                const hit = llmCache.get(llmCardCacheKey(cnd.card, sig));
                if (hit) sug.push({ card: cnd.card, group: hit.group, confidence: hit.confidence, reason: hit.reason });
            }
            if (sug.length) mergeSuggestionsIntoPlan(plan, sug);
        } catch (e) { /* 缓存合并失败不影响扫描 */ }
    };

    // ==================== 扫描（只读） ====================

    const scanAutoGroup = (opts = {}) => {
        if (autoGroupExec.value.running || autoGroupRollback.value.running) return null;
        const includeGrouped = typeof opts.includeGrouped === 'boolean'
            ? opts.includeGrouped
            : !!(autoGroupScan.value && autoGroupScan.value.includeGrouped);
        const profiles = normalizeGroupProfiles(autoGroupProfiles.value);
        const enabledCount = profiles.filter(p => p.enabled !== false).length;
        if (!enabledCount) {
            autoGroupScan.value = null; // 无启用规则 → 无计划可谈（UI 会给引导文案）
            return null;
        }
        const plan = buildAutoGroupPlan({
            cards: library.value,
            profiles,
            options: {
                includeGrouped,
                groupOrder: autoGroupGroupOptions.value.map(o => o.value),
                knownGroups: autoGroupGroupOptions.value.map(o => o.value),
                libraryPath: currentFolderPath.value || '',
                ignoreNativeTags: !!(sanitizeImportedTags && sanitizeImportedTags.value)
            }
        });
        mergeCachedSuggestions(plan, profiles); // 🤖 缓存建议自动并回（重扫不丢）
        autoGroupScan.value = { at: Date.now(), includeGrouped, plan };
        return plan;
    };

    // ==================== 执行（S3） ====================

    /** 执行后：原分组被搬空 → 询问是否删除空分组文件夹（方案 §4.3） */
    const promptCleanupEmptyGroups = async (entries, opts) => {
        if (opts && opts.skipConfirm) return; // 端到端验收：不弹窗、不动空分组（产品路径不受影响）
        const affected = Array.from(new Set(entries.map(e => e.fromGroup).filter(g => g && g !== AUTO_GROUP_ROOT_GROUP)));
        if (!affected.length) return;
        const empties = affected.filter(g => {
            if (!customCategories.value.includes(g)) return false;
            return !library.value.some(i => (i.category || AUTO_GROUP_ROOT_GROUP) === g);
        });
        if (!empties.length) return;
        const ok = await confirmDialog(`以下分组已没有卡片：${empties.join('、')}。\n是否删除这些空分组文件夹？（回滚时若需要会自动重建）`);
        if (!ok) return;
        for (const g of empties) {
            try {
                if (window.electronAPI && typeof window.electronAPI.deleteEmptyGroupFolder === 'function' && currentFolderPath.value) {
                    await window.electronAPI.deleteEmptyGroupFolder({ libraryPath: currentFolderPath.value, groupName: g });
                }
            } catch (e) { /* 非空/占用由主进程拒绝；提示已过，忽略 */ }
            customCategories.value = customCategories.value.filter(c => c !== g);
        }
        if (empties.includes(currentCategoryKey.value)) currentCategoryKey.value = 'all';
        addLog(`🧹 已删除 ${empties.length} 个空分组：${empties.join('、')}`, 'info');
    };

    /**
     * 执行自动分组
     * @param {Array<string>|null} selectedIds 勾选要移动的 cardId 列表（null = 计划内全部；通常由预览弹窗传入）
     */
    const executeAutoGroup = async (selectedIds, opts) => {
        const quiet = !!(opts && opts.skipConfirm); // ⚠️ 仅 dev 端到端验收使用；产品路径永远走原生确认框
        if (autoGroupExec.value.running || autoGroupRollback.value.running) return;
        const scan = autoGroupScan.value;
        if (!scan || !scan.plan) { if (!quiet) await nativeAlert('请先「🔄 扫描预览」生成计划。', 'warning'); return; }
        if (!scan.plan.counters.enabledProfiles) { if (!quiet) await nativeAlert('没有启用中的收纳规则，请先在「📋 收纳规则」里配置。', 'warning'); return; }

        const ids = Array.isArray(selectedIds) ? selectedIds : null;
        const moves = scan.plan.moves.filter(m => !ids || ids.includes(m.cardId));
        if (!moves.length) { if (!quiet) await nativeAlert('没有勾选任何需要移动的卡片。', 'info'); return; }

        const newFolders = scan.plan.targetGroups.filter(g => g.isNew).map(g => g.folder);
        const ok = quiet ? true : await confirmDialog(
            `即将移动 ${moves.length} 张卡片到目标分组` +
            (newFolders.length ? `，并新建 ${newFolders.length} 个分组文件夹（${newFolders.join('、')}）` : '') +
            `。\n移动完成后可在本窗口「↩️ 回滚」撤销。是否继续？`
        );
        if (!ok) return;

        execAbort = false;
        autoGroupExec.value = { running: true, done: 0, total: moves.length, moved: 0, failed: 0, aborted: false, failures: [], finishedAt: 0 };
        const entries = [];
        const failures = [];
        for (const m of moves) {
            if (execAbort) { autoGroupExec.value.aborted = true; break; }
            let success = false;
            try { success = await moveCardToGroup(m.card, m.toGroup); } catch (e) { success = false; }
            autoGroupExec.value.done++;
            if (success) {
                autoGroupExec.value.moved++;
                entries.push({ cardName: m.cardName, fromGroup: m.fromGroup, toGroup: m.toGroup, movedAt: Date.now() });
            } else {
                autoGroupExec.value.failed++;
                failures.push({ cardId: m.cardId, cardName: m.cardName, toGroup: m.toGroup });
            }
            // 每 10 张让出一次主线程（进度条可刷新；11k 卡也不会把界面钉死）
            if (autoGroupExec.value.done % 10 === 0) await new Promise(r => setTimeout(r, 0));
        }
        autoGroupExec.value.failures = failures;
        autoGroupExec.value.running = false;
        autoGroupExec.value.finishedAt = Date.now();

        if (entries.length) {
            // ⚠️ 与上一次日志**合并**（而不是覆盖）：否则上次执行过的卡将永久失去回滚能力
            const prev = normalizeAutoGroupLastRun(autoGroupLastRun.value);
            const merged = prev ? prev.entries.concat(entries) : entries;
            autoGroupLastRun.value = { at: Date.now(), entries: merged };
            syncConfigToDiskDebounced();
            addLog(`🗂️ 自动分组：移动 ${entries.length} 张卡片` + (failures.length ? `（失败 ${failures.length} 张）` : ''), failures.length ? 'warning' : 'info');
        }

        await promptCleanupEmptyGroups(entries, opts);

        const summary = `✅ 自动分组${autoGroupExec.value.aborted ? '已中止' : '完成'}：成功移动 ${entries.length} 张`
            + (failures.length ? `，失败 ${failures.length} 张（可在弹窗内「重试失败项」）` : '，无失败')
            + (autoGroupExec.value.aborted ? '（剩余未执行的仍在预览里）' : '');
        if (quiet) console.log('[自动分组·e2e]', summary);
        else await nativeAlert(summary, failures.length || autoGroupExec.value.aborted ? 'warning' : 'info');

        // 重扫：已移动的卡会以「已在目标分组」进入跳过项，避免重复执行
        scanAutoGroup({ includeGrouped: scan.includeGrouped });
    };

    const abortAutoGroup = () => {
        if (autoGroupExec.value.running) execAbort = true;
    };

    // ==================== 回滚（S4） ====================

    const rollbackAutoGroup = async (opts) => {
        const quiet = !!(opts && opts.skipConfirm); // ⚠️ 仅 dev 端到端验收使用
        if (autoGroupRollback.value.running || autoGroupExec.value.running) return;
        const run = normalizeAutoGroupLastRun(autoGroupLastRun.value);
        if (!run || !run.entries.length) { if (!quiet) await nativeAlert('没有可回滚的自动分组记录。', 'warning'); return; }
        const ok = quiet ? true : await confirmDialog(
            `将按「最近一次移动优先」的逆序，把 ${run.entries.length} 张卡片移回各自原分组。\n` +
            `发现卡片已变动的（被删/被手动移动/分组被改名）会单独列出，不会中断其它卡片的回滚。是否继续？`
        );
        if (!ok) return;

        autoGroupRollback.value = { running: true, done: 0, total: run.entries.length, rolled: 0, failed: [], finishedAt: 0 };
        const reverse = run.entries.slice().reverse();
        const remain = [];   // 未能解决 → 保留在日志里（可人工处理后重试）
        const failedList = [];
        for (const entry of reverse) {
            const r = resolveRollbackCard(library.value, entry);
            if (r.status === 'ok') {
                let success = false;
                try { success = await moveCardToGroup(r.card, entry.fromGroup || AUTO_GROUP_ROOT_GROUP); } catch (e) { success = false; }
                if (success) autoGroupRollback.value.rolled++;
                else { remain.push(entry); failedList.push({ cardName: entry.cardName, reason: '移动失败（目标可能被占用或权限不足）' }); }
            } else if (r.status === 'already') {
                autoGroupRollback.value.rolled++; // 已回到原分组：算已还原，无需移动
            } else if (r.status === 'missing') {
                failedList.push({ cardName: entry.cardName, reason: '卡片已不存在（被删除或改名）' });
            } else if (r.status === 'ambiguous') {
                remain.push(entry); failedList.push({ cardName: entry.cardName, reason: '发现多张同名卡片，无法确定回滚对象' });
            } else { // changed
                remain.push(entry);
                failedList.push({ cardName: entry.cardName, reason: `卡片已变动（当前位于「${r.actualGroup}」，不在预期分组「${entry.toGroup}」）` });
            }
            autoGroupRollback.value.done++;
            if (autoGroupRollback.value.done % 10 === 0) await new Promise(r => setTimeout(r, 0));
        }
        autoGroupRollback.value.running = false;
        autoGroupRollback.value.failed = failedList;
        autoGroupRollback.value.finishedAt = Date.now();

        if (remain.length) {
            autoGroupLastRun.value = {
                at: run.at,
                entries: remain,
                lastRollback: { at: Date.now(), rolled: autoGroupRollback.value.rolled, failed: failedList }
            };
        } else {
            autoGroupLastRun.value = null; // 全部解决（含已还原/已删除）→ 无残留日志
        }
        syncConfigToDiskDebounced();
        addLog(`↩️ 自动分组回滚：还原 ${autoGroupRollback.value.rolled} 张` + (failedList.length ? `，${failedList.length} 张需人工处理` : ''), failedList.length ? 'warning' : 'info');
        const rbSummary = `回滚完成：已还原 ${autoGroupRollback.value.rolled} / ${autoGroupRollback.value.total} 张`
            + (failedList.length ? `\n${failedList.length} 张未能自动处理（见弹窗内列表）` : '');
        if (quiet) console.log('[自动分组·e2e]', rbSummary);
        else await nativeAlert(rbSummary, failedList.length ? 'warning' : 'info');
        scanAutoGroup();
    };

    // ==================== 🤖 LLM 分辨（手动触发；分批 + 缓存；建议默认不勾选） ====================

    /** 运行 AI 分辨：对「未命中/冲突」卡按各组的「判定标准」请求归类建议 */
    const runLlmJudge = async (opts = {}) => {
        const quiet = !!(opts && opts.skipConfirm); // ⚠️ 仅 dev 端到端验收使用
        if (autoGroupLlm.value.running || autoGroupExec.value.running || autoGroupRollback.value.running) return null;
        const endpoint = apiEndpoint && apiEndpoint.value ? String(apiEndpoint.value).trim() : '';
        if (!endpoint) { if (!quiet) await nativeAlert('尚未配置 API（设置 → API）—— AI 分辨需要可用的对话 API。', 'warning'); return null; }
        if (!window.electronAPI || typeof window.electronAPI.sendChatMessage !== 'function') { if (!quiet) await nativeAlert('当前环境不支持调用 AI（sendChatMessage 不可用）。', 'warning'); return null; }
        const scan = autoGroupScan.value;
        if (!scan || !scan.plan) { if (!quiet) await nativeAlert('请先「🔄 扫描」生成计划，再运行 AI 分辨。', 'warning'); return null; }
        const specs = buildLlmGroupSpecs(normalizeGroupProfiles(autoGroupProfiles.value));
        if (!specs.length) { if (!quiet) await nativeAlert('没有任何规则填写「🤖 判定标准」。请到「📋 收纳规则」页为需要的分组补上说明（留空 = 不参与 AI 判定）。', 'warning'); return null; }

        const candidates = collectLlmCandidates({ plan: scan.plan, cards: library.value });
        if (!candidates.length) { if (!quiet) await nativeAlert('当前没有「未命中规则 / 冲突」的卡片可供 AI 判断。', 'info'); return null; }

        const sig = llmSpecsSignature(specs);
        const cachedHits = new Map(); // cardId → 缓存的判定
        const toQuery = [];
        for (const cnd of candidates) {
            const hit = llmCache.get(llmCardCacheKey(cnd.card, sig));
            if (hit) cachedHits.set(cnd.cardId, hit); else toQuery.push(cnd);
        }
        const batchSize = Math.max(1, Number(opts.batchSize) || LLM_DEFAULT_BATCH_SIZE);
        const batchCount = Math.ceil(toQuery.length / batchSize) || 0;
        const ok = quiet ? true : await confirmDialog(
            `AI 分辨：${candidates.length} 张候选卡（未命中规则 / 冲突）\n` +
            `- 缓存命中 ${cachedHits.size} 张（不重复请求）\n` +
            `- 需请求 ${toQuery.length} 张，分 ${batchCount} 批（每批 ${batchSize} 张）\n` +
            `输出仅为建议，默认不勾选，请人工确认后再执行。是否继续？`
        );
        if (!ok) return null;

        llmAbort = false;
        autoGroupLlm.value = { running: true, done: 0, total: toQuery.length, requested: 0, suggested: cachedHits.size, unmatched: 0, errors: [], lastAt: 0 };
        const freshByCard = new Map(); // card → 判定

        for (let i = 0; i < toQuery.length; i += batchSize) {
            if (llmAbort) break;
            const batch = toQuery.slice(i, i + batchSize);
            const { system, user } = buildLlmMessages({
                specs, cards: batch,
                ignoreNativeTags: !!(sanitizeImportedTags && sanitizeImportedTags.value)
            });
            const payload = {
                model: typeof resolveApiModel === 'function' ? resolveApiModel() : 'local-model',
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                temperature: 0.2
            };
            const batchNo = Math.floor(i / batchSize) + 1;
            try {
                let okRes = null; let lastErr = null;
                for (let attempt = 0; attempt < 2 && !okRes; attempt++) {
                    try {
                        const res = await window.electronAPI.sendChatMessage(endpoint, payload, (apiKey && apiKey.value) || '', (apiType && apiType.value) || 'openai');
                        if (res && res.success) okRes = res;
                        else lastErr = new Error((res && res.error) || 'API 请求失败');
                    } catch (e) { lastErr = e; }
                    if (!okRes && attempt === 0) {
                        const msg = (lastErr && lastErr.message) || '';
                        await new Promise(r => setTimeout(r, /429|rate|timeout|econnreset|fetch failed/i.test(msg) ? 1500 : 300));
                    }
                }
                if (!okRes) throw lastErr || new Error('API 请求失败');
                autoGroupLlm.value.requested++;
                const text = typeof extractReplyContent === 'function' ? extractReplyContent(okRes) : '';
                const parsed = parseLlmJudgement(text, { validGroups: specs.map(s => s.group), cardNames: batch.map(b => b.cardName) });
                const applied = assignJudgements(parsed.assignments, batch.map(b => b.card));
                for (const a of applied) {
                    freshByCard.set(a.card, a);
                    llmCache.set(llmCardCacheKey(a.card, sig), { group: a.group, confidence: a.confidence, reason: a.reason, at: Date.now() });
                }
                autoGroupLlm.value.suggested += applied.length;
                autoGroupLlm.value.unmatched += Math.max(0, batch.length - applied.length);
                if (parsed.parseError) autoGroupLlm.value.errors.push(`批次 ${batchNo}：${parsed.parseError}`);
                if (parsed.invalidGroups.length) autoGroupLlm.value.errors.push(`批次 ${batchNo}：忽略不存在的分组（${parsed.invalidGroups.join('、')}）`);
            } catch (e) {
                autoGroupLlm.value.errors.push(`批次 ${batchNo}：${(e && e.message) || e}`);
            }
            autoGroupLlm.value.done = Math.min(toQuery.length, i + batch.length);
            await new Promise(r => setTimeout(r, 250)); // 批次间节流（避免瞬时打满上游）
        }
        autoGroupLlm.value.running = false;
        autoGroupLlm.value.lastAt = Date.now();
        if (llmCache.size > LLM_CACHE_MAX) { // 简单淘汰：超限清一半（防无界增长）
            const keys = Array.from(llmCache.keys());
            for (const k of keys.slice(0, Math.floor(keys.length / 2))) llmCache.delete(k);
        }

        // 合并全部建议（本批新结果 + 缓存命中）进当前计划
        const finalSuggestions = [];
        for (const cnd of candidates) {
            const hit = freshByCard.get(cnd.card) || cachedHits.get(cnd.cardId);
            if (hit) finalSuggestions.push({ card: cnd.card, group: hit.group, confidence: hit.confidence, reason: hit.reason });
        }
        mergeSuggestionsIntoPlan(scan.plan, finalSuggestions);

        const summary = `🤖 AI 分辨：建议 ${finalSuggestions.length} 张（缓存 ${cachedHits.size} · 新请求 ${autoGroupLlm.value.requested} 次）`
            + (autoGroupLlm.value.unmatched ? `，未识别 ${autoGroupLlm.value.unmatched} 张` : '')
            + (autoGroupLlm.value.errors.length ? `，${autoGroupLlm.value.errors.length} 个批次异常` : '');
        if (quiet) console.log('[自动分组·e2e]', summary);
        else addLog(summary + '（建议默认不勾选，请人工确认后再执行）', autoGroupLlm.value.errors.length ? 'warning' : 'info');
        return { suggested: finalSuggestions.length, requested: autoGroupLlm.value.requested, cached: cachedHits.size, errors: autoGroupLlm.value.errors.slice() };
    };

    const abortLlmJudge = () => { if (autoGroupLlm.value.running) llmAbort = true; };

    // ==================== 规则保存 / 弹窗控制 ====================

    const saveAutoGroupProfiles = (list) => {
        autoGroupProfiles.value = normalizeGroupProfiles(list);
        syncConfigToDiskDebounced();
        scanAutoGroup(); // 规则变了 → 预览立即对齐（弹窗开着时体验一致）
    };

    const resetAutoGroupProfiles = () => {
        autoGroupProfiles.value = [];
        autoGroupScan.value = null;
        llmCache.clear(); // 🤖 规则清空 → LLM 建议缓存一并作废
        syncConfigToDiskDebounced();
    };

    const openAutoGroupModal = () => {
        showAutoGroupModal.value = true;
        if (!autoGroupExec.value.running) {
            try { scanAutoGroup(); } catch (e) { console.error('[自动分组] 打开弹窗时扫描失败', e); }
        }
    };

    const closeAutoGroupModal = () => { showAutoGroupModal.value = false; };

    return {
        showAutoGroupModal, openAutoGroupModal, closeAutoGroupModal,
        autoGroupScan, autoGroupExec, autoGroupRollback, autoGroupGroupOptions,
        autoGroupLlm, runLlmJudge, abortLlmJudge,
        scanAutoGroup, executeAutoGroup, abortAutoGroup, rollbackAutoGroup,
        saveAutoGroupProfiles, resetAutoGroupProfiles
    };
}
