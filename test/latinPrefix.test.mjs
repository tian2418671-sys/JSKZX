import { test } from 'node:test';
import assert from 'node:assert/strict';
import searchIndex from '../js/utils/searchIndex.js';

// PK-19 防再犯：拉丁前缀 / 子串检索的候选剪枝（bigram）**不得改变结果集合**。
//
// 背景（缺陷 PK-19）：`_getMatches(keyword)` 在精确命中失败时会退化为「遍历整张倒排表」。
//   中文按单字建 token → 单字查询必精确命中（0~0.2ms）；
//   拉丁词是整词 token → 用户输前缀（`syst`）或词中片段（`aster`）时整词命中不了
//   → **每次都全表扫**（11k 卡 / 112 万 token 实测 19~44ms/次，随 token 表线性增长）。
//
// 修复：建 bigram（token 二元组 → token 下标）候选索引，查询时取「最稀有的 bigram」候选集
//   再做 `includes` 精筛。语义与全表扫**完全一致**，只是范围小几个数量级。
//
// ⚠️ 对比口径说明（写测试时踩过的坑）：
//   `search(str)` 会先把 str **分词**（中文拆单字、拉丁整词），再多 token 做 **AND 交集**；
//   而 `_getMatches(kw)` 是**token 级**函数（对单个 token 做子串匹配）。
//   因此「结果是否与全表扫一致」必须在**同一层级**比较 —— 本文件一律直接对
//   `_getMatches(kw)` 与「全表 `includes(kw)`」比集合，避免被查询层的分词/交集语义干扰。
//
// 本文件的价值：**把「结果必须与基线逐条一致」钉死**。实测阶段曾验证「有序数组前缀区间」
// 与「首字母桶」两个更简单的方案都会**破坏子串语义**（`aster` / `yst` / `el` 结果变少），
// 若未来有人为了省内存换回那类方案，本文件会立刻失败。

const LATIN = ['system', 'syntax', 'symbol', 'sync', 'syndrome', 'symphony', 'sympathy',
    'character', 'challenge', 'channel', 'chemistry', 'magic', 'master', 'material',
    'element', 'elegant', 'embrace', 'emotion', 'empire', 'energy', 'personality',
    'performance', 'description', 'destiny', 'detail', 'appearance', 'application',
    'world', 'wisdom', 'knowledge', 'kingdom', 'network', 'neutral', 'tavern', 'technique',
    'village', 'virtue', 'vision', 'shadow', 'shelter', 'signal', 'silence', 'silver',
    'ocean', 'oracle', 'origin', 'rhythm', 'ritual', 'ancient', 'anchor', 'angel'];

const CJK = ['神秘的旅人', '古老的书卷', '禁忌的仪式', '荣耀的骑士', '沉默的守望者',
    '自由的风', '永恒的记忆', '破碎的誓言', '遥远的星辰'];

function makeCards(n) {
    const cards = [];
    let seed = 987654321;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
        const parts = [`角色${i}`, `name_${i}`];
        for (let k = 0; k < 12; k++) parts.push(LATIN[Math.floor(rnd() * LATIN.length)]);
        for (let k = 0; k < 3; k++) parts.push(CJK[Math.floor(rnd() * CJK.length)]);
        parts.push(`这是第${i}张卡，含 system 与 syntax 等英文术语。`);
        cards.push({ id: `c${i}`, path: `E:/lib/card${i}.png`, name: `角色${i}`, text: parts.join(' ') });
    }
    return cards;
}

const extractText = (c) => c.text.toLowerCase();
const extractTags = () => [];

/** 基线：修复前的「全表 includes」token 级语义 —— 作为正确性判据（唯一真相） */
function baselineToken(index, kw) {
    const exact = index.get(kw);
    if (exact) return new Set(exact);
    const out = [];
    for (const [word, cards] of index) if (word.includes(kw)) out.push(...cards);
    return new Set(out);
}

/** 断言：`_getMatches(kw)`（优化后）与全表扫基线**逐条一致**（不多不少） */
function assertTokenSameAsBaseline(kw) {
    const expect = baselineToken(searchIndex.index, kw);
    const actual = new Set(searchIndex._getMatches(kw));
    assert.equal(actual.size, expect.size,
        `token「${kw}」命中数不一致：期望 ${expect.size}，实际 ${actual.size}（候选剪枝破坏了子串语义）`);
    for (const card of expect) {
        assert.ok(actual.has(card), `token「${kw}」丢失了命中项 ${card.path}`);
    }
}

test('PK-19：拉丁前缀（逐字母递增）token 结果与全表扫基线一致', async () => {
    await searchIndex.buildAsync(makeCards(400), extractText, extractTags, 50);
    for (const kw of ['s', 'sy', 'sys', 'syst', 'syste', 'system', 'e', 'el', 'ele', 'elem', 'element']) {
        assertTokenSameAsBaseline(kw);
    }
});

test('PK-19：词中片段（非前缀子串）token 结果与基线一致 —— 这是前缀区间/首字母桶方案会挂的用例', async () => {
    await searchIndex.buildAsync(makeCards(400), extractText, extractTags, 50);
    // `aster` 是 master 的**中段**；`yst` 是 system/syntax 的中段；`el` 是 element 的前缀
    // 但也是 challenge / channel 的中段 —— 纯前缀结构会漏掉后半类。
    for (const kw of ['aster', 'yst', 'el', 'tem', 'haract', 'nowled', 'erform']) {
        assertTokenSameAsBaseline(kw);
    }
});

test('PK-19：中文单字 / 无命中词 token 结果与基线一致', async () => {
    await searchIndex.buildAsync(makeCards(300), extractText, extractTags, 50);
    for (const kw of ['系', '统', '神', '秘', '旅', '人', 'zzz', 'qx', '不存在的词']) {
        assertTokenSameAsBaseline(kw);
    }
});

test('PK-19：bigram 桶不存在的查询走「精确剪枝」返回空（不得漏命中）', async () => {
    await searchIndex.buildAsync(makeCards(200), extractText, extractTags, 50);
    // `zq` 这个二元组在任何 token 里都不存在 → 必然无匹配
    assert.equal(searchIndex._getMatches('zqxyz').length, 0);
    assert.equal(baselineToken(searchIndex.index, 'zqxyz').size, 0);
    assert.equal(searchIndex.search('zqxyz').length, 0, '端到端 search 也应返回空');
});

test('PK-19：精确命中（完整词）走直通分支，token 结果与基线一致', async () => {
    await searchIndex.buildAsync(makeCards(200), extractText, extractTags, 50);
    for (const kw of ['system', 'element', 'magic', 'name_7']) {
        assertTokenSameAsBaseline(kw);
    }
});

test('PK-19：端到端 search —— 拉丁词与中文单字与「分词 + 交集」基线一致', async () => {
    await searchIndex.buildAsync(makeCards(300), extractText, extractTags, 50);

    // 复刻 search() 的查询语义：分词 → 每个 token 取全表扫基线 → 交集
    const expectByQuery = (q) => {
        const tokens = searchIndex._tokenize(q.toLowerCase());
        if (!tokens.length) return new Set(searchIndex.cards);
        const sets = tokens.map(t => baselineToken(searchIndex.index, t));
        sets.sort((a, b) => a.size - b.size);
        let acc = new Set(sets[0]);
        for (let i = 1; i < sets.length && acc.size; i++) {
            acc = new Set([...acc].filter(c => sets[i].has(c)));
        }
        return acc;
    };

    for (const q of ['system', 'syst', 'aster', '神', '神秘', '旅人', '守望者', 'element magic']) {
        const expect = expectByQuery(q);
        const actual = new Set(searchIndex.search(q));
        assert.equal(actual.size, expect.size,
            `查询「${q}」命中数不一致：期望 ${expect.size}，实际 ${actual.size}`);
        for (const card of expect) assert.ok(actual.has(card), `查询「${q}」丢失命中项 ${card.path}`);
    }
});

test('PK-19：add/remove 之后（bigram 置脏）token 结果仍然正确 —— 降级只变慢、绝不错', async () => {
    const cards = makeCards(200);
    await searchIndex.buildAsync(cards, extractText, extractTags, 50);
    // 新增一张卡 → token 表变化 → bigram 下标失效 → 必须回退全表扫而不是返回旧下标
    const extra = { id: 'extra', path: 'E:/lib/extra.png', name: '额外角色', text: 'system syntax 神秘旅人 extra_marker' };
    searchIndex.add(extra, extractText, extractTags);
    assert.equal(searchIndex.bigramDirty, true, 'add 之后 bigram 应被标记为脏');
    assertTokenSameAsBaseline('system');
    assertTokenSameAsBaseline('extra_marker');
    assertTokenSameAsBaseline('神');
    assert.ok(new Set(searchIndex._getMatches('extra_marker')).has(extra), '新增的卡应能被搜到');

    // 移除一张卡 → 同样置脏，结果里不得再出现它
    searchIndex.remove(extra);
    assert.equal(searchIndex.bigramDirty, true, 'remove 之后 bigram 应被标记为脏');
    assert.equal(searchIndex.search('extra_marker').length, 0, '已移除的卡不得再被搜到');
    assertTokenSameAsBaseline('system');
});

test('PK-19：重建索引后 bigram 恢复可用（不脏），结果依旧正确', async () => {
    const cards = makeCards(200);
    await searchIndex.buildAsync(cards, extractText, extractTags, 50);
    searchIndex.add({ id: 'x', path: 'E:/lib/x.png', name: 'x', text: 'temporary' }, extractText, extractTags);
    assert.equal(searchIndex.bigramDirty, true);
    await searchIndex.buildAsync(cards, extractText, extractTags, 50);
    const st = searchIndex.stats();
    assert.equal(st.bigramDirty, false, '重建后 bigram 应为可用状态');
    assert.ok(st.bigramCount > 0, '重建后 bigram 桶不应为空');
    assertTokenSameAsBaseline('system');
    assertTokenSameAsBaseline('aster');
});

test('PK-19：clear() 之后 bigram 与 token 表同生死（标记脏，不得指向旧 token）', async () => {
    await searchIndex.buildAsync(makeCards(100), extractText, extractTags, 50);
    searchIndex.clear();
    assert.equal(searchIndex.bigramDirty, true, 'clear 之后 bigram 应为脏');
    assert.equal(searchIndex.stats().bigramCount, 0, 'clear 之后 bigram 桶应清空');
    assert.equal(searchIndex.search('system').length, 0, 'clear 之后不应再命中任何卡');
});

test('PK-19：大桶不触发 push(...cards) 的展开上限（改用循环追加）', async () => {
    // 构造「同一 token 命中极多卡」的场景：全部卡共享同一个超长 token
    const big = [];
    for (let i = 0; i < 5000; i++) {
        big.push({ id: `b${i}`, path: `E:/lib/big${i}.png`, name: `大库${i}`, text: 'sharedsuperlongtoken' });
    }
    await searchIndex.buildAsync(big, extractText, extractTags, 200);
    const res = searchIndex.search('sharedsuperlongtoken');
    assert.equal(res.length, 5000, '大桶场景下应完整返回全部命中（不得因展开上限丢结果或抛错）');
    assert.equal(new Set(res).size, 5000, '结果不得有重复引用');
});
