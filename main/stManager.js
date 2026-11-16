/**
 * 🛠️ 酒馆「安装与维护」主进程服务
 *
 * 职责：检测 / 安装 / 启动 / 停止 / 升级 / 卸载。
 * 设计要点：
 *   1. **不污染酒馆仓库**：运行时清单、日志、备份都放 `<安装目录>\_jsk-runtime\`
 *   2. **绝不内置 Node**：检测系统 Node，缺失时走 winget，再不行引导官网
 *   3. **卸载必须极谨慎**：注册表按 Publisher 校验，备份默认开启，需手输 DELETE
 *   4. 所有子进程用 spawn + 参数数组，绝不拼接命令行字符串（防中文/空格踩坑）
 */

const { spawn } = require('child_process');
const { planSpawn, pickNodeCli } = require('./spawnPlan.js'); // 🛡️ AR-84：Windows 的 .cmd/.bat 必须走 cmd.exe 包装
const { pickDownloadOrder, pickNpmRegistry, describeDecision } = require('./networkPlan.js'); // 🌐 先测网络再选地址
const { classifyDirState } = require('./dirStatePlan.js'); // 🗂️ 空目录 = 待安装，不是「必须修复」
const {
    DEFAULT_TICK_MS,
    readTotalBytes,
    buildDownloadReadout,
    shouldEmit,
    mapToOverall,
} = require('./downloadProgress.js'); // 📥 下载百分比读数（流式统计）
const {
    buildRangeHeaders,
    decideResume,
    normalizeMeta,
    makeMeta,
    isPartComplete,
    prioritizeResumeSource,
    isRangeProbeOk,
    pickResumeSource,
    checkZipTail,
    parseContentRange,
    shouldAbandonResume,
} = require('./downloadResume.js'); // ⏯️ 断点续传（Range + .part 片段）
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    detectSillyTavern,
    parseNodeVersion,
    judgeNodeVersion,
    validateInstallPath,
    isOwnedUninstallEntry,
    buildUninstallInventory,
    isStRootStrict: isStRootStrictByEntries,
    summarizeChecks,
    compareSemver,
    pickLatestVersion,
    formatBytes,
} = require('../js/utils/stInstallCore.js');

/** 官方仓库（稳定分支 release） */
const ST_REPO = 'SillyTavern/SillyTavern';
const ST_BRANCH_STABLE = 'release';
const ST_BRANCH_DEV = 'main';
/** 镜像前缀（国内加速；按顺序尝试） */
const GH_MIRRORS = [
    '',                                   // 直连
    'https://ghfast.top/',                // 常用加速
    'https://gh-proxy.com/',              // 备用
];
const RUNTIME_DIRNAME = '_jsk-runtime';

function createStManager({ sendProgress, getMainWindow }) {
    /** 正在跑的 npm / node 子进程：{ [taskId]: ChildProcess } */
    const running = new Map();
    /** 已被用户「取消」的任务（用于把退出码翻译成「已取消」而不是「失败」） */
    const cancelledTasks = new Set();
    /** 每个任务的取消信号（覆盖 fetch 下载这类没有子进程的阶段） */
    const taskAborts = new Map();
    /** 正在运行的酒馆服务：{ child, url, port, startedAt } */
    let serverProc = null;

    // ==================== 工具 ====================

    const emit = (payload) => {
        try { if (typeof sendProgress === 'function') sendProgress(payload); } catch (e) { /* 忽略 */ }
    };

    const log = (msg) => {
        emit({ type: 'log', text: String(msg), ts: Date.now() });
    };

    /** 递归统计目录体积与文件数 */
    const measureDir = (dir, limit = 200000) => {
        let bytes = 0;
        let files = 0;
        const walk = (d) => {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
            for (const e of entries) {
                if (files >= limit) return;
                const full = path.join(d, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.isFile()) {
                    try { bytes += fs.statSync(full).size; files++; } catch (e2) { /* 忽略 */ }
                }
            }
        };
        walk(dir);
        return { bytes, files };
    };

    /** 目录是否为空（不存在视为空） */
    const isEmptyDir = (dir) => {
        try {
            if (!fs.existsSync(dir)) return true;
            return fs.readdirSync(dir).length === 0;
        } catch (e) {
            return false;
        }
    };

    /** 读取并解析某文件的 package.json */
    const readPkg = (dir) => {
        try {
            const p = path.join(dir, 'package.json');
            if (!fs.existsSync(p)) return null;
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch (e) {
            return null;
        }
    };

    /**
     * 统计酒馆 data/ 目录里的角色卡 / 世界书 / 会话数量。
     *
     * 真实结构（本机 v1.18.0 实测）：
     *   data/default-user/characters/    49 个 .png（角色卡）
     *   data/default-user/worlds/       110 个 .json（世界书）
     *   data/default-user/chats/<角色>/  若干 .jsonl（会话）
     *   data/default-user/group chats/  群聊 .jsonl
     * 注意：不同版本/多用户目录结构略有差异，故按目录名宽松匹配。
     *
     * @param {string} dataDir 酒馆的 data 目录
     * @returns {{cards:number, worldbooks:number, chats:number}}
     */
    const countStData = (dataDir) => {
        const out = { cards: 0, worldbooks: 0, chats: 0 };
        const findDirs = (d, name, depth = 0, acc = []) => {
            if (depth > 4) return acc;
            let ents = [];
            try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return acc; }
            for (const e of ents) {
                if (!e.isDirectory()) continue;
                const full = path.join(d, e.name);
                if (String(e.name).toLowerCase() === name) acc.push(full);
                else findDirs(full, name, depth + 1, acc);
            }
            return acc;
        };

        // 角色卡
        for (const cd of findDirs(dataDir, 'characters')) {
            try {
                out.cards += fs.readdirSync(cd).filter((f) => /\.(png|json)$/i.test(f)).length;
            } catch (e) { /* 忽略 */ }
        }
        // 世界书
        for (const wd of findDirs(dataDir, 'worlds')) {
            try {
                out.worldbooks += fs.readdirSync(wd).filter((f) => /\.json$/i.test(f)).length;
            } catch (e) { /* 忽略 */ }
        }
        // 会话：chats 目录下按角色分文件夹，递归数 .jsonl
        const countChats = (d, depth = 0) => {
            if (depth > 3) return 0;
            let n = 0;
            let ents = [];
            try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return 0; }
            for (const e of ents) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) n += countChats(full, depth + 1);
                else if (/\.(jsonl|json)$/i.test(e.name)) n++;
            }
            return n;
        };
        for (const cd of findDirs(dataDir, 'chats')) {
            try { out.chats += countChats(cd); } catch (e) { /* 忽略 */ }
        }
        for (const gd of findDirs(dataDir, 'group chats')) {
            try { out.chats += fs.readdirSync(gd).filter((f) => /\.(jsonl|json)$/i.test(f)).length; } catch (e) { /* 忽略 */ }
        }
        return out;
    };

    /** 在酒馆目录下定位真正的根（zip 解压常多一层 SillyTavern-release） */
    const findStRoot = (baseDir) => {
        // 先看自身
        const self = readPkg(baseDir);
        const selfDetect = detectSillyTavern(fs.existsSync(baseDir) ? fs.readdirSync(baseDir) : [], {
            packageName: self && self.name,
        });
        if (selfDetect.isSillyTavern) return baseDir;

        // 再看一层子目录
        let entries = [];
        try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (e) { return ''; }
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        for (const d of dirs) {
            const full = path.join(baseDir, d);
            const pkg = readPkg(full);
            const det = detectSillyTavern(
                (() => { try { return fs.readdirSync(full); } catch (e) { return []; } })(),
                { packageName: pkg && pkg.name },
            );
            if (det.isSillyTavern) return full;
        }
        return '';
    };

    // ==================== 本地已装酒馆嗅探 ====================

    /**
     * 扫描时要跳过的目录名。
     * 这些要么是系统目录、要么是依赖/缓存大户，绝不可能在里面装酒馆，
     * 但一旦进去遍历会非常慢（node_modules 动辄几万文件）。
     */
    const SCAN_SKIP = new Set([
        'node_modules', '.git', '.svn', '.hg', '.cache', '.vscode', '.idea', '.github',
        'dist', 'dist_new', 'build', 'out', '.next', '.nuxt', 'coverage', '.turbo',
        '$recycle.bin', 'system volume information', 'windows', 'winsxs', 'perflogs',
        'recovery', 'msocache', 'config.msi', 'drivers', 'temp', 'tmp', 'cache',
        'appdata', 'programdata', 'onedrivetemp', 'assembly', 'installer',
    ]);

    /**
     * 严格判定某目录是不是「酒馆安装根」。
     *
     * ⚠️ 比 `detectSillyTavern` 的「命中 3 个特征」更严 —— 扫描全盘时宁漏勿误：
     *    普通 Node 工程也常同时有 `package.json` + `src` + `data`，
     *    用宽松判定会报出一堆假酒馆，反而让用户不敢点。
     *
     * 判定条件（满足其一）：
     *   ① `server.js` + `public/` 同时存在  ← 酒馆最硬的指纹
     *   ② `package.json` 的 name === 'sillytavern'
     *
     * @param {string} dir 待判定目录
     * @returns {boolean}
     */
    const isStRootStrict = (dir) => {
        try {
            if (!fs.existsSync(dir)) return false;
            if (!fs.statSync(dir).isDirectory()) return false;
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch (e) { return false; }
            const pkg = readPkg(dir);
            return isStRootStrictByEntries(entries, { packageName: pkg && pkg.name });
        } catch (e) {
            return false;
        }
    };

    /**
     * 扫描本机，找出所有已安装的酒馆。
     *
     * 采用「分层递进」而不是全盘递归：先查最可能的位置，再逐层放宽，
     * 全程受**时间预算 + 每层条目上限**约束，避免大硬盘扫到天荒地老。
     *
     * 覆盖场景（实测本机 `E:\AI\SillyTavern` 属于第 3 层）：
     *   · `D:\SillyTavern`              ← 盘根一级
     *   · `D:\AI\SillyTavern`           ← 盘根二级
     *   · `C:\Users\x\Desktop\SillyTavern` ← 用户目录
     *
     * @param {object} [opts]
     * @param {boolean} [opts.deep] 深度模式（多扫一层，时间预算放宽）
     * @returns {Promise<{success:boolean, items:Array, scannedDirs:number, elapsedMs:number, truncated:boolean}>}
     */
    const scanForSillyTavern = async ({ deep = false } = {}) => {
        const startedAt = Date.now();
        const budgetMs = deep ? 60000 : 20000;
        const MAX_CHILDREN = 500;
        const found = new Map();   // 小写路径 -> 结果
        let scannedDirs = 0;
        let hitTimeLimit = false;   // 时间用完（可能还有遗漏）
        let hitItemLimit = false;   // 某目录子项太多被截断（不影响“已找到”的结果）

        const timeUp = () => Date.now() - startedAt > budgetMs;
        const normKey = (p) => path.resolve(p).toLowerCase();

        /** 判定并收录 */
        const addIfSt = (dir) => {
            if (timeUp()) { hitTimeLimit = true; return; }
            const key = normKey(dir);
            if (found.has(key)) return;
            scannedDirs++;
            if (!isStRootStrict(dir)) return;
            const pkg = readPkg(dir);
            found.set(key, {
                dir: path.resolve(dir),
                version: pkg ? String(pkg.version || '') : '',
                hasGit: fs.existsSync(path.join(dir, '.git')),
                hasNodeModules: fs.existsSync(path.join(dir, 'node_modules')),
            });
            emit({ type: 'log', text: `✅ 发现酒馆：${path.resolve(dir)}`, ts: Date.now() });
        };

        /** 列出某目录下的子目录（已过滤系统/依赖目录，并限制数量） */
        const listDirs = (dir, limit = MAX_CHILDREN) => {
            const out = [];
            let ents;
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
            for (const e of ents) {
                if (out.length >= limit) { hitItemLimit = true; break; }
                if (!e.isDirectory()) continue;
                const lname = e.name.toLowerCase();
                if (SCAN_SKIP.has(lname) || lname.startsWith('$') || lname.startsWith('.')) continue;
                out.push(path.join(dir, e.name));
            }
            return out;
        };

        emit({ type: 'stage', text: '正在扫描本机已安装的酒馆…', ts: Date.now() });

        // ---------- 1) 所有存在的盘符 ----------
        const drives = [];
        for (let i = 0; i < 26; i++) {
            const d = String.fromCharCode(65 + i) + ':\\';
            try { if (fs.existsSync(d)) drives.push(d); } catch (e) { /* 忽略 */ }
        }

        // ---------- 2) 盘根一级 + 二级 ----------
        for (const drv of drives) {
            if (timeUp()) { hitTimeLimit = true; break; }
            emit({ type: 'log', text: `🔍 扫描 ${drv}`, ts: Date.now() });
            addIfSt(drv);                       // 极少数人直接装在盘根
            const lvl1 = listDirs(drv);
            for (const c of lvl1) addIfSt(c);   // D:\SillyTavern
            // 二级：D:\AI\SillyTavern（本机真实位置就在这里）
            for (const c of lvl1) {
                if (timeUp()) { hitTimeLimit = true; break; }
                for (const cc of listDirs(c)) addIfSt(cc);
            }
        }

        // ---------- 3) 用户目录与常见安装位置 ----------
        const home = os.homedir();
        const userRoots = [
            path.join(home, 'Desktop'),
            path.join(home, 'Downloads'),
            path.join(home, 'Documents'),
            path.join(home, '桌面'),
            path.join(home, '下载'),
            path.join(home, '文档'),
        ];
        for (const r of userRoots) {
            if (timeUp()) { hitTimeLimit = true; break; }
            addIfSt(r);
            for (const c of listDirs(r)) {
                addIfSt(c);
                // 用户常把酒馆塞在一层壳里，如 Desktop\AI\SillyTavern
                for (const cc of listDirs(c)) addIfSt(cc);
            }
        }

        // ---------- 4) 深度模式：再向下一层 ----------
        if (deep && !timeUp()) {
            emit({ type: 'log', text: '🔎 深度扫描（可能较慢）…', ts: Date.now() });
            for (const drv of drives) {
                if (timeUp()) { hitTimeLimit = true; break; }
                for (const c of listDirs(drv)) {
                    if (timeUp()) { hitTimeLimit = true; break; }
                    for (const cc of listDirs(c)) {
                        for (const ccc of listDirs(cc)) addIfSt(ccc);
                    }
                }
            }
        }

        const items = [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
        const elapsedMs = Date.now() - startedAt;
        emit({
            type: 'log',
            text: items.length
                ? `✅ 扫描完成：找到 ${items.length} 个酒馆（用时 ${(elapsedMs / 1000).toFixed(1)}s）`
                : `扫描完成：未找到已安装的酒馆（用时 ${(elapsedMs / 1000).toFixed(1)}s）`,
            ts: Date.now(),
        });
        emit({ type: 'stage', text: '', ts: Date.now() });
        return {
            success: true,
            items,
            scannedDirs,
            elapsedMs,
            truncated: hitTimeLimit || hitItemLimit,
            hitTimeLimit,
            hitItemLimit,
        };
    };

    // ==================== 跨平台 spawn 计划（AR-84） ====================
    // 实现收敛到 `main/spawnPlan.js`（纯函数，可单测）：Windows 的 `.cmd` / `.bat`
    // 必须走 `cmd.exe /d /s /c`，否则 Node ≥18.20.2 抛 EINVAL（npm 在 Windows 上就是 npm.cmd）。

    // ==================== Node 检测 ====================

    /**
     * 运行一个命令并收集输出（带超时）。
     *
     * @param {string} cmd
     * @param {string[]} args
     * @param {number|object} [optsOrTimeout] 数字=超时毫秒（兼容旧调用）；或 { timeoutMs, cwd }
     */
    const runOnce = (cmd, args, optsOrTimeout = 20000) => new Promise((resolve) => {
        const opts = (optsOrTimeout && typeof optsOrTimeout === 'object')
            ? optsOrTimeout
            : { timeoutMs: optsOrTimeout };
        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20000;
        let out = '';
        let err = '';
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        let child;
        try {
            const plan = planSpawn(cmd, args); // 🛡️ AR-84：Windows 的 .cmd/.bat 必须走 cmd.exe 包装
            child = spawn(plan.cmd, plan.args, {
                windowsHide: true,
                shell: false,
                windowsVerbatimArguments: plan.windowsVerbatimArguments,
                cwd: opts.cwd || process.cwd(),
                env: opts.env || process.env,
            });
        } catch (e) {
            return finish({ ok: false, out: '', err: e.message });
        }
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) { /* 忽略 */ }
            finish({ ok: false, out, err: 'timeout' });
        }, timeoutMs);
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, out, err: e.message }); });
        child.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, out, err }); });
    });

    /** 探测系统 Node：返回 { found, version, major, level, message, path } */
    const detectNode = async () => {
        const r = await runOnce('node', ['-v']);
        if (!r.ok) {
            return {
                found: false,
                version: '',
                major: -1,
                level: 'missing',
                message: '未检测到 Node.js',
                path: '',
            };
        }
        const parsed = parseNodeVersion(r.out);
        const judged = judgeNodeVersion(parsed.major);
        // 取 node 实际路径（winget 装完后 PATH 可能未刷新，故同时尝试常见位置）
        let nodePath = '';
        const w = await runOnce('where', ['node']);
        if (w.ok) nodePath = String(w.out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
        if (!nodePath) {
            const guess = 'C:\\Program Files\\nodejs\\node.exe';
            if (fs.existsSync(guess)) nodePath = guess;
        }
        return {
            found: true,
            version: parsed.version,
            major: parsed.major,
            level: judged.level,
            message: judged.message,
            path: nodePath,
        };
    };

    /**
     * 解析 npm 可执行文件位置，并把 Node 目录注入 PATH（AR-84 配套）
     *
     * 为什么需要：如果用「一键安装」里的 winget 才装上 Node，**当前进程的 PATH 还没刷新**，
     * 直接找 `npm.cmd` 会「不是内部或外部命令」；而 `npm.cmd` 本身还要靠 PATH 找到 `node.exe`。
     * 所以这里既解析绝对路径，又把它所在目录（以及 node 目录）前置进子进程 PATH。
     *
     * @param {{path?:string}} [nodeInfo] detectNode() 的返回值
     * @returns {Promise<{npmCmd:string, env:object, resolved:boolean}>}
     */
    const resolveNpm = async (nodeInfo) => {
        const isWin = process.platform === 'win32';
        const nodeDir = nodeInfo && nodeInfo.path ? path.dirname(nodeInfo.path) : '';
        const candidates = [];
        if (isWin && nodeDir) candidates.push(path.join(nodeDir, 'npm.cmd'));
        try {
            const w = await runOnce('where', [isWin ? 'npm.cmd' : 'npm'], 10000);
            if (w.ok) String(w.out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((p) => candidates.push(p));
        } catch (e) { /* 忽略 */ }
        if (isWin) {
            const roots = [
                'C:\\Program Files\\nodejs',
                process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : '',
                process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs') : '',
            ].filter(Boolean);
            for (const r of roots) candidates.push(path.join(r, 'npm.cmd'));
            if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'npm.cmd'));
        }
        const found = candidates.find((p) => {
            try { return !!p && fs.existsSync(p); } catch (e) { return false; }
        });
        const npmCmd = found || (isWin ? 'npm.cmd' : 'npm');
        const toolDir = found ? path.dirname(found) : nodeDir;
        const env = { ...process.env };
        const prepend = [];
        if (toolDir) prepend.push(toolDir);
        if (nodeDir && nodeDir !== toolDir) prepend.push(nodeDir);
        if (prepend.length) env.PATH = `${prepend.join(path.delimiter)}${path.delimiter}${env.PATH || ''}`;

        // 🛡️ AR-84 首选：node.exe + npm-cli.js（完全绕开 cmd，路径带空格也不会出错）
        const nodeExe = (nodeInfo && nodeInfo.path) || (isWin ? 'node.exe' : 'node');
        const nodeCli = pickNodeCli({ nodeExe, npmCmdPath: found, exists: (p) => { try { return fs.existsSync(p); } catch (e) { return false; } } });
        if (nodeCli) {
            return { cmd: nodeCli.cmd, argsPrefix: nodeCli.argsPrefix, npmCmd, env, resolved: true, mode: 'node-cli' };
        }
        // 兜底：PATH 里的裸名 npm.cmd（不能带路径，见 spawnPlan 注释）
        return { cmd: isWin ? 'npm.cmd' : 'npm', argsPrefix: [], npmCmd, env, resolved: !!found, mode: 'cmd' };
    };

    /** 计数 node_modules 下的包数（心跳进度探针：让「静默的 npm」有可见增长） */
    const countInstalled = (root) => {
        try {
            const nm = path.join(String(root || ''), 'node_modules');
            if (!fs.existsSync(nm)) return '已装 0 个包';
            const n = fs.readdirSync(nm, { withFileTypes: true })
                .filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
            return `已装 ${n} 个包`;
        } catch (e) {
            return '';
        }
    };

    /** 探测 winget 是否可用 */
    const detectWinget = async () => {
        const r = await runOnce('winget', ['--version'], 15000);
        return { available: r.ok, version: r.ok ? String(r.out).trim() : '' };
    };

    /** 用 winget 安装 Node LTS（静默接受协议） */
    const installNodeViaWinget = async (taskId) => {
        const wg = await detectWinget();
        if (!wg.available) {
            return { success: false, error: '系统没有 winget，无法自动安装 Node.js', needManual: true };
        }
        log('正在通过 winget 安装 Node.js LTS（可能需要管理员授权）…');
        const code = await runStreamed(
            taskId,
            'winget',
            [
                'install', 'OpenJS.NodeJS.LTS',
                '--silent',
                '--accept-package-agreements',
                '--accept-source-agreements',
            ],
            { cwd: os.tmpdir() },
        );
        if (code !== 0) {
            return { success: false, error: `winget 安装失败（退出码 ${code}）`, needManual: true };
        }
        // 装完后重新探测（注意：当前进程 PATH 可能仍是旧的，需要绝对路径兜底）
        const node = await detectNode();
        if (node.level !== 'ok') {
            return {
                success: false,
                error: 'Node.js 已安装但当前会话无法识别，请重启本软件后再试',
                needManual: true,
                node,
            };
        }
        return { success: true, node };
    };

    // ==================== 流式子进程（带进度） ====================

    /**
     * 运行子进程并实时推送输出；返回退出码。
     *
     * ⚠️ 支持 `opts.timeoutMs`：某些命令会**永久挂起**——
     *    最典型的是 `git pull` 遇到需要认证时弹凭据提示（无终端则静默等待输入），
     *    一卡就是无限久，UI 上的「正在 git pull…」永远不结束、弹窗也关不掉（实测踩过）。
     *    超时后整个进程树强杀，并返回 -2 让调用方区分「超时」与「普通失败」。
     *
     * @param {string} taskId
     * @param {string} cmd
     * @param {string[]} args
     * @param {object} [opts] { cwd, env, timeoutMs, heartbeatMs, heartbeatProbe }
     * @returns {Promise<number>} 退出码；-1 启动失败/进程错误；-2 超时；-3 用户取消
     */
    const runStreamed = (taskId, cmd, args, opts = {}) => new Promise((resolve) => {
        let child;
        let done = false;
        let timer = null;
        let heartbeat = null;
        const finish = (code) => {
            if (done) return;
            done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            resolve(code);
        };
        try {
            const plan = planSpawn(cmd, args); // 🛡️ AR-84：Windows 的 .cmd/.bat 必须走 cmd.exe 包装
            child = spawn(plan.cmd, plan.args, {
                cwd: opts.cwd || process.cwd(),
                windowsHide: true,
                shell: false,
                windowsVerbatimArguments: plan.windowsVerbatimArguments,
                env: opts.env || process.env,
            });
        } catch (e) {
            log(`启动失败: ${e.message}`);
            return finish(-1);
        }
        running.set(taskId, child);

        // 💓 心跳：npm 在 `--loglevel=error --no-progress` 下**成功前一个字节都不输出**，
        //    用户会以为卡死。这里每隔 heartbeatMs 推一条「仍在执行 + 已用秒数（+ 进度探针）」，
        //    保证 UI 一直在动，也说明「不是没反应」。
        const heartbeatMs = Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : 0;
        if (heartbeatMs) {
            const startedAt = Date.now();
            heartbeat = setInterval(() => {
                if (done) return;
                const sec = Math.round((Date.now() - startedAt) / 1000);
                let extra = '';
                try {
                    if (typeof opts.heartbeatProbe === 'function') extra = String(opts.heartbeatProbe() || '');
                } catch (e) { /* 探针失败不影响心跳 */ }
                emit({ type: 'stdout', text: `⏳ 仍在执行（已用 ${sec} 秒）${extra ? '｜' + extra : ''}`, ts: Date.now(), taskId });
            }, heartbeatMs);
            if (heartbeat.unref) heartbeat.unref();
        }

        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
        if (timeoutMs) {
            timer = setTimeout(() => {
                if (done) return;
                emit({
                    type: 'stderr',
                    text: `⏱ 命令超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已强制终止`,
                    ts: Date.now(),
                    taskId,
                });
                try {
                    if (process.platform === 'win32') {
                        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                    } else {
                        child.kill('SIGTERM');
                    }
                } catch (e) { /* 忽略 */ }
                running.delete(taskId);
                finish(-2);
            }, timeoutMs);
        }

        const pump = (stream, isErr) => {
            stream.on('data', (d) => {
                String(d).split(/\r?\n/).forEach((line) => {
                    const t = line.trim();
                    if (t) emit({ type: isErr ? 'stderr' : 'stdout', text: t, ts: Date.now(), taskId });
                });
            });
        };
        pump(child.stdout, false);
        pump(child.stderr, true);

        child.on('error', (e) => {
            running.delete(taskId);
            log(`进程错误: ${e.message}`);
            finish(-1);
        });
        child.on('close', (code) => {
            running.delete(taskId);
            // 🛑 用户主动取消 → 统一翻译成 -3（否则会被报成「依赖安装失败（退出码 1）」误导用户）
            if (cancelledTasks.has(taskId)) {
                cancelledTasks.delete(taskId);
                return finish(-3);
            }
            finish(typeof code === 'number' ? code : -1);
        });
    });

    /**
     * 取消任务
     *
     * 🛑 AR-85：UI 早期调用 `st.cancel()` **没传 taskId** ⇒ `running.get(undefined)` 恒为空
     *    → 永远返回「没有正在运行的任务」，用户点了「取消任务」看起来毫无反应。
     * 🛑 AR-86：取消必须覆盖**所有阶段** —— 下载/网络探测/解压期间没有 npm 子进程，
     *    旧实现只杀子进程 ⇒ 取消无效，而 UI 的 `busy` 一直为 true ⇒ **所有按钮变灰、弹窗也关不掉**。
     *    现在：先打取消标记 + abort 掉 fetch，再杀子进程（有的话）。
     */
    const cancelTask = (taskId) => {
        let targetId = taskId;
        let child = targetId ? running.get(targetId) : null;
        if (!child && (!targetId || !taskAborts.has(targetId)) && running.size === 1) {
            targetId = [...running.keys()][0];
            child = running.get(targetId);
        }
        // 没有子进程但任务在跑（下载/探测/解压）也要能取消：以 taskAborts 为「活跃任务」判据
        const hasLiveTask = (targetId && (taskAborts.has(targetId) || running.has(targetId)));
        if (!child && !hasLiveTask && running.size === 0 && taskAborts.size === 0) {
            return { success: false, error: '当前没有正在运行的任务' };
        }
        if (!targetId && taskAborts.size === 1) targetId = [...taskAborts.keys()][0];

        try {
            if (targetId) cancelledTasks.add(targetId);
            const ctrl = targetId ? taskAborts.get(targetId) : null;
            if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }
            if (child) {
                if (process.platform === 'win32') {
                    // Windows 下 npm 会派生子进程，需整棵树杀
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                } else {
                    child.kill('SIGTERM');
                }
                running.delete(targetId);
            }
            emit({ type: 'stderr', text: '⏹ 已请求取消，正在终止当前步骤…', ts: Date.now(), taskId: targetId });
            return { success: true, taskId: targetId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    // ==================== 检测状态 ====================

    /**
     * 检测某个目录的酒馆状态
     * @returns {Promise<object>}
     */
    const inspect = async (dirPath) => {
        const dir = String(dirPath || '').trim();
        const result = {
            success: true,
            dir,
            state: 'notFound',      // notFound | ready | running | incomplete
            version: '',
            stRoot: '',
            hasGit: false,
            hasNodeModules: false,
            dataInfo: { cards: 0, worldbooks: 0, chats: 0, bytes: 0 },
            node: null,
            winget: null,
            server: null,
        };
        if (!dir) { result.success = false; result.error = '请先选择安装目录'; return result; }

        if (!fs.existsSync(dir)) {
            result.node = await detectNode();
            result.winget = await detectWinget();
            return result;
        }

        const stRoot = findStRoot(dir);
        if (!stRoot) {
            result.node = await detectNode();
            result.winget = await detectWinget();
            return result;
        }

        result.stRoot = stRoot;
        const pkg = readPkg(stRoot) || {};
        result.version = String(pkg.version || '');
        result.hasGit = fs.existsSync(path.join(stRoot, '.git'));
        result.hasNodeModules = fs.existsSync(path.join(stRoot, 'node_modules'));

            // 数据规模
            const dataDir = path.join(stRoot, 'data');
            if (fs.existsSync(dataDir)) {
                const m = measureDir(dataDir);
                result.dataInfo.bytes = m.bytes;
                result.dataInfo = { ...result.dataInfo, ...countStData(dataDir) };
            }

        result.state = result.hasNodeModules ? 'ready' : 'incomplete';
        result.node = await detectNode();
        result.winget = await detectWinget();
        if (serverProc) {
            result.state = 'running';
            result.server = { url: serverProc.url, port: serverProc.port, startedAt: serverProc.startedAt };
        } else {
            result.server = null;
        }
        return result;
    };

    // ==================== 网络探测（先测网络再选地址） ====================

    /** 探测单个地址是否可用 + 耗时（HEAD 请求，4 秒超时；可被外部 signal 取消） */
    const probeUrl = async (url, timeoutMs = 4000, signal = null) => {
        const startedAt = Date.now();
        const ctrl = new AbortController();
        const abortLocal = () => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
        const timer = setTimeout(abortLocal, timeoutMs);
        if (signal) {
            if (signal.aborted) abortLocal();
            else { try { signal.addEventListener('abort', abortLocal, { once: true }); } catch (e) { /* 忽略 */ } }
        }
        try {
            const resp = await fetch(url, {
                method: 'HEAD',
                redirect: 'follow',
                signal: ctrl.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (SillyTavern-Manager; compatible)' },
            });
            const ms = Date.now() - startedAt;
            // 镜像常见 403/405（不支持 HEAD），只要连上了就算可达，实际下载还会再校验
            return { ok: resp.ok || resp.status === 403 || resp.status === 405, ms, status: resp.status };
        } catch (e) {
            return { ok: false, ms: Date.now() - startedAt, status: 0, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) };
        } finally {
            clearTimeout(timer);
            if (signal) { try { signal.removeEventListener('abort', abortLocal); } catch (e) { /* 忽略 */ } }
        }
    };

    /**
     * 安装/升级前的网络体检：并行探测「GitHub 直连 + 各镜像 + 两个 npm registry」，
     * 再按实测耗时决定用哪个下载源、哪个 npm 源（决策逻辑在 `main/networkPlan.js`，可单测）。
     *
     * @param {string} taskId
     * @param {string} branch
     * @param {{signal?:AbortSignal}} [opts]
     * @returns {Promise<{ok:boolean, order:Array, registry:object, probes:Array, candidates:string[]}>}
     */
    const detectNetwork = async (taskId, branch, opts = {}) => {
        const base = `https://codeload.github.com/${ST_REPO}/zip/refs/heads/${branch}`;
        const downloadTargets = [
            { key: 'github-direct', label: 'GitHub 直连', kind: 'download', priority: 10, url: base },
            ...GH_MIRRORS.filter(Boolean).map((m, i) => ({
                key: 'm-' + (m.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '').slice(0, 14) || ('idx' + i)),
                label: m.replace(/^https?:\/\//, '').replace(/\/$/, ''),
                kind: 'download',
                priority: 0,
                url: m + base,
            })),
        ];
        const registryTargets = [
            { key: 'npm-official', label: 'npm 官方', kind: 'registry', priority: 10, url: 'https://registry.npmjs.org/-/ping', registryUrl: 'https://registry.npmjs.org' },
            { key: 'npm-mirror', label: 'npm 国内镜像', kind: 'registry', priority: 0, url: 'https://registry.npmmirror.com/-/ping', registryUrl: 'https://registry.npmmirror.com' },
        ];
        const all = [...downloadTargets, ...registryTargets];
        emit({ type: 'stage', stage: 'net', taskId, text: '🌐 正在检测网络（选择最快的下载源 / npm 源）…' });
        const results = await Promise.all(all.map(async (t) => ({ ...t, ...(await probeUrl(t.url, 4000, opts.signal)) })));

        const order = pickDownloadOrder(results);
        const registry = pickNpmRegistry(results);
        const text = describeDecision(results, { order, registry });
        log(`🌐 网络检测：${text}`);

        const candidates = order.map((p) => p.url);
        if (!candidates.length) {
            log('❌ 所有下载源都不可用（GitHub 直连与镜像均失败）');
            return { ok: false, order, registry, probes: results, candidates: [] };
        }
        return { ok: true, order, registry, probes: results, candidates };
    };

    // ==================== 下载与安装 ====================

    /** 构造候选下载地址（直连 + 镜像；固定顺序，仅在没做网络探测时兜底使用） */
    const buildZipCandidates = (branch) => {
        const base = `https://codeload.github.com/${ST_REPO}/zip/refs/heads/${branch}`;
        return GH_MIRRORS.map((m) => (m ? m + base : base));
    };

    /**
     * zip 魔数校验：镜像有时返回 200 的 HTML 错误页 / 截断文件 ⇒ 用 "PK" 挡掉，
     * 避免把垃圾当安装包写进磁盘（流式下载时校验首块即可）。
     */
    const isZipMagic = (buf) => Boolean(buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b);

    /** 读文件前 5 字节判断是不是 zip（用于「上次已下满但没改名」的快速复用） */
    const fileLooksLikeZip = async (file) => {
        let fh = null;
        try {
            fh = await fs.promises.open(file, 'r');
            const buf = Buffer.alloc(5);
            const { bytesRead } = await fh.read(buf, 0, 5, 0);
            return isZipMagic(buf.subarray(0, bytesRead));
        } catch (e) {
            return false;
        } finally {
            if (fh) { try { await fh.close(); } catch (e) { /* 忽略 */ } }
        }
    };

    /** 读文件尾部判断 zip 结构是否完整（跨源续传拼接不一致时能提前发现） */
    const zipTailOk = async (file) => {
        let fh = null;
        try {
            const size = (await fs.promises.stat(file)).size;
            const len = Math.min(size, 128 * 1024);
            fh = await fs.promises.open(file, 'r');
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, size - len);
            return checkZipTail(buf, size).ok;
        } catch (e) {
            return false;
        } finally {
            if (fh) { try { await fh.close(); } catch (e) { /* 忽略 */ } }
        }
    };

    /**
     * 探测哪些候选源支持断点续传（`Range: bytes=0-0` → 期望 206）。
     * 实测：GitHub 直连 codeload 恒返 200（不支持），部分镜像（gh-proxy.com）返 206。
     */
    const probeRangeSupport = async (urls, { signal } = {}) => Promise.all((urls || []).map(async (url) => {
        const startedAt = Date.now();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 4000);
        const onAbort = () => ac.abort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        try {
            const r = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (SillyTavern-Manager; compatible)', Range: 'bytes=0-0' },
                redirect: 'follow',
                signal: ac.signal,
            });
            const contentRange = r.headers.get('content-range');
            const ok = isRangeProbeOk({ status: r.status, contentRange });
            const cr = parseContentRange(contentRange);
            try { if (r.body) await r.body.cancel(); } catch (e) { /* 忽略 */ }
            return { url, ok, total: cr ? cr.total : 0, ms: Date.now() - startedAt };
        } catch (e) {
            return { url, ok: false, total: 0, ms: Date.now() - startedAt };
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }));

    /**
     * 下载并保存到文件，返回 { ok, bytes, from, cancelled?, error?, partial?, resumedFrom? }
     *
     * 📥 流式下载：边下边推送**数值百分比读数**（`37% · 13.6 MB / 36.7 MB · 1.1 MB/s`）。
     *
     * ⏯️ 断点续传：数据写 `<dest>.part`，旁边留 `<dest>.part.json`（源地址 / 总大小 / ETag）。
     *    下次（哪怕软件被强制关闭后重开）再下载同一个目标时，用 `Range` 从已下载处继续，
     *    不必从头再来；源不支持 Range（返回 200）或文件已变（`If-Range` 失效）则自动退回从头下载。
     *
     * @param {string[]} candidates
     * @param {string} destFile
     * @param {{taskId?:string, signal?:AbortSignal, tickMs?:number}} [opts] 传 signal 才能被「取消任务」真正中断
     */
    const downloadZip = async (candidates, destFile, opts = {}) => {
        const taskId = opts.taskId || '';
        const minTick = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : DEFAULT_TICK_MS;
        const partFile = `${destFile}.part`;
        const metaFile = `${partFile}.json`;
        const isCancelled = () => Boolean(taskId && cancelledTasks.has(taskId));
        const fileSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
        const readMeta = () => {
            try { return normalizeMeta(JSON.parse(fs.readFileSync(metaFile, 'utf-8'))); } catch (e) { return null; }
        };
        const writeMeta = (m) => {
            try { fs.writeFileSync(metaFile, JSON.stringify(m), 'utf-8'); } catch (e) { /* 元数据写不了不影响下载本身 */ }
        };
        const dropMeta = async () => { try { await fs.promises.unlink(metaFile); } catch (e) { /* 忽略 */ } };
        const cleanupPart = async () => {
            try { await fs.promises.unlink(partFile); } catch (e) { /* 忽略 */ }
            await dropMeta();
        };
        /** 中途中断/取消时**保留**已下载片段：下次能接着下（这正是断点续传的意义） */
        const keepPart = (rateBps = 0) => {
            const kept = fileSize(partFile);
            if (kept <= 0) return;
            const rate = Number(rateBps);
            if (Number.isFinite(rate) && rate > 0) {
                // 记下本次实测速度：下次用它判断「续传到慢镜像」还是「换回快源重下」
                const m = readMeta();
                if (m) writeMeta(makeMeta({ ...m, rateBps: rate }));
            }
            log(`  已保留已下载的 ${formatBytes(kept)}，下次点「一键安装」会从这里继续`);
        };
        const rateOf = (received, resumedFrom, startedAt) => {
            const sec = (Date.now() - startedAt) / 1000;
            return sec > 0.5 ? Math.round(Math.max(0, received - resumedFrom) / sec) : 0;
        };

        let meta = readMeta();
        let resumeBytes = fileSize(partFile);

        // ⏯️ 上次已经下满、只是没来得及改名（崩溃在 rename 之前）→ 直接复用，不联网
        if (resumeBytes > 0 && meta && isPartComplete({ partBytes: resumeBytes, total: meta.total })) {
            if (await fileLooksLikeZip(partFile)) {
                try {
                    await fs.promises.rename(partFile, destFile);
                    await dropMeta();
                    log(`  发现上次已下载完整的安装包（${formatBytes(resumeBytes)}），直接复用`);
                    return { ok: true, bytes: resumeBytes, from: meta.url || '（本地已下载）', resumedFrom: resumeBytes };
                } catch (e) {
                    log(`  复用已下载文件失败：${e.message}`);
                }
            } else {
                log('  残留的下载片段不是有效 zip，已丢弃');
                await cleanupPart();
                resumeBytes = 0;
                meta = null;
            }
        }
        if (resumeBytes > 0) {
            log(`  发现未完成的下载片段（${formatBytes(resumeBytes)}${meta && meta.total ? ` / ${formatBytes(meta.total)}` : ''}），尝试续传`);
        }

        // 续传必须优先回到上次那个源
        let ordered = prioritizeResumeSource(candidates, meta ? meta.url : '').list;
        if (resumeBytes > 0 && !(meta && meta.total > 0)) {
            // 没有可信的元数据（文件丢了 / 版本不符）→ 不敢拼，直接重下
            log('  片段缺少可用的续传信息（不知道总大小），改为重新下载');
            await cleanupPart();
            resumeBytes = 0;
            meta = null;
        }
        if (resumeBytes > 0) {
            // 🔎 有残留片段时先问一句「谁能续传」：直连不支持 Range，镜像可能支持
            const probes = await probeRangeSupport(ordered, { signal: opts.signal });
            const pick = pickResumeSource(probes, { total: meta ? meta.total : 0, preferUrl: meta ? meta.url : '' });
            if (pick) {
                ordered = [pick, ...ordered.filter((u) => u !== pick)];
                log(`  续传源：${pick}（该源支持 Range）`);
            } else {
                log('  ⚠️ 所有可用源都不支持断点续传（服务器未开启 Range），只能重新下载');
                await cleanupPart();
                resumeBytes = 0;
                meta = null;
            }
        }
        let keepOnExit = false;

        try {
            for (let i = 0; i < ordered.length; i++) {
                if (isCancelled()) { keepPart(); return { ok: false, bytes: 0, from: '', cancelled: true }; }
                const url = ordered[i];
                log(`尝试下载（源 ${i + 1}/${ordered.length}）：${url}`);
                const startedAt = Date.now();
                let received = 0;
                let resumedFrom = 0; // 本次的续传起点（catch 里也要用，故提到 try 之外）
                let lastTick = 0;
                let out = null;
                try {
                    // 只有回到「上次那个源」才带 If-Range（各镜像的 ETag 互不相同，不能交叉校验）
                    const sameSource = Boolean(meta && meta.url && meta.url === url);
                    const offset = resumeBytes > 0 ? resumeBytes : 0;
                    const resp = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (SillyTavern-Manager; compatible)',
                            ...buildRangeHeaders({
                                offset,
                                etag: sameSource ? meta.etag : '',
                                lastModified: sameSource ? meta.lastModified : '',
                            }),
                        },
                        redirect: 'follow',
                        signal: opts.signal,
                    });

                    if (resp.status === 416) {
                        // 服务端说范围越界：只有「元数据说已下满」才敢直接用（否则可能是换了版本）
                        if (offset > 0 && meta && isPartComplete({ partBytes: offset, total: meta.total }) && await fileLooksLikeZip(partFile)) {
                            await fs.promises.rename(partFile, destFile);
                            await dropMeta();
                            log(`  续传校验：本地片段已完整（${formatBytes(offset)}），直接使用`);
                            return { ok: true, bytes: offset, from: url, resumedFrom: offset };
                        }
                        log('  续传位置无效（HTTP 416），改为从头下载');
                        await cleanupPart();
                        resumeBytes = 0;
                        meta = null;
                        continue;
                    }
                    if (!resp.ok) {
                        log(`  下载失败 HTTP ${resp.status}`);
                        continue;
                    }

                    const mode = decideResume({ offset, status: resp.status, contentRange: resp.headers.get('content-range') });
                    const append = mode === 'append';
                    if (offset > 0 && !append) {
                        log(`  该源不支持续传（HTTP ${resp.status}），改为从头下载`);
                        resumeBytes = 0; // 片段会被截断，后续源不要再试续传
                    } else if (append) log(`  续传：从 ${formatBytes(offset)} 处继续`);

                    const cr = parseContentRange(resp.headers.get('content-range'));
                    const total = (cr && cr.total) || readTotalBytes(resp.headers);
                    received = append ? offset : 0;
                    writeMeta(makeMeta({
                        url,
                        total,
                        etag: resp.headers.get('etag') || '',
                        lastModified: resp.headers.get('last-modified') || '',
                    }));

                    resumedFrom = append ? offset : 0;
                    const push = (readout, label) => {
                        // 整体进度条按 10% → 45% 区间平滑推进；读数行给出真实下载百分比
                        emit({
                            type: 'progress',
                            taskId,
                            stage: 'download',
                            percent: mapToOverall(readout.percent, 10, 45),
                            downloadPercent: readout.percent,
                            received,
                            total,
                            resumedFrom,
                            text: `${label || (resumedFrom ? '续传中' : '下载中')} ${readout.text}`,
                            detail: readout.detail,
                        });
                    };
                    if (total > 0) log(`  文件大小 ${formatBytes(total)}`);

                    if (!resp.body || typeof resp.body[Symbol.asyncIterator] !== 'function') {
                        // 运行时没有流式 body（老 Node / 被 polyfill 掉）→ 退回一次性读，至少功能不丢
                        const buf = Buffer.from(await resp.arrayBuffer());
                        if (!isZipMagic(buf)) { log(`  内容不是有效 zip（前 4 字节 ${buf.subarray(0, 4).toString('hex') || '空'}），换下一个源`); continue; }
                        received = buf.length;
                        await fs.promises.writeFile(partFile, buf);
                        await fs.promises.rename(partFile, destFile);
                        await dropMeta();
                        push(buildDownloadReadout({ received, total: total || received, elapsedMs: Date.now() - startedAt }), '下载完成');
                        log(`  下载成功（${formatBytes(buf.length)}）`);
                        return { ok: true, bytes: buf.length, from: url, resumedFrom };
                    }

                    out = fs.createWriteStream(partFile, { flags: append ? 'a' : 'w' });
                    let writeErr = null;
                    out.on('error', (e) => { writeErr = e; });
                    let magicOk = append ? true : null; // 续传时首块不在文件开头，不验魔数
                    let headBuf = null;
                    // ⏱️ 续传先跑 10 秒测速：镜像若明显比上次慢，宁可重下（否则用户等更久）
                    const SPEED_CHECK_MS = 10000;
                    let speedChecked = !append;
                    let abandonResume = false;
                    for await (const chunk of resp.body) {
                        if (writeErr) break;
                        if (isCancelled()) break;
                        let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        if (!buf.length) continue;
                        if (magicOk === null) {
                            // 首块可能不足 5 字节（分块边界不可控）：攒够再判，避免误杀正常包
                            buf = headBuf ? Buffer.concat([headBuf, buf]) : buf;
                            headBuf = null;
                            if (buf.length < 5) { headBuf = buf; continue; }
                            magicOk = isZipMagic(buf);
                            if (!magicOk) {
                                log(`  内容不是有效 zip（前 4 字节 ${buf.subarray(0, 4).toString('hex') || '空'}），换下一个源`);
                                break;
                            }
                        }
                        received += buf.length;
                        if (!out.write(buf)) {
                            // 等背压释放；写流出错时也要放行（否则永远挂在这里）
                            await new Promise((resolve) => {
                                const done = () => { out.off('drain', done); out.off('error', done); resolve(); };
                                out.once('drain', done);
                                out.once('error', done);
                            });
                        }
                        const now = Date.now();
                        if (!speedChecked && now - startedAt >= SPEED_CHECK_MS) {
                            speedChecked = true;
                            const rate = (received - resumedFrom) / ((now - startedAt) / 1000);
                            if (shouldAbandonResume({ resumeRateBps: rate, previousRateBps: meta && meta.rateBps })) {
                                log(`  续传源明显更慢（${formatBytes(rate)}/s，上次 ${formatBytes(meta.rateBps)}/s），改回快速源重新下载`);
                                abandonResume = true;
                                break;
                            }
                        }
                        if (shouldEmit(lastTick, now, minTick)) {
                            lastTick = now;
                            push(buildDownloadReadout({ received, total, elapsedMs: now - startedAt }));
                        }
                    }
                    if (magicOk === false || writeErr || isCancelled() || abandonResume) {
                        // 提前收手：把还没读完的响应体掐掉，别让后台继续白下载
                        try { await resp.body.cancel(); } catch (e) { /* 忽略 */ }
                    }
                    await new Promise((resolve) => { out.end(() => resolve()); });
                    out = null;
                    if (writeErr) throw writeErr;

                    if (abandonResume) {
                        // 放弃续传：丢掉片段，回到候选列表里更快的源从头下
                        await cleanupPart();
                        resumeBytes = 0;
                        meta = null;
                        keepOnExit = false;
                        continue;
                    }
                    if (isCancelled()) { keepPart(rateOf(received, resumedFrom, startedAt)); return { ok: false, bytes: 0, from: '', cancelled: true }; }
                    if (magicOk === false) { await cleanupPart(); resumeBytes = 0; meta = null; continue; }
                    if (!received) { log('  内容为空，换下一个源'); await cleanupPart(); resumeBytes = 0; meta = null; continue; }
                    if (total > 0 && received < total) {
                        // 连接被提前掐断（网络抖动 / 服务端断流）→ 保留片段，下次（或下一个源）续传
                        keepOnExit = true;
                        resumeBytes = received;
                        keepPart(rateOf(received, resumedFrom, startedAt));
                        log(`  下载中断（${formatBytes(received)} / ${formatBytes(total)}），已保留片段，可续传`);
                        continue;
                    }
                    if (!(await zipTailOk(partFile))) {
                        log('  下载内容结构不完整（zip 中央目录缺失，可能续传拼接不一致），换下一个源');
                        await cleanupPart();
                        resumeBytes = 0;
                        meta = null;
                        continue;
                    }
                    await fs.promises.rename(partFile, destFile);
                    await dropMeta();
                    push(buildDownloadReadout({ received, total: total || received, elapsedMs: Date.now() - startedAt }), '下载完成');
                    log(`  下载成功（${formatBytes(received)}${total > 0 ? ' · 100%' : ''}）`);
                    return { ok: true, bytes: received, from: url, resumedFrom };
                } catch (e) {
                    if (out) { try { out.destroy(); } catch (err) { /* 忽略 */ } }
                    if (isCancelled()) { keepPart(rateOf(received, resumedFrom, startedAt)); return { ok: false, bytes: 0, from: '', cancelled: true }; }
                    log(`  下载异常：${e.message}`);
                    // 网络异常也保留片段（下次续传）；只有「内容不是 zip」才清掉
                    const kept = fileSize(partFile);
                    if (kept > 0) {
                        keepOnExit = true;
                        resumeBytes = kept;
                        const m = readMeta();
                        const rate = rateOf(received, resumedFrom, startedAt);
                        if (m && rate > 0) writeMeta(makeMeta({ ...m, rateBps: rate }));
                    }
                }
            }
            if (keepOnExit) keepPart();
            return { ok: false, bytes: resumeBytes, from: '', partial: keepOnExit };
        } catch (e) {
            if (keepOnExit) keepPart();
            throw e;
        }
    };

    /** 解压 zip（系统 bsdtar，Windows 10+ 自带）—— 传 taskId 时注册子进程，取消任务能杀掉它 */
    const extractZip = (zipFile, destDir, opts = {}) => new Promise((resolve) => {
        const taskId = opts.taskId || '';
        const tar = spawn('tar', ['-xf', zipFile, '-C', destDir], { windowsHide: true });
        if (taskId) running.set(taskId, tar);
        let err = '';
        tar.stderr.on('data', (d) => { err += String(d); });
        tar.on('error', (e) => { if (taskId) running.delete(taskId); resolve({ ok: false, error: e.message }); });
        tar.on('close', (code) => {
            if (taskId) running.delete(taskId);
            if (taskId && cancelledTasks.has(taskId)) return resolve({ ok: false, cancelled: true, error: '已取消' });
            resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `tar 退出码 ${code}` });
        });
    });

    /**
     * 一键安装
     * @param {object} p { dirPath, branch, skipDeps, taskId }
     */
    const install = async ({ dirPath, branch, skipDeps, taskId } = {}) => {
        const dir = String(dirPath || '').trim();
        const task = taskId || `install-${Date.now()}`;
        if (!dir) return { success: false, error: '请选择安装目录' };

        // 🛑 AR-86：登记取消控制（覆盖「下载/解压」这些没有子进程的阶段）
        const ctrl = new AbortController();
        taskAborts.set(task, ctrl);
        const cancelledResult = () => ({
            success: false,
            cancelled: true,
            error: '已取消（安装未完成，可重新点「一键安装」或「重装依赖」）',
        });
        /** 阶段之间的取消检查点（下载/解压/依赖之间各插一次） */
        const bailIfCancelled = () => (cancelledTasks.has(task) ? cancelledResult() : null);

        try {
            emit({ type: 'stage', stage: 'prepare', taskId: task, text: '准备安装…' });

            // 1) Node 检查（未装先装）
            let node = await detectNode();
            if (node.level !== 'ok') {
                log(node.message);
                if (node.level === 'missing') {
                    const r = await installNodeViaWinget(task);
                    if (!r.success) {
                        return {
                            success: false,
                            error: r.error,
                            needManualNode: true,
                            downloadUrl: 'https://nodejs.org/zh-cn/download',
                        };
                    }
                    node = r.node;
                } else if (node.level === 'too-old') {
                    return {
                        success: false,
                        error: `${node.message}。请先升级 Node.js（可通过 winget upgrade OpenJS.NodeJS.LTS 或到官网下载）`,
                        needManualNode: true,
                        downloadUrl: 'https://nodejs.org/zh-cn/download',
                    };
                }
            }
            log(`使用 Node.js ${node.version}（${node.path || 'PATH 中'}）`);

            // 2) 目录准备
            const bail2 = bailIfCancelled(); if (bail2) return bail2;
            await fs.promises.mkdir(dir, { recursive: true });
            const runtimeDir = path.join(dir, RUNTIME_DIRNAME);
            await fs.promises.mkdir(runtimeDir, { recursive: true });
            const logsDir = path.join(runtimeDir, 'logs');
            await fs.promises.mkdir(logsDir, { recursive: true });

            // 3) 下载（🌐 先测网络：按实测耗时选最快的源，而不是盲试固定顺序）
            const useBranch = branch === 'dev' ? ST_BRANCH_DEV : ST_BRANCH_STABLE;
            const net = await detectNetwork(task, useBranch, { signal: ctrl.signal });
            const bail3 = bailIfCancelled(); if (bail3) return bail3;
            if (!net.ok) {
                return {
                    success: false,
                    error: '❌ 网络不可用：GitHub 直连与所有加速镜像都连不上。请检查网络/代理后重试。',
                    network: net,
                };
            }
            emit({ type: 'stage', stage: 'download', taskId: task, text: '正在下载酒馆…' });
            const zipFile = path.join(runtimeDir, 'st-download.zip');
            const dl = await downloadZip(net.candidates, zipFile, { taskId: task, signal: ctrl.signal });
            const bail4 = bailIfCancelled(); if (bail4) return bail4;
            if (!dl.ok) {
                if (dl.partial) {
                    return {
                        success: false,
                        error: `下载中断（已保存 ${formatBytes(dl.bytes)}），网络恢复后再点「一键安装」会从断点继续`,
                        partial: true,
                        network: net,
                    };
                }
                return { success: false, error: '下载失败：所有源都不可用，请检查网络后重试', network: net };
            }

            // 4) 解压到临时目录
            emit({ type: 'stage', stage: 'extract', taskId: task, text: '正在解压…' });
            const tmpDir = path.join(runtimeDir, `extract-${Date.now()}`);
            await fs.promises.mkdir(tmpDir, { recursive: true });
            const ex = await extractZip(zipFile, tmpDir, { taskId: task });
            const bail5 = bailIfCancelled(); if (bail5) return bail5;
            if (!ex.ok) {
                return { success: false, error: `解压失败：${ex.error}` };
            }
            emit({ type: 'progress', taskId: task, stage: 'extract', percent: 55 });

            // 5) 定位真正的酒馆根并移动到目标位置
            const srcRoot = findStRoot(tmpDir);
            if (!srcRoot) {
                return { success: false, error: '下载内容不是有效的酒馆工程（未找到 server.js / package.json）' };
            }
            const targetRoot = path.join(dir, 'SillyTavern');
            if (fs.existsSync(targetRoot)) {
                // 已存在则拒绝（不覆盖用户数据）
                try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
                return { success: false, error: '目标目录已存在 SillyTavern 文件夹，请改用「升级」' };
            }
            try {
                await fs.promises.rename(srcRoot, targetRoot);
            } catch (e) {
                if (e && e.code === 'EXDEV') {
                    await fs.promises.cp(srcRoot, targetRoot, { recursive: true, force: true });
                } else {
                    throw e;
                }
            }
            try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
            try { await fs.promises.unlink(zipFile); } catch (e) { /* 忽略 */ }
            emit({ type: 'progress', taskId: task, stage: 'extract', percent: 60 });

            // 6) 安装依赖
            if (!skipDeps) {
                emit({ type: 'stage', stage: 'deps', taskId: task, text: '正在安装依赖（可能需要几分钟，下方每 5 秒有一次心跳）…' });
                const npm = await resolveNpm(node); // 🛡️ AR-84：解析 npm 绝对路径 + 注入 PATH
                if (!npm.resolved) log('⚠️ 未找到 npm 的绝对路径，回退按 PATH 查找');
                log(`📦 依赖安装命令：${npm.mode === 'node-cli' ? 'node + npm-cli.js' : npm.cmd}｜源：${net.registry.key === 'npm-mirror' ? '国内镜像' : '官方'}`);
                const registryArgs = net.registry.key === 'npm-mirror' ? [`--registry=${net.registry.url}`] : [];
                const code = await runStreamed(
                    task,
                    npm.cmd,
                    [...npm.argsPrefix, 'install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--no-progress', '--omit=dev', ...registryArgs],
                    { cwd: targetRoot, env: npm.env, heartbeatMs: 5000, heartbeatProbe: () => countInstalled(targetRoot) },
                );
                if (code === -3) {
                    return { success: false, cancelled: true, error: '已取消（依赖可能不完整，可稍后点「重装依赖」补齐）', stRoot: targetRoot, logsDir };
                }
                if (code !== 0) {
                    return {
                        success: false,
                        error: code === -1
                            ? '依赖安装无法启动：找不到可用的 npm（请确认 Node.js 已装好并重启软件后再试）。'
                            : `依赖安装失败（退出码 ${code}）。常见原因：网络问题、杀毒软件拦截、缺少 Visual C++ 运行库。`,
                        stRoot: targetRoot,
                        logsDir,
                    };
                }
            }
            emit({ type: 'progress', taskId: task, stage: 'deps', percent: 95 });

            // 7) 写安装清单
            const manifest = {
                installedAt: new Date().toISOString(),
                branch: useBranch,
                version: (readPkg(targetRoot) || {}).version || '',
                nodeVersion: node.version,
                nodePath: node.path || '',
                source: dl.from,
                depsInstalled: !skipDeps,
            };
            await fs.promises.writeFile(
                path.join(runtimeDir, 'runtime.json'),
                JSON.stringify(manifest, null, 2),
                'utf-8',
            );

            emit({ type: 'progress', taskId: task, stage: 'done', percent: 100 });
            const info = await inspect(dir);
            return { success: true, stRoot: targetRoot, version: manifest.version, info };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        } finally {
            // 🧹 任务收尾：清掉取消信号与 AbortController，避免残留状态影响下一次安装
            taskAborts.delete(task);
            cancelledTasks.delete(task);
        }
    };

    /** 仅重装依赖 */
    const installDeps = async ({ dirPath, taskId } = {}) => {
        const task = taskId || `deps-${Date.now()}`;
        const ctrl = new AbortController(); // 🛑 AR-86：让「网络探测」阶段也能被取消
        taskAborts.set(task, ctrl);
        try {
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };
            const node = await detectNode();
            if (node.level !== 'ok') return { success: false, error: node.message };
            emit({ type: 'stage', stage: 'deps', taskId: task, text: '正在安装依赖（可能需要几分钟，下方每 5 秒有一次心跳）…' });
            // 🌐 重装依赖同样先测网络（决定用官方 registry 还是国内镜像）
            const net = await detectNetwork(task, ST_BRANCH_STABLE, { signal: ctrl.signal });
            if (cancelledTasks.has(task)) return { success: false, cancelled: true, error: '已取消' };
            const npm = await resolveNpm(node); // 🛡️ AR-84：解析 npm 绝对路径 + 注入 PATH
            if (!npm.resolved) log('⚠️ 未找到 npm 的绝对路径，回退按 PATH 查找');
            log(`📦 依赖安装命令：${npm.mode === 'node-cli' ? 'node + npm-cli.js' : npm.cmd}｜源：${net.registry.key === 'npm-mirror' ? '国内镜像' : '官方'}`);
            const registryArgs = net.registry.key === 'npm-mirror' ? [`--registry=${net.registry.url}`] : [];
            const code = await runStreamed(
                task,
                npm.cmd,
                [...npm.argsPrefix, 'install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--no-progress', '--omit=dev', ...registryArgs],
                { cwd: stRoot, env: npm.env, heartbeatMs: 5000, heartbeatProbe: () => countInstalled(stRoot) },
            );
            if (code === -3) return { success: false, cancelled: true, error: '已取消（依赖可能不完整，可重新点「重装依赖」）' };
            if (code !== 0) return { success: false, error: code === -1 ? '依赖安装无法启动：找不到可用的 npm（请确认 Node.js 已装好并重启软件后再试）。' : `依赖安装失败（退出码 ${code}）` };
            const info = await inspect(dirPath);
            return { success: true, info };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        } finally {
            taskAborts.delete(task);
            cancelledTasks.delete(task);
        }
    };

    /** 检测端口是否被占用（用于启动前的占用检查） */
    const isPortBusy = (port) => new Promise((resolve) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
        srv.once('listening', () => srv.close(() => resolve(false)));
        srv.listen(port, '127.0.0.1');
    });

    /**
     * 探测某端口上是否已有服务在监听（真正连一次）。
     *
     * 不能用 isPortBusy 来判断「服务已就绪」：本机 bsd/node 绑定的是 IPv6 通配 `::`，
     * 而 isPortBusy 去 bind 127.0.0.1 —— 两者不冲突，会永远返回「不忙」，
     * 导致服务明明已起（HTTP 200）却被判为启动失败。故改为主动 TCP 连接探测。
     *
     * @param {number} port 端口
     * @param {number} timeoutMs 单次连接超时
     * @returns {Promise<boolean>} 能连上即 true
     */
    const isPortListening = (port, timeoutMs = 1200) => new Promise((resolve) => {
        const net = require('net');
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) { /* 忽略 */ }
            resolve(v);
        };
        const sock = net.connect({ port, host: '127.0.0.1' });
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
    });

    /**
     * 启动酒馆
     * @param {object} p { dirPath, port }
     */
    const startServer = async ({ dirPath, port } = {}) => {
        try {
            if (serverProc) {
                return { success: true, alreadyRunning: true, url: serverProc.url, port: serverProc.port };
            }
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };
            if (!fs.existsSync(path.join(stRoot, 'node_modules'))) {
                return { success: false, error: '依赖未安装，请先点击「重装依赖」', needDeps: true };
            }

            const node = await detectNode();
            if (node.level !== 'ok') return { success: false, error: node.message, needManualNode: true };

            const usePort = Number(port) > 0 ? Number(port) : 8000;
            const busy = await isPortBusy(usePort);
            if (busy) {
                return {
                    success: false,
                    error: `端口 ${usePort} 已被占用，请换一个端口（可能是上次未正常关闭的酒馆，或其它程序）`,
                    portBusy: true,
                    port: usePort,
                };
            }

            log(`正在启动酒馆（端口 ${usePort}）…`);
            // 用绝对 node 路径，规避 winget 装完后当前进程 PATH 未刷新的问题
            const nodeExe = node.path || (process.platform === 'win32' ? 'node.exe' : 'node');
            const child = spawn(nodeExe, ['server.js', '--port', String(usePort)], {
                cwd: stRoot,
                windowsHide: true,
                shell: false,
                env: { ...process.env, NODE_ENV: 'production' },
            });

            serverProc = { child, port: usePort, url: `http://localhost:${usePort}`, startedAt: Date.now() };

            child.stdout.on('data', (d) => {
                String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) emit({ type: 'server', text: l.trim(), ts: Date.now() }); });
            });
            child.stderr.on('data', (d) => {
                String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) emit({ type: 'server', text: l.trim(), ts: Date.now() }); });
            });
            child.on('close', (code) => {
                emit({ type: 'server-exit', code, ts: Date.now() });
                serverProc = null;
            });
            child.on('error', (e) => {
                emit({ type: 'server-exit', code: -1, error: e.message, ts: Date.now() });
                serverProc = null;
            });

            // 等待端口真正可连。
            // 大库首启很慢（本机 3.7GB / 170 会话实测需 >30 秒，因为要建索引、加载缓存），
            // 故上限放到 180 秒；期间进程若已退出则立刻判失败，不必干等。
            const WAIT_MS = 180000;
            const ok = await new Promise((resolve) => {
                const deadline = Date.now() + WAIT_MS;
                let lastReport = 0;
                const tick = async () => {
                    if (!serverProc) return resolve(false);
                    const up = await isPortListening(usePort);
                    if (up) return resolve(true);
                    if (Date.now() > deadline) return resolve(false);
                    const waited = Math.round((WAIT_MS - (deadline - Date.now())) / 1000);
                    if (waited - lastReport >= 10) {
                        lastReport = waited;
                        emit({ type: 'info', text: `等待酒馆就绪…（已 ${waited} 秒，大库首次启动较慢）`, ts: Date.now() });
                    }
                    setTimeout(tick, 500);
                };
                setTimeout(tick, 800);
            });
            if (!ok) {
                const gone = !serverProc;
                return {
                    success: false,
                    error: gone
                        ? '酒馆进程已退出，请查看日志排查（常见：依赖缺失、配置错误、Node 版本过低）'
                        : '酒馆启动后 180 秒内仍未监听端口，请查看日志排查（大库首次启动可能偏慢，可稍后再点「刷新状态」）',
                    started: !gone,
                    url: serverProc ? serverProc.url : '',
                };
            }
            return { success: true, url: `http://localhost:${usePort}`, port: usePort };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        }
    };

    /**
     * 在酒馆根目录里找「原版启动脚本」。
     *
     * 存在的意义：用户实测对比后明确反馈「原版 bat 启动更好用」，要求两种方式都能选。
     * 直接跑酒馆自带脚本，才能拿到**完全等同于双击**的行为：
     * 它自己的 `npm install` 依赖检查、`NODE_ENV=production`、`pause` 保留窗口都在脚本里。
     *
     * @param {string} stRoot 酒馆根目录
     * @returns {string} 脚本绝对路径；没有则空串
     */
    const findStartScript = (stRoot) => {
        for (const name of ['Start.bat', 'start.bat', 'Start.cmd', 'start.cmd']) {
            const p = path.join(stRoot, name);
            try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* 不存在，继续找 */ }
        }
        return '';
    };

    /**
     * 按端口找到「正在监听」的进程 PID 及其命令行（只读，用于停止前核对身份）。
     * @param {number} port
     * @returns {Promise<{pid:number, cmd:string}>}
     */
    const findListenerByPort = (port) => new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve({ pid: 0, cmd: '' });
        const { execFile } = require('child_process');
        const ps = [
            '-NoProfile', '-NonInteractive', '-Command',
            `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
            'if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue; ' +
            'Write-Output ("{0}|{1}" -f $c.OwningProcess, $p.CommandLine) }',
        ];
        execFile('powershell', ps, { encoding: 'utf-8', windowsHide: true, timeout: 10000 }, (err, stdout) => {
            if (err) return resolve({ pid: 0, cmd: '' });
            const raw = String(stdout || '').trim();
            const i = raw.indexOf('|');
            if (i < 0) return resolve({ pid: 0, cmd: '' });
            const pid = Number(raw.slice(0, i).trim()) || 0;
            resolve({ pid, cmd: raw.slice(i + 1).trim() });
        });
    });

    /**
     * 结束「终端启动」的酒馆进程（我们手里没有它的 child 句柄，只能按端口定位）。
     *
     * 安全校验（必须有）：确认该 PID 的命令行含 `server.js` 才杀。
     * 否则一旦端口被别的程序占用，会把无关进程误杀 —— 这类事故不可逆。
     *
     * @param {number} port
     */
    const killServerByPort = async (port) => {
        const { pid, cmd } = await findListenerByPort(port);
        if (!pid) {
            return { success: true, alreadyStopped: true, note: `端口 ${port} 上没有监听进程` };
        }
        if (!/server\.js/i.test(cmd)) {
            return {
                success: false,
                error: `端口 ${port} 被非酒馆程序占用（PID ${pid}），已拒绝结束。命令行：${cmd.slice(0, 120)}`,
            };
        }
        try {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } catch (e) {
            return { success: false, error: e && e.message ? e.message : String(e) };
        }
        // 等端口真正释放（最多 10 秒）
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (!(await isPortListening(port))) break;
        }
        const stillUp = await isPortListening(port);
        return stillUp
            ? { success: false, error: '已发送结束指令，但端口仍在监听，请稍后重试' }
            : { success: true, killedPid: pid };
    };

    /**
     * 🖥️ 终端窗口启动（原版体验）
     * ─────────────────────────────────────────────────────────────
     * 与 `startServer`（软件托管）的关键差别：
     *   1. 日志直连控制台，**不经过本软件的 stdout 管道** ⇒ 无背压、可 Ctrl+C、可滚动翻历史；
     *   2. `detached` 独立进程树 ⇒ **关掉本软件不影响酒馆**（软件托管的会被 taskkill /T 一并结束）；
     *   3. 直接跑酒馆自带的 `Start.bat`（含它自己的 npm install / NODE_ENV / pause），
     *      没有脚本时才回退 `node server.js --port N`。
     *
     * 代价：拿不到 child 句柄 ⇒ 停止改走「按端口定位 PID + 校验 server.js 后结束」。
     *
     * @param {object} p { dirPath, port }
     */
    const startServerConsole = async ({ dirPath, port } = {}) => {
        try {
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };

            const usePort = Number(port) > 0 ? Number(port) : 8000;
            const url = `http://localhost:${usePort}`;

            // 已经在跑就直接复用，不再开第二个窗口（否则会出现「端口冲突」的假故障）
            if (await isPortListening(usePort)) {
                return { success: true, alreadyRunning: true, url, port: usePort, mode: 'console' };
            }
            if (await isPortBusy(usePort)) {
                return {
                    success: false,
                    error: `端口 ${usePort} 已被占用，请换一个端口（可能是上次未正常关闭的酒馆，或其它程序）`,
                    portBusy: true,
                    port: usePort,
                };
            }

            if (process.platform !== 'win32') {
                return { success: false, error: '「终端启动」目前仅支持 Windows（其它系统请用软件启动）' };
            }

            const script = findStartScript(stRoot);
            if (!script) {
                const node = await detectNode();
                if (node.level !== 'ok') return { success: false, error: node.message, needManualNode: true };
            }

            // `start` 是 cmd 内建命令，第一个参数是窗口标题（必须显式给空串，
            // 否则带空格的路径会被当成标题，窗口一闪就没了）。
            // shell:true 让 cmd 负责解析；stdio:'ignore' 确保不继承我们的管道；detached 让新窗口独立存活。
            // ⚠️ 端口参数用 `--port`：Start.bat 是 `node server.js %*` 透传，SillyTavern 只认 `--port`，
            //    写成 `/port` 会被它当成未知参数忽略，结果仍然起在默认端口上。
            const cmdLine = script
                ? `start "" "${script}"${usePort !== 8000 ? ` --port ${usePort}` : ''}`
                : `start "" node server.js --port ${usePort}`;
            log(`正在终端窗口中启动酒馆（端口 ${usePort}）… ${script ? '脚本：' + path.basename(script) : '（无启动脚本，回退 node server.js）'}`);

            const child = spawn(cmdLine, {
                cwd: stRoot,
                shell: true,
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
                env: { ...process.env },
            });
            child.unref();

            let spawnErr = '';
            child.on('error', (e) => { spawnErr = e && e.message ? e.message : String(e); });

            // 等端口起来（Start.bat 里可能先跑 npm install，给足时间）
            const WAIT_MS = 180000;
            const startedAt = Date.now();
            let lastReport = 0;
            while (Date.now() - startedAt < WAIT_MS) {
                if (spawnErr) return { success: false, error: '无法打开终端窗口：' + spawnErr, mode: 'console' };
                if (await isPortListening(usePort)) {
                    return {
                        success: true,
                        url,
                        port: usePort,
                        mode: 'console',
                        script: script ? path.basename(script) : '',
                    };
                }
                const waited = Math.round((Date.now() - startedAt) / 1000);
                if (waited - lastReport >= 10) {
                    lastReport = waited;
                    emit({ type: 'info', text: `等待终端里的酒馆就绪…（已 ${waited} 秒，首次会先跑依赖安装）`, ts: Date.now() });
                }
                await new Promise((r) => setTimeout(r, 600));
            }
            return {
                success: false,
                error: '终端已打开，但 180 秒内未监听端口，请查看该终端窗口里的报错信息',
                mode: 'console',
                script: script ? path.basename(script) : '',
            };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err), mode: 'console' };
        }
    };

    /** 停止酒馆 */
    const stopServer = async ({ port } = {}) => {
        if (!serverProc) {
            // 没有托管进程 ⇒ 可能是「终端启动」或用户自己双击 bat 起的：按端口定位后结束
            const p = Number(port) > 0 ? Number(port) : 8000;
            if (!(await isPortListening(p))) return { success: true, alreadyStopped: true };
            return await killServerByPort(p);
        }
        const { child } = serverProc;
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } else {
                child.kill('SIGTERM');
            }
        } catch (e) { /* 忽略 */ }
        // 等它真的退出（最多 10 秒）
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 10000);
            child.once('close', () => { clearTimeout(t); resolve(); });
        });
        serverProc = null;
        return { success: true };
    };

    /**
     * 查询服务状态。
     * 除了看内存里的 serverProc，还要实际探一次端口 ——
     * 用户可能用 start.bat 自己启动、或本软件重启过（内存标记丢失），
     * 只要端口在监听就应视作「运行中」。
     * @returns {Promise<{running:boolean,url:string,port:number,startedAt:number,tracked:boolean}>}
     */
    const getServerStatus = async () => {
        const port = serverProc ? serverProc.port : 8000;
        const listening = await isPortListening(port);
        return {
            running: listening || !!serverProc,
            url: (listening || serverProc) ? `http://localhost:${port}` : '',
            port: (listening || serverProc) ? port : 0,
            startedAt: serverProc ? serverProc.startedAt : 0,
            tracked: !!serverProc,
        };
    };

    // ==================== 环境体检 ====================

    /** 安全读取目录条目名（失败返回空数组） */
    const safeReaddir = (dir) => {
        try { return fs.readdirSync(dir); } catch (e) { return []; }
    };

    /** 查询某路径所在磁盘的剩余空间（字节；失败返回 0） */
    const getFreeBytes = (dir) => {
        try {
            const drv = path.parse(path.resolve(dir)).root.replace(/[:\\]/g, '');
            const { execFileSync } = require('child_process');
            const out = execFileSync('powershell', [
                '-NoProfile', '-Command',
                `(Get-PSDrive -Name '${drv}' -ErrorAction SilentlyContinue).Free`,
            ], { encoding: 'utf-8', windowsHide: true, timeout: 8000 });
            return Number(String(out).trim()) || 0;
        } catch (e) {
            return 0;
        }
    };

    /**
     * 对某个已装酒馆做「环境体检」。
     *
     * 目的：把「装完之后跑不起来」的常见成因一次性摆给用户看，
     * 而不是等点「启动」失败后只丢一句含糊的错误。
     *
     * 检查项（每项都带 status / detail / hint，UI 直接渲染）：
     *   程序文件 / 版本 / Node.js / 依赖 / 配置文件 / 数据目录 /
     *   端口占用 / 磁盘空间 / git 状态 / 运行状态
     *
     * @param {object} p { dirPath }
     * @returns {Promise<{success:boolean, stRoot?:string, checks?:Array, summary?:object, elapsedMs?:number, error?:string}>}
     */
    const diagnose = async ({ dirPath } = {}) => {
        const startedAt = Date.now();
        const dir = String(dirPath || '').trim();
        if (!dir) return { success: false, error: '未选择目录' };

        /** @type {Array<{id:string,label:string,status:'ok'|'warn'|'error',detail:string,hint:string}>} */
        const checks = [];
        const add = (id, label, status, detail, hint = '') => checks.push({ id, label, status, detail, hint });

        // ---------- 0. 网络（放最前面：安装/升级能否成功首先取决于它，空目录也要给结论） ----------
        try {
            const net = await detectNetwork('diag-network', ST_BRANCH_STABLE);
            const best = net.order && net.order.length ? net.order[0] : null;
            const regLabel = net.registry && net.registry.key === 'npm-mirror' ? '国内镜像' : '官方源';
            if (!net.ok) {
                add('network', '网络', 'error', 'GitHub 直连与所有加速镜像都连不上',
                    '请检查网络/代理后重试；「一键安装」需要能访问 GitHub 或其加速镜像');
            } else if (best && best.key === 'github-direct') {
                add('network', '网络', 'ok', `GitHub 直连可用（${best.ms}ms）｜npm 将用${regLabel}`);
            } else {
                add('network', '网络', 'warn',
                    `GitHub 直连不可用，将改用镜像 ${best ? best.label : '?'}（${best ? best.ms : '?'}ms）｜npm 将用${regLabel}`,
                    '走镜像可以正常安装，只是速度取决于镜像');
            }
        } catch (e) {
            add('network', '网络', 'warn', `网络探测失败：${(e && e.message) || e}`, '可忽略；安装时会再次自动探测');
        }

        // ---------- 1. 定位酒馆根（🗂️ 空目录 = 待安装，不是「必须修复」） ----------
        let stRoot = '';
        try { stRoot = findStRoot(dir); } catch (e) { /* 忽略 */ }
        const dirExists = fs.existsSync(dir);
        const topEntries = dirExists ? safeReaddir(dir) : [];
        const topLower = topEntries.map((x) => String(x).toLowerCase());
        const dirState = classifyDirState({
            exists: dirExists,
            entries: topEntries,
            stRoot,
            hasServerJs: topLower.includes('server.js'),
            hasPublic: topLower.includes('public'),
        });
        /** 还没装酒馆（空目录 / 目录不存在）→ 体检结论应说「可以安装」，而不是「一切正常」 */
        const installReady = dirState.kind === 'empty' || dirState.kind === 'missing';
        if (!stRoot) add('structure', '酒馆目录', dirState.status, dirState.detail, dirState.hint);

        // ---------- 2~3. 程序文件 / 版本（需要先定位到酒馆根） ----------
        if (stRoot) {
            const stEntries = safeReaddir(stRoot);
            const lower = stEntries.map((x) => String(x).toLowerCase());
            const required = ['server.js', 'public', 'package.json'];
            const missing = required.filter((n) => !lower.includes(n));
            if (missing.length) {
                add('structure', '程序文件', 'error', `缺少 ${missing.join('、')}`, '安装不完整，建议「一键安装」重装或重新拉取代码');
            } else {
                add('structure', '程序文件', 'ok', 'server.js / public / package.json 齐全');
            }

            const pkg = readPkg(stRoot);
            const version = pkg ? String(pkg.version || '') : '';
            if (pkg && version) {
                const engines = pkg.engines && pkg.engines.node ? String(pkg.engines.node) : '';
                add('version', '酒馆版本', 'ok', `v${version}${engines ? `（要求 Node ${engines}）` : ''}`);
            } else if (pkg) {
                add('version', '酒馆版本', 'warn', 'package.json 里没有 version 字段', '可能不是官方发布版，升级时可能受影响');
            } else {
                add('version', '酒馆版本', 'warn', '读不到 package.json（或无 version）', '建议检查文件是否损坏');
            }
        }

        // ---------- 4. Node.js ----------
        let node = null;
        try { node = await detectNode(); } catch (e) { /* 忽略 */ }
        if (node && node.level === 'ok') {
            add('node', 'Node.js', 'ok', `v${node.version}（${node.path || '系统 PATH'}）`);
        } else if (node && node.level === 'too-old') {
            add('node', 'Node.js', 'error', node.message || `版本过低（v${node.version || '?'}）`, '请在 Node.js 官网或 winget 升级到 20 或更高版本');
        } else {
            add('node', 'Node.js', 'error', '未检测到 Node.js', '酒馆是 Node 工程，必须先装 Node 20+；可点页面上的「一键安装 Node」');
        }

        // ---------- 5~7. 依赖 / 配置 / 数据（需要酒馆根） ----------
        if (stRoot) {
            const nmDir = path.join(stRoot, 'node_modules');
            if (!fs.existsSync(nmDir)) {
                add('deps', '依赖包', 'error', '未安装依赖（node_modules 不存在）', '点「🔄 重装依赖」即可');
            } else {
                // 抽查酒馆运行必需的核心包
                const corePkgs = ['express', 'yaml'];
                const missCore = corePkgs.filter((p) => !fs.existsSync(path.join(nmDir, p)));
                const nmCount = safeReaddir(nmDir).length;
                if (missCore.length) {
                    add('deps', '依赖包', 'error', `node_modules 存在但缺少核心包：${missCore.join('、')}`, '点「🔄 重装依赖」修复');
                } else if (nmCount < 50) {
                    add('deps', '依赖包', 'warn', `node_modules 只有 ${nmCount} 个条目，可能装得不完整`, '建议点「🔄 重装依赖」');
                } else {
                    add('deps', '依赖包', 'ok', `已安装（node_modules 共 ${nmCount} 个条目）`);
                }
            }

            const cfgPath = path.join(stRoot, 'config.yaml');
            if (fs.existsSync(cfgPath)) {
                let size = 0;
                try { size = fs.statSync(cfgPath).size; } catch (e) { /* 忽略 */ }
                add('config', '配置文件', 'ok', `config.yaml 存在（${formatBytes(size)}）`);
            } else {
                add('config', '配置文件', 'warn', '没有 config.yaml', '首次启动时酒馆会按默认模板自动生成，通常不影响使用');
            }

            const dataDir = path.join(stRoot, 'data');
            if (!fs.existsSync(dataDir)) {
                add('data', '数据目录', 'warn', '没有 data 目录', '全新安装时属正常，首次启动会自动创建');
            } else {
                const counts = countStData(dataDir);
                add('data', '数据目录', 'ok', `${counts.cards} 张角色卡 · ${counts.worldbooks} 本世界书 · ${counts.chats} 个会话`);
            }
        }

        // ---------- 8. 端口 ----------
        const PORT = 8000;
        const listening = await isPortListening(PORT);
        const trackedByUs = !!serverProc;
        if (listening && trackedByUs) {
            add('port', '端口', 'ok', `端口 ${PORT} 正在被本软件启动的酒馆占用（运行中）`);
        } else if (listening) {
            add('port', '端口', 'warn', `端口 ${PORT} 已被占用（不是本软件启动的进程）`, '可能是你手动开着的酒馆，或别的程序。启动前请先停掉，或在启动时换端口');
        } else {
            add('port', '端口', 'ok', `端口 ${PORT} 空闲`);
        }

        // ---------- 9. 磁盘空间 ----------
        const free = getFreeBytes(stRoot || dir);
        if (free > 0) {
            const GB = 1024 ** 3;
            if (free < 2 * GB) {
                add('disk', '磁盘空间', 'error', `仅剩 ${formatBytes(free)}`, '空间不足可能导致聊天记录/备份写入失败，建议清理磁盘');
            } else if (free < 5 * GB) {
                add('disk', '磁盘空间', 'warn', `剩余 ${formatBytes(free)}`, '空间偏紧，建议预留 5GB 以上');
            } else {
                add('disk', '磁盘空间', 'ok', `剩余 ${formatBytes(free)}`);
            }
        } else {
            add('disk', '磁盘空间', 'warn', '无法读取剩余空间', '可忽略，或用系统「此电脑」自行查看');
        }

        // ---------- 10. git 状态（需要酒馆根） ----------
        if (stRoot) {
            const gitDir = path.join(stRoot, '.git');
            if (!fs.existsSync(gitDir)) {
                add('git', '升级方式', 'warn', '不是 git 仓库（无 .git）', '升级时将改用「下载覆盖」方式，仍可正常升级');
            } else {
                const gitVer = await runOnce('git', ['--version']);
                if (!gitVer.ok) {
                    add('git', '升级方式', 'warn', '是 git 仓库，但系统未安装 Git', '安装 Git 后可增量升级；否则用覆盖方式');
                } else {
                    const st = await runOnce('git', ['-c', 'core.quotepath=false', 'status', '--porcelain'], { cwd: stRoot });
                    const dirtyLines = st.ok ? String(st.out || '').split(/\r?\n/).filter((l) => l.trim()) : [];
                    // 未跟踪文件（xx.bak、pnpm-lock.yaml 等）不会阻碍升级，单独计数
                    const trackedCount = dirtyLines.filter((l) => !/^\?\?/.test(l)).length;
                    const untrackedCount = dirtyLines.length - trackedCount;
                    if (trackedCount > 0) {
                        // 这些改动（多半来自扩展自动注入，如 cocktail-plus 改 public/index.html）
                        // 升级时会**自动备份 + 自动收起 + 升级后自动恢复**，用户无需懂 git
                        add(
                            'git', 'git 状态', 'ok',
                            `有 ${trackedCount} 处本地改动${untrackedCount ? `、${untrackedCount} 个未跟踪文件` : ''}`,
                            '升级时会自动备份并尽量保留，无需手动处理',
                        );
                    } else {
                        add('git', 'git 状态', 'ok', `工作区干净，可安全升级${untrackedCount ? `（另有 ${untrackedCount} 个未跟踪文件，不影响升级）` : ''}`);
                    }
                }
            }
        }

        // ---------- 11. 运行状态 ----------
        try {
            const s = await getServerStatus();
            if (s.running && s.tracked) {
                add('running', '运行状态', 'ok', `本软件启动的酒馆正在运行：${s.url}`);
            } else if (s.running) {
                // 端口有人监听 ≠ 本软件启动的酒馆：不要重复报警（「端口」一项已说明），也别让用户以为「已经在跑了」
                add('running', '运行状态', 'ok', '本软件当前没有启动酒馆（端口上另有程序在监听，见上一条「端口」）');
            } else {
                add('running', '运行状态', 'ok', '当前未运行');
            }
        } catch (e) {
            add('running', '运行状态', 'warn', '无法获取运行状态', '可点「重新检测」重试');
        }

        return {
            success: true,
            stRoot,
            dirState: dirState.kind,
            installReady,
            checks,
            summary: summarizeChecks(checks),
            elapsedMs: Date.now() - startedAt,
        };
    };

    // ==================== 升级 ====================

    /**
     * 检查是否有新版本。
     *
     * ⚠️ 没有这个函数时，UI 只能「只要装了酒馆就显示升级按钮」——
     *    用户点完升级、关掉再打开，按钮还是「升级」，永远不知道到底升没升到最新
     *    （用户实测吐槽：「本地已经是最新版本了点击升级后怎么还要升级」）。
     *
     * 远程版本两条来源，按成本从低到高：
     *   ① git 仓库：`git ls-remote --tags`（只取引用，不下载代码，几百 ms）
     *   ② 非 git / 上面失败：GitHub API `releases/latest`
     *
     * @param {object} p { dirPath }
     * @returns {Promise<{success:boolean, currentVersion?:string, latestVersion?:string, hasUpdate?:boolean, source?:string, error?:string}>}
     */
    const checkUpdate = async ({ dirPath } = {}) => {
        try {
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };

            const pkg = readPkg(stRoot);
            const currentVersion = pkg ? String(pkg.version || '').trim() : '';

            let latestVersion = '';
            let source = '';

            // ---------- ① git 仓库：ls-remote 取 tag 列表 ----------
            if (fs.existsSync(path.join(stRoot, '.git'))) {
                const r = await runOnce('git', ['ls-remote', '--tags', '--refs', 'origin'], {
                    cwd: stRoot,
                    timeoutMs: 30000,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                });
                if (r.ok) {
                    const tags = String(r.out || '')
                        .split(/\r?\n/)
                        .map((l) => (l.split(/\s+/).pop() || '').replace(/^refs\/tags\//i, ''))
                        .filter(Boolean);
                    latestVersion = pickLatestVersion(tags);
                    if (latestVersion) source = 'git-tags';
                }
            }

            // ---------- ② 兜底：GitHub API ----------
            if (!latestVersion) {
                try {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 15000);
                    const res = await fetch(`https://api.github.com/repos/${ST_REPO}/releases/latest`, {
                        headers: { 'User-Agent': 'SillyTavern-Manager', Accept: 'application/vnd.github+json' },
                        signal: ctrl.signal,
                    });
                    clearTimeout(timer);
                    if (res.ok) {
                        const j = await res.json();
                        const v = String(j.tag_name || j.name || '').trim().replace(/^v/i, '');
                        if (/^\d+\.\d+\.\d+$/.test(v)) { latestVersion = v; source = 'github-api'; }
                    }
                } catch (e) { /* 网络不通就算了，不阻断 UI */ }
            }

            const hasUpdate = !!(currentVersion && latestVersion && compareSemver(latestVersion, currentVersion) > 0);
            return { success: true, currentVersion, latestVersion, hasUpdate, source };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        }
    };

    /**
     * 升级酒馆
     * 策略：有 .git 用 git pull；否则 zip 覆盖（但绝不覆盖 data/ 与 config.yaml）
     */
    const update = async ({ dirPath, taskId } = {}) => {
        const task = taskId || `update-${Date.now()}`;
        const ctrl = new AbortController(); // 🛑 AR-86：升级也能在下载阶段被取消
        taskAborts.set(task, ctrl);
        try {
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };
            if (serverProc) return { success: false, error: '请先停止酒馆再升级' };

            const hasGit = fs.existsSync(path.join(stRoot, '.git'));
            if (hasGit) {
                const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
                const gitOk = await runOnce('git', ['--version']);
                if (!gitOk.ok) {
                    return { success: false, error: '检测到 git 仓库，但系统未安装 Git。请安装 Git 后重试，或选择「重新下载覆盖」' };
                }

                // ==================== ① 处理本地改动（傻瓜式） ====================
                // 为什么必须自动处理：酒馆的一些扩展（如 cocktail-plus）会在启动时
                // **自动往 public/index.html 注入 script 标签**，用户完全不知情。
                // 直接 `git pull` 必然报
                //   error: Your local changes to the following files would be overwritten by merge
                // 然后要求用户 commit / stash —— 这对普通用户就是天书（实测踩过）。
                //
                // 因此这里自动完成：备份改动文件 → stash → pull → 尝试恢复。
                // 用户只需要点一次「升级」，不必理解任何 git 概念。
                emit({ type: 'stage', stage: 'check', taskId: task, text: '检查本地改动…' });
                const dirty = await runOnce(
                    'git',
                    ['-c', 'core.quotepath=false', 'status', '--porcelain'],
                    { cwd: stRoot, env: gitEnv, timeoutMs: 30000 },
                );
                const dirtyLines = String(dirty.out || '').split(/\r?\n/).filter((l) => l.trim());
                // 只关心**已跟踪文件**的改动：未跟踪文件（如 xx.bak、pnpm-lock.yaml）不会阻止 pull
                const trackedChanges = dirtyLines
                    .filter((l) => !/^\?\?/.test(l))
                    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
                    .filter(Boolean);

                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                let backupDir = '';
                let stashed = false;

                if (trackedChanges.length) {
                    // 先把这些文件**逐个复制**到备份目录（双保险：即使 stash 出问题也能找回原文）
                    backupDir = path.join(path.dirname(stRoot), RUNTIME_DIRNAME, 'backups', `local-changes-${stamp}`);
                    let copied = 0;
                    for (const rel of trackedChanges) {
                        const src = path.join(stRoot, rel);
                        const dst = path.join(backupDir, rel);
                        try {
                            await fs.promises.mkdir(path.dirname(dst), { recursive: true });
                            await fs.promises.copyFile(src, dst);
                            copied++;
                        } catch (e) { /* 单个文件失败不阻断 */ }
                    }
                    emit({
                        type: 'log',
                        taskId,
                        ts: Date.now(),
                        text: `检测到 ${trackedChanges.length} 个本地改动（${trackedChanges.slice(0, 3).join('、')}${trackedChanges.length > 3 ? ' 等' : ''}），已备份 ${copied} 个到：${backupDir}`,
                    });

                    // stash 掉这些改动，让 pull 顺利执行
                    const st = await runStreamed(task, 'git', ['stash', 'push', '-m', `jsk-before-update-${stamp}`], {
                        cwd: stRoot,
                        env: gitEnv,
                        timeoutMs: 60000,
                    });
                    if (st === 0) {
                        stashed = true;
                        emit({ type: 'log', taskId, ts: Date.now(), text: '本地改动已临时收起，开始升级…' });
                    } else {
                        // stash 失败（极少见）：不硬来，如实报告并中止，磁盘保持原样
                        return {
                            success: false,
                            error: `本地有 ${trackedChanges.length} 个改动，自动收起失败（git stash 返回 ${st}）。已备份到：${backupDir}。可手动处理后重试`,
                        };
                    }
                }

                // ==================== ② 拉取最新代码 ====================
                emit({ type: 'stage', stage: 'update', taskId: task, text: '正在 git pull…' });
                const code = await runStreamed(task, 'git', ['pull', '--ff-only'], {
                    cwd: stRoot,
                    // 3 分钟：正常 pull 远用不了这么久；超时通常是网络挂死或等待认证
                    timeoutMs: 180000,
                    env: gitEnv,
                });

                // pull 失败 → 把改动**原样放回**，磁盘回到升级前状态
                if (code === -2 || code !== 0) {
                    if (stashed) {
                        await runStreamed(task, 'git', ['stash', 'pop'], { cwd: stRoot, env: gitEnv, timeoutMs: 60000 });
                        emit({ type: 'log', taskId, ts: Date.now(), text: '升级失败，你的本地改动已放回原处' });
                    }
                    if (code === -2) {
                        return {
                            success: false,
                            error: 'git pull 超时（3 分钟未完成）。多半是网络问题，或该仓库需要登录认证。请检查网络后重试',
                        };
                    }
                    return {
                        success: false,
                        error: 'git pull 失败（可能是分支分叉或网络问题）。你原有的本地改动已恢复，可重试或改用「重新下载覆盖」',
                    };
                }

                // ==================== ③ 恢复本地改动 ====================
                let restoreNote = '';
                if (stashed) {
                    emit({ type: 'stage', stage: 'restore', taskId: task, text: '恢复本地改动…' });
                    const pop = await runStreamed(task, 'git', ['stash', 'pop'], {
                        cwd: stRoot,
                        env: gitEnv,
                        timeoutMs: 60000,
                    });
                    if (pop === 0) {
                        restoreNote = '你的本地改动已自动保留';
                        emit({ type: 'log', taskId, ts: Date.now(), text: `✅ ${restoreNote}` });
                    } else {
                        // 与新版冲突：清掉冲突标记让程序能正常跑，原文仍在备份目录
                        await runStreamed(task, 'git', ['checkout', '--', '.'], { cwd: stRoot, env: gitEnv, timeoutMs: 60000 });
                        // 丢弃这个已冲突的 stash，避免下次升级反复撞同一个冲突（原文已备份到 backupDir）
                        await runStreamed(task, 'git', ['stash', 'drop'], { cwd: stRoot, env: gitEnv, timeoutMs: 30000 });
                        restoreNote = `有 ${trackedChanges.length} 个改动与新版冲突，已改用新版文件；你原来的内容完整备份在 ${backupDir}`;
                        emit({ type: 'log', taskId, ts: Date.now(), text: `⚠️ ${restoreNote}` });
                    }
                }

                const info = await inspect(dirPath);
                return { success: true, mode: 'git', info, restoreNote, backupDir, changedFiles: trackedChanges };
            }

            // 无 git：先备份 data 与 config，再 zip 覆盖
            emit({ type: 'stage', stage: 'backup', taskId: task, text: '升级前备份数据…' });
            const backup = await backupData(dirPath, 'before-update');
            if (!backup.success) return { success: false, error: `备份失败，已中止升级：${backup.error}` };

            emit({ type: 'stage', stage: 'download', taskId: task, text: '正在下载新版本…' });
            const runtimeDir = path.join(path.dirname(stRoot), RUNTIME_DIRNAME);
            await fs.promises.mkdir(runtimeDir, { recursive: true });
            const zipFile = path.join(runtimeDir, 'st-update.zip');
            // 🌐 升级同样先测网络，选最快的源
            const net = await detectNetwork(task, ST_BRANCH_STABLE, { signal: ctrl.signal });
            if (!net.ok) return { success: false, error: '❌ 网络不可用：GitHub 直连与所有加速镜像都连不上，请检查网络后重试' };
            const dl = await downloadZip(net.candidates, zipFile, { taskId: task, signal: ctrl.signal });
            if (!dl.ok) {
                if (dl.cancelled || cancelledTasks.has(task)) return { success: false, cancelled: true, error: '已取消升级' };
                if (dl.partial) {
                    return { success: false, error: `下载中断（已保存 ${formatBytes(dl.bytes)}），网络恢复后再点「升级」会从断点继续`, partial: true };
                }
                return { success: false, error: '下载失败，所有源都不可用' };
            }

            const tmpDir = path.join(runtimeDir, `extract-${Date.now()}`);
            await fs.promises.mkdir(tmpDir, { recursive: true });
            const ex = await extractZip(zipFile, tmpDir);
            if (!ex.ok) return { success: false, error: `解压失败：${ex.error}` };
            const srcRoot = findStRoot(tmpDir);
            if (!srcRoot) return { success: false, error: '新版本内容不是有效酒馆工程' };

            // 保留用户数据：先把 data/ 与 config.yaml 从旧目录移到旁边
            emit({ type: 'stage', stage: 'replace', taskId: task, text: '正在替换程序文件…' });
            const keepData = path.join(runtimeDir, 'keep-data');
            const keepCfg = path.join(runtimeDir, 'keep-config.yaml');
            try { await fs.promises.rm(keepData, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
            if (fs.existsSync(path.join(stRoot, 'data'))) {
                await fs.promises.rename(path.join(stRoot, 'data'), keepData);
            }
            if (fs.existsSync(path.join(stRoot, 'config.yaml'))) {
                await fs.promises.rename(path.join(stRoot, 'config.yaml'), keepCfg);
            }

            // 删除旧程序文件（保留 node_modules 以复用，除非用户要求重装）
            const keepNames = new Set(['node_modules']);
            const oldEntries = await fs.promises.readdir(stRoot, { withFileTypes: true });
            for (const e of oldEntries) {
                if (keepNames.has(e.name)) continue;
                await fs.promises.rm(path.join(stRoot, e.name), { recursive: true, force: true }).catch(() => {});
            }
            // 复制新文件
            const newEntries = await fs.promises.readdir(srcRoot, { withFileTypes: true });
            for (const e of newEntries) {
                await fs.promises.cp(path.join(srcRoot, e.name), path.join(stRoot, e.name), {
                    recursive: true,
                    force: true,
                }).catch(() => {});
            }
            // 回填数据
            if (fs.existsSync(keepData)) await fs.promises.rename(keepData, path.join(stRoot, 'data'));
            if (fs.existsSync(keepCfg)) await fs.promises.rename(keepCfg, path.join(stRoot, 'config.yaml'));

            try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
            try { await fs.promises.unlink(zipFile); } catch (e) { /* 忽略 */ }

            const info = await inspect(dirPath);
            return { success: true, mode: 'zip', info, backup: backup.path };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        } finally {
            taskAborts.delete(task);
            cancelledTasks.delete(task);
        }
    };

    // ==================== 备份 ====================

    /**
     * 备份酒馆 data/ 目录（可选含 config.yaml）为 zip
     * 用系统 tar 打包，避免引入新依赖。
     */
    const backupData = async (dirPath, tag = 'backup') => {
        try {
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };
            const dataDir = path.join(stRoot, 'data');
            if (!fs.existsSync(dataDir)) return { success: true, path: '', skipped: true };

            const runtimeDir = path.join(path.dirname(stRoot), RUNTIME_DIRNAME);
            const backupsDir = path.join(runtimeDir, 'backups');
            await fs.promises.mkdir(backupsDir, { recursive: true });

            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const outFile = path.join(backupsDir, `data-${tag}-${stamp}.zip`);

            const code = await new Promise((resolve) => {
                const tar = spawn('tar', ['-a', '-c', '-f', outFile, '-C', stRoot, 'data'], { windowsHide: true });
                let err = '';
                tar.stderr.on('data', (d) => { err += String(d); });
                tar.on('error', () => resolve(-1));
                tar.on('close', (c) => resolve(c));
            });
            if (code !== 0) return { success: false, error: `打包失败（tar 退出码 ${code}）` };
            const st = fs.statSync(outFile);
            return { success: true, path: outFile, bytes: st.size };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        }
    };

    // ==================== 卸载（两档） ====================

    /**
     * 计算出「将要删除什么」，供弹窗展示。
     * 只读，不做任何删除。
     * @param {object} p { dirPath, mode }
     */
    const inventory = async ({ dirPath, mode } = {}) => {
        try {
            const dir = String(dirPath || '').trim();
            const stRoot = dir ? findStRoot(dir) : '';
            const runtimeDir = stRoot ? path.join(path.dirname(stRoot), RUNTIME_DIRNAME) : (dir ? path.join(dir, RUNTIME_DIRNAME) : '');

            let stBytes = 0;
            let rtBytes = 0;
            let counts = { cards: 0, worldbooks: 0, chats: 0 };

            if (stRoot) {
                const m = measureDir(stRoot);
                stBytes = m.bytes;
                const dataDir = path.join(stRoot, 'data');
                if (fs.existsSync(dataDir)) {
                    counts = countStData(dataDir);
                }
            }
            if (runtimeDir && fs.existsSync(runtimeDir)) rtBytes = measureDir(runtimeDir).bytes;

            // 本软件自身数据
            let appDataBytes = 0;
            let appBytes = 0;
            try {
                const { app } = require('electron');
                appDataBytes = measureDir(app.getPath('userData')).bytes;
                const exeDir = path.dirname(app.getPath('exe'));
                appBytes = measureDir(exeDir, 20000).bytes;
            } catch (e) { /* 非 Electron 环境（单测）忽略 */ }

            const inv = buildUninstallInventory({
                stBytes,
                rtBytes,
                appDataBytes,
                appBytes,
                cards: counts.cards,
                worldbooks: counts.worldbooks,
                chats: counts.chats,
                mode,
            });
            return {
                success: true,
                stRoot,
                runtimeDir,
                inventory: inv,
                formatted: inv.items.map((x) => ({ label: x.label, bytes: x.bytes, text: formatBytes(x.bytes) })),
                totalText: formatBytes(inv.totalBytes),
            };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        }
    };

    /** 收集本软件相关注册表项，并按归属过滤 */
    const listUninstallEntries = () => {
        if (process.platform !== 'win32') return { entries: [], owned: [], skipped: [] };
        const { execFileSync } = require('child_process');
        const roots = [
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        ];
        // 允许的路径：本软件 exe 目录
        const ownedPaths = [];
        try {
            const { app } = require('electron');
            ownedPaths.push(path.dirname(app.getPath('exe')));
        } catch (e) { /* 忽略 */ }

        const entries = [];
        for (const root of roots) {
            let names = [];
            try {
                const out = execFileSync('reg', ['query', root], { encoding: 'utf-8', windowsHide: true });
                names = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && /\\Uninstall\\/i.test(l));
            } catch (e) { continue; }
            for (const key of names) {
                try {
                    const out = execFileSync('reg', ['query', key], { encoding: 'utf-8', windowsHide: true });
                    const get = (name) => {
                        const m = out.match(new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.+)`));
                        return m ? m[1].trim() : '';
                    };
                    const item = {
                        key,
                        DisplayName: get('DisplayName'),
                        Publisher: get('Publisher'),
                        UninstallString: get('UninstallString'),
                        InstallLocation: get('InstallLocation'),
                    };
                    if (item.DisplayName) entries.push(item);
                } catch (e) { /* 忽略 */ }
            }
        }
        const owned = [];
        const skipped = [];
        for (const e of entries) {
            const j = isOwnedUninstallEntry(e, { ownedPaths, ownedPublishers: ['sillytavern', 'jsk'] });
            if (j.owned) owned.push({ ...e, reason: j.reason });
            else if (/sillytavern|酒馆|资源管理器/i.test(e.DisplayName)) skipped.push({ ...e, reason: j.reason });
        }
        return { entries, owned, skipped };
    };

    /**
     * 执行卸载
     * @param {object} p { dirPath, mode, confirmText, doBackup, backupPath, relaunchUninstaller }
     * @returns {Promise<object>}
     */
    const uninstall = async ({ dirPath, mode, confirmText, doBackup, backupPath } = {}) => {
        const report = [];
        try {
            if (String(confirmText || '').trim() !== 'DELETE') {
                return { success: false, error: '确认串不正确，已中止（需输入大写 DELETE）' };
            }
            const m = Number(mode) === 2 ? 2 : 1;
            if (serverProc) return { success: false, error: '请先停止酒馆再卸载' };

            const dir = String(dirPath || '').trim();
            const stRoot = dir ? findStRoot(dir) : '';
            const runtimeDir = stRoot ? path.join(path.dirname(stRoot), RUNTIME_DIRNAME) : (dir ? path.join(dir, RUNTIME_DIRNAME) : '');

            // ── 1. 备份（必须先成功）──
            if (doBackup && stRoot) {
                emit({ type: 'stage', stage: 'backup', text: '正在备份 data/…' });
                const bk = await backupData(dir, 'uninstall');
                if (!bk.success) {
                    return { success: false, error: `备份失败，已中止卸载：${bk.error}` };
                }
                report.push(bk.skipped
                    ? { item: '备份', status: 'skip', detail: '没有 data/ 目录，无需备份' }
                    : { item: '备份', status: 'ok', detail: bk.path || backupPath || '' });
            }

            // ── 2. 删酒馆目录 ──
            if (stRoot) {
                // 安全校验：必须确认是酒馆，才允许删
                const pkg = readPkg(stRoot) || {};
                const det = detectSillyTavern(
                    (() => { try { return fs.readdirSync(stRoot); } catch (e) { return []; } })(),
                    { packageName: pkg.name },
                );
                if (!det.isSillyTavern) {
                    report.push({ item: '酒馆目录', status: 'skip', detail: '目标不是酒馆目录，已跳过（安全保护）' });
                } else {
                    emit({ type: 'stage', stage: 'delete-st', text: '正在删除酒馆…' });
                    try {
                        await fs.promises.rm(stRoot, { recursive: true, force: true, maxRetries: 3 });
                        report.push({ item: '酒馆目录', status: 'ok', detail: stRoot });
                    } catch (e) {
                        report.push({ item: '酒馆目录', status: 'fail', detail: `${stRoot} — ${e.message}` });
                    }
                }
            }

            // ── 3. 删托管区 ──
            if (runtimeDir && fs.existsSync(runtimeDir)) {
                try {
                    await fs.promises.rm(runtimeDir, { recursive: true, force: true });
                    report.push({ item: '托管区', status: 'ok', detail: runtimeDir });
                } catch (e) {
                    report.push({ item: '托管区', status: 'fail', detail: e.message });
                }
            }

            // ── 4. 注册表（仅删归属本软件的）──
            const regInfo = listUninstallEntries();
            for (const s of regInfo.skipped) {
                report.push({ item: '注册表项', status: 'skip', detail: `${s.DisplayName} — ${s.reason}` });
            }
            if (m === 2) {
                const { execFileSync } = require('child_process');
                for (const o of regInfo.owned) {
                    try {
                        execFileSync('reg', ['delete', o.key, '/f'], { windowsHide: true });
                        report.push({ item: '注册表项', status: 'ok', detail: o.DisplayName || o.key });
                    } catch (e) {
                        report.push({ item: '注册表项', status: 'fail', detail: `${o.DisplayName || o.key} — ${e.message}` });
                    }
                }
            }

            // ── 5. 本软件自身（模式 2）──
            if (m === 2) {
                let userData = '';
                let exeDir = '';
                let uninstaller = '';
                try {
                    const { app } = require('electron');
                    userData = app.getPath('userData');
                    exeDir = path.dirname(app.getPath('exe'));
                    // NSIS 卸载器通常与主程序同目录，名字含 Uninstall
                    const cands = fs.readdirSync(exeDir).filter((f) => /^uninstall.*\.exe$/i.test(f));
                    if (cands.length) uninstaller = path.join(exeDir, cands[0]);
                } catch (e) { /* 忽略 */ }

                if (userData) {
                    try {
                        await fs.promises.rm(userData, { recursive: true, force: true, maxRetries: 3 });
                        report.push({ item: '软件数据', status: 'ok', detail: userData });
                    } catch (e) {
                        report.push({ item: '软件数据', status: 'fail', detail: `${userData} — ${e.message}` });
                    }
                }
                if (uninstaller) {
                    report.push({ item: '软件本体', status: 'delegated', detail: `${uninstaller}（即将启动卸载程序）` });
                } else {
                    report.push({
                        item: '软件本体',
                        status: 'skip',
                        detail: '未找到卸载程序（可能是绿色版），请手动删除程序目录',
                    });
                }
            }

            return { success: true, report, mode: m };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err), report };
        }
    };

    return {
        inspect,
        install,
        installDeps,
        detectNode,
        detectWinget,
        installNodeViaWinget,
        cancelTask,
        findStRoot,
        scanForSillyTavern,
        diagnose,
        checkUpdate,
        isStRootStrict,
        measureDir,
        isEmptyDir,
        validateInstallPath,
        startServer,
        startServerConsole,
        stopServer,
        getServerStatus,
        isPortBusy,
        findStartScript,
        killServerByPort,
        update,
        backupData,
        inventory,
        listUninstallEntries,
        uninstall,
        _internal: { buildZipCandidates, formatBytes, downloadZip },
    };
}

module.exports = { createStManager, RUNTIME_DIRNAME, ST_REPO };
