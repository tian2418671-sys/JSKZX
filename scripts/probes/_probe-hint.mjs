const BASE = 'http://127.0.0.1:9380';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${BASE}/json/list`)).json();
const main = list.find((t) => t.type === 'page');
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0; const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
};
const C = `(()=>{const v=document.querySelector('#app').__vue_app__;return v._container._vnode.component.provides.appCtx})()`;
await sleep(3000);
await ev(`(()=>{ (${C}).appMode.value='heavycards'; })()`);
await sleep(2000);

console.log('=== 侧栏说明文字 ===');
console.log(await ev(`(()=>{
  const t = document.body.innerText;
  const i = t.indexOf('HTML');
  return i>=0 ? JSON.stringify(t.slice(Math.max(0,i-120), i+140)) : '未找到';
})()`));

console.log('\n=== 添加按钮 title ===');
console.log(await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/添加/.test(x.textContent||'')&&/独立前端/.test(x.getAttribute('title')||''));return b?b.getAttribute('title'):'nf';})()`));

console.log('\n=== 工作区空态 ===');
console.log(await ev(`(()=>{const t=document.body.innerText;const i=t.indexOf('请在左侧选择');return i>=0?JSON.stringify(t.slice(i,i+180)):'未找到(可能已选卡)';})()`));

console.log('\n=== 页面是否含 exe/apk 说明 ===');
console.log(await ev(`JSON.stringify({exe:/exe/.test(document.body.innerText), apk:/apk/.test(document.body.innerText), html:/HTML 网页链接/.test(document.body.innerText)})`));
ws.close(); process.exit(0);
