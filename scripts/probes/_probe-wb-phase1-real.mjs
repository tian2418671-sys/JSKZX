/**
 * 阶段 1（秒开）真实耗时与回包体积实测（2026-09-23）
 *
 * 用真实应用（CDP）测 `scanWorldbooks(dir, { fastListOnly: true })`：
 *   · 主进程侧耗时（IPC 往返）
 *   · 回包 JSON 体积（含 / 不含 keyHashes 对比）
 *   · 渲染层接收后的堆占用
 *
 * 目的：验证「改成只读文件名」能省多少 —— 重点是**回包体积**，不是 stat。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-wb-phase1-real.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-wb-phase1-real.mjs "<目录>"'); process.exit(1); }

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

const DIR_LIT = JSON.stringify(DIR);
console.log('═════ 阶段 1 真实耗时与回包体积 ═════');
console.log(`目录：${DIR}`);
console.log('');

const r = await ev(`(async () => {
    const API = window.electronAPI;
    const heap = () => { const m = performance.memory || {}; return Math.round((m.usedJSHeapSize||0)/1048576); };

    // ① 首次（冷缓存）：阶段 1
    const h0 = heap();
    let t = performance.now();
    const cold = await API.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    const coldMs = Math.round(performance.now() - t);
    const coldHeap = heap();
    const coldData = (cold && cold.data) || [];

    // ② 二次（热缓存）：阶段 1
    t = performance.now();
    const warm = await API.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    const warmMs = Math.round(performance.now() - t);
    const warmData = (warm && warm.data) || [];

    // ③ 完整扫描（含 L1 摘要）
    t = performance.now();
    const full = await API.scanWorldbooks(${DIR_LIT});
    const fullMs = Math.round(performance.now() - t);
    const fullData = (full && full.data) || [];

    const withKH = fullData.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length).length;
    const khLen = fullData.filter(w => Array.isArray(w.keyHashes)).map(w => w.keyHashes.length);
    const avgKH = khLen.length ? Math.round(khLen.reduce((a,b)=>a+b,0)/khLen.length) : 0;

    return {
        coldMs, warmMs, fullMs,
        coldCount: coldData.length, warmCount: warmData.length, fullCount: fullData.length,
        heap: { before: h0, afterCold: coldHeap },
        withKH, avgKH,
        // 阶段 1 回包体积（粗算：字段级）
        coldBytes: JSON.stringify(coldData).length,
        warmBytes: JSON.stringify(warmData).length,
        // 阶段 1 回包是否带 keyHashes（热缓存命中时会带 → 这是体积大头）
        coldHasKH: coldData.filter(w => Array.isArray(w.keyHashes)).length,
        warmHasKH: warmData.filter(w => Array.isArray(w.keyHashes)).length,
        // 只读名字的对照：仅 path+name
        namesOnlyBytes: JSON.stringify(coldData.map(w => ({ path: w.path, name: w.name }))).length,
        // 阶段 1 字段清单（取样一本）
        sampleKeys: Object.keys(coldData[0] || {}),
        warmSampleKeys: Object.keys(warmData[0] || {}),
        inlineMB: full && full.inlineMB
    };
})()`);

console.log(`① 冷缓存阶段 1：${r.coldMs}ms，${r.coldCount} 本，回包 ${(r.coldBytes/1048576).toFixed(2)}MB，带 keyHashes ${r.coldHasKH} 本`);
console.log(`② 热缓存阶段 1：${r.warmMs}ms，${r.warmCount} 本，回包 ${(r.warmBytes/1048576).toFixed(2)}MB，带 keyHashes ${r.warmHasKH} 本`);
console.log(`③ 完整扫描：   ${r.fullMs}ms，${r.fullCount} 本，L1 覆盖 ${r.withKH}/${r.fullCount}（均长 ${r.avgKH}）`);
console.log('');
console.log(`渲染堆：${r.heap.before}MB → ${r.heap.afterCold}MB（阶段 1 后）`);
console.log('');
console.log('───── 回包体积对比 ─────');
console.log(`现状（阶段 1 全字段）：   ${(r.coldBytes/1048576).toFixed(2)}MB`);
console.log(`只读名字（path+name）：   ${(r.namesOnlyBytes/1048576).toFixed(2)}MB`);
console.log(`⇒ 体积比 ${(r.coldBytes / r.namesOnlyBytes).toFixed(1)}×`);
console.log('');
console.log(`阶段 1 字段：${JSON.stringify(r.sampleKeys)}`);
console.log(`热缓存字段：${JSON.stringify(r.warmSampleKeys)}`);
