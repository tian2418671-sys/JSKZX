const WS = process.argv[2];
const ws = new WebSocket(WS);
let id = 0;
const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result.value; };
ws.onopen = async () => {
    await send('Runtime.enable');
    const C = `(()=>{const v=document.querySelector('#app').__vue_app__;return v._container._vnode.component.provides.appCtx})()`;
    console.log('=== chatMessages 完整结构 ===');
    console.log(JSON.stringify(await ev(`JSON.parse(JSON.stringify((${C}).chatMessages.value))`), null, 1));
    console.log('=== chatSessions 完整结构 ===');
    console.log(JSON.stringify(await ev(`JSON.parse(JSON.stringify((${C}).chatSessions.value))`), null, 1));
    ws.close(); process.exit(0);
};
ws.onerror = (e) => { console.log('wserr', e.message); process.exit(1); };
