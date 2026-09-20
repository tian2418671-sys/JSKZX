/**
 * 🤖 自动分组 · LLM 判定层（纯函数）
 * ═════════════════════════════════════════════════════════════════
 * 设计（2026-09-20 用户拍板，草案→落地）：
 *   · 「判定标准」= 每条收纳规则上的自然语言说明（留空 = 该组不参与 AI 判定）
 *   · 只喂「未命中规则 / 规则冲突」的卡片（命中的卡不浪费 API 额度）
 *   · 卡信息口径：**名称 + 标签 + 描述前 200 字**（用户拍板）
 *   · 输出契约（系统提示词写死）：{"assignments":[{card, group, confidence, reason}]}
 *   · 建议**默认不勾选**（用户拍板）——本层只产出建议，执行权始终在用户手里
 *
 * 本模块纯函数：无 window / electronAPI / fetch（真正调用在 useAutoGroup 编排层，走统一
 * `window.electronAPI.sendChatMessage` 通道 —— 渲染层直接 fetch 会被 CORS 拦，见 useAITools 注释）。
 */
import { extractCardTags } from '../composables/useSearch.js';

export const LLM_CARD_DESC_LIMIT = 200;    // 描述截断（口径：前 200 字）
export const LLM_CRITERIA_LIMIT = 300;     // 「判定标准」长度上限（防配置无限长）
export const LLM_DEFAULT_BATCH_SIZE = 20;  // 每批请求携带的卡片数
const ROOT_GROUP = '未分类';

/** 归一化「判定标准」文本（落盘/提示词/签名三处共用） */
export function normalizeLlmCriteria(v) {
    return typeof v === 'string' ? v.trim().slice(0, LLM_CRITERIA_LIMIT) : '';
}

/** 从分组档案提取「参与 AI 判定」的组规格（enabled + 有判定标准；同组合并标准） */
export function buildLlmGroupSpecs(profiles) {
    const out = [];
    const byGroup = new Map();
    for (const p of (Array.isArray(profiles) ? profiles : [])) {
        if (!p || p.enabled === false) continue;
        const group = typeof p.group === 'string' ? p.group.trim() : '';
        const criteria = normalizeLlmCriteria(p.llmCriteria);
        if (!group || !criteria) continue;
        if (byGroup.has(group)) { byGroup.get(group).criteria += '；' + criteria; continue; }
        const spec = { group, criteria };
        byGroup.set(group, spec);
        out.push(spec);
    }
    return out;
}

/** 规格签名（LLM 建议缓存的失效依据：改分组/改标准 → 旧缓存不再命中） */
export function llmSpecsSignature(specs) {
    return (Array.isArray(specs) ? specs : []).map(s => `${s.group}\u0000${s.criteria}`).join('\u0001');
}

/** 卡片 → 缓存 key（移动前 path 稳定；改题/换文件天然失效） */
export function llmCardCacheKey(card, signature) {
    const base = (card && (card.path || card.name)) || '';
    return `${base}\u0000${signature || ''}`;
}

/** 卡面标签（唯一入口 extractCardTags；异常兜底空数组） */
export function llmCardTags(card, opts = {}) {
    try { return extractCardTags(card, opts) || []; } catch (e) { return []; }
}

/** 描述前 N 字（折叠空白；超长补省略号） */
export function llmCardDesc(card) {
    const data = (card && card.data && card.data.data) || (card && card.data) || {};
    const raw = typeof data.description === 'string' ? data.description : '';
    const flat = raw.replace(/\s+/g, ' ').trim();
    return flat.length > LLM_CARD_DESC_LIMIT ? flat.slice(0, LLM_CARD_DESC_LIMIT) + '…' : flat;
}

/**
 * 收集 LLM 候选：规则**未命中** + 规则**冲突**（去重，保持计划内的出现顺序）
 * @returns {Array<{card:object, cardId:any, cardName:string, currentGroup:string, kind:'unmatched'|'conflict'}>}
 */
export function collectLlmCandidates({ plan, cards } = {}) {
    const byId = new Map();
    for (const c of (Array.isArray(cards) ? cards : [])) {
        if (c && c.id !== undefined) byId.set(c.id, c);
    }
    const out = [];
    const seen = new Set();
    const push = (cardId, kind) => {
        if (cardId === undefined || cardId === null || seen.has(cardId)) return;
        const card = byId.get(cardId);
        if (!card) return;
        seen.add(cardId);
        out.push({
            card, cardId, kind,
            cardName: String(card.name || '(未命名卡片)'),
            currentGroup: card.subFolder || card.category || ROOT_GROUP
        });
    };
    for (const s of ((plan && plan.skipped) || [])) {
        // 判定层 skip 文案「未命中任何启用中的收纳条件」（前缀匹配，防文案微调漏检）
        if (s && typeof s.reason === 'string' && s.reason.startsWith('未命中')) push(s.cardId, 'unmatched');
    }
    for (const c of ((plan && plan.conflicts) || [])) push(c.cardId, 'conflict');
    return out;
}

/** 构造系统/用户消息（系统提示词 = 契约，写死在模块里；用户消息 = 分组清单 + 卡信息） */
export function buildLlmMessages({ specs, cards, ignoreNativeTags } = {}) {
    const specList = Array.isArray(specs) ? specs : [];
    const cardList = Array.isArray(cards) ? cards : [];
    const system = [
        '你是角色卡库的分组助手。任务：根据每张卡片的信息，判断它最契合的目标分组。',
        '',
        '输出要求（务必严格遵守）：',
        '1. 只输出一个 JSON 对象，不要输出任何其它文字、注释或 Markdown 代码块标记。',
        '2. 格式：{"assignments":[{"card":"卡片名","group":"分组名","confidence":0.0-1.0,"reason":"简短理由"}]}',
        '3. 只能使用「可选分组」清单中的分组名；无法判断或没有合适分组时，可以不输出该卡片。',
        '4. 同一张卡片最多输出一条；confidence 表示把握程度（0~1）。'
    ].join('\n');

    const lines = ['【可选分组】'];
    for (const s of specList) lines.push(`- ${s.group}：判定标准：${s.criteria}`);
    lines.push('', '【待判断卡片】');
    cardList.forEach((entry, i) => {
        const card = entry && entry.card ? entry.card : entry;
        const name = String((card && card.name) || '(未命名卡片)');
        const tags = llmCardTags(card, { ignoreNative: !!ignoreNativeTags });
        const desc = llmCardDesc(card);
        lines.push(`${i + 1}. ${name}｜标签：${tags.length ? tags.join('、') : '（无）'}｜简介：${desc || '（无）'}`);
    });
    lines.push('', '请按系统要求输出 JSON。');
    return { system, user: lines.join('\n') };
}

/**
 * 容错解析 LLM 输出：去 fence → 截取首尾花括号 → JSON.parse → 过滤未知组/未知卡 + 置信度夹紧
 * 同卡多条取置信度最高者。
 */
export function parseLlmJudgement(rawText, { validGroups = [], cardNames = [] } = {}) {
    const text = String(rawText || '').trim();
    const fail = (msg) => ({ assignments: [], invalidGroups: [], unknownCards: [], parseError: msg });
    if (!text) return fail('回复为空');
    let t = text;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return fail('未找到 JSON 对象');
    let obj;
    try { obj = JSON.parse(t.slice(start, end + 1)); }
    catch (e) { return fail('JSON 解析失败：' + ((e && e.message) || e)); }

    const gset = new Set(Array.isArray(validGroups) ? validGroups : []);
    const cset = new Set(Array.isArray(cardNames) ? cardNames : []);
    const invalidGroups = [];
    const unknownCards = [];
    const best = new Map(); // card → assignment（取置信度最高者）
    for (const it of (Array.isArray(obj && obj.assignments) ? obj.assignments : [])) {
        if (!it || typeof it !== 'object') continue;
        const card = typeof it.card === 'string' ? it.card.trim() : '';
        const group = typeof it.group === 'string' ? it.group.trim() : '';
        if (!card || !group) continue;
        if (!cset.has(card)) { if (!unknownCards.includes(card)) unknownCards.push(card); continue; }
        if (!gset.has(group)) { if (!invalidGroups.includes(group)) invalidGroups.push(group); continue; }
        let conf = Number(it.confidence);
        if (!Number.isFinite(conf)) conf = 0.6;
        conf = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
        const reason = typeof it.reason === 'string' ? it.reason.trim().slice(0, LLM_CARD_DESC_LIMIT) : '';
        const prev = best.get(card);
        if (!prev || conf > prev.confidence) best.set(card, { card, group, confidence: conf, reason });
    }
    const out = Array.from(best.values());
    return { assignments: out, invalidGroups, unknownCards, parseError: '' };
}

/** 判定 → 卡片对象（同名多卡按出现顺序消费，避免重复指派） */
export function assignJudgements(assignments, cards) {
    const pool = new Map();
    for (const c of (Array.isArray(cards) ? cards : [])) {
        if (!c) continue;
        const n = String(c.name || '');
        if (!pool.has(n)) pool.set(n, []);
        pool.get(n).push(c);
    }
    const applied = [];
    for (const a of (Array.isArray(assignments) ? assignments : [])) {
        const q = pool.get(a.card);
        if (!q || !q.length) continue;
        applied.push({ card: q.shift(), group: a.group, confidence: a.confidence, reason: a.reason });
    }
    return applied;
}
