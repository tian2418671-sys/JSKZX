const BASE = 'http://127.0.0.1:9380';
const list = await (await fetch(`${BASE}/json/list`)).json();
console.log('=== 所有 target ===');
list.forEach(t => console.log(` [${t.type}] ${t.url.slice(0, 110)}`));

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

const info = await ev(`(()=>{
  const f = document.querySelector('iframe');
  if (!f) return JSON.stringify({noIframe:true});
  const srcdoc = f.getAttribute('srcdoc') || '';
  const segWrap = f.closest('.seg-wrap');
  const segHtml = f.closest('.seg-html');
  return JSON.stringify({
    sandbox: f.getAttribute('sandbox'),
    h: f.offsetHeight, w: f.offsetWidth,
    srcdocLen: srcdoc.length,
    srcdocHead: srcdoc.slice(0, 400),
    srcdocTail: srcdoc.slice(-300),
    segWrapStyle: segWrap ? segWrap.getAttribute('style') : null,
    segHtmlStyle: segHtml ? segHtml.getAttribute('style') : null,
    fStyle: f.getAttribute('style')
  });
})()`);
console.log('\n=== iframe 详情 ===');
console.log(info);
ws.close();
process.exit(0);
