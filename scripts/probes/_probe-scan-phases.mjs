/**
 * 量化「秒开」可行性：readdir + stat 到底多快？（决定能否不读文件就出列表）
 *
 * 用法：node scripts/probes/_probe-scan-phases.mjs [目录]
 *
 * 分阶段计时：
 *   ① 纯 readdir 递归（拿到全部文件名）
 *   ② ① + 对每个文件 stat（拿 size/mtime）
 *   ③ 读单个文件并 parse（× 若干本，外推全部）
 *
 * 结论用途：若 ①+② 只需百毫秒级，则「秒开」= 只做 ①+②、不读文件内容。
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';
const skipFolders = ['.git', 'node_modules', 'windows', 'program files', 'temp', 'cache'];

// ① 递归 readdir
const t1 = Date.now();
const files = [];
(function walk(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (skipFolders.includes(e.name.toLowerCase())) continue;
            walk(fp, depth + 1);
            continue;
        }
        if (e.isFile() && path.extname(e.name).toLowerCase() === '.json') files.push(fp);
    }
})(DIR);
const t2 = Date.now();
console.log(`① readdir 递归：${files.length} 个 .json，耗时 ${t2 - t1}ms`);

// ② stat
const stats = new Map();
for (const fp of files) {
    try { stats.set(fp, fs.statSync(fp)); } catch (e) { /* 忽略 */ }
}
const t3 = Date.now();
let bytes = 0;
for (const st of stats.values()) bytes += st.size;
console.log(`② + stat：耗时 ${t3 - t2}ms（累计 ${t3 - t1}ms），合计 ${(bytes / 1073741824).toFixed(2)}GB`);

// ③ 读 + parse（抽样 10 本外推）
const sample = files.slice(0, 10);
const t4 = Date.now();
let sampleBytes = 0;
for (const fp of sample) {
    const text = fs.readFileSync(fp, 'utf-8');
    sampleBytes += text.length;
    JSON.parse(text);
}
const t5 = Date.now();
const perFile = (t5 - t4) / sample.length;
const totalRead = perFile * files.length;
console.log(`③ 读+parse：抽样 ${sample.length} 本，平均 ${perFile.toFixed(0)}ms/本（${(sampleBytes / sample.length / 1048576).toFixed(1)}MB/本）`);
console.log(`   外推全部 ${files.length} 本 ≈ ${(totalRead / 1000).toFixed(1)}s`);

console.log('\n═════ 结论 ═════');
console.log(`只 readdir+stat（不读内容）：${t3 - t1}ms  → ${(t3 - t1) < 2000 ? '✅ 可做到「秒开」' : '⚠️ 偏慢'}`);
console.log(`读全部文件内容：≈ ${(totalRead / 1000).toFixed(1)}s  → 这才是慢的根源`);
console.log(`\n⇒ 「秒开」方案：列表只用 ①+② 的结果（文件名 + size + mtime），`);
console.log(`   正文与元数据（书名 / 词条数）走**持久化缓存**，首次建缓存后即可秒开。`);
