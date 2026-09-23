/**
 * 离线复算：内容级查重的分组是否符合阈值口径（不依赖应用状态，纯 Node）
 *
 * 目的：回答「两本完全不相似的世界书为何被判重复」
 *  · 完全复刻 useDedupe.js 的 extractContentText(世界书) + normalizeText + computeSimhash
 *  · 输出**两两汉明距离矩阵**（真值），与阈值 T=19 对照
 *  · 检查 Union-Find 的**传递链**是否把「A~B 近、B~C 近、A~C 远」误聚成一组
 *
 * 用法：node scripts/probes/_probe-content-dedupe-offline.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const SIMHASH_N = 4;
const SIMHASH_STEP = 4;
const SIMHASH_THRESHOLD = 19;

function computeSimhash(text) {
    const v = new Int32Array(64);
    const len = text.length;
    const n = SIMHASH_N, step = SIMHASH_STEP;
    for (let i = 0; i + n <= len; i += step) {
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
const normalize = (t) => String(t || '')
    .replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();

/** 复刻 useDedupe.js extractContentText 的世界书分支 */
function contentTextOf(entries) {
    return entries.map(e => {
        if (!e || typeof e !== 'object') return '';
        const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
        return `${keys} ${e.content || ''}`;
    }).join('\n');
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const items = [];
for (const f of files) {
    const full = path.join(DIR, f);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { console.log(`  [skip] ${f}: ${e.message}`); continue; }
    // 复刻 main.js:2916 —— 对象形态的 entries 转数组
    let entries = raw && raw.entries;
    if (entries && !Array.isArray(entries) && typeof entries === 'object') entries = Object.values(entries);
    if (!Array.isArray(entries)) { console.log(`  [skip] ${f}: 无 entries`); continue; }
    const norm = normalize(contentTextOf(entries));
    if (norm.length < 20) { console.log(`  [skip] ${f}: 归一化文本过短(${norm.length})`); continue; }
    items.push({ name: f.replace(/\.json$/i, ''), file: f, len: norm.length, sig: computeSimhash(norm) });
}

console.log(`═════ 离线复算：${DIR} ═════`);
console.log(`参与比对：${items.length} / ${files.length} 个文件\n`);

// Union-Find（复刻应用逻辑）
const parent = items.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

const pairs = [];
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
        const d = hamming(items[a].sig, items[b].sig);
        if (d <= SIMHASH_THRESHOLD) { union(a, b); pairs.push({ a, b, d }); }
    }
}
console.log(`阈值内候选对（d ≤ ${SIMHASH_THRESHOLD}）：${pairs.length} 对`);
for (const p of pairs) {
    console.log(`  d=${String(p.d).padStart(2)}  『${items[p.a].name}』(${items[p.a].len}) ↔ 『${items[p.b].name}』(${items[p.b].len})`);
}

// 聚类
const clusters = new Map();
items.forEach((_, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(i); });
console.log('');
let gi = 0;
for (const members of clusters.values()) {
    if (members.length < 2) continue;
    gi++;
    console.log(`───── 组 ${gi}：${members.length} 本 ─────`);
    const maxLen = Math.max(...members.map(i => items[i].len));
    const master = members.find(i => items[i].len === maxLen);
    for (const i of members) {
        const d = hamming(items[i].sig, items[master].sig);
        const flag = (i !== master && d > SIMHASH_THRESHOLD) ? '  ⚠️⚠️ 与主项超阈值（传递链误聚）' : '';
        console.log(`  ${i === master ? '👑' : '  '} d=${String(d).padStart(2)} len=${String(items[i].len).padStart(7)}  『${items[i].name}』${flag}`);
    }
    // 组内两两最大距离
    let mx = 0, mxPair = null;
    for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) {
            const d = hamming(items[members[x]].sig, items[members[y]].sig);
            if (d > mx) { mx = d; mxPair = [items[members[x]].name, items[members[y]].name]; }
        }
    }
    console.log(`  → 组内最大两两距离 = ${mx}${mx > SIMHASH_THRESHOLD ? `  ⚠️ 超过阈值 ${SIMHASH_THRESHOLD}：『${mxPair[0]}』↔『${mxPair[1]}』` : ''}`);
    console.log('');
}
if (gi === 0) console.log('（无分组）');
