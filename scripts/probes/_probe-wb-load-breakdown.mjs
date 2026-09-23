/**
 * 世界书库加载 —— **分段耗时定位**（2026-09-23）
 *
 * 背景：端到端实测发现「冷启动首屏 5.34s」，但直调 IPC 只要 196ms + 1ms。
 *   差距必须查清 —— 到底是「真实入口有额外开销」还是「探针口径问题」。
 *
 * 本脚本用**同一实例、连续多次**测 `scanWorldbookDir`，并细分内部阶段。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-wb-load-breakdown.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-wb-load-breakdown.mjs "<目录>"'); process.exit(1); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
const ev = async (expr, t = 900000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};

const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const DIR_LIT = JSON.stringify(DIR);
const fmt = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

console.log('═════ 世界书库加载 · 分段耗时定位 ═════');
console.log(`目录：${DIR}`);
console.log('');

// ── A. 直调 IPC（不触发 UI）──
const A = await ev(`(async () => {
    const API = window.electronAPI;
    const t0 = performance.now();
    const f = await API.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    const p1 = performance.now() - t0;
    const d = (f && f.data) || [];
    const pending = d.filter(w => w.metaPending).map(w => w.path);
    let firstMs = 0, firstCount = 0;
    if (pending.length) {
        const t1 = performance.now();
        const m = await API.fetchWorldbookMeta(pending.slice(0, 120));
        firstMs = performance.now() - t1;
        firstCount = ((m && m.data) || []).length;
    }
    return { p1: Math.round(p1), firstMs: Math.round(firstMs), count: d.length, pending: pending.length, firstCount };
})()`);
console.log('A. 直调 IPC（**不含 UI 渲染**）');
console.log(`   ① scanWorldbooks(fastListOnly)：**${fmt(A.p1)}**，列出 ${A.count} 本（待补 ${A.pending}）`);
console.log(`   ② fetchWorldbookMeta(前 120)：**${fmt(A.firstMs)}**，返回 ${A.firstCount} 条`);
console.log('');

// ── B. 真实入口（含 UI）—— 连测 3 次 ──
console.log('B. 真实入口 `scanWorldbookDir`（含 Vue 渲染 + 侧栏更新）');
for (let i = 1; i <= 3; i++) {
    const B = await ev(`(async () => {
        const ctx = ${CTX};
        ctx.appMode.value = 'worldbooks';
        const t0 = performance.now();
        await ctx.scanWorldbookDir(${DIR_LIT});
        const t1 = performance.now();
        // 等渲染帧
        await new Promise(r => requestAnimationFrame(() => r()));
        const t2 = performance.now();
        return {
            scanMs: Math.round(t1 - t0), renderMs: Math.round(t2 - t0),
            count: ctx.worldbooks.value.length,
            named: ctx.worldbooks.value.filter(w => w.wbName).length,
            pending: ctx.worldbooks.value.filter(w => w.metaPending).length,
            filling: !!ctx.wbMetaFilling.value
        };
    })()`);
    console.log(`   第 ${i} 次：scanWorldbookDir **${fmt(B.scanMs)}** ｜ 含渲染 **${fmt(B.renderMs)}** ｜ `
        + `${B.count} 本（书名 ${B.named} / 待补 ${B.pending}）｜ 后台续补中 ${B.filling}`);
}
console.log('');

// ── C. 空列表冷启动（模拟「刚启动应用」）──
console.log('C. 清空内存库后冷启动（模拟刚启动应用）');
const C = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.worldbooks.value = [];
    await new Promise(r => setTimeout(r, 500));
    const t0 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    const t1 = performance.now();
    await new Promise(r => requestAnimationFrame(() => r()));
    const t2 = performance.now();
    return {
        scanMs: Math.round(t1 - t0), renderMs: Math.round(t2 - t0),
        count: ctx.worldbooks.value.length,
        named: ctx.worldbooks.value.filter(w => w.wbName).length,
        pending: ctx.worldbooks.value.filter(w => w.metaPending).length
    };
})()`);
console.log(`   scanWorldbookDir **${fmt(C.scanMs)}** ｜ 含渲染 **${fmt(C.renderMs)}** ｜ `
    + `${C.count} 本（书名 ${C.named} / 待补 ${C.pending}）`);
console.log('');

console.log('───── 结论 ─────');
console.log(`直调 IPC 阶段 1：${fmt(A.p1)} ｜ 真实入口（热）：见上 B ｜ 冷启动：${fmt(C.renderMs)}`);
console.log(`⇒ 若 B 远大于 A，说明**UI 渲染**是大头；若 C 远大于 B，说明**清空列表后的重建**是大头`);
