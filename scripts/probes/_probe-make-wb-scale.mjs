/**
 * 规模梯度压力库构造（用硬链接，零拷贝、瞬间完成）
 *
 * 用法：
 *   node scripts/probes/_probe-make-wb-scale.mjs            # 构造 s050 / s100 / s200 / s300 / s400
 *   node scripts/probes/_probe-make-wb-scale.mjs --clean    # 删除
 *
 * 为什么要梯度：500 本一次性崩溃只能说明「会崩」，不能证明「是体积驱动」。
 *   按规模递增找出临界点，才能把根因钉死在「内联 data 总量 vs 渲染堆上限」。
 *
 * ⚠️ 硬链接（HardLink）要求同卷同文件系统（本机都在 D:），且不占额外空间。
 *   每个规模目录的**根目录**必须放 ≥1 个 .json —— 否则 `wb:scan` 的
 *   顶层指纹验证（只 readdir 顶层）会拒绝授权（见 _probe-make-wb-lib.mjs 注释）。
 */
import fs from 'node:fs';
import path from 'node:path';

const LIB = 'D:/TkDmGzq/_wb500';
const OUT = 'D:/TkDmGzq/_wbscale';

if (process.argv.includes('--clean')) {
    if (fs.existsSync(OUT)) { fs.rmSync(OUT, { recursive: true, force: true }); console.log('已删除 ' + OUT); }
    else console.log('无需删除：' + OUT);
    process.exit(0);
}

// 每个规模：源组目录 + 需要的有效世界书数量
// 每组 25 本有效世界书；全部 >5MB（走 heavy 档）
const GROUPS = [];
for (let g = 2; g <= 20; g++) GROUPS.push(path.join(LIB, 'g' + String(g).padStart(2, '0')));
// 根目录也算一组（27 个文件，25 本有效 + 2 诱饵）
const ROOT_GROUP = LIB;

const SCALES = [50, 100, 200, 300, 400];

const link = (src, dst) => {
    if (fs.existsSync(dst)) return false;
    try { fs.linkSync(src, dst); return true; }
    catch (e) { fs.copyFileSync(src, dst); return true; }   // 跨卷/不支持时退回复制
};

fs.mkdirSync(OUT, { recursive: true });

for (const n of SCALES) {
    const dir = path.join(OUT, 's' + String(n).padStart(3, '0'));
    fs.mkdirSync(dir, { recursive: true });
    let count = 0;
    let bytes = 0;

    // ① 先放根目录指纹文件（1 本有效世界书，放顶层）
    const fpSrc = path.join(LIB, '炎孕-异世界工口学院物语-威力加强版 世界书.json');
    if (link(fpSrc, path.join(dir, '指纹-炎孕.json'))) { count++; bytes += fs.statSync(fpSrc).size; }

    // ② 依次从各组链接文件，直到凑够 n 本有效世界书
    const groupList = [ROOT_GROUP, ...GROUPS];
    for (const g of groupList) {
        if (count >= n) break;
        const sub = path.join(dir, 'g' + path.basename(g));
        fs.mkdirSync(sub, { recursive: true });
        const files = fs.readdirSync(g).filter(f => f.endsWith('.json'));
        // 只链接**有效世界书**（排除诱饵与坏 JSON），保证「有效本数 = n」
        const validOnes = files.filter(f =>
            !f.includes('非世界书') && !f.includes('超巨世界书'));
        for (const f of validOnes) {
            if (count >= n) break;
            const s = path.join(g, f);
            const d = path.join(sub, f);
            if (link(s, d)) { count++; bytes += fs.statSync(s).size; }
        }
        if (!validOnes.length) fs.rmdirSync(sub);   // 空目录清掉
    }
    console.log(`s${String(n).padStart(3, '0')}: ${count} 本 / ${(bytes / 1073741824).toFixed(2)} GB`);
}

console.log('\n═════ 规模梯度库已就绪 ═════');
console.log('目录: ' + OUT);
for (const n of SCALES) {
    const d = path.join(OUT, 's' + String(n).padStart(3, '0'));
    let total = 0, cnt = 0;
    const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(p, e.name));
        else if (e.name.endsWith('.json')) { cnt++; total += fs.statSync(path.join(p, e.name)).size; }
    } };
    walk(d);
    console.log(`  s${String(n).padStart(3, '0')}  .json ${cnt} 个  ${(total / 1073741824).toFixed(2)} GB`);
}
