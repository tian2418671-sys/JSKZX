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
    return { tags, library, systemCommonTags, customTagAssignments, alerts, confirms, persists, state };
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
