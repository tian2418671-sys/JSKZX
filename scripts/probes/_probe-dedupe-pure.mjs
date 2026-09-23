/**
 * S2' 纯查重耗时验证（**跳过「查重前重扫」**）
 *
 * 背景：`startWorldbookDedupeScan()` 含两步：
 *   ① `rescanForWorldbookDedupe()` —— 重扫目录（读全部文件，s1000 实测 ~58s）
 *   ② 查重本身（旧版：逐本读正文算 keys；新版 S2'：**只读 L1 整数比较**）
 * 总耗时被 ① 主导 → 无法判断 ② 的改善。
 * ⇒ 本探针**手动执行 ② 的核心逻辑**（不调 rescan），单独量它。
 *
 * 用法：node scripts/probes/_probe-dedupe-pure.mjs
 *   前置：应用已 `scanWorldbookDir(<目录>)` 完成（worldbooks 已带 keyHashes）
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

console.log('═════ S2\' 纯查重（跳过重扫） ═════');

const r = await ev(`(async () => {
    const ctx = ${CTX};
    const L = ctx.worldbooks.value;
    if (!L.length) return { err: '库为空 —— 请先 scanWorldbookDir' };
    const withIdx = L.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length);

    // ── 复刻 startWorldbookDedupeScan 的②（查重本身），但**不重扫** ──
    const t0 = performance.now();

    // 1. 按书名聚类
    const groups = {};
    L.forEach(wb => {
        const name = ((wb.wbName || wb.name || '').replace(/\\.json$/i, '')).trim() || '未命名';
        (groups[name] = groups[name] || []).push(wb);
    });
    const potential = Object.entries(groups).filter(([, list]) => list.length > 1);

    // 2. 组内**直接全量精算**（S2' 定稿：不预筛 —— 同名分组已把范围缩到组内）
    const MAXC = 2000;
    const jac = (a, b) => {
        const A = a.keyHashes, B = b.keyHashes;
        if (!A || !B || !A.length || !B.length) return null;
        const la = Math.min(MAXC, A.length), lb = Math.min(MAXC, B.length);
        let i = 0, j = 0, inter = 0;
        while (i < la && j < lb) { const x = A[i], y = B[j]; if (x === y) { inter++; i++; j++; } else if (x < y) i++; else j++; }
        const u = la + lb - inter;
        return u ? inter / u : 0;
    };
    const tJac = performance.now();
    let cmpCount = 0;
    const out = [];
    for (const [name, list] of potential) {
        list.sort((a, b) => ((b.entryCount || 0) - (a.entryCount || 0)));
        const master = list[0];
        const rows = list.map((wb, i) => {
            if (i === 0) return { name: wb.wbName || wb.name, j: 100, entryCount: wb.entryCount };
            cmpCount++;
            const j = jac(master, wb);
            return { name: wb.wbName || wb.name, j: j === null ? null : Math.round(j * 100), entryCount: wb.entryCount };
        });
        out.push({ name, size: list.length, rows: rows.slice(0, 3) });
    }
    const jacMs = Math.round(performance.now() - tJac);

    return {
        totalBooks: L.length, withIdx: withIdx.length,
        groups: potential.length,
        jacMs,
        totalMs: Math.round(performance.now() - t0),
        cmpCount,
        sample: out.slice(0, 3)
    };
})()`, 600000);

console.log(JSON.stringify(r, null, 2));

if (r && !r.err) {
    console.log('\n───── 时间分解 ─────');
    console.log(`  组内精算      ${r.jacMs}ms（${r.cmpCount} 次比较，纯整数双指针）`);
    console.log(`  查重总计      **${r.totalMs}ms**（对比旧版「逐本读正文」70.8s）`);
    const ok = r.totalMs < 3000;
    console.log(`\n${ok ? '✅' : '❌'} 纯查重 < 3s：${r.totalMs}ms`);
}
