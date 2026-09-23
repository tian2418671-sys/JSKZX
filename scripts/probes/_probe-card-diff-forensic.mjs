/**
 * 角色卡查重 / 差异比对 —— 取证探针（2026-09-23）
 *
 * 用户反馈：
 *   ① 「角色卡的查重界面出现了进度条滚动光条效果」→ 疑 `dedupeScanIndeterminate` 未复位
 *   ② 「角色卡对比查重功能出现了严重的错误，对比错误，角色卡错误卡片和对比卡片都不对」
 *      → 疑 `openDiffDetailModal` 把角色卡误判成世界书 / 传错条目
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-card-diff-forensic.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
const ev = async (expr, t = 900000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app && app._container && app._container._vnode && app._container._vnode.component) || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

console.log('═════ 角色卡查重 / 差异比对 取证 ═════');
console.log('');

// ── ① 同名查重：进度条状态 + 分组内容 ──
const r1 = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'characters';
    await new Promise(r => setTimeout(r, 300));
    const snap = [];
    // 采样进度条状态（扫描期间）
    const timer = setInterval(() => {
        snap.push({
            ind: !!ctx.dedupeScanIndeterminate.value,
            pct: ctx.dedupeScanPercent.value,
            label: ctx.dedupeScanLabel.value,
            scan: !!ctx.dedupeScanning.value
        });
    }, 400);
    await ctx.startDedupeScan();
    await new Promise(r => setTimeout(r, 1500));
    clearInterval(timer);
    const g = ctx.duplicateGroups.value || [];
    return {
        indeterminate_samples: snap.filter(s => s.ind).length + '/' + snap.length,
        timeline: snap.map(s => (s.ind ? 'I' : '-') + s.pct).join(' '),
        firstDeterminateAt: snap.findIndex(s => !s.ind),
        final: { ind: !!ctx.dedupeScanIndeterminate.value, pct: ctx.dedupeScanPercent.value, scan: !!ctx.dedupeScanning.value },
        groups: g.length,
        firstGroup: g[0] ? {
            name: g[0].name,
            n: g[0].cards.length,
            members: g[0].cards.slice(0, 4).map(c => ({
                file: (c.path || '').split(/[\\/]/).pop(),
                name: c.name,
                tokens: c._tokens,
                diffType: c._diffType,
                nameOnly: !!c._nameOnly,
                dist: c._nameOnlyDist
            }))
        } : null
    };
})()`, 900000);
console.log('① 同名查重');
console.log('   扫描期间 indeterminate 为 true 的采样：' + r1.indeterminate_samples);
console.log('   时间线（I=不定态，-数字=确定态）：' + r1.timeline);
console.log('   首次出现确定态的帧号：' + r1.firstDeterminateAt);
console.log('   结束后：' + JSON.stringify(r1.final));
console.log('   分组数：' + r1.groups);
console.log('   首组：' + JSON.stringify(r1.firstGroup, null, 2));
console.log('');

// ── ② 差异比对：取首组前两张，看被判成什么 ──
const r2 = await ev(`(async () => {
    const ctx = ${CTX};
    const g = ctx.duplicateGroups.value || [];
    if (!g.length) return { err: '无分组' };
    const master = g[0].cards[0], compare = g[0].cards[1];
    const probe = (it) => ({
        name: it.name, file: (it.path || '').split(/[\\\\/]/).pop(),
        entryCount: typeof it.entryCount, wbName: !!it.wbName,
        dataEntries: !!(it.data && it.data.entries),
        dataKeys: it.data ? Object.keys(it.data).slice(0, 8) : null,
        hasInnerData: !!(it.data && it.data.data),
        customTags: (it.customTags || []).length
    });
    ctx.openDiffDetailModal(master, compare);
    await new Promise(r => setTimeout(r, 600));
    return {
        masterPassed: probe(master), comparePassed: probe(compare),
        boundMaster: ctx.diffMasterItem.value ? { name: ctx.diffMasterItem.value.name, file: (ctx.diffMasterItem.value.path||'').split(/[\\\\/]/).pop() } : null,
        boundCompare: ctx.diffCompareItem.value ? { name: ctx.diffCompareItem.value.name, file: (ctx.diffCompareItem.value.path||'').split(/[\\\\/]/).pop() } : null,
        fields: (ctx.diffFieldResults.value || []).map(f => ({ label: f.label, isSame: f.isSame, len1: f.len1, len2: f.len2 }))
    };
})()`, 900000);
console.log('② 差异比对（首组前两张）');
console.log('   传入 master：' + JSON.stringify(r2.masterPassed));
console.log('   传入 compare：' + JSON.stringify(r2.comparePassed));
console.log('   弹窗绑定 master：' + JSON.stringify(r2.boundMaster));
console.log('   弹窗绑定 compare：' + JSON.stringify(r2.boundCompare));
console.log('   字段判定：');
for (const f of (r2.fields || [])) console.log('     ' + (f.isSame ? '=' : '≠') + ' ' + f.label + '  ' + f.len1 + ' | ' + f.len2);
process.exit(0);
