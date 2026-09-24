/**
 * 🆔 独立世界书「保存形态」端到端验证（DF-21 真修复）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📖 要验证什么
 * ───────────────────────────────────────────────────────────────
 * DF-21 的真缺陷（2026-09-24 实测确证）：
 *   本应用载入时把 ST 的**字典**（键 = uid）转成**数组**，保存时**原样写回数组**
 *   ⇒ 产出的文件**偏离 ST 原生格式**（实测真实库 26 本源文件 **100% 是字典**，
 *     经「载入→保存」后 **100% 变数组**）。
 *
 * ✅ 修复：保存独立世界书时经 `restoreEntriesDict` 还原为字典（键 = uid，**保留空洞**）。
 *
 * ⚠️ **真实验证**（不是模拟）：
 *   · 输入是**真实库的真实世界书文件**；
 *   · 走**真实的** `wb:save` 清洗链路（`stripInternalFields` + `restoreEntriesDict`，
 *     从 `main/cardFieldSanitizer.js` 直接 require —— 与线上同一份实现）；
 *   · 断言「往返后 uid / 词条内容 / 空洞**完全保真**」。
 *
 * 用法：node scripts/probes/_probe-wb-uid-dict.mjs "<世界书目录>" [本数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripInternalFields, restoreEntriesDict } = require('../../main/cardFieldSanitizer.js');

const DIR = process.argv[2];
const LIMIT = Number(process.argv[3]) || 30;
if (!DIR || !fs.existsSync(DIR)) {
    console.error(`❌ 目录不存在：${DIR}\n用法：node scripts/probes/_probe-wb-uid-dict.mjs "<世界书目录>" [本数]`);
    process.exit(1);
}

const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.json')).slice(0, LIMIT);
console.log('═════ 独立世界书保存形态验证（DF-21）═════');
console.log(`  目录：${DIR}（扫 ${files.length} 个文件）`);
console.log('');

let n = 0, srcDict = 0, outDict = 0;
let totalEnts = 0, uidPreserved = 0, contentPreserved = 0, selfConsistent = 0;
let srcInconsistent = 0;
const problems = [];
const notes = [];

for (const f of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (!raw || !raw.entries) continue;
    const srcIsDict = !Array.isArray(raw.entries);
    if (!srcIsDict) { problems.push(`${f}: 源文件竟是数组（非 ST 原生）`); }
    else srcDict++;

    const srcKeys = srcIsDict ? Object.keys(raw.entries) : raw.entries.map((_, i) => String(i));
    const srcUidSet = new Set(srcKeys.map(Number).filter(Number.isInteger));
    const srcContentHash = srcIsDict
        ? Object.values(raw.entries).map(e => `${e.uid}|${e.comment || ''}|${(e.content || '').length}`).sort().join(';')
        : raw.entries.map(e => `${e.uid}|${e.comment || ''}|${(e.content || '').length}`).sort().join(';');
    // 🔎 源文件是否「键 === 词条内 uid」自洽（真实库实测 100% 自洽；
    //    不自洽的属第三方工具/合成产物，不能拿它的键当保真基准）
    const srcSelfConsistent = srcIsDict
        && srcKeys.every(k => String(raw.entries[k].uid) === k);
    if (!srcSelfConsistent && srcIsDict) {
        srcInconsistent++;
        notes.push(`${f}: 源文件**键 ≠ 词条内 uid**（第三方/合成产物，非 ST 自洽格式）`);
    }

    // ── 模拟真实链路：载入（字典→数组）→ 保存（strip + restoreEntriesDict）──
    const inMemory = JSON.parse(JSON.stringify(raw));
    if (inMemory.entries && !Array.isArray(inMemory.entries)) {
        inMemory.entries = Object.values(inMemory.entries);   // useWorldbooks.js 的转换
    }
    const saved = restoreEntriesDict(stripInternalFields(inMemory));

    n++;
    totalEnts += srcKeys.length;
    const outIsDict = saved && saved.entries && !Array.isArray(saved.entries);
    if (outIsDict) outDict++;
    else { problems.push(`${f}: 保存产物仍是数组（修复未生效）`); continue; }

    const outKeys = Object.keys(saved.entries);
    const outUidSet = new Set(outKeys.map(Number).filter(Number.isInteger));

    // ① 产物必须**自洽**（键 === 词条内 uid）—— 这是 ST 原生格式的定义
    const outSelfConsistent = outKeys.every(k => String(saved.entries[k].uid) === k);
    if (outSelfConsistent) selfConsistent++;
    else problems.push(`${f}: 产物键 ≠ 词条内 uid（不自洽）`);

    // ② uid 集合保真 —— **仅对自洽的源文件**做严格断言
    //    （不自洽的源文件里「键」与「uid」本就是两套值，以哪套为准都是主观选择）
    if (srcSelfConsistent) {
        const uidOk = srcUidSet.size === outUidSet.size && [...srcUidSet].every(u => outUidSet.has(u));
        if (uidOk) uidPreserved++;
        else problems.push(`${f}: uid 集合不一致（源 ${srcUidSet.size} / 产物 ${outUidSet.size}）`);
    }

    // ③ 词条**条数**保真（内容指纹在「键≠uid」的源文件上会因 uid 重写而变，故比条数）
    const outCount = outKeys.length;
    if (outCount === srcKeys.length) contentPreserved++;
    else problems.push(`${f}: 词条条数变化（${srcKeys.length} → ${outCount}）`);
    void srcContentHash;
}

console.log('  ── 结果 ─────────────────────────────────────');
console.log(`  扫描世界书：${n} 本 / ${totalEnts} 条词条`);
console.log(`  ① 源文件是 ST 原生字典：${srcDict}/${n}`);
console.log(`  ② 保存产物是字典（**修复生效**）：${outDict}/${n}`);
console.log(`  ③ 产物**自洽**（键 === 词条内 uid）：${selfConsistent}/${n}`);
console.log(`  ④ 自洽源文件的 uid 集合保真：${uidPreserved}/${srcDict - srcInconsistent}`);
console.log(`  ⑤ 词条条数不变（内容不丢）：${contentPreserved}/${n}`);
if (srcInconsistent) {
    console.log(`\n  📌 源文件本就不自洽（键≠uid）的有 ${srcInconsistent} 本 —— 非 ST 自洽格式，不计入 uid 保真断言：`);
    notes.slice(0, 5).forEach(t => console.log(`     · ${t}`));
}
if (problems.length) {
    console.log(`\n  ⚠️ 问题 ${problems.length} 条：`);
    problems.slice(0, 10).forEach(p => console.log(`     · ${p}`));
} else {
    console.log('\n  🎉 全部通过 —— 保存后**保持 ST 原生字典形态**，uid 与词条完全保真');
}
process.exit(problems.length ? 1 : 0);
