/**
 * 🏷️ 标签统计（纯函数 · 可单测 · 供「一键质检」S3 用）
 *
 * 口径与项目既有实现**保持一致**（不造第二套）：
 *   · 标签字段回退顺序 = `tags` → `customTags`（同 `js/utils/dedupeContract.js::normalizeCard`）；
 *   · 非字符串标签一律 `String()` 后 trim，空白项不计（脏数据防护）。
 *
 * 规格：`docs/规格与计划/功能规格/一键质检流水线-实现规格.md` §3.2
 */

/** 取卡片标签数组（唯一入口，别在别处再写一遍回退） */
export function tagsOf(item) {
    const t = (item && Array.isArray(item.tags)) ? item.tags
        : ((item && Array.isArray(item.customTags)) ? item.customTags : []);
    return t.map((x) => String(x === undefined || x === null ? '' : x).trim()).filter((x) => x !== '');
}

/** 卡片展示名（回退顺序：name → 文件名） */
export function nameOf(item) {
    const n = item && (item.name || item.fileName);
    if (n) return String(n);
    const p = (item && item.path) ? String(item.path) : '';
    return p ? p.split(/[\\/]/).pop() : '(未命名)';
}

/**
 * 统计标签分布
 * @param {Array<object>} items 卡片数组（库项）
 * @param {{topN?:number, capItems?:number}} [opts] topN=榜单长度（默认 15）；capItems=问题清单上限（默认 200）
 * @returns {{total:number, tagged:number, untagged:number, coveragePct:number, singleTag:number,
 *            tagCount:number, tagCounts:Map<string,number>, topTags:Array<{tag:string,count:number}>,
 *            untaggedItems:Array<{path:string,name:string}>, singleTagItems:Array<{path:string,name:string,tag:string}>}}
 */
export function computeTagStats(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const topN = Math.max(1, Number(opts.topN) || 15);
    const capItems = Math.max(1, Number(opts.capItems) || 200);

    const tagCounts = new Map();
    const untaggedItems = [];
    const singleTagItems = [];
    let untagged = 0;
    let singleTag = 0;

    for (const item of list) {
        const tags = tagsOf(item);
        if (tags.length === 0) {
            untagged++;
            if (untaggedItems.length < capItems) untaggedItems.push({ path: String((item && item.path) || ''), name: nameOf(item) });
            continue;
        }
        if (tags.length === 1) {
            singleTag++;
            if (singleTagItems.length < capItems) singleTagItems.push({ path: String((item && item.path) || ''), name: nameOf(item), tag: tags[0] });
        }
        for (const t of tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }

    const topTags = [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
        .slice(0, topN);

    const total = list.length;
    const tagged = total - untagged;
    return {
        total,
        tagged,
        untagged,
        coveragePct: total ? Math.round((tagged / total) * 1000) / 10 : 0,
        singleTag,
        tagCount: tagCounts.size,
        tagCounts,
        topTags,
        untaggedItems,
        singleTagItems
    };
}
