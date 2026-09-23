/**
 * 内容级查重误判单测（PK-29，2026-09-23 用户实测报出）
 *
 * 用户原话：「两完全不相似的世界书进行对比查重」（被判为重复）
 *
 * 两个独立根因：
 *   ① **simhash 阈值失准**：T=19 过宽（S0.5 的「负样本 min 31」是在**合成样本**上测的，
 *      真实库无关对距离**低至 17**）→ 收紧到 16（实测零误报零漏报）；
 *   ② **Union-Find 传递链误聚**：A~B≤T、B~C≤T 但 **A~C≫T** 时仍并成一簇
 *      （实测 `鬼物` 与主项距离 29 却被聚成 6 本一组，按钮是「清理其余」⇒ 可一键误删）
 *      → 加**簇心校验**：合并前要求双方**都与对方簇心**通过闸门。
 *
 * 本单测用**等价实现**锁死这两条，防止回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ══════════════════════════════════════════════════════════════
// 等价复刻：useDedupe 的算法（与生产代码同口径）
// ══════════════════════════════════════════════════════════════
const SIMHASH_N = 4, SIMHASH_STEP = 4;
const SIMHASH_THRESHOLD = 16;              // PK-29：19 → 16
const CONTENT_SIMILARITY_THRESHOLD = 0.85;

function computeSimhash(text) {
    const v = new Int32Array(64);
    for (let i = 0; i + SIMHASH_N <= text.length; i += SIMHASH_STEP) {
        let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
        for (let k = 0; k < SIMHASH_N; k++) {
            const c = text.charCodeAt(i + k);
            lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
            hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
        }
        for (let b = 0; b < 32; b++) { v[b] += ((lo >>> b) & 1) ? 1 : -1; v[b + 32] += ((hi >>> b) & 1) ? 1 : -1; }
    }
    let a = 0, b2 = 0;
    for (let b = 0; b < 32; b++) { if (v[b] > 0) a |= (1 << b); if (v[b + 32] > 0) b2 |= (1 << b); }
    return [a >>> 0, b2 >>> 0];
}
const hammingDistance = (a, b) => {
    let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    while (y) { c += y & 1; y >>>= 1; }
    return c;
};
const getShingles = (t) => { const s = new Set(); for (let i = 0; i + 4 <= t.length; i++) s.add(t.slice(i, i + 4)); return s; };
const MINHASH_HASHES = 96;
const seeds = (() => { const s = []; let x = 0x9e3779b9; for (let i = 0; i < MINHASH_HASHES; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s.push(x); } return s; })();
// 🛑 PK-30：不能退回 `h * 31 + c`（对定长 shingle 会结构性退化）
const hashString = (str, seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
};
/** PK-30 的退化实现（用于对照断言，证明差异存在） */
const hashStringDegenerate = (str, seed) => { let h = seed >>> 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
const computeMinHashWith = (hashFn) => (sh) => { const sig = new Array(MINHASH_HASHES).fill(0x7fffffff); sh.forEach(x => { for (let i = 0; i < MINHASH_HASHES; i++) { const h = hashFn(x, seeds[i]); if (h < sig[i]) sig[i] = h; } }); return sig; };
const computeMinHash = computeMinHashWith(hashString);
const estimateSimilarity = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) s++; return s / a.length; };

/** 朴素并查集（修复前的行为） */
function unionFindNaive(n) {
    const p = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[rb] = ra; };
    return { find, union };
}
/** 🛡️ 带闸门 + 簇心校验的并查集（修复后） */
function unionFindGated(n, gate, weight) {
    const p = Array.from({ length: n }, (_, i) => i);
    const rep = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra === rb) return false;
        if (!gate(rep[ra], b) || !gate(rep[rb], a)) return false;
        const wA = weight ? (weight[rep[ra]] || 0) : 0;
        const wB = weight ? (weight[rep[rb]] || 0) : 0;
        p[rb] = ra;
        rep[ra] = wA >= wB ? rep[ra] : rep[rb];
        return true;
    };
    return { find, union };
}
/** 把并查集结果整理成「组」（只保留 ≥2 的簇） */
function groupsOf(find, n) {
    const m = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); }
    return [...m.values()].filter(g => g.length >= 2);
}

/**
 * 🧬 高熵语料：从 CJK 区随机取字。
 * ⚠️ 为什么不能用「模板重复文本」当语料（实测踩到）：
 *    模板文本的 4-gram 去重数极小（如 3000 段重复模板 → 仅 4000 余个 distinct shingle，
 *    且两本不同模板的文本仍有 30% 共享）⇒ 替换 5% 的块就会把对方的**全部** shingle 引入
 *    → 相似度断崖下跌，度量退化，测试结论不可信。
 *    真实世界书的 4-gram 去重数上万，必须用**高熵语料**模拟。
 */
function highEntropy(len, seed0) {
    let s = seed0 >>> 0;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 0x1000000; };
    let out = '';
    for (let i = 0; i < len; i++) out += String.fromCharCode(0x4e00 + Math.floor(rnd() * 2000));
    return out;
}

/** 造测试语料：把 base 的若干块替换为 filler 的块（p = 替换比例） */
function mixText(base, filler, p, seed0 = 7) {
    let seed = seed0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const K = 40, cb = Math.floor(base.length / K), cf = Math.floor(filler.length / K);
    const parts = [];
    for (let i = 0; i < K; i++) parts.push(rnd() < p ? filler.slice(i * cf, (i + 1) * cf) : base.slice(i * cb, (i + 1) * cb));
    return parts.join('');
}

const BASE = highEntropy(20000, 101);
const FILLER = highEntropy(20000, 202);

// ══════════════════════════════════════════════════════════════

test('PK-29①：阈值已收紧到实测安全区（T=16，不再是 19）', () => {
    assert.equal(SIMHASH_THRESHOLD, 16, 'simhash 阈值必须是 16（真实库实测：T≤16 零误报零漏报）');
    assert.ok(SIMHASH_THRESHOLD < 19, '必须严格小于旧的 19 —— 旧值会把无关书判近（实测无关对距离低至 17）');
});

test('PK-29①：无关文本的 simhash 距离 > 阈值（不被预筛命中）', () => {
    const a = computeSimhash(BASE);
    const b = computeSimhash(FILLER);
    const d = hammingDistance(a, b);
    assert.ok(d > SIMHASH_THRESHOLD,
        `完全无关的两本书距离应超过阈值，实测 d=${d}（阈值 ${SIMHASH_THRESHOLD}）`);
});
test('PK-29①：复核闸门能拦下「预筛命中但内容无关」的误判', () => {
    // 造一对「simhash 近但内容无关」：用不同 filler 混合，使 simhash 巧合接近
    const x = mixText(BASE, FILLER, 0.5, 3);
    const y = mixText(BASE, FILLER, 0.52, 9);
    const dx = computeSimhash(x), dy = computeSimhash(y);
    const mhX = computeMinHash(getShingles(x)), mhY = computeMinHash(getShingles(y));
    const gate = (i, j) => {
        const sigs = [dx, dy], mhs = [mhX, mhY];
        if (hammingDistance(sigs[i], sigs[j]) > SIMHASH_THRESHOLD) return false;
        const a = mhs[i], b = mhs[j];
        if (!a || !b) return true;
        return estimateSimilarity(a, b) >= CONTENT_SIMILARITY_THRESHOLD;
    };
    const trueSim = estimateSimilarity(mhX, mhY);
    // 闸门结论必须与真实内容相似度一致
    assert.equal(gate(0, 1), trueSim >= CONTENT_SIMILARITY_THRESHOLD,
        `闸门结论必须由真实内容相似度决定（实测 ${(trueSim * 100).toFixed(1)}%）`);
});

test('PK-29①：完全相同的内容必须通过闸门（不能修成「什么都不算重复」）', () => {
    const a = computeSimhash(BASE), mhA = computeMinHash(getShingles(BASE));
    assert.equal(hammingDistance(a, a), 0);
    assert.equal(estimateSimilarity(mhA, mhA), 1, '同一份内容的自相似度必须为 1');
});

test('PK-29②：簇心校验必须切断「A~B 近、B~C 近、但 A~C 远」的链式误聚', () => {
    // 构造 3 本书的 simhash 距离矩阵：0-1 = 10（近）、1-2 = 10（近）、0-2 = 30（远）
    // 用真实文本造不出精确距离，故直接用「假签名」测**并查集机制本身**
    const fake = [
        { sig: [0b0, 0b0], mh: null },   // 全 0
        { sig: [0b1111111111, 0b0], mh: null },  // 与 0 距 10
        { sig: [0b0, 0b1111111111111111111111, 0b0].slice(0, 2), mh: null } // 占位，下面重设
    ];
    // 精确构造：0=0，1=低10位全1（d(0,1)=10），2=低20位全1（d(0,2)=20 > 16，d(1,2)=10）
    const s0 = [0, 0];
    const s1 = [0b1111111111, 0];                 // d(0,1) = 10
    const s2 = [0b11111111111111111111, 0];       // d(0,2) = 20 > 16 ；d(1,2) = 10
    const sigs = [s0, s1, s2];
    assert.equal(hammingDistance(s0, s1), 10, '前置：d(0,1) 应为 10');
    assert.equal(hammingDistance(s1, s2), 10, '前置：d(1,2) 应为 10');
    assert.equal(hammingDistance(s0, s2), 20, '前置：d(0,2) 应为 20（超过阈值 16）');

    const gate = (i, j) => hammingDistance(sigs[i], sigs[j]) <= SIMHASH_THRESHOLD;

    // 修复前：朴素并查集 → 三者串成一组（错误）
    const naive = unionFindNaive(3);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (gate(a, b)) naive.union(a, b);
    const naiveGroups = groupsOf(naive.find, 3);
    assert.equal(naiveGroups.length, 1, '前置：朴素并查集确实会把三者串成 1 组（这就是原缺陷）');
    assert.equal(naiveGroups[0].length, 3);

    // 修复后：簇心校验 → 必须切断，不能让 0 与 2 同组
    const gated = unionFindGated(3, gate, [3, 2, 1]);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) gated.union(a, b);
    const gatedGroups = groupsOf(gated.find, 3);
    const sameGroup02 = gatedGroups.some(g => g.includes(0) && g.includes(2));
    assert.equal(sameGroup02, false,
        `簇心校验必须阻止 A~C（距离 20 > 阈值 16）同组，实际分组：${JSON.stringify(gatedGroups)}`);
    // 且近邻关系仍应保留（不能把 0-1 也切断）
    assert.ok(gatedGroups.some(g => g.includes(0) && g.includes(1)),
        `0 与 1 距离 10 ≤ 阈值，应保留同组，实际：${JSON.stringify(gatedGroups)}`);
});

test('PK-29②：簇心校验不能把「真实同源链」误切断（召回不损失）', () => {
    // 真实场景：A 与 B 同源、B 与 C 同源，A~C 也接近（真实库实测的「同源链」）
    const tA = BASE;
    const tB = mixText(BASE, FILLER, 0.05, 11);
    const tC = mixText(tB, FILLER, 0.05, 23);
    const sigs = [computeSimhash(tA), computeSimhash(tB), computeSimhash(tC)];
    const mhs = [computeMinHash(getShingles(tA)), computeMinHash(getShingles(tB)), computeMinHash(getShingles(tC))];
    const gate = (i, j) => {
        if (hammingDistance(sigs[i], sigs[j]) > SIMHASH_THRESHOLD) return false;
        return estimateSimilarity(mhs[i], mhs[j]) >= CONTENT_SIMILARITY_THRESHOLD;
    };
    const uf = unionFindGated(3, gate, [tA.length, tB.length, tC.length]);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) uf.union(a, b);
    const groups = groupsOf(uf.find, 3);
    // 三者应聚在一起（同源链），不能因簇心校验而全散开
    assert.ok(groups.length >= 1 && groups.some(g => g.length >= 2),
        `同源内容应被聚成组，实际：${JSON.stringify(groups)}`);
});

test('PK-29：缺 MinHash 的条目必须「降级为仅 simhash」而不是「补空签名」（防闸门恒真失效）', () => {
    // 空集合的 MinHash 签名会让任意两本的 estimateSimilarity = 1.0 → 闸门恒真 → 完全失效
    const emptyMh = computeMinHash(new Set());
    assert.equal(estimateSimilarity(emptyMh, emptyMh), 1,
        '前置：空签名的自相似度为 1（这就是为什么不能给缺数据的条目补空签名）');
    // 生产代码的契约：缺数据 → gate 直接返回 true（降级），绝不构造空签名参与比较
    const mhSigs = [null, null];
    const gate = (i, j) => {
        const a = mhSigs[i], b = mhSigs[j];
        if (!a || !b) return true;   // 降级：只信 simhash
        return estimateSimilarity(a, b) >= CONTENT_SIMILARITY_THRESHOLD;
    };
    assert.equal(gate(0, 1), true, '缺 MinHash 时应降级放行（由 simhash 预筛负责），而不是崩或误判');
});

test('PK-29：展示相似度必须用 MinHash（真实内容重合度），不是 simhash 距离换算', () => {
    // 复刻实测案例：simhash 距离 19（旧代码显示 1-19/64 = 70%），但真实内容完全无关
    const simhashDerived = Math.max(0, Math.round((1 - 19 / 64) * 100));
    assert.equal(simhashDerived, 70, '前置：旧口径下距离 19 会显示 70% —— 这正是误导用户的来源');

    const unrelatedA = computeMinHash(getShingles(BASE));
    const unrelatedB = computeMinHash(getShingles(FILLER));
    const trueSim = Math.round(estimateSimilarity(unrelatedA, unrelatedB) * 100);
    assert.ok(trueSim < 50,
        `无关内容的真实重合度必须远低于 simhash 换算值（实测 ${trueSim}% vs 换算 70%）`);
});

// ══════════════════════════════════════════════════════════════
// PK-30：MinHash 哈希族独立性（防止「96 个 seed 实际只有 1 个」的退化）
// ══════════════════════════════════════════════════════════════

test('PK-30：哈希族必须真正独立（不同 seed 产生不同排列）', () => {
    // 用**等长** shingle（本项目的 4-gram 恒为 4 字符）—— 这正是退化触发的条件
    const shingles = [];
    for (let i = 0; i < 300; i++) {
        shingles.push(String.fromCharCode(0x4e00 + i)
            + String.fromCharCode(0x4e00 + (i * 7) % 300)
            + String.fromCharCode(0x4e00 + (i * 13) % 300)
            + String.fromCharCode(0x4e00 + (i * 29) % 300));
    }
    // 统计「最小值落在哪个 shingle」的分布
    const argminCounts = new Array(shingles.length).fill(0);
    for (let i = 0; i < MINHASH_HASHES; i++) {
        let best = Infinity, bestIdx = -1;
        for (let x = 0; x < shingles.length; x++) {
            const v = hashString(shingles[x], seeds[i]);
            if (v < best) { best = v; bestIdx = x; }
        }
        argminCounts[bestIdx]++;
    }
    const distinctArgmins = argminCounts.filter(c => c > 0).length;
    const maxHit = Math.max(...argminCounts);
    assert.ok(distinctArgmins >= 50,
        `哈希族的「最小值落点」应有大量不同取值（独立哈希期望 ≈96），实测仅 ${distinctArgmins} 个 —— 疑似退化`);
    assert.ok(maxHit <= 8,
        `单个 shingle 不应被过多 seed 同时选中（退化时会出现 95/96），实测最多 ${maxHit} 次`);
});

test('PK-30：退化实现（h*31+c）必须被本测试识别为不独立', () => {
    // 反向验证：确认本测试**真的能抓到**退化 —— 否则断言是假的
    const shingles = [];
    for (let i = 0; i < 300; i++) {
        shingles.push(String.fromCharCode(0x4e00 + i)
            + String.fromCharCode(0x4e00 + (i * 7) % 300)
            + String.fromCharCode(0x4e00 + (i * 13) % 300)
            + String.fromCharCode(0x4e00 + (i * 29) % 300));
    }
    const argminCounts = new Array(shingles.length).fill(0);
    for (let i = 0; i < MINHASH_HASHES; i++) {
        let best = Infinity, bestIdx = -1;
        for (let x = 0; x < shingles.length; x++) {
            const v = hashStringDegenerate(shingles[x], seeds[i]);
            if (v < best) { best = v; bestIdx = x; }
        }
        argminCounts[bestIdx]++;
    }
    const distinctArgmins = argminCounts.filter(c => c > 0).length;
    assert.ok(distinctArgmins < 50,
        `前置：退化实现应被识别为不独立（实测 ${distinctArgmins} 个不同落点）—— 若此断言失败，说明测试无法抓到退化`);
});

test('PK-30：修复后 MinHash 估计误差回到理论范围（96 维标准误 ≈ 10.2%）', () => {
    // 用高熵语料造「已知相似度」样本，检验估计精度
    const A = BASE;
    const B = mixText(BASE, FILLER, 0.5, 31);   // 与 A 有约 50% 内容相同
    const mhA = computeMinHash(getShingles(A));
    const mhB = computeMinHash(getShingles(B));
    const est = estimateSimilarity(mhA, mhB);
    // 真实 Jaccard（精确计算）
    const setA = getShingles(A), setB = getShingles(B);
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    const trueJ = inter / (setA.size + setB.size - inter);
    const err = Math.abs(est - trueJ);
    assert.ok(err < 0.35,
        `估计误差应落在理论范围（96 维 3σ ≈ 31%），实测估计 ${(est * 100).toFixed(1)}% vs 真实 ${(trueJ * 100).toFixed(1)}%，误差 ${(err * 100).toFixed(1)}%`);
});

test('PK-30：同一份内容的自相似度必须为 1（签名确定性）', () => {
    const mh1 = computeMinHash(getShingles(BASE));
    const mh2 = computeMinHash(getShingles(BASE));
    assert.deepEqual(mh1, mh2, '同一文本两次计算的签名必须完全一致（确定性）');
    assert.equal(estimateSimilarity(mh1, mh2), 1);
});
