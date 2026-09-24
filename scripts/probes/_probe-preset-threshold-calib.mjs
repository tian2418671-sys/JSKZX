/**
 * 🎚️ 预设查重**阈值标定**（用带真值的合成样本库）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📖 要解决什么
 * ───────────────────────────────────────────────────────────────
 * 预设查重的阈值一直**未标定**（本机真实预设库为空）。本次用
 * `scripts/tools/make-preset-lib.mjs` 造出**带已知真值**的样本库
 * （11 对同源 + 3 对无关，覆盖 exact / renamed / reskin / trimmed /
 *  extended / reorder / flipped / sampler / unrelated / sameNameOnly / sharedSkeleton），
 * 从而把「拍脑袋的阈值」换成**有真值支撑的阈值**。
 *
 * ⚠️ **诚实声明**（结论必须带这句）：本标定用的是**合成样本**，
 *    其文本分布与真实预设不同（真实库 118~261 块、正文可达 MB、中英混排）。
 *    ⇒ 本结果只证明「**算法判别力**在已知差异类型上成立」，
 *      **不能**替代真实预设库标定（PK-29 的教训：合成样本定的 T 在真实库误报 10/18）。
 *    ⇒ 故标定后仍保留**保守档**倾向（宁可漏报绝不误报），并标注数据来源。
 *
 * ═══════════════════════════════════════════════════════════════
 * 📐 标定方法
 * ───────────────────────────────────────────────────────────────
 * 对**每一个阈值**做网格扫描，统计：
 *   · **误报（FP）** = 真值 `diff` 却被判为「同组」⇒ **最危险**（弹窗给「清理其余」）
 *   · **漏报（FN）** = 真值 `dup` 却未进同组
 *   · 判据：**先要求 FP = 0**（安全第一），再在 FP=0 的区间内取「召回最高」的阈值。
 *
 * 用法：
 *   node scripts/probes/_probe-preset-threshold-calib.mjs "D:\TkDmGzq\_preset-calib"
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    buildPresetStructure, structureSimilarity, contentSimilarity,
    orderSimilarity, enabledAgreement, samplerAgreement
} from '../../js/utils/presetStructure.js';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_preset-calib';

if (!fs.existsSync(DIR)) {
    console.error(`❌ 样本库不存在：${DIR}\n   先跑：node scripts/tools/make-preset-lib.mjs "${DIR}"`);
    process.exit(1);
}
const truthPath = path.join(DIR, '_truth.json');
if (!fs.existsSync(truthPath)) {
    console.error(`❌ 缺真值清单：${truthPath}`);
    process.exit(1);
}
const TRUTH = JSON.parse(fs.readFileSync(truthPath, 'utf-8'));

// ── 加载样本 ──
const load = (name) => {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf-8'));
    const s = buildPresetStructure(raw);
    return { name, raw, item: { data: raw }, struct: s };
};
const baseline = load(TRUTH.baseline);
const cases = TRUTH.pairs.map(p => {
    const b = load(p.file);
    return {
        family: p.family,
        truth: p.truth,
        file: p.file,
        structSim: structureSimilarity(baseline.struct, b.struct),
        contentSim: contentSimilarity(baseline.struct, b.struct),
        orderSim: orderSimilarity(baseline.struct, b.struct),
        enabledSim: enabledAgreement(baseline.struct, b.struct),
        samplerSim: samplerAgreement(baseline.item, b.item)
    };
});

const pct = (v) => (v === null ? '  n/a' : (v * 100).toFixed(1).padStart(5) + '%');
const pad = (s, n) => String(s).padEnd(n);

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  🎚️ 预设查重阈值标定（合成样本库）');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`  样本库：${DIR}`);
console.log(`  基线：${TRUTH.baseline}（${baseline.struct.blockCount} 块）`);
console.log(`  对比：${cases.length} 对（同源 ${cases.filter(c => c.truth === 'dup').length} ｜ 无关 ${cases.filter(c => c.truth === 'diff').length}）`);
console.log('');
console.log('  ── 每对样本的实测相似度（真值 = 人工构造时标注）─────────────────');
console.log(`  ${pad('族', 16)} ${pad('真值', 5)} ${pad('结构', 7)} ${pad('内容', 7)} ${pad('顺序', 7)} ${pad('启用', 7)} ${pad('参数', 7)}`);
for (const c of cases) {
    console.log(`  ${pad(c.family, 16)} ${pad(c.truth === 'dup' ? '同源' : '无关', 5)} `
        + `${pad(pct(c.structSim), 7)} ${pad(pct(c.contentSim), 7)} ${pad(pct(c.orderSim), 7)} `
        + `${pad(pct(c.enabledSim), 7)} ${pad(pct(c.samplerSim), 7)}`);
}

// ══════════════════════════════════════════════════════════════
// 网格扫描：结构阈值（**决定「是否同组」—— 最关键**）
// ══════════════════════════════════════════════════════════════
console.log('');
console.log('  ── ① 结构阈值扫描（决定「是否同组」）─────────────────────────────');
console.log('     判据：**FP 必须 = 0**（无关对被判同组 = 一键误删风险）');
console.log(`  ${pad('阈值', 7)} ${pad('TP', 4)} ${pad('FN', 4)} ${pad('FP', 4)} ${pad('TN', 4)}  说明`);
const structGrid = [];
for (let t = 0.30; t <= 0.999; t += 0.05) {
    const T = Math.round(t * 100) / 100;
    let TP = 0, FN = 0, FP = 0, TN = 0;
    for (const c of cases) {
        const s = c.structSim;
        const grouped = s !== null && s >= T;
        if (c.truth === 'dup') { if (grouped) TP++; else FN++; }
        else { if (grouped) FP++; else TN++; }
    }
    structGrid.push({ T, TP, FN, FP, TN });
    const note = FP > 0 ? '❌ 有误报（危险）' : (FN === 0 ? '✅ 零误报零漏报' : `⚠️ 零误报但有 ${FN} 漏报`);
    console.log(`  ${pad(T.toFixed(2), 7)} ${pad(TP, 4)} ${pad(FN, 4)} ${pad(FP, 4)} ${pad(TN, 4)}  ${note}`);
}
const safe = structGrid.filter(g => g.FP === 0);
const best = safe.length ? safe.reduce((a, b) => (b.TP > a.TP ? b : a)) : null;
const lowestSafe = safe.length ? safe[safe.length - 1] : null;   // 最松的「零误报」阈值 = 召回最高

// ══════════════════════════════════════════════════════════════
// 网格扫描：内容高线（决定「完全重复 / 换皮 / 相似」的区分）
// ══════════════════════════════════════════════════════════════
console.log('');
console.log('  ── ② 内容高线扫描（结构已同组的前提下）──────────────────────────');
console.log('     统计「结构同组」的对里，内容高线取不同值时的类型分布');
const grouped = cases.filter(c => c.structSim !== null && c.structSim >= (best ? best.T : 0.95));
console.log(`     （结构阈值取 ${best ? best.T.toFixed(2) : 'n/a'} ⇒ 同组 ${grouped.length} 对）`);
console.log(`  ${pad('内容高线', 9)} ${pad('EXACT', 6)} ${pad('RESKIN', 7)} ${pad('SIMILAR', 8)} ${pad('REORDER', 8)} ${pad('FLIPPED', 8)} ${pad('SAMPLER', 8)}`);
const ENABLED_HIGH = 1.0, SAMPLER_HIGH = 0.95;
for (let t = 0.70; t <= 0.99; t += 0.05) {
    const CH = Math.round(t * 100) / 100;
    const dist = { EXACT: 0, RESKIN: 0, SIMILAR: 0, REORDER: 0, FLIPPED: 0, SAMPLER: 0 };
    for (const c of grouped) {
        const sHigh = true;                       // 已同组
        const cHigh = c.contentSim !== null && c.contentSim >= CH;
        if (!cHigh) { dist.RESKIN++; continue; }
        if (c.orderSim !== null && c.orderSim < 0.95) dist.REORDER++;
        else if (c.enabledSim !== null && c.enabledSim < ENABLED_HIGH) dist.FLIPPED++;
        else if (c.samplerSim !== null && c.samplerSim < SAMPLER_HIGH) dist.SAMPLER++;
        else dist.EXACT++;
    }
    console.log(`  ${pad(CH.toFixed(2), 9)} ${pad(dist.EXACT, 6)} ${pad(dist.RESKIN, 7)} ${pad(dist.SIMILAR, 8)} ${pad(dist.REORDER, 8)} ${pad(dist.FLIPPED, 8)} ${pad(dist.SAMPLER, 8)}`);
}

// ══════════════════════════════════════════════════════════════
// 结论
// ══════════════════════════════════════════════════════════════
console.log('');
console.log('  ═══ 结论 ══════════════════════════════════════════════════════');
if (best) {
    console.log(`  ✅ 结构阈值安全区间：**≥ ${best.T.toFixed(2)}**（零误报；最低安全值 = ${lowestSafe.T.toFixed(2)}）`);
    console.log(`     当前代码值：0.95（保守档）⇒ ${0.95 >= best.T ? '**落在安全区间内**' : '❌ **不在安全区间**'}`);
    const at095 = structGrid.find(g => Math.abs(g.T - 0.95) < 0.001);
    if (at095) {
        console.log(`     阈值 0.95 实测：TP=${at095.TP} / FN=${at095.FN} / FP=${at095.FP} / TN=${at095.TN}`);
        if (at095.FN > 0) {
            const missed = cases.filter(c => c.truth === 'dup' && c.structSim !== null && c.structSim < 0.95);
            console.log(`     ⚠️ 漏报的 ${at095.FN} 对（结构相似度低于 0.95）：`);
            for (const m of missed) console.log(`        · ${pad(m.family, 16)} 结构 ${pct(m.structSim)}  内容 ${pct(m.contentSim)}`);
        }
    }
    // 无关对的最高结构相似度（决定阈值下限）
    const diffMax = Math.max(...cases.filter(c => c.truth === 'diff' && c.structSim !== null).map(c => c.structSim));
    console.log(`  📏 无关对的**最高**结构相似度：${pct(diffMax)}（阈值必须高于它）`);
    const dupMin = Math.min(...cases.filter(c => c.truth === 'dup' && c.structSim !== null).map(c => c.structSim));
    console.log(`  📏 同源对的**最低**结构相似度：${pct(dupMin)}（低于它就会漏报）`);
    console.log(`  📐 分离间隙：${(dupMin - diffMax).toFixed(3)} ${dupMin > diffMax ? '✅ 可分' : '❌ 不可分（重叠）'}`);
}
console.log('');
console.log('  ⚠️ **诚实声明**：以上为**合成样本**标定（文本分布 ≠ 真实预设）。');
console.log('     真实库需 20+ OpenAI 预设 / 10+ 对同源才能标定；在此之前**保持保守档**。');
