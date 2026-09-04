/**
 * useTags.cleanForeignTagsFromLibrary 单元测试
 * 背景：sanitizeImportedTags 开关只影响「新导入」；历史卡的外来标签已被旧逻辑收编进
 *   customTags 并永久写回 PNG data.tags，且 globalAvailableTags 无条件聚合 customTags
 *   → 表现为「开关无效」的体感残留。本清洗按词表白名单（系统/常用标签库 + 自动打标规则
 *   + 手动归类标签 + 自定义关键词库）反向清除外来标签，customTags 与原生 data.tags 双清。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { useTags } from '../js/composables/useTags.js';

// 构造 useTags mock（仅覆盖 cleanForeignTagsFromLibrary 消费的依赖）
function makeMock(overrides = {}) {
    const library = { value: [] };
    const systemCommonTags = { value: ['Fantasy (奇幻)', 'NSFW (限制级)'] };
    const customTagAssignments = { value: {} };
    const customTagCategories = { value: [] };
    const compiledAutoTagRules = { value: { 'Fantasy (奇幻)': /魔法|精灵/, '恋爱': /恋爱/ } };
    const customKeywords = { value: ['傲娇'] };
    const alerts = [];
    const confirms = { value: true };
    const persists = [];
    const state = { syncConfigToDisk: 0 };

    const tags = useTags({
        systemCommonTags,
        tagLangMode: { value: 'both' },
        library,
        sanitizeImportedTags: { value: true },
        confirmDialog: async () => confirms.value,
        nativeAlert: (m, type) => alerts.push({ m, type }),
        persistCardUpdate: async (item, payload) => { persists.push({ name: item.name, payload }); },
        cardData: { value: null },
        searchQueryInput: { value: '' },
        selectedIds: { value: [] },
        clearSelection: () => {},
        syncConfigToDisk: () => { state.syncConfigToDisk++; },
        createProgressToast: () => null,
        customTagCategories,
        customTagAssignments,
        compiledAutoTagRules,
        customKeywords,
        ...overrides
    });
    return { tags, library, systemCommonTags, customTagCategories, customTagAssignments, alerts, confirms, persists, state };
}

function makeCard(overrides = {}) {
    return {
        path: 'C:/lib/x.png',
        name: '测试卡',
        subFolder: '',
        category: '奇幻',
        data: { data: { name: '测试卡', description: '', tags: [] } },
        customTags: [],
        ...overrides
    };
}

// ---------- 清洗行为 ----------

test('清洗：移除 customTags 与原生 tags 中词表外来标签并物理落盘', async () => {
    const m = makeMock();
    const card = makeCard({
        name: '历史卡',
        customTags: ['外来A', 'Fantasy (奇幻)'],
        data: { data: { name: '历史卡', description: '', tags: ['外来A', '外来B', 'Fantasy (奇幻)'] } }
    });
    m.library.value.push(card);
    await m.tags.cleanForeignTagsFromLibrary();
    assert.deepEqual(card.customTags, ['Fantasy (奇幻)'], 'customTags 保留白名单标签');
    assert.deepEqual(card.data.data.tags, ['Fantasy (奇幻)'], '原生 data.tags 同步清洗');
    assert.equal(m.persists.length, 1, '有改动即物理落盘一次');
    assert.equal(m.persists[0].name, '历史卡');
    assert.ok(m.alerts.some(a => a.type === 'info' && a.m.includes('清洗完成')), '完成提示');
});

test('清洗：手动归类过的标签（含小写键）大小写不敏感保留', async () => {
    const m = makeMock();
    m.customTagAssignments.value['nsfw'] = 'rating'; // 用户手动归类过（键存小写）
    const card = makeCard({
        name: '归类卡',
        customTags: ['NSFW', '杂标签'],
        data: { data: { name: '归类卡', description: '', tags: ['NSFW'] } }
    });
    m.library.value.push(card);
    await m.tags.cleanForeignTagsFromLibrary();
    assert.deepEqual(card.customTags, ['NSFW'], '手动归类标签（大小写不同）保留');
    assert.deepEqual(card.data.data.tags, ['NSFW']);
    assert.equal(m.persists.length, 1, '仍有外来标签需落盘');
});

test('清洗：V1 字符串型原生 tags 同样双清', async () => {
    const m = makeMock();
    const card = makeCard({
        name: 'v1卡',
        customTags: ['外来X'],
        data: { data: { name: 'v1卡', description: '', tags: '外来Y, Fantasy (奇幻)' } }
    });
    m.library.value.push(card);
    await m.tags.cleanForeignTagsFromLibrary();
    assert.deepEqual(card.customTags, [], '自定义外来标签清除');
    assert.equal(card.data.data.tags, 'Fantasy (奇幻)', '字符串 tags 保留白名单项');
    assert.equal(m.persists.length, 1, '字符串层有改动即落盘');
});

// ---------- 边界 ----------

test('清洗：全库均在词表内时提示无需清洗且不落盘', async () => {
    const m = makeMock();
    const card = makeCard({
        name: '干净卡',
        customTags: ['Fantasy (奇幻)', '傲娇'],
        data: { data: { name: '干净卡', description: '', tags: ['恋爱'] } }
    });
    m.library.value.push(card);
    await m.tags.cleanForeignTagsFromLibrary();
    assert.equal(m.persists.length, 0, '无外来标签不物理落盘');
    assert.ok(m.alerts.some(a => a.type === 'info' && a.m.includes('未发现外来标签')), '提示无需清洗');
});

test('清洗：用户取消则不改动任何卡片', async () => {
    const m = makeMock();
    m.confirms.value = false;
    const card = makeCard({
        name: '取消卡',
        customTags: ['外来A'],
        data: { data: { name: '取消卡', description: '', tags: ['外来A'] } }
    });
    m.library.value.push(card);
    await m.tags.cleanForeignTagsFromLibrary();
    assert.deepEqual(card.customTags, ['外来A'], '取消后不修改 customTags');
    assert.deepEqual(card.data.data.tags, ['外来A'], '取消后不修改原生 tags');
    assert.equal(m.persists.length, 0, '取消不落盘');
});

test('清洗：空库直接提示无需清洗', async () => {
    const m = makeMock();
    await m.tags.cleanForeignTagsFromLibrary();
    assert.equal(m.persists.length, 0);
    assert.ok(m.alerts.some(a => a.type === 'info' && a.m.includes('没有已加载的卡片')), '空库提示');
});

// ---------- 自定义大分类：同名变体幂等 + 重复合并 ----------

test('addCustomTagCategory：同名变体（含 NBSP）幂等返回已有 key，不重复建分类', () => {
    const m = makeMock();
    m.customTagCategories.value.push({ key: 'custom_a', name: '虚构组织', icon: '🏷️' });
    const k = m.tags.addCustomTagCategory('虚构组织\u00a0');
    assert.equal(k, 'custom_a', '复用已有分类 key');
    assert.equal(m.customTagCategories.value.length, 1, '不重复建同名分类');
});

test('mergeDuplicateTagCategories：合并同名变体分类并把标签归属迁移到保留项', () => {
    const m = makeMock();
    m.customTagCategories.value.push({ key: 'c1', name: '虚构组织', icon: '🏷️' });
    m.customTagCategories.value.push({ key: 'c2', name: '虚构组织\u3000', icon: '🏷️' });
    m.customTagAssignments.value['某个标签'] = 'c2';
    const merged = m.tags.mergeDuplicateTagCategories();
    assert.equal(merged, 1, '合并 1 个重复分类');
    assert.equal(m.customTagCategories.value.length, 1, '只剩保留分类');
    assert.equal(m.customTagCategories.value[0].key, 'c1');
    assert.equal(m.customTagAssignments.value['某个标签'], 'c1', '归属迁移到保留分类');
});

test('addCustomTagCategory：同毫秒连续建两个分类 key 唯一不碰撞（AI 一次应用连建多类）', () => {
    const m = makeMock();
    const k1 = m.tags.addCustomTagCategory('虚构组织');
    const k2 = m.tags.addCustomTagCategory('游戏动漫作品');
    assert.notEqual(k1, k2, 'key 必须唯一，不能复用同一毫秒时间戳');
    assert.equal(m.customTagCategories.value.length, 2);
    assert.equal(new Set(m.customTagCategories.value.map(c => c.key)).size, 2);
});

test('ensureUniqueCustomCategoryKeys：同 key 重复条目重发唯一 key', () => {
    const m = makeMock();
    m.customTagCategories.value.push({ key: 'custom_x', name: '虚构组织', icon: '🏷️' });
    m.customTagCategories.value.push({ key: 'custom_x', name: '游戏动漫作品', icon: '🏷️' });
    const fixed = m.tags.ensureUniqueCustomCategoryKeys();
    assert.equal(fixed, 1, '修复 1 个同 key 条目');
    assert.equal(new Set(m.customTagCategories.value.map(c => c.key)).size, 2, '修复后 key 全部唯一');
});
