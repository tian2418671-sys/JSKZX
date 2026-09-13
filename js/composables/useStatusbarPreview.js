/**
 * 角色卡渲染预览器（Composable）——美化 / 状态栏
 * 从正则脚本域衍生的独立功能：把 AI 输出的状态文本块应用卡内正则脚本，
 * 实时预览酒馆聊天中渲染出的 HTML 效果（所见即所得调试）。
 *
 * 核心能力：
 *   ① 渲染型脚本识别：replaceString 含 HTML 标签且未禁用的脚本视为「渲染型」（美化/状态栏均覆盖），
 *      多脚本并存可勾选隔离调试
 *   ② 候选数据源扫描：自动从 开场白 / 备用开场白 / 聊天测试记录 收集状态文本块，
 *      一键导入（单个或拼接全部），解决「数据从哪来」问题
 *   ③ 正则引擎模拟：按酒馆语义顺序应用脚本（String.replace，$1 等捕获组原生支持）
 *   ④ 外链 GUI 支持：识别 <body><script>$('body').load('URL')</script></body> 格式，
 *      提取 URL 经沙箱 iframe 直接加载（CDN 分发的状态栏界面）
 *   ⑤ 安全预览：内联 HTML 经 DOMPurify 白名单清洗；外链 GUI 走 sandbox iframe（无同源权限）
 *   ⑥ 内置模板：一键向当前卡注入 <status> 渲染正则（无现成脚本的卡片开箱即用）
 *
 * 共享状态（regexScripts / safeData 派生链）与工具（getRegexUid / refreshCardData 等）
 * 保留在 App.vue 并注入；chatHistory 经 getter 延迟绑定（useChat 调用时序晚于本函数）。
 */
import { ref, computed, watch } from 'vue';
import DOMPurify from 'dompurify';
import { STATUSBAR_TEMPLATES, STATUSBAR_TEMPLATE_META, findStatusbarTemplate } from '../utils/statusbarTemplates.js';
import { STATUSBAR_PROMPT_TEMPLATES, STATUSBAR_PROMPT_META, findStatusbarPrompt } from '../utils/statusbarPromptTemplates.js';

// 解析脚本里的正则字符串 → RegExp；兼容 '/pattern/flags' 与裸 'pattern' 两种写法
// 返回 null 表示非法正则（调用方跳过该脚本，绝不抛错卡死预览）
// 🔒 安全加固：杜绝「模块片段 / 半截正则」被无脑当作有效正则导入
// ⚠️ 本函数经 export 供测卡渲染链路复用（移动版同名模块亦为导出，两端保持同签名）
export function parseRegexPattern(str) {
    const raw = String(str || '').trim();
    if (!raw) return null;

    // 🔒 模块片段过滤：如果内容明显是 JS 代码（模块/声明/控制流关键字），
    //    且不包含正则常见元字符集 → 判定为代码片段而非正则，直接拒绝
    const codeKeywords = /(?:^|\s|;)(?:import\s+|export\s+(?:default\s+)?|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|function\s+\w+\s*\(|class\s+\w+|module\.exports\s*=|require\s*\(|return\s+|if\s*\(|for\s*\(|while\s*\()/;
    const regexMetaChar = /[.*+?^${}()|[\]\\]|\\[dwsbDWBS]|\{\d+(?:,\d*)?\}/;
    if (codeKeywords.test(raw) && !regexMetaChar.test(raw) && raw.length > 30) {
        return null;
    }

    const m = raw.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (m) {
        // ✅ 完整的 '/pattern/flags' 格式：正常解析
        const flags = m[2].includes('g') ? m[2] : m[2] + 'g'; // 预览场景必须全局替换（与酒馆一致）
        try { return new RegExp(m[1], flags); } catch (e) { return null; }
    }

    // 🔒 半截正则防护：如果原文以 '/' 开头但未匹配完整的 /pattern/flags 格式，
    //    说明是不完整的正则片段（如 '/abc'、'/foo|bar'），禁止 fallback 到裸字符串，
    //    否则会被 new RegExp('/abc','g') 错误地构造成「匹配字面量斜杠 a b c」的伪正则
    if (raw.startsWith('/')) return null;

    // 🔒 裸字符串模式二次校验：长度过长且几乎无正则元字符 + 含换行/大段空白 → 文本块而非正则
    if (raw.length > 200 && !regexMetaChar.test(raw)) return null;

    // 正常裸 pattern 路径（与酒馆一致：全局替换）
    try { return new RegExp(raw, 'g'); } catch (e) { return null; }
}

// 实体反转义：部分卡的模板 HTML 被整体转义存储（&lt;div&gt;...），检测与预览前须还原
function unescapeHtmlEntities(str) {
    const s = String(str || '');
    if (!/&(lt|gt|quot|apos|#39);/i.test(s)) return s;
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// 🚀 对齐酒馆 addDOMPurifyHooks：链接强制新窗口打开，防点击链接把页面整体导航走
let sanitizeHooksInstalled = false;
function installSanitizeHooks() {
    if (sanitizeHooksInstalled) return;
    sanitizeHooksInstalled = true;
    try {
        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
            if (node.tagName === 'A') {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });
    } catch (e) { /* 钩子失败不影响主流程 */ }
}

/**
 * DOMPurify 白名单清洗（测卡消息文本段渲染用；与移动版 `composables/useStatusbarPreview.js`
 * 的同名导出逐行对齐，保证两端渲染行为一致）
 *  - 剥离 Markdown 代码块围栏 / loader 直链块，禁止事件属性与外联追踪
 *  - 放行 <a href>（http/https/mailto/tel）+ 新窗口钩子，使标题/列表/表格等 Markdown 全量生效
 *
 * ⚠️ 与下方 useStatusbarPreview 内部的 `sanitizePreviewHtml` 是两条独立管线：
 *    后者是状态栏预览既有实现（不放开 <a>/href），本次刻意不改动以免影响既有预览行为；
 *    两者策略接近但白名单不同，后续如需合并请先回归状态栏预览。
 */
export function sanitizeStatusHtml(text) {
    if (!text) return '';
    installSanitizeHooks();
    let t = String(text);
    // 🧹 剥离 Markdown 代码块围栏（```html ```json 等）
    t = t.replace(/```[a-zA-Z]*\n?/gi, '').replace(/```/g, '');
    // loader/script 直链块交给 iframe 渲染，清洗前先剥离（DOMPurify 必删 <script>，留着会出现空壳）
    const textWithoutLoader = extractLoaderUrls(t).length > 0
        ? t.replace(/\$\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*['"][^'"]+['"]\s*\)\s*;?/gi, '')
             .replace(/<script[^>]*>\s*\$\(\s*['"]body['"][\s\S]*?<\/script>/gi, '')
             .replace(/<(?:script|iframe)[^>]+src\s*=\s*['"]https?:\/\/[^'"]+['"][^>]*>(?:[\s\S]*?<\/script>)?/gi, '')
        : t;
    return DOMPurify.sanitize(textWithoutLoader, {
        ALLOWED_TAGS: [
            'b', 'i', 'em', 'strong', 'u', 's', 'br', 'p', 'div', 'span', 'a',
            'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'img', 'hr',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'table', 'thead', 'tbody', 'tr', 'td', 'th',
            'progress', 'details', 'summary', 'font', 'center', 'small', 'sub', 'sup'
        ],
        ALLOWED_ATTR: ['class', 'style', 'src', 'alt', 'title', 'width', 'height', 'href',
            'align', 'valign', 'colspan', 'rowspan', 'bgcolor', 'color', 'max', 'value'],
        ALLOW_DATA_ATTR: false,
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'oninput', 'onanimationstart', 'onanimationend', 'onpointerdown', 'onpointerup', 'onpointermove', 'ondragstart', 'ondrop'],
        // 🚀 放行 http(s)/mailto/tel 链接与内嵌 base64 图；事件属性已被 FORBID_ATTR 全量拦截
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    });
}

// =========================================================
// 🧭 模板分类器：把脚本 replaceString 分为五类（杜绝「片段冒充模板」「代码形态漏检」）
//   loader   — 外链 GUI：$('body').load('URL')（宽松：不要求 <body> 包裹）或 <iframe> src 直链
//   html     — 完整 HTML 模板：有标签且有实际体量（样式/结构），可安全静态渲染
//   code     — 代码形态模板：含 <script>/JS 逻辑/CSS 动画的完整状态栏，经沙箱 srcdoc 运行
//   fragment — 片段级：单个简单标签的小修饰（<br>、<b>$1</b> 等），不构成完整模板，排除
//   none     — 纯文本替换，与渲染无关
// =========================================================
export function classifyTemplate(repStr) {
    const raw = String(repStr || '');
    // 转义态识别：反转义后出现标签而原文没有 → 存储时被转义了，用反转义版本
    const unescaped = unescapeHtmlEntities(raw);
    const text = (!/<[a-z][^>]*>/i.test(raw) && /<[a-z][^>]*>/i.test(unescaped)) ? unescaped : raw;

    // 🌐 loader：$('body').load('URL') 宽松匹配（单双引号/空格/换行/无 body 包裹均可）
    const loadMatch = text.match(/\$\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*['"]([^'"]+)['"]/i);
    if (loadMatch && /^https?:\/\//i.test(loadMatch[1].trim())) {
        return { type: 'loader', url: loadMatch[1].trim(), text };
    }
    // 🌐 loader 变体：<iframe src="URL"> 直链界面
    const iframeMatch = text.match(/<iframe[^>]+src\s*=\s*['"]([^'"]+)['"][^>]*>/i);
    if (iframeMatch && /^https?:\/\//i.test(iframeMatch[1].trim())) {
        return { type: 'loader', url: iframeMatch[1].trim(), text };
    }

    const hasTag = /<[a-z][^>]*>/i.test(text);
    // 🔧 扩展代码/样式信号：覆盖 jQuery 常见 DOM 写法（$.html/append/prepend/css）、
    //    内联 CSS 属性（color/display/background/font-size）、Flex/Grid 布局等
    const codeSign = /(<script|<style|function\s*\(|document\.|window\.|setInterval|setTimeout|querySelector|querySelectorAll|addEventListener|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|\.appendTo\s*\(|\.replaceWith\s*\(|\.before\s*\(|\.after\s*\(|\.css\s*\(|\.text\s*\(|\$\(|const\s+|let\s+|var\s+|=>|linear-gradient|radial-gradient|border-radius|animation\s*:|animation-name|@keyframes|transition\s*:|transform\s*:|display\s*:\s*(?:flex|grid|block|inline-block)|background\s*:|background-color|color\s*:|font-size\s*:|padding\s*:|margin\s*:|box-shadow\s*:|border\s*:)/i.test(text);
    const hasCaptureGroup = /\$[1-9&`']/.test(text);

    if (!hasTag && !codeSign && !hasCaptureGroup) return { type: 'none', url: null, text };

    // 🔧 模块片段过滤：纯 <script> 且不含捕获组 / DOM 渲染操作 → 静态注入而非状态栏
    //    扩展 DOM 渲染识别：不只 innerHTML/createElement，还覆盖 jQuery 常见写法
    if (/^\s*<script[^>]*>[\s\S]*<\/script>\s*$/i.test(text)) {
        const hasRenderOp = /(innerHTML|outerHTML|insertAdjacentHTML|createElement|appendChild|insertBefore|replaceChild|document\.write|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|\.appendTo\s*\(|\.replaceWith\s*\(|\.before\s*\(|\.after\s*\(|\.text\s*\()/i.test(text);
        if (!hasCaptureGroup && !hasRenderOp) {
            return { type: 'fragment', url: null, text };
        }
    }

    // 🔧 完整模板判定：扩展结构/样式信号，降低长度阈值（60→80 之间的状态栏模板很多）
    //    新增：<span>/<li>/<tr>/<progress>/<br> 与多个标签共存、内联 CSS 属性、class/id/data- 属性
    const hasRichStructure = /(<div|<table|<section|<article|<header|<footer|<nav|<style|<script|<iframe|<svg|<canvas|<progress|<meter|<details|<summary|<ul|<ol|<li|<tr|<td|<th|<figure|<figcaption)/i.test(text);
    const hasAttrOrStyle = /(style\s*=|class\s*=|id\s*=|data-[a-z-]+\s*=|on[a-z]+\s*=)/i.test(text);
    const hasInlineCss = /(?:^|[;{\s])(?:color|background(?:-color)?|font(?:-size|-family|-weight)?|padding|margin|border(?:-radius)?|width|height|display|position|flex|grid|box-shadow|text-shadow|opacity|overflow|transform|transition|animation|z-index|line-height|letter-spacing|text-align|vertical-align|white-space|word-break)\s*:/i.test(text);
    const multiTag = (text.match(/<[a-z][^>]*>/gi) || []).length >= 3; // 三个及以上标签共存 = 大概率完整模板
    const isFullTemplate = text.length >= 60
        || hasRichStructure
        || hasAttrOrStyle
        || hasInlineCss
        || multiTag
        || hasCaptureGroup;
    if (!isFullTemplate) return { type: 'fragment', url: null, text };

    // 完整模板内部再分：含可执行逻辑或样式块 → code（沙箱运行）；纯静态标签 → html（安全渲染）
    const isCode = /(<script|<style|function\s*\(|document\.|window\.|setInterval|setTimeout|setImmediate|requestAnimationFrame|querySelector|querySelectorAll|addEventListener|removeEventListener|fetch\s*\(|\.ajax\s*\(|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|\.css\s*\(|\$\(|XMLHttpRequest|Promise\.then|async\s+function|await\s+|localStorage|sessionStorage|indexedDB)/i.test(text);
    return { type: isCode ? 'code' : 'html', url: null, text };
}

// 从文本中提取全部外链 GUI 的 URL（仅 http/https 直链；输入可能是 AI 原文或脚本替换后的结果）
// 宽松策略：$('body').load('URL') 不要求 <body> 包裹；兼容 <script>/<iframe> src 直链
export function extractLoaderUrls(text) {
    if (!text) return [];
    // 剥离 ``` 围栏（AI 输出常把 loader 块包在代码块里，酒馆渲染时围栏会被正则一并吃掉）
    const cleaned = String(text).replace(/```[a-zA-Z]*\n?/gi, '').replace(/```/g, '');
    const urls = [];
    const patterns = [
        /\$\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*['"]([^'"]+)['"]/gi,
        /<(?:script|iframe)[^>]+src\s*=\s*['"]([^'"]+)['"][^>]*>/gi
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(cleaned)) !== null) {
            const url = m[1].trim();
            if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
        }
    }
    return urls;
}

// 演示文本：注入模板后开箱即见效果（<status> 块 + 普通文本对照）
const DEMO_INPUT = `<status>
❤️ 体力：85/100
💰 金钱：320
💕 好感度：42
📅 第 3 天 · 上午 · 晴
</status>

（状态块以外的 AI 回复会原样保留，只有 <status> 包裹的部分被渲染成面板）`;

export function useStatusbarPreview({
    regexScripts,          // 卡内正则脚本列表 computed（App.vue 正则域）
    ensureRegexScriptsArray, // 可写数组获取器（注入模板用，App.vue 正则域）
    getRegexUid,           // 脚本稳定标识（WeakMap 计数器，勾选状态 key）
    refreshCardData,       // shallowRef 手动刷新（注入后触发视图更新）
    safeData,              // 角色卡数据层 computed（扫描开场白/备用开场白）
    worldbookEntries,      // 角色卡内嵌世界书条目 computed（状态栏常写在世界书里，文本/代码形态都有）
    ensureCharacterBookEntries, // 角色卡内嵌世界书 entries 获取器（注入指令模板用，App.vue 世界书域）
    getChatHistory,        // 聊天记录 getter（延迟绑定：useChat 调用时序晚于本函数）
    addLog, nativeAlert, confirmDialog
}) {
    // 预览输入（默认预填演示文本，用户可粘贴自己的 AI 输出）
    const statusbarInput = ref(DEMO_INPUT);
    // 预览视图切换：'render' 渲染效果 | 'source' 替换后源码
    const statusbarViewMode = ref('render');
    // 已启用于预览的脚本 uid 列表（默认自动启用全部渲染型脚本）
    const enabledScriptUids = ref([]);
    // 候选数据导入面板展开状态
    const showStatusDataPanel = ref(false);
    // 当前展开的模板卡 uid（卡内美化模板检测区，空串=全收起）
    const expandedTemplateUid = ref('');

    // 渲染型脚本：经分类器判定为完整模板（loader / html / code），片段级与纯文本替换排除
    const renderableScripts = computed(() => {
        const list = Array.isArray(regexScripts.value) ? regexScripts.value : [];
        return list.filter(s => {
            if (!s || s.disabled) return false;
            const rep = (s.replaceString !== undefined && s.replaceString !== null)
                ? s.replaceString : (s.replace_string || '');
            const t = classifyTemplate(rep).type;
            return t === 'loader' || t === 'html' || t === 'code';
        });
    });

    // 片段级脚本计数（<br>/<b>$1</b> 类小修饰，不构成完整模板，已从模板列表排除）
    const fragmentScriptCount = computed(() => {
        const list = Array.isArray(regexScripts.value) ? regexScripts.value : [];
        let n = 0;
        for (const s of list) {
            if (!s || s.disabled) continue;
            const rep = (s.replaceString !== undefined && s.replaceString !== null)
                ? s.replaceString : (s.replace_string || '');
            if (classifyTemplate(rep).type === 'fragment') n++;
        }
        return n;
    });

    // 新出现的渲染型脚本自动加入预览（已有的勾选状态不动；被删脚本的 uid 残留无副作用）
    watch(renderableScripts, (list) => {
        const known = new Set(enabledScriptUids.value);
        let changed = false;
        for (const s of list) {
            const uid = getRegexUid(s);
            if (!known.has(uid)) { known.add(uid); changed = true; }
        }
        if (changed) enabledScriptUids.value = Array.from(known);
    }, { immediate: true });

    // 勾选/取消某个脚本参与预览
    const toggleStatusbarScript = (script) => {
        const uid = getRegexUid(script);
        const idx = enabledScriptUids.value.indexOf(uid);
        if (idx >= 0) enabledScriptUids.value.splice(idx, 1);
        else enabledScriptUids.value.push(uid);
    };
    const isScriptEnabled = (script) => enabledScriptUids.value.includes(getRegexUid(script));

    // =========================================================
    // 🎨 卡内美化模板检测（核心功能）：美化代码本体写在正则 replaceString 里 ——
    // 逐个渲染型脚本独立成卡，自动寻找可匹配数据代入 $1 等捕获组，直接预览模板效果
    // =========================================================

    // DOMPurify 预览清洗（模板卡与链式预览共用同策略）
    const sanitizePreviewHtml = (text) => {
        if (!text) return '';
        let t = String(text);
        // 🧹 剥离 Markdown 代码块围栏（```html ```json 等）：AI 输出/世界书常把模板或状态块包在
        //    代码块里，围栏是纯文本，DOMPurify 不清洗会原样显示「```html」等标记（与聊天渲染 cleanMarkdownFences 同策略）
        t = t.replace(/```[a-zA-Z]*\n?/gi, '').replace(/```/g, '');
        // loader/script 直链块交给 iframe 渲染，清洗前先剥离（DOMPurify 必删 <script>，留着会出现空壳）
        const textWithoutLoader = extractLoaderUrls(t).length > 0
            ? t.replace(/\$\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*['"][^'"]+['"]\s*\)\s*;?/gi, '')
                 .replace(/<script[^>]*>\s*\$\(\s*['"]body['"][\s\S]*?<\/script>/gi, '')
                 .replace(/<(?:script|iframe)[^>]+src\s*=\s*['"]https?:\/\/[^'"]+['"][^>]*>(?:[\s\S]*?<\/script>)?/gi, '')
            : t;
        return DOMPurify.sanitize(textWithoutLoader, {
            ALLOWED_TAGS: [
                'b', 'i', 'em', 'strong', 'u', 's', 'br', 'p', 'div', 'span',
                'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'img', 'hr',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'table', 'thead', 'tbody', 'tr', 'td', 'th',
                'progress', 'details', 'summary', 'font', 'center', 'small', 'sub', 'sup'
            ],
            ALLOWED_ATTR: ['class', 'style', 'src', 'alt', 'title', 'width', 'height',
                'align', 'valign', 'colspan', 'rowspan', 'bgcolor', 'color', 'max', 'value'],
            ALLOW_DATA_ATTR: false,
            FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'oninput', 'onanimationstart', 'onanimationend', 'onpointerdown', 'onpointerup', 'onpointermove', 'ondragstart', 'ondrop'],
            // 允许内嵌 base64 图与相对路径，禁止 http(s) 外联（防追踪像素/内网探测）
            ALLOWED_URI_REGEXP: /^(?:data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
        });
    };

    // =========================================================
    // 🔍 状态数据检测（核心）：数据源按「能否命中渲染脚本正则」筛选 ——
    // 不无脑全量收开场白/世界书；世界书条目也是状态栏的常见载体（文本/代码形态皆有）
    // =========================================================

    // 收集全部原始候选文本（输入框/开场白/备用开场白/世界书条目/聊天记录），不做命中过滤
    const collectRawCandidates = () => {
        const sources = [];
        const input = (statusbarInput.value || '').trim();
        if (input) sources.push({ from: '输入框', text: input });
        const d = safeData ? safeData.value : null;
        if (d && typeof d === 'object') {
            if (d.first_mes) sources.push({ from: '开场白', text: String(d.first_mes) });
            (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [])
                .forEach((g, i) => { if (g) sources.push({ from: `备用开场白#${i + 1}`, text: String(g) }); });
        }
        // 🌍 世界书条目：状态栏常写在世界书里（comment 约定输出格式，content 含示例状态块或代码形态模板）
        const wEntries = worldbookEntries ? worldbookEntries.value : [];
        wEntries.forEach((e, i) => {
            if (!e) return;
            const content = String(e.content || '').trim();
            if (!content) return;
            const label = e.comment || e.name || `词条#${i + 1}`;
            sources.push({ from: `世界书·${String(label).slice(0, 12)}`, text: content });
        });
        const hist = (typeof getChatHistory === 'function') ? (getChatHistory() || []) : [];
        hist.filter(m => m && m.role === 'assistant' && m.content).slice(-3).reverse()
            .forEach((m, i) => sources.push({ from: i === 0 ? '聊天记录·最新' : '聊天记录', text: String(m.content) }));
        return sources;
    };

    // 单脚本模板渲染的数据源优先级（模板卡逐源尝试命中；末位兜底内置示例，永不「无脑全量」）
    const getTemplateDataSources = () => {
        const sources = collectRawCandidates();
        sources.push({ from: '内置示例', text: DEMO_INPUT });
        return sources;
    };

    // 每个渲染型脚本 → 一张模板卡（分类器驱动）：
    //   loader → 沙箱 iframe 直载 URL；html → 找数据代入后安全静态渲染；code → 找数据代入后沙箱 srcdoc 运行
    const statusbarTemplates = computed(() => {
        return renderableScripts.value.map(s => {
            const rawRep = (s.replaceString !== undefined && s.replaceString !== null)
                ? String(s.replaceString) : String(s.replace_string || '');
            const cls = classifyTemplate(rawRep);
            const name = s.scriptName || s.script_name || '未命名脚本';
            const uid = getRegexUid(s);

            // 🌐 外链 GUI 型模板
            if (cls.type === 'loader') {
                return { uid, name, type: 'loader', loaderUrl: cls.url, matched: true, matchedFrom: '脚本内置', previewHtml: '', previewSrcdoc: '', rawHtml: cls.text };
            }

            // 🎨 HTML / 📜 code：逐数据源尝试命中（代入 $1 等捕获组）
            const re = parseRegexPattern(s.findRegex || s.find_regex);
            let matched = false, matchedFrom = '', html = cls.text;
            if (re) {
                for (const src of getTemplateDataSources()) {
                    re.lastIndex = 0;
                    const text = String(src.text);
                    const m = re.exec(text);
                    if (m) {
                        matched = true; matchedFrom = src.from;
                        // 🎯 片段级渲染（修复「模板预览被整篇数据源淹没」）：
                        //    只对「第一个命中的匹配片段」单独应用替换，代入捕获组渲染状态栏本体效果。
                        //    不 replace 整个数据源——开场白/世界书词条可能上千字，整段替换会把
                        //    状态栏淹没在整篇设定里，用户想看的是状态栏本身。
                        const fragment = m[0];
                        const reFrag = parseRegexPattern(s.findRegex || s.find_regex);
                        if (reFrag) { reFrag.lastIndex = 0; html = fragment.replace(reFrag, cls.text); }
                        else { html = fragment; }
                        break;
                    }
                }
            }
            // 📜 代码形态：包成完整文档经沙箱 srcdoc 运行（JS/CSS 全量生效；无酒馆变量接口）
            if (cls.type === 'code') {
                const srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;}</style></head><body>${html}</body></html>`;
                return { uid, name, type: 'code', loaderUrl: null, matched, matchedFrom, previewHtml: '', previewSrcdoc: srcdoc, rawHtml: html };
            }
            // 🎨 静态 HTML：DOMPurify 清洗后渲染
            return { uid, name, type: 'html', loaderUrl: null, matched, matchedFrom, previewHtml: sanitizePreviewHtml(html), previewSrcdoc: '', rawHtml: html };
        });
    });
    // 模板卡展开状态维护：列表变化后若当前展开项失效，自动展开第一张
    watch(statusbarTemplates, (list) => {
        if (list.length === 0) { expandedTemplateUid.value = ''; return; }
        if (!list.some(t => t.uid === expandedTemplateUid.value)) {
            expandedTemplateUid.value = list[0].uid;
        }
    }, { immediate: true });

    // 展开/收起某张模板卡
    const toggleTemplateCard = (uid) => {
        expandedTemplateUid.value = (expandedTemplateUid.value === uid) ? '' : uid;
    };

    // =========================================================
    // 📥 候选数据列表（检测式）：只有命中任一渲染脚本正则的来源才列入 ——
    // 开场白/世界书不再无脑全收，未命中格式约定的内容不会混进来
    // =========================================================
    const statusDataCandidates = computed(() => {
        const regexes = renderableScripts.value
            .map(s => parseRegexPattern(s.findRegex || s.find_regex))
            .filter(Boolean);
        if (regexes.length === 0) return [];
        const seen = new Set();
        const items = [];
        for (const src of collectRawCandidates()) {
            const key = src.text.slice(0, 120);
            if (seen.has(key)) continue;
            const hit = regexes.some(re => { re.lastIndex = 0; return re.test(src.text); });
            if (hit) {
                seen.add(key);
                items.push({ source: src.from, text: src.text, renderable: true });
            }
        }
        return items.slice(0, 12); // 上限 12 条，防大世界书刷屏
    });

    // 导入单条候选数据（替换当前输入）
    const importStatusData = (item) => {
        if (!item || !item.text) return;
        statusbarInput.value = item.text;
        showStatusDataPanel.value = false;
        addLog(`📥 已导入${item.source}的文本（${item.text.length} 字）到渲染预览`, 'info');
    };

    // 拼接导入全部候选（多状态块同屏预览，用分隔线隔开）
    const importAllStatusData = () => {
        const list = statusDataCandidates.value;
        if (list.length === 0) return;
        statusbarInput.value = list.map(i => i.text).join('\n\n────────\n\n');
        showStatusDataPanel.value = false;
        addLog(`📥 已拼接导入 ${list.length} 条候选文本到渲染预览`, 'info');
    };

    // 应用勾选的渲染型脚本（按卡内顺序；$1/$2 捕获组由 String.replace 原生展开，与酒馆行为一致）
    const appliedResult = computed(() => {
        const active = renderableScripts.value.filter(isScriptEnabled);
        let text = statusbarInput.value || '';
        for (const s of active) {
            const re = parseRegexPattern(s.findRegex || s.find_regex);
            if (!re) continue; // 非法正则跳过（编辑中途的半截输入不炸预览）
            const rep = (s.replaceString !== undefined && s.replaceString !== null)
                ? s.replaceString : (s.replace_string || '');
            try { text = text.replace(re, rep); } catch (e) { /* 单脚本失败不中断整体 */ }
        }
        return text;
    });

    // 🌐 外链 GUI 的 URL 列表：同时扫描原始输入与替换结果（loader 块可能由脚本替换产生，也可能 AI 直接输出）
    const loaderUrls = computed(() => {
        const fromInput = extractLoaderUrls(statusbarInput.value);
        const fromApplied = extractLoaderUrls(appliedResult.value);
        return Array.from(new Set([...fromInput, ...fromApplied]));
    });

    // 安全预览：DOMPurify 白名单清洗（与模板卡同策略）
    const previewHtml = computed(() => sanitizePreviewHtml(appliedResult.value));

    // 恢复演示文本
    const resetStatusbarDemo = () => { statusbarInput.value = DEMO_INPUT; };

    // 📚 状态栏模板库（15 套风格，见 utils/statusbarTemplates.js）——暴露给 UI 做模板选择
    const statusbarTemplateMeta = STATUSBAR_TEMPLATE_META;

    // 📜 状态栏世界书指令模板库（10 套，见 utils/statusbarPromptTemplates.js）
    //   —— 指导 AI 在回复末尾输出 <Status> 文本块；与 UI 渲染模板互补（指令→文本，渲染→面板）
    const statusbarPromptMeta = STATUSBAR_PROMPT_META;

    // 📜 注入指定世界书指令模板到当前卡的内嵌世界书（character_book.entries 常驻条目）
    //    templateKey 传指令 key（如 'prompt-fantasy'）；不传则默认第一套（奇幻冒险者）
    const injectStatusbarPrompt = async (templateKey) => {
        const tpl = templateKey ? findStatusbarPrompt(templateKey) : STATUSBAR_PROMPT_TEMPLATES[0];
        if (!tpl) { nativeAlert('未找到该指令模板，请重试。', 'warning'); return; }
        if (typeof ensureCharacterBookEntries !== 'function') {
            nativeAlert('请先打开一张角色卡，再注入世界书指令。', 'warning'); return;
        }
        const entries = ensureCharacterBookEntries();
        if (!entries) { nativeAlert('请先打开一张角色卡，再注入世界书指令。', 'warning'); return; }

        // 已存在同特征指令则询问「替换现有」（同主题的 <Status> 输出约束不应重复堆叠）
        const existingIndex = entries.findIndex(e => e && String(e.content || '').includes('<Status>')
            && String(e.comment || e.name || '').includes('状态栏'));
        if (existingIndex >= 0) {
            const existing = entries[existingIndex];
            const existingName = existing.comment || existing.name || '现有状态栏指令';
            const replace = await confirmDialog(
                `内嵌世界书已有「${existingName}」，与本指令模板同属 <Status> 输出约束。\n\n` +
                `• 确定：替换为「${tpl.icon} ${tpl.name}」指令\n` +
                `• 取消：保留现有指令\n\n` +
                `（替换后 AI 将按新规则输出状态栏）`
            );
            if (!replace) return;
            existing.comment = `${tpl.icon} 状态栏指令：${tpl.name}`;
            existing.name = existing.comment;
            existing.content = tpl.content;
            existing.constant = true;
            existing.enabled = true;
            existing.position = 0;
            existing.insertion_order = 0;
            existing.keys = existing.keys || [];
            existing.secondary_keys = existing.secondary_keys || [];
            refreshCardData();
            addLog(`📜 已将状态栏世界书指令替换为「${tpl.icon} ${tpl.name}」`, 'success');
            nativeAlert(`已替换内嵌世界书中的状态栏指令为「${tpl.name}」。\n\nAI 将在回复末尾按新规则输出 <Status> 状态栏。`, 'success');
            return;
        }

        const ok = await confirmDialog(
            `将向当前角色卡的内嵌世界书注入「${tpl.icon} ${tpl.name}」指令模板：\n\n` +
            `• 适用：${tpl.category}\n` +
            `• 数据字段：${tpl.fields}\n` +
            `• 注入为「常驻条目」：AI 每次回复末尾都会按规则输出 <Status> 状态栏\n` +
            `• 与「📚 状态栏模板库」的 HTML 渲染模板配合：指令生成文本 → 正则渲染为面板\n\n` +
            `确定注入吗？`
        );
        if (!ok) return;
        // 常驻条目：keys 留空（不靠触发词）、constant=true（常驻）、position 顶部、插入深度 0
        entries.unshift({
            uid: `status_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            keys: [], secondary_keys: [],
            content: tpl.content,
            comment: `${tpl.icon} 状态栏指令：${tpl.name}`,
            name: `${tpl.icon} 状态栏指令：${tpl.name}`,
            constant: true, selective: false,
            insertion_order: 0, order: 0,
            position: 0, enabled: true
        });
        refreshCardData();
        addLog(`📜 已注入「${tpl.icon} ${tpl.name}」世界书指令到内嵌世界书（常驻）`, 'success');
        nativeAlert(
            `注入成功！\n\n` +
            `已向当前卡的内嵌世界书添加「${tpl.name}」指令（常驻条目）。\n\n` +
            `配合使用：\n` +
            `1. AI 每次回复末尾会输出 <Status>...</Status> 文本状态栏\n` +
            `2. 再到「📚 状态栏模板库」选一套 HTML 渲染模板注入\n` +
            `3. 正则脚本会把 <Status> 文本渲染成对应风格面板\n` +
            `4. 可在「世界书」Tab 修改指令的数值映射与字段名`, 'success'
        );
    };

    // 📦 注入指定状态栏模板到当前卡（无现成脚本的卡片开箱即用；可选择 8 套风格之一）
    //    templateKey 传模板 key（如 'dark-rpg'）；不传则默认第一套（暗黑奇幻 RPG）
    //    ⚠️ 所有模板共用 <status> findRegex：若卡内已有同触发词脚本，询问「替换现有模板」而非直接拒绝，
    //       让用户可在 8 套风格间自由切换。
    const injectStatusbarTemplate = async (templateKey) => {
        const tpl = templateKey ? findStatusbarTemplate(templateKey) : STATUSBAR_TEMPLATES[0];
        if (!tpl) { nativeAlert('未找到该模板，请重试。', 'warning'); return; }
        const arr = ensureRegexScriptsArray();
        if (!arr) {
            nativeAlert('请先打开一张角色卡，再注入状态栏模板。', 'warning');
            return;
        }
        // 已存在同触发词脚本（所有模板共用 <status>）：提供「替换现有」而非直接拦截
        const existingIndex = arr.findIndex(s => s && /<status>([\\s\\S]*?)<\/status>/.test(String((s.findRegex || s.find_regex) || '')));
        if (existingIndex >= 0) {
            const existing = arr[existingIndex];
            const existingName = existing.scriptName || existing.script_name || '现有状态栏模板';
            const replace = await confirmDialog(
                `卡内已有「${existingName}」，与「${tpl.icon} ${tpl.name}」使用相同的 <status> 触发词。\n\n` +
                `• 确定：替换现有模板为该风格\n` +
                `• 取消：保留现有模板\n\n` +
                `替换后旧样式将被覆盖（数据字段 ${tpl.fields}）。`
            );
            if (!replace) return;
            // 替换：保留 id，覆盖名称/查找/替换串（正则脚本编辑器里的用户微调将被新模板覆盖）
            existing.scriptName = `${tpl.icon} ${tpl.name}`;
            existing.script_name = `${tpl.icon} ${tpl.name}`;
            existing.findRegex = tpl.findRegex;
            existing.find_regex = tpl.findRegex;
            existing.replaceString = tpl.replaceString;
            existing.replace_string = tpl.replaceString;
            existing.disabled = false;
            refreshCardData();
            addLog(`📊 已将状态栏模板替换为「${tpl.icon} ${tpl.name}」`, 'success');
            nativeAlert(`已将现有状态栏模板替换为「${tpl.name}」风格。\n\n可在「正则脚本」选项卡继续微调。`, 'success');
            return;
        }
        const ok = await confirmDialog(
            `将向当前角色卡注入「${tpl.icon} ${tpl.name}」状态栏模板：\n\n` +
            `• 风格：${tpl.category}\n` +
            `• 数据字段：${tpl.fields}\n` +
            `• AI 输出 <status>...</status> 文本块时，自动渲染为该风格面板\n` +
            `• 注入后可在「正则脚本」选项卡中修改样式/字段映射\n\n` +
            `确定注入吗？`
        );
        if (!ok) return;
        arr.push({
            id: `status_${tpl.key}_${Date.now()}`,
            scriptName: `${tpl.icon} ${tpl.name}`,
            script_name: `${tpl.icon} ${tpl.name}`,
            findRegex: tpl.findRegex,
            find_regex: tpl.findRegex,
            replaceString: tpl.replaceString,
            replace_string: tpl.replaceString,
            placement: [2], // 作用于 AI 输出
            disabled: false,
            markdownOnly: true,
            promptOnly: false
        });
        refreshCardData(); // shallowRef 手动刷新（数组 push 不触发深层响应）
        addLog(`📊 已注入「${tpl.icon} ${tpl.name}」状态栏模板（<status> → 面板）`, 'success');
        nativeAlert(
            `注入成功！\n\n` +
            `已向当前卡添加「${tpl.name}」状态栏正则脚本。\n\n` +
            `使用方式：\n` +
            `1. 让 AI 用 <status>...</status> 格式输出状态（可在世界书/提示词中约定）\n` +
            `2. 酒馆聊天与本预览器都会渲染成 ${tpl.name} 风格面板\n` +
            `3. 面板数据读取酒馆变量（stat_data.角色 / 世界），需配合酒馆变量系统使用\n` +
            `4. 可在「正则脚本」选项卡中微调样式与字段映射`, 'success'
        );
    };

    return {
        // 输入与视图
        statusbarInput, statusbarViewMode, resetStatusbarDemo,
        // 📚 状态栏模板库（HTML 渲染模板）
        statusbarTemplateMeta,
        // 📜 状态栏世界书指令模板库（AI 输出约束）
        statusbarPromptMeta,
        // 卡内美化模板检测（核心）
        statusbarTemplates, expandedTemplateUid, toggleTemplateCard, fragmentScriptCount,
        // 候选数据源
        showStatusDataPanel, statusDataCandidates, importStatusData, importAllStatusData,
        // 脚本参与控制
        renderableScripts, toggleStatusbarScript, isScriptEnabled,
        // 预览产出
        appliedResult, previewHtml, loaderUrls,
        // 模板注入
        injectStatusbarTemplate, injectStatusbarPrompt
    };
}
