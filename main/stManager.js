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
            child = spawn(cmd, args, {
                windowsHide: true,
                shell: false,
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
     * @param {object} [opts] { cwd, env, timeoutMs }
     * @returns {Promise<number>} 退出码；-1 启动失败/进程错误；-2 超时
     */
    const runStreamed = (taskId, cmd, args, opts = {}) => new Promise((resolve) => {
        let child;
        let done = false;
        let timer = null;
        const finish = (code) => {
            if (done) return;
            done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            resolve(code);
        };
        try {
            child = spawn(cmd, args, {
                cwd: opts.cwd || process.cwd(),
                windowsHide: true,
                shell: false,
                env: opts.env || process.env,
            });
        } catch (e) {
            log(`启动失败: ${e.message}`);
            return finish(-1);
        }
        running.set(taskId, child);

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
            finish(typeof code === 'number' ? code : -1);
        });
    });

    /** 取消任务 */
    const cancelTask = (taskId) => {
        const child = running.get(taskId);
        if (!child) return { success: false, error: '没有正在运行的任务' };
        try {
            if (process.platform === 'win32') {
                // Windows 下 npm 会派生子进程，需整棵树杀
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } else {
                child.kill('SIGTERM');
            }
            running.delete(taskId);
            return { success: true };
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

    // ==================== 下载与安装 ====================

    /** 构造候选下载地址（直连 + 镜像） */
    const buildZipCandidates = (branch) => {
        const base = `https://codeload.github.com/${ST_REPO}/zip/refs/heads/${branch}`;
        return GH_MIRRORS.map((m) => (m ? m + base : base));
    };

    /** 下载并保存到文件，返回 { ok, bytes, from } */
    const downloadZip = async (candidates, destFile) => {
        for (let i = 0; i < candidates.length; i++) {
            const url = candidates[i];
            log(`尝试下载（源 ${i + 1}/${candidates.length}）：${url}`);
            try {
                const resp = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (SillyTavern-Manager; compatible)' },
                    redirect: 'follow',
                });
                if (!resp.ok) {
                    log(`  下载失败 HTTP ${resp.status}`);
                    continue;
                }
                const buf = Buffer.from(await resp.arrayBuffer());
                if (!buf.length) { log('  内容为空，换下一个源'); continue; }
                await fs.promises.writeFile(destFile, buf);
                log(`  下载成功（${formatBytes(buf.length)}）`);
                return { ok: true, bytes: buf.length, from: url };
            } catch (e) {
                log(`  下载异常：${e.message}`);
            }
        }
        return { ok: false, bytes: 0, from: '' };
    };

    /** 解压 zip（系统 bsdtar，Windows 10+ 自带） */
    const extractZip = (zipFile, destDir) => new Promise((resolve) => {
        const tar = spawn('tar', ['-xf', zipFile, '-C', destDir], { windowsHide: true });
        let err = '';
        tar.stderr.on('data', (d) => { err += String(d); });
        tar.on('error', (e) => resolve({ ok: false, error: e.message }));
        tar.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `tar 退出码 ${code}` }));
    });

    /**
     * 一键安装
     * @param {object} p { dirPath, branch, skipDeps, taskId }
     */
    const install = async ({ dirPath, branch, skipDeps, taskId } = {}) => {
        const dir = String(dirPath || '').trim();
        const task = taskId || `install-${Date.now()}`;
        if (!dir) return { success: false, error: '请选择安装目录' };

        try {
            emit({ type: 'stage', stage: 'prepare', taskId, text: '准备安装…' });

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
            await fs.promises.mkdir(dir, { recursive: true });
            const runtimeDir = path.join(dir, RUNTIME_DIRNAME);
            await fs.promises.mkdir(runtimeDir, { recursive: true });
            const logsDir = path.join(runtimeDir, 'logs');
            await fs.promises.mkdir(logsDir, { recursive: true });

            // 3) 下载
            emit({ type: 'stage', stage: 'download', taskId, text: '正在下载酒馆…' });
            const zipFile = path.join(runtimeDir, 'st-download.zip');
            const useBranch = branch === 'dev' ? ST_BRANCH_DEV : ST_BRANCH_STABLE;
            const dl = await downloadZip(buildZipCandidates(useBranch), zipFile);
            if (!dl.ok) {
                return { success: false, error: '下载失败：所有源都不可用，请检查网络后重试' };
            }
            emit({ type: 'progress', taskId, stage: 'download', percent: 40 });

            // 4) 解压到临时目录
            emit({ type: 'stage', stage: 'extract', taskId, text: '正在解压…' });
            const tmpDir = path.join(runtimeDir, `extract-${Date.now()}`);
            await fs.promises.mkdir(tmpDir, { recursive: true });
            const ex = await extractZip(zipFile, tmpDir);
            if (!ex.ok) {
                return { success: false, error: `解压失败：${ex.error}` };
            }
            emit({ type: 'progress', taskId, stage: 'extract', percent: 55 });

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
            emit({ type: 'progress', taskId, stage: 'extract', percent: 60 });

            // 6) 安装依赖
            if (!skipDeps) {
                emit({ type: 'stage', stage: 'deps', taskId, text: '正在安装依赖（可能需要几分钟）…' });
                const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                const code = await runStreamed(
                    task,
                    npmCmd,
                    ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--no-progress', '--omit=dev'],
                    { cwd: targetRoot },
                );
                if (code !== 0) {
                    return {
                        success: false,
                        error: `依赖安装失败（退出码 ${code}）。常见原因：网络问题、杀毒软件拦截、缺少 Visual C++ 运行库。`,
                        stRoot: targetRoot,
                        logsDir,
                    };
                }
            }
            emit({ type: 'progress', taskId, stage: 'deps', percent: 95 });

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

            emit({ type: 'progress', taskId, stage: 'done', percent: 100 });
            const info = await inspect(dir);
            return { success: true, stRoot: targetRoot, version: manifest.version, info };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        }
    };

    /** 仅重装依赖 */
    const installDeps = async ({ dirPath, taskId } = {}) => {
        try {
            const stRoot = findStRoot(String(dirPath || '').trim());
            if (!stRoot) return { success: false, error: '未找到酒馆目录' };
            const node = await detectNode();
            if (node.level !== 'ok') return { success: false, error: node.message };
            const task = taskId || `deps-${Date.now()}`;
            emit({ type: 'stage', stage: 'deps', taskId: task, text: '正在安装依赖…' });
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const code = await runStreamed(
                task,
                npmCmd,
                ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--no-progress', '--omit=dev'],
                { cwd: stRoot },
            );
            if (code !== 0) return { success: false, error: `依赖安装失败（退出码 ${code}）` };
            const info = await inspect(dirPath);
            return { success: true, info };
        } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
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

        // ---------- 1. 定位酒馆根 ----------
        let stRoot = '';
        try { stRoot = findStRoot(dir); } catch (e) { /* 忽略 */ }
        if (!stRoot) {
            add('structure', '酒馆目录', 'error', '该目录不是有效的酒馆工程', '请选择酒馆根目录（应含 server.js 与 public/），或先点「一键安装」');
            return { success: true, stRoot: '', checks, summary: summarize(checks), elapsedMs: Date.now() - startedAt };
        }

        // ---------- 2. 程序文件 ----------
        const stEntries = safeReaddir(stRoot);
        const lower = stEntries.map((x) => String(x).toLowerCase());
        const required = ['server.js', 'public', 'package.json'];
        const missing = required.filter((n) => !lower.includes(n));
        if (missing.length) {
            add('structure', '程序文件', 'error', `缺少 ${missing.join('、')}`, '安装不完整，建议「一键安装」重装或重新拉取代码');
        } else {
            add('structure', '程序文件', 'ok', 'server.js / public / package.json 齐全');
        }

        // ---------- 3. 版本 ----------
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

        // ---------- 5. 依赖 ----------
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

        // ---------- 6. 配置文件 ----------
        const cfgPath = path.join(stRoot, 'config.yaml');
        if (fs.existsSync(cfgPath)) {
            let size = 0;
            try { size = fs.statSync(cfgPath).size; } catch (e) { /* 忽略 */ }
            add('config', '配置文件', 'ok', `config.yaml 存在（${formatBytes(size)}）`);
        } else {
            add('config', '配置文件', 'warn', '没有 config.yaml', '首次启动时酒馆会按默认模板自动生成，通常不影响使用');
        }

        // ---------- 7. 数据目录 ----------
        const dataDir = path.join(stRoot, 'data');
        if (!fs.existsSync(dataDir)) {
            add('data', '数据目录', 'warn', '没有 data 目录', '全新安装时属正常，首次启动会自动创建');
        } else {
            const counts = countStData(dataDir);
            add('data', '数据目录', 'ok', `${counts.cards} 张角色卡 · ${counts.worldbooks} 本世界书 · ${counts.chats} 个会话`);
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
        const free = getFreeBytes(stRoot);
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

        // ---------- 10. git 状态 ----------
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

        // ---------- 11. 运行状态 ----------
        try {
            const s = await getServerStatus();
            add('running', '运行状态', 'ok', s.running ? `运行中：${s.url}` : '当前未运行');
        } catch (e) {
            add('running', '运行状态', 'warn', '无法获取运行状态', '可点「重新检测」重试');
        }

        return {
            success: true,
            stRoot,
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
            const dl = await downloadZip(buildZipCandidates(ST_BRANCH_STABLE), zipFile);
            if (!dl.ok) return { success: false, error: '下载失败，所有源都不可用' };

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
        _internal: { buildZipCandidates, formatBytes },
    };
}

module.exports = { createStManager, RUNTIME_DIRNAME, ST_REPO };
