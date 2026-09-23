/**
 * 差异弹窗卡顿修复验证（2026-09-22）
 *
 * 用法：node scripts/probes/_probe-diff-perf.mjs [世界书目录]
 *
 * 背景：用户反馈「扫描对比的窗口是否有卡顿点」。实测定位：
 *   · 算法部分只 **29ms**（不是瓶颈）
 *   · 但整篇比对 + 397 个词条卡片一次性渲染 → **34,232 个 DOM 节点**
 *   · 单次长任务 **750ms**、事件循环延迟 max **843ms**
 *   ⇒ 修：整篇比对**默认折叠** + 长列表**分块渲染** + 词条卡片**分页**
 *
 * ⚠️ 两个测量陷阱（v1 踩过）：
 *   ① 同名查重组内都是**完全相同的副本** → 没差异 → 整篇比对块本就不出现。
 *      必须拿「基准 vs 改写变体」（不同名、内容有差异）才测得到。
 *   ② 用 `requestAnimationFrame` 等「渲染完成」→ **后台窗口下 rAF 根本不触发**，
 *      探针会一直卡到窗口被激活（实测读出 191333ms 的假耗时）。
 *      ⇒ 改用「两次 `setTimeout(0)`」（宏任务双跳）作为渲染完成点。
 *   ③ 把 `setTimeout(900)` 算进「打开耗时」→ 读数虚高。
 *
 * ⚠️ 为什么用「DOM 节点数」当主判据：后台窗口下 rAF 不触发、定时器被节流，
 *   longtask/lag 采样极不稳定（同一改动实测 0 个 vs 1 个）。DOM 节点数是**确定性**指标。
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const WB_DIR = process.argv[2] || 'D:\\TkDmGzq\\_wbscale\\s100';
const BASE_NAME = '炎孕-异世界工口学院物语-威力加强版 世界书.json';
const VAR_NAMES = ['炎孕-改写A.json', '炎孕-改写D.json'];

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
// 选定「基准 vs 改写变体」并打开差异弹窗，返回可序列化快照
const OPEN = `(async () => {
    const ctx = ${CTX};
    const all = ctx.worldbooks.value;
    const A = all.find(w => w.name === ${JSON.stringify(BASE_NAME)});
    const B = all.find(w => w.name === ${JSON.stringify(VAR_NAMES[0])}) || all.find(w => w.name === ${JSON.stringify(VAR_NAMES[1])});
    if (!A || !B) return { err: '未找到基准/变体', sample: all.map(w => w.name).slice(0, 10) };
    const base = document.querySelectorAll('*').length;
    const t0 = performance.now();
    ctx.openDiffDetailModal(A, B);
    const syncMs = Math.round(performance.now() - t0);
    // ⚠️ 不能用 requestAnimationFrame：后台窗口下不触发（会卡到窗口激活）
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const renderMs = Math.round(performance.now() - t0);
    const modal = document.querySelector('.fixed.inset-0.z-\\\\[110\\\\]') || document.body;
    const txt = modal.innerText || '';
    return {
        ok: true, base, syncMs, renderMs,
        domNodes: modal.querySelectorAll('*').length,
        domTotal: document.querySelectorAll('*').length,
        hasCollapsedBtn: /展开整篇比对/.test(txt),
        collapsedRows: (txt.match(/共 (\\d+) 行/) || [])[1] || null,
        pairsShown: (txt.match(/显示前 (\\d+) \\/ (\\d+) 个词条/) || []).slice(1, 3),
        hasShowMorePairs: /显示更多词条/.test(txt),
        sameFolded: /两版内容完全一致/.test(txt)
    };
})()`;

const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);
const head = (n) => console.log(`\n───── ${n} ─────`);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `目录 ${WB_DIR}`);

    await evaluate(`(async () => {
        const ctx = ${CTX};
        ctx.appMode.value = 'worldbooks';
        if (!ctx.worldbooks.value.length) await ctx.scanWorldbookDir(${JSON.stringify(WB_DIR)});
        return ctx.worldbooks.value.length;
    })()`, 900000);
    info('世界书库', `${await evaluate(`(() => { const c = ${CTX}; return c.worldbooks.value.length; })()`)} 本`);

    // ── ① 默认态（整篇比对应折叠）──
    head('① 差异弹窗默认态（DOM 规模 / 首屏耗时）');
    const r1 = await evaluate(OPEN, 900000);
    if (!r1.ok) { console.error('无法继续：', JSON.stringify(r1)); process.exit(1); }
    info('弹窗 DOM', `${r1.domNodes} 个节点（基线 34,232），全页 ${r1.domTotal}（开窗前 ${r1.base}）`);
    info('耗时', `同步算法 ${r1.syncMs}ms，首屏渲染完成 ${r1.renderMs}ms`);
    info('整篇比对', `折叠按钮=${r1.hasCollapsedBtn}，行数=${r1.collapsedRows}，「完全一致」占位=${r1.sameFolded}`);
    info('词条分页', `显示前 ${JSON.stringify(r1.pairsShown)}，有「显示更多词条」=${r1.hasShowMorePairs}`);
    check('整篇比对**默认折叠**（有「展开整篇比对」按钮）', r1.hasCollapsedBtn === true,
        `hasBtn=${r1.hasCollapsedBtn} sameFolded=${r1.sameFolded}`);
    check('词条级对齐**已分页**（显示前 N / 总数）', Array.isArray(r1.pairsShown) && r1.pairsShown.length === 2,
        JSON.stringify(r1.pairsShown));
    check('★ DOM 节点数大幅下降（< 1.2 万，基线 34,232）', r1.domNodes < 12000, `${r1.domNodes} 个`);
    check('首屏渲染 < 500ms（基线 ~900ms）', r1.renderMs < 500, `${r1.renderMs}ms`);

    // ── ② 展开整篇比对（分块渲染应生效）──
    head('② 展开整篇比对（分块渲染）');
    const r2 = await evaluate(`(async () => {
        const btn = [...document.querySelectorAll('button')].find(b => /展开整篇比对/.test(b.textContent || ''));
        if (!btn) return { err: '未找到展开按钮' };
        const before = document.querySelectorAll('*').length;
        const t0 = performance.now();
        btn.click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        const ms = Math.round(performance.now() - t0);
        const after = document.querySelectorAll('*').length;
        const txt = document.body.innerText || '';
        return { before, after, delta: after - before, ms,
                 hasMore: /显示更多（已渲染/.test(txt),
                 shown: (txt.match(/已渲染 (\\d+) \\/ (\\d+) 行/) || []).slice(1, 3) };
    })()`, 900000);
    info('展开后', `节点 ${r2.before} → ${r2.after}（+${r2.delta}），耗时 ${r2.ms}ms`);
    info('分块渲染', `已渲染/总行 ${JSON.stringify(r2.shown)}，有「显示更多」=${r2.hasMore}`);
    check('展开是**分块**渲染（不是一次全渲染）', r2.hasMore === true, JSON.stringify(r2.shown));
    check('展开增量为受控（< 1.5 万节点）', r2.delta < 15000, `+${r2.delta}`);
    check('展开耗时 < 500ms', r2.ms < 500, `${r2.ms}ms`);

    // ── ③ 关闭再打开：状态复位 ──
    head('③ 关闭再打开（状态复位，不残留上次展开）');
    await evaluate(`(() => { const c = ${CTX}; c.showDiffDetailModal.value = false; return true; })()`);
    await new Promise(r => setTimeout(r, 500));
    const r3 = await evaluate(OPEN, 900000);
    info('重开后', `折叠态=${r3.hasCollapsedBtn}，DOM ${r3.domNodes} 个，词条显示数=${(r3.pairsShown || [])[0]}`);
    check('重开后回到折叠态', r3.hasCollapsedBtn === true);
    check('重开后 DOM 未累积', r3.domNodes < 12000, `${r3.domNodes} 个`);
    check('重开后词条分页回到首页（30）', String((r3.pairsShown || [])[0]) === '30', JSON.stringify(r3.pairsShown));

    await evaluate(`(() => { const c = ${CTX}; c.showDiffDetailModal.value = false; return true; })()`);

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 差异弹窗卡顿修复：${pass}/${results.length} 通过 ═════`);
    console.log(`DOM 节点：基线 34,232 → 现在 ${r1.domNodes}（降幅 ${(100 - r1.domNodes / 34232 * 100).toFixed(1)}%）`);
    console.log(`首屏渲染：基线 ~900ms → 现在 ${r1.renderMs}ms`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('DIFF PERF PROBE FAILED:', e.message); process.exit(1); });
