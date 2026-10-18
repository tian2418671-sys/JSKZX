const BASE = 'http://127.0.0.1:9380';
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

// 哪些 ctx 值是「卡片对象数组」
console.log(await ev(`(()=>{
  const c = ${C};
  const out = [];
  for (const k of Object.keys(c)) {
    let v; try { v = c[k]; } catch(e){ continue; }
    let val; try { val = v && v.value; } catch(e){ continue; }
    if (Array.isArray(val) && val.length > 10) {
      const s = val[0];
      out.push({ k, len: val.length, sampleType: typeof s, sampleKeys: s && typeof s==='object' ? Object.keys(s).slice(0,8) : null });
    }
  }
  return JSON.stringify(out, null, 1);
})()`));
ws.close(); process.exit(0);
