/**
 * pluginResPath.js — 插件预览的资源路径改写（纯函数）
 *
 * 🐞 2026-10-25 用户实测「插件渲染：资源加载不出来」。
 *
 * 根因：插件预览页以 `app://index.html/__jsk_preview__/<id>.html` 加载。
 *      插件 HTML/CSS 里的相对路径（`./img/a.png`、`style.css`、`url(./bg.jpg)`）
 *      会被浏览器按**预览文档所在目录**解析 ⇒ 落到应用根目录 ⇒ 404。
 *      于是图片、字体、样式全部加载失败。
 *
 * 修法：渲染预览 HTML 前，把相对路径改写成
 *      `__jsk_plugin_res__/<previewId>/<相对路径>`
 *   主进程 `app://` 协议按 `<previewId>` 查出该插件的根目录并读盘（限定在根目录内，防穿越）。
 *
 * ⚠️ 本文件是**纯函数**，不 import 任何 Vite 专有资源（`?raw` 等），因此可在 Node 里直接单测。
 */

/** 是否是可以改写的「插件内相对路径」 */
function isRelativeAssetUrl(u) {
    const s = String(u || '').trim();
    if (!s) return false;
    if (s.startsWith('#')) return false;                        // 页内锚点
    if (s.startsWith('//')) return false;                       // 协议相对（//cdn/x.png）
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;      // 带 scheme：http/https/data/blob/app/file/chrome-extension…
    if (s.startsWith('/')) return false;                        // 站点绝对路径（插件里少见，保守不改）
    return true;
}

/** 去掉开头 ./ 与多余 ./、并在不越界的前提下消解 ../ */
function normalizeRelAssetPath(u) {
    const s = String(u || '').trim().replace(/^\.\//, '');
    const parts = [];
    for (const seg of s.split('/')) {
        if (seg === '..') { if (parts.length) parts.pop(); continue; }
        if (seg === '.' || seg === '') continue;
        parts.push(seg);
    }
    return parts.join('/');
}

/**
 * 把 HTML / CSS 文本里的相对资源路径改写成插件资源代理 URL。
 *
 * @param {string} text HTML 或 CSS 文本
 * @param {string} previewId 预览 id（主进程据此查插件根目录）
 * @returns {string}
 */
export function rewritePluginResourcePaths(text, previewId) {
    const src = String(text || '');
    if (!src || !previewId) return src;
    const base = `__jsk_plugin_res__/${previewId}/`;

    const fixOne = (u) => {
        if (!isRelativeAssetUrl(u)) return u;
        const rel = normalizeRelAssetPath(u);
        if (!rel) return u;
        return base + rel;
    };

    let out = src;

    // ① 常见属性：src / href / poster / data-src
    out = out.replace(/\b(src|href|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr, quoted, dq, sq) => {
        const val = dq !== undefined ? dq : sq;
        const q = quoted.startsWith("'") ? "'" : '"';
        const fixed = fixOne(val);
        if (fixed === val) return m;
        return `${attr}=${q}${fixed}${q}`;
    });

    // ② srcset="a.png 1x, b.png 2x"
    out = out.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, quoted, dq, sq) => {
        const val = dq !== undefined ? dq : sq;
        const q = quoted.startsWith("'") ? "'" : '"';
        const fixed = val.split(',').map((part) => {
            const seg = part.trim();
            if (!seg) return seg;
            const bits = seg.split(/\s+/);
            bits[0] = fixOne(bits[0]);
            return bits.join(' ');
        }).join(', ');
        return `srcset=${q}${fixed}${q}`;
    });

    // ③ CSS url(...)
    out = out.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi, (m, _all, dq, sq, bare) => {
        const raw = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
        const val = String(raw || '').trim();
        const fixed = fixOne(val);
        if (fixed === val) return m;
        return `url("${fixed}")`;
    });

    // ④ CSS @import '...'
    out = out.replace(/@import\s+("([^"]*)"|'([^']*)')/gi, (m, quoted, dq, sq) => {
        const val = dq !== undefined ? dq : sq;
        const fixed = fixOne(val);
        if (fixed === val) return m;
        return `@import "${fixed}"`;
    });

    return out;
}
