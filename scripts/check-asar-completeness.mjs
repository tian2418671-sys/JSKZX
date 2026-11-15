/**
 * 🔍 打包完整性自检：主进程 require 的文件必须在 asar 里真实存在。
 *
 * 背景（v2.5.0 发布事故）：
 *   `build.files` 是**白名单**，只有列进去的文件才会打进 app.asar。
 *   v2.5.0 里 `main.js` 新增了 `require('./js/utils/pluginInstallUrl.js')`，
 *   但 `files` 里只列了 `js/utils/simhash64.mjs` —— 结果打包版一启动就
 *   `Cannot find module './js/utils/pluginInstallUrl.js'`，主进程直接抛异常，
 *   用户装完根本打不开软件。
 *
 *   而这类问题**源码版永远测不出来**（`electron .` 时文件都在磁盘上），
 *   只有「装完包真跑一次」才会暴露。故做成打包后的机器自检。
 *
 * 用法：
 *   node scripts/check-asar-completeness.mjs                  # 检查 dist_new/win-unpacked
 *   node scripts/check-asar-completeness.mjs <asar 路径>
 *
 * 退出码：0 = 通过；1 = 有缺失（阻断发版）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 主进程入口与目录（这些文件里的 require 都要能被解析） */
const ENTRY_FILES = ['main.js', 'preload.js'];

/** 递归收集目录下的 .js 文件（跳过 node_modules 等） */
function collectJs(dir, out = [], depth = 0) {
    if (depth > 6) return out;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectJs(full, out, depth + 1);
        else if (/\.(c?js|mjs)$/i.test(e.name)) out.push(full);
    }
    return out;
}

/** 提取某文件里所有「相对路径」require */
function extractRelativeRequires(file) {
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    const out = [];
    // require('x') / require("x") —— 只要以 . 开头的相对路径
    const re = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
    return out;
}

/** 把相对 require 解析成相对仓库根的路径候选（含 Node 的补全规则） */
function resolveCandidates(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const rel = path.relative(ROOT, base).split(path.sep).join('/');
    const cands = [rel];
    // Node 解析规则：无扩展名时依次尝试 .js / .json / index.js
    if (!path.extname(rel)) {
        cands.push(`${rel}.js`, `${rel}.json`, `${rel}/index.js`);
    }
    return cands;
}

/** 读取 asar 条目列表，统一成 `a/b/c.js` 形式（去首尾分隔符、反斜杠转正斜杠） */
async function listAsar(asarPath) {
    const normalize = (l) => l
        .trim()
        .replace(/^[\\/]+/, '')      // ⚠️ asar list 输出的条目**以反斜杠开头**（如 \main\x.js），必须一起剥掉
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .join('/');

    try {
        const { listPackage } = await import('@electron/asar');
        return listPackage(asarPath).map(normalize);
    } catch (e) {
        // 退路：用 npx asar list（较慢但可用）
        const { execFileSync } = await import('node:child_process');
        const out = execFileSync('npx', ['asar', 'list', asarPath], { encoding: 'utf8' });
        return out.split(/\r?\n/).map(normalize).filter(Boolean);
    }
}

async function main() {
    const argPath = process.argv[2];
    const asarPath = argPath
        ? path.resolve(argPath)
        : path.join(ROOT, 'dist_new', 'win-unpacked', 'resources', 'app.asar');

    if (!fs.existsSync(asarPath)) {
        console.error(`❌ 找不到 asar：${asarPath}`);
        console.error('   请先打包，或显式传入 asar 路径。');
        process.exit(1);
    }

    console.log(`🔍 检查打包完整性：${path.relative(ROOT, asarPath)}`);

    // 收集要检查的源文件
    const sources = [];
    for (const f of ENTRY_FILES) {
        const full = path.join(ROOT, f);
        if (fs.existsSync(full)) sources.push(full);
    }
    collectJs(path.join(ROOT, 'main'), sources);
    // 主进程可能 require 的纯逻辑模块（js/utils 下的全部）
    collectJs(path.join(ROOT, 'js', 'utils'), sources);

    const entries = new Set(await listAsar(asarPath));
    const missing = [];
    let checked = 0;

    for (const file of sources) {
        for (const spec of extractRelativeRequires(file)) {
            const cands = resolveCandidates(file, spec);
            checked++;
            // 只要有一个候选在 asar 里就算解析成功（Node 的补全语义）
            const hit = cands.some((c) => entries.has(c));
            if (!hit) {
                missing.push({
                    from: path.relative(ROOT, file).split(path.sep).join('/'),
                    spec,
                    expected: cands,
                });
            }
        }
    }

    if (!missing.length) {
        console.log(`✅ 通过：${checked} 处 require 全部能在 asar 里找到（共 ${entries.size} 个条目）`);
        process.exit(0);
    }

    console.error(`\n❌ 发现 ${missing.length} 处 require 打不进包（装完会启动失败）：\n`);
    // 去重展示（同一个 spec 可能被多文件引用）
    const seen = new Set();
    for (const m of missing) {
        const key = `${m.from}->${m.spec}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.error(`  ${m.from}  →  require('${m.spec}')`);
        console.error(`     期望 asar 里有：${m.expected.join('  或  ')}`);
    }
    console.error('\n修法：把对应路径加进 package.json 的 `build.files` 白名单。');
    console.error('     推荐按目录整体包含（如 `js/utils/**/*`），不要逐个文件列 —— 漏一个就是启动崩溃。\n');
    process.exit(1);
}

main().catch((e) => {
    console.error('❌ 检查脚本自身出错：', e && e.message ? e.message : e);
    process.exit(1);
});
