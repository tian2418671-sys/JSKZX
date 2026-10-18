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

// 1. 找到并点击揽仙录卡片条目
const clicked = await ev(`(()=>{
  const walk = (root) => {
    const els = [...root.querySelectorAll('*')];
    for (const el of els) {
      if (el.children.length <= 3 && /揽仙录/.test(el.textContent||'') && (el.textContent||'').trim().length < 40) {
        return el;
      }
    }
    return null;
  };
  const el = walk(document.body);
  if (!el) return 'not-found';
  let t = el;
  for (let i=0;i<4 && t;i++) { if (t.getAttribute && (t.getAttribute('role')==='button' || t.tagName==='BUTTON' || t.className && /cursor-pointer|card/i.test(t.className))) break; t = t.parentElement; }
  const target = t || el;
  target.click();
  return target.tagName + '.' + String(target.className).slice(0,80);
})()`);
console.log('点击结果:', clicked);
await sleep(3000);

// 2. 打开聊天 tab
const tab = await ev(`(()=>{
  if (typeof (${C}).openChatTab === 'function') { try { (${C}).openChatTab(); return 'openChatTab()'; } catch(e){ return 'err:'+e.message; } }
  const cands=[...document.querySelectorAll('button,[role=button]')].filter(b=>/测卡|聊天|对话/.test(b.textContent||''));
  if (cands[0]) { cands[0].click(); return 'clicked:'+cands[0].textContent.trim().slice(0,20); }
  return 'no-tab';
})()`);
console.log('聊天 tab:', tab);
await sleep(3500);

const msgs = await ev(`(()=>{const c=${C};const m=c.chatMessages.value||[];return JSON.stringify({
  count: m.length,
  detail: m.map(x=>({role:x.role, clen:(x.content||'').length, idx:x.index, sw:(x.swipes||[]).map(s=>({len:s.length,head:s.slice(0,50)}))}))
});})()`);
console.log('消息:', msgs);

const dom = await ev(`(()=>{
  const segs=[...document.querySelectorAll('.seg-text,.seg-html')];
  const leakMark = 'replace(/^' + '\u0060'.repeat(3);
  return JSON.stringify({
    count: segs.length,
    detail: segs.slice(0,6).map(el=>({cls:el.className,len:(el.textContent||'').length,head:(el.textContent||'').replace(/\\s+/g,' ').slice(0,80)})),
    leak: document.body.innerText.includes(leakMark)
  });
})()`);
console.log('DOM 段:', dom);

ws.close();
process.exit(0);
