/**
 * 验证「流式提取」修复：内容级查重现在能覆盖懒加载的书
 *
 * 用法：node scripts/probes/_probe-content-dedupe-fix.mjs [目录] [预期有效书数]
 *
 * 修复前：1001 本库里 944 本未内联 → 内容级查重候选 **0/944**（对 94% 的书失效）
 * 修复后：应能提取绝大多数书（流式：读一本 → 提取 → 立即释放正文，避免 40GB 常驻）
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';

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

const out = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    if (!ctx.worldbooks.value.length) await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 1500));
    const before = ctx.worldbooks.value.length;
    const beforeNoData = ctx.worldbooks.value.filter(w => w.dataLoaded === false).length;
    const memBefore = Math.round((performance.memory || {}).usedJSHeapSize / 1048576);

    // 走**真实**内容级查重入口（内含流式提取）
    const t0 = performance.now();
    await ctx.startContentDedupeScan();
    const ms = Math.round(performance.now() - t0);
    const memAfter = Math.round((performance.memory || {}).usedJSHeapSize / 1048576);
    const groups = ctx.contentDuplicateGroups.value;

    // 提取后：书应**恢复懒加载态**（正文被释放），否则 5000 本会 OOM
    const afterNoData = ctx.worldbooks.value.filter(w => w.dataLoaded === false).length;

    return {
        before, beforeNoData, afterNoData,
        ms, groups: groups.length,
        groupSizes: groups.slice(0, 5).map(g => (g.list || []).length),
        totalGrouped: groups.reduce((s, g) => s + (g.list || []).length, 0),
        memBefore, memAfter,
        logs: ctx.editorLogs.value.slice(0, 6).map(x => x.msg || '')
    };
})()`, 1800000);

console.log(`库：${out.before} 本（扫描后未内联 ${out.beforeNoData} 本）`);
console.log(`内容级查重耗时：${(out.ms / 1000).toFixed(1)}s`);
console.log(`分组：${out.groups} 组，前 5 组大小 ${JSON.stringify(out.groupSizes)}，参与聚类的书共 ${out.totalGrouped} 本`);
console.log(`内存：${out.memBefore}MB → ${out.memAfter}MB`);
console.log(`查重后仍未内联：${out.afterNoData} 本（应 ≈ 全部懒加载书 → 证明正文被及时释放）`);
console.log('\n日志：');
for (const s of out.logs) console.log('  ' + s);
console.log(`\n⇒ ${out.groups > 0 ? '✅ 内容级查重已能覆盖懒加载的书（修复生效）' : '❌ 仍无分组'}`);
console.log(`⇒ ${out.afterNoData >= out.beforeNoData ? '✅ 正文已及时释放（内存安全）' : '⚠️ 有书仍持有正文'}`);
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|out of memory|before initialization/i.test(t));
console.log(`⇒ ${bad.length === 0 ? '✅ 无渲染期错误 / OOM' : '❌ 有错误：' + bad.slice(0, 2).join(' | ')}`);
process.exit(0);
