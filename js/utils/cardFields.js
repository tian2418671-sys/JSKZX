/**
 * 🧹 渲染层「前端内部字段」剥离（导出 / 转存前使用）
 *
 * 与主进程 `main/cardFieldSanitizer.js` **同一套规则**（两份实现是有意为之：
 * 主进程是 CJS、渲染层是 ESM，且 `main/` 与 `js/` 分层不互相 import）。
 * ⚠️ 两份的字段名单必须一致 —— `test/cardFieldSanitizer.test.mjs` 里有断言强制校验，
 *    改一边不改另一边会直接测试失败。
 *
 * 为什么需要它（为什么不能图省事写「递归剔掉所有 `_` 前缀键」）：
 *   第三方扩展把 `_` 开头的名字当**真实数据**用。对 11,045 张真实卡片的审计发现
 *   7 类、131 处会被前缀规则误删，其中最贴近本文件用处的是：
 *     · `character_book/entries[].extensions._filename`（28 张真实卡片）
 *   所以规则必须是 **白名单字段名 + 限定位置**：只删「词条对象自身的直接键」，
 *   **绝不递归进词条内部**。详见 docs/bugs/BUG-数据与文件.md 的 DF-14。
 *
 * 🆔 **DF-21（2026-09-23）：`uid` 按形态区分** —— 旧实现把 uid 当「纯前端字段」无条件删，
 *   但取证发现真实库（**804 个世界书 / 319,148 条词条**）的 uid **100% 是 ST 原生数字**
 *   （`0/1/2…`），本应用随机串 **0 个** ⇒ 旧行为在**删 ST 的真实数据**。
 *   ⇒ 现在**只删本应用生成形态**（`<Date.now()>_<随机串>`），ST 原生 uid 保留。
 *
 * 🛑 **当前实现已知问题（方案待拍板，见 `docs/规格与计划/工作记录-20260923.md` §二）**：
 *   ST 的 uid **完全等于数组下标**（真实库 40 文件恒为 `0..n-1`）⇒ 「保留原有 uid」在
 *   **调序 / 删除**后会写出与下标不一致的数据（上移：`[0,1,2]`→`[2,0,1]`；删中间：`[0,2]`）。
 *   ✅ **推荐方案 A**：保存时按下标重写 `uid = i`（与 ST 一致且始终自洽，
 *      届时可删掉 `APP_UID_RE` 那套形态判定）。**拍板前不要以为这块已完成。**
 */

/** 世界书词条对象自身的内部字段（前端 v-for key / 折叠态 / 导入过程临时字段） */
export const WB_ENTRY_INTERNAL_FIELDS = ['uid', '_collapsed', '_srcIndex', '_srcUid'];

/** 卡片 / 世界书**顶层**的库项元数据（正常只挂左栏库项，此处兜底） */
export const ROOT_INTERNAL_FIELDS = [
    'uid', '_collapsed', '_srcIndex', '_srcUid',
    '_mtime', '_ctime', '_size', '_importTime',
];

/**
 * 🆔 本应用生成的 uid 形态（DF-21）：`<Date.now()>_<base36 随机串>`
 *   与主进程 `main/cardFieldSanitizer.js` **必须一致**（有防漂移单测锁定）。
 */
export const APP_UID_RE = /^\d{13}_[a-z0-9]{4,10}$/;
/**
 * 🆔 历史形态（DF-21 兼容）：`useWorldbooks` 克隆世界书曾用字符串拼接产出无下划线串。
 *   ⚠️ **要求至少含一个小写字母**，避免把「长纯数字」误判成本应用的。
 */
export const APP_UID_LEGACY_RE = /^\d{13}(?=[a-z0-9]{5,10}$)(?=.*[a-z])[a-z0-9]+$/;

/** 该 uid 是否为本应用生成的临时 key（是 → 可删；否 → 视为外部真实数据，保留） */
export function isAppGeneratedUid(v) {
    if (typeof v !== 'string') return false;
    return APP_UID_RE.test(v) || APP_UID_LEGACY_RE.test(v);
}

/**
 * 删除对象**自身的**白名单直接键（不递归 —— 递归会误伤 extensions 内的同名真实数据）。
 * 就地修改入参；调用方需自行保证传进来的是副本。
 *
 * 🆔 DF-21：`uid` **单独处理** —— 只删本应用生成形态的。
 * @param {object} obj
 * @param {string[]} names
 * @param {{keepForeignUid?: boolean}} [opts] `keepForeignUid` 默认 true
 * @returns {object} 同一个对象，便于链式调用
 */
export function dropInternalFields(obj, names = WB_ENTRY_INTERNAL_FIELDS, opts) {
    if (!obj || typeof obj !== 'object') return obj;
    const keepForeignUid = !(opts && opts.keepForeignUid === false);
    for (const k of names) {
        if (!(k in obj)) continue;
        // 🆔 uid 特例：保留非本应用形态的（ST 原生数字 uid 是别人的真实数据）
        if (k === 'uid' && keepForeignUid && !isAppGeneratedUid(obj[k])) continue;
        delete obj[k];
    }
    return obj;
}

/** 取世界书词条数组：兼容 `{entries:[...]}` / `{entries:{k:v}}` / 裸数组；非世界书形态返回 null */
export function worldbookEntryList(book) {
    if (Array.isArray(book)) return book;
    if (!book || typeof book !== 'object') return null;
    const e = book.entries;
    if (Array.isArray(e)) return e;
    if (e && typeof e === 'object') return Object.values(e); // 第三方工具的对象字典格式
    return null;
}

/**
 * 返回剥离了内部字段的**深拷贝**，供导出/转存使用。
 * 兼容角色卡对象（character_book 在根或 `data` 下）与世界书载荷（`{entries:[...]}` 或裸数组）。
 * 深拷贝失败（循环引用等）时**原样返回**，绝不因清理失败丢数据。
 * @param {*} data
 */
export function stripInternalFields(data) {
    let clone;
    try {
        clone = JSON.parse(JSON.stringify(data));
    } catch (e) {
        console.warn('[strip] 内部字段剥离失败，已回退原样:', e && e.message);
        return data;
    }
    dropInternalFields(clone, ROOT_INTERNAL_FIELDS);
    if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
        dropInternalFields(clone.character_book, WB_ENTRY_INTERNAL_FIELDS);
        for (const e of worldbookEntryList(clone.character_book) || []) dropInternalFields(e);
        const inner = clone.data;
        if (inner && typeof inner === 'object') {
            dropInternalFields(inner.character_book, WB_ENTRY_INTERNAL_FIELDS);
            for (const e of worldbookEntryList(inner.character_book) || []) dropInternalFields(e);
        }
    }
    for (const e of worldbookEntryList(clone) || []) dropInternalFields(e);
    return clone;
}
