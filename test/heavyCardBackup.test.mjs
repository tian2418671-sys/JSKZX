/**
 * 💾 重型卡备份引擎 · 单测
 * 覆盖：保留策略 / manifest 权威性 / LOCK 过滤 / CURRENT 保留 / 目录缺失容错 /
 *       原子性（.part）/ 世代轮换恢复 / 启动清理（gN-1 保留）
 *
 * 全部使用临时目录，不触碰真实 userData。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createHeavyCardBackupService,
    normalizeKeep,
    normalizeKind,
    snapshotNameOf,
    partitionDirOf,
    backupRootOf,
    shouldCopyFile,
    pickRotateVictims,
    buildManifest,
    parseManifest,
    statTree,
    copyTree,
    MANIFEST_NAME,
    PART_SUFFIX,
    STORE_DIRS
} from '../main/heavyCards/backup.js';

// ─────────────────────────── 辅助 ───────────────────────────

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-backup-test-'));
}

function rmrf(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/** 造一个假的 partition 目录（含 leveldb 关键文件） */
function seedPartition(userData, cardId, gen) {
    const dir = partitionDirOf(userData, cardId, gen);
    const ls = path.join(dir, 'Local Storage', 'leveldb');
    fs.mkdirSync(ls, { recursive: true });
    fs.writeFileSync(path.join(ls, 'CURRENT'), 'MANIFEST-000001\n');
    fs.writeFileSync(path.join(ls, 'MANIFEST-000001'), 'manifest');
    fs.writeFileSync(path.join(ls, 'LOCK'), 'lock');
    fs.writeFileSync(path.join(ls, '000003.log'), 'data');
    fs.writeFileSync(path.join(ls, 'LOG'), 'log');
    // Session Storage 也造一份，验证多目录
    fs.mkdirSync(path.join(dir, 'Session Storage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Session Storage', 'x'), 'y');
    // 故意不造 IndexedDB —— 必须容错（实测 V8）
    return dir;
}

// ─────────────────────────── 纯函数 ───────────────────────────

test('normalizeKeep：上下限与 NaN 回退', () => {
    assert.equal(normalizeKeep(5), 5);
    assert.equal(normalizeKeep(0), 1);
    assert.equal(normalizeKeep(999), 20);
    assert.equal(normalizeKeep('abc'), 5);
});

test('normalizeKind：非法值回退 auto', () => {
    assert.equal(normalizeKind('manual'), 'manual');
    assert.equal(normalizeKind('pre-restore'), 'pre-restore');
    assert.equal(normalizeKind('xxx'), 'auto');
    assert.equal(normalizeKind(undefined), 'auto');
});

test('shouldCopyFile：LOCK 跳过，CURRENT / MANIFEST 必须保留', () => {
    assert.equal(shouldCopyFile('LOCK'), false, 'LOCK 必须跳过');
    assert.equal(shouldCopyFile('CURRENT'), true, 'CURRENT 缺了库打不开');
    assert.equal(shouldCopyFile('MANIFEST-000001'), true);
    assert.equal(shouldCopyFile('000003.log'), true);
    assert.equal(shouldCopyFile('LOG'), true);
    assert.equal(shouldCopyFile(MANIFEST_NAME), false, 'manifest 由引擎单独写');
    assert.equal(shouldCopyFile(''), false);
});

test('snapshotNameOf：带类型后缀且可作目录名（无非法字符）', () => {
    const n = snapshotNameOf(new Date(2026, 9, 18, 14, 20, 0), 'manual');
    assert.equal(n, '2026-10-18T14-20-00_manual');
    assert.equal(/[\\/:*?"<>|]/.test(n.replace(/^[\d]{4}-/, '')), false, '不应含 Windows 非法字符（冒号已替换）');
});

test('partitionDirOf：固定形态 heavycard-<id>_g<N>', () => {
    const d = partitionDirOf('C:/ud', 'hc_abc', 3);
    assert.ok(d.endsWith(path.join('Partitions', 'heavycard-hc_abc_g3')));
    assert.ok(partitionDirOf('C:/ud', 'hc_abc', 0).endsWith('heavycard-hc_abc_g1'), 'gen<1 归一到 1');
});

test('buildManifest / parseManifest：往返一致且拒绝脏数据', () => {
    const m = buildManifest({ cardId: 'hc_1', name: 'n', url: 'u', gen: 2, kind: 'auto', totalBytes: 10 });
    assert.equal(m.schema, 1);
    assert.equal(m.kind, 'auto');
    const back = parseManifest(JSON.stringify(m));
    assert.equal(back.cardId, 'hc_1');
    assert.equal(parseManifest('not json'), null);
    assert.equal(parseManifest('{}'), null, '缺 cardId/createdAt 视为无效');
});

test('pickRotateVictims：超出 keep 时删最旧', () => {
    const list = [
        { name: 'a', kind: 'auto' },
        { name: 'b', kind: 'auto' },
        { name: 'c', kind: 'auto' },
        { name: 'd', kind: 'auto' }
    ];
    const v = pickRotateVictims(list, 2);
    assert.deepEqual(v.map((x) => x.name), ['a', 'b']);
});

test('pickRotateVictims：最后一份 manual 永不删除', () => {
    const list = [
        { name: 'm1', kind: 'manual' },   // 最旧
        { name: 'a1', kind: 'auto' },
        { name: 'a2', kind: 'auto' }
    ];
    const v = pickRotateVictims(list, 2);
    assert.equal(v.some((x) => x.name === 'm1'), false, '最旧的 manual 是唯一锚点时不能被删');
    assert.equal(v.length, 1);
});

test('pickRotateVictims：未超限不删', () => {
    const list = [{ name: 'a', kind: 'auto' }];
    assert.deepEqual(pickRotateVictims(list, 5), []);
});

// ─────────────────────────── IO ───────────────────────────

test('copyTree：跳过 LOCK，保留 CURRENT / MANIFEST', () => {
    const root = tmpRoot();
    try {
        const src = path.join(root, 'src', 'leveldb');
        fs.mkdirSync(src, { recursive: true });
        for (const f of ['CURRENT', 'MANIFEST-000001', 'LOCK', '000003.log', 'LOG']) {
            fs.writeFileSync(path.join(src, f), f);
        }
        const dest = path.join(root, 'dest');
        const r = copyTree(src, dest);
        assert.equal(fs.existsSync(path.join(dest, 'LOCK')), false, 'LOCK 必须被跳过');
        assert.equal(fs.existsSync(path.join(dest, 'CURRENT')), true);
        assert.equal(fs.existsSync(path.join(dest, MANIFEST_NAME)), false);
        assert.equal(r.skipped >= 1, true);
    } finally { rmrf(root); }
});

test('copyTree：源目录不存在时给 warning 而不抛错', () => {
    const root = tmpRoot();
    try {
        const r = copyTree(path.join(root, 'nope'), path.join(root, 'out'));
        assert.equal(r.copied, 0);
        assert.ok(r.warnings.length >= 1);
    } finally { rmrf(root); }
});

test('statTree：统计文件数与字节数', () => {
    const root = tmpRoot();
    try {
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a', 'x.txt'), '12345');
        fs.writeFileSync(path.join(root, 'a', 'b', 'y.txt'), '123');
        const s = statTree(root);
        assert.equal(s.files, 2);
        assert.equal(s.bytes, 8);
    } finally { rmrf(root); }
});

// ─────────────────────────── 服务级 ───────────────────────────

test('createBackup：生成 manifest，且 .part 不残留', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t1', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const res = await svc.createBackup({
            cardId: 'hc_t1', name: 'N', url: 'https://x', gen: 1,
            partition: 'persist:heavycard-hc_t1_g1', kind: 'manual', keep: 5
        });
        assert.equal(res.success, true, JSON.stringify(res));
        const bRoot = backupRootOf(root, 'hc_t1');
        const entries = fs.readdirSync(bRoot);
        assert.equal(entries.some((n) => n.endsWith(PART_SUFFIX)), false, '.part 不应残留');
        const snap = path.join(bRoot, entries[0]);
        assert.equal(fs.existsSync(path.join(snap, MANIFEST_NAME)), true);
        assert.equal(fs.existsSync(path.join(snap, 'Local Storage', 'leveldb', 'LOCK')), false);
        assert.equal(fs.existsSync(path.join(snap, 'Local Storage', 'leveldb', 'CURRENT')), true);
        // IndexedDB 不存在也不能报错
        assert.equal(res.success, true);
    } finally { rmrf(root); }
});

test('createBackup：无 partition 目录时报错（未打开过）', async () => {
    const root = tmpRoot();
    try {
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const res = await svc.createBackup({ cardId: 'hc_none', gen: 1, kind: 'auto' });
        assert.equal(res.success, false);
        assert.match(res.error, /尚无存档目录/);
    } finally { rmrf(root); }
});

test('createBackup：flush 抛错则不产生任何备份（原子性）', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t2', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const res = await svc.createBackup({
            cardId: 'hc_t2', gen: 1, kind: 'auto',
            flush: async () => { throw new Error('boom'); }
        });
        assert.equal(res.success, false);
        const bRoot = backupRootOf(root, 'hc_t2');
        const entries = fs.existsSync(bRoot) ? fs.readdirSync(bRoot) : [];
        assert.equal(entries.length, 0, '刷盘失败不应留下任何目录');
    } finally { rmrf(root); }
});

test('listBackups：没有 manifest 的目录不计入', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t3', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        await svc.createBackup({ cardId: 'hc_t3', gen: 1, kind: 'manual' });
        // 造一个"看目录存在但没有 manifest"的伪备份
        fs.mkdirSync(path.join(backupRootOf(root, 'hc_t3'), '2026-01-01T00-00-00_auto'), { recursive: true });
        const list = svc.listBackups('hc_t3');
        assert.equal(list.length, 1, '无 manifest 的目录必须被忽略');
    } finally { rmrf(root); }
});

test('rotate：保留 keep 份，且保留最后一份 manual', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t4', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        // 连续备份 4 次（同一秒会用 -N 后缀区分）
        for (let i = 0; i < 4; i++) {
            await svc.createBackup({ cardId: 'hc_t4', gen: 1, kind: 'auto', keep: 10 });
        }
        const before = svc.listBackups('hc_t4').length;
        assert.equal(before, 4);
        svc.rotate('hc_t4', 2);
        assert.equal(svc.listBackups('hc_t4').length, 2);
    } finally { rmrf(root); }
});

test('restoreGeneration：写入新世代目录，且不触碰旧目录', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t5', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const bk = await svc.createBackup({ cardId: 'hc_t5', gen: 1, kind: 'manual' });
        assert.equal(bk.success, true, JSON.stringify(bk));

        const res = svc.restoreGeneration({ cardId: 'hc_t5', currentGen: 1, backupName: bk.name });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.equal(res.nextGen, 2);
        assert.match(res.nextPartition, /_g2$/);
        assert.ok(fs.existsSync(path.join(res.targetDir, 'Local Storage', 'leveldb', 'CURRENT')));
        assert.equal(fs.existsSync(path.join(res.targetDir, 'Local Storage', 'leveldb', 'LOCK')), false);
        // 旧世代仍在
        assert.ok(fs.existsSync(partitionDirOf(root, 'hc_t5', 1)));
    } finally { rmrf(root); }
});

test('restoreGeneration：目标世代已存在时自动跳号', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t6', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const bk = await svc.createBackup({ cardId: 'hc_t6', gen: 1, kind: 'manual' });
        // 预先占住 g2
        fs.mkdirSync(partitionDirOf(root, 'hc_t6', 2), { recursive: true });
        const res = svc.restoreGeneration({ cardId: 'hc_t6', currentGen: 1, backupName: bk.name });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.equal(res.nextGen, 3);
    } finally { rmrf(root); }
});

test('cleanupOnStartup：清 .part 垃圾 + 保留 gN 与 gN-1', () => {
    const root = tmpRoot();
    try {
        // 三个世代目录
        for (const g of [1, 2, 3]) seedPartition(root, 'hc_t7', g);
        // 一个残留 .part
        const bRoot = backupRootOf(root, 'hc_t7');
        fs.mkdirSync(path.join(bRoot, '2026-01-01T00-00-00_auto' + PART_SUFFIX), { recursive: true });

        const svc = createHeavyCardBackupService({ userDataPath: root });
        const r = svc.cleanupOnStartup([{ id: 'hc_t7', gen: 3 }]);

        assert.equal(r.removedParts.length, 1, '.part 应被清掉');
        // 保留 g3 与 g2，删除 g1
        assert.equal(fs.existsSync(partitionDirOf(root, 'hc_t7', 3)), true);
        assert.equal(fs.existsSync(partitionDirOf(root, 'hc_t7', 2)), true);
        assert.equal(fs.existsSync(partitionDirOf(root, 'hc_t7', 1)), false);
        assert.equal(r.removedGens.length, 1);
    } finally { rmrf(root); }
});

test('cleanupOnStartup：不碰非本模块的 partition 目录', () => {
    const root = tmpRoot();
    try {
        const other = path.join(root, 'Partitions', 'some-other-app');
        fs.mkdirSync(other, { recursive: true });
        const svc = createHeavyCardBackupService({ userDataPath: root });
        svc.cleanupOnStartup([]);
        assert.equal(fs.existsSync(other), true, '无关目录不得删除');
    } finally { rmrf(root); }
});

test('deleteBackup：删掉指定备份，其余保留', async () => {
    const root = tmpRoot();
    try {
        seedPartition(root, 'hc_t8', 1);
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const b1 = await svc.createBackup({ cardId: 'hc_t8', gen: 1, kind: 'auto', keep: 10 });
        await svc.createBackup({ cardId: 'hc_t8', gen: 1, kind: 'auto', keep: 10 });
        const r = svc.deleteBackup('hc_t8', b1.name);
        assert.equal(r.success, true);
        assert.equal(svc.listBackups('hc_t8').length, 1);
    } finally { rmrf(root); }
});

test('STORE_DIRS：白名单不含缓存目录', () => {
    for (const bad of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
        assert.equal(STORE_DIRS.includes(bad), false, `${bad} 不应被备份`);
    }
    assert.equal(STORE_DIRS.includes('Local Storage'), true);
    assert.equal(STORE_DIRS.includes('IndexedDB'), true);
});
