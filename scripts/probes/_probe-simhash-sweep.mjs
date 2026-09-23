/**
 * simhash 阈值扫描 + 修法验证（离线，纯 Node）
 *
 * 回答：T 该定多少？加「文本长度下限」能否解决短文本失真？
 *
 * 判据（以真实 4-gram Jaccard 为真值）：
 *   · 正样本 = Jaccard ≥ 0.85（真重复）→ 应召回
 *   · 负样本 = Jaccard < 0.5（内容无关）→ 应排除
 * 输出每个 (T, 最小长度) 组合的**误报 / 漏报**。
 *
 * 用法：node scripts/probes/_probe-simhash-sweep.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const SIMHASH_N = 4, SIMHASH_STEP = 4;

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
const jaccard = (A, B) => { let i = 0; const [s, b] = A.size <= B.size ? [A, B] : [B, A]; for (const x of s) if (b.has(x)) i++; return i / (A.size + B.size - i); };

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

// 真值对（不受 T 影响）
const all = [];
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
        all.push({
            a: items[a].name, b: items[b].name, la: items[a].len, lb: items[b].len,
            minLen: Math.min(items[a].len, items[b].len),
            d: hamming(items[a].sig, items[b].sig),
            jac: jaccard(items[a].sh, items[b].sh)
        });
    }
}
const POS = all.filter(r => r.jac >= 0.85);
const NEG = all.filter(r => r.jac < 0.5);
console.log(`═════ simhash 阈值扫描 · ${DIR} ═════`);
console.log(`参与比对：${items.length} 本 ｜ 总对 ${all.length}`);
console.log(`真值：正样本(Jaccard≥85%) ${POS.length} 对 ｜ 负样本(Jaccard<50%) ${NEG.length} 对\n`);
console.log(`正样本距离：${POS.map(r => r.d).join(', ')}`);
console.log(`负样本距离 ≤25 的：${NEG.filter(r => r.d <= 25).map(r => r.d).sort((x, y) => x - y).join(', ')}\n`);

console.log('  T   长度下限   误报(负样本被判重复)   漏报(正样本被漏)   评价');
console.log('  ───────────────────────────────────────────────────────────────────────');
for (const minLen of [20, 500, 1000, 2000, 3000, 5000, 8000]) {
    for (const T of [8, 12, 14, 16, 19]) {
        const fp = NEG.filter(r => r.minLen >= minLen && r.d <= T).length;
        const fn = POS.filter(r => r.minLen >= minLen && r.d > T).length;
        const evaln = fp === 0 && fn === 0 ? '✅ 完美' : (fp === 0 ? '🟡 无误差但漏报' : (fn === 0 ? '⚠️ 有误报' : '❌ 两者都有'));
        console.log(`  ${String(T).padStart(2)}   ${String(minLen).padStart(6)}   ${String(fp).padStart(10)}（${NEG.filter(r => r.minLen >= minLen).length} 负）   ${String(fn).padStart(10)}（${POS.filter(r => r.minLen >= minLen).length} 正）   ${evaln}`);
    }
    console.log('  ───────────────────────────────────────────────────────────────────────');
}

// 详细：负样本为何距离近 —— 是否都是短文本？
console.log('\n【负样本近距离明细】验证「短文本导致 simhash 退化」假设：');
console.log('  距离  长度A    长度B    较小长度  Jaccard');
NEG.filter(r => r.d <= 25).sort((x, y) => x.d - y.d).forEach(r => {
    console.log(`  d=${String(r.d).padStart(2)}  ${String(r.la).padStart(7)} ${String(r.lb).padStart(7)}  ${String(r.minLen).padStart(8)}  ${(r.jac * 100).toFixed(1)}%   『${r.a}』↔『${r.b}』`);
});
