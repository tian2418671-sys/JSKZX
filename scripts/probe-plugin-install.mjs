/**
 * 🔗 插件链接安装 —— 真实链路验证（不是 mock）
 *
 * 目的：绕开 Electron，但**完全复用**真实规则文件 pluginInstallUrl.js 与
 *      真实网络（github codeload）+ 真实 bsdtar 解压 + 真实磁盘落盘，
 *      确认「粘贴 https://github.com/anyKami/AutoRandomInput 就能装成插件」。
 *
 * 用法：
 *   node scripts/probe-plugin-install.mjs                # 只解析，不下载（安全）
 *   node scripts/probe-plugin-install.mjs --download     # 真下载到临时目录
 */
import { parseInstallUrl, gitHubZipUrl, pickPluginRoot } from '../js/utils/pluginInstallUrl.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAMPLE = 'https://github.com/anyKami/AutoRandomInput';
const doDownload = process.argv.includes('--download');

console.log('=== 1. URL 解析 ===');
const plan = parseInstallUrl(SAMPLE);
console.log('输入 :', SAMPLE);
console.log('结果 :', JSON.stringify(plan, null, 2));

if (plan.kind !== 'github-repo') {
    console.error('❌ 解析失败');
    process.exit(1);
}

const zipUrl = gitHubZipUrl(plan.owner, plan.repo, plan.branch);
console.log('\n=== 2. 下载地址 ===');
console.log(zipUrl);

if (!doDownload) {
    console.log('\n（未加 --download，跳过真实下载）');
    process.exit(0);
}

console.log('\n=== 3. 真实下载 ===');
const resp = await fetch(zipUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (JSK-Manager; compatible)' },
    redirect: 'follow',
});
console.log('HTTP', resp.status);
if (!resp.ok) {
    console.error('❌ 下载失败');
    process.exit(1);
}
const buf = Buffer.from(await resp.arrayBuffer());
console.log('压缩包大小:', buf.length, 'bytes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-probe-'));
const zipPath = path.join(tmp, 'pkg.zip');
fs.writeFileSync(zipPath, buf);

console.log('\n=== 4. 用系统 tar 解压 ===');
await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', zipPath, '-C', tmp], { windowsHide: true });
    let err = '';
    tar.stderr.on('data', (d) => { err += String(d); });
    tar.on('error', (e) => reject(e));
    tar.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err))));
});
console.log('解压完成');

const listDir = (d) => fs.readdirSync(d, { withFileTypes: true })
    .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));

console.log('\n=== 5. 定位插件根 ===');
let root = tmp;
for (let i = 0; i < 3; i++) {
    const entries = listDir(root);
    const sub = pickPluginRoot(entries);
    console.log(`  L${i} 条目:`, entries.map((e) => e.type[0] + ':' + e.name).join(', '));
    if (!sub) {
        const dirs = entries.filter((e) => e.type === 'dir');
        const files = entries.filter((e) => e.type === 'file' && e.name !== 'pkg.zip');
        if (dirs.length === 1 && files.length === 0) {
            root = path.join(root, dirs[0].name);
            console.log('  → 下沉到', path.basename(root));
            continue;
        }
        break;
    }
    root = path.join(root, sub);
    console.log('  → 下沉到', path.basename(root));
}
console.log('插件根:', root);

console.log('\n=== 6. 插件内容校验 ===');
const manifestPath = path.join(root, 'manifest.json');
let manifest = null;
if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    console.log('✅ manifest.json 存在');
    console.log('   display_name:', manifest.display_name || '(无)');
    console.log('   version     :', manifest.version || '(无)');
    console.log('   author      :', manifest.author || '(无)');
} else {
    console.log('⚠️ 无 manifest.json');
}
const files = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile());
console.log('   顶层文件:', files.join(', '));

const ok = !!manifest;
console.log('\n=== 结论 ===');
console.log(ok ? '✅ 可直接安装为扩展工程（扫描器认 manifest.json）' : '❌ 不是标准扩展工程');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log('临时目录已清理');
process.exit(ok ? 0 : 1);
