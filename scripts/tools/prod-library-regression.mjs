/**
 * 生产模式卡库/搜索 回归探针（CDP，app:// 生产构建）
 *
 * 对应历史缺陷（v2.2.7 修复，本脚本防其复活）：
 *   PK-01 🔴 搜索后刷新 → 同一张卡重复出现
 *   PK-02 🔴 刷新后整个库从界面消失（扫描异常被当空库）
 *   DF-08 🔴 refreshLibrary 增量刷新缺 path 去重 → 同一文件入库两条
 *   DF-09 🔴 parseAndAddCard 判重条件过窄 → 同 path 进两次
 *
 * 手法：**纯 DOM + preload API**（生产构建没有 __jskDiag 调试句柄，
 *       这反而更贴近真实用户路径）。核心不变量：
 *         渲染出的卡片行里，同一个「卡片名」不应出现次数异常；
 *         刷新/搜索前后，卡片总数不应无故归零或翻倍。
 *
 * 用法：
 *   npx electron . --disable-gpu --remote-debugging-port=9350
 *   $env:CDP_PORT="9350"; node scripts/tools/prod-library-regression.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9350);
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
            try {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) {
                    const p = pending.get(m.id); pending.delete(m.id);
                    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
                }
            } catch (e) { /* 忽略非 JSON 帧 */ }
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

/**
 * 读取「侧栏卡片列表」的可观测状态（纯 DOM，不依赖调试句柄）
 *  - 标题形如「卡片列表 (75)」→ 计数
 *  - 卡片行 div.cursor-pointer → 取「名字 + 缩略图 URL」作为唯一键
 *
 * ⚠️ 为什么不能只用「名字」判定重复：卡库里**本来就存在大量重名卡**
 *    （不同文件、不同卡，仅名字相同 —— 实测该库有 1,910 组同名不同路径）。
 *    只比名字会把它们误判成"重复卡"，产生假警报（第一版脚本就踩了这个）。
 *    只有「名字 + 缩略图 src」都相同，才可能是同一张卡被渲染/入库两次。
 */
const LIST_STATE = `(() => {
    const txt = document.body.innerText || '';
    const m = txt.match(/卡片列表\\s*\\(\\s*(\\d+)\\s*\\)/);
    const count = m ? Number(m[1]) : null;
    const rows = [...document.querySelectorAll('div.cursor-pointer')];
    const keys = rows.map(r => {
        const sp = [...r.querySelectorAll('span')].find(s => (s.className || '').includes('truncate'));
        const name = sp ? (sp.textContent || '').trim() : '';
        const img = r.querySelector('img');
        const src = img ? (img.getAttribute('src') || '') : '';
        if (!name && !src) return '';
        return name + '\\u0000' + src;
    }).filter(Boolean);
    const seen = new Map();
    for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1);
    const dupKeys = [...seen.entries()].filter(([, c]) => c > 1);
    // 仅同名（不同文件）也统计一下，用于区分「物理重名」与「真重复」
    const names = keys.map(k => k.split('\\u0000')[0]);
    const nameSeen = new Map();
    for (const n of names) nameSeen.set(n, (nameSeen.get(n) || 0) + 1);
    const dupNames = [...nameSeen.entries()].filter(([, c]) => c > 1);
    return JSON.stringify({
        headerCount: count,
        renderedRows: keys.length,
        uniqueCards: seen.size,
        dupCardGroups: dupKeys.length,
        dupCardSample: dupKeys.slice(0, 3).map(([k, c]) => ({ key: k.split('\\u0000')[0], times: c })),
        sameNameOnlyGroups: dupNames.length
    });
})()`;

/** 点「刷新/重新扫描」按钮（SidebarPanel.vue 的 refreshLibrary 按钮，title 明确） */
const CLICK_REFRESH = `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.title || '').includes('重新扫描当前库目录'));
    if (!btn) return JSON.stringify({ clicked: false, reason: 'button-not-found' });
    btn.click();
    return JSON.stringify({ clicked: true });
})()`;

/** 在搜索框输入（找带 placeholder 的搜索 input） */
function setSearch(q) {
    return `(() => {
        const inp = [...document.querySelectorAll('input')].find(i => /搜索|检索|search/i.test(i.placeholder || ''));
        if (!inp) return JSON.stringify({ ok: false, reason: 'search-input-not-found' });
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(q)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return JSON.stringify({ ok: true, q: ${JSON.stringify(q)} });
    })()`;
}

/** 切到「全部」分组 */
const CLICK_ALL = `(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^(📁\\s*)?全部$/.test((e.textContent || '').trim()));
    if (!el) return JSON.stringify({ ok: false });
    el.click();
    return JSON.stringify({ ok: true });
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(1500);

    // 等首屏加载完（卡片列表出现计数）
    console.log('等首屏加载…');
    const t0 = Date.now();
    let initial = null;
    while (Date.now() - t0 < 180000) {
        const s = await run(LIST_STATE);
        if (s && s.headerCount !== null && s.headerCount !== undefined) { initial = s; break; }
        await wait(1000);
    }
    if (!initial) { console.log('❌ 首屏未就绪'); process.exit(1); }

    const R = { steps: [] };
    const record = (name, state, verdict, note) => {
        R.steps.push({ name, headerCount: state.headerCount, renderedRows: state.renderedRows, dupCardGroups: state.dupCardGroups, sameNameOnly: state.sameNameOnlyGroups, verdict, note: note || '' });
        console.log(`  [${verdict}] ${name}: 计数=${state.headerCount} 渲染行=${state.renderedRows} 真重复组=${state.dupCardGroups} 仅同名组=${state.sameNameOnlyGroups}${note ? '  ' + note : ''}`);
    };

    console.log('\n===== ① 首屏（PK-02：库不该为空） =====');
    record('首屏', initial, initial.headerCount > 0 ? 'PASS' : 'FAIL', initial.headerCount === 0 ? '库为空 → 疑似 PK-02' : '');

    console.log('\n===== ② 刷新 ×5（DF-08/DF-09/PK-02：不该重复、不该丢库） =====');
    for (let i = 1; i <= 5; i++) {
        const c = await run(CLICK_REFRESH);
        if (!c.clicked) { console.log('  ⚠️ 未找到刷新按钮:', c.reason); break; }
        await wait(3500);
        const s = await run(LIST_STATE);
        const bad = s.headerCount === 0 || s.headerCount > initial.headerCount * 2;
        record(`刷新#${i}`, s, bad ? 'FAIL' : 'PASS', s.headerCount === 0 ? '库消失→PK-02' : (s.headerCount > initial.headerCount * 2 ? '数量翻倍→DF-08/09' : ''));
    }

    console.log('\n===== ③ 搜索 ×5（PK-01：搜索后不该出现重复） =====');
    await run(CLICK_ALL);
    await wait(800);
    const queries = ['a', '小', 's', '的', '1'];
    for (const q of queries) {
        const r = await run(setSearch(q));
        if (!r.ok) { console.log('  ⚠️ 未找到搜索框'); break; }
        await wait(1600);
        const s = await run(LIST_STATE);
        const bad = s.dupCardGroups > 0;
        record(`搜索"${q}"`, s, bad ? 'FAIL' : 'PASS', bad ? '同一张卡重复→PK-01' : '（物理重名 ' + s.sameNameOnlyGroups + ' 组，属正常）');
    }

    console.log('\n===== ④ 搜索状态下刷新（PK-01 原始复现路径） =====');
    await run(setSearch('a'));
    await wait(1200);
    const c2 = await run(CLICK_REFRESH);
    if (c2.clicked) {
        await wait(4000);
        const s = await run(LIST_STATE);
        const bad = s.dupCardGroups > 0 || s.headerCount === 0;
        record('搜索中刷新', s, bad ? 'FAIL' : 'PASS', bad ? 'PK-01 复现路径异常' : '');
    }

    // 收尾：清空搜索
    await run(setSearch(''));
    await wait(1000);

    console.log('\n===== 汇总 =====');
    const fails = R.steps.filter((s) => s.verdict === 'FAIL');
    console.log(`  步骤 ${R.steps.length} 个，失败 ${fails.length} 个`);
    if (fails.length) { console.log('  失败项:'); fails.forEach((f) => console.log(`    - ${f.name}: ${f.note}`)); }
    console.log(fails.length ? '\n❌ 发现回归' : '\n✅ PK-01 / PK-02 / DF-08 / DF-09 未复活');
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
