/**
 * T4 实测（真实库）：H:\01\全局世界书 内每本世界书的 `entries` 起始偏移 vs 头 64KB 预检
 *
 * 用法：node scripts/probes/_probe-real-head-check.mjs "H:\01\全局世界书"
 *
 * 判据与 main.js 逐字一致：
 *   · size > 512KB  → 走头部预检（读头 64KB 找 `"entries"`），未命中则**整本跳过**
 *   · size > 50MB   → 只回元数据（不 parse）
 * 输出：每本的 体积 / entries 偏移 / 预检是否命中 / 会不会被误杀
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-real-head-check.mjs <目录>'); process.exit(1); }

const HEAD_BYTES = 64 * 1024;
const PRE_CHECK_BYTES = 512 * 1024;
const PARSE_MAX = 50 * 1024 * 1024;

/** 找到 `"entries"` 在文件里的字节偏移（用 4MB 分块扫描，避免整文件载入内存） */
function findEntriesOffset(filePath, size) {
    const CHUNK = 4 * 1024 * 1024;
    const fd = openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(CHUNK);
        let pos = 0;
        let carry = '';
        while (pos < size) {
            const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
            if (n <= 0) break;
            const text = carry + buf.subarray(0, n).toString('utf-8');
            const idx = text.indexOf('"entries"');
            if (idx >= 0) return pos - carry.length + idx;
            carry = text.slice(-16);   // 保留尾部，防关键字跨块
            pos += n;
        }
        return -1;
    } finally { closeSync(fd); }
}

function headHit(filePath, size) {
    if (size <= PRE_CHECK_BYTES) return true;
    const fd = openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
        return buf.subarray(0, n).toString('utf-8').includes('"entries"');
    } finally { closeSync(fd); }
}

const files = readdirSync(DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
    .map(d => path.join(DIR, d.name));

const kb = (b) => (b / 1024).toFixed(0) + 'KB';
const mb = (b) => (b / 1048576).toFixed(2) + 'MB';

const rows = [];
for (const f of files) {
    const size = statSync(f).size;
    const offset = findEntriesOffset(f, size);
    const hit = headHit(f, size);
    let tier;
    if (size > PARSE_MAX) tier = '>50MB 只回元数据';
    else if (size > PRE_CHECK_BYTES) tier = '5MB? 预检档';
    else tier = '常规档';
    if (size > 5 * 1024 * 1024) tier = '≥5MB 大档';
    const killed = size > PRE_CHECK_BYTES && !hit;
    rows.push({ name: path.basename(f), size, offset, hit, tier, killed });
}

rows.sort((a, b) => b.size - a.size);

console.log(`\n===== T4 真实库实测：${DIR}（${rows.length} 本）=====\n`);
console.log('体积         entries偏移   预检命中  档位            判定');
for (const r of rows) {
    const offTxt = r.offset < 0 ? '未找到' : kb(r.offset);
    console.log(
        `${mb(r.size).padStart(9)}  ${offTxt.padStart(11)}   ${(r.hit ? '✅' : '❌').padEnd(8)}  ${r.tier.padEnd(14)}  ${r.killed ? '❌ 被误杀' : '✅ 入库'}  ${r.name.slice(0, 34)}`
    );
}

const preChecked = rows.filter(r => r.size > PRE_CHECK_BYTES);
const killed = rows.filter(r => r.killed);
console.log('\n===== 结论 =====');
console.log(`走头部预检的（>512KB）：${preChecked.length} 本`);
console.log(`其中被误杀：${killed.length} 本${killed.length ? ' —— ' + killed.map(r => r.name.slice(0, 28)).join('、') : '（无误杀）'}`);
if (preChecked.length) {
    console.log(`误杀率：${((killed.length / preChecked.length) * 100).toFixed(0)}%（真实库）`);
}
const maxOff = Math.max(...rows.map(r => r.offset));
console.log(`全部文件的 entries 最大偏移：${maxOff < 0 ? '未找到' : kb(maxOff)}（头窗 ${kb(HEAD_BYTES)}）`);
console.log('');
