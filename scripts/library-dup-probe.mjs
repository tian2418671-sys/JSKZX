/**
 * 卡库重复卡 复现/诊断脚本（CDP，dev 模式）
 *
 * 用法：
 *   1) npx vite
 *   2) $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *      npx electron . --disable-gpu --remote-debugging-port=9335
 *   3) $env:CDP_PORT="9335"; node scripts/library-dup-probe.mjs
 *
 * 目的：定位「搜索 / 刷新后卡库出现重复卡」的真实成因。
 * 手法：读 library 数组的 path/id 分布（唯一数 vs 总数），并在「打开库 → 刷新 → 搜索」
 *      各阶段分别取样，看重复是在哪一步引入的。
 */
const PORT = Number(process.env.CDP_PORT || 9335);
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && /localhost:5173/.test(t.url || ''));
    if (!page) throw new Error('未找到 localhost:5173 target；可见: ' + list.map((t) => t.url).join(' | '));
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

const DUP = `JSON.stringify(window.__jskDiag ? window.__jskDiag.dupInfo() : { noHook: true })`;
const PAGED = `JSON.stringify(window.__jskDiag ? { filtered: window.__jskDiag.filteredCount(), pages: window.__jskDiag.totalPages(), page1: window.__jskDiag.paginated().length } : { noHook: true })`;
const SET_SEARCH = (q) => `(async () => { window.__jskDiag.setSearch(${JSON.stringify(q)}); await new Promise(r=>setTimeout(r,900)); return JSON.stringify({ ok: true, q: ${JSON.stringify(q)} }); })()`;
const DO_REFRESH = `(async () => { const r = await window.__jskDiag.refresh(); await new Promise(x=>setTimeout(x,2500)); return JSON.stringify({ ok: true }); })()`;

/** 展开所有分组/清除搜索，让 filteredLibrary 尽量接近全量 */
const RESET_FILTERS = `(async () => {
    const d = window.__jskDiag;
    d.setSearch('');
    await new Promise(r=>setTimeout(r,600));
    return JSON.stringify({ filtered: d.filteredCount(), total: d.lib().length });
})()`;

/** 渲染层取证：DOM 里每张卡出现几次（用 handleCardClick 的卡片行特征定位） */
const DOM_DUP = `(() => {
    // 列表视图卡片行：带 @click 的 div，且内含 w-8 h-8 缩略图容器（与工具栏按钮区分）
    const rows = [...document.querySelectorAll('div.cursor-pointer')];
    const names = rows.map(r => {
        const sp = [...r.querySelectorAll('span')].find(s => (s.className || '').includes('truncate'));
        return sp ? (sp.textContent || '').trim() : '(无名字)';
    }).filter(n => n && n !== '(无名字)');
    const seen = new Map();
    for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
    const dups = [...seen.entries()].filter(([, c]) => c > 1);
    return JSON.stringify({
        renderedRows: names.length,
        uniqueNames: seen.size,
        dupNames: dups.length,
        dupSamples: dups.slice(0, 6),
        firstFew: names.slice(0, 8)
    });
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(1500);

    // 等库加载
    const ready = await run(`(async () => {
        const dl = Date.now() + 40000;
        while (Date.now() < dl) {
            if (window.__jskDiag && window.__jskDiag.lib().length) break;
            await new Promise(r => setTimeout(r, 500));
        }
        return JSON.stringify({
            ready: !!(window.__jskDiag && window.__jskDiag.lib().length),
            count: window.__jskDiag ? window.__jskDiag.lib().length : 0,
            noHook: !window.__jskDiag
        });
    })()`);
    console.log('① 库就绪:', JSON.stringify(ready));
    if (!ready.ready) {
        console.log(ready.noHook
            ? '⚠️ 未找到 window.__jskDiag（该句柄已从 App.vue 移除；如需复跑本探针，请临时加回）'
            : '库未加载，退出');
        process.exit(1);
    }

    console.log('② 初始:', await evaluate(DUP));
    console.log('   分页:', await evaluate(PAGED));

    // 搜索（用户报的场景 1）
    await run(SET_SEARCH('a'));
    console.log('③ 搜索 "a" 后:', await evaluate(DUP));
    await run(SET_SEARCH(''));
    await wait(500);

    // 刷新（用户报的场景 2）
    console.log('④ 执行 refreshLibrary …');
    await run(DO_REFRESH);
    console.log('   刷新后:', await evaluate(DUP));
    console.log('   分页  :', await evaluate(PAGED));

    // 再来一次刷新，看是否累积
    console.log('⑤ 再次 refreshLibrary …');
    await run(DO_REFRESH);
    console.log('   二刷后:', await evaluate(DUP));

    // 刷新后带搜索
    await run(SET_SEARCH('a'));
    console.log('⑥ 二刷 + 搜索 "a":', await evaluate(DUP));
    await run(RESET_FILTERS);
    console.log('⑦ 清空搜索:', await evaluate(DUP));

    // 渲染层取证（不做翻页操作，避免因缺少 goPage 句柄而挂住）
    console.log('⑧ DOM 渲染行:', await evaluate(DOM_DUP));

    process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
