/**
 * 进度条「反复横跳」复现与定位（2026-09-23 用户二次报出）
 *
 * 背景：AR-45 声称已修（探针 5/5），但用户实测**又出现横跳**。
 *   本探针比 `_probe-progress-continuity.mjs` 更狠：
 *     · 采样间隔 **10ms**（原探针 20ms，可能漏掉短窗口）
 *     · **同时采样 `wbScanPercent`**（阶段 1 定时器的数据源）——原探针没采它，
 *       所以看不出「dedupeScanPercent 被 wbScanPercent 拖着走」这条路径
 *     · 记录 `label`（阶段文案），定位是哪个阶段在倒退
 *     · **连跑两轮**（冷缓存 / 热缓存），横跳常在热缓存下才出现
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-progress-jump.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-progress-jump.mjs "<目录>"'); process.exit(1); }

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

console.log('═════ 进度条横跳复现（10ms 采样）═════');
console.log(`目录：${DIR}`);

// 建库（冷缓存）
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 2500));
    return ctx.worldbooks.value.length;
})()`);
console.log('库已就绪');
console.log('');

async function runOnce(tag) {
    // 装采样器
    await ev(`(() => {
        window.__jumpSamples = [];
        window.__jumpSampling = true;
        const ctx = ${CTX};
        const timer = setInterval(() => {
            if (!window.__jumpSampling) { clearInterval(timer); return; }
            window.__jumpSamples.push({
                t: Math.round(performance.now()),
                pct: ctx.dedupeScanPercent.value,
                scanning: !!ctx.dedupeScanning.value,
                indet: !!ctx.dedupeScanIndeterminate.value,
                label: ctx.dedupeScanLabel.value || '',
                // ★ 关键：阶段 1 定时器的数据源（原探针没采它）
                wbPct: typeof ctx.wbScanPercent?.value === 'number' ? ctx.wbScanPercent.value : -1,
                wbPhase: (ctx.wbScanProgress && ctx.wbScanProgress.value && ctx.wbScanProgress.value.phase) || ''
            });
        }, 10);
        return true;
    })()`);

    await ev(`(async () => {
        const ctx = ${CTX};
        await ctx.startWorldbookDedupeScan();
        await new Promise(r => setTimeout(r, 2000));
        return ctx.wbDuplicateGroups.value.length;
    })()`);

    const samples = await ev(`(() => { window.__jumpSampling = false; return window.__jumpSamples; })()`);

    // 找倒退点
    const drops = [];
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        if (!a.scanning || !b.scanning) continue;   // 只看扫描窗口内
        if (b.pct < a.pct - 1) drops.push({ from: a, to: b });
    }
    const maxPct = Math.max(...samples.map(s => s.pct));
    const indetCnt = samples.filter(s => s.scanning && s.indet).length;

    console.log(`───── ${tag} ─────`);
    console.log(`采样 ${samples.length} 点 ｜ max percent=${maxPct}% ｜ 光条出现 ${indetCnt} 次 ｜ 倒退 ${drops.length} 次`);
    if (drops.length) {
        console.log('🔴 倒退明细（前 10 条）：');
        for (const d of drops.slice(0, 10)) {
            console.log(`   ${d.from.pct}% → ${d.to.pct}%  (${d.from.t}→${d.to.t}ms)`);
            console.log(`      前一拍: label="${d.from.label}" wbPct=${d.from.wbPct} wbPhase=${d.from.wbPhase}`);
            console.log(`      后一拍: label="${d.to.label}" wbPct=${d.to.wbPct} wbPhase=${d.to.wbPhase}`);
        }
    }
    // 打印 percent 变化序列（压缩连续相同值）
    const seq = [];
    let last = null;
    for (const s of samples) {
        const k = `${s.pct}|${s.label}|${s.wbPct}`;
        if (k !== last) { seq.push(`${s.pct}%(wb:${s.wbPct}) [${s.label}]`); last = k; }
    }
    console.log(`序列（${seq.length} 次变化）：`);
    seq.forEach(x => console.log('   ' + x));
    console.log('');
    return { drops: drops.length, maxPct, indetCnt, samples: samples.length };
}

const r1 = await runOnce('第 1 轮（冷缓存）');
const r2 = await runOnce('第 2 轮（热缓存）');

console.log('═════ 结论 ═════');
console.log(`第 1 轮：倒退 ${r1.drops} 次，max ${r1.maxPct}%，光条 ${r1.indetCnt} 次`);
console.log(`第 2 轮：倒退 ${r2.drops} 次，max ${r2.maxPct}%，光条 ${r2.indetCnt} 次`);
if (r1.drops || r2.drops) console.log('🔴 复现成功 —— 横跳确实存在（AR-45 未真正修好）');
else console.log('✅ 本次未复现（需换更大库或更长采样）');
