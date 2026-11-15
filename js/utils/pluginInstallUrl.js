/**
 * 🔗 插件「链接安装」URL 解析（纯逻辑，无 Electron / fs 依赖，可被 node --test 单测）
 *
 * 背景：SillyTavern 生态里插件的标准安装方式是「在酒馆里粘贴一个仓库地址」，
 * 例如 `https://github.com/anyKami/AutoRandomInput`，由酒馆把整个仓库克隆到
 * `public/scripts/extensions/third-party/<名字>`。本项目要做到「粘贴链接即可安装」，
 * 就需要把这类地址翻译成一个**可下载的地址**。
 *
 * 支持的输入形态（按优先级）：
 *   1. GitHub 仓库主页         https://github.com/<owner>/<repo>[/tree/<branch>[/sub/dir]]
 *   2. GitHub 分支 / 标签页     https://github.com/<owner>/<repo>/releases/tag/v1.2.3
 *   3. 任意 http(s) 直链       以 .zip 结尾 → 直接下载
 *                             以 .json/.js → 单文件插件
 *   4. codeload 地址           https://codeload.github.com/<owner>/<repo>/zip/refs/heads/<b>
 *
 * 设计原则：
 *   - **纯函数**：只做字符串 → 结构化描述，不发起网络请求，方便测试与复用。
 *   - **只认 https/http**：拒绝 file://、javascript: 等协议（安全）。
 *   - **不猜测分支**：GitHub 主页默认交给 codeload 的 `HEAD` 兜底（见 main.js），
 *     这里只在 URL 明确写出 /tree/<branch> 时才固定分支。
 */

/** 允许的协议（大小写不敏感） */
const SAFE_PROTOCOL = /^https?:\/\//i;

/**
 * 解析 GitHub 仓库地址
 *
 * 与 SillyTavern 官方安装接口（src/endpoints/extensions.js）对齐：
 *   - 仓库名取 pathname 的 basename，并可去掉 `.git` 后缀
 *   - 支持 `?branch=xxx` 查询参数（官方接口的 branch 也能用 URL 传）
 *   - 额外兼容 `/tree/<branch>` 页面地址，分支名**允许含斜杠**（如 feature/x）
 *
 * @returns {{owner:string, repo:string, branch:string, subdir:string}|null}
 */
function parseGitHubRepo(url) {
    const m = String(url).match(
        /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)((?:\/|\?|#).*)?$/i,
    );
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    // owner 不能是 github.com 自身的功能页（如 /settings、/marketplace）
    if (/^(settings|marketplace|explore|topics|collections|sponsors|login|signup|orgs|features)$/i.test(owner)) {
        return null;
    }

    let branch = '';
    let subdir = '';
    const rest = m[3] || '';
    const treeMatch = rest.match(/^\/tree\/(.+)$/i);
    if (treeMatch) {
        // 分支名可以含斜杠，无法从 URL 区分「分支 feature/x」与「分支 feature 的子目录 x」。
        // 官方行为是直接把整串当分支交给 git；这里同样取整串（交给下载端解析失败再退默认分支）。
        branch = treeMatch[1].replace(/^\/+|\/+$/g, '').split(/[?#]/)[0];
    } else {
        const blobMatch = rest.match(/^\/blob\/[^/]+\/(.+)$/i);
        if (blobMatch) subdir = blobMatch[1].split(/[?#]/)[0];
    }

    // ?branch=xxx / ?ref=xxx —— 与 SillyTavern 官方 install 接口的 branch 参数对齐
    if (!branch) {
        const q = String(url).match(/[?&](?:branch|ref)=([^&#]+)/i);
        if (q) branch = decodeURIComponent(q[1]);
    }

    return { owner, repo, branch, subdir };
}

/**
 * 解析「安装链接」为结构化描述
 *
 * 返回对象的 `kind`：
 *   - `github-repo`  整仓库（最常见的酒馆插件安装方式）
 *   - `zip`          直接 zip 直链
 *   - `single-file`  单个 .json / .js 文件（酒馆助手脚本）
 *   - `unknown`      无法识别（调用方应给出提示）
 *
 * @param {string} raw 用户粘贴的原始链接
 * @returns {{kind:string, url:string, fileName:string, owner?:string, repo?:string,
 *            branch?:string, subdir?:string, displayName?:string, reason?:string}}
 */
export function parseInstallUrl(raw) {
    const url = String(raw == null ? '' : raw).trim();

    if (!url) {
        return { kind: 'unknown', url: '', fileName: '', reason: '链接为空' };
    }
    if (!SAFE_PROTOCOL.test(url)) {
        return {
            kind: 'unknown',
            url,
            fileName: '',
            reason: '只支持 http / https 开头的链接',
        };
    }

    // ── 1. codeload 直链（GitHub 打包下载的正式地址）───────────────
    const codeload = url.match(
        /^https?:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/zip\/refs\/(?:heads|tags)\/(.+)$/i,
    );
    if (codeload) {
        const owner = codeload[1];
        const repo = codeload[2];
        const branch = decodeURIComponent(codeload[3].replace(/[?#].*$/, ''));
        return {
            kind: 'github-repo',
            url,
            fileName: `${repo}.zip`,
            owner,
            repo,
            branch,
            subdir: '',
            displayName: repo,
        };
    }

    // ── 2. GitHub 仓库 / 分支页面 ────────────────────────────────────
    const gh = parseGitHubRepo(url);
    if (gh) {
        // 带 /tree/ 分支的，subdir 会被当作「仓库内子目录」——插件可能就在其中
        return {
            kind: 'github-repo',
            url,
            fileName: `${gh.repo}.zip`,
            owner: gh.owner,
            repo: gh.repo,
            branch: gh.branch,
            subdir: gh.subdir,
            displayName: gh.repo,
        };
    }

    // ── 3. 直链文件 ──────────────────────────────────────────────────
    // 去掉 query / hash 后再取文件名（GitHub raw 常带 ?raw=true）
    const pathPart = url.split(/[?#]/)[0];
    const lastSeg = decodeURIComponent(pathPart.split('/').pop() || '');
    const lower = lastSeg.toLowerCase();

    if (lower.endsWith('.zip')) {
        return {
            kind: 'zip',
            url,
            fileName: lastSeg || 'plugin.zip',
            displayName: lastSeg.replace(/\.zip$/i, ''),
        };
    }
    if (lower.endsWith('.json') || lower.endsWith('.js') || lower.endsWith('.mjs')) {
        return {
            kind: 'single-file',
            url,
            fileName: lastSeg || 'plugin.json',
            displayName: lastSeg.replace(/\.(json|m?js)$/i, ''),
        };
    }

    return {
        kind: 'unknown',
        url,
        fileName: lastSeg || '',
        reason: '无法识别的链接：请填写 GitHub 仓库地址、zip 直链，或 .json / .js 文件链接',
    };
}

/** GitHub 仓库打包下载地址（codeload，官方、无需登录、不限流为 API 配额） */
export function gitHubZipUrl(owner, repo, branch) {
    const safeOwner = String(owner || '').trim();
    const safeRepo = String(repo || '').trim().replace(/\.git$/i, '');
    const ref = String(branch || 'HEAD').trim() || 'HEAD';
    // refs/heads 与 refs/tags 都可能；HEAD 用 zip/HEAD 形式
    if (ref === 'HEAD') {
        return `https://codeload.github.com/${safeOwner}/${safeRepo}/zip/HEAD`;
    }
    return `https://codeload.github.com/${safeOwner}/${safeRepo}/zip/refs/heads/${encodeURIComponent(ref)}`;
}

/**
 * 从解压后的顶层目录里找出「真正的插件根」。
 *
 * zip 解压通常得到一层包裹目录（`<repo>-<branch>/`），也可能多套一层；
 * 但插件真正的位置由内容决定：
 *   - 含 manifest.json（扩展工程）→ 就是它
 *   - 含 index.js + style.css（无 manifest 的独立扩展）→ 就是它
 *   - 否则往下找一层
 *
 * @param {Array<{name:string, type:'dir'|'file'}>} entries 顶层条目
 * @returns {string} 应作为插件根的子目录名（空字符串表示就是当前目录）
 */
export function pickPluginRoot(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const files = list.filter((e) => e && e.type === 'file').map((e) => String(e.name).toLowerCase());
    const dirs = list.filter((e) => e && e.type === 'dir').map((e) => String(e.name));

    const looksLikePlugin = (names) =>
        names.includes('manifest.json') ||
        (names.includes('index.js') && (names.includes('style.css') || names.includes('index.html')));

    if (looksLikePlugin(files)) return '';

    // 只套了一层目录 ⇒ 进去看看它是不是插件
    //   判定依据：忽略噪音文件（README / LICENSE / .DS_Store / __MACOSX）后，
    //   顶层**没有真正的代码文件**，说明插件本体在那一层目录里。
    if (dirs.length === 1) {
        const noise = /^(__macosx|\.ds_store|\.gitignore|\.gitattributes|readme\.md|readme\.txt|readme|license|license\.md|changelog\.md)$/i;
        const realFiles = files.filter((f) => !noise.test(f));
        if (realFiles.length === 0) return dirs[0];
    }

    return '';
}
