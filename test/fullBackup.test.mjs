/**
 * 📦 整库冷备 单测（`main/fullBackup.js` 的纯函数 + 服务端到端）
 * 覆盖规格 §四.5（manifest 生成与解析、排除规则、轮转选择）与 §三.3 三项防呆。
 * ⚠️ 服务级测试全部在 **临时目录** 上跑（不碰真实库）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    normalizeKeep, shouldExclude, stampOf, backupFolderName, assertDestRoot,
    buildManifest, parseManifest, pickRotationVictims, formatBytes, classifyIoError,
    walkLibrary, createFullBackupService, BACKUP_ROOT_NAME, MANIFEST_NAME, SCHEMA_VERSION
} from '../main/fullBackup.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-fb-'));

/** 造一个迷你「库」 */
function mkLibrary(dir, files = {}) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    return dir;
}

// ───────── 纯函数 ─────────
test('normalizeKeep：1~10 夹取，脏值退回默认 3', () => {
    assert.equal(normalizeKeep(0), 1);
    assert.equal(normalizeKeep(99), 10);
    assert.equal(normalizeKeep(4), 4);
    assert.equal(normalizeKeep('x'), 3);
    assert.equal(normalizeKeep(undefined), 3);
});

test('shouldExclude：隐藏项 / *.tmp / 回收站与冷备根被排除，正常文件保留', () => {
    assert.equal(shouldExclude('.bak_history', true), true);
    assert.equal(shouldExclude('.trash', true), true);
    assert.equal(shouldExclude('a.png.tmp', false), true);
    assert.equal(shouldExclude('jsTavern_Trash', true), true);
    assert.equal(shouldExclude(BACKUP_ROOT_NAME, true), true);
    assert.equal(shouldExclude('小樱.png', false), false);
    assert.equal(shouldExclude('子目录', true), false);
    assert.equal(shouldExclude('', false), true);
});

test('stampOf / backupFolderName：时间戳与目录名格式', () => {
    assert.match(stampOf(new Date(2026, 9, 3, 15, 30)), /^20261003-1530$/);
    assert.equal(stampOf('bad'), '00000000-0000');
    assert.equal(backupFolderName('E:\\AI\\酒馆工具\\角色卡', new Date(2026, 9, 3, 15, 30)), '角色卡__20261003-1530');
    assert.equal(backupFolderName('E:/x/y/', new Date(2026, 9, 3, 15, 30)), 'y__20261003-1530');
});

test('assertDestRoot：库自身 / 库内子目录 / 包含库的父目录 均被拒', () => {
    const lib = path.join('E:', 'AI', 'lib');
    assert.equal(assertDestRoot(path.join('E:', 'backup'), lib).ok, true);
    assert.equal(assertDestRoot(lib, lib).ok, false);
    assert.equal(assertDestRoot(path.join(lib, 'sub'), lib).ok, false);
    assert.equal(assertDestRoot(path.join('E:', 'AI'), lib).ok, false, '父目录包含库 ⇒ 拒绝');
    assert.equal(assertDestRoot('', lib).ok, false);
    assert.equal(assertDestRoot('E:\\b', '').ok, false);
});

test('buildManifest / parseManifest：生成 → 解析往返一致，损坏数据被拒', () => {
    const m = buildManifest({
        appVersion: '2.3.6', libraryPath: 'E:\\lib', createdAt: '2026-10-03T00:00:00.000Z',
        files: [{ rel: 'a\\b.png', size: 10, mtimeMs: 1 }, { rel: 'c.json', size: 5, mtimeMs: 2 }]
    });
    assert.equal(m.schema, SCHEMA_VERSION);
    assert.equal(m.fileCount, 2);
    assert.equal(m.bytes, 15);
    assert.equal(m.files[0].rel, 'a/b.png', 'rel 统一为正斜杠');
    const back = parseManifest(JSON.stringify(m));
    assert.equal(back.ok, true);
    assert.deepEqual(back.manifest.files, m.files);
    assert.equal(parseManifest('not json').ok, false);
    assert.equal(parseManifest('{"schema":99,"files":[]}').ok, false);
    assert.equal(parseManifest('{"schema":1}').ok, false);
});

test('★ pickRotationVictims：只淘汰最旧的超出部分', () => {
    const items = [
        { name: 'c', createdAt: '2026-10-03T03:00:00Z' },
        { name: 'a', createdAt: '2026-10-03T01:00:00Z' },
        { name: 'b', createdAt: '2026-10-03T02:00:00Z' }
    ];
    assert.deepEqual(pickRotationVictims(items, 3), []);
    assert.deepEqual(pickRotationVictims(items, 2).map((x) => x.name), ['a']);
    assert.deepEqual(pickRotationVictims(items, 1).map((x) => x.name), ['a', 'b']);
    assert.deepEqual(pickRotationVictims(items, 0).map((x) => x.name), ['a', 'b'], 'keep 夹到 ≥1 ⇒ 只保留最新一份');
});

test('formatBytes / classifyIoError：可读体积与长路径专项提示', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.match(formatBytes(5 * 1024 * 1024), /5\.0 MB/);
    assert.match(classifyIoError({ code: 'ENAMETOOLONG' }), /路径过长/);
    assert.match(classifyIoError({ code: 'ENOSPC' }), /空间不足/);
    assert.match(classifyIoError({ code: 'EACCES' }), /权限/);
    assert.equal(classifyIoError(new Error('boom')), 'boom');
});

test('walkLibrary：递归列举并遵守排除规则（隐藏目录/tmp 不进清单）', async () => {
    const lib = mkLibrary(path.join(tmpRoot(), 'lib'), {
        'a.png': 'x', 'sub/b.json': 'yy', '.bak_history/old.png': 'zzz', 'c.tmp': 'tt', 'sub/deep/d.txt': 'dddd'
    });
    const seen = [];
    await walkLibrary(lib, (rel) => seen.push(rel.split(path.sep).join('/')));
    seen.sort();
    assert.deepEqual(seen, ['a.png', 'sub/b.json', 'sub/deep/d.txt']);
});

// ───────── 服务端到端（临时目录） ─────────
test('★ createBackup：复制 + manifest + 列表可读 + 排除生效', async () => {
    const root = tmpRoot();
    const lib = mkLibrary(path.join(root, 'lib'), { 'a.png': 'AAA', 'sub/b.json': 'BB', '.bak_history/x.png': 'X', 'c.tmp': 'T' });
    const dest = path.join(root, 'dest');
    const svc = createFullBackupService({ appVersion: 'test', shell: null });
    const r = await svc.createBackup({ libraryPath: lib, destRoot: dest, keep: 3 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.fileCount, 2, '排除后只剩 2 个文件');
    assert.equal(r.bytes, 5);
    assert.equal(fs.readFileSync(path.join(r.backupDir, 'sub', 'b.json'), 'utf8'), 'BB');
    assert.equal(fs.existsSync(path.join(r.backupDir, '.bak_history')), false);
    assert.equal(fs.existsSync(path.join(r.backupDir, 'c.tmp')), false);
    const man = JSON.parse(fs.readFileSync(path.join(r.backupDir, MANIFEST_NAME), 'utf8'));
    assert.equal(man.fileCount, 2);
    assert.equal(man.libraryPath, lib);
    const listed = await svc.listBackups({ destRoot: dest });
    assert.equal(listed.ok, true);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].fileCount, 2);
    assert.equal(listed.items[0].dir, r.backupDir);
});

test('★ 中断的半成品不会被 list 认可（无 manifest）', async () => {
    const root = tmpRoot();
    const dest = path.join(root, 'dest');
    const half = path.join(dest, BACKUP_ROOT_NAME, 'lib__20261003-0100');
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, 'a.png'), 'x');   // 没有 manifest
    const svc = createFullBackupService({ appVersion: 't', shell: null });
    const listed = await svc.listBackups({ destRoot: dest });
    assert.equal(listed.items.length, 0);
});

test('★ 轮转：keep=2 时第 3 份出现，最旧一份被移走', async () => {
    const root = tmpRoot();
    const lib = mkLibrary(path.join(root, 'lib'), { 'a.png': 'A' });
    const dest = path.join(root, 'dest');
    const trashed = [];
    const svc = createFullBackupService({
        appVersion: 't',
        shell: { trashItem: async (p) => { trashed.push(path.basename(p)); fs.rmSync(p, { recursive: true, force: true }); } }
    });
    // 手造两份「旧备份」（manifest 齐全），再跑一次 create ⇒ 应把最旧那份轮转掉
    for (const [name, when] of [['lib__20260101-0100', '2026-01-01T01:00:00.000Z'], ['lib__20260102-0100', '2026-01-02T01:00:00.000Z']]) {
        const d = path.join(dest, BACKUP_ROOT_NAME, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, MANIFEST_NAME), JSON.stringify(buildManifest({ libraryPath: lib, createdAt: when, files: [{ rel: 'a.png', size: 1, mtimeMs: 1 }] })));
    }
    const r = await svc.createBackup({ libraryPath: lib, destRoot: dest, keep: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.trashed, ['lib__20260101-0100'], '最旧一份进回收站');
    const listed = await svc.listBackups({ destRoot: dest });
    assert.equal(listed.items.length, 2, '保留 2 份');
    assert.equal(listed.items.some((x) => x.name === 'lib__20260101-0100'), false);
});

test('★ 恢复：改名 + 复制（旧库留在安全副本、备份不被删）', async () => {
    const root = tmpRoot();
    const lib = mkLibrary(path.join(root, 'lib'), { 'a.png': 'OLD', 'keep.json': 'K' });
    const dest = path.join(root, 'dest');
    const svc = createFullBackupService({ appVersion: 't', shell: null });
    const b = await svc.createBackup({ libraryPath: lib, destRoot: dest, keep: 3 });
    // 备份后改动库（模拟误操作）
    fs.writeFileSync(path.join(lib, 'a.png'), 'CHANGED');
    const r = await svc.restoreBackup({ backupDir: b.backupDir, libraryPath: lib });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(lib, 'a.png'), 'utf8'), 'OLD', '内容已回滚');
    assert.ok(r.safeCopyPath && fs.existsSync(r.safeCopyPath), '旧库保留在安全副本');
    assert.equal(fs.readFileSync(path.join(r.safeCopyPath, 'a.png'), 'utf8'), 'CHANGED', '安全副本是改后的内容');
    assert.ok(fs.existsSync(path.join(b.backupDir, MANIFEST_NAME)), '备份未被删除（可重试）');
});

test('★ 防呆：嵌套目录 / 空库路径 / 并发 / 取消', async () => {
    const root = tmpRoot();
    const lib = mkLibrary(path.join(root, 'lib'), { 'a.png': 'A' });
    const svc = createFullBackupService({ appVersion: 't', shell: null });
    // ① 目标在库内
    const nested = await svc.createBackup({ libraryPath: lib, destRoot: path.join(lib, 'bk') });
    assert.equal(nested.ok, false);
    assert.match(nested.error, /库目录内部/);
    // ② 库路径不存在
    const missing = await svc.createBackup({ libraryPath: path.join(root, 'nope'), destRoot: path.join(root, 'd2') });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /库目录不可读/);
    // ③ 同一时刻只允许一个任务（并发触发第二个必须被拒）
    const dest3 = path.join(root, 'd3');
    const p1 = svc.createBackup({ libraryPath: lib, destRoot: dest3, keep: 3 });
    const p2 = svc.createBackup({ libraryPath: lib, destRoot: dest3, keep: 3 });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, false);
    assert.match(r2.error, /进行中/);
    // ④ 取消：无进行中任务时明确回报
    const noTask = svc.cancel();
    assert.equal(noTask.ok, false);
});

test('★ 删除：拒绝删除冷备根之外的路径', async () => {
    const root = tmpRoot();
    const svc = createFullBackupService({ appVersion: 't', shell: null });
    const bad = await svc.deleteBackup({ backupDir: path.join(root, 'not-a-backup') });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /拒绝删除/);
    // 正常路径：走 shell.trashItem
    const lib = mkLibrary(path.join(root, 'lib'), { 'a.png': 'A' });
    const dest = path.join(root, 'dest');
    const trashed = [];
    const svc2 = createFullBackupService({ appVersion: 't', shell: { trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); } } });
    const b = await svc2.createBackup({ libraryPath: lib, destRoot: dest, keep: 3 });
    const del = await svc2.deleteBackup({ backupDir: b.backupDir });
    assert.equal(del.ok, true);
    assert.equal(trashed.length, 1);
    assert.equal(fs.existsSync(b.backupDir), false);
});

test('恢复：备份 fileCount=0 拒绝恢复（防呆）', async () => {
    const root = tmpRoot();
    const lib = mkLibrary(path.join(root, 'lib'), { 'a.png': 'A' });
    const empty = path.join(root, 'dest', BACKUP_ROOT_NAME, 'lib__20260101-0000');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, MANIFEST_NAME), JSON.stringify(buildManifest({ libraryPath: lib, files: [] })));
    const svc = createFullBackupService({ appVersion: 't', shell: null });
    const r = await svc.restoreBackup({ backupDir: empty, libraryPath: lib });
    assert.equal(r.ok, false);
    assert.match(r.error, /备份为空/);
    assert.equal(fs.readFileSync(path.join(lib, 'a.png'), 'utf8'), 'A', '库未被改动');
});
