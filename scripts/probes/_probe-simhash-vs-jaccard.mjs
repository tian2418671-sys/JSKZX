/**
 * simhash 判定 vs 真实内容重叠度 —— 一致性取证（离线，纯 Node）
 *
 * 目的：证明「simhash 距离近」是否真的等于「内容相似」。
 *  · 对每对候选同时算：① simhash 汉明距离 ② 真实 4-gram Jaccard（集合语义真值）
 *  · 若出现「汉明距离 ≤19 但 Jaccard 很低」→ 证明 simhash 在本库失真（误判）
 *
 * 用法：node scripts/probes/_probe-simhash-vs-jaccard.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const SIMHASH_N = 4, SIMHASH_STEP = 4, T = 19;

function computeSimhash(text) {
    const v = new Int32Array(64);
    const n = SIMHASH_N, step = SIMHASH_STEP;
    for (let i = 0; i + n <= text.length; i += step) {
        let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
        for (let k = 0; k < n; k++) {
            const c = text.charCodeAt(i + k);
            lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
            hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
        }
        for (let b = 0; b < 32; b++) {
            v[b] += ((lo >>> b) & 1) ? 1 : -1;
            v[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
        }
    }
    let outLo = 0, outHi = 0;
    for (let b = 0; b < 32; b++) {
        if (v[b] > 0) outLo |= (1 << b);
        if (v[b + 32] > 0) outHi |= (1 << b);
    }
    return [outLo >>> 0, outHi >>> 0];
}
const hamming = (a, b) => {
    let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    while (y) { c += y & 1; y >>>= 1; }
    return c;
};
const normalize = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
const contentTextOf = (entries) => entries.map(e => {
    if (!e || typeof e !== 'object') return '';
    const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
    return `${keys} ${e.content || ''}`;
}).join('\n');
const shingles = (text) => { const s = new Set(); for (let i = 0; i + 4 <= text.length; i++) s.add(text.slice(i, i + 4)); return s; };
const jaccard = (A, B) => {
    let inter = 0;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    for (const x of small) if (big.has(x)) inter++;
    return inter / (A.size + B.size - inter);
};
/** 包含度（重叠系数）：交集 / 较小集合 —— 对「子集关系」比 Jaccard 更敏感 */
const overlapCoef = (A, B) => {
    let inter = 0;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    for (const x of small) if (big.has(x)) inter++;
    return inter / small.size;
};

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const items = [];
for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    let entries = raw && raw.entries;
    if (entries && !Array.isArray(entries) && typeof entries === 'object') entries = Object.values(entries);
    if (!Array.isArray(entries)) continue;
    const norm = normalize(contentTextOf(entries));
    if (norm.length < 20) continue;
    items.push({ name: f.replace(/\.json$/i, ''), len: norm.length, sig: computeSimhash(norm), sh: shingles(norm) });
}

console.log(`═════ simhash vs 真实 Jaccard · ${DIR} ═════`);
console.log(`参与比对：${items.length} 本\n`);

const rows = [];
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
        const d = hamming(items[a].sig, items[b].sig);
        if (d > T) continue;
        rows.push({
            d, a: items[a].name, b: items[b].name, la: items[a].len, lb: items[b].len,
            jac: jaccard(items[a].sh, items[b].sh),
            ovl: overlapCoef(items[a].sh, items[b].sh)
        });
    }
}
rows.sort((x, y) => x.d - y.d);
console.log(`汉明距离 ≤ ${T} 的候选对：${rows.length} 对\n`);
console.log('  距离  长度A      长度B      Jaccard  包含度   判定');
console.log('  ────────────────────────────────────────────────────────────────────────');
for (const r of rows) {
    // 判定：Jaccard >= 0.85（应用对 MinHash 用的阈值）才算真重复
    const verdict = r.jac >= 0.85 ? '✅ 真重复' : (r.jac >= 0.5 ? '⚠️ 部分重叠' : '❌ 误判（内容无关）');
    console.log(`  d=${String(r.d).padStart(2)}  ${String(r.la).padStart(7)}  ${String(r.lb).padStart(7)}  ${(r.jac * 100).toFixed(1).padStart(6)}%  ${(r.ovl * 100).toFixed(1).padStart(6)}%  ${verdict}`);
    console.log(`         『${r.a}』 ↔ 『${r.b}』`);
}
const wrong = rows.filter(r => r.jac < 0.5);
console.log('');
console.log(wrong.length === 0
    ? '✅ simhash 候选对全部为真重复（无失真）'
    : `❌ simhash 失真：${wrong.length}/${rows.length} 对候选的**真实内容重叠 < 50%**（被误判为重复）`);
if (wrong.length) {
    const worst = wrong.reduce((m, r) => r.jac < m.jac ? r : m, wrong[0]);
    console.log(`   最严重：d=${worst.d} 但 Jaccard 仅 ${(worst.jac * 100).toFixed(1)}% —— 『${worst.a}』 ↔ 『${worst.b}』`);
}
