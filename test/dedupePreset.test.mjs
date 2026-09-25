import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPresetStructure, setJaccard, sameSampler, pickPresetSimType, presetViewStats, contentTier,
    STRUCT_HIGH, CONTENT_HIGH, CONTENT_LOW, PRESET_TYPE_META, PRESET_PARAM_FIELDS,
} from '../js/utils/dedupePreset.js';
import { computeMinHash96 } from '../js/utils/dedupeCommon.js';

/** v4 §3.3 / §9.2 / §9.3 —— 预设结构统计与五枚举判定单测 */

const mkCenter = (over = {}) => ({
    identifierSet: new Set(['a', 'b', 'c', 'd']),
    identifierSeq: ['a', 'b', 'c', 'd'].join('\u0001'),
    enabledRatio: 1,
    sampler: { temperature: 0.8, max_tokens: 512 },
    fullMinHash: null,
    ...over,
});

test('buildPresetStructure：数组形态（seq/set/enabledRatio/sampler）', () => {
    const s = buildPresetStructure({
        prompts: [
            { identifier: 'main', content: 'x' },
            { identifier: 'jail', content: 'y', enabled: false },
        ],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'jail', enabled: false }] }],
        temperature: 0.9,
        top_k: 0,
    });
    assert.deepEqual([...s.identifierSet].sort(), ['jail', 'main']);
    assert.equal(s.enabledRatio, 0.5);
    assert.deepEqual(s.sampler, { temperature: 0.9, top_k: 0 });
});

test('buildPresetStructure：字典形态 + 无名块回退编号 + 多组 prompt_order 取覆盖最多（不写死 character_id）', () => {
    const s = buildPresetStructure({
        prompts: { p1: 'a', p2: 'b', p3: 'c' },
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'p1', enabled: true }] },
            { character_id: 100001, order: [{ identifier: 'p1', enabled: true }, { identifier: 'p2', enabled: false }, { identifier: 'p3', enabled: true }] },
        ],
    });
    assert.equal(s.identifierSet.size, 3);
    // 取覆盖最多组（3 条：2 启用 / 3）→ 2/3
    assert.ok(Math.abs(s.enabledRatio - 2 / 3) < 1e-9, `enabledRatio=${s.enabledRatio}`);
    // 无 identifier 的数组块 → 编号回退
    const s2 = buildPresetStructure({ prompts: [{ content: '无标识' }] });
    assert.deepEqual([...s2.identifierSet], ['#0']);
});

test('setJaccard：null 语义（空集不静默当 0）与精确值', () => {
    assert.equal(setJaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(setJaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
    assert.equal(setJaccard(new Set(), new Set(['a'])), null);
    assert.equal(setJaccard(null, new Set(['a'])), null);
});

test('sameSampler：键集合与值都要一致', () => {
    assert.equal(sameSampler({ a: 1 }, { a: 1 }), true);
    assert.equal(sameSampler({ a: 1 }, { a: 2 }), false);
    assert.equal(sameSampler({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(sameSampler({}, {}), true);
});

test('pickPresetSimType：五枚举逐项', () => {
    const center = mkCenter();
    // sampler：参数不同
    assert.equal(pickPresetSimType(center, mkCenter({ sampler: { temperature: 1.0, max_tokens: 512 } })), 'sampler');
    // flipped：启用比例不同（其他同）
    assert.equal(pickPresetSimType(center, mkCenter({ enabledRatio: 0.5 })), 'flipped');
    // reorder：集合同、顺序不同
    assert.equal(pickPresetSimType(center, mkCenter({
        identifierSeq: ['d', 'c', 'b', 'a'].join('\u0001'),
        identifierSet: new Set(['a', 'b', 'c', 'd']),
    })), 'reorder');
    // reskin：结构一致 + 顺序一致（内容差异交给内容证据/展示）
    assert.equal(pickPresetSimType(center, mkCenter()), 'reskin');
    // different：结构不一致
    assert.equal(pickPresetSimType(center, mkCenter({
        identifierSet: new Set(['x', 'y', 'z']),
        identifierSeq: ['x', 'y', 'z'].join('\u0001'),
    })), 'different');
});

test('pickPresetSimType：emptyRatio 为 null 或空集时不误判 flipped/different', () => {
    const c = mkCenter({ enabledRatio: null });
    const m = mkCenter({ enabledRatio: null });
    assert.equal(pickPresetSimType(c, m), 'reskin', '双 null 不得误判 flipped');
    const j = setJaccard(mkCenter({ identifierSet: new Set() }).identifierSet, new Set(['a']));
    assert.equal(j, null);
});

test('presetViewStats：三维数值与缺数据 null', () => {
    const ml = '提示词正文样本内容。'.repeat(10);
    const c = mkCenter({ fullMinHash: computeMinHash96(ml), enabledRatio: 1 });
    const m = mkCenter({ fullMinHash: computeMinHash96(ml), enabledRatio: 0.75, identifierSet: new Set(['a', 'b', 'c', 'x']) });
    const s = presetViewStats(c, m);
    assert.equal(s.structPct, 60, `结构 3/5：${s.structPct}`); // inter3/(4+4-3)=3/5
    assert.equal(s.contentPct, 100);
    assert.equal(s.enabledPct, 75);
    // fullMinHash null（空文本）→ contentPct null（不得静默当 0）
    assert.equal(presetViewStats(c, mkCenter()).contentPct, null);
});

test('contentTier：保守档阈值分档 + META 白名单覆盖', () => {
    assert.equal(contentTier(95), 'high');
    assert.equal(contentTier(80), 'mid');
    assert.equal(contentTier(10), 'low');
    assert.equal(contentTier(null), null);
    assert.equal(STRUCT_HIGH, 0.95);
    assert.equal(CONTENT_HIGH, 0.90);
    assert.equal(CONTENT_LOW, 0.70);
    // 五枚举展示元数据齐全（弹窗从 meta 取 label/tone/advice）
    for (const k of ['sampler', 'reorder', 'flipped', 'reskin', 'different']) {
        assert.ok(PRESET_TYPE_META[k], `缺元数据：${k}`);
    }
    assert.ok(PRESET_PARAM_FIELDS.length >= 8);
});
