/**
 * 库状态速查（探针辅助）
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-lib-state.mjs
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
const ev = async (expr, t = 600000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app && app._container && app._container._vnode && app._container._vnode.component) || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const st = await ev(`(() => {
    const c = ${CTX};
    if (!c) return { err: 'no ctx' };
    return {
        mode: c.appMode.value,
        cards: c.library.value.length,
        presets: c.presets.value.length,
        wb: c.worldbooks.value.length,
        dir: c.currentFolderPath.value
    };
})()`);
console.log(JSON.stringify(st, null, 2));
process.exit(0);
