/**
 * CDP 内存/索引采样（容量压测配套；dev 模式）
 *
 * 用法：
 *   node scripts/tools/_cdp-mem.mjs                     # 采一次：堆占用 + 索引统计
 *   node scripts/tools/_cdp-mem.mjs --refresh           # 先触发一次刷新（大库最容易顶穿的操作）再采样
 *   node scripts/tools/_cdp-mem.mjs --port 9338 --json  # 指定端口 / 输出原始 JSON
 *
 * 说明：
 *   · 依赖 dev 模式的 `window.__jskDiag`（含 `mem` 守门员、`idx` 索引、`refresh()`）；
 *   · 采样前会尝试强制 GC（CDP `HeapProfiler.collectGarbage`），避免读到 GC 前的虚高数字；
 *   · 全程只读，不会改动用户数据（`--refresh` 会触发一次真实刷新，这是压测的意图）。
 */
import { spawnSync } from 'node:child_process';

const PORT = process.env.CDP_PORT || '9338';
const argv = process.argv.slice(2);
const DO_REFRESH = argv.includes('--refresh');
const RAW = argv.includes('--json');
// ⚠️ 强制 GC 只在**明确要求**时做（--gc）。曾写成每次采样都 GC：大库加载期间每 8s
//    被强行 full GC 一次，22k 卡首启从 ~117s 拖到 >215s 仍没完，测量也跟着失真。
const DO_GC = argv.includes('--gc');
const INDEX = argv.indexOf('--port');
const port = INDEX >= 0 && argv[INDEX + 1] ? argv[INDEX + 1] : PORT;

const SAMPLE = `(() => {
    const d = window.__jskDiag || {};
    const m = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
    return JSON.stringify({
        cards: d.lib ? (d.lib() ? d.lib().length : null) : null,
        heapUsedMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null,
        heapTotalMB: m ? Math.round(m.totalJSHeapSize / 1048576) : null,
        heapLimitMB: m ? Math.round(m.jsHeapSizeLimit / 1048576) : null,
        idx: d.idx ? d.idx.stats() : null,
        mem: d.mem ? d.mem.stats : null,
        memThresholds: d.mem ? d.mem.thresholds : null,
        // NOTE: performance.memory.jsHeapSizeLimit is reported as ~4GB by Chromium no matter
        // what --max-old-space-size says, so it is NOT a valid check. The presence of window.gc
        // proves --js-flags reached the renderer (both come from the same switch). Backticks are
        // forbidden here: this whole block is a JS template literal.
        gcAvailable: (typeof window.gc === 'function')
    });
})()`;

const REFRESH = `(async () => {
    const d = window.__jskDiag;
    if (!d || typeof d.refresh !== 'function') return JSON.stringify({ error: 'no-refresh-handle' });
    const t0 = Date.now();
    try { await d.refresh(); } catch (e) { /* 刷新期间页面可能重载 */ }
    // 等库稳定（最多 200s）：刷新后 library 会先清空再填充
    while (Date.now() - t0 < 200000) {
        const n = d.lib ? (d.lib() ? d.lib().length : 0) : 0;
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 4000));
    return JSON.stringify({ refreshMs: Date.now() - t0 });
})()`;

function evalCdp(expr, gc = false) {
    const r = spawnSync('node', ['scripts/tools/_cdp-eval.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, CDP_PORT: port, EXPR: expr, GC: gc ? '1' : '0' },
        encoding: 'utf-8'
    });
    return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

/** 取 CDP 返回值并**解开双重编码**
 *  `_cdp-eval.mjs` 会 `JSON.stringify(结果)`，而我们的 EXPR 本身返回 JSON 字符串
 *  → stdout 是 `"{\\\"cards\\\":0,...}"`。只 parse 一次得到的是**字符串**而不是对象，
 *   `o.cards` 永远是 undefined —— 之前三个小时的「not ready」全是这个误报。
 */
function unwrap(stdout) {
    if (!stdout) return null;
    let v;
    try { v = JSON.parse(stdout); } catch (e) { return null; }
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e) { return null; }
    }
    return (v && typeof v === 'object') ? v : null;
}

let refreshInfo = null;
if (DO_REFRESH) {
    const before = evalCdp(SAMPLE);
    const r = evalCdp(REFRESH);
    refreshInfo = { ok: r.status === 0 && !!r.out, raw: (r.out || '').slice(0, 200), before: before.out };
}

const s = evalCdp(SAMPLE, DO_GC);
if (!s.out) {
    // ⚠️ 采样失败**不能**走 stderr / 非零退出：调用方 capacity-check.ps1 在轮询页面就绪时
    //   必然碰到“还没加载完”，而 PowerShell 5.1 在 $ErrorActionPreference='Stop' 下会把
    //   原生子进程的 stderr 当成 NativeCommandError 直接中断整个脚本（曾因此空跑一大轮）。
    //   统一改成 stdout 输出 JSON + 退出码 0，由调用方看 ok 字段决定重试。
    console.log(JSON.stringify({
        ok: false,
        error: 'cdp-sample-failed',
        port: port,
        stderr: (s.err || '').slice(0, 300),
        refresh: refreshInfo
    }));
    process.exit(0);
}
let parsed = unwrap(s.out);
if (!parsed) {
    console.log(JSON.stringify({
        ok: false,
        error: 'cdp-unparseable',
        port: port,
        stdout: (s.out || '').slice(0, 200),
        refresh: refreshInfo
    }));
    process.exit(0);
}
const result = { ok: true, ...(refreshInfo ? { ...parsed, refresh: refreshInfo } : parsed) };
console.log(RAW ? JSON.stringify(result) : JSON.stringify(result, null, 2));
