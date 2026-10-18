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
const C = `(()=>{const v=document.querySelector('#app').__vue_app__;return v._container._vnode.component.provides.appCtx})()`;

// 等卡片库加载
for (let i = 0; i < 30; i++) {
    const n = await ev(`(${C}).cardData.value?.length ?? -1`);
    if (typeof n === 'number' && n > 0) { console.log('卡片加载完成:', n); break; }
    await sleep(1000);
}

const st = await ev(`(()=>{const c=${C};return JSON.stringify({
  cards: c.cardData.value?.length,
  view: c.activeView?.value ?? c.currentView?.value ?? 'n/a',
  viewKeys: Object.keys(c).filter(k=>/^active/i.test(k))
});})()`);
console.log('状态:', st);

// 用 UI 点击进入：先看当前视图容器
const domInfo = await ev(`(()=>{
  const txt = document.body.innerText;
  const btns = [...document.querySelectorAll('button,a,li,div')].filter(e=>e.children.length===0 && /揽仙录/.test(e.textContent||''));
  return JSON.stringify({hasLanxian: /揽仙录/.test(txt), matchCount: btns.length, first: btns[0] ? btns[0].outerHTML.slice(0,180) : null});
})()`);
console.log('DOM:', domInfo);
ws.close();
process.exit(0);
