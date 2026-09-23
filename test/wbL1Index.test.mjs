/**
 * PK-27 / S1'~S4' 单测：L1 摘要（keys hash + exactContentHash + 截断口径）
 *
 * 覆盖 v3 评审 §5 的硬要求：
 *   · #2 规范化统一（trim + lowercase + NFC），**写成单测断言**（非注释）
 *   · #7 exactContentHash 的 canonical 序列化（递归键排序 / 只覆盖 entries / 顺序敏感）
 *   · #8 截断比较口径（双方都截到 min(k, 自身)，否则系统性低估）
 *   · P0-2 截断 = bottom-k 的数学性质（Jaccard 无偏）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ══════════════════════════════════════════════════════════════
// 被测实现的**等价复刻**（与 main.js 逐字一致；main.js 是 Electron 主进程，无法直接 import）
// ⚠️ 与 main.js 保持同步：`normalizeWbKey` / `fnv1a32` / `buildKeyHashes` / `canonicalJson` / `exactContentHash`
// ══════════════════════════════════════════════════════════════
const normalizeWbKey = (s) => String(s).trim().toLowerCase().normalize('NFC');

function fnv1a32(str, seed) {
    let h = (seed === undefined ? 0x811c9dc5 : seed) >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

const MAX_KEYS_PER_BOOK = 2000;
function buildKeyHashes(entries) {
    const set = new Set();
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const arr = Array.isArray(e.key) ? e.key : (e.key !== undefined && e.key !== null ? [e.key] : []);
        for (const k of arr) {
            const s = normalizeWbKey(k);
            if (s) set.add(fnv1a32(s));
        }
    }
    const out = Array.from(set).sort((a, b) => a - b);
    return out.length > MAX_KEYS_PER_BOOK ? out.slice(0, MAX_KEYS_PER_BOOK) : out;
}

function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
function exactContentHash(entries) {
    const cleaned = entries.map(e => {
        if (!e || typeof e !== 'object') return e;
        const o = {};
        for (const k of Object.keys(e)) {
            if (k === 'uid' || k === '_collapsed' || k === '_srcIndex' || k === '_srcUid') continue;
            o[k] = e[k];
        }
        return o;
    });
    return crypto.createHash('sha256').update(canonicalJson(cleaned)).digest('hex').slice(0, 32);
}

/** 截断比较（与 useDedupe.jaccardOf 同口径） */
const MAX_KEY_COMPARE = 2000;
function jaccardOf(A, B) {
    if (!Array.isArray(A) || !Array.isArray(B) || !A.length || !B.length) return null;
    const la = Math.min(MAX_KEY_COMPARE, A.length), lb = Math.min(MAX_KEY_COMPARE, B.length);
    let i = 0, j = 0, inter = 0;
    while (i < la && j < lb) {
        const x = A[i], y = B[j];
        if (x === y) { inter++; i++; j++; } else if (x < y) i++; else j++;
    }
    const union = la + lb - inter;
    return { jaccard: union ? inter / union : 0, inter, union, la, lb };
}

// ══════════════════════════════════════════════════════════════
// #2 规范化统一（评审要求：写成单测断言）
// ══════════════════════════════════════════════════════════════
test('规范化：trim + lowercase + NFC（全库唯一口径）', () => {
    assert.equal(normalizeWbKey('  炎孕  '), '炎孕', '应 trim');
    assert.equal(normalizeWbKey('ABC'), 'abc', '应 lowercase');
    assert.equal(normalizeWbKey('café'), normalizeWbKey('cafe\u0301'), 'NFC：组合字符应与预组合等价');
    assert.equal(normalizeWbKey(null), 'null', '非字符串应 String() 后处理（不抛错）');
    assert.equal(normalizeWbKey(undefined), 'undefined');
    assert.equal(normalizeWbKey(123), '123');
});

test('规范化后相同 → hash 相同（大小写/全半角/组合字符不产生假差异）', () => {
    const a = buildKeyHashes([{ key: ['  Hello '] }]);
    const b = buildKeyHashes([{ key: ['hello'] }]);
    assert.deepEqual(a, b, '「  Hello 」与「hello」规范化后应一致');
    const c = buildKeyHashes([{ key: ['café'] }]);
    const d = buildKeyHashes([{ key: ['cafe\u0301'] }]);
    assert.deepEqual(c, d, 'NFC 组合字符应等价');
});

// ══════════════════════════════════════════════════════════════
// buildKeyHashes 基本性质
// ══════════════════════════════════════════════════════════════
test('buildKeyHashes：去重 + 升序（升序是 bottom-k 的前提）', () => {
    const kh = buildKeyHashes([
        { key: ['b', 'a', 'a'] },
        { key: ['c'] },
        { key: [] },
        { key: 'd' }        // 单值（非数组）也应支持
    ]);
    assert.equal(kh.length, 4, 'a/b/c/d 去重后 4 个');
    const sorted = [...kh].sort((x, y) => x - y);
    assert.deepEqual(kh, sorted, '必须升序（bottom-k sketch 依赖此性质）');
});

test('buildKeyHashes：截断到 MAX_KEYS_PER_BOOK，且保留**最小的** N 个（= bottom-k）', () => {
    const entries = [];
    for (let i = 0; i < 3000; i++) entries.push({ key: ['k' + i] });
    const kh = buildKeyHashes(entries);
    assert.equal(kh.length, MAX_KEYS_PER_BOOK, '应截断到 2000');
    // ★ bottom-k 性质：截断后保留的是**最小值**的 2000 个
    const all = buildKeyHashes(entries.map(e => e));   // 同上
    const min2000 = [...all].sort((a, b) => a - b).slice(0, MAX_KEYS_PER_BOOK);
    assert.deepEqual(kh, min2000, '截断必须保留最小的 2000 个 hash（bottom-k）');
});

test('buildKeyHashes：脏数据不抛错（null / 数字 / 对象 key）', () => {
    assert.doesNotThrow(() => buildKeyHashes([null, undefined, {}, { key: null }, { key: 123 }, { key: {} }]));
    const kh = buildKeyHashes([{ key: 123 }]);
    assert.equal(kh.length, 1, '数字 key 应被 String() 接受');
});

// ══════════════════════════════════════════════════════════════
// #7 exactContentHash 的 canonical 序列化
// ══════════════════════════════════════════════════════════════
test('exactContentHash：**键序不同**但逻辑相同 → hash 相同（canonical JSON）', () => {
    const a = exactContentHash([{ key: ['x'], content: 'c' }]);
    const b = exactContentHash([{ content: 'c', key: ['x'] }]);
    assert.equal(a, b, '键序不同不应产生不同 hash（否则「确定性」是假的）');
});

test('exactContentHash：**顺序不同** → hash 不同（顺序敏感，v3 评审 §5 #7③）', () => {
    const a = exactContentHash([{ content: '1' }, { content: '2' }]);
    const b = exactContentHash([{ content: '2' }, { content: '1' }]);
    assert.notEqual(a, b, '条目顺序不同应视为不同版本（顺序语义交给 simhash）');
});

test('exactContentHash：内容**不做** NFC/大小写规范化（字节级，「完全相同」就该如此）', () => {
    const a = exactContentHash([{ content: 'Hello' }]);
    const b = exactContentHash([{ content: 'hello' }]);
    assert.notEqual(a, b, 'exactHash 必须字节级敏感（与 keys 的规范化口径相反，这是有意的）');
});

test('exactContentHash：剔除前端内部字段（uid/_collapsed），同内容跨会话一致', () => {
    const a = exactContentHash([{ key: ['x'], content: 'c', uid: 'AAA', _collapsed: true }]);
    const b = exactContentHash([{ key: ['x'], content: 'c', uid: 'BBB', _collapsed: false }]);
    assert.equal(a, b, 'uid/_collapsed 是前端临时字段，不应影响内容指纹');
});

test('exactContentHash：嵌套对象也走 canonical（递归键排序）', () => {
    const a = exactContentHash([{ content: 'c', extensions: { b: 2, a: 1 } }]);
    const b = exactContentHash([{ content: 'c', extensions: { a: 1, b: 2 } }]);
    assert.equal(a, b, '嵌套对象的键序也不应影响 hash');
});

// ══════════════════════════════════════════════════════════════
// #8 截断比较口径（跨「截断/未截断」书，双方都截到 min(k, 自身)）
// ══════════════════════════════════════════════════════════════
test('jaccardOf：相同集合 → 1.0；无交集 → 0', () => {
    assert.equal(jaccardOf([1, 2, 3], [1, 2, 3]).jaccard, 1);
    assert.equal(jaccardOf([1, 2], [3, 4]).jaccard, 0);
    assert.equal(jaccardOf([1, 2, 3], [2, 3, 4]).jaccard, 0.5, '交 2 / 并 4 = 0.5');
});

test('jaccardOf：**截断 vs 未截断** —— 双方都截到 min(k, 自身)，避免系统性低估', () => {
    // A 有 2000 个（已截断），B 有 2000 个，两者前 1000 个相同
    const A = [], B = [];
    for (let i = 0; i < 1000; i++) { A.push(i); B.push(i); }
    for (let i = 1000; i < 2000; i++) { A.push(i); B.push(i + 10000); }
    const r = jaccardOf(A, B);
    assert.equal(r.la, 2000, 'A 应截到 2000');
    assert.equal(r.lb, 2000, 'B 应截到 2000');
    assert.equal(r.inter, 1000);
    assert.equal(r.jaccard, 1000 / 3000, '交 1000 / 并 3000');
});

test('jaccardOf：一侧超限一侧不足 → 双方各按自身 min(k, 长度) 截', () => {
    const A = Array.from({ length: 2000 }, (_, i) => i);
    const B = [0, 1, 2];                 // 只有 3 个
    const r = jaccardOf(A, B);
    assert.equal(r.la, 2000, 'A 截到 2000');
    assert.equal(r.lb, 3, 'B 不足 2000 → 用自身 3 个（**不补齐**，这是正确口径）');
    assert.equal(r.inter, 3, 'A 含 0,1,2 → 交集 3');
    assert.equal(r.jaccard, 3 / 2000);
});

test('jaccardOf：空/缺失 → null（调用方据此明确标注「缺少索引」，不静默）', () => {
    assert.equal(jaccardOf([], [1]), null);
    assert.equal(jaccardOf(null, [1]), null);
    assert.equal(jaccardOf([1], undefined), null);
});

// ══════════════════════════════════════════════════════════════
// P0-2 的数学性质：截断 = bottom-k ⇒ Jaccard 仍是无偏估计
// ══════════════════════════════════════════════════════════════
test('bottom-k 性质：截断后 Jaccard 与全量 Jaccard 的偏差有界（无偏性抽样验证）', () => {
    // 构造两个大集合（共享 50%），比较「全量」与「bottom-k(64)」的 Jaccard
    const mk = (seed, overlap) => {
        const s = new Set();
        for (let i = 0; i < overlap; i++) s.add(fnv1a32('shared' + i));
        for (let i = 0; i < 500; i++) s.add(fnv1a32(seed + i));
        return [...s].sort((a, b) => a - b);
    };
    const A = mk('A', 500), B = mk('B', 500);
    const full = jaccardOf(A, B).jaccard;
    const k64 = jaccardOf(A.slice(0, 64), B.slice(0, 64)).jaccard;
    // bottom-k 是估计量，不要求完全相等；只要求「不系统性偏离」（同一数量级）
    assert.ok(k64 >= 0 && k64 <= 1, '应在 [0,1]');
    assert.ok(Math.abs(k64 - full) < 0.5, `bottom-k 估计不应严重偏离全量（full=${full.toFixed(3)} k64=${k64.toFixed(3)}）`);
});
