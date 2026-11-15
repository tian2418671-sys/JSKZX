/**
 * dropRouter.js — 拖拽导入「按内容分流」判定（纯函数）
 *
 * 🐞 2026-10-25 真 bug（用户实测）：
 *    「拖动导入世界书是角色卡，拖动导入预设也是角色卡；拖动导入后预设库没有、角色卡库也没有」
 *
 *  根因：`useCardCrud.handleDrop` 拿到文件后**不做任何类型判断**，先用
 *        `file:copyToLibrary` 把文件**复制进卡库目录**，再走 `parseAndAddCard`。
 *        而 `parseAndAddCard` 内的 `isCharacterCardData` 会拒绝非角色卡 ⇒
 *        结果是「文件已经躺进卡库文件夹，但没入库」：
 *          · 世界书库 / 预设库：完全没变（用户说的「没有」）；
 *          · 角色卡库：目录里多了一个解析不了的垃圾文件（用户说的「是角色卡」）。
 *
 *  修法：拖入时**先读内容判类型**，再分别落到对应库；判不出来的仍按角色卡处理（保持旧行为）。
 *
 * 判定优先级（从最强特征到最弱）：
 *   1. 角色卡 —— 有 `spec: chara_card_v2/v3` + `data`，或有角色名 + 角色内容字段
 *   2. 世界书 —— 顶层 `entries`，或 `data.entries`（且无 `character_book`），或 entries 对象字典
 *   3. 预设 —— 酒馆预设特征：`prompts`/`prompt_order`/`temperature`+`max_context` 等采样参数
 *   4. 其余 —— 交给角色卡流程（`parseAndAddCard` 会自行拒绝并记录原因，行为与旧版一致）
 *
 * ⚠️ 本文件只做**判定**，不碰文件系统、不发 IPC —— 便于单测与复用。
 */

/** 拖入分流的五种结果 */
export const DROP_KIND = {
    CARD: 'card',        // 角色卡 → 卡库
    WORLDBOOK: 'worldbook', // 世界书 → 世界书库
    PRESET: 'preset',    // 预设 → 预设库
    PLUGIN: 'plugin',    // 插件/脚本 → 插件库（用户口中的「脚本」就是插件）
    UNKNOWN: 'unknown'   // 认不出 → 走角色卡流程（由 parseAndAddCard 决定收/拒）
};

/**
 * 判断是否为世界书数据。
 *
 * 兼容形态（实测酒馆生态）：
 *   A. `{ entries: { "0": {...}, "1": {...} } }`   —— 原生世界书（字典）
 *   B. `{ entries: [ {...}, {...} ] }`             —— 数组形态
 *   C. `{ data: { entries: [...] } }`              —— 部分导出工具包一层 data（无 character_book）
 *
 * ⚠️ 角色卡里也可能有 `character_book.entries`（内嵌世界书）—— 这里**只认顶层/data 下的 entries**，
 *    带 `character_book` 的不算独立世界书（否则角色卡会被误判成世界书）。
 * @param {any} data
 * @returns {boolean}
 */
export function looksLikeWorldbook(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    // 角色卡优先：带角色特征的一律不算世界书（避免误判内嵌世界书）
    if (isCardLike(data)) return false;

    // A/B：顶层 entries
    if (data.entries !== undefined && data.entries !== null) {
        if (Array.isArray(data.entries)) {
            // 空数组不算世界书（避免把 `{entries:[]}` 这种空壳当世界书）
            if (data.entries.length === 0) return false;
            // 数组元素是对象才认（排除 `{entries:["a","b"]}` 这种字符串数组）
            return data.entries.some((e) => e && typeof e === 'object');
        }
        if (typeof data.entries === 'object') {
            const keys = Object.keys(data.entries);
            // 空对象不算世界书（避免把 `{entries:{}}` 这种空壳当世界书）
            if (keys.length === 0) return false;
            // 字典形态：值是对象且带世界书词条常见字段
            const first = data.entries[keys[0]];
            if (first && typeof first === 'object') return true;
        }
    }

    // C：data.entries（且明确不是角色卡内嵌世界书）
    if (data.data && typeof data.data === 'object' && !data.data.character_book) {
        const e = data.data.entries;
        if (Array.isArray(e) && e.length > 0) return true;
        if (e && typeof e === 'object' && Object.keys(e).length > 0) return true;
    }

    return false;
}

/**
 * 判断是否为酒馆「预设」（preset）数据。
 *
 * 实测预设 JSON 的强特征（任一命中即可，且不能是角色卡/世界书）：
 *   · `prompts` 数组（提示词列表）—— 几乎每个预设都有
 *   · `prompt_order` —— 提示词排序
 *   · `temperature` + `max_context`（+ 可能的 top_p/frequency_penalty）—— 采样参数组
 *   · `wrap_in_quotes` / `names_behavior` / `continue_prefill` —— 酒馆预设专有开关
 *
 * ⚠️ 必须排除角色卡：V2 卡也可能有 `data.temperature`（少见），所以先用 isCardLike 挡掉。
 * @param {any} data
 * @returns {boolean}
 */
export function looksLikePreset(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (isCardLike(data)) return false;
    if (looksLikeWorldbook(data)) return false;

    // ① 强特征：提示词列表 / 排序
    if (Array.isArray(data.prompts)) return true;
    if (Array.isArray(data.prompt_order)) return true;

    // ② 酒馆预设专有开关
    if (data.wrap_in_quotes !== undefined) return true;
    if (data.names_behavior !== undefined) return true;
    if (data.continue_prefill !== undefined) return true;

    // ③ 采样参数组合：temperature 与 max_context 同时出现才认（单独一个太容易误判）
    const hasTemp = typeof data.temperature === 'number';
    const hasCtx = typeof data.max_context === 'number' || typeof data.openai_max_context === 'number';
    if (hasTemp && hasCtx) return true;

    return false;
}

/**
 * 粗判「像角色卡」（供上面两个函数做排除用）。
 *
 * 与 `cardLoader.isCharacterCardData` 口径保持一致，但**不 import** 它 ——
 * 避免循环依赖（cardLoader 是重模块），且这里只需要「保守地排除」。
 * 真正的严格校验仍由 `parseAndAddCard` 内的 `isCharacterCardData` 负责。
 * @param {any} data
 * @returns {boolean}
 */
export function isCardLike(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

    // V2/V3：spec + data
    if (typeof data.spec === 'string' && /^chara_card_v[23]$/i.test(data.spec.trim())) {
        return !!(data.data && typeof data.data === 'object');
    }

    // 🐞 2026-10-25 真 bug（拖拽热测抓获）：
    //    独立世界书通常也带 `name` + `description`（酒馆世界书就是 {name, description, entries}），
    //    而旧写法把「有 name + 有 description」直接当成 V1 角色卡 ⇒ **世界书永远被判成角色卡**，
    //    分流完全失效。所以这里必须先排除「顶层 entries」这一世界书最强特征。
    //    ⚠️ 只排除**顶层** entries：角色卡的 `data.character_book.entries` 不在此列（下面仍按角色卡判）。
    if (hasTopLevelWorldbookEntries(data)) return false;

    // 带角色内容字段（任一）
    const hasBody = ['description', 'personality', 'first_mes', 'scenario', 'mes_example']
        .some((k) => typeof data[k] === 'string' && data[k].length > 0);

    // V1：name + 角色内容
    if (typeof data.name === 'string' && data.name.trim() !== '') {
        // 酒馆配置 / 破限 / 快速回复 不算角色卡
        if (data.system_settings || data.api_keys || data.public_api) return false;
        return hasBody;
    }

    // 没有 name 但 data 里带完整角色字段（部分工具导出会省掉外层 name）
    if (data.data && typeof data.data === 'object') {
        const d = data.data;
        const innerBody = ['description', 'personality', 'first_mes', 'scenario', 'mes_example']
            .some((k) => typeof d[k] === 'string' && d[k].length > 0);
        const innerName = typeof d.name === 'string' && d.name.trim() !== '';
        if (innerName && innerBody) {
            // 同样是世界书特征时以世界书为准
            return !hasTopLevelWorldbookEntries(d);
        }
    }

    return false;
}

/**
 * 是否为「顶层 entries 型世界书」——角色卡判定必须先排除它。
 * @param {any} data
 * @returns {boolean}
 */
function hasTopLevelWorldbookEntries(data) {
    const e = data && data.entries;
    if (e === undefined || e === null) return false;
    if (Array.isArray(e)) return e.length > 0 && e.some((x) => x && typeof x === 'object');
    if (typeof e === 'object') {
        const keys = Object.keys(e);
        if (!keys.length) return false;
        const first = e[keys[0]];
        return !!(first && typeof first === 'object');
    }
    return false;
}

/**
 * 判断是否为「插件 / 脚本」数据（用户口中的「脚本」= 插件库）。
 *
 * 覆盖三类（与 `pluginScanner.js` 的判定口径一致，避免两处漂移）：
 *   A. 酒馆助手 JSON 脚本 —— 有 `content` 字符串 + (id/name/buttons)，且**不是**卡/书/预设
 *   B. 扩展工程 manifest —— `manifest_version` / `extensions[]` / `display_name + js|css`
 *   C. 正则脚本 JSON —— 有 `scriptName` + `findRegex`（酒馆正则规则的标准字段）
 *   D. 快捷回复集（QR）—— 有 `disableSend` / `injectInput` / `placeBeforeInput`
 *   E. 酒馆配置文件 —— `system_settings` / `api_keys` / `public_api` / `apiType`
 *
 * ⚠️ 用户在 2026-10-25 明确说「脚本 = 插件库，只是名字叫法不同」，
 *    所以这些**全部归 PLUGIN**，拖入后进插件库，不再被当角色卡拒掉。
 * @param {any} data
 * @returns {boolean}
 */
export function looksLikePlugin(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    // 角色卡 / 世界书 / 预设优先，其余才可能是插件
    if (isCardLike(data)) return false;
    if (looksLikeWorldbook(data)) return false;
    if (looksLikePreset(data)) return false;

    // A. 酒馆助手 JSON 脚本（含 content JS 字符串）
    if (typeof data.content === 'string' && data.content.trim()) {
        if (data.id || data.name || Array.isArray(data.buttons)) return true;
    }

    // B. 扩展工程 manifest
    if (data.manifest_version !== undefined) return true;
    if (Array.isArray(data.extensions) && data.extensions.length > 0) return true;
    if (typeof data.display_name === 'string' && data.display_name.trim()) {
        if (typeof data.js === 'string' && data.js.trim()) return true;
        if (typeof data.css === 'string' && data.css.trim()) return true;
    }

    // C. 正则脚本（酒馆 Regex 扩展导出的规则）
    if (typeof data.scriptName === 'string' || typeof data.findRegex === 'string') {
        // 至少要有一个正则相关字段，避免误吞普通配置
        if (typeof data.findRegex === 'string' || typeof data.replaceString === 'string') return true;
    }

    // D. 快捷回复集（QR）
    if (data.disableSend !== undefined || data.injectInput !== undefined || data.placeBeforeInput !== undefined) {
        return true;
    }

    // E. 酒馆配置文件（API 配置 / 破限 等）
    if (data.system_settings || data.api_keys || data.public_api) return true;
    if (data.apiType !== undefined || data.openAIKey !== undefined || data.jailbreak !== undefined) return true;

    // F. 酒馆 UI 主题 / 界面设置（2026-10-25 实测 `晦明v2.6.json` 命中此分支）
    //    典型字段：blur_strength / main_text_color / chat_width / custom_css / font_scale …
    //    ⚠️ 用「多个配色/UI 字段同时出现」判定，别用单个字段（防误吞别的配置）。
    const THEME_HINTS = [
        'blur_strength', 'main_text_color', 'italics_text_color', 'quote_text_color',
        'blur_tint_color', 'chat_tint_color', 'shadow_color', 'border_color', 'font_scale',
        'custom_css', 'chat_width', 'avatar_style', 'fast_ui_mode', 'compact_input_area'
    ];
    const themeHits = THEME_HINTS.filter((k) => k in data).length;
    if (themeHits >= 3) return true;

    return false;
}

/**
 * 判断是否为 `.js` 脚本文件（按文件名，不读内容）。
 * 用户明确要求 `.js` 也归插件库。
 * @param {string} fileName
 * @returns {boolean}
 */
export function isScriptFileName(fileName) {
    return /\.(js|mjs|cjs)$/i.test(String(fileName || ''));
}

/**
 * 主入口：判定一个已解析的 JSON 数据属于哪一类（供拖拽导入分流）。
 * @param {any} data 已 `JSON.parse` 的对象
 * @returns {{kind: string, reason: string}}
 *   kind ∈ DROP_KIND；reason 为可读原因（写日志 / 提示用）
 */
export function classifyDroppedJson(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        // 数组：世界书（entries 数组直接导出）或聊天记录，交给角色卡流程判断
        return { kind: DROP_KIND.UNKNOWN, reason: '非对象数据' };
    }

    if (isCardLike(data)) return { kind: DROP_KIND.CARD, reason: '角色卡特征（spec/角色名+内容字段）' };

    if (looksLikeWorldbook(data)) return { kind: DROP_KIND.WORLDBOOK, reason: '世界书特征（顶层 entries）' };

    if (looksLikePreset(data)) return { kind: DROP_KIND.PRESET, reason: '预设特征（prompts/采样参数）' };

    if (looksLikePlugin(data)) return { kind: DROP_KIND.PLUGIN, reason: '插件/脚本特征（content/manifest/正则/QR/配置）' };

    return { kind: DROP_KIND.UNKNOWN, reason: '无法判定类型' };
}

/**
 * 给一批拖入文件做分流计划（纯计算，不碰 IO）。
 * @param {Array<{name: string, kind: string}>} items 每项含文件名与 `classifyDroppedJson` 的结果
 * @returns {{cards: Array, worldbooks: Array, presets: Array, plugins: Array, unknown: Array}}
 */
export function planDrop(items) {
    const out = { cards: [], worldbooks: [], presets: [], plugins: [], unknown: [] };
    for (const it of (Array.isArray(items) ? items : [])) {
        if (!it) continue;
        if (it.kind === DROP_KIND.CARD) out.cards.push(it);
        else if (it.kind === DROP_KIND.WORLDBOOK) out.worldbooks.push(it);
        else if (it.kind === DROP_KIND.PRESET) out.presets.push(it);
        else if (it.kind === DROP_KIND.PLUGIN) out.plugins.push(it);
        else out.unknown.push(it);
    }
    return out;
}
