/**
 * 通用 CDP 取值小工具（dev 模式调试用）
 * 用法：$env:CDP_PORT="9338"; $env:EXPR="JSON.stringify(window.__jskDiag.folder())"; node scripts/_cdp-eval.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9338);
const EXPR = process.env.EXPR || '1';
let sock; let msgId = 0; const pending = new Map();

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res;
        sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id); pending.delete(m.id);
                m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
            }
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    // GC=1 时先强制一次 GC，再取值（用于内存基线对比）
    if (process.env.GC === '1') {
        try { await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage'); } catch (e) { /* 忽略 */ }
    }
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
        console.log('EXCEPTION:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        process.exit(1);
    }
    console.log(JSON.stringify(r.result && r.result.value, null, 2));
    process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
