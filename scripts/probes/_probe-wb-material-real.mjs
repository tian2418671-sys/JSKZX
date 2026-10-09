/**
 * 🌍 世界书「打标材料」真实库只读探针（AI-14，2026-10-03）
 *
 * 目的：在**真实库**上核对材料保真改动（纯函数 `js/utils/wbMaterial.js`）——
 *   · 词条名 `comment` 是否真的被用上（旧实现只用触发词 `key`）
 *   · 禁用词条（`enabled === false` / `disable === true`）是否真的被跳过
 *   · 书级 `description` 是否被送
 *   · 材料长度分布（供分段上限 Q8 参考）
 *
 * ⚠️ **纯只读**：只 `readFileSync` + 纯函数构建，不写任何文件、不开 GUI、不动配置。
 * 用法：node scripts/probes/_probe-wb-material-real.mjs ["H:\01\全局世界书"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildWbMaterial, listWbEntries, isEntryDisabled, entryTitle } from '../../js/utils/wbMaterial.js';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';

/** 递归收集 .json（跳过隐藏目录） */
function walk(dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.json$/i.test(e.name)) out.push(p);
    }
    return out;
}

const files = walk(DIR);
console.log(`═════ 世界书打标材料 · 真实库只读探针（AI-14） ═════`);
console.log(`库：${DIR}`);
console.log(`文件：${files.length} 个 .json\n`);

let ok = 0, failed = 0;
let booksWithComment = 0, totalEntries = 0, entriesWithComment = 0, disabledSkipped = 0, booksWithDesc = 0;
let materialLenSum = 0, materialLenMax = 0, maxBook = '';
const samples = [];
const perBook = [];

for (const f of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { failed++; continue; }
    const wb = { name: path.basename(f), wbName: raw && raw.name, data: raw };
    const entries = listWbEntries(wb);
    if (!entries.length) { failed++; continue; }
    ok++;
    const withComment = entries.filter((e) => String((e && (e.comment || e.name)) || '').trim()).length;
    const disabled = entries.filter(isEntryDisabled).length;
    if (withComment > 0) booksWithComment++;
    if (raw && String(raw.description || '').trim()) booksWithDesc++;
    totalEntries += entries.length;
    entriesWithComment += withComment;
    disabledSkipped += disabled;

    const material = buildWbMaterial(wb, { name: raw && raw.name ? raw.name : path.basename(f) });
    materialLenSum += material.length;
    if (material.length > materialLenMax) { materialLenMax = material.length; maxBook = path.basename(f); }
    perBook.push({ file: path.basename(f), entries: entries.length, withComment, disabled, len: material.length });
    if (samples.length < 2) samples.push({ file: path.basename(f), head: material.split('\n').slice(0, 8).join('\n') });
}

perBook.sort((a, b) => b.len - a.len);
console.log('── 汇总 ──');
console.log(`可解析世界书：${ok} 本（跳过 ${failed}：非世界书 JSON / 空 entries）`);
console.log(`词条总数：${totalEntries}`);
console.log(`其中有词条名(comment/name)的：${entriesWithComment}（${(entriesWithComment / Math.max(1, totalEntries) * 100).toFixed(1)}%）`);
console.log(`带词条名的书：${booksWithComment}/${ok}`);
console.log(`带书级简介(description) 的书：${booksWithDesc}/${ok}`);
console.log(`禁用词条（会被跳过）：${disabledSkipped}`);
console.log(`材料长度：合计 ${(materialLenSum / 1048576).toFixed(2)}MB · 最大 ${materialLenMax} 字（${maxBook}）· 均值 ${Math.round(materialLenSum / Math.max(1, ok))} 字`);
console.log(`超过 4000 字（会走分段）的书：${perBook.filter((b) => b.len > 4000).length}/${ok}；其中超 40 段（约 14 万字）的：${perBook.filter((b) => b.len > 140000).length}`);

console.log('\n── 最大 5 本 ──');
for (const b of perBook.slice(0, 5)) console.log(`  ${b.len.toString().padStart(9)} 字 · ${b.entries} 词条 · 命名 ${b.withComment} · 禁用 ${b.disabled} · ${b.file}`);

console.log('\n── 材料样例（前 2 本前 8 行）──');
for (const s of samples) console.log(`\n[${s.file}]\n${s.head}`);

// 断言（AI-14 的核心收益：词条名真的进了材料）
const checks = [
    ['可解析世界书 ≥ 20 本', ok >= 20],
    ['存在带词条名的世界书（comment 用于标题）', booksWithComment > 0],
    ['词条名覆盖率 > 0%', entriesWithComment > 0]
];
if (samples.length) {
    checks.push(['材料首行是「书名：」', samples[0].head.startsWith('书名：')]);
    checks.push(['材料含「词条数：」统计行', samples[0].head.includes('词条数：')]);
}
console.log('\n── 断言 ──');
let allPass = true;
for (const [n, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} ${n}`); if (!pass) allPass = false; }
console.log(allPass ? '\n✅ 全部通过' : '\n❌ 有失败项');
process.exit(allPass ? 0 : 1);
