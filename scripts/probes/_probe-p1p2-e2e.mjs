/**
 * P1-P2 端到端验证（2026-09-23）
 *
 * 验什么：
 *   · **P1-2 流式提取**：真实库上 `wb:meta` 对超大书能产出 keys（不再「永远无法参与查重」）
 *   · **P2-1 按需分批**：阶段 2 首批（120 本）完成后**书名立刻可见**，其余后台续补
 *   · **P1-1 simhash 落盘**：默认关闭时 `simhash` 应为 null；开启（`JSK_WB_SIMHASH=1`）才有值
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-p1p2-e2e.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-p1p2-e2e.mjs "<目录>"'); process.exit(1); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errs = [];
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

console.log('═════ P1-P2 端到端验证 ═════');
console.log(`目录：${DIR}`);

const DIR_LIT = JSON.stringify(DIR);
const r = await ev(`(async () => {
    const API = window.electronAPI;
    // ① 阶段 1（秒开）
    const t0 = performance.now();
    const fast = await API.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    const p1ms = Math.round(performance.now() - t0);
    const list = (fast && fast.data) || [];

    // ② 阶段 2（P2-1 分批：先 120 本）
    const pending = list.filter(w => w.metaPending).map(w => w.path);
    const FIRST = Math.min(pending.length, 120);
    const t1 = performance.now();
    const m1 = await API.fetchWorldbookMeta(pending.slice(0, FIRST));
    const firstMs = Math.round(performance.now() - t1);
    const d1 = (m1 && m1.data) || [];
    // ⚠️ wb:meta **也返回诱饵条目**（valid:false + wbName:null，供渲染层剔除）——
    //    故「书名补齐率」必须**只统计 valid !== false 的**（PK-24 的正确行为）。
    const valid1 = d1.filter(m => m.valid !== false);
    const named1 = valid1.filter(m => m.wbName).length;
    const withKeys1 = valid1.filter(m => Array.isArray(m.keyHashes) && m.keyHashes.length).length;
    const invalid1 = d1.length - valid1.length;

    // ③ P1-1 simhash 落盘状态（默认关闭 → 应全为 null）
    const withSimhash = d1.filter(m => Array.isArray(m.simhash) && m.simhash.length === 2).length;

    // ④ P1-2 oversized 流式提取（若库里有超大书）
    const oversized = d1.filter(m => m.oversized);
    const oversizedWithKeys = oversized.filter(m => Array.isArray(m.keyHashes) && m.keyHashes.length).length;
    const streamed = d1.filter(m => m.streamed);

    return {
        p1ms, p1count: list.length, pendingCount: pending.length,
        firstMs, firstCount: d1.length, requested: FIRST, named1, withKeys1, validCount: valid1.length, invalid1,
        withSimhash,
        oversizedCount: oversized.length, oversizedWithKeys,
        streamedCount: streamed.length,
        oversizedSample: oversized.slice(0, 3).map(m => ({ path: String(m.path).split('\\\\').pop().split('/').pop(), keys: (m.keyHashes || []).length, name: m.wbName, size: m.size }))
    };
})()`);

console.log('');
console.log(`① 阶段 1（秒开）：${r.p1ms}ms，列出 ${r.p1count} 本（待补元数据 ${r.pendingCount} 本）`);
console.log(`② 阶段 2 首批：${r.firstMs}ms，请求 ${r.requested} 本 → 返回 ${r.firstCount} 条（有效 ${r.validCount} / 诱饵 ${r.invalid1}），有书名 ${r.named1}，有 L1 索引 ${r.withKeys1}`);
console.log(`③ P1-1 simhash 落盘：${r.withSimhash}/${r.firstCount} 本有 simhash（默认关闭应为 0）`);
console.log(`④ P1-2 oversized 流式：超大书 ${r.oversizedCount} 本，其中**成功提取 keys** ${r.oversizedWithKeys} 本，标记 streamed ${r.streamedCount} 本`);
if (r.oversizedSample.length) {
    console.log('   超大书样本：');
    for (const s of r.oversizedSample) {
        console.log(`     · ${s.path}  ${(s.size / 1048576).toFixed(1)}MB  keys=${s.keys}  name=${s.name || '(无)'}`);
    }
}

console.log('');
console.log('───── 断言 ─────');
// ⚠️ 判据说明（探针踩过的坑）：`fetchWorldbookMeta` 返回的条数**不等于**请求数 ——
//    阶段 2 会顺带跑 `isValidWorldbook`，把诱饵（角色卡/预设/大表格/损坏 JSON）**剔除**
//    （PK-24 的正确行为）。故断言只能是「**返回的**都有书名」，不能要求「等于请求数」。
const checks = [
    ['① 阶段 1 秒开（<2000ms）', r.p1ms < 2000, `${r.p1ms}ms`],
    ['② 首批**有效条目**书名全部补齐（诱饵已标 valid:false）', r.named1 === r.validCount, `${r.named1}/${r.validCount}（有效 ${r.validCount} / 诱饵 ${r.invalid1}）`],
    ['② 首批 L1 索引覆盖（同上口径）', r.withKeys1 >= r.validCount * 0.9, `${r.withKeys1}/${r.validCount}`],
    ['③ simhash 默认关闭（未开启环境变量时全为 null）', r.withSimhash === 0, `${r.withSimhash} 本有 simhash`],
    ['④ P1-2 超大书能提取 keys（不再「永远无法参与查重」）',
        r.oversizedCount === 0 || r.oversizedWithKeys === r.oversizedCount,
        `${r.oversizedWithKeys}/${r.oversizedCount}`]
];
let pass = 0;
for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}  → ${detail}`);
    if (ok) pass++;
}

const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|out of memory|before initialization/i.test(t));
console.log(`${bad.length === 0 ? '✅' : '❌'} 无渲染期错误  → ${bad.slice(0, 2).join(' | ') || '无'}`);
if (bad.length === 0) pass++;

console.log('');
console.log(`═════ 结果：${pass}/${checks.length + 1} 通过 ═════`);
process.exit(pass === checks.length + 1 ? 0 : 1);
