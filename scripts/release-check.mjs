/**
 * 发布前置检查（一条龙 preflight）—— 一条命令跑完「能不能发版」的所有自动可查项
 *
 * 用法：
 *   node scripts/release-check.mjs                      # 语法 + 单测 + 构建 + 文档一致性 + git 状态
 *   node scripts/release-check.mjs --skip-build         # 跳过 npm run build:web（省 ~5s，调试时用）
 *   node scripts/release-check.mjs --e2e dev  --port 9338   # 另跑：大库重复卡 + 正则探针 + 测卡引擎（需 dev 实例）
 *   node scripts/release-check.mjs --e2e prod --port 9333   # 另跑：测卡侧栏端到端（需**生产构建**实例）
 *
 * 为什么要有它：
 *   今天（2026-09-13）多次出现「手工漏跑一项」的情况（忘记 build:web、忘跑端到端、
 *   版本号与 CHANGELOG 不一致）。这里把顺序与判定口径固定下来，避免靠记忆。
 *
 * 退出码：0 = 无阻塞项（可以进入打包）；1 = 有 ❌ 阻塞项。
 * 说明：⚠️ 只是提醒，不算阻塞（例如工作区有未提交改动、端到端被数据条件跳过）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const E2E = arg('e2e', '');           // '' | 'dev' | 'prod'
const PORT = arg('port', E2E === 'prod' ? '9333' : '9338');
const SKIP_BUILD = flag('skip-build');

const results = [];
const add = (name, ok, detail = '', blocking = true) => results.push({ name, ok, detail, blocking });

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', shell: process.platform === 'win32', ...opts });
}

// ── 1. 语法检查（主进程/预加载/主进程模块） ───────────────────────────────
for (const f of ['main.js', 'preload.js', 'main/memoryStore.js', 'main/vectorManager.js', 'main/vectorWorker.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) { add(`语法 ${f}`, false, '文件不存在'); continue; }
    const r = run('node', ['--check', f]);
    add(`语法 ${f}`, r.status === 0, r.status === 0 ? '' : String(r.stderr || '').slice(0, 120));
}

// ── 2. 单元测试 ────────────────────────────────────────────────────────
{
    const r = run('npm', ['test']);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // ⚠️ node --test 在管道下用 spec 报告器，计数行带装饰符（`ℹ pass 187` / `# pass 187` 两种都要认）
    const clean = out.replace(/[^\x20-\x7e]+/g, ' ');
    const pass = Number((clean.match(/\bpass\s+(\d+)/) || [])[1] ?? -1);
    const fail = Number((clean.match(/\bfail\s+(\d+)/) || [])[1] ?? -1);
    const ok = r.status === 0 && fail === 0 && pass > 0;
    add('npm test', ok, ok ? `${pass} 例全绿` : `pass=${pass} fail=${fail}（exit ${r.status}）`);
}

// ── 3. 前端构建（生产模式必需：web/ 产物被 app:// 加载） ─────────────────
if (SKIP_BUILD) add('npm run build:web', true, '已跳过（--skip-build）', false);
else {
    const r = run('npm', ['run', 'build:web']);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const built = /built in [\d.]+s/.test(out);
    add('npm run build:web', r.status === 0 && built, built ? '构建成功' : String(out).slice(-160));
}

// ── 4. 版本与文档一致性 ────────────────────────────────────────────────
let version = '';
try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version || '';
} catch (e) { /* 下面报错 */ }
add('package.json 版本可读', !!version, version ? `v${version}` : '解析失败');

if (version) {
    const cl = fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) ? fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8') : '';
    const hasSection = cl.includes(`v${version}`);
    add('CHANGELOG 含当前版本章节', hasSection, hasSection ? '' : `CHANGELOG 里找不到 v${version}`, false);
    const unr = (cl.match(/未发布/g) || []).length;
    add('CHANGELOG 无残留「未发布」段', unr === 0, unr === 0 ? '' : `仍有 ${unr} 处「未发布」（应在发版时归档为版本号）`, false);

    const rn = fs.existsSync(path.join(ROOT, 'RELEASE_NOTES.md')) ? fs.readFileSync(path.join(ROOT, 'RELEASE_NOTES.md'), 'utf-8') : '';
    add('RELEASE_NOTES 含当前版本', rn.includes(`v${version}`), rn.includes(`v${version}`) ? '' : `RELEASE_NOTES 里找不到 v${version}`, false);

    // 打包产物是否已存在（仅提示）
    const distDir = path.join(ROOT, 'dist_new');
    if (fs.existsSync(distDir)) {
        const exe = fs.readdirSync(distDir).find((f) => f.includes(`-${version}.exe`));
        add(`dist_new 已有 v${version} 安装包`, !!exe, exe || '尚未打包（下一步 npm run build）', false);
    }
}

// ── 5. git 状态 ────────────────────────────────────────────────────────
{
    const st = run('git', ['status', '--porcelain']);
    const dirty = String(st.stdout || '').trim().split('\n').filter(Boolean);
    add('工作区干净', dirty.length === 0, dirty.length === 0 ? '' : `${dirty.length} 个未提交文件（发版前建议先提交）`, false);
    const ahead = run('git', ['rev-list', '--count', 'origin/master..master']);
    const n = Number(String(ahead.stdout || '0').trim());
    add('已推送远端', n === 0, n === 0 ? '' : `本地领先 origin/master ${n} 个提交（记得 push --tags）`, false);
}

// ── 6. 端到端（可选） ──────────────────────────────────────────────────
if (E2E) {
    const list = E2E === 'prod'
        ? [['测卡侧栏端到端（生产构建）', 'scripts/tools/chat-sidebar-test.mjs']]
        : [
            ['大库重复卡/刷新压测', 'scripts/tools/library-dup-search-refresh.mjs'],
            ['正则增删 UI 探针', 'scripts/probes/_probe-regex-ui.mjs'],
            ['测卡编排引擎端到端', 'scripts/tools/chat-engine-test.mjs']
        ];
    for (const [name, script] of list) {
        const r = run('node', [script], { env: { ...process.env, CDP_PORT: String(PORT) } });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        const ok = r.status === 0;
        const skipNote = /断言已跳过|无对象，已跳过/.test(out) ? '（含数据条件跳过项）' : '';
        add(name, ok, ok ? `通过${skipNote}` : String(out).slice(-200));
    }
} else {
    add('端到端（未指定 --e2e）', true, '如需端到端：先起实例再 --e2e dev --port 9338 / --e2e prod --port 9333', false);
}

// ── 输出 ──────────────────────────────────────────────────────────────
console.log(`\n🧪 发布前置检查${E2E ? `（含 ${E2E} 端到端 @${PORT}）` : ''}\n`);
let blocked = 0;
for (const r of results) {
    const mark = r.ok ? '✅' : (r.blocking ? '❌' : '⚠️');
    if (!r.ok && r.blocking) blocked++;
    console.log(`${mark} ${r.name}${r.detail ? ' —— ' + r.detail : ''}`);
}
console.log('');
if (blocked === 0) {
    console.log('✅ 无阻塞项，可进入打包：npm run build');
    console.log('   之后按 docs/发布/一条龙-发布流程.md 执行：装包自测 → tag → push → Release 上传 → OTA 验证');
} else {
    console.log(`❌ 有 ${blocked} 项阻塞，先修完再打包`);
}
process.exit(blocked === 0 ? 0 : 1);
