/**
 * 世界书库加载速度实测（分阶段独立计时）
 *
 * 目的：回答「5000 本加载多少秒 + 有无提速空间」。
 * 设计：**不调用 `scanWorldbookDir`**（那会同时触发 UI 渲染），
 *      只直调 `scanWorldbooks` / `fetchWorldbookMeta`，**分阶段独立计时**。
 *
 * 用法：node scripts/probes/_probe-load-speed.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-load-speed.mjs <目录>'); process.exit(1); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
if (!pg) { console.error('未找到 page target'); process.exit(1); }
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
const fmt = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

console.log(`═════ 世界书库加载速度实测 ═════`);
console.log(`目录：${DIR}\n`);

// ① 阶段 1（readdir + stat，完全不读内容）
const p1 = await ev(`(async () => {
    const t = performance.now();
    const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)}, { fastListOnly: true });
    const d = (r && r.data) || [];
    return {
        ms: Math.round(performance.now() - t),
        count: d.length,
        skipped: (r && r.skipped || []).length,
        metaPending: d.filter(w => w.metaPending).length
    };
})()`, 900000);
console.log('① 阶段 1（readdir + stat，**零读盘**）');
console.log(`   耗时 **${fmt(p1.ms)}** ｜ 列出 ${p1.count} 本 ｜ 跳过 ${p1.skipped} ｜ 待补元数据 ${p1.metaPending}`);

// ② 阶段 2（读全文 + parse + L1 摘要）—— 只测待补的那批
let p2 = { ms: 0, n: 0, withL1: 0, oversized: 0, perBook: 0 };
if (p1.metaPending > 0) {
    p2 = await ev(`(async () => {
        const r0 = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)}, { fastListOnly: true });
        const paths = ((r0 && r0.data) || []).filter(w => w.metaPending).map(w => w.path);
        const t = performance.now();
        const meta = await window.electronAPI.fetchWorldbookMeta(paths);
        const ms = Math.round(performance.now() - t);
        const withL1 = ((meta && meta.data) || []).filter(m => Array.isArray(m.keyHashes) && m.keyHashes.length).length;
        return { ms, n: paths.length, withL1, oversized: (meta && meta.oversized) || 0 };
    })()`, 3600000);
    p2.perBook = p2.ms / Math.max(1, p2.n);
    console.log(`\n② 阶段 2（读全文 + JSON.parse + L1 摘要）`);
    console.log(`   耗时 **${fmt(p2.ms)}** ｜ 处理 ${p2.n} 本 ｜ L1 覆盖 ${p2.withL1} ｜ oversized ${p2.oversized}`);
    console.log(`   单本 **${p2.perBook.toFixed(1)}ms**`);
} else {
    console.log('\n② 阶段 2：**0 本待补**（缓存全命中 → 零读盘）');
}

// ③ 阶段 1 复测（缓存已热）
const p1b = await ev(`(async () => {
    const t = performance.now();
    const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)}, { fastListOnly: true });
    const d = (r && r.data) || [];
    return { ms: Math.round(performance.now() - t), count: d.length, metaPending: d.filter(w => w.metaPending).length };
})()`, 900000);
console.log(`\n③ 阶段 1 复测（缓存已热）`);
console.log(`   耗时 **${fmt(p1b.ms)}** ｜ 列出 ${p1b.count} 本 ｜ 待补 ${p1b.metaPending}`);

// ── 汇总 ──
console.log('\n═════ 汇总 ═════');
console.log(`本数                      ${p1.count}`);
console.log(`① 阶段 1（秒开）          **${fmt(p1.ms)}**   ← 用户感知首屏`);
console.log(`② 阶段 2（元数据 + L1）   **${fmt(p2.ms)}**   ← 后台补，不阻塞首屏`);
console.log(`③ 阶段 1 复测（热）       **${fmt(p1b.ms)}**`);
console.log(`\n冷启动总耗时（主进程侧）  **${fmt(p1.ms + p2.ms)}**`);
console.log(`热启动总耗时              **${fmt(p1b.ms)}**`);
if (p2.perBook > 0) {
    console.log(`\n阶段 2 单本 ${p2.perBook.toFixed(1)}ms ｜ 其中 JSON.parse ≈ 31ms/本（L1 探针实测）、keys hash ≈ 0.04ms/本`);
    console.log(`⇒ 阶段 2 瓶颈 = **读盘 + parse**（不可避免，除非跳过已缓存文件）`);
}
