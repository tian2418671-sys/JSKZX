/**
 * 核实 501 本压测中 3 个「失败项」是否为真缺陷（而非探针假设过期）
 *
 * 用法：node scripts/probes/_probe-wb-verify3.mjs [目录]
 *
 * 3 个疑点：
 *   ① 「>50MB 超巨书走懒加载」断言 `noData === 1` 失败（实际 445）
 *      → 预期：现在有 445 本因**累计预算**转懒加载，不止超巨书。断言口径过期。
 *   ② 「世界书视图渲染出搜索框」失败（bodyLen 仅 370）
 *      → 预期：501 本列表 + 分页可能让侧栏渲染变慢/搜不到该文案。需确认 UI 是否真坏。
 *   ③ 「搜索有命中结果」失败
 *      → 预期：探针搜「改写」，但该库有改写变体；需确认搜索结果是否真的为空。
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb500';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = list.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
const ev = async (expr, t = 900000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const DIR_LIT = JSON.stringify(DIR);

// 先正常扫描建白名单，再加载进 UI
const out = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${DIR_LIT});
    await new Promise(r => setTimeout(r, 2500));
    const list = ctx.worldbooks.value;
    const txt = document.body.innerText || '';
    const aside = document.querySelector('aside');
    const asideTxt = aside ? (aside.innerText || '') : '';

    // ① 懒加载口径
    const noData = list.filter(w => w.dataLoaded === false).length;
    const withData = list.filter(w => w.dataLoaded === true).length;
    const noDataWithCount = list.filter(w => w.dataLoaded === false && typeof w.entryCount === 'number' && w.entryCount > 0).length;
    const noDataNullCount = list.filter(w => w.dataLoaded === false && w.entryCount === null).length;

    // ② 侧栏搜索框
    const searchInput = document.querySelector('input[placeholder*="搜索世界书"]');

    // ③ 搜索命中
    ctx.wbSearchQuery.value = '改写';
    await new Promise(r => setTimeout(r, 900));
    const hit = ctx.filteredWorldbooks.value.length;
    const hitNames = ctx.filteredWorldbooks.value.slice(0, 5).map(w => w.name);
    ctx.wbSearchQuery.value = '';

    // 词条数徽标（懒加载书是否显示数字）
    const badgeSample = list.filter(w => w.dataLoaded === false).slice(0, 3).map(w => ({ n: w.name, ec: w.entryCount, dl: w.dataLoaded }));

    return {
        total: list.length, noData, withData, noDataWithCount, noDataNullCount,
        searchInputFound: !!searchInput,
        asideHtmlLen: aside ? aside.innerHTML.length : 0,
        asideTxtLen: asideTxt.length,
        bodyTxtLen: txt.length,
        hasSearchPlaceholderText: txt.includes('搜索世界书名称'),
        hasAsideSearchPlaceholderText: asideTxt.includes('搜索世界书名称'),
        hit, hitNames,
        badgeSample,
        // 侧栏里可见的世界书卡片数（分页）
        visibleCards: aside ? aside.querySelectorAll('[class*="rounded-lg border"]').length : 0,
        sidebarPagingText: (asideTxt.match(/\\d+\\s*\\/\\s*\\d+/) || [])[0] || null
    };
})()`);

console.log('=== ① 懒加载口径 ===');
console.log(`  总 ${out.total} 本：已载入正文 ${out.withData} / 未载入 ${out.noData}`);
console.log(`  未载入中「有准确词条数」${out.noDataWithCount} / 「entryCount=null」${out.noDataNullCount}`);
console.log(`  ⇒ ${out.noDataNullCount === 0 ? '✅ 所有书都有准确词条数（不再显示 0 词条）' : '❌ 仍有 ' + out.noDataNullCount + ' 本词条数为 null'}`);
console.log(`  ⇒ 超巨书(>50MB) 只 1 本，但懒加载 ${out.noData} 本 —— 探针断言「=== 1」口径已过期（预算机制会转更多）`);

console.log('\n=== ② 世界书视图搜索框 ===');
console.log(`  input[placeholder*="搜索世界书"] 找到：${out.searchInputFound}`);
console.log(`  侧栏 innerText 含「搜索世界书名称」：${out.hasAsideSearchPlaceholderText}`);
console.log(`  body innerText 含「搜索世界书名称」：${out.hasSearchPlaceholderText}`);
console.log(`  侧栏 HTML ${out.asideHtmlLen} 字符 / 文本 ${out.asideTxtLen} 字符，可见卡片 ${out.visibleCards} 个，分页 ${out.sidebarPagingText}`);
console.log(`  ⇒ ${out.searchInputFound ? '✅ 搜索框存在（探针用 body.innerText 判据不可靠）' : '❌ 搜索框真的不存在'}`);

console.log('\n=== ③ 搜索命中 ===');
console.log(`  搜「改写」命中 ${out.hit} 本：${JSON.stringify(out.hitNames)}`);
console.log(`  ⇒ ${out.hit > 0 ? '✅ 搜索正常（探针断言失败是判据问题）' : '❌ 搜索真的没命中'}`);

console.log('\n=== 词条数徽标抽样（未载入正文的书）===');
for (const b of out.badgeSample) console.log(`  ${b.n}: entryCount=${b.ec}, dataLoaded=${b.dl}`);

process.exit(0);
