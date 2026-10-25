/**
 * 📊 结构画像纯函数 — 单测（方向 A / 阶段一）
 * 规格：docs/规格与计划/功能规格/A-结构画像-实现规格.md §7.1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortrait, percentile, portraitReportLines } from '../js/utils/libraryPortrait.js';

/** 造一张卡（data.data 形态，与真实库一致） */
const card = (name, tags, group, extra = {}) => Object.assign({
    name,
    path: `E:\\lib\\${name}.png`,
    tags,
    ...(group ? { subFolder: group } : {}),
    data: { data: { description: '简介', first_mes: '开场白' } }
}, extra);

const tagStatsOf = (counts, total) => ({
    total,
    tagCounts: new Map(Object.entries(counts)),
    topTags: Object.entries(counts).map(([tag, count]) => ({ tag, count }))
});

// ───────── percentile ─────────
test('percentile：空数组返回 null（不产生 NaN）', () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile(null, 0.9), null);
});

test('percentile：单元素任意分位都返回该值', () => {
    assert.equal(percentile([42], 0.5), 42);
    assert.equal(percentile([42], 0.99), 42);
});

test('percentile：线性插值正确', () => {
    const a = [1, 2, 3, 4, 5];
    assert.equal(percentile(a, 0.5), 3);
    assert.equal(percentile(a, 0), 1);
    assert.equal(percentile(a, 1), 5);
    assert.equal(percentile([10, 20], 0.5), 15);
});

// ───────── 空库 / 边界 ─────────
test('★ buildPortrait：空库时矩阵/Token 置灰，但池健康度仍可用（池里有 N 个从没用过）', () => {
    const p = buildPortrait([], { tagStats: tagStatsOf({}, 0), commonTags: ['Male (男性)'], estimateCardTokens: () => 100 });
    assert.equal(p.readiness.matrix, false);
    assert.equal(p.readiness.poolHealth, true, '池健康度：有 tagStats 即可算（空库 ⇒ 池内全部未使用，这是真实信息）');
    assert.equal(p.poolHealth.unusedInPoolCount, 1);
    assert.equal(p.tokenStats, null, '空库 Token 应为 null 而不是 0');
});

test('buildPortrait：全卡无标签 ⇒ 矩阵行数为 0、readiness.matrix=false', () => {
    const lib = [card('A', [], '组1'), card('B', [], null)];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({}, 2), commonTags: [], estimateCardTokens: () => 10 });
    assert.equal(p.matrix.rows.length, 0);
    assert.equal(p.readiness.matrix, false);
});

// ───────── 矩阵 ─────────
test('★ buildPortrait：单卡单标签单分组 ⇒ 1 行 1 列、单元格 1', () => {
    const lib = [card('A', ['病娇'], '组1')];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ 病娇: 1 }, 1), commonTags: [], estimateCardTokens: () => 10 });
    assert.equal(p.matrix.rows.length, 1);
    assert.equal(p.matrix.cols.length, 1);
    assert.equal(p.matrix.rows[0].tag, '病娇');
    assert.equal(p.matrix.cols[0].name, '组1');
    assert.equal(p.matrix.rows[0].cells[0], 1);
});

test('buildPortrait：未分组的卡归入「未分类」列，且该列排在最后', () => {
    const lib = [card('A', ['x'], '真实组'), card('B', ['x'], null), card('C', ['x'], '真实组')];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ x: 3 }, 3), commonTags: [], estimateCardTokens: () => 10 });
    const names = p.matrix.cols.map((c) => c.name);
    assert.deepEqual(names, ['真实组', '未分类'], '未分类必须排最后');
    const row = p.matrix.rows.find((r) => r.tag === 'x');
    assert.equal(row.cells[0], 2);
    assert.equal(row.cells[1], 1);
});

test('buildPortrait：同一张卡重复标签只计一次', () => {
    const lib = [card('A', ['病娇', '病娇'], '组1')];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ 病娇: 1 }, 1), commonTags: [], estimateCardTokens: () => 10 });
    assert.equal(p.matrix.rows[0].cells[0], 1);
});

test('★ buildPortrait：标签数超 maxTagRows 时截断并给出 truncatedTags', () => {
    const lib = [];
    const counts = {};
    for (let i = 0; i < 31; i++) { lib.push(card(`C${i}`, [`tag${i}`], 'G')); counts[`tag${i}`] = 1; }
    const p = buildPortrait(lib, { tagStats: tagStatsOf(counts, 31), commonTags: [], estimateCardTokens: () => 10 }, { maxTagRows: 30 });
    assert.equal(p.matrix.rows.length, 30);
    assert.equal(p.matrix.truncatedTags, 1);
    assert.equal(p.matrix.totalTags, 31);
});

test('buildPortrait：分组数超 maxGroupCols 时截断并给出 truncatedGroups', () => {
    const lib = [];
    for (let i = 0; i < 5; i++) lib.push(card(`C${i}`, ['x'], `G${i}`));
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ x: 5 }, 5), commonTags: [], estimateCardTokens: () => 10 }, { maxGroupCols: 3 });
    assert.equal(p.matrix.cols.length, 3);
    assert.ok(p.matrix.truncatedGroups >= 2);
});

test('buildPortrait：行按卡片数降序', () => {
    const lib = [card('A', ['多'], 'G'), card('B', ['多'], 'G'), card('C', ['少'], 'G')];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ 多: 2, 少: 1 }, 3), commonTags: [], estimateCardTokens: () => 10 });
    assert.equal(p.matrix.rows[0].tag, '多');
    assert.equal(p.matrix.rows[1].tag, '少');
});

// ───────── 标签池健康度 ─────────
test('★ buildPortrait：池为空时 poolEmpty=true，unusedInPool 为空', () => {
    const lib = [card('A', ['野生'], 'G')];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ 野生: 1 }, 1), commonTags: [], estimateCardTokens: () => 10 });
    assert.equal(p.poolHealth.poolEmpty, true);
    assert.deepEqual(p.poolHealth.unusedInPool, []);
    assert.equal(p.poolHealth.usedNotInPoolCount, 1);
});

test('★ buildPortrait：池内未被使用的标签正确列出', () => {
    const lib = [card('A', ['病娇'], 'G')];
    const p = buildPortrait(lib, {
        tagStats: tagStatsOf({ 病娇: 1 }, 1),
        commonTags: ['Male (男性)', 'Female (女性)', '病娇'],
        estimateCardTokens: () => 10
    });
    assert.deepEqual(p.poolHealth.unusedInPool, ['Male (男性)', 'Female (女性)']);
    assert.equal(p.poolHealth.unusedInPoolCount, 2);
    assert.equal(p.poolHealth.usedNotInPoolCount, 0, '病娇在池内 ⇒ 不属于「未入池」');
});

test('buildPortrait：已使用但不在池内的标签按使用数降序、带 count', () => {
    const lib = [card('A', ['甲'], 'G'), card('B', ['乙'], 'G'), card('C', ['乙'], 'G')];
    const p = buildPortrait(lib, {
        tagStats: tagStatsOf({ 甲: 1, 乙: 2 }, 3),
        commonTags: ['Male (男性)'],
        estimateCardTokens: () => 10
    });
    assert.equal(p.poolHealth.usedNotInPool[0].tag, '乙');
    assert.equal(p.poolHealth.usedNotInPool[0].count, 2);
    assert.equal(p.poolHealth.usedNotInPool[1].tag, '甲');
});

// ───────── Token ─────────
test('buildPortrait：未勾选 S3（tagStats=null）⇒ 矩阵与池健康都置灰，Token 仍可算', () => {
    const lib = [card('A', ['x'], 'G')];
    const p = buildPortrait(lib, { tagStats: null, commonTags: ['x'], estimateCardTokens: () => 100 });
    assert.equal(p.readiness.matrix, false);
    assert.equal(p.readiness.poolHealth, false);
    assert.equal(p.readiness.tokenStats, true, 'Token 不依赖 S3');
    assert.equal(p.matrix, null);
    assert.equal(p.poolHealth, null);
});

test('★ buildPortrait：传入 tokenSample（S4 已算）时不调用 estimateCardTokens', () => {
    const lib = [card('A', [], 'G'), card('B', [], 'G')];
    let calls = 0;
    const est = () => { calls++; return 999; };
    const p = buildPortrait(lib, { tagStats: null, commonTags: [], estimateCardTokens: est, tokenSample: [100, 300] });
    assert.equal(calls, 0, '有 S4 样本时不得重复遍历');
    assert.equal(p.tokenStats.p50, 200);
    assert.equal(p.tokenStats.reusedFromS4, true);
    assert.equal(p.tokenStats.max, 300);
});

test('buildPortrait：无 tokenSample 时调用 estimateCardTokens', () => {
    const lib = [card('A', [], 'G'), card('B', [], 'G')];
    let calls = 0;
    const est = () => { calls++; return 50; };
    const p = buildPortrait(lib, { tagStats: null, commonTags: [], estimateCardTokens: est });
    assert.equal(calls, 2);
    assert.equal(p.tokenStats.reusedFromS4, false);
    assert.equal(p.tokenStats.p50, 50);
});

test('buildPortrait：tokenSample 长度与库不符 ⇒ 不复用（回退自行计算）', () => {
    const lib = [card('A', [], 'G'), card('B', [], 'G')];
    let calls = 0;
    const p = buildPortrait(lib, { tagStats: null, commonTags: [], estimateCardTokens: () => { calls++; return 7; }, tokenSample: [1] });
    assert.equal(calls, 2);
    assert.equal(p.tokenStats.reusedFromS4, false);
});

test('buildPortrait：估算函数缺失 ⇒ tokenStats 为 null（不用 0 冒充）', () => {
    const lib = [card('A', [], 'G')];
    const p = buildPortrait(lib, { tagStats: null, commonTags: [] });
    assert.equal(p.tokenStats, null);
    assert.equal(p.readiness.tokenStats, false);
});

test('buildPortrait：估算函数抛错时按 0 计，不中断整体', () => {
    const lib = [card('A', [], 'G'), card('B', [], 'G')];
    const est = (c) => { if (c.name === 'A') throw new Error('boom'); return 100; };
    const p = buildPortrait(lib, { tagStats: null, commonTags: [], estimateCardTokens: est });
    assert.equal(p.tokenStats.max, 100);
    assert.equal(p.tokenStats.min, 0);
});

test('buildPortrait：最重列表按 token 降序且长度受 topHeavy 限制', () => {
    const lib = [];
    const sample = [];
    for (let i = 0; i < 30; i++) { lib.push(card(`C${i}`, [], 'G')); sample.push(i * 10); }
    const p = buildPortrait(lib, { tagStats: null, commonTags: [], tokenSample: sample }, { topHeavy: 5 });
    assert.equal(p.tokenStats.heaviest.length, 5);
    assert.equal(p.tokenStats.heaviest[0].tokens, 290);
});

// ───────── Markdown 摘要 ─────────
test('portraitReportLines：三块都有内容时生成对应行', () => {
    const lib = [card('A', ['病娇'], '组1')];
    const p = buildPortrait(lib, {
        tagStats: tagStatsOf({ 病娇: 1 }, 1),
        commonTags: ['Male (男性)'],
        estimateCardTokens: () => 500
    });
    const lines = portraitReportLines(p);
    const text = lines.join('\n');
    assert.ok(text.includes('标签×分组矩阵'));
    assert.ok(text.includes('标签池'));
    assert.ok(text.includes('Token 分位数'));
    assert.ok(text.includes('P50 500'));
});

test('portraitReportLines：池为空时有专门说明', () => {
    const lib = [card('A', ['x'], 'G')];
    const p = buildPortrait(lib, { tagStats: tagStatsOf({ x: 1 }, 1), commonTags: [], estimateCardTokens: () => 1 });
    const text = portraitReportLines(p).join('\n');
    assert.ok(text.includes('空'));
    assert.ok(!text.includes('从未使用 0 个'), '池空时不应给出误导性的 0 计数');
});

test('portraitReportLines：传空对象不抛错', () => {
    assert.deepEqual(portraitReportLines(null), []);
    assert.deepEqual(portraitReportLines({}), []);
});

// ───────── 回归：tagCounts 的两种形态（真实 bug） ─────────
test('★★ buildPortrait：tagCounts 为 Array<[tag,count]>（质检步骤序列化后的形态）时矩阵必须可用', () => {
    const lib = [card('A', ['病娇'], '组1'), card('B', ['病娇'], '组1')];
    // 质检 S3 的 data 经 IPC/returnByValue 后 Map 会变成数组 —— 这里模拟该形态
    const tagStats = { total: 2, tagCounts: [['病娇', 2]] };
    const p = buildPortrait(lib, { tagStats, commonTags: [], estimateCardTokens: () => 10 });
    assert.equal(p.readiness.matrix, true, '数组形态必须被接受，否则就是「S3 跑完却一直提示需要 S3」');
    assert.equal(p.matrix.rows.length, 1);
    assert.equal(p.matrix.rows[0].cells[0], 2);
    assert.equal(p.readiness.poolHealth, true);
});

test('buildPortrait：tagCounts 为 Map 时同样可用（两种形态等价）', () => {
    const lib = [card('A', ['病娇'], '组1')];
    const a = buildPortrait(lib, { tagStats: { tagCounts: new Map([['病娇', 1]]) }, commonTags: [], estimateCardTokens: () => 1 });
    const b = buildPortrait(lib, { tagStats: { tagCounts: [['病娇', 1]] }, commonTags: [], estimateCardTokens: () => 1 });
    assert.deepEqual(a.matrix.rows, b.matrix.rows);
    assert.equal(a.poolHealth.usedNotInPoolCount, b.poolHealth.usedNotInPoolCount);
});

test('buildPortrait：tagCounts 为空数组 ⇒ 置灰（不是「有数据但 0」）', () => {
    const p = buildPortrait([card('A', [], 'G')], { tagStats: { tagCounts: [] }, commonTags: [], estimateCardTokens: () => 1 });
    assert.equal(p.readiness.matrix, false, '空数组无内容 ⇒ 矩阵无行 ⇒ readiness.matrix=false');
    assert.equal(p.readiness.poolHealth, true, '但池健康度仍可算（池里有几个没用过是真实信息）');
});

test('buildPortrait：tagCounts 为非法值（字符串/数字）⇒ 置灰，不抛错', () => {
    for (const bad of ['abc', 123, null, undefined, {}]) {
        const p = buildPortrait([card('A', ['x'], 'G')], { tagStats: { tagCounts: bad }, commonTags: [], estimateCardTokens: () => 1 });
        assert.equal(p.readiness.matrix, false, `tagCounts=${JSON.stringify(bad)} 应置灰`);
    }
});
