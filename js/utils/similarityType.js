/**
 * 🏷️ 世界书查重 —— **相似类型判定**（纯函数，无副作用）
 *
 * 背景（2026-09-23 用户提出、经评估采纳）：
 *   现有内容级查重只给一个「相似度 %」，用户无法据此判断**该怎么处理**。
 *   而酒馆世界书的相似有明确语义类型 —— 不同类型的处理方式完全不同：
 *
 *   | 类型 | keys | content | 用户该做什么 |
 *   |---|---|---|---|
 *   | 完全重复 | — | 指纹一致 | ✅ 可安全清理 |
 *   | 触发重复 | 高 | 低 | ⚠️ 触发条件撞车 → 合并 keys 或改触发词，**别删** |
 *   | 内容可合并 | 低 | 高 | 🔀 内容重复但触发条件不同 → 合并为一本 |
 *   | 设定冲突 | 同 | 冲突 | 🚨 **需人工裁决**，两版设定矛盾 |
 *   | 高度相似 | 中 | 中 | 🔍 逐条对比后再决定 |
 *
 * 📌 为什么这些数据**已经在手**（零额外成本）：
 *   · keys 相似度 → L1a `keyHashes`（`main.js:1100` 已落盘）
 *   · content 相似度 → 查重时已算的 MinHash 估计值
 *   · 完全相同 → `exactContentHash`（`main.js:1296` 已落盘）
 *   · 长度 → 查重时已算的 `textLen`
 *   ⇒ 本模块只做**组合与判定**，不引入任何新计算、不读盘。
 *
 * ⚠️ 阈值说明（**未标定，属启发式**，见 §阈值）：
 *   下面所有阈值都是**结构性的**（如「高」「低」的分界），不参与相似度打分。
 *   它们决定的是**标签**（给用户看），不是**分组**（决定删不删）。
 *   分组仍由 PK-29 修复后的「simhash 预筛 + MinHash 复核 + 簇心校验」负责 ——
 *   本模块**绝不参与「是否同一组」的判定**，避免引入新的误删风险。
 */

/** keys 相似度分档（Dice / Jaccard 的 0~1 值） */
export const KEYS_HIGH = 0.5;    // ≥ 视为「触发条件高度重合」
export const KEYS_LOW = 0.15;    // < 视为「触发条件基本无关」
/** content 相似度分档 */
export const CONTENT_HIGH = 0.85; // ≥ 视为「内容高度重合」（与查重复核闸门同口径）
export const CONTENT_LOW = 0.5;   // < 视为「内容明显不同」

/** 相似类型枚举（值即展示用短标签） */
export const SIM_TYPE = {
    EXACT: 'exact',           // 完全重复（指纹一致）
    TRIGGER_ONLY: 'trigger',  // 触发重复（keys 高 / content 低）
    MERGEABLE: 'merge',       // 内容可合并（content 高 / keys 低）
    CONFLICT: 'conflict',     // 设定冲突（keys 高 / content 低且长度悬殊）
    SIMILAR: 'similar',       // 高度相似（其余）
    DIFFERENT: 'different'    // 仅名称相同（内容无关）
};

/** 类型 → 展示元数据（标签 / 配色 / 建议动作） */
export const SIM_TYPE_META = {
    [SIM_TYPE.EXACT]: {
        label: '🔁 完全重复', tone: 'emerald',
        advice: '内容指纹完全一致，可安全清理'
    },
    [SIM_TYPE.TRIGGER_ONLY]: {
        label: '🔑 触发重复', tone: 'amber',
        advice: '触发条件撞车但内容不同 —— 建议合并触发词或改写，**不要直接删**'
    },
    [SIM_TYPE.MERGEABLE]: {
        label: '🔀 内容可合并', tone: 'blue',
        advice: '内容高度重合但触发条件不同 —— 可合并为一本'
    },
    [SIM_TYPE.CONFLICT]: {
        label: '🚨 设定冲突', tone: 'rose',
        advice: '触发条件相同但内容明显矛盾 —— **需人工裁决**，勿自动清理'
    },
    [SIM_TYPE.SIMILAR]: {
        label: '🔍 高度相似', tone: 'purple',
        advice: '内容相似但有差异 —— 建议逐条对比后再决定'
    },
    [SIM_TYPE.DIFFERENT]: {
        label: '⚠️ 仅名称相同', tone: 'rose',
        advice: '内容基本无关，很可能是不同的世界书 —— **请勿清理**'
    }
};

/**
 * 📏 长度惩罚：`0.7 + 0.3 × min/max`（方案 §3.4）
 *
 * 为什么需要它：短文本的相似度**天然虚高** —— 两本各 3 条词条的书，
 * 只要共享 2 条触发词，Jaccard 就可能 0.6+，但「相似」毫无信息量。
 * 惩罚让「长度悬殊」的对比降权，避免「短书 vs 巨著」被误判为高度相似。
 *
 * ⚠️ 下限 0.7（而非 0）—— 惩罚是**降权**不是**否决**：
 *   长度悬殊也可能真的是同一本的删减版（真实库有 83727 vs 270615 的实例）。
 *
 * @param {number} lenA @param {number} lenB 两侧内容长度（字符）
 * @returns {number} 0.7 ~ 1.0
 */
export function lengthPenalty(lenA, lenB) {
    const a = Number(lenA) || 0;
    const b = Number(lenB) || 0;
    if (a <= 0 || b <= 0) return 0.7;          // 长度未知 → 取最保守值
    return 0.7 + 0.3 * (Math.min(a, b) / Math.max(a, b));
}

/**
 * 🏷️ 判定相似类型（**只产出标签，不决定分组**）
 *
 * @param {object} p
 * @param {number|null} p.keysSim    keys 相似度 0~1（`compareKeyHashes().jaccard`；无索引传 null）
 * @param {number|null} p.contentSim 内容相似度 0~1（MinHash 估计；未知传 null）
 * @param {boolean} [p.exactSame]    内容指纹是否完全一致（`exactContentHash`）
 * @param {number} [p.lenA] @param {number} [p.lenB] 两侧内容长度（用于长度惩罚与冲突判定）
 * @returns {{type:string, label:string, tone:string, advice:string, penalty:number, score:number|null}}
 *   `score` = 长度惩罚后的综合分（**仅供展示排序**，不用于阈值判定）
 */
export function classifySimilarity({ keysSim, contentSim, exactSame, lenA, lenB } = {}) {
    const penalty = lengthPenalty(lenA, lenB);
    const k = (typeof keysSim === 'number' && Number.isFinite(keysSim)) ? keysSim : null;
    const c = (typeof contentSim === 'number' && Number.isFinite(contentSim)) ? contentSim : null;

    // 综合分（展示用）：内容为主、keys 次之，再乘长度惩罚
    const score = (c === null && k === null) ? null
        : penalty * ((c === null ? 0 : c) * 0.75 + (k === null ? 0 : k) * 0.25);

    let type;
    if (exactSame) {
        type = SIM_TYPE.EXACT;
    } else if (c !== null && k !== null) {
        const kHigh = k >= KEYS_HIGH;
        const kLow = k < KEYS_LOW;
        const cHigh = c >= CONTENT_HIGH;
        const cLow = c < CONTENT_LOW;

        if (kHigh && cLow) {
            // 触发条件重合但内容明显不同：
            //   · 长度相近 → 「触发重复」（可能只是写法不同）
            //   · 长度悬殊 → 「设定冲突」（一版被大改，触发词却没变 —— 最危险，易误删）
            const ratio = (Number(lenA) > 0 && Number(lenB) > 0)
                ? Math.min(lenA, lenB) / Math.max(lenA, lenB) : 1;
            type = ratio < 0.5 ? SIM_TYPE.CONFLICT : SIM_TYPE.TRIGGER_ONLY;
        } else if (cHigh && kLow) {
            type = SIM_TYPE.MERGEABLE;
        } else if (kLow && cLow) {
            // 🛑 两侧都低 → **无关**。
            //    ⚠️ 这一支最初漏了（实测踩到）：漏掉后 `keys=0, content=0` 会落进
            //       下面的 `else` 被误判成「高度相似」—— 完全反向的结论，
            //       而弹窗还会给出「保留此版，清理其余」⇒ 可一键误删。
            //       这正是 PK-29/AR-48 同型的「反向结论最危险」。
            type = SIM_TYPE.DIFFERENT;
        } else {
            // 其余（如 keys 高 + content 高但指纹不同 / 中间值）→ 高度相似，需逐条对比
            type = SIM_TYPE.SIMILAR;
        }
    } else if (c !== null) {
        // 只有内容相似度（无 keys 索引，如 oversized 书）
        if (c < CONTENT_LOW) type = SIM_TYPE.DIFFERENT;
        else type = SIM_TYPE.SIMILAR;
    } else if (k !== null) {
        // 只有 keys 相似度（内容过短或读取失败）
        type = k < KEYS_LOW ? SIM_TYPE.DIFFERENT : SIM_TYPE.SIMILAR;
    } else {
        type = SIM_TYPE.DIFFERENT;   // 两边都无数据 → 无法判定，标为「仅名称相同」偏保守
    }

    const meta = SIM_TYPE_META[type];
    return { type, label: meta.label, tone: meta.tone, advice: meta.advice, penalty, score };
}
