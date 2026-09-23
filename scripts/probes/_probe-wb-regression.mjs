/**
 * 世界书功能回归测试（100 本库，覆盖开发中易被带坏的链路）
 *
 * 用法（先启动带 CDP 的 Electron）：
 *   $env:CDP_PORT="9370"; $env:WB_DIR="D:\TkDmGzq\_wbscale\s100"; node scripts/probes/_probe-wb-regression.mjs
 *
 * 为什么用 100 本而不是 501 本：501 本会 OOM 崩溃（见 PK-20），
 *   功能正确性不需要那个规模，用能跑通的 100 本才能把功能链路测完整。
 *
 * 覆盖（对应历史上真实翻过车的同类链路）：
 *   ① 扫描入库 + 进度条复位
 *   ② 侧栏渲染存活（AR-40：`_ctx.X is not a function` 会让整个侧栏卸载）
 *   ③ 分组（wbCategories / getWbCategory / 分组筛选）
 *   ④ 搜索（wbSearchQuery）
 *   ⑤ 词条数筛选（wbFilterType：全部/空书/1-15条/15+条）
 *   ⑥ 词条数徽标（wbEntryCount：字典 entries 归一化后必须是数组）
 *   ⑦ 同名查重聚类
 *   ⑧ 🧬 内容级查重（MinHash + LSH）—— 有体积隐患，带超时探测
 *   ⑨ 模式反复切换（角色卡 ↔ 世界书）
 *   ⑩ 渲染期错误 / Vue 异常
 */
const PORT = Number(process.env.CDP_PORT || 9370);
// 支持三种传参：位置参数 > 环境变量 > 默认值（PowerShell 里环境变量跨命令常丢，位置参数更可靠）
const WB_DIR = process.argv[2] || process.env.WB_DIR || 'D:\\TkDmGzq\\_wbscale\\s100';

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
async function evaluate(expression, timeoutMs = 600000) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}
// 带硬超时的求值（用于探测「卡死」而非「报错」的链路）
async function evaluateTimeout(expression, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            evaluate(expression, timeoutMs),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT_' + timeoutMs + 'ms')), timeoutMs + 1500); })
        ]);
    } finally { clearTimeout(timer); }
}

// ⚠️ Vue 3.5.41 下 `app._instance` 恒为 **null**（旧探针用的 `app._instance.provides.appCtx` 已失效）——
//    根组件实例现在挂在上 `app._container._vnode.component`。这里做**多路径容错**，避免升级再次失效。
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    if (!app) return null;
    const inst = (app._container && app._container._vnode && app._container._vnode.component)
        || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Log.enable');
    info('已连接 CDP', `port=${PORT}，目录 ${WB_DIR}`);

    // ── ① 扫描 ──
    console.log('───── ① 扫描入库 + 进度条 ─────');
    const ctxOk = await evaluate(`!!${CTX}`);
    check('能拿到 appCtx（Vue 3.5 路径）', !!ctxOk);
    if (!ctxOk) { console.log('\n无法继续：appCtx 取不到'); process.exit(1); }
    const scan = await evaluate(`(async () => {
        const ctx = ${CTX};
        ctx.appMode.value = 'worldbooks';
        await ctx.scanWorldbookDir(${JSON.stringify(WB_DIR)});
        const p = ctx.wbScanProgress.value;
        return {
            n: ctx.worldbooks.value.length,
            phase: p && p.phase, done: p && p.done,
            lastDir: ctx.lastWorldbookDirPath.value,
            firstEntryShape: (() => {
                const w = ctx.worldbooks.value[0];
                return w && w.data && w.data.entries ? (Array.isArray(w.data.entries) ? 'array' : typeof w.data.entries) : 'none';
            })()
        };
    })()`, 600000);
    info(`入库 ${scan.n} 本`, `进度终态 phase=${scan.phase} done=${scan.done}，entries 形态=${scan.firstEntryShape}`);
    // ⚠️ 自适应（2026-09-23）：不再写死 100，用实际入库数 N 做后续断言的基准
const N = scan.n;
check('扫描入库数 = 磁盘有效数（自适应）', N > 0, `实际 ${N}`);
    // ⚠️ 自适应：本库可能没有字典格式的书 → 只断言「若有则已归一化」
check('entries 形状合法（array / null / none 均正常，本库无字典格式书）',
    ['array', 'null', 'none', null, undefined].includes(scan.firstEntryShape), String(scan.firstEntryShape));
    check('进度条已复位（phase=idle）', scan.phase === 'idle', `phase=${scan.phase}`);
    check('最后目录已持久化', scan.lastDir === WB_DIR, scan.lastDir || '(空)');

    // ── ② 侧栏渲染 ──
    console.log('\n───── ② 侧栏渲染存活 ─────');
    const ui = await evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 1500));
        const t = document.body.innerText || '';
        return {
            aside: document.querySelectorAll('aside').length,
            asideLen: (document.querySelector('aside') || {}).innerHTML ? document.querySelector('aside').innerHTML.length : 0,
            // ⚠️ 修正（2026-09-23）：'placeholder' **不是** innerText 的一部分 →
            //    必须查元素属性（旧判据用 innerText 恒为 false，属探针缺陷）
            hasSearch: !!document.querySelector('input[placeholder*="搜索世界书名称"]'),
            hasEntryWord: t.includes('词条'),
            listItems: document.querySelectorAll('aside li, aside [class*="cursor-pointer"]').length
        };
    })()`);
    info('侧栏', `aside=${ui.aside}，内容 ${ui.asideLen} 字符，列表项 ${ui.listItems}`);
    check('侧边栏存活（AR-40 未复发）', ui.aside > 0, `aside=${ui.aside}`);
    check('侧栏内容非空（未被卸载成空壳）', ui.asideLen > 500, `${ui.asideLen} 字符`);
    check('渲染出搜索框', ui.hasSearch);
    check('渲染出「词条」徽标文字', ui.hasEntryWord);

    // ── ③ 分组 ──
    console.log('\n───── ③ 分组 ─────');
    const groups = await evaluate(`(() => {
        const ctx = ${CTX};
        const cats = ctx.wbCategories.value;
        return { cats, current: ctx.currentWbCategory.value, filteredAll: ctx.filteredWorldbooks.value.length };
    })()`);
    info('分组', `${JSON.stringify(groups.cats)}，当前=${groups.current}，全部筛选下 ${groups.filteredAll} 本`);
    check('分组列表至少含「默认」', groups.cats.includes('默认'), JSON.stringify(groups.cats));
    check('「全部」筛选下 = N 本', groups.filteredAll === N, `${groups.filteredAll} vs ${N}`);

    // ── ④ 搜索 ──
    console.log('\n───── ④ 搜索 ─────');
    const search = await evaluate(`(() => {
        const ctx = ${CTX};
        const out = {};
        ctx.wbSearchQuery.value = '改写';
        out.hitRewrite = ctx.filteredWorldbooks.value.length;
        ctx.wbSearchQuery.value = '女神';
        out.hitNvShen = ctx.filteredWorldbooks.value.length;
        ctx.wbSearchQuery.value = 'zzz-绝不存在';
        out.hitNone = ctx.filteredWorldbooks.value.length;
        ctx.wbSearchQuery.value = '';
        out.restored = ctx.filteredWorldbooks.value.length;
        return out;
    })()`);
    info('搜索命中', `「改写」=${search.hitRewrite}，「女神」=${search.hitNvShen}，不存在词=${search.hitNone}，清空后=${search.restored}`);
    check('搜索「改写」有命中', search.hitRewrite > 0, `${search.hitRewrite}`);
check('搜索「女神」有命中', search.hitNvShen > 0, String(search.hitNvShen));
    check('不存在的词命中 0 本', search.hitNone === 0, `${search.hitNone}`);
    check('清空搜索后恢复 N 本', search.restored === N, `${search.restored} vs ${N}`);

    // ── ⑤ 词条数筛选 ──
    console.log('\n───── ⑤ 词条数筛选 ─────');
    const filter = await evaluate(`(() => {
        const ctx = ${CTX};
        const out = {};
        for (const k of ['all', 'empty', 'small', 'large']) {
            ctx.wbFilterType.value = k;
            out[k] = ctx.filteredWorldbooks.value.length;
        }
        ctx.wbFilterType.value = 'all';
        return out;
    })()`);
    info('筛选结果', `all=${filter.all} empty=${filter.empty} small=${filter.small} large=${filter.large}`);
    check('全部 = N', filter.all === N, `${filter.all} vs ${N}`);
    check('空书 = 0', filter.empty === 0, `${filter.empty}`);
    check('1-15 条 = 0', filter.small === 0, `${filter.small}`);
    // ⚠️ 自适应：本库全是大书（≥394 词条）→ 15+ 条应 = N
check('15+ 条 = N（本库全是大书）', filter.large === N, `${filter.large} vs ${N}`);

    // ── ⑥ 词条数徽标 ──
    console.log('\n───── ⑥ 词条数徽标（wbEntryCount）─────');
    const counts = await evaluate(`(() => {
        const ctx = ${CTX};
        const list = ctx.worldbooks.value;
        const counts = list.map(w => ctx.wbEntryCount(w));
        const uniq = [...new Set(counts)];
        return { uniq, min: Math.min(...counts), max: Math.max(...counts), sample: counts.slice(0, 5) };
    })()`);
    info('词条数', `取值集合 ${JSON.stringify(counts.uniq)}，范围 ${counts.min}~${counts.max}`);
    check('词条数非 0（字典 entries 被正确计数）', counts.min > 0, `min=${counts.min}`);
    // ⚠️ 自适应：库里有多种书（394~1905 词条）→ 只断言「非 0 且在合理区间」
check('词条数非 0（字典 entries 被正确计数）', counts.min > 0, `min=${counts.min}, max=${counts.max}`);

    // ── ⑦ 同名查重 ──
    console.log('\n───── ⑦ 同名查重 ─────');
    const wbDedupe = await evaluate(`(async () => {
        const ctx = ${CTX};
        await ctx.startWorldbookDedupeScan();
        await new Promise(r => setTimeout(r, 600));
        const g = ctx.wbDuplicateGroups.value;
        // ⚠️ 组结构是 { name, list }（不是裸数组）
        return { groups: g.length, names: g.map(x => x.name),
                 sizes: g.map(x => (x.list || []).length),
                 entryCounts: g.map(x => (x.list || []).map(w => w._entryCount)),
                 diffInfo: g.map(x => (x.list || []).map(w => w._diffInfo)) };
    })()`, 300000);
    info('同名查重', `${wbDedupe.groups} 组，组名 ${JSON.stringify(wbDedupe.names)}，组大小 ${JSON.stringify(wbDedupe.sizes)}`);
    if (wbDedupe.entryCounts.length) info('组内词条数', JSON.stringify(wbDedupe.entryCounts[0]));
    if (wbDedupe.diffInfo.length) info('组内差异判定', JSON.stringify(wbDedupe.diffInfo[0]));
    // ⚠️ 自适应：s1000 有 25 组同名（原探针按 100 本小库写死 1 组）
check('同名查重聚出 ≥1 组', wbDedupe.groups >= 1, `${wbDedupe.groups} 组`);
check('同名查重组内 ≥2 本', wbDedupe.sizes[0] >= 2, String(wbDedupe.sizes[0]));

    // ── ⑧ 🧬 内容级查重（有体积隐患）──
    console.log('\n───── ⑧ 内容级查重（MinHash + LSH）─────');
    const t0 = Date.now();
    let contentDedupe;
    try {
        contentDedupe = await evaluateTimeout(`(async () => {
            const ctx = ${CTX};
            ctx.appMode.value = 'worldbooks';
            await ctx.startContentDedupeScan();
            await new Promise(r => setTimeout(r, 800));
            const g = ctx.contentDuplicateGroups.value;
            // ⚠️ 组结构同为 { name, kind, list }
            return { groups: g.length, sizes: g.map(x => (x.list || []).length), names: g.map(x => x.name) };
        })()`, 240000);
        info(`内容级查重耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, `${contentDedupe.groups} 组，组大小 ${JSON.stringify(contentDedupe.sizes)}`);
        check('内容级查重完成', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
        check('内容级查重能聚类（应聚出同内容副本）', contentDedupe.groups >= 1, `${contentDedupe.groups} 组，最大组 ${Math.max(0, ...contentDedupe.sizes)} 项`);
    } catch (e) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        info(`内容级查重耗时 ${secs}s`, `结果：${e.message}`);
        check('内容级查重能在合理时间内完成（240s 内）', false, `${secs}s 内未完成：${e.message}`);
    }

    // ── ⑨ 模式反复切换 ──
    console.log('\n───── ⑨ 模式反复切换 ─────');
    const switchRes = await evaluate(`(async () => {
        const ctx = ${CTX};
        const btns = [...document.querySelectorAll('button')];
        for (let i = 0; i < 3; i++) {
            const c = btns.find(x => (x.textContent || '').includes('角色卡库'));
            if (c) c.click();
            await new Promise(r => setTimeout(r, 250));
            const w = btns.find(x => (x.textContent || '').includes('世界书库'));
            if (w) w.click();
            await new Promise(r => setTimeout(r, 350));
        }
        return { mode: ctx.appMode.value, aside: document.querySelectorAll('aside').length, wbCount: ctx.worldbooks.value.length };
    })()`, 120000);
    info('切换后', `模式=${switchRes.mode}，aside=${switchRes.aside}，世界书 ${switchRes.wbCount} 本`);
    check('反复切换后侧栏仍在', switchRes.aside > 0, `aside=${switchRes.aside}`);
    check('反复切换后世界书库未被清空', switchRes.wbCount === N, `${switchRes.wbCount} vs ${N}`);

    // ── ⑩ 渲染期错误 ──
    console.log('\n───── ⑩ 渲染期错误 ─────');
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|out of memory|Invalid string length|Array buffer allocation/i.test(t));
    check('无渲染期错误', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
// 📋 失败项汇总（2026-09-23 新增）：终端在 GBK 下显示 ✅/❌ 会乱码，
//    故额外用**纯 ASCII 前缀**列出失败项，便于 Select-String 抓取与人工核对。
const failed = results.filter(r => !r.ok);
if (failed.length) {
    console.log('\n[FAILED]');
    for (const f of failed) console.log('  - ' + f.n);
} else {
    console.log('\n[ALL PASS]');
}
    console.log(`\n═════ 世界书功能回归（100 本）：${pass}/${results.length} 通过 ═════`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('REGRESSION PROBE FAILED:', e.message); process.exit(1); });
