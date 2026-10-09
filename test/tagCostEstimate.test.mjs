/**
 * 💰 打标成本预估 单测（`js/utils/tagCostEstimate.js`）
 *
 * 重点不是"函数能跑"，而是**数字对不对**：
 *   · 用 2026-10-03 的真实 API 实验数据校准（114 请求 / 408,994 字 → 264,094 prompt tokens = 0.646 token/字）
 *   · 用真实库实测的"96 万字重书 + cap40"黄金值对照（实发 115,421 字 / 40 请求）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    estimateRealTokens, estimateWbCost, estimateCardCost,
    stripMaterialPrefix, REAL_TOKENS_PER_CJK,
    WB_MATERIAL_PREFIX, CARD_MATERIAL_PREFIX
} from '../js/utils/tagCostEstimate.js';
import { estimateTokens } from '../js/utils/tokenEstimate.js';

// ─────────── 口径 ───────────
test('estimateRealTokens：纯中文按 0.65/字', () => {
    assert.equal(estimateRealTokens('字'.repeat(1000)), 650);
    assert.equal(REAL_TOKENS_PER_CJK, 0.65);
});

test('estimateRealTokens：中英混排分别计权，且**不截断**（对比保守估算器）', () => {
    const t = '汉字'.repeat(500) + ' ' + 'hello world foo';
    assert.equal(estimateRealTokens(t), Math.ceil(1000 * 0.65 + 3 * 1.3));
    // 30 万汉字：保守估算器会截断到 20 万（少报），实测口径不截断
    const big = '字'.repeat(300000);
    assert.equal(estimateRealTokens(big), 195000);
    assert.equal(estimateTokens(big), 300000); // 1.5 × 20 万（被截断）→ 恰好说明两者用途不同
    assert.ok(estimateRealTokens(big) < estimateTokens(big));
});

test('★ 校准：真实实验的 408,994 字 → 264,094 token，估算误差 ≤ 15%', () => {
    // 实验实测：114 请求，材料+固定开销合计 408,994 字 → prompt 264,094 tokens（0.646 token/字）
    const measuredChars = 408994;
    const measuredTokens = 264094;
    const est = estimateRealTokens('字'.repeat(measuredChars)); // 全中文近似（实验材料以中文为主）
    const err = Math.abs(est - measuredTokens) / measuredTokens;
    assert.ok(err <= 0.15, `估算 ${est} vs 实测 ${measuredTokens}，误差 ${(err * 100).toFixed(1)}% 应 ≤15%`);
});

// ─────────── 前缀剥离 ───────────
test('stripMaterialPrefix：世界书 / 卡片两种前缀都能剥掉，其他原样返回', () => {
    assert.equal(stripMaterialPrefix(WB_MATERIAL_PREFIX + '书名：X'), '书名：X');
    assert.equal(stripMaterialPrefix(CARD_MATERIAL_PREFIX + '名字：Y'), '名字：Y');
    assert.equal(stripMaterialPrefix('用户自定义覆盖文本'), '用户自定义覆盖文本');
    assert.equal(stripMaterialPrefix(null), '');
});

// ─────────── 世界书：分段 / 采样 / 覆盖度 ───────────
test('世界书：小书单请求、覆盖 100%', () => {
    const r = estimateWbCost({ targets: [{ label: 'A', material: '字'.repeat(3000) }], fixedText: '固'.repeat(500), segmentMax: 40 });
    assert.equal(r.requests, 1);
    assert.equal(r.sentChars, 3000);
    assert.equal(r.coverage, 1);
    assert.equal(r.heavy.length, 0);
    assert.equal(r.promptTokens, estimateRealTokens('字'.repeat(3000)) + estimateRealTokens('固'.repeat(500)));
});

test('★ 世界书：96 万字重书 + cap40 → 40 请求、采样后实发 ≈ 全书 12%（与真实库实测一致）', () => {
    // 真实库实测：炎孕 960,877 字 / 333 段 / cap40 → 实发 115,421 字（12.0%）
    const material = '字'.repeat(960877);
    const r = estimateWbCost({ targets: [{ label: '炎孕', material }], fixedText: '', segmentMax: 40 });
    assert.equal(r.requests, 40);
    assert.equal(r.totalChars, 960877);
    assert.ok(Math.abs(r.coverage - 0.12) < 0.03, `覆盖率 ${(r.coverage * 100).toFixed(1)}% 应≈12%`);
    assert.equal(r.heavy.length, 1);
    assert.equal(r.heavy[0].label, '炎孕');
});

test('世界书：上限越小请求越少、覆盖越低（单调）', () => {
    const material = '字'.repeat(300000);
    const a = estimateWbCost({ targets: [{ label: 'x', material }], fixedText: '', segmentMax: 5 });
    const b = estimateWbCost({ targets: [{ label: 'x', material }], fixedText: '', segmentMax: 40 });
    assert.equal(a.requests, 5);
    assert.equal(b.requests, 40);
    assert.ok(a.promptTokens < b.promptTokens);
    assert.ok(a.coverage < b.coverage);
});

test('世界书：多目标汇总请求数与覆盖度', () => {
    const r = estimateWbCost({
        targets: [
            { label: '小', material: '字'.repeat(3000) },
            { label: '大', material: '字'.repeat(400000) }
        ],
        fixedText: '', segmentMax: 20
    });
    assert.equal(r.requests, 1 + 20);
    assert.equal(r.totalChars, 403000);
    assert.equal(r.targets, 2);
    assert.ok(r.coverage > 0 && r.coverage < 1);
});

// ─────────── 卡片：打包 / 长卡分段 ───────────
test('卡片：packSize=1 → 一卡一请求', () => {
    const r = estimateCardCost({ targets: [1, 2, 3].map((i) => ({ label: 'c' + i, material: '字'.repeat(200) })), fixedText: '', packSize: 1 });
    assert.equal(r.requests, 3);
    assert.equal(r.packedUnits, 0);
});

test('卡片：短卡按 packSize 成组（5 张 + packSize3 → 2 请求）', () => {
    const targets = [1, 2, 3, 4, 5].map((i) => ({ label: 'c' + i, material: '字'.repeat(200) }));
    const r = estimateCardCost({ targets, fixedText: '', packSize: 3 });
    assert.equal(r.requests, 2);
    assert.equal(r.packedUnits, 2);
});

test('卡片：长卡（>1200 估算 token）不参与打包，单独成单元', () => {
    const short = { label: '短', material: '字'.repeat(200) };
    const long = { label: '长', material: '字'.repeat(2000) }; // 2000×1.5 = 3000 > 1200
    const r = estimateCardCost({ targets: [short, long, short], fixedText: '', packSize: 3 });
    // [短] 缓冲 → 遇长卡 flush → [长] → [短] ⇒ 3 个单元
    assert.equal(r.requests, 3);
});

test('卡片：超 4000 字的单卡会分段（请求数 = 段数）', () => {
    const r = estimateCardCost({ targets: [{ label: '巨大卡', material: '字'.repeat(20000) }], fixedText: '', packSize: 1 });
    assert.ok(r.requests > 1, '应分段为多个请求');
    assert.equal(r.segmentedCards, 1);
    assert.equal(r.coverage, 1); // 卡片分段不丢内容
    assert.equal(r.heavy.length, 1);
});

test('卡片：覆盖度恒为 100%（卡片不做采样截断）', () => {
    const r = estimateCardCost({ targets: [{ label: 'a', material: '字'.repeat(5000) }], fixedText: '', packSize: 1 });
    assert.equal(r.coverage, 1);
    assert.equal(r.sentChars, r.totalChars);
});

test('固定开销按请求数重复计费（打包的省钱效果体现在这里）', () => {
    const targets = [1, 2, 3, 4].map((i) => ({ label: 'c' + i, material: '字'.repeat(200) }));
    const fixed = '固'.repeat(5000);
    const p1 = estimateCardCost({ targets, fixedText: fixed, packSize: 1 });
    const p4 = estimateCardCost({ targets, fixedText: fixed, packSize: 4 });
    assert.equal(p1.requests, 4);
    assert.equal(p4.requests, 1);
    assert.ok(p4.promptTokens < p1.promptTokens, '打包后固定开销只付一次 ⇒ token 更少');
});
