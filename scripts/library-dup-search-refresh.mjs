/**
 * 「搜索后刷新 → 同一张角色卡重复出现」缺陷 端到端重测（CDP，dev 模式）
 *
 * 目标场景（用户反馈）：搜索状态下刷新库，刷新完成后列表里同一张卡出现两次；
 * 搜索（尤其中文单字）时更容易看到。
 *
 * 前置：
 *   npx vite
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   npx electron . --disable-gpu --remote-debugging-port=9338
 * 运行：$env:CDP_PORT="9338"; node scripts/library-dup-search-refresh.mjs
 *
 * 判定口径（两条线，都要为 0）：
 *   ① library 层：`__jskDiag.dupInfo()` 的 duplicatePaths / duplicateIds
 *      —— 库数组本身是否有同一 path 入两条
 *   ② 列表层（用户真正看到的）：`__jskDiag.filteredDup()` 的 duplicatePaths
 *      —— 当前搜索/筛选结果里是否有同一张卡出现两次
 *      搜索走倒排索引，索引并发重建被修好后这里必须为 0
 */
const PORT = Number(process.env.CDP_PORT || 9338);
const TERMS = (process.env.SEARCH_TERMS || '龙,的,卡,女').split(',').map(s => s.trim()).filter(Boolean);
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
    catch (e) { return { __parseError: String(raw).slice(0, 300) }; }
}

const LIB = 'JSON.stringify(window.__jskDiag.dupInfo())';
const FILT = 'JSON.stringify(window.__jskDiag.filteredDup())';
const HEAP = '+(performance.memory.usedJSHeapSize/1048576).toFixed(0)';
const setSearch = (q) => `(() => { window.__jskDiag.setSearch(${JSON.stringify(q)}); return JSON.stringify({ q: ${JSON.stringify(q)} }); })()`;
const clearSearch = '(() => { window.__jskDiag.clearSearch(); return JSON.stringify({ ok: true }); })()';
const doRefresh = '(async () => { const t = Date.now(); await window.__jskDiag.refresh(); return JSON.stringify({ ms: Date.now() - t }); })()';

/** 等搜索索引构建完成（搜索走索引才有意义；搜索索引挂起时 useSearch 会退化到全库慢扫）
 *  ⚠️ 必须用 `window.__jskDiag.idx`（应用真正使用的那份单例）；
 *     用 `import('/js/utils/searchIndex.js')` 可能因 Vite 的 `?t=` 查询参数拿到另一个实例。
 */
async function waitIndexReady(maxMs = 420000) {
    const expr = `(async () => {
        const t0 = Date.now();
        const si = window.__jskDiag.idx;
        while (Date.now() - t0 < ${maxMs}) {
            if (si.buildTime && si.cardCount > 0) return JSON.stringify({ ready: true, cards: si.cardCount, words: si.index.size, s: Math.round((Date.now() - t0) / 1000) });
            await new Promise(r => setTimeout(r, 3000));
        }
        return JSON.stringify({ ready: false, cards: si.cardCount, generation: si.generation });
    })()`;
    const r = await run(expr);
    console.log('索引:', JSON.stringify(r));
    return r && r.ready;
}

const problems = [];
const rows = [];
function report(label, lib, filt) {
    const libBad = lib.duplicatePaths > 0 || lib.duplicateIds > 0;
    const filtBad = filt.duplicatePaths > 0;
    const bad = libBad || filtBad;
    const row = { label, total: lib.total, filtered: filt.filtered, libDup: lib.duplicatePaths, filtDup: filt.duplicatePaths, bad };
    rows.push(row);
    console.log(`  ${label}: 库 ${lib.total} (dup ${lib.duplicatePaths}) · 列表 ${filt.filtered} (dup ${filt.duplicatePaths})${bad ? '   [重复!]' : '   OK'}`);
    if (libBad) problems.push(`${label}: 库层重复 ${JSON.stringify(lib.dupPathSamples)}`);
    if (filtBad) problems.push(`${label}: 列表层重复 ${JSON.stringify(filt.dupPathSamples)}`);
    return { lib, filt, bad, row };
}

async function snap(label) {
    const lib = await run(LIB);
    const filt = await run(FILT);
    const heap = await evaluate(HEAP);
    if (lib.__exc || filt.__exc) { problems.push(`${label}: 取值异常 ${lib.__exc || filt.__exc}`); return; }
    const r = report(label, lib, filt);
    r.row.heapMB = heap;
    console.log(`    堆占用 ${heap}MB`);
    return r;
}

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
    // 等索引/Token 预热收尾（首屏完成后才开始构建）
    await wait(3000);
    await waitIndexReady();

    console.log('\n===== A 基线（无搜索） =====');
    await snap('A 基线');

    console.log('\n===== B 搜索态基线（中文单字 + 多字，索引直通路径） =====');
    for (const q of TERMS) {
        await run(setSearch(q));
        await wait(2000);
        await snap(`B 搜索「${q}」`);
    }

    console.log('\n===== C 搜索 → 刷新（用户反馈的主场景） =====');
    for (let i = 1; i <= 2; i++) {
        const q = TERMS[(i - 1) % TERMS.length];
        await run(setSearch(q));
        await wait(1200);
        const r = await run(doRefresh);
        console.log(`  第 ${i} 轮：搜索「${q}」后刷新耗时 ${r.ms}ms`);
        await wait(4000);   // 等索引重建 + computed 收敛
        await snap(`C-${i} 「${q}」刷新后`);
    }

    console.log('\n===== D 搜索 → 立刻刷新（不等防抖，模拟快速操作） =====');
    await run(setSearch(TERMS[0]));
    const rd = await run(doRefresh);
    console.log(`  刷新耗时 ${rd.ms}ms`);
    await wait(5000);
    await snap('D 未等待防抖即刷新');

    console.log('\n===== E 清空搜索后 =====');
    await run(clearSearch);
    await wait(2000);
    await snap('E 清空搜索');

    console.log('\n===== F 连点刷新 ×6（合并 coalesce） =====');
    const burst = `(async () => { const p = []; for (let i = 0; i < 6; i++) p.push(window.__jskDiag.refresh()); await Promise.allSettled(p); return JSON.stringify({ ok: true }); })()`;
    await run(setSearch(TERMS[0]));
    const t0 = Date.now();
    await run(burst);
    console.log(`  6 连点总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await wait(5000);
    await snap('F 连点后（搜索态）');

    console.log('\n===== 汇总 =====');
    rows.forEach(r => console.log(`  ${r.label}: total=${r.total} filtered=${r.filtered} dup(lib)=${r.libDup} dup(list)=${r.filtDup} heap=${r.heapMB}MB`));
    console.log('  索引状态:', JSON.stringify(await run('JSON.stringify(window.__jskDiag.idx.stats())')));
    if (problems.length) {
        console.log('\n[FAIL] 发现重复卡：');
        problems.forEach(p => console.log('   - ' + p));
        process.exit(1);
    }
    console.log('\n[PASS] 全程 库层/列表层 均无重复卡');
    process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
