/**
 * 临时诊断：连接已启动实例 → 重载页面 → 抓取全部 console / 异常 → 判断根组件是否挂载。
 * 用法：$env:CDP_PORT="9375"; node scripts/probes/_probe-app-boot-debug.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9375);
let sock; let msgId = 0; const pending = new Map();
const logs = [];

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res; sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
            if (m.method === 'Runtime.consoleAPICalled') {
                const text = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
                logs.push(`[console.${m.params.type}] ${text.slice(0, 500)}`);
            }
            if (m.method === 'Runtime.exceptionThrown') {
                const d = m.params.exceptionDetails || {};
                logs.push(`[exception] ${(d.exception && (d.exception.description || d.exception.value)) || d.text || '?'}`.slice(0, 800));
            }
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __evalError: (r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
    return r.result && r.result.value;
}

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    console.log('已触发重载，采集 12s …');
    await new Promise(r => setTimeout(r, 12000));

    const state = await evaluate(`(() => ({
        hasDiag: !!window.__jskDiag,
        diagKeys: window.__jskDiag ? Object.keys(window.__jskDiag).slice(0, 10) : [],
        appInnerLen: (document.querySelector('#app') || {}).innerHTML ? document.querySelector('#app').innerHTML.length : -1,
        bodyText: String(document.body.innerText || '').slice(0, 300),
        btnCount: document.querySelectorAll('button').length,
        vueErrHandler: (() => { try { const a = document.querySelector('#app').__vue_app__; return !!(a && a.config && a.config.errorHandler); } catch (e) { return 'err'; } })()
    }))()`);
    console.log('页面状态：', JSON.stringify(state, null, 1));
    console.log(`\n共采集 ${logs.length} 条 console/异常：`);
    for (const line of logs.slice(-40)) console.log(line);
    process.exit(0);
})().catch(e => { console.error('诊断脚本异常：', e); process.exit(2); });
