/**
 * 分组清理 · 空组收集单测（DF-16）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectEmptyGroups, SYSTEM_VIEW_KEYS } from '../js/utils/groupCleanup.js';

const preset = (key, cn, en) => ({ key, cn, en });

test('空输入：返回空名单，不抛错', () => {
    assert.deepEqual(collectEmptyGroups(), { customEmpties: [], presetEmpties: [] });
    assert.deepEqual(collectEmptyGroups({}), { customEmpties: [], presetEmpties: [] });
    assert.deepEqual(
        collectEmptyGroups({ customCategories: null, presetCategories: undefined, cards: 'oops' }),
        { customEmpties: [], presetEmpties: [] }
    );
});

test('有卡片的自定义组不算空；零卡片才算空', () => {
    const r = collectEmptyGroups({
        customCategories: ['纯爱', '催眠', '空组A'],
        cards: [{ category: '纯爱' }, { category: '纯爱' }, { category: '未分类' }, { category: '' }]
    });
    assert.deepEqual(r.customEmpties, ['催眠', '空组A']);
});

test('未分类（空 / 未分类 / uncategorized / 未分组）不计入任何分组', () => {
    const r = collectEmptyGroups({
        customCategories: ['未分类', '空组A'],
        cards: [{ category: '未分类' }, { category: 'uncategorized' }, { category: '未分组' }, { category: '   ' }]
    });
    // 即使用户把「未分类」当自定义组名，也不会进清理名单（系统口径）
    assert.deepEqual(r.customEmpties, ['空组A']);
});

test('预设分组按 cn / en / key 三种存储形态计数', () => {
    const presets = [
        preset('pleasure', '纯爱', 'Pure Love'),
        preset('hypnosis', '催眠', 'Hypnosis'),
        preset('ntr', 'NTR', 'NTR')
    ];
    const r1 = collectEmptyGroups({
        presetCategories: presets,
        cards: [{ category: '纯爱' }] // 命中 cn
    });
    assert.deepEqual(r1.presetEmpties.map(c => c.key), ['hypnosis', 'ntr']);

    const r2 = collectEmptyGroups({
        presetCategories: presets,
        cards: [{ category: 'Pure Love' }, { category: 'hypnosis' }] // 命中 en / key
    });
    assert.deepEqual(r2.presetEmpties.map(c => c.key), ['ntr']);

    const r3 = collectEmptyGroups({ presetCategories: presets, cards: [] });
    assert.deepEqual(r3.presetEmpties.map(c => c.key), ['pleasure', 'hypnosis', 'ntr']);
});

test('系统视图（all / 未分类 / 过滤视图）永不进清理名单', () => {
    const r = collectEmptyGroups({
        presetCategories: [
            preset('all', '全部'), preset('uncategorized', '未分类'),
            preset('has_lorebook', '带世界书'), preset('has_regex', '带正则')
        ],
        customCategories: ['未分类', 'all']
    });
    assert.deepEqual(r.presetEmpties, []);
    assert.deepEqual(r.customEmpties, []);
    assert.deepEqual(SYSTEM_VIEW_KEYS, ['all', 'has_lorebook', 'has_regex', 'uncategorized']);
});

test('自定义组：空白名过滤 + 重复名去重 + 首尾空格名按原名保留', () => {
    const r = collectEmptyGroups({
        customCategories: ['纯爱', '纯爱', '  ', '', ' 空组 ', null, 123],
        cards: [{ category: '纯爱' }]
    });
    assert.deepEqual(r.customEmpties, [' 空组 ']);
});
