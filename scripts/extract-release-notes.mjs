/**
 * 从 RELEASE_NOTES.md 抽取指定版本段（用于 `gh release --notes-file`），写到 TEMP 下的纯 ASCII 路径。
 * 用法：node scripts/extract-release-notes.mjs v2.2.7
 * 判据：以 `## ` 开头且含版本号的段=head；到下一个 `## ` 为止（不包含下一个标题）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ver = (process.argv[2] || '').trim();
if (!ver) { console.error('用法: node scripts/extract-release-notes.mjs vX.Y.Z'); process.exit(1); }

const src = path.resolve('RELEASE_NOTES.md');
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);

const headRe = /^##\s+/;
let start = -1;
for (let i = 0; i < lines.length; i++) {
    if (headRe.test(lines[i]) && lines[i].includes(ver)) { start = i; break; }
}
if (start < 0) { console.error('未找到版本段: ' + ver); process.exit(1); }

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
    if (headRe.test(lines[i])) { end = i; break; }
}
const body = lines.slice(start, end).join('\n').replace(/\s+$/, '') + '\n';

const out = path.join(process.env.TEMP || '.', 'jsk-notes-' + ver.replace(/^v/, '') + '.md');
fs.writeFileSync(out, body, 'utf8');
console.log('已写出: ' + out + '（' + body.split('\n').length + ' 行）');
console.log('首行: ' + body.split('\n')[0]);
