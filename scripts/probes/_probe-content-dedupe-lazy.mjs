/**
 * 诊断：内容级查重在「懒加载库」上是否失效（PK-20 修复的副作用排查）
 *
 * 用法：node scripts/probes/_probe-content-dedupe-lazy.mjs [目录]
 *
 * 假设：`startContentDedupeScan` → `extractContentText(item)` 读 `item.data.entries`，
 *   但 PK-20 后大量书 `dataLoaded === false && data === null`
 *   → 提取到空文本 → 被 `text.length < 20` 跳过 → **无候选 → 0 组**。
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
const ev = async (expr, t = 900000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

const out = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    if (!ctx.worldbooks.value.length) await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 1500));
    const list = ctx.worldbooks.value;
    const withData = list.filter(w => w.dataLoaded === true);
    const noData = list.filter(w => w.dataLoaded === false);

    // 复刻 extractContentText（世界书分支）
    const extract = (item) => {
        const entries = (item.data && Array.isArray(item.data.entries)) ? item.data.entries : [];
        return entries.map(e => {
            if (!e || typeof e !== 'object') return '';
            const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
            return keys + ' ' + (e.content || '');
        }).join('\\n');
    };
    const normalize = (t) => String(t || '').replace(/\\s+/g, ' ').replace(/[^\\p{L}\\p{N}]+/gu, ' ').toLowerCase().trim();

    // 已内联的书：能提取多少文本？
    const inlineLens = withData.slice(0, 5).map(w => normalize(extract(w)).length);
    // 未内联的书：提取到多少？
    const lazyLens = noData.slice(0, 5).map(w => normalize(extract(w)).length);

    // 统计：能通过 text.length >= 20 的候选数
    let validInline = 0, validLazy = 0;
    for (const w of withData) if (normalize(extract(w)).length >= 20) validInline++;
    for (const w of noData) if (normalize(extract(w)).length >= 20) validLazy++;

    return {
        total: list.length,
        withDataCount: withData.length,
        noDataCount: noData.length,
        inlineLens, lazyLens,
        validInline, validLazy,
        // 内容级查重结果
        contentGroups: ctx.contentDuplicateGroups.value.length
    };
})()`, 900000);

console.log(`库：${out.total} 本（已内联 ${out.withDataCount} / 未内联 ${out.noDataCount}）`);
console.log(`\n已内联样本的提取文本长度：${JSON.stringify(out.inlineLens)}`);
console.log(`未内联样本的提取文本长度：${JSON.stringify(out.lazyLens)}`);
console.log(`\n能通过「文本 ≥ 20 字符」的候选数：`);
console.log(`  已内联：${out.validInline} / ${out.withDataCount}`);
console.log(`  未内联：${out.validLazy} / ${out.noDataCount}   ← 若为 0 则内容级查重对这些书**完全失效**`);
console.log(`\n内容级查重分组数：${out.contentGroups}`);
console.log(`\n⇒ ${out.validLazy === 0 && out.noDataCount > 0
    ? '❌ 确认缺陷：未内联的书提取不出文本 → 内容级查重失效（PK-20 的副作用）'
    : '✅ 未内联的书也能提取文本'}`);
process.exit(0);
