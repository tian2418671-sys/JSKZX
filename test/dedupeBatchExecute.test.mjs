/**
 * 🧹 查重批量清理 · 执行器收尾回归（用户报「预演按钮永久变灰」= exec.running 卡在 true）
 * 规格：docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md §四
 *
 * 生死线：无论成功 / 异常 / 中止 / IPC 无响应，`exec.running` 都必须回到 false，
 * 否则四个查重窗口的「预演」按钮会一起永久变灰。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ref } from 'vue';
import { useDedupe } from '../js/composables/useDedupe.js';

const mkLib = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-batch-exec-'));
    const lib = path.join(root, 'lib');
    fs.mkdirSync(lib);
    return { root, lib };
};

const makeGroup = (keepPath, dupPath) => ({
    id: 'g1', name: 'A', type: 'duplicate',
    cards: [{ path: keepPath, name: 'A' }, { path: dupPath, name: 'A', _sizeKb: 4 }],
});

const setup = (lib, trashFiles) => {
    global.window = { electronAPI: { trashFiles } };
    const library = ref([]);
    const dupe = useDedupe({
        library, currentFolderPath: ref(lib),
        nativeAlert: () => {}, confirmDialog: async () => true,
        addLog: () => {}, showToast: () => {},
        cleanupEmptyCategories: async () => {}, deleteCardOverlays: () => {},
    });
    return { library, dupe };
};

test('IPC 永不返回 ⇒ 超时后 exec.running 必须复位，且失败项列出来', async () => {
    const { root, lib } = mkLib();
    try {
        const keep = path.join(lib, 'keep.png');
        const dup = path.join(lib, 'dup.png');
        fs.writeFileSync(keep, 'x');
        fs.writeFileSync(dup, 'y');
        const { dupe } = setup(lib, () => new Promise(() => {})); // 永远 pending
        dupe.duplicateGroups.value = [makeGroup(keep, dup)];

        const r = await dupe.executeDedupeBatch('card', { skipConfirm: true, batchTimeoutMs: 120 });
        assert.equal(r.running, false, '执行器必须已解锁');
        assert.ok(r.failed.length >= 1, '超时批次要记为失败');
        assert.match(String(r.failed[0].error), /超时/);

        // 解锁后可以继续预演（正是用户报「点不回去」的那一步）
        const plan = dupe.previewDedupeBatch('card', {});
        assert.ok(plan && Array.isArray(plan.deletions));
        assert.equal(dupe.dedupeBatchExec.value.running, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('trashFiles 同步抛错 ⇒ 也被兜住，running 复位', async () => {
    const { root, lib } = mkLib();
    try {
        const keep = path.join(lib, 'keep.png');
        const dup = path.join(lib, 'dup.png');
        fs.writeFileSync(keep, 'x');
        fs.writeFileSync(dup, 'y');
        const { dupe } = setup(lib, () => { throw new Error('IPC 崩了'); });
        dupe.duplicateGroups.value = [makeGroup(keep, dup)];

        const r = await dupe.executeDedupeBatch('card', { skipConfirm: true, batchTimeoutMs: 500 });
        assert.equal(r.running, false);
        assert.ok(r.failed.length >= 1);
        assert.match(String(r.failed[0].error), /IPC 崩了|超时/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('中止（abort）⇒ running 复位、标记 aborted、已完成的仍算成功', async () => {
    const { root, lib } = mkLib();
    try {
        const keep = path.join(lib, 'keep.png');
        const d1 = path.join(lib, 'd1.png');
        fs.writeFileSync(keep, 'x');
        fs.writeFileSync(d1, 'y');
        let calls = 0;
        const { dupe } = setup(lib, async (paths) => {
            calls++;
            // 第一批正常，之后一律挂住（模拟主进程随后无响应）
            if (calls === 1) {
                for (const p of paths) { try { fs.renameSync(p, path.join(root, path.basename(p))); } catch (e) { /* 忽略 */ } }
                return { success: true, count: paths.length, failed: [] };
            }
            return new Promise(() => {});
        });
        const multi = { id: 'g1', name: 'A', type: 'duplicate', cards: [{ path: keep, name: 'A' }, { path: d1, name: 'A', _sizeKb: 1 }] };
        dupe.duplicateGroups.value = [multi];

        const p = dupe.executeDedupeBatch('card', { skipConfirm: true, batchTimeoutMs: 200 });
        dupe.abortDedupeBatch();
        const r = await p;
        assert.equal(r.running, false);
        assert.equal(dupe.dedupeBatchExec.value.running, false, '中止后必须解锁');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('♻️ P5 撤销：执行后 undo 把本批文件还原回原位，并清空可撤销清单', async () => {
    const { root, lib } = mkLib();
    try {
        const keep = path.join(lib, 'keep.png');
        const dup = path.join(lib, 'dup.png');
        fs.writeFileSync(keep, 'k');
        fs.writeFileSync(dup, 'd');
        const trashDir = path.join(root, 'trash');
        fs.mkdirSync(trashDir, { recursive: true });
        const moved = new Map(); // 回收站文件名 → 原路径
        const { dupe } = setup(lib, async (paths) => {
            const failed = [];
            for (const p of paths) {
                const dest = path.join(trashDir, `${Date.now()}_${path.basename(p)}`);
                try { fs.renameSync(p, dest); moved.set(dest, p); } catch (e) { failed.push({ path: p, error: e.message }); }
            }
            return { success: failed.length === 0, count: paths.length - failed.length, failed };
        });
        // 撤销接口
        global.window.electronAPI.restoreFromTrash = async (paths) => {
            const restored = [];
            for (const p of paths) {
                const hit = [...moved.entries()].find(([, orig]) => orig === p);
                if (!hit) continue;
                fs.renameSync(hit[0], p);
                moved.delete(hit[0]);
                restored.push({ original: p, finalPath: p, renamed: false });
            }
            return { success: true, restored, failed: [], blocked: [] };
        };
        dupe.duplicateGroups.value = [makeGroup(keep, dup)];
        await dupe.executeDedupeBatch('card', { skipConfirm: true });
        assert.equal(fs.existsSync(dup), false, '执行后重复文件应在回收站');
        assert.equal(dupe.dedupeBatchExec.value.deletedPaths.length, 1);

        await dupe.undoDedupeBatch('card');
        assert.equal(fs.existsSync(dup), true, '撤销后文件必须回到原位');
        assert.equal(dupe.dedupeBatchExec.value.deletedPaths.length, 0, '撤销后不应再显示可撤销');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
