/**
 * 🏷️ 世界书**分组与标签**的纯函数层（A2 落地，`RFC-20260921-WB-TAGS-02`）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📌 已拍板的三个决策（2026-09-24，用户明确选择）
 * ───────────────────────────────────────────────────────────────
 * | 决策 | 选择 | 后果 |
 * |---|---|---|
 * | **元数据存哪（SSOT）** | **只留在配置文件**（`wbCategoryMap` + 新增 `wbTagMap`） | 零风险：**不动用户文件、不产快照、不碰第三方格式**；⚠️ 代价 = 换机 / 库外复制**不随书走** |
 * | **哨兵值** | **保持中文「全部」「默认」** + **补用户输入的碰撞防护** | 存量用户分组名不受影响；新输入不得撞保留名 |
 * | **标签口径** | **角色卡随卡片走**（现状 `customTags` + 配置覆盖层）；**独立世界书留在系统配置** | 两套口径**刻意并存**（见下） |
 *
 * ⚠️ **为什么两套标签口径并存（避免日后被当成 bug 反复「修复」）**：
 *   · 角色卡：`item.customTags`（内存）+ 配置覆盖层 `cardOverlays[path].tags` 恢复
 *     （`useCardCrud.js` 的 `persistCardCategory`）——**不写进卡片文件**；
 *   · 世界书：**同样只留配置层**（本模块的 `wbTagMap`）。
 *   ⇒ 用户明确表态「角色卡随卡片走，独立世界书保留在系统配置即可」。
 *     两者都是「配置层持久化」，差别在**卡片侧另有覆盖层恢复链路**（历史原因）。
 *     这是**有意的产品选择**，不是遗漏。
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔬 与原方案的偏差（照抄会直接报错 / 造成数据事故 —— 详见规格 §〇）
 * ───────────────────────────────────────────────────────────────
 * · 原方案要新建 `saveWorldbooksMeta` IPC + 落盘 `extensions.jskzx` ——
 *   **本次决策 A 后不需要**（不写文件 ⇒ 不产快照、不需要新 IPC、不需要 `isPathAllowed` 扩权）。
 * · 原方案用英文哨兵 `__all__` / `__ungrouped__` —— **本次决策保留中文哨兵**，
 *   只补「用户输入不得撞保留名」的防护（原方案只拦 `__` 前缀，**拦不住存量中文名**）。
 */

/**
 * 🚩 视图哨兵：表示「不按分组过滤」（**不是**一个真实分组）
 * ⚠️ 与 `App.vue` 的 `currentWbCategory` 初值一致；改这里必须同步那里。
 */
export const WB_CAT_ALL = '全部';

/** 🚩 未分组默认名（真实分组，只是名字固定） */
export const WB_CAT_DEFAULT = '默认';

/**
 * 🚩 **保留名**（用户不得用它们作为自建分组名）
 * 为什么必须防：`'全部'` 是视图哨兵 —— 用户若建一个叫「全部」的分组，
 *   `filteredWorldbooks` 的 `if (currentWbCategory.value !== '全部')` 会**恒不过滤**
 *   ⇒ 该分组的筛选**完全失效**（点了等于没点），且**无法察觉**。
 */
export const WB_RESERVED_CATEGORY_NAMES = [WB_CAT_ALL, WB_CAT_DEFAULT];

/** 分组名 / 标签名的**最大长度**（防止超长名把 UI 撑爆、把配置写肥） */
export const WB_NAME_MAX_LEN = 40;

/**
 * 🧹 规范化**分组名**（纯函数）
 *
 * 处理：trim → 折叠内部空白 → 截断到上限。
 * ⚠️ **不做大小写归一**：中文分组名无大小写问题，而英文名用户可能有意区分（`NSFW` vs `nsfw`）。
 *
 * @param {*} raw 原始输入
 * @returns {string} 规范化后的名字（非法输入返回空串）
 */
export function normalizeWbCategoryName(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s) return '';
    if (s.length > WB_NAME_MAX_LEN) s = s.slice(0, WB_NAME_MAX_LEN).trim();
    return s;
}

/**
 * 🛡️ 校验分组名是否可用（**碰撞防护** —— A2-2 决策的核心）
 *
 * @param {*} raw 原始输入
 * @param {{ existing?: string[], self?: string }} [opts]
 *   `existing` = 已存在的分组名列表；`self` = 当前分组名（重命名时视为合法，不算冲突）
 * @returns {{ok:boolean, name:string, reason?:string}}
 */
export function validateWbCategoryName(raw, opts) {
    const name = normalizeWbCategoryName(raw);
    const o = opts || {};
    if (!name) return { ok: false, name: '', reason: '分组名不能为空' };
    if (WB_RESERVED_CATEGORY_NAMES.includes(name)) {
        // 「默认」允许作为**目标**（= 移出分组），但「全部」是视图哨兵，永远不能当分组名
        if (name === WB_CAT_DEFAULT) {
            return { ok: true, name, reserved: true };
        }
        return {
            ok: false, name,
            reason: `「${name}」是本应用保留的**视图名称**（表示"不按分组筛选"），不能用作分组名。`
        };
    }
    const self = normalizeWbCategoryName(o.self);
    if (name !== self && Array.isArray(o.existing) && o.existing.includes(name)) {
        return { ok: false, name, reason: `分组「${name}」已存在，请换一个名字（或直接把书移进去）。` };
    }
    return { ok: true, name };
}

/**
 * 🧹 规范化**标签**（纯函数）
 *
 * 与分组名的差别：标签**允许重复输入**（要去重）、**允许「全部」这类词**
 *   （标签不参与视图哨兵判定，没有碰撞问题）。
 *
 * @param {*} raw
 * @returns {string}
 */
export function normalizeWbTag(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s) return '';
    if (s.length > WB_NAME_MAX_LEN) s = s.slice(0, WB_NAME_MAX_LEN).trim();
    return s;
}

/**
 * 🧹 规范化**标签数组**：逐项规范化 → 去空 → **去重**（保留首次出现顺序）
 * @param {*} arr
 * @returns {string[]}
 */
export function normalizeWbTags(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const t of arr) {
        const n = normalizeWbTag(t);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * 🔀 切换某个标签的**存在性**（有则删、无则加）—— 纯函数，返回新数组
 * @param {string[]} tags 现有标签
 * @param {string} tag 目标标签
 * @returns {string[]} 新数组（已规范化去重）
 */
export function toggleWbTag(tags, tag) {
    const list = normalizeWbTags(tags);
    const n = normalizeWbTag(tag);
    if (!n) return list;
    return list.includes(n) ? list.filter(t => t !== n) : [...list, n];
}

/**
 * 🔎 统计标签**使用频次**（供「标签选择器」按热度排序）
 * @param {Iterable<string[]>} tagLists 每本书的标签数组
 * @returns {Array<{tag:string, count:number}>} 按 count 降序、同频按名称升序
 */
export function countWbTags(tagLists) {
    const map = new Map();
    for (const list of tagLists || []) {
        for (const t of normalizeWbTags(list)) {
            map.set(t, (map.get(t) || 0) + 1);
        }
    }
    return [...map.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'zh-CN'));
}

/**
 * 🎯 复合过滤判定（分组 + 标签 + 搜索 + 词条数档）—— **纯函数**，供列表筛选与单测共用
 *
 * 语义（与规格 TC-WB-05 一致）：
 *   · 分组：`'全部'` = 不过滤；否则必须**精确等于**该书分组；
 *   · 标签：选中的标签必须**全部命中**（AND，不是 OR）—— 规格原文「仅展示同时命中全部条件者」；
 *   · 搜索 / 词条数：由调用方传入已算好的布尔值（避免本函数依赖响应式状态）。
 *
 * @param {object} p
 * @param {string} p.bookCategory 该书的分组
 * @param {string[]} p.bookTags 该书的标签
 * @param {string} [p.filterCategory] 当前选中分组（缺省 = 不过滤）
 * @param {string[]} [p.filterTags] 当前选中标签（缺省 = 不过滤）
 * @param {boolean} [p.matchesSearch] 搜索是否命中（调用方算）
 * @param {boolean} [p.matchesCount] 词条数档是否命中（调用方算）
 * @returns {boolean}
 */
export function matchWbFilter(p) {
    const o = p || {};
    if (o.matchesSearch === false) return false;
    if (o.matchesCount === false) return false;
    const filterCat = o.filterCategory;
    if (filterCat && filterCat !== WB_CAT_ALL) {
        if (o.bookCategory !== filterCat) return false;
    }
    const want = normalizeWbTags(o.filterTags);
    if (want.length) {
        const have = new Set(normalizeWbTags(o.bookTags));
        for (const t of want) if (!have.has(t)) return false;
    }
    return true;
}
