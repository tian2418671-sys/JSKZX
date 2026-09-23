/**
 * S0.5：simhash 特征方案实验（离线，不碰线上代码）
 *
 * 目的（v3 评审 P0-1「参数依赖倒挂」）：
 *   S1' 要落盘 `simhash64`，但**特征选择方案**（n-gram 宽度）此前无安排。
 *   若 S3' 才实验且结果推翻 S1' → **全库 simhash 作废 = 34.8GB 重读**。
 *   ⇒ 本脚本在 S1' 之前把「特征方案 + 阈值 T」定稿。
 *
 * ⚠️ 样本来源说明（踩过的坑，务必先读）：
 *   `_wb5k/s1000` 是**硬链接放大**产物 —— 40 个组**全部是同一本书**（MD5 相同），
 *   **没有负样本多样性**，无法用于阈值实验（首次跑出「汉明距离全 0」即此因）。
 *   ⇒ 改为用其中**唯一内容**的书：炎孕系列（同源变体，正样本）+ 女神（独立书，负样本）。
 *
 * 用法：node scripts/probes/_probe-simhash-tune.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';
const MASK64 = (1n << 64n) - 1n;

// ============ 收集「唯一内容」书 ============
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
            if (!arr.length) { seen.set(h, null); continue; }   // 诱饵（0 词条）跳过
            const ks = new Set();
            for (const x of arr) {
                const k = Array.isArray(x && x.key) ? x.key : (x && x.key ? [x.key] : []);
                for (const y of k) { const s = String(y).trim().toLowerCase(); if (s) ks.add(s); }
            }
            seen.set(h, {
                name: e.name,
                content: arr.map(x => String((x && x.content) || '')).join('\n'),
                keys: [...ks].sort()
            });
        } catch { seen.set(h, null); }
    }
};
walk(DIR);

const books = [...seen.values()].filter(Boolean);
console.log(`目录：${DIR}`);
console.log(`唯一内容书：${books.length} 本 → ${books.map(b => b.name).join('、')}\n`);
if (books.length < 3) { console.error('样本不足（需 ≥3 本唯一内容书）'); process.exit(1); }

// ============ simhash 实现 ============
function fnv1a64(str) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < str.length; i++) {
        h ^= BigInt(str.charCodeAt(i));
        h = (h * 0x100000001b3n) & MASK64;
    }
    return h;
}
function simhash64(text, n) {
    const v = new Int32Array(64);
    for (let i = 0; i + n <= text.length; i++) {
        const h = fnv1a64(text.slice(i, i + n));
        for (let b = 0; b < 64; b++) v[b] += ((h >> BigInt(b)) & 1n) ? 1 : -1;
    }
    let out = 0n;
    for (let b = 0; b < 64; b++) if (v[b] > 0) out |= (1n << BigInt(b));
    return out;
}
const hamming = (a, b) => { let x = (a ^ b) & MASK64, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; };

// ============ 正负样本标注 ============
const family = (name) => name.replace(/[-_].*$/, '');   // 「炎孕-改写A」→「炎孕」
const pairs = { pos: [], neg: [] };
for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
        (family(books[i].name) === family(books[j].name) ? pairs.pos : pairs.neg).push([i, j]);
    }
}
console.log(`标注：正样本 ${pairs.pos.length} 对（同源家族内）｜ 负样本 ${pairs.neg.length} 对（跨家族）\n`);

// ============ 跑三种特征方案 ============
const stat = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};

for (const n of [3, 4, 5]) {
    const t0 = performance.now();
    const sigs = books.map(b => simhash64(b.content, n));
    const ms = Math.round(performance.now() - t0);

    const posD = pairs.pos.map(([i, j]) => hamming(sigs[i], sigs[j]));
    const negD = pairs.neg.map(([i, j]) => hamming(sigs[i], sigs[j]));
    const ps = stat(posD), ns = stat(negD);

    console.log(`───── char ${n}-gram ─────`);
    console.log(`  耗时 ${ms}ms（${(ms / books.length).toFixed(0)}ms/本）`);
    if (ps) console.log(`  正样本（同源）${posD.length} 对：${posD.join(', ')}`);
    if (ps) console.log(`    → min ${ps.min} / P50 ${ps.p50} / P95 ${ps.p95} / max ${ps.max}`);
    if (ns) console.log(`  负样本（跨家族）${negD.length} 对：${negD.join(', ')}`);
    if (ns) console.log(`    → min ${ns.min} / P50 ${ns.p50} / P95 ${ns.p95} / max ${ns.max}`);
    if (ps && ns) {
        const gap = ns.min - ps.max;
        console.log(`  可分性：正样本 max ${ps.max} ｜ 负样本 min ${ns.min} ｜ 间隙 ${gap} → ${gap > 0 ? '✅ 完全可分' : (gap === 0 ? '⚠️ 临界' : '❌ 重叠')}`);
        console.log(`  ⇒ 建议阈值 T = ${gap > 0 ? Math.floor((ps.max + ns.min) / 2) : ps.p95}`);
    }
    console.log('');
}

// ============ 附：keys 集合 Jaccard（供 S2' 指纹分组参考） ============
console.log('═════ 附：keys 集合 Jaccard（S2\' 指纹分组用） ═════');
for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
        const a = new Set(books[i].keys), b = new Set(books[j].keys);
        let inter = 0; for (const x of a) if (b.has(x)) inter++;
        const uni = a.size + b.size - inter;
        const jac = uni ? (inter / uni * 100).toFixed(1) : '0';
        const tag = family(books[i].name) === family(books[j].name) ? '同源' : '跨族';
        console.log(`  [${tag}] ${books[i].name} × ${books[j].name}：Jaccard ${jac}% (交 ${inter} / 并 ${uni})`);
    }
}
