/**
 * 🗂️ 「选中的目录现在是什么状态」判定（纯函数）
 *
 * 背景（2026-11-16 用户实测）：全新安装前选一个**空目录**去体检，结果报
 * 「🩺 环境体检：发现 1 个必须修复的问题 —— 酒馆目录：该目录不是有效的酒馆工程」。
 * 用户看不懂：我就是要往里装，怎么成了「必须修复」？
 *
 * 结论：**空目录 / 目录尚不存在**都是安装前的正常状态，应该给「可以直接装」，
 * 只有「已有别的东西占着但又不是酒馆」才值得报错（还可能选错了层级）。
 */

/**
 * @param {object} p
 * @param {boolean} [p.exists] 目录是否存在（不存在 = 一键安装会自动创建）
 * @param {string[]} [p.entries] 目录内条目名（已排除不存在的情况可传空数组）
 * @param {string} [p.stRoot] `findStRoot()` 的结果（非空 = 已经是酒馆根）
 * @param {boolean} [p.hasServerJs] 选中的就是含 server.js 的目录
 * @param {boolean} [p.hasPublic] 同层是否有 public/
 * @returns {{kind:'installed'|'missing'|'empty'|'partial'|'occupied', status:'ok'|'warn'|'error', detail:string, hint:string}}
 */
function classifyDirState({ exists = true, entries = [], stRoot = '', hasServerJs = false, hasPublic = false } = {}) {
    const list = (Array.isArray(entries) ? entries : [])
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim());

    if (stRoot) {
        return { kind: 'installed', status: 'ok', detail: '', hint: '' };
    }
    if (!exists) {
        return {
            kind: 'missing',
            status: 'ok',
            detail: '目录还不存在（安装时会自动创建）',
            hint: '这是正常状态：点「一键安装」会装到该路径',
        };
    }
    if (!list.length) {
        return {
            kind: 'empty',
            status: 'ok',
            detail: '空目录，还没有安装酒馆',
            hint: '这是正常状态：点「一键安装」会下载并装到这里（约 37MB + 依赖）',
        };
    }

    const preview = list.slice(0, 6).join('、') + (list.length > 6 ? ` 等 ${list.length} 项` : '');
    if (hasServerJs && !hasPublic) {
        return {
            kind: 'partial',
            status: 'error',
            detail: `像是酒馆目录，但缺少 public/ 文件夹（目录内：${preview}）`,
            hint: '安装不完整：可点「🔄 重装依赖」补齐，或换个空目录重新「一键安装」',
        };
    }
    return {
        kind: 'occupied',
        status: 'error',
        detail: `这个目录已有 ${list.length} 项内容，但没有酒馆程序（缺 server.js）：${preview}`,
        hint: '两种可能：① 这是酒馆的**上一级**目录 → 请在它下面选 SillyTavern 子目录；② 想装到此处 → 请换一个空目录（安装要求目标为空）',
    };
}

module.exports = { classifyDirState };
