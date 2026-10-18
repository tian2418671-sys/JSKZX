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

console.log('1) 切到独立前端角色卡模式…');
console.log('   appMode 切换:', await ev(`(()=>{ try { (${C}).appMode.value='heavycards'; return 'ok:'+(${C}).appMode.value; } catch(e){ return 'err:'+e.message } })()`));
await sleep(2500);

console.log('\n2) 侧栏入口按钮 title:');
console.log('  ', await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>/独立前端角色卡|重型卡/.test(x.getAttribute('title')||''));return JSON.stringify(b.map(x=>x.getAttribute('title')));})()`));

console.log('\n3) 面板头部标签:');
console.log('  ', await ev(`(()=>{const t=document.body.innerText;return JSON.stringify({has旧名:/重型卡/.test(t), has新名:/独立前端角色卡/.test(t)});})()`));

console.log('\n4) 页面上所有可见的「重型卡」文本:');
console.log('  ', await ev(`(()=>{const hits=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const s=(n.textContent||'').trim();if(/重型卡/.test(s))hits.push(s.slice(0,80));}return JSON.stringify(hits.slice(0,10));})()`));

console.log('\n5) 空态/按钮文案:');
console.log('  ', await ev(`(()=>{const t=document.body.innerText;const i=t.indexOf('独立前端角色卡');return i>=0?JSON.stringify(t.slice(Math.max(0,i-60),i+120)):'未找到';})()`));
ws.close(); process.exit(0);
