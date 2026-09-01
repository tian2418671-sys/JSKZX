/**
 * useCardCrud 组合式函数单元测试
 * 聚焦 processAutoTagsAndCategory 的覆盖层恢复优先级链：
 *   物理文件夹 > overlay(app_config 覆盖层) > importedConfig(导入历史) > localCategoryMap > 自动规则
 * —— 防"重扫/重启冲刷用户手动分类与标签"回归的最后防线。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { useCardCrud } from '../js/composables/useCardCrud.js';
import { compileAutoTagRules } from '../js/utils/cardLoader.js';

// ---------- 测试夹具 ----------

// 构造 useCardCrud 所需 mock 注入（仅覆盖 processAutoTagsAndCategory 消费的状态）
function makeMock(overrides = {}) {
    const appConfig = { value: { cardOverlays: {} } };
    const importedConfig = { value: {} };
    const localCategoryMap = { value: {} };
    const sanitizeImportedTags = { value: false };
    const allCategories = { value: [
        { key: 'all', cn: '全部', en: 'All' },
        { key: 'fantasy', cn: '奇幻', en: 'Fantasy' },
        { key: 'scifi', cn: '科幻', en: 'Sci-Fi' },
        { key: 'romance', cn: '恋爱', en: 'Romance' },
        { key: 'uncategorized', cn: '未分类', en: 'Uncategorized' }
    ] };
    const customCategories = { value: [] };
    const crud = useCardCrud({
        library: { value: [] },
        cardData: { value: null },
        currentFolderPath: { value: 'C:/lib' },
        appConfig,
        customCategories,
        allCategories,
        isCategoryKnown: () => false,
        importedConfig,
        localCategoryMap,
        sanitizeImportedTags,
        // 使用系统预设规则表（含「魔法/精灵 → Fantasy (奇幻)」等默认规则）编译结果
        autoTagRules: { value: compileAutoTagRules(null) },
        isDragging: { value: false },
        dragCounter: { value: 0 },
        importFileInput: { value: null },
        nativeAlert: () => {},
        showToast: () => {},
        appPrompt: async () => null,
        safeData: { value: {} },
        syncConfigToDisk: () => {},
        syncConfigToDiskDebounced: () => {},
        reset: () => {},
        openFromLibrary: () => {},
        cleanupEmptyCategories: async () => {},
        ...overrides
    });
    return { crud, appConfig, importedConfig, localCategoryMap, sanitizeImportedTags, allCategories, customCategories };
}

// 构造一张待处理卡片（V2 结构，data 在 data 层）
function makeCard(overrides = {}) {
    return {
        path: 'C:/lib/test.png',
        name: '测试卡',
        subFolder: '',
        data: {
            data: {
                name: '测试卡',
                description: '',
                personality: '',
                scenario: '',
                first_mes: '',
                tags: []
            }
        },
        category: '未分类',
        customTags: [],
        ...overrides
    };
}

// ---------- 优先级链 ①：物理文件夹 ----------

test('优先级链①：物理文件夹分组优先（分类取文件夹，标签仍恢复 overlay）', () => {
    const m = makeMock();
    // 分类的事实依据 = 物理文件夹位置；但标签必须按覆盖层恢复
    // （2026-09-01 修复：旧实现 subFolder 分支裸 return 跳过覆盖层恢复，
    //   导致子文件夹卡 AI 打标/手动标签重启后丢失）
    m.appConfig.value.cardOverlays['C:/lib/恋活/test.png'] = { category: '奇幻', tags: ['魔法'] };
    const card = makeCard({
        path: 'C:/lib/恋活/test.png',
        subFolder: '恋活/子目录',
        data: { data: { name: '测试卡', description: '魔法 精灵 异世界', tags: [] } }
    });
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '恋活', '分类应取一级文件夹名，不用 overlay 分类');
    assert.deepEqual(card.customTags, ['魔法'], '标签仍恢复 overlay（修复：防重启丢失），且不追加自动规则标签');
    assert.ok(card.data.data.tags.includes('魔法'), '标签应同步回原生 data.tags');
});

// ---------- 优先级链 ②：overlay（app_config 覆盖层） ----------

test('优先级链②：overlay 恢复用户手动分类与标签', () => {
    const m = makeMock();
    m.appConfig.value.cardOverlays['C:/lib/test.png'] = { category: '奇幻', tags: ['魔法', '精灵'] };
    const card = makeCard({ data: { data: { name: '测试卡', description: 'nsfw 色情内容', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '奇幻', '覆盖层分类优先，禁止被自动分类冲刷');
    assert.deepEqual(card.customTags, ['魔法', '精灵'], '覆盖层标签恢复');
    // 标签应同步回原生 data.tags（保证后续保存一致）
    assert.ok(card.data.data.tags.includes('魔法'), '标签应同步到原生 data.tags');
});

test('优先级链②b：overlay 空标签数组 = 用户清空过，禁止回退自动分类', () => {
    const m = makeMock();
    m.appConfig.value.cardOverlays['C:/lib/test.png'] = { category: '', tags: [] };
    const card = makeCard({ data: { data: { name: '测试卡', description: '魔法 精灵 异世界 巨龙', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.deepEqual(card.customTags, [], '空数组代表用户清空过，不得恢复自动规则标签');
    assert.equal(card.category, '未分类', 'overlay 命中即跳过自动分类');
});

test('优先级链②c：overlay 仅 category（无 tags）时分类恢复并 return（标签保持原样）', () => {
    const m = makeMock();
    m.appConfig.value.cardOverlays['C:/lib/test.png'] = { category: '科幻' };
    const card = makeCard({ data: { data: { name: '测试卡', description: '赛博朋克 未来 机甲', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '科幻', '覆盖层分类恢复');
    assert.deepEqual(card.customTags, [], 'overlay 命中即 return，不自动补标签（用户配置权威）');
});

// ---------- 优先级链 ③：importedConfig（导入历史配置） ----------

test('优先级链③：无 overlay 时 importedConfig 历史配置优先', () => {
    const m = makeMock();
    m.importedConfig.value['测试卡'] = { category: '恋爱', customTags: ['傲娇'] };
    const card = makeCard({ data: { data: { name: '测试卡', description: '魔法 精灵', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '恋爱', '导入历史分类优先于自动规则');
    assert.deepEqual(card.customTags, ['傲娇'], '导入历史标签');
});

// ---------- 优先级链 ④：localCategoryMap（localStorage 手动分类） ----------

test('优先级链④：无 overlay/importedConfig 时 localCategoryMap 恢复', () => {
    const m = makeMock();
    m.localCategoryMap.value['测试卡'] = '科幻';
    const card = makeCard();
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '科幻', 'localStorage 手动分类优先于自动规则');
});

// ---------- 优先级链 ⑤：自动规则（兜底） ----------

test('优先级链⑤：自动规则匹配生成标签并落到已知分组', () => {
    const m = makeMock();
    const card = makeCard({ data: { data: { name: '测试卡', description: '这是一个魔法世界，精灵与巨龙共存', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.ok(card.customTags.includes('Fantasy (奇幻)'), '应生成 Fantasy 标签');
    assert.equal(card.category, 'Fantasy', 'Fantasy 在预设分组中应落到该分组（en 匹配）');
});

test('自动规则：未知分组名不设分类（保持未分类）', () => {
    const m = makeMock();
    // NSFW (限制级) 不在 allCategories 预设中 → 分类保持未分类，但标签保留
    const card = makeCard({ data: { data: { name: '测试卡', description: 'nsfw 18+ 内容', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.ok(card.customTags.includes('NSFW (限制级)'), '标签照常生成');
    assert.equal(card.category, '未分类', '未知分组不设分类');
});

test('自动规则：sanitizeImportedTags 开启时不带入原生 tags', () => {
    const m = makeMock();
    m.sanitizeImportedTags.value = true;
    const card = makeCard({ data: { data: { name: '测试卡', description: '魔法', tags: ['他人杂标签'] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.ok(!card.customTags.includes('他人杂标签'), '开启净化时不带入原生 tags');
    assert.ok(card.customTags.includes('Fantasy (奇幻)'), '自动规则标签照常生成');
});

test('自动规则：sanitizeImportedTags 关闭时带入原生 tags 并去重', () => {
    const m = makeMock();
    const card = makeCard({ data: { data: { name: '测试卡', description: '魔法', tags: ['Fantasy (奇幻)', '原生标签'] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.ok(card.customTags.includes('原生标签'), '关闭净化时保留原生 tags');
    const count = card.customTags.filter(t => t === 'Fantasy (奇幻)').length;
    assert.equal(count, 1, 'Set 去重不重复');
});

test('自动规则：预设外分类不补建分组（防幽灵分组）', () => {
    const m = makeMock();
    // 构造不含 Fantasy 的 allCategories —— 自动分类只落已知预设，
    // 未知预设（Fantasy）保持「未分类」且绝不自动建组（v1.8.0 防幽灵分组修复）
    m.allCategories.value = [
        { key: 'all', cn: '全部', en: 'All' },
        { key: 'uncategorized', cn: '未分类', en: 'Uncategorized' }
    ];
    const card = makeCard({ data: { data: { name: '测试卡', description: '魔法 精灵', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.ok(card.customTags.includes('Fantasy (奇幻)'), '标签照常生成');
    assert.equal(card.category, '未分类', '未知预设不设分类');
    assert.deepEqual(m.customCategories.value, [], '绝不自动创建幽灵分组');
});

// ---------- 边界 ----------

test('无任何命中：纯文本不匹配任何规则，保持未分类', () => {
    const m = makeMock();
    const card = makeCard({ data: { data: { name: '测试卡', description: '平凡的一天', tags: [] } } });
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '未分类');
    assert.deepEqual(card.customTags, []);
});

test('无 data 层：脏卡片不崩溃', () => {
    const m = makeMock();
    const card = { path: 'C:/lib/x.png', name: '脏卡', subFolder: '', data: null, category: '未分类', customTags: [] };
    m.crud.processAutoTagsAndCategory(card);
    assert.equal(card.category, '未分类', '无 data 时安全返回');
});
