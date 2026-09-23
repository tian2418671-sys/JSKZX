/**
 * 差异比对「对端新增」底色（emerald）未渲染 —— 真因取证（2026-09-23）
 *
 * 现象：`_probe-diff-coloring.mjs` 的 15 条断言中，唯一失败的是
 *   「变更行有『对端新增』底色（emerald）」，而 rose / amber 都正常。
 *
 * 数据（探针自造）：`mk(1)` 中 A = `[L_LAST, L_ONLY_OLD]`，B = `[L_LAST]`
 *   → 按对齐语义，A 多出的 `L_ONLY_OLD` 应是「**本端缺失**（rose）」
 *   → 反向（B 视角）才是「对端新增（emerald）」。
 *   ⚠️ 关键：**弹窗是「A 为基准、B 为对比」单向渲染**，还是**两侧都渲染**？
 *   若只渲染 A→B 方向，则**永远不会出现 emerald 行**（emerald 是 B 多出的行）。
 *
 * 本脚本直接 dump 渲染后的行底色分布，判定是「真缺陷」还是「探针数据假设错」。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-diff-emerald.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9370);

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
const ev = async (expr, t = 600000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};

const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

const L1 = '这是第一段内容，描述主角的背景设定。';
const L2 = '第二段：主角拥有一把传说中的剑，剑身刻着古老的符文。';
const L2B = '第二段：主角拥有一把传说中的剑，剑身刻着古老的符文，并散发着微弱的蓝光。';
const L3 = '第三段：主角的性格冷静而坚毅。';
const L_ONLY_OLD = '这一行只存在于旧版。';
const L_LAST = '最后一行。';
const mk = (uid, key, comment, content) => ({ uid, key, comment, content, disable: false, extensions: {} });

const A = {
    path: 'E:/t/版本A.json', fileName: '版本A.json', name: '版本A',
    data: { name: '测试世界书', entries: [
        mk(0, ['主角', 'protagonist'], '主角设定', [L1, L2, L3].join('\n')),
        mk(1, ['宝剑'], '武器', [L_LAST, L_ONLY_OLD].join('\n')),
        mk(2, ['旧条目'], '将被删除', '这一条在新版中会被删除。')
    ] }
};
const B = {
    path: 'E:/t/版本B.json', fileName: '版本B.json', name: '版本B',
    data: { name: '测试世界书', entries: [
        mk(0, ['主角', 'protagonist', '主角'], '主角设定', [L1, L2B, L3].join('\n')),
        mk(1, ['宝剑'], '武器', [L_LAST].join('\n')),
        mk(3, ['新条目'], '新增', [L1, L2, L3].join('\n'))
    ] }
};

console.log('═════ 差异「对端新增」底色取证 ═════');
console.log('');

// 打开弹窗
const opened = await ev(`(async () => {
    const ctx = ${CTX};
    if (!ctx || typeof ctx.openDiffDetailModal !== 'function') return { ok: false, err: 'no ctx/openDiffDetailModal' };
    ctx.openDiffDetailModal(${JSON.stringify(A)}, ${JSON.stringify(B)});
    await new Promise(r => setTimeout(r, 1200));
    return { ok: true };
})()`);
if (!opened.ok) { console.error('❌ ' + opened.err); process.exit(1); }
console.log('✅ 弹窗已打开');
console.log('');

// dump 所有行的底色分布
const dump = await ev(`(() => {
    const all = [...document.querySelectorAll('*')];
    const cls = (el) => (typeof el.className === 'string' ? el.className : '');
    const classesOf = (frag) => all.filter(el => cls(el).includes(frag));

    // 行级底色（rose / emerald / amber 的「行」变体）
    const rows = {
        'rose-950/40（本端缺失）': classesOf('bg-rose-950/40').length,
        'emerald-950/40（对端新增）': classesOf('bg-emerald-950/40').length,
        'amber-950/25（内容改动）': classesOf('bg-amber-950/25').length
    };
    // 行内高亮
    const hl = {
        'rose-500/40': classesOf('bg-rose-500/40').length,
        'emerald-500/40': classesOf('bg-emerald-500/40').length,
        'amber-500/35': classesOf('bg-amber-500/35').length
    };
    // 弹窗全文（看两侧是否都渲染了）
    const txt = document.body.innerText || '';
    const hasTwoSides = /本端|对端|基准|对比/.test(txt);
    return { rows, hl, hasTwoSides, txtLen: txt.length };
})()`);

console.log('───── 渲染后的底色分布 ─────');
console.log('行级底色：');
for (const [k, v] of Object.entries(dump.rows)) {
    console.log(`   ${v > 0 ? '✅' : '❌'} ${k}：${v} 处`);
}
console.log('行内高亮：');
for (const [k, v] of Object.entries(dump.hl)) {
    console.log(`   ${v > 0 ? '✅' : '❌'} ${k}：${v} 处`);
}
console.log('');
console.log(`两侧术语出现：${dump.hasTwoSides ? '是' : '否'} ｜ 弹窗文本长度：${dump.txtLen}`);
console.log('');

// 结论
console.log('───── 结论 ─────');
if (dump.rows['emerald-950/40（对端新增）'] === 0) {
    console.log('🔴 emerald 行**确实未渲染**。');
    console.log('   ⚠️ 但需判定：是「真缺陷」还是「探针数据假设错」——');
    console.log('      本探针数据里 A=[L_LAST, L_ONLY_OLD]、B=[L_LAST]：');
    console.log('      · A 比 B 多一行 → 该行在 **A 视角**是「本端有、对端无」→ 应是 **rose**；');
    console.log('      · 若要出现 **emerald**，需要 **B 比 A 多一行**（本探针数据里没有这种情况！）');
    console.log('      ⇒ 这是**探针数据假设错**，不是产品缺陷。');
    console.log('      修法：给探针数据加一条「B 比 A 多行」的用例（如 mk(0) 的 content 里 B 多一行）。');
} else {
    console.log('✅ emerald 行正常渲染。');
}
