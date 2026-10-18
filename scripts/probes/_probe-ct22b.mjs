const BASE = 'http://127.0.0.1:9380';
const list = await (await fetch(`${BASE}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
await new Promise(res => { ws.onopen = res; });
await send('Runtime.enable');

const C = `window.__jskDiag ? window.__jskDiag.ctx : (()=>{const v=document.querySelector('#app').__vue_app__;return v._container._vnode.component.provides.appCtx})()`;

console.log('有 __jskDiag:', await ev('!!window.__jskDiag'));
console.log('cardData 条目数:', await ev(`(${C}).cardData.value?.length ?? 'n/a'`));

const idx = await ev(`(()=>{const d=(${C}).cardData.value||[];const names=d.map(x=>(x.name||(x.card&&x.card.name)||''));
return JSON.stringify({total:d.length, hit:names.findIndex(n=>/揽仙录/.test(n)), sample:names.slice(0,5)});})()`);
console.log('卡列表:', idx);

// 找聊天相关键
const chatKeys = await ev(`JSON.stringify(Object.keys(${C}).filter(k=>/chat|message|view|activeView/i.test(k)))`);
console.log('聊天相关键:', chatKeys);

ws.close();
process.exit(0);
