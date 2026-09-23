/**
 * 大库「刷新 ×10」重复卡复现测试（CDP，dev 模式）
 *
 * 用户截图：侧栏「卡片列表 (478)」时出现 4 个相同的「吞噬星空」。
 * 上一轮已验证：全新全量加载后无重复、也没有 478 中间态。
 * → 所以嫌疑集中在**多次刷新**这条路径上。本脚本就是打这条路径。
 *
 * 前置：
 *   npx vite
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   npx electron . --disable-gpu --remote-debugging-port=9340
 * 运行：$env:CDP_PORT="9340"; node scripts/tools/library-dup-refresh10.mjs
 *
 * 每轮刷新后记录：库长度、唯一 path 数、重复 path 数、以及「吞噬星空」相关条目明细。
 */
const PORT = Number(process.env.CDP_PORT || 9340);
const ROUNDS = Number(process.env.ROUNDS || 10);
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

const DO_REFRESH = '(async () => { await window.__jskDiag.refresh(); return JSON.stringify({ ok: true }); })()';
const STAT = 'JSON.stringify(window.__jskDiag.quickDup())';
const TUNSHI = `JSON.stringify((() => {
    const arr = window.__jskDiag.lib();
    const hit = arr.filter(c => (c.name || '').includes('吞噬星空') || (c.path || '').includes('吞噬星空'));
    return { count: hit.length, items: hit.map(c => c.name + ' | ' + c.path + ' | ' + c.id) };
})())`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(1000);

    console.log('等库就绪…');
    const ready = await run(`(async () => {
        const dl = Date.now() + 600000;
        while (Date.now() < dl) {
            if (window.__jskDiag && window.__jskDiag.lib().length > 1000) return JSON.stringify(window.__jskDiag.quickDup());
            await new Promise(r => setTimeout(r, 1000));
        }
        return JSON.stringify({ ready: false });
    })()`);
    console.log('初始:', JSON.stringify(ready));

    const rows = [];
    for (let i = 1; i <= ROUNDS; i++) {
        const t0 = Date.now();
        const r = await run(DO_REFRESH);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.__exc) { console.log(`  第 ${i} 轮 evaluate 异常: ${String(r.__exc).slice(0, 120)}`); break; }
        await wait(500);
        const s = await run(STAT);
        const tun = await run(TUNSHI);
        const dup = s.dupPaths > 0;
        rows.push({ round: i, secs, total: s.total, unique: s.uniquePaths, dupPaths: s.dupPaths, tunshi: tun.count });
        console.log(`  第 ${String(i).padStart(2)} 轮 (${secs}s): total=${s.total} unique=${s.uniquePaths} dupPaths=${s.dupPaths} 吞噬星空相关=${tun.count}${dup ? '   <== 出现重复!' : ''}`);
        if (dup || tun.count > 3) {
            console.log('     quickDup:', JSON.stringify(s));
            console.log('     吞噬星空明细:', JSON.stringify(tun, null, 1));
        }
    }

    console.log('\n===== 汇总 =====');
    console.log('  轮次  耗时    total   unique  dupPaths  吞噬星空相关');
    rows.forEach((r) => console.log(`  ${String(r.round).padStart(4)}  ${String(r.secs).padStart(6)}s  ${String(r.total).padStart(6)}  ${String(r.unique).padStart(6)}  ${String(r.dupPaths).padStart(8)}  ${String(r.tunshi).padStart(10)}`));
    const bad = rows.filter((r) => r.dupPaths > 0 || r.tunshi > 3);
    console.log(bad.length ? `\n[FAIL] ${bad.length} 轮出现异常` : '\n[PASS] 10 轮刷新全程无重复');
    console.log('\n最终 dupInfo:', JSON.stringify(await run('JSON.stringify(window.__jskDiag.dupInfo())')));
    process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
