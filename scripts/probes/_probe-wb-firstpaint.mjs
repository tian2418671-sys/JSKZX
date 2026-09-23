/**
 * P2-1 回归修复复测 —— **只测首屏**（不等后台续补）（2026-09-23）
 *
 * 为什么单独写：`_probe-wb-load-breakdown.mjs` 的 B 段会**等后台续补完成**
 *   （s5000 要 ~4 分钟），而本项要验的只是「**首屏何时可用**」。
 *
 * 判据：`scanWorldbookDir` 返回后立刻读 DOM（用 `setTimeout(0)`，**不用 rAF** —— 会被节流）。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-wb-firstpaint.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-wb-firstpaint.mjs "<目录>"'); process.exit(1); }

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

console.log('═════ 首屏可用复测（P2-1 回归修复）═════');
console.log(`目录：${DIR}`);
console.log('');

// ── 冷启动：清空列表 + 清掉元数据缓存？──
// ⚠️ 无法从渲染层清主进程缓存；但**清空内存库**已能复现「首屏」路径
//    （首屏瓶颈在「首批 meta 是否被 await」而非缓存本身）
const r = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    ctx.worldbooks.value = [];
    await new Promise(r => setTimeout(r, 500));
    const dom0 = document.querySelectorAll('aside *').length;

    const t0 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    const tScan = performance.now() - t0;

    // ⚠️ setTimeout(0) 而非 rAF（rAF 在窗口不可见时被节流 → 假耗时）
    const t1 = performance.now();
    await new Promise(r => setTimeout(r, 0));
    const tTick = performance.now() - t1;
    const dom1 = document.querySelectorAll('aside *').length;

    return {
        tScan: Math.round(tScan), tTick: Math.round(tTick),
        total: Math.round(tScan + tTick),
        dom0, dom1,
        count: ctx.worldbooks.value.length,
        named: ctx.worldbooks.value.filter(w => w.wbName).length,
        filling: !!ctx.wbMetaFilling.value
    };
})()`, 900000);

console.log(`① 冷启动（清空内存库后打开）`);
console.log(`   scanWorldbookDir 本体：**${fmt(r.tScan)}**`);
console.log(`   等 1 个宏任务：        ${fmt(r.tTick)}`);
console.log(`   ⇒ **首屏可用：${fmt(r.total)}**`);
console.log(`   入库 ${r.count} 本 ｜ 已有书名 ${r.named} ｜ 后台续补中 ${r.filling}`);
console.log(`   DOM 节点：${r.dom0} → ${r.dom1}`);
console.log('');

// ── 热启动 ──
const w = await ev(`(async () => {
    const ctx = ${CTX};
    const t0 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    const tScan = performance.now() - t0;
    await new Promise(r => setTimeout(r, 0));
    return {
        tScan: Math.round(tScan), total: Math.round(performance.now() - t0),
        count: ctx.worldbooks.value.length,
        named: ctx.worldbooks.value.filter(w => w.wbName).length,
        filling: !!ctx.wbMetaFilling.value
    };
})()`, 900000);

console.log(`② 热启动（列表已有数据）`);
console.log(`   scanWorldbookDir 本体：**${fmt(w.tScan)}**`);
console.log(`   ⇒ **首屏可用：${fmt(w.total)}**`);
console.log(`   入库 ${w.count} 本 ｜ 已有书名 ${w.named} ｜ 后台续补中 ${w.filling}`);
console.log('');

console.log('───── 断言 ─────');
const checks = [
    ['① 冷启动首屏 < 3s（修复前 s5000 为 5.51s）', r.total < 3000, fmt(r.total)],
    ['① 列表已渲染（DOM 有节点）', r.dom1 > r.dom0, `${r.dom0} → ${r.dom1}`],
    ['① 入库数正确', r.count > 1000, `${r.count}`],
    ['① 后台续补已启动（P2-1 生效）', r.filling === true, `${r.filling}`],
    ['② 热启动首屏 < 2s', w.total < 2000, fmt(w.total)]
];
let pass = 0;
for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}  → ${detail}`);
    if (ok) pass++;
}
console.log('');
console.log(`═════ 结果：${pass}/${checks.length} 通过 ═════`);
process.exit(pass === checks.length ? 0 : 1);
