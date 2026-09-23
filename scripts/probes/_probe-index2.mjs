/**
 * 探针2：抓运行期 console + 观察 rebuildSearchIndex 是否被合并（indexBuilding 是否卡住）
 * 用法：$env:CDP_PORT="9338"; node scripts/probes/_probe-index2.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9338);
const CAPTURE_MS = Number(process.env.CAPTURE_MS || 60000);
let sock; let msgId = 0; const pending = new Map();
const logged = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
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
                return;
            }
            if (m.method === 'Runtime.consoleAPICalled') {
                const text = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
                logged.push(`[${m.params.type}] ${text}`.slice(0, 300));
            } else if (m.method === 'Runtime.exceptionThrown') {
                logged.push(`[exception] ${(m.params.exceptionDetails.exception || m.params.exceptionDetails).description || m.params.exceptionDetails.text}`.slice(0, 500));
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
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result && r.result.value;
}

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(300);

    // 包装：看应用侧是否会再发起一次 buildAsync（若一直只 coalesced 不 start，说明 indexBuilding 卡住）
    console.log('包装:', await evaluate(`(async () => {
        const si = window.__jskDiag.idx;   // ⚠️ 必须用应用那一份单例（import 可能拿到 ?t= 的另一实例）
        if (!window.__idxWrap) {
            window.__idxWrap = { build: 0, clear: 0 };
            const ob = si.buildAsync.bind(si); si.buildAsync = function (l, ...r) { window.__idxWrap.build++; return ob(l, ...r); };
            const oc = si.clear.bind(si); si.clear = function (...a) { window.__idxWrap.clear++; return oc(...a); };
        }
        return JSON.stringify({ wrap: window.__idxWrap, stats: si.stats(), generation: si.generation });
    })()`));

    console.log(`触发一次刷新并抓 ${CAPTURE_MS / 1000}s 日志…`);
    evaluate('(async () => { await window.__jskDiag.refresh(); return "refreshed"; })()');

    for (let i = 0; i < CAPTURE_MS / 5000; i++) {
        await wait(5000);
        const s = await evaluate(`(async () => { const si = window.__jskDiag.idx; return JSON.stringify({ wrap: window.__idxWrap, stats: si.stats(), generation: si.generation, lib: window.__jskDiag.lib().length, heapMB: +(performance.memory.usedJSHeapSize/1048576).toFixed(0) }); })()`);
        console.log(`  +${(i + 1) * 5}s`, s);
    }

    console.log('\n===== console 日志（索引/错误/刷新相关） =====');
    logged.filter(l => /索引|Token|打标|刷新|Error|error|失败|警告|Warning|刷新|目录/.test(l)).slice(-40).forEach(l => console.log('  ' + l));
    process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
