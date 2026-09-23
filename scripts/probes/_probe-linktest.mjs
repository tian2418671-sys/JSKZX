/** 诊断：为什么 fs.linkSync 在 D: 同卷内失败（一次性排查） */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/TkDmGzq/_wb500/炎孕-异世界工口学院物语-威力加强版 世界书.json';
const TMP = 'D:/TkDmGzq/_linktest';

console.log('源文件存在：', fs.existsSync(SRC));
const st = fs.statSync(SRC);
console.log('源文件 size:', st.size, ' ino:', st.ino, ' dev:', st.dev, ' nlink:', st.nlink);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const dst = path.join(TMP, 'a.json');
try {
    fs.linkSync(SRC, dst);
    console.log('✅ linkSync 成功');
    const d2 = fs.statSync(dst);
    console.log('  目标 ino:', d2.ino, ' nlink:', d2.nlink);
} catch (e) {
    console.log('❌ linkSync 失败：', e.code, e.message);
}

// 再测一次：链接到已存在硬链接的源（_wbscale 里的文件）
const SRC2 = 'D:/TkDmGzq/_wbscale/s100/g002/炎孕-副本01.json';
if (fs.existsSync(SRC2)) {
    const st2 = fs.statSync(SRC2);
    console.log('\n_wbscale 源文件 nlink:', st2.nlink, ' ino:', st2.ino);
    const dst2 = path.join(TMP, 'b.json');
    try { fs.linkSync(SRC2, dst2); console.log('✅ 链接 _wbscale 文件成功'); }
    catch (e) { console.log('❌ 链接 _wbscale 文件失败：', e.code, e.message); }
}

// 检查 _wb5k 里已生成的文件：是硬链接还是副本？
const CHECK = 'D:/TkDmGzq/_wb5k/s1000/g001/炎孕-副本01.json';
if (fs.existsSync(CHECK)) {
    const c = fs.statSync(CHECK);
    console.log('\n_wb5k 中已生成文件 nlink:', c.nlink, '（1 = 独立副本，>1 = 硬链接）');
}

// 真实占用统计（用 nlink 去重更准）
let unique = new Set(), total = 0, files = 0;
(function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(p, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        const s = fs.statSync(fp);
        files++;
        const key = s.ino + ':' + s.dev;
        if (!unique.has(key)) { unique.add(key); total += s.size; }
    }
})('D:/TkDmGzq/_wb5k');
console.log(`\n_wb5k: ${files} 个文件，唯一 inode ${unique.size} 个，去重后 ${(total / 1048576).toFixed(1)}MB`);

fs.rmSync(TMP, { recursive: true, force: true });
