/**
 * 插件类型分类器（纯函数，供 node --test 直接单测）
 *
 * ── 为什么需要分类 ───────────────────────────────────────────────────────
 * 「效果」页最初把所有插件一股脑丢进沙箱跑脚本。但真实插件库里：
 *   · `晦明v2.6.json` 是**纯配色 JSON**，没有一行代码 → 跑脚本必然空
 *   · `发送前最后正则.json`、`玉藻前一键写卡器.json` 是**纯后台逻辑**，本来就没有界面
 * 用户看到空白只会认为「软件坏了」。分类后各走各的呈现方式，才不会误导。
 *
 * 判定顺序（先强后弱，避免误判）：
 *   1. kind === 'extension'            → EXTENSION（扩展工程，有 manifest + bundle）
 *   2. 顶层 ≥3 个酒馆配色字段          → THEME（纯样式，不跑脚本）
 *   3. 有 .html 模板或 .css            → DOM_SCRIPT
 *   4. 源码里有 DOM 操作 / 弹窗输出    → DOM_SCRIPT
 *   5. 其余                            → LOGIC（后台逻辑，给能力卡）
 */

export const PLUGIN_KIND = {
    THEME: 'theme',
    LOGIC: 'logic',
    DOM_SCRIPT: 'domScript',
    EXTENSION: 'extension',
};

/** 酒馆 UI 主题 JSON 的配色字段（晦明v2.6 等主题文件顶层就是这些） */
export const THEME_COLOR_KEYS = [
    'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
    'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color',
    'shadow_color', 'border_color', 'blur_strength',
];

/**
 * 「会产出可见界面」的迹象。
 * 注意：只用于**分类呈现方式**，不用于决定「是否尝试渲染」——
 * 后者永远先跑，跑完没内容才展示能力卡（上游 Q5 拍板：透视卡绝不阻止渲染）。
 *
 * [!] 2026-11-08 踩坑：原来用裸 `/\$\(/` 判定 jQuery，结果把酒馆助手的
 *    **包装函数 `$(errorCatched(() => {...}))`** 误判成 DOM 操作
 *    → 「发送前最后正则」这种纯逻辑脚本被判成 `domScript`
 *    → 能力卡分支不触发 → 用户看到的还是空白。
 *    修正：`$(` 后面必须跟**选择器/HTML**（引号或 `<`）才算真的在操作 DOM。
 */
const DOM_OP_HINTS = [
    /\$\(\s*['"`]/,                       // $('.x') / $("#id") / $('<div>')
    /\$\(\s*</,                           // $(<div>) 少见但合法
    /jQuery\s*\(\s*['"`]/,
    /document\.(createElement|querySelector|getElementById|body\.append)/,
    /\.append(To)?\s*\(/, /\.prepend\s*\(/, /\.html\s*\(/, /\.innerHTML\s*=/,
    /insertAdjacentHTML/, /renderExtensionTemplate/,
    /SlashRunner\.(showMessage|renderPanel)/, /toastr\./,
    /callGenericPopup/,
];

/** 提取插件里的全部脚本源码 */
export function extractAllScriptCode(plugin) {
    if (!plugin) return '';
    const parts = [];
    for (const s of (plugin.scripts || [])) {
        if (s && typeof s.content === 'string' && s.content) parts.push(s.content);
    }
    // 少数条目把源码放在 content 顶层
    if (!parts.length && typeof plugin.content === 'string') parts.push(plugin.content);
    return parts.join('\n');
}

/** 插件里是否有 HTML 模板或 CSS 资产 */
export function hasHtmlOrCssAssets(plugin) {
    if (!plugin) return false;
    const files = plugin.files || [];
    for (const f of files) {
        const low = String(f).toLowerCase();
        if (low.endsWith('.html') || low.endsWith('.htm') || low.endsWith('.css')) return true;
    }
    return false;
}

/** 统计顶层命中多少个酒馆配色字段 */
export function countThemeColorKeys(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
    let n = 0;
    for (const k of THEME_COLOR_KEYS) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) n++;
    }
    return n;
}

/**
 * 分类插件
 * @param {object} plugin 插件模型（见 js/utils/pluginScanner.js）
 * @param {object} [extra] 补充信息
 * @param {object} [extra.rawJson] 原始 JSON 对象（用于主题判定；缺失时尝试从 scripts 解析）
 * @returns {{kind:string, reason:string, themeKeys?:string[]}}
 */
export function classifyPlugin(plugin, extra = {}) {
    if (!plugin) return { kind: PLUGIN_KIND.LOGIC, reason: '空插件' };

    // ① 扩展工程
    if (plugin.kind === 'extension' || plugin.manifest) {
        return { kind: PLUGIN_KIND.EXTENSION, reason: '扩展工程（manifest + bundle）' };
    }

    // ①b 扫描阶段已判定的主题（pluginScanner 给出 kind='theme' + themeData）
    if (plugin.kind === 'theme') {
        const keys = plugin.themeData && typeof plugin.themeData === 'object'
            ? THEME_COLOR_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(plugin.themeData, k))
            : [];
        return { kind: PLUGIN_KIND.THEME, reason: '扫描阶段已识别为 UI 主题', themeKeys: keys };
    }

    // ② UI 主题：顶层配色字段 ≥ 3
    let rawObj = (extra && extra.rawJson) || plugin.rawJson || plugin.themeData || null;
    if (!rawObj && typeof plugin.content === 'string') {
        // 有些条目把整个 JSON 塞进 content
        try {
            const parsed = JSON.parse(plugin.content);
            if (parsed && typeof parsed === 'object') rawObj = parsed;
        } catch (e) { /* 不是 JSON，忽略 */ }
    }
    const colorHits = countThemeColorKeys(rawObj);
    if (colorHits >= 3) {
        const keys = THEME_COLOR_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(rawObj, k));
        return { kind: PLUGIN_KIND.THEME, reason: `命中 ${colorHits} 个主题配色字段`, themeKeys: keys };
    }

    // ③ 有 HTML/CSS 资产
    if (hasHtmlOrCssAssets(plugin)) {
        return { kind: PLUGIN_KIND.DOM_SCRIPT, reason: '含 HTML 模板或 CSS 资产' };
    }

    // ④ 源码里有 DOM 操作
    const code = extractAllScriptCode(plugin);
    for (const re of DOM_OP_HINTS) {
        if (re.test(code)) {
            return { kind: PLUGIN_KIND.DOM_SCRIPT, reason: `源码含界面迹象（${re}）` };
        }
    }

    // ⑤ 纯后台逻辑
    return { kind: PLUGIN_KIND.LOGIC, reason: '未检测到界面产出迹象（后台逻辑脚本）' };
}

/** 供 UI 显示的中文标签 */
export function pluginKindLabel(kind) {
    switch (kind) {
        case PLUGIN_KIND.THEME: return 'UI 主题';
        case PLUGIN_KIND.LOGIC: return '后台逻辑';
        case PLUGIN_KIND.DOM_SCRIPT: return '界面脚本';
        case PLUGIN_KIND.EXTENSION: return '扩展工程';
        default: return '未知';
    }
}
