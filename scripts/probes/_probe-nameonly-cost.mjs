/**
 * 「仅名称相同」判定 —— 性能实测（2026-09-23）
 * 对同名组内所有卡算 simhash 的耗时（不截断 vs 截断 1200 字）。
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-nameonly-cost.mjs
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
const r = await ev(`(() => {
    const ctx = ${CTX};
    const lib = ctx.library.value;
    // 复刻 computeSimhash（step=4）
    const compute = (text) => {
        const v = new Int32Array(64);
        const len = text.length;
        for (let i = 0; i + 4 <= len; i += 4) {
            let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
            for (let k = 0; k < 4; k++) {
                const c = text.charCodeAt(i + k);
                lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
                hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
            }
            for (let b = 0; b < 32; b++) {
                v[b] += ((lo >>> b) & 1) ? 1 : -1;
                v[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
            }
        }
        let oL = 0, oH = 0;
        for (let b = 0; b < 32; b++) { if (v[b] > 0) oL |= (1 << b); if (v[b + 32] > 0) oH |= (1 << b); }
        return [oL >>> 0, oH >>> 0];
    };
    const norm = (t) => String(t || '').replace(/\\s+/g, ' ').replace(/[^\\p{L}\\p{N}]+/gu, ' ').toLowerCase().trim();
    const textOf = (c) => { const d = (c.data && (c.data.data || c.data)) || {}; return norm([d.description, d.personality, d.scenario, d.first_mes, d.mes_example].filter(Boolean).join('\\n')); };
    const byName = new Map();
    for (const c of lib) { const n = (c.name || '').trim(); if (!byName.has(n)) byName.set(n, []); byName.get(n).push(c); }
    const inGroups = [];
    for (const [, list] of byName) if (list.length > 1) inGroups.push(...list);
    const texts = inGroups.map(textOf);
    const totalChars = texts.reduce((s, t) => s + t.length, 0);
    const t0 = performance.now();
    for (const t of texts) compute(t);
    const full = performance.now() - t0;
    const t1 = performance.now();
    for (const t of texts) compute(t.slice(0, 1200));
    const cut = performance.now() - t1;
    return { cardsInNameGroups: inGroups.length, totalChars, avgChars: Math.round(totalChars / Math.max(1, texts.length)), fullMs: Math.round(full), cutMs: Math.round(cut) };
})()`, 900000);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
