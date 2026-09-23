/**
 * 同名查重「假阳性」取证（2026-09-23）
 * 统计真实库中按「卡内 name」聚出的组里，有多少是**同名但内容完全无关**。
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-card-name-falsepos.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
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
    const inst = (app && app._container && app._container._vnode && app._container._vnode.component) || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const r = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'characters';
    await new Promise(r => setTimeout(r, 300));
    await ctx.startDedupeScan();
    await new Promise(r => setTimeout(r, 1200));
    const gs = ctx.duplicateGroups.value || [];
    // 卡内 name 是否等于文件名（占位名/默认名的强信号）
    const shingles = (t) => { const s = new Set(); const n = String(t || '').replace(/\\s+/g, ' ').trim(); for (let i = 0; i + 4 <= n.length; i++) s.add(n.slice(i, i + 4)); return s; };
    const jac = (a, b) => { if (!a.size || !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); };
    const rows = gs.map(g => {
        const master = g.cards[0];
        const sims = g.cards.slice(1).map(c => jac(shingles(master._desc), shingles(c._desc)));
        const maxSim = sims.length ? Math.max(...sims) : 1;
        const nameIsGeneric = /^\\d+$/.test(String(g.name || '').trim()) || String(g.name || '').trim().length <= 2;
        return { name: g.name, n: g.cards.length, maxSim, nameIsGeneric };
    });
    const buckets = { '0-20%': 0, '20-50%': 0, '50-80%': 0, '80-100%': 0 };
    for (const r of rows) {
        const k = r.maxSim < 0.2 ? '0-20%' : r.maxSim < 0.5 ? '20-50%' : r.maxSim < 0.8 ? '50-80%' : '80-100%';
        buckets[k]++;
    }
    const suspicious = rows.filter(r => r.maxSim < 0.2).sort((a, b) => b.n - a.n);
    return {
        groups: rows.length,
        buckets,
        genericNameGroups: rows.filter(r => r.nameIsGeneric).length,
        suspiciousCount: suspicious.length,
        topSuspicious: suspicious.slice(0, 12)
    };
})()`, 900000);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
