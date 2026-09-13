/**
 * 大库「加载中间态」重复卡验证（CDP，dev 模式）
 *
 * 目的：用户截图里侧栏显示「卡片列表 (478)」时出现 4 个重复的「吞噬星空」。
 *       本脚本在**加载过程中**高频轮询，抓取库长度时间线 + 每一步的 path 重复情况，
 *       验证「中间态是否本来就带重复」。
 *
 * 前置：
 *   npx vite
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   npx electron . --disable-gpu --remote-debugging-port=9340
 * 运行：$env:CDP_PORT="9340"; node scripts/library-dup-timeline.mjs
 *
 * 输出：
 *   ① 加载时间线（库长度、耗时、每步 dupPaths）
 *   ② 「478 附近」是否有重复
 *   ③ 加载完成后（11186）的全量去重结果
 *   ④ 针对「吞噬星空」逐条列出 path / id / name（用户截图的那张卡）
 */
const PORT = Number(process.env.CDP_PORT || 9340);
const POLL_MS = Number(process.env.POLL_MS || 700);
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

/** 「吞噬星空」相关条目的逐条明细 */
const TUNSHI = `JSON.stringify((() => {
    const arr = window.__jskDiag.lib();
    return arr.filter(c => (c.name || '').includes('吞噬星空') || (c.path || '').includes('吞噬星空'))
              .map(c => ({ name: c.name, path: c.path, id: c.id, size: c._size, mtime: c._mtime }));
})())`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    console.log('已连接 CDP，开始抓加载时间线（每 ' + POLL_MS + 'ms 一次）…\n');

    const t0 = Date.now();
    const timeline = [];
    let lastTotal = -1;
    let sawHook = false;
    const deadline = Date.now() + 900000;

    while (Date.now() < deadline) {
        const s = await run(`JSON.stringify(window.__jskDiag ? window.__jskDiag.quickDup() : { noHook: true })`);
        if (s.noHook) { await wait(500); continue; }
        if (s.__exc) { console.log('evaluate 异常（页面可能已卡）:', String(s.__exc).slice(0, 120)); await wait(1500); continue; }
        sawHook = true;
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        // 只在长度变化时记一行，减少噪音
        if (s.total !== lastTotal) {
            const flag = s.dupPaths > 0 ? '   <== 重复!' : '';
            console.log(`  t=${String(secs).padStart(7)}s  total=${String(s.total).padStart(6)}  unique=${String(s.uniquePaths).padStart(6)}  dupPaths=${s.dupPaths}${flag}`);
            timeline.push({ secs: Number(secs), ...s });
            lastTotal = s.total;
            // 抓「478 附近」
            if (s.total >= 400 && s.total <= 560) {
                const t = await run(TUNSHI);
                console.log('     [478 区间] 吞噬星空条目:', JSON.stringify(t));
            }
        }
        // 加载完成判定：连续 3 次长度不变且 >10000
        if (s.total > 10000) {
            await wait(4000);
            const s2 = await run(`JSON.stringify(window.__jskDiag.quickDup())`);
            const s3 = await wait(0).then(() => run(`JSON.stringify(window.__jskDiag.quickDup())`));
            if (s2.total === s.total && s3.total === s.total) {
                console.log(`\n加载稳定于 ${s.total}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
                break;
            }
        }
        await wait(POLL_MS);
    }

    console.log('\n===== 最终全量去重 =====');
    console.log('  dupInfo:', JSON.stringify(await run('JSON.stringify(window.__jskDiag.dupInfo())')));
    console.log('\n===== 「吞噬星空」逐条明细 =====');
    console.log('  ' + JSON.stringify(await run(TUNSHI), null, 1));

    console.log('\n===== 时间线摘要 =====');
    console.log('  采样点数:', timeline.length);
    console.log('  出现过重复的采样点:', timeline.filter((t) => t.dupPaths > 0).length);
    const near478 = timeline.filter((t) => t.total >= 400 && t.total <= 560);
    console.log('  478 区间采样:', JSON.stringify(near478));
    process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
