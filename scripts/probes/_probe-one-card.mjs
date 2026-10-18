const BASE = 'http://127.0.0.1:9380';
const NAME = process.argv[2] || '巡夜绯屋';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list0 = await (await fetch(`${BASE}/json/list`)).json();
const main = list0.find((t) => t.type === 'page');
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

// 通过 library 找到并选中
console.log('选中卡:', await ev(`(()=>{
  const lib=(${C}).library.value||[];
  const hit=lib.filter(x=>String(x.name||'').includes(${JSON.stringify(NAME)}))[0];
  if(!hit) return 'nf:'+lib.slice(0,5).map(x=>x.name).join('|');
  if(typeof (${C}).handleCardClick==='function'){((${C}).handleCardClick)(hit);return 'clicked:'+hit.name;}
  return 'hit:'+hit.name;
})()`));
await sleep(3000);
await ev(`(()=>{ if(typeof (${C}).openChatTab==='function') (${C}).openChatTab(); })()`);
await sleep(4500);

console.log('消息:', await ev(`(()=>{const m=(${C}).chatMessages.value||[];return JSON.stringify(m.map(x=>({role:x.role,clen:(x.content||'').length,sw:(x.swipes||[]).map(s=>s.length)})));})()`));
console.log('段:', await ev(`(()=>{const s=[...document.querySelectorAll('.seg-text,.seg-html')];return JSON.stringify(s.map(e=>({cls:e.className,len:(e.textContent||'').length,head:(e.textContent||'').slice(0,70)})));})()`));

const now = await (await fetch(`${BASE}/json/list`)).json();
now.forEach((t) => console.log(`target [${t.type}] ${t.url.slice(0, 90)}`));
ws.close(); process.exit(0);
