import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fnv1a32, exactTextKey, computeMinHash96, estimateMinHashSimilarity,
    normKey, keysToHashes, keysJaccard,
    cardDataOf, extractCardFullText, extractCardCoreText, cardBookEntries, extractCardKeys,
    promptsOf, countPrompts, extractPresetText,
} from '../js/utils/dedupeCommon.js';

/** v4 §13 —— 通用工具单测（哈希 / MinHash / keys / 三库提取） */

// ── 哈希 ─────────────────────────────────────────────────────

test('fnv1a32：确定性与分布基本性质', () => {
    assert.equal(fnv1a32('abc'), fnv1a32('abc'));
    assert.notEqual(fnv1a32('abc'), fnv1a32('abd'));
    assert.ok(fnv1a32('') >>> 0 === 0x811c9dc5);
});

test('exactTextKey：64 位键（16 hex）、相同文本同键、不同文本不同键', () => {
    const k1 = exactTextKey('一段用于指纹的文本');
    const k2 = exactTextKey('一段用于指纹的文本');
    const k3 = exactTextKey('一段用于指纹的文本 ');
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
    assert.match(k1, /^[0-9a-f]{16}$/);
});

// ── MinHash-96 ───────────────────────────────────────────────

test('MinHash：自身相似度 = 1；无关文本近似 0', () => {
    const A = '她是一位温柔而坚定的修行者，行走于群山之间，心底藏着对世界的好奇与善意。'.repeat(4);
    const U = '这是一台老式蒸汽机车，锅炉的轰鸣声在旷野中回荡，司机检查了每一个阀门。'.repeat(4);
    assert.equal(estimateMinHashSimilarity(computeMinHash96(A), computeMinHash96(A)), 1);
    const j = estimateMinHashSimilarity(computeMinHash96(A), computeMinHash96(U));
    assert.ok(j !== null && j < 0.2, `无关文本 J 过高：${j}`);
});

test('MinHash 回归哨兵：**同源微改**必须保持高相似（锁定采样修复）', () => {
    // 历史缺陷（2026-09-25 校准抓获）：曾用「排序后等距抽样」→ 同源微改 J≈0.04（几乎零相似）。
    // 修复为「确定性哈希采样」后，本对样本 J≈0.75。断言下限 0.5（留容量，但对 0.04 级别缺陷是碾压式拦截）。
    const A = '她是一位来自昆仑的年轻修士，性格温柔却异常坚定。修炼路上，她始终相信善意会带来回响。面对险境，她从不退缩，总在关键时刻挺身而出。'.repeat(4);
    const B = A + '在漫长旅途中，她学会了用笑容面对孤独，用剑意回应质疑。';
    const j = estimateMinHashSimilarity(computeMinHash96(A), computeMinHash96(B));
    assert.ok(j !== null && j > 0.5, `同源微改 J 异常：${j}（若低于 0.5 说明采样/口径退化）`);
});

test('MinHash：签名长度 96、确定性、过短文本 → 无效（null 语义，不得静默当 0）', () => {
    const sig = computeMinHash96('一段足够长的文本内容用于生成签名');
    assert.equal(sig.length, 96);
    assert.deepEqual([...sig], [...computeMinHash96('一段足够长的文本内容用于生成签名')]);
    assert.equal(estimateMinHashSimilarity(computeMinHash96('ab'), computeMinHash96('ab')), null);
    assert.equal(estimateMinHashSimilarity(null, sig), null);
    assert.equal(estimateMinHashSimilarity(sig, null), null);
});

// ── keys ─────────────────────────────────────────────────────

test('keysToHashes：规范化去重升序；keysJaccard：精确值与 null 语义', () => {
    const a = keysToHashes([' 甲 ', '甲', '乙', '丙']);
    assert.equal(a.length, 3);
    for (let i = 1; i < a.length; i++) assert.ok(a[i - 1] < a[i], '必须升序去重');
    assert.equal(keysJaccard(a, keysToHashes(['甲', '乙', '丙'])), 1);
    // [甲,乙,丙] vs [甲,乙,丙,丁,戊,己]：inter=3, uni=6 → 0.5
    assert.equal(keysJaccard(keysToHashes(['甲', '乙', '丙']), keysToHashes(['甲', '乙', '丙', '丁', '戊', '己'])), 0.5);
    assert.equal(keysJaccard(keysToHashes(['甲']), keysToHashes(['乙'])), 0);
    assert.equal(keysJaccard(new Uint32Array(0), a), null);
    assert.equal(keysJaccard(a, null), null);
});

test('normKey：trim + lower + NFC（⚠️ 无 NFKC — 与 main.js normalizeWbKey 逐字对齐，不得单方面「优化」）', () => {
    assert.equal(normKey('  AbC  '), 'abc');
    // 全角不被折叠（main.js 口径如此；改了会与已落盘 keyHashes 失去可比性）
    assert.equal(normKey('ＡＢＣ'), 'ａｂｃ');
});

// ── 三库提取 ─────────────────────────────────────────────────

test('cardDataOf：DF-17 双形态（item.data.data 优先）', () => {
    const inner = { description: 'x' };
    assert.equal(cardDataOf({ data: inner }), inner);
    assert.equal(cardDataOf({ data: { data: inner, name: '外' } }), inner);
    assert.equal(cardDataOf({}), null);
    assert.equal(cardDataOf(null), null);
});

test('extractCardFullText：全字段池 + alternate_greetings + 内嵌书（数组/字典双形态）', () => {
    const data = {
        description: '描述文本',
        personality: '性格文本',
        first_mes: '开场文本',
        alternate_greetings: ['备选开场一'],
        character_book: { entries: [{ content: '词条正文A' }, { content: '词条正文B' }] },
    };
    const t = extractCardFullText(data);
    for (const piece of ['描述文本', '性格文本', '开场文本', '备选开场一', '词条正文A', '词条正文B']) {
        assert.ok(t.includes(piece), `缺少字段：${piece}`);
    }
    // 字典形态
    const t2 = extractCardFullText({ character_book: { entries: { a: { content: '字典形态词条' } } } });
    assert.ok(t2.includes('字典形态词条'));
    assert.equal(extractCardFullText(null), '');
});

test('extractCardCoreText：仅核心 5 字段（不含词条）', () => {
    const t = extractCardCoreText({ description: 'D', first_mes: 'F', creator_notes: '不应出现', character_book: { entries: [{ content: '不应出现词条' }] } });
    assert.ok(t.includes('D') && t.includes('F'));
    assert.ok(!t.includes('不应出现'));
});

test('cardBookEntries / extractCardKeys：key 与 keys 全形态（DF-19）', () => {
    const data = {
        character_book: {
            entries: [
                { key: ['甲', '乙'] },
                { keys: ['丙'] },
                { key: '丁', keys: ['戊'] },
            ],
        },
    };
    assert.equal(cardBookEntries(data).length, 3);
    const keys = extractCardKeys(data);
    for (const k of ['甲', '乙', '丙', '丁', '戊']) assert.ok(keys.includes(k), `缺触发词：${k}`);
});

test('promptsOf / countPrompts / extractPresetText：数组与字典双形态', () => {
    assert.equal(countPrompts({ prompts: [{ content: 'a' }, { content: 'b' }] }), 2);
    assert.equal(countPrompts({ prompts: { x: { content: 'a' } } }), 1);
    assert.equal(extractPresetText({ prompts: [{ content: '甲' }, { content: '乙' }] }), '甲\n乙');
    assert.equal(extractPresetText({}), '');
    assert.deepEqual(promptsOf(null), []);
});
