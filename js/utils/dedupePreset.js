/**
 * 🧩 预设结构统计与三维判定（v4 §3.3 / §9.2 / §9.3）—— 纯函数层
 * ═══════════════════════════════════════════════════════════════
 * 三维：**结构**（identifierSet Jaccard）/ **内容**（MinHash）/ **启用状态**（enabledRatio 一致性）。
 * `_simType` 五枚举（§9.3，必须落在 PresetDedupeModal `isRisky` 白名单内）：
 *   `sampler`（参数变体）/ `reorder`（顺序变体）/ `flipped`（启用变体）/ `reskin`（骨架相同）/ `different`（内容差异）。
 *
 * 历史口径（DF-24 教训，改前必读）：
 *   · `prompts` **数组 / 字典双形态**都要兼容（真实库是数组；旧实现先判 object → 产出 `[object Object]`）；
 *   · `prompt_order` 的 `character_id` **不写死**（真实库 100000/100001 并存）——取**覆盖最多**的 order 组；
 *   · 内容相似度必须走 **MinHash（Jaccard 语义）**，不得用「只累加共有块」的口径（会虚高到 100%）。
 *
 * 保守档阈值（§13，2026-09-24 拍板：宁可漏报绝不误报——弹窗按钮是「清理其余」）：
 *   `STRUCT_HIGH=0.95 / CONTENT_HIGH=0.90 / CONTENT_LOW=0.70`。
 * 本文件零案例字面量（守卫扫描）。
 */
import { estimateMinHashSimilarity } from './dedupeCommon.js';

export const STRUCT_HIGH = 0.95;
export const CONTENT_HIGH = 0.90;
export const CONTENT_LOW = 0.70;

/** 采样参数字段（与 DiffModal 预设分支字段表同源——唯一定义处） */
export const PRESET_PARAM_FIELDS = [
    { key: 'temperature', label: '🌡️ 温度 (Temperature)' },
    { key: 'max_tokens', label: '📏 最大输出 (Max Tokens)' },
    { key: 'max_context', label: '🧠 上下文 (Context)' },
    { key: 'rep_pen', label: '🚫 重复惩罚 (Rep Pen)' },
    { key: 'top_p', label: '🎯 Top P' },
    { key: 'top_k', label: '🔝 Top K' },
    { key: 'min_p', label: '📉 Min P' },
    { key: 'openai_model', label: '🧩 模型 (Model)' },
];

/** `_simType` → 展示元数据（label / tone / advice；白名单五枚举全覆盖） */
export const PRESET_TYPE_META = Object.freeze({
    sampler: { label: '参数变体', tone: 'amber', advice: '建议对比采样参数后清理' },
    reorder: { label: '顺序变体', tone: 'amber', advice: '建议对比条目顺序后清理' },
    flipped: { label: '启用状态不同', tone: 'rose', advice: '请先人工核对（勿直接清理）' },
    reskin: { label: '骨架相同（换皮）', tone: 'amber', advice: '建议对比内容后清理' },
    different: { label: '内容差异', tone: 'rose', advice: '请先人工核对（勿直接清理）' },
});

/** prompts（数组 / 字典）→ 块列表（字典形态每键视为一块） */
const blockList = (prompts) => {
    if (Array.isArray(prompts)) return prompts;
    if (prompts && typeof prompts === 'object') return Object.keys(prompts).map((k) => ({ identifier: k, content: prompts[k] }));
    return [];
};

/** 取「覆盖最多」的 prompt_order 组（不写死 character_id —— DF-24） */
const bestOrderGroup = (promptOrder) => {
    if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null;
    let best = null;
    for (const group of promptOrder) {
        const list = group && Array.isArray(group.order) ? group.order
            : (Array.isArray(group) ? group : null);
        if (list && (!best || list.length > best.length)) best = list;
    }
    return best;
};

/**
 * 预设结构统计（→ `NormalizedItem` 的四个派生字段）。
 * @returns {{identifierSeq:string, identifierSet:Set<string>, enabledRatio:number|null, sampler:object}}
 */
export const buildPresetStructure = (data) => {
    const d = (data && typeof data === 'object') ? data : {};
    const prompts = blockList(d.prompts);
    const seq = prompts.map((p, i) => (p && typeof p === 'object' && typeof p.identifier === 'string' && p.identifier)
        ? p.identifier : `#${i}`);
    const identifierSet = new Set(seq);

    // 启用比例：prompt_order（覆盖最多的组）优先；缺失时回退 prompts[].enabled
    let enabledRatio = null;
    const best = bestOrderGroup(d.prompt_order);
    if (best && best.length > 0) {
        const enabled = best.filter((e) => e && e.enabled !== false).length;
        enabledRatio = enabled / best.length;
    } else {
        const flagged = prompts.filter((p) => p && typeof p === 'object' && 'enabled' in p);
        if (flagged.length > 0) enabledRatio = flagged.filter((p) => p.enabled !== false).length / flagged.length;
    }

    const sampler = {};
    for (const f of PRESET_PARAM_FIELDS) if (d[f.key] !== undefined) sampler[f.key] = d[f.key];

    return { identifierSeq: seq.join('\u0001'), identifierSet, enabledRatio, sampler };
};

/** 集合 Jaccard（空集 → null，**不静默当 0**） */
export const setJaccard = (a, b) => {
    if (!a || !b || a.size === 0 || b.size === 0) return null;
    let inter = 0;
    for (const v of a) if (b.has(v)) inter++;
    return inter / (a.size + b.size - inter);
};

/** 采样参数向量相等（键集合与值都一致） */
export const sameSampler = (a, b) => {
    const ka = Object.keys(a || {});
    const kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
};

/**
 * 五枚举判定（§9.3；**优先级：参数 → 启用 → 顺序 → 骨架**，其余为内容差异）。
 * @param {object} center 参照版归一化项（需 sampler / enabledRatio / identifierSeq / identifierSet）
 * @param {object} member 对比项
 * @returns {'sampler'|'reorder'|'flipped'|'reskin'|'different'}
 */
export const pickPresetSimType = (center, member) => {
    if (!sameSampler(center.sampler, member.sampler)) return 'sampler';
    if (center.enabledRatio !== null && member.enabledRatio !== null && center.enabledRatio !== member.enabledRatio) return 'flipped';
    const j = setJaccard(center.identifierSet, member.identifierSet);
    if (j !== null && j >= STRUCT_HIGH) {
        return (center.identifierSeq === member.identifierSeq) ? 'reskin' : 'reorder';
    }
    return 'different';
};

/**
 * 三维百分比（0~100；缺数据 → null）。
 * @returns {{structPct:number|null, contentPct:number|null, enabledPct:number|null}}
 */
export const presetViewStats = (center, member) => {
    const js = setJaccard(center && center.identifierSet, member && member.identifierSet);
    const mh = estimateMinHashSimilarity(center && center.fullMinHash, member && member.fullMinHash);
    const en = (center && member && center.enabledRatio !== null && member.enabledRatio !== null)
        ? (1 - Math.abs(center.enabledRatio - member.enabledRatio)) : null;
    return {
        structPct: js === null ? null : Math.round(js * 100),
        contentPct: mh === null ? null : Math.round(mh * 100),
        enabledPct: en === null ? null : Math.round(en * 100),
    };
};

/** 内容分层（保守档 §13）：'high' | 'mid' | 'low' | null */
export const contentTier = (contentPct) => {
    if (contentPct === null || contentPct === undefined) return null;
    const v = contentPct / 100;
    if (v >= CONTENT_HIGH) return 'high';
    if (v >= CONTENT_LOW) return 'mid';
    return 'low';
};
