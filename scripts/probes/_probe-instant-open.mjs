/**
 * ⚡ 秒开验证：世界书库加载是否达到「和角色卡一样秒开」
 *
 * 用法：node scripts/probes/_probe-instant-open.mjs <目录> <预期有效书数>
 *
 * 对比基线（本机实测，1001 本 / 6.97GB）：
 *   读全部文件内容 + parse ≈ 36.0s
 *   只 readdir + stat       ≈ 0.043s
 *
 * 测：
 *   ① 阶段 1（fastListOnly）耗时 —— 必须**远低于 1s**（目标「秒开」）
 *   ② 列表是否**立即**可用（条数 / 文件名作书名 / 词条数待补）
 *   ③ 阶段 2（元数据补齐）耗时 —— 后台进行，不阻塞首屏
 *   ④ 二次进入（缓存命中）是否**更快**
 *   ⑤ 秒开后 UI 是否正常（侧栏 / 书名 / 词条徽标 / 搜索）
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';
const EXPECT = Number(process.argv[3] || 0);

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
const ev = async (expr, t = 1800000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

// ── 首次：走完整流程（秒开 + 后台补全）──
const first = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    const t0 = performance.now();
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    const totalMs = Math.round(performance.now() - t0);
    const list = ctx.worldbooks.value;
    return {
        totalMs,
        count: list.length,
        // 书名是否已补全（wbName 非空的比例）
        named: list.filter(w => w.wbName).length,
        // 词条数是否已补全
        counted: list.filter(w => typeof w.entryCount === 'number').length,
        metaPending: list.filter(w => w.metaPending).length,
        sample: list.slice(0, 3).map(w => ({ name: w.wbName, ec: w.entryCount, file: w.name })),
        aside: document.querySelectorAll('aside').length,
        asideLen: (document.querySelector('aside') || {}).innerHTML ? document.querySelector('aside').innerHTML.length : 0,
        hasSearch: !!document.querySelector('input[placeholder*="搜索世界书"]')
    };
})()`, 1800000);
info('首次完整流程', `${(first.totalMs / 1000).toFixed(1)}s，入库 ${first.count} 本`);
info('元数据补全', `书名 ${first.named}/${first.count}，词条数 ${first.counted}/${first.count}，仍待补 ${first.metaPending}`);
info('书名抽样', JSON.stringify(first.sample));

// ── 只测阶段 1（秒开）耗时 ──
const fast = await ev(`(async () => {
    const t0 = performance.now();
    const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)}, { fastListOnly: true });
    const ms = Math.round(performance.now() - t0);
    const d = (r && r.data) || [];
    return { ms, count: d.length, withMeta: d.filter(x => x.entryCount !== null).length,
             sample: d.slice(0, 3).map(x => ({ n: x.wbName, ec: x.entryCount, f: x.name })) };
})()`, 600000);
info('⚡ 阶段 1（fastListOnly）', `${fast.ms}ms，列出 ${fast.count} 本，其中带元数据 ${fast.withMeta} 本`);
info('抽样', JSON.stringify(fast.sample));

// ── 阶段 2（元数据）耗时 ──
const meta = await ev(`(async () => {
    const all = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)}, { fastListOnly: true });
    const paths = ((all && all.data) || []).filter(x => x.metaPending).map(x => x.path);
    if (!paths.length) return { ms: 0, count: 0, note: '全部缓存命中（0 次读盘）' };
    const t0 = performance.now();
    const r = await window.electronAPI.fetchWorldbookMeta(paths);
    return { ms: Math.round(performance.now() - t0), count: ((r && r.data) || []).length };
})()`, 1800000);
info('阶段 2（元数据补齐）', meta.note || `${(meta.ms / 1000).toFixed(1)}s，补全 ${meta.count} 本`);

// ── 二次秒开（缓存应全命中）──
const second = await ev(`(async () => {
    const t0 = performance.now();
    const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)}, { fastListOnly: true });
    const ms = Math.round(performance.now() - t0);
    const d = (r && r.data) || [];
    return { ms, count: d.length, withMeta: d.filter(x => x.entryCount !== null).length };
})()`, 600000);
info('⚡ 二次秒开（缓存命中）', `${second.ms}ms，带元数据 ${second.withMeta}/${second.count} 本`);

const mem = await ev(`(() => { const m = performance.memory || {}; return { usedMB: Math.round((m.usedJSHeapSize||0)/1048576), limitMB: Math.round((m.jsHeapSizeLimit||0)/1048576) }; })()`);
info('渲染堆', `${mem.usedMB}MB / 上限 ${mem.limitMB}MB`);

console.log('\n═════ 秒开验证结果 ═════');
check('⚡ 阶段 1 达到「秒开」（< 1000ms）', fast.ms < 1000, `${fast.ms}ms`);
check('阶段 1 列出全部书', fast.count === first.count, `${fast.count} vs ${first.count}`);
if (EXPECT) check(`入库数 = 磁盘有效数 ${EXPECT}`, first.count === EXPECT, `实际 ${first.count}`);
check('元数据已补全（书名）', first.named === first.count, `${first.named}/${first.count}`);
check('元数据已补全（词条数）', first.counted === first.count, `${first.counted}/${first.count}`);
check('二次秒开缓存命中（带元数据）', second.withMeta === second.count, `${second.withMeta}/${second.count}`);
check('二次秒开更快或相当', second.ms <= fast.ms + 200, `${second.ms}ms vs ${fast.ms}ms`);
check('侧栏正常渲染', first.aside > 0 && first.asideLen > 500, `aside=${first.aside}，${first.asideLen} 字符`);
check('搜索框存在', first.hasSearch);
check('内存未逼近上限', mem.usedMB < mem.limitMB * 0.7, `${mem.usedMB}MB = ${(mem.usedMB / mem.limitMB * 100).toFixed(1)}%`);
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|out of memory|before initialization/i.test(t));
check('无渲染期错误 / OOM', bad.length === 0, bad.slice(0, 2).join(' | ') || '无');

const pass = results.filter(r => r.ok).length;
console.log(`\n═════ ${pass}/${results.length} 通过 ═════`);
console.log(`⚡ 阶段 1：${fast.ms}ms ｜ 阶段 2：${meta.note || (meta.ms / 1000).toFixed(1) + 's'} ｜ 二次秒开：${second.ms}ms`);
console.log(`对比：读全部内容 ≈ 36.0s（1001 本）`);
process.exit(pass === results.length ? 0 : 1);
