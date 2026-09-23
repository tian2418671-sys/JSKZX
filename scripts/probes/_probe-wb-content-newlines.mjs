// 核实：世界书词条 content 的换行结构分布 —— 决定「句级对齐」是否真有必要
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
let totalEntries = 0, singleLine = 0, multiLine = 0;
let totalChars = 0, singleLineChars = 0, maxSingleLine = 0;
let singleLineSample = null;
const singleLineLens = [];
const buckets = { '1 行': 0, '2-5 行': 0, '6-20 行': 0, '21+ 行': 0 };

for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json'))) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    let e = raw && raw.entries;
    if (e && !Array.isArray(e) && typeof e === 'object') e = Object.values(e);
    if (!Array.isArray(e)) continue;
    for (const it of e) {
        if (!it || typeof it !== 'object') continue;
        const c = String(it.content || '');
        if (!c) continue;
        totalEntries++;
        totalChars += c.length;
        const lines = c.split('\n').filter(x => x.trim()).length;
        if (lines <= 1) { singleLine++; singleLineChars += c.length; singleLineLens.push(c.length); if (c.length > maxSingleLine) { maxSingleLine = c.length; singleLineSample = { file: f, len: c.length }; } }
        else multiLine++;
        if (lines <= 1) buckets['1 行']++;
        else if (lines <= 5) buckets['2-5 行']++;
        else if (lines <= 20) buckets['6-20 行']++;
        else buckets['21+ 行']++;
    }
}
console.log('══ 世界书词条 content 的换行结构 ══');
console.log(`词条总数：${totalEntries}`);
console.log(`单行（无换行）：${singleLine}  (${(singleLine / totalEntries * 100).toFixed(1)}%)  —— 行级 diff 会退化为「整段标记」`);
console.log(`多行：${multiLine}  (${(multiLine / totalEntries * 100).toFixed(1)}%)  —— 行级 diff 可正常细粒度对比`);
console.log('');
console.log('行数分布：');
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}  (${(v / totalEntries * 100).toFixed(1)}%)`);
console.log('');
console.log(`字符总量：${totalChars}  其中单行占 ${singleLineChars} (${(singleLineChars / totalChars * 100).toFixed(1)}%)`);
console.log(`最长单行词条：${maxSingleLine} 字符  (${singleLineSample ? singleLineSample.file : '-'})`);
console.log('');
console.log('【结论】');
console.log('  ⚠️ 注意：行级 diff 对单行词条**不是**退化为整段标记 ——');
console.log('     textDiff.js 的 diffOneLine 会「剥公共前后缀 + 行内 token 级 LCS」，单行词条照样细粒度对比。');
console.log('     唯一降级条件是「行内 LCS 规模积 > MAX_INLINE_PRODUCT(250000)」，即单行长度 ≳ 500 字符。');
console.log('');
// 真实缺口：单行且长度超阈值（行内 token 级也会降级）
const inlineDegraded = singleLineLens.filter(l => l * l > 250000).length;
console.log(`【真实缺口量化】单行词条 ${singleLine} 条：`);
console.log(`  · 长度 < 500（行内 token 级正常）：${singleLine - inlineDegraded} 条  (${((singleLine - inlineDegraded) / singleLine * 100).toFixed(1)}%)`);
console.log(`  · 长度 ≥ 500（行内也降级为整段标记）：${inlineDegraded} 条  (${(inlineDegraded / singleLine * 100).toFixed(1)}%)`);
console.log(`  单行长度：均值 ${(singleLineLens.reduce((a, b) => a + b, 0) / Math.max(1, singleLineLens.length)).toFixed(0)}，最大 ${maxSingleLine}`);
if (inlineDegraded / singleLine < 0.1) {
    console.log('  ⇒ 真正需要「句级切分」的词条 < 10% → **句级对齐优先级低**（行级 + 行内 token 已覆盖绝大多数）。');
} else {
    console.log('  ⇒ 句级切分确有价值。');
}
