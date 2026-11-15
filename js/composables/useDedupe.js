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
import { buildBatchPlan, chunkList } from '../utils/dedupeBatch.js'; // 🧹 批量清理判定层（纯函数）

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
    /**
     * @param {'card'|'wb'|'preset'|'content'} kind
     * @param {{silent?:boolean}} [opts] silent=true ⇒ **不自动弹出查重弹窗**（供「一键质检流水线」「启动自动任务」
     *   等编排场景使用：它们有自己的界面，弹窗会把报告顶掉）。
     */
    const executeScan = async (kind, opts) => {
        const silent = !!(opts && opts.silent);
        skipped.count = 0; skipped.reasons = Object.create(null); skipped.samples = [];
        notices.length = 0;
        // 🛡️ 重新扫描 ⇒ 旧批量计划立即失效：组结构与「推荐版」都可能变，
        //    继续用旧计划执行可能删掉新的推荐版本（未报告隐患，见 AR-81）。
        dedupeBatchPlan.value = null;
        setDedupeBusy(true);
        try {
            if (kind === 'card') {
                duplicateGroups.value = [];
                if (!silent) showDedupeModal.value = true;
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
                if (!silent) showWbDedupeModal.value = true;
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
                if (!silent) showPresetDedupeModal.value = true;
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
                if (!silent) showContentDedupeModal.value = true;
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
    const startDedupeScan = (opts) => executeScan('card', opts);
    const startWorldbookDedupeScan = (opts) => executeScan('wb', opts);
    const startPresetDedupeScan = (opts) => executeScan('preset', opts);
    const startContentDedupeScan = (opts) => executeScan('content', opts);

    /** 🎯 三合一切换（用户点名保留）：按当前库类型分发 */
    const startSmartDedupe = () => {
        const mode = appMode && appMode.value;
        if (mode === 'worldbooks') return startWorldbookDedupeScan();
        if (mode === 'presets') return startPresetDedupeScan();
        return startDedupeScan();
    };

    // ── 清理（v4 §10：confirmDialog + trashFiles；回收站安全网） ──
    const dedupeSourceOf = (kind) => (kind === 'card' ? duplicateGroups
        : kind === 'wb' ? wbDuplicateGroups
            : kind === 'preset' ? presetDuplicateGroups
                : contentDuplicateGroups);

    /** 内存同步（单组清理与批量清理共用）：只按**实际成功路径**剔除，失败项保留 —— 杜绝幽灵卡 */
    const applyTrashedPaths = async (kind, trashedPaths, failedPaths) => {
        if (!Array.isArray(trashedPaths) || trashedPaths.length === 0) return;
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
        void failedPaths;
    };

    /** 组数据同步：全删净（剩 0~1 张）的组移除；有残留只剔已删项（弹窗与磁盘一致） */
    const pruneGroupsAfterTrash = (kind, trashedSet) => {
        const src = dedupeSourceOf(kind);
        const list = src && Array.isArray(src.value) ? src.value : null;
        if (!list) return;
        for (let i = list.length - 1; i >= 0; i--) {
            const g = list[i];
            const members = (g && (g.cards || g.list)) || [];
            const remain = members.filter((m) => m && !trashedSet.has(m.path));
            if (remain.length === members.length) continue;
            if (remain.length <= 1) list.splice(i, 1);
            else { g.cards = remain; g.list = remain; }
        }
    };

    /** 从列表移除**失效条目**（磁盘上已不存在；只动内存与覆盖层，绝不删文件 —— DF-33） */
    const removeGhostEntries = async (kind, paths) => {
        const set = new Set((Array.isArray(paths) ? paths : []).filter(Boolean));
        if (!set.size) return 0;
        if (kind === 'card') {
            if (library && Array.isArray(library.value)) library.value = library.value.filter((it) => !set.has(it.path));
            if (typeof deleteCardOverlays === 'function') { try { deleteCardOverlays([...set]); } catch (e) { /* 忽略 */ } }
        } else if (kind === 'wb') {
            if (worldbooks && Array.isArray(worldbooks.value)) worldbooks.value = worldbooks.value.filter((w) => !set.has(w.path));
        } else if (kind === 'preset') {
            if (presets && Array.isArray(presets.value)) presets.value = presets.value.filter((p) => !set.has(p.path));
        } else if (kind === 'content') {
            const mode = appMode && appMode.value;
            if (mode === 'worldbooks' && worldbooks && Array.isArray(worldbooks.value)) worldbooks.value = worldbooks.value.filter((w) => !set.has(w.path));
            else if (mode === 'presets' && presets && Array.isArray(presets.value)) presets.value = presets.value.filter((p) => !set.has(p.path));
            else if (library && Array.isArray(library.value)) library.value = library.value.filter((it) => !set.has(it.path));
        }
        pruneGroupsAfterTrash(kind, set);
        if (typeof addLog === 'function') addLog(`🧹 已从列表移除 ${set.size} 个失效条目（磁盘未改动）`, 'warning');
        return set.size;
    };

    /** 把 `trashFiles` 的分项失败渲染成人能看懂的多行文本（DF-33：不再用「未知错误」糊掉真因） */
    const describeTrashFailures = (fails, limit = 8) => {
        const list = (Array.isArray(fails) ? fails : []).filter((f) => f && f.path);
        if (!list.length) return '';
        const lines = list.slice(0, limit).map((f) => `  · ${String(f.path).split(/[\\/]/).pop()} —— ${f.error || '未知原因'}`);
        if (list.length > limit) lines.push(`  …还有 ${list.length - limit} 个`);
        return lines.join('\n');
    };

    const isMissingError = (err) => /文件不存在|不存在|ENOENT/i.test(String(err || ''));
    const isBusyError = (err) => /占用|EBUSY|EPERM|EACCES|DELETE_PENDING|权限/i.test(String(err || ''));
    const isOutsideError = (err) => /授权|越界|白名单/.test(String(err || ''));

    /** 失败后的可操作建议（按原因类别生成；没有对应类别就不写 —— 不制造噪音） */
    const trashHints = (fails) => {
        const list = Array.isArray(fails) ? fails : [];
        const hints = [];
        if (list.some((f) => isMissingError(f && f.error))) {
            hints.push('· 文件已不存在：多半是在软件外被移动/删除/改名，点「🔄 刷新/重扫」后这些条目会消失');
        }
        if (list.some((f) => isBusyError(f && f.error))) {
            hints.push('· 文件被占用：关掉正在预览/同步这些文件的程序（含杀毒实时扫描）后点「↻ 重试失败项」');
        }
        if (list.some((f) => isOutsideError(f && f.error))) {
            hints.push('· 路径未授权：重新「打开角色库目录」（或世界书/预设目录）授权后再清理');
        }
        return hints.length ? `\n\n💡 处理建议：\n${hints.join('\n')}` : '';
    };

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
        try { res = await api.trashFiles(pathsToTrash); } catch (e) { res = { success: false, error: e && e.message, failed: [] }; }
        const fails = ((res && res.failed) || []).filter((f) => f && f.path);

        // 整批失败（一个都没删成）：必须把 failed[] 的逐项原因说出来 —— 旧实现只说「未知错误」（DF-33）
        if (!res || (res.success === false && fails.length === 0)) {
            if (typeof nativeAlert === 'function') nativeAlert(`清理失败：${(res && res.error) || '未知错误（接口未返回原因）'}`, 'error');
            return;
        }
        if (res.success === false && fails.length > 0) {
            const missing = fails.filter((f) => isMissingError(f.error)).map((f) => f.path);
            let note = `❌ 这 ${fails.length} 个文件都没能移入回收站：\n\n${describeTrashFailures(fails)}` + trashHints(fails);
            if (missing.length) {
                note += `\n\n其中 ${missing.length} 个在磁盘上已不存在（可能被移动 / 删除 / 改名后没重扫）。`;
            }
            if (typeof nativeAlert === 'function') nativeAlert(note, 'error');
            // 全是失效条目 → 主动提出「从列表移除」（只动列表，不动磁盘）
            if (missing.length === fails.length && typeof confirmDialog === 'function') {
                const ok = await confirmDialog(
                    `这些卡片在磁盘上已不存在，删不掉也清不掉，会一直留在查重列表里。\n\n是否从**列表**中移除这些失效条目？（只改列表，不动磁盘）`
                );
                if (ok) {
                    const n = await removeGhostEntries(kind, missing);
                    if (typeof showToast === 'function') showToast(`✅ 已移除 ${n} 个失效条目（磁盘未改动）`, 'success', 4000);
                }
            }
            return;
        }

        // 按实际成功路径过滤内存（失败项保留，与磁盘一致 —— 杜绝幽灵卡）
        const failedPaths = new Set(((res && res.failed) || []).map((f) => f && f.path).filter(Boolean));
        const trashedPaths = pathsToTrash.filter((p) => !failedPaths.has(p));

        await applyTrashedPaths(kind, trashedPaths, failedPaths);

        // 组数据同步：全删净（剩 0~1 张）的组移除；有残留只剔已删项（弹窗与磁盘一致）
        pruneGroupsAfterTrash(kind, new Set(trashedPaths));

        if (failedPaths.size > 0) {
            const failsDetail = fails.filter((f) => failedPaths.has(f.path));
            const missing = failsDetail.filter((f) => isMissingError(f.error)).map((f) => f.path);
            if (typeof showToast === 'function') showToast(`已清理 ${trashedPaths.length} 个，${failedPaths.size} 个失败`, 'warning', 5000);
            if (typeof nativeAlert === 'function') {
                nativeAlert(
                    `已清理 ${trashedPaths.length} 个；${failedPaths.size} 个失败：\n\n${describeTrashFailures(failsDetail)}`
                    + (missing.length ? `\n\n其中 ${missing.length} 个在磁盘上已不存在（失效条目）。` : '')
                    + trashHints(failsDetail),
                    'warning'
                );
            }
            if (missing.length && missing.length === failedPaths.size && typeof confirmDialog === 'function') {
                const ok = await confirmDialog('这些失效条目还留在查重列表里，是否从**列表**中移除？（只改列表，不动磁盘）');
                if (ok) await removeGhostEntries(kind, missing);
            }
        } else if (typeof showToast === 'function') {
            showToast(`✅ 清理成功：已将 ${trashedPaths.length} 个文件移入回收站`, 'success', 4000);
        }
    };

    const resolveDedupeGroup = (groupIndex, keepPath) => resolveGeneric('card', groupIndex, keepPath);
    const resolveWbDedupeGroup = (groupIndex, keepPath) => resolveGeneric('wb', groupIndex, keepPath);
    const resolvePresetDedupeGroup = (groupIndex, keepPath) => resolveGeneric('preset', groupIndex, keepPath);
    const resolveContentDedupeGroup = (groupIndex, keepPath) => resolveGeneric('content', groupIndex, keepPath);

    // ══════════════════════════════════════════════════════════════
    // 🧹 批量清理（方案：docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md）
    //   两段式：preview（纯只读）→ execute（分批 trashFiles + 整批一次内存同步）
    //   ⚠️ 与单组清理共用 applyTrashedPaths / pruneGroupsAfterTrash，禁止另写删除逻辑
    // ══════════════════════════════════════════════════════════════

    /** 最近一次预演计划（含 deletions/keepList/skipGroups/stats；活引用禁止序列化落盘） */
    const dedupeBatchPlan = ref(null);
    /** 批量执行进度/结果 */
    const dedupeBatchExec = ref({ running: false, done: 0, total: 0, deleted: 0, deletedPaths: [], failed: [], aborted: false, finishedAt: 0 });
    let batchAbort = false;
    const BATCH_CHUNK = 200;
    const BATCH_TIMEOUT_MS = 30000; // 单批 IPC 超时：主进程卡住也不能把 UI 永远锁死

    /** 给 promise 加超时（超时按"整批失败"返回，绝不让 running 卡在 true —— 预演按钮会因此永久变灰） */
    const withTimeout = (p, ms, onTimeout) => new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(onTimeout());
        }, ms);
        Promise.resolve(p).then(
            (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
            (e) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ success: false, error: (e && e.message) || '调用异常', failed: [] });
            }
        );
    });

    /** 当前视图的库根（用于「不在库目录内」预判；取不到就跳过该校验） */
    const dedupeRootOf = (kind) => {
        const val = (r) => (r && typeof r === 'object' && 'value' in r ? r.value : r) || '';
        if (kind === 'wb') return val(lastWorldbookDirPath) || '';
        if (kind === 'preset') return val(lastPresetDirPath) || '';
        if (kind === 'content') {
            const mode = appMode && appMode.value;
            if (mode === 'worldbooks') return val(lastWorldbookDirPath) || '';
            if (mode === 'presets') return val(lastPresetDirPath) || '';
        }
        return val(currentFolderPath) || '';
    };

    /** 正在编辑/打开的文件（批量清理整组跳过，避免删掉用户正在改的那份） */
    const openPathsOf = () => {
        const out = new Set();
        const push = (v) => { if (v && typeof v === 'string') out.add(v); };
        push(cardData && cardData.value && cardData.value.path);
        push(activeWorldbook && activeWorldbook.value && activeWorldbook.value.path);
        push(activePreset && activePreset.value && activePreset.value.path);
        return out;
    };

    /**
     * 预演（**零写入**）：生成删除清单并写入 `dedupeBatchPlan`
     * @param {'card'|'wb'|'preset'|'content'} kind
     * @param {object} opts `{ keepBy, scopes, guards, excludeIds, maxGroups, maxFiles }`
     */
    const previewDedupeBatch = (kind = 'card', opts = {}) => {
        const source = dedupeSourceOf(kind);
        const groups = (source && Array.isArray(source.value)) ? source.value : [];
        const openSet = openPathsOf();
        const plan = buildBatchPlan(groups, {
            ...opts,
            libraryPath: opts.libraryPath || dedupeRootOf(kind),
            isOpenPath: opts.isOpenPath || ((p) => openSet.has(p)),
        });
        dedupeBatchPlan.value = { kind, ...plan };
        // 点击后必须有可见反馈（否则同规则二次预演"看起来像没反应"）
        const stats = dedupeBatchPlan.value.stats || {};
        const msg = stats.files
            ? `👁 预演完成：将清理 ${stats.groupsPlanned} 组 / ${stats.files} 个文件（约 ${(Number(stats.bytes || 0) / 1024 / 1024).toFixed(1)} MB）`
                + (stats.skipByReason && Object.keys(stats.skipByReason).length
                    ? `；跳过 ${Object.entries(stats.skipByReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`
                    : '')
            : '👁 预演完成：当前规则下没有可清理的文件（可调整「处理范围」或检查是否都已是最新版）';
        if (typeof showToast === 'function') showToast(msg, stats.files ? 'info' : 'warning', 4000);
        if (typeof addLog === 'function') addLog(msg, 'info');
        return dedupeBatchPlan.value;
    };

    /**
     * 执行批量清理（先预演/确认，再分批 trashFiles）
     * @param {'card'|'wb'|'preset'|'content'} kind
     * @param {object} opts 同 preview，另支持 `{ skipConfirm, plan }`（skipConfirm 仅 dev 端到端用）
     */
    const executeDedupeBatch = async (kind = 'card', opts = {}) => {
        const quiet = !!(opts && opts.skipConfirm);
        if (dedupeBatchExec.value.running) return null;

        const plan = (opts && opts.plan) || previewDedupeBatch(kind, opts);
        const deletions = (plan && plan.deletions) || [];
        if (!deletions.length) {
            if (!quiet && typeof nativeAlert === 'function') nativeAlert('没有需要清理的文件（可调整「处理范围」后重新预演）。', 'info');
            return null;
        }

        if (typeof confirmDialog !== 'function') {
            if (typeof nativeAlert === 'function') nativeAlert('清理确认对话框不可用（confirmDialog 未注入），已取消。', 'error');
            return null;
        }
        const mb = ((plan.stats.bytes || 0) / 1024 / 1024).toFixed(1);
        const samples = deletions.slice(0, 5).map((d) => `  · ${String(d.path).split(/[\\/]/).pop()}（${d.groupName}）`).join('\n');
        const riskyScopes = [];
        if (plan.options && plan.options.scopes) {
            if (plan.options.scopes.similar) riskyScopes.push('高度相似(L1/L2)');
            if (plan.options.scopes.nameonly) riskyScopes.push('仅名称相同');
        }
        if (!quiet) {
            const ok = await confirmDialog(
                `即将把 ${plan.stats.groupsPlanned} 组里的 ${deletions.length} 个重复/旧版文件移入回收站`
                + `（约 ${mb} MB，每组都会保留 1 张）：\n\n${samples}`
                + (deletions.length > 5 ? `\n  …还有 ${deletions.length - 5} 个` : '')
                + (riskyScopes.length
                    ? `\n\n🚨 本次包含高风险范围：${riskyScopes.join('、')}。\n这些组并非「内容完全一致」，请确认已逐组看过差异。`
                    : '')
                + '\n\n文件会进回收站，可在「打开回收站」里找回。是否继续？'
            );
            if (!ok) return null;
            if (riskyScopes.length) {
                const ok2 = await confirmDialog(`二次确认：包含「${riskyScopes.join('、')}」的组，删错需要手动去回收站捞。\n确定继续？`);
                if (!ok2) return null;
            }
        }

        const api = window.electronAPI;
        if (!api || typeof api.trashFiles !== 'function') {
            if (typeof nativeAlert === 'function') nativeAlert('❌ 回收站接口不可用（preload 未提供 trashFiles），已取消清理。', 'error');
            return null;
        }

        batchAbort = false;
        dedupeBatchExec.value = { running: true, done: 0, total: deletions.length, deleted: 0, deletedPaths: [], failed: [], aborted: false, finishedAt: 0 };
        const failedList = [];
        const trashed = [];

        try {
            const timeoutMs = Math.max(50, Number(opts && opts.batchTimeoutMs) || BATCH_TIMEOUT_MS);
            for (const chunk of chunkList(deletions, BATCH_CHUNK)) {
                if (batchAbort) { dedupeBatchExec.value.aborted = true; break; }
                const res = await withTimeout(
                    api.trashFiles(chunk.map((d) => d.path)),
                    timeoutMs,
                    () => ({ success: false, error: `批次超时（${Math.round(timeoutMs / 1000)} 秒无响应）`, failed: [] })
                );
                const failedPaths = new Set(((res && res.failed) || []).map((f) => f && f.path).filter(Boolean));
                for (const d of chunk) {
                    if (failedPaths.has(d.path)) continue;
                    // 整批失败（success=false 但无分项）也要如实计入失败，绝不虚报成功
                    if (res && res.success === false && failedPaths.size === 0) {
                        failedList.push({ path: d.path, groupName: d.groupName, cardName: d.cardName, error: res.error || '未知错误' });
                        continue;
                    }
                    trashed.push(d.path);
                }
                for (const f of ((res && res.failed) || [])) {
                    const hit = chunk.find((d) => d.path === (f && f.path));
                    failedList.push({
                        path: (f && f.path) || '',
                        groupName: (hit && hit.groupName) || '',
                        cardName: (hit && hit.cardName) || '',
                        error: (f && f.error) || '未知错误',
                    });
                }
                dedupeBatchExec.value.done += chunk.length;
                dedupeBatchExec.value.deleted = trashed.length;
                dedupeBatchExec.value.deletedPaths = trashed.slice(); // ♻️ 撤销依据（本次成功移入回收站的路径）
                dedupeBatchExec.value.failed = failedList.slice();
                await new Promise((r) => setTimeout(r, 0)); // 让出主线程：进度条可刷新、可中止
            }
        } catch (e) {
            // 兜底：循环里任何未预期异常都要留痕，但不阻断收尾
            failedList.push({ path: '', groupName: '', cardName: '', error: `执行异常：${(e && e.message) || e}` });
            if (typeof addLog === 'function') addLog(`❌ 批量清理异常：${(e && e.message) || e}`, 'error');
        } finally {
            // 🛡️ 生死线：无论成功 / 异常 / 中止都必须解锁 running
            //    （旧实现只在正常路径置 false —— 一旦抛错，「预演」按钮就永久变灰，四个窗口一起瘫）
            dedupeBatchExec.value.failed = failedList.slice(); // 兜底：异常分支的失败项也要可见
            dedupeBatchExec.value.running = false;
            dedupeBatchExec.value.finishedAt = Date.now();
        }

        await applyTrashedPaths(kind, trashed, new Set(failedList.map((f) => f.path)));
        pruneGroupsAfterTrash(kind, new Set(trashed));
        dedupeBatchPlan.value = plan.deletions.length === trashed.length ? null : previewDedupeBatch(kind, opts);

        const summary = `🧹 批量清理${dedupeBatchExec.value.aborted ? '已中止' : '完成'}：移入回收站 ${trashed.length} 个`
            + (failedList.length ? `，失败 ${failedList.length} 个（可「重试失败项」）` : '，无失败')
            + (dedupeBatchExec.value.aborted ? '（剩余未执行的仍在预演清单里）' : '');
        if (typeof addLog === 'function') addLog(summary, failedList.length ? 'warning' : 'info');
        if (typeof showToast === 'function') showToast(summary, failedList.length ? 'warning' : 'success', 5000);
        if (!quiet && typeof nativeAlert === 'function') {
            const reasonTop = {};
            for (const f of failedList) {
                const key = /占用|EBUSY|EPERM/i.test(f.error) ? '文件被占用' : (f.error || '未知错误');
                reasonTop[key] = (reasonTop[key] || 0) + 1;
            }
            const detail = Object.entries(reasonTop).map(([k, v]) => `  · ${k}：${v} 个`).join('\n');
            const missingCount = failedList.filter((f) => isMissingError(f.error)).length;
            nativeAlert(
                summary + (detail ? `\n\n失败原因分布：\n${detail}` : '')
                + (missingCount ? `\n\n其中 ${missingCount} 个在磁盘上已不存在（失效条目）—— 可在工具条里点「🧹 移除失效条目」只清理列表。` : '')
                + trashHints(failedList),
                failedList.length ? 'warning' : 'info'
            );
        }
        return dedupeBatchExec.value;
    };

    /**
     * ♻️ P5：撤销「本次批量清理」（把这一批移入回收站的文件按原路径还原）
     * · 只还原**本次批量**实际删掉的那些（`dedupeBatchExec.deletedPaths`），不影响历史批次；
     * · 还原后自动重扫对应库，列表/分组与磁盘重新一致。
     */
    const undoDedupeBatch = async (kind = 'card') => {
        const paths = Array.isArray(dedupeBatchExec.value.deletedPaths) ? dedupeBatchExec.value.deletedPaths.slice() : [];
        if (!paths.length) {
            if (typeof nativeAlert === 'function') nativeAlert('没有可撤销的记录（本次批量没有成功移入回收站的文件）。', 'info');
            return null;
        }
        const api = window.electronAPI;
        if (!api || typeof api.restoreFromTrash !== 'function') {
            if (typeof nativeAlert === 'function') nativeAlert('❌ 撤销接口不可用（preload 未提供 restoreFromTrash）。', 'error');
            return null;
        }
        if (typeof confirmDialog === 'function') {
            const ok = await confirmDialog(`将把本次移入回收站的 ${paths.length} 个文件**还原回原位**。\n（原位置已有同名文件时会另存为 _restored_<时间戳>，绝不覆盖）\n\n是否继续？`);
            if (!ok) return null;
        }
        // 🔁 分批还原：1000 个文件一次性 IPC 会超时误报（且主进程仍在还原 → 二次撤销互撞）
        const restored = [];
        const failed = [];
        for (const chunk of chunkList(paths, BATCH_CHUNK)) {
            const res = await withTimeout(
                api.restoreFromTrash(chunk),
                BATCH_TIMEOUT_MS,
                () => ({ success: false, restored: [], failed: chunk.map((p) => ({ path: p, error: '撤销超时（未响应）' })), blocked: [] })
            );
            for (const r of ((res && res.restored) || [])) restored.push(r);
            for (const f of ((res && res.failed) || [])) failed.push(f);
        }
        if (restored.length) {
            dedupeBatchExec.value.deletedPaths = paths.filter((p) => !restored.some((r) => r.original === p));
            dedupeBatchExec.value.deleted = Math.max(0, (dedupeBatchExec.value.deleted || 0) - restored.length);
            dedupeBatchPlan.value = null; // 原计划已失效，避免"撤销后还显示要删"
            // 还原后尽量刷新列表，让「列表 ↔ 磁盘」重新一致
            const mode = appMode && appMode.value;
            const realKind = kind === 'content'
                ? (mode === 'worldbooks' ? 'wb' : mode === 'presets' ? 'preset' : 'card')
                : kind;
            try {
                if (realKind === 'card' && typeof refreshLibrary === 'function') await refreshLibrary();
                else if (realKind === 'wb' && typeof rescanWorldbooks === 'function') await rescanWorldbooks();
                else if (realKind === 'preset' && typeof addLog === 'function') {
                    addLog('♻️ 已还原预设文件；预设列表需「重扫/重新打开目录」后刷新', 'info');
                }
            } catch (e) { /* 重扫失败不影响撤销结论 */ }
        }
        const renamed = restored.filter((r) => r.renamed).length;
        const summary = `♻️ 撤销完成：还原 ${restored.length} 个`
            + (renamed ? `（其中 ${renamed} 个因原位已存在另存为 _restored_*）` : '')
            + (failed.length ? `，失败 ${failed.length} 个` : '');
        if (typeof addLog === 'function') addLog(summary, failed.length ? 'warning' : 'info');
        if (typeof showToast === 'function') showToast(summary, failed.length ? 'warning' : 'success', 5000);
        if (failed.length && typeof nativeAlert === 'function') {
            const lines = failed.slice(0, 8).map((f) => `  · ${String(f.path).split(/[\\/]/).pop()} —— ${f.error}`).join('\n');
            nativeAlert(`${summary}\n\n未还原的文件：\n${lines}` + (failed.length > 8 ? `\n  …还有 ${failed.length - 8} 个` : ''), 'warning');
        }
        return { restored, failed };
    };

    /** 移除批量清单里「文件不存在」的失效条目（只动列表，不动磁盘 —— DF-33） */    const purgeDedupeBatchMissing = async (kind = 'card') => {
        const failed = dedupeBatchExec.value.failed || [];
        const missing = failed.filter((f) => f && f.path && isMissingError(f.error));
        if (!missing.length) {
            if (typeof showToast === 'function') showToast('没有「文件不存在」的失效条目可移除', 'info', 3000);
            return 0;
        }
        if (typeof confirmDialog === 'function') {
            const ok = await confirmDialog(
                `将从**列表**中移除 ${missing.length} 个磁盘上已不存在的条目（不动磁盘文件）。是否继续？`
            );
            if (!ok) return 0;
        }
        const n = await removeGhostEntries(kind, missing.map((f) => f.path));
        dedupeBatchExec.value.failed = failed.filter((f) => !isMissingError(f.error));
        if (typeof showToast === 'function') showToast(`✅ 已移除 ${n} 个失效条目（磁盘未改动）`, 'success', 4000);
        return n;
    };

    /** 中止批量清理（已完成的不回退；剩余项保留在预演清单里；2 秒后强制复位，防状态卡死） */
    const abortDedupeBatch = () => {
        if (!dedupeBatchExec.value.running) return;
        batchAbort = true;
        if (typeof showToast === 'function') showToast('正在中止…（已完成的不回退）', 'info', 2000);
        setTimeout(() => {
            if (!dedupeBatchExec.value.running) return;
            // 兜底复位：IPC 无响应时也必须把 UI 解锁（否则「预演」永久变灰）
            dedupeBatchExec.value.running = false;
            dedupeBatchExec.value.aborted = true;
            dedupeBatchExec.value.finishedAt = Date.now();
            if (typeof showToast === 'function') showToast('⏹ 已强制中止（状态已复位，可重新预演）', 'warning', 4000);
            if (typeof addLog === 'function') addLog('⏹ 批量清理已强制中止（状态复位）', 'warning');
        }, 2000);
    };

    /** 重试失败项（仅重跑这批路径，不重新生成计划） */
    const retryDedupeBatchFailures = async (kind = 'card') => {
        const failed = (dedupeBatchExec.value.failed || []).filter((f) => f && f.path);
        if (!failed.length || dedupeBatchExec.value.running) return null;
        const api = window.electronAPI;
        if (!api || typeof api.trashFiles !== 'function') return null;
        const res = await api.trashFiles(failed.map((f) => f.path));
        const stillFailed = new Set(((res && res.failed) || []).map((f) => f && f.path).filter(Boolean));
        const okPaths = failed.map((f) => f.path).filter((p) => !stillFailed.has(p));
        if (okPaths.length) {
            await applyTrashedPaths(kind, okPaths, stillFailed);
            pruneGroupsAfterTrash(kind, new Set(okPaths));
        }
        dedupeBatchExec.value.failed = failed.filter((f) => stillFailed.has(f.path));
        dedupeBatchExec.value.deleted = (dedupeBatchExec.value.deleted || 0) + okPaths.length;
        const msg = `重试完成：成功 ${okPaths.length} 个` + (stillFailed.size ? `，仍失败 ${stillFailed.size} 个` : '');
        if (typeof showToast === 'function') showToast(msg, stillFailed.size ? 'warning' : 'success', 4000);
        if (typeof addLog === 'function') addLog(`🧹 查重批量·${msg}`, stillFailed.size ? 'warning' : 'info');
        return { ok: okPaths.length, failed: dedupeBatchExec.value.failed };
    };

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
        // 🧹 批量清理（预演 / 执行 / 中止 / 重试失败项）
        dedupeBatchPlan, dedupeBatchExec, previewDedupeBatch, executeDedupeBatch,
        abortDedupeBatch, retryDedupeBatchFailures, purgeDedupeBatchMissing, removeGhostEntries,
        undoDedupeBatch,
        dedupeScanning, dedupeScanLabel, dedupeScanPercent, dedupeScanIndeterminate,
        dedupeScanDone, dedupeScanTotal,
        showDiffDetailModal, diffMasterItem, diffCompareItem, diffFieldResults, openDiffDetailModal
    };
}
