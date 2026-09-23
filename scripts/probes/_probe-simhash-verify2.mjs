/**
 * S3' 阈值复核 —— **精确标注版**（2026-09-23）
 *
 * 为什么需要独立脚本：`_probe-simhash-verify.mjs` 的「自动标注」在**同族副本库**上有噪声
 *   （s1000 里 `炎孕-副本01..15` 与 `女神-副本01..04` 内容互不相同，但按「同名」规则
 *     会被分成 15 个「家族」，导致跨副本对被误标为「无关」→ 误报率虚高 66%）。
 *   ⇒ 本脚本按 **MD5 去重后** 取真正唯一的书，再按**书名前缀**精确标注家族。
 *
 * 用法：node scripts/probes/_probe-simhash-verify2.mjs "<目录>"
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-simhash-verify2.mjs "<目录>"'); process.exit(1); }

// ══════ 逐字复刻线上实现（与 useDedupe.js 一致）══════
const SIMHASH_N = 4, SIMHASH_STEP = 4, SIMHASH_THRESHOLD = 19;

const normalizeText = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();

const computeSimhash = (text) => {
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
};
const hammingDistance = (a, b) => {
    let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    while (y) { c += y & 1; y >>>= 1; }
    return c;
};

// ══════ MD5 去重取唯一内容书 ══════
const files = [];
(function walk(d, depth = 0) {
    if (depth > 5) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (e.name.toLowerCase().endsWith('.json')) files.push(p);
    }
})(DIR);

console.log('═════ S3\' 阈值复核（精确标注 · MD5 去重）═════');
console.log(`目录：${DIR}`);
console.log(`线上参数：char ${SIMHASH_N}-gram ｜ step=${SIMHASH_STEP} ｜ T=${SIMHASH_THRESHOLD}`);
console.log('');

const seenMd5 = new Map();
const books = [];
let skipped = 0;
for (const p of files) {
    let buf;
    try { buf = fs.readFileSync(p); } catch { skipped++; continue; }
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (seenMd5.has(md5)) continue;      // 内容重复 → 跳过（保证样本多样性）
    seenMd5.set(md5, true);
    try {
        const data = JSON.parse(buf.toString('utf-8'));
        const arr = Array.isArray(data.entries) ? data.entries
            : (data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : null);
        if (!arr || !arr.length) { skipped++; continue; }
        const content = normalizeText(arr.map(x => String((x && x.content) || '')).join('\n'));
        if (content.length < 20) { skipped++; continue; }
        books.push({
            path: p, name: path.basename(p, '.json'), contentLen: content.length,
            sig: computeSimhash(content)
        });
    } catch { skipped++; }
}

console.log(`唯一内容书：${books.length} 本（跳过 ${skipped}：重复内容 / 空 / 过短 / 解析失败）`);
books.forEach(b => console.log(`   · ${b.name}（${b.contentLen.toLocaleString()} 字符）`));
console.log('');

// ══════ 按书名前缀精确标注家族 ══════
// 「炎孕-副本01」「炎孕-改写A」「炎孕-异世界…」→ 家族「炎孕」
// 「女神-副本01」「女神攻略…」→ 家族「女神」
const familyOf = (name) => {
    const m = /^([^-—_\s]+)/.exec(name);
    return m ? m[1] : name;
};
const fams = new Map();
for (const b of books) {
    const f = familyOf(b.name);
    if (!fams.has(f)) fams.set(f, []);
    fams.get(f).push(b);
}
console.log('家族划分：');
for (const [f, list] of fams) console.log(`   ${f} → ${list.length} 本：${list.map(b => b.name).join('、')}`);
console.log('');

// 正样本：同家族内所有对；负样本：跨家族所有对
const posPairs = [], negPairs = [];
const famKeys = [...fams.keys()];
for (let i = 0; i < famKeys.length; i++) {
    for (let j = i; j < famKeys.length; j++) {
        const A = fams.get(famKeys[i]), B = fams.get(famKeys[j]);
        if (i === j) {
            for (let a = 0; a < A.length; a++) for (let b = a + 1; b < A.length; b++) posPairs.push([A[a], B[b]]);
        } else {
            for (const a of A) for (const b of B) negPairs.push([a, b]);
        }
    }
}
console.log(`标注对：正（同家族）${posPairs.length} 对 ｜ 负（跨家族）${negPairs.length} 对`);
console.log('');

const posD = posPairs.map(([a, b]) => hammingDistance(a.sig, b.sig)).sort((x, y) => x - y);
const negD = negPairs.map(([a, b]) => hammingDistance(a.sig, b.sig)).sort((x, y) => x - y);
const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;

console.log('───── 汉明距离分布 ─────');
console.log(`正样本（同源）：min ${posD[0]} ｜ P50 ${q(posD, 0.5)} ｜ P95 ${q(posD, 0.95)} ｜ max ${posD[posD.length - 1]}`);
console.log(`   全部距离：${posD.join(', ')}`);
console.log(`负样本（无关）：min ${negD[0]} ｜ P5 ${q(negD, 0.05)} ｜ P50 ${q(negD, 0.5)} ｜ max ${negD[negD.length - 1]}`);
console.log(`   全部距离：${negD.join(', ')}`);
console.log('');

console.log(`───── 复核线上阈值 T=${SIMHASH_THRESHOLD} ─────`);
const missed = posD.filter(d => d > SIMHASH_THRESHOLD);
const falsePos = negD.filter(d => d <= SIMHASH_THRESHOLD);
const pct = (n, t) => t ? `${(n / t * 100).toFixed(2)}%` : 'n/a';
console.log(`漏报（正样本 d > T）：${missed.length}/${posD.length} = ${pct(missed.length, posD.length)}`);
if (missed.length) console.log(`   ${missed.join(', ')}`);
console.log(`误报（负样本 d <= T）：${falsePos.length}/${negD.length} = ${pct(falsePos.length, negD.length)}`);
if (falsePos.length) console.log(`   ${falsePos.join(', ')}`);
console.log('');

const posMax = posD[posD.length - 1], negMin = negD[0];
const gap = negMin - posMax;
console.log('───── 可分性 ─────');
if (gap > 0) {
    console.log(`✅ 两组**完全可分**：正 max ${posMax} ｜ 负 min ${negMin} ｜ 间隙 ${gap}`);
    console.log(`   ⇒ 任意 T ∈ [${posMax}, ${negMin}) 都零误报零漏报`);
    const inRange = SIMHASH_THRESHOLD >= posMax && SIMHASH_THRESHOLD < negMin;
    console.log(`   ⇒ 线上 T=${SIMHASH_THRESHOLD} ${inRange ? '**落在区间内 ✅ 复核通过**' : '⚠️ 不在区间内，建议改为 ' + Math.floor((posMax + negMin) / 2)}`);
} else {
    console.log(`⚠️ 两组**重叠**：正 max ${posMax} ｜ 负 min ${negMin}`);
    console.log(`   ⇒ 不存在零误报零漏报的阈值（样本本身难以区分，或标注有误）`);
}
console.log('');
console.log('═════ 结论 ═════');
const ok = missed.length === 0 && falsePos.length === 0;
console.log(ok
    ? `✅ T=${SIMHASH_THRESHOLD} 在**精确标注**下零漏报零误报 —— 线上阈值复核通过`
    : `⚠️ 有 ${missed.length} 漏报 / ${falsePos.length} 误报`);
process.exit(ok ? 0 : 1);
