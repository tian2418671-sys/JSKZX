/**
 * T6 实测：分级扫描「5~50MB 档」的并发度与内存（生产值从 main.js 动态读取）
 *
 * 用法：node --expose-gc scripts/probes/_probe-heavy-concurrency.mjs "H:\01\全局世界书" [并发档位...]
 *   例：node --expose-gc scripts/probes/_probe-heavy-concurrency.mjs "H:\01\全局世界书" 1 3 6 12
 *
 * 为什么必须实测：该并发值原是**保守估值**（代码注释自认）。
 *   世界书扫描是 Promise.all 并发 readFile + JSON.parse，若并发过高：
 *     · 主进程堆峰值暴涨（单本 10MB JSON parse 后对象可达数十 MB）
 *     · 反而因 GC 压力变慢
 *   若并发过低：大库扫描白等。
 *   本探针**逐字复刻** main.js 的 handleOne 路径（stat → 预检 → readFile → parse → isValidWorldbook），
 *   在不同并发下量 耗时 / 堆峰值 / 判定一致性，给出「是否该调整」的依据。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) { console.error('用法：node --expose-gc scripts/probes/_probe-heavy-concurrency.mjs <目录> [并发档位...]'); process.exit(1); }
const TIERS = process.argv.slice(3).map(Number).filter(n => n > 0);
const CONCURRENCY_LEVELS = TIERS.length ? TIERS : [1, 2, 3, 6, 12];

// 从 main.js 动态读取生产常量，避免探针与代码脱节（改参数后无需同步注释）
const MAIN_SRC = readFileSync(new URL('../../main.js', import.meta.url), 'utf-8');
const prodConst = (name, dflt) => {
    const m = MAIN_SRC.match(new RegExp('const\\s+' + name + '\\s*=\\s*([0-9*\\s]+);'));
    if (!m) return dflt;
    try { return eval(m[1]); } catch (e) { return dflt; }
};
const PROD_HEAVY_CONC = prodConst('SCAN_HEAVY_CONCURRENCY', 2);
const PROD_JSON_BATCH = prodConst('SCAN_JSON_BATCH', 32);
const SCAN_INLINE_MAX_BYTES = 5 * 1024 * 1024;
const SCAN_PARSE_MAX_BYTES = 50 * 1024 * 1024;

// ── 与 main.js 逐字一致的判定 ──
function isValidWorldbook(wbData) {
    if (!wbData || typeof wbData !== 'object') return false;
    if (wbData.spec === 'chara_card_v2' || wbData.spec === 'chara_card_v3') return false;
    if (wbData.data && (wbData.data.description !== undefined || wbData.data.first_mes !== undefined)) return false;
    if (!wbData.entries) return false;
    if (typeof wbData.entries === 'object' && !Array.isArray(wbData.entries)) {
        wbData.entries = Object.values(wbData.entries);
    }
    if (!Array.isArray(wbData.entries)) return false;
    if (wbData.entries.length > 0) {
        const sample = wbData.entries[0];
        if (!sample || typeof sample !== 'object') return false;
        const isWbEntry = ('key' in sample) || ('keys' in sample) || ('content' in sample) || ('comment' in sample) || ('uid' in sample);
        if (!isWbEntry) return false;
    }
    return true;
}

/** 逐字复刻 main.js 的 handleOne（大文件档）—— **必须用 fs.promises 真异步**。
 *  ⚠️ 踩坑记录：首版用 `readFileSync` + `Promise.all` 包同步函数 → 实际是**串行**执行
 *     （async 函数体内无 await，body 同步跑完），于是所有并发档位耗时几乎相同（244~262ms），
 *     数据「看起来很稳」但**完全没有测到并发**。改用 fs.promises 后并发才真正生效。 */
async function handleOne(fullPath) {
    const st = await fs.promises.stat(fullPath);
    if (st.size > SCAN_PARSE_MAX_BYTES) {
        return { kind: 'meta', size: st.size };            // >50MB 只回元数据
    }
    if (st.size > 512 * 1024) {
        // 与 main.js 一致：用 file handle 只读头 64KB（不整文件载入）
        const fh = await fs.promises.open(fullPath, 'r');
        try {
            const buf = Buffer.alloc(64 * 1024);
            const r = await fh.read(buf, 0, buf.length, 0);
            const bytes = (r && typeof r.bytesRead === 'number') ? r.bytesRead : buf.length;
            if (!buf.subarray(0, bytes).toString('utf-8').includes('"entries"')) {
                return { kind: 'skip', size: st.size, reason: 'head-miss' };
            }
        } finally { await fh.close().catch(() => {}); }
    }
    const text = await fs.promises.readFile(fullPath, 'utf-8');
    const wbData = JSON.parse(text);
    const valid = isValidWorldbook(wbData);
    return { kind: valid ? 'ok' : 'skip', size: st.size, entries: Array.isArray(wbData.entries) ? wbData.entries.length : 0 };
}

// ── 挑出「大文件档」（5MB < size ≤ 50MB）作为被测集合 ──
const all = readdirSync(DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
    .map(d => path.join(DIR, d.name))
    .map(f => ({ f, size: statSync(f).size }));
const heavy = all.filter(x => x.size > SCAN_INLINE_MAX_BYTES && x.size <= SCAN_PARSE_MAX_BYTES);
const normal = all.filter(x => x.size <= SCAN_INLINE_MAX_BYTES);

const mb = (b) => (b / 1048576).toFixed(1) + 'MB';
const heapMB = () => { if (global.gc) global.gc(); return process.memoryUsage().heapUsed / 1048576; };

console.log(`\n===== T6 实测：5~50MB 档并发（${DIR}）=====`);
console.log(`常规档（≤5MB）：${normal.length} 本 / ${mb(normal.reduce((s, x) => s + x.size, 0))}`);
console.log(`大文件档（5~50MB）：${heavy.length} 本 / ${mb(heavy.reduce((s, x) => s + x.size, 0))}`);
console.log(`当前生产值：SCAN_HEAVY_CONCURRENCY = ${PROD_HEAVY_CONC } / SCAN_JSON_BATCH = ${PROD_JSON_BATCH}\n`);

if (!heavy.length) { console.log('本目录没有 5~50MB 的世界书，无法实测。'); process.exit(0); }

// 基线：串行结果（作为「判定一致性」的真相）
const baseline = new Map();
for (const x of heavy) baseline.set(x.f, JSON.stringify(await handleOne(x.f)));

console.log('并发  耗时      堆峰值(相对)  峰值增量  判定一致  说明');
const report = [];
for (const C of CONCURRENCY_LEVELS) {
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sample = () => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; };

    const t0 = performance.now();
    const out = new Map();
    for (let i = 0; i < heavy.length; i += C) {
        const batch = heavy.slice(i, i + C);
        const res = await Promise.all(batch.map(async (x) => {
            sample();
            const r = await handleOne(x.f);
            sample();
            return [x.f, JSON.stringify(r)];
        }));
        for (const [k, v] of res) out.set(k, v);
        sample();
    }
    const ms = performance.now() - t0;
    const peakDelta = (peak - before) / 1048576;

    const consistent = [...baseline.keys()].every(k => baseline.get(k) === out.get(k));
    report.push({ C, ms, peakDelta, consistent });
    console.log(
        `${String(C).padStart(4)}  ${(ms.toFixed(0) + 'ms').padStart(9)}  ${mb(peak).padStart(12)}  ${(peakDelta.toFixed(1) + 'MB').padStart(9)}  ${(consistent ? '✅' : '❌').padEnd(9)}  `
    );
}

console.log('\n===== 结论 =====');
const best = report.reduce((a, b) => (b.ms < a.ms ? b : a));
const base3 = report.find(r => r.C === 3);
console.log(`最快档位：并发 ${best.C}（${best.ms.toFixed(0)}ms，峰值增量 ${best.peakDelta.toFixed(1)}MB）`);
if (base3) {
    const speedup = ((base3.ms - best.ms) / base3.ms * 100).toFixed(0);
    console.log(`相对生产值（并发 ${PROD_HEAVY_CONC}）：${speedup > 0 ? `快 ${speedup}%` : '无提升'}；峰值增量 ${base3.peakDelta.toFixed(1)}MB → ${best.peakDelta.toFixed(1)}MB`);
}
console.log(`判定一致性：${report.every(r => r.consistent) ? '✅ 所有并发档结果与串行基线完全一致' : '❌ 存在不一致，说明并发路径有副作用'}`);
console.log('');
