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
await new Promise(res => { ws.onopen = res; });
await send('Runtime.enable');

// 父层 iframe
console.log('=== 父层 iframe ===');
console.log(await ev(`(()=>{
  const f=document.querySelector('iframe');
  return JSON.stringify({h:f.offsetHeight, w:f.offsetWidth, style:f.getAttribute('style'),
    wrapper: f.parentElement ? f.parentElement.className : null,
    wrapH: f.parentElement ? f.parentElement.offsetHeight : null});
})()`));

// iframe 内部滚动高度
const t = list.find(x => x.type === 'iframe');
if (t) {
    const ws2 = new WebSocket(t.webSocketDebuggerUrl);
    let id2 = 0; const P2 = new Map();
    const send2 = (m, p) => new Promise((r, j) => { const i = ++id2; P2.set(i, { r, j }); ws2.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
    ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P2.has(m.id)) { const p = P2.get(m.id); P2.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
    await new Promise(res => { ws2.onopen = res; });
    await send2('Runtime.enable');
    const ev2 = async (x) => { const r = await send2('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result.value; };
    console.log('\n=== iframe 内部 ===');
    console.log('body.scrollHeight:', await ev2('document.body.scrollHeight'));
    console.log('docEl.scrollHeight:', await ev2('document.documentElement.scrollHeight'));
    console.log('window.innerHeight:', await ev2('window.innerHeight'));
    console.log('.opening-card offsetHeight:', await ev2('(()=>{const e=document.querySelector(".opening-card");return e?e.offsetHeight:-1})()'));
    console.log('是否渲染 ### :', await ev2('document.body.innerText.includes("### 一")'));
    console.log('h3 数量:', await ev2('document.querySelectorAll("h3").length'));
    ws2.close();
}
ws.close();
process.exit(0);
