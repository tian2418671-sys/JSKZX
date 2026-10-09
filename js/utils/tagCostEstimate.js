/**
 * 💰 打标「成本与覆盖度」预估（纯函数 · 只读计算，**不改变任何发送行为**）
 *
 * 来历（2026-10-03 用户需求）：「给卡片和世界书都显示『这次要花多少、覆盖多少』，
 *   只是显示功能，让用户有数、由用户决定怎么用，后续按反馈再优化。」
 *
 * 口径（重要，别猜）：
 *   · **token 用实测校准值**：114 个真实请求 / 408,994 字（材料+固定开销）→ 264,094 prompt tokens
 *     ⇒ **0.646 token/字**（中文为主）→ 本模块取 `0.65 × 汉字 + 1.3 × 英文词`。
 *     ⚠️ 仓库既有 `js/utils/tokenEstimate.js` 是「汉字 ×1.5」的**保守上界**（实测高估约 132%），
 *        它仍用于**打包短卡准入**判据（那里要求保守），**不要**用它来显示预算 —— 两者用途不同。
 *   · **请求数与覆盖度必须与发送同源**：世界书按 `splitTextSegments(material, 3500)` 切段、
 *     超过 `ui.tagWbSegmentMax`（默认 40）均匀采样；卡片按 `描述+首句+性格` 估算 ≤1200 token 视为
 *     「短卡」并按 `packSize` 连续成组，长卡单独成单元、>4000 字再分段。
 *
 * ⚠️ 本模块**只算数字**：不写配置、不改草稿、不影响发送。
 */
import { splitTextSegments } from './llmPromptRoles.js';
import { estimateTokens } from './tokenEstimate.js';

/** 实测校准：token/汉字（0.646 取整；见 docs/规格与计划/AI打标/实验-材料策略对照-2026-10-03.md） */
export const REAL_TOKENS_PER_CJK = 0.65;
/** 实测校准：token/英文词 */
export const REAL_TOKENS_PER_EN_WORD = 1.3;

/** 材料段前缀（预览 part.body 带的头部；预估时要剥掉才能与"送出去的材料"对齐） */
export const WB_MATERIAL_PREFIX = '\n\n【世界书材料】\n';
export const CARD_MATERIAL_PREFIX = '\n\n【角色设定提取】：\n';

/** 剥掉预览 part.body 的材料前缀（拿回"真正被切段/发送的材料正文"） */
export function stripMaterialPrefix(body) {
    const t = String(body == null ? '' : body);
    if (t.startsWith(WB_MATERIAL_PREFIX)) return t.slice(WB_MATERIAL_PREFIX.length);
    if (t.startsWith(CARD_MATERIAL_PREFIX)) return t.slice(CARD_MATERIAL_PREFIX.length);
    return t;
}

/**
 * 实测口径的 token 估算（**不截断**，与 1.5/字 的保守估算器区分开）
 * @param {string} text
 * @returns {number} 估算 token 数
 */
export function estimateRealTokens(text) {
    const t = String(text == null ? '' : text);
    if (!t) return 0;
    const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = t.replace(/[\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjk * REAL_TOKENS_PER_CJK + words * REAL_TOKENS_PER_EN_WORD);
}

/**
 * 世界书一轮的预估
 * @param {object} o
 * @param {Array<{label:string, material:string}>} o.targets 目标书（material 已是"送出去的材料正文"）
 * @param {string} o.fixedText 每请求重复的固定开销（SYSTEM 段 + USER 段 + 未被占位符接管/未被丢弃的公共材料）
 * @param {number} o.segmentMax 分段上限（ui.tagWbSegmentMax）
 * @param {number} [o.chunkChars=3500] 单段目标字数
 * @param {number} [o.thresholdChars=4000] 超此字数才分段
 */
export function estimateWbCost({ targets = [], fixedText = '', segmentMax = 40, chunkChars = 3500, thresholdChars = 4000 } = {}) {
    const cap = Math.max(1, Math.round(Number(segmentMax) || 40));
    const fixedTokens = estimateRealTokens(fixedText);
    let requests = 0;
    let sentChars = 0;
    let totalChars = 0;
    let tokens = 0;
    const perTarget = [];
    for (const t of targets) {
        const material = String((t && t.material) || '');
        const chars = material.length;
        totalChars += chars;
        let taken;
        let segTotal = 1;
        if (chars <= thresholdChars) {
            taken = [material];
        } else {
            const segs = splitTextSegments(material, chunkChars);
            segTotal = segs.length;
            if (segs.length <= cap) taken = segs;
            else {
                taken = [];
                const stride = segs.length / cap;
                for (let k = 0; k < cap; k++) taken.push(segs[Math.min(segs.length - 1, Math.floor(k * stride))]);
            }
        }
        let tSent = 0;
        let tTokens = 0;
        for (const seg of taken) {
            tSent += seg.length;
            tTokens += estimateRealTokens(seg) + fixedTokens;
        }
        requests += taken.length;
        sentChars += tSent;
        tokens += tTokens;
        perTarget.push({
            label: (t && t.label) || '未命名',
            materialChars: chars,
            segTotal,
            requests: taken.length,
            sentChars: tSent,
            coverage: chars ? tSent / chars : 1,
            sampled: tSent < chars
        });
    }
    return {
        mode: 'wb',
        targets: perTarget.length,
        requests,
        sentChars,
        totalChars,
        coverage: totalChars ? sentChars / totalChars : 1,
        promptTokens: tokens,
        fixedTokens,
        heavy: perTarget.filter((x) => x.sampled).sort((a, b) => b.materialChars - a.materialChars).slice(0, 3)
    };
}

/**
 * 卡片一轮的预估（含打包）
 * @param {object} o
 * @param {Array<{label:string, material:string, shortText?:string}>} o.targets 选中的卡（material = 送出去的卡材料正文）
 * @param {string} o.fixedText 每请求重复的固定开销
 * @param {number} o.packSize 每请求打包卡数（1 = 不打包）
 * @param {number} [o.shortMaxTokens=1200] 短卡准入（与发送侧 PACK_SHORT_CARD_MAX_TOKENS 一致）
 * @param {number} [o.chunkChars=3500]
 * @param {number} [o.thresholdChars=4000]
 */
export function estimateCardCost({ targets = [], fixedText = '', packSize = 1, shortMaxTokens = 1200, chunkChars = 3500, thresholdChars = 4000 } = {}) {
    const size = Math.max(1, Math.min(10, Number(packSize) || 1));
    const fixedTokens = estimateRealTokens(fixedText);
    const totalChars = targets.reduce((n, t) => n + String((t && t.material) || '').length, 0);

    // ① 连续短卡按 packSize 成组；长卡单独成单元（与发送侧 buildTagUnits 同判据）
    const units = [];
    let buf = [];
    const flush = () => { if (buf.length) { units.push(buf); buf = []; } };
    for (const t of targets) {
        const material = String((t && t.material) || '');
        const judge = String((t && t.shortText) || material);
        const packable = size > 1 && estimateTokens(judge) <= shortMaxTokens;
        if (!packable) { flush(); units.push([t]); continue; }
        buf.push(t);
        if (buf.length >= size) flush();
    }
    flush();

    // ② 每个单元 → 1 个请求；单卡单元若超阈值则分段
    let requests = 0;
    let sentChars = 0;
    let tokens = 0;
    let packedUnits = 0;
    let segmentedCards = 0;
    for (const unit of units) {
        const chars = unit.reduce((n, t) => n + String((t && t.material) || '').length, 0);
        let segs;
        if (unit.length === 1 && chars > thresholdChars) {
            segs = splitTextSegments(String(unit[0].material || ''), chunkChars);
            segmentedCards++;
        } else {
            segs = [unit.map((t) => String((t && t.material) || '')).join('\n')];
            if (unit.length > 1) packedUnits++;
        }
        for (const seg of segs) {
            requests++;
            sentChars += seg.length;
            tokens += estimateRealTokens(seg) + fixedTokens;
        }
    }
    return {
        mode: 'card',
        targets: targets.length,
        requests,
        sentChars,
        totalChars,
        coverage: totalChars ? sentChars / totalChars : 1,
        promptTokens: tokens,
        fixedTokens,
        packedUnits,
        segmentedCards,
        heavy: targets
            .map((t) => ({ label: (t && t.label) || '未命名', materialChars: String((t && t.material) || '').length }))
            .filter((x) => x.materialChars > thresholdChars)
            .sort((a, b) => b.materialChars - a.materialChars)
            .slice(0, 3)
    };
}
