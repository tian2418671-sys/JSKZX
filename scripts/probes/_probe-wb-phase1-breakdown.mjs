/**
 * 阶段 1（秒开）耗时构成分解（2026-09-23）
 *
 * 背景：主进程注释称「阶段 1 = ~780ms，其中 stat 649ms（83%）」；
 *   但独立 Node 实测 `readdir+stat` 只要 ~133ms。差距必须查清 ——
 *   否则「改成只读文件名」能省多少会算错。
 *
 * 本脚本分解 4 项：
 *   ① 纯 readdir（递归）
 *   ② + realpathSync（主进程 fastWalk 每个目录都调）
 *   ③ + fs.promises.stat（主进程口径）
 *   ④ + 组装 5401 个对象并 JSON 序列化（**IPC 回渲染层的成本代理**）
 *
 * 用法：node scripts/probes/_probe-wb-phase1-breakdown.mjs "<目录>"
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) { console.error('用法：node scripts/probes/_probe-wb-phase1-breakdown.mjs "<目录>"'); process.exit(1); }

const isJson = (n) => n.toLowerCase().endsWith('.json');

// ① 纯 readdir
function walkOnly(dir, acc) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walkOnly(fp, acc);
        else if (isJson(e.name)) acc.push(fp);
    }
}

// ② + realpathSync
function walkReal(dir, acc, visited) {
    let realDir;
    try { realDir = fs.realpathSync(dir); } catch { return; }
    if (visited.has(realDir)) return;
    visited.add(realDir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walkReal(fp, acc, visited);
        else if (isJson(e.name)) acc.push(fp);
    }
}

// ③ + 异步 stat（主进程口径：每目录 Promise.all）
async function walkStat(dir, acc, visited) {
    let realDir;
    try { realDir = fs.realpathSync(dir); } catch { return; }
    if (visited.has(realDir)) return;
    visited.add(realDir);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    const files = entries
        .filter(e => !e.name.startsWith('.') && e.isFile() && path.extname(e.name).toLowerCase() === '.json')
        .map(e => path.join(dir, e.name));
    await Promise.all(files.map(async (fp) => {
        let st;
        try { st = await fs.promises.stat(fp); } catch { return; }
        acc.push({ path: fp, name: path.basename(fp), size: st.size, mtime: st.mtimeMs });
    }));
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        await walkStat(path.join(dir, e.name), acc, visited);
    }
}

const t = () => Date.now();

// ── ① ──
let t0 = t(); const a1 = []; walkOnly(ROOT, a1); const ms1 = t() - t0;
console.log(`① 纯 readdir                        ${ms1}ms（${a1.length} 个 .json）`);

// ── ② ──
t0 = t(); const a2 = []; walkReal(ROOT, a2, new Set()); const ms2 = t() - t0;
console.log(`② + realpathSync（每目录）           ${ms2}ms  → realpath 成本 ≈ ${ms2 - ms1}ms`);

// ── ③ ──
t0 = t(); const a3 = []; await walkStat(ROOT, a3, new Set()); const ms3 = t() - t0;
console.log(`③ + fs.promises.stat                ${ms3}ms  → stat 成本 ≈ ${ms3 - ms2}ms`);

// ── ④ 序列化成本（IPC 代理）──
// 模拟「热缓存命中」：每本带 keyHashes（实测 P95 ≈ 1492 个 hash）
const KH_LEN = 1492;
const payload = a3.map((f, i) => ({
    path: f.path, name: f.name, size: f.size, mtime: f.mtime,
    entryCount: 1905, wbName: '世界书-' + i,
    keyHashes: Array.from({ length: KH_LEN }, (_, k) => (i * KH_LEN + k) >>> 0),
    exactContentHash: 'abcdef1234567890',
    heavy: f.size > 5 * 1024 * 1024, dataLoaded: false, data: null, metaPending: false
}));
t0 = t();
const json = JSON.stringify(payload);
const ms4 = t() - t0;
console.log(`④ JSON 序列化（含 keyHashes）        ${ms4}ms  → 体积 ${(json.length / 1048576).toFixed(1)}MB`);

// 对照：不含 keyHashes
const payloadNoL1 = a3.map(f => ({
    path: f.path, name: f.name, size: f.size, mtime: f.mtime,
    entryCount: null, wbName: null, heavy: f.size > 5 * 1024 * 1024,
    dataLoaded: false, data: null, metaPending: true
}));
t0 = t();
const json2 = JSON.stringify(payloadNoL1);
const ms5 = t() - t0;
console.log(`   对照：不含 keyHashes 序列化        ${ms5}ms  → 体积 ${(json2.length / 1048576).toFixed(2)}MB`);

console.log('');
console.log('───── 汇总 ─────');
console.log(`阶段 1 理论总耗时（主进程侧）≈ ${ms3 + ms4}ms（fs ${ms3}ms + 序列化 ${ms4}ms）`);
console.log(`若改成「只读文件名」：fs ${ms1}ms + 序列化 ${ms5}ms ≈ ${ms1 + ms5}ms`);
console.log(`⇒ 单次省 ≈ ${(ms3 + ms4) - (ms1 + ms5)}ms（${(((ms3 + ms4) - (ms1 + ms5)) / (ms3 + ms4) * 100).toFixed(0)}%）`);
