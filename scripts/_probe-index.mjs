/**
 * 探针：观察 searchIndex 的 clear/buildAsync 调用与 library watch 是否触发（dev 调试用）
 * 用法：$env:CDP_PORT="9338"; node scripts/_probe-index.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9338);
let sock; let msgId = 0; const pending = new Map();
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
    await wait(500);

    // 1) 装上探针（包装单例方法）
    const wrap = await evaluate(`(async () => {
        const si = window.__jskDiag.idx;   // ⚠️ 必须用应用那一份单例（import 可能拿到 ?t= 的另一实例）
        if (!window.__idxLog) {
            window.__idxLog = [];
            const oc = si.clear.bind(si);
            si.clear = function (...a) { window.__idxLog.push({ t: Date.now(), fn: 'clear', gen: si.generation }); return oc(...a); };
            const ob = si.buildAsync.bind(si);
            si.buildAsync = function (lib, ...rest) {
                window.__idxLog.push({ t: Date.now(), fn: 'buildAsync', n: (lib || []).length, gen: si.generation });
                return ob(lib, ...rest);
            };
            const og = si.build.bind(si);
            si.build = function (lib, ...rest) { window.__idxLog.push({ t: Date.now(), fn: 'build', n: (lib || []).length }); return og(lib, ...rest); };
        }
        return JSON.stringify({ wrapped: true, stats: si.stats() });
    })()`);
    console.log('探针:', JSON.stringify(wrap));

    // 2) 触发一次刷新，看 watcher/重建是否被调用
    console.log('触发刷新…');
    await evaluate('(async () => { await window.__jskDiag.refresh(); return "refreshed"; })()');
    await wait(8000);

    const out = await evaluate(`(async () => {
        const si = window.__jskDiag.idx;
        return JSON.stringify({ stats: si.stats(), log: (window.__idxLog || []).slice(-20).map(e => ({ ms: e.t - (window.__idxLog[0] ? window.__idxLog[0].t : e.t), fn: e.fn, n: e.n, gen: e.gen })) });
    })()`);
    console.log('结果:', out);
    process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
