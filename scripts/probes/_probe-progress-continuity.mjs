/**
 * 进度条连续性实测（2026-09-22 用户报「横跳 / 时长时短 / 变光条」）
 *
 * 做法：在页面内起**高频采样器**，记录查重全程的
 *   `scanning / percent / indeterminate / visible(组件是否渲染)`
 * 然后断言：
 *   ① 全程 `scanning` 保持 true（不出现「消失又出现」的横跳）
 *   ② `percent` 单调不减（不出现「时长时短」）
 *   ③ `indeterminate` 全程 false（世界书路径；不出现「滚动的光条」）
 *   ④ 组件 `visible` 保持 true（DOM 层不闪烁）
 *
 * 用法：node scripts/probes/_probe-progress-continuity.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-progress-continuity.mjs <目录>'); process.exit(1); }

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
const ev = async (expr, t = 1800000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

console.log('═════ 进度条连续性实测 ═════');

// 采样器：在页面内高频记录（20ms 一次）
// 🛑 AR-45 二次修复（2026-09-23）：**必须同时采「数字」与「宽度」**。
//    旧版只采 `dedupeScanPercent`（宽度）+ `indeterminate`，**完全没采数字文本** ——
//    而「横跳」的真正表现是「条宽 100%、数字却掉回 0 / ?」（数字与宽度**不同源**）。
//    ⚠️ 这与 AR-43 是同一类病（「宽度与数字走两条不同路径 → 只有数字坏，现象隐蔽」），
//       所以探针**必须两条都采**，否则又是假绿。
await ev(`(() => {
    window.__progSamples = [];
    window.__progSampling = true;
    const app = document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance;
    const ctx = inst.provides.appCtx;
    const timer = setInterval(() => {
        if (!window.__progSampling) { clearInterval(timer); return; }
        const el = document.querySelector('[data-testid="dedupe-scan-progress"]');
        const numsEl = el ? el.querySelector('[data-testid="dedupe-scan-numbers"]') : null;
        window.__progSamples.push({
            t: Math.round(performance.now()),
            scanning: !!ctx.dedupeScanning.value,
            percent: ctx.dedupeScanPercent.value,
            indeterminate: !!ctx.dedupeScanIndeterminate.value,
            visible: !!el,
            numbers: numsEl ? (numsEl.innerText || '').replace(/\\s+/g, ' ').trim() : '',
            // 数据源（供定位脱钩）
            srcDone: ctx.dedupeScanDone ? ctx.dedupeScanDone.value : -1,
            srcTotal: ctx.dedupeScanTotal ? ctx.dedupeScanTotal.value : -1
        });
    }, 20);
    return true;
})()`);

// 扫描建库（保证有数据）
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 2500));
    return ctx.worldbooks.value.length;
})()`);
info('库已就绪');

// 跑同名查重（含重扫 + 指纹比对两阶段）
// ⚠️ 采样窗口必须覆盖 `finishDedupeScan()` 的 **400ms 停留**（否则抓不到 100% 终态）
await ev(`(async () => {
    const ctx = ${CTX};
    await ctx.startWorldbookDedupeScan();
    await new Promise(r => setTimeout(r, 2000));   // ★ 等收尾（100% 停留 400ms + 收起）
    return ctx.wbDuplicateGroups.value.length;
})()`, 1800000);

const samples = await ev(`(() => { window.__progSampling = false; return window.__progSamples; })()`);
info('采样点数', String(samples.length));

if (!samples || samples.length < 3) {
    console.log('⚠️ 采样点过少，无法判定（可能查重太快）');
    process.exit(1);
}

// ① 不横跳：scanning 全程 true（收尾后允许变 false）
//    ⚠️ 窗口定义：取「首个 true」到「最后一个 true」之间的**所有**采样点 ——
//       中间若出现 false 就是「消失又出现」的横跳（这正是要抓的缺陷）。
const firstScanIdx = samples.findIndex(s => s.scanning);
const lastScanIdx = samples.map(s => s.scanning).lastIndexOf(true);
const scanWindow = samples.slice(firstScanIdx, lastScanIdx + 1);
const gapsInScanning = scanWindow.filter(s => !s.scanning).length;
check('★ ① 不横跳：扫描窗口内 scanning 无 false 中断', gapsInScanning === 0,
    `窗口 ${scanWindow.length} 点，中断 ${gapsInScanning} 次`);

// ★ 单调性只在「真正扫描中」的点上判（排除收尾归零 —— 那是正常行为）
const activePts = samples.slice(firstScanIdx, lastScanIdx + 1).filter(s => s.scanning);

// ② 不时长时短：percent 单调不减
//    ⚠️ 必须**只看扫描窗口内**（`scanning===true`）：
//       `finishDedupeScan()` 的收尾是「100% 停留 → 归 0 收起」，**归零是正常行为**，
//       不是倒退（探针最初把 100→0 误判为倒退，属判据缺陷）。
const pcts = activePts.map(s => s.percent);
let drops = [];
for (let i = 1; i < pcts.length; i++) if (pcts[i] < pcts[i - 1] - 2) drops.push(`${pcts[i - 1]}→${pcts[i]}`);
check('★ ② 不倒退：扫描窗口内 percent 单调不减（允许 2% 抖动）', drops.length === 0,
    drops.length ? `倒退 ${drops.length} 次：${drops.slice(0, 5).join(', ')}` : `区间 ${Math.min(...pcts)}~${Math.max(...pcts)}`);

// ③ 不变光条：indeterminate 全程 false
const indet = scanWindow.filter(s => s.indeterminate).length;
check('★ ③ 不变光条：indeterminate 全程 false', indet === 0, `true 出现 ${indet} 次`);

// ④ 不闪烁：visible 保持 true
const inviz = scanWindow.filter(s => !s.visible).length;
check('★ ④ 不闪烁：组件 visible 全程 true', inviz === 0, `不可见 ${inviz} 次`);

// ⑤ 终态：最后到过 100%
const maxPct = Math.max(...samples.map(s => s.percent));
check('★ ⑤ 终态到达 100%', maxPct === 100, `max ${maxPct}%`);

// ═══════════════════════════════════════════════════════════════
// 🛑 AR-45 二次修复（2026-09-23）新增断言 —— 旧版**完全没覆盖**这些维度：
//    「横跳」的真正表现是「条宽已满，数字却掉回 0 / ?」（数字与宽度不同源）。
//    ⚠️ 与 AR-43 同类：宽度与数字走两条路径，只测宽度会**假绿**。
// ═══════════════════════════════════════════════════════════════

// ⑥ 数字与宽度**必须一致**（同源校验）
const mismatches = [];
for (const s of scanWindow) {
    if (!s.scanning) continue;
    const m = /（(\d+)%）/.exec(s.numbers || '');
    if (!m) continue;
    const shown = Number(m[1]);
    if (Math.abs(shown - s.percent) > 1) mismatches.push(`${s.t}ms 数字${shown}% vs 条宽${s.percent}%`);
}
check('★ ⑥ 数字与条宽一致（AR-45 二次：同源校验，旧探针盲区）', mismatches.length === 0,
    mismatches.length ? `${mismatches.length} 次脱钩：${mismatches.slice(0, 3).join(' | ')}` : `区间一致`);

// ⑦ 扫描中数字不得掉回「0 / ?」（数据源被冲掉的典型症状）
const zeroNum = scanWindow.filter(s => s.scanning && /^0 \/ \?/.test(s.numbers || '') && s.percent > 5);
check('★ ⑦ 扫描中数字不出现「0 / ?」（AR-45 二次：数据源不得被冲掉）', zeroNum.length === 0,
    zeroNum.length ? `出现 ${zeroNum.length} 次（条宽已 ${zeroNum[0].percent}%）` : '未出现');

// ⑧ 数字百分比单调不减
let lastShown = -1; const numDrops = [];
for (const s of scanWindow) {
    if (!s.scanning) continue;
    const m = /（(\d+)%）/.exec(s.numbers || '');
    if (!m) continue;
    const v = Number(m[1]);
    if (lastShown >= 0 && v < lastShown - 1) numDrops.push(`${lastShown}%→${v}%`);
    lastShown = v;
}
check('★ ⑧ 数字百分比单调不减（AR-45 二次）', numDrops.length === 0,
    numDrops.length ? `倒退 ${numDrops.length} 次：${numDrops.slice(0, 3).join(', ')}` : '单调');

// ⑨ 收尾时数字必须到 total（不能「100% 但数字停在 970 / 1001」）
const lastActive = [...samples].reverse().find(s => s.scanning);
const finalNum = lastActive ? (lastActive.numbers || '') : '';
const doneTotalOk = !/（100%）/.test(finalNum) || !/^\d+ \/ \d+/.test(finalNum)
    || (() => { const m = /^(\d+) \/ (\d+)/.exec(finalNum); return m && m[1] === m[2]; })();
check('★ ⑨ 终态数字 done === total（AR-45 二次）', doneTotalOk, `末帧「${finalNum || '(无)'}」`);

// 打印关键序列（便于人工核对）
const key = [];
let lastP = -1;
for (const s of samples) {
    if (s.percent !== lastP) { key.push(`${s.t}ms:${s.percent}%${s.indeterminate ? '(光条)' : ''}${s.scanning ? '' : '(停)'}`); lastP = s.percent; }
}
console.log('\n───── 进度变化序列（前 20 个变化点）─────');
console.log(key.slice(0, 20).join('  '));

// 打印「数字」变化序列（AR-45 二次新增，用于核对脱钩）
const numKey = [];
let lastN = '';
for (const s of samples) {
    const n = `${s.percent}%|${s.numbers}`;
    if (n !== lastN) { numKey.push(`${s.t}ms 条${s.percent}% 数字「${s.numbers || '(无)'}」`); lastN = n; }
}
console.log('\n───── 数字 vs 条宽 变化序列（前 25 个）─────');
console.log(numKey.slice(0, 25).join('\n'));

const pass = results.filter(x => x.ok).length;
console.log(`\n═════ 结果：${pass}/${results.length} 通过 ═════`);
process.exit(pass === results.length ? 0 : 1);
