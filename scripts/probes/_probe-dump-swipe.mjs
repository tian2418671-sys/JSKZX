import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const txt = await ev(`(()=>{const m=(${C}).chatMessages.value[0];return (m.swipes&&m.swipes[0])||m.content||'';})()`);
    const out = path.join(os.tmpdir(), 'swipe0.txt');
    fs.writeFileSync(out, typeof txt === 'string' ? txt : JSON.stringify(txt), 'utf8');
    console.log('已导出:', out, '长度:', typeof txt === 'string' ? txt.length : -1);
    ws.close(); process.exit(0);
};
ws.onerror = (e) => { console.log('wserr', e.message); process.exit(1); };
