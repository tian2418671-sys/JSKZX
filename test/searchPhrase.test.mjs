/**
 * PK-18 / PK-19 检索准确度与就绪判定单测
 *
 * 背景（见 docs/规格与计划/查重扫描与检索-最终方案.md §2.6）：
 *   索引对 CJK **按单字**建 token，所以「系统」在索引路径下退化为「含『系』且含『统』」的单字 AND，
 *   会把正文「体**系** 传**统**」的卡误命中；而旧代码的短语校验条件是
 *   `... && searchIndex.cardCount === 0` —— **索引一就绪整条被跳过** → 同一查询在索引前后结果不一致。
 *
 * 本测试直接实例化 useSearch（不依赖 Electron），断言：
 *   1. 索引就绪时，「系统」不得命中「体系 传统」的卡（候选集短语复核生效）
 *   2. 索引未就绪（构建中 / 覆盖不足）时不漏卡
 *   3. 索引查空时回落内存匹配，而不是硬空
 *   4. 索引就绪前后，同一查询结果一致（这是最关键的回归断言）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { useSearch } from '../js/composables/useSearch.js';
import searchIndex from '../js/utils/searchIndex.js';

/** 造一张卡：正文含指定文本 */
function mkCard(name, text) {
    return {
        id: 'c_' + name,
        name,
        path: `E:/lib/${name}.png`,
        fileName: `${name}.png`,
        customTags: [],
        data: { name, description: text }
    };
}

/** 建一个干净的 useSearch 实例（每个用例独立，避免共享索引状态） */
function makeSearch(library) {
    const searchQueryInputRef = ref('');
    const ctx = useSearch({
        library,
        currentCategoryKey: ref('all'),
        allCategories: ref([]),
        sortBy: ref('name'),
        currentPage: ref(1),
        itemsPerPage: ref(100),
        lastSelectedIndex: ref(-1),
        estimateCardTokens: () => 0,
        sanitizeImportedTags: ref(false)
    });
    return ctx;
}

/** 等待防抖（useSearch 的 searchQuery 有 300ms 防抖） */
const settle = () => new Promise(r => setTimeout(r, 380));

// ───────────────────────── PK-18：短语准确度 ─────────────────────────

test('PK-18：索引就绪时「系统」不得命中正文「体系 传统」的卡', async () => {
    const decoy = mkCard('诱饵卡', '体系 传统 经典文字');   // 含「系」「统」但不含「系统」
    const real = mkCard('真卡', '本系统用于监控');           // 真含「系统」
    const lib = ref([decoy, real]);

    // 建索引（模拟「索引已就绪」）
    searchIndex.clear();
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系统';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name);
    assert.ok(hits.includes('真卡'), '「系统」必须命中真含该词的卡');
    assert.ok(!hits.includes('诱饵卡'), '「系统」不得命中仅含「体系 传统」的卡（单字 AND 误命中）');
});

test('PK-18：索引就绪前后，同一查询结果必须一致', async () => {
    const decoy = mkCard('诱饵卡', '体系 传统 经典文字');
    const real = mkCard('真卡', '本系统用于监控');
    const other = mkCard('无关卡', '完全无关的内容');
    const lib = ref([decoy, real, other]);

    const s = makeSearch(lib);

    // ① 索引未就绪（cardCount = 0）→ 走内存匹配
    searchIndex.clear();
    s.searchQueryInput.value = '系统';
    await settle();
    const beforeNames = s.filteredLibrary.value.map(c => c.name).sort();

    // ② 建索引（就绪）→ 走索引 + 短语复核
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);
    s.searchQueryInput.value = '系统 监控';   // 换词触发重算
    await settle();
    s.searchQueryInput.value = '系统';
    await settle();
    const afterNames = s.filteredLibrary.value.map(c => c.name).sort();

    assert.deepEqual(afterNames, beforeNames, '索引建好前后同一查询结果必须一致（否则用户看到的结果会随索引状态漂移）');
    assert.deepEqual(afterNames, ['真卡'], '两个路径都应只命中真卡');
});

test('PK-18：多词 AND 在索引路径下同样严格（两个词都必须出现）', async () => {
    const c1 = mkCard('卡A', '系统与监控都有');
    const c2 = mkCard('卡B', '只有系统没有另一个词');
    const c3 = mkCard('卡C', '体系 传统 监控');   // 有「监控」但「系」「统」不连续
    const lib = ref([c1, c2, c3]);

    searchIndex.clear();
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系统 监控';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name).sort();
    assert.deepEqual(hits, ['卡A'], '必须同时含「系统」和「监控」，且「系统」要连续出现');
});

// ───────────────────────── 就绪判定（不漏卡 / 不硬空） ─────────────────────────

test('索引未就绪（构建中）时不漏卡', async () => {
    const cards = [mkCard('甲', '系统监控'), mkCard('乙', '系统监控'), mkCard('丙', '无关')];
    const lib = ref(cards);

    // 让索引处于「构建中」状态：cardCount 有值但 building = true
    searchIndex.clear();
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);
    searchIndex.building = true;   // 强制模拟「正在重建」

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系统';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name).sort();
    assert.deepEqual(hits, ['乙', '甲'], '构建中必须回落内存匹配，不得因索引半建而漏卡');

    searchIndex.building = false;  // 复原
});

test('索引覆盖不足（cardCount < 库大小）时不漏卡', async () => {
    const all = [mkCard('甲', '系统监控'), mkCard('乙', '系统监控'), mkCard('丙', '系统监控')];
    const lib = ref(all);

    // 只索引前 1 张 → 覆盖不足
    searchIndex.clear();
    await searchIndex.buildAsync([all[0]], (c) => JSON.stringify(c).toLowerCase(), () => [], 10);

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系统';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name).sort();
    assert.deepEqual(hits, ['丙', '乙', '甲'], '索引覆盖不足必须回落内存匹配，不得只返回索引里那 1 张');
});

test('索引查空时回落内存匹配（不出现「0 结果」假象）', async () => {
    // 索引里没有该词，但库里有（模拟索引与库不同步）
    const cards = [mkCard('甲', '系统监控')];
    const lib = ref(cards);

    searchIndex.clear();
    await searchIndex.buildAsync([], () => '', () => [], 10);   // 空索引

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系统';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name);
    assert.deepEqual(hits, ['甲'], '索引查空必须回落内存匹配，而不是返回空列表');
});

test('索引完全就绪时结果正确（正常路径不回归）', async () => {
    const cards = [mkCard('甲', '系统监控'), mkCard('乙', '完全无关')];
    const lib = ref(cards);

    searchIndex.clear();
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系统';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name);
    assert.deepEqual(hits, ['甲']);
});

test('中文单字查询仍走索引精确路径（不因复核而破坏）', async () => {
    const cards = [mkCard('甲', '系统监控'), mkCard('乙', '无关')];
    const lib = ref(cards);

    searchIndex.clear();
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);

    const s = makeSearch(lib);
    s.searchQueryInput.value = '系';
    await settle();

    const hits = s.filteredLibrary.value.map(c => c.name);
    assert.deepEqual(hits, ['甲'], '单字「系」应命中含「系统」的卡');
});

test('排除词（-语法）在两条路径下行为一致', async () => {
    const cards = [mkCard('甲', '系统监控'), mkCard('乙', '系统备份')];
    const lib = ref(cards);

    // 索引未就绪
    searchIndex.clear();
    const s1 = makeSearch(lib);
    s1.searchQueryInput.value = '系统 -备份';
    await settle();
    const beforeNames = s1.filteredLibrary.value.map(c => c.name).sort();

    // 索引就绪
    await searchIndex.buildAsync(lib.value, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);
    const s2 = makeSearch(lib);
    s2.searchQueryInput.value = '系统 -备份';
    await settle();
    const afterNames = s2.filteredLibrary.value.map(c => c.name).sort();

    assert.deepEqual(beforeNames, ['甲'], '排除词应滤掉「系统备份」');
    assert.deepEqual(afterNames, beforeNames, '两条路径的排除词结果必须一致');
});
