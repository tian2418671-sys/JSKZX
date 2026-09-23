/**
 * S2' 验证：L1 摘要是否真的到达渲染层 + 同名查重是否真的不读正文
 * 用法：node scripts/probes/_probe-l1-render.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-l1-render.mjs <目录>'); process.exit(1); }

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

console.log('═════ S2\' 验证：L1 摘要到达渲染层？ ═════');

// 1. 扫描（走 fastListOnly + wb:meta，与真实路径一致）
const scan = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 3000));
    const list = ctx.worldbooks.value;
    const withIdx = list.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length);
    return {
        total: list.length,
        withKeyHashes: withIdx.length,
        sample: withIdx.slice(0, 3).map(w => ({
            name: w.wbName || w.name,
            keyCount: w.keyCount,
            hashLen: w.keyHashes.length,
            hashType: Object.prototype.toString.call(w.keyHashes),
            first3: w.keyHashes.slice(0, 3),
            sorted: w.keyHashes.every((v, i, a) => i === 0 || a[i-1] <= v),
            exact: w.exactContentHash ? w.exactContentHash.slice(0, 12) : null
        }))
    };
})()`, 1800000);
console.log(JSON.stringify(scan, null, 2));

// 2. 同名查重：计时 + 是否读正文
const t0 = Date.now();
const dedupe = await ev(`(async () => {
    const ctx = ${CTX};
    const loadedHeavy = () => ctx.worldbooks.value.filter(w => w.heavy && w.dataLoaded === true).length;
    const before = loadedHeavy();
    let peak = before;
    const timer = setInterval(() => { const h = loadedHeavy(); if (h > peak) peak = h; }, 20);
    const t0 = performance.now();
    try {
        await ctx.startWorldbookDedupeScan();
        await new Promise(r => setTimeout(r, 500));
    } finally { clearInterval(timer); }
    const g = ctx.wbDuplicateGroups.value;
    return {
        ms: Math.round(performance.now() - t0),
        groups: g.length,
        before, peak, after: loadedHeavy(),
        firstGroup: (g[0] && g[0].list || []).slice(0, 3).map(w => ({
            name: w.wbName || w.name, entryCount: w._entryCount, jaccard: w._jaccard, diff: w._diffInfo
        }))
    };
})()`, 1800000);
console.log('\n--- 同名查重 ---');
console.log(JSON.stringify(dedupe, null, 2));
console.log(`\n探针外部计时：${((Date.now() - t0) / 1000).toFixed(1)}s`);
