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

    const stats = { samples: 0, warns: 0, criticals: 0, gcCalls: 0, releases: 0, last: null, lastLevel: 'unknown' };
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

    return { start, stop, checkNow, stats, thresholds: { ...thresholds } };
}

export default createMemoryGuard;
