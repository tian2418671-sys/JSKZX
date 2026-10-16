/**
 * 🌍 世界书打标材料构建 —— **纯函数**（四处消费点同源：① 规则层 / ② 向量层 / ③ LLM 层 / 预览区）
 *
 * ═══════════════════════════════════════════════════════════════
 * 🩹 修 AI-14（2026-10-03）：旧实现 `useAITools.buildMaterial` **用触发词 `key` 当词条标题**，
 *   把作者写的词条名 `comment` 整块丢掉；书级 `description`、次级触发词、`constant`（常驻）
 *   也都不送；且**不跳过禁用词条** ⇒ AI 只拿到「零信息量标题（`{{user}}` / 你 / 我）+ 正文」，
 *   打标偏泛偏错（用户反馈「打标失误太大」）。
 * 🩹 修 AI-20（2026-10-04）：本模块此前**只认「世界书库对象」**（`wb.data.entries`）⇒
 *   角色卡**内嵌**世界书（`character_book`，卡根或 `data` 下）根本进不来，
 *   `{{世界书}}` 占位符在卡片视图恒空（用户实测「无法引用世界书的内容，是空的」）。
 *   ⇒ 新增 `resolveWbBook()` / `resolveWbEntries()`：**库世界书与卡内嵌世界书走同一套材料实现**。
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ **口径（两类世界书必须分清）**：
 *   · **独立世界书（库）**：`key` / `keysecondary` / `order` / `disable`
 *   · **卡内嵌世界书（V2）**：`keys` / `secondary_keys` / `insertion_order` / `enabled`
 *   ⇒ 本模块**只读**，一律**双向回退**（`key → keys`）；**不做口径转换**
 *     （写回才需要 `wbEntryFormat.toEmbeddedEntry` / `useWorldbookExtras.extractWorldbookFromCard`）。
 *   📖 取证见 `docs/规格与计划/AI打标/AI打标-卡片材料字段与占比控制方案-v2.md` §2.3。
 *
 * 输出形态（纯文本；词条之间空行 ⇒ 与 `splitTextSegments` 的段落切分天然对齐）：
 *
 * ```text
 * 书名：X
 * 简介：…（有则送）
 * 词条数：N（另有 M 条已禁用，未送）
 *
 * 【<comment → 触发词 → 次级 → 无标题>】
 * 触发词：a、b · 次级：c · 常驻
 * <content>
 * ```
 *
 * 零 Vue / 零 Electron 依赖，可 `node --test` 直接测。
 */

/** 默认选项（调用方一般只需传 `name` = 显示名口径 `wbDisplayName`） */
export const WB_MATERIAL_DEFAULTS = {
    name: '',
    includeDescription: true,
    includeComment: true,
    includeTriggers: true,
    skipDisabled: true,
    includeCount: true,
    // 🩹 2026-10-03（真实 UI 手动测试暴露）：正文**未载入**时输出显式标注（默认 true）
    //    背景：预览首帧 / 读盘失败时若只输出「词条数：0」，看起来就像"这本书真的没有词条"
    //    —— 这正是 PK-31 那类"把瘦身态当真的空"的坑（方案 §4.5 承诺过不许显示成空）。
    pendingNote: true
};

/** 正文未载入时的显式标注（替代词条列表；发送链路由调用方负责先读正文，故正常情况下不会出现） */
export const WB_MATERIAL_PENDING_NOTE = '⚠️ 词条正文未载入（发送前会按需读取；预览内容稍后自动补全）';

/** 正文是否已载入（`dataLoaded === false` 或 `data` 缺失 ⇒ 视为未载入）
 *  🔑 **两种入参各判自己的口径**（AI-20 真机实测踩到，别只写一种）：
 *    · **库世界书** `{ data: { entries } }` ⇒ 判 `data` 存在（且 `dataLoaded !== false`）；
 *    · **角色卡**（`character_book` 在卡根 / `data` / `data.data`）⇒ 转 [`isEmbeddedBodyLoaded`](#isembeddedbodyloaded)，
 *      判「内嵌词条里有没有正文」（大库瘦身态下词条在、`content` 被清空 ⇒ 未载入）。
 *    ⚠️ 只判前者会让**卡对象恒判「未载入」**（卡上没有 `data.entries`）—— 真机上表现为
 *      「明明有 35 条内嵌词条，材料却说正文未载入」，与 AI-17 同型的假空。 */
export function isWbBodyLoaded(wb) {
    if (!wb || typeof wb !== 'object') return false;
    if (wb.dataLoaded === false) return false;
    if (bookHostOf(wb)) return isEmbeddedBodyLoaded(wb);   // 卡内嵌世界书口径
    const d = (wb.data && typeof wb.data === 'object') ? wb.data : null;
    return !!(d && (d.entries !== undefined || d.description !== undefined));
}

/** 任意形态 → 干净字符串数组（去空值；字符串当单项） */
export function toKeyArray(v) {
    if (Array.isArray(v)) {
        return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    }
    const s = String(v == null ? '' : v).trim();
    return s ? [s] : [];
}

/**
 * 词条集合 → 词条数组（字典形态 `{entries:{"0":{…}}}` / 数组 / 空；全形态安全）。
 * @param {*} raw 裸条目数组，或带 `entries` 的书载荷
 * @returns {Array<object>}
 */
function entriesOf(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Array.isArray(raw)) return raw.filter((e) => e && typeof e === 'object');
    const list = raw.entries;
    if (Array.isArray(list)) return list.filter((e) => e && typeof e === 'object');
    if (list && typeof list === 'object') return Object.values(list).filter((e) => e && typeof e === 'object');
    return [];
}

/**
 * 全形态安全提取词条数组（字典形态 / 数组 / 空）。
 * ⚠️ 只读 `wb.data`（与旧实现同源；**不碰** `wb` 顶层，避免与卡内嵌形态混淆）。
 *    —— 卡内嵌世界书请用 [`resolveWbEntries`](#resolvewbentries)（AI-20）。
 * @param {object} wb 世界书条目（含 `data`）
 * @returns {Array<object>}
 */
export function listWbEntries(wb) {
    const data = wb && wb.data ? wb.data : null;
    if (!data || typeof data !== 'object') return [];
    return entriesOf(data);
}

/** 禁用判定：内嵌口径 `enabled === false` 或 库口径 `disable === true`（两者任一为真即禁用） */
export function isEntryDisabled(e) {
    if (!e || typeof e !== 'object') return true;
    if (e.enabled === false) return true;
    if (e.disable === true) return true;
    return false;
}

/** 主触发词（双向回退：库 `key` → 内嵌 `keys`） */
export function entryPrimaryKeys(e) {
    const lib = toKeyArray(e && e.key);
    return lib.length ? lib : toKeyArray(e && e.keys);
}

/** 次级触发词（双向回退：库 `keysecondary` → 内嵌 `secondary_keys`） */
export function entrySecondaryKeys(e) {
    const lib = toKeyArray(e && e.keysecondary);
    return lib.length ? lib : toKeyArray(e && e.secondary_keys);
}

/**
 * 词条标题（**三级回退**）：
 *   `comment`（作者写的摘要，**第一优先**）→ `name`（旧卡）→ 主触发词首个 → 次级首词 → `''`
 */
export function entryTitle(e) {
    const comment = String((e && (e.comment || e.name)) || '').trim();
    if (comment) return comment;
    const p = entryPrimaryKeys(e);
    if (p.length) return p[0];
    const s = entrySecondaryKeys(e);
    return s.length ? s[0] : '';
}

/** 触发词行（`触发词：a、b · 次级：c · 常驻`；无任何内容返回 `''`） */
export function entryTriggerLine(e) {
    const seg = [];
    const keys = entryPrimaryKeys(e);
    const sec = entrySecondaryKeys(e);
    if (keys.length) seg.push(`触发词：${keys.join('、')}`);
    if (sec.length) seg.push(`次级：${sec.join('、')}`);
    if (e && e.constant === true) seg.push('常驻');
    return seg.join(' · ');
}

/**
 * 该入参形态下「放世界书的那个对象」（库：`{name, entries}` 或 `{data:{…}}`；卡：`character_book` 所在层）。
 *
 * ⚠️ **卡的数据层有两层**（真机实测 2026-10-04，别只探一层）：
 *   · 库卡片条目 = `{ id, path, name, data: <PNG 内嵌 JSON>, … }`
 *   · PNG 内嵌 JSON = `{ spec, spec_version, data: { name, description, character_book, … } }`
 *   ⇒ `character_book` 实际在 **`item.data.data.character_book`**。
 *   另有两种历史形态：`item.character_book`（V1 扁平卡）与 `item.data.character_book`（已解包）。
 *   **必须恰好探三层且顺序固定**（外层先看，`bookHostOf` 只负责回答"哪一层带书"）。
 */
function bookHostOf(wb) {
    if (!wb || typeof wb !== 'object') return null;
    if (wb.character_book && typeof wb.character_book === 'object') return wb;              // V1 扁平卡
    const d = (wb.data && typeof wb.data === 'object' && !Array.isArray(wb.data)) ? wb.data : null;
    if (d && d.character_book && typeof d.character_book === 'object') return d;            // 已解包
    const dd = (d && d.data && typeof d.data === 'object' && !Array.isArray(d.data)) ? d.data : null;
    if (dd && dd.character_book && typeof dd.character_book === 'object') return dd;        // ★ V2/V3 卡（现实形态）
    return null;
}

/**
 * 🌍 **全形态取书**（AI-20）：同时兼容「世界书库对象」与「角色卡」，返回统一的
 * `{ name?, description?, entries }`；取不到时返回 `null`（调用方按「没有世界书」处理，绝不抛错）。
 *
 * 形态表：
 * | 入参 | 命中 | 说明 |
 * | --- | --- | --- |
 * | 库世界书 `{ name, data:{description, entries} }` | `wb.data` | 独立世界书（扫描出来的对象） |
 * | 库世界书（已解包）`{ description, entries }` | 自身 | 调用方直接传 data |
 * | **角色卡（V2/V3）** `{ data:{ data:{ character_book:{…} } } }` | `wb.data.data.character_book` | ★ 现实形态（PNG 内嵌 JSON 再包一层） |
 * | **角色卡（已解包）** `{ data:{ character_book:{…} } }` | `wb.data.character_book` | 少数中间态 |
 * | **角色卡（V1 扁平）** `{ character_book:{…} }` | `wb.character_book` | 老卡 |
 * | 裸条目数组 / `{entries}` | 自身 | 兼容形态 |
 * @param {object} wb
 * @returns {{name?:string, description?:string, entries:*}|null}
 */
export function resolveWbBook(wb) {
    if (!wb || typeof wb !== 'object') return null;
    // ① 卡内嵌世界书（卡根 / data 下 / data.data 下）—— 优先（卡对象自带 name，不会误当书）
    const host = bookHostOf(wb);
    if (host) {
        const book = host.character_book;
        return (book && typeof book === 'object') ? book : null;
    }
    // ② 库世界书：`{ data: { entries } }`
    const d = (wb.data && typeof wb.data === 'object' && !Array.isArray(wb.data)) ? wb.data : null;
    if (d && (d.entries !== undefined || d.description !== undefined)) return d;
    // ③ 已解包的 data / 裸数组 / 裸 `{entries}`
    if (Array.isArray(wb)) return wb;
    if (wb.entries !== undefined) return wb;
    if (wb.description !== undefined) return wb;
    return null;
}

/**
 * 全形态安全提取「词条数组」，**库世界书与卡内嵌世界书共用**（AI-20）。
 * 内部复用与 `buildWbMaterial` 同一套形态判定（`entriesOf`），
 * 避免两处口径漂移 ⇒ 需要「只判有没有 / 有多少条」的调用方（如 `hasEmbeddedBook`）也走这里。
 * @param {object} wb 库世界书对象 / 角色卡 / 裸书载荷
 * @returns {Array<object>} 永不为 null
 */
export function resolveWbEntries(wb) {
    const book = resolveWbBook(wb);
    if (!book) return [];
    return entriesOf(book);
}

/**
 * 🃏 角色卡是否带**内嵌世界书**（有词条才算；AI-20 —— 卡上「🌍 徽标」的同一判据）。
 * ⚠️ 只看「有没有词条」，不看正文是否已载入（大库瘦身态下词条对象仍在、只是 `content` 被清空，
 *    见 `js/utils/cardSlim.js`）。
 * @param {object} card 库卡片条目（`data.data.character_book` / `data.character_book` / `character_book`）
 * @returns {boolean}
 */
export function hasEmbeddedBook(card) {
    return resolveWbEntries(card).length > 0;
}

/**
 * 🩹 内嵌世界书的**正文是否已载入**（大库瘦身态 / 读盘失败时为 false）。
 * ⚠️ 与 `isWbBodyLoaded` 是**不同口径**：后者判的是库世界书对象的 `data`（卡对象上没有这个字段，
 *    拿它判卡会**恒判未载入**）；本函数判「卡内嵌书里有没有正文」，与 `cardSlim.slimCard` 清空的是同一处。
 * @param {object} card 角色卡（或库世界书；库里没有 `content` 字段 ⇒ 恒 true，不影响调用方）
 * @returns {boolean} true = 至少一条词条有正文；没有词条时也返回 true（"没有书"不等于"没载入"）
 */
export function isEmbeddedBodyLoaded(card) {
    const entries = resolveWbEntries(card);
    if (!entries.length) return true;
    for (const e of entries) {
        if (typeof (e && e.content) === 'string' && e.content.length) return true;
    }
    return false;
}

/**
 * 构建一本世界书的打标材料。
 * @param {object} wb 世界书条目 —— **三种入参都支持**（AI-20）：
 *   ① 库世界书 `{ name|wbName, data:{ description, entries } }`；
 *   ② **角色卡**（`character_book` 在卡根或 `data` 下）—— 即「卡内嵌世界书」；
 *   ③ 裸书载荷 `{ description, entries }` / 裸条目数组。
 * @param {object} [opts] 见 `WB_MATERIAL_DEFAULTS`；`name` 建议传显示名（`wbDisplayName(wb)`）
 * @returns {string} 材料文本；取不到书时返回 `''`（调用方按「无词条内容可打标」处理）
 */
export function buildWbMaterial(wb, opts = {}) {
    if (!wb || typeof wb !== 'object') return '';
    const o = { ...WB_MATERIAL_DEFAULTS, ...(opts || {}) };
    const name = String(o.name || wb.wbName || wb.name || '未命名');
    const data = resolveWbBook(wb);
    const all = resolveWbEntries(wb);
    const entries = o.skipDisabled ? all.filter((e) => !isEntryDisabled(e)) : all;
    const disabledCount = all.length - entries.length;

    const parts = [`书名：${name}`];

    if (o.includeDescription && data) {
        const desc = String(data.description == null ? '' : data.description).trim();
        if (desc) parts.push(`简介：${desc}`);
    }
    // 🩹 正文未载入 ⇒ **显式标注**（绝不装作"词条数 0"）
    if (!isWbBodyLoaded(wb) && o.pendingNote) {
        parts.push(WB_MATERIAL_PENDING_NOTE);
        return parts.join('\n\n');
    }
    if (o.includeCount) {
        parts.push(`词条数：${entries.length}${disabledCount > 0 ? `（另有 ${disabledCount} 条已禁用，未送）` : ''}`);
    }

    for (const e of entries) {
        const blocks = [];
        if (o.includeComment) {
            const title = entryTitle(e);
            blocks.push(title ? `【${title}】` : '【无标题】');
        }
        if (o.includeTriggers) {
            const line = entryTriggerLine(e);
            if (line) blocks.push(line);
        }
        const content = String(e.content == null ? '' : e.content);
        if (content) blocks.push(content);
        if (blocks.length) parts.push(blocks.join('\n'));
    }

    return parts.join('\n\n');
}

export default {
    WB_MATERIAL_DEFAULTS, buildWbMaterial, listWbEntries,
    // 🌍 AI-20：卡内嵌世界书（`character_book`）与库世界书共用的取书入口
    resolveWbBook, resolveWbEntries, hasEmbeddedBook, isEmbeddedBodyLoaded,
    isEntryDisabled, entryTitle, entryPrimaryKeys, entrySecondaryKeys, entryTriggerLine, toKeyArray
};
