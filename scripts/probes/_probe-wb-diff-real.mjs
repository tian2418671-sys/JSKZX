/**
 * 世界书「差异着色」真实数据端到端验证
 *
 * 用法（先启动带 CDP 的 Electron）：
 *   $env:CDP_PORT="9370"; $env:WB_DIR="D:\TkDmGzq\_wbdiff"; node scripts/probes/_probe-wb-diff-real.mjs
 *
 * 背景：本次新提交（9fcf09c）给「词条正文对比」加了**行级对齐 + 行内精确高亮**
 *   （js/utils/textDiff.js + DiffModal.vue）。既有 `_probe-diff-coloring.mjs` 用的是
 *   **手工构造的迷你数据**（3~4 条词条）；本探针改用**真实大世界书**（397 词条 / 6.5MB）
 *   与其 4 个改写变体，验证在真实规模下着色是否仍然正确、且不卡死。
 *
 * 目录构成（D:\TkDmGzq\_wbdiff）：
 *   根：炎孕-异世界工口学院物语-威力加强版 世界书.json        ← 基准（同时是顶层指纹文件）
 *   sub：同名基准副本 + 炎孕-改写A/B/C/D.json
 *
 * 断言：
 *   ① 扫描入库 6 本（含同名跨目录 2 本）
 *   ② 同名查重能聚成 1 组、组内 2 本
 *   ③ 差异弹窗在**真实 397 词条**下能打开且不卡死（每例限时）
 *   ④ 改写A（改正文）→ 出现「正文有改动」+ 变更行底色 + 行内高亮段
 *   ⑤ 改写B（增词条）→ 出现 [新增] 标记 + 绿色行底
 *   ⑥ 改写C（删词条）→ 出现 [缺失] 标记 + 红色行底
 *   ⑦ 改写D（改 key + 中段插删行）→ 触发词着色 + 变更行
 *   ⑧ 基准 vs 基准副本 → 完全一致，无任何高亮（**假阳性检查**）
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const WB_DIR = process.env.WB_DIR || 'D:\\TkDmGzq\\_wbdiff';
const A_NAME = '炎孕-异世界工口学院物语-威力加强版 世界书.json';

let sock; let msgId = 0; const pending = new Map();
const consoleErrors = [];

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res; sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
            if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text || '');
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression, timeoutMs = 300000) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => { console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`); };

// 差异弹窗渲染快照：统计各类底色/高亮段的实际数量（DOM 取证，不依赖组件内部状态）
const SNAP = `(() => {
    const all = document.querySelectorAll('*');
    const count = (cls) => { let n = 0; for (const el of all) if (el.className && typeof el.className === 'string' && el.className.includes(cls)) n++; return n; };
    const t = document.body.innerText || '';
    return {
        opened: t.includes('数据版本差异深度比对'),
        hasAlign: t.includes('词条级对齐'),
        hasAddedTag: t.includes('[新增]'),
        hasMissingTag: t.includes('[缺失]'),
        hasChangedBadge: t.includes('正文有改动'),
        hasSameBadge: t.includes('完全一致') || t.includes('无差异'),
        rowRemoved: count('bg-rose-950/40'),
        rowAdded: count('bg-emerald-950/40'),
        rowChanged: count('bg-amber-950/25'),
        hlRemoved: count('bg-rose-500/40'),
        hlAdded: count('bg-emerald-500/40'),
        hlChanged: count('bg-amber-500/35'),
        keyRose: count('bg-rose-900/50'),
        keyEmerald: count('bg-emerald-900/50'),
        bodyLen: t.length
    };
})()`;

// 打开差异弹窗：走 App 的真实 ctx 入口（与 UI 同一条链路）
const openDiff = (aPath, bPath) => `(async () => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const ctx = app && app._instance && app._instance.provides && app._instance.provides.appCtx;
    if (!ctx || typeof ctx.openDiffDetailModal !== 'function') return { ok: false, err: 'no ctx.openDiffDetailModal' };
    const list = ctx.worldbooks ? ctx.worldbooks.value : null;
    if (!list) return { ok: false, err: 'no ctx.worldbooks' };
    const find = (p) => list.find(w => (w.path || '').replace(/\\\\/g, '/').toLowerCase().endsWith(p.toLowerCase()));
    const a = find(${JSON.stringify(aPath)});
    const b = find(${JSON.stringify(bPath)});
    if (!a || !b) return { ok: false, err: 'not found: ' + (!a ? 'A' : 'B'), total: list.length };
    const t0 = performance.now();
    ctx.openDiffDetailModal(a, b);
    await new Promise(r => setTimeout(r, 700));
    return { ok: true, ms: Math.round(performance.now() - t0), aEntries: (a.data && a.data.entries || []).length, bEntries: (b.data && b.data.entries || []).length };
})()`;

// 关闭差异弹窗：该弹窗没有 close 函数，由 App 的 showDiffDetailModal ref 控制
const closeDiff = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const ctx = app && app._instance && app._instance.provides && app._instance.provides.appCtx;
    if (ctx && ctx.showDiffDetailModal) ctx.showDiffDetailModal.value = false;
    return true;
})()`;

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Log.enable');
    info('已连接 CDP', `port=${PORT}`);

    // ── ① 扫描真实目录 ──
    console.log('\n───── ① 扫描真实差异测试目录 ─────');
    const scan = await evaluate(`(async () => {
        const t0 = performance.now();
        const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(WB_DIR)});
        const data = (r && r.data) || [];
        return { ok: !!(r && r.success), ms: Math.round(performance.now() - t0), count: data.length,
                 error: r && r.error,
                 names: data.map(w => w.name),
                 sameName: data.filter(w => w.name === ${JSON.stringify(A_NAME)}).length,
                 entries: data.filter(w => w.name === ${JSON.stringify(A_NAME)}).map(w => (w.data && w.data.entries || []).length) };
    })()`, 300000);
    info(`扫描 ${scan.ms}ms`, `入库 ${scan.count} 本，同名基准 ${scan.sameName} 本，词条数 ${JSON.stringify(scan.entries)}`);
    check('扫描成功', scan.ok, scan.error || '');
    check('入库 6 本（1 根 + 5 sub）', scan.count === 6, `实际 ${scan.count}：${(scan.names || []).join(', ')}`);
    check('同名跨目录 2 本', scan.sameName === 2, `实际 ${scan.sameName}`);

    // 让渲染层的 worldbooks 拿到数据（走真实 UI 入口，确保 ctx 里是同一份）
    await evaluate(`(async () => {
        const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
        const ctx = app._instance.provides.appCtx;
        ctx.appMode.value = 'worldbooks';
        await ctx.scanWorldbookDir(${JSON.stringify(WB_DIR)});
        return true;
    })()`, 300000);
    const inCtx = await evaluate(`(() => {
        const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
        const ctx = app._instance.provides.appCtx;
        return { n: ctx.worldbooks.value.length, names: ctx.worldbooks.value.map(w => w.name) };
    })()`);
    info('渲染层世界书库', `${inCtx.n} 本`);
    check('渲染层 worldbooks 已装载 6 本', inCtx.n === 6, `实际 ${inCtx.n}`);

    // ── ② 同名查重（验证「改写变体不影响同名聚类」）──
    console.log('\n───── ② 同名查重 ─────');
    const dedupe = await evaluate(`(async () => {
        const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
        const ctx = app._instance.provides.appCtx;
        await ctx.startWorldbookDedupeScan();
        await new Promise(r => setTimeout(r, 500));
        return { groups: ctx.wbDuplicateGroups.value.length,
                 sizes: ctx.wbDuplicateGroups.value.map(g => g.length),
                 names: ctx.wbDuplicateGroups.value.map(g => g[0] && g[0].name) };
    })()`, 300000);
    info('同名查重结果', `${dedupe.groups} 组，组大小 ${JSON.stringify(dedupe.sizes)}`);
    check('同名查重聚出 1 组', dedupe.groups === 1, `${dedupe.groups} 组`);
    check('该组含 2 本同名世界书', dedupe.sizes[0] === 2, `实际 ${dedupe.sizes[0]}`);

    // ── ③~⑦ 逐个改写变体做差异比对 ──
    console.log('\n───── ③ 基准 vs 基准副本（假阳性检查）─────');
    await evaluate(closeDiff);
    const same = await evaluate(openDiff('sub/' + A_NAME, A_NAME));
    info('打开耗时', `${same.ms}ms`, `A ${same.aEntries} 条 / B ${same.bEntries} 条`);
    const snapSame = await evaluate(SNAP);
    check('差异弹窗打开（真实 397 词条）', snapSame.opened && same.ok, same.err || '');
    check('未渲染 [新增] / [缺失] 标记', !snapSame.hasAddedTag && !snapSame.hasMissingTag);
    check('未渲染「正文有改动」徽标', !snapSame.hasChangedBadge);
    check('无变更行底色（假阳性检查）', snapSame.rowRemoved === 0 && snapSame.rowAdded === 0 && snapSame.rowChanged === 0,
        `removed=${snapSame.rowRemoved} added=${snapSame.rowAdded} changed=${snapSame.rowChanged}`);
    check('无行内高亮段（假阳性检查）', snapSame.hlRemoved === 0 && snapSame.hlAdded === 0 && snapSame.hlChanged === 0,
        `rose=${snapSame.hlRemoved} emerald=${snapSame.hlAdded} amber=${snapSame.hlChanged}`);

    console.log('\n───── ④ 基准 vs 改写A（改正文）─────');
    await evaluate(closeDiff);
    const a = await evaluate(openDiff('sub/炎孕-改写A.json', A_NAME));
    info('打开耗时', `${a.ms}ms`, `A ${a.aEntries} 条 / B ${a.bEntries} 条`);
    const snapA = await evaluate(SNAP);
    check('出现「正文有改动」徽标', snapA.hasChangedBadge);
    check('出现变更行底色（琥珀）', snapA.rowChanged > 0, `${snapA.rowChanged} 行`);
    check('出现行内精确高亮段', snapA.hlChanged > 0, `${snapA.hlChanged} 段`);

    console.log('\n───── ⑤ 基准 vs 改写B（新增词条）─────');
    await evaluate(closeDiff);
    const b = await evaluate(openDiff('sub/炎孕-改写B.json', A_NAME));
    info('打开耗时', `${b.ms}ms`, `A ${b.aEntries} 条 / B ${b.bEntries} 条`);
    const snapB = await evaluate(SNAP);
    check('出现 [新增] 标记', snapB.hasAddedTag);
    check('出现绿色新增行底', snapB.rowAdded > 0, `${snapB.rowAdded} 行`);

    console.log('\n───── ⑥ 基准 vs 改写C（删除词条）─────');
    await evaluate(closeDiff);
    const c = await evaluate(openDiff('sub/炎孕-改写C.json', A_NAME));
    info('打开耗时', `${c.ms}ms`, `A ${c.aEntries} 条 / B ${c.bEntries} 条`);
    const snapC = await evaluate(SNAP);
    check('出现 [缺失] 标记', snapC.hasMissingTag);
    check('出现红色缺失行底', snapC.rowRemoved > 0, `${snapC.rowRemoved} 行`);

    console.log('\n───── ⑦ 基准 vs 改写D（改 key + 中段插删行）─────');
    await evaluate(closeDiff);
    const d = await evaluate(openDiff('sub/炎孕-改写D.json', A_NAME));
    info('打开耗时', `${d.ms}ms`, `A ${d.aEntries} 条 / B ${d.bEntries} 条`);
    const snapD = await evaluate(SNAP);
    check('出现「正文有改动」徽标', snapD.hasChangedBadge);
    check('出现变更行底色', snapD.rowChanged > 0, `${snapD.rowChanged} 行`);
    check('触发词着色生效（本侧独有标色）', snapD.keyRose > 0 || snapD.keyEmerald > 0,
        `rose=${snapD.keyRose} emerald=${snapD.keyEmerald}`);

    await evaluate(closeDiff);

    // ── ⑧ 渲染期错误 ──
    console.log('\n───── ⑧ 渲染期错误 ─────');
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|out of memory|Invalid string length/i.test(t));
    check('无渲染期错误', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 差异着色真实数据验证：${pass}/${results.length} 通过 ═════`);
    console.log(`弹窗打开耗时：同版 ${same.ms}ms ｜ 改写A ${a.ms}ms ｜ B ${b.ms}ms ｜ C ${c.ms}ms ｜ D ${d.ms}ms`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('DIFF PROBE FAILED:', e.message); process.exit(1); });
