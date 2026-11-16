/**
 * 🧩 跨平台 spawn 计划（纯逻辑，可单测）—— AR-84
 * ═══════════════════════════════════════════════════════════════
 * 问题：Windows 上 `npm` 就是 `npm.cmd`。Node 18.20.2 / 20.12.2 / 21.7.3 起
 * （CVE-2024-27980 修复）**禁止**在 `shell:false` 下直接 spawn `.cmd` / `.bat`，
 * 会抛 `EINVAL` ⇒「酒馆一键安装」的依赖安装必然失败（退出码 -1）。
 *
 * 实测对照（Node v25.2.1）：
 *   spawnSync('npm.cmd', ['--version'], {shell:false}) → error.code = EINVAL
 *   spawnSync('npm',     ['--version'], {shell:false}) → error.code = ENOENT
 *   spawnSync(cmd.exe, ['/d','/s','/c','npm.cmd --version']) → status 0
 *
 * 本模块只做「命令 → 真实可执行文件 + 参数」的转换，不真正 spawn，便于单测。
 */

/** 判断是否需要走 cmd.exe 包装（仅 Windows 的 .cmd / .bat） */
function needsShellWrap(cmd, platform = process.platform) {
    return platform === 'win32' && /\.(cmd|bat)$/i.test(String(cmd == null ? '' : cmd));
}

/** cmd 参数引号化：含空格/引号/命令分隔符时整体加双引号 */
function quoteForCmd(arg) {
    const s = String(arg == null ? '' : arg);
    return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 计算真正要 spawn 的命令。
 *
 * ⚠️ 三个坑都在这踩过（实测 Node v25.2.1 / Windows 11）：
 *   1. `shell:false` 直接 spawn `npm.cmd` → `EINVAL`（Node ≥18.20.2 的 CVE-2024-27980 修复）；
 *   2. 改走 `cmd /c "npm.cmd" args` 但不开 `windowsVerbatimArguments` → Node 二次转义引号，
 *      cmd 收到 `\"npm.cmd\"` 字面量，报「不是内部或外部命令」；
 *   3. 开了 verbatim 且命令是**带空格的绝对路径**（`C:\Program Files\nodejs\npm.cmd`）→ cmd 的
 *      `/s /c` 会把外层引号剥掉，剩 `C:\Program Files\nodejs\npm.cmd" args` → 报「'C:\Program' 不是…」。
 *
 * ⇒ 首选**完全绕开 cmd**：用 `node.exe` 执行 `npm-cli.js`（由 `pickNodeCli` 解析）。
 *   只有在找不到 npm-cli.js 时才退回 cmd 包装（此时命令名必须是 PATH 里的裸名，不能带空格）。
 *
 * @param {string} cmd 原始命令（可能是 `npm.cmd`）
 * @param {string[]} [args]
 * @param {object} [opts] { platform, comspec }
 * @returns {{cmd:string, args:string[], wrapped:boolean, windowsVerbatimArguments:boolean}}
 */
function planSpawn(cmd, args, opts = {}) {
    const list = Array.isArray(args) ? args.slice() : [];
    const platform = opts.platform || process.platform;
    if (!needsShellWrap(cmd, platform)) {
        return { cmd, args: list, wrapped: false, windowsVerbatimArguments: false };
    }
    if (/[\\/]/.test(String(cmd))) {
        // 带路径的 .cmd/.bat 无法安全经 cmd /s /c 传递（见上面第 3 条）—— 明确失败，由调用方改走 node-cli
        throw new Error(`不能直接 spawn 带路径的批处理命令：${cmd}（请改用 node + npm-cli.js）`);
    }
    const comspec = opts.comspec || process.env.ComSpec || 'cmd.exe';
    const line = `${cmd} ${list.map(quoteForCmd).join(' ')}`.trim();
    // /d 跳过 AutoRun；/s 按「最外层引号」规则解析；/c 执行后退出
    return { cmd: comspec, args: ['/d', '/s', '/c', line], wrapped: true, windowsVerbatimArguments: true };
}

/**
 * 解析「node.exe + npm-cli.js」调用形式（绕开 cmd，AR-84 首选路径）。
 * @param {object} p { nodeExe, npmCmdPath, exists }
 * @returns {{cmd:string, argsPrefix:string[]} | null}
 */
function pickNodeCli({ nodeExe, npmCmdPath, exists } = {}) {
    const has = typeof exists === 'function' ? exists : () => false;
    if (!nodeExe) return null;
    const sep = /[\\/]/;
    const dirOf = (p) => {
        const s = String(p == null ? '' : p);
        const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        return i > 0 ? s.slice(0, i) : '';
    };
    const joinAll = (...parts) => parts.filter(Boolean).join('\\');
    const dirs = [];
    if (sep.test(String(nodeExe))) dirs.push(dirOf(nodeExe));
    if (npmCmdPath && sep.test(String(npmCmdPath))) dirs.push(dirOf(npmCmdPath));
    for (const d of dirs) {
        const cli = joinAll(d, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (has(cli)) return { cmd: nodeExe, argsPrefix: [cli] };
    }
    return null;
}

module.exports = { planSpawn, needsShellWrap, quoteForCmd, pickNodeCli };
