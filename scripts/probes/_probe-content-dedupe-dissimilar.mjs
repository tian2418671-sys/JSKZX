/**
 * 内容级查重「不相似的书被聚成一组」排查（2026-09-23 用户报出）
 *
 * 用户原话：「两完全不相似的的世界书进行对比查重」（被判为重复）
 *
 * 排查方向：
 *   · 分组内每本书的 simhash 与组内「master」的**汉明距离**（判定依据）
 *   · 组内**两两**汉明距离矩阵（是否出现「A~B 近、B~C 近，但 A~C 远」的链式误聚）
 *   · 落盘 simhash（L1b）与运行时算的 simhash 是否**同口径**
 *   · 归一化文本长度（是否因文本过短导致 simhash 退化）
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-content-dedupe-dissimilar.mjs [世界书目录]
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'H:\\01\\全局世界书';

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
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
    const app = document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

console.log('═════ 内容级查重 · 不相似误聚排查 ═════');
console.log(`目录：${DIR}`);
console.log('');

const out = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 2000));
    const n = ctx.worldbooks.value.length;

    await ctx.startContentDedupeScan();
    await new Promise(r => setTimeout(r, 1500));
    const groups = ctx.contentDuplicateGroups.value || [];

    // 独立复算：对每本书**重新**提取文本并算 simhash（不复用查重内部状态），
    // 用于与查重结果交叉验证（口径是否一致）。
    const lib = ctx.worldbooks.value;
    const recomp = {};
    for (const wb of lib) {
        try {
            const t = await ctx.extractContentText(wb);
            const norm = String(t || '').replace(/\\s+/g, ' ').replace(/[^\\p{L}\\p{N}]+/gu, ' ').toLowerCase().trim();
            if (norm.length >= 20) recomp[wb.path] = { sig: ctx.computeSimhash(norm), len: norm.length };
        } catch (e) { /* skip */ }
    }

    const hd = (a, b) => {
        let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
        while (x) { c += x & 1; x >>>= 1; }
        while (y) { c += y & 1; y >>>= 1; }
        return c;
    };

    return {
        libCount: n,
        groups: groups.length,
        detail: groups.map(g => {
            const list = g.list || [];
            const names = list.map(v => v._name || (v.item.path || '').split(/[\\\\/]/).pop());
            const storedSigs = list.map(v => v.sig || null);
            const recomputed = list.map(v => (recomp[v.item.path] || {}).sig || null);
            const lens = list.map(v => (recomp[v.item.path] || {}).len || v.textLen || 0);
            // 组内两两汉明距离（用**复算**签名，避免复用内部状态）
            const pairD = [];
            for (let a = 0; a < list.length; a++) {
                for (let b = a + 1; b < list.length; b++) {
                    const sa = recomputed[a], sb = recomputed[b];
                    pairD.push(sa && sb ? hd(sa, sb) : -1);
                }
            }
            // 落盘 simhash vs 复算 simhash 是否一致
            const l1bMismatch = list.filter((v, i) => {
                const s = storedSigs[i], r = recomputed[i];
                return s && r && (s[0] !== r[0] || s[1] !== r[1]);
            }).length;
            return {
                name: g.name, size: list.length, names, lens,
                simPct: list.map(v => v._simPct),
                hamming: list.map(v => v._hamming),
                pairD,
                maxPairD: pairD.length ? Math.max(...pairD) : 0,
                l1bMismatch,
                hasStoredSig: storedSigs.map(s => !!s)
            };
        })
    };
})()`, 1800000);

console.log(`库：${out.libCount} 本 ｜ 内容查重发现 ${out.groups} 组`);
console.log('');
if (!out.detail.length) {
    console.log('（本次未发现任何分组）');
} else {
    out.detail.forEach((g, i) => {
        console.log(`───── 第 ${i + 1} 组：『${g.name}』 ${g.size} 本 ─────`);
        g.names.forEach((nm, j) => {
            console.log(`  [${j}] ${nm}`);
            console.log(`       归一化文本长度=${g.lens[j]} ｜ 展示相似度=${g.simPct[j]}% ｜ 与master汉明距离=${g.hamming[j]} ｜ 落盘sig=${g.hasStoredSig[j]}`);
        });
        console.log(`  组内两两汉明距离: [${g.pairD.join(', ')}]  （阈值 T=19，>19 即不该同组）`);
        console.log(`  最大两两距离=${g.maxPairD} ｜ 落盘sig与复算不一致=${g.l1bMismatch}`);
        console.log('');
    });
}
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|out of memory/i.test(t));
console.log(bad.length === 0 ? '✅ 无渲染期错误' : '❌ 错误：' + bad.slice(0, 3).join(' | '));
process.exit(0);
