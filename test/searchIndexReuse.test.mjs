import { test } from 'node:test';
import assert from 'node:assert/strict';
import searchIndex from '../js/utils/searchIndex.js';

/**
 * 契约测试：**增量重建 === 全量重建**（P2 前置，P1 依赖它）
 *
 * 为什么先写它：
 *   1) P1「列表只留元数据 + 正文懒加载」的前提是——刷新时**未变动的卡不再需要正文**也能重建索引。
 *      要做到这点必须让索引支持「沿用上一代的 token 桶」（P2）。而一旦引入增量路径，
 *      最容易出的错就是「增量和全量结果不一致」（漏卡 / 重复卡 / 陈旧条目）——
 *      所以先把等价性钉死在测试里，再改实现。
 *   2) 本文件在**实现之前**也必须通过：今天 `buildAsync` 会忽略 `{ reuse: true }`，
 *      两条路径都是全量构建，因此天然相等。P2 落地后同一份测试自动开始覆盖增量路径
 *      （`rebuild()` 里的选项就会被真正使用）——不需要再写第二份测试。
 *
 * 断言口径：对每个查询，比较**命中的 path 集合**（不是对象引用）——
 *   这正是用户可见的行为（列表里出现哪些卡），也是历史上「重复卡」缺陷的观测面。
 */

const extractText = (card) => `${card.name} ${card.body || ''}`.toLowerCase();
const extractTags = (card) => card.tags || [];

const QUERIES = ['龙', 'hero', 'unique', '甲', '乙', '不存在词'];

const makeCard = (i, opts = {}) => ({
    id: `c${i}`,
    path: `C:\\lib\\${opts.group || 'g'}\\card${i}.png`,
    name: opts.name || `龙${i}传`,
    body: opts.body || `unique${i} 仙侠 修真`,
    tags: opts.tags || ['仙侠'],
    _mtime: opts.mtime || 1000,
    _size: opts.size || 2000
});

const makeLib = (n) => {
    const lib = [];
    for (let i = 0; i < n; i++) lib.push(makeCard(i));
    return lib;
};

/** 走增量路径（若实现支持）；否则退化为全量 —— 两条路径都必须给出同样的可观测结果 */
async function rebuild(lib) {
    return await searchIndex.buildAsync(lib, extractText, extractTags, 7, { reuse: true });
}

/** 强制全量重建（先清空） */
async function rebuildFull(lib) {
    searchIndex.clear();
    return await searchIndex.buildAsync(lib, extractText, extractTags, 7);
}

function hits(lib) {
    const out = {};
    for (const q of QUERIES) {
        out[q] = searchIndex.search(q).map((c) => c.path).sort();
    }
    // 标签过滤也要一致（cardTags 是 WeakMap，增量沿用 token 桶时最容易漏掉它）
    out['#仙侠'] = searchIndex.search([], { tags: ['仙侠'] }).map((c) => c.path).sort();
    return out;
}

function assertNoDupPaths(lib, label) {
    for (const q of QUERIES) {
        const paths = searchIndex.search(q).map((c) => c.path);
        const seen = new Set();
        const dups = [];
        for (const p of paths) {
            if (seen.has(p)) dups.push(p);
            seen.add(p);
        }
        assert.equal(dups.length, 0, `[${label}] 查询「${q}」出现重复 path：${JSON.stringify(dups.slice(0, 3))}`);
    }
}

/** 核心断言：增量重建后的可观测行为，必须等于「清空后全量重建」 */
async function assertEquivalent(lib, label) {
    await rebuild(lib);
    assertNoDupPaths(lib, label);
    const incremental = hits(lib);
    await rebuildFull(lib);
    const full = hits(lib);
    assert.deepEqual(incremental, full, `[${label}] 增量与全量的命中结果不一致`);
    // 当前库全部卡都必须在索引里（防「沿用旧桶」时漏卡）
    assert.equal(searchIndex.stats().cardCount, lib.length, `[${label}] 索引卡数应等于库大小`);
}

test('基线：首次全量构建后，普通重建结果一致', async () => {
    const lib = makeLib(60);
    await rebuild(lib);
    assert.equal(searchIndex.stats().reusedCards, 0, '首次构建没有上一代可沿用，应为 0');
    await assertEquivalent(lib, '基线');
});

test('未变动的卡确实走「沿用」（证明增量路径真的被走到，而不是静默回退全量）', async () => {
    const lib = makeLib(80);
    await rebuild(lib);
    await rebuild(lib);                       // 库没变 → 应全部沿用
    assert.equal(searchIndex.stats().cardCount, lib.length);
    assert.equal(searchIndex.stats().reusedCards, lib.length, '同库重建应全部沿用上一代 token');
    // 只改一张卡（同 path、新 mtime）→ 只有它需要重新分词
    lib[7] = makeCard(7, { body: '改了内容 乙', mtime: 5000 });
    await rebuild(lib);
    assert.equal(searchIndex.stats().reusedCards, lib.length - 1, '只有变更的那张卡需要重新分词');
    assert.equal(searchIndex.search('乙').length, 1, '变更后的新内容应可检索');
});

test('新增卡片后重建（未变动的卡应被沿用）', async () => {
    const lib = makeLib(50);
    await rebuild(lib);
    lib.push(makeCard(999, { name: '甲甲甲', body: '新增卡 甲' }));
    await assertEquivalent(lib, '新增');
});

test('删除卡片后重建（被删的卡不得残留在索引里）', async () => {
    const lib = makeLib(50);
    await rebuild(lib);
    const removed = lib.splice(10, 1)[0];
    await assertEquivalent(lib, '删除');
    const still = searchIndex.search(removed.name);
    assert.equal(still.length, 0, `被删除的卡仍在索引里：${removed.name}`);
});

test('同 path 替换为新对象（刷新复用失败的情形）', async () => {
    const lib = makeLib(40);
    await rebuild(lib);
    // 模拟「刷新时该卡被重新解析」：同 path，新对象、新 mtime、正文也不同
    lib[5] = makeCard(5, { name: '乙乙乙', body: '改写后的正文 乙', mtime: 2000, size: 3000 });
    await assertEquivalent(lib, '替换');
    const hit = searchIndex.search('乙').map((c) => c.path);
    assert.equal(hit.length, 1, '改名/改正文后应能搜到新内容且只有一条');
    assert.equal(searchIndex.search('乙乙乙').length, 1, '新名字应可检索');
});

test('连续多轮增量（库里既有沿用也有新增/删除）', async () => {
    const lib = makeLib(70);
    await rebuild(lib);
    lib.splice(3, 5);                                              // 删 5 张
    for (let i = 100; i < 108; i++) lib.push(makeCard(i, { body: '第二批 甲' }));
    lib[0] = makeCard(0, { name: '丙丙丙', body: '第三批 丙', mtime: 3000 });
    await assertEquivalent(lib, '多轮');
});

test('标签过滤在增量路径下同样正确', async () => {
    const lib = makeLib(30).map((c, i) => ({ ...c, tags: i % 2 === 0 ? ['仙侠'] : ['科幻'] }));
    await rebuild(lib);
    assert.equal(searchIndex.search([], { tags: ['仙侠'] }).length, 15);
    lib.push(makeCard(500, { tags: ['科幻'], body: '新卡 乙' }));
    await assertEquivalent(lib, '标签');
});
