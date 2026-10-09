/**
 * 🧪 卡片质量巡检（纯函数 · 可单测 · 供「一键质检」S4 用）
 *
 * v1 规则刻意保守（规格 §五）：**只报事实，不给删改建议**，避免误报引发误删。
 *   1. `desc-empty`      简介（`description`）为空
 *   2. `no-tags`         无标签
 *   3. `first-mes-empty` 开场白（`first_mes`）为空
 *   4. `token-over`      Token 超阈值（默认 8000，可调）
 *
 * 口径复用（不造第二套）：
 *   · 卡片正文位置 = `card.data.data || card.data || card`（同 `App.vue::estimateCardTokens`）；
 *   · Token 数 = 注入的 `opts.estimateCardTokens`（App 传同一个），否则回退 `item._tokens`。
 */
import { tagsOf, nameOf } from './tagStats.js';

/** 规则元数据（顺序即报告顺序） */
export const AUDIT_RULES = [
    { id: 'desc-empty', title: '简介为空', hint: '`description` 缺失或全空白' },
    { id: 'no-tags', title: '无标签', hint: '`tags` / `customTags` 均空' },
    { id: 'first-mes-empty', title: '开场白为空', hint: '`first_mes` 缺失或全空白' },
    { id: 'token-over', title: 'Token 超阈值', hint: '超过设定阈值（默认 8000）' }
];

export const DEFAULT_TOKEN_THRESHOLD = 8000;

/** 卡片正文对象（唯一入口） */
export function cardInnerOf(item) {
    if (!item || typeof item !== 'object') return {};
    const d = item.data;
    if (d && typeof d === 'object') {
        const inner = d.data;
        if (inner && typeof inner === 'object') return inner;
        return d;
    }
    return item;
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * 巡检卡片数组
 * @param {Array<object>} items
 * @param {{tokenThreshold?:number, estimateCardTokens?:Function, maxHits?:number}} [opts]
 * @returns {{total:number, tokenThreshold:number, rules:Array<{id:string,title:string,hint:string,count:number,hits:Array<{path:string,name:string,detail:string}>}>}}
 */
export function auditCards(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const tokenThreshold = Number(opts.tokenThreshold) > 0 ? Number(opts.tokenThreshold) : DEFAULT_TOKEN_THRESHOLD;
    const maxHits = Math.max(1, Number(opts.maxHits) || 200);
    const est = (typeof opts.estimateCardTokens === 'function')
        ? opts.estimateCardTokens
        : ((item) => (item && typeof item._tokens === 'number' ? item._tokens : 0));

    const buckets = new Map(AUDIT_RULES.map((r) => [r.id, { ...r, count: 0, hits: [] }]));
    const push = (id, item, detail) => {
        const b = buckets.get(id);
        b.count++;
        if (b.hits.length < maxHits) b.hits.push({ path: String((item && item.path) || ''), name: nameOf(item), detail });
    };

    for (const item of list) {
        const inner = cardInnerOf(item);
        if (isBlank(inner.description)) push('desc-empty', item, '');
        if (tagsOf(item).length === 0) push('no-tags', item, '');
        if (isBlank(inner.first_mes)) push('first-mes-empty', item, '');
        let tokens = 0;
        try { tokens = Number(est(item)) || 0; } catch (e) { tokens = 0; }
        if (tokens > tokenThreshold) push('token-over', item, `${tokens} token`);
    }

    return {
        total: list.length,
        tokenThreshold,
        rules: AUDIT_RULES.map((r) => buckets.get(r.id))
    };
}
