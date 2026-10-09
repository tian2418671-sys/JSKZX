/**
 * 💰 「打标发料成本模型」真实库只读测算（2026-10-03 · 供《AI打标-材料预算与取舍方案》引用）
 *
 * 为什么要它：用户问「这么大规模发送给 AI 多少 token？如何解决字数问题？」——
 *   回答这个必须先把**真实发送形态**量清楚，而不是拿"材料总字数"吓人：
 *     · 材料 > 4000 字 ⇒ `splitTextSegments(material, 3500)` 切成 ≤3500 字的段，**逐段独立请求**
 *     · 段数 > 上限（`ui.tagWbSegmentMax`，默认 40）⇒ 均匀采样到上限
 *     · 每段请求都**重新携带**：任务说明 + 候选池与规则 + 输出要求（固定开销，按段重复付费）
 *   ⇒ 真实成本 = Σ_每本书 min(段数, 上限) × (固定开销 + 该段字数)
 *
 * ⚠️ **纯只读**：只 readFileSync + 纯函数计算，不写文件、不开 GUI、不改配置。
 * 用法：node scripts/probes/_probe-material-budget.mjs ["H:\01\全局世界书"] [--overhead=147]
 *
 * Token 口径说明（重要）：
 *   · 「估算」列 = 仓库自带 `js/utils/tokenEstimate.js`（中文 ×1.5 + 英文词 ×1.2，且**>20 万字会截断**）
 *     —— 这是应用内显示的口径，**偏保守（高估）**，且对大材料会因截断而失真。
 *   · 「真实区间」列 = 按 cl100k / o200k 上中文经验区间 **0.6~1.0 token/汉字** 折算，仅供量级参考，
 *     **要落地必须用真分词器校准**（列入方案待决项 Q）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildWbMaterial, listWbEntries, isEntryDisabled, entryTitle, entryPrimaryKeys, entrySecondaryKeys } from '../../js/utils/wbMaterial.js';
import { splitTextSegments, SEGMENT_DEFAULT_CHUNK_CHARS, SEGMENT_DEFAULT_MAX_CHARS } from '../../js/utils/llmPromptRoles.js';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const OVERHEAD_ARG = process.argv.find((a) => a.startsWith('--overhead='));
const OVERHEAD_CHARS = OVERHEAD_ARG ? Number(OVERHEAD_ARG.split('=')[1]) : 147; // 用户真实配置里「公共材料」实测 147 字

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

/** 应用内口径的 token 估算（**不做 200K 截断**，以便看真实量级；同时给出截断口径作对照） */
function estTokens(text) {
    const t = String(text || '');
    const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonCn = t.replace(/[\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    return Math.ceil(cn * 1.5 + nonCn * 1.2);
}
/** cl100k/o200k 中文经验区间折算（0.6~1.0 token/汉字 + 英文按 1.3 token/词） */
function realRange(text) {
    const t = String(text || '');
    const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonCn = t.replace(/[\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    const en = nonCn * 1.3;
    return [Math.round(cn * 0.6 + en), Math.round(cn * 1.0 + en)];
}
const fmt = (n) => n.toLocaleString('en-US');

/** 🦴 骨架材料：书名 + 简介 + 词条名/触发词/常驻标记（**不含正文**）—— 供「两阶段送料」测算 */
function buildSkeleton(wb, name) {
    const entries = listWbEntries(wb).filter((e) => !isEntryDisabled(e));
    const head = [`书名：${name}`, '【骨架材料 · 仅词条索引，无正文】'];
    const desc = String((wb && wb.data && wb.data.description) || '').trim();
    if (desc) head.push('简介：' + desc);
    head.push(`词条数：${entries.length}`);
    const lines = entries.map((e, i) => {
        const t = entryTitle(e) || `词条${i + 1}`;
        const keys = entryPrimaryKeys(e).concat(entrySecondaryKeys(e)).filter(Boolean);
        return `- ${t}${keys.length ? '（' + keys.join(' / ') + '）' : ''}`;
    });
    return head.concat(lines).join('\n');
}

const files = walk(DIR);
console.log('═════ 打标发料成本模型 · 真实库只读测算 ═════');
console.log(`世界书库：${DIR}`);
console.log(`文件：${files.length} 个`);
console.log(`每请求固定开销（任务说明 + 候选池 + 输出要求）：${OVERHEAD_CHARS} 字（用户真实配置「公共材料」实测值）`);
console.log(`分段阈值：>${SEGMENT_DEFAULT_MAX_CHARS} 字开始分段 · 单段目标 ${SEGMENT_DEFAULT_CHUNK_CHARS} 字\n`);

const books = [];
for (const f of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const wb = { name: path.basename(f), wbName: raw && raw.name, data: raw };
    const entries = listWbEntries(wb);
    if (!entries.length) continue;
    const name = (raw && raw.name) || path.basename(f);
    const material = buildWbMaterial(wb, { name });
    const skeleton = buildSkeleton(wb, name);
    const segs = splitTextSegments(material, SEGMENT_DEFAULT_CHUNK_CHARS);
    books.push({
        file: path.basename(f), name, entries: entries.length,
        materialChars: material.length, skeletonChars: skeleton.length,
        segTotal: segs.length,
        segLens: segs.map((s) => s.length),
        materialTokens: estTokens(material),
        skeletonTokens: estTokens(skeleton)
    });
}
books.sort((a, b) => b.materialChars - a.materialChars);

/** 按 cap 采样（与 useAITools 同款：均匀采样）并算成本 */
function costWithCap(cap, overheadChars) {
    let requests = 0, sentChars = 0, tokens = 0, tokensReal = [0, 0];
    for (const b of books) {
        const segs = b.segLens;
        let taken;
        if (b.materialChars <= SEGMENT_DEFAULT_MAX_CHARS) taken = [b.materialChars];
        else if (segs.length <= cap) taken = segs;
        else {
            taken = [];
            const stride = segs.length / cap;
            for (let k = 0; k < cap; k++) taken.push(segs[Math.min(segs.length - 1, Math.floor(k * stride))]);
        }
        const chars = taken.reduce((n, x) => n + x, 0);
        const per = Math.ceil((chars / taken.length) + overheadChars);
        requests += taken.length;
        sentChars += chars;
        tokens += taken.length * (estTokens('字'.repeat(per)));   // 用等长中文串估算该请求 token
        const rr = realRange('字'.repeat(per));
        tokensReal[0] += taken.length * rr[0];
        tokensReal[1] += taken.length * rr[1];
    }
    return { cap, requests, sentChars, tokens, tokensReal };
}

const totalMaterial = books.reduce((n, b) => n + b.materialChars, 0);
console.log('── 库规模 ──');
console.log(`可解析世界书：${books.length} 本 · 词条 ${fmt(books.reduce((n, b) => n + b.entries, 0))} 条`);
console.log(`材料总字数（全量）：${fmt(totalMaterial)} 字 ⇒ 若一次性发，估算 ${fmt(estTokens('字'.repeat(totalMaterial)))} tokens（**实际不会这样发**）`);
console.log(`骨架材料总字数：${fmt(books.reduce((n, b) => n + b.skeletonChars, 0))} 字（仅为全量的 ${(books.reduce((n, b) => n + b.skeletonChars, 0) / totalMaterial * 100).toFixed(1)}%）`);

console.log('\n── 单本成本（材料 >4000 字需要分段的书，前 8 本）──');
console.log('  书名/文件'.padEnd(30) + '词条'.padStart(6) + '材料字数'.padStart(12) + '段数'.padStart(7) + '请求(cap40)'.padStart(12) + '实发字数'.padStart(12) + '估算token'.padStart(13) + '真实区间'.padStart(18));
for (const b of books.slice(0, 8)) {
    const taken = Math.min(b.segTotal, 40);
    const chars = b.materialChars <= SEGMENT_DEFAULT_MAX_CHARS ? b.materialChars
        : (b.segTotal <= 40 ? b.materialChars : Math.round(b.materialChars * 40 / b.segTotal));
    const per = Math.ceil(chars / taken) + OVERHEAD_CHARS;
    const tk = taken * estTokens('字'.repeat(per));
    const rr = realRange('字'.repeat(per));
    console.log(
        (b.name.length > 28 ? b.name.slice(0, 27) + '…' : b.name).padEnd(30) +
        String(b.entries).padStart(6) + fmt(b.materialChars).padStart(12) + String(b.segTotal).padStart(7) +
        String(taken).padStart(12) + fmt(chars).padStart(12) + fmt(tk).padStart(13) +
        `${fmt(rr[0])}~${fmt(rr[1])}`.padStart(18)
    );
}

console.log('\n── 全库一轮打标的总成本 × 分段上限（默认 40）──');
console.log('  上限'.padEnd(8) + '请求数'.padStart(10) + '实发材料字数'.padStart(16) + '估算 token'.padStart(16) + '真实区间 token'.padStart(24));
for (const cap of [5, 10, 20, 40, 80, 300]) {
    const r = costWithCap(cap, OVERHEAD_CHARS);
    console.log(String(cap).padEnd(8) + fmt(r.requests).padStart(10) + fmt(r.sentChars).padStart(16) +
        fmt(r.tokens).padStart(16) + `${fmt(r.tokensReal[0])}~${fmt(r.tokensReal[1])}`.padStart(24));
}

console.log('\n── 三种策略对照（全库一轮，cap=40）──');
const base = costWithCap(40, OVERHEAD_CHARS);
const skelOnly = (() => {
    let requests = 0, chars = 0, tokens = 0, rr = [0, 0];
    for (const b of books) {
        // 骨架一次一请求；若骨架仍 >4000 字则同样分段
        const segs = splitTextSegments('字'.repeat(b.skeletonChars), SEGMENT_DEFAULT_CHUNK_CHARS).length;
        const n = Math.min(Math.max(segs, 1), 40);
        requests += n; chars += b.skeletonChars;
        const per = Math.ceil(b.skeletonChars / n) + OVERHEAD_CHARS;
        tokens += n * estTokens('字'.repeat(per));
        const r = realRange('字'.repeat(per)); rr[0] += n * r[0]; rr[1] += n * r[1];
    }
    return { requests, chars, tokens, rr };
})();
const bigPool = costWithCap(40, 5000);
const rows = [
    ['现状：全量材料 + cap40', base.requests, base.sentChars, base.tokens, base.tokensReal],
    ['现状 + 大候选池(5000字)', bigPool.requests, bigPool.sentChars, bigPool.tokens, bigPool.tokensReal],
    ['🦴 仅骨架材料 + cap40', skelOnly.requests, skelOnly.chars, skelOnly.tokens, skelOnly.rr]
];
console.log('  策略'.padEnd(26) + '请求数'.padStart(10) + '字数'.padStart(14) + '估算 token'.padStart(16) + '真实区间 token'.padStart(24));
for (const [label, req, ch, tk, rr] of rows) {
    console.log(label.padEnd(26) + fmt(req).padStart(10) + fmt(ch).padStart(14) + fmt(tk).padStart(16) + `${fmt(rr[0])}~${fmt(rr[1])}`.padStart(24));
}

console.log('\n── 分布：钱花在哪（决定「抓大放小」有没有用）──');
{
    const base2 = costWithCap(40, OVERHEAD_CHARS);
    const buckets = [
        ['≤4000 字（单请求，不分段）', (b) => b.materialChars <= 4000],
        ['4K~50K 字', (b) => b.materialChars > 4000 && b.materialChars <= 50000],
        ['50K~200K 字', (b) => b.materialChars > 50000 && b.materialChars <= 200000],
        ['>200K 字（重书）', (b) => b.materialChars > 200000]
    ];
    console.log('  区间'.padEnd(30) + '本数'.padStart(6) + '材料字数占比'.padStart(18) + 'token 占比(cap40)'.padStart(20));
    for (const [label, pred] of buckets) {
        const list = books.filter(pred);
        const ch = list.reduce((n, b) => n + b.materialChars, 0);
        let tk = 0;
        for (const b of list) {
            const taken = Math.min(b.segTotal, 40);
            const chars = b.materialChars <= SEGMENT_DEFAULT_MAX_CHARS ? b.materialChars
                : (b.segTotal <= 40 ? b.materialChars : Math.round(b.materialChars * 40 / b.segTotal));
            tk += taken * estTokens('字'.repeat(Math.ceil(chars / taken) + OVERHEAD_CHARS));
        }
        console.log(label.padEnd(30) + String(list.length).padStart(6) +
            (fmt(ch) + ` (${(ch / totalMaterial * 100).toFixed(1)}%)`).padStart(18) +
            (fmt(tk) + ` (${(tk / Math.max(1, base2.tokens) * 100).toFixed(1)}%)`).padStart(20));
    }
    const ranked = books.map((b) => {
        const taken = Math.min(b.segTotal, 40);
        const chars = b.segTotal <= 40 ? b.materialChars : Math.round(b.materialChars * 40 / b.segTotal);
        return { name: b.name, tk: taken * estTokens('字'.repeat(Math.ceil(chars / taken) + OVERHEAD_CHARS)) };
    }).sort((a, b) => b.tk - a.tk);
    const top5 = ranked.slice(0, 5).reduce((n, x) => n + x.tk, 0);
    console.log(`  📊 最贵的 5 本占全库 token 的 ${(top5 / Math.max(1, base2.tokens) * 100).toFixed(1)}%（全库共 ${books.length} 本）`);
}

console.log('\n── 每请求固定开销的重复代价（cap=40，单本为例）──');
const worst = books[0];
const wReq = Math.min(worst.segTotal, 40);
console.log(`最重一本「${worst.name}」：${fmt(worst.materialChars)} 字 / ${worst.segTotal} 段 ⇒ 发 ${wReq} 个请求`);
console.log(`  · 材料本身：约 ${fmt(Math.round(worst.materialChars * wReq / worst.segTotal))} 字`);
console.log(`  · 固定开销重复：${wReq} × ${OVERHEAD_CHARS} = ${fmt(wReq * OVERHEAD_CHARS)} 字（占 ${(wReq * OVERHEAD_CHARS / (wReq * OVERHEAD_CHARS + worst.materialChars * wReq / worst.segTotal) * 100).toFixed(1)}%）`);
console.log(`  · 若候选池 5000 字：重复开销 ${fmt(wReq * 5000)} 字 = 材料本身的 ${((wReq * 5000) / (worst.materialChars * wReq / worst.segTotal) * 100).toFixed(0)}%`);
