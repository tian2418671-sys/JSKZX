const BASE = 'http://127.0.0.1:9380';
const list = await (await fetch(`${BASE}/json/list`)).json();
const t = list.find(x => x.type === 'iframe');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
const events = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); }
    else if (m.method) events.push(m);
};
const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
};
await new Promise(res => { ws.onopen = res; });
await send('Runtime.enable');
await send('Log.enable');
await new Promise(r => setTimeout(r, 1500));

console.log('=== 控制台/异常事件 ===');
events.forEach(e => {
    if (e.method === 'Runtime.exceptionThrown') console.log('EXC:', JSON.stringify(e.params.exceptionDetails).slice(0, 600));
    if (e.method === 'Runtime.consoleAPICalled') console.log('LOG[' + e.params.type + ']:', (e.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 500));
    if (e.method === 'Log.entryAdded') console.log('ENTRY[' + e.params.entry.level + ']:', (e.params.entry.text || '').slice(0, 400));
});

// 手动重挂载看是否报错
console.log('\n=== 手动重挂载 ===');
console.log(await ev(`(()=>{
  try {
    if (typeof Vue === 'undefined') return 'no Vue';
    const app = Vue.createApp({ template: '<div style="padding:20px;color:red">手动测试渲染 OK</div>' });
    const el = document.getElementById('app');
    el.innerHTML = '';
    app.mount('#app');
    return 'mounted, innerHTML len=' + el.innerHTML.length;
  } catch(e) { return 'ERR: ' + e.message + '\\n' + (e.stack||'').slice(0,300); }
})()`));
await new Promise(r => setTimeout(r, 800));
console.log('#app 现在:', await ev('document.getElementById("app").innerHTML.slice(0,200)'));

ws.close();
process.exit(0);
