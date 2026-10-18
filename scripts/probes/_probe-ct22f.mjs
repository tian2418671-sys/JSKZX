const BASE = 'http://127.0.0.1:9380';
const list = await (await fetch(`${BASE}/json/list`)).json();
const iframeTarget = list.find(t => t.type === 'iframe');
if (!iframeTarget) { console.log('没有 iframe target'); process.exit(0); }

const ws = new WebSocket(iframeTarget.webSocketDebuggerUrl);
let id = 0;
const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
};
await new Promise(res => { ws.onopen = res; });
await send('Runtime.enable');

console.log('URL:', iframeTarget.url);
console.log('body 长度:', await ev('document.body ? document.body.innerHTML.length : -1'));
console.log('body 开头:', await ev('(document.body?document.body.innerHTML:"").slice(0,500)'));
console.log('有 Vue:', await ev('typeof Vue'));
console.log('有 jQuery:', await ev('typeof jQuery'));
console.log('#app 有内容:', await ev('(()=>{const a=document.getElementById("app");return a? a.innerHTML.length : -1})()'));
console.log('#app innerHTML 开头:', await ev('(()=>{const a=document.getElementById("app");return a? a.innerHTML.slice(0,400) : ""})()'));
console.log('scrollHeight:', await ev('document.documentElement.scrollHeight'));
console.log('title:', await ev('document.title'));
ws.close();
process.exit(0);
