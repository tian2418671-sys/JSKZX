/**
 * 🌍 世界书打标材料构建 —— **纯函数**（四处消费点同源：① 规则层 / ② 向量层 / ③ LLM 层 / 预览区）
 *
 * ═══════════════════════════════════════════════════════════════
 * 🩹 修 AI-14（2026-10-03）：旧实现 `useAITools.buildMaterial` **用触发词 `key` 当词条标题**，
 *   把作者写的词条名 `comment` 整块丢掉；书级 `description`、次级触发词、`constant`（常驻）
 *   也都不送；且**不跳过禁用词条** ⇒ AI 只拿到「零信息量标题（`{{user}}` / 你 / 我）+ 正文」，
 *   打标偏泛偏错（用户反馈「打标失误太大」）。
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

/** 正文是否已载入（`dataLoaded === false` 或 `data` 缺失 ⇒ 视为未载入） */
export function isWbBodyLoaded(wb) {
    if (!wb || typeof wb !== 'object') return false;
    if (wb.dataLoaded === false) return false;
    return !!(wb.data && typeof wb.data === 'object');
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
 * 全形态安全提取词条数组（字典形态 `{entries:{"0":{…}}}` / 数组 / 空）。
 * ⚠️ 只读 `wb.data`（与旧实现同源；**不碰** `wb` 顶层，避免与卡内嵌形态混淆）。
 * @param {object} wb 世界书条目（含 `data`）
 * @returns {Array<object>}
 */
export function listWbEntries(wb) {
    const data = wb && wb.data ? wb.data : null;
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data)) return data.filter((e) => e && typeof e === 'object');
    const raw = data.entries;
    if (Array.isArray(raw)) return raw.filter((e) => e && typeof e === 'object');
    if (raw && typeof raw === 'object') return Object.values(raw).filter((e) => e && typeof e === 'object');
    return [];
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
 * 构建一本世界书的打标材料。
 * @param {object} wb 世界书条目（`{ name|wbName, data:{ description, entries } }`）
 * @param {object} [opts] 见 `WB_MATERIAL_DEFAULTS`；`name` 建议传显示名（`wbDisplayName(wb)`）
 * @returns {string} 材料文本；`wb` 为空时返回 `''`（调用方按「无词条内容可打标」处理）
 */
export function buildWbMaterial(wb, opts = {}) {
    if (!wb || typeof wb !== 'object') return '';
    const o = { ...WB_MATERIAL_DEFAULTS, ...(opts || {}) };
    const name = String(o.name || wb.wbName || wb.name || '未命名');
    const data = (wb.data && typeof wb.data === 'object') ? wb.data : null;
    const all = listWbEntries(wb);
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
    isEntryDisabled, entryTitle, entryPrimaryKeys, entrySecondaryKeys, entryTriggerLine, toKeyArray
};
