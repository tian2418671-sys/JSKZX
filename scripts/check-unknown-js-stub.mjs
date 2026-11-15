/**
 * 校验 buildUnknownJsStub 生成的 ESM 桩语法是否合法。
 *
 * 背景：这个桩是「未知 JS 资源兜底」，一旦语法不合法，插件模块图会再次整体失败，
 * 而且报错同样只指向入口文件，极难定位。所以必须离线先验证一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.join(here, '..', 'main.js'), 'utf-8');

const start = mainSrc.indexOf('function buildUnknownJsStub(');
if (start < 0) {
    console.error('❌ 未找到 buildUnknownJsStub');
    process.exit(1);
}
// 从 function 起找第一个 return `，再找配对的 `;
const retIdx = mainSrc.indexOf('return `', start);
const endIdx = mainSrc.indexOf('\n`;', retIdx);
if (retIdx < 0 || endIdx < 0) {
    console.error('❌ 未找到桩模板字符串边界');
    process.exit(1);
}
const stubSrc = mainSrc.slice(retIdx + 8, endIdx);

const outFile = path.join(here, '_stub_check.mjs');
fs.writeFileSync(outFile, stubSrc, 'utf-8');
console.log('提取桩源码:', stubSrc.length, '字符 →', outFile);

try {
    execFileSync(process.execPath, ['--check', outFile], { stdio: 'pipe' });
    console.log('✅ ESM 语法合法');
} catch (e) {
    console.error('❌ ESM 语法错误:');
    console.error(String(e.stderr || e.message).split('\n').slice(0, 12).join('\n'));
    process.exitCode = 1;
} finally {
    try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
}
