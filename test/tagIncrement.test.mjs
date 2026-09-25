/**
 * ⏭️ 增量模式（Q7）单测：`hasAnyTag` / `splitByTagged`
 * 口径：customTags 或 data.tags 任一非空 = 已打标；空白/空数组不算。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hasAnyTag, splitByTagged } from '../js/utils/tagIncrement.js';

describe('hasAnyTag — 是否已有标签', () => {
    test('customTags 非空 → true', () => {
        assert.equal(hasAnyTag({ customTags: ['奇幻'] }), true);
    });
    test('V2 结构 data.data.tags 非空 → true', () => {
        assert.equal(hasAnyTag({ data: { data: { tags: ['仙侠/修真'] } } }), true);
    });
    test('V1 结构 data.tags 非空 → true', () => {
        assert.equal(hasAnyTag({ data: { tags: ['日常'] } }), true);
    });
    test('customTags 为空但原生 data.tags 非空 → true（已有标签就算已打标）', () => {
        assert.equal(hasAnyTag({ customTags: [], data: { data: { tags: ['原生标签'] } } }), true);
    });
    test('原生 tags 为字符串（非数组）→ 非空白即 true', () => {
        assert.equal(hasAnyTag({ data: { tags: ' 奇幻 ' } }), true);
        assert.equal(hasAnyTag({ data: { tags: '   ' } }), false);
    });
    test('全空 → false', () => {
        assert.equal(hasAnyTag({ customTags: [] }), false);
        assert.equal(hasAnyTag({ customTags: [], data: { data: { tags: [] } } }), false);
        assert.equal(hasAnyTag({}), false);
    });
    test('空白项不算标签（防脏值误跳过）', () => {
        assert.equal(hasAnyTag({ customTags: ['', '   '] }), false);
        assert.equal(hasAnyTag({ data: { data: { tags: ['', null] } } }), false);
    });
    test('null / 非对象 → false（不抛错）', () => {
        assert.equal(hasAnyTag(null), false);
        assert.equal(hasAnyTag(undefined), false);
        assert.equal(hasAnyTag('x'), false);
    });
});

describe('splitByTagged — 拆分', () => {
    test('按已有标签拆分且保持顺序', () => {
        const a = { id: 'a', customTags: ['x'] };
        const b = { id: 'b', customTags: [] };
        const c = { id: 'c', data: { data: { tags: ['y'] } } };
        const d = { id: 'd' };
        const r = splitByTagged([a, b, c, d]);
        assert.deepEqual(r.tagged.map(x => x.id), ['a', 'c']);
        assert.deepEqual(r.untagged.map(x => x.id), ['b', 'd']);
    });
    test('非数组输入 → 两个空数组（不抛错）', () => {
        assert.deepEqual(splitByTagged(null), { tagged: [], untagged: [] });
        assert.deepEqual(splitByTagged('x'), { tagged: [], untagged: [] });
    });
});
