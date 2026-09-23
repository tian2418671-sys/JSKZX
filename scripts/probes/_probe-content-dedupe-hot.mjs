/**
 * 热测试：内容查重（S3' simhash）端到端（2026-09-23）
 *
 * 验：内容级查重在真实库上能完成、出结果、耗时受控、无 OOM/错误。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-content-dedupe-hot.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-content-dedupe-hot.mjs "<目录>"'); process.exit(1); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text || '');
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable'); await send('Log.enable');
const ev = async (expr, t = 3600000) => {
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

console.log('═════ 热测试：内容查重（S3\' simhash）═════');
console.log(`目录：${DIR}`);
console.log('');

// 先确保库已加载
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    if (!ctx.worldbooks.value.length) await ctx.scanWorldbookDir(${DIR_LIT});
    return ctx.worldbooks.value.length;
})()`);

const mem0 = await ev(`Math.round(((performance.memory||{}).usedJSHeapSize||0)/1048576)`);
console.log(`查重前堆：${mem0}MB`);

const r = await ev(`(async () => {
    const ctx = ${CTX};
    const t0 = performance.now();
    await ctx.startContentDedupeScan();
    await new Promise(x => setTimeout(x, 1500));
    return {
        ms: Math.round(performance.now() - t0),
        groups: ctx.contentDuplicateGroups.value.length,
        grouped: ctx.contentDuplicateGroups.value.reduce((s, g) => s + (g.list || []).length, 0),
        // 抽样：确认相似度与汉明距离字段有值（S3' 路径）
        sample: ctx.contentDuplicateGroups.value.slice(0, 2).map(g => ({
            name: g.name,
            len: (g.list || []).length,
            sims: (g.list || []).slice(0, 3).map(v => v._simPct),
            ham: (g.list || []).slice(0, 3).map(v => v._hamming)
        })),
        // simhash 是否来自落盘（P1-1；默认关闭 → 应为 false）
        fromL1b: ctx.worldbooks.value.filter(w => Array.isArray(w.simhash)).length
    };
})()`, 3600000);

const mem1 = await ev(`Math.round(((performance.memory||{}).usedJSHeapSize||0)/1048576)`);

console.log(`内容查重耗时：**${(r.ms / 1000).toFixed(1)}s**`);
console.log(`结果：**${r.groups} 组**，参与 ${r.grouped} 本`);
console.log(`simhash 落盘覆盖（P1-1）：${r.fromL1b} 本（默认关闭应为 0）`);
console.log(`查重后堆：${mem1}MB（${mem1 - mem0 >= 0 ? '+' : ''}${mem1 - mem0}MB）`);
if (r.sample.length) {
    console.log('样本组：');
    for (const s of r.sample) {
        console.log(`   · ${s.name}（${s.len} 本）相似度 ${JSON.stringify(s.sims)}% 汉明距离 ${JSON.stringify(s.ham)}`);
    }
}
console.log('');

const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|out of memory|before initialization/i.test(t));
const checks = [
    ['内容查重出结果', r.groups > 0, `${r.groups} 组`],
    ['耗时受控（< 300s）', r.ms < 300000, `${(r.ms / 1000).toFixed(1)}s`],
    ['相似度字段有值（S3\' 路径生效）', r.sample.every(s => s.sims.some(v => typeof v === 'number')), JSON.stringify(r.sample[0] ? r.sample[0].sims : [])],
    ['汉明距离字段有值（simhash 专用）', r.sample.every(s => s.ham.some(v => typeof v === 'number')), JSON.stringify(r.sample[0] ? r.sample[0].ham : [])],
    ['堆未失控（< 50% 上限）', mem1 < 4192 * 0.5, `${mem1}MB / 4192MB`],
    ['无渲染期错误 / OOM', bad.length === 0, bad.slice(0, 2).join(' | ') || '无']
];
let pass = 0;
console.log('───── 断言 ─────');
for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}  → ${detail}`);
    if (ok) pass++;
}
console.log('');
console.log(`═════ 结果：${pass}/${checks.length} 通过 ═════`);
process.exit(pass === checks.length ? 0 : 1);
