/**
 * S0.5 补充：simhash 性能优化验证
 *
 * 背景：初版实现用 BigInt 64 位 → 实测 **1368ms/本** → 全库 5401 本 ≈ **2.05 小时**（不可接受）。
 * 本脚本对比三种实现的「速度 + 分离度」，选出可落地方案。
 *
 * 用法：node scripts/probes/_probe-simhash-perf.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';
const MASK64 = (1n << 64n) - 1n;

// ============ 收集唯一内容书（复用 S0.5 逻辑） ============
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
console.log(`样本：${books.length} 本 → ${books.map(b => b.name).join('、')}\n`);

const posPairs = [], negPairs = [];
for (let i = 0; i < books.length; i++)
    for (let j = i + 1; j < books.length; j++)
        (family(books[i].name) === family(books[j].name) ? posPairs : negPairs).push([i, j]);

// ============ 实现 A：BigInt 64 位（初版） ============
function fnv1a64(str) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < str.length; i++) {
        h ^= BigInt(str.charCodeAt(i));
        h = (h * 0x100000001b3n) & MASK64;
    }
    return h;
}
function simA(text, n) {
    const v = new Int32Array(64);
    for (let i = 0; i + n <= text.length; i++) {
        const h = fnv1a64(text.slice(i, i + n));
        for (let b = 0; b < 64; b++) v[b] += ((h >> BigInt(b)) & 1n) ? 1 : -1;
    }
    let out = 0n;
    for (let b = 0; b < 64; b++) if (v[b] > 0) out |= (1n << BigInt(b));
    return out;
}
const hamA = (a, b) => { let x = (a ^ b) & MASK64, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; };

// ============ 实现 B：32 位 number + 双半区（低位/高位各 32） ============
function fnv1a32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
/** 64 位签名 = [低 32 位 Int32Array 累加, 高 32 位]（用两个 32 位 hash 拼） */
function simB(text, n) {
    const v = new Int32Array(64);
    for (let i = 0; i + n <= text.length; i++) {
        const s = text.slice(i, i + n);
        const lo = fnv1a32(s, 0x811c9dc5);          // 低位 hash
        const hi = fnv1a32(s, 0x01000193);          // 高位 hash（不同种子）
        for (let b = 0; b < 32; b++) {
            v[b] += ((lo >>> b) & 1) ? 1 : -1;
            v[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
        }
    }
    // 打包为两个 number（低 32 / 高 32）
    let lo = 0, hi = 0;
    for (let b = 0; b < 32; b++) {
        if (v[b] > 0) lo |= (1 << b);
        if (v[b + 32] > 0) hi |= (1 << b);
    }
    return [lo >>> 0, hi >>> 0];
}
const hamB = (a, b) => {
    let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    while (y) { c += y & 1; y >>>= 1; }
    return c;
};

// ============ 实现 C：32 位 simhash（位宽减半） ============
function simC(text, n) {
    const v = new Int32Array(32);
    for (let i = 0; i + n <= text.length; i++) {
        const h = fnv1a32(text.slice(i, i + n), 0x811c9dc5);
        for (let b = 0; b < 32; b++) v[b] += ((h >>> b) & 1) ? 1 : -1;
    }
    let out = 0;
    for (let b = 0; b < 32; b++) if (v[b] > 0) out |= (1 << b);
    return out >>> 0;
}
const hamC = (a, b) => { let x = (a ^ b) >>> 0, c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

// ============ 对比 ============
const impls = [
    { id: 'A. BigInt 64 位（初版）', fn: simA, ham: hamA, bits: 64 },
    { id: 'B. number 双 32 位（64 位宽）', fn: simB, ham: hamB, bits: 64 },
    { id: 'C. number 32 位', fn: simC, ham: hamC, bits: 32 }
];
const N = 4;   // char 4-gram（S0.5 定稿）

const stat = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]; return { min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }; };

console.log(`特征：char ${N}-gram ｜ 正文合计 ${(books.reduce((s, b) => s + b.content.length, 0) / 1048576).toFixed(1)}M 字符\n`);

for (const im of impls) {
    // 预热（JIT）
    im.fn(books[0].content.slice(0, 2000), N);

    const t0 = performance.now();
    const sigs = books.map(b => im.fn(b.content, N));
    const ms = performance.now() - t0;

    const posD = posPairs.map(([i, j]) => im.ham(sigs[i], sigs[j]));
    const negD = negPairs.map(([i, j]) => im.ham(sigs[i], sigs[j]));
    const ps = stat(posD), ns = stat(negD);
    const gap = ns.min - ps.max;
    const perBook = ms / books.length;
    const fullLib = perBook * 5401 / 1000;   // 秒

    console.log(`───── ${im.id} ─────`);
    console.log(`  耗时 ${ms.toFixed(0)}ms（${perBook.toFixed(0)}ms/本）→ 全库 5401 本 ≈ **${(fullLib / 60).toFixed(1)} 分钟**`);
    console.log(`  正样本：${posD.join(',')}  → max ${ps.max}`);
    console.log(`  负样本：${negD.join(',')}  → min ${ns.min}`);
    console.log(`  可分性：间隙 ${gap} → ${gap > 0 ? '✅ 可分' : (gap === 0 ? '⚠️ 临界' : '❌ 重叠')}  ｜ 建议 T = ${gap > 0 ? Math.floor((ps.max + ns.min) / 2) : ps.p95}`);
    console.log('');
}
