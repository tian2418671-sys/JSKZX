import { test } from 'node:test';
import assert from 'node:assert/strict';
import searchIndex from '../js/utils/searchIndex.js';

// 搜索索引：并发/重叠重建的幂等性
// 背景（「搜索后刷新同一张卡重复出现」缺陷）：
//   App.vue 的 watch(library) 在刷新期间会被多次触发（library 引用替换 + 每张新解析卡
//   triggerRef），每次都调 searchIndex.buildAsync()。buildAsync 只有「开头 clear()」，
//   没有代次（generation）保护，也不检查「同一张卡是否已索引」——
//   两个重叠的重建循环会各自把同一张卡 push 进同一个倒排桶，
//   或把「刷新前的旧卡对象」在 clear() 之后又补回索引里。
//   于是搜索时同一张卡命中两次 → 列表里一个角色卡重复出现。

const extractText = (card) => `${card.name} ${card.desc || ''}`.toLowerCase();
const extractTags = (card) => card.tags || [];

function makeCards(n, prefix = 'hero') {
    const cards = [];
    for (let i = 0; i < n; i++) {
        cards.push({ id: `c${i}`, path: `C:\\lib\\${prefix}${i}.png`, name: `${prefix}${i}`, desc: 'unique' + i });
    }
    return cards;
}

test('重叠的两次 buildAsync 不得让同一张卡在结果里出现两次（同一批对象）', async () => {
    // 用中文单字做关键词：_tokenize 对中文按「单字」切分，搜索词因此与倒排 token
    // 精确相等，走 `index.get(keyword)` 直通分支（该分支不做身份去重）——
    // 这正是用户在中文卡库里最常敲的搜索方式。
    const cards = makeCards(200).map((c, i) => ({ ...c, name: `龙${i}传`, desc: '仙侠' }));
    const p1 = searchIndex.buildAsync(cards, extractText, extractTags, 10);
    const p2 = searchIndex.buildAsync(cards, extractText, extractTags, 10);
    await Promise.all([p1, p2]);

    const res = searchIndex.search('龙');
    const byPath = new Map();
    for (const card of res) byPath.set(card.path, (byPath.get(card.path) || 0) + 1);
    const dups = [...byPath.entries()].filter(([, n]) => n > 1);
    assert.equal(dups.length, 0, `同一张卡在搜索结果中出现多份：${JSON.stringify(dups.slice(0, 3))}`);
    assert.equal(res.length, new Set(res).size, '搜索结果不得包含重复引用');
});

test('重叠重建：已从库中移除的旧卡对象不得残留在索引里（同 path 新旧两份）', async () => {
    const oldCards = makeCards(120);
    const p1 = searchIndex.buildAsync(oldCards, extractText, extractTags, 10);
    // 刷新：库替换为全新对象（同 path），紧接着触发第二次重建
    const newCards = oldCards.map((c) => ({ ...c }));
    const p2 = searchIndex.buildAsync(newCards, extractText, extractTags, 10);
    await Promise.all([p1, p2]);
    // p2 只索引新对象，p1 在 clear() 之后又把旧对象补回 → 同一 path 命中两次
    const res = searchIndex.search('hero');
    const byPath = new Map();
    for (const card of res) byPath.set(card.path, (byPath.get(card.path) || 0) + 1);
    const dups = [...byPath.entries()].filter(([, n]) => n > 1);
    assert.equal(dups.length, 0, `同一 path 在搜索结果中出现多份：${JSON.stringify(dups.slice(0, 3))}`);
});

test('重叠重建后索引内容完整：所有卡片都能被搜到且各一次', async () => {
    const cards = makeCards(150);
    const p1 = searchIndex.buildAsync(cards, extractText, extractTags, 10);
    const p2 = searchIndex.buildAsync(cards, extractText, extractTags, 10);
    await Promise.all([p1, p2]);
    const res = searchIndex.search('hero');
    assert.equal(new Set(res).size, cards.length, '重建后应包含全部卡片');
});

test('单次 buildAsync 后 add/remove 幂等：重复 add 同一张卡不产生重复命中', async () => {
    const cards = makeCards(30);
    await searchIndex.buildAsync(cards, extractText, extractTags, 10);
    searchIndex.add(cards[0], extractText, extractTags);
    searchIndex.add(cards[0], extractText, extractTags);
    const res = searchIndex.search('hero0');
    assert.equal(res.filter((c) => c === cards[0]).length, 1, '同一张卡重复 add 后仍应只命中一次');
});

test('search 结果自身保证唯一（防御性）', async () => {
    const cards = makeCards(50);
    await searchIndex.buildAsync(cards, extractText, extractTags, 10);
    // 人为构造脏倒排（模拟历史遗留的重复桶）
    searchIndex.index.set('hero', [...cards, ...cards]);
    const res = searchIndex.search('hero');
    assert.equal(res.length, new Set(res).size, 'search 返回结果必须去重');
    searchIndex.clear();
});

test('双缓冲：构建期间搜索仍命中上一代完整索引（不出现「半份结果」）', async () => {
    // 回归保护：旧实现先 clear() 再逐片写入 → 构建中搜索只能命中半份倒排
    // （列表条目忽多忽少地抖动，甚至「搜不到明明存在的卡」）。现在构建写入暂存缓冲，
    // 完成后一次性切换活跃表。
    const gen1 = makeCards(100).map((c, i) => ({ ...c, name: `龙${i}传` }));
    await searchIndex.buildAsync(gen1, extractText, extractTags, 10);
    const before = searchIndex.search('龙').length;
    assert.equal(before, 100, '第一代建索引应完整');

    const gen2 = makeCards(40).map((c, i) => ({ ...c, name: `龙X${i}传` }));
    const p = searchIndex.buildAsync(gen2, extractText, extractTags, 10);
    const during = searchIndex.search('龙').length;   // 构建中读取
    assert.equal(during, before, '构建期间必须仍命中上一代完整索引（不得是半份）');
    await p;
    assert.equal(searchIndex.search('龙').length, 40, '构建完成后应切换到新缓冲');
});

test('buildAsync 在页面繁忙（idle 回调长期不触发）时仍能推进', async () => {
    // 回归保护：分片让步曾经只挂 requestIdleCallback，页面繁忙时几乎不回调
    // （实测启动后 5 分钟索引仍是 0 张）。现在 idle 与定时器竞速，最多 60ms 必推进。
    const cards = makeCards(120);
    const ric = globalThis.requestIdleCallback;
    globalThis.requestIdleCallback = () => 0; // 模拟「永不回调」
    try {
        const t0 = Date.now();
        await searchIndex.buildAsync(cards, extractText, extractTags, 10);
        const cost = Date.now() - t0;
        assert.equal(searchIndex.cardCount, cards.length, '即使 idle 永不回调也应完成索引');
        assert.ok(cost < 5000, `构建耗时不应被 idle 拖死（实测 ${cost}ms）`);
    } finally {
        if (ric) globalThis.requestIdleCallback = ric; else delete globalThis.requestIdleCallback;
    }
});
