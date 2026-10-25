/**
 * 🧪 一键质检流水线（编排 + 汇总）— Composable
 *
 * 设计原则（规格 §一）：**只做编排与汇总**，每步复用现有能力，**不复制实现、不引入第二套口径**；
 * 全流程**只读**（不动库、不删文件、不保存任何配置）。
 *
 * 步骤（v1，规格 §二）：
 *   S1 重新扫描     → 注入的 `refreshLibrary`
 *   S2 查重扫描     → 注入的 `startSmartDedupe`（按库分发）
 *   S3 标签分析     → `js/utils/tagStats.js::computeTagStats`
 *   S4 卡片质量巡检 → `js/utils/cardAudit.js::auditCards`
 *   S5 世界书体检   → 注入的 `entryHealthReport`（**范围 = 当前打开的书**；未打开 → skipped）
 *
 * 健壮性：每步 try/catch（失败记录后**继续**，不阻断后续）；步骤间与长循环内检查取消标志；
 *        大库分片遍历（每 `CHUNK` 项让出一次微任务），避免长任务卡 UI（PK-34 同款纪律）。
 *
 * 规格：`docs/规格与计划/功能规格/一键质检流水线-实现规格.md`
 */
import { ref, reactive, computed } from 'vue';
import { computeTagStats } from '../utils/tagStats.js';
import { auditCards, DEFAULT_TOKEN_THRESHOLD } from '../utils/cardAudit.js';
import { buildPortrait, portraitReportLines } from '../utils/libraryPortrait.js';   // 📊 结构画像（阶段二）

/** 大库分片粒度：每 200 项让出一次（规格 §3.1） */
export const CHUNK = 200;

/**
 * 步骤定义（顺序即执行顺序；`defaultOn` 为默认勾选态）
 *
 * ⚠️ 面向用户的文案里**不要出现 S1/S2/S3 这类内部编号**（用户明确反馈「看不懂、不该出现」）。
 *    编号只保留在本文件的注释与代码 `id` 中，用于内部引用与报告定位；
 *    界面标题一律用**人能读懂的动作名**。
 *    报告里的定论文案（如「需要先做标签分析」）同样用动作名，不写编号。
 */
export const QC_STEPS = [
    { id: 'rescan', title: '刷新卡库数据', desc: '重新扫描一遍卡库，确保下面的检查都用最新数据', defaultOn: true },
    { id: 'dedupe', title: '查重扫描', desc: '找出重复/高度相似的卡片（结果可在查重弹窗里细看）', defaultOn: true },
    { id: 'tags', title: '标签分析', desc: '统计无标签卡、标签覆盖率、单标签卡与热门标签榜', defaultOn: true },
    { id: 'audit', title: '卡片质量巡检', desc: '检查简介为空、没有标签、开场白为空、内容过大等问题', defaultOn: true },
    { id: 'wb', title: '世界书词条体检', desc: '检查当前打开的世界书：空词条 / 孤儿词条 / 重复词条', defaultOn: true }
];

/** 让出主线程（分片用；不依赖 setTimeout 精度，只要一个微/宏任务边界） */
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export function useQualityCheck(deps = {}) {
    const library = deps.library || ref([]);
    const worldbooks = deps.worldbooks || ref([]);
    const activeWorldbook = deps.activeWorldbook || ref(null);
    // 📊 结构画像需要对比「标签池」；未注入时按空池处理（画像的池健康度会提示「池为空」）
    const systemCommonTags = deps.systemCommonTags || ref([]);
    const estimateCardTokens = deps.estimateCardTokens || null;
    const refreshLibrary = deps.refreshLibrary || null;
    const startSmartDedupe = deps.startSmartDedupe || null;
    const entryHealthReport = deps.entryHealthReport || null;
    const addLog = typeof deps.addLog === 'function' ? deps.addLog : (() => { });
    const showToast = typeof deps.showToast === 'function' ? deps.showToast : (() => { });
    const openWbDedupeModal = deps.openWbDedupeModal || null;
    const openCardByPath = deps.openCardByPath || null;

    const showQualityCheckModal = ref(false);
    const running = ref(false);
    const cancelRequested = ref(false);
    const startedAt = ref(0);
    const elapsedMs = ref(0);
    const tokenThreshold = ref(DEFAULT_TOKEN_THRESHOLD);
    const enabled = reactive(Object.fromEntries(QC_STEPS.map((s) => [s.id, s.defaultOn])));
    /** 每步结果：{id,title,status,summary,items,error,ms} */
    const steps = ref(QC_STEPS.map((s) => ({ id: s.id, title: s.title, status: 'pending', summary: '', items: [], error: '', ms: 0 })));
    const report = ref(null);
    const currentIndex = computed(() => {
        const i = steps.value.findIndex((s) => s.status === 'running');
        if (i >= 0) return i;
        const done = steps.value.filter((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed').length;
        return Math.min(done, steps.value.length - 1);
    });

    const setStep = (id, patch) => {
        const s = steps.value.find((x) => x.id === id);
        if (s) Object.assign(s, patch);
    };

    // ── 📊 结构画像（阶段二 · 上游 Q1/Q2/Q11：作为本弹窗的第 2 个页签） ──────────
    //   ⚠️ 刻意**不新建弹窗 / 不新增命令** —— 与质检共享同一份生命周期，
    //      「未跑质检就点画像」不存在空态歧义（未跑时 readiness 全 false，UI 提示先跑质检）。
    //   ⚠️ 必须**显式依赖** steps.value 与 library.value / systemCommonTags.value，
    //      否则会重蹈 AI-16 / CT-02「computed 缺依赖 ⇒ 永远停在旧值」。
    const portrait = computed(() => {
        // 从已完成的步骤里取数据（S3 的 tagStats / S4 的 token 结果）
        const s3 = steps.value.find((x) => x.id === 'tags');
        const s4 = steps.value.find((x) => x.id === 'audit');
        const tagStats = (s3 && (s3.status === 'done' || s3.status === 'cancelled') && s3.data) ? s3.data : null;

        // S4 已跑 ⇒ 复用它的 token 结果，避免对 11k 库二次全量遍历（上游补充 3）
        let tokenSample = null;
        if (s4 && (s4.status === 'done' || s4.status === 'cancelled') && s4.data && s4.data.tokenSample) {
            tokenSample = s4.data.tokenSample;
        }

        return buildPortrait(library.value || [], {
            tagStats,
            commonTags: systemCommonTags.value || [],
            estimateCardTokens,
            tokenSample
        });
    });

    /** 画像是否已有可用数据（UI 用来决定显示「先跑质检」还是真图表） */
    const hasPortrait = computed(() => {
        const r = portrait.value && portrait.value.readiness;
        return !!(r && (r.matrix || r.poolHealth || r.tokenStats));
    });

    /** 打开弹窗（并把上一次结果留着，便于对照） */
    const openQualityCheck = () => { showQualityCheckModal.value = true; };
    const cancel = () => { if (running.value) { cancelRequested.value = true; addLog('🧪 质检：已请求中止（当前步骤跑完即停）', 'warning'); } };

    // ── 各步实现 ─────────────────────────────────────────────

    /** S1 重新扫描 */
    const stepRescan = async () => {
        if (typeof refreshLibrary !== 'function') return { status: 'skipped', summary: '（当前环境无扫描入口）' };
        await refreshLibrary();
        return { status: 'done', summary: `已重新扫描：${library.value.length} 张卡` };
    };

    /** S2 查重扫描（复用现有；按库分发由调用方负责） */
    const stepDedupe = async () => {
        if (typeof startSmartDedupe !== 'function') return { status: 'skipped', summary: '（未接线查重入口）' };
        await startSmartDedupe();
        return { status: 'done', summary: '查重已执行（结果见对应查重弹窗）' };
    };

    /** S3 标签分析（分片遍历 + 让出） */
    const stepTags = async () => {
        const items = library.value || [];
        let acc = { total: 0, untagged: 0, singleTag: 0, top: new Map() };
        // ⚠️ 分片只为「让 UI 有呼吸」：统计口径与一次性调用 computeTagStats 完全一致（同一函数、同一切片汇总）
        for (let i = 0; i < items.length; i += CHUNK) {
            if (cancelRequested.value) return { status: 'cancelled', summary: '已中止' };
            const part = items.slice(i, i + CHUNK);
            const s = computeTagStats(part, { topN: 1000, capItems: 1 });
            acc.total += s.total;
            acc.untagged += s.untagged;
            acc.singleTag += s.singleTag;
            for (const [k, v] of s.tagCounts) acc.top.set(k, (acc.top.get(k) || 0) + v);
            if (i + CHUNK < items.length) await yieldToUi();
        }
        const full = computeTagStats(items);   // 终值口径（与分片结果一致，取终值更直观）
        const topTags = [...acc.top.entries()].map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag)).slice(0, 15);
        // 📊 阶段二：结构画像（标签×分组矩阵 / 标签池健康度）需要**全量** tagCounts。
        //    `full.tagCounts` 是 Map，不能直接放进 report 数据（也便于探针 returnByValue），
        //    ⇒ 转成数组随 data 一起传出；`buildPortrait` 两种形态都接受。
        return {
            status: 'done',
            summary: `共 ${full.total} 张卡：无标签 ${full.untagged} 张、覆盖率 ${full.coveragePct}%、单标签 ${full.singleTag} 张、标签种类 ${acc.top.size}`,
            items: [
                ...full.untaggedItems.slice(0, 50).map((x) => ({ kind: 'card', path: x.path, name: x.name, detail: '无标签' })),
                ...topTags.map((t) => ({ kind: 'tag', name: t.tag, detail: `${t.count} 张卡`, tag: t.tag }))
            ],
            data: {
                total: full.total, untagged: full.untagged, coveragePct: full.coveragePct,
                singleTag: full.singleTag, tagCount: acc.top.size, topTags,
                // ⚠️ 画像专用：全量标签计数（`[[tag, count], ...]`，按 count 降序）
                tagCounts: [...acc.top.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
            }
        };
    };

    /** S4 卡片质量巡检（分片遍历） */
    const stepAudit = async () => {
        const items = library.value || [];
        const merged = new Map();
        let scanned = 0;
        // 📊 阶段二：顺手把每卡 token 收集起来，供「结构画像」复用，避免 11k 库二次全量遍历。
        //    索引与 library 一一对应（分片遍历是顺序推进，所以 push 顺序 == 库顺序）。
        const tokenSample = [];
        for (let i = 0; i < items.length; i += CHUNK) {
            if (cancelRequested.value) return { status: 'cancelled', summary: '已中止' };
            const part = items.slice(i, i + CHUNK);
            const r = auditCards(part, { tokenThreshold: tokenThreshold.value, estimateCardTokens });
            for (const rule of r.rules) {
                const m = merged.get(rule.id) || { id: rule.id, title: rule.title, hint: rule.hint, count: 0, hits: [] };
                m.count += rule.count;
                for (const h of rule.hits) { if (m.hits.length < 50) m.hits.push(h); }
                merged.set(rule.id, m);
            }
            // 复用同一个估算函数（缺失时按 0，与 auditCards 内部口径一致）
            for (const it of part) {
                let t = 0;
                try { t = Number(estimateCardTokens ? estimateCardTokens(it) : ((it && it._tokens) || 0)) || 0; } catch (e) { t = 0; }
                tokenSample.push(t);
            }
            scanned += part.length;
            if (i + CHUNK < items.length) await yieldToUi();
        }
        const rules = [...merged.values()];
        const totalHits = rules.reduce((n, r) => n + r.count, 0);
        return {
            status: 'done',
            summary: `巡检 ${scanned} 张卡：${rules.map((r) => `${r.title} ${r.count}`).join(' / ')}（阈值 ${tokenThreshold.value} token）`,
            items: rules.flatMap((r) => r.hits.map((h) => ({ kind: 'card', path: h.path, name: h.name, detail: `${r.title}${h.detail ? ' · ' + h.detail : ''}` }))),
            data: { total: scanned, totalHits, rules, tokenSample }
        };
    };

    /** S5 世界书词条体检（范围 = 当前打开的书） */
    const stepWb = async () => {
        const active = activeWorldbook.value;
        if (!active) return { status: 'skipped', summary: '跳过（未打开世界书）' };
        let r = null;
        if (entryHealthReport && typeof entryHealthReport === 'object' && 'value' in entryHealthReport) r = entryHealthReport.value;
        else if (typeof deps.computeEntryHealth === 'function') r = deps.computeEntryHealth(active);
        if (!r) return { status: 'skipped', summary: '跳过（体检函数未接线）' };
        const entries = (active.data && active.data.entries) || [];
        return {
            status: 'done',
            summary: `《${active.name || '当前世界书'}》共 ${Array.isArray(entries) ? entries.length : Object.keys(entries).length} 条：空词条 ${r.emptyCount} / 孤儿触发词 ${r.orphanCount} / 重复 ${r.duplicateCount}（${r.groupCount} 组）`,
            items: [
                ...(r.empty || []).slice(0, 20).map((e) => ({ kind: 'wb-entry', name: String(e.comment || e.key || '(空词条)'), detail: '空词条' })),
                ...(r.orphan || []).slice(0, 20).map((e) => ({ kind: 'wb-entry', name: String(e.comment || '(孤儿触发词)'), detail: '孤儿触发词（有正文无触发词）' }))
            ],
            data: { emptyCount: r.emptyCount, orphanCount: r.orphanCount, duplicateCount: r.duplicateCount, groupCount: r.groupCount, bookName: active.name || '' }
        };
    };

    const RUNNERS = { rescan: stepRescan, dedupe: stepDedupe, tags: stepTags, audit: stepAudit, wb: stepWb };

    // ── 主流程 ─────────────────────────────────────────────

    /** 串行执行勾选步骤；失败不阻断 */
    const run = async () => {
        if (running.value) { showToast('质检已在运行中', 'warning'); return null; }
        // 重置
        running.value = true;
        cancelRequested.value = false;
        startedAt.value = nowMs();
        elapsedMs.value = 0;
        steps.value = QC_STEPS.map((s) => ({
            id: s.id, title: s.title,
            status: enabled[s.id] ? 'pending' : 'skipped',
            summary: enabled[s.id] ? '' : '未勾选（跳过）',
            items: [], error: '', ms: 0
        }));
        report.value = null;

        for (const s of QC_STEPS) {
            if (!enabled[s.id]) continue;
            if (cancelRequested.value) { setStep(s.id, { status: 'cancelled', summary: '用户中止' }); continue; }
            const t0 = nowMs();
            setStep(s.id, { status: 'running', summary: '执行中…' });
            try {
                const r = await RUNNERS[s.id]();
                setStep(s.id, {
                    status: r.status || 'done',
                    summary: r.summary || '',
                    items: r.items || [],
                    data: r.data || null,
                    error: r.error || '',
                    ms: Math.round(nowMs() - t0)
                });
            } catch (e) {
                // ⚠️ 失败**记录后继续**（规格 §3.1）——一步坏不拖垮整条流水线
                setStep(s.id, { status: 'failed', summary: '失败', error: (e && e.message) || String(e), ms: Math.round(nowMs() - t0) });
                addLog(`🧪 质检步骤失败（${s.title}）：${(e && e.message) || e}`, 'error');
            }
        }

        elapsedMs.value = Math.round(nowMs() - startedAt.value);
        running.value = false;
        report.value = buildReport();
        const failed = steps.value.filter((x) => x.status === 'failed').length;
        addLog(`🧪 一键质检完成：${steps.value.filter((x) => x.status === 'done').length} 步完成${failed ? `、${failed} 步失败` : ''}，用时 ${(elapsedMs.value / 1000).toFixed(1)}s`, failed ? 'warning' : 'success');
        showToast(`质检完成（用时 ${(elapsedMs.value / 1000).toFixed(1)}s）`, failed ? 'warning' : 'success');
        return report.value;
    };

    /** 汇总文本（复制 / 导出用；纯文本 Markdown 友好） */
    const buildReport = () => {
        const lines = [];
        lines.push('# 🧪 一键质检报告');
        lines.push('');
        lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
        lines.push(`- 卡库：共 ${library.value.length} 张卡 ｜ 世界书库：${worldbooks.value.length} 本`);
        lines.push(`- 用时：${(elapsedMs.value / 1000).toFixed(1)} 秒 ｜ Token 阈值：${tokenThreshold.value}`);
        lines.push(`- 说明：本报告**只读**生成（未修改/删除任何文件）；动手清理前建议先做「📦 整库冷备」`);
        lines.push('');
        for (const s of steps.value) {
            lines.push(`## ${s.title}`);
            lines.push('');
            lines.push(`- 状态：${statusLabel(s.status)}${s.error ? `（${s.error}）` : ''}`);
            lines.push(`- 摘要：${s.summary || '—'}`);
            if (s.ms) lines.push(`- 耗时：${(s.ms / 1000).toFixed(2)}s`);
            const d = s.data;
            if (d && d.topTags && d.topTags.length) {
                lines.push('- Top 标签：' + d.topTags.map((t) => `${t.tag}(${t.count})`).join('、'));
            }
            if (d && Array.isArray(d.rules)) {
                for (const r of d.rules) if (r.count) lines.push(`- ${r.title}：${r.count} 张（前几条：${r.hits.slice(0, 3).map((h) => h.name).join('、')}）`);
            }
            if (s.items && s.items.length) {
                lines.push(`- 清单（前 ${Math.min(s.items.length, 50)} 条）：`);
                for (const it of s.items.slice(0, 50)) lines.push(`  - ${it.name || it.path}${it.detail ? ' — ' + it.detail : ''}`);
            }
            lines.push('');
        }
        // 📊 结构画像三小段（上游 Q9：并入同一份 Markdown，不另做导出）
        try {
            const pl = portraitReportLines(portrait.value);
            if (pl.length) {
                lines.push('## 📊 结构画像');
                lines.push('');
                lines.push(...pl);
                lines.push('');
            }
        } catch (e) { /* 画像摘要失败不影响主报告 */ }
        return lines.join('\n');
    };

    const statusLabel = (st) => ({ pending: '待执行', running: '执行中', done: '✅ 完成', skipped: '⏭ 跳过', failed: '❌ 失败', cancelled: '⛔ 已中止' }[st] || st);

    /**
     * 定位：把用户**带到目标前面**
     * ⚠️ 必须先收起质检弹窗 —— 它是全屏遮罩，目标卡/查重弹窗开在它后面等于"点了没反应"（用户实测反馈）。
     *    报告本身不丢（状态就在本 composable 里），重新打开弹窗还在。
     */
    const locate = async (item) => {
        if (!item) return;
        if (item.kind === 'card' && item.path && typeof openCardByPath === 'function') {
            showQualityCheckModal.value = false;          // 先让位，再打开目标
            await openCardByPath(item.path);
            try { addLog(`🧪 质检定位：已打开《${item.name || item.path}》`, 'info'); } catch (e) { /* 忽略 */ }
            try { showToast(`已定位到《${item.name || '目标卡'}》`, 'success', 2500); } catch (e) { /* 忽略 */ }
            return;
        }
        if (item.kind === 'dedupe' && typeof openWbDedupeModal === 'function') {
            showQualityCheckModal.value = false;
            openWbDedupeModal();
            return;
        }
        showToast('该项暂不支持定位', 'info');
    };

    return {
        // 状态
        showQualityCheckModal, running, cancelRequested, steps, currentIndex, report,
        enabled, tokenThreshold, elapsedMs, elapsedSec: computed(() => (elapsedMs.value / 1000).toFixed(1)),
        // 📊 结构画像（阶段二）
        portrait, hasPortrait, systemCommonTags,
        // 动作
        openQualityCheck, closeQualityCheck: () => { showQualityCheckModal.value = false; }, run, cancel, locate, buildReport,
        // 常量透出（UI 用）
        QC_STEPS
    };
}
