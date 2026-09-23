/**
 * S3' 前置：simhash 实现进一步优化（避免 substring 分配）
 *
 * S0.5 实测：number 双 32 位版 **173ms/本** → 全库 5401 本 ≈ **15.6 分钟**。
 * 瓶颈分析：`text.slice(i, i+n)` 每个 4-gram **分配一个新字符串**（32 万次/本）。
 *
 * 本脚本对比：
 *   · 方案 B（S0.5 定稿）：slice + fnv1a32  —— 173ms/本
 *   · 方案 D（本脚本新增）：**直接 charCode 哈希**（零分配）—— 预期大幅提速
 *   · 方案 E：方案 D + **特征采样**（每 k 个取 1）—— 再提速，且分离度可控
 *
 * 用法：node scripts/probes/_probe-simhash-opt.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';

// ── 收集唯一内容书（复用 S0.5 逻辑）──
const seen = new Map();
const walk = (d, depth = 0) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.name.toLowerCase().endsWith('.json')) continue;
        const buf = fs.readFileSync(p);
        const h = crypto.createHash('md5').update(buf).digest('hex');
        if (seen.has(h)) continue;
        try {
            const d2 = JSON.parse(buf.toString('utf-8'));
            const arr = Array.isArray(d2.entries) ? d2.entries
                : (d2.entries && typeof d2.entries === 'object' ? Object.values(d2.entries) : []);
            if (!arr.length) { seen.set(h, null); continue; }
            seen.set(h, { name: e.name, content: arr.map(x => String((x && x.content) || '')).join('\n') });
        } catch { seen.set(h, null); }
    }
};
walk(DIR);
const books = [...seen.values()].filter(Boolean);
const family = (n) => n.replace(/[-_].*$/, '');
console.log(`样本：${books.length} 本（唯一内容）\n`);

const posPairs = [], negPairs = [];
for (let i = 0; i < books.length; i++)
    for (let j = i + 1; j < books.length; j++)
        (family(books[i].name) === family(books[j].name) ? posPairs : negPairs).push([i, j]);

// ── 通用：投票累加 + 打包（两半区）──
function packVotes(v) {
    let lo = 0, hi = 0;
    for (let b = 0; b < 32; b++) {
        if (v[b] > 0) lo |= (1 << b);
        if (v[b + 32] > 0) hi |= (1 << b);
    }
    return [lo >>> 0, hi >>> 0];
}
const ham = (a, b) => {
    let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    while (y) { c += y & 1; y >>>= 1; }
    return c;
};

// ── 方案 B：slice + fnv1a32（S0.5 定稿）──
function fnv1a32(str, seed) {
    let h = (seed === undefined ? 0x811c9dc5 : seed) >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}
function simB(text, n) {
    const v = new Int32Array(64);
    for (let i = 0; i + n <= text.length; i++) {
        const s = text.slice(i, i + n);
        const lo = fnv1a32(s, 0x811c9dc5);
        const hi = fnv1a32(s, 0x01000193);
        for (let b = 0; b < 32; b++) {
            v[b] += ((lo >>> b) & 1) ? 1 : -1;
            v[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
        }
    }
    return packVotes(v);
}

// ── 方案 D：直接 charCode 哈希（**零 substring 分配**）──
//    4-gram hash 由 4 个 charCode 直接滚动算出，不构造字符串。
function simD(text, n) {
    const v = new Int32Array(64);
    const len = text.length;
    for (let i = 0; i + n <= len; i++) {
        // 直接对窗口内 n 个 charCode 做 FNV-1a（零分配）
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
    return packVotes(v);
}

// ── 方案 E：方案 D + 特征采样（每 step 个取 1）──
function simE(text, n, step) {
    const v = new Int32Array(64);
    const len = text.length;
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
    return packVotes(v);
}

const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], max: s[s.length - 1] }; };

const impls = [
    { id: 'B. slice + fnv1a32（S0.5 定稿）', fn: (t) => simB(t, 4) },
    { id: 'D. 直接 charCode（零分配）', fn: (t) => simD(t, 4) },
    { id: 'E. D + 采样 step=4', fn: (t) => simE(t, 4, 4) },
    { id: 'E2. D + 采样 step=8', fn: (t) => simE(t, 4, 8) }
];

console.log('特征：char 4-gram ｜ 正文合计 ' + (books.reduce((s, b) => s + b.content.length, 0) / 1048576).toFixed(1) + 'M 字符\n');

for (const im of impls) {
    im.fn(books[0].content.slice(0, 3000));   // 预热 JIT
    const t0 = performance.now();
    const sigs = books.map(b => im.fn(b.content));
    const ms = performance.now() - t0;

    const posD = posPairs.map(([i, j]) => ham(sigs[i], sigs[j]));
    const negD = negPairs.map(([i, j]) => ham(sigs[i], sigs[j]));
    const ps = stat(posD), ns = stat(negD);
    const gap = ns.min - ps.max;
    const perBook = ms / books.length;

    console.log(`───── ${im.id} ─────`);
    console.log(`  耗时 ${ms.toFixed(0)}ms（${perBook.toFixed(0)}ms/本）→ 全库 5401 本 ≈ **${(perBook * 5401 / 60000).toFixed(1)} 分钟**`);
    console.log(`  正样本 ${posD.join(',')} → max ${ps.max}`);
    console.log(`  负样本 ${negD.join(',')} → min ${ns.min}`);
    console.log(`  间隙 ${gap} → ${gap > 0 ? '✅ 可分' : '❌ 重叠'}  ｜ 建议 T = ${gap > 0 ? Math.floor((ps.max + ns.min) / 2) : '?'}`);
    console.log('');
}
