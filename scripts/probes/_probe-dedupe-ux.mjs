/**
 * 查重 UX 三问排查 v2（用户 2026-09-22 反馈）
 *
 * 用法：node scripts/probes/_probe-dedupe-ux.mjs [世界书目录]
 *
 * ⚠️ v1 的两个测量错误（已修）：
 *   · ① 用「数字/数字」正则找进度条 → **误匹配到分页控件「1 / 4」**（100 本 / 每页 25）
 *     ⇒ 改用 `data-testid="dedupe-scan-numbers"` 精确定位
 *   · ③ 用 requestAnimationFrame 测帧 → **窗口隐藏时 Chromium 不触发 rAF**（0 帧）
 *     ⇒ 改用 `PerformanceObserver('longtask')` + `setTimeout` 递归测事件循环延迟
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const WB_DIR = process.argv[2] || 'D:\\TkDmGzq\\_wbscale\\s100';

let sock; let msgId = 0; const pending = new Map();
async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res; sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression, timeoutMs = 900000) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    if (!app) return null;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);
const head = (n) => console.log(`\n───── ${n} ─────`);

// 卡顿测量器（注入页面）：longtask + 事件循环延迟
const PERF_INSTALL = `(() => {
    if (window.__perf) return true;
    window.__perf = { longtasks: [], lag: [], running: false };
    try {
        const po = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                if (e.duration > 50) window.__perf.longtasks.push({ d: Math.round(e.duration), t: Math.round(e.startTime) });
            }
        });
        po.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* 不支持 longtask 就只靠 lag */ }
    let last = performance.now();
    const tick = () => {
        if (!window.__perf.running) return;
        const now = performance.now();
        const lag = now - last - 25;
        if (lag > 0) window.__perf.lag.push(Math.round(lag));
        last = now;
        setTimeout(tick, 25);
    };
    window.__perf.start = () => { window.__perf.running = true; window.__perf.longtasks = []; window.__perf.lag = []; last = performance.now(); setTimeout(tick, 25); };
    window.__perf.stop = () => { window.__perf.running = false; return { longtasks: window.__perf.longtasks.slice(), lag: window.__perf.lag.slice() }; };
    return true;
})()`;

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Log.enable');
    await evaluate(PERF_INSTALL);
    info('已连接 CDP', `目录 ${WB_DIR}`);

    // 预热：确保世界书库已加载
    await evaluate(`(async () => {
        const ctx = ${CTX};
        ctx.appMode.value = 'worldbooks';
        if (!ctx.worldbooks.value.length) await ctx.scanWorldbookDir(${JSON.stringify(WB_DIR)});
        return ctx.worldbooks.value.length;
    })()`, 900000);

    // ── ① 进度条数字：用 data-testid 精确读 ──
    head('① 进度条数字（精确读 data-testid="dedupe-scan-numbers"）');
    const num = await evaluate(`(async () => {
        const ctx = ${CTX};
        const readNum = () => {
            const el = document.querySelector('[data-testid="dedupe-scan-numbers"]');
            return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
        };
        const barWidth = () => {
            const b = document.querySelector('[data-testid="dedupe-scan-bar"] > div');
            return b ? (b.style.width || '') : null;
        };
        const seen = [];
        const bars = [];
        const timer = setInterval(() => {
            const t = readNum();
            const w = barWidth();
            if (t && (seen.length === 0 || seen[seen.length - 1] !== t)) seen.push(t);
            if (w && (bars.length === 0 || bars[bars.length - 1] !== w)) bars.push(w);
        }, 60);
        await ctx.startWorldbookDedupeScan();
        clearInterval(timer);
        await new Promise(r => setTimeout(r, 700));
        return { distinct: seen, n: seen.length, barWidths: bars, barCount: bars.length,
                 progressRef: { ...ctx.wbScanProgress.value } };
    })()`, 900000);
    info('数字变化序列（去重后）', JSON.stringify(num.distinct));
    info('进度条宽度变化（去重后）', `${num.barCount} 种：${JSON.stringify(num.barWidths.slice(0, 14))}`);
    info('结束后 wbScanProgress', JSON.stringify(num.progressRef));
    console.log(`   ⇒ 数字：${num.n > 1 ? '✅ 确实在走动（' + num.n + ' 个不同取值）' : '❌ 全程只有 ' + num.n + ' 个取值'}`);
    console.log(`   ⇒ 宽度：${num.barCount > 1 ? '✅ 确实在推进（' + num.barCount + ' 种宽度）' : '❌ 宽度未变化'}`);

    // ── ② 二次打开：陈旧结果 ──
    head('② 二次打开：扫描期间是否显示上一轮的陈旧结果');
    const second = await evaluate(`(async () => {
        const ctx = ${CTX};
        const groupsBeforeOpen = ctx.wbDuplicateGroups.value.length;
        const showBeforeOpen = ctx.showWbDedupeModal.value;
        const samples = [];
        const timer = setInterval(() => {
            samples.push({
                show: ctx.showWbDedupeModal.value,
                scanning: ctx.dedupeScanning.value,
                groups: ctx.wbDuplicateGroups.value.length,
                done: ctx.wbScanProgress.value.done
            });
        }, 50);
        await ctx.startWorldbookDedupeScan();
        clearInterval(timer);
        await new Promise(r => setTimeout(r, 700));
        const stale = samples.filter(s => s.show && s.scanning && s.groups > 0);
        return {
            groupsBeforeOpen, showBeforeOpen,
            staleCount: stale.length, total: samples.length,
            firstStale: stale[0] || null, groupsAfter: ctx.wbDuplicateGroups.value.length
        };
    })()`, 900000);
    info('调用前状态', `showWbDedupeModal=${second.showBeforeOpen}，wbDuplicateGroups=${second.groupsBeforeOpen} 组`);
    info('采样', `${second.total} 次，其中「弹窗已开+扫描中+已有结果」${second.staleCount} 次`);
    console.log(`   ⇒ ${second.staleCount > 0 ? '❌ 命中问题②：扫描期间就渲染了**上一轮的陈旧结果**' : '✅ 无陈旧结果'}`);
    if (second.firstStale) info('首个陈旧采样', JSON.stringify(second.firstStale));

    // ── ③ 流畅性：longtask + 事件循环延迟 ──
    head('③ 流畅性：扫描期 / 差异弹窗期（longtask + 事件循环延迟）');
    const perf = await evaluate(`(async () => {
        const ctx = ${CTX};
        const run = async (label, fn) => {
            await window.__perf.start();
            const t0 = performance.now();
            await fn();
            const dur = performance.now() - t0;
            const r = window.__perf.stop();
            const lag = r.lag.slice().sort((a,b)=>a-b);
            const p = (q) => lag.length ? lag[Math.min(lag.length-1, Math.floor(lag.length*q))] : 0;
            const lt = r.longtasks.slice().sort((a,b)=>b.d-a.d);
            return {
                label, dur: Math.round(dur), samples: lag.length,
                lagP50: p(0.5), lagP95: p(0.95), lagMax: lag.length ? lag[lag.length-1] : 0,
                longtaskCount: r.longtasks.length,
                longtaskTop: lt.slice(0, 5).map(x => x.d),
                longtaskTotal: r.longtasks.reduce((s,x)=>s+x.d, 0)
            };
        };
        const out = [];
        out.push(await run('查重扫描期', () => ctx.startWorldbookDedupeScan()));
        out.push(await run('差异弹窗打开', async () => {
            const g = ctx.wbDuplicateGroups.value[0];
            if (g && g.list && g.list.length >= 2) {
                const t0 = performance.now();
                ctx.openDiffDetailModal(g.list[0], g.list[1]);
                await new Promise(r => setTimeout(r, 300));
                window.__diffOpenMs = Math.round(performance.now() - t0);
                await new Promise(r => setTimeout(r, 1500));
                ctx.showDiffDetailModal.value = false;
            }
        }));
        return { out, diffOpenMs: window.__diffOpenMs || null };
    })()`, 900000);
    for (const f of perf.out) {
        info(`${f.label}（${f.dur}ms，${f.samples} 次采样）`,
            `延迟 p50=${f.lagP50}ms p95=${f.lagP95}ms max=${f.lagMax}ms`);
        info('  longtask', `${f.longtaskCount} 个（总 ${f.longtaskTotal}ms），最长 5 个：${JSON.stringify(f.longtaskTop)}ms`);
        const verdict = f.longtaskTop[0] > 1000 ? '❌ 有严重卡顿（单次 >1s）'
            : f.longtaskTop[0] > 300 ? '⚠️ 有明显卡顿（单次 >300ms）'
            : f.longtaskCount > 5 ? '⚠️ 有轻微卡顿' : '✅ 流畅';
        console.log(`   ⇒ ${verdict}`);
    }
    info('差异弹窗打开耗时', `${perf.diffOpenMs}ms`);

    process.exit(0);
})().catch((e) => { console.error('UX PROBE FAILED:', e.message); process.exit(1); });
