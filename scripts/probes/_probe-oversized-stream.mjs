/**
 * P1-2 流式提取**真实效果**验证（2026-09-23）
 *
 * 压力库里没有 >50MB 的书，故本脚本**现造一本超大世界书**（>50MB），
 * 然后直接调用主进程的流式提取，验证：
 *   · 能拿到 keys（不再「永远无法参与查重」）
 *   · **内存峰值远低于文件体积**（这是选项 B 的核心价值）
 *   · 耗时可控
 *   · 与「完整 parse」结果**逐字节等价**
 *
 * 用法：node scripts/probes/_probe-oversized-stream.mjs [目标MB]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const TARGET_MB = Number(process.argv[2]) || 60;

// ── 从 main.js 抽真实现（测真代码）──
const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');
function extractFn(src, name) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`未找到 ${name}`);
    let start0 = i;
    if (src.slice(Math.max(0, i - 6), i) === 'async ') start0 = i - 6;
    const start = src.indexOf('{', i);
    let depth = 0, inLine = false, inBlock = false, inStr = false, quote = '';
    for (let k = start; k < src.length; k++) {
        const c = src[k], n = src[k + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
        if (inStr) { if (c === '\\') { k++; continue; } if (c === quote) inStr = false; continue; }
        if (c === '/' && n === '/') { inLine = true; k++; continue; }
        if (c === '/' && n === '*') { inBlock = true; k++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(start0, k + 1); }
    }
    throw new Error(`${name} 配对失败`);
}
const normalizeWbKey = new Function(`return (s) => ${/const normalizeWbKey = \(s\) => ([^;]+);/.exec(mainSrc)[1]};`)();
const fnv1a32 = new Function(`${extractFn(mainSrc, 'fnv1a32')}; return fnv1a32;`)();
const MAX_KEYS_PER_BOOK = Number(/const MAX_KEYS_PER_BOOK\s*=\s*(\d+)/.exec(mainSrc)[1]);
const buildKeyHashes = new Function('normalizeWbKey', 'fnv1a32', 'MAX_KEYS_PER_BOOK',
    `${extractFn(mainSrc, 'buildKeyHashes')}; return buildKeyHashes;`)(normalizeWbKey, fnv1a32, MAX_KEYS_PER_BOOK);
const buildKeyHashesStreaming = new Function('fs', 'StringDecoder', 'normalizeWbKey', 'fnv1a32', 'MAX_KEYS_PER_BOOK',
    `${extractFn(mainSrc, 'buildKeyHashesStreaming')}; return buildKeyHashesStreaming;`)(
    fs, StringDecoder, normalizeWbKey, fnv1a32, MAX_KEYS_PER_BOOK);

console.log('═════ P1-2 流式提取真实效果验证 ═════');

// ── 造一本超大世界书 ──
const tmp = path.join(os.tmpdir(), `jsk-oversized-${Date.now()}.json`);
console.log(`正在生成 ~${TARGET_MB}MB 的超大世界书…`);
const entries = [];
let approx = 0;
const CONTENT_LEN = 50000;   // 每条 50KB 正文
let i = 0;
while (approx < TARGET_MB * 1024 * 1024) {
    const e = {
        key: [`触发词-${i}`, `kw${i}`, `关键词${i}`],
        keysecondary: [`次级-${i}`],
        content: ('这是第 ' + i + ' 条词条的正文。').repeat(Math.ceil(CONTENT_LEN / 20)),
        comment: `注释 ${i}`
    };
    entries.push(e);
    approx += CONTENT_LEN;
    i++;
}
const wb = { name: '超大世界书（流式测试）', entries };
fs.writeFileSync(tmp, JSON.stringify(wb), 'utf-8');
const fileSize = fs.statSync(tmp).size;
console.log(`已生成：${(fileSize / 1048576).toFixed(1)}MB，${entries.length} 条词条`);
console.log('');

// ── 完整 parse（基线）──
const m0 = process.memoryUsage();
const t0 = Date.now();
const parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
const baselineKeys = buildKeyHashes(parsed.entries);
const parseMs = Date.now() - t0;
const parsePeakMB = Math.round((process.memoryUsage().heapUsed - m0.heapUsed) / 1048576);
console.log(`【基线】完整 parse：${parseMs}ms，堆增量 ≈ ${parsePeakMB}MB，keys ${baselineKeys.length} 个`);

// ── 流式提取 ──
if (global.gc) global.gc();
const m1 = process.memoryUsage();
const t1 = Date.now();
const streamed = await buildKeyHashesStreaming(tmp);
const streamMs = Date.now() - t1;
const streamPeakMB = Math.round((process.memoryUsage().heapUsed - m1.heapUsed) / 1048576);
console.log(`【P1-2】流式提取：${streamMs}ms，堆增量 ≈ ${streamPeakMB}MB，keys ${streamed.keyHashes.length} 个`);
console.log(`         书名 = ${streamed.name || '(未取到)'}`);
console.log('');

// ── 断言 ──
const same = JSON.stringify(streamed.keyHashes) === JSON.stringify(baselineKeys);
console.log('───── 断言 ─────');
console.log(`${same ? '✅' : '❌'} 与完整 parse **逐字节等价**（${streamed.keyHashes.length} vs ${baselineKeys.length}）`);
console.log(`${streamed.name === '超大世界书（流式测试）' ? '✅' : '❌'} 能取到书名：${streamed.name}`);
console.log(`${streamPeakMB < parsePeakMB * 0.5 ? '✅' : '⚠️'} 内存峰值远低于完整 parse（${streamPeakMB}MB vs ${parsePeakMB}MB，比 ${(parsePeakMB / Math.max(1, streamPeakMB)).toFixed(1)}×）`);
console.log(`${streamed.keyHashes.length > 0 ? '✅' : '❌'} 能提取到 keys（不再「永远无法参与查重」）`);

// 清理
fs.unlinkSync(tmp);
console.log('');
console.log(`（已清理临时文件 ${path.basename(tmp)}）`);
process.exit(same && streamed.keyHashes.length > 0 ? 0 : 1);
