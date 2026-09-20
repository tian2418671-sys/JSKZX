/**
 * 🧩 插件归一与形态识别（纯逻辑模块，无 DOM / Electron 依赖，可被 node --test 单测）
 *
 * 目标：把不同来源的「酒馆插件」统一归一为可渲染的 plugin 模型，供：
 *   - 侧边栏列表（name / kind 徽章 / 来源）
 *   - 工作区「代码」页（文件树 + 源码）
 *   - 工作区「效果」页（沙箱 iframe 宿主桩运行脚本）
 *
 * 来源形态（真实样例归纳）：
 *   A 酒馆助手 JSON 脚本：{ id, name, info, content, buttons[] }，content 为 jQuery $() 注入 DOM 的 JS
 *   B 酒馆助手 JSON 脚本：content 为 `// ==UserScript==` 头 + IIFE（同属 JSON 脚本，仅内容形态不同）
 *   C 散落脚本：SlashRunner.registerCommand(...)（依赖 JS-Slash-Runner 运行时）
 *   E 扩展工程：manifest.json + dist/*.bundle.js + css（st-yuzi-phone / JS-Slash-Runner 原生扩展）
 */

/** 内容形态枚举：A=jQuery 注入 | B=userscript 头 | C=SlashRunner 命令 | unknown=无法识别 */
export function detectScriptKind(content) {
    const c = String(content || '');
    if (!c.trim()) return 'unknown';
    if (/==UserScript==/i.test(c)) return 'B';
    if (/SlashRunner\s*\.\s*registerCommand/.test(c)) return 'C';
    return 'A';
}

/** 判断一个 JSON 对象是否为「酒馆助手 JSON 脚本」（含 content JS 字符串）
 *  ⚠️ 与主进程 main.js 的 isValidPluginJson 判定保持一致：排除角色卡 / 世界书 / 预设。 */
export function isPluginJson(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (typeof parsed.content !== 'string') return false;
    // 排除角色卡（spec 字段）
    if (parsed.spec === 'chara_card_v2' || parsed.spec === 'chara_card_v3') return false;
    // 排除世界书（entries 字段）
    if (parsed.entries) return false;
    // 排除预设（prompts 等字段）
    if (['prompts', 'prompt_order', 'temperature', 'max_tokens'].some(k => k in parsed)) return false;
    return !!(parsed.id || parsed.name || Array.isArray(parsed.buttons));
}

/** 判断一个 JSON 对象是否为扩展工程 manifest.json（兼容原生扩展与独立扩展 display_name + js/css 格式） */
export function isExtensionManifest(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.manifest_version !== undefined) return true;
    if (Array.isArray(parsed.extensions) && parsed.extensions.length > 0) return true;
    if (typeof parsed.display_name === 'string' && parsed.display_name.trim()) {
        if (typeof parsed.js === 'string' && parsed.js.trim()) return true;
        if (typeof parsed.css === 'string' && parsed.css.trim()) return true;
    }
    return false;
}

/**
 * 归一化「酒馆助手 JSON 脚本」为 plugin 模型
 * @param {object} item 主进程扫描返回的原始条目 { type:'json', path, name, data }
 */
export function normalizeJsonPlugin(item) {
    const data = item.data || {};
    const content = String(data.content || '');
    const kind = detectScriptKind(content);
    const name = (data.name && data.name.trim()) || stripExt(item.name || '');
    return {
        id: data.id || 'json-' + stableId(item.path),
        name,
        source: { type: 'json', origin: item.path },
        kind: 'tavern-helper',           // 酒馆助手 JSON 脚本
        scriptKind: kind,                 // A / B / C / unknown（内容形态）
        meta: {
            info: data.info || '',
            buttons: Array.isArray(data.buttons) ? data.buttons : []
        },
        scripts: [{
            file: item.path,
            lang: 'js',
            kind,
            content
        }],
        manifest: null,
        files: [item.path]
    };
}

/**
 * 归一化「散落脚本」（如 statusSystem.js / userscript.js）为 plugin 模型
 * @param {object} item 主进程扫描返回的原始条目 { type:'script', path, name, content }
 */
export function normalizeScriptPlugin(item) {
    const content = String(item.content || '');
    const kind = detectScriptKind(content);
    return {
        id: 'script-' + stableId(item.path),
        name: stripExt(item.name || ''),
        source: { type: 'script', origin: item.path },
        kind: kind === 'C' ? 'slash' : 'userscript',
        scriptKind: kind,
        meta: { info: '', buttons: [] },
        scripts: [{ file: item.path, lang: 'js', kind, content }],
        manifest: null,
        files: [item.path]
    };
}

/**
 * 归一化「扩展工程」（manifest.json + bundle 文件树）为 plugin 模型
 * @param {object} item 主进程扫描返回的原始条目 { type:'extension', root, name, manifest, files[] }
 */
export function normalizeExtensionPlugin(item) {
    const manifest = item.manifest || {};
    const name = (manifest.name && manifest.name.trim())
        || (manifest.display_name && manifest.display_name.trim())
        || item.name || '未命名扩展';
    // manifest 指向的入口文件（dist/index.js 或 dist/*.bundle.js）
    const entryFiles = resolveManifestEntries(manifest);
    const files = item.files || [];
    const scripts = [];
    for (const entry of entryFiles) {
        const full = entry.replace(/^\//, '');
        // Windows 上 collectExtensionFiles 用 path.join 生成反斜杠路径（绝对路径 + dist\index.js），
        // 而 manifest 声明的是正斜杠（dist/index.js），直接 endsWith 必然失配。
        // 统一归一为 / 再比较，确保 bundlePath 落到真实绝对路径而非相对路径。
        const normFull = full.replace(/\\/g, '/');
        const found = files.find(f => {
            const nf = f.replace(/\\/g, '/');
            return nf.endsWith(normFull) || nf === normFull;
        });
        scripts.push({
            file: found || full,
            lang: /\.css$/i.test(entry) ? 'css' : 'js',
            kind: 'bundle',               // 整包 bundle，无内联 content
            content: '',                  // 效果页走 bundlePath 加载
            bundlePath: found || full
        });
    }
    return {
        id: 'ext-' + stableId(item.root),
        name,
        source: { type: 'extension', origin: item.root },
        kind: 'extension',
        scriptKind: 'bundle',
        meta: { info: (manifest.description || manifest.summary || ''), buttons: [] },
        scripts,
        manifest,
        files
    };
}

/** 从 manifest.json 提取入口文件列表（兼容多种字段命名） */
export function resolveManifestEntries(manifest) {
    const out = [];
    const push = (v) => {
        if (typeof v === 'string' && v.trim()) out.push(v.trim());
        else if (Array.isArray(v)) v.forEach(x => push(x));
    };
    if (Array.isArray(manifest.extensions)) {
        // SillyTavern 原生扩展：extensions: [{ name, entry | main | js | css }]
        for (const e of manifest.extensions) {
            if (!e || typeof e !== 'object') continue;
            push(e.entry || e.main || e.js);
            push(e.css);
        }
    } else {
        push(manifest.entry || manifest.main || manifest.js || manifest.index);
        push(manifest.css);
    }
    // 兜底：常见 dist bundle 命名
    if (out.length === 0) out.push('dist/index.js');
    return Array.from(new Set(out));
}

/** 从文件树里挑出「效果页需要关注的资源」（bundle js / css / 入口 html）。
 *  只返回 manifest 明确声明的入口（normalizeExtensionPlugin 已通过 resolveManifestEntries
 *  解析出 js/css 入口）。不再把整个文件树里的 js/mjs 都当 bundle——否则会误注入
 *  eslint.config.mjs / build.mjs / postcss.config.js 等工程配置文件，导致
 *  「import ts from 'typescript-eslint'」被剥离后遗留全局 tseslint 引用报错。 */
export function resolvePreviewAssets(plugin) {
    const assets = { js: [], css: [] };
    if (!plugin) return assets;
    for (const s of (plugin.scripts || [])) {
        if (s.lang === 'css') assets.css.push(s.bundlePath || s.file);
        else assets.js.push(s.bundlePath || s.file);
    }
    return assets;
}

/** 去除文件名扩展名 */
export function stripExt(name) {
    const n = String(name || '');
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(0, i) : n;
}

/** 生成稳定的短 id（避免直接暴露绝对路径） */
export function stableId(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}
