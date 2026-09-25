#!/usr/bin/env node
/**
 * _probe-dedupe-real-lib.mjs —— 真实库端到端（**只读**）验证 v4-P1 查重管线
 *
 * 铁律：读操作上真实库 —— 本脚本直接读：
 *   · 角色卡库：E:\AI\酒馆工具\角色卡（PNG 内嵌 + JSON 卡）
 *   · 世界书库：H:\01\全局世界书（JSON，含子目录）
 *
 * 口径与主程序对齐：
 *   · 世界书 keys：`normalizeWbKey`(trim+lower+NFC) + fnv1a32 + 升序去重 + cap 2000（= main.js）
 *   · 世界书 simhash：`computeSimhash64(simhashInputOf(entries))`（= main.js 单源实现）
 *   · 卡片：`data?.data || data`（DF-17）；PNG 读 tEXt/zTXt/iTXt 的 `chara`（base64 JSON）
 *
 * 输出：控制台摘要 + %TEMP%\dedupe-real-report.json（详细）
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const B = (n) => fileURLToPath(new URL(`../../js/utils/${n}`, import.meta.url));
const { fnv1a32 } = await import(new URL('../../js/utils/dedupeCommon.js', import.meta.url).href);
const { computeSimhash64, simhashInputOf } = await import(new URL('../../js/utils/simhash64.mjs', import.meta.url).href);
const { normalizeCard, normalizeWorldbook } = await import(new URL('../../js/utils/dedupeContract.js', import.meta.url).href);
const { extractNameStem, discoverTails, applyTails } = await import(new URL('../../js/utils/dedupeNames.js', import.meta.url).href);
const { buildCandidatePairs } = await import(new URL('../../js/utils/dedupeBuckets.js', import.meta.url).href);
const { evaluateGate } = await import(new URL('../../js/utils/dedupeGates.js', import.meta.url).href);
const { buildStarClusters, buildNameOnlyGroups } = await import(new URL('../../js/utils/dedupeCluster.js', import.meta.url).href);
void B;

const CARD_LIB = 'E:\\AI\\酒馆工具\\角色卡';
const WB_LIB = 'H:\\01\\全局世界书';
const SKIP_DIRS = new Set(['.trash', '.bak_history', 'node_modules']);

// ── 工具 ─────────────────────────────────────────────────────
const walk = (dir, exts, out = []) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(p, exts, out);
        } else if (exts.includes(extname(e.name).toLowerCase()) && !/\.tmp$/i.test(e.name)) {
            out.push(p);
        }
    }
    return out;
};

const parsePngCard = (buf) => {
    let off = 8;
    const chunks = {};
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        try {
            if (type === 'tEXt') {
                const nul = data.indexOf(0);
                chunks[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1);
            } else if (type === 'zTXt') {
                const nul = data.indexOf(0);
                chunks[data.toString('latin1', 0, nul)] = inflateSync(data.subarray(nul + 2)).toString('latin1');
            } else if (type === 'iTXt') {
                const nul = data.indexOf(0);
                const kw = data.toString('latin1', 0, nul);
                const compFlag = data[nul + 1];
                let p = data.indexOf(0, nul + 3) + 1;
                p = data.indexOf(0, p) + 1;
                let text = data.subarray(p);
                if (compFlag === 1) text = inflateSync(text);
                chunks[kw] = text.toString('utf8');
            }
        } catch { /* 单个块解析失败不中断 */ }
        off += 12 + len;
        if (type === 'IEND') break;
    }
    const raw = chunks.chara || chunks.ccv3;
    if (!raw) return null;
    try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return null; }
};

const normalizeWbKey = (s) => String(s).trim().toLowerCase().normalize('NFC');
const MAX_KEYS = 2000;
const wbKeyHashes = (entries) => {
    const set = new Set();
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const arr = Array.isArray(e.key) ? e.key : (e.key !== undefined && e.key !== null ? [e.key] : []);
        for (const k of arr) { const s = normalizeWbKey(k); if (s) set.add(fnv1a32(s)); }
    }
    const out = Array.from(set).sort((a, b) => a - b);
    return new Uint32Array(out.length > MAX_KEYS ? out.slice(0, MAX_KEYS) : out);
};

const prepareNames = (items) => {
    const tails = discoverTails(items.map((it) => it.name));
    for (const it of items) {
        const { stem0 } = extractNameStem(it.name);
        it.stemFinal = applyTails(stem0, tails).stemFinal || stem0;
    }
    return tails;
};

const runPipeline = (items) => {
    const t0 = Date.now();
    const tails = prepareNames(items);
    const pairs = buildCandidatePairs(items, { report: null });
    const edges = [];
    for (const [a, b] of pairs) {
        const g = evaluateGate(a, b);
        if (g.pass) edges.push({ a, b, gate: g });
    }
    const { clusters, notices } = buildStarClusters(edges);
    const used = new Set();
    for (const c of clusters) for (const m of c.members) used.add(m.id);
    const nameOnly = buildNameOnlyGroups(items.filter((it) => !used.has(it.id)));
    const ms = Date.now() - t0;
    const levels = { L0: 0, L1: 0, L2: 0 };
    for (const c of clusters) levels[`L${c.level}`] = (levels[`L${c.level}`] || 0) + 1;
    return { items: items.length, tails: [...tails], pairs: pairs.length, edges: edges.length, clusters, nameOnly, notices, ms, levels };
};

const summarize = (label, r, sampleN = 12) => {
    console.log(`\n═══ ${label} ═══`);
    console.log(`样本 ${r.items} | 语料尾缀 ${r.tails.length} 个 [${r.tails.slice(0, 10).join(', ')}]`);
    console.log(`候选对 ${r.pairs} | 证据边 ${r.edges} | 重复组 ${r.clusters.length}（L0=${r.levels.L0 || 0} L1=${r.levels.L1 || 0} L2=${r.levels.L2 || 0}）| 同名家族 ${r.nameOnly.length} | 耗时 ${r.ms}ms`);
    console.log(`提示 ${r.notices.length} 条${r.notices.length ? '：' + r.notices.slice(0, 3).join(' / ') : ''}`);
    const rows = [];
    for (const c of r.clusters.slice(0, sampleN)) {
        rows.push({ 组: c.center.name, 级: `L${c.level}`, 相似: `${c.simPct}%`, 成员: c.members.map((m) => m.name).join(' ‖ ') });
    }
    if (rows.length) console.table(rows);
    if (r.nameOnly.length) {
        const r2 = r.nameOnly.slice(0, 6).map((g) => ({ 同名: g.center.name, 成员数: g.members.length }));
        console.table(r2);
    }
    return {
        items: r.items, tails: r.tails, pairs: r.pairs, edges: r.edges, ms: r.ms, levels: r.levels,
        notices: r.notices,
        clusters: r.clusters.map((c) => ({ level: c.level, simPct: c.simPct, members: c.members.map((m) => m.name) })),
        nameOnly: r.nameOnly.map((g) => ({ name: g.center.name, n: g.members.length })),
    };
};

// ── 1) 世界书库（L1 只读） ─────────────────────────────────────
console.log('扫描世界书库:', WB_LIB);
const wbFiles = walk(WB_LIB, ['.json']);
let wbDegraded = 0;
const wbItems = [];
for (const f of wbFiles) {
    let data = null;
    try { data = JSON.parse(readFileSync(f, 'utf8')); } catch { wbDegraded++; continue; }
    const raw = (data && data.entries) ? data.entries : (data && data.data && data.data.entries ? data.data.entries : null);
    const entries = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    if (entries.length === 0 && wbDegraded !== -1) { /* 允许 0 条目书 */ }
    const item = normalizeWorldbook({
        path: f,
        wbName: (data && (data.name || data.wbName)) || f.split(/[\\/]/).pop().replace(/\.json$/i, ''),
        keyHashes: wbKeyHashes(entries),
        simhash: entries.length ? computeSimhash64(simhashInputOf(entries)) : null,
        entryCount: entries.length,
        mtime: 0,
        size: (() => { try { return statSync(f).size; } catch { return 0; } })(),
    });
    if (item.degraded) { wbDegraded++; continue; }
    wbItems.push(item);
}
const wbReport = summarize('世界书真实库（' + WB_LIB + '）', runPipeline(wbItems));
wbReport.degraded = wbDegraded;

// ── 2) 角色卡库 ───────────────────────────────────────────────
console.log('\n扫描角色卡库:', CARD_LIB);
const cardFiles = walk(CARD_LIB, ['.png', '.json', '.webp']);
let cardDegraded = 0;
const cardItems = [];
for (const f of cardFiles) {
    let parsed = null;
    try {
        if (extname(f).toLowerCase() === '.json') parsed = JSON.parse(readFileSync(f, 'utf8'));
        else if (extname(f).toLowerCase() === '.png') parsed = parsePngCard(readFileSync(f));
        else continue; // webp 深度扫描（罕见）本轮跳过
    } catch { cardDegraded++; continue; }
    if (!parsed) { cardDegraded++; continue; }
    const inner = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    const name = String(inner.name || parsed.name || f.split(/[\\/]/).pop()).trim();
    const item = normalizeCard({ path: f, name, data: parsed });
    if (item.degraded) { cardDegraded++; continue; }
    cardItems.push(item);
}
const cardReport = summarize('角色卡真实库（' + CARD_LIB + '）', runPipeline(cardItems));
cardReport.degraded = cardDegraded;

// ── 3) 性能复测（P2 基线）───────────────────────────────────────
const perf = {};
const PERF_CARDS = 'I:\\03\\角色色卡';
if (existsSync(PERF_CARDS)) {
    console.log('\n── 性能：压测大库 ' + PERF_CARDS + ' ──');
    const files = walk(PERF_CARDS, ['.png', '.json', '.webp']);
    const t0 = Date.now();
    const bigItems = [];
    let bigDegraded = 0;
    let lastTick = Date.now();
    for (const f of files) {
        let parsed = null;
        try {
            const ext = extname(f).toLowerCase();
            if (ext === '.json') parsed = JSON.parse(readFileSync(f, 'utf8'));
            else if (ext === '.png') parsed = parsePngCard(readFileSync(f));
            else continue;
        } catch { bigDegraded++; continue; }
        if (!parsed) { bigDegraded++; continue; }
        const inner = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
        const name = String(inner.name || parsed.name || f.split(/[\\/]/).pop()).trim();
        const it = normalizeCard({ path: f, name, data: parsed });
        // 📉 与运行侧同口径：清掉 raw 上的原对象引用（否则全库正文被结果集锚住——P2 实测 +1.7GB）
        if (!it.degraded && it.raw !== null) it.raw = null;
        if (it.degraded) bigDegraded++;
        else bigItems.push(it);
        if (Date.now() - lastTick > 20000) { console.log(`  …解析中 ${bigItems.length + bigDegraded}/${files.length}`); lastTick = Date.now(); }
    }
    const normMs = Date.now() - t0;
    const mem = process.memoryUsage();
    console.log(`文件 ${files.length} | 归一化 ${bigItems.length}（降级 ${bigDegraded}）| 解析+指纹 ${(normMs / 1000).toFixed(1)}s | rss ${Math.round(mem.rss / 1048576)}MB heapUsed ${Math.round(mem.heapUsed / 1048576)}MB`);
    const t1 = Date.now();
    const rBig = runPipeline(bigItems);
    const pipeMs = Date.now() - t1;
    console.log(`管线 ${pipeMs}ms：候选 ${rBig.pairs} / 证据边 ${rBig.edges} / 组 ${rBig.clusters.length}（L0=${rBig.levels.L0 || 0} L1=${rBig.levels.L1 || 0} L2=${rBig.levels.L2 || 0}）/ 同名家族 ${rBig.nameOnly.length}`);
    perf.bigCards = {
        files: files.length, items: bigItems.length, degraded: bigDegraded, normMs, pipelineMs: pipeMs,
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        pairs: rBig.pairs, edges: rBig.edges, clusters: rBig.clusters.length, levels: rBig.levels, nameOnly: rBig.nameOnly.length,
    };
} else {
    console.log('\n（跳过：压测大库不存在）');
}

// 世界书千本规模（**合成复制**——仅规模压测；功能正确性以上方真实库为准）
if (wbItems.length > 0) {
    const N = 1000;
    const big = [];
    for (let i = 0; i < N; i++) {
        const src = wbItems[i % wbItems.length];
        big.push({ ...src, id: `syn:${i}`, path: `X:/syn/${i}.json`, name: `${src.name}#${i}` });
    }
    const t2 = Date.now();
    const rSyn = runPipeline(big);
    const ms = Date.now() - t2;
    console.log(`\n── 世界书 ${N} 本（合成复制·规模压测）耗时 ${ms}ms：候选 ${rSyn.pairs} / 组 ${rSyn.clusters.length} / rss ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
    perf.wb1000 = { n: N, ms, pairs: rSyn.pairs, clusters: rSyn.clusters.length, rssMB: Math.round(process.memoryUsage().rss / 1048576) };
}

const REPORT = { time: new Date().toISOString(), worldbooks: wbReport, cards: cardReport, perf };
const out = join(process.env.TEMP || '.', 'dedupe-real-report.json');
writeFileSync(out, JSON.stringify(REPORT, null, 2), 'utf8');
console.log('\n详细报告:', out);
