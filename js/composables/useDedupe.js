/**
 * 查重与差异比对功能组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：角色卡查重、世界书查重、以及双屏差异比对器（Diff Inspector）。
 * 依赖通过参数注入；estimateCardTokens 为共享工具保留在 App.vue，此处作为依赖传入。行为保持不变。
 */
import { ref, triggerRef } from 'vue';
import { alignEntryLists, summarizeAlignment, normalizeEntries } from '../utils/entryAlign.js';
import { diffContentForDisplay } from '../utils/textDiff.js';

export function useDedupe({
    library, worldbooks, activeWorldbook, cardData,
    presets, activePreset, appMode,
    estimateCardTokens,
    nativeAlert, confirmDialog, addLog, reset, cleanupEmptyCategories, deleteCardOverlays,
    // 🔔 T1：非阻塞反馈（由 App.vue 经 ctx 注入；本仓库没有 $toast，也没有 useToast.js）。
    //    成功路径用 showToast（不打断用户），失败路径仍走 nativeAlert 保留可复制的文件名详情。
    showToast,
    // 📊🔍 查重/版本对比的**扫描进度**（2026-09-22 设计修正）
    //    用户定性：进度是「查重 / 版本对比」的体现，**不是**「浏览/加载库」的体现
    //    （规格 TC-07：「上百本世界书查重：有进度指示 + 当前项名」；最终方案 §185：「进度应挂到扫描阶段」）。
    //    ⇒ 查重开始前先重扫磁盘（拿到最新数据 + 真实进度），进度条显示在**查重弹窗内**。
    rescanWorldbooks, wbScanProgress, isWbScanning, wbScanPercent,
    // 角色卡侧：重扫入口与「上次目录」（refreshLibrary 无进度信号，故用不定态进度条）
    refreshLibrary, currentFolderPath,
    lastWorldbookDirPath, lastPresetDirPath,
    // 🦥 PK-20 后续（2026-09-22）：懒加载的书 `data` 为 null，
    //    而查重 / 差异比对都**必须读正文**（`extractContentText` 取 `data.entries`）。
    //    若不管：未内联的书提取到空文本 → 被 `text.length < 20` 跳过 →
    //    内容级查重对它们**完全失效**（实测 1001 本库里 944 本未内联 → 0 候选）。
    //    故查重前必须**按需载入正文**（复用既有 DF-18 机制）。
    ensureWorldbookLoaded,
    // ⚡ PK-26（2026-09-22）：秒开后 `wb.data` 常为 null，**轻量字段才是可靠来源**。
    //    这两个由 `useWorldbooks` 提供：`wbEntryCount` 优先 `entryCount`、`wbDisplayName` 优先 `wbName`。
    //    ⚠️ 不注入它们会导致查重「静默算出 0 条 / 0% 重合度」（用户实测报出的 4 个问题，见 PK-26）。
    wbEntryCount, wbDisplayName,
    // ⚡ PK-26：选中世界书必须走它 —— 它会 `ensureWorldbookLoaded` 再设 `activeWorldbook`。
    //    直接 `activeWorldbook.value = wb` 会设成一本 `data === null` 的书 → 编辑器读 `data.entries` 崩溃。
    selectWorldbook,
    // ⚡ PK-26 后续：批量流程（同名查重逐本读正文）必须**用后释放**，否则 1000+ 本会重演 PK-20 的 OOM。
    releaseWorldbookBody,
    // 🧯 PK-27（2026-09-22）：**唯一**的「批量读正文」入口 ——
    //    受控并发（默认顺序）+ 每本用完即释放 + 进度回调。
    //    ⚠️ 任何「批量读世界书正文」的新代码**必须**走它，不得自己写 `Promise.all` 循环。
    consumeWorldbookBodies,
    // 🧠 PK-27 / S2'：L1 摘要消费（**查重只读索引，永不重读正文**）
    hasKeyIndex, compareKeyHashes, isExactSame
}) {
    /** 统一的「成功反馈」出口：Toast 缺失时静默降级（不抛错，老调用方也能跑） */
    const toastOk = (message, duration = 3000) => {
        if (typeof showToast === 'function') showToast(message, 'success', duration);
    };

    // =========================================================
    // 📊🔍 查重扫描进度（2026-09-22 设计修正）
    // ---------------------------------------------------------
    //  为什么要有这层：查重原本直接读内存里已加载的库，**既不保证数据最新、也没有可推进的进度**。
    //  现在查重前先重扫磁盘：
    //    · 世界书：`wb:scan` 有分批进度（真实 done/total/当前文件名）→ 用真实百分比
    //    · 角色卡：`refreshLibrary` **没有**进度通道 → 用「不定态」进度条（不给假百分比）
    //  进度对象只服务**查重弹窗**，绝不回流到侧栏（那是已纠正的设计错误）。
    // =========================================================
    const dedupeScanning = ref(false);        // 查重是否处于「扫描中」
    // 🛑 差异比对的「已尝试载入正文」集合（防无限递归 / 弹框风暴）
    //    ⚠️ 用 WeakSet：条目被替换后可自然回收，不会累积泄漏。
    const diffLoadAttempted = new WeakSet();
    const dedupeScanLabel = ref('');          // 当前阶段的文案（如「正在扫描世界书库…」）
    const dedupeScanPercent = ref(0);         // 0~100；角色卡侧恒为 0（不定态）
    const dedupeScanIndeterminate = ref(false); // true = 无真实进度，用滑动条而非百分比
    // 🛑🛑 AR-45 二次修复（2026-09-23 用户二次报出「又横跳」）：
    //    **病根 = 进度条有两条不同源的数据路径** ——
    //      · 宽度 ← `dedupeScanPercent`（本文件）
    //      · 数字 ← `dedupeScanProgressForModal`（App.vue computed，透传 `wbScanProgress`）
    //    ⇒ 两者会**脱钩**：阶段 2 时 `percent=100` 而 `wbScanProgress` 已归零
    //      → 组件渲染出「条满格、数字 0 / ?、百分比整块消失」= 用户看到的「横跳」。
    //    ⚠️ 与 AR-43 是**同一个设计缺陷**（「宽度与数字走两条不同路径 → 只有数字坏，现象隐蔽」）。
    //    ✅ 修法：数字也走本文件的 ref，**与宽度同源同寿命**。
    const dedupeScanDone = ref(0);
    const dedupeScanTotal = ref(0);

    // ═══════════════════════════════════════════════════════════════
    // 🧊 P2-2（2026-09-23）：**L1 索引快照**（copy-on-write，v3 评审 §5 #5）
    // ───────────────────────────────────────────────────────────────
    // 📖 要防什么：查重是**多阶段长流程**（重扫 → 逐本算指纹 → 比对，s5000 可达分钟级）。
    //    若用户在查重进行中**保存/编辑某本书**（`wb:save` 会改写 `wb.keyHashes`），
    //    就会出现「**前半段用旧索引、后半段用新索引**」——结果自相矛盾且无法复现。
    // 📖 解法：查重**开始时**对参与比对的条目做一次**浅快照**：
    //    · 冻结 `keyHashes` / `exactContentHash` / `entryCount` / `wbName`（都是**不可变**值或数组，
    //      浅拷贝即可 —— 我们**从不原地改这些数组**，只会整个替换引用）；
    //    · 比对阶段**只读快照**，不读活对象 ⇒ 用户中途保存**不会**污染本轮结果。
    // ⚠️ 为什么不深拷贝整个 `wb` 对象：那会复制 `data`（正文，可达 GB 级）→ 正是 PK-20 的病根。
    //    **只快照「比对用到的标量/小数组」**，内存开销 ≈ L1 索引本身（23.4MB 量级）。
    // ⚠️ 快照**只在查重期间持有**，`finishDedupeScan` 后释放（避免长期占用）。
    // ═══════════════════════════════════════════════════════════════
    let l1Snapshot = null;   // Map<path, {keyHashes, exactContentHash, entryCount, wbName, simhash}>

    /** 🧊 冻结参与比对的 L1 字段（**只拷标量与小数组，绝不碰 `data`**） */
    const freezeL1Snapshot = (items) => {
        const m = new Map();
        for (const it of items) {
            if (!it || !it.path) continue;
            m.set(it.path, {
                keyHashes: Array.isArray(it.keyHashes) ? it.keyHashes.slice() : null,
                exactContentHash: it.exactContentHash || null,
                entryCount: typeof it.entryCount === 'number' ? it.entryCount : null,
                wbName: it.wbName || null,
                simhash: Array.isArray(it.simhash) ? it.simhash.slice() : null
            });
        }
        l1Snapshot = m;
        return m.size;
    };
    /** 🧊 从快照取字段（无快照则回落活对象 —— 保证「未启用快照」时行为不变） */
    const snapOf = (it) => (l1Snapshot && it && it.path && l1Snapshot.has(it.path))
        ? l1Snapshot.get(it.path) : null;
    const releaseL1Snapshot = () => { l1Snapshot = null; };

    /**
     * 🎯 **统一的进度写入入口**（AR-45 二次修复核心）。
     *
     * 为什么必须统一入口：旧实现里有 8 处直接给 `dedupeScanPercent` 赋值，
     *   其中**只有 6 处**带 `Math.max` 单调保护 —— 剩下 2 处（同步定时器 / 阶段初始化）
     *   是**裸赋值**，正是倒退的来源。散落的赋值点无法保证一致性。
     *
     * 契约（改这里前请先读）：
     *   · `percent` **单调不减**（`Math.max`）；`finishDedupeScan` 传 100 时也走这里；
     *   · `done/total` **成对更新** —— 只有 `total > 0`（已知）时才写，
     *     避免「未知」把已知总数/已处理数冲掉（否则数字渲染成「0 / ?」）；
     *   · 数字与宽度**同一次写入** → 永远同源，不可能脱钩。
     *
     * @param {{percent?:number, done?:number, total?:number, label?:string}} p
     */
    const applyDedupeProgress = (p) => {
        const o = p || {};
        if (typeof o.label === 'string' && o.label) dedupeScanLabel.value = o.label;
        // 🛑 done/total **成对更新**：`total` 未知（<=0）时**两者都不写** ——
        //    否则会出现「done=0 而 total=1001」或「total=0」→ 数字渲染成「0 / ?」
        //    （旧实现透传 `wbScanProgress` 就是这个症状）。
        if (typeof o.total === 'number' && o.total > 0) {
            dedupeScanTotal.value = o.total;
            if (typeof o.done === 'number' && o.done >= 0) dedupeScanDone.value = o.done;
        }
        // percent：**单调不减**（唯一写入口，不可能再出现裸赋值倒退）
        if (typeof o.percent === 'number' && Number.isFinite(o.percent)) {
            const v = Math.max(0, Math.min(100, Math.round(o.percent)));
            dedupeScanPercent.value = Math.max(dedupeScanPercent.value, v);
        }
        // 收尾时让数字也到 total（否则「100% 但数字停在 970 / 1001」）
        if (dedupeScanPercent.value >= 100 && dedupeScanTotal.value > 0) {
            dedupeScanDone.value = dedupeScanTotal.value;
        }
    };

    const resetDedupeScan = () => {
        dedupeScanning.value = false;
        dedupeScanLabel.value = '';
        dedupeScanPercent.value = 0;
        dedupeScanIndeterminate.value = false;
        dedupeScanDone.value = 0;
        dedupeScanTotal.value = 0;
    };

    /**
     * 🏁 统一收尾（2026-09-22 新增）：把进度推到 100% → 短暂停留 → 收起。
     *
     * 为什么必须有它（用户实测报出的缺陷）：
     *   查重是**多阶段**流程（重扫 → 逐本算指纹 → 比对）。
     *   旧实现在**每个阶段的 `finally`** 都 `resetDedupeScan()` → 进度条**消失又出现**（「反复横跳」）
     *   + `percent` 从 100 掉回 0（「时长时短」）+ 阶段 2 切成不定态（「最后变成滚动的光条」）。
     *   ⇒ 现在**只在整条流程结束时**调本函数一次；各阶段只负责**推进**进度，绝不重置。
     *
     * ⚠️ 必须在**所有**出口调用（含 early return / catch），否则进度条会停在中间不收起。
     */
    const finishDedupeScan = () => {
        // ⚠️ 走统一入口：保证「100%」与「done === total」同时生效（数字不得停在半途）
        applyDedupeProgress({ percent: 100, label: '查重完成' });
        dedupeScanning.value = false;
        // 🧊 P2-2：释放 L1 快照（只在查重期间需要；长期持有会白占 23MB 量级内存）
        releaseL1Snapshot();
        // 停留 400ms 让用户看到 100%，再收起（避免「闪一下就没了」）
        setTimeout(() => {
            if (!dedupeScanning.value) resetDedupeScan();
        }, 400);
    };

    /**
     * 世界书：查重前重扫磁盘（带真实进度）。
     * 进度取自注入的 `wbScanProgress`（由 useWorldbooks 维护），这里用 watcher 同步到弹窗进度。
     *
     * 🛑 RL/AR（2026-09-22 用户实测报出）：**不要在这里 `resetDedupeScan()`**！
     *    查重是**多阶段**流程（重扫 → 逐本算指纹 → 比对），旧实现在每个阶段的 `finally`
     *    都 reset 一次 → 进度条**消失又出现**（用户看到「反复横跳」）+ `percent` 从 100 掉回 0
     *    （用户看到「时长时短」）+ 阶段 2 用不定态（用户看到「最后变成滚动的光条」）。
     *    ⇒ 现在由**调用方**（`startWorldbookDedupeScan` / `startContentDedupeScan`）统一收尾，
     *      本函数只负责「推进进度」，**绝不重置状态**。
     *
     * @param {{keepAlive?: boolean}} [opts] `keepAlive=true` → 结束时**不重置**（由调用方接管后续阶段）
     * @returns {Promise<{ok:boolean, count:number, error?:string}>}
     */
    const rescanForWorldbookDedupe = async (opts) => {
        const keepAlive = !!(opts && opts.keepAlive);
        const dir = lastWorldbookDirPath && lastWorldbookDirPath.value;
        if (!dir) return { ok: false, count: worldbooks.value.length, error: '未设置世界书目录（本次仅对已加载的库查重）' };
        if (typeof rescanWorldbooks !== 'function') return { ok: true, count: worldbooks.value.length };

        // ═══════════════════════════════════════════════════════════════
        // 🛑🛑 重大修正（2026-09-23，用户反馈「进度条走完还要等几秒/几十秒」的**根因**）：
        // ───────────────────────────────────────────────────────────────
        // 📖 **病根**：旧实现**无条件**调用 `rescanWorldbooks(dir)`（内部 `scanWorldbooks(dir, {rescan:true})`）
        //    —— 那是**完整扫描**：重读**全部正文**（s1000 = 7GB / 202s；s5000 = 34.8GB / 234s）。
        //    而 **S2' 之后同名查重只读 L1 索引**（`keyHashes` 已在内存），
        //    **根本不需要重读正文**！
        //    ⇒ 用户看到的就是：进度条慢吞吞爬到 2%（全在重读正文），然后突然跳到结束出结果。
        //
        // ✅ **修法：按需重扫** —— 只在「内存库为空」或「L1 索引缺失」时才重扫：
        //    · 已加载 + 有索引（**日常场景**）→ **直接查重**（秒级），进度条从 0% 走到 100% 都是真实工作；
        //    · 未加载 / 无索引（刚启动 / 老缓存）→ 才走完整重扫（此时重扫是**必要**的）。
        //    ⚠️ 判据用「**索引覆盖率**」而非「库非空」—— 库非空但索引缺失（老缓存）时重扫仍然必要。
        const list = worldbooks.value || [];
        const withIndex = list.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length > 0).length;
        const needRescan = list.length === 0 || withIndex < list.length * 0.9;
        if (!needRescan) {
            addLog(`⚡ 查重：内存库已有 L1 索引（${withIndex}/${list.length} 本），**跳过重读正文**（直接比对）`, 'info');
            dedupeScanning.value = true;
            dedupeScanIndeterminate.value = false;
            dedupeScanLabel.value = '正在准备比对（索引已就绪）…';
            applyDedupeProgress({ percent: 50 });   // 直接进入阶段 2 的起点
            return { ok: true, count: list.length, skipped: 0, fromMemory: true };
        }
        addLog(`🔍 查重：L1 索引不足（${withIndex}/${list.length} 本）→ 需要重扫磁盘补索引`, 'warning');

        dedupeScanning.value = true;
        dedupeScanLabel.value = '正在扫描世界书库…';
        dedupeScanIndeterminate.value = false;
        // 同步真实进度（wbScanProgress 由 useWorldbooks 在主进程心跳驱动）
        // 🛑 AR-45 二次修复（2026-09-23）：旧实现是**裸赋值**
        //    `dedupeScanPercent.value = wbScanPercent.value` ——
        //    而 `wbScanPercent` 在 `total===0` 时返回 **0**，且 `rescanWorldbooks`
        //    开头 / `finally` 都把 `wbScanProgress` 置为 `{done:0,total:0}`
        //    ⇒ 每次重扫开始与结束都会把进度**拽回 0**（这就是「时长时短」的残余来源）。
        //    ✅ 现在：① 走统一入口（`Math.max` 单调保护）；② `total<=0` 视为**未知**，
        //      不覆盖已有进度；③ 数字与宽度**同源**写入。
        let syncTimer = null;
        if (wbScanProgress) {
            syncTimer = setInterval(() => {
                const p = wbScanProgress.value || {};
                const t = Number(p.total) || 0;
                const d = Number(p.done) || 0;
                if (t <= 0) return;   // 未知 → 跳过（绝不归零）
                // 🛑🛑 进度映射修正（2026-09-23，用户反馈「进度条走完还要等」的**真正病根**）：
                //    旧实现映射到 **0~100%** —— 阶段 1（重扫）跑完时 `d === t` → 进度**直接冲到 100%**；
                //    而 `applyDedupeProgress` 有 `Math.max` 单调保护 → 阶段 2 的 50~99% **全被吞掉**
                //    ⇒ **进度条显示 100%，但比对（最耗时的部分）还没开始**。
                //    用户看到的就是「进度条走完，还要等几秒/几十秒才出结果」。
                //    ✅ 正确映射：阶段 1（重扫）占 **0~50%**，阶段 2（比对）续 **50~100%**。
                applyDedupeProgress({ percent: (d / t) * 50, done: d, total: t });
            }, 100);
        }
        try {
            const r = await rescanWorldbooks(dir);
            if (!r.ok) {
                addLog(`⚠️ 查重前重扫世界书失败：${r.error}（本次对已加载的库查重）`, 'warning');
            }
            return r;
        } finally {
            if (syncTimer) clearInterval(syncTimer);
            // 🛑 AR-45 二次修复：`rescanWorldbooks` 的 `finally` 会把
            //    `wbScanProgress` 置回 `{done:0,total:0}`（那是对的 —— 它表示「扫描已结束」），
            //    但**不能因此把进度条也归零**。本函数只负责「阶段 1 结束」，
            //    进度**保持在当前位置**，由调用方继续推进（`keepAlive` 时）
            //    或由 `finishDedupeScan()` 统一收尾（非 keepAlive 时）。
            if (!keepAlive) {
                finishDedupeScan();
            }
        }
    };

    /**
     * 角色卡：查重前重扫磁盘。
     * ⚠️ `refreshLibrary` 无进度通道（只有末尾 Toast）→ 用**不定态**进度条，不编假百分比。
     * 🛑 同 `rescanForWorldbookDedupe`：**不在 `finally` 里 reset**（避免阶段切换时进度条横跳）。
     * @param {{keepAlive?: boolean}} [opts] `keepAlive=true` → 结束时**不重置**（由调用方接管）
     */
    const rescanForCardDedupe = async (opts) => {
        const keepAlive = !!(opts && opts.keepAlive);
        if (typeof refreshLibrary !== 'function') return { ok: true };
        if (!currentFolderPath || !currentFolderPath.value) return { ok: true };
        dedupeScanning.value = true;
        // ⚠️ 角色卡重扫（`refreshLibrary`）**没有进度通道** → 只能用不定态（不编假百分比）。
        //    🛑 但这正是「滚动光条」的来源：调用方**必须**在重扫结束后切回确定态
        //       （见 `startDedupeScan` 的 `dedupeScanIndeterminate.value = false`）。
        dedupeScanIndeterminate.value = true;
        // 🛑🛑 这里**必须裸赋值归零**，不能用 `applyDedupeProgress({percent:0})`：
        //    统一入口有 `Math.max` **单调保护**（那是给「同一条流程内推进」用的），
        //    而**新流程开始**的语义是**重置** —— 用入口会把上一轮残留的百分比
        //    （实测残留 61 / 100）**保留下来** ⇒ 重扫结束切确定态时进度条先显示残留值再跳，
        //    用户看到「闪跳」（实测踩到：时间线出现 `I61` 而非 `I0`）。
        //    故：**重置用裸赋值，推进走统一入口**（`resetDedupeScan` 同理）。
        dedupeScanPercent.value = 0;
        dedupeScanDone.value = 0;
        dedupeScanTotal.value = 0;
        dedupeScanLabel.value = '正在扫描角色卡库…';
        try {
            await refreshLibrary();
            return { ok: true };
        } finally {
            if (!keepAlive) {
                await new Promise(res => setTimeout(res, 400));
                resetDedupeScan();
            }
        }
    };
    // =========================================================
    // 🔍 智能查重与版本清洗系统
    // =========================================================
    const showDedupeModal = ref(false);
    const duplicateGroups = ref([]);

    // 提取核心描述以便于对比差异
    const getCoreDescription = (card) => {
        const d = card.data?.data || card.data || {};
        return d.description || '';
    };

    // 🛡️ 同名假阳性防护（2026-09-23 用户实测报出「角色卡对比错误 / 卡片和对比卡片都不对」）
    // ─────────────────────────────────────────────────────────────────────────────
    // 📖 **病根**：角色卡同名查重**只按「卡内 `name` 字段」聚类**。真实库里有大量
    //    「`name` 撞车但内容完全无关」的卡 —— 实测真实库（11,188 张 / 1910 组）：
    //      · **350 组（18.3%）** 组内最大相似度 < 20%，**很多直接 = 0%**
    //      · 例：9 张卡都叫「花宁娜」内容零重合；17 张都叫「菜菜子」；
    //        还有一张卡内 `name` 竟是 `"1"`、另一张是 `"Nian"`（实为「明日方舟：龙娘四姐妹」）
    //        —— 两者被聚成一组、弹窗显示成「同一角色的历史版本」。
    //    而弹窗按钮是「✅ 保留此版，**清理其余**」⇒ **一键就会误删真卡**（不可接受）。
    //
    // ✅ **修法**：用 **simhash 汉明距离**（与世界书内容查重**同算法、同阈值**）判「内容是否真同源」，
    //    对「与推荐版无关」的卡明确标注 `_nameOnly`；弹窗据此**降级按钮 + 二次确认加警示**。
    //
    // 📊 **阈值实测**（`scripts/probes/_probe-card-simhash-dist.mjs`，真实库 3907 张）：
    //      · 同名**且同源**组内距离：p50 = 0 ｜ p75 = 0 ｜ p95 = 30
    //      · **随机无关**两两距离：p50 = **31** ｜ p25 = 28 ｜ p75 = 34（与理论期望 32 吻合）
    //      ⇒ 取 **T = 24**（落在两组之间，且与世界书 `SIMHASH_THRESHOLD` 口径一致）。
    //    ⚠️ 内容过短（<20 字）→ 返回 `null`（**无法判定就不臆断**，不标注）。
    //    💰 成本实测：4547 张 / 约 2.0s（一次性，且只对参与同名的卡计算）。
    const NAME_ONLY_MAX_DIST = 24;
    /** 角色卡内容指纹（simhash）；内容过短返回 `null`。
     *  ⚠️ 依赖 `extractContentText` / `normalizeText` / `computeSimhash`（本文件后段定义）——
     *     它们与 `startDedupeScan` 同处一个函数作用域，运行时已初始化，**不存在 TDZ 问题**。 */
    const cardSigOf = async (c) => {
        try {
            const txt = normalizeText(await extractContentText(c));
            return txt.length < 20 ? null : computeSimhash(txt);
        } catch (e) { return null; }
    };

    // 启动全库查重扫描（升级版：综合 Token 丰度 + 物理文件修改时间判定；整体 try-catch 防静默崩溃）
    const startDedupeScan = async () => {
        try {
            // 📊🔍 查重前先重扫磁盘（2026-09-22）：保证数据最新 + 给弹窗一个可感知的扫描阶段。
            //    ⚠️ 顺序很重要：必须先重扫再判空 —— 否则「重启后库未加载」会直接报「卡片库为空」
            //    ⚠️⚠️ 同样先开弹窗再重扫，否则扫描期间看不到进度条
            //    🧹 同样必须清空上一轮结果（否则扫描期间显示陈旧分组）
            duplicateGroups.value = [];
            showDedupeModal.value = true;
            await rescanForCardDedupe();
            // 🛑🛑 修复（2026-09-23 用户实测报出「角色卡查重界面出现滚动光条」）：
            //    **病根**：`rescanForCardDedupe` 因「角色卡重扫无进度通道」置了
            //      `dedupeScanIndeterminate = true`，而旧实现**重扫后从不复位** →
            //      之后「算 Token / 读文件信息」这些**完全有真实进度**的阶段仍在滚动光条下进行，
            //      真实库（11k 卡）下重扫就要约 10s，用户全程只看到一条来回滑动的光条（零信息量）。
            //    ✅ 修法：**重扫一结束立刻切回确定态**，并给后续阶段真实进度（0~90%）+ 让出主线程。
            //      重扫阶段本身仍是不定态（它确实没有进度通道，不编假百分比 —— 这条设计不变）。
            dedupeScanIndeterminate.value = false;
            dedupeScanPercent.value = 0;
            dedupeScanDone.value = 0;
            dedupeScanTotal.value = 0;
            if (library.value.length === 0) {
                finishDedupeScan();
                nativeAlert('卡片库为空，无法查重！', 'warning');
                return;
            }

            // 【防崩溃检查】底层 API 是否真的连接上了
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                finishDedupeScan();
                nativeAlert('❌ 查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            // 🛑 进度时序（2026-09-23）：本阶段要**逐卡算 Token**（真实库 11k 卡 = 秒级 CPU），
            //    旧实现无进度、不让出 → 进度条不动（用户以为卡死）。现按「已处理张数」推进 0~90%。
            applyDedupeProgress({
                label: `正在统计卡片体积（共 ${library.value.length} 张）…`,
                done: 0,
                total: library.value.length,
                percent: 0
            });
            await new Promise(r => setTimeout(r, 0));

            const groups = {};
            // 1. 聚类：按角色名称分组
            library.value.forEach(card => {
                const name = (card.name || '未命名').trim();
                if (!groups[name]) groups[name] = [];
                groups[name].push(card);
            });

            const potentialGroups = Object.entries(groups).filter(([name, cards]) => cards.length > 1);

            if (potentialGroups.length === 0) {
                finishDedupeScan();
                // 🔔 T1：纯信息型结论不再用模态框打断（无详情可复制），走 Toast
                if (typeof showToast === 'function') showToast('🎉 恭喜！当前库中极为整洁，未发现同名重复的角色卡！', 'success', 4000);
                else nativeAlert('🎉 恭喜！当前库中极为整洁，未发现同名重复的角色卡！', 'info');
                return;
            }

            // 2. 收集所有需要获取 stats 的文件路径
            const pathsToStat = [];
            potentialGroups.forEach(([name, cards]) => cards.forEach(c => pathsToStat.push(c.path)));

            // 3. 批量获取文件物理状态 (修改时间/大小)；失败时降级为仅 Token 判定
            // 🛑 进度时序（2026-09-23）：这步要**读盘**（11k 库实测数秒）→ 明确标注阶段 + 推进到 90%
            applyDedupeProgress({
                label: `正在读取文件信息（${pathsToStat.length} 张）…`,
                done: potentialGroups.length,
                total: potentialGroups.length,
                percent: 90
            });
            await new Promise(r => setTimeout(r, 0));
            let fileStats = {};
            try {
                const statsRes = await window.electronAPI.getFileStats(pathsToStat);
                if (statsRes && statsRes.success) fileStats = statsRes.data || {};
            } catch (e) {
                console.warn('获取文件信息失败，将仅依据 Token 判定:', e);
            }

            // 4. 组装查重分组并综合排序（🛑 改为 for + 让出主线程：旧 `map` 是纯同步，
            //    11k 库下会长时间不让出 → 进度条画面不更新）
            const builtCardGroups = [];
            const cardGroupTotal = potentialGroups.length;
            // 🛡️ 同名假阳性防护：先算「参与同名的卡」的内容指纹（进度 90~99%），再逐组比对
            applyDedupeProgress({
                label: `正在校验同名卡片的内容是否真同源（共 ${pathsToStat.length} 张）…`,
                done: cardGroupTotal,
                total: cardGroupTotal,
                percent: 95
            });
            await new Promise(r => setTimeout(r, 0));
            const nameGroupItems = [];
            potentialGroups.forEach(([, cards]) => cards.forEach(c => nameGroupItems.push(c)));
            for (let i = 0; i < nameGroupItems.length; i++) {
                const it = nameGroupItems[i];
                it._nameOnlySig = await cardSigOf(it);
                if (i % 20 === 19) {
                    applyDedupeProgress({
                        done: cardGroupTotal,
                        total: cardGroupTotal,
                        percent: 95 + (i / nameGroupItems.length) * 4
                    });
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            for (let gi = 0; gi < cardGroupTotal; gi++) {
                const [name, cards] = potentialGroups[gi];
                applyDedupeProgress({
                    done: gi,
                    total: cardGroupTotal,
                    percent: 90 + (gi / cardGroupTotal) * 10
                });
                if (gi % 50 === 0) await new Promise(r => setTimeout(r, 0));
                cards.forEach(c => {
                    c._tokens = estimateCardTokens(c);
                    c._desc = getCoreDescription(c);
                    // 优先使用物理文件修改时间（可空链保护），兜底使用内部数据时间
                    const fallback = (c.data && c.data.create_date) ? new Date(c.data.create_date).getTime() : 0;
                    c._mtime = fileStats?.[c.path]?.mtimeMs || fallback || Date.now();
                    c._dateStr = new Date(c._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                });

                // 【综合排序策略】Token 差异 > 5% 视为有实质差异，Token 多者优先；相近则比较物理修改时间，越新越优先
                cards.sort((a, b) => {
                    const tokenDiff = b._tokens - a._tokens;
                    const tokenRatio = Math.abs(tokenDiff) / Math.max(a._tokens, b._tokens, 1);
                    if (tokenRatio > 0.05) {
                        return tokenDiff;
                    } else {
                        return b._mtime - a._mtime;
                    }
                });

                // 【差异计算】将第一张（推荐保留）与其他卡片对比描述长度差异
                // 🛡️ 同时判「是否仅名称相同」（内容指纹与推荐版距离过大 → 很可能不是同一角色）
                const masterSig = cards[0]._nameOnlySig;
                cards.forEach((c, idx) => {
                    c._nameOnly = false;
                    c._nameOnlyDist = null;
                    if (idx === 0) {
                        c._diffType = '推荐版';
                        return;
                    }
                    const diffLen = c._desc.length - cards[0]._desc.length;
                    if (diffLen > 100) c._diffType = '可能包含更多设定';
                    else if (diffLen < -100) c._diffType = '设定可能有缺失';
                    else if (c._desc !== cards[0]._desc) c._diffType = '设定细节不同';
                    else c._diffType = '设定完全一致';
                    // 🛡️ 仅名称相同判定（任一侧无法判定则跳过，不臆断）
                    if (masterSig && c._nameOnlySig) {
                        const d = hammingDistance(masterSig, c._nameOnlySig);
                        c._nameOnlyDist = d;
                        if (d > NAME_ONLY_MAX_DIST) c._nameOnly = true;
                    }
                });

                // 🛡️ 组级汇总：让用户在**组标题**就能看出这组是不是「只同名」
                builtCardGroups.push({
                    name,
                    cards,
                    nameOnlyCount: cards.filter(c => c._nameOnly).length,
                    totalCount: cards.length
                });
            }
            // ✅ 先赋值结果、再收尾（保证「进度条走完」时内容已经在，不出现「走完还要等」）
            duplicateGroups.value = builtCardGroups;
            applyDedupeProgress({ done: cardGroupTotal, total: cardGroupTotal, percent: 100 });

            // 只要逻辑没报错，就一定能打开弹窗！
            finishDedupeScan();
            showDedupeModal.value = true;
        } catch (err) {
            console.error('查重引擎崩溃:', err);
            resetDedupeScan();
            nativeAlert(`❌ 查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理：保留指定卡片，其余送入回收站
    const resolveDedupeGroup = async (groupIndex, keepCardPath) => {
        const group = duplicateGroups.value[groupIndex];
        if (!group) return;

        // 选出所有不等于 keepCardPath 的卡片路径（即准备扔掉的冗余版本）
        const pathsToTrash = group.cards
            .filter(c => c.path !== keepCardPath)
            .map(c => c.path);

        if (pathsToTrash.length === 0) return;

        // 🛡️ 同名假阳性防护（2026-09-23）：若待清理项里含「**仅名称相同**（内容与推荐版无关）」的卡，
        //    必须在确认框里**明确警示** —— 否则用户点「清理其余」会误删真卡（实测真实库 350/1910 组属此列）。
        const risky = group.cards.filter(c => c.path !== keepCardPath && c._nameOnly);
        const warn = risky.length > 0
            ? `\n\n⚠️ 注意：其中 ${risky.length} 张只是「名字相同」，内容与保留版本并不同源`
              + `（相似度极低，很可能是完全不同的角色）：\n`
              + risky.slice(0, 5).map(c => `  · ${(c.path || '').split(/[\\/]/).pop()}`).join('\n')
              + (risky.length > 5 ? `\n  …还有 ${risky.length - 5} 张` : '')
              + `\n\n建议先点「🔍 对比差异」逐一确认，再决定是否清理。`
            : '';

        // ⚠️ 必须用 confirmDialog（window.confirm 在 Electron 中静默返回 null）
        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个历史版本/重复卡移入回收站吗？${warn}`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            // 🔧 按实际删除成功的路径过滤内存（失败项保留在库中，与磁盘一致，杜绝幽灵卡）
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));

            const currentLibItem = library.value.find(item => item.data === cardData.value);
            const currentTrashed = !!(currentLibItem && trashedPaths.includes(currentLibItem.path));

            library.value = library.value.filter(c => !trashedPaths.includes(c.path));
            // 组内全部删净才移除该组；有残留则只剔除已删项，保持弹窗数据与磁盘一致
            if (failedPaths.size === 0) {
                duplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.cards = group.cards.filter(c => !trashedPaths.includes(c.path));
            }

            if (currentTrashed) reset();

            deleteCardOverlays(trashedPaths); // 🔧 清理覆盖层，防配置膨胀
            await cleanupEmptyCategories(); // 🧹 自动清理空分组

            // 🔧 分项结果提示（渲染进程无 path 模块，用 split 取文件名）
            // 🔔 T1：成功走非阻塞 Toast；有失败项时 Toast 报数 + nativeAlert 保留可复制的文件名详情
            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                if (typeof showToast === 'function') showToast(`已清理 ${res.count} 张，${failedPaths.size} 张失败（可能被占用）`, 'warning', 5000);
                nativeAlert(`已清理 ${res.count} 张；${failedPaths.size} 张失败（可能被其他程序占用）：\n${names}`, 'warning');
            } else {
                toastOk(`清理成功！已将 ${res.count} 张冗余卡片移入回收站。`);
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // 🌍 世界书查重弹窗状态
    const showWbDedupeModal = ref(false);  // 世界书对比查重弹窗开关
    const wbDuplicateGroups = ref([]);     // 世界书查重分组

    // ⚡ PK-26（2026-09-22）：秒开后 `wb.data` 常为 `null`（懒加载），
    //    **任何读 `wb.data.entries` 的代码都会静默得到空数组** → 词条数 0 / 重合度 0% / 判不出世界书。
    //    统一入口：需要**正文**时才 `ensureWorldbookLoaded`；只需要**数量**时走轻量字段。
    /** 世界书的词条数（优先轻量 `entryCount`，无需正文） */
    const wbCountOf = (wb) => {
        if (!wb) return 0;
        if (typeof wbEntryCount === 'function') return wbEntryCount(wb);
        if (typeof wb.entryCount === 'number') return wb.entryCount;
        return (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries.length : 0;
    };
    /** 世界书的显示名（优先轻量 `wbName`，无需正文） */
    const wbNameOf = (wb) => {
        if (!wb) return '';
        if (typeof wbDisplayName === 'function') return wbDisplayName(wb);
        return (wb.data && wb.data.name) || wb.name || '';
    };
    /** 世界书词条数组（**需要正文**；未载入时按需读取，失败返回空数组）
     *  @param {{batch?: boolean}} [opts] `batch=true` → 批量场景（不逐本刷日志/不逐本重渲染）
     */
    const wbEntriesOf = async (wb, opts) => {
        if (!wb) return [];
        if (wb.dataLoaded === false && wb.path && typeof ensureWorldbookLoaded === 'function') {
            await ensureWorldbookLoaded(wb, { silent: true, batch: !!(opts && opts.batch) });
        }
        return (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries : [];
    };

    // 提取世界书的所有触发词集合（用于计算重合度）
    // ⚡ PK-26：改成 **async + 按需载入**（否则懒加载书的 keys 恒为空集 → 重合度恒 0%）
    // @param {{batch?: boolean}} [opts] 批量场景标记（透传给 `wbEntriesOf`）
    const getWorldbookKeysSet = async (wb, opts) => {
        const keys = new Set();
        const entries = await wbEntriesOf(wb, opts);
        entries.forEach(e => {
            if (!e || typeof e !== 'object') return; // 脏数据条目防护
            const kArr = Array.isArray(e.key) ? e.key : (typeof e.key === 'string' ? e.key.split(/[,，]/) : []);
            kArr.forEach(k => {
                const clean = String(k).trim().toLowerCase();
                if (clean) keys.add(clean);
            });
        });
        return keys;
    };

    // 启动世界书智能查重扫描
    const startWorldbookDedupeScan = async () => {
        try {
            // 📊🔍 查重前先重扫世界书目录（2026-09-22）：
            //    ① 保证查重基于磁盘最新数据（而不是可能过期的内存库）；
            //    ② 天然复用 `wb:scan` 的分批进度 → 弹窗进度条有真实数据源。
            //    ⚠️ 必须先重扫再判空（同角色卡侧，否则重启后未加载时会误报「库为空」）
            //    ⚠️⚠️ 顺序关键：**先开弹窗再重扫**。否则弹窗在扫描结束后才打开，
            //       用户在扫描期间根本看不到进度条 —— 进度条等于白做（实测踩过）。
            //    🧹 同时必须**清空上一轮结果**：否则弹窗一打开就渲染着上次的 24 组结果，
            //       用户看到的是「结果早就列出来了、只有进度条在动」——数据是旧的却看不出旧。
            wbDuplicateGroups.value = [];
            showWbDedupeModal.value = true;
            // 🛑 进度条连续性（2026-09-22 用户实测报出「横跳 / 时长时短 / 变光条」）：
            //    旧实现在 `rescanForWorldbookDedupe` 的 `finally` 里 reset → 阶段 1 结束时
            //    进度条**消失**、`percent` 从 100 掉回 0 → 用户看到横跳与时长时短。
            //    ⇒ 现在传 `keepAlive:true`（**不 reset**），由本函数**统一收尾**；
            //      且阶段 1 的进度映射到 **0~50%**，阶段 2 继续到 50~100%（**单调递增，不倒退**）。
            const keepAlive = true;
            dedupeScanning.value = true;
            dedupeScanIndeterminate.value = false;
            // 🛑 AR-45 二次修复：**走统一入口**重置（而不是裸赋值 `= 0`）
            //    `total:0` 表示「未知」→ 入口会保留上次已知 total，不把数字冲成「0 / ?」
            dedupeScanDone.value = 0;
            dedupeScanTotal.value = 0;
            dedupeScanPercent.value = 0;
            dedupeScanLabel.value = '正在扫描世界书库…';
            await rescanForWorldbookDedupe({ keepAlive });
            if (worldbooks.value.length === 0) {
                finishDedupeScan();
                nativeAlert('世界书库为空，无法进行查重！', 'warning');
                return;
            }
            // 阶段 1 完成 → 进入阶段 2
            // 🛑 AR-45 二次修复：硬编码 `Math.max(当前, 50)` 有两个问题 ——
            //    ① 若阶段 1 已推到 97% → 停在 97（对，不倒退），但阶段 2 的**数字**仍停在扫描值；
            //    ② 阶段 2 的进度基数（50）与实际剩余工作量无关。
            //    ⇒ 现在**统一走 `applyDedupeProgress`**：阶段 2 用「已比对组数 / 总组数」
            //      驱动数字，宽度由入口的 `Math.max` 保证不倒退。
            dedupeScanLabel.value = '正在比对触发词指纹…';

            // 【防崩溃检查】底层 API 是否真的连接上了
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                finishDedupeScan();
                nativeAlert('❌ 世界书查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            const groups = {};
            // 1. 按书名或文件名聚类
            //    ⚡ PK-26：秒开后 `wb.data` 为 null，**必须用轻量 `wbName`**
            //       （否则所有书都回退成文件名 → 跨目录同名书聚不成组 / 聚错组）
            worldbooks.value.forEach(wb => {
                const name = (wbNameOf(wb) || '').replace(/\.json$/i, '').trim() || '未命名世界书';
                if (!groups[name]) groups[name] = [];
                groups[name].push(wb);
            });

            const potentialGroups = Object.entries(groups).filter(([_, list]) => list.length > 1);

            if (potentialGroups.length === 0) {
                finishDedupeScan();
                if (typeof showToast === 'function') showToast('🎉 恭喜！当前库中未发现同名的重复世界书！', 'success', 4000);
                else nativeAlert('🎉 恭喜！当前库中未发现同名的重复世界书！', 'info');
                return;
            }

            // 2. 收集物理文件状态（带空安全保护）
            // 🛑 进度条时序修正（2026-09-23）：这步要**读盘**，旧实现下进度条可能已 100%
            //    → 用户看到「走完还要等」。故明确标注阶段 + 推进到 90% + 让出渲染。
            applyDedupeProgress({
                label: `正在读取文件信息（${potentialGroups.reduce((s, [, l]) => s + l.length, 0)} 本）…`,
                percent: 90
            });
            await new Promise(r => setTimeout(r, 0));
            const pathsToStat = [];
            potentialGroups.forEach(([_, list]) => list.forEach(wb => pathsToStat.push(wb.path)));
            let fileStats = {};
            try {
                const statsRes = await window.electronAPI.getFileStats(pathsToStat);
                if (statsRes && statsRes.success) fileStats = statsRes.data || {};
            } catch (e) {
                console.warn('获取世界书文件信息失败:', e);
            }

            // ═══════════════════════════════════════════════════════════════
            // 🧠 PK-27 / S2'（2026-09-22）：**查重只读 L1 索引，永不重读正文**
            // ───────────────────────────────────────────────────────────────
            // 📖 病根：旧实现为拿「触发词集合」而**逐本重读 34.8GB 正文**
            //    → 三次 OOM 事故（PK-20 / 内容查重 / PK-27，s5000 进程被内核杀掉）。
            // 📖 方案：`docs/规格与计划/世界书大库-加载与查重架构方案.md`
            //    L1a 摘要（`keyHashes`）已在**扫描阶段 2** 由主进程算好并落盘
            //    ⇒ 此处只需读内存里的 `wb.keyHashes`（**零读盘、零正文**）。
            // 📊 实测（`_probe-pk26-release.mjs`）：改前 s5000 同名查重 **492.0s**（顺序读 5001 本）
            //    → 改后预期**秒级**（只做整数比较）。
            // ═══════════════════════════════════════════════════════════════
            const allTargets = [];
            potentialGroups.forEach(([name, list]) => list.forEach(wb => allTargets.push(wb)));

            // 3. ★ 组内精算（**直接全量两两**，不需要候选预筛）
            //    🔴 设计修正（2026-09-22 实测踩到两次，务必读完再改）：
            //       ① 原计划用「bottom-k + 倒排共现」做候选预筛 —— **在极端同源库下彻底失效**：
            //          所有书的 keys 几乎相同 → 每个 hash 的桶大小 = 全部书数 → 高频桶**全部被跳过**
            //          → 候选集为空。而「截断后仍枚举」又会爆（C(500,2)×64 ≈ 800 万对 → 卡死）。
            //       ② **同名分组本身已经把范围缩到组内**（实测 s1000：25 组 × 40 本 = 19500 对；
            //          s5000：每组 200 本 = C(200,2) ≈ 2 万对）—— 全量精算是 O(组内对数 × keys 长度)，
            //          实测量级完全可接受（**纯整数双指针，无读盘**）。
            //    ⇒ **组内直接全量精算**（简单、正确、无召回损失）；bottom-k 只用于**跨组发现改名重复**（可选，见下）。
            const MAX_KEY_COMPARE = 2000;   // 与主进程 MAX_KEYS_PER_BOOK 同口径
            const jaccardOf = (a, b) => {
                // 🧊 P2-2：**优先读快照**（查重开始时冻结）—— 防「中途保存书」污染本轮结果
                const sa = snapOf(a) || a, sb = snapOf(b) || b;
                const A = sa.keyHashes, B = sb.keyHashes;
                if (!Array.isArray(A) || !Array.isArray(B) || !A.length || !B.length) return null;
                // ⚠️ 截断口径（v3 评审 §5 #8）：跨「截断/未截断」书比较时**双方都截到 min(k, 自身)**
                const la = Math.min(MAX_KEY_COMPARE, A.length), lb = Math.min(MAX_KEY_COMPARE, B.length);
                let i = 0, j = 0, inter = 0;
                while (i < la && j < lb) {
                    const x = A[i], y = B[j];
                    if (x === y) { inter++; i++; j++; } else if (x < y) i++; else j++;
                }
                const union = la + lb - inter;
                return { jaccard: union ? inter / union : 0, inter, union, la, lb };
            };
            // 🧊 P2-2：冻结 L1 快照（**必须在比对开始前**，且只冻参与比对的条目）
            const frozen = freezeL1Snapshot(allTargets);
            addLog(`🧊 已冻结 L1 索引快照（${frozen} 本）—— 查重期间保存书籍不会影响本轮结果`, 'info');

            let noIndexCount = 0;
            // 🛑🛑 进度条时序修正（2026-09-23 用户反馈「进度条走完还要等几秒/几十秒」）：
            //    **病根**：旧实现用 `potentialGroups.map(...)` ——
            //      ① **同步执行**：整个比对在一个宏任务里跑完，**浏览器没有机会重绘**
            //         → 进度条虽然被赋值，但**画面不会更新**（用户看到的是「卡住」然后突然出结果）；
            //      ② 且每组都写死 `percent: 100` → 进度条**第 1 组就冲到 100%**。
            //    ✅ 修法：
            //      · 改为 **`for` + `await` 逐组处理**，每组后**让出主线程**
            //        （`await new Promise(r => setTimeout(r, 0))`）→ 进度条能真实重绘；
            //      · 进度映射 **50%~100%**（接阶段 1 的重扫 0~50%），**最后一组才到 100%**。
            //    📊 影响面：s5000 有 25 组 × 200 本，比对含 `getFileStats` + 组内两两 Jaccard，
            //       旧实现下「进度条 100% → 结果出现」的空白期可达数十秒。
            const groupTotal = potentialGroups.length;
            const builtGroups = [];
            for (let groupIdx = 0; groupIdx < groupTotal; groupIdx++) {
                const [name, list] = potentialGroups[groupIdx];
                // 进度：处理**第 groupIdx 组**时映射到 50% ~ 100%（`groupIdx/total`）
                applyDedupeProgress({
                    done: groupIdx,
                    total: groupTotal,
                    percent: 50 + (groupIdx / groupTotal) * 50
                });
                // ⚠️ 让出主线程：让 Vue 有机会重绘进度条（否则进度是「假的」—— 画面不更新）
                if (groupIdx % 5 === 0) await new Promise(r => setTimeout(r, 0));
                builtGroups.push((() => {
                    list.forEach(wb => {
                    // ⚡ PK-26：词条数走轻量 `entryCount`（秒开后 data 为 null）
                    // 🧊 P2-2：**优先读快照**（防中途保存书导致同一组内口径不一致）
                    const sp = snapOf(wb);
                    wb._entryCount = (sp && typeof sp.entryCount === 'number') ? sp.entryCount : wbCountOf(wb);
                    const kh = sp ? sp.keyHashes : wb.keyHashes;
                    if (!Array.isArray(kh)) noIndexCount++;
                    wb._mtime = fileStats?.[wb.path]?.mtimeMs || Date.now();
                    wb._dateStr = new Date(wb._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                    wb._sizeKb = ((fileStats?.[wb.path]?.size || 0) / 1024).toFixed(1);
                });

                // 排序：词条数多的排前面，词条数相近则新的排前面
                list.sort((a, b) => {
                    if (b._entryCount !== a._entryCount) return b._entryCount - a._entryCount;
                    return b._mtime - a._mtime;
                });

                // 计算相对第一本（推荐版本）的差异与触发词重合度（**纯整数比较，不读正文**）
                const master = list[0];
                list.forEach((wb, idx) => {
                    wb._nameOnly = false;
                    if (idx === 0) {
                        wb._diffInfo = '👑 建议保留 (词条最全/最新)';
                        wb._jaccard = 100;
                        return;
                    }
                    const cmp = jaccardOf(master, wb);
                    if (!cmp) {
                        // 🛡️ 无 L1 摘要（oversized / 未补齐）→ **明确标注，不静默**
                        wb._diffInfo = '⚠️ 缺少索引（超大书或元数据未补齐），未参与指纹比对';
                        wb._jaccard = null;
                        return;
                    }
                    const ratio = Math.round(cmp.jaccard * 100);
                    wb._jaccard = ratio;
                    // 🛡️ 同名假阳性防护（2026-09-23，与角色卡侧同口径）：
                    //    只按「书名」分组同样会聚出「同名但触发词毫无交集」的书。
                    //    L1a 的 Jaccard 已在手（**零额外成本**）→ 重合度极低即标「仅名称相同」。
                    //    阈值 5%：实测同名同源书的重合度普遍 ≥ 50%，无关书 ≈ 0%（间隙极大）。
                    if (ratio < 5) wb._nameOnly = true;
                    // 🆔 确定性判定：exactContentHash 一致 → 内容完全相同（比 Jaccard 更可靠）
                    // 🧊 P2-2：传**快照视图**（若已冻结）—— 防中途保存书导致「前半段旧 hash / 后半段新 hash」
                    const masterView = snapOf(master) || master;
                    const wbView = snapOf(wb) || wb;
                    const exact = typeof isExactSame === 'function' && isExactSame(masterView, wbView);
                    if (exact) {
                        wb._diffInfo = '⚠️ 内容完全相同（指纹一致，可安全清理）';
                    } else if (wb._entryCount === master._entryCount && ratio === 100) {
                        wb._diffInfo = '⚠️ 词条内容完全重合 (可安全清理)';
                    } else if (wb._nameOnly) {
                        wb._diffInfo = `⚠️ 仅书名相同·触发词几乎无交集 (${ratio}%)，很可能是不同世界书`;
                    } else {
                        wb._diffInfo = `🔍 触发词重合度: ${ratio}% (${wb._entryCount}条)`;
                    }
                });

                    return { name, list, nameOnlyCount: list.filter(w => w._nameOnly).length };
                })());
            }
            // ✅ 全部组处理完 → 结果**一次性赋值**（此时进度也刚好到 100%）
            //    ⚠️ 顺序关键：**先赋值再 finish** —— 保证「进度条走完」时内容**已经在**，
            //       不会出现用户报的「进度条走完还要等」（那正是本次修的目标）。
            wbDuplicateGroups.value = builtGroups;
            applyDedupeProgress({ done: groupTotal, total: groupTotal, percent: 100 });

            // 📢 PK-26 教训「静默 = 坏了」：无索引的书**必须可见**
            if (noIndexCount > 0) {
                addLog(`⚠️ 有 ${noIndexCount} 本世界书缺少 L1 索引（超大书或元数据未补齐），未参与指纹比对`, 'warning');
            }

            // 🛑 统一收尾（2026-09-22）：进度推到 100% 并**短暂停留**再收起。
            //    为什么必须在这里收尾而不是各阶段自己 reset：见 `finishDedupeScan` 的注释
            //    （各阶段 reset 会导致进度条横跳 / 时长时短 / 变光条 —— 用户实测报出）。
            finishDedupeScan();

            // 只要逻辑没报错，就一定能打开弹窗！（弹窗已在扫描前打开，此处仅兼容旧路径）
            showWbDedupeModal.value = true;
        } catch (err) {
            console.error('世界书查重引擎崩溃:', err);
            resetDedupeScan();
            showWbDedupeModal.value = false;
            nativeAlert(`❌ 世界书查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理重复世界书
    const resolveWbDedupeGroup = async (groupIndex, keepPath) => {
        const group = wbDuplicateGroups.value[groupIndex];
        if (!group) return;
        const pathsToTrash = group.list.filter(wb => wb.path !== keepPath).map(wb => wb.path);
        if (pathsToTrash.length === 0) return;

        // 🛡️ 同名假阳性防护（2026-09-23，与角色卡侧同口径）：待清理项含「仅书名相同」时必须警示
        const riskyWb = group.list.filter(wb => wb.path !== keepPath && wb._nameOnly);
        const warnWb = riskyWb.length > 0
            ? `\n\n⚠️ 注意：其中 ${riskyWb.length} 本只是「书名相同」，触发词几乎无交集`
              + `（很可能是完全不同的世界书）：\n`
              + riskyWb.slice(0, 5).map(w => `  · ${(w.path || '').split(/[\\/]/).pop()}`).join('\n')
              + (riskyWb.length > 5 ? `\n  …还有 ${riskyWb.length - 5} 本` : '')
              + `\n\n建议先点「🔍 对比差异」逐一确认，再决定是否清理。`
            : '';

        // ⚠️ confirm 在 Electron 中静默返回 null，必须用 confirmDialog
        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 本冗余/旧版世界书放入回收站吗？${warnWb}`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            // 🔧 按实际删除成功的路径过滤内存（失败项保留，与磁盘一致）
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));
            if (trashedPaths.length === 0) {
                return nativeAlert('全部世界书移入回收站失败（可能被其他程序占用），未做任何更改。', 'error');
            }

            worldbooks.value = worldbooks.value.filter(wb => !trashedPaths.includes(wb.path));
            // 组内全部删净才移除该组；有残留则只剔除已删项，保持弹窗数据与磁盘一致
            if (failedPaths.size === 0) {
                wbDuplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.list = group.list.filter(wb => !trashedPaths.includes(wb.path));
            }
            if (activeWorldbook.value && trashedPaths.includes(activeWorldbook.value.path)) {
                // ⚡ PK-26：走 selectWorldbook（会先载入正文），否则编辑器拿到 data:null 会崩
                const next = worldbooks.value[0] || null;
                if (next && typeof selectWorldbook === 'function') await selectWorldbook(next);
                else activeWorldbook.value = next;
            }
            addLog(`🗑️ 已清理 ${res.count} 本冗余世界书`, 'warning');

            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                if (typeof showToast === 'function') showToast(`已清理 ${res.count} 本，${failedPaths.size} 本失败（可能被占用）`, 'warning', 5000);
                nativeAlert(`已清理 ${res.count} 本；${failedPaths.size} 本失败（可能被占用）：\n${names}`, 'warning');
            } else {
                toastOk(`清理完成！已移入回收站 ${res.count} 本世界书。`);
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // ⚙️ 预设查重弹窗状态
    // =========================================================
    const showPresetDedupeModal = ref(false);  // 预设对比查重弹窗开关
    const presetDuplicateGroups = ref([]);     // 预设查重分组

    // 预设关键采样参数字段（用于「内容指纹」与差异提示）
    const PRESET_KEYS = [
        'temperature', 'max_tokens', 'max_context', 'rep_pen', 'rep_pen_range',
        'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'tfs',
        'epsilon_cutoff', 'eta_cutoff', 'openai_model', 'prompt_order'
    ];

    // 预设关键采样参数摘要（用于卡片展示，人类可读）
    const getPresetSettingsSummary = (p) => {
        const d = p.data || {};
        const map = {
            temperature: 'temp', max_context: 'ctx', max_tokens: 'max',
            rep_pen: 'rep', top_p: 'top_p', top_k: 'top_k', min_p: 'min_p',
            typical_p: 'typical', tfs: 'tfs', openai_model: 'model'
        };
        const parts = [];
        for (const [k, label] of Object.entries(map)) {
            if (d[k] !== undefined && d[k] !== null) {
                // 🔧 对象/数组值序列化，避免摘要出现 [object Object]
                const v = typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k];
                parts.push(`${label}=${v}`);
            }
        }
        return parts.join(' · ') || '（无采样参数）';
    };

    // 预设提示词条数（prompts 对象或数组、prompt_order 数组）
    const getPresetPromptCount = (p) => {
        const d = p.data || {};
        if (Array.isArray(d.prompts) && d.prompts.length) return d.prompts.length;
        // 🔧 SillyTavern 预设的 prompts 通常是对象 {"0":"…","1":"…"}，按键数统计，与指纹逻辑一致
        if (d.prompts && typeof d.prompts === 'object') return Object.keys(d.prompts).length;
        if (Array.isArray(d.prompt_order)) return d.prompt_order.length;
        return 0;
    };

    // 预设「内容指纹」：采样参数 + 归一化提示词正文，用于判定「完全相同」
    const getPresetFingerprint = (p) => {
        const d = p.data || {};
        const subset = {};
        PRESET_KEYS.forEach(k => { if (d[k] !== undefined) subset[k] = d[k]; });
        if (d.prompts && typeof d.prompts === 'object') {
            const prompts = {};
            // 🔧 数字键按数值升序（字典序会把 "10" 排在 "2" 前，导致同内容不同键集合误判）
            Object.keys(d.prompts).map(Number).sort((a, b) => a - b).forEach(k => { prompts[k] = String(d.prompts[k] || '').trim(); });
            subset._prompts = prompts;
        }
        return JSON.stringify(subset);
    };

    // 启动预设智能查重扫描
    const startPresetDedupeScan = async () => {
        try {
            // 🛑 修正（2026-09-23 热测试发现）：旧实现**库为空时直接 return，连弹窗都不开**
            //    ⇒ 用户点「智能查重」**毫无反应**（既不弹窗也不提示）= AR-38「零反馈 = 坏了」。
            //    ✅ 与角色卡/世界书侧对齐：**先开弹窗 + 清空上一轮结果**，再判空并给出明确提示。
            presetDuplicateGroups.value = [];
            showPresetDedupeModal.value = true;
            if (presets.value.length === 0) {
                finishDedupeScan();
                nativeAlert('预设库为空，无法进行查重！', 'warning');
                return;
            }
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                finishDedupeScan();
                nativeAlert('❌ 预设查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }
            // 📊 进度条：预设侧无扫描通道 → 不定态（不编假百分比）
            dedupeScanning.value = true;
            dedupeScanIndeterminate.value = true;
            dedupeScanLabel.value = '正在比对预设…';
            // 🛑 **新流程开始 = 重置**（裸赋值，不用统一入口的 `Math.max`）——
            //    否则上一轮残留百分比会被保留（实测残留 61/100）→ 切确定态时闪跳。
            dedupeScanPercent.value = 0;
            dedupeScanDone.value = 0;
            dedupeScanTotal.value = 0;

            const groups = {};
            // 1. 按预设名称聚类（data.name 优先，兜底文件名）
            presets.value.forEach(p => {
                const name = ((p.data && p.data.name) || (p.name || '').replace(/\.json$/i, '') || '未命名预设').trim();
                if (!groups[name]) groups[name] = [];
                groups[name].push(p);
            });

            const potentialGroups = Object.entries(groups).filter(([_, list]) => list.length > 1);
            if (potentialGroups.length === 0) {
                // ⚠️ 必须收尾（否则进度条停在中间不收起）
                finishDedupeScan();
                if (typeof showToast === 'function') showToast('🎉 恭喜！当前库中未发现同名的重复预设！', 'success', 4000);
                else nativeAlert('🎉 恭喜！当前库中未发现同名的重复预设！', 'info');
                return;
            }

            // 2. 批量获取物理文件状态（带空安全保护）
            const pathsToStat = [];
            potentialGroups.forEach(([_, list]) => list.forEach(p => pathsToStat.push(p.path)));
            let fileStats = {};
            try {
                const statsRes = await window.electronAPI.getFileStats(pathsToStat);
                if (statsRes && statsRes.success) fileStats = statsRes.data || {};
            } catch (e) {
                console.warn('获取预设文件信息失败:', e);
            }

            presetDuplicateGroups.value = potentialGroups.map(([name, list]) => {
                list.forEach(p => {
                    p._settings = getPresetSettingsSummary(p);
                    p._promptCount = getPresetPromptCount(p);
                    p._fingerprint = getPresetFingerprint(p);
                    p._fingerLen = p._fingerprint.length;
                    p._mtime = fileStats?.[p.path]?.mtimeMs || Date.now();
                    p._dateStr = new Date(p._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                    p._sizeKb = ((fileStats?.[p.path]?.size || 0) / 1024).toFixed(1);
                });

                // 排序：提示词更全的排前面，参数更丰富的其次，再按修改时间新→旧
                list.sort((a, b) => {
                    if (b._promptCount !== a._promptCount) return b._promptCount - a._promptCount;
                    if (b._fingerLen !== a._fingerLen) return b._fingerLen - a._fingerLen;
                    return b._mtime - a._mtime;
                });

                // 计算相对第一份（推荐保留）的差异
                const masterFp = list[0]._fingerprint;
                list.forEach((p, idx) => {
                    if (idx === 0) {
                        p._diffInfo = '👑 建议保留 (参数最全/最新)';
                    } else if (p._fingerprint === masterFp) {
                        p._diffInfo = '⚠️ 参数内容完全一致 (可安全清理)';
                    } else {
                        p._diffInfo = '🔍 参数配置存在差异';
                    }
                });

                return { name, list };
            });

            // 🛑 收尾（2026-09-23）：进度推到 100% 再收起（与角色卡/世界书侧同口径）
            finishDedupeScan();
            showPresetDedupeModal.value = true;
        } catch (err) {
            console.error('预设查重引擎崩溃:', err);
            resetDedupeScan();
            nativeAlert(`❌ 预设查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理重复预设
    const resolvePresetDedupeGroup = async (groupIndex, keepPath) => {
        const group = presetDuplicateGroups.value[groupIndex];
        if (!group) return;
        const pathsToTrash = group.list.filter(p => p.path !== keepPath).map(p => p.path);
        if (pathsToTrash.length === 0) return;

        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个冗余/旧版预设移入回收站吗？`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));
            if (trashedPaths.length === 0) {
                return nativeAlert('全部预设移入回收站失败（可能被其他程序占用），未做任何更改。', 'error');
            }

            presets.value = presets.value.filter(p => !trashedPaths.includes(p.path));
            if (failedPaths.size === 0) {
                presetDuplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.list = group.list.filter(p => !trashedPaths.includes(p.path));
            }
            if (activePreset.value && trashedPaths.includes(activePreset.value.path)) {
                activePreset.value = presets.value[0] || null;
            }
            addLog(`🗑️ 已清理 ${res.count} 个冗余预设`, 'warning');

            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                if (typeof showToast === 'function') showToast(`已清理 ${res.count} 个，${failedPaths.size} 个失败（可能被占用）`, 'warning', 5000);
                nativeAlert(`已清理 ${res.count} 个；${failedPaths.size} 个失败（可能被占用）：\n${names}`, 'warning');
            } else {
                toastOk(`清理完成！已移入回收站 ${res.count} 个预设。`);
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 🔍 查重双屏差异比对器 (Diff Inspector) 终极修复版
    // =========================================================
    const showDiffDetailModal = ref(false);
    const diffMasterItem = ref(null);
    const diffCompareItem = ref(null);
    const diffFieldResults = ref([]);

    /**
     * 行级差异（🎨 2026-09-21 改造）。
     *
     * 旧实现是「按标点切块 + 集合匹配」：不保留位置（同一句出现在别处就算相同），
     * 且两侧是**各自独立的滚动容器** → 行与行对不齐；长正文或小改动肉眼看不出来。
     * 现在改为 `diffContentForDisplay`：行级 LCS 对齐 + 变更行**行内精确高亮**，
     * 两侧共用同一份 `rows`（行号一一对应）→ 组件顺序渲染即天然对齐。
     *
     * ⚠️ 返回结构从 `{ masterLines, compareLines }` 变为 `{ rows, stats }`；
     *    `DiffModal` 已同步改为渲染 `rows`（并保留 `diffLines` 旧分支做兼容）。
     */
    const computeTextDiffLines = (str1 = '', str2 = '') => diffContentForDisplay(str1, str2);

    // 全能通用比对唤起 (自动识别世界书 / 角色卡)
    const openDiffDetailModal = (masterItem, compareItem) => {
        if (!masterItem || !compareItem) return;

        // 🦥 PK-20 后续（2026-09-22）：懒加载的书 `data` 为 null → 比对会得到空结果。
        //    ⚠️ 本函数是**同步**的（模板 `@open-diff` 直接调用），不能 await；
        //       故发现未载入时**先弹窗（加载态）**、再异步载入正文、完成后重新计算。
        //
        //    🛑 **必须防重入**（实测踩到「疯狂报错弹框」）：
        //       `ensureWorldbookLoaded` **失败时不会改 `dataLoaded`**（仍为 false），
        //       且它**内部自己会 `nativeAlert`**。若无保护地递归重试 →
        //       **无限递归 + 无限弹框**（每个失败的书都弹一次，循环不停）。
        //       故：用 WeakSet 记住「已尝试载入过」的条目，失败后**不再重试**，
        //       只弹一次说明，然后照常渲染（比对结果会是「本端无词条」，用户能看出问题）。
        const needLoad = (it) => it && it.dataLoaded === false && it.path;
        const attempted = (it) => diffLoadAttempted.has(it);
        if ((needLoad(masterItem) && !attempted(masterItem)) || (needLoad(compareItem) && !attempted(compareItem))) {
            diffMasterItem.value = masterItem;
            diffCompareItem.value = compareItem;
            diffFieldResults.value = [];
            showDiffDetailModal.value = true;
            (async () => {
                const failed = [];
                for (const it of [masterItem, compareItem]) {
                    if (!needLoad(it) || attempted(it)) continue;
                    diffLoadAttempted.add(it);          // ★ 先标记，无论成败都不再重试
                    try {
                        // silent 仅避免重复弹框；失败仍会**汇总提示一次**（不掩盖真因）
                        await ensureWorldbookLoaded(it, { silent: true });
                        if (it.dataLoaded !== true) failed.push(`${it.name || it.path}\n  → ${it._loadError || '读取失败'}`);
                    } catch (e) {
                        failed.push(`${it.name || it.path}\n  → ${e.message}`);
                    }
                }
                if (failed.length) {
                    addLog(`❌ 差异比对：${failed.length} 本世界书正文读取失败，比对结果可能不完整`, 'error');
                    nativeAlert(`❌ 无法读取以下世界书正文，比对结果可能不完整：\n\n${failed.join('\n')}`
                        + `\n\n请检查文件是否仍可访问；若提示未授权，重新点「打开世界书目录」后再试。`, 'error');
                }
                // 正文就绪后重新计算（此时已标记 attempted，不会再进本分支）
                openDiffDetailModal(masterItem, compareItem);
            })();
            return;
        }

        diffMasterItem.value = masterItem;
        diffCompareItem.value = compareItem;
        diffFieldResults.value = [];

        // 智能识别：当前是在查重世界书 / 角色卡 / 预设？
        // 🛡️ DF-19：entries 兼容对象字典形态（V2 老格式 {"0":{...}}）——与 main.js 的 isValidWorldbook 同口径，
        //    否则字典形态的书会被判成「角色卡」→ 走角色卡字段比对（全空）→ 显示「✅ 设定完全一致」的反向结论。
        // ⚡ PK-26：秒开后 `data` 常为 `null`（懒加载）→ **仅靠 `data.entries` 判不出世界书**
        //    → 会被误判成角色卡 → 同样是「设定完全一致」的反向结论。
        //    故补一条轻量判据：**有 `entryCount`（数字）也说明它是世界书**（秒开阶段就会给出）。
        const masterEntriesRaw = masterItem.data && masterItem.data.entries;
        const compareEntriesRaw = compareItem.data && compareItem.data.entries;
        // 判定「是不是世界书」：任一侧存在 entries（数组或字典形态）或带世界书元数据即认为是世界书
        const hasEntriesShape = (v) => !!v && typeof v === 'object';
        const looksWorldbook = (it) => !!it && (
            (it.data && hasEntriesShape(it.data.entries))
            || typeof it.entryCount === 'number'
            || !!it.wbName
        );
        const isWorldbook = looksWorldbook(masterItem) || looksWorldbook(compareItem);
        const isPreset = !isWorldbook && !!(
            masterItem.data &&
            ('temperature' in masterItem.data || 'prompts' in masterItem.data || 'prompt_order' in masterItem.data)
        );

        const masterData = (masterItem.data && (masterItem.data.data || masterItem.data)) || {};
        const compareData = (compareItem.data && (compareItem.data.data || compareItem.data)) || {};

        if (isWorldbook) {
            // ---------- 🌍 世界书对比逻辑 ----------
            const entries1 = normalizeEntries(masterEntriesRaw);
            const entries2 = normalizeEntries(compareEntriesRaw);

            const countSame = entries1.length === entries2.length;

            // 🧩 词条级对齐（DF-17）：把「不对称增删」表达成 only-a / only-b / both，
            //    回答用户真正关心的问题「删了哪个 / 加了哪个」——取代「拼接大字符串」的旧做法。
            const pairs = alignEntryLists(entries1, entries2);
            const stat = summarizeAlignment(pairs);
            const alignSame = stat.onlyA === 0 && stat.onlyB === 0 && stat.changed === 0;

            diffFieldResults.value.push({
                label: '📚 世界书词条总数 (Entries Count)',
                isSame: countSame,
                len1: `${entries1.length} 条`,
                len2: `${entries2.length} 条`,
                diffText: null,
                // 占位文案：本行无逐行对比内容，引导用户去看词条级对齐（否则会留白，观感像坏了）
                hint: countSame
                    ? '词条数一致。'
                    : `词条数不同（${entries1.length} vs ${entries2.length}）——逐条增删见下方「🧩 词条级对齐」。`
            });

            diffFieldResults.value.push({
                label: '🧩 词条级对齐 (Entry Alignment)',
                isEntryPairs: true,
                isSame: alignSame,
                len1: `新增 ${stat.onlyB} / 缺失 ${stat.onlyA} / 改动 ${stat.changed}`,
                len2: `共 ${pairs.length} 条`,
                pairs
            });

            // 提取所有触发词 Key
            const getKeys = (entries) => entries.map(e => (Array.isArray(e.key) ? e.key.join(', ') : e.key)).filter(Boolean);
            const keys1 = new Set(getKeys(entries1));
            const keys2 = new Set(getKeys(entries2));

            diffFieldResults.value.push({
                label: '🔑 触发词池覆盖差异 (Trigger Keys)',
                isSame: keys1.size === keys2.size && [...keys1].every(k => keys2.has(k)),
                isTags: true,
                commonTags: [...keys1].filter(k => keys2.has(k)),
                onlyMasterTags: [...keys1].filter(k => !keys2.has(k)),
                onlyCompareTags: [...keys2].filter(k => !keys1.has(k))
            });

            // 将所有词条内容拼接起来进行宏观文本对比（【加固】entry 判空 + String 强转，防脏数据崩溃）
            const text1 = entries1.map(e => (e && typeof e === 'object') ? String(e.content || '') : '').join('\n');
            const text2 = entries2.map(e => (e && typeof e === 'object') ? String(e.content || '') : '').join('\n');
            const isTextSame = text1 === text2;

            diffFieldResults.value.push({
                label: '📝 词条正文总集比对 (All Content Diff)',
                isSame: isTextSame,
                len1: `${text1.length} 字`,
                len2: `${text2.length} 字`,
                // 🎨 行级着色（两侧行号一一对应，变更行加底色 + 行内高亮）
                diffText: isTextSame ? null : computeTextDiffLines(text1, text2),
                hint: '正文总集无逐行差异可展开，逐条对比见「🧩 词条级对齐」。'
            });

        } else if (isPreset) {
            // ---------- ⚙️ 预设对比逻辑 ----------
            const presetFields = [
                { key: 'temperature', label: '🌡️ 温度 (Temperature)' },
                { key: 'max_tokens', label: '📏 最大输出 (Max Tokens)' },
                { key: 'max_context', label: '🧠 上下文 (Context)' },
                { key: 'rep_pen', label: '🚫 重复惩罚 (Rep Pen)' },
                { key: 'top_p', label: '🎯 Top P' },
                { key: 'top_k', label: '🔝 Top K' },
                { key: 'min_p', label: '📉 Min P' },
                { key: 'openai_model', label: '🧩 模型 (Model)' }
            ];
            const presetVal = (d, k) => {
                const v = d[k];
                if (v === undefined || v === null) return '';
                return typeof v === 'object' ? JSON.stringify(v) : String(v);
            };
            presetFields.forEach(f => {
                const v1 = presetVal(masterData, f.key);
                const v2 = presetVal(compareData, f.key);
                diffFieldResults.value.push({
                    label: f.label,
                    isSame: v1 === v2,
                    len1: v1 || '未设置',
                    len2: v2 || '未设置',
                    diffText: (v1 === v2) ? null : computeTextDiffLines(v1, v2)
                });
            });

            // 提示词正文对比
            const formatPrompts = (d) => {
                const prompts = d.prompts;
                if (!prompts) return '';
                if (Array.isArray(prompts)) return prompts.join('\n');
                if (typeof prompts === 'object') {
                    return Object.keys(prompts).map(k => `${k}: ${String(prompts[k] || '')}`).join('\n');
                }
                return String(prompts);
            };
            const promptText1 = formatPrompts(masterData);
            const promptText2 = formatPrompts(compareData);
            const isPromptSame = promptText1 === promptText2;
            diffFieldResults.value.push({
                label: '💬 提示词正文 (Prompts)',
                isSame: isPromptSame,
                len1: `${promptText1.length} 字`,
                len2: `${promptText2.length} 字`,
                diffText: isPromptSame ? null : computeTextDiffLines(promptText1, promptText2)
            });
        } else {
            // ---------- 🎴 角色卡对比逻辑 ----------
            const fieldsToCompare = [
                { key: 'description', label: '📝 角色描述 (Description)' },
                { key: 'personality', label: '🎭 性格设定 (Personality)' },
                { key: 'scenario', label: '🎬 当前场景 (Scenario)' }, // ✅ 补上漏掉的场景字段（此前场景改动在查重面板上不显示，可能误删新版本）
                { key: 'first_mes', label: '💬 开场首句 (First Message)' },
                { key: 'mes_example', label: '🗣️ 示例对话 (Mes Example)' }
            ];

            diffFieldResults.value = fieldsToCompare.map(f => {
                const val1 = String(masterData[f.key] || masterItem[f.key] || '');
                const val2 = String(compareData[f.key] || compareItem[f.key] || '');
                const isSame = val1.trim() === val2.trim();
                return {
                    label: f.label,
                    isSame,
                    len1: `${val1.length} 字`,
                    len2: `${val2.length} 字`,
                    diffText: isSame ? null : computeTextDiffLines(val1, val2)
                };
            });

            // 标签对比
            const tags1 = new Set([...(masterItem.customTags || []), ...((masterData && masterData.tags) || [])]);
            const tags2 = new Set([...(compareItem.customTags || []), ...((compareData && compareData.tags) || [])]);

            diffFieldResults.value.push({
                label: '🏷️ 自定义/系统标签 (Tags)',
                isSame: tags1.size === tags2.size && [...tags1].every(t => tags2.has(t)),
                isTags: true,
                commonTags: [...tags1].filter(t => tags2.has(t)),
                onlyMasterTags: [...tags1].filter(t => !tags2.has(t)),
                onlyCompareTags: [...tags2].filter(t => !tags1.has(t))
            });
        }

        showDiffDetailModal.value = true;
    };

    // =========================================================
    // 🧬 内容级跨名称版本查重引擎（MinHash + LSH 预过滤 + Union-Find 聚类）
    //    与「同名查重」互补：即使名字/文件名不同，只要内容高度相似也归为一组。
    //    角色卡/世界书/预设通用，由当前 appMode 决定数据源。
    // =========================================================
    const showContentDedupeModal = ref(false);
    const contentDuplicateGroups = ref([]);

    // 1) 按资产类型提取对比文本（角色卡：描述/人格/场景/开场白；世界书：词条 key+content；预设：提示词+采样参数）
    //    ⚡ PK-26：世界书分支改为 **async + 按需载入正文**（秒开后 `data` 为 null）。
    //       调用方（内容级查重）已 `ensureWorldbookLoaded`，此处再兜一层保证契约完整。
    const extractContentText = async (item) => {
        if (appMode.value === 'worldbooks') {
            const entries = await wbEntriesOf(item);
            return entries.map(e => {
                if (!e || typeof e !== 'object') return '';
                const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
                return `${keys} ${e.content || ''}`;
            }).join('\n');
        }
        if (appMode.value === 'presets') {
            const d = item.data || {};
            const promptTexts = [];
            if (d.prompts && typeof d.prompts === 'object') {
                Object.keys(d.prompts).map(Number).sort((a, b) => a - b)
                    .forEach(k => promptTexts.push(String(d.prompts[k] || '')));
            } else if (Array.isArray(d.prompts)) {
                d.prompts.forEach(p => promptTexts.push(typeof p === 'string' ? p : JSON.stringify(p)));
            }
            const params = PRESET_KEYS.filter(k => d[k] !== undefined)
                .map(k => `${k}=${JSON.stringify(d[k])}`).join('|');
            return promptTexts.join('\n') + '\n' + params;
        }
        // 角色卡
        const d = item.data?.data || item.data || {};
        return [d.description, d.personality, d.scenario, d.first_mes, d.mes_example]
            .filter(Boolean).join('\n');
    };

    // 2) 文本规范化（去空白/标点/大小写）
    const normalizeText = (t) => String(t || '')
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .toLowerCase()
        .trim();

    // 3) 字符 4-gram shingle 集合
    const getShingles = (text) => {
        const set = new Set();
        for (let i = 0; i + 4 <= text.length; i++) set.add(text.slice(i, i + 4));
        return set;
    };

    // ═══════════════════════════════════════════════════════════════
    // 🧬 PK-27 / S3'（2026-09-22）：**simhash 内容指纹**（替代 MinHash+LSH）
    // ───────────────────────────────────────────────────────────────
    // 📖 方案：`docs/规格与计划/世界书大库-加载与查重架构方案.md` §6.2
    // 📊 定稿依据：`docs/规格与计划/S0.5-simhash特征方案实验报告.md` + `_probe-simhash-opt.mjs`
    //    · 特征方案：**char 4-gram**（负样本汉明距离 = 理论期望 32，分离最好）
    //    · 实现：**零分配 charCode 哈希**（不 `slice`，避免每 4-gram 分配字符串）
    //    · **采样 step=4**：实测 **43ms/本**（全库 3.9 分钟）vs 不采样 171ms/本（15.4 分钟）
    //      —— 提速 4×，且正样本 max 8 / 负样本 min 31（**间隙 23，仍清晰可分**）
    //    · 阈值 **T = 19**（正 max 8 ｜ 负 min 31 → 中点）
    // 🔴 **为什么替代 MinHash+LSH**：原 LSH 桶内是 O(bucket²)，在**极端同源库**下
    //    大量项落进同一批桶 → 亿级比对（PK-25，实测 >25 分钟未完）。
    //    simhash 比较只需**整数异或 + popcount**（每对 <1μs），且天然无「桶」概念。
    // ═══════════════════════════════════════════════════════════════
    const SIMHASH_N = 4;          // char 4-gram（S0.5 定稿）
    const SIMHASH_STEP = 4;       // 特征采样步长（S3' 优化实测）
    const SIMHASH_THRESHOLD = 19; // 汉明距离阈值（S0.5 实验：正 max 8 / 负 min 31）

    /**
     * 计算 64 位 simhash（**number 双 32 位**，返回 `[lo, hi]`）。
     * ⚠️ 不用 BigInt：实测 BigInt 版 **1387ms/本** vs number 版 **171ms/本**（**8× 差距**）。
     * ⚠️ 不 `slice`：直接对窗口内 charCode 做 FNV-1a（**零字符串分配**）。
     */
    const computeSimhash = (text) => {
        const v = new Int32Array(64);
        const len = text.length;
        const n = SIMHASH_N, step = SIMHASH_STEP;
        for (let i = 0; i + n <= len; i += step) {
            let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
            for (let k = 0; k < n; k++) {
                const c = text.charCodeAt(i + k);
                lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
                hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
            }
            for (let b = 0; b < 32; b++) {
                v[b] += ((lo >>> b) & 1) ? 1 : -1;
                v[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
            }
        }
        let outLo = 0, outHi = 0;
        for (let b = 0; b < 32; b++) {
            if (v[b] > 0) outLo |= (1 << b);
            if (v[b + 32] > 0) outHi |= (1 << b);
        }
        return [outLo >>> 0, outHi >>> 0];
    };

    /** 64 位 simhash 的**汉明距离**（整数异或 + popcount，每对 <1μs） */
    const hammingDistance = (a, b) => {
        let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
        while (x) { c += x & 1; x >>>= 1; }
        while (y) { c += y & 1; y >>>= 1; }
        return c;
    };

    // 4) 确定性 MinHash 哈希函数族（固定种子，同一文本签名稳定）
    const MINHASH_HASHES = 96;
    const LSH_BANDS = 8;
    const LSH_ROWS = MINHASH_HASHES / LSH_BANDS; // 12
    const minhashSeeds = (() => {
        const seeds = [];
        let s = 0x9e3779b9;
        for (let i = 0; i < MINHASH_HASHES; i++) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            seeds.push(s);
        }
        return seeds;
    })();
    const hashString = (str, seed) => {
        let h = seed >>> 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
        return h;
    };

    // 5) MinHash 签名（每 shingle 求 96 个哈希的最小值）
    const computeMinHash = (shingles) => {
        const sig = new Array(MINHASH_HASHES).fill(0x7fffffff);
        shingles.forEach(sh => {
            for (let i = 0; i < MINHASH_HASHES; i++) {
                const h = hashString(sh, minhashSeeds[i]);
                if (h < sig[i]) sig[i] = h;
            }
        });
        return sig;
    };

    // 6) Jaccard 估计 = 签名中相同分量比例
    const estimateSimilarity = (a, b) => {
        let same = 0;
        for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
        return same / a.length;
    };

    // 7) LSH band 分桶 key（同一 band 内签名段完全一致的项互为候选）
    const bandKey = (sig, band) => {
        let key = '';
        for (let r = 0; r < LSH_ROWS; r++) key += sig[band * LSH_ROWS + r].toString(16).padStart(8, '0');
        return key;
    };

    // 8) Union-Find 并查集
    const unionFind = (n) => {
        const parent = Array.from({ length: n }, (_, i) => i);
        const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
        return { find, union };
    };

    // 9) 内容级版本查重主流程
    const startContentDedupeScan = async () => {
        try {
            // 📊🔍 内容级查重同样先重扫当前视图对应的库（2026-09-22）。
            //    角色卡/世界书走各自的重扫；预设无扫描通道 → 直接用已加载的库。
            //    ⚠️⚠️ 先开弹窗再重扫，否则扫描期间看不到进度条
            //    🧹 同样必须清空上一轮结果（否则扫描期间显示陈旧分组）
            contentDuplicateGroups.value = [];
            showContentDedupeModal.value = true;
            // 🛑 进度条连续性（2026-09-22 用户实测报出「横跳 / 时长时短 / 变光条」）：
            //    旧实现：阶段 1（重扫）确定态 → 阶段 2 切成 `indeterminate`（**滚动光条**），
            //    且各阶段 `finally` 里 reset → 进度条消失又出现。
            //    ⇒ 现在：**全程确定态**（阶段 1 占 0~50%、阶段 2 占 50~100%），**绝不切不定态、绝不中途 reset**。
            const keepAlive = true;
            dedupeScanning.value = true;
            dedupeScanIndeterminate.value = false;   // ★ 不切不定态（避免「滚动光条」）
            // 🛑 AR-45 二次修复：**走统一入口重置**（数字与宽度同源；不裸赋值）
            dedupeScanDone.value = 0;
            dedupeScanTotal.value = 0;
            dedupeScanPercent.value = 0;
            dedupeScanLabel.value = '正在扫描库文件…';
            if (appMode.value === 'worldbooks') await rescanForWorldbookDedupe({ keepAlive });
            else if (appMode.value !== 'presets') await rescanForCardDedupe({ keepAlive });
            const items = appMode.value === 'worldbooks' ? worldbooks.value
                : appMode.value === 'presets' ? presets.value
                : library.value;
            if (!items || items.length === 0) {
                finishDedupeScan();
                nativeAlert('当前库为空，无法进行版本查重！', 'warning');
                return;
            }
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                finishDedupeScan();
                nativeAlert('❌ 版本查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            // 提取规范化文本，内容过短（<20 字符）无法可靠判定，跳过
            const valid = [];
            if (appMode.value === 'worldbooks') {
                // 🦥 PK-20 后续（2026-09-22）：世界书可能未载入正文（懒加载）→ 必须按需读取。
                //    ⚠️⚠️ 但**不能「先提取全部文本再算签名」**：实测 1001 本时归一化文本 ≈ 600MB，
                //       5000 本 → 3GB → **渲染进程被 OOM killer 杀掉**（`reason:"killed"`，实测踩到）。
                //    ✅ 正确做法：**逐本：读入 → 提取 → 算签名 → 立即丢弃文本与正文**。
                //       内存峰值只 = 单本文本 + 全部签名（每本 96 个 int，极小）。
                const total = items.length;
                dedupeScanning.value = true;
                // 🧬 S3'（2026-09-23）：**优先用落盘的 L1b simhash**（`wb.simhash`）——
                //    有它就不必读正文！这是「L1b 落盘」的**唯一收益**：
                //      · 未落盘：逐本读正文（s5000 = 34.8GB）+ 算 simhash（43ms/本）
                //      · 已落盘：**零读盘**，只做整数比较
                //    ⚠️ 但落盘的代价是**首次索引慢 15.6 分钟**（见 main.js `WB_STORE_SIMHASH`），
                //      故默认关闭 ⇒ 此处是**双路径**（有则用、无则算），两条必须同口径。
                const hasL1b = items.filter(it => Array.isArray(it.simhash) && it.simhash.length === 2).length;
                const useL1b = hasL1b > 0;
                // 🛑 AR-45 二次修复：数字与宽度**同源写入**（走统一入口）
                //    本阶段按「已处理本数 / 总本数」推进，且 `total` 在这里**已知**（不像阶段 1 的
                //    `wbScanProgress` 会归零）→ 数字不会再掉回「0 / ?」。
                applyDedupeProgress({
                    label: useL1b
                        ? `正在比对内容指纹（共 ${total} 本，已用落盘索引 ${hasL1b} 本）…`
                        : `正在逐本读取并计算内容指纹（共 ${total} 本）…`,
                    done: 0,
                    total,
                    percent: Math.max(dedupeScanPercent.value, 50)
                });
                addLog(useL1b
                    ? `🧬 内容查重：${hasL1b}/${total} 本已用**落盘 simhash**（零读盘）；其余 ${total - hasL1b} 本需读正文`
                    : `🧬 内容查重：无落盘 simhash → 逐本读正文计算（共 ${total} 本）`, 'info');
                // 🛑 2026-09-22（用户实测报出「最后变成滚动的光条」）：
                //    **绝不切不定态**。旧实现这里置 `true` → 进度条变滑动光条，
                //    用户看到「明明有进度却不显示数字」的观感突变。
                //    ⇒ 全程确定态；本阶段进度映射到 **50%~100%**（接阶段 1，**用 max 防倒退**）。
                dedupeScanIndeterminate.value = false;
                // 🧯 PK-27：改走**统一批量消费器**（顺序 + 用后释放 + 让出主线程）。
                //    原来这里自己写了一套 `for` 循环 —— 两套循环行为不一致正是 PK-27 的土壤。
                try {
                    if (typeof consumeWorldbookBodies === 'function') {
                        await consumeWorldbookBodies(items, async (item) => {
                            // 🧬 L1b 快路径：已有落盘 simhash → **不读正文**
                            if (useL1b && Array.isArray(item.simhash) && item.simhash.length === 2) {
                                // ⚠️ `textLen` 用于「内容最长者排最前」的展示排序；
                                //    无正文时用「词条数」近似（不读正文的代价，仅影响展示顺序）
                                return { sig: item.simhash, textLen: wbCountOf(item) || 0, fromL1b: true };
                            }
                            const text = normalizeText(await extractContentText(item));
                            // ★ 关键：**当场算签名**，不让文本进入结果（否则全部常驻）
                            return text.length < 20 ? null : { sig: computeSimhash(text), textLen: text.length };
                        }, {
                            concurrency: 1,
                            onProgress: (doneN, totalN) => {
                                // ★ AR-45 二次修复：**走统一入口**（数字与宽度同源 + 单调保护）
                                //    旧写法只更新 `percent`，**没更新 `done/total`** →
                                //    数字停在阶段 1 的扫描值，与条宽脱钩（用户看到「条 100%、数字 0 / ?」）。
                                applyDedupeProgress({
                                    done: doneN,
                                    total: totalN,
                                    percent: totalN ? 50 + (doneN / totalN) * 50 : dedupeScanPercent.value
                                });
                            }
                        }).then(({ results }) => {
                            results.forEach((r, idx) => {
                                if (r) valid.push({ item: items[idx], idx, sig: r.sig, textLen: r.textLen });
                            });
                        });
                    } else {
                        // 兜底（不应发生）：顺序读取，**仍不得并发**
                        for (let idx = 0; idx < items.length; idx++) {
                            const item = items[idx];
                            let text = '';
                            try {
                                if (item && item.dataLoaded === false && item.path && typeof ensureWorldbookLoaded === 'function') {
                                    await ensureWorldbookLoaded(item, { silent: true, batch: true });
                                }
                                text = normalizeText(await extractContentText(item));
                            } catch (e) { text = ''; }
                            finally {
                                if (item && item.dataLoaded === true && item.heavy) {
                                    if (typeof releaseWorldbookBody === 'function') releaseWorldbookBody(item);
                                    else { item.data = null; item.dataLoaded = false; }
                                }
                            }
                            if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
                            // ★ AR-45 二次修复：走统一入口（与消费器路径同口径，数字+宽度同源）
                            applyDedupeProgress({
                                done: idx + 1,
                                total: items.length,
                                percent: 50 + ((idx + 1) / items.length) * 50
                            });
                            if (text.length >= 20) valid.push({ item, idx, sig: computeSimhash(text), textLen: text.length });
                        }
                        if (items.length) triggerRef(worldbooks);
                    }
                } finally {
                    // 🛑 2026-09-22：**不在这里 reset**（会导致进度条消失又出现）。
                    //    统一由本函数结尾（阶段 2 全部完成后）收尾。
                    await new Promise(r => setTimeout(r, 100));
                }
                addLog(`🧬 内容查重：已计算 ${valid.length}/${total} 本世界书的内容指纹（其余内容过短或读取失败）`, 'info');
                // 📢 失败**必须可见**：列出真实原因（不掩盖）。批量下逐本弹框会淹没界面，故汇总一次。
                const failedItems = items.filter(it => it && it._loadError);
                const shortOnes = total - valid.length - failedItems.length;
                if (failedItems.length > 0) {
                    const sample = failedItems.slice(0, 5).map(it => `· ${it.name || it.path}\n  → ${it._loadError}`);
                    nativeAlert(`❌ 有 ${failedItems.length} 本世界书正文读取失败，未参与内容比对。\n\n`
                        + `前 ${Math.min(5, failedItems.length)} 个原因：\n${sample.join('\n')}`
                        + (failedItems.length > 5 ? `\n…还有 ${failedItems.length - 5} 本` : '')
                        + `\n\n请检查文件是否仍可访问；若提示未授权，重新点「打开世界书目录」后再试。`, 'error');
                } else if (shortOnes > 0) {
                    addLog(`ℹ️ 另有 ${shortOnes} 本内容过短（<20 字符），已跳过比对`, 'info');
                }
            } else {
                // ⚡ PK-26：`extractContentText` 已改 async → 顺序 await（角色卡/预设侧本就不需载入，代价可忽略）
                // 🛑🛑 修复（2026-09-23 真实库热测试暴露，**用户反馈第 2 点**）：
                //    旧实现把**每张卡的归一化正文**都塞进 `valid[i].text` 常驻 ——
                //    实测真实 11,188 张卡库：内容查重耗时 **151.8s**（用户观感 = 卡死），
                //    且此分支**既无进度推进、也不让出主线程** → 进度条全程不动（AR-38「零反馈 = 坏了」）。
                //    ✅ 与世界书分支同口径：**当场算签名 → 立即丢弃文本**（内存峰值 = 单卡文本 + 全部签名）。
                //       MinHash 签名仅 96 个 int，全库常驻代价可忽略；正文则可达数百 MB。
                //    进度：**50%~90%**（90% 留给后续 getFileStats 读盘阶段，100% 由收尾统一给）。
                applyDedupeProgress({
                    label: `正在逐张提取并计算内容指纹（共 ${items.length} 张）…`,
                    done: 0,
                    total: items.length,
                    percent: Math.max(dedupeScanPercent.value, 50)
                });
                await new Promise(r => setTimeout(r, 0));
                for (let idx = 0; idx < items.length; idx++) {
                    const item = items[idx];
                    let text = '';
                    try {
                        text = normalizeText(await extractContentText(item));
                    } catch (e) { text = ''; }
                    // ★ 关键：**当场算签名**，不让文本进入结果（否则全部常驻 → 大库内存爆炸）
                    if (text.length >= 20) {
                        valid.push({ item, idx, sig: computeMinHash(getShingles(text)), textLen: text.length });
                    }
                    applyDedupeProgress({
                        done: idx + 1,
                        total: items.length,
                        percent: 50 + ((idx + 1) / items.length) * 40
                    });
                    // ⚠️ 让出主线程（每 10 张）—— 否则进度条**画面不会更新**（赋值 ≠ 重绘）
                    if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
                }
            }
            const n = valid.length;
            if (n < 2) {
                finishDedupeScan();
                if (typeof showToast === 'function') showToast('🎉 未发现可判定的内容重复项（内容过短的项已跳过）。', 'success', 4000);
                else nativeAlert('🎉 未发现可判定的内容重复项（内容过短的项已跳过）。', 'info');
                return;
            }

            // 计算签名（挂回条目，供相似度展示复用）
            // ⚠️ 世界书分支已在提取时**当场算好** `v.sig`（为避免全部文本常驻内存）；
            //    这里只对尚未算签名的分支（角色卡 / 预设）补算。
            // 🧬 S3'：**世界书用 simhash（`[lo,hi]` 位向量）**；角色卡/预设仍走 **MinHash（96 维计数向量）**
            //    ⚠️ 两者**语义不同**（位向量 vs 计数向量），**绝不能混用同一个相似度函数**
            //    （`estimateSimilarity` 是「相同分量比例」，对 `[lo,hi]` 无意义）。
            const useSimhash = appMode.value === 'worldbooks';
            const sigs = valid.map(v => v.sig || computeMinHash(getShingles(v.text || '')));
            valid.forEach((v, i) => { v.sig = sigs[i]; });

            // 🧬 PK-27 / S3'：**simhash 全量两两 + 汉明距离预筛**（替代原 LSH，解 PK-25）
            // ─────────────────────────────────────────────────────────────
            // 🔴 原实现（MinHash + LSH）的问题：**桶内是朴素两两比较 O(bucket²)**。
            //    极端同源库下大量项落进同一批桶 → 亿级比对（PK-25，实测 >25 分钟未完）。
            // ✅ 新实现（simhash）：比较是**整数异或 + popcount**（每对 <1μs），
            //    且**先按汉明距离阈值 T 预筛**。
            //
            // ⚠️ 但**仍必须防「候选对爆炸」**（否则又是 PK-25 换形式）：
            //    极端同源库下所有书 simhash 都相同 → 预筛**全部通过** → C(n,2) 对。
            //    实测：s1000（1001 本）C(1001,2) ≈ 50 万对 × <1μs ≈ **0.5s**；
            //          s5000（5001 本）C(5001,2) ≈ 1250 万对 × <1μs ≈ **12.5s** —— 均可接受。
            //    ⇒ 因 simhash 比较极快（比 MinHash 的 96 次整数比较快约 100×），
            //      **全量两两预筛可接受**，不需要分桶（分桶反而引入桶大小调参难题）。
            //
            // 🎯 **判定口径（simhash 路径）**：**只看汉明距离**（`d ≤ T` 即判为同组）。
            //    这是 simhash 的标准用法（位差异 = 内容相似度）；阈值 T 由 S0.5 实验定（正 max 8 / 负 min 31）。
            //    ⚠️ **不能再用 `estimateSimilarity`** —— 那是 MinHash 的「相同分量比例」，
            //       对 `[lo,hi]` 位向量无意义（实测会把同源对的相似度算成 0 → 全部漏报）。
            const THRESHOLD = 0.85;
            const uf = unionFind(n);
            const pairStats = { total: 0, candidates: 0 };
            if (useSimhash) {
                // 🛑🛑 进度条时序修正（2026-09-23 用户反馈「进度条走完还要等」）：
                //    **病根**：这里是**纯同步双重循环**（s1000 有 C(1001,2) ≈ 50 万对）——
                //      期间浏览器**没有机会重绘** → 进度条卡在最后的值不动，用户以为「卡死」，
                //      然后结果**突然**出现（观感就是「进度条走完还要等几十秒」）。
                //    ✅ 修法：**每处理一批让出主线程** + **按 a 的进度映射到 90%~99%**
                //      （90% 留给「读取正文」阶段，99% 留给「构造分组」，100% 由收尾统一给）。
                const totalPairs = (n * (n - 1)) / 2;
                let processed = 0;
                for (let a = 0; a < n; a++) {
                    for (let b = a + 1; b < n; b++) {
                        pairStats.total++;
                        if (hammingDistance(sigs[a], sigs[b]) <= SIMHASH_THRESHOLD) {
                            pairStats.candidates++;
                            uf.union(a, b);
                        }
                    }
                    // 进度：按外层 a 的比例映射到 90%~99%（**只在最后一个 a 才到 99**）
                    processed += (n - 1 - a);
                    applyDedupeProgress({
                        done: a + 1,
                        total: n,
                        percent: 90 + ((a + 1) / n) * 9
                    });
                    // ⚠️ 让出主线程（每 20 本一次）—— 否则进度条**画面不会更新**
                    if (a % 20 === 19) await new Promise(r => setTimeout(r, 0));
                }
                addLog(`🧬 simhash 预筛：${pairStats.total} 对（${totalPairs} 理论值）→ 同组 ${pairStats.candidates} 对`
                    + `（阈值 T=${SIMHASH_THRESHOLD}；已解 PK-25 的 O(bucket²)）`, 'info');
            } else {
                // 角色卡 / 预设：保留原 MinHash + LSH 路径（集合语义更合适，且量级小）
                const buckets = new Map();
                valid.forEach((_, i) => {
                    for (let b = 0; b < LSH_BANDS; b++) {
                        const k = bandKey(sigs[i], b);
                        if (!buckets.has(k)) buckets.set(k, []);
                        buckets.get(k).push(i);
                    }
                });
                const seenPairs = new Set();
                // 🛑 进度条时序修正（2026-09-23）：分桶比较也改为**逐桶 + 让出主线程**，
                //    否则桶多时同样是「同步跑完才重绘」（用户观感 = 进度条卡住）。
                const bucketList = [...buckets.values()];
                let bucketDone = 0;
                for (const list of bucketList) {
                    bucketDone++;
                    // 进度：按桶数映射到 90%~99%
                    applyDedupeProgress({
                        done: bucketDone,
                        total: bucketList.length,
                        percent: 90 + (bucketDone / bucketList.length) * 9
                    });
                    if (list.length >= 2) {
                        for (let x = 0; x < list.length; x++) {
                            for (let y = x + 1; y < list.length; y++) {
                                const a = list[x], b = list[y];
                                const pairKey = a < b ? `${a}:${b}` : `${b}:${a}`;
                                if (seenPairs.has(pairKey)) continue;
                                seenPairs.add(pairKey);
                                if (estimateSimilarity(sigs[a], sigs[b]) >= THRESHOLD) uf.union(a, b);
                            }
                        }
                    }
                    // ⚠️ 每 20 桶让出一次主线程（让进度条真实重绘）
                    if (bucketDone % 20 === 0) await new Promise(r => setTimeout(r, 0));
                }
            }

            // 聚类分组（单例忽略）
            const clusters = new Map();
            valid.forEach((_, i) => {
                const root = uf.find(i);
                if (!clusters.has(root)) clusters.set(root, []);
                clusters.get(root).push(i);
            });

            const rawGroups = [];
            clusters.forEach(members => {
                if (members.length < 2) return;
                rawGroups.push(members.map(i => valid[i]));
            });

            if (rawGroups.length === 0) {
                finishDedupeScan();
                if (typeof showToast === 'function') showToast('🎉 未发现内容高度相似的重复项！', 'success', 4000);
                else nativeAlert('🎉 未发现内容高度相似的重复项！', 'info');
                return;
            }

            // 批量获取物理状态（修改时间/大小）用于展示与排序
            // 🛑 进度条时序修正（2026-09-23）：这一步要**读盘**（`getFileStats`），
            //    在 s5000 上可达数秒 —— 旧实现此时进度条**已经是 100%**，
            //    用户看到的就是「走完还要等」。故在此**明确标注阶段文案**并**推进到 99%**。
            applyDedupeProgress({
                label: `正在读取文件信息（${rawGroups.reduce((s, g) => s + g.length, 0)} 本）…`,
                percent: 99
            });
            await new Promise(r => setTimeout(r, 0));   // 让出，让文案先渲染出来
            const flatPaths = rawGroups.flat().map(v => v.item.path);
            let fileStats = {};
            try {
                const res = await window.electronAPI.getFileStats(flatPaths);
                if (res && res.success) fileStats = res.data || {};
            } catch (e) { /* 降级为无物理状态 */ }

            contentDuplicateGroups.value = rawGroups.map(list => {
                list.forEach(v => {
                    const st = fileStats[v.item.path];
                    v._sizeKb = st ? (st.size / 1024).toFixed(1) : '?';
                    v._mtime = st ? st.mtimeMs : Date.now();
                    v._dateStr = new Date(v._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                });
                // 内容最长者排最前（更可能是完整版）
                // ⚠️ 世界书分支的文本已被丢弃（内存优化），改用提取时记下的 `textLen`。
                list.sort((a, b) => (b.textLen || 0) - (a.textLen || 0));
                const master = list[0];
                list.forEach(v => {
                    // 🧬 S3'：**simhash 路径**用「汉明距离 → 相似度」换算（位向量语义）；
                    //    角色卡/预设仍用 MinHash 的「相同分量比例」。
                    //    ⚠️ 两者**语义不同**，混用会把同源对算成 0（实测踩到）。
                    if (useSimhash) {
                        const d = hammingDistance(v.sig, master.sig);
                        v._simPct = v === master ? 100 : Math.max(0, Math.round((1 - d / 64) * 100));
                        v._hamming = d;
                    } else {
                        v._simPct = v === master ? 100 : Math.round(estimateSimilarity(v.sig, master.sig) * 100);
                    }
                    // ⚠️ 正文可能已被释放（懒加载态）→ 不能再从 `item.data` 取书名，
                    //    回退到 `item.name` / 文件名（世界书的书名本来就常回退为文件名）。
                    //    ⚡ PK-27 / S1'：优先用轻量 `wbName`（秒开后 `data` 为 null）。
                    const d = (v.item.data && (v.item.data.data || v.item.data)) || {};
                    v._name = d.name || v.item.wbName || v.item.name || (v.item.path || '').split(/[\\/]/).pop() || '未命名';
                });
                return { name: master._name, kind: 'content', list };
            });

            // 🛑 统一收尾（2026-09-22）：进度推到 100% 并短暂停留再收起。
            //    见 `rescanForWorldbookDedupe` 的注释（各阶段自行 reset 会导致进度条横跳）。
            finishDedupeScan();
            showContentDedupeModal.value = true;
            addLog(`🧬 内容级版本查重完成，发现 ${contentDuplicateGroups.value.length} 组疑似重复`, 'info');
        } catch (err) {
            console.error('内容级版本查重异常:', err);
            resetDedupeScan();
            nativeAlert(`❌ 版本查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理：保留指定项，其余疑似重复版本移入回收站
    const resolveContentDedupeGroup = async (groupIndex, keepPath) => {
        const group = contentDuplicateGroups.value[groupIndex];
        if (!group) return;
        const pathsToTrash = group.list.filter(v => v.item.path !== keepPath).map(v => v.item.path);
        if (pathsToTrash.length === 0) return;

        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个疑似重复版本移入回收站吗？`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));

            // 同步内存库（按当前视图移除已删项）
            if (appMode.value === 'worldbooks') {
                worldbooks.value = worldbooks.value.filter(w => !trashedPaths.includes(w.path));
                if (activeWorldbook.value && trashedPaths.includes(activeWorldbook.value.path)) {
                    // ⚡ PK-26：走 selectWorldbook（会先载入正文），否则编辑器拿到 data:null 会崩
                    const first = worldbooks.value[0] || null;
                    if (first && typeof selectWorldbook === 'function') await selectWorldbook(first);
                    else activeWorldbook.value = first;
                }
            } else if (appMode.value === 'presets') {
                presets.value = presets.value.filter(p => !trashedPaths.includes(p.path));
                if (activePreset.value && trashedPaths.includes(activePreset.value.path)) {
                    activePreset.value = presets.value[0] || null;
                }
            } else {
                const currentLibItem = library.value.find(item => item.data === cardData.value);
                const currentTrashed = !!(currentLibItem && trashedPaths.includes(currentLibItem.path));
                library.value = library.value.filter(c => !trashedPaths.includes(c.path));
                if (currentTrashed) reset();
                deleteCardOverlays(trashedPaths);
                await cleanupEmptyCategories();
            }

            // 组内全部删净才移除该组；有残留则只剔除已删项
            if (failedPaths.size === 0) {
                contentDuplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.list = group.list.filter(v => !trashedPaths.includes(v.item.path));
            }

            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                if (typeof showToast === 'function') showToast(`已清理 ${res.count} 个，${failedPaths.size} 个失败（可能被占用）`, 'warning', 5000);
                nativeAlert(`已清理 ${res.count} 个；${failedPaths.size} 个失败（可能被占用）：\n${names}`, 'warning');
            } else {
                toastOk(`清理完成！已将 ${res.count} 个疑似重复版本移入回收站。`);
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 🎯 智能查重统一入口：根据当前视图（角色卡 / 世界书 / 预设）自动分发
    // =========================================================
    const startSmartDedupe = () => {
        if (appMode.value === 'worldbooks') return startWorldbookDedupeScan();
        if (appMode.value === 'presets') return startPresetDedupeScan();
        return startDedupeScan();
    };

    return {
        showDedupeModal, duplicateGroups, startDedupeScan, resolveDedupeGroup,
        showWbDedupeModal, wbDuplicateGroups, startWorldbookDedupeScan, resolveWbDedupeGroup,
        showPresetDedupeModal, presetDuplicateGroups, startPresetDedupeScan, resolvePresetDedupeGroup,
        showContentDedupeModal, contentDuplicateGroups, startContentDedupeScan, resolveContentDedupeGroup,
        // 📊🔍 查重/版本对比的扫描进度（供查重弹窗消费；**不回流侧栏**）
        // 🛑 AR-45 二次修复（2026-09-23）：`dedupeScanDone` / `dedupeScanTotal` 必须一起导出 ——
        //    弹窗的**数字**改读它们（与 `dedupeScanPercent` **同源**），
        //    不再走 `wbScanProgress`（那是「扫描」的进度，会在扫描结束时归零 → 数字掉回 0 / ?）。
        dedupeScanning, dedupeScanLabel, dedupeScanPercent, dedupeScanIndeterminate,
        dedupeScanDone, dedupeScanTotal,
        startSmartDedupe,
        showDiffDetailModal, diffMasterItem, diffCompareItem, diffFieldResults, openDiffDetailModal
    };
}