/**
 * 🗂️ 世界书自动分组：执行器 + 回滚（S4 · 2026-09-25）
 * ═════════════════════════════════════════════════════════════════
 * 职责边界（对齐卡片版 useAutoGroup）：
 *   · 判定（谁该去哪）→ `js/utils/wbAutoGroup.js`（纯函数，已单测）
 *   · 落地（怎么搬）  → **必须复用 `useWorldbooks.moveWbToFolder`**（含键迁移：wbTagMap / wbCategoryMap —— 铁律 6）
 *   · 本文件只做编排：材料构建（书名 + 词条名）→ 扫描 → 预览 → 执行 → 写日志 → 回滚。
 *
 * 安全约定：
 *   1. 没有扫描结果不许执行；执行前有原生二次确认。
 *   2. 默认只处理「默认」（库根）的书（includeGrouped=false）；勾选才碰已分组书。
 *   3. 日志按「书名 + fromGroup + toGroup」记录（不记绝对路径）；回滚按书名定位。
 *   4. 材料 = 书名 + 词条名（**不读全文留存**：逐本加载提取 key 后立即释放正文——大书内存纪律）。
 */

import { ref, computed } from 'vue';
import {
    normalizeWbGroupProfiles, buildWbAutoGroupPlan, resolveRollbackWb,
    buildWbLlmSpecs, wbLlmSpecsSignature, buildWbLlmMessages, parseWbLlmJudgement,
    WB_GROUP_ROOT_GROUP, WB_LLM_DEFAULT_BATCH_SIZE
} from '../utils/wbAutoGroup.js';

export function useWbAutoGroup({
    // —— App.vue 持有并持久化的状态 ——
    wbAutoGroupProfiles,
    wbAutoGroupLastRun,
    // —— 共享状态 / 工具 ——
    worldbooks, activeWorldbook,
    getWbCategory, wbFolderGroupOf, moveWbToFolder, wbDisplayName,
    ensureWorldbookLoaded, releaseWorldbookBody,
    nativeAlert, confirmDialog, addLog, syncConfigToDiskDebounced,
    // —— 🤖 LLM 判定层：统一 API 通道 ——
    apiEndpoint, apiKey, apiType, resolveApiModel, extractReplyContent
}) {
    const showWbAutoGroupModal = ref(false);
    /** 最近一次扫描：{ at, includeGrouped, plan }（内存态；plan.moves 含书活引用，禁止序列化） */
    const wbAutoGroupScan = ref(null);
    /** 执行进度/结果 */
    const wbAutoGroupExec = ref({ running: false, done: 0, total: 0, moved: 0, failed: 0, aborted: false, failures: [], finishedAt: 0 });
    /** 回滚进度/结果 */
    const wbAutoGroupRollback = ref({ running: false, done: 0, total: 0, rolled: 0, failed: [], finishedAt: 0 });
    let execAbort = false;

    /** 🤖 LLM 判定状态 */
    const wbAutoGroupLlm = ref({ running: false, done: 0, total: 0, requested: 0, suggested: 0, unmatched: 0, errors: [], lastAt: 0 });
    const wbLlmCache = new Map(); // bookKey+签名 → { group, at }
    const WB_LLM_CACHE_MAX = 500;
    let llmAbort = false;

    /** 词条名缓存（会话级；key = path||name）——扫描多次不重复读盘 */
    const wbKeysCache = new Map();
    /** 扫描时注意：材料构建是**读操作**（逐本读正文提取 key 后立即释放） */

    /**
     * 构建全库判定材料（异步：含懒加载读取——用后释放）
     * @returns {Promise<Array>} [{ key, name, group, keys, ref }]
     */
    const collectBookMaterials = async (onProgress) => {
        const out = [];
        const list = Array.isArray(worldbooks.value) ? worldbooks.value : [];
        for (let i = 0; i < list.length; i++) {
            const wb = list[i];
            if (!wb) continue;
            const key = wb.path || wb.name || '';
            if (!key) continue;
            let keys = wbKeysCache.get(key);
            if (!keys) {
                try {
                    if (typeof ensureWorldbookLoaded === 'function') await ensureWorldbookLoaded(wb);
                    const data = wb && wb.data ? wb.data : null;
                    let entries = [];
                    if (data) {
                        if (Array.isArray(data.entries)) entries = data.entries;
                        else if (data.entries && typeof data.entries === 'object') entries = Object.values(data.entries);
                    }
                    keys = [];
                    for (const e of entries) {
                        if (!e || typeof e !== 'object') continue;
                        if (Array.isArray(e.key)) keys.push(...e.key.filter(Boolean).map(String));
                        else if (e.key) keys.push(String(e.key));
                        if (e.comment) keys.push(String(e.comment));
                    }
                } catch (e) {
                    keys = [];
                } finally {
                    try { if (typeof releaseWorldbookBody === 'function') releaseWorldbookBody(wb); } catch (e) { /* 忽略 */ }
                }
                wbKeysCache.set(key, keys);
            }
            out.push({
                key,
                name: wbDisplayName(wb) || wb.name || '未命名',
                group: getWbCategory(wb),
                keys,
                ref: wb
            });
            if (typeof onProgress === 'function' && (i & 7) === 7) onProgress(i + 1, list.length);
        }
        return out;
    };

    /** 清空材料缓存（库变化/手动刷新时可调；当前由重新扫描自然覆盖） */
    const clearWbKeysCache = () => wbKeysCache.clear();

    // ==================== 扫描（读材料 + 判定，不落地） ====================

    const scanWbAutoGroup = async (opts = {}) => {
        if (wbAutoGroupExec.value.running || wbAutoGroupRollback.value.running) return null;
        const includeGrouped = typeof opts.includeGrouped === 'boolean'
            ? opts.includeGrouped
            : !!(wbAutoGroupScan.value && wbAutoGroupScan.value.includeGrouped);
        const profiles = normalizeWbGroupProfiles(wbAutoGroupProfiles.value);
        const enabledCount = profiles.filter(p => p.enabled !== false).length;
        if (!enabledCount) {
            wbAutoGroupScan.value = null; // 无启用规则 → 无计划可谈（UI 给引导文案）
            return null;
        }
        const books = await collectBookMaterials(opts.onProgress);
        const plan = buildWbAutoGroupPlan({
            books,
            profiles,
            options: {
                includeGrouped,
                knownGroups: Array.from(new Set(books.map(b => b.group).filter(g => g && g !== WB_GROUP_ROOT_GROUP)))
            }
        });
        // 🤖 缓存建议自动并回（重扫不丢）
        mergeCachedSuggestions(plan, profiles, books);
        wbAutoGroupScan.value = { at: Date.now(), includeGrouped, plan };
        return plan;
    };

    /** 重建计划的「目标分组汇总 + 计数」（LLM 合并后调用） */
    const rebuildPlanTargets = (plan, books) => {
        const counts = new Map();
        for (const m of plan.moves) counts.set(m.toGroup, (counts.get(m.toGroup) || 0) + 1);
        const known = new Set((books || []).map(b => b.group).filter(g => g && g !== WB_GROUP_ROOT_GROUP));
        plan.targetGroups = Array.from(counts.entries())
            .map(([name, count]) => ({ name, folder: name, renamed: false, isNew: !known.has(name), count }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        plan.counters.willMove = plan.moves.length;
        plan.counters.skipped = plan.skipped.length;
        plan.counters.newFolders = plan.targetGroups.filter(g => g.isNew).length;
    };

    /** 把 LLM 建议合并进计划（规则命中优先；去重） */
    const mergeWbSuggestionsIntoPlan = (plan, suggestions, books) => {
        if (!plan || !Array.isArray(suggestions) || !suggestions.length) return plan;
        const byKey = new Map((books || []).map(b => [b.key, b]));
        for (const s of suggestions) {
            const bk = byKey.get(s.bookKey);
            if (!bk) continue;
            if (plan.moves.some(m => m.bookKey === s.bookKey)) continue; // 已有点（规则命中优先）
            const si = plan.skipped.findIndex(x => x.bookKey === s.bookKey);
            if (si >= 0) plan.skipped.splice(si, 1);
            if (bk.group === s.group) {
                plan.skipped.push({ bookKey: s.bookKey, bookName: bk.name, currentGroup: bk.group, reason: `🤖 AI 判定：已在「${s.group}」` });
                continue;
            }
            plan.moves.push({
                bookKey: s.bookKey, bookName: bk.name,
                fromGroup: bk.group || WB_GROUP_ROOT_GROUP, toGroup: s.group,
                reason: `🤖 AI 判定：${s.reason || '按判定标准归类'}`,
                profileId: `llm_${s.group}`, ref: bk.ref, source: 'llm'
            });
        }
        rebuildPlanTargets(plan, books);
        return plan;
    };

    /** 扫描后：把缓存中的 LLM 建议自动合并（重扫/重开弹窗后建议不丢） */
    const mergeCachedSuggestions = (plan, profiles, books) => {
        try {
            const specs = buildWbLlmSpecs(profiles);
            if (!specs.length) return;
            const sig = wbLlmSpecsSignature(specs);
            const sug = [];
            for (const bk of books) {
                const hit = wbLlmCache.get(`${bk.key}\u0000${sig}`);
                if (hit) sug.push({ bookKey: bk.key, group: hit.group, confidence: hit.confidence, reason: '（缓存）AI 判定' });
            }
            if (sug.length) mergeWbSuggestionsIntoPlan(plan, sug, books);
        } catch (e) { /* 缓存合并失败不影响扫描 */ }
    };

    // ==================== 执行 ====================

    const executeWbAutoGroup = async (selectedKeys, opts) => {
        const quiet = !!(opts && opts.skipConfirm); // ⚠️ 仅 dev 端到端验收使用
        if (wbAutoGroupExec.value.running || wbAutoGroupRollback.value.running) return;
        const scan = wbAutoGroupScan.value;
        if (!scan || !scan.plan) { if (!quiet) await nativeAlert('请先「🔄 扫描预览」生成计划。', 'warning'); return; }
        if (!scan.plan.counters.enabledProfiles) { if (!quiet) await nativeAlert('没有启用中的收纳规则，请先在「📋 收纳规则」里配置。', 'warning'); return; }

        const keys = Array.isArray(selectedKeys) ? selectedKeys : null;
        const moves = scan.plan.moves.filter(m => !keys || keys.includes(m.bookKey));
        if (!moves.length) { if (!quiet) await nativeAlert('没有勾选任何需要移动的世界书。', 'info'); return; }

        const newFolders = scan.plan.targetGroups.filter(g => g.isNew).map(g => g.folder);
        const ok = quiet ? true : await confirmDialog(
            `即将把 ${moves.length} 本世界书移动到目标分组` +
            (newFolders.length ? `，并新建 ${newFolders.length} 个文件夹（${newFolders.join('、')}）` : '') +
            `。\n（移动的是**文件位置**，不改任何世界书内容；完成后可在本窗口「↩️ 回滚」撤销）\n\n是否继续？`
        );
        if (!ok) return;

        execAbort = false;
        wbAutoGroupExec.value = { running: true, done: 0, total: moves.length, moved: 0, failed: 0, aborted: false, failures: [], finishedAt: 0 };
        const entries = [];
        const failures = [];
        for (const m of moves) {
            if (execAbort) { wbAutoGroupExec.value.aborted = true; break; }
            let success = false;
            try { success = await moveWbToFolder(m.ref, m.toGroup); } catch (e) { success = false; }
            wbAutoGroupExec.value.done++;
            if (success) {
                wbAutoGroupExec.value.moved++;
                entries.push({ bookName: m.bookName, fromGroup: m.fromGroup, toGroup: m.toGroup, movedAt: Date.now() });
            } else {
                wbAutoGroupExec.value.failed++;
                failures.push({ bookKey: m.bookKey, bookName: m.bookName, toGroup: m.toGroup });
            }
            if (wbAutoGroupExec.value.done % 8 === 0) await new Promise(r => setTimeout(r, 0));
        }
        wbAutoGroupExec.value.failures = failures;
        wbAutoGroupExec.value.running = false;
        wbAutoGroupExec.value.finishedAt = Date.now();

        if (entries.length) {
            // ⚠️ 与上一次日志合并（否则上次移动的书永久失去回滚能力）
            const prevEntries = (wbAutoGroupLastRun.value && Array.isArray(wbAutoGroupLastRun.value.entries)) ? wbAutoGroupLastRun.value.entries : [];
            wbAutoGroupLastRun.value = { at: Date.now(), entries: [...prevEntries, ...entries] };
            if (typeof syncConfigToDiskDebounced === 'function') syncConfigToDiskDebounced();
            addLog(`🗂️ 世界书自动分组：移动 ${entries.length} 本` + (failures.length ? `（失败 ${failures.length} 本）` : ''), failures.length ? 'warning' : 'info');
        }

        const summary = `✅ 世界书自动分组${wbAutoGroupExec.value.aborted ? '已中止' : '完成'}：成功移动 ${entries.length} 本`
            + (failures.length ? `，失败 ${failures.length} 本` : '，无失败');
        if (quiet) console.log('[世界书自动分组·e2e]', summary);
        else await nativeAlert(summary, failures.length || wbAutoGroupExec.value.aborted ? 'warning' : 'info');

        // 重扫：已移动的书进入「已在目标分组」跳过项，避免重复执行
        await scanWbAutoGroup({ includeGrouped: scan.includeGrouped });
    };

    const abortWbAutoGroup = () => { if (wbAutoGroupExec.value.running) execAbort = true; };

    // ==================== 回滚 ====================

    const rollbackWbAutoGroup = async (opts) => {
        const quiet = !!(opts && opts.skipConfirm);
        if (wbAutoGroupRollback.value.running || wbAutoGroupExec.value.running) return;
        const run = wbAutoGroupLastRun.value;
        const entries = (run && Array.isArray(run.entries)) ? run.entries : [];
        if (!entries.length) { if (!quiet) await nativeAlert('没有可回滚的自动分组记录。', 'warning'); return; }
        const ok = quiet ? true : await confirmDialog(
            `将按「最近一次移动优先」的逆序，把 ${entries.length} 本世界书移回各自原分组。\n` +
            `已被删除 / 改名的书会单独列出，不会中断其它书的回滚。是否继续？`
        );
        if (!ok) return;

        wbAutoGroupRollback.value = { running: true, done: 0, total: entries.length, rolled: 0, failed: [], finishedAt: 0 };
        const reverse = entries.slice().reverse();
        const remain = [];
        const failedList = [];
        for (const entry of reverse) {
            const r = resolveRollbackWb(worldbooks.value, entry);
            if (r.status === 'ok') {
                let success = false;
                try { success = await moveWbToFolder(r.book, entry.fromGroup || WB_GROUP_ROOT_GROUP); } catch (e) { success = false; }
                if (success) wbAutoGroupRollback.value.rolled++;
                else { remain.push(entry); failedList.push({ bookName: entry.bookName, reason: '移动失败（目标可能被占用或权限不足）' }); }
            } else if (r.status === 'missing') {
                failedList.push({ bookName: entry.bookName, reason: '世界书已不存在（被删除或改名）' });
            } else if (r.status === 'ambiguous') {
                remain.push(entry); failedList.push({ bookName: entry.bookName, reason: '发现多本同名世界书，无法确定回滚对象' });
            }
            wbAutoGroupRollback.value.done++;
            if (wbAutoGroupRollback.value.done % 8 === 0) await new Promise(r => setTimeout(r, 0));
        }
        wbAutoGroupRollback.value.running = false;
        wbAutoGroupRollback.value.failed = failedList;
        wbAutoGroupRollback.value.finishedAt = Date.now();

        if (remain.length) {
            wbAutoGroupLastRun.value = {
                at: (run && run.at) || Date.now(),
                entries: remain,
                lastRollback: { at: Date.now(), rolled: wbAutoGroupRollback.value.rolled, failed: failedList }
            };
        } else {
            wbAutoGroupLastRun.value = null; // 全部解决 → 无残留日志
        }
        if (typeof syncConfigToDiskDebounced === 'function') syncConfigToDiskDebounced();
        addLog(`↩️ 世界书自动分组回滚：还原 ${wbAutoGroupRollback.value.rolled} 本` + (failedList.length ? `，${failedList.length} 本需人工处理` : ''), failedList.length ? 'warning' : 'info');
        const rbSummary = `回滚完成：已还原 ${wbAutoGroupRollback.value.rolled} / ${wbAutoGroupRollback.value.total} 本`
            + (failedList.length ? `\n${failedList.length} 本未能自动处理（见弹窗内列表）` : '');
        if (quiet) console.log('[世界书自动分组·e2e]', rbSummary);
        else await nativeAlert(rbSummary, failedList.length ? 'warning' : 'info');
        await scanWbAutoGroup();
    };

    // ==================== 🤖 LLM 判定（手动触发；分批 + 缓存） ====================

    /**
     * 运行 AI 判定：对「规则未命中」的书按各组「判定标准」请求归类建议。
     * 建议默认**不勾选**，人工确认后才会进入执行清单（与卡片版同口径）。
     */
    const runWbLlmJudge = async (opts = {}) => {
        const quiet = !!(opts && opts.skipConfirm);
        if (wbAutoGroupLlm.value.running || wbAutoGroupExec.value.running || wbAutoGroupRollback.value.running) return null;
        const endpoint = apiEndpoint && apiEndpoint.value ? String(apiEndpoint.value).trim() : '';
        if (!endpoint) { if (!quiet) await nativeAlert('尚未配置 API（设置 → API）—— AI 判定需要可用的对话 API。', 'warning'); return null; }
        if (!window.electronAPI || typeof window.electronAPI.sendChatMessage !== 'function') { if (!quiet) await nativeAlert('当前环境不支持调用 AI。', 'warning'); return null; }
        const scan = wbAutoGroupScan.value;
        if (!scan || !scan.plan) { if (!quiet) await nativeAlert('请先「🔄 扫描预览」生成计划，再运行 AI 判定。', 'warning'); return null; }
        const profiles = normalizeWbGroupProfiles(wbAutoGroupProfiles.value);
        const specs = buildWbLlmSpecs(profiles);
        if (!specs.length) { if (!quiet) await nativeAlert('没有任何规则填写「🤖 判定标准」。请到「📋 收纳规则」页为需要的分组补上说明（留空 = 不参与 AI 判定）。', 'warning'); return null; }

        // 候选 = 规则未命中的书（skipped 中 reason=未命中）+ 全部「默认」书里没进 moves 的
        const books = await collectBookMaterials();
        const byKey = new Map(books.map(b => [b.key, b]));
        const candidateKeys = new Set();
        for (const s of scan.plan.skipped) {
            if (s.reason && String(s.reason).includes('未命中')) candidateKeys.add(s.bookKey);
        }
        const toQueryBooks = books.filter(b => candidateKeys.has(b.key) && b.group === WB_GROUP_ROOT_GROUP);
        if (!toQueryBooks.length) { if (!quiet) await nativeAlert('当前没有「未命中规则」的世界书可供 AI 判断。', 'info'); return null; }

        const sig = wbLlmSpecsSignature(specs);
        const cached = [];
        const toQuery = [];
        for (const b of toQueryBooks) {
            const hit = wbLlmCache.get(`${b.key}\u0000${sig}`);
            if (hit) cached.push({ bookKey: b.key, group: hit.group, confidence: hit.confidence, reason: '（缓存）AI 判定' });
            else toQuery.push(b);
        }
        const batchSize = Math.max(1, Number(opts.batchSize) || WB_LLM_DEFAULT_BATCH_SIZE);
        const batchCount = Math.ceil(toQuery.length / batchSize) || 0;
        const ok = quiet ? true : await confirmDialog(
            `AI 判定：${toQueryBooks.length} 本候选世界书（未命中规则）\n` +
            `- 缓存命中 ${cached.length} 本（不重复请求）\n` +
            `- 需请求 ${toQuery.length} 本，分 ${batchCount} 批（每批 ${batchSize} 本）\n` +
            `输出仅为建议，请人工确认后再执行。是否继续？`
        );
        if (!ok) return null;

        llmAbort = false;
        wbAutoGroupLlm.value = { running: true, done: 0, total: toQuery.length, requested: 0, suggested: cached.length, unmatched: 0, errors: [], lastAt: 0 };
        const fresh = [];

        for (let i = 0; i < toQuery.length; i += batchSize) {
            if (llmAbort) break;
            const batch = toQuery.slice(i, i + batchSize);
            const { system, user } = buildWbLlmMessages({
                specs,
                books: batch.map(b => ({ bookName: b.name, keys: b.keys, entryCount: b.keys.length }))
            });
            const payload = {
                model: typeof resolveApiModel === 'function' ? resolveApiModel() : 'local-model',
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                temperature: 0.2
            };
            const batchNo = Math.floor(i / batchSize) + 1;
            try {
                let okRes = null;
                let lastErr = null;
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
                wbAutoGroupLlm.value.requested++;
                const text = typeof extractReplyContent === 'function' ? extractReplyContent(okRes) : '';
                const parsed = parseWbLlmJudgement(text, {
                    validGroups: specs.map(s => s.group),
                    bookNames: batch.map(b => b.name)
                });
                const nameToKey = new Map(batch.map(b => [b.name, b.key]));
                for (const a of parsed.assignments) {
                    const bk = nameToKey.get(a.bookName);
                    if (!bk) continue;
                    fresh.push({ bookKey: bk, group: a.group, confidence: a.confidence, reason: a.reason });
                    wbLlmCache.set(`${bk}\u0000${sig}`, { group: a.group, confidence: a.confidence, at: Date.now() });
                }
                wbAutoGroupLlm.value.suggested += parsed.assignments.length;
                wbAutoGroupLlm.value.unmatched += parsed.unmatched.length;
                if (parsed.parseError) wbAutoGroupLlm.value.errors.push(`批次 ${batchNo}：${parsed.parseError}`);
                if (parsed.invalidGroups.length) wbAutoGroupLlm.value.errors.push(`批次 ${batchNo}：忽略不存在的分组（${parsed.invalidGroups.join('、')}）`);
            } catch (e) {
                wbAutoGroupLlm.value.errors.push(`批次 ${batchNo}：${(e && e.message) || e}`);
            }
            wbAutoGroupLlm.value.done = Math.min(toQuery.length, i + batch.length);
            await new Promise(r => setTimeout(r, 250)); // 批次间节流
        }
        wbAutoGroupLlm.value.running = false;
        wbAutoGroupLlm.value.lastAt = Date.now();
        if (wbLlmCache.size > WB_LLM_CACHE_MAX) {
            const keys = Array.from(wbLlmCache.keys());
            for (const k of keys.slice(0, Math.floor(keys.length / 2))) wbLlmCache.delete(k);
        }

        // 合并全部建议（新结果 + 缓存命中）进当前计划
        mergeWbSuggestionsIntoPlan(scan.plan, [...cached, ...fresh], books);

        const summary = `🤖 AI 判定：建议 ${cached.length + fresh.length} 本（缓存 ${cached.length} · 新请求 ${wbAutoGroupLlm.value.requested} 次）`
            + (wbAutoGroupLlm.value.unmatched ? `，未识别 ${wbAutoGroupLlm.value.unmatched} 本` : '')
            + (wbAutoGroupLlm.value.errors.length ? `，${wbAutoGroupLlm.value.errors.length} 个批次异常` : '');
        if (quiet) console.log('[世界书自动分组·e2e]', summary);
        else addLog(summary + '（建议默认不勾选，请人工确认后再执行）', wbAutoGroupLlm.value.errors.length ? 'warning' : 'info');
        return { suggested: cached.length + fresh.length, requested: wbAutoGroupLlm.value.requested, cached: cached.length, errors: wbAutoGroupLlm.value.errors.slice() };
    };

    const abortWbLlmJudge = () => { if (wbAutoGroupLlm.value.running) llmAbort = true; };

    // ==================== 规则保存 / 弹窗控制 ====================

    const saveWbAutoGroupProfiles = (list) => {
        wbAutoGroupProfiles.value = normalizeWbGroupProfiles(list);
        if (typeof syncConfigToDiskDebounced === 'function') syncConfigToDiskDebounced();
        scanWbAutoGroup(); // 规则变化 → 预览即时对齐
    };

    const resetWbAutoGroupProfiles = () => {
        wbAutoGroupProfiles.value = [];
        wbAutoGroupScan.value = null;
        wbLlmCache.clear();
        if (typeof syncConfigToDiskDebounced === 'function') syncConfigToDiskDebounced();
    };

    const openWbAutoGroupModal = () => {
        showWbAutoGroupModal.value = true;
        if (!wbAutoGroupExec.value.running) {
            try { scanWbAutoGroup(); } catch (e) { console.error('[世界书自动分组] 打开弹窗时扫描失败', e); }
        }
    };

    const closeWbAutoGroupModal = () => { showWbAutoGroupModal.value = false; };

    return {
        showWbAutoGroupModal, openWbAutoGroupModal, closeWbAutoGroupModal,
        wbAutoGroupScan, wbAutoGroupExec, wbAutoGroupRollback,
        wbAutoGroupLlm, runWbLlmJudge, abortWbLlmJudge,
        scanWbAutoGroup, executeWbAutoGroup, abortWbAutoGroup, rollbackWbAutoGroup,
        saveWbAutoGroupProfiles, resetWbAutoGroupProfiles,
        clearWbKeysCache
    };
}
