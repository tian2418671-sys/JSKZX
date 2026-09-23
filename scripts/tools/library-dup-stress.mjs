/**
 * 大库重复卡压测（CDP，dev 模式）—— 驱动真实应用完成「刷新 ×10 + 搜索 ×10」
 *
 * 目标库：I:\03\角色色卡（11,138 PNG + 525 JSON，9.76 GB，1,910 组同名不同路径）
 *
 * 前置：
 *   npx vite
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   npx electron . --disable-gpu --remote-debugging-port=9337
 *
 * 运行：$env:CDP_PORT="9337"; node scripts/tools/library-dup-stress.mjs
 *
 * 四段：
 *   ① 等全量加载完成（大库 9.76GB，首载数分钟）
 *   ② refreshLibrary ×REFRESH_ROUNDS（走应用真实的「重新扫描」逻辑），每轮核对 path/id 唯一性
 *   ③ 搜索 ×10（分组固定为 all，确保搜的是全库），核对结果集内 path/id 唯一性
 *   ④ 汇总
 *
 * ⚠️ 全库 dupInfo 要对 11k 条做三次 Map 遍历（较慢），故搜索段只查「结果集内部」重复。
 */
const PORT = Number(process.env.CDP_PORT || 9337);
const REFRESH_ROUNDS = Number(process.env.REFRESH_ROUNDS || 10);
const SEARCHES = process.env.SEARCHES
    ? process.env.SEARCHES.split(',')
    : ['a', 'e', '的', '小', 's', 'cl', '妈妈', 'static', '2025', 'X'];

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

const READY = `(async () => {
    const dl = Date.now() + 900000;
    while (Date.now() < dl) {
        if (window.__jskDiag && window.__jskDiag.lib().length) {
            const info = window.__jskDiag.dupInfo();
            return JSON.stringify({ ready: true, count: info.total, uniquePaths: info.uniquePaths, folder: window.__jskDiag.folder(), category: window.__jskDiag.category() });
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return JSON.stringify({ ready: false, noHook: !window.__jskDiag });
})()`;

/** 搜索 + 只查结果集内部重复 */
function searchStep(q) {
    return `(async () => {
        const d = window.__jskDiag;
        d.setCategory('all');            // 确保搜全库，而不是只搜当前分组
        d.setSearch(${JSON.stringify(q)});
        await new Promise(r => setTimeout(r, 900));
        const f = d.filteredDup();
        return JSON.stringify({ q: ${JSON.stringify(q)}, filtered: f.filtered, uniquePaths: f.uniquePaths, dupPaths: f.duplicatePaths, dupIds: f.duplicateIds, samples: f.dupPathSamples });
    })()`;
}

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(1200);

    console.log('⏳ 等待大库全量加载（最多 15 分钟）…');
    const ready = await run(READY);
    console.log('① 库就绪:', JSON.stringify(ready));
    if (!ready.ready) { console.log('❌ 未就绪（hook 缺失或库未加载）'); process.exit(1); }

    // ===== ② 刷新 × N（应用真实「重新扫描」）=====
    console.log(`\n======== ② refreshLibrary × ${REFRESH_ROUNDS} ========`);
    const refreshRounds = [];
    for (let i = 1; i <= REFRESH_ROUNDS; i++) {
        const t0 = Date.now();
        await run(`(async () => { await window.__jskDiag.refresh(); return JSON.stringify({ ok: true }); })()`);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const d = await run(`JSON.stringify(window.__jskDiag.dupInfo())`);
        refreshRounds.push(d);
        const bad = d.duplicatePaths > 0 || d.duplicateIds > 0;
        console.log(`  第 ${String(i).padStart(2)} 轮 (${secs}s): total=${d.total} unique=${d.uniquePaths} dupPaths=${d.duplicatePaths} dupIds=${d.duplicateIds}${bad ? '   ❌ 出现重复!' : '   ✅'}`);
        if (bad) {
            console.log('     path 样本:', JSON.stringify(d.dupPathSamples));
            console.log('     id  样本:', JSON.stringify(d.dupIdSamples));
        }
    }

    // ===== ③ 搜索 × 10 =====
    console.log(`\n======== ③ 搜索 × ${SEARCHES.length}（分组固定 all）========`);
    const searchRounds = [];
    for (const q of SEARCHES) {
        const r = await run(searchStep(q));
        searchRounds.push(r);
        const bad = r.dupPaths > 0 || r.dupIds > 0;
        console.log(`  "${q}": 命中=${r.filtered} 唯一path=${r.uniquePaths} dupPaths=${r.dupPaths} dupIds=${r.dupIds}${bad ? '   ❌' : '   ✅'}`);
        if (bad) console.log('     样本:', JSON.stringify(r.samples));
    }
    await run(`(async () => { window.__jskDiag.clearSearch(); window.__jskDiag.setCategory('all'); return JSON.stringify({ ok: true }); })()`);

    // ===== ④ 汇总 =====
    const finalInfo = await run(`JSON.stringify(window.__jskDiag.dupInfo())`);
    const anyRefreshDup = refreshRounds.some((d) => d.duplicatePaths > 0 || d.duplicateIds > 0);
    const anySearchDup = searchRounds.some((r) => r.dupPaths > 0 || r.dupIds > 0);
    const scanTotal = searchRounds.reduce((s, r) => s + r.filtered, 0);
    console.log('\n======== ④ 汇总 ========');
    console.log(`  全量库规模                    : ${finalInfo.total} 张 / 唯一 path ${finalInfo.uniquePaths}`);
    console.log(`  同名不同路径（物理事实非bug） : ${finalInfo.sameNameDiffPath} 组`);
    console.log(`  刷新 ${REFRESH_ROUNDS} 轮后出现重复      : ${anyRefreshDup ? '❌ 是' : '✅ 否'}`);
    console.log(`  搜索 ${SEARCHES.length} 个查询后出现重复   : ${anySearchDup ? '❌ 是' : '✅ 否'}（累计命中 ${scanTotal} 条）`);
    console.log(`  最终库内 duplicatePaths/Ids   : ${finalInfo.duplicatePaths} / ${finalInfo.duplicateIds}`);
    const pass = !anyRefreshDup && !anySearchDup && finalInfo.duplicatePaths === 0 && finalInfo.duplicateIds === 0;
    console.log(pass ? '\n✅ 压测通过：未观测到任何重复卡（数据层）' : '\n❌ 压测发现问题');
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
