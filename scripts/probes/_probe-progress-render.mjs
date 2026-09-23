/**
 * 进度条「横跳」根因取证 —— **采样渲染后的 DOM 文本**（2026-09-23）
 *
 * 为什么必须采 DOM：用户看到的是**渲染结果**，不是 ctx 里的变量。
 *   之前 `_probe-progress-continuity.mjs` 只采 `ctx.dedupeScanPercent`（进度条宽度），
 *   而「数字」来自**另一条路径**（`dedupeScanProgressForModal` → `wbScanProgress`）
 *   ⇒ **探针只看了一半**，所以「5/5 通过」是假绿（这是 AR-43 同款病根：
 *     「宽度与数字走两条不同路径，所以只有数字坏，现象隐蔽」）。
 *
 * 本探针同时采：
 *   · 进度条**宽度**（style.width，来自 `percent`）
 *   · 数字文本（`data-testid="dedupe-scan-numbers"`，来自 `progress.done/total`）
 *   · 文案 label
 *   · 背后两个数据源（`dedupeScanPercent` / `wbScanPercent`）
 * 并断言「数字与百分比必须一致」—— 这是原探针**完全没覆盖**的维度。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-progress-render.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-progress-render.mjs "<目录>"'); process.exit(1); }

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

console.log('═════ 进度条「渲染结果」取证 ═════');
console.log(`目录：${DIR}`);

// 建库
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 2500));
    return ctx.worldbooks.value.length;
})()`);
console.log('库已就绪');
console.log('');

// 装采样器：**采渲染后的 DOM**
await ev(`(() => {
    window.__renderSamples = [];
    window.__renderSampling = true;
    const ctx = ${CTX};
    const timer = setInterval(() => {
        if (!window.__renderSampling) { clearInterval(timer); return; }
        const el = document.querySelector('[data-testid="dedupe-scan-progress"]');
        const numsEl = el ? el.querySelector('[data-testid="dedupe-scan-numbers"]') : null;
        const barEl = el ? el.querySelector('[data-testid="dedupe-scan-bar"]') : null;
        const inner = barEl ? barEl.querySelector('div') : null;
        window.__renderSamples.push({
            t: Math.round(performance.now()),
            visible: !!el,
            // ★ 用户实际看到的
            numbersText: numsEl ? (numsEl.innerText || '').replace(/\\s+/g, ' ').trim() : '',
            barWidth: inner ? (inner.style.width || '') : '',
            labelText: el ? ((el.innerText || '').split('\\n')[0] || '').trim() : '',
            // 背后数据源
            pct: ctx.dedupeScanPercent.value,
            scanning: !!ctx.dedupeScanning.value,
            wbTotal: (ctx.wbScanProgress && ctx.wbScanProgress.value && ctx.wbScanProgress.value.total) || 0,
            wbDone: (ctx.wbScanProgress && ctx.wbScanProgress.value && ctx.wbScanProgress.value.done) || 0
        });
    }, 30);
    return true;
})()`);

// 跑内容级查重（阶段 2 最慢，最能暴露「数字掉 0」）
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.startContentDedupeScan();
    await new Promise(r => setTimeout(r, 2000));
    return ctx.contentDuplicateGroups.value.length;
})()`);

const samples = await ev(`(() => { window.__renderSampling = false; return window.__renderSamples; })()`);

console.log(`采样 ${samples.length} 点`);

// 断言：数字里出现的百分比 必须与 pct 一致（允许 1% 误差 + 数字文本无百分比时跳过）
const mismatches = [];
for (const s of samples) {
    if (!s.visible || !s.scanning) continue;
    const m = /（(\d+)%）/.exec(s.numbersText);
    if (!m) continue;
    const shownPct = Number(m[1]);
    if (Math.abs(shownPct - s.pct) > 1) {
        mismatches.push({ t: s.t, shownPct, pct: s.pct, text: s.numbersText, label: s.labelText });
    }
}
console.log('');
console.log('───── 断言 1：数字百分比 vs 进度条宽度 ─────');
if (mismatches.length === 0) console.log('✅ 一致（未发现脱钩）');
else {
    console.log(`🔴 脱钩 ${mismatches.length} 次（前 8 条）：`);
    for (const x of mismatches.slice(0, 8)) {
        console.log(`   ${x.t}ms  数字显示 ${x.shownPct}%  实际条宽 ${x.pct}%  | "${x.text}" [${x.label}]`);
    }
}

// 断言 2：数字文本不得出现「0 / ?」（= 数据源掉回空）—— 除非百分比也是 0
const zeroNum = samples.filter(s => s.visible && s.scanning && /^0 \/ \?/.test(s.numbersText) && s.pct > 5);
console.log('');
console.log('───── 断言 2：扫描中数字不得掉回「0 / ?」 ─────');
if (zeroNum.length === 0) console.log('✅ 未出现');
else {
    console.log(`🔴 出现 ${zeroNum.length} 次（进度条已是 ${zeroNum[0].pct}% 却显示 0 / ?）`);
    console.log(`   首次：${zeroNum[0].t}ms  "${zeroNum[0].numbersText}" [${zeroNum[0].labelText}]`);
    console.log(`   ⇒ 用户看到「进度条满/半满，数字却是 0」= 观感上的「横跳」`);
}

// 断言 3：数字百分比不得倒退
const drops = [];
let lastShown = -1;
for (const s of samples) {
    if (!s.visible || !s.scanning) continue;
    const m = /（(\d+)%）/.exec(s.numbersText);
    if (!m) continue;
    const v = Number(m[1]);
    if (lastShown >= 0 && v < lastShown - 1) drops.push({ t: s.t, from: lastShown, to: v, text: s.numbersText, label: s.labelText });
    lastShown = v;
}
console.log('');
console.log('───── 断言 3：数字百分比单调不减 ─────');
if (drops.length === 0) console.log('✅ 单调');
else {
    console.log(`🔴 倒退 ${drops.length} 次（前 8 条）：`);
    for (const x of drops.slice(0, 8)) console.log(`   ${x.t}ms  ${x.from}% → ${x.to}%  | "${x.text}" [${x.label}]`);
}

// 打印关键序列（只看渲染文本变化）
console.log('');
console.log('───── 渲染文本变化序列 ─────');
const seq = [];
let lastKey = null;
for (const s of samples) {
    const key = s.visible ? `${s.labelText} | ${s.numbersText} | ${s.barWidth}` : '(隐藏)';
    if (key !== lastKey) { seq.push(`${s.t}ms  ${key}`); lastKey = key; }
}
seq.slice(0, 60).forEach(x => console.log('   ' + x));
if (seq.length > 60) console.log(`   …（共 ${seq.length} 次变化）`);
