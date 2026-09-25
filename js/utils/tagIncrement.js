/**
 * ⏭️ AI 打标 · 增量模式（Q7，2026-09-25 落地）——「跳过已打标卡」判定
 *
 * 口径（与引擎/界面约定一致）：
 *   「已打标」= 该卡**已有标签**，满足任一即可：
 *     · `card.customTags`（本工具的标签层，落盘在 cardOverlays）非空；
 *     · 卡本体 `data.tags` / `data.data.tags`（原生携带的标签）非空。
 *   ⚠️ 空数组、空字符串、纯空白都不算「有标签」（避免脏值误跳过）。
 *
 * 零 Vue / 零 Electron 依赖，可 `node --test` 直接测。
 */

/**
 * 该卡是否已有标签（增量模式据此跳过）。
 * @param {object} card 卡片对象（library 元素；兼容 V1/V2 两种 data 结构）
 * @returns {boolean}
 */
export function hasAnyTag(card) {
    if (!card || typeof card !== 'object') return false;

    // ① 工具标签层：customTags
    const custom = Array.isArray(card.customTags) ? card.customTags : [];
    if (custom.some(t => String(t == null ? '' : t).trim() !== '')) return true;

    // ② 卡本体原生标签：data.tags（V2 在 card.data.data.tags，V1 在 card.data.tags）
    const dataLayer = card.data && card.data.data ? card.data.data : (card.data || {});
    const native = dataLayer ? dataLayer.tags : undefined;
    if (Array.isArray(native)) return native.some(t => String(t == null ? '' : t).trim() !== '');
    if (typeof native === 'string') return native.trim() !== '';

    return false;
}

/**
 * 按「是否已有标签」拆分卡片数组（供后续批量接口/统计复用）。
 * @param {Array} cards
 * @returns {{tagged: Array, untagged: Array}}
 */
export function splitByTagged(cards) {
    const tagged = [];
    const untagged = [];
    for (const c of Array.isArray(cards) ? cards : []) {
        if (hasAnyTag(c)) tagged.push(c);
        else untagged.push(c);
    }
    return { tagged, untagged };
}
