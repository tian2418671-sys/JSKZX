/**
 * PNG 头读取量探针（配合 measure-startup.mjs 评估「冷启动」成本）
 *
 * 背景：2026-09-13 移除了 PNG 内嵌提取缓存（实测负优化），代价是**每次启动都要重读所有 PNG 头**。
 * 那么「刚开机（OS 文件缓存冷）」到底要读多少数据、开多少次文件？本脚本按**与主进程完全相同的
 * 窗口逻辑**（`main.js → readPngEmbeddedFromFile`）算给你看，并把磁盘真实读一遍测吞吐。
 *
 * 主进程读取逻辑（等价）：
 *   size ≤ 1MB   → 直接整文件兜底（读 size 字节）
 *   1MB < size   → 先读前 1MB，命中则停；未命中再读 8MB；仍未命中读整个文件
 *   ⚠️ 实测（2026-09-13）：本库多数卡的 `chara` 块位于**文件末尾附近**
 *      （块结束偏移 P50≈616KB / P90≈897KB / P99≈1010KB），所以「把首读窗口缩小到 64KB」这类优化
 *      无效（64KB 只能命中 24%）。下面按真实逻辑把「读 1MB / 读整文件」分开统计。
 *
 * 用法：
 *   node scripts/tools/png-head-io-probe.mjs                        # 默认 I:\03\角色色卡
 *   node scripts/tools/png-head-io-probe.mjs --library "D:\某库"
 *   node scripts/tools/png-head-io-probe.mjs --dry                # 只统计不实读
 *   node scripts/tools/png-head-io-probe.mjs --concurrency 128     # 默认与应用一致
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : d; };
const LIB = arg('library', 'I:\\03\\角色色卡');
const CONC = Math.max(1, Number(arg('concurrency', '128')) || 128);
const DRY = argv.includes('--dry');
const WIN = 1024 * 1024;

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
const fmt = (n) => n.toLocaleString('en-US');

function chunkIn(buf) {
    if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) return false;
    let off = 8;
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (off + 12 + len > buf.length) return false;   // 截断 → 块不在本窗口
        const type = buf.subarray(off + 4, off + 8).toString('latin1');
        if (type === 'tEXt' || type === 'iTXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const nul = data.indexOf(0);
            if (nul > 0) {
                const kw = data.subarray(0, nul).toString('latin1');
                if (kw === 'chara' || kw === 'ccv3') return true;
            }
        }
        off += 12 + len;
    }
    return false;
}

async function walk(dir, out = []) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p, out); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.png' || ext === '.json') out.push(p);
    }
    return out;
}

(async () => {
    if (!fs.existsSync(LIB)) { console.error(`❌ 库目录不存在：${LIB}`); process.exit(1); }
    console.log(`📦 扫描：${LIB}`);
    const t0 = Date.now();
    const files = await walk(LIB);
    const scanMs = Date.now() - t0;

    // 统计体积分布（并复刻主进程读取逻辑：1MB 命中即停，否则整文件兜底）
    let total = 0, expectRead = 0;
    const buckets = { le1mb: 0, le8mb: 0, gt8mb: 0 };
    const tasks = [];
    for (const f of files) {
        let st; try { st = await fsp.stat(f); } catch { continue; }
        const size = st.size || 0;
        total += size;
        if (size <= WIN) buckets.le1mb++; else if (size <= 8 * WIN) buckets.le8mb++; else buckets.gt8mb++;
        // 读前 1MB 判断块是否落在这个窗口里
        let read = size <= WIN ? size : Math.min(size, WIN);
        if (size > WIN) {
            let fh = null;
            try {
                fh = await fsp.open(f, 'r');
                const head = Buffer.allocUnsafe(WIN);
                const { bytesRead } = await fh.read(head, 0, WIN, 0);
                if (!chunkIn(head.subarray(0, bytesRead))) read = size;   // 未命中 → 主进程会兜底读整个文件
            } catch { read = 0; } finally { if (fh) { try { await fh.close(); } catch { /* */ } } }
        }
        expectRead += read;
        tasks.push({ f, size, read });
    }

    console.log(`   文件 ${fmt(tasks.length)} 个｜合计 ${mb(total)}｜目录遍历 ${scanMs}ms`);
    console.log(`   ≤1MB: ${fmt(buckets.le1mb)}｜1~8MB: ${fmt(buckets.le8mb)}｜>8MB: ${fmt(buckets.gt8mb)}`);
    console.log(`\n🔎 按主进程窗口逻辑，每次启动需读取：${fmt(tasks.length)} 次文件打开 + 约 ${mb(expectRead)}`);

    if (DRY) { console.log('（--dry：跳过实读）'); process.exit(0); }

    // 实读一遍（与主进程同并发），得到「缓存已热」下的参照吞吐
    console.log(`\n⚙️ 实读中（并发 ${CONC}）…`);
    let done = 0, bytes = 0, i = 0;
    const t1 = Date.now();
    const worker = async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            let fh = null;
            try {
                fh = await fsp.open(t.f, 'r');
                const buf = Buffer.allocUnsafe(t.read);
                await fh.read(buf, 0, t.read, 0);
                bytes += t.read; done++;
            } catch { /* 跳过读失败 */ } finally { if (fh) { try { await fh.close(); } catch { /* */ } } }
        }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    const ms = Date.now() - t1;
    const throughput = bytes / 1048576 / (ms / 1000);
    console.log(`   用时 ${(ms / 1000).toFixed(1)}s｜实读 ${mb(bytes)}｜等效吞吐 ${throughput.toFixed(0)}MB/s（缓存已热）`);

    // 冷启动估算：字节/吞吐 + 每次打开的固定开销（应用内实测 ~40-120µs/次；Defender 实时防护下会更高）
    const perOpenLow = 0.04, perOpenHigh = 0.30;   // ms
    const coldBytes = expectRead / 1048576 / 600;  // 假设冷盘顺序读 600MB/s（保守，NVMe 随机头读远低于顺序）
    console.log(`\n🧊 冷启动估算（重启后首次）：`);
    console.log(`   仅按 600MB/s 冷盘吞吐：约 ${coldBytes.toFixed(1)}s`);
    console.log(`   叠加每次打开开销 ${perOpenLow}~${perOpenHigh}ms × ${fmt(tasks.length)} 次：约 ${(coldBytes + tasks.length * perOpenLow / 1000).toFixed(1)}~${(coldBytes + tasks.length * perOpenHigh / 1000).toFixed(1)}s`);
    console.log(`   ⇒ 结论口径：冷启动额外成本主要由「${fmt(tasks.length)} 次文件打开」的固定开销决定，而不是读取字节数（仅 ${mb(expectRead)}）。`);
    console.log(`\n💡 实测冷启动：重启电脑后第一时间执行  node scripts/tools/measure-startup.mjs --label 冷启动 --timeout 240000`);
})().catch((e) => { console.error('❌ 失败：', e.message); process.exit(1); });
