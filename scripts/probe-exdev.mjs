/**
 * 🔗 跨盘落盘验证（EXDEV 修复）
 *
 * 复现用户实测场景：暂存目录在系统盘（C:），插件库在别的盘（E:）。
 * 直接 fs.rename 会报 `EXDEV: cross-device link not permitted`，
 * 必须降级为「递归复制 + 删源」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const src = path.join(os.tmpdir(), 'exdev-src-' + Date.now());
fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ name: '随机指令', version: '2.2.0' }));
fs.writeFileSync(path.join(src, 'sub', 'a.js'), '// a');

const dest = 'E:\\AI\\酒馆工具\\_exdev_dest_' + Date.now();

// 1) 复现：跨盘 rename 必然失败
let renameFailed = false;
try {
    await fs.promises.rename(src, dest);
    console.log('1) rename 成功 → 同盘（本机 C: 与 E: 应当跨盘，请检查）');
} catch (e) {
    renameFailed = true;
    console.log('1) rename 失败，错误码 =', e.code, '（预期 EXDEV）');
}

// 2) moveDir 降级逻辑（与 main.js 中实现一致）
const moveDir = async (from, to) => {
    try {
        await fs.promises.rename(from, to);
    } catch (e) {
        if (e && e.code === 'EXDEV') {
            await fs.promises.cp(from, to, { recursive: true, force: true });
            await fs.promises.rm(from, { recursive: true, force: true });
        } else {
            throw e;
        }
    }
};

if (renameFailed) {
    const src2 = path.join(os.tmpdir(), 'exdev-src2-' + Date.now());
    fs.mkdirSync(path.join(src2, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src2, 'manifest.json'), JSON.stringify({ name: '随机指令', version: '2.2.0' }));
    fs.writeFileSync(path.join(src2, 'sub', 'a.js'), '// a');

    await moveDir(src2, dest);
    console.log('2) moveDir 降级成功');
    console.log('   目标内容:', fs.readdirSync(dest).join(', '));
    console.log('   子目录   :', fs.readdirSync(path.join(dest, 'sub')).join(', '));
    console.log('   源已删除 :', !fs.existsSync(src2));
} else {
    // 同盘情况下 rename 已把 src 移走，直接用 dest 检查
    console.log('2) 同盘，内容:', fs.readdirSync(dest).join(', '));
}

fs.rmSync(dest, { recursive: true, force: true });
try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) { /* 已移走 */ }
console.log('\n✅ 验证完成，已清理临时目录');
