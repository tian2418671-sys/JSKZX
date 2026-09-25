/**
 * compileAutoTagRules 关闭清单单元测试（P1 打标三层开关）
 * 规格：`docs/规格与计划/AI打标/打标三层开关-P1实现规格.md` §5.2
 *
 * 三条硬约束（改这个函数时别破坏）：
 *   1. 旧签名（单参数）行为**完全不变** → 老配置/老调用零迁移
 *   2. 关闭清单**只作用于内置规则** —— 同名自定义规则仍生效
 *   3. 逐条 try/catch 语义不变（单条非法不拖垮整表）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { compileAutoTagRules, defaultAutoTagRules } from '../js/utils/cardLoader.js';

test('旧签名（单参数）→ 内置规则全量生效（零破坏回归）', () => {
    const rules = compileAutoTagRules(null);
    assert.strictEqual(Object.keys(rules).length, defaultAutoTagRules.length);
    for (const r of defaultAutoTagRules) {
        assert.ok(rules[r.name] instanceof RegExp, `${r.name} 应存在且为正则`);
    }
});

test('关闭清单生效：只剔除指定内置规则，其余不动', () => {
    const rules = compileAutoTagRules(null, ['NSFW (限制级)']);
    assert.strictEqual(rules['NSFW (限制级)'], undefined);
    assert.strictEqual(Object.keys(rules).length, defaultAutoTagRules.length - 1);
    assert.ok(rules['Fantasy (奇幻)'] instanceof RegExp);
});

test('关闭清单支持多条', () => {
    const off = ['NSFW (限制级)', '青梅竹马', '主仆/女仆'];
    const rules = compileAutoTagRules(null, off);
    for (const name of off) assert.strictEqual(rules[name], undefined);
    assert.strictEqual(Object.keys(rules).length, defaultAutoTagRules.length - off.length);
});

test('关闭清单不作用于自定义规则（同名自定义仍生效，且覆盖内置版本）', () => {
    const custom = [{ name: 'NSFW (限制级)', regex: '自定义标记词' }];
    const rules = compileAutoTagRules(custom, ['NSFW (限制级)']);
    assert.ok(rules['NSFW (限制级)'] instanceof RegExp);
    assert.ok(rules['NSFW (限制级)'].test('含自定义标记词的文本'));
    // 内置版本的正则（nsfw|18\+|r18|色情|淫乱）不应再生效
    assert.ok(!rules['NSFW (限制级)'].test('nsfw'));
});

test('关闭清单含不存在名字 / 非字符串 / 空白 → 不抛错，结果与全开一致', () => {
    const base = Object.keys(compileAutoTagRules(null)).sort();
    const rules = compileAutoTagRules(null, ['不存在的规则', '', '   ', null, 12, undefined, {}]);
    assert.deepStrictEqual(Object.keys(rules).sort(), base);
});

test('关闭清单的 name 前后空白容错', () => {
    const rules = compileAutoTagRules(null, ['  NSFW (限制级)  ']);
    assert.strictEqual(rules['NSFW (限制级)'], undefined);
});

test('关闭清单按 name 精确匹配（大小写敏感，不做模糊匹配）', () => {
    const rules = compileAutoTagRules(null, ['nsfw (限制级)']);
    assert.ok(rules['NSFW (限制级)'] instanceof RegExp, '大小写不一致不应命中关闭');
});

test('非法自定义正则只跳过该条，不拖垮整表（既有逐条 try/catch 语义）', () => {
    const rules = compileAutoTagRules([
        { name: '坏规则', regex: '([unclosed' },
        { name: '好规则', regex: 'ok' }
    ]);
    assert.strictEqual(rules['坏规则'], undefined);
    assert.ok(rules['好规则'] instanceof RegExp);
});

test('空自定义数组 + 空关闭清单 → 结果等于内置全量', () => {
    const a = Object.keys(compileAutoTagRules([], [])).sort();
    const b = Object.keys(compileAutoTagRules(null)).sort();
    assert.deepStrictEqual(a, b);
});
