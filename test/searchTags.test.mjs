import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCardTags } from '../js/composables/useSearch.js';

// 卡片标签提取：验证「导入时忽略卡片自带标签」开关（ignoreNative）对标签搜索的影响
// 回归保护：开关开启时原生 data.tags 不得再参与标签搜索（否则杂乱标签仍可被 t: 搜到）

function makeCard({ customTags = [], nativeTags = [], itemTags } = {}) {
    return {
        name: '测试卡',
        customTags,
        itemTags,
        data: {
            data: {
                name: '测试卡',
                tags: nativeTags
            }
        }
    };
}

test('extractCardTags 默认合并 customTags + 原生 tags', () => {
    const card = makeCard({ customTags: ['都市', '恋爱'], nativeTags: ['作者_乱标_1', '作者_乱标_2'] });
    const tags = extractCardTags(card);
    assert.ok(tags.includes('都市'), '应包含 customTags');
    assert.ok(tags.includes('恋爱'), '应包含 customTags');
    assert.ok(tags.includes('作者_乱标_1'), '默认应包含原生 tags');
    assert.ok(tags.includes('作者_乱标_2'), '默认应包含原生 tags');
});

test('extractCardTags ignoreNative=true 时不提取原生 data.tags（开关开启）', () => {
    const card = makeCard({ customTags: ['都市'], nativeTags: ['作者_乱标_1', '作者_乱标_2'] });
    const tags = extractCardTags(card, { ignoreNative: true });
    assert.ok(tags.includes('都市'), '应保留 customTags');
    assert.ok(!tags.includes('作者_乱标_1'), 'ignoreNative 时应忽略原生 tags');
    assert.ok(!tags.includes('作者_乱标_2'), 'ignoreNative 时应忽略原生 tags');
});

test('extractCardTags 兼容字符串形式原生 tags', () => {
    const card = {
        name: '测试卡',
        customTags: [],
        data: { data: { tags: 'a, b, c' } }
    };
    assert.deepEqual(extractCardTags(card).sort(), ['a', 'b', 'c']);
    assert.deepEqual(extractCardTags(card, { ignoreNative: true }), []);
});

test('extractCardTags 兼容 item.tags 与数据缺失容错', () => {
    const card1 = { customTags: ['x'], tags: 'y,z', data: {} };
    assert.deepEqual(extractCardTags(card1).sort(), ['x', 'y', 'z']);
    // 数据缺失不抛错
    assert.deepEqual(extractCardTags(null), []);
    assert.deepEqual(extractCardTags(undefined, { ignoreNative: true }), []);
});
