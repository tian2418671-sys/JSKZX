/**
 * [PLUGIN] 插件效果宿主桩——纯逻辑部分（host stub pure）
 * 从 hostStub.js 抽离出的无 DOM / 无浏览器依赖的纯函数，供 node --test 单测直接 import。
 * 这些函数只做字符串处理，不含 import.meta / 浏览器全局引用，可在 Node 环境运行。
 * 注意：保持与 hostStub.js 内联版本行为一致，修改任一处需同步另一处。
 */

/**
 * 把扩展 bundle 的 ESM 源码重写为可在沙箱 <script type="module"> 内运行的形式。
 * 通用策略（不针对具体脚本）：
 *   1. 静态 named import `import{a as b, c}from"x"` → 内联解构 `var{a:b,c}=window.__jskModuleExports;`。
 *   2. 静态 default import / star import → `var X=window.__jskModuleExports;`。
 *   3. 动态 import('...') → `__jskResolveModule('...')`，同步返回命名空间。
 *   4. import.meta → `window.__jskMeta`（无 url 的假对象）。
 *   5. export{...} → 移除；export default → 落到 window.__jskPluginDefault 供宿主观察。
 * @param {string} src bundle 源码
 * @returns {string} 重写后的 ESM 源码
 */
export function rewriteEsmModule(src) {
    let out = String(src || '');
    // 1) import.meta -> window.__jskMeta
    out = out.replace(/\bimport\.meta\b/g, 'window.__jskMeta');
    // 2) 静态 named import（minified 可能是 import{...} 无空格）→ 内联解构 var 声明。
    out = out.replace(
        /\bimport\s*\{([\s\S]*?)\}\s*from\s*(['"])[^'"]*\2\s*;?/g,
        function (m, inner) {
            const parts = String(inner).split(',').map(p => p.trim()).filter(Boolean);
            const mapped = parts.map(p => {
                const mm = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
                return mm ? (mm[1] + ':' + mm[2]) : p;
            });
            return 'var{' + mapped.join(',') + '}=window.__jskModuleExports;';
        }
    );
    // 3) 静态 default import：import d from "x" -> var d=window.__jskModuleExports;
    out = out.replace(
        /\bimport\s+([A-Za-z_$][\w$]*)\s*from\s*(['"])[^'"]*\2\s*;?/g,
        'var $1=window.__jskModuleExports;'
    );
    // 4) 静态 star import：import * as ns from "x" -> var ns=window.__jskModuleExports;
    out = out.replace(
        /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*(['"])[^'"]*\2\s*;?/g,
        'var $1=window.__jskModuleExports;'
    );
    // 5) 副作用 import：import "x"（无绑定，仅执行）→ 移除
    out = out.replace(/\bimport\s*(['"])[^'"]*\1\s*;?/g, '');
    // 6) 动态 import('...') / import("...") → __jskResolveModule('...')
    out = out.replace(/\bimport\s*\(\s*(['"`])([^'"`]*)\1\s*\)/g, "__jskResolveModule('$2')");
    // 7) export { ... } / export { x as y } → 空
    out = out.replace(/\bexport\s*\{[\s\S]*?\}\s*;?/g, '');
    // 8) export default <expr> → window.__jskPluginDefault = <expr>
    out = out.replace(/\bexport\s+default\s+(?=[^\s;])/g, 'window.__jskPluginDefault = ');
    // 9) export const/let/var/function/class/async function → 去掉 export 关键字
    out = out.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, '');
    return out;
}

/**
 * 剥离 ESM 语法（import / export），供内联 <script> 注入使用。
 * 仅按整行匹配（^...$ + m 标志），避免误伤字符串字面量里的 import 字样。
 * @param {string} src
 * @returns {string}
 */
export function stripEsmSyntax(src) {
    return String(src || '')
        .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]*['"]\s*;?\s*$/gm, '')
        .replace(/^\s*import\s+['"][^'"]*['"]\s*;?\s*$/gm, '')
        .replace(/^\s*import\s*\([^)]*\)\s*;?\s*$/gm, '')
        .replace(/^\s*export\s*\{[\s\S]*?\}\s*;?\s*$/gm, '')
        .replace(/^\s*export\s+default\s+/gm, 'window.__jskPluginDefault = ')
        .replace(/^\s*export\s+(?=(const|let|var|function|class|async\s+function)\b)/gm, '');
}

/**
 * 解析 Slash 命令文本（对齐真实酒馆 SlashCommandParser.parse 的消费约定）。
 * 首 token 为命令名（容忍前导 /），剩余按「空格分词 + 双/单引号包裹的带空值保留 + name=value 命名参数」解析。
 * @param {string} text
 * @param {Record<string, object>} [registry] 已注册命令表，用于回填 result.command
 * @returns {{command: object|null, name: string, args: string[], namedArguments: Record<string,string>, raw: string}}
 */
export function parseSlashCommand(text, registry = {}) {
    const raw = String(text == null ? '' : text).trim().replace(/^\//, '');
    if (!raw) return { command: null, name: '', args: [], namedArguments: {}, raw: '' };
    const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const name = tokens.shift() || '';
    const args = [];
    const namedArguments = {};
    tokens.forEach(function (t) {
        if (t.length >= 2 && ((t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') || (t.charAt(0) === "'" && t.charAt(t.length - 1) === "'"))) t = t.slice(1, -1);
        const eq = t.indexOf('=');
        if (eq > 0 && eq < t.length - 1) { namedArguments[t.slice(0, eq)] = t.slice(eq + 1); return; }
        args.push(t);
    });
    return { command: registry[name] || null, name, args, namedArguments, raw };
}

/** HTML 转义（插件名等注入到标签间时防破坏结构）。对齐官方 utils.js 五字符：& < > " ' */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 编码消息文本中的 <style> 块，使其绕过 DOMPurify 对 <style> 标签的拦截。
 * 对齐官方 chats.js encodeStyleTags：/<style>(.+?)<\/style>/gims → <custom-style>encodeURIComponent(内容)</custom-style>。
 * @param {string} text
 * @returns {string}
 */
export function encodeStyleTags(text) {
    const styleRegex = /<style>(.+?)<\/style>/gims;
    return String(text == null ? '' : text).replace(styleRegex, (_, m) => {
        return `<custom-style>${encodeURIComponent(m)}</custom-style>`;
    });
}

/**
 * 解码 <custom-style> 还原为安全 <style>。
 * 官方 chats.js decodeStyleTags 依赖 cssom 做 AST 级净化；本地未引入 cssom，用字符串级等价实现：
 *   · 移除 @import 规则、过滤含 :// 的声明（防外部资源加载）
 *   · 类名 .foo → .custom-foo（已是 custom- 前缀则保留）
 *   · 普通选择器前加 .mes_text 前缀（@ 规则 / 伪类开头除外）
 * @param {string} text
 * @param {{prefix?: string}} [opts]
 * @returns {string}
 */
export function decodeStyleTags(text, opts) {
    const prefix = (opts && opts.prefix) || '.mes_text ';
    const styleDecodeRegex = /<custom-style>(.+?)<\/custom-style>/gms;
    return String(text == null ? '' : text).replace(styleDecodeRegex, (_, style) => {
        try {
            let cssText = decodeURIComponent(style).replace(/<br\/>/g, '');
            // 1) 移除 @import 规则（防外部样式表注入）
            cssText = cssText.replace(/@import[^;]*;?/gi, '');
            // 2) 过滤含 :// 的声明（防 url(http...) 等外部资源加载）
            cssText = cssText.replace(/([\w-]+)\s*:\s*[^;}]*:\/\/[^;}]*;?/g, '');
            // 3) 选择器处理：类名加 custom- 前缀；普通选择器前加 .mes_text 前缀
            cssText = cssText.replace(/([^{}]+)\{/g, function (_, selector) {
                const sel = selector.split(',').map(function (part) {
                    let p = part.trim();
                    if (!p) return p;
                    p = p.replace(/\.([\w-]+)/g, function (m, cls) {
                        return (cls.indexOf('custom-') === 0) ? m : ('.custom-' + cls);
                    });
                    if (/^@/.test(p) || /^:/.test(p)) return p;
                    return prefix + p;
                }).join(', ');
                return sel + '{';
            });
            return '<style>' + cssText + '</style>';
        } catch (e) {
            return 'CSS ERROR: ' + e;
        }
    });
}
