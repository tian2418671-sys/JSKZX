/**
 * 🔀 世界书合并 单测（`js/utils/wbMerge.js`）
 * 覆盖规格 §三.1：顺序敏感键判重 / 非字符串不崩 / 键冲突统计 / 空书与单书边界 / dropInternalFields 保 extensions._filename。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normKeysOf, normContentOf, entrySignature, contentHead, keySampleOf,
    mergeWorldbookEntries, mergeNameOf, mergeDescriptionOf, defaultUidFactory
} from '../js/utils/wbMerge.js';

const seqUid = (() => { let i = 0; return () => 'uid_' + (++i); })();
const entry = (key, content, extra = {}) => Object.assign({ key, content }, extra);

test('normKeys：数组逐项归一 + 排序 ⇒ **对顺序不敏感**（修复旧的顺序敏感键）', () => {
    assert.equal(normKeysOf({ key: ['A', 'B'] }), normKeysOf({ key: ['B', 'A'] }));
    assert.equal(normKeysOf({ key: [' B ', 'a'] }), 'a\u0001b');
    assert.equal(normKeysOf({ key: ' Solo ' }), 'solo');
    assert.equal(normKeysOf({}), '', '无 key → 空串');
    assert.equal(normKeysOf({ key: [] }), '');
});

test('normContent / signature / contentHead：非字符串一律 String 兜底，不崩', () => {
    assert.equal(normContentOf({ content: 123 }), '123');
    assert.equal(normContentOf({ content: null }), '');
    assert.equal(normContentOf({}), '');
    assert.equal(normContentOf({ content: { a: 1 } }), '[object object]');
    assert.equal(entrySignature({ key: ['B', 'A'], content: ' X ' }), entrySignature({ key: ['a', 'b'], content: 'x' }));
    assert.equal(contentHead({ content: 'a\n\nb   c' }), 'a b c');
    assert.equal(contentHead({ content: 'x'.repeat(100) }).length, 61, '截断 + 省略号');
});

test('★ 顺序敏感键：`["A","B"]` 与 `["B","A"]` 判为重复（只保留 1 条）', () => {
    const r = mergeWorldbookEntries([
        { name: '书1', entries: [entry(['A', 'B'], '内容')] },
        { name: '书2', entries: [entry(['B', 'A'], '内容')] }
    ], { uidFactory: seqUid });
    assert.equal(r.entries.length, 1);
    assert.equal(r.stats.added, 1);
    assert.equal(r.stats.skippedDup, 1);
});

test('★ 非字符串 key/content：数字 / 对象 / 空值都不崩且能正常去重', () => {
    const r = mergeWorldbookEntries([
        { name: 's1', entries: [entry(12345, 678), entry({ a: 1 }, ['x']), entry(null, null)] },
        { name: 's2', entries: [entry('12345', '678')] }
    ], { uidFactory: seqUid });
    assert.equal(r.stats.total, 4);
    assert.equal(r.entries.length, 3, '数字 key/content 与字符串形式视为同一条');
    assert.equal(r.stats.skippedDup, 1);
});

test('★ 键冲突：同 keys 不同 content ⇒ 两条都保留 + 计入 stats.keyConflicts', () => {
    const r = mergeWorldbookEntries([
        { name: '书甲', entries: [entry('触发词', '甲的内容')] },
        { name: '书乙', entries: [entry('触发词', '乙的内容')] }
    ], { uidFactory: seqUid });
    assert.equal(r.entries.length, 2, '不自动取舍：两条都在');
    assert.equal(r.stats.keyConflicts.length, 1);
    assert.deepEqual(r.stats.keyConflicts[0].keys, ['触发词']);
    assert.equal(r.stats.keyConflicts[0].items.length, 2, '冲突报告列出两个来源');
    assert.deepEqual(r.stats.keyConflicts[0].items.map((x) => x.source), ['书甲', '书乙']);
});

test('同 keys 同 content ⇒ 算重复而非冲突', () => {
    const r = mergeWorldbookEntries([
        { name: 'a', entries: [entry('k', '一样')] },
        { name: 'b', entries: [entry('k', '一样')] }
    ], { uidFactory: seqUid });
    assert.equal(r.stats.skippedDup, 1);
    assert.equal(r.stats.keyConflicts.length, 0);
});

test('★ dropInternalFields 是**白名单制**：只剔 uid/_collapsed/_srcIndex/_srcUid，保住 extensions._filename（DF-14）', () => {
    const src = entry('k', 'c', {
        _srcUid: 'tmp-1', _collapsed: true, _srcIndex: 3, uid: 12345,      // 白名单内 ⇒ 剔（uid 由本模块重生成）
        _front: 1, extensions: { _filename: 'must-keep.png', other: 2 }, inner: { _deep: 'keep-me' }
    });
    const r = mergeWorldbookEntries([{ name: 's', entries: [src] }], { uidFactory: () => 'newuid' });
    const got = r.entries[0];
    assert.equal(got.uid, 'newuid', 'uid 全量重生成（含覆盖 ST 原生数字 uid —— 合并产出的是新书）');
    assert.equal(got._srcUid, undefined, '白名单内的前端内部字段被剔');
    assert.equal(got._collapsed, undefined);
    assert.equal(got._srcIndex, undefined);
    assert.equal(got.extensions._filename, 'must-keep.png', 'extensions._filename 必须保留');
    assert.equal(got.inner._deep, 'keep-me', '非白名单的 `_` 键不动（**不得**递归剔 `_` 前缀）');
    assert.equal(got._front, 1, '非白名单的 `_` 键一律保留');
    assert.equal(src.uid, 12345, '源词条不被修改（本模块只读 sources）');
});

test('uid 唯一性：全量重生成且互不相同', () => {
    const r = mergeWorldbookEntries([
        { name: 's', entries: [entry('a', '1'), entry('b', '2'), entry('c', '3')] }
    ], { uidFactory: defaultUidFactory });
    const uids = r.entries.map((x) => x.uid);
    assert.equal(new Set(uids).size, 3);
    assert.deepEqual(uids, r.entries.map((x) => x.uid));
});

test('边界：空来源 / 空书 / 单书 / 脏条目（null、字符串、数字）', () => {
    assert.deepEqual(mergeWorldbookEntries([]).entries, []);
    assert.equal(mergeWorldbookEntries([]).stats.added, 0);
    assert.equal(mergeWorldbookEntries([{ name: 'x', entries: [] }]).stats.added, 0);
    assert.equal(mergeWorldbookEntries([{ name: 'x', entries: [entry('a', 'b')] }]).entries.length, 1);
    const dirty = mergeWorldbookEntries([{ name: 'x', entries: [null, 'str', 42, undefined, entry('ok', 'v')] }]);
    assert.equal(dirty.entries.length, 1, '非对象条目跳过');
    assert.equal(dirty.stats.total, 1, 'total 只统计有效对象条目');
});

test('bySource 统计（total / added / skipped 逐本）', () => {
    const r = mergeWorldbookEntries([
        { name: '一', entries: [entry('a', '1'), entry('b', '2')] },
        { name: '二', entries: [entry('a', '1'), entry('c', '3')] }
    ], { uidFactory: seqUid });
    assert.deepEqual(r.stats.bySource, [
        { name: '一', total: 2, added: 2, skipped: 0 },
        { name: '二', total: 2, added: 1, skipped: 1 }
    ]);
    assert.equal(r.stats.total, 4);
    assert.equal(r.stats.added, 3);
    assert.equal(r.stats.skippedDup, 1);
});

test('mergeNameOf / mergeDescriptionOf：命名与描述口径', () => {
    assert.equal(mergeNameOf(3), '合并世界书_3本');
    assert.equal(mergeNameOf(0), '合并世界书_0本');
    assert.equal(mergeDescriptionOf(['甲', '乙'], 12), '由 [甲, 乙] 合并而成，包含 12 个词条。');
    assert.equal(mergeDescriptionOf([], 0), '由 [] 合并而成，包含 0 个词条。');
});

test('keySampleOf：保留原始大小写与顺序（预览展示用）', () => {
    assert.deepEqual(keySampleOf({ key: [' B ', 'a'] }), ['B', 'a']);
    assert.deepEqual(keySampleOf({}), []);
});
