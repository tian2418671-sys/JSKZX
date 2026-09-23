/**
 * simhash 距离 ↔ 真实相似度 标定（离线，纯 Node）
 *
 * 回答两个问题：
 *   ① 阈值 T 该定多少？（用「改造真实文本」造出**已知相似度**的样本，测其距离）
 *   ② 「simhash 预筛 + 真实 Jaccard 复核」能否根治误判？
 *
 * 方法：取真实世界书 A、B（无关），把 A 的若干等分块按比例 p 替换为 B 的块，
 *      得到「与 A 有 (1-p) 相似度」的混合文本 → 测 simhash 距离 + 真实 Jaccard。
 *
 * 用法：node scripts/probes/_probe-simhash-calib2.mjs [目录]
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
    items.push({ name: f.replace(/\.json$/i, ''), len: norm.length, text: norm, sig: computeSimhash(norm) });
}
console.log(`═════ simhash 距离 ↔ 真实相似度 标定 ═════`);
console.log(`参与：${items.length} 本\n`);

// ── ① 无关对（真实库真值）──
let negMin = 99;
const negD = [];
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
        const d = hamming(items[a].sig, items[b].sig);
        negD.push(d);
        if (d < negMin) negMin = d;
    }
}
console.log(`【无关对】${negD.length} 对，距离 min=${negMin}`);
console.log('');

// ── ② 改造文本：造「已知相似度」样本 ──
// 取长度中等的书作为 A（避免超大文本拖慢 shingle 计算）
const src = items.filter(x => x.len >= 3000 && x.len <= 60000).sort((a, b) => a.len - b.len);
const targets = src.slice(0, Math.min(6, src.length));
console.log(`【改造实验】源书 ${targets.length} 本 × 各相似度档位（每档 3 次取均值）\n`);
console.log('  目标相似度  simhash距离  实测Jaccard   （是否被 T 判为重复）');
console.log('  ──────────────────────────────────────────────────────────');

// 确定性伪随机
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const rows = [];
for (const A of targets) {
    // 找一本与 A 无关且长度相近的书作 B
    const B = items.find(x => x !== A && Math.abs(x.len - A.len) < A.len && hamming(x.sig, A.sig) > 20);
    if (!B) continue;
    const K = 20;                                   // 分 20 块
    const chunkA = Math.floor(A.text.length / K);
    const aParts = Array.from({ length: K }, (_, i) => A.text.slice(i * chunkA, (i + 1) * chunkA));
    for (const p of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
        const reps = [];
        for (let t = 0; t < 3; t++) {
            const nReplace = Math.round(K * p);
            const idx = new Set();
            while (idx.size < nReplace) idx.add(Math.floor(rnd() * K));
            const parts = aParts.map((seg, i) => idx.has(i)
                ? B.text.slice((i % 20) * Math.floor(B.text.length / 20), (i % 20 + 1) * Math.floor(B.text.length / 20))
                : seg);
            const hybrid = parts.join('');
            const d = hamming(computeSimhash(hybrid), A.sig);
            const j = jaccard(shingles(hybrid), shingles(A.text));
            reps.push({ d, j });
        }
        const dAvg = Math.round(reps.reduce((s, r) => s + r.d, 0) / reps.length);
        const jAvg = reps.reduce((s, r) => s + r.j, 0) / reps.length;
        rows.push({ target: 1 - p, d: dAvg, j: jAvg });
        console.log(`  ${((1 - p) * 100).toFixed(0).padStart(9)}%  ${String(dAvg).padStart(9)}  ${(jAvg * 100).toFixed(1).padStart(10)}%   ${dAvg <= 19 ? '⚠️ 会判重复' : ' 不会'}`);
    }
    console.log('  ──────────────────────────────────────────────────────────');
}

// ── ③ 推荐阈值 ──
console.log('\n【阈值推荐】要求：不漏报「真实相似度 ≥ 85%」的样本，且不误报无关对');
const TARGET = 0.85;
const relevant = rows.filter(r => r.target >= TARGET && r.target < 1);
if (relevant.length) {
    const need = Math.max(...relevant.map(r => r.d));
    console.log(`  「相似度 ≥ ${TARGET * 100}%」样本的最大距离 = ${need}  →  阈值 T 至少需 ≥ ${need}`);
}
console.log(`  无关对的最小距离 = ${negMin}  →  阈值 T 必须 < ${negMin}`);
const lo = relevant.length ? Math.max(...relevant.map(r => r.d)) : 0;
console.log(`  ⇒ 安全区间：${lo} ≤ T < ${negMin}${lo < negMin ? `（可取 T = ${Math.min(negMin - 1, Math.max(lo, 12))}）` : '  ⚠️ 区间为空 → 单靠 simhash 无法区分，必须加复核'}`);

// ── ④ 模拟修法：预筛 + Jaccard 复核 ──
console.log('\n【修法模拟】simhash 预筛（宽松 T=19）→ 真实 Jaccard ≥ 85% 复核');
const allPairs = [];
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) allPairs.push({ a, b, d: hamming(items[a].sig, items[b].sig) });
}
const cand = allPairs.filter(p => p.d <= 19);
console.log(`  预筛候选：${cand.length} 对`);
let kept = 0, dropped = 0;
const keepList = [];
for (const p of cand) {
    const j = jaccard(shingles(items[p.a].text), shingles(items[p.b].text));
    if (j >= TARGET) { kept++; keepList.push({ ...p, j }); } else dropped++;
}
console.log(`  复核后保留：${kept} 对（真重复）｜ 剔除：${dropped} 对（误判）`);
keepList.forEach(p => console.log(`    ✅ d=${p.d} Jaccard=${(p.j * 100).toFixed(1)}%  『${items[p.a].name}』↔『${items[p.b].name}』`));
// 真值：Jaccard >= 85% 的对有多少（不限距离）
let truePos = 0;
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
        if (jaccard(shingles(items[a].text), shingles(items[b].text)) >= TARGET) truePos++;
    }
}
console.log(`  真值（Jaccard ≥ 85%）：${truePos} 对  →  ${kept === truePos ? '✅ 零漏报零误报' : `⚠️ 漏报 ${truePos - kept} 对`}`);
