/**
 * 🔧 查重与差异比对 —— **v4 实现（P1：三轨候选 / 证据分级 / 星型聚类）**
 * ─────────────────────────────────────────────────────────────
 * 依据《查重引擎重构方案 v4 · 实现规格（通用算法版）》（**评审已通过**）§十五：
 *   · P0（已完成）：接线恢复 / 28 符号骨架 / L0 直通 / `diffFieldResults` 契约修复；
 *   · **P1（本版）**：三轨候选（内容 MinHash+LSH / keys 倒排 / 名字 2-gram）
 *     → 证据分级判定（L0/L1/L2 + 否决族带前提）→ 星型聚类（全员回归校验）
 *     + 同名家族通道（G7）→ 四弹窗视图契约（dedupeView）。
 *
 * 模块分工（纯函数均可独立单测）：
 *   dedupeCommon / dedupeNames / dedupeContract / dedupeBuckets / dedupeGates / dedupeCluster / dedupeView
 *   本文件只做**编排**：注入 → 进度 → 降级上报 → 清理安全网。
 *
 * 硬约束（v4 §10，评审必查）：
 *   · 清理只走 `confirmDialog` + `electronAPI.trashFiles`（回收站）；
 *     严禁系统级确认弹窗与 Electron 物理删除 API（详见 `scripts/check-dedupe-api.mjs`）。
 *   · 降级/跳过/抽样一律上报（`noteSkipped` / `flushNotices`），禁止静默。
 *   · 进度单写入口（`applyDedupeProgress`）。
 */
import { ref } from 'vue';
import { ensureFullBody, isSlim, slimCard } from '../utils/cardSlim.js';
import { setDedupeBusy } from '../utils/dedupeBusy.js';
import { normalizeCard, normalizeWorldbook, normalizePreset } from '../utils/dedupeContract.js';
import { extractNameStem, applyTails, discoverTails } from '../utils/dedupeNames.js';
import { buildCandidatePairs } from '../utils/dedupeBuckets.js';
import { evaluateGate } from '../utils/dedupeGates.js';
import { buildStarClusters, buildNameOnlyGroups } from '../utils/dedupeCluster.js';
import { buildGroup } from '../utils/dedupeView.js';
import { buildFieldResults } from '../utils/dedupeDiff.js';
import { collectDfLines, buildTemplateKeySet, stripDataTemplateLines } from '../utils/dedupeDf.js';
import { cardDataOf } from '../utils/dedupeCommon.js';

// （纯函数已抽到 `js/utils/dedupeCommon.js` / `dedupeNames.js` —— P1；本文件只做编排）

export function useDedupe({
    // ── 共享状态 ──
    library = null, worldbooks = null, activeWorldbook = null, cardData = null,
    presets = null, activePreset = null, appMode = null,
    // ── 工具 / 服务 ──
    estimateCardTokens = null,
    nativeAlert = null, confirmDialog = null, addLog = null,
    reset = null, cleanupEmptyCategories = null, deleteCardOverlays = null,
    showToast = null,
    loadFullCardFromDisk = null,
    // ── 重扫与目录（P1 接入重扫；P0 仅保持注入契约） ──
    rescanWorldbooks = null, wbScanProgress = null, isWbScanning = null, wbScanPercent = null,
    refreshLibrary = null, currentFolderPath = null,
    lastWorldbookDirPath = null, lastPresetDirPath = null,
    // ── 世界书按需载入 / 轻量字段 / L1 摘要 ──
    //    ⚠️ 本文件**不得**出现世界书全量载入调用（批量读正文唯一入口是 consumeWorldbookBodies，
    //       guard:batch-read + guard:dedupe 双重强制）；世界书侧只读 L1，不读正文。
    wbEntryCount = null, wbDisplayName = null,
    releaseWorldbookBody = null, consumeWorldbookBodies = null,
    hasKeyIndex = null, compareKeyHashes = null, isExactSame = null
} = {}) {
    // ── 弹窗与结果空状态（六个组件的 props 契约不变） ──
    const showDedupeModal = ref(false);
    const duplicateGroups = ref([]);
    const showWbDedupeModal = ref(false);
    const wbDuplicateGroups = ref([]);
    const showPresetDedupeModal = ref(false);
    const presetDuplicateGroups = ref([]);
    const showContentDedupeModal = ref(false);
    const contentDuplicateGroups = ref([]);

    // ── 扫描进度（`DedupeScanProgress` 的 props；新实现接管前恒为空） ──
    const dedupeScanning = ref(false);
    const dedupeScanLabel = ref('');
    const dedupeScanPercent = ref(0);
    const dedupeScanIndeterminate = ref(false);
    const dedupeScanDone = ref(0);
    const dedupeScanTotal = ref(0);

    // ── 差异查看窗口（`DiffModal` 保留；P2 已接三分支深度比对） ──
    const showDiffDetailModal = ref(false);
    const diffMasterItem = ref(null);
    const diffCompareItem = ref(null);
    // v4 §10.3：DiffModal props 默认 `[]`；初值必须是数组（旧壳的 ref(null) 已修正）
    const diffFieldResults = ref([]);
    // 差异窗口的正文读回防重入（WeakSet）——失败只报一次，绝不递归弹框
    const diffLoadAttempted = new WeakSet();

    // ── 降级 / 跳过上报（红线：禁止静默；v4 §3.4） ──
    const skipped = { count: 0, reasons: Object.create(null), samples: [] };
    const noteSkipped = (reason, sampleName) => {
        skipped.count++;
        skipped.reasons[reason] = (skipped.reasons[reason] || 0) + 1;
        if (skipped.samples.length < 5 && sampleName) skipped.samples.push(String(sampleName));
    };
    const flushSkippedReport = () => {
        if (!skipped.count) return;
        const parts = Object.entries(skipped.reasons).map(([k, v]) => `${k}×${v}`).join('、');
        try {
            if (typeof addLog === 'function') addLog(`⚠️ 查重跳过 ${skipped.count} 项（${parts}）；样例：${skipped.samples.join('、') || '—'}`, 'warning');
        } catch (e) { /* 日志失败不影响主流程 */ }
        if (typeof showToast === 'function') showToast(`已跳过 ${skipped.count} 项（索引未就绪/无文本，详见日志）`, 'warning', 6000);
        skipped.count = 0; skipped.reasons = Object.create(null); skipped.samples = [];
    };

    // ── 进度（单写入口；不变量：不裸赋值、不倒退、total ≥ 1 —— AR-45/49） ──
    let lastProgressAt = 0;
    const applyDedupeProgress = ({ label = '', done = 0, total = 0, percent = null, force = false } = {}) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 80 && done < total) return;
        lastProgressAt = now;
        if (label) dedupeScanLabel.value = label;
        dedupeScanning.value = true;
        dedupeScanIndeterminate.value = false;
        if (total > 0) {
            dedupeScanDone.value = Math.max(dedupeScanDone.value, done);
            dedupeScanTotal.value = Math.max(total, 1);
        }
        if (percent === null) {
            const t = Math.max(dedupeScanTotal.value, 1);
            dedupeScanPercent.value = Math.min(100, Math.floor((dedupeScanDone.value / t) * 100));
        } else {
            dedupeScanPercent.value = Math.max(dedupeScanPercent.value, Math.min(100, Math.max(0, percent)));
        }
    };
    /** 收尾（含释放查重忙标志，交回瘦身许可 —— AR-50） */
    const finishDedupeScan = () => {
        dedupeScanning.value = false;
        dedupeScanIndeterminate.value = false;
        setDedupeBusy(false);
    };

    // （视图适配已抽到 `js/utils/dedupeView.js` —— P1：
    //   四弹窗字段契约 / `_simType` 白名单对齐 / 推荐版 index 0 / 差异窗口基础对照行）

    // ── P1 管线（契约 → 语料 → 三轨候选 → 证据判定 → 星型聚类 → 视图） ──
    const CHUNK_SIZE = 64; // 评审微调 #3：分批读回（50~100/批），禁止 Promise.all 全量并发
    const notices = []; // 候选/聚类提示（桶超限、跨簇、降级等 —— 收尾统一上报）
    const pushNotice = (m) => { if (notices.length < 200) notices.push(String(m)); };
    const flushNotices = () => {
        if (!notices.length) return;
        try {
            if (typeof addLog === 'function') addLog(`⚠️ 查重提示 ${notices.length} 条（前 5）：${notices.slice(0, 5).join('；')}`, 'warning');
        } catch (e) { /* 日志失败不影响主流程 */ }
        notices.length = 0;
    };

    /** 名字层准备：语料统计（跨主干尾缀）+ stemFinal（三库通用） */
    const prepareNames = (items) => {
        const tails = discoverTails(items.map((it) => it.name));
        for (const it of items) {
            const { stem0 } = extractNameStem(it.name);
            it.stemFinal = applyTails(stem0, tails).stemFinal || stem0;
        }
    };

    /** 三库通用收束：候选 → 判定 → 聚类 → 视图 */
    const resolveClusters = (items, kind, viewOpts = {}) => {
        const pairs = buildCandidatePairs(items, { report: { notice: pushNotice } });
        const edges = [];
        for (const [a, b] of pairs) {
            const g = evaluateGate(a, b);
            if (g.pass) edges.push({ a, b, gate: g });
        }
        const { clusters, notices: cNotices } = buildStarClusters(edges);
        for (const n of cNotices) pushNotice(n);
        const used = new Set();
        for (const c of clusters) for (const m of c.members) used.add(m.id);
        const nameOnly = buildNameOnlyGroups(items.filter((it) => !used.has(it.id)));
        const opts = { estimateCardTokens, wbEntryCount, wbDisplayName, ...viewOpts };
        const groups = clusters.map((c) => buildGroup(kind, c, opts))
            .concat(nameOnly.map((c) => buildGroup(kind, c, opts)));
        return { groups, pairCount: pairs.length, edgeCount: edges.length, nameOnlyCount: nameOnly.length };
    };

    /**
     * 卡片：**两遍管线**（§8 DF 模板剥离 + 契约归一化）。
     *   Pass A：分批读回 → 全字段池抽行统计 → 交还；构建全库模板行集（模板 = 跨卡高频行）；
     *   Pass B：分批读回 → 剔除模板行（仅命中卡克隆，**不动作内存原对象**）→ 归一化算指纹 → 交还。
     *   ⚠️ AR-50：两遍都「用完即还」（当前打开的卡除外）；禁止把正文跨批保留在内存。
     */
    const runCardPipeline = async (dfReport) => {
        const lib = (library && Array.isArray(library.value)) ? library.value.slice() : [];
        if (lib.length === 0) { if (typeof nativeAlert === 'function') nativeAlert('卡片库为空，无法查重！', 'warning'); return null; }

        applyDedupeProgress({ label: `正在提取内容指纹（共 ${lib.length} 张）…`, done: 0, total: lib.length, percent: 5, force: true });

        // ── Pass A：行级模板统计（读回 → 抽行 → 交还） ──
        const perCard = [];
        let fieldsScannedTotal = 0;
        let processed = 0;
        for (let i = 0; i < lib.length; i += CHUNK_SIZE) {
            const chunk = lib.slice(i, i + CHUNK_SIZE);
            const wasSlim = new Map();
            try {
                for (const it of chunk) wasSlim.set(it, isSlim(it));
                await ensureFullBody(chunk, { silent: true });
            } catch (e) { /* 读回失败不中断：缺文本走 NO_TEXT 降级 */ }
            for (const it of chunk) {
                const data = cardDataOf(it);
                if (data) {
                    const { lines, fieldsScanned } = collectDfLines(data);
                    fieldsScannedTotal += fieldsScanned;
                    if (lines.length > 0) perCard.push({ id: it.path || it.name, lines });
                }
                if (wasSlim.get(it) && !(cardData && cardData.value && it.data === cardData.value)) {
                    try { slimCard(it); } catch (e) { /* 交还失败不影响结果 */ }
                }
            }
            processed += chunk.length;
            applyDedupeProgress({ label: '正在统计共用模板行…', done: processed, total: lib.length, percent: 5 + Math.floor((processed / Math.max(lib.length, 1)) * 20) });
            await new Promise((r) => setTimeout(r, 0)); // 让出主线程（UI 不冻结）
        }
        const dfSet = buildTemplateKeySet(perCard);
        if (dfReport) {
            dfReport.fieldsScanned = fieldsScannedTotal;
            dfReport.linesTotal = dfSet.linesTotal;
            dfReport.templateLines = dfSet.templateLines;
            dfReport.cardsWithTemplate = dfSet.cardsWithTemplate;
        }

        // ── Pass B：剔模板 → 归一化（读回 → 剔除 → 算指纹 → 交还） ──
        const items = [];
        processed = 0;
        for (let i = 0; i < lib.length; i += CHUNK_SIZE) {
            const chunk = lib.slice(i, i + CHUNK_SIZE);
            const wasSlim = new Map();
            try {
                for (const it of chunk) wasSlim.set(it, isSlim(it));
                await ensureFullBody(chunk, { silent: true });
            } catch (e) { /* 继续按原样处理 */ }
            for (const it of chunk) {
                const data = cardDataOf(it);
                const stripped = (data && dfSet.keys.size > 0) ? stripDataTemplateLines(data, dfSet.keys) : null;
                const src = stripped ? { ...it, data: stripped.data } : it;
                if (stripped && dfReport) {
                    dfReport.cardsAffected++;
                    dfReport.strippedChars += stripped.strippedChars;
                }
                const n = normalizeCard(src);
                // ★ 防正文锚定（P2 性能复核，11k 库实测 rss +1.7GB 的根因）：
                //   `src` 是为「剔模板」构造的包装对象；若让它留在 raw 上，`slimCard` 交还正文时
                //   清不掉它 ⇒ **全库卡正文会被查重结果集锚住**，直到分组被销毁。
                //   raw 必须指回 library 条目本身（差异窗口需要正文时走 `openDiffDetailModal` 的读回逻辑）。
                if (!n.degraded && n.raw !== it) n.raw = it;
                if (n.degraded) noteSkipped(n.degraded, n.name);
                else items.push(n);
                if (wasSlim.get(it) && !(cardData && cardData.value && it.data === cardData.value)) {
                    try { slimCard(it); } catch (e) { /* 交还失败不影响结果 */ }
                }
            }
            processed += chunk.length;
            applyDedupeProgress({ label: '正在计算内容指纹（已剔模板行）…', done: processed, total: lib.length, percent: 25 + Math.floor((processed / Math.max(lib.length, 1)) * 25) });
            await new Promise((r) => setTimeout(r, 0));
        }
        return items;
    };

    /** 世界书：只读 L1（不读正文），归一化 + 降级上报 */
    const runWbPipeline = () => {
        const list = (worldbooks && Array.isArray(worldbooks.value)) ? worldbooks.value : [];
        if (list.length === 0) { if (typeof nativeAlert === 'function') nativeAlert('世界书库为空，无法查重！', 'warning'); return null; }
        const items = [];
        for (const wb of list) {
            const n = normalizeWorldbook(wb);
            if (n.degraded) noteSkipped(n.degraded, n.name);
            else items.push(n);
        }
        return items;
    };

    /** 预设：L0（JSON 指纹）+ L2（内容 MinHash） */
    const runPresetPipeline = () => {
        const list = (presets && Array.isArray(presets.value)) ? presets.value : [];
        if (list.length === 0) { if (typeof nativeAlert === 'function') nativeAlert('预设库为空，无法查重！', 'warning'); return null; }
        const items = [];
        for (const p of list) {
            const n = normalizePreset(p);
            if (n.degraded) noteSkipped(n.degraded, n.name);
            else items.push(n);
        }
        return items;
    };

    // ── 统一执行（忙标志 / 进度 / 降级与提示上报收尾） ──
    const executeScan = async (kind) => {
        skipped.count = 0; skipped.reasons = Object.create(null); skipped.samples = [];
        notices.length = 0;
        setDedupeBusy(true);
        try {
            if (kind === 'card') {
                duplicateGroups.value = [];
                showDedupeModal.value = true;
                dedupeScanning.value = true;
                dedupeScanDone.value = 0; dedupeScanTotal.value = 0; dedupeScanPercent.value = 0;
                dedupeScanLabel.value = '正在扫描卡片库…';
                // 🧬 DF 模板剥离报告（§8 红线：发生剥离必须上报）
                const dfReport = { fieldsScanned: 0, linesTotal: 0, templateLines: 0, cardsWithTemplate: 0, cardsAffected: 0, strippedChars: 0 };
                const items = await runCardPipeline(dfReport);
                if (items === null) return;
                prepareNames(items);
                applyDedupeProgress({ label: '正在生成候选与判定（三轨）…', percent: 58, force: true });
                const res = resolveClusters(items, 'card');
                applyDedupeProgress({ label: '正在整理结果…', done: Math.max(items.length, 1), total: Math.max(items.length, 1), percent: 96, force: true });
                duplicateGroups.value = res.groups;
                if (dfReport.cardsAffected > 0 && typeof addLog === 'function') {
                    addLog(`🧬 模板剥离：模板行 ${dfReport.templateLines} · 涉及 ${dfReport.cardsWithTemplate} 张卡 · 实际剔除 ${dfReport.cardsAffected} 张卡共 ${dfReport.strippedChars} 字符`, 'info');
                }
                if (typeof showToast === 'function') {
                    const dfNote = dfReport.cardsAffected > 0 ? `；模板剥离 ${dfReport.cardsAffected} 张` : '';
                    showToast(res.groups.length > 0
                        ? `✅ 查重完成：${res.groups.length} 组（同名家族 ${res.nameOnlyCount} 组；候选 ${res.pairCount} 对${dfNote}）`
                        : `✅ 查重完成：未发现重复组（候选已全量比对${dfNote}）`,
                        'info', 6500);
                }
            } else if (kind === 'wb') {
                wbDuplicateGroups.value = [];
                showWbDedupeModal.value = true;
                dedupeScanning.value = true;
                dedupeScanLabel.value = '正在比对世界书索引（L1，不读正文）…';
                const items = runWbPipeline();
                if (items === null) return;
                prepareNames(items);
                const res = resolveClusters(items, 'wb');
                wbDuplicateGroups.value = res.groups;
                if (typeof showToast === 'function') {
                    showToast(res.groups.length > 0
                        ? `✅ 世界书查重完成：${res.groups.length} 组（同名家族 ${res.nameOnlyCount} 组）`
                        : '✅ 世界书查重完成：未发现重复组（候选已全量比对）',
                        'info', 6500);
                }
            } else if (kind === 'preset') {
                presetDuplicateGroups.value = [];
                showPresetDedupeModal.value = true;
                dedupeScanning.value = true;
                dedupeScanLabel.value = '正在比对预设内容…';
                const items = runPresetPipeline();
                if (items === null) return;
                prepareNames(items);
                const res = resolveClusters(items, 'preset');
                presetDuplicateGroups.value = res.groups;
                if (typeof showToast === 'function') {
                    showToast(res.groups.length > 0
                        ? `✅ 预设查重完成：${res.groups.length} 组（同名家族 ${res.nameOnlyCount} 组）`
                        : '✅ 预设查重完成：未发现重复组（候选已全量比对）',
                        'info', 6500);
                }
            } else if (kind === 'content') {
                contentDuplicateGroups.value = [];
                showContentDedupeModal.value = true;
                dedupeScanning.value = true;
                dedupeScanLabel.value = '正在比对内容指纹…';
                const mode = appMode && appMode.value;
                let items = null; let viewKind = 'card';
                if (mode === 'worldbooks') { viewKind = 'wb'; items = runWbPipeline(); }
                else if (mode === 'presets') { viewKind = 'preset'; items = runPresetPipeline(); }
                else { items = await runCardPipeline(); }
                if (items === null) return;
                prepareNames(items);
                const res = resolveClusters(items, viewKind, { asContent: true });
                contentDuplicateGroups.value = res.groups;
                if (typeof showToast === 'function') {
                    showToast(`✅ 内容查重完成：${res.groups.length} 组（证据边 ${res.edgeCount} 条；非完全一致组已降级提示）`, 'info', 6500);
                }
            }
        } catch (err) {
            console.error('[useDedupe·v4-P1] 执行异常:', err);
            if (typeof showToast === 'function') showToast('查重计算中途发生错误，已终止', 'error', 6000);
        } finally {
            finishDedupeScan();
            flushSkippedReport();
            flushNotices();
        }
    };

    // ── 入口（四个 + 三合一；全部无参 —— 与 HeaderBar / 命令面板调用一致） ──
    const startDedupeScan = () => executeScan('card');
    const startWorldbookDedupeScan = () => executeScan('wb');
    const startPresetDedupeScan = () => executeScan('preset');
    const startContentDedupeScan = () => executeScan('content');

    /** 🎯 三合一切换（用户点名保留）：按当前库类型分发 */
    const startSmartDedupe = () => {
        const mode = appMode && appMode.value;
        if (mode === 'worldbooks') return startWorldbookDedupeScan();
        if (mode === 'presets') return startPresetDedupeScan();
        return startDedupeScan();
    };

    // ── 清理（v4 §10：confirmDialog + trashFiles；回收站安全网） ──
    const resolveGeneric = async (kind, groupIndex, keepPath) => {
        const source = kind === 'card' ? duplicateGroups
            : kind === 'wb' ? wbDuplicateGroups
                : kind === 'preset' ? presetDuplicateGroups
                    : contentDuplicateGroups;
        const group = source.value[groupIndex];
        if (!group) return;
        const members = group.cards || group.list || [];
        const pathsToTrash = members.filter((m) => m && m.path && m.path !== keepPath).map((m) => m.path);
        if (pathsToTrash.length === 0) return;

        // 🛡️ 「仅同名」警示（P0 恒空；P1 同名家族通道启用后生效）——与旧实现同口径
        const risky = members.filter((m) => m && m.path !== keepPath && m._nameOnly);
        const warn = risky.length > 0
            ? `\n\n⚠️ 注意：其中 ${risky.length} 个只是「名字相同」，内容与保留版并不同源（很可能是不同的实体）：\n`
                + risky.slice(0, 5).map((m) => `  · ${String(m.path).split(/[\\/]/).pop()}`).join('\n')
                + (risky.length > 5 ? `\n  …还有 ${risky.length - 5} 个` : '')
                + '\n\n建议先点「🔍 对比差异」逐一确认，再决定是否清理。'
            : '';

        // ⚠️ 必须用 confirmDialog（window.confirm 在 Electron 中静默失败 —— AR-02）
        if (typeof confirmDialog !== 'function') {
            if (typeof nativeAlert === 'function') nativeAlert('清理确认对话框不可用（confirmDialog 未注入），已取消。', 'error');
            return;
        }
        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个重复/旧版文件移入回收站吗？${warn}`);
        if (!ok) return;

        const api = window.electronAPI;
        if (!api || typeof api.trashFiles !== 'function') {
            if (typeof nativeAlert === 'function') nativeAlert('❌ 回收站接口不可用（preload 未提供 trashFiles），已取消清理。', 'error');
            return;
        }

        let res = null;
        try { res = await api.trashFiles(pathsToTrash); } catch (e) { res = { success: false, error: e && e.message }; }
        if (!res || !res.success) {
            if (typeof nativeAlert === 'function') nativeAlert(`清理失败：${(res && res.error) || '未知错误'}`, 'error');
            return;
        }

        // 按实际成功路径过滤内存（失败项保留，与磁盘一致 —— 杜绝幽灵卡）
        const failedPaths = new Set(((res && res.failed) || []).map((f) => f && f.path).filter(Boolean));
        const trashedPaths = pathsToTrash.filter((p) => !failedPaths.has(p));

        if (kind === 'card') {
            if (library && Array.isArray(library.value)) {
                const openItem = (cardData && cardData.value) ? library.value.find((it) => it.data === cardData.value) : null;
                const currentTrashed = !!(openItem && trashedPaths.includes(openItem.path));
                library.value = library.value.filter((it) => !trashedPaths.includes(it.path));
                if (currentTrashed && typeof reset === 'function') reset();
            }
            if (typeof deleteCardOverlays === 'function') { try { deleteCardOverlays(trashedPaths); } catch (e) { /* 忽略 */ } }
            if (typeof cleanupEmptyCategories === 'function') { try { await cleanupEmptyCategories(); } catch (e) { /* 忽略 */ } }
        } else if (kind === 'wb') {
            if (worldbooks && Array.isArray(worldbooks.value)) worldbooks.value = worldbooks.value.filter((w) => !trashedPaths.includes(w.path));
        } else if (kind === 'preset') {
            if (presets && Array.isArray(presets.value)) presets.value = presets.value.filter((p) => !trashedPaths.includes(p.path));
        } else if (kind === 'content') {
            const mode = appMode && appMode.value;
            if (mode === 'worldbooks' && worldbooks && Array.isArray(worldbooks.value)) worldbooks.value = worldbooks.value.filter((w) => !trashedPaths.includes(w.path));
            else if (mode === 'presets' && presets && Array.isArray(presets.value)) presets.value = presets.value.filter((p) => !trashedPaths.includes(p.path));
            else if (library && Array.isArray(library.value)) library.value = library.value.filter((it) => !trashedPaths.includes(it.path));
        }

        // 组数据同步：全删净（无失败）才移除整组；有残留只剔除已删项（弹窗与磁盘一致）
        const remain = members.filter((m) => m && m.path && !trashedPaths.includes(m.path));
        if (failedPaths.size === 0 || remain.length <= 1) {
            source.value.splice(groupIndex, 1);
        } else {
            group.cards = remain; group.list = remain;
        }

        if (failedPaths.size > 0) {
            const names = [...failedPaths].map((p) => String(p).split(/[\\/]/).pop()).join('、');
            if (typeof showToast === 'function') showToast(`已清理 ${trashedPaths.length} 个，${failedPaths.size} 个失败（可能被占用）`, 'warning', 5000);
            if (typeof nativeAlert === 'function') nativeAlert(`已清理 ${trashedPaths.length} 个；${failedPaths.size} 个失败（可能被其他程序占用）：\n${names}`, 'warning');
        } else if (typeof showToast === 'function') {
            showToast(`✅ 清理成功：已将 ${trashedPaths.length} 个文件移入回收站`, 'success', 4000);
        }
    };

    const resolveDedupeGroup = (groupIndex, keepPath) => resolveGeneric('card', groupIndex, keepPath);
    const resolveWbDedupeGroup = (groupIndex, keepPath) => resolveGeneric('wb', groupIndex, keepPath);
    const resolvePresetDedupeGroup = (groupIndex, keepPath) => resolveGeneric('preset', groupIndex, keepPath);
    const resolveContentDedupeGroup = (groupIndex, keepPath) => resolveGeneric('content', groupIndex, keepPath);

    // ── 差异窗口（v4 §10.3）：三分支深度比对 + 懒加载/瘦身正文按需读回 ──
    //   🔑 同步入口（模板 @open-diff 直接调用）：
    //      · 正文未就绪（懒加载世界书 / 瘦身卡）→ **先弹窗（加载态）+ 异步读回后重算**；
    //      · `diffLoadAttempted`（WeakSet）防重入 —— 读回失败**只报一次**，绝不递归弹框（历史事故：无限递归+无限弹框）。
    //   🔑 世界书正文走 `consumeWorldbookBodies`（唯一的批量读正文入口，顺序读；**不得**直接调世界书载入函数——batch-read 守卫）；
    //      卡片正文走 `ensureFullBody`（AR-50 第五项统一入口，与查重口径一致）。
    //   🔑 差异窗口期间正文**保留**（release:false）——用户可能反复查看；重型书在下一次批量流程/重扫时自然回收。
    const openDiffDetailModal = (masterItem, compareItem) => {
        if (!masterItem || !compareItem) return;
        diffMasterItem.value = masterItem;
        diffCompareItem.value = compareItem;

        const needWbBody = (it) => it && it.dataLoaded === false && it.path;
        const needCardBody = (it) => it && isSlim(it) && it.path;
        const needLoad = (it) => (needWbBody(it) || needCardBody(it)) && !diffLoadAttempted.has(it);

        if (needLoad(masterItem) || needLoad(compareItem)) {
            diffFieldResults.value = [{
                label: '⏳ 正在读取正文…',
                isSame: true, len1: '—', len2: '—',
                hint: '懒加载 / 瘦身态的正文读取完成后会自动重算差异；若本端显示「无词条」，说明正文未能读取。',
            }];
            showDiffDetailModal.value = true;
            (async () => {
                const failed = [];
                // 世界书：批量正文消费器（顺序读 + 失败不中断）
                const wbItems = [masterItem, compareItem].filter((it) => needLoad(it) && needWbBody(it));
                if (wbItems.length > 0 && typeof consumeWorldbookBodies === 'function') {
                    for (const it of wbItems) diffLoadAttempted.add(it); // ★ 先标记：无论成败都不再重试
                    try {
                        const r = await consumeWorldbookBodies(wbItems, () => true, { release: false });
                        for (const f of (r && r.failed) || []) {
                            failed.push(`${(f.item && (f.item.name || f.item.path)) || '未知'}\n  → ${f.error}`);
                        }
                        for (const it of wbItems) {
                            if (it.dataLoaded !== true) failed.push(`${it.name || it.path}\n  → ${it._loadError || '读取失败'}`);
                        }
                    } catch (e) {
                        failed.push(`${masterItem.name || ''}\n  → ${e.message}`);
                    }
                }
                // 卡片：统一入口 ensureFullBody（瘦身读回）
                const cardItems = [masterItem, compareItem].filter((it) => needLoad(it) && needCardBody(it));
                if (cardItems.length > 0) {
                    for (const it of cardItems) diffLoadAttempted.add(it);
                    try {
                        await ensureFullBody(cardItems, { silent: true });
                        for (const it of cardItems) {
                            if (isSlim(it)) failed.push(`${it.name || it.path}\n  → 读卡正文失败（可能未授权目录）`);
                        }
                    } catch (e) {
                        failed.push(`${masterItem.name || ''}\n  → ${e.message}`);
                    }
                }
                if (failed.length > 0) {
                    if (typeof addLog === 'function') addLog(`❌ 差异比对：${failed.length} 份正文读取失败，比对结果可能不完整`, 'error');
                    if (typeof nativeAlert === 'function') {
                        nativeAlert(`❌ 无法读取以下正文，比对结果可能不完整：\n\n${failed.join('\n')}\n\n请检查文件是否仍可访问；若提示未授权，重新打开库目录后再试。`, 'error');
                    }
                }
                // 正文就绪后重算（attempted 已标记 → 不会再进本分支）
                openDiffDetailModal(masterItem, compareItem);
            })();
            return;
        }

        diffFieldResults.value = buildFieldResults(masterItem, compareItem);
        showDiffDetailModal.value = true;
    };

    return {
        showDedupeModal, duplicateGroups, startDedupeScan, resolveDedupeGroup,
        showWbDedupeModal, wbDuplicateGroups, startWorldbookDedupeScan, resolveWbDedupeGroup,
        showPresetDedupeModal, presetDuplicateGroups, startPresetDedupeScan, resolvePresetDedupeGroup,
        showContentDedupeModal, contentDuplicateGroups, startContentDedupeScan, resolveContentDedupeGroup,
        startSmartDedupe,
        dedupeScanning, dedupeScanLabel, dedupeScanPercent, dedupeScanIndeterminate,
        dedupeScanDone, dedupeScanTotal,
        showDiffDetailModal, diffMasterItem, diffCompareItem, diffFieldResults, openDiffDetailModal
    };
}
