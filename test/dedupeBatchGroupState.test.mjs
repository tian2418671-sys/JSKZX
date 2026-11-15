/**
 * 🧹 查重批量清理 · 组级勾选状态（纯函数）单测
 * 规格：docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md §二 P4
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGroupExcluded, toggleGroupExcluded, collectExcludeIds } from '../js/utils/dedupeBatchGroupState.js';

test('isGroupExcluded：未标记 = 参与批量；标记 = 排除', () => {
    assert.equal(isGroupExcluded({}, 0), false);
    assert.equal(isGroupExcluded({ 0: true }, 0), true);
    assert.equal(isGroupExcluded({ 0: true }, 1), false);
    assert.equal(isGroupExcluded(null, 0), false);
});

test('toggleGroupExcluded：返回新对象（不原地改，保证 Vue 响应式）', () => {
    const first = {};
    const second = toggleGroupExcluded(first, 2, false);
    assert.deepEqual(first, {}, '入参不能被改');
    assert.equal(second[2], true);
    const third = toggleGroupExcluded(second, 2, true);
    assert.equal(third[2], undefined, '重新勾选 → 删除标记');
    assert.notEqual(second, third);
});

test('toggleGroupExcluded：脏入参不崩', () => {
    assert.deepEqual(toggleGroupExcluded(null, 0, false), { 0: true });
    assert.deepEqual(toggleGroupExcluded(undefined, 3, true), {});
});

test('collectExcludeIds：组 id + 下标双写（重扫后下标漂移也能命中）', () => {
    const groups = [{ id: 'g-a' }, { id: 'g-b' }, { id: 'g-c' }];
    const ids = collectExcludeIds({ 1: true }, groups);
    // 下标是数字（buildBatchPlan 内部统一 String() 归一，故数字/字符串都命中）
    assert.deepEqual(ids.slice().sort(), [1, 'g-b'].sort());
});

test('collectExcludeIds：没有 id 的组只写下标；空标记 → []', () => {
    assert.deepEqual(collectExcludeIds({ 0: true }, [{}, { id: 'x' }]), [0]);
    assert.deepEqual(collectExcludeIds({}, [{ id: 'x' }]), []);
    assert.deepEqual(collectExcludeIds(null, null), []);
});
