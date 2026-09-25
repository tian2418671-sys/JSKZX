import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCandidatePairs, BUCKET_CAP_KEYS, BUCKET_CAP_NAME, CANDIDATE_CAP,
} from '../js/utils/dedupeBuckets.js';
import { computeMinHash96 } from '../js/utils/dedupeCommon.js';

/** v4 §5 —— 候选层单测（三轨 / 桶上限 / 超限上报） */

const T_A = '她是一位来自昆仑的年轻修士，性格温柔却异常坚定。修炼路上，她始终相信善意会带来回响。'.repeat(4);

const mk = (o) => ({
    id: o.id, path: o.path || `/p/${o.id}`, name: o.name || o.id,
    stemFinal: o.stemFinal || '', fullMinHash: o.fullMinHash || null,
    keyHashes: o.keyHashes || null, keyCount: o.keyHashes ? o.keyHashes.length : 0,
    simhash: o.simhash || null,
});

const collect = (items) => {
    const notices = [];
    const pairs = buildCandidatePairs(items, { report: { notice: (m) => notices.push(String(m)) } });
    return { pairs, notices };
};

test('内容轨：MinHash 相同 → 生成候选对', () => {
    const sig = computeMinHash96(T_A);
    const { pairs } = collect([mk({ id: 'a', fullMinHash: sig }), mk({ id: 'b', fullMinHash: sig })]);
    assert.equal(pairs.length, 1);
});

test('keys 轨：bottom-k 倒排 → 生成候选对', () => {
    const kh = Uint32Array.from([11, 22, 33]);
    const { pairs } = collect([mk({ id: 'a', keyHashes: kh }), mk({ id: 'b', keyHashes: kh })]);
    assert.equal(pairs.length, 1);
});

test('名字轨：stem 2-gram 共享 + nameSim 复核通过 → 候选对', () => {
    const { pairs } = collect([
        mk({ id: 'a', name: '清风明月', stemFinal: '清风明月' }),
        mk({ id: 'b', name: '清风明月改', stemFinal: '清风明月' }),
    ]);
    assert.equal(pairs.length, 1);
});

test('名字轨：共享 2-gram 但 nameSim < 0.5 → 不生成（复核防线）', () => {
    const { pairs } = collect([
        mk({ id: 'a', name: '清风明月光', stemFinal: '清风明月光' }),
        mk({ id: 'b', name: '甲乙明月丁', stemFinal: '甲乙明月丁' }),
    ]);
    assert.equal(pairs.length, 0);
});

test('世界书轨：simhash 粗桶（同桶与相邻桶都生成候选）', () => {
    const { pairs } = collect([
        mk({ id: 'a', simhash: [1, 0x00010001] }),
        mk({ id: 'b', simhash: [2, 0x00010005] }),
    ]);
    assert.equal(pairs.length, 1, '同高 16 位桶应成对');
    const r2 = collect([
        mk({ id: 'c', simhash: [1, 0x00010001] }),
        mk({ id: 'd', simhash: [2, 0x00020002] }),
    ]);
    assert.equal(r2.pairs.length, 1, '相邻桶应成对');
});

test('keys 轨桶超限：>100 跳过并**上报**（禁止静默）', () => {
    const kh = Uint32Array.from([7]);
    const items = [];
    for (let i = 0; i < BUCKET_CAP_KEYS + 1; i++) items.push(mk({ id: `k${i}`, keyHashes: kh }));
    const { pairs, notices } = collect(items);
    assert.equal(pairs.length, 0);
    assert.ok(notices.some((n) => n.includes('keys 轨高频桶跳过')), `缺上报：${notices}`);
});

test('名字轨桶超限：抽样后仍出对并**上报**', () => {
    const items = [];
    for (let i = 0; i < BUCKET_CAP_NAME + 1; i++) items.push(mk({ id: `n${i}`, name: '共同茎段', stemFinal: '共同茎段' }));
    const { pairs, notices } = collect(items);
    assert.ok(notices.some((n) => n.includes('名字轨桶超限')), `缺上报：${notices}`);
    // 抽样 200 → 200×199/2
    assert.equal(pairs.length, (BUCKET_CAP_NAME * (BUCKET_CAP_NAME - 1)) / 2);
    assert.ok(pairs.length < CANDIDATE_CAP);
});

test('三轨合并去重：同一对不重复出现', () => {
    const sig = computeMinHash96(T_A);
    const kh = Uint32Array.from([11, 22]);
    const { pairs } = collect([
        mk({ id: 'a', name: '清风明月', stemFinal: '清风明月', fullMinHash: sig, keyHashes: kh }),
        mk({ id: 'b', name: '清风明月', stemFinal: '清风明月', fullMinHash: sig, keyHashes: kh }),
    ]);
    assert.equal(pairs.length, 1);
});

test('护栏：自身对/重复 id 不产生候选', () => {
    const sig = computeMinHash96(T_A);
    const a = mk({ id: 'same', fullMinHash: sig });
    const { pairs } = collect([a, mk({ id: 'same', fullMinHash: sig })]);
    assert.equal(pairs.length, 0, '相同 id 不得自配');
    const r2 = collect([a]);
    assert.equal(r2.pairs.length, 0);
});
