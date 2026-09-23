/**
 * PK-27 / S3' 单测：simhash 内容指纹（替代 MinHash+LSH，解 PK-25）
 *
 * 覆盖：
 *   · simhash 的**确定性**（同文本同签名）
 *   · **汉明距离语义**（相似文本距离小、无关文本距离大，接近理论期望 32）
 *   · 采样（step=4）不影响可分性（S0.5 实测正 max 8 / 负 min 31）
 *   · ⚠️ **关键回归**：simhash 位向量**不能**用 `estimateSimilarity`（会全漏报）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ══════════════════════════════════════════════════════════════
// 被测实现的等价复刻（与 useDedupe.js 逐字一致）
// ══════════════════════════════════════════════════════════════
const SIMHASH_N = 4;
const SIMHASH_STEP = 4;
const SIMHASH_THRESHOLD = 19;

const normalizeText = (t) => String(t || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();

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

function hammingDistance(a, b) {
    let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    while (y) { c += y & 1; y >>>= 1; }
    return c;
}

// MinHash（用于回归测试：证明两者不可混用）
const MINHASH_HASHES = 96;
const minhashSeeds = (() => {
    const seeds = []; let s = 0x9e3779b9;
    for (let i = 0; i < MINHASH_HASHES; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; seeds.push(s); }
    return seeds;
})();
const hashString = (str, seed) => { let h = seed >>> 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
const computeMinHash = (shingles) => {
    const sig = new Array(MINHASH_HASHES).fill(0x7fffffff);
    shingles.forEach(sh => { for (let i = 0; i < MINHASH_HASHES; i++) { const h = hashString(sh, minhashSeeds[i]); if (h < sig[i]) sig[i] = h; } });
    return sig;
};
const estimateSimilarity = (a, b) => { let same = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++; return same / a.length; };
const getShingles = (text) => { const set = new Set(); for (let i = 0; i + 4 <= text.length; i++) set.add(text.slice(i, i + 4)); return set; };

// ══════════════════════════════════════════════════════════════
// 基本性质
// ══════════════════════════════════════════════════════════════
test('simhash：确定性（同文本 → 同签名）', () => {
    const t = '这是一段用于测试的世界书词条正文内容，包含若干中文字符与 English words 123。';
    const a = computeSimhash(t), b = computeSimhash(t);
    assert.deepEqual(a, b, '同文本必须产出相同签名（确定性）');
    assert.equal(hammingDistance(a, b), 0, '自身距离必须为 0');
});

test('simhash：返回 64 位（两个 32 位无符号整数）', () => {
    const s = computeSimhash('测试文本内容');
    assert.equal(s.length, 2, '应为 [lo, hi] 两段');
    assert.ok(s[0] >= 0 && s[0] <= 0xFFFFFFFF, 'lo 应在 uint32 范围');
    assert.ok(s[1] >= 0 && s[1] <= 0xFFFFFFFF, 'hi 应在 uint32 范围');
});

test('simhash：空文本/极短文本不抛错', () => {
    assert.doesNotThrow(() => computeSimhash(''));
    assert.doesNotThrow(() => computeSimhash('a'));
    assert.doesNotThrow(() => computeSimhash('abc'));
    assert.deepEqual(computeSimhash(''), [0, 0], '空文本 → 全 0 票（无特征）');
});

// ══════════════════════════════════════════════════════════════
// ★ 汉明距离语义（S3' 判定的核心）
// ══════════════════════════════════════════════════════════════
test('★ 相似文本 → 汉明距离小（远小于阈值）', () => {
    const base = '角色设定：李斌是一名普通的高中生，性格内向但善良。他有一个青梅竹马叫小雨。'.repeat(20);
    const modified = base + '（额外补充：他喜欢看书。）';   // 微调：追加一小段
    const d = hammingDistance(computeSimhash(base), computeSimhash(modified));
    assert.ok(d <= SIMHASH_THRESHOLD, `相似文本距离应 ≤ T=${SIMHASH_THRESHOLD}（实测 ${d}）`);
});

test('★ 无关文本 → 汉明距离大（远超阈值）', () => {
    const a = '角色设定：李斌是一名高中生，性格内向。'.repeat(30);
    const b = '世界观设定：这是一片魔法大陆，龙族与精灵族世代为敌。'.repeat(30);
    const d = hammingDistance(computeSimhash(a), computeSimhash(b));
    assert.ok(d > SIMHASH_THRESHOLD, `无关文本距离应 > T=${SIMHASH_THRESHOLD}（实测 ${d}）`);
});

test('★ 无关文本的期望距离接近理论值 32（验证实现无偏）', () => {
    // 生成多对无关文本，看距离均值是否接近 32（64 位随机向量的期望）
    const ds = [];
    for (let i = 0; i < 20; i++) {
        const a = `文本A第${i}版：${'内容甲'.repeat(40)}`;
        const b = `文本B第${i}版：${'内容乙'.repeat(40)}`;
        ds.push(hammingDistance(computeSimhash(a), computeSimhash(b)));
    }
    const avg = ds.reduce((s, x) => s + x, 0) / ds.length;
    // 理论期望 32；允许较宽区间（采样 step=4 增加方差）
    assert.ok(avg > 20 && avg < 44, `无关文本平均距离应接近 32（实测均值 ${avg.toFixed(1)}）`);
});

// ══════════════════════════════════════════════════════════════
// ★★ 关键回归：simhash 不能用 estimateSimilarity（会全漏报）
// ══════════════════════════════════════════════════════════════
test('★★ 回归：对 simhash 位向量用 estimateSimilarity 语义完全错误（会**假阳性**）', () => {
    const base = '角色设定：李斌是一名普通的高中生，性格内向但善良。'.repeat(20);
    const mod = base + '（补充一句）';        // 微调（内容高度相似，但非完全相同）
    const far = '完全无关的另一段文本：魔法大陆与龙族战争。'.repeat(20);
    const sigBase = computeSimhash(base);
    const sigMod = computeSimhash(mod);
    const sigFar = computeSimhash(far);

    // ✅ 正确口径：汉明距离换算 → 相似度高、无关低
    const rightMod = 1 - hammingDistance(sigBase, sigMod) / 64;
    const rightFar = 1 - hammingDistance(sigBase, sigFar) / 64;
    assert.ok(rightMod > 0.7, `汉明距离：微调文本应高度相似（实测 ${rightMod.toFixed(2)}）`);
    assert.ok(rightFar < 0.7, `汉明距离：无关文本应低（实测 ${rightFar.toFixed(2)}）`);

    // ❌ 错误口径：`estimateSimilarity` 只比 `[lo,hi]` **两个数字**
    //    → 一旦两个数恰好相同（lo、hi 都对上）就返回 **1.0**（**假阳性**）；
    //    → 一旦不同就返回 0（**假阴性**）。**两个方向都错**，完全无中间态。
    const wrongMod = estimateSimilarity(sigBase, sigMod);
    const wrongFar = estimateSimilarity(sigBase, sigFar);
    const isDegenerate = (v) => v === 0 || v === 1;
    assert.ok(isDegenerate(wrongMod), `estimateSimilarity 对 2 元素位向量只能给 0 或 1（实测 ${wrongMod}）—— 证明不可混用`);
    assert.ok(isDegenerate(wrongFar), `同上（实测 ${wrongFar}）`);
});

test('★★ 回归：simhash 对「部分相同」的文本必须给出**中间态**（estimateSimilarity 做不到）', () => {
    // 构造：前半相同、后半不同 → 相似度应在中间（既非 0 也非 1）
    const a = '第一部分：角色设定李斌是高中生。'.repeat(40);
    const b = '第一部分：角色设定李斌是高中生。'.repeat(20) + '第二部分：完全不同的世界观描述。'.repeat(20);
    const d = hammingDistance(computeSimhash(a), computeSimhash(b));
    const sim = 1 - d / 64;
    assert.ok(sim > 0 && sim < 1, `部分相同应给中间态（实测 ${sim.toFixed(2)}，距离 ${d}）`);
});

test('★★ 回归：MinHash 路径仍正常（角色卡/预设不受影响）', () => {
    const a = '角色设定：李斌是一名高中生，性格内向。'.repeat(20);
    const b = a;   // 相同
    const c = '完全不同的另一段文本：魔法大陆与龙族战争。'.repeat(20);
    const sa = computeMinHash(getShingles(normalizeText(a)));
    const sb = computeMinHash(getShingles(normalizeText(b)));
    const sc = computeMinHash(getShingles(normalizeText(c)));
    assert.ok(estimateSimilarity(sa, sb) > 0.99, 'MinHash 对相同文本应 ~1.0');
    assert.ok(estimateSimilarity(sa, sc) < 0.3, 'MinHash 对无关文本应很低');
});

// ══════════════════════════════════════════════════════════════
// 采样（step=4）不影响可分性
// ══════════════════════════════════════════════════════════════
test('采样 step=4：正样本距离仍 ≤ T，负样本距离仍 > T（S0.5 实测 8 / 31）', () => {
    const mk = (seed) => {
        let s = '';
        for (let i = 0; i < 3000; i++) s += String.fromCharCode(0x4e00 + ((seed * 7919 + i * 104729) % 2000));
        return s;
    };
    const A = mk(1), A2 = A + '补充内容', B = mk(2);
    const dPos = hammingDistance(computeSimhash(A), computeSimhash(A2));
    const dNeg = hammingDistance(computeSimhash(A), computeSimhash(B));
    assert.ok(dPos <= SIMHASH_THRESHOLD, `正样本距离 ${dPos} 应 ≤ ${SIMHASH_THRESHOLD}`);
    assert.ok(dNeg > SIMHASH_THRESHOLD, `负样本距离 ${dNeg} 应 > ${SIMHASH_THRESHOLD}`);
});

// ══════════════════════════════════════════════════════════════
// 🧬 P1-1（2026-09-23）：**跨实现口径一致性**（simhash 落盘的核心风险）
//
// 背景：`main.js` 的 `computeSimhash64` / `simhashInputOf`（**落盘路径**）
//   与 `useDedupe.js` 的 `computeSimhash` + `extractContentText`+`normalizeText`（**运行时路径**）
//   必须**逐字同口径**。任一处漂移 ⇒ 「同一本书，落盘的 simhash ≠ 运行时算的 simhash」
//   ⇒ 表现是「**同一本书两次查重结果不同**」，极难定位。
//
// 本单测**从源码里直接读实现**（不复制粘贴），确保测的是**真代码**而非副本。
// ══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** 从源码文本里抽出某个函数体（⚠️ 必须跳过注释与字符串再配对 —— 注释里的 `{`/`}` 会误导） */
function extractFn(src, name) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`未找到 function ${name}`);
    // 向前吞掉 `async ` 前缀（若有）
    let start0 = i;
    if (src.slice(Math.max(0, i - 6), i) === 'async ') start0 = i - 6;
    const start = src.indexOf('{', i);
    let depth = 0;
    let inLine = false, inBlock = false, inStr = false, quote = '';
    for (let k = start; k < src.length; k++) {
        const c = src[k], n = src[k + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
        if (inStr) {
            if (c === '\\') { k++; continue; }
            if (c === quote) inStr = false;
            continue;
        }
        if (c === '/' && n === '/') { inLine = true; k++; continue; }
        if (c === '/' && n === '*') { inBlock = true; k++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(start0, k + 1); }
    }
    throw new Error(`${name} 花括号不配对`);
}

/** 归一化函数体（去注释 / 空白 / 变量名差异无法处理，只做保守比对） */
const norm = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/\/\/[^\n]*/g, '')           // 行注释
    .replace(/\s+/g, ' ')
    .trim();

test('★ P1-1 口径一致：main.js 与 useDedupe.js 的 simhash 实现逐字等价', () => {
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');
    const dedupeSrc = fs.readFileSync(path.join(repoRoot, 'js', 'composables', 'useDedupe.js'), 'utf-8');

    const mainFn = norm(extractFn(mainSrc, 'computeSimhash64'));
    // useDedupe 里是 `const computeSimhash = (text) => { ... }`（箭头函数）
    const i = dedupeSrc.indexOf('const computeSimhash = (text) => {');
    assert.ok(i > 0, 'useDedupe.js 里应能找到 computeSimhash');
    const start = dedupeSrc.indexOf('{', i);
    let depth = 0, end = -1;
    for (let k = start; k < dedupeSrc.length; k++) {
        if (dedupeSrc[k] === '{') depth++;
        else if (dedupeSrc[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    const dedupeFn = norm(dedupeSrc.slice(start, end));

    // 去掉函数签名（`function x(text) {` vs `{`），只比**函数体**
    const bodyOf = (s) => { const b = s.indexOf('{'); return s.slice(b + 1, s.lastIndexOf('}')); };
    assert.equal(bodyOf(mainFn), bodyOf(dedupeFn),
        '⚠️ main.js 的 computeSimhash64 与 useDedupe.js 的 computeSimhash **函数体必须逐字一致**\n'
        + '（口径漂移会导致「同一本书两次查重结果不同」）');
});

test('★ P1-1 口径一致：simhash 常量（N / STEP）两侧相同', () => {
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');
    const dedupeSrc = fs.readFileSync(path.join(repoRoot, 'js', 'composables', 'useDedupe.js'), 'utf-8');
    const pick = (src, name) => {
        const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(src);
        return m ? Number(m[1]) : null;
    };
    assert.equal(pick(mainSrc, 'SIMHASH_N'), pick(dedupeSrc, 'SIMHASH_N'), 'SIMHASH_N 必须一致');
    assert.equal(pick(mainSrc, 'SIMHASH_STEP'), pick(dedupeSrc, 'SIMHASH_STEP'), 'SIMHASH_STEP 必须一致');
});

test('★ P1-1 口径一致：main.js 的 simhashInputOf 与 useDedupe 的 extractContentText+normalizeText 同口径', () => {
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');
    const fn = extractFn(mainSrc, 'simhashInputOf');
    // 关键特征必须齐备（缺一即口径漂移）
    assert.ok(/Array\.isArray\(e\.key\)/.test(fn), 'simhashInputOf 必须处理 e.key 为数组的情况');
    assert.ok(/e\.key\.join\(','\)/.test(fn), "simhashInputOf 必须用 ',' 连接多 key（与 extractContentText 一致）");
    assert.ok(/\$\{keys\} \$\{e\.content/.test(fn), 'simhashInputOf 必须是 `${keys} ${content}` 格式');
    assert.ok(/join\('\\n'\)/.test(fn), "simhashInputOf 必须用 '\\n' 连接词条");
    assert.ok(/\\s\+/.test(fn), 'simhashInputOf 必须做 \\s+ → 空格 归一化');
    assert.ok(/\\p\{L\}\\p\{N\}/.test(fn), 'simhashInputOf 必须保留字母数字（与 normalizeText 一致）');
    assert.ok(/toLowerCase\(\)/.test(fn), 'simhashInputOf 必须转小写');
    // 用等价输入做**行为级**验证
    const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
    const entries = [
        { key: ['魔法', 'Magic'], content: '这是内容 A' },
        { key: '战斗', content: '内容 B  with   spaces' },
        { key: ['x'] }
    ];
    const expected = normalizeText(entries.map(e => {
        const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
        return `${keys} ${e.content || ''}`;
    }).join('\n'));
    // 把 simhashInputOf 作为函数求值（源码里是纯函数，无外部依赖）
    const impl = new Function(`${fn}; return simhashInputOf;`)();
    assert.equal(impl(entries), expected, 'simhashInputOf 行为必须与「extractContentText + normalizeText」一致');
});

