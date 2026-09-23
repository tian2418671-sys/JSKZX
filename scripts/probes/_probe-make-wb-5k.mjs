/**
 * 5000 本世界书极端压力库生成器（**硬链接，零拷贝**）
 *
 * 用法：
 *   node scripts/probes/_probe-make-wb-5k.mjs            # 生成 _wb5k 全部规模档
 *   node scripts/probes/_probe-make-wb-5k.mjs --clean    # 删除
 *
 * ⚠️ 为什么必须用硬链接：5000 本 × 平均 8MB ≈ **40GB**。
 *   真实复制既慢（40GB 写盘）又占地（D 盘只剩 195GB，还要留余量）。
 *   硬链接让 5000 个"文件"共享同一批物理数据 → **占用 0 额外空间、瞬间完成**。
 *   要求：源与目标在同一卷（都在 D:）。
 *
 * 目录结构（D:\TkDmGzq\_wb5k）：
 *   s1000/  s2000/  s3000/  s5000/     ← 四个规模档，各含 指纹-炎孕.json（根目录指纹）
 *     g001/ .. gNNN/                   ← 每目录 27 个文件 = 25 本有效 + 2 个诱饵
 *
 * 每目录构成（沿用已验证的 27 文件布局）：
 *   1 基准A(炎孕 6.5MB) + 1 基准B(女神 9.9MB) + 15 副本A + 4 副本B + 4 改写变体 + 2 诱饵
 *
 * ⚠️ 根目录必须放 ≥1 个 .json：`wb:scan` 的白名单指纹验证**只 readdir 顶层**，
 *   顶层全是子目录的库会被直接拒绝授权。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/TkDmGzq/_wb500';
const OUT = 'D:/TkDmGzq/_wb5k';

const A_NAME = '炎孕-异世界工口学院物语-威力加强版 世界书.json';

// 每目录 25 本有效书的源文件（组内文件名唯一）
const VALID_SRC = [
    { src: A_NAME, dst: A_NAME },                                     // 基准 A
    { src: '女神攻略调教手册.json', dst: '女神攻略调教手册.json' },      // 基准 B
    ...Array.from({ length: 15 }, (_, i) => ({ src: A_NAME, dst: `炎孕-副本${String(i + 1).padStart(2, '0')}.json` })),
    ...Array.from({ length: 4 }, (_, i) => ({ src: '女神攻略调教手册.json', dst: `女神-副本${String(i + 1).padStart(2, '0')}.json` })),
    { src: '炎孕-改写A.json', dst: '炎孕-改写A.json' },
    { src: '炎孕-改写B.json', dst: '炎孕-改写B.json' },
    { src: '炎孕-改写C.json', dst: '炎孕-改写C.json' },
    { src: '炎孕-改写D.json', dst: '炎孕-改写D.json' }
];
// 每目录 2 个诱饵（应被 isValidWorldbook 拦下）
const DECOY_SRC = [
    { src: '非世界书-角色卡.json', dst: '非世界书-角色卡.json' },
    { src: '非世界书-大表格.json', dst: '非世界书-大表格.json' }
];

if (VALID_SRC.length !== 25) { console.error('每目录有效书数 ≠ 25：' + VALID_SRC.length); process.exit(1); }
const PER_GROUP = VALID_SRC.length + DECOY_SRC.length;   // 27

const SCALES = [
    { name: 's1000', books: 1000 },
    { name: 's2000', books: 2000 },
    { name: 's3000', books: 3000 },
    { name: 's5000', books: 5000 }
];

if (process.argv.includes('--clean')) {
    if (fs.existsSync(OUT)) { fs.rmSync(OUT, { recursive: true, force: true }); console.log('已删除 ' + OUT); }
    else console.log('无需删除：' + OUT);
    process.exit(0);
}

// ── 源文件校验 ──
for (const it of [...VALID_SRC, ...DECOY_SRC]) {
    const p = path.join(SRC, it.src);
    if (!fs.existsSync(p)) { console.error('源文件缺失：' + p); process.exit(1); }
}
console.log(`源库：${SRC}`);
console.log(`每目录 ${PER_GROUP} 个文件（${VALID_SRC.length} 有效 + ${DECOY_SRC.length} 诱饵）\n`);

/** 硬链接（同卷零拷贝）；不支持时退回复制 */
let linkCount = 0, copyCount = 0;
const link = (src, dst) => {
    if (fs.existsSync(dst)) return false;
    try { fs.linkSync(src, dst); linkCount++; return true; }
    catch (e) { fs.copyFileSync(src, dst); copyCount++; return true; }
};

const t0 = Date.now();
const summary = [];

for (const sc of SCALES) {
    const dir = path.join(OUT, sc.name);
    fs.mkdirSync(dir, { recursive: true });

    // ① 根目录指纹文件（wb:scan 的白名单指纹验证只 readdir 顶层）
    link(path.join(SRC, A_NAME), path.join(dir, '指纹-炎孕.json'));

    const groups = Math.ceil(sc.books / VALID_SRC.length);
    for (let g = 1; g <= groups; g++) {
        const gdir = path.join(dir, 'g' + String(g).padStart(3, '0'));
        fs.mkdirSync(gdir, { recursive: true });
        for (const it of VALID_SRC) link(path.join(SRC, it.src), path.join(gdir, it.dst));
        for (const it of DECOY_SRC) link(path.join(SRC, it.src), path.join(gdir, it.dst));
    }

    // 磁盘对账（注意：硬链接的"体积"会被重复计入，但物理占用为 0）
    let json = 0, valid = 0, decoy = 0;
    (function walk(p) {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const fp = path.join(p, e.name);
            if (e.isDirectory()) { walk(fp); continue; }
            if (!e.name.toLowerCase().endsWith('.json')) continue;
            json++;
            if (/非世界书/.test(e.name)) decoy++; else valid++;
        }
    })(dir);

    summary.push({ scale: sc.name, groups, json, valid, decoy });
    console.log(`${sc.name}: ${groups} 目录 × ${PER_GROUP} = ${json} 个 .json（有效 ${valid} / 诱饵 ${decoy}）`);
}

// ── 物理占用（硬链接不重复计） ──
let diskBytes = 0;
try {
    const seen = new Set();
    (function walk(p) {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, e.name);
            if (e.isDirectory()) { walk(fp); continue; }
            const st = fs.statSync(fp);
            const key = st.ino + ':' + st.dev;
            if (seen.has(key)) continue;
            seen.add(key);
            diskBytes += st.size;
        }
    })(OUT);
} catch (e) { /* 忽略 */ }

console.log('\n═════ 5000 本极端压力库生成完成 ═════');
console.log('输出目录 : ' + OUT);
console.log(`链接 ${linkCount} 个（硬链接，零拷贝）` + (copyCount ? `，复制 ${copyCount} 个` : ''));
console.log(`物理占用 : ${(diskBytes / 1073741824).toFixed(2)} GB（硬链接去重后；若为真实复制则需 ${(summary.reduce((s, x) => s + x.json, 0) * 8 / 1024).toFixed(0)}GB+）`);
console.log('耗时     : ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('\n各档明细：');
for (const s of summary) console.log(`  ${s.scale}: ${s.groups} 目录，${s.json} 个 .json（有效 ${s.valid}）`);
