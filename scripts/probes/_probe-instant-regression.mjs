/**
 * 秒开回归诊断：`wb.data` 为 null 的消费者影响面
 * 用法：node scripts/probes/_probe-instant-regression.mjs "<世界书目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-instant-regression.mjs <目录>'); process.exit(1); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text || '');
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable'); await send('Log.enable');
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
const DIR_LIT = JSON.stringify(DIR);

console.log('═════ 秒开回归诊断 ═════');
const r = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${DIR_LIT});
    await new Promise(r => setTimeout(r, 3000));
    const list = ctx.worldbooks.value;
    const out = {
        total: list.length,
        dataNull: list.filter(w => w.data === null).length,
        dataLoadedFalse: list.filter(w => w.dataLoaded === false).length,
        dataLoadedTrue: list.filter(w => w.dataLoaded === true).length,
        hasEntryCount: list.filter(w => typeof w.entryCount === 'number').length,
        hasWbName: list.filter(w => !!w.wbName).length,
        // 消费端受影响面：读 wb.data.entries 会拿到什么
        wbEntryCountFn: list.slice(0, 3).map(w => ctx.wbEntryCount(w)),
        // 同名查重依赖 wb.data.name
        dataNameUsable: list.filter(w => w.data && w.data.name).length
    };
    return out;
})()`, 1800000);
console.log(JSON.stringify(r, null, 2));

console.log('\n--- 同名查重实测 ---');
const d = await ev(`(async () => {
    const ctx = ${CTX};
    await ctx.startWorldbookDedupeScan();
    await new Promise(r => setTimeout(r, 2000));
    const g = ctx.wbDuplicateGroups.value;
    return {
        groups: g.length,
        firstGroupSizes: g.slice(0, 3).map(x => (x.list || []).length),
        firstGroupEntryCounts: g.slice(0, 1).map(x => (x.list || []).map(w => w._entryCount)),
        firstGroupDiffInfo: g.slice(0, 1).map(x => (x.list || []).map(w => w._diffInfo))
    };
})()`, 3600000);
console.log(JSON.stringify(d, null, 2));

console.log('\n--- 差异比对实测 ---');
const df = await ev(`(async () => {
    const ctx = ${CTX};
    const all = ctx.worldbooks.value;
    if (all.length < 2) return { err: '库内不足 2 本' };
    const A = all[0], B = all[1];
    const out = { a: A.name, b: B.name, aDataLoaded: A.dataLoaded, bDataLoaded: B.dataLoaded };
    ctx.openDiffDetailModal(A, B);
    await new Promise(r => setTimeout(r, 3000));
    out.fieldLabels = ctx.diffFieldResults.value.map(f => f.label);
    out.firstIsSame = ctx.diffFieldResults.value.slice(0, 3).map(f => f.isSame);
    out.modalOpen = ctx.showDiffDetailModal.value;
    const txt = document.body.innerText || '';
    out.showsCardConclusion = /设定完全一致/.test(txt);
    ctx.showDiffDetailModal.value = false;
    return out;
})()`, 600000);
console.log(JSON.stringify(df, null, 2));

console.log('\n--- 进度条状态 ---');
const p = await ev(`(() => { const ctx = ${CTX}; return {
    wbScanProgress: JSON.parse(JSON.stringify(ctx.wbScanProgress.value)),
    wbScanPercent: ctx.wbScanPercent.value,
    isWbScanning: ctx.isWbScanning.value,
    dedupeScanning: ctx.dedupeScanning.value,
    dedupeScanPercent: ctx.dedupeScanPercent.value,
    dedupeScanLabel: ctx.dedupeScanLabel.value
}; })()`);
console.log(JSON.stringify(p, null, 2));

console.log('\n--- 渲染期错误 ---');
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|Invalid|before initialization/i.test(t));
console.log(bad.length ? bad.slice(0, 10).join('\n---\n') : '（无）');

// ══════════════════════════════════════════════════════════
// 断言（PK-26 回归门禁）：修复前这里是「_entryCount 大量为 0 / 重合度 0%」
// ══════════════════════════════════════════════════════════
console.log('\n═════ PK-26 断言 ═════');
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

check('秒开列表非空', r.total > 0, `${r.total} 本`);
check('轻量字段 entryCount 覆盖全部（秒开也能给出词条数）', r.hasEntryCount === r.total, `${r.hasEntryCount}/${r.total}`);
check('轻量字段 wbName 覆盖全部（秒开也能给出书名）', r.hasWbName === r.total, `${r.hasWbName}/${r.total}`);
check('wbEntryCount() 返回真实值（非 0）', r.wbEntryCountFn.length > 0 && r.wbEntryCountFn.every(v => v > 0), JSON.stringify(r.wbEntryCountFn));

const allCounts = (d.firstGroupEntryCounts[0] || []);
check('同名查重出结果', d.groups > 0, `${d.groups} 组`);
check('★ 同名查重 _entryCount 全为真实值（修复前大量为 0）',
    allCounts.length > 0 && allCounts.every(v => typeof v === 'number' && v > 0),
    `前 ${allCounts.length} 本：${[...new Set(allCounts)].join('/')}`);
const allDiffs = (d.firstGroupDiffInfo[0] || []);
check('★ 重合度不是反向的「0%」（修复前恒 0%）',
    !allDiffs.some(t => /重合度: 0%/.test(t)),
    allDiffs[1] || '(无)');

check('★ 差异比对走世界书分支（修复前误判成角色卡）',
    (df.fieldLabels || []).some(l => /世界书词条总数/.test(l)), (df.fieldLabels || [])[0] || '(无)');
check('★ 差异比对不出现「设定完全一致」反向结论', df.showsCardConclusion !== true, String(df.showsCardConclusion));
check('差异弹窗已打开', df.modalOpen === true, String(df.modalOpen));

check('无渲染期错误 / TDZ', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

const pass = results.filter(x => x.ok).length;
console.log(`\n═════ 结果：${pass}/${results.length} 通过 ═════`);
process.exit(pass === results.length ? 0 : 1);
