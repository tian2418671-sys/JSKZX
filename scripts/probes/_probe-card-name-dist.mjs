/**
 * 角色卡 name 字段分布统计（2026-09-23）
 * 用于取证「同名查重把无关卡片聚成一组」的真因。
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-card-name-dist.mjs
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
    const nameCount = new Map();
    const fileBaseCount = new Map();
    let nameEqFileBase = 0;
    const placeholder = /^(\\d+|未命名|无|untitled|new|test|\\.|-)$/i;
    let placeholderCount = 0;
    for (const c of lib) {
        const nm = (c.name || '').trim();
        nameCount.set(nm, (nameCount.get(nm) || 0) + 1);
        const base = ((c.path || '').split(/[\\\\/]/).pop() || '').replace(/\\.(png|webp|json)$/i, '');
        fileBaseCount.set(base, (fileBaseCount.get(base) || 0) + 1);
        if (nm === base) nameEqFileBase++;
        if (placeholder.test(nm)) placeholderCount++;
    }
    const topName = [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const topFile = [...fileBaseCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    return {
        total: lib.length,
        uniqueNames: nameCount.size,
        uniqueFileBases: fileBaseCount.size,
        nameEqFileBase,
        placeholderCount,
        dupNameGroups: [...nameCount.values()].filter(v => v > 1).length,
        dupFileGroups: [...fileBaseCount.values()].filter(v => v > 1).length,
        cardsInDupNameGroups: [...nameCount.values()].filter(v => v > 1).reduce((s, v) => s + v, 0),
        cardsInDupFileGroups: [...fileBaseCount.values()].filter(v => v > 1).reduce((s, v) => s + v, 0),
        topName, topFile
    };
})()`, 900000);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
