/**
 * 🏗️ 酒馆「安装与维护」纯逻辑模块
 *
 * 设计原则：**所有可判定的逻辑都放这里**，主进程只做 IO 与编排。
 * 这样可以在 Node 里直接单测，不必启动 Electron、不必真装酒馆。
 *
 * 覆盖：目录形态识别 / 版本解析 / Node 版本判定 / 路径校验 / 注册表归属判定 / 卸载清单估计
 */

/** 酒馆目录的特征文件（出现任意两个即认为是「装过的酒馆」） */
export const ST_MARKERS = [
    'server.js',
    'package.json',
    'public',
    'src',
    'data',
    'config.yaml',
];

/**
 * 识别一个目录是不是「酒馆安装目录」
 *
 * @param {string[]} entries 目录下的条目名（文件或目录都算）
 * @param {object} [opts]
 * @param {string} [opts.packageName] package.json 里的 name（若已读取）
 * @returns {{isSillyTavern:boolean, confidence:string, hits:string[]}}
 */
export function detectSillyTavern(entries, opts = {}) {
    const list = (entries || []).map((x) => String(x).toLowerCase());
    const hits = ST_MARKERS.filter((m) => list.includes(m.toLowerCase()));

    // package.json 里 name === 'sillytavern' 是最强证据
    if (opts.packageName && /^sillytavern$/i.test(String(opts.packageName).trim())) {
        return { isSillyTavern: true, confidence: 'high', hits };
    }
    // server.js + public 同时存在，基本可确定
    if (hits.includes('server.js') && hits.includes('public')) {
        return { isSillyTavern: true, confidence: 'high', hits };
    }
    // 命中 3 个及以上特征
    if (hits.length >= 3) {
        return { isSillyTavern: true, confidence: 'medium', hits };
    }
    return { isSillyTavern: false, confidence: 'none', hits };
}

/**
 * 严格判定：这个目录是不是「酒馆安装根」。
 *
 * 与 `detectSillyTavern` 的区别 —— **扫描全盘时必须用这个**：
 *   `detectSillyTavern` 对「命中 3 个特征」也放行（medium），
 *   但普通 Node 工程同样常备 `package.json` + `src` + `data`，
 *   拿它扫全盘会报出一堆假酒馆，反而让用户不敢点。
 *
 * 只认两种硬证据：
 *   ① `package.json` 的 `name === 'sillytavern'`
 *   ② `server.js` 与 `public/` 同时存在
 *
 * @param {string[]} entries 目录下的条目名
 * @param {object} [opts]
 * @param {string} [opts.packageName] package.json 里的 name（若已读取）
 * @returns {boolean}
 */
export function isStRootStrict(entries, opts = {}) {
    if (opts.packageName && /^sillytavern$/i.test(String(opts.packageName).trim())) return true;
    const list = (entries || []).map((x) => String(x).toLowerCase());
    return list.includes('server.js') && list.includes('public');
}

/**
 * 汇总「环境体检」结果。
 *
 * 结论优先级：有 error 就一定跑不起来（最优先提示）> 只有 warn 说明能用但要注意 > 全绿。
 *
 * @param {Array<{status:'ok'|'warn'|'error'}>} checks 检查项
 * @returns {{ok:number, warn:number, error:number, total:number, verdict:string}}
 */
export function summarizeChecks(checks = []) {
    const list = Array.isArray(checks) ? checks : [];
    const n = { ok: 0, warn: 0, error: 0, total: list.length, verdict: '' };
    for (const c of list) {
        const s = c && c.status;
        if (s === 'ok') n.ok++;
        else if (s === 'warn') n.warn++;
        else if (s === 'error') n.error++;
    }
    if (n.error > 0) n.verdict = `发现 ${n.error} 个必须修复的问题`;
    else if (n.warn > 0) n.verdict = `可以正常运行，但有 ${n.warn} 项建议留意`;
    else n.verdict = '一切正常';
    return n;
}

/**
 * 比较两个 semver（`主.次.修订`）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0
 */
export function compareSemver(a, b) {
    const parse = (s) => String(s || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

/**
 * 从一堆 tag 里挑出最大的 semver。
 *
 * 为什么不能直接用字符串排序：`'1.9.7' > '1.19.0'` 在字典序下成立，
 * 但语义上 1.19.0 才是新版本 —— 必须逐段按数字比（实测踩过）。
 *
 * @param {string[]} tags 形如 `['1.18.0', '1.19.0', 'v1.20.0', 'nightly']`
 * @returns {string} 最大版本号（已去掉 `v` 前缀）；没有合法版本时返回空串
 */
export function pickLatestVersion(tags = []) {
    const list = Array.isArray(tags) ? tags : [];
    let best = '';
    for (const raw of list) {
        const v = String(raw || '').trim().replace(/^v/i, '');
        if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
        if (!best || compareSemver(v, best) > 0) best = v;
    }
    return best;
}

/**
 * 解析 `node -v` 输出，取主版本号
 *
 * 兼容：`v25.2.1` / `25.2.1` / `v20.0.0-nightly2024` / 前后空白与换行
 *
 * @param {string} output
 * @returns {{ok:boolean, major:number, version:string}}
 */
export function parseNodeVersion(output) {
    const s = String(output || '').trim();
    const m = s.match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (!m) return { ok: false, major: -1, version: '' };
    return { ok: true, major: Number(m[1]), version: `${m[1]}.${m[2]}.${m[3]}` };
}

/**
 * 判定 Node 版本是否满足酒馆要求
 *
 * 酒馆 `engines.node: ">= 20"`。低于 20 装了也跑不起来，必须提前拦。
 *
 * @param {number} major 主版本号
 * @param {number} [min=20]
 * @returns {{level:'ok'|'too-old'|'missing', message:string}}
 */
export function judgeNodeVersion(major, min = 20) {
    if (!Number.isFinite(major) || major < 0) {
        return { level: 'missing', message: '未检测到 Node.js' };
    }
    if (major < min) {
        return {
            level: 'too-old',
            message: `Node.js 版本过低（当前 v${major}.x，需要 v${min} 及以上）`,
        };
    }
    return { level: 'ok', message: `Node.js v${major}.x 可用` };
}

/**
 * 校验用户选择的安装路径
 *
 * @param {object} p
 * @param {string} p.dirPath 用户选择的路径
 * @param {boolean} [p.dirExists] 目录是否已存在
 * @param {boolean} [p.dirEmpty] 目录是否为空（不存在时视为空）
 * @param {boolean} [p.hasSillyTavern] 目录内是否已有酒馆
 * @param {number} [p.freeBytes] 磁盘剩余字节
 * @param {number} [p.needBytes] 预计需要字节（默认 5GB）
 * @returns {{ok:boolean, level:'ok'|'warn'|'error', reason:string}}
 */
export function validateInstallPath(p = {}) {
    const dir = String(p.dirPath || '').trim();
    const needBytes = Number(p.needBytes) > 0 ? Number(p.needBytes) : 5 * 1024 * 1024 * 1024;

    if (!dir) return { ok: false, level: 'error', reason: '请选择安装目录' };

    // 盘符必须存在（Windows）
    const drive = dir.match(/^([A-Za-z]):[\\/]/);
    if (drive) {
        const letter = drive[1].toUpperCase();
        const exists = (p.existingDrives || []).map((d) => String(d).toUpperCase()).includes(letter);
        if (p.existingDrives && !exists) {
            return { ok: false, level: 'error', reason: `磁盘 ${letter}: 不存在` };
        }
    }

    // 受保护目录
    if (/^[A-Za-z]:[\\/](Windows|Program Files|Program Files \(x86\))([\\/]|$)/i.test(dir)) {
        return {
            ok: false,
            level: 'error',
            reason: '不建议安装到系统或 Program Files 目录（需要管理员权限，且易被权限问题卡住）',
        };
    }

    // 长路径
    if (dir.length > 200) {
        return {
            ok: false,
            level: 'warn',
            reason: '路径过长，可能触发 Windows 长路径限制，建议换一个更短的目录',
        };
    }

    // 特殊字符（npm / cmd 易出问题）
    if (/[&%!^]/.test(dir)) {
        return {
            ok: false,
            level: 'warn',
            reason: '路径含 & % ! ^ 等特殊字符，可能导致依赖安装失败',
        };
    }

    // 已装酒馆
    if (p.hasSillyTavern) {
        return {
            ok: false,
            level: 'error',
            reason: '该目录已安装酒馆，请改用「升级」或换一个目录',
        };
    }

    // 非空目录
    if (p.dirExists && p.dirEmpty === false) {
        return {
            ok: false,
            level: 'warn',
            reason: '目录非空，安装后可能与已有文件混杂，确认要装到这里吗？',
        };
    }

    // 空间
    if (Number(p.freeBytes) > 0 && Number(p.freeBytes) < needBytes) {
        const needGb = (needBytes / 1024 / 1024 / 1024).toFixed(1);
        return {
            ok: false,
            level: 'error',
            reason: `磁盘空间不足（至少需要 ${needGb} GB）`,
        };
    }

    return { ok: true, level: 'ok', reason: '' };
}

/**
 * 判定一个注册表卸载项是否「由本软件创建」
 *
 * ⚠️ 真实发现：Chrome 装 PWA 时也会写 DisplayName=SillyTavern，
 *    Publisher="Google\Chrome"，UninstallString 指向 chrome.exe。
 *    无脑按名字删会误删用户的浏览器快捷方式。
 *
 * @param {object} item { DisplayName, Publisher, UninstallString, InstallLocation }
 * @param {object} [opts]
 * @param {string[]} [opts.ownedPaths] 本软件/本软件安装的酒馆路径
 * @param {string[]} [opts.ownedPublishers] 允许的 Publisher 关键字
 * @returns {{owned:boolean, reason:string}}
 */
export function isOwnedUninstallEntry(item = {}, opts = {}) {
    const name = String(item.DisplayName || '');
    const publisher = String(item.Publisher || '');
    const uninstall = String(item.UninstallString || '');
    const location = String(item.InstallLocation || '');
    const ownedPaths = (opts.ownedPaths || []).map((x) => String(x).toLowerCase());
    const ownedPublishers = (opts.ownedPublishers || []).map((x) => String(x).toLowerCase());

    // 明确不是酒馆
    if (!/sillytavern|酒馆|资源管理器/i.test(name)) {
        return { owned: false, reason: '名称不匹配' };
    }

    // 浏览器 PWA：绝不能删
    if (/chrome|edge|firefox|brave|opera/i.test(publisher) || /chrome\.exe|msedge\.exe/i.test(uninstall)) {
        return { owned: false, reason: '属于浏览器安装的网页应用（PWA），非本软件创建' };
    }

    // 路径命中
    for (const p of ownedPaths) {
        if (p && (uninstall.toLowerCase().includes(p) || location.toLowerCase().includes(p))) {
            return { owned: true, reason: '路径属于本软件安装位置' };
        }
    }

    // Publisher 命中
    for (const pub of ownedPublishers) {
        if (pub && publisher.toLowerCase().includes(pub)) {
            return { owned: true, reason: '发布者匹配' };
        }
    }

    return { owned: false, reason: '无法确认由本软件创建，已跳过（安全考虑）' };
}

/**
 * 估算卸载清单（用于弹窗展示「将删除什么」）
 *
 * @param {object} inv
 * @param {number} [inv.stBytes] 酒馆目录体积
 * @param {number} [inv.rtBytes] 托管区体积
 * @param {number} [inv.appDataBytes] 本软件 userData 体积
 * @param {number} [inv.appBytes] 本软件本体体积
 * @param {number} [inv.cards] 角色卡数
 * @param {number} [inv.worldbooks] 世界书数
 * @param {number} [inv.chats] 会话数
 * @param {2|1} [inv.mode] 2=彻底删除 1=只删酒馆
 * @returns {{items:Array<{label:string,bytes:number}>, totalBytes:number, counts:object}}
 */
export function buildUninstallInventory(inv = {}) {
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const mode = Number(inv.mode) === 2 ? 2 : 1;

    const items = [
        { label: '酒馆程序与数据', bytes: n(inv.stBytes) },
        { label: '托管区（日志/清单/备份）', bytes: n(inv.rtBytes) },
    ];
    if (mode === 2) {
        items.push({ label: '本软件数据（配置/缓存/记忆库）', bytes: n(inv.appDataBytes) });
        items.push({ label: '本软件本体', bytes: n(inv.appBytes) });
    }

    const totalBytes = items.reduce((s, x) => s + x.bytes, 0);
    return {
        items,
        totalBytes,
        counts: {
            cards: n(inv.cards),
            worldbooks: n(inv.worldbooks),
            chats: n(inv.chats),
        },
    };
}

/** 字节数转人类可读（弹窗展示用） */
export function formatBytes(bytes) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
