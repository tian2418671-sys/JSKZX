/**
 * S3' 阈值**线上复核**（真实库，离线，不碰线上代码）
 *
 * 目的：S0.5 实验用的是「1 组同源 + 1 组独立」的**小样本**（10 正 / 5 负），
 *      定出 T=16（step=1）→ 落地加采样 step=4 后改为 **T=19**。
 *      本脚本在**真实世界书库**上复核：T=19 是否会 **误报（假阳）/ 漏报（假阴）**。
 *
 * ⚠️ 为什么必须上真实库（铁律 7）：
 *   压力库 `_wb5k/s1000` 是**硬链接放大**产物（40 组全是同一本书），
 *   首次实验因此跑出「汉明距离全 0」的假结论。真实库才有真正的多样性。
 *
 * 📐 判据（不猜，看分布）：
 *   1. **正样本**（人工标注的同源组）：汉明距离应 **≤ T**（否则漏报）
 *   2. **负样本**（人工标注的无关对）：汉明距离应 **> T**（否则误报）
 *   3. 输出**全库距离分布直方图**，看 T=19 落在哪个位置（是否在间隙中央）
 *
 * 用法：node scripts/probes/_probe-simhash-threshold-real.mjs "<真实世界书目录>" [--full]
 *   --full  对**全部两两**算距离（大库会很慢；默认只算标注对 + 抽样无关对）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2];
const FULL = process.argv.includes('--full');
if (!DIR || !fs.existsSync(DIR)) {
    console.error('用法：node scripts/probes/_probe-simhash-threshold-real.mjs "<真实世界书目录>" [--full]');
    process.exit(2);
}

// ═══════════════════════════════════════════════════════════
// 与线上**逐字一致**的 simhash 实现（`useDedupe.js` 的 computeSimhash）
//   ⚠️ 任何参数改动都必须同步改这里，否则复核结果无意义
// ═══════════════════════════════════════════════════════════
const SIMHASH_N = 4;
const SIMHASH_STEP = 4;
const SIMHASH_THRESHOLD = 19;

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

// ═══════════════════════════════════════════════════════════
// 收集世界书（与 main.js 的 `isValidWorldbook` 口径一致）
// ═══════════════════════════════════════════════════════════
const entriesOf = (d) => {
    const e = d && d.entries;
    if (Array.isArray(e)) return e;
    if (e && typeof e === 'object') return Object.values(e);
    return [];
};

const seen = new Map();
const walk = (d, depth = 0) => {
    if (depth > 4) return;
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.name.toLowerCase().endsWith('.json')) continue;
        let buf;
        try { buf = fs.readFileSync(p); } catch { continue; }
        const md5 = crypto.createHash('md5').update(buf).digest('hex');
        let data;
        try { data = JSON.parse(buf.toString('utf-8')); } catch { continue; }
        const arr = entriesOf(data);
        if (!arr.length) continue;                       // 诱饵（0 词条）跳过
        const content = arr.map(x => String((x && x.content) || '')).join('\n');
        if (content.length < 20) continue;               // 太短无法算指纹
        // 🔬 精确裁判用：词条 content 规范化集合（trim 后非空）
        const contents = new Set();
        for (const x of arr) {
            const s = String((x && x.content) || '').trim();
            if (s.length >= 20) contents.add(s);
        }
        const keys = new Set();
        for (const x of arr) {
            const k = Array.isArray(x && x.key) ? x.key : (x && x.key ? [x.key] : []);
            for (const y of k) { const s = String(y).trim().toLowerCase(); if (s) keys.add(s); }
        }
        // 同 MD5 只留一份（真库常有多份副本），但记录副本数
        if (seen.has(md5)) { seen.get(md5).dup++; continue; }
        seen.set(md5, { md5, name: e.name, file: p, content, contents, keys, chars: content.length, dup: 1 });
    }
};
walk(DIR);

const books = [...seen.values()];
console.log(`目录：${DIR}`);
console.log(`世界书：${books.length} 本（去重后；含副本的书已合并计数）`);
console.log(`正文合计：${(books.reduce((s, b) => s + b.chars, 0) / 1048576).toFixed(1)}M 字符`);
console.log(`参数：char ${SIMHASH_N}-gram ｜ 采样 step=${SIMHASH_STEP} ｜ 阈值 T=${SIMHASH_THRESHOLD}\n`);
if (books.length < 2) { console.error('书数不足（需 ≥2 本）'); process.exit(1); }

// ═══════════════════════════════════════════════════════════
// 计算指纹
// ═══════════════════════════════════════════════════════════
console.log('计算 simhash…');
const t0 = Date.now();
for (const b of books) b.sig = computeSimhash(b.content);
const ms = Date.now() - t0;
console.log(`完成：${ms}ms（${(ms / books.length).toFixed(1)}ms/本）\n`);

// ═══════════════════════════════════════════════════════════
// 正/负样本标注
//   ⚠️ **关键**：标注**不能依赖 simhash 自己**（会循环论证）。
//   用 **keys Jaccard** 做基准（S0.5 定稿：同源 98.6~100% ｜ 跨族 0%）：
//     · 正样本：Jaccard ≥ 0.90
//     · 负样本：Jaccard < 0.50
//     · 中间地带（0.50~0.90）：**不确定** → 单列，不参与误报/漏报判定
//      （keys 是触发词集合，simhash 是正文指纹 —— 两者独立，可互为验证）
// ═══════════════════════════════════════════════════════════
const baseName = (n) => n.replace(/\.json$/i, '')
    .replace(/\s*\(\d+\)/g, '')        // 去掉 " (1)" " (2)"
    .replace(/[-_. ]?\d+$/g, '')        // 去掉尾部 "-1" "_2" ".1" " 3"
    .replace(/[-_ ]?(副本|copy|改写[A-Z])/gi, '')
    .trim().toLowerCase();

const jaccard = (a, b) => {
    const A = a.keys, B = b.keys;
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const k of A) if (B.has(k)) inter++;
    return inter / (A.size + B.size - inter);
};

/** 🔬 **精确裁判**：词条 content 完全相同集合的 Jaccard（不采样、不看指纹） */
const contentJaccard = (a, b) => {
    const A = a.contents, B = b.contents;
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const s of A) if (B.has(s)) inter++;
    return inter / (A.size + B.size - inter);
};

const JAC_POS = 0.90, JAC_NEG = 0.50;
const positives = [], negatives = [], uncertain = [];
for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
        const a = books[i], b = books[j];
        const jac = jaccard(a, b);
        const d = hammingDistance(a.sig, b.sig);
        const sameName = baseName(a.name) !== '' && baseName(a.name) === baseName(b.name);
        const cj = contentJaccard(a, b);   // 🔬 精确裁判
        const pair = { a: a.name, b: b.name, d, jac, cj, sameName, ca: a.chars, cb: b.chars };
        if (jac >= JAC_POS) positives.push(pair);
        else if (jac < JAC_NEG) negatives.push(pair);
        else uncertain.push(pair);
    }
}

// 负样本可能极多 → 抽样（保分布形态，控运行时间）
const NEG_SAMPLE = FULL ? negatives.length : Math.min(negatives.length, 5000);
if (!FULL && negatives.length > NEG_SAMPLE) {
    // 均匀抽样（确定性：按步长取，避免随机导致结论不可复现）
    const stepN = negatives.length / NEG_SAMPLE;
    const sampled = [];
    for (let k = 0; k < NEG_SAMPLE; k++) sampled.push(negatives[Math.floor(k * stepN)]);
    negatives.length = 0;
    negatives.push(...sampled);
}

const stat = (arr) => {
    if (!arr.length) return null;
    const s = arr.map(x => x.d).sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], sorted: s };
};

console.log('═══ 距离分布 ═══');
const sp = stat(positives), sn = stat(negatives), su = stat(uncertain);
const fmt = (s) => s ? `n=${s.n}  min=${s.min}  p50=${s.p50}  p95=${s.p95}  max=${s.max}` : '（无样本）';
console.log(`正样本（keys Jaccard ≥ ${JAC_POS}）：${fmt(sp)}`);
console.log(`负样本（keys Jaccard < ${JAC_NEG}，${FULL ? '全量' : '抽样'}）：${fmt(sn)}`);
console.log(`待定区（${JAC_NEG} ≤ Jaccard < ${JAC_POS}，不参与判定）：${fmt(su)}`);

// 直方图（0~40，超出归入 40+）
const hist = new Array(41).fill(0);
for (const p of positives) hist[Math.min(40, p.d)]++;
const histNeg = new Array(41).fill(0);
for (const p of negatives) histNeg[Math.min(40, p.d)]++;
const histUnc = new Array(41).fill(0);
for (const p of uncertain) histUnc[Math.min(40, p.d)]++;
console.log('\n距离  正样本  负样本  待定');
for (let d = 0; d <= 40; d++) {
    if (!hist[d] && !histNeg[d] && !histUnc[d]) continue;
    const mark = d === SIMHASH_THRESHOLD ? '  ← T' : '';
    console.log(`${String(d).padStart(3)}  ${String(hist[d]).padStart(6)}  ${String(histNeg[d]).padStart(6)}  ${String(histUnc[d]).padStart(4)}${mark}`);
}

// ═══════════════════════════════════════════════════════════
// 判定：T=19 的误报 / 漏报
// ═══════════════════════════════════════════════════════════
console.log('\n═══ T=' + SIMHASH_THRESHOLD + ' 复核 ═══');
const fp = negatives.filter(p => p.d <= SIMHASH_THRESHOLD);   // 误报（假阳）
const fn = positives.filter(p => p.d > SIMHASH_THRESHOLD);    // 漏报（假阴）

// 🔬 用「词条 content 精确 Jaccard」当裁判：
//    · 精确相似度高 → **不是误报**，是 keys 基准漏了（改触发词的重复书）
//    · 精确相似度低 → **是真误报**
const CJ_SAME = 0.80;
const explain = (list, label) => {
    const real = list.filter(p => p.cj < CJ_SAME);
    const keysMiss = list.filter(p => p.cj >= CJ_SAME);
    console.log(`\n${label}：${list.length} 对`
        + `（其中 **真错 ${real.length}** ｜ **基准漏判 ${keysMiss.length}** —— 后者是改名/改触发词的重复书）`);
    for (const p of list.sort((x, y) => (label.startsWith('误报') ? x.d - y.d : y.d - x.d)).slice(0, 10)) {
        const verdict = p.cj >= CJ_SAME ? '✔真重复（基准漏）' : '✖真误判';
        console.log(`    d=${String(p.d).padStart(2)}  keysJ=${p.jac.toFixed(2)}  正文J=${p.cj.toFixed(2)}`
            + `  字数=${p.ca}/${p.cb}  ${verdict}`);
        console.log(`        ${p.a}`);
        console.log(`      × ${p.b}`);
    }
    return { real: real.length, keysMiss: keysMiss.length };
};
const fpR = explain(fp, `误报（无关对判成同组）`);
const fnR = explain(fn, `漏报（同源对没判出）`);

// 🔬 验证假设：误报是否集中在**短文本**（simhash 对短文本方差大）
if (fp.length) {
    const realFp = fp.filter(p => p.cj < CJ_SAME);
    if (realFp.length) {
        const shortSide = realFp.map(p => Math.min(p.ca, p.cb)).sort((a, b) => a - b);
        const med = shortSide[Math.floor(shortSide.length / 2)];
        console.log(`\n🔬 真误报的**较短一侧字数**：min=${shortSide[0]} 中位=${med} max=${shortSide[shortSide.length - 1]}`);
        const allChars = books.map(b => b.chars).sort((a, b) => a - b);
        console.log(`   全库字数分布：min=${allChars[0]} 中位=${allChars[Math.floor(allChars.length / 2)]} max=${allChars[allChars.length - 1]}`);
        console.log(`   ⇒ ${med < allChars[Math.floor(allChars.length / 2)] ? '✅ 误报确实集中在**短文本**（低于全库中位）' : '⚠️ 误报与字数无明显关系'}`);
    }
}

// 间隙分析：正样本 max 与负样本 min 之间
const gapLo = sp ? sp.max : null;
const gapHi = sn ? sn.min : null;
console.log('\n═══ 间隙分析 ═══');
if (gapLo !== null && gapHi !== null) {
    if (gapLo < gapHi) {
        const mid = Math.floor((gapLo + gapHi) / 2);
        console.log(`正样本 max=${gapLo} ｜ 负样本 min=${gapHi} → 间隙 ${gapHi - gapLo}，中点 T=${mid}`);
        console.log(`当前 T=${SIMHASH_THRESHOLD} → ${SIMHASH_THRESHOLD > gapLo && SIMHASH_THRESHOLD < gapHi ? '✅ 落在间隙内（最优区间）' : '⚠️ 不在间隙内，建议改 T=' + mid}`);
    } else {
        console.log(`⚠️ 正负分布**重叠**（正 max=${gapLo} ≥ 负 min=${gapHi}）→ 单一阈值无法完全分开`);
        console.log(`   建议：取 F1 最优点，或提高区分度（加大 step 会增方差，注意权衡）`);
    }
}

// ═══════════════════════════════════════════════════════════
// 退出码即结论
// ═══════════════════════════════════════════════════════════
const ok = fpR.real === 0 && fnR.real === 0;
console.log('\n' + (ok
    ? `✅ 复核通过：T=${SIMHASH_THRESHOLD} 无真误报 / 无真漏报`
        + `（另有 ${fpR.keysMiss} 对「keys 基准漏判的真重复」被 simhash 正确抓出 —— 这是**能力**不是缺陷）`
    : `❌ 复核未通过：真误报 ${fpR.real} 对 / 真漏报 ${fnR.real} 对（详见上表）`));
process.exit(ok ? 0 : 1);
