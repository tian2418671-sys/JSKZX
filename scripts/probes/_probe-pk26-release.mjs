/**
 * PK-26 后续专项：验证「同名查重读完正文后用后释放」确实生效（防 PK-20 OOM 重演）。
 *
 * 为什么单独一个探针：`_probe-wb-stress-5k.mjs` 里 D1 之后还有 D2/D3/D4，
 * 堆水位会被后续步骤污染，无法干净地判断「释放」是否生效。
 * 本脚本只做一件事：跑同名查重 → 立刻 GC → 断言 heavy 的书 data 回到 null 且堆回落。
 *
 * 用法：node scripts/probes/_probe-pk26-release.mjs "<世界书目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-pk26-release.mjs <目录>'); process.exit(1); }

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
const ev = async (expr, t = 3600000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const gc = async () => { try { await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage'); } catch (e) { /* 忽略 */ } };
const memMB = () => ev(`(() => { const m = performance.memory || {}; return Math.round((m.usedJSHeapSize||0)/1048576); })()`);

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

console.log(`═════ PK-26 用后释放专项：${DIR} ═════`);

// 1. 扫描入库
const scan = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 2500));
    const list = ctx.worldbooks.value;
    return {
        total: list.length,
        heavy: list.filter(w => w.heavy).length,
        loadedAfterScan: list.filter(w => w.dataLoaded === true).length
    };
})()`);
info('扫描完成', `${scan.total} 本（heavy ${scan.heavy}，扫描后已载入 ${scan.loadedAfterScan}）`);

await gc();
const memBefore = await memMB();
info('查重前堆（GC 后）', `${memBefore}MB`);

// 2. 跑同名查重
//    🛑 **判据已随架构演进更新（2026-09-23）**：
//       · **PK-26 时代**：同名查重**真的逐本读正文** → 正确判据是「峰值 > 查重前，终值回落到查重前」；
//       · **S2' 之后**：同名查重**只读 L1 索引（`keyHashes` 整数比较）**，**完全不读正文** ⇒
//         「峰值 > 查重前」**不再是正确性证据，反而是回归**。
//    ⚠️ 但 `startWorldbookDedupeScan()` 内部会**重扫磁盘**，而重扫按 PK-20 的**内联预算**
//       主动载入少量书 → 终值不为 0 是**正常**的（实测 s1000：57 本）。
//    ⇒ 正确判据：**查重比对阶段不得新增载入**（峰值 ≈ 终值）+ 总量受控 + L1 索引可用。
const dedupe = await ev(`(async () => {
    const ctx = ${CTX};
    const loadedCount = () => ctx.worldbooks.value.filter(w => w.dataLoaded === true).length;
    const loadedHeavyCount = () => ctx.worldbooks.value.filter(w => w.heavy && w.dataLoaded === true).length;

    const before = { all: loadedCount(), heavy: loadedHeavyCount() };
    let peakAll = before.all, peakHeavy = before.heavy;
    const timer = setInterval(() => {
        const a = loadedCount(), h = loadedHeavyCount();
        if (a > peakAll) peakAll = a;
        if (h > peakHeavy) peakHeavy = h;
    }, 50);

    const t0 = performance.now();
    try {
        await ctx.startWorldbookDedupeScan();
        await new Promise(r => setTimeout(r, 1500));
    } finally {
        clearInterval(timer);
    }
    const list = ctx.worldbooks.value;
    return {
        ms: Math.round(performance.now() - t0),
        groups: ctx.wbDuplicateGroups.value.length,
        beforeAll: before.all, beforeHeavy: before.heavy,
        peakAll, peakHeavy,
        afterAll: loadedCount(), afterHeavy: loadedHeavyCount(),
        total: list.length,
        // 🛑 S2' 判据：L1 索引覆盖率（反证「不读正文」是因为有索引，而非没索引）
        withKeyHashes: list.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length > 0).length,
        // 抽样：确认 entryCount 是真实值（不是 0）
        sampleCounts: list.slice(0, 5).map(w => ctx.wbEntryCount(w))
    };
})()`, 3600000);
info('同名查重', `${(dedupe.ms / 1000).toFixed(1)}s，${dedupe.groups} 组`);
info('已载入本数：查重前 → 峰值 → 查重后',
    `全部 ${dedupe.beforeAll} → **${dedupe.peakAll}** → ${dedupe.afterAll}`
    + ` ｜ heavy ${dedupe.beforeHeavy} → **${dedupe.peakHeavy}** → ${dedupe.afterHeavy}`);

await gc();
const memAfter = await memMB();
info('查重后堆（GC 后）', `${memAfter}MB（相对查重前 ${memAfter - memBefore >= 0 ? '+' : ''}${memAfter - memBefore}MB）`);

check('同名查重完成且出结果', dedupe.groups > 0, `${dedupe.groups} 组`);
// ★ **S2' 之后的正确判据**（见上方「判据已随架构演进更新」注释）：
//   ① 查重比对**不得新增载入正文**（峰值 ≈ 终值）—— 这证明「只读 L1 索引」确实生效；
//   ② L1 索引必须可用（反证：否则「不读正文」是因为没索引，而非设计如此）。
check('★ 查重比对不新增载入正文（S2\' 后只读 L1 索引 → 峰值 ≈ 终值）',
    dedupe.peakHeavy - dedupe.afterHeavy <= 3,
    `查重前 ${dedupe.beforeHeavy} → 峰值 ${dedupe.peakHeavy} → 终值 ${dedupe.afterHeavy}（终值来自重扫内联预算，非查重）`);
check('★ L1 索引已到达渲染层（查重只读索引的前提）',
    dedupe.withKeyHashes >= dedupe.total * 0.9,
    `${dedupe.withKeyHashes}/${dedupe.total}`);
check('★ 未把全部 1001 本留在内存（防 PK-20 OOM 重演）',
    // ⚠️ 判据口径（2026-09-23 修正）：**终值 = 重扫的内联预算**（PK-20 既有设计，约 5%），
    //    不是「泄漏」。故阈值取 **15%**（留足余量；真泄漏会是 100%）。
    dedupe.afterHeavy < dedupe.total * 0.15,
    `终值 ${dedupe.afterHeavy} / 共 ${dedupe.total} 本（${(dedupe.afterHeavy / dedupe.total * 100).toFixed(1)}%，上限 15%）`);
check('★ 词条数取真实值（非 0）', dedupe.sampleCounts.every(v => v > 0), JSON.stringify(dedupe.sampleCounts));
check('★ 堆未失控（< 上限 50%）', memAfter < 4192 * 0.5, `${memAfter}MB / 4192MB`);

const bad = errs.filter(t => /TypeError|Cannot read|is not a function|out of memory|Invalid string length|Array buffer allocation|before initialization/i.test(t));
check('无渲染期错误 / OOM', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

const pass = results.filter(x => x.ok).length;
console.log(`\n═════ 结果：${pass}/${results.length} 通过 ═════`);
process.exit(pass === results.length ? 0 : 1);
