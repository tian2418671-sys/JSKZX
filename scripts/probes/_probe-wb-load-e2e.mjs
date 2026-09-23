/**
 * 世界书库**加载速度**端到端实测（2026-09-23）
 *
 * ⚠️ 定位澄清：本脚本测的是**浏览库（点「打开世界书目录」）**，**不是查重**。
 *   两者都会触发扫描，但查重还多一层「比对」；用户感知的「打开库要多久」= 本脚本。
 *
 * 与 `_probe-load-speed.mjs` 的区别：
 *   · 那个只直调 IPC（`scanWorldbooks`），**不含 UI 渲染**；
 *   · 本脚本走**真实入口** `ctx.scanWorldbookDir(dir)`，并采样「列表何时可用」，
 *     即用户真正感知的耗时（含 Vue 渲染 + 侧栏更新）。
 *
 * 测什么（P2-1 之后口径有变，必须分段测）：
 *   ① **首屏可用**：`scanWorldbookDir` 返回到「列表已渲染」——用户感知的核心指标
 *   ② 阶段 1（readdir + stat，零读盘）
 *   ③ **首批元数据**（P2-1：前 120 本 → 书名立即可见）
 *   ④ 全量元数据（后台续补，不阻塞用户）
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-wb-load-e2e.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-wb-load-e2e.mjs "<目录>"'); process.exit(1); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
if (!pg) { console.error('未找到 page target'); process.exit(1); }
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text || '');
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable'); await send('Log.enable');
const ev = async (expr, t = 1800000) => {
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
const heapMB = `Math.round(((performance.memory||{}).usedJSHeapSize||0)/1048576)`;

console.log('═════ 世界书库加载速度（端到端 · 浏览库）═════');
console.log(`目录：${DIR}`);
console.log('');

// ── 冷启动（清掉内存库，模拟首次打开）──
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    ctx.worldbooks.value = [];
    await new Promise(r => setTimeout(r, 300));
    return true;
})()`);

const h0 = await ev(`(${heapMB})`);
console.log(`起始堆：${h0}MB`);
console.log('');

// ══════ ① 真实入口：首屏可用 ══════
// ⚠️ 用 `scanWorldbookDir`（真实入口），它内部 = 阶段 1 + 首批元数据 + 后台续补
//    本步骤**只 await 到「列表已渲染」**，不等后台续补（那才是用户感知）
const r1 = await ev(`(async () => {
    const ctx = ${CTX};
    const t0 = performance.now();
    // 真实入口（内部会 await 阶段 1 + 首批元数据；后台续补不 await）
    await ctx.scanWorldbookDir(${DIR_LIT});
    const afterScan = performance.now() - t0;
    // 等一帧，确保列表已渲染
    await new Promise(r => requestAnimationFrame(() => r()));
    const tRendered = performance.now() - t0;
    const list = ctx.worldbooks.value;
    const aside = document.querySelector('aside');
    return {
        afterScanMs: Math.round(afterScan),
        renderedMs: Math.round(tRendered),
        count: list.length,
        named: list.filter(w => w.wbName).length,
        withKeys: list.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length).length,
        metaPending: list.filter(w => w.metaPending).length,
        asideAlive: document.querySelectorAll('aside').length,
        asideChars: aside ? aside.innerHTML.length : 0,
        metaFilling: !!ctx.wbMetaFilling.value
    };
})()`, 1800000);

console.log('① 真实入口 `scanWorldbookDir`（用户点「打开世界书目录」）');
console.log(`   IPC 返回耗时：**${fmt(r1.afterScanMs)}**`);
console.log(`   列表已渲染：  **${fmt(r1.renderedMs)}** ← 用户感知的「首屏可用」`);
console.log(`   入库 ${r1.count} 本 ｜ 已有书名 ${r1.named} ｜ 已有 L1 索引 ${r1.withKeys} ｜ 待补 ${r1.metaPending}`);
console.log(`   侧栏存活：${r1.asideAlive} 个（${r1.asideChars} 字符）｜ 后台续补中：${r1.metaFilling}`);
console.log('');

const h1 = await ev(`(${heapMB})`);
console.log(`首屏后堆：${h1}MB（+${h1 - h0}MB）`);
console.log('');

// ══════ ② 等后台续补完成 ══════
const t2 = Date.now();
let filled = r1.named;
let waited = 0;
while (waited < 600000) {
    const s = await ev(`(() => {
        const ctx = ${CTX};
        const l = ctx.worldbooks.value;
        return { named: l.filter(w => w.wbName).length, filling: !!ctx.wbMetaFilling.value, count: l.length };
    })()`);
    filled = s.named;
    if (!s.filling && s.named >= s.count * 0.99) break;
    await new Promise(r => setTimeout(r, 1000));
    waited = Date.now() - t2;
}
const bgMs = Date.now() - t2;
console.log('② 后台续补完成（**不阻塞用户**，仅影响「书名何时全部可见」）');
console.log(`   续补耗时：**${fmt(bgMs)}** ｜ 最终书名 ${filled}/${r1.count}`);
console.log('');

const h2 = await ev(`(${heapMB})`);
console.log(`全量后堆：${h2}MB（+${h2 - h0}MB）`);
console.log('');

// ══════ ③ 热加载（第二次打开，缓存全命中）══════
const r3 = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.worldbooks.value = [];
    await new Promise(r => setTimeout(r, 300));
    const t0 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    await new Promise(r => requestAnimationFrame(() => r()));
    const ms = performance.now() - t0;
    const list = ctx.worldbooks.value;
    return {
        ms: Math.round(ms), count: list.length,
        named: list.filter(w => w.wbName).length,
        withKeys: list.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length).length,
        metaPending: list.filter(w => w.metaPending).length
    };
})()`, 1800000);

console.log('③ 热加载（第二次打开，元数据缓存全命中）');
console.log(`   首屏可用：**${fmt(r3.ms)}** ｜ ${r3.count} 本 ｜ 书名 ${r3.named} ｜ L1 索引 ${r3.withKeys} ｜ 待补 ${r3.metaPending}`);
console.log('');

// ══════ 汇总 ══════
console.log('───── 汇总 ─────');
console.log(`① 冷启动首屏：**${fmt(r1.renderedMs)}**（其中 IPC ${fmt(r1.afterScanMs)}）`);
console.log(`② 后台续补：  **${fmt(bgMs)}**（不阻塞，仅决定「书名全部可见」的时刻）`);
console.log(`③ 热加载首屏：**${fmt(r3.ms)}**`);
console.log(`内存：${h0} → ${h1} → ${h2}MB`);
console.log('');

// ══════ 断言 ══════
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|out of memory|before initialization/i.test(t));
const checks = [
    ['① 冷启动首屏可用 < 3s', r1.renderedMs < 3000, fmt(r1.renderedMs)],
    ['① 首批书名已可见（P2-1 生效）', r1.named > 0, `${r1.named}/${r1.count}`],
    ['① 侧栏存活（AR-40 未复发）', r1.asideAlive > 0 && r1.asideChars > 500, `${r1.asideAlive} 个 / ${r1.asideChars} 字符`],
    ['② 后台续补完成（书名全覆盖）', filled >= r1.count * 0.99, `${filled}/${r1.count}`],
    ['③ 热加载 < 2s', r3.ms < 2000, fmt(r3.ms)],
    ['③ 热加载零待补（缓存全命中）', r3.metaPending === 0, `待补 ${r3.metaPending}`],
    ['内存未失控（< 1.5GB）', h2 < 1536, `${h2}MB`],
    ['无渲染期错误', bad.length === 0, bad.slice(0, 2).join(' | ') || '无']
];
let pass = 0;
console.log('───── 断言 ─────');
for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}  → ${detail}`);
    if (ok) pass++;
}
console.log('');
console.log(`═════ 结果：${pass}/${checks.length} 通过 ═════`);
process.exit(pass === checks.length ? 0 : 1);
