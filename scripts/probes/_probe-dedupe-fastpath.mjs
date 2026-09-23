/**
 * 查重「按需重扫」修复验证（2026-09-23）
 *
 * 背景：修复后查重会检查「L1 索引覆盖率」，足够则**跳过全量重扫**（秒级）。
 *   但探针若在 `scanWorldbookDir` 后**立刻**查重，索引可能还没补齐（P2-1 后台续补）
 *   → 会走重扫路径。本探针**先等索引就绪**，再测查重耗时。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-dedupe-fastpath.mjs "<目录>"
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-dedupe-fastpath.mjs "<目录>"'); process.exit(1); }

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
const DIR_LIT = JSON.stringify(DIR);

console.log('═════ 查重「按需重扫」快速路径验证 ═════');
console.log(`目录：${DIR}`);
console.log('');

// ① 加载库并**等索引补齐**
console.log('① 加载库 + 等待 L1 索引补齐（P2-1 后台续补）…');
await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${DIR_LIT});
    return true;
})()`);

// 轮询等索引就绪（最多 10 分钟）
let waited = 0, cover = { withIndex: 0, total: 0, filling: true };
while (waited < 600000) {
    cover = await ev(`(() => {
        const ctx = ${CTX};
        const l = ctx.worldbooks.value || [];
        return {
            withIndex: l.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length > 0).length,
            total: l.length,
            filling: !!ctx.wbMetaFilling.value
        };
    })()`);
    if (!cover.filling && cover.withIndex >= cover.total * 0.9) break;
    await new Promise(r => setTimeout(r, 2000));
    waited += 2000;
}
console.log(`   索引覆盖 ${cover.withIndex}/${cover.total}（等待 ${(waited / 1000).toFixed(0)}s，续补中=${cover.filling}）`);
console.log('');

// ② 查重（应走快速路径）
console.log('② 跑同名查重（索引已就绪 → 应**跳过重扫**）…');
const r = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    const t0 = performance.now();
    await ctx.startWorldbookDedupeScan();
    await new Promise(x => setTimeout(x, 2500));
    return {
        ms: Math.round(performance.now() - t0),
        groups: (ctx.wbDuplicateGroups.value || []).length,
        scanning: !!ctx.dedupeScanning.value,
        pct: ctx.dedupeScanPercent.value
    };
})()`, 1800000);

console.log(`   耗时：**${(r.ms / 1000).toFixed(2)}s** ｜ ${r.groups} 组 ｜ 收尾 pct=${r.pct} scanning=${r.scanning}`);
console.log('');

console.log('───── 判定 ─────');
if (r.ms < 30000) {
    console.log(`✅ **快速路径生效**：${(r.ms / 1000).toFixed(2)}s（修复前 s1000 需 ~202s）`);
    console.log(`   ⇒ 提速约 ${(202000 / r.ms).toFixed(0)}×`);
} else {
    console.log(`⚠️ 仍走了重扫（${(r.ms / 1000).toFixed(1)}s）—— 检查索引覆盖率判据`);
}
console.log('');
console.log(`（对比：修复前 s1000 同名查重 ~202s = 全量重读 7GB 正文）`);
process.exit(r.ms < 30000 ? 0 : 1);
