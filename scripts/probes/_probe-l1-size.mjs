/**
 * L1 摘要体积实测（离线，不起应用）
 *
 * 目的：用**真实世界书数据**回答评审的核心质疑 ——
 *   「L1 摘要 2~4KB/本 的估算是否过于乐观？」
 *
 * 实测项：
 *   ① 每本 parse 后字符数 vs 磁盘 size（验证「size × 2」系数是否够）
 *   ② 去重触发词数、长度分布、**原字符串存储体积**（含 JS 字符串/数组开销）
 *   ③ 若改存 **Uint32Array hash** 的体积
 *   ④ 含 emoji / 非 BMP 字符的比例（验证 UTF-16 系数余量）
 *   ⑤ 全库外推（按 5401 本）
 *
 * 用法：node scripts/probes/_probe-l1-size.mjs "<世界书目录>" [采样本数]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
const LIMIT = Number(process.argv[3]) || 100;
if (!DIR) { console.error('用法：node scripts/probes/_probe-l1-size.mjs <目录> [采样本数]'); process.exit(1); }

// —— 规范化：与方案里写死的口径一致（trim + lowercase + NFC）
const norm = (s) => String(s).trim().toLowerCase().normalize('NFC');

// —— 提取触发词（与 useDedupe.getWorldbookKeysSet 同口径）
function extractKeys(entries) {
    const keys = new Set();
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const arr = Array.isArray(e.key) ? e.key : (e.key ? [e.key] : []);
        for (const k of arr) { const s = norm(k); if (s) keys.add(s); }
    }
    return keys;
}

// —— 字符串真实体积估算（UTF-16：每 code unit 2 字节 + 每字符串约 40B 头部 + 数组槽 8B）
function strBytes(s) {
    // Buffer.byteLength(s,'utf16le') 精确反映 UTF-16 code unit 数 × 2
    return Buffer.byteLength(s, 'utf16le');
}
const STR_OVERHEAD = 40;   // V8 字符串头部（实测约 16~24B + 对齐，保守取 40）
const ARRAY_SLOT = 8;      // 数组/Set 槽位指针

// —— 32 位 hash（FNV-1a），用于估算 hash 数组方案体积
function fnv1a32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

// —— 递归收集 .json
const files = [];
(function walk(d, depth = 0) {
    if (depth > 5) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.toLowerCase().endsWith('.json')) files.push(p);
    }
})(DIR);

console.log(`目录：${DIR}`);
console.log(`共 ${files.length} 个 .json，采样 ${Math.min(LIMIT, files.length)} 本\n`);

// —— 均匀采样（避免只取到前 N 本同源书）
const step = Math.max(1, Math.floor(files.length / LIMIT));
const sample = [];
for (let i = 0; i < files.length && sample.length < LIMIT; i += step) sample.push(files[i]);

const rows = [];
let parseMsTotal = 0, hashMsTotal = 0;

for (const f of sample) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const t0 = performance.now();
    let text; try { text = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    let data; try { data = JSON.parse(text); } catch { continue; }
    const parseMs = performance.now() - t0;
    parseMsTotal += parseMs;

    const entries = Array.isArray(data.entries) ? data.entries
        : (data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : []);
    if (!entries.length) continue;

    // ① 体积系数：parse 后字符数 vs 磁盘 size
    const charCount = text.length;
    const ratio = st.size ? charCount / st.size : 0;

    // ② 触发词
    const keys = extractKeys(entries);
    const keyArr = [...keys];
    let keyChars = 0, maxLen = 0;
    for (const k of keyArr) { keyChars += k.length; if (k.length > maxLen) maxLen = k.length; }
    const avgLen = keyArr.length ? keyChars / keyArr.length : 0;
    // 原字符串方案：字符字节 + 每串头部 + 槽位
    const keysRawBytes = keyArr.reduce((s, k) => s + strBytes(k) + STR_OVERHEAD, 0) + keyArr.length * ARRAY_SLOT;
    // hash 方案：Uint32Array
    const keysHashBytes = keyArr.length * 4;

    // ④ 非 BMP（emoji 等，1 字符 = 2 code unit）
    let nonBmp = 0;
    for (const k of keyArr) if (/[\u{10000}-\u{10FFFF}]/u.test(k)) nonBmp++;

    // hash 计算耗时
    const th = performance.now();
    for (const k of keyArr) fnv1a32(k);
    hashMsTotal += performance.now() - th;

    rows.push({
        name: path.basename(f),
        diskKB: +(st.size / 1024).toFixed(1),
        chars: charCount,
        ratio: +ratio.toFixed(2),
        entries: entries.length,
        keys: keyArr.length,
        keyDedupRatio: +(keyArr.length / entries.length).toFixed(2),
        avgKeyLen: +avgLen.toFixed(1),
        maxKeyLen: maxLen,
        keysRawKB: +(keysRawBytes / 1024).toFixed(1),
        keysHashKB: +(keysHashBytes / 1024).toFixed(2),
        nonBmp,
        parseMs: +parseMs.toFixed(1)
    });
}

// —— 汇总
const n = rows.length;
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const avg = (k) => sum(k) / n;
const p95 = (k) => { const a = rows.map(r => r[k]).sort((x, y) => x - y); return a[Math.floor(a.length * 0.95)]; };
const max = (k) => Math.max(...rows.map(r => r[k]));

console.log('═════ 逐本明细（前 15 本） ═════');
console.log('文件'.padEnd(34) + '磁盘KB'.padStart(9) + '字符数'.padStart(11) + '系数'.padStart(7)
    + '词条'.padStart(7) + '去重keys'.padStart(10) + '均长'.padStart(6) + '原串KB'.padStart(9) + 'hashKB'.padStart(8));
for (const r of rows.slice(0, 15)) {
    console.log(String(r.name).slice(0, 32).padEnd(34)
        + String(r.diskKB).padStart(9) + String(r.chars).padStart(11) + String(r.ratio).padStart(7)
        + String(r.entries).padStart(7) + String(r.keys).padStart(10) + String(r.avgKeyLen).padStart(6)
        + String(r.keysRawKB).padStart(9) + String(r.keysHashKB).padStart(8));
}

console.log('\n═════ 汇总（' + n + ' 本采样） ═════');
console.log('① 体积系数（parse 后字符 / 磁盘字节）  平均 ' + avg('ratio').toFixed(2) + ' ｜ P95 ' + p95('ratio').toFixed(2) + ' ｜ max ' + max('ratio').toFixed(2));
console.log('② 触发词数/本                        平均 ' + avg('keys').toFixed(0) + ' ｜ P95 ' + p95('keys') + ' ｜ max ' + max('keys'));
console.log('   去重比（keys/词条）                平均 ' + avg('keyDedupRatio').toFixed(2));
console.log('   触发词平均长度                     平均 ' + avg('avgKeyLen').toFixed(1) + ' 字符 ｜ 最长 ' + max('maxKeyLen') + ' 字符');
console.log('③ 原字符串方案 单本体积               平均 ' + avg('keysRawKB').toFixed(1) + 'KB ｜ P95 ' + p95('keysRawKB').toFixed(1) + 'KB ｜ max ' + max('keysRawKB').toFixed(1) + 'KB');
console.log('   hash 数组方案 单本体积             平均 ' + avg('keysHashKB').toFixed(2) + 'KB ｜ max ' + max('keysHashKB').toFixed(2) + 'KB');
console.log('   压缩比（原串/hash）                ' + (avg('keysRawKB') / Math.max(0.01, avg('keysHashKB'))).toFixed(1) + '×');
console.log('④ 含非 BMP（emoji）的书               ' + rows.filter(r => r.nonBmp > 0).length + '/' + n);
console.log('⑤ parse 耗时/本                      平均 ' + avg('parseMs').toFixed(1) + 'ms ｜ 合计 ' + parseMsTotal.toFixed(0) + 'ms');
console.log('   hash 计算耗时/本（全部 keys）      平均 ' + (hashMsTotal / n).toFixed(2) + 'ms ｜ 合计 ' + hashMsTotal.toFixed(1) + 'ms');

// —— 全库外推
const TOTAL_BOOKS = Number(process.env.TOTAL_BOOKS) || 5401;
const ext = (kb) => (kb * TOTAL_BOOKS / 1024).toFixed(1) + 'MB';
console.log('\n═════ 全库外推（' + TOTAL_BOOKS + ' 本） ═════');
console.log('原字符串方案（平均）  ' + ext(avg('keysRawKB')) + '   ｜（按 P95 本） ' + ext(p95('keysRawKB')) + '  ｜（按最大本） ' + ext(max('keysRawKB')));
console.log('hash 数组方案（平均） ' + ext(avg('keysHashKB')) + '   ｜（按 P95 本） ' + ext(p95('keysHashKB')) + '  ｜（按最大本） ' + ext(max('keysHashKB')));
console.log('\n★ 结论：' + (avg('keysRawKB') > 4
    ? '评审的质疑成立 —— 原字符串方案平均 ' + avg('keysRawKB').toFixed(1) + 'KB/本，远超方案原估 2~4KB'
    : '原估算基本成立（平均 ' + avg('keysRawKB').toFixed(1) + 'KB/本）'));
