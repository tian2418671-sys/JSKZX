/**
 * 🧾 角色卡查重「双口径」实证门禁（DF-23 的必要配套取证）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📖 **为什么需要这个探针**（它同时是「定阈值的依据」和「长期门禁」）
 * ───────────────────────────────────────────────────────────────
 * DF-23 把 `character_book` 等字段纳入角色卡查重后，**必然**引出两个配套问题
 * （实测踩到，不是理论推演）：
 *
 *   ① **AR-48 阈值作废 → 误报**
 *      文本量级 ×26（真实卡实测 4,872 → 129,918 字符）⇒ **simhash 距离整体压缩**：
 *        无关对：30 → **20~23**（落进 `NAME_ONLY_MAX_DIST = 24` 内！）
 *      而真实 4-gram Jaccard 仅 **1.6%**（确认「确实无关」）。
 *      ⇒ 若不处理，会凭空产生误报（PK-29 同型病：**口径一变，阈值必须重标**）。
 *      ✅ 修法：`_nameOnly` 防护**刻意保留 5 字段口径**（`extractLegacyCardText`），保住 T=24。
 *
 *   ② **稀释 → 漏报**
 *      `鬼.png` ↔ `鬼1.png`（**真实同源改版**）：5 字段 100% → **全字段 67.7%**
 *      （< `CONTENT_SIMILARITY_THRESHOLD = 0.85` 闸门）⇒ 只看全字段会**漏报真实同源版本**。
 *      ✅ 修法：聚类闸门改**双口径 OR**（`全字段 ≥0.85 或 5 字段 ≥0.85`）。
 *
 * ⚠️ 两个修法**必须配对**：只改一个就会引入误报或漏报。
 *    本探针逐对输出「单口径 / 双口径 OR / 真值」的判定，**任何不一致都要警觉**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔁 **长期门禁用法**（改角色卡查重字段或阈值后必跑）
 * ───────────────────────────────────────────────────────────────
 *   node scripts/probes/_probe-card-legacy-vs-full.mjs "<卡1>" "<卡2>" ["<卡3>" …]
 *
 * ⚠️ 本探针**逐字复刻** `useDedupe.js` 的以下实现（口径必须一致，改生产代码后要同步这里）：
 *   · `extractContentText` 的角色卡分支（全字段）
 *   · `extractLegacyCardText`（5 字段，AR-48 专用）
 *   · `computeMinHash` / `hashString` / `estimateSimilarity`（PK-30 的 FNV-1a + 雪崩混合）
 *   · `CONTENT_SIMILARITY_THRESHOLD`
 *
 * 📌 真实库未挂载时的替代样本（本机）：
 *   `D:\TkDmGzq\GUI\示例\鬼\鬼.png`、`鬼1.png`、`D:\TkDmGzq\GUI\示例\角色卡示例\角色卡示例.png`、`头像.png`
 */
import fs from 'node:fs';
import { parsePNGChunk } from '../../js/utils/pngParser.js';
import { extractBookEntries } from '../../js/utils/cardLoader.js';

// ══════════════════════════════════════════════════════════════
// 与生产代码**同口径**的实现（改生产代码后必须同步）
// ══════════════════════════════════════════════════════════════
const CONTENT_SIMILARITY_THRESHOLD = 0.85;   // = useDedupe.js 的同名常量
const MINHASH_HASHES = 96;

const minhashSeeds = (() => {
    const seeds = [];
    let s = 0x9e3779b9;
    for (let i = 0; i < MINHASH_HASHES; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; seeds.push(s); }
    return seeds;
})();

/** 🛑 PK-30：不能退回 `h * 31 + c`（对定长 shingle 会结构性退化） */
const hashString = (str, seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
};
const computeMinHash = (shingles) => {
    const sig = new Array(MINHASH_HASHES).fill(0x7fffffff);
    shingles.forEach((sh) => {
        for (let i = 0; i < MINHASH_HASHES; i++) {
            const h = hashString(sh, minhashSeeds[i]);
            if (h < sig[i]) sig[i] = h;
        }
    });
    return sig;
};
const estimateSimilarity = (a, b) => {
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    return same / a.length;
};
const getShingles = (text) => {
    const set = new Set();
    for (let i = 0; i + 4 <= text.length; i++) set.add(text.slice(i, i + 4));
    return set;
};
const normalizeText = (t) => String(t || '')
    .replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();

/** 📏 真实 4-gram Jaccard（**作为「真值」**，用于校验 MinHash 估计是否可信） */
const trueJaccard = (A, B) => {
    if (A.size + B.size === 0) return null;
    let inter = 0;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    for (const x of small) if (big.has(x)) inter++;
    return inter / (A.size + B.size - inter);
};

// ── 两种提取口径（与 useDedupe.js 逐字一致）──
/** 全字段（含 `character_book` / 备用问候 / 作者备注）—— DF-23 修复后的口径 */
const extractFullText = (item) => {
    const d = item.data?.data || item.data || {};
    const parts = [d.description, d.personality, d.scenario, d.first_mes, d.mes_example];
    if (Array.isArray(d.alternate_greetings)) parts.push(...d.alternate_greetings);
    parts.push(d.creator_notes, d.system_prompt, d.post_history_instructions);
    for (const e of extractBookEntries(d.character_book)) {
        if (!e || typeof e !== 'object') continue;
        const keys = Array.isArray(e.keys) ? e.keys.join(',') : (e.keys || e.key || '');
        parts.push(`${keys} ${e.content || ''}`);
    }
    return parts.filter(Boolean).join('\n');
};
/** 5 字段（**AR-48 `_nameOnly` 防护专用**，刻意保留以保住已标定的 T=24） */
const extractLegacyText = (item) => {
    const d = item.data?.data || item.data || {};
    return [d.description, d.personality, d.scenario, d.first_mes, d.mes_example]
        .filter(Boolean).join('\n');
};

// ══════════════════════════════════════════════════════════════
// 加载真实卡
// ══════════════════════════════════════════════════════════════
const files = process.argv.slice(2);
if (files.length < 2) {
    console.error('用法：node scripts/probes/_probe-card-legacy-vs-full.mjs "<卡1>" "<卡2>" ["<卡3>" …]');
    console.error('需要 ≥ 2 张卡（否则没有可比对的对）。');
    process.exit(1);
}

const cards = [];
for (const f of files) {
    let raw = null;
    try {
        const buf = fs.readFileSync(f);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        raw = parsePNGChunk(ab);
    } catch (e) { console.log(`⚠️ 解析失败 ${f}：${e.message}`); continue; }
    if (!raw) { console.log(`⚠️ 非有效角色卡（解析为 null）：${f}`); continue; }
    const item = { data: raw.data || raw };
    const full = normalizeText(extractFullText(item));
    const leg = normalizeText(extractLegacyText(item));
    const ents = extractBookEntries((item.data.data || item.data || {}).character_book);
    cards.push({
        file: f.split(/[\\/]/).pop(),
        name: (item.data.data || item.data || {}).name || '(无名)',
        bookCount: ents.length,
        fullLen: full.length,
        legLen: leg.length,
        fullJ: getShingles(full),
        legJ: getShingles(leg),
        fullSig: full.length >= 20 ? computeMinHash(getShingles(full)) : null,
        legSig: leg.length >= 20 ? computeMinHash(getShingles(leg)) : null
    });
}

if (cards.length < 2) {
    console.error(`\n❌ 只成功加载 ${cards.length} 张卡，无法比对（需要 ≥ 2）。`);
    process.exit(1);
}

console.log('═════ 加载的卡 ═════');
for (const c of cards) {
    console.log(`  ${c.file.padEnd(20)} name="${c.name}"  世界书 ${String(c.bookCount).padStart(3)} 条`
        + `  ｜ 5字段 ${String(c.legLen).padStart(6)} 字符 ｜ 全字段 ${String(c.fullLen).padStart(7)} 字符`
        + ` (×${(c.fullLen / Math.max(c.legLen, 1)).toFixed(1)})`);
}

// ══════════════════════════════════════════════════════════════
// 逐对判定：单口径 vs 双口径 OR vs 真值
// ══════════════════════════════════════════════════════════════
console.log('\n═════ 逐对判定（T=0.85）═════');
console.log('  真值 = 「全字段 Jaccard ≥0.5 或 5字段 Jaccard ≥0.5」（人工语义上的同源）\n');

let agree = 0, total = 0, singleMiss = 0, dualWrong = 0;
for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
        const A = cards[i], B = cards[j];
        const fullMh = (A.fullSig && B.fullSig) ? estimateSimilarity(A.fullSig, B.fullSig) : null;
        const legMh = (A.legSig && B.legSig) ? estimateSimilarity(A.legSig, B.legSig) : null;
        const fullTrue = trueJaccard(A.fullJ, B.fullJ);
        const legTrue = trueJaccard(A.legJ, B.legJ);

        const single = fullMh !== null && fullMh >= CONTENT_SIMILARITY_THRESHOLD;
        const dual = (fullMh !== null && fullMh >= CONTENT_SIMILARITY_THRESHOLD)
            || (legMh !== null && legMh >= CONTENT_SIMILARITY_THRESHOLD);
        const truth = (fullTrue !== null && fullTrue >= 0.5) || (legTrue !== null && legTrue >= 0.5);

        total++;
        if (dual === truth) agree++; else dualWrong++;
        if (single !== truth) singleMiss++;

        const p = (v) => (v === null ? '  n/a' : (v * 100).toFixed(1).padStart(5) + '%');
        const mark = (ok) => (ok ? '✅' : '❌');
        console.log(`  ${A.file.slice(0, 16).padEnd(17)} ↔ ${B.file.slice(0, 16).padEnd(17)}`);
        console.log(`      全字段 MinHash ${p(fullMh)}（真 ${p(fullTrue)}）  5字段 MinHash ${p(legMh)}（真 ${p(legTrue)}）`);
        console.log(`      单口径 ${single ? '同源' : '无关'} ${mark(single === truth)}  ｜ 双口径OR ${dual ? '同源' : '无关'} ${mark(dual === truth)}  ｜ 真值 ${truth ? '同源' : '无关'}`);
        // ⚠️ 单口径漏报「真实同源」→ 正是必须加 OR 的原因
        if (single !== truth && truth) {
            console.log(`      🛑 **单口径漏报**：全字段被稀释到闸门之下（${p(fullMh)} < ${CONTENT_SIMILARITY_THRESHOLD}），`
                + `而 5 字段 ${p(legMh)} ⇒ 必须靠 OR 兜住`);
        }
        if (dual !== truth) {
            console.log(`      🛑🛑 **双口径判定与真值不一致** —— 需人工复核（可能是阈值或真值口径问题）`);
        }
    }
}

// ══════════════════════════════════════════════════════════════
// 结论
// ══════════════════════════════════════════════════════════════
console.log('\n═════ 结论 ═════');
console.log(`  双口径 OR 与真值一致：${agree}/${total}${agree === total ? ' ✅' : ' ❌'}`);
console.log(`  单口径（只看全字段）与真值不一致：${singleMiss}/${total}`
    + `${singleMiss > 0 ? ' ⇒ **单口径会漏报/误报**，OR 是必需的' : ''}`);
if (dualWrong > 0) {
    console.log(`  ⚠️ 双口径仍有 ${dualWrong} 对与真值不一致 —— 请人工核对后再调阈值。`);
}
console.log('\n  📌 记法：');
console.log('     · 同名防护（`_nameOnly`）必须用 **5 字段**（保住 AR-48 真实库 3907 张标定的 T=24）；');
console.log('     · 聚类闸门必须用 **双口径 OR**（同时覆盖「仅世界书不同」与「正文版本迭代」）；');
console.log('     · 两者**必须配对**：只改一个 → 误报（用全字段判同名）或漏报（只用全字段判同组）。');
process.exit(dualWrong > 0 ? 1 : 0);
