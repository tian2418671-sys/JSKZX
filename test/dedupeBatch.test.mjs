/**
 * 🧹 查重批量清理 · 判定层单测
 * 规格：docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md §三 / §七
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    KEEP_STRATEGIES, BATCH_SCOPES, SKIP_REASONS, DEFAULT_BATCH_OPTIONS,
    classifyGroup, nameDirtScore, pickKeepIndex, chunkList, buildBatchPlan,
} from '../js/utils/dedupeBatch.js';

const LIB = 'E:\\lib';

const member = (name, extra = {}) => ({
    path: `${LIB}\\${name}.png`,
    name,
    _tokens: 100,
    _sizeKb: 100,
    _dateStr: '2026-01-01 00:00',
    ...extra,
});

const group = (id, members, extra = {}) => ({
    id,
    name: id,
    type: 'duplicate',
    cards: members,
    ...extra,
});

const similarityGroup = (id, members) => group(id, members, { type: 'high', simPct: 92 });
const nameOnlyGroup = (id, members) => group(id, members, { type: 'nameonly', _nameOnly: true });

// ───────── 常量 ─────────
test('常量：策略 5 种 / 范围 3 档 / 默认只勾 exact', () => {
    assert.deepEqual([...KEEP_STRATEGIES], ['center', 'tokens', 'newest', 'clean-name', 'size']);
    assert.deepEqual([...BATCH_SCOPES], ['exact', 'similar', 'nameonly']);
    assert.equal(DEFAULT_BATCH_OPTIONS.scopes.exact, true);
    assert.equal(DEFAULT_BATCH_OPTIONS.scopes.similar, false);
    assert.equal(DEFAULT_BATCH_OPTIONS.scopes.nameonly, false);
});

// ───────── 归类 ─────────
test('classifyGroup：duplicate→exact / high→similar / nameOnly→nameonly / 脏数据→bad', () => {
    assert.equal(classifyGroup(group('a', [member('x')])), 'exact');
    assert.equal(classifyGroup(similarityGroup('b', [member('x')])), 'similar');
    assert.equal(classifyGroup(nameOnlyGroup('c', [member('x')])), 'nameonly');
    assert.equal(classifyGroup(null), 'bad');
    assert.equal(classifyGroup({ id: 'd', cards: [] }), 'bad');
    assert.equal(classifyGroup({ id: 'e', list: [member('x')], type: 'duplicate' }), 'exact'); // list 兼容
});

// ───────── 文件名脏度 ─────────
test('nameDirtScore：副本后缀越"脏"分越高，干净文件为 0', () => {
    assert.equal(nameDirtScore(`${LIB}\\纯爱.png`), 0);
    assert.ok(nameDirtScore(`${LIB}\\纯爱 (1).png`) > 0);
    assert.ok(nameDirtScore(`${LIB}\\纯爱_copy_1789000000.png`) > 0);
    assert.ok(nameDirtScore(`${LIB}\\纯爱_移动_1789000000000.png`) > 0);
    assert.ok(nameDirtScore(`${LIB}\\纯爱_1789000000000.png`) > 0);
    assert.ok(nameDirtScore(`${LIB}\\纯爱 (1).png`) > nameDirtScore(`${LIB}\\纯爱v1.2.png`));
});

// ───────── 保留策略 ─────────
test('pickKeepIndex：默认 center 恒为 0（= 界面推荐版）', () => {
    const g = group('g', [member('a', { _tokens: 1 }), member('b', { _tokens: 999 })]);
    assert.equal(pickKeepIndex(g, 'center'), 0);
    assert.equal(pickKeepIndex(g, 'unknown-strategy'), 0); // 非法策略回退推荐版
});

test('pickKeepIndex：tokens / newest / size 各取最大；并列保留 center', () => {
    const g = group('g', [
        member('center', { _tokens: 10, _sizeKb: 10, _dateStr: '2026-01-01 00:00' }),
        member('big', { _tokens: 500, _sizeKb: 5, _dateStr: '2025-01-01 00:00' }),
        member('new', { _tokens: 20, _sizeKb: 1, _dateStr: '2026-11-01 00:00' }),
        member('fat', { _tokens: 30, _sizeKb: 900, _dateStr: '2024-01-01 00:00' }),
    ]);
    assert.equal(pickKeepIndex(g, 'tokens'), 1);
    assert.equal(pickKeepIndex(g, 'newest'), 2);
    assert.equal(pickKeepIndex(g, 'size'), 3);

    // 并列：严格大于才替换 → center（下标 0）胜出
    const tie = group('t', [member('a', { _tokens: 50 }), member('b', { _tokens: 50 })]);
    assert.equal(pickKeepIndex(tie, 'tokens'), 0);
});

test('pickKeepIndex：clean-name 保留文件名最干净的那张', () => {
    const g = group('g', [
        member('纯爱 (1)'),
        member('纯爱'),
        member('纯爱_copy_1789000000'),
    ]);
    assert.equal(pickKeepIndex(g, 'clean-name'), 1);
});

test('pickKeepIndex：时间字段三种形态都能解析；解不出不回退成"删掉它"', () => {
    const ms = group('m', [
        member('a', { _dateStr: '2020-01-01' }),
        member('b', { _dateStr: 1794737627757 }),
    ]);
    assert.equal(pickKeepIndex(ms, 'newest'), 1);
    const bad = group('b', [member('a', { _dateStr: '不是时间' }), member('b', { _dateStr: '' })]);
    assert.equal(pickKeepIndex(bad, 'newest'), 0);
});

// ───────── 计划：范围与闸门 ─────────
test('buildBatchPlan：默认只清理 L0，similar / nameonly 全部跳过并计数', () => {
    const groups = [
        group('exact', [member('a'), member('a (1)')]),
        similarityGroup('similar', [member('b'), member('b (1)')]),
        nameOnlyGroup('nameonly', [member('c'), member('c (1)')]),
    ];
    const plan = buildBatchPlan(groups, { libraryPath: LIB });
    assert.equal(plan.stats.files, 1);
    assert.equal(plan.deletions[0].groupId, 'exact');
    assert.equal(plan.stats.skipByReason[SKIP_REASONS.OUT_OF_SCOPE], 2);
    assert.deepEqual(plan.stats.scopeGroups, { exact: 1, similar: 1, nameonly: 1 });
});

test('buildBatchPlan：勾上 similar / nameonly 后一并处理', () => {
    const groups = [
        group('exact', [member('a'), member('a (1)')]),
        similarityGroup('similar', [member('b'), member('b (1)')]),
        nameOnlyGroup('nameonly', [member('c'), member('c (1)')]),
    ];
    const plan = buildBatchPlan(groups, {
        libraryPath: LIB,
        scopes: { exact: true, similar: true, nameonly: true },
    });
    assert.equal(plan.stats.files, 3);
    assert.equal(plan.stats.groupsPlanned, 3);
});

test('buildBatchPlan：每组必留 1 张（硬闸门）', () => {
    const groups = [group('g1', [member('a'), member('b'), member('c')])];
    const plan = buildBatchPlan(groups, { libraryPath: LIB, keepBy: 'size' });
    assert.equal(plan.deletions.length, 2);
    assert.equal(plan.keepList.length, 1);
    assert.ok(!plan.deletions.some((d) => d.path === plan.keepList[0].keepPath));
});

test('buildBatchPlan：成员 <2 的组跳过（成员不足）', () => {
    const plan = buildBatchPlan([group('solo', [member('a')])], { libraryPath: LIB });
    assert.equal(plan.stats.files, 0);
    assert.equal(plan.stats.skipByReason[SKIP_REASONS.TOO_FEW_MEMBERS], 1);
});

test('buildBatchPlan：跳过已打开的卡（整组跳过，不偷偷删别的）', () => {
    const g = group('g', [member('a'), member('open')]);
    const plan = buildBatchPlan([g], { libraryPath: LIB, isOpenPath: (p) => p.includes('open') });
    assert.equal(plan.stats.files, 0);
    assert.equal(plan.stats.skipByReason[SKIP_REASONS.OPEN_CARD], 1);
});

test('buildBatchPlan：skipOutside 开→库外组跳过；关→放行', () => {
    const g = group('g', [member('a'), { path: 'D:\\别处\\a.png', name: 'a', _sizeKb: 1 }]);
    const on = buildBatchPlan([g], { libraryPath: LIB, guards: { skipOutside: true } });
    assert.equal(on.stats.files, 0);
    assert.equal(on.stats.skipByReason[SKIP_REASONS.NOT_IN_LIBRARY], 1);

    const off = buildBatchPlan([g], { libraryPath: LIB, guards: { skipOutside: false } });
    assert.equal(off.stats.files, 1);
});

test('buildBatchPlan：excludeIds 生效（组级勾选取消）', () => {
    const groups = [group('g1', [member('a'), member('a (1)')]), group('g2', [member('b'), member('b (1)')])];
    const plan = buildBatchPlan(groups, { libraryPath: LIB, excludeIds: ['g1'] });
    assert.equal(plan.stats.files, 1);
    assert.equal(plan.deletions[0].groupId, 'g2');
    assert.equal(plan.stats.skipByReason[SKIP_REASONS.EXCLUDED], 1);
});

test('buildBatchPlan：上限（组数 / 文件数）触发 → 标记「已达单次上限」', () => {
    const groups = [];
    for (let i = 0; i < 5; i++) groups.push(group(`g${i}`, [member(`n${i}`), member(`n${i} (1)`)]));
    const byGroup = buildBatchPlan(groups, { libraryPath: LIB, maxGroups: 2 });
    assert.equal(byGroup.stats.groupsPlanned, 2);
    assert.equal(byGroup.stats.skipByReason[SKIP_REASONS.LIMIT_REACHED], 3);

    const byFile = buildBatchPlan(groups, { libraryPath: LIB, maxFiles: 2 });
    assert.ok(byFile.stats.files <= 2);
    assert.ok(byFile.stats.skipByReason[SKIP_REASONS.LIMIT_REACHED] >= 1);
});

test('buildBatchPlan：同一路径出现在两组只计一次（防重复删除）', () => {
    const shared = member('shared');
    const groups = [
        group('g1', [member('a'), shared]),
        group('g2', [member('b'), shared]),
    ];
    const plan = buildBatchPlan(groups, { libraryPath: LIB });
    const paths = plan.deletions.map((d) => d.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(paths.filter((p) => p === shared.path).length, 1);
});

test('buildBatchPlan：空入参 / 非数组 → 空计划（不抛异常）', () => {
    for (const bad of [undefined, null, 'x', 42]) {
        const plan = buildBatchPlan(bad, {});
        assert.equal(plan.stats.files, 0);
        assert.equal(plan.deletions.length, 0);
    }
});

test('buildBatchPlan：分组数据异常（无 path）→ 跳过并计数', () => {
    const plan = buildBatchPlan([group('g', [member('a'), { name: '无路径' }])], { libraryPath: LIB });
    assert.equal(plan.stats.files, 0);
    assert.equal(plan.stats.skipByReason[SKIP_REASONS.BAD_GROUP], 1);
});

// ───────── 分批 ─────────
test('chunkList：按 200 分批；非法 size 回退 200；空数组 → []', () => {
    const arr = Array.from({ length: 450 }, (_, i) => i);
    const chunks = chunkList(arr, 200);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((c) => c.length), [200, 200, 50]);
    assert.equal(chunkList(arr, 0).length, 3);
    assert.deepEqual(chunkList([], 200), []);
    assert.deepEqual(chunkList(null, 200), []);
});
