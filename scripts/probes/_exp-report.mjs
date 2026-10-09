/**
 * 📊 实验报告渲染器：读 `_exp-material-strategy-result.json` → 输出 markdown 表（供贴进方案/讨论）
 * 用法：node scripts/probes/_exp-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const P = path.resolve('scripts/probes/_exp-material-strategy-result.json');
const r = JSON.parse(fs.readFileSync(P, 'utf8'));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (x) => (x * 100).toFixed(1) + '%';

console.log(`# 材料策略对照实验（真实库 + 真实 API）\n`);
console.log(`- 时间：${r.meta.time}`);
console.log(`- 模型：${r.meta.model}（中转：${r.meta.endpointHost}）`);
console.log(`- cap（S1/S3 每本请求数）：${r.meta.cap}`);
console.log(`- 固定开销：SYSTEM ${r.meta.sysChars} 字 + task/pool/output ${r.meta.fixedOverheadChars} 字`);
console.log(`- 总请求数：${r.totalRequests}（失败 ${r.errors.length}）\n`);

console.log(`## 一、逐书 × 逐策略\n`);
for (const b of r.books) {
    console.log(`### 📖 ${b.name}`);
    console.log(`词条 ${b.entries} · 全量材料 ${fmt(b.materialChars)} 字 · 段数 ${b.segTotal} · 骨架 ${fmt(b.skeletonChars)} 字\n`);
    console.log('| 策略 | 请求 | 实发字数 | 覆盖率 | 真实 prompt tokens | 标签数 | 有据率 | 每标签 token |');
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of b.strategies) {
        console.log(`| ${s.id} ${s.label} | ${s.requests} | ${fmt(s.chars)} | ${pct(s.coverage)} | **${fmt(s.promptTokens)}** | ${s.tagCount} | ${pct(s.grounded)} | ${s.tokensPerTag} |`);
    }
    if (b.pairwise) console.log(`\n两两一致率（Jaccard）：S1∩S2 **${b.pairwise['S1∩S2']}** · S1∩S3 **${b.pairwise['S1∩S3']}** · S2∩S3 **${b.pairwise['S2∩S3']}**\n`);
    // 标签明细（S1 vs S2 vs S3）
    console.log('<details><summary>标签明细</summary>\n');
    for (const s of b.strategies) console.log(`- **${s.id} ${s.label}**：${s.tags.join('、') || '（无）'}`);
    console.log('\n</details>\n');
}

console.log(`## 二、合计（所有实验书）\n`);
const sum = {};
for (const b of r.books) for (const s of b.strategies) {
    const k = s.id;
    sum[k] = sum[k] || { label: s.label, requests: 0, chars: 0, promptTokens: 0, tags: 0, groundedSum: 0, n: 0 };
    sum[k].requests += s.requests; sum[k].chars += s.chars; sum[k].promptTokens += s.promptTokens;
    sum[k].tags += s.tagCount; sum[k].groundedSum += s.grounded; sum[k].n++;
}
console.log('| 策略 | 请求合计 | 实发字数 | 真实 prompt tokens 合计 | 标签合计 | 平均有据率 | 每标签 token |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const k of Object.keys(sum).sort()) {
    const s = sum[k];
    console.log(`| ${k} ${s.label} | ${s.requests} | ${fmt(s.chars)} | **${fmt(s.promptTokens)}** | ${s.tags} | ${pct(s.groundedSum / Math.max(1, s.n))} | ${s.tags ? Math.round(s.promptTokens / s.tags) : 0} |`);
}

// 真实口径校准：用"固定开销 + 材料"总字符 vs 真实 prompt tokens
console.log(`\n## 三、Token 口径校准（真实 API usage）\n`);
let totChars = 0, totTok = 0, totReq = 0;
for (const b of r.books) for (const s of b.strategies) { totChars += s.chars + s.requests * (r.meta.sysChars + r.meta.fixedOverheadChars); totTok += s.promptTokens; totReq += s.requests; }
console.log(`- 全部请求合计：**${fmt(totReq)} 个请求**，估算字符量 ${fmt(totChars)} 字 → 真实 prompt tokens **${fmt(totTok)}**`);
console.log(`- ⇒ 实测 **${(totTok / Math.max(1, totChars)).toFixed(3)} token/字**（中文为主、含英文触发词）`);
console.log(`- 应用内估算器口径为 **1.5 token/中文字**（且 >20 万字截断）⇒ 相对实测**高估约 ${((1.5 / Math.max(0.0001, totTok / Math.max(1, totChars)) - 1) * 100).toFixed(0)}%**`);
if (r.errors.length) {
    console.log(`\n## 四、失败请求\n`);
    for (const e of r.errors.slice(0, 20)) console.log(`- ${e.book} / ${e.strategy} / 第 ${e.seg} 段：${e.err}`);
}
