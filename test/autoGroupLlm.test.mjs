/**
 * 🤖 自动分组 · LLM 判定层单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LLM_CARD_DESC_LIMIT, LLM_CRITERIA_LIMIT,
    normalizeLlmCriteria, buildLlmGroupSpecs, llmSpecsSignature, llmCardCacheKey,
    llmCardDesc, collectLlmCandidates, buildLlmMessages, parseLlmJudgement, assignJudgements
} from '../js/utils/autoGroupLLM.js';

const card = (name, opts = {}) => ({
    id: opts.id || name, name,
    category: opts.category || '', subFolder: opts.subFolder || '',
    customTags: opts.tags || [],
    data: { description: opts.desc || '', tags: opts.nativeTags || [] }
});

test('normalizeLlmCriteria：trim / 截断 / 非字符串兜底', () => {
    assert.equal(normalizeLlmCriteria('  以支配为核心  '), '以支配为核心');
    assert.equal(normalizeLlmCriteria(null), '');
    assert.equal(normalizeLlmCriteria(123), '');
    assert.equal(normalizeLlmCriteria('x'.repeat(500)).length, LLM_CRITERIA_LIMIT);
});

test('buildLlmGroupSpecs：只收 enabled + 有标准的组；同组合并标准并保序', () => {
    const specs = buildLlmGroupSpecs([
        { group: '纯爱', enabled: true, llmCriteria: '恋爱为主' },
        { group: '催眠', enabled: false, llmCriteria: '不应该出现' },
        { group: 'NTR', enabled: true, llmCriteria: '   ' },            // 空标准 → 剔除
        { group: '', enabled: true, llmCriteria: '无分组 → 剔除' },
        { group: '纯爱', enabled: true, llmCriteria: '不含变心' }        // 同组合并
    ]);
    assert.deepEqual(specs, [{ group: '纯爱', criteria: '恋爱为主；不含变心' }]);
});

test('llmSpecsSignature：稳定；标准变化 → 签名变化（缓存失效）', () => {
    const a = llmSpecsSignature([{ group: 'A', criteria: 'x' }]);
    const b = llmSpecsSignature([{ group: 'A', criteria: 'x' }]);
    const c = llmSpecsSignature([{ group: 'A', criteria: 'y' }]);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(llmSpecsSignature(null), '');
});

test('llmCardCacheKey：同卡不同签名 → 不同 key；无 path 回退 name', () => {
    const k1 = llmCardCacheKey({ name: 'A', path: 'E:/x/A.png' }, 'sig1');
    const k2 = llmCardCacheKey({ name: 'A', path: 'E:/x/A.png' }, 'sig2');
    assert.notEqual(k1, k2);
    assert.equal(llmCardCacheKey({ name: 'A' }, 's'), 'A\u0000s');
});

test('llmCardDesc：折叠空白；前 200 字截断加省略号；无描述为空', () => {
    assert.equal(llmCardDesc(card('A', { desc: '  多\n行   空白  ' })), '多 行 空白');
    assert.equal(llmCardDesc(card('A', { desc: '' })), '');
    const long = '甲'.repeat(300);
    const out = llmCardDesc(card('A', { desc: long }));
    assert.equal(out.length, LLM_CARD_DESC_LIMIT + 1);
    assert.ok(out.endsWith('…'));
});

test('collectLlmCandidates：只收「未命中 / 冲突」，去重、按序、缺卡跳过', () => {
    const cards = [card('甲', { id: 1 }), card('乙', { id: 2 }), card('丙', { id: 3 })];
    const plan = {
        skipped: [
            { cardId: 1, cardName: '甲', reason: '未命中任何启用中的收纳条件' },
            { cardId: 2, cardName: '乙', reason: '已手动分组「催眠」（未勾选「包含已分组」）' },
            { cardId: 99, cardName: '幽灵', reason: '未命中任何启用中的收纳条件' } // 活引用不存在 → 跳过
        ],
        conflicts: [{ cardId: 3, cardName: '丙', winnerGroup: 'A' }, { cardId: 1, cardName: '甲' }] // 1 去重
    };
    const out = collectLlmCandidates({ plan, cards });
    assert.deepEqual(out.map(x => [x.cardName, x.kind]), [['甲', 'unmatched'], ['丙', 'conflict']]);
});

test('buildLlmMessages：契约 + 分组清单 + 卡片行（名称/标签/简介）', () => {
    const msg = buildLlmMessages({
        specs: [{ group: '谷风', criteria: '以压抑氛围为核心' }],
        cards: [card('小甲', { tags: ['aaa'], desc: '简介内容' }), card('小乙')]
    });
    assert.ok(msg.system.includes('assignments'));
    assert.ok(msg.system.includes('JSON'));
    assert.ok(msg.user.includes('- 谷风：判定标准：以压抑氛围为核心'));
    assert.ok(msg.user.includes('1. 小甲｜标签：aaa｜简介：简介内容'));
    assert.ok(msg.user.includes('2. 小乙｜标签：（无）｜简介：（无）'));
});

test('parseLlmJudgement：正常 JSON / 代码块 / 夹带废话均可解析', () => {
    const body = '{"assignments":[{"card":"甲","group":"纯爱","confidence":0.83,"reason":"恋爱主线"}]}';
    for (const raw of [body, '```json\n' + body + '\n```', '好的，结果如下：\n' + body + '\n以上。']) {
        const r = parseLlmJudgement(raw, { validGroups: ['纯爱'], cardNames: ['甲'] });
        assert.equal(r.parseError, '');
        assert.deepEqual(r.assignments[0], { card: '甲', group: '纯爱', confidence: 0.83, reason: '恋爱主线' });
    }
});

test('parseLlmJudgement：非法 JSON / 空文本 → parseError，不抛异常', () => {
    assert.ok(parseLlmJudgement('完全不是 JSON', {}).parseError);
    assert.ok(parseLlmJudgement('', {}).parseError);
    assert.equal(parseLlmJudgement('{}', {}).assignments.length, 0);
});

test('parseLlmJudgement：未知分组 / 未知卡被过滤并单列', () => {
    const raw = JSON.stringify({ assignments: [
        { card: '甲', group: '不存在的组', confidence: 0.9 },
        { card: '幽灵卡', group: '纯爱', confidence: 0.9 },
        { card: '甲', group: '纯爱', confidence: 0.5 }
    ] });
    const r = parseLlmJudgement(raw, { validGroups: ['纯爱'], cardNames: ['甲'] });
    assert.deepEqual(r.assignments.map(a => a.card), ['甲']);
    assert.deepEqual(r.invalidGroups, ['不存在的组']);
    assert.deepEqual(r.unknownCards, ['幽灵卡']);
});

test('parseLlmJudgement：置信度缺失默认 0.6、越界夹紧、同卡取最高', () => {
    const raw = JSON.stringify({ assignments: [
        { card: '甲', group: '纯爱' },
        { card: '甲', group: '纯爱', confidence: 7 },
        { card: '乙', group: '纯爱', confidence: -3 }
    ] });
    const r = parseLlmJudgement(raw, { validGroups: ['纯爱'], cardNames: ['甲', '乙'] });
    const by = Object.fromEntries(r.assignments.map(a => [a.card, a.confidence]));
    assert.equal(by['甲'], 1);      // 0.6 与 7 → 夹紧后 1（取最高）
    assert.equal(by['乙'], 0);      // 负数夹紧为 0
});

test('assignJudgements：同名多卡按出现顺序消费；未知卡跳过', () => {
    const a1 = card('同名'), a2 = card('同名'), b = card('乙');
    const applied = assignJudgements([
        { card: '同名', group: 'X', confidence: 0.9, reason: '' },
        { card: '同名', group: 'Y', confidence: 0.8, reason: '' },
        { card: '不存在', group: 'X', confidence: 0.9, reason: '' }
    ], [a1, a2, b]);
    assert.equal(applied.length, 2);
    assert.equal(applied[0].card, a1);
    assert.equal(applied[1].card, a2);
    assert.deepEqual(applied.map(x => x.group), ['X', 'Y']);
});
