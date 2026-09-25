/**
 * 🧬 名字层（v4 §4）—— **形状规则 + 语料统计**，零案例字面量
 * ═══════════════════════════════════════════════════════════════
 * 规格出处：《查重引擎重构方案 v4》§4.1~4.5。
 *
 * 三层：
 *   ① `normName`         —— 比较/展示用规范化（NFKC → lower → 去空白标点符号）
 *   ② `extractNameStem`  —— 形状剥离（版本号 / 括号副本 / 时间戳 / 长数字 / 拉丁副本词形状）
 *   ③ `discoverTails`    —— **语料统计**：跨主干频次 ≥ K_tail 的尾缀自动登记为可剥离修饰词
 *      （评审微调 #1：**单字主干不参与尾缀剥离**——仅当剩余主干 ≥ 2 字符才允许登记/剥离）
 *
 * ⚠️ 本文件**不含任何具体卡名/书名/预设名**（守卫 `scripts/check-dedupe-literals.mjs`）。
 */

/** 比较 / 展示用规范化 */
export const normName = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// ── 形状规则（只描述“形状”，不枚举词汇） ─────────────────────────

/** 尾部副本形状：`(1)` / `（1）` / `_20250925` / `_2025092501` / ` copy2` / `_old` / `-bak` */
const REPLICA_SHAPES_TAIL = /(?:[_\- ]?(?:copy|backup|bak|old|new)(?:[_\-\d]+)?|\(\d+\)|（\d+）|[_\- ]?\d{4}[-_]?\d{2}[-_]?\d{2}(?:[t_\-]\d{1,6}z?)?|[_\-]\d{6,})$/i;

/**
 * 数字版本形状（token 边界，兼容 CJK 邻接）：`v1.0b` / `2.2` / `3.0-1`（数字前/后可直接接中文，如 `2.2版`）。
 * 用 lookbehind 避免把前导中文字符一起吃掉；仅剥离**数字段**，其后残留的语义词（如“版”）交给语料统计 `discoverTails`。
 */
const VERSION_SHAPE_G = /(?<=^|[\s\-_\u3400-\u9fff])v?\d+(?:[.\-]\d+)*[a-z]?(?=$|[\s\-_\u3400-\u9fff])/gi;

/** 分隔符（形状剥离后的折叠用） */
const SEPARATORS_G = /[\s\-_.,/\\()[\]{}（）「」【】『』—－]+/g;

/**
 * 形状剥离：得 `stem0`（未过语料检验）与被剥片段列表。
 * 仅做**形状**识别——语义修饰词（各类“XX版”后缀等）一律留给 `discoverTails` 语料统计决定。
 */
export const extractNameStem = (rawName) => {
    let s = String(rawName == null ? '' : rawName).normalize('NFKC').trim();
    const stripped = [];
    if (!s) return { stem0: '', stripped };

    // 形状①：尾部副本/时间戳/长数字（迭代，最多 3 轮，防“_2024-01-02-copy”类叠加）
    for (let round = 0; round < 3; round++) {
        const before = s;
        s = s.replace(REPLICA_SHAPES_TAIL, (m) => { stripped.push(m); return ' '; });
        if (s === before) break;
    }
    // 形状②：数字版本（任意位置，token 边界）
    s = s.replace(VERSION_SHAPE_G, (m) => { stripped.push(m); return ' '; });

    const stem0 = s.replace(SEPARATORS_G, '').toLowerCase();
    return { stem0, stripped };
};

// ── 语料统计（数据驱动发现“可剥离修饰词”） ─────────────────────

const isCJK = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
const isLatinNum = (ch) => /[a-z0-9]/i.test(ch);

/**
 * 尾缀候选：从 `stem0` 末尾切 “中文 1~4 字” 或 “末尾拉丁/数字连续段（≤12）”。
 * 仅返回 **主干长度 ≥ 2**（评审微调 #1：单字主干保护）的候选。
 * @returns {Array<[head:string, tail:string]>}
 */
export const tailCandidates = (stem0) => {
    const out = [];
    const s = String(stem0 || '');
    if (s.length < 3) return out; // 主干至少 2 + 尾缀至少 1

    // 拉丁/数字 run
    let i = s.length - 1;
    while (i >= 0 && isLatinNum(s[i])) i--;
    const tailLat = s.slice(i + 1);
    if (tailLat.length >= 2 && tailLat.length <= 12 && i + 1 >= 2) {
        out.push([s.slice(0, i + 1), tailLat]);
    }

    // 中文后缀（长度 1~4）
    const maxK = Math.min(4, s.length - 2);
    for (let k = 1; k <= maxK; k++) {
        const tail = s.slice(s.length - k);
        if (![...tail].every(isCJK)) break;
        out.push([s.slice(0, s.length - k), tail]);
    }
    return out;
};

/**
 * 语料统计：对全库名字（三库合流）统计“尾缀 → 不同主干集合”。
 * 某尾缀的跨主干频次 ≥ K_tail ⇒ 判为**本库可剥离修饰词**（运行时从当前库发现，不落盘、不写死）。
 * @param {string[]} names
 * @param {{K_tail?:number}} [opts]
 * @returns {Set<string>} 可剥离尾缀集合
 */
export const discoverTails = (names, { K_tail = 3 } = {}) => {
    const vote = new Map(); // tail -> Set<head>
    for (const name of names || []) {
        const { stem0 } = extractNameStem(name);
        if (!stem0) continue;
        for (const [head, tail] of tailCandidates(stem0)) {
            if (!head || head.length < 2) continue; // 单字主干保护
            let set = vote.get(tail);
            if (!set) { set = new Set(); vote.set(tail, set); }
            set.add(head);
        }
    }
    const out = new Set();
    for (const [tail, heads] of vote) {
        if (heads.size >= K_tail) out.add(tail);
    }
    return out;
};

/**
 * 应用语料结论：stem0 → stemFinal（剥离**最长**的已登记尾缀；无则原样）。
 * @returns {{ stemFinal:string, tail:string|null }}
 */
export const applyTails = (stem0, tails) => {
    const s = String(stem0 || '');
    if (!s || !tails || tails.size === 0) return { stemFinal: s, tail: null };
    for (let k = Math.min(4, s.length - 2); k >= 1; k--) {
        const tail = s.slice(s.length - k);
        if (tails.has(tail) && s.length - k >= 2) return { stemFinal: s.slice(0, s.length - k), tail };
    }
    // 拉丁尾缀（整 run）
    for (const [head, tail] of tailCandidates(s)) {
        if (tails.has(tail)) return { stemFinal: head, tail };
    }
    return { stemFinal: s, tail: null };
};

// ── 相似度（仅候选与展示用；绝不单独决定分组/清理） ─────────────

/** 最长公共子串长度（滚动数组 O(min) 空间） */
export const lcsLen = (a, b) => {
    if (!a || !b) return 0;
    const dp = new Uint16Array(b.length + 1);
    let best = 0;
    for (let i = 1; i <= a.length; i++) {
        let prev = 0;
        for (let j = 1; j <= b.length; j++) {
            const t = dp[j];
            dp[j] = (a[i - 1] === b[j - 1]) ? prev + 1 : 0;
            if (dp[j] > best) best = dp[j];
            prev = t;
        }
    }
    return best;
};

/**
 * 名字相似度（规范化名 LCS / 较短长度；互相包含 = 1）。
 * @returns {number|null} null = 任一方为空（无法判定就不否决 —— AR-48 同精神）
 */
export const nameSimRaw = (a, b) => {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return null;
    if (na.includes(nb) || nb.includes(na)) return 1;
    return lcsLen(na, nb) / Math.min(na.length, nb.length);
};

/** 精确同名（规范化后相等；用于同名家族通道） */
export const sameName = (a, b) => {
    const na = normName(a);
    const nb = normName(b);
    return !!na && na === nb;
};
