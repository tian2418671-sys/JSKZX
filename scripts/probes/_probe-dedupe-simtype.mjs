/**
 * 端到端验证：相似类型判定是否在真实库上产出正确标签（2026-09-23）
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-dedupe-simtype.mjs [世界书目录]
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'H:\\01\\全局世界书';

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errs = [];
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

console.log('═════ 相似类型判定 · 端到端验证 ═════');
console.log(`目录：${DIR}\n`);

const out = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 2000));
    await ctx.startContentDedupeScan();
    await new Promise(r => setTimeout(r, 1500));
    const groups = ctx.contentDuplicateGroups.value || [];
    return {
        libCount: ctx.worldbooks.value.length,
        groups: groups.length,
        detail: groups.map(g => ({
            name: g.name,
            items: (g.list || []).map(v => ({
                name: v._name,
                simPct: v._simPct,
                keysPct: v._keysSimPct,
                hamming: v._hamming,
                penalty: v._lenPenalty,
                score: v._score,
                type: v._simType,
                label: v._simLabel,
                tone: v._simTone,
                advice: v._simAdvice,
                textLen: v.textLen
            }))
        }))
    };
})()`, 1800000);

console.log(`库：${out.libCount} 本 ｜ 分组：${out.groups} 组\n`);
let missing = 0, total = 0;
out.detail.forEach((g, i) => {
    console.log(`───── 第 ${i + 1} 组：『${g.name}』 ${g.items.length} 本 ─────`);
    g.items.forEach((it, j) => {
        total++;
        const isMaster = j === 0;
        const tag = it.label ? `${it.label}` : '（基准版，不标类型）';
        if (!isMaster && !it.label) missing++;
        const fmt = (v, digits = 3) => (v === null || v === undefined) ? '-' : Number(v).toFixed(digits);
        console.log(`  [${j}] ${it.name}`);
        console.log(`      长度=${String(it.textLen).padStart(7)} ｜ 内容重合=${it.simPct}% ｜ 触发词重合=${isMaster ? '（基准版）' : (it.keysPct === null || it.keysPct === undefined ? '无索引' : it.keysPct + '%')}`);
        console.log(`      类型=${tag} ｜ 指纹距离=${it.hamming} ｜ 长度惩罚=${fmt(it.penalty)} ｜ 综合分=${fmt(it.score)}`);
        if (it.advice && !isMaster) console.log(`      💡 ${it.advice}`);
    });
    console.log('');
});
console.log(`【覆盖率】${total} 个条目中，非基准版缺类型标签的：${missing} 个  →  ${missing === 0 ? '✅ 全部标注' : '❌ 有遗漏'}`);
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|out of memory/i.test(t));
console.log(bad.length === 0 ? '✅ 无渲染期错误' : '❌ 错误：' + bad.slice(0, 3).join(' | '));
process.exit(0);
