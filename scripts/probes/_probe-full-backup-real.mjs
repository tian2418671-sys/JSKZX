/**
 * 📦 整库冷备 · 真实验证（真库只读冷备 + **隔离副本**恢复演练）
 *
 * 口径（铁律 4）：
 *   · **真库只读**：对真实卡库 `E:\AI\酒馆工具\角色卡` 做一次冷备（源只读，产物写临时目录）；
 *   · **恢复演练在隔离副本**：把若干真卡复制到临时目录再恢复，**绝不**对真库执行恢复；
 *   · 轮转 / 防呆在生产实现上跑（`main/fullBackup.js`），删除用 shell 桩记录而非真删。
 *
 * 用法：node scripts/probes/_probe-full-backup-real.mjs ["E:\AI\酒馆工具\角色卡"]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFullBackupService, walkLibrary, MANIFEST_NAME, BACKUP_ROOT_NAME } from '../../main/fullBackup.js';

const REAL_LIB = process.argv[2] || 'E:\\AI\\酒馆工具\\角色卡';
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } };

console.log('═════ 整库冷备 · 真实验证 ═════');
console.log('真库（只读源）：' + REAL_LIB);

// ═══════ A. 真库只读冷备（产物落临时目录） ═══════
const destA = tmp('jsk-fb-real-');
const phases = [];
const svcA = createFullBackupService({ appVersion: 'probe', shell: null, onProgress: (p) => phases.push(p.phase) });
let realScanFiles = 0;
let realScanBytes = 0;
await walkLibrary(REAL_LIB, (rel, size) => { realScanFiles++; realScanBytes += size; });
console.log(`  真库独立扫描：${fmt(realScanFiles)} 个文件 · ${(realScanBytes / 1024 / 1024).toFixed(1)} MB`);
const A = await svcA.createBackup({ libraryPath: REAL_LIB, destRoot: destA, keep: 3 });
check('真库冷备成功（源只读）', !!(A && A.ok), JSON.stringify(A && { ok: A.ok, fileCount: A.fileCount, bytes: A.bytes, error: A.error }));
check('冷备文件数与独立扫描一致', !!A && A.fileCount === realScanFiles, `备份 ${A && A.fileCount} vs 扫描 ${realScanFiles}`);
check('冷备字节数与独立扫描一致', !!A && A.bytes === realScanBytes, `备份 ${A && A.bytes} vs 扫描 ${realScanBytes}`);
const manA = (() => { try { return JSON.parse(fs.readFileSync(path.join(A.backupDir, MANIFEST_NAME), 'utf8')); } catch (e) { return null; } })();
check('manifest 可读且字段齐全', !!manA && manA.schema === 1 && manA.fileCount === A.fileCount && String(manA.libraryPath) === path.resolve(REAL_LIB), JSON.stringify(manA && { schema: manA.schema, fileCount: manA.fileCount, libraryPath: manA.libraryPath }));
check('进度事件连续（scan → copy → done）', phases.includes('scan') && phases.includes('copy') && phases[phases.length - 1] === 'done', phases.join(' → '));
const listA = await svcA.listBackups({ destRoot: destA });
check('list 能列出该份冷备', listA.items.length === 1 && listA.items[0].fileCount === A.fileCount, JSON.stringify(listA.items.map((x) => ({ n: x.name, f: x.fileCount }))));
// 抽查一个真实文件的内容一致性（防"复制成空文件"）
let spotOk = false;
let spotInfo = '';
if (manA && manA.files.length) {
    const pick = manA.files.find((f) => /\.png$/i.test(f.rel)) || manA.files[0];
    const srcP = path.join(REAL_LIB, pick.rel.split('/').join(path.sep));
    const dstP = path.join(A.backupDir, pick.rel.split('/').join(path.sep));
    try {
        const a = fs.statSync(srcP).size; const b = fs.statSync(dstP).size;
        spotOk = a === b && b > 0;
        spotInfo = `${pick.rel} 源 ${a} / 备 ${b}`;
    } catch (e) { spotInfo = String(e.message); }
}
check('抽查文件字节一致（非空复制）', spotOk, spotInfo);

// ═══════ B. 隔离副本恢复演练（绝不动真库） ═══════
const drillRoot = tmp('jsk-fb-drill-');
const libB = path.join(drillRoot, 'lib');
fs.mkdirSync(libB, { recursive: true });
// 从真库复制 10 个卡 + 造隐藏目录 / tmp / 子目录
let copied = 0;
for (const f of fs.readdirSync(REAL_LIB)) {
    const src = path.join(REAL_LIB, f);
    let st; try { st = fs.statSync(src); } catch (e) { continue; }
    if (!st.isFile()) continue;
    fs.copyFileSync(src, path.join(libB, f));
    if (++copied >= 10) break;
}
fs.mkdirSync(path.join(libB, 'sub'), { recursive: true });
fs.writeFileSync(path.join(libB, 'sub', 'note.json'), '{"a":1}');
fs.mkdirSync(path.join(libB, '.bak_history'), { recursive: true });
fs.writeFileSync(path.join(libB, '.bak_history', 'old.png'), 'HIDDEN');
fs.writeFileSync(path.join(libB, 'junk.tmp'), 'TMP');
const destB = path.join(drillRoot, 'dest');
const svcB = createFullBackupService({ appVersion: 'probe', shell: null });
const B = await svcB.createBackup({ libraryPath: libB, destRoot: destB, keep: 3 });
check('副本库冷备成功且排除生效', !!(B && B.ok) && B.fileCount === copied + 1 && !fs.existsSync(path.join(B.backupDir, '.bak_history')) && !fs.existsSync(path.join(B.backupDir, 'junk.tmp')),
    `fileCount=${B && B.fileCount}（期望 ${copied + 1}）`);
// 制造"误操作"：改掉一个卡 + 删掉一个文件
const victim = fs.readdirSync(libB).find((f) => /\.(png|json)$/i.test(f));
fs.writeFileSync(path.join(libB, victim), 'CORRUPTED');
const before = fs.statSync(path.join(libB, victim)).size;
// 恢复
const R = await svcB.restoreBackup({ backupDir: B.backupDir, libraryPath: libB });
check('恢复成功且给出安全副本路径', !!(R && R.ok && R.safeCopyPath), JSON.stringify(R && { ok: R.ok, restored: R.restored, safeCopyPath: R.safeCopyPath, error: R.error }));
check('内容已回滚（与冷备时的字节一致）', fs.statSync(path.join(libB, victim)).size !== before && fs.readFileSync(path.join(libB, victim), 'utf8') !== 'CORRUPTED', `改后 ${before} → 恢复后 ${fs.statSync(path.join(libB, victim)).size}`);
check('旧库体保留在安全副本（含被改坏的那份）', fs.readFileSync(path.join(R.safeCopyPath, victim), 'utf8') === 'CORRUPTED', R.safeCopyPath);
check('恢复不删备份（可重试）', fs.existsSync(path.join(B.backupDir, MANIFEST_NAME)));
check('恢复后原文可读（抽查 note.json）', fs.readFileSync(path.join(libB, 'sub', 'note.json'), 'utf8') === '{"a":1}');

// ═══════ C. 轮转（旧份进回收站，不硬删） ═══════
const trashed = [];
const svcC = createFullBackupService({ appVersion: 'probe', shell: { trashItem: async (p) => { trashed.push(path.basename(p)); rm(p); } } });
const destC = path.join(drillRoot, 'destC');
const c1 = await svcC.createBackup({ libraryPath: libB, destRoot: destC, keep: 1 });
await new Promise((r) => setTimeout(r, 1100));  // 让目录名的时间戳（分钟级）不同 ⇒ 手动改 manifest 时间更稳
const c2dir = path.join(destC, BACKUP_ROOT_NAME, 'lib__20260101-0000');
fs.mkdirSync(c2dir, { recursive: true });
fs.writeFileSync(path.join(c2dir, MANIFEST_NAME), JSON.stringify({ schema: 1, appVersion: 'x', libraryPath: libB, createdAt: '2026-01-01T00:00:00.000Z', fileCount: 1, bytes: 1, files: [{ rel: 'x', size: 1, mtimeMs: 1 }] }));
const c3 = await svcC.createBackup({ libraryPath: libB, destRoot: destC, keep: 1 });
check('轮转：keep=1 时最旧一份进回收站', !!(c3 && c3.ok) && c3.trashed.length >= 1 && trashed.length >= 1, `trashed=${JSON.stringify(trashed)}`);
const listC = await svcC.listBackups({ destRoot: destC });
check('轮转后仅保留 1 份', listC.items.length === 1, `items=${listC.items.length}`);

// ═══════ D. 防呆 ═══════
const svcD = createFullBackupService({ appVersion: 'probe', shell: null });
const nested = await svcD.createBackup({ libraryPath: REAL_LIB, destRoot: path.join(REAL_LIB, 'bk') });
check('防呆①：冷备目录在库内被拒', nested.ok === false && /库目录内部/.test(nested.error), nested.error);
const missing = await svcD.createBackup({ libraryPath: path.join(drillRoot, 'nope'), destRoot: path.join(drillRoot, 'd4') });
check('防呆②：库不存在被拒', missing.ok === false && /库目录不可读/.test(missing.error), missing.error);

// 清理临时产物（真库侧只读，不动）
rm(destA); rm(drillRoot);
console.log('\n（临时冷备产物已清理；真库未被写入）');

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 整库冷备验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
