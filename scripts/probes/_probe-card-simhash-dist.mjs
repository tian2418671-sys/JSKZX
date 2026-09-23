/**
 * 角色卡「同名组内内容相似度」阈值实测（2026-09-23）
 *
 * 目的：为「同名查重假阳性标注」定一个**实测阈值**，而不是拍脑袋。
 *   · 组 A：**同名**组内的两两 simhash 汉明距离（真同源 → 应偏小；假同名 → 应偏大）
 *   · 组 B：**随机不同名**两两（无关基线 → 期望 ≈ 32）
 *
 * 用法：node scripts/probes/_probe-card-simhash-dist.mjs <卡库目录> [最多张数]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'E:\\BaiduNetdiskDownload\\26.6角色卡\\测试卡库';
const LIMIT = Number(process.argv[3] || 4000);

const SIMHASH_N = 4, SIMHASH_STEP = 4;
function computeSimhash(text) {
    const v = new Int32Array(64);
    const len = text.length, n = SIMHASH_N, step = SIMHASH_STEP;
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
const normalize = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();

function extract(p) {
    const buf = fs.readFileSync(p);
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const dataStart = off + 8;
        if (type === 'tEXt') {
            const chunk = buf.toString('latin1', dataStart, dataStart + len);
            const z = chunk.indexOf('\0');
            if (chunk.slice(0, z) === 'chara' || chunk.slice(0, z) === 'ccv3') {
                try { return JSON.parse(Buffer.from(chunk.slice(z + 1), 'base64').toString('utf8')); } catch (e) { return null; }
            }
        }
        if (type === 'IEND') break;
        off = dataStart + len + 4;
    }
    return null;
}

const cards = [];
let scanned = 0;
const walk = (d) => {
    if (scanned >= LIMIT) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
        if (scanned >= LIMIT) return;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        if (!/\.png$/i.test(e.name)) continue;
        scanned++;
        const c = extract(fp);
        if (!c) continue;
        const inner = c.data || c;
        const nm = String(inner.name || '').trim();
        const text = normalize([inner.description, inner.personality, inner.scenario, inner.first_mes, inner.mes_example].filter(Boolean).join('\n'));
        if (text.length < 20) continue;
        cards.push({ file: e.name.replace(/\.png$/i, ''), name: nm, sig: computeSimhash(text), len: text.length });
    }
};
walk(DIR);
console.log(`扫描 ${cards.length} 张（含正文 ≥20 字）`);

// 组 A：同名组内两两距离
const byName = new Map();
for (const c of cards) { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name).push(c); }
const sameD = [], sameGroups = [];
for (const [nm, list] of byName) {
    if (list.length < 2) continue;
    let mx = -1;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const d = hamming(list[i].sig, list[j].sig);
        sameD.push(d);
        if (d > mx) mx = d;
    }
    sameGroups.push({ name: nm, n: list.length, maxD: mx });
}
// 组 B：随机不同名对
const diffD = [];
for (let i = 0; i < 4000; i++) {
    const a = cards[Math.floor(Math.random() * cards.length)];
    const b = cards[Math.floor(Math.random() * cards.length)];
    if (!a || !b || a.name === b.name) continue;
    diffD.push(hamming(a.sig, b.sig));
}
const stat = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, min: s[0], p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), max: s[s.length - 1], mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
};
console.log('\n【组 A】同名组内两两距离：' + JSON.stringify(stat(sameD)));
console.log('【组 B】随机不同名两两距离：' + JSON.stringify(stat(diffD)));

// 直方图
const hist = (arr, label) => {
    const b = new Array(9).fill(0);
    for (const d of arr) b[Math.min(8, Math.floor(d / 8))]++;
    console.log(`${label} 直方图(0-7,8-15,...,64)：[${b.join(', ')}]`);
};
hist(sameD, '组 A');
hist(diffD, '组 B');

// 「同名组」按 maxD 分布，找假阳性
console.log('\n── 同名组 maxD ≥ 24 的实例（疑似假同名）前 15 ──');
sameGroups.filter(g => g.maxD >= 24).sort((a, b) => b.maxD - a.maxD).slice(0, 15)
    .forEach(g => console.log(`   maxD=${g.maxD}  n=${g.n}  name="${g.name}"`));
console.log(`\n同名组总数 ${sameGroups.length}；其中 maxD>=24 的 ${sameGroups.filter(g => g.maxD >= 24).length} 组`);
