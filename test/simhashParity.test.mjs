import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSimhash64, simhashInputOf, hammingDistance64 } from '../js/utils/simhash64.mjs';

/**
 * v4 §12 —— simhash **行为锁定测试（golden vectors）**
 *
 * 为什么用固定向量：simhash 是世界书 L1 的落盘口径（`main.js` 的 `simhash` 字段），
 * 任何输出变化都会让**已落盘数据失去可比性**（历史事故教训：口径漂移 = 同库两次结果不同）。
 *
 * ⚠️ 向量的含义（诚实声明）：由 2026-09-25 从 main.js **逐字搬移**后的权威实现生成，
 *    用于锁定行为；若实现需要「优化」，必须先论证并同步全部标定（T=16 等）。
 */

const VECTORS = [
    ['', [0, 0]],
    ['a', [0, 0]],
    ['ab', [0, 0]],
    ['abc', [0, 0]],
    ['abcd', [3459545533, 4292565899]],
    ['abcde', [3459545533, 4292565899]],
    ['测试文本abc', [2944285142, 1443129828]],
    ['Hello World 123', [4131701766, 1445750768]],
    ['🌸🎐 混合 emoji 与文字 42', [1752771856, 2141178466]],
    ['line one\nline two\nline three', [2644318513, 1701610963]],
    ['重复重复重复重复重复重复重复重复重复重复', [2168303601, 3120077599]],
    ['a'.repeat(300), [1290481081, 1791175911]],
    ['很长的一段中文文本'.repeat(80), [1204215199, 789547181]],
    ['The quick brown fox jumps over the lazy dog. 0123456789', [1061254147, 2231322669]],
];

test('simhash：14 组 golden vectors 全部一致（锁定 L1 落盘口径）', () => {
    for (const [text, expected] of VECTORS) {
        assert.deepEqual(computeSimhash64(text), expected, `输入: ${JSON.stringify(text.slice(0, 30))}`);
    }
});

test('simhash：确定性（两次调用结果相同）与边界（空/未定义）', () => {
    const t = '确定性检定的文本'.repeat(30);
    assert.deepEqual(computeSimhash64(t), computeSimhash64(t));
    assert.deepEqual(computeSimhash64(''), [0, 0]);
    assert.deepEqual(computeSimhash64('xxxx'), computeSimhash64('xxxx'));
});

test('simhashInputOf：归一化口径（key + content 拼接 → 小写/去标点/折叠空白）', () => {
    assert.equal(simhashInputOf([]), '');
    assert.equal(simhashInputOf([{ key: 'alpha', content: '正文一' }]), 'alpha 正文一');
    assert.equal(simhashInputOf([{ key: ['a', 'b'], content: 'ABC' }, { key: 'c', content: 'def' }]), 'a b abc c def');
    assert.equal(simhashInputOf([{ key: '只有键' }]), '只有键');
    assert.equal(simhashInputOf([{ content: '只有正文' }]), '只有正文');
    // main.js 口径：只读 `e.key`（不读 `e.keys`）——数组形态等价
    assert.equal(simhashInputOf([{ keys: ['复数形态的键'], content: 'X' }]), 'x');
    assert.equal(simhashInputOf([null, { key: 'k1', content: 'C1' }, 42, { key: 'k2' }]), 'k1 c1 k2');
});

test('hammingDistance64：0 / 64 / 中点与缺失输入', () => {
    assert.equal(hammingDistance64([1, 2], [1, 2]), 0);
    assert.equal(hammingDistance64([0, 0], [0xffffffff, 0xffffffff]), 64);
    assert.equal(hammingDistance64([0, 0], [0xff, 0]), 8);
    assert.equal(hammingDistance64(null, [1, 2]), 64);
    assert.equal(hammingDistance64([1], [1, 2]), 64);
});

test('打包白名单：js/utils/simhash64.mjs 必须随包分发（main.js require 依赖）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(Array.isArray(pkg.build && pkg.build.files), 'package.json build.files 缺失');
    assert.ok(pkg.build.files.includes('js/utils/simhash64.mjs'), 'build.files 必须包含 js/utils/simhash64.mjs');
});
