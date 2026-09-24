/**
 * 🏷️ 世界书分组与标签 —— 纯函数单测（A2 落地，`RFC-20260921-WB-TAGS-02`）
 *
 * 覆盖：
 *   · 分组名规范化 / **碰撞防护**（「全部」是视图哨兵，用它当分组名会让筛选**静默失效**）
 *   · 标签规范化 / 去重 / 切换
 *   · 标签频次统计
 *   · **复合过滤**语义（分组 + 标签 AND + 搜索 + 词条数档）—— 规格 TC-WB-02 / TC-WB-05
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WB_CAT_ALL, WB_CAT_DEFAULT, WB_RESERVED_CATEGORY_NAMES, WB_NAME_MAX_LEN,
    normalizeWbCategoryName, validateWbCategoryName,
    normalizeWbTag, normalizeWbTags, toggleWbTag, countWbTags, matchWbFilter
} from '../js/utils/wbGroupsTags.js';

// ══════════════════════════════════════════════════════════════
// 哨兵常量（与 App.vue 的 currentWbCategory 初值必须一致）
// ══════════════════════════════════════════════════════════════
test('哨兵常量：视图哨兵「全部」与未分组默认名「默认」（保留中文 —— 2026-09-24 拍板）', () => {
    assert.equal(WB_CAT_ALL, '全部');
    assert.equal(WB_CAT_DEFAULT, '默认');
    assert.deepEqual(WB_RESERVED_CATEGORY_NAMES, ['全部', '默认']);
});

// ══════════════════════════════════════════════════════════════
// 分组名规范化 + 碰撞防护（A2-2 决策核心）
// ══════════════════════════════════════════════════════════════
test('normalizeWbCategoryName：trim + 折叠内部空白 + 截断', () => {
    assert.equal(normalizeWbCategoryName('  科幻  '), '科幻');
    assert.equal(normalizeWbCategoryName('科幻   世界'), '科幻 世界', '内部多空白折叠为一个');
    assert.equal(normalizeWbCategoryName(''), '');
    assert.equal(normalizeWbCategoryName(null), '');
    assert.equal(normalizeWbCategoryName(undefined), '');
    assert.equal(normalizeWbCategoryName('   '), '');
    const long = 'x'.repeat(WB_NAME_MAX_LEN + 20);
    assert.equal(normalizeWbCategoryName(long).length, WB_NAME_MAX_LEN, '超长必须截断');
});

test('★ 碰撞防护：**「全部」不得作为分组名**（用了会让该组筛选静默失效）', () => {
    const r = validateWbCategoryName('全部', {});
    assert.equal(r.ok, false, '「全部」是视图哨兵 —— 用户建同名分组会导致 `!== 全部` 判定恒真、筛选点了没反应');
    assert.ok(r.reason.includes('保留'), '必须给出可理解的原因');
});

test('★ 碰撞防护：「默认」**允许**作为目标（语义 = 移出分组）', () => {
    const r = validateWbCategoryName('默认', {});
    assert.equal(r.ok, true);
    assert.equal(r.reserved, true, '应标记为保留名（UI 可据此提示）');
});

test('★ 碰撞防护：与**已存在**分组重名要拦（除自己）', () => {
    const existing = ['科幻', '恋爱'];
    assert.equal(validateWbCategoryName('科幻', { existing }).ok, false, '新建重名要拦');
    assert.equal(validateWbCategoryName('科幻', { existing, self: '科幻' }).ok, true,
        '重命名时「改成自己」不算冲突（幂等）');
    assert.equal(validateWbCategoryName('奇幻', { existing }).ok, true);
});

test('★ 碰撞防护：空名 / 纯空白要拦', () => {
    assert.equal(validateWbCategoryName('', {}).ok, false);
    assert.equal(validateWbCategoryName('   ', {}).ok, false);
    assert.equal(validateWbCategoryName(null, {}).ok, false);
});

// ══════════════════════════════════════════════════════════════
// 标签
// ══════════════════════════════════════════════════════════════
test('normalizeWbTag：trim + 折叠空白 + 截断；**允许**「全部」这类词（标签不参与哨兵判定）', () => {
    assert.equal(normalizeWbTag('  战斗系统  '), '战斗系统');
    assert.equal(normalizeWbTag('战斗   系统'), '战斗 系统');
    assert.equal(normalizeWbTag('全部'), '全部', '标签没有哨兵碰撞问题，应放行');
    assert.equal(normalizeWbTag(''), '');
    assert.equal(normalizeWbTag(null), '');
});

test('★ normalizeWbTags：**去重**（规格 TC-WB-02：`"  战斗系统 "` 与 `"战斗系统"` 应合并计数 1）', () => {
    assert.deepEqual(normalizeWbTags(['  战斗系统 ', '战斗系统', '', null, '战斗系统']), ['战斗系统']);
    assert.deepEqual(normalizeWbTags(['a', 'b', 'a']), ['a', 'b'], '保留首次出现顺序');
    assert.deepEqual(normalizeWbTags('不是数组'), []);
    assert.deepEqual(normalizeWbTags(null), []);
});

test('toggleWbTag：有则删、无则加（返回新数组，不改入参）', () => {
    const src = ['a', 'b'];
    assert.deepEqual(toggleWbTag(src, 'c'), ['a', 'b', 'c']);
    assert.deepEqual(toggleWbTag(src, 'a'), ['b']);
    assert.deepEqual(src, ['a', 'b'], '不得修改入参');
    assert.deepEqual(toggleWbTag(src, ''), ['a', 'b'], '空标签无操作');
});

test('countWbTags：频次统计，按 count 降序', () => {
    const r = countWbTags([['a', 'b'], ['a'], ['a', 'c'], ['b']]);
    assert.deepEqual(r[0], { tag: 'a', count: 3 });
    assert.deepEqual(r[1], { tag: 'b', count: 2 });
    assert.deepEqual(r[2], { tag: 'c', count: 1 });
    assert.deepEqual(countWbTags([]), []);
});

// ══════════════════════════════════════════════════════════════
// ★ 复合过滤（规格 TC-WB-05）
// ══════════════════════════════════════════════════════════════
test('★ matchWbFilter：分组「全部」= 不过滤；具体分组 = 精确匹配', () => {
    const base = { bookCategory: '科幻', bookTags: [] };
    assert.equal(matchWbFilter({ ...base, filterCategory: WB_CAT_ALL }), true);
    assert.equal(matchWbFilter({ ...base, filterCategory: undefined }), true);
    assert.equal(matchWbFilter({ ...base, filterCategory: '科幻' }), true);
    assert.equal(matchWbFilter({ ...base, filterCategory: '奇幻' }), false);
});

test('★ matchWbFilter：标签是 **AND**（必须全部命中）—— 规格原文「同时命中全部条件者」', () => {
    const book = { bookCategory: '奇幻', bookTags: ['日常', '高武'] };
    assert.equal(matchWbFilter({ ...book, filterTags: ['日常'] }), true);
    assert.equal(matchWbFilter({ ...book, filterTags: ['日常', '高武'] }), true, '两个都命中 → 通过');
    assert.equal(matchWbFilter({ ...book, filterTags: ['日常', '不存在'] }), false,
        'AND 语义：有一个没命中就不通过（不是 OR）');
    assert.equal(matchWbFilter({ ...book, filterTags: [] }), true, '空筛选 = 不过滤');
});

test('★ matchWbFilter：分组 + 标签**同时生效**（复合条件）', () => {
    const book = { bookCategory: '奇幻', bookTags: ['日常'] };
    assert.equal(matchWbFilter({ ...book, filterCategory: '奇幻', filterTags: ['日常'] }), true);
    assert.equal(matchWbFilter({ ...book, filterCategory: '科幻', filterTags: ['日常'] }), false,
        '分组不匹配 → 整条不通过（即使标签命中）');
    assert.equal(matchWbFilter({ ...book, filterCategory: '奇幻', filterTags: ['高武'] }), false,
        '标签不命中 → 整条不通过（即使分组匹配）');
});

test('★ matchWbFilter：搜索 / 词条数档 由调用方传入（false 即不通过）', () => {
    const book = { bookCategory: '默认', bookTags: [] };
    assert.equal(matchWbFilter({ ...book, matchesSearch: false }), false);
    assert.equal(matchWbFilter({ ...book, matchesCount: false }), false);
    assert.equal(matchWbFilter({ ...book, matchesSearch: true, matchesCount: true }), true);
});

test('matchWbFilter：脏输入不崩（null / 非数组标签 / 缺字段）', () => {
    assert.equal(matchWbFilter({}), true, '全空 = 不过滤 → 通过');
    assert.equal(matchWbFilter(null), true);
    assert.equal(matchWbFilter({ bookTags: '不是数组', filterTags: ['a'] }), false,
        '书标签脏形态 → 视为无标签 → 筛选不命中');
    assert.equal(matchWbFilter({ filterTags: '不是数组' }), true, '筛选标签脏形态 → 视为不过滤');
});
