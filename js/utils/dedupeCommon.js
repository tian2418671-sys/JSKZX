/**
 * 🧩 查重通用工具（纯函数）—— v4 实现（P1）
 * ═══════════════════════════════════════════════════════════════
 * 规格出处：《查重引擎重构方案 v4》§5.1（指纹）/ §3.1（文本提取）/ §13（常量）。
 *
 * 设计约束（评审必查）：
 *   · 本文件**零案例字面量**（无卡名/书名/预设名/词表）——由 `scripts/check-dedupe-literals.mjs` 守卫；
 *   · 全部函数为纯函数（无副作用、无 IO），单测覆盖：`test/dedupeCommon.test.mjs`；
 *   · `MINHASH_SEEDS` 为**硬编码常量数组**（评审微调 #2）：不在运行时动态生成，保证跨进程 / 跨轮次幂等。
 */

// ═══════════════════════════════════════════════════════════════
// 哈希
// ═══════════════════════════════════════════════════════════════

/** FNV-1a 32 位（与 main.js 同款常量；种子可换） */
export const fnv1a32 = (str, seed = 0x811c9dc5) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
};

/**
 * 内容指纹键（L0「完全相同」直通）；**不是相似度**。
 * 双 32 位 FNV-1a 流（第二流用不同素数 0x85ebca6b），碰撞概率 ≈ 2⁻⁶⁴。
 */
export const exactTextKey = (str) => {
    let a = 0x811c9dc5, b = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
};

// ═══════════════════════════════════════════════════════════════
// MinHash-96（内容轨指纹）
// ═══════════════════════════════════════════════════════════════

/**
 * 96 个独立哈希族种子（硬编码常量；生成于 2026-09-25，生成式 `fnv1a32('seed_salt_pk30_' + i)`）。
 * ⚠️ 修改本数组 = 变更指纹口径 ⇒ 必须同步更新全部标定与测试。
 */
export const MINHASH_SEEDS = new Uint32Array([
    0x22a25cd7, 0x21a25b44, 0x24a25ffd, 0x23a25e6a, 0x1ea2568b, 0x1da254f8, 0x20a259b1, 0x1fa2581e,
    0x1aa2503f, 0x19a24eac, 0x6695f79c, 0x6795f92f, 0x6895fac2, 0x6995fc55, 0x6295f150, 0x6395f2e3,
    0x6495f476, 0x6595f609, 0x6e960434, 0x6f9605c7, 0x789ccfb7, 0x779cce24, 0x7a9cd2dd, 0x799cd14a,
    0x749cc96b, 0x739cc7d8, 0x769ccc91, 0x759ccafe, 0x709cc31f, 0x6f9cc18c, 0x729a87ae, 0x739a8941,
    0x709a8488, 0x719a861b, 0x769a8dfa, 0x779a8f8d, 0x749a8ad4, 0x759a8c67, 0x6a9a7b16, 0x6b9a7ca9,
    0xf48e8861, 0xf38e86ce, 0xf28e853b, 0xf18e83a8, 0xf88e8ead, 0xf78e8d1a, 0xf68e8b87, 0xf58e89f4,
    0xec8e7bc9, 0xeb8e7a36, 0x6e8b76d8, 0x6f8b786b, 0x708b79fe, 0x718b7b91, 0x728b7d24, 0x738b7eb7,
    0x748b804a, 0x758b81dd, 0x668b6a40, 0x678b6bd3, 0xe092e613, 0xdf92e480, 0xe292e939, 0xe192e7a6,
    0xe492ec5f, 0xe392eacc, 0xe692ef85, 0xe592edf2, 0xe892f2ab, 0xe792f118, 0xfa90d06a, 0xfb90d1fd,
    0xf890cd44, 0xf990ced7, 0xf690ca1e, 0xf790cbb1, 0xf490c6f8, 0xf590c88b, 0xf290c3d2, 0xf390c565,
    0xfc84079d, 0xfb84060a, 0xfa840477, 0xf98402e4, 0xf8840151, 0xf783ffbe, 0xf683fe2b, 0xf583fc98,
    0xf483fb05, 0xf383f972, 0xf681bf94, 0xf781c127, 0xf881c2ba, 0xf981c44d, 0xf281b948, 0xf381badb,
]);

const MINHASH_DIM = 96;
const SHINGLE_N = 4;
const SAMPLE_STEP = 4;

/** 归一化（保字符序）：NFC → lower → 空白标点折叠为空格 */
const normForMinHash = (text) => String(text).normalize('NFC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

/**
 * 96 维 MinHash 签名（内容轨）。
 * 口径（v4 §5.1，2026-09-25 校准修正）：4-gram shingle → **确定性哈希采样**（仅保留 `hash%4===0`）
 * → 96 种子取 min（异或 + 雪崩混洗）。
 *
 * ⚠️ 采样方式说明：曾用「Set 去重 → 排序 → step=4 等距抽样」，实测**同源微改文本 J≈0.04**
 * （两侧集合任何微小差异都会让排序序列整段错位 → 抽样子集几乎不相交），已修正为
 * **只取决于 shingle 自身哈希**的采样（与集合顺序/规模无关，估计无偏）。
 * @returns {Uint32Array} 96 维签名；空/过短文本返回全 0xffffffff（由 `estimateMinHashSimilarity` 视为无效）
 */
export function computeMinHash96(text) {
    const sig = new Uint32Array(MINHASH_DIM).fill(0xffffffff);
    if (!text || typeof text !== 'string') return sig;
    const clean = normForMinHash(text);
    if (clean.length < SHINGLE_N) return sig;

    const samples = new Set();
    for (let i = 0; i + SHINGLE_N <= clean.length; i++) {
        const h = fnv1a32(clean.slice(i, i + SHINGLE_N));
        if (h % SAMPLE_STEP === 0) samples.add(h);
    }
    if (samples.size === 0) {
        // 兜底：极短文本无采样命中 → 全量（避免签名全 FF 被误判为无效）
        for (let i = 0; i + SHINGLE_N <= clean.length; i++) samples.add(fnv1a32(clean.slice(i, i + SHINGLE_N)));
    }

    for (const baseH of samples) {
        for (let s = 0; s < MINHASH_DIM; s++) {
            let h = (baseH ^ MINHASH_SEEDS[s]) >>> 0;
            h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
            h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
            h = (h ^ (h >>> 16)) >>> 0;
            if (h < sig[s]) sig[s] = h;
        }
    }
    return sig;
}

const isAllFF = (sig) => {
    if (!sig || sig.length !== MINHASH_DIM) return true;
    for (let i = 0; i < MINHASH_DIM; i++) if (sig[i] !== 0xffffffff) return false;
    return true;
};

/**
 * MinHash 相似度（96 维匹配率）。
 * @returns {number|null} null = 任一方无有效签名（**不得静默当 0**）
 */
export const estimateMinHashSimilarity = (a, b) => {
    if (!a || !b || a.length !== MINHASH_DIM || b.length !== MINHASH_DIM) return null;
    if (isAllFF(a) || isAllFF(b)) return null;
    let m = 0;
    for (let i = 0; i < MINHASH_DIM; i++) if (a[i] === b[i]) m++;
    return m / MINHASH_DIM;
};

// ═══════════════════════════════════════════════════════════════
// 触发词（keys）指纹
// ═══════════════════════════════════════════════════════════════

/** 触发词规范化（**全库唯一口径**，与 main.js `normalizeWbKey` 等价） */
export const normKey = (s) => String(s).trim().toLowerCase().normalize('NFC');

/**
 * keys → 升序去重 Uint32Array（bottom-k 预截断，cap 默认 2000 —— 与 main.js 一致）。
 * @returns {Uint32Array}
 */
export const keysToHashes = (keys, cap = 2000) => {
    const set = new Set();
    for (const k of keys || []) {
        const s = normKey(k);
        if (s) set.add(fnv1a32(s));
    }
    const arr = Array.from(set).sort((x, y) => x - y);
    return new Uint32Array(arr.length > cap ? arr.slice(0, cap) : arr);
};

/**
 * 两个**升序去重** Uint32Array 的精确 Jaccard（双指针归并）。
 * @returns {number|null} null = 任一方为空（**缺索引语义，不得静默当 0**）
 */
export const keysJaccard = (a, b) => {
    if (!a || !b || a.length === 0 || b.length === 0) return null;
    let i = 0, j = 0, inter = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { inter++; i++; j++; }
        else if (a[i] < b[j]) i++;
        else j++;
    }
    const uni = a.length + b.length - inter;
    return uni ? inter / uni : null;
};

// ═══════════════════════════════════════════════════════════════
// 三库数据解构 / 文本提取（DF-17 / DF-19 全形态）
// ═══════════════════════════════════════════════════════════════

/** 角色卡数据解构（DF-17 口径：`item.data?.data || item.data`） */
export const cardDataOf = (item) => {
    if (!item || typeof item !== 'object') return null;
    const d = item.data;
    if (!d || typeof d !== 'object') return null;
    return (d.data && typeof d.data === 'object') ? d.data : d;
};

/** 角色卡全字段池（v4 §3.1；含内嵌世界书正文，entries 数组/字典双形态） */
export const CARD_FIELD_KEYS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'];
export const extractCardFullText = (data) => {
    if (!data || typeof data !== 'object') return '';
    const parts = [];
    for (const k of CARD_FIELD_KEYS) {
        const v = data[k];
        if (typeof v === 'string' && v) parts.push(v);
    }
    const greetings = data.alternate_greetings;
    if (Array.isArray(greetings)) {
        for (const g of greetings) if (typeof g === 'string' && g) parts.push(g);
    }
    const cb = data.character_book || data.characterBook;
    const rawEntries = cb && cb.entries ? cb.entries : null;
    const entries = Array.isArray(rawEntries) ? rawEntries : (rawEntries && typeof rawEntries === 'object' ? Object.values(rawEntries) : []);
    for (const e of entries) {
        if (e && typeof e === 'object' && typeof e.content === 'string' && e.content) parts.push(e.content);
    }
    return parts.join('\n');
};

/** 角色卡核心 5 字段文本（coreSig 的输入；与历史口径一致） */
export const extractCardCoreText = (data) => {
    if (!data || typeof data !== 'object') return '';
    return ['description', 'personality', 'scenario', 'first_mes', 'mes_example']
        .map((k) => (typeof data[k] === 'string' ? data[k] : '')).filter(Boolean).join('\n');
};

/** 内嵌世界书词条数组（数组/字典双形态） */
export const cardBookEntries = (data) => {
    if (!data || typeof data !== 'object') return [];
    const cb = data.character_book || data.characterBook;
    const raw = cb && cb.entries ? cb.entries : null;
    return Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
};

/** 内嵌世界书触发词（`key` 与 `keys` **全形态**都读 —— DF-19 教训） */
export const extractCardKeys = (data) => {
    const keys = [];
    for (const e of cardBookEntries(data)) {
        if (!e || typeof e !== 'object') continue;
        const k1 = Array.isArray(e.key) ? e.key : (e.key !== undefined && e.key !== null ? [e.key] : []);
        const k2 = Array.isArray(e.keys) ? e.keys : (e.keys !== undefined && e.keys !== null ? [e.keys] : []);
        for (const k of k1.concat(k2)) {
            if (k === undefined || k === null) continue;
            const s = String(k).trim();
            if (s) keys.push(s);
        }
    }
    return keys;
};

/** 预设 prompts（数组 / 字典双形态） */
export const promptsOf = (data) => {
    const p = data && data.prompts;
    if (!p) return [];
    return Array.isArray(p) ? p : (typeof p === 'object' ? Object.values(p) : []);
};
export const countPrompts = (data) => promptsOf(data).length;
export const extractPresetText = (data) => promptsOf(data)
    .map((p) => (p && typeof p.content === 'string' ? p.content : '')).filter(Boolean).join('\n');
