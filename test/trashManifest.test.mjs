/**
 * 🗑️ 回收站清单（trash manifest）单测 —— P5「一键撤销」的底层保证
 * 规格：docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md §四 P5
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    readManifest, appendTrashEntries, restoreFromTrash, pruneEntries, MAX_ENTRIES, KEEP_DAYS,
} = require('../main/trashManifest.js');

const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-trash-'));
    const trash = path.join(root, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    return { root, trash, manifest: path.join(root, 'trash_manifest.json') };
};

test('清单：追加 → 读回；坏文件当空、不抛错', () => {
    const { manifest, trash } = mk();
    const trashed = path.join(trash, '1_a.png');
    fs.writeFileSync(trashed, 'x');
    appendTrashEntries(manifest, [{ original: 'E:\\lib\\a.png', trashed }]);
    const entries = readManifest(manifest);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].original, 'E:\\lib\\a.png');
    assert.ok(entries[0].at > 0);

    fs.writeFileSync(manifest, 'not json');
    assert.deepEqual(readManifest(manifest), []);
});

test('还原：成功搬回原位', () => {
    const { root, trash, manifest } = mk();
    const original = path.join(root, 'lib', 'a.png');
    const trashed = path.join(trash, '2_a.png');
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(trashed, 'content');
    appendTrashEntries(manifest, [{ original, trashed }]);

    const res = restoreFromTrash({ manifestPath: manifest, paths: [original] });
    assert.equal(res.restored.length, 1);
    assert.equal(res.restored[0].renamed, false);
    assert.equal(fs.readFileSync(original, 'utf-8'), 'content');
    assert.equal(fs.existsSync(trashed), false);
    assert.equal(readManifest(manifest).length, 0, '还原成功应从清单移除');
});

test('还原：原位已有同名文件 ⇒ 加 _restored_<ts> 后缀，绝不覆盖', () => {
    const { root, trash, manifest } = mk();
    const original = path.join(root, 'a.png');
    const trashed = path.join(trash, '3_a.png');
    fs.writeFileSync(original, 'NEW');
    fs.writeFileSync(trashed, 'OLD');
    appendTrashEntries(manifest, [{ original, trashed }]);

    const res = restoreFromTrash({ manifestPath: manifest, paths: [original], now: 1794738000000 });
    assert.equal(res.restored.length, 1);
    assert.equal(res.restored[0].renamed, true);
    assert.equal(fs.readFileSync(original, 'utf-8'), 'NEW', '原位文件不能被覆盖');
    assert.match(path.basename(res.restored[0].finalPath), /_restored_1794738000000\.png$/);
    assert.equal(fs.readFileSync(res.restored[0].finalPath, 'utf-8'), 'OLD');
});

test('还原：回收站文件已不存在 ⇒ 记失败并丢弃该条', () => {
    const { root, trash, manifest } = mk();
    const original = path.join(root, 'gone.png');
    const trashed = path.join(trash, '4_gone.png'); // 故意不创建
    appendTrashEntries(manifest, [{ original, trashed }]);
    const res = restoreFromTrash({ manifestPath: manifest, paths: [original] });
    assert.equal(res.restored.length, 0);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /找不到/);
    assert.equal(readManifest(manifest).length, 0);
});

test('还原：只还原传入的路径，其余条目保留', () => {
    const { root, trash, manifest } = mk();
    const a = path.join(root, 'a.png'); const ta = path.join(trash, '5_a.png');
    const b = path.join(root, 'b.png'); const tb = path.join(trash, '6_b.png');
    fs.writeFileSync(ta, 'A'); fs.writeFileSync(tb, 'B');
    appendTrashEntries(manifest, [{ original: a, trashed: ta }, { original: b, trashed: tb }]);
    const res = restoreFromTrash({ manifestPath: manifest, paths: [a] });
    assert.equal(res.restored.length, 1);
    assert.equal(res.remaining, 1);
    assert.equal(fs.existsSync(b), false, '未点名的条目不能被还原');
});

test('路径比较忽略大小写与分隔符（Windows 口径）', () => {
    const { root, trash, manifest } = mk();
    const original = path.join(root, 'X', 'A.png');
    const trashed = path.join(trash, '7_A.png');
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(trashed, 'x');
    appendTrashEntries(manifest, [{ original, trashed }]);
    const res = restoreFromTrash({ manifestPath: manifest, paths: [original.toLowerCase().replace(/\\/g, '/')] });
    assert.equal(res.restored.length, 1);
});

test('自净：超过保留天数 / 条数上限的条目被淘汰', () => {
    assert.equal(KEEP_DAYS, 30);
    const now = Date.now();
    const old = now - (KEEP_DAYS + 1) * 24 * 60 * 60 * 1000;
    const entries = [
        { original: 'a', trashed: 'ta', at: old },
        { original: 'b', trashed: 'tb', at: now },
    ];
    assert.deepEqual(pruneEntries(entries, now).map((e) => e.original), ['b']);

    const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => ({ original: `p${i}`, trashed: `t${i}`, at: now }));
    const pruned = pruneEntries(many, now);
    assert.equal(pruned.length, MAX_ENTRIES);
    assert.equal(pruned[pruned.length - 1].original, `p${MAX_ENTRIES + 9}`, '保留最新的');
});
