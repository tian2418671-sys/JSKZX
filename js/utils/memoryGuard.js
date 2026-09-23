/**
 * 内存守门员（Memory Guard）—— 把「OOM 崩溃」变成「主动降级」
 * ─────────────────────────────────────────────────────────────
 * 背景（2026-09-13 容量实测，见 `docs/大库重复卡-压测数据记录.md` §12）：
 *   22,372 张卡时渲染进程堆 3.05~3.26GB，而 Chromium 默认老生代上限只有 4.19GB，
 *   余量仅 ~1GB；刷新/索引重建的瞬时峰值一旦顶穿，渲染进程就崩（随后兜底重载，
 *   用户看到的是「界面突然重来一遍」）。
 *
 * 两层防线：
 *   ① `main.js` 已用 `--max-old-space-size=6144` 把上限抬到 6GB、并开 `--expose-gc`；
 *   ② 本模块按阈值**主动降级**：先释放可重算的缓存，再强制 GC；仍高就提示用户，
 *      而不是等它崩。V8 在被抬高上限后 GC 会更「懒」，这层主动回收因此更重要。
 *
 * 设计要点：
 *   · 纯逻辑（阈值判定 / 阶梯动作）与副作用（读 `performance.memory`、调 `gc()`）分离，
 *     便于单测（`test/memoryGuard.test.mjs` 注入假的读数与假的回收函数）。
 *   · 采样点：定时（默认 30s）+ 重活之后（加载完成 / 索引构建完成 / 刷新后），
 *     后者比定时更关键 —— 峰值就出现在这些时刻。
 *   · 全程有日志（`[mem] ...`），可在主进程转发的日志里直接观察。
 */

/** 默认阈值（占上限比例）。warn 档先救缓存，critical 档才打扰用户。 */
export const DEFAULT_THRESHOLDS = { warn: 0.72, critical: 0.88 };

const MB = 1048576;

/**
 * 判定当前水位档位（纯函数，便于单测）
 * @param {{used:number,total:number,limit:number}|null} mem 字节
 * @param {{warn:number,critical:number}} thresholds 比例
 * @returns {{level:'unknown'|'ok'|'warn'|'critical', ratio:number, usedMB:number, limitMB:number}}
 */
export function gradeMemory(mem, thresholds = DEFAULT_THRESHOLDS) {
    if (!mem || !Number.isFinite(mem.used) || !Number.isFinite(mem.limit) || mem.limit <= 0) {
        return { level: 'unknown', ratio: 0, usedMB: 0, limitMB: 0 };
    }
    const ratio = mem.used / mem.limit;
    const level = ratio >= thresholds.critical ? 'critical' : (ratio >= thresholds.warn ? 'warn' : 'ok');
    return { level, ratio, usedMB: Math.round(mem.used / MB), limitMB: Math.round(mem.limit / MB) };
}

/**
 * 创建守门员
 * @param {object} opts
 * @param {() => ({used:number,total:number,limit:number}|null)} opts.readMemory 读当前堆（默认取 performance.memory）
 * @param {() => void} [opts.forceGc] 强制 GC（默认 window.gc，需 --expose-gc）
 * @param {() => void} [opts.releaseCaches] 释放「可重算」的缓存（令牌/缩略图等）
 * @param {(info:object) => void} [opts.onWarn] 进入 warn 档回调（只记日志）
 * @param {(info:object) => void} [opts.onCritical] 进入 critical 档回调（提示用户 + 记录）
 * @param {{warn:number,critical:number}} [opts.thresholds]
 * @param {number} [opts.intervalMs] 定时采样间隔（0 = 不自动定时）
 * @param {number} [opts.cooldownMs] 同档位重复动作的最小间隔（防抖）
 */
// ═══════════════════════════════════════════════════════════════
// 🛡️ 读前预估（§5.3「预检」，2026-09-23 补 —— 此前只有运行时水位检查）
// ───────────────────────────────────────────────────────────────
// 📖 为什么需要：`checkNow` 是**读了之后**才知道爆 —— 遇超大书（如 200MB 合并书）
//    等发现时已经分配完，只剩「崩」或「勉强撑住」两种结局，**没有拒绝的机会**。
//    PK-27 那次 OOM 是**内核直接杀进程**，应用连提示的机会都没有。
// ✅ 预检价值：在**分配之前**用「磁盘 size」估算，超限就**优雅拒绝并说明原因**
//    （符合 PK-26 教训「静默 = 坏了」—— 要能告诉用户为什么没做）。
//
// ⚠️ 三个已知的估算不确定性（评审 §3.7 指出，**必须留余量**）：
//   ① **`usedJSHeapSize` 不含 ArrayBuffer 外部内存** —— `fs.readFile` 的 Buffer 不计入堆，
//      故 `used` 会低估实际占用 ⇒ 按「预估值 vs 余量预算」独立判断，不能只看 `used`；
//   ② **parse 后体积 ≠ 磁盘字节** —— 实测系数 **0.57（P95 0.89）**，但 emoji（非 BMP）会翻倍，
//      故保守取 **2.2**（emoji 占 2 个 code unit 的余量）；
//   ③ **`performance.memory` 只在 Chromium 可用** —— 拿不到时本函数**降级为「只看绝对预算」**，
//      不抛错、不写死依赖。
// ═══════════════════════════════════════════════════════════════

/** 磁盘字节 → parse 后堆占用的保守系数（实测平均 0.57 / P95 0.89；取 2.2 留 emoji 与 JS 对象开销余量） */
export const PARSE_SIZE_FACTOR = 2.2;

/**
 * 估算「读入并 parse 若干文件」后的堆占用（纯函数，便于单测）
 * @param {Array<{size?:number}>|number[]} files 文件列表（对象取 `.size`，数字直接用）
 * @param {number} [factor] 系数，默认 `PARSE_SIZE_FACTOR`
 * @returns {{bytes:number, mb:number, count:number, unknown:number}} `unknown` = 缺 size 的个数
 */
export function estimateParseBytes(files, factor = PARSE_SIZE_FACTOR) {
    const list = Array.isArray(files) ? files : [];
    let sum = 0, unknown = 0;
    for (const f of list) {
        const s = (typeof f === 'number') ? f : (f && Number(f.size));
        if (!Number.isFinite(s) || s <= 0) { unknown++; continue; }
        sum += s;
    }
    const bytes = Math.round(sum * factor);
    return { bytes, mb: Math.round(bytes / MB), count: list.length, unknown };
}

/**
 * 读前预检：是否**允许**读入这批文件（纯函数，便于单测）
 *
 * 判定顺序（任一不过即拒）：
 *   ① **单本超限** → 拒（单个文件就超预算，读了必爆）
 *   ② **总预估超「可用余量 × 比例」** → 拒
 *   ③ `readMemory()` 拿不到（非 Chromium / 未开开关）→ **降级**：改用 `assumedLimitBytes` 的绝对预算
 *
 * ⚠️ 本函数**只做判定，不产生副作用**（不 GC、不释放缓存）—— 由调用方决定怎么处理拒绝。
 *
 * @param {object} opts
 * @param {Array<{size?:number}>|number[]} opts.files 待读文件
 * @param {() => ({used:number,total:number,limit:number}|null)} [opts.readMemory]
 * @param {number} [opts.budgetRatio] 允许占用的「可用余量」比例（默认 0.7，评审 §3.7 建议）
 * @param {number} [opts.maxSingleBytes] 单本上限（默认 50MB，与 `WB_META_MAX_BYTES` 同口径）
 * @param {number} [opts.assumedLimitBytes] 拿不到 `readMemory` 时的假定上限（默认 4192MB）
 * @param {number} [opts.factor]
 * @returns {{ok:boolean, reason:string|null, est:object, availMB:number, budgetMB:number,
 *            degraded:boolean, oversized:Array<{size:number}>}}
 */
export function preflightRead(opts = {}) {
    const files = opts.files || [];
    const est = estimateParseBytes(files, opts.factor);
    const budgetRatio = Number.isFinite(opts.budgetRatio) ? opts.budgetRatio : 0.7;
    const maxSingle = Number.isFinite(opts.maxSingleBytes) ? opts.maxSingleBytes : 50 * MB;

    // ① 单本超限（先把「读了必爆」的挑出来，便于给出可操作清单）
    const oversized = [];
    for (const f of files) {
        const s = (typeof f === 'number') ? f : (f && Number(f.size));
        if (Number.isFinite(s) && s > maxSingle) oversized.push({ size: s });
    }

    const mem = typeof opts.readMemory === 'function' ? opts.readMemory() : null;
    const hasMem = !!(mem && Number.isFinite(mem.used) && Number.isFinite(mem.limit) && mem.limit > 0);
    // 拿不到内存读数 → 降级：用假定上限做绝对预算（不写死依赖 performance.memory）
    const limit = hasMem ? mem.limit : (Number.isFinite(opts.assumedLimitBytes) ? opts.assumedLimitBytes : 4192 * MB);
    const used = hasMem ? mem.used : 0;
    const avail = Math.max(0, limit - used);
    const budget = Math.floor(avail * budgetRatio);

    const base = {
        est, degraded: !hasMem,
        availMB: Math.round(avail / MB), budgetMB: Math.round(budget / MB), oversized
    };
    if (oversized.length > 0) return { ok: false, reason: 'single-too-large', ...base };
    if (est.bytes > budget) return { ok: false, reason: 'batch-too-large', ...base };
    return { ok: true, reason: null, ...base };
}

/**
 * 创建守门员
 * @param {object} opts
 * @param {() => ({used:number,total:number,limit:number}|null)} opts.readMemory 读当前堆（默认取 performance.memory）
 * @param {() => void} [opts.forceGc] 强制 GC（默认 window.gc，需 --expose-gc）
 * @param {() => void} [opts.releaseCaches] 释放「可重算」的缓存（令牌/缩略图等）
 * @param {(info:object) => void} [opts.onWarn] 进入 warn 档回调（只记日志）
 * @param {(info:object) => void} [opts.onCritical] 进入 critical 档回调（提示用户 + 记录）
 * @param {{warn:number,critical:number}} [opts.thresholds]
 * @param {number} [opts.intervalMs] 定时采样间隔（0 = 不自动定时）
 * @param {number} [opts.cooldownMs] 同档位重复动作的最小间隔（防抖）
 */
export function createMemoryGuard(opts = {}) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
    // ⚠️ 实测结论（2026-09-13，22,372 卡）：**Chromium 渲染进程不采纳 `--max-old-space-size`**
    //    —— 用 `js-flags` 与 `webPreferences.additionalArguments` 两条路都试过，
    //    `window.gc` 在（`--expose-gc` 生效），但仍会在堆 ~3.3GB 时 `render-process-gone reason=oom`，
    //    且 `performance.memory.jsHeapSizeLimit` 恒为 4192MB。
    //    ⇒ 所以 4192 就是**真实上限**，按比例判定没问题（之前以为它"固定上报"是错的）。
    //    assumedLimitMB 仅作为逃生口保留（今后若真能抬高上限再用）。
    const assumedLimitMB = Number.isFinite(opts.assumedLimitMB) ? opts.assumedLimitMB : 0;
    const readMemory = opts.readMemory || (() => {
        try {
            const m = (typeof performance !== 'undefined') && performance.memory;
            if (!m) return null;
            const reportedMB = Math.round(m.jsHeapSizeLimit / MB);
            const limitMB = (assumedLimitMB > 0) ? Math.max(assumedLimitMB, reportedMB) : reportedMB;
            return { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: limitMB * MB };
        } catch (e) { return null; }
    });
    const forceGc = opts.forceGc || (() => {
        try { if (typeof window !== 'undefined' && typeof window.gc === 'function') window.gc(); } catch (e) { /* 未开 --expose-gc */ }
    });
    const releaseCaches = opts.releaseCaches || (() => {});
    const onWarn = opts.onWarn || (() => {});
    const onCritical = opts.onCritical || (() => {});
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 30000;
    const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 60000;

    const stats = { samples: 0, warns: 0, criticals: 0, gcCalls: 0, releases: 0, preflights: 0, preflightRejects: 0, last: null, lastLevel: 'unknown' };
    let lastActedAt = { warn: 0, critical: 0 };
    let timer = null;

    /** 采样一次并按档位动作；reason 用于日志区分触发点（timer/load/index/refresh/...） */
    function checkNow(reason = 'manual') {
        const mem = readMemory();
        const g = gradeMemory(mem, thresholds);
        stats.samples++;
        stats.last = { ...g, reason, at: Date.now() };
        if (g.level === 'unknown') return g;
        stats.lastLevel = g.level;

        if (g.level === 'ok') return g;

        const now = Date.now();
        const key = g.level;
        if (now - (lastActedAt[key] || 0) < cooldownMs) return g;   // 冷却中：不重复动作/提示
        lastActedAt[key] = now;

        // —— warn 及以上：先丢掉可重算的缓存，再强制 GC ——
        try { releaseCaches(); stats.releases++; } catch (e) { /* 释放失败不影响主流程 */ }
        try { forceGc(); stats.gcCalls++; } catch (e) { /* 忽略 */ }
        const after = gradeMemory(readMemory(), thresholds);

        if (g.level === 'critical') {
            stats.criticals++;
            onCritical({ ...g, after, reason });
        } else {
            stats.warns++;
            onWarn({ ...g, after, reason });
        }
        return after;
    }

    function start() {
        if (timer || !(intervalMs > 0)) return;
        timer = setInterval(() => checkNow('timer'), intervalMs);
    }
    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    /**
     * 读前预检（复用本守门员的 `readMemory`，保证与实际水位判定**同一数据源**）
     * @param {Array<{size?:number}>|number[]} files
     * @param {{budgetRatio?:number, maxSingleBytes?:number}} [o]
     * @returns {ReturnType<typeof preflightRead>}
     */
    function preflight(files, o) {
        const r = preflightRead({
            files,
            readMemory,
            budgetRatio: (o && o.budgetRatio),
            maxSingleBytes: (o && o.maxSingleBytes)
        });
        stats.preflights++;
        if (!r.ok) stats.preflightRejects++;
        return r;
    }

    return { start, stop, checkNow, preflight, stats, thresholds: { ...thresholds } };
}

export default createMemoryGuard;
