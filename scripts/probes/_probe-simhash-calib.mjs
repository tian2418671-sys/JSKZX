/**
 * simhash 阈值标定复核（离线，纯 Node）
 *
 * 背景：S0.5 实验定 T=19（正样本 max 8 / 负样本 min 31）。
 * 但真实世界书库实测出现负样本 d=17~19 —— 落在阈值内 → 误判。
 * 本脚本统计**真实库**的汉明距离分布，检验「T=19 是否仍成立」。
 *
 * 用法：node scripts/probes/_probe-simhash-calib.mjs [目录]
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

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const items = [];
for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    let entries = raw && raw.entries;
    if (entries && !Array.isArray(entries) && typeof entries === 'object') entries = Object.values(entries);
    if (!Array.isArray(entries)) continue;
    const norm = normalize(contentTextOf(entries));
    if (norm.length < 20) continue;
    items.push({ name: f.replace(/\.json$/i, ''), len: norm.length, sig: computeSimhash(norm) });
}

// 归一化文件名 → 判定「同名同源」（真正的重复）
const baseOf = (n) => n.replace(/\s*\(\d+\)\s*/g, ' ').replace(/-1$/, '').replace(/\s+/g, ' ').trim();

const bins = new Array(33).fill(0);
const pos = [], neg = [];
const near = [];   // d <= 25 的「可疑」对（含真实负样本）
for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
        const d = hamming(items[a].sig, items[b].sig);
        bins[d]++;
        const sameSource = baseOf(items[a].name) === baseOf(items[b].name);
        (sameSource ? pos : neg).push(d);
        if (d <= 25) near.push({ d, a: items[a].name, b: items[b].name, sameSource, la: items[a].len, lb: items[b].len });
    }
}
const stat = (arr) => {
    if (!arr.length) return '（空）';
    const s = [...arr].sort((x, y) => x - y);
    return `n=${s.length} min=${s[0]} p25=${s[Math.floor(s.length * .25)]} p50=${s[Math.floor(s.length * .5)]} p75=${s[Math.floor(s.length * .75)]} max=${s[s.length - 1]}`;
};

console.log(`═════ simhash 阈值标定复核 · ${DIR} ═════`);
console.log(`参与比对：${items.length} 本 ｜ 总对数：${(items.length * (items.length - 1)) / 2}\n`);
console.log('【正样本】文件名同源（真重复）距离分布：');
console.log('  ' + stat(pos));
console.log('【负样本】文件名不同源（应判不重复）距离分布：');
console.log('  ' + stat(neg));
console.log('');
console.log('距离直方图（0~32+）：');
for (let d = 0; d <= 32; d++) {
    if (!bins[d]) continue;
    console.log(`  d=${String(d).padStart(2)}  ${'█'.repeat(Math.min(60, bins[d]))} ${bins[d]}`);
}
console.log('');
console.log(`⚠️ 负样本中 d ≤ 19（会被当前阈值 T=19 判为重复）的对：${neg.filter(d => d <= 19).length} 对`);
console.log('');
console.log('d ≤ 25 的「近距离」对明细（★ = 同名同源，应判重复）：');
near.sort((x, y) => x.d - y.d).forEach(p => {
    console.log(`  ${p.sameSource ? '★' : ' '} d=${String(p.d).padStart(2)}  『${p.a}』(${p.la}) ↔ 『${p.b}』(${p.lb})`);
});
const overlap = neg.filter(d => d <= 19).length;
console.log('');
console.log(overlap === 0
    ? '✅ 阈值 T=19 在本库无误判（负样本均在阈值外）'
    : `❌ 阈值 T=19 存在误判：${overlap} 对无关书落进阈值内（S0.5 的「负 min 31」在本库不成立）`);
