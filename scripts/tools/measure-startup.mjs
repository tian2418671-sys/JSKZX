/**
 * 启动性能测量（桌面版 JSK管理）
 *
 * 为什么需要它：
 *   「库加载快慢」之前都是手工杀进程 + 重定向日志 + grep 出来的，容易漏步骤、参数不一致。
 *   这里固定成一条命令，保证每次测量条件完全一致（同一 profile 状态、同一启动方式、同一解析口径）。
 *
 * 特性：
 *   · **独立临时 profile**（`--user-data-dir`）→ 绝不触碰真实配置与缓存目录；
 *     启动前把真实 profile 的 `lastFolder` 复制过来并改写成 `--library` 指定的库。
 *   · **生产模式**启动（不注入 `VITE_DEV_SERVER_URL`），即用户双击 exe 的同一条路径
 *     （依赖 `web/` 构建产物；没有就先 `npm run build:web`）。
 *   · 解析主进程转发的渲染端日志，输出 fetch / worker / assemble / 蒙版淡出 与卡片数。
 *
 * 用法：
 *   node scripts/tools/measure-startup.mjs                                  # 默认 I:\03\角色色卡 ×1
 *   node scripts/tools/measure-startup.mjs --runs 3                         # 跑 3 轮（交替/取平均）
 *   node scripts/tools/measure-startup.mjs --library "E:\AI\酒馆工具\角色卡" --runs 2
 *   node scripts/tools/measure-startup.mjs --label 冷启动 --timeout 180000   # 冷启动建议放宽超时
 *   node scripts/tools/measure-startup.mjs --keep-profile --verbose          # 保留临时 profile / 打印原始日志
 *
 * 🥶 测「冷启动」：**重启电脑后第一时间运行**（此时 OS 文件缓存未热）。
 *    移除 PNG 内嵌缓存后，每次首启都要重读每个 PNG 头，冷启动是唯一需要观察的场景。
 * 🔥 测「热启动」：直接连着跑两轮，第二轮即为热（但生产模式下每轮都是新进程）。
 *
 * ⚠️ 绝对值会随机器状态大幅波动（2026-09-13 实测同一份代码 16.0s ↔ 31.2s：VS Code/Defender
 *    抢内存带宽时，CPU/内存密集的 worker/assemble 阶段能慢 2~5 倍，而 fetch 恒稳 ~3s）。
 *    ⇒ **要下结论必须同一次会话内交替 A/B**（改前跑几轮、改后跑几轮），跨会话的绝对值只当参考区间。
 *    ⇒ 只想看「是否退化」时，盯 fetch（I/O 阶段）与卡片数是否正常即可。
 *
 * 退出码：0 = 至少一轮成功；1 = 全部失败（会打印原始日志尾部帮助定位）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return def;
};
const flag = (name) => argv.includes(`--${name}`);

const LIBRARY = arg('library', 'I:\\03\\角色色卡');
const RUNS = Math.max(1, Number(arg('runs', '1')) || 1);
const LABEL = arg('label', '');
const TIMEOUT = Number(arg('timeout', '150000')) || 150000;
const PORT = Number(arg('port', '9339')) || 9339;
const KEEP_PROFILE = flag('keep-profile');
const VERBOSE = flag('verbose');

// ⚠️ 必须用 fileURLToPath：本仓库路径含中文，new URL().pathname 会给出 %E9%85%92… 编码串
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_USERDATA = path.join(process.env.APPDATA || '', 'sillytavern-card-manager');
const TEMP_PROFILE = path.join(os.tmpdir(), 'jsk-measure-profile');

// ---------------- 小工具 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

function log(msg) { console.log(msg); }

function resolveElectron() {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (fs.existsSync(exe)) return exe;
    const alt = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
    if (fs.existsSync(alt)) return alt;
    throw new Error(`找不到 Electron 可执行文件（期望 ${exe}），先 npm install`);
}

/** 准备隔离 profile：复制真实配置 + 改写 lastFolder；返回 {profile, cleanup()} */
function prepareProfile() {
    fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
    fs.mkdirSync(TEMP_PROFILE, { recursive: true });
    const copied = [];
    for (const f of ['app_config.json', 'tavern_manager_config.json']) {
        const src = path.join(REAL_USERDATA, f);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(TEMP_PROFILE, f)); copied.push(f); }
    }
    // 改写库路径（两个文件都可能带 lastFolder，写进存在的那个；都不存在就新建 legacy 文件）
    let patched = false;
    for (const f of ['app_config.json', 'tavern_manager_config.json']) {
        const p = path.join(TEMP_PROFILE, f);
        if (!fs.existsSync(p)) continue;
        try {
            const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (cfg && typeof cfg === 'object') { cfg.lastFolder = LIBRARY; fs.writeFileSync(p, JSON.stringify(cfg), 'utf-8'); patched = true; }
        } catch { /* 坏文件跳过 */ }
    }
    if (!patched) fs.writeFileSync(path.join(TEMP_PROFILE, 'tavern_manager_config.json'), JSON.stringify({ lastFolder: LIBRARY }), 'utf-8');
    return { profile: TEMP_PROFILE, copied, cleanup: () => { if (!KEEP_PROFILE) fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } };
}

function killTree(pid) {
    try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-pid, 'SIGKILL');
    } catch { /* 已退出 */ }
}

/** 解析一轮日志 */
function parse(lines) {
    const text = lines.join('\n');
    const pick = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
    const out = {
        fetch: pick(/fetch=(\d+)ms/),
        worker: pick(/worker=(\d+)ms/),
        assemble: pick(/assemble=(\d+)ms/),
        totalFiles: pick(/总文件=(\d+)/),
        ready: pick(/蒙版淡出\(总耗时\):\s*(\d+)ms/),
        cards: pick(/成功从[\s\S]*?加载了\s*(\d+)\s*张卡片/),
        skipped: pick(/\[载入\] 跳过\s*(\d+)\s*个/),
        indexDone: /搜索索引构建完成/.test(text),
        warmupDone: /Token 缓存预热完成/.test(text),
        cacheFiles: 0,
        cacheReclaim: /\[embed-cache\]\s*已回收遗留缓存/.test(text),
    };
    try { out.cacheFiles = fs.readdirSync(TEMP_PROFILE).filter((f) => f.startsWith('embed_cache_')).length; } catch { /* 忽略 */ }
    return out;
}

async function runOnce(idx, electron) {
    const lines = [];
    const child = spawn(electron, ['.', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TEMP_PROFILE}`], {
        cwd: ROOT,
        env: { ...process.env, VITE_DEV_SERVER_URL: '' },   // 清空 → 生产模式
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (process.env.VITE_DEV_SERVER_URL) delete process.env.VITE_DEV_SERVER_URL;

    const done = new Promise((resolve) => {
        const onChunk = (buf) => {
            const s = buf.toString('utf-8');
            for (const l of s.split(/\r?\n/)) {
                if (!l.trim()) continue;
                lines.push(l);
                if (VERBOSE) console.log(`  │ ${l}`);
                if (/蒙版淡出\(总耗时\)/.test(l)) resolve('ready');
            }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('exit', () => resolve('exit'));
        setTimeout(() => resolve('timeout'), TIMEOUT);
    });

    // 首屏就绪后若还没建完索引，再等一会儿（索引是后台跑的，不影响首屏结论，但值得记录）
    const why = await done;
    if (why === 'ready') {
        const t0 = Date.now();
        while (Date.now() - t0 < 60000 && !/搜索索引构建完成/.test(lines.join('\n'))) await sleep(500);
    }
    killTree(child.pid);
    await sleep(1200);

    const r = parse(lines);
    r.why = why;
    r.run = idx;
    if (!r.ready && !VERBOSE) {
        console.log('  ── 原始日志尾部（帮助定位）──');
        for (const l of lines.slice(-12)) console.log(`  │ ${l}`);
    }
    return r;
}

// ---------------- 主流程 ----------------
(async () => {
    if (!fs.existsSync(LIBRARY)) { console.error(`❌ 库目录不存在：${LIBRARY}`); process.exit(1); }
    if (!fs.existsSync(path.join(ROOT, 'web', 'index.html'))) {
        console.error('❌ 缺少 web/ 构建产物（生产模式需要）→ 先执行：npm run build:web');
        process.exit(1);
    }
    const electron = resolveElectron();
    const { profile, copied, cleanup } = prepareProfile();

    log(`📏 启动性能测量${LABEL ? ` · ${LABEL}` : ''}`);
    log(`   库：${LIBRARY}`);
    log(`   模式：生产模式（无 Vite）｜profile：${profile}（复制自真实配置：${copied.join(', ') || '无'}）`);
    log(`   轮数：${RUNS}｜超时：${TIMEOUT}ms\n`);

    const results = [];
    try {
        for (let i = 1; i <= RUNS; i++) {
            log(`▶ 第 ${i}/${RUNS} 轮…`);
            const r = await runOnce(i, electron);
            results.push(r);
            if (r.ready == null) {
                log(`  ❌ 未捕获到「蒙版淡出」（${r.why}）`);
            } else {
                log(`  ✅ 首屏就绪 ${(r.ready / 1000).toFixed(1)}s ｜ fetch ${(r.fetch / 1000).toFixed(1)}s · worker ${(r.worker / 1000).toFixed(1)}s · assemble ${(r.assemble / 1000).toFixed(1)}s`);
                log(`     卡片 ${r.cards ?? '?'} 张（跳过 ${r.skipped ?? '?'}）｜索引 ${r.indexDone ? '✅' : '—'}｜Token 预热 ${r.warmupDone ? '✅' : '—'}｜缓存文件 ${r.cacheFiles} 个`);
            }
            if (i < RUNS) await sleep(1500);
        }
    } finally {
        cleanup();
    }

    const ok = results.filter((r) => r.ready != null);
    if (ok.length > 1) {
        const avg = (k) => Math.round(ok.reduce((s, r) => s + (r[k] || 0), 0) / ok.length);
        log(`\n📊 平均（${ok.length} 轮）：首屏 ${(avg('ready') / 1000).toFixed(1)}s ｜ fetch ${(avg('fetch') / 1000).toFixed(1)}s · worker ${(avg('worker') / 1000).toFixed(1)}s · assemble ${(avg('assemble') / 1000).toFixed(1)}s`);
    }
    log('\n参考基线（2026-09-13，I:\\03\\角色色卡 11,186 卡 / 9.76GB，移除内嵌提取缓存后）：首屏 16.0~17.7s');
    process.exit(ok.length > 0 ? 0 : 1);
})().catch((e) => { console.error('❌ 测量失败：', e.message); process.exit(1); });
