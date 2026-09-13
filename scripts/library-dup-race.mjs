/**
 * 并发重入 → 重复卡 验证脚本（CDP，dev 模式）
 *
 * 目的：验证「快速连点刷新 / 加载未完成就刷新」是否会产生重复卡，以及修复后是否消失。
 *
 * 前置：
 *   npx vite
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   npx electron . --disable-gpu --remote-debugging-port=9338
 * 运行：$env:CDP_PORT="9338"; node scripts/library-dup-race.mjs
 *
 * 四段（刻意贴近真实操作，不做多路叠加，避免无谓堵死主线程）：
 *   A 基线：库内 path/id 唯一性
 *   B 单路刷新 ×2：确认基础路径正常
 *   C 连点刷新 ×10：验证「合并」—— 应折叠为至多 2 次执行
 *   D 并发全量加载 ×2：验证互斥（加载未完成时再触发）
 */
const PORT = Number(process.env.CDP_PORT || 9338);
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result && r.result.value;
}
async function run(expr) {
    const raw = await evaluate(expr);
    if (raw && typeof raw === 'object' && raw.__exc) return raw;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return { __parseError: String(raw).slice(0, 200) }; }
}

const DUP = 'JSON.stringify(window.__jskDiag.dupInfo())';
const DO_REFRESH = '(async () => { await window.__jskDiag.refresh(); return JSON.stringify({ ok: true }); })()';
const BURST_10 = `(async () => {
    const p = [];
    for (let i = 0; i < 10; i++) p.push(window.__jskDiag.refresh());
    await Promise.allSettled(p);
    return JSON.stringify({ ok: true });
})()`;
const CONCURRENT_LOAD = '(async () => JSON.stringify({ ok: await window.__jskDiag.concurrentLoad() }))()';

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(1200);

    console.log('等库加载…');
    const ready = await run(`(async () => {
        const dl = Date.now() + 900000;
        while (Date.now() < dl) {
            if (window.__jskDiag && window.__jskDiag.lib().length) {
                return JSON.stringify({ ready: true, n: window.__jskDiag.lib().length, folder: window.__jskDiag.folder() });
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        return JSON.stringify({ ready: false, noHook: !window.__jskDiag });
    })()`);
    console.log('库:', JSON.stringify(ready));
    if (!ready.ready) { console.log('未就绪，退出'); process.exit(1); }

    const results = [];
    const check = async (label) => {
        const d = await run(DUP);
        const bad = d.duplicatePaths > 0 || d.duplicateIds > 0;
        results.push({ label, ...d, bad });
        console.log(`  ${label}: total=${d.total} unique=${d.uniquePaths} dupPaths=${d.duplicatePaths} dupIds=${d.duplicateIds}${bad ? '   [重复!]' : '   [OK]'}`);
        if (bad) {
            console.log('     path 样本:', JSON.stringify(d.dupPathSamples));
            console.log('     id 样本  :', JSON.stringify(d.dupIdSamples));
        }
        return d;
    };

    // MODE=snapshot：只快照当前库状态后退出（压测暂停时用于留存数据）
    if (process.env.MODE === 'snapshot') {
        const d = await run(DUP);
        const cats = await run('JSON.stringify({ category: window.__jskDiag.category(), filtered: window.__jskDiag.filteredCount(), pages: window.__jskDiag.totalPages() })');
        console.log('SNAPSHOT ' + JSON.stringify({ folder: ready.folder, ...d, ...cats }));
        process.exit(0);
    }

    console.log('\n===== A 基线 =====');
    await check('A 初始');

    console.log('\n===== B 单路刷新 x2 =====');
    for (let i = 1; i <= 2; i++) {
        const t0 = Date.now();
        await run(DO_REFRESH);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log('  第 ' + i + ' 次刷新耗时 ' + secs + 's');
        await check('B 第 ' + i + ' 次刷新后');
    }

    console.log('\n===== C 连点刷新 x10（验证合并 coalesce）=====');
    const tC = Date.now();
    await run(BURST_10);
    const cSecs = ((Date.now() - tC) / 1000).toFixed(1);
    console.log('  10 连点总耗时 ' + cSecs + 's（未合并的话会是 ~180s）');
    await wait(2500);
    await check('C 连点后');

    console.log('\n===== D 并发全量加载 x2（验证互斥）=====');
    const cl = await run(CONCURRENT_LOAD);
    console.log('  触发:', JSON.stringify(cl));
    await wait(3000);
    await check('D 并发加载后');

    const anyBad = results.some((r) => r.bad);
    console.log('\n===== 汇总 =====');
    results.forEach((r) => console.log('  ' + r.label + ': dupPaths=' + r.duplicatePaths + ' dupIds=' + r.duplicateIds));
    console.log(anyBad ? '\n[FAIL] 出现了重复卡' : '\n[PASS] 全程未产生重复卡');
    process.exit(anyBad ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
