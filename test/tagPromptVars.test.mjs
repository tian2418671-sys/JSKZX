// 🔗 打标「材料占位符」纯函数单测（批次 C · 方案 v1 §4.1）
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    VAR_DEFS, DOLLAR_ALIASES,
    parseSegmentVars, applySegmentVars, splitPartsByVars, buildVarsFromParts
} from '../js/utils/tagPromptVars.js';

const seg = (content, role = 'user', id = 's1') => ({ id, role, content });

describe('tagPromptVars — 占位符解析', () => {
    it('识别中文别名 / 英文别名 / 容忍内部空格与大小写', () => {
        const r = parseSegmentVars([
            seg('{{材料}} + {{ Pool }} + {{输出 要求}}'),
            seg('{{material}}', 'system', 's2')
        ]);
        assert.deepEqual(r.used, ['material', 'pool', 'output']);
        assert.deepEqual(r.unknown, []);
    });

    it('`$1` 等价 {{材料}}（用户建议的别名）', () => {
        assert.deepEqual(DOLLAR_ALIASES, { '$1': 'material' });
        const r = parseSegmentVars([seg('以下是内容：$1')]);
        assert.deepEqual(r.used, ['material']);
    });

    it('未知占位符 → 收集进 unknown，且不算 used', () => {
        const r = parseSegmentVars([seg('{{材料}} 与 {{随便写的}}')]);
        assert.deepEqual(r.used, ['material']);
        assert.deepEqual(r.unknown, ['随便写的']);
    });

    it('perSegment：逐段列出用到的键（供 UI 打徽标）', () => {
        const r = parseSegmentVars([seg('{{材料}}', 'user', 'a'), seg('无占位符', 'user', 'b'), seg('{{任务说明}}', 'system', 'c')]);
        assert.deepEqual(r.perSegment, [
            { id: 'a', keys: ['material'] },
            { id: 'b', keys: [] },
            { id: 'c', keys: ['task'] }
        ]);
    });

    it('空段 / 非数组 / 缺 content 不抛错', () => {
        assert.deepEqual(parseSegmentVars(null).used, []);
        assert.deepEqual(parseSegmentVars([null, { role: 'user' }]).used, []);
    });

    it('VAR_DEFS：每个逻辑键都有中文别名（用户可读）', () => {
        for (const d of VAR_DEFS) {
            assert.ok(d.key && d.label);
            assert.ok(d.aliases.some((a) => /[\u4e00-\u9fff]/.test(a)), `${d.key} 缺中文别名`);
        }
    });
});

describe('tagPromptVars — 占位符替换（applySegmentVars）', () => {
    it('就地替换 + 返回新数组（不可变更新，原数组不动）', () => {
        const src = [seg('开头\n{{材料}}\n结尾')];
        const r = applySegmentVars(src, { material: '【卡】内容' });
        assert.equal(r.segments[0].content, '开头\n【卡】内容\n结尾');
        assert.equal(src[0].content, '开头\n{{材料}}\n结尾'); // 原数组未被改
        assert.notEqual(r.segments, src);
        assert.equal(r.segments[0].role, 'user'); // 其余字段保留
        assert.equal(r.segments[0].id, 's1');
    });

    it('同一个占位符出现多次 → 每处都替换（不去重）', () => {
        const r = applySegmentVars([seg('{{材料}}|{{材料}}')], { material: 'X' });
        assert.equal(r.segments[0].content, 'X|X');
    });

    it('未知占位符原样保留（绝不吞用户文本）', () => {
        const r = applySegmentVars([seg('{{材料}} + {{未知}}')], { material: 'M' });
        assert.equal(r.segments[0].content, 'M + {{未知}}');
        assert.deepEqual(r.unknown, ['未知']);
    });

    it('缺失的变量按空串（不报错、不留花括号）', () => {
        const r = applySegmentVars([seg('[{{输出要求}}]')], {});
        assert.equal(r.segments[0].content, '[]');
    });

    it('🔒 不递归：替换出来的值里若含占位符，不再展开（防自引用）', () => {
        const r = applySegmentVars([seg('{{材料}}')], { material: '值里带 {{输出要求}} 字样', output: '不该被插入' });
        assert.equal(r.segments[0].content, '值里带 {{输出要求}} 字样');
    });

    it('$1 别名替换 + 与 {{材料}} 可混用', () => {
        const r = applySegmentVars([seg('$1 / {{材料}}')], { material: 'M' });
        assert.equal(r.segments[0].content, 'M / M');
    });

    it('替换只作用于段内容：材料正文里的 {{user}} 不会被当占位符处理也不会被改写', () => {
        // 段里只有 {{材料}}；材料正文自带 {{user}} —— 替换后必须原样保留
        const r = applySegmentVars([seg('{{材料}}')], { material: '你好 {{user}}，这是 {{char}} 的世界' });
        assert.equal(r.segments[0].content, '你好 {{user}}，这是 {{char}} 的世界');
        assert.deepEqual(r.unknown, []); // 材料里的宏不参与解析
    });

    it('空段内容 / 无占位符段 → 原样返回（内容不变）', () => {
        const r = applySegmentVars([seg(''), seg('普通文本', 'system', 's2')], { material: 'M' });
        assert.equal(r.segments[0].content, '');
        assert.equal(r.segments[1].content, '普通文本');
    });
});

describe('tagPromptVars — 材料段分流（splitPartsByVars）', () => {
    const parts = [
        { key: 'task', body: 'T' },
        { key: 'pool', body: 'P' },
        { key: 'output', body: 'O' },
        { key: 'card', body: 'C' }
    ];

    it('compat（默认）：没被占位符引用的全部自动附加（零回归）', () => {
        const r = splitPartsByVars(parts, [], 'compat', 'card');
        assert.deepEqual(r.autoParts.map((p) => p.key), ['task', 'pool', 'output', 'card']);
        assert.deepEqual(r.takenKeys, []);
        assert.deepEqual(r.droppedKeys, []);
    });

    it('被占位符引用 → 该段不再自动附加（接管即抑制）', () => {
        const r = splitPartsByVars(parts, ['material'], 'compat', 'card');
        assert.deepEqual(r.autoParts.map((p) => p.key), ['task', 'pool', 'output']);
        assert.deepEqual(r.takenKeys, ['card']);
    });

    it('世界书视图：`wb` 段归一到逻辑键 material', () => {
        const wbParts = [{ key: 'task', body: 'T' }, { key: 'wb', body: 'W' }];
        const r = splitPartsByVars(wbParts, ['material'], 'compat', 'wb');
        assert.deepEqual(r.autoParts.map((p) => p.key), ['task']);
        assert.deepEqual(r.takenKeys, ['wb']);
    });

    it('semi 档：任务说明 / 输出要求不送，材料与候选池照旧', () => {
        const r = splitPartsByVars(parts, [], 'semi', 'card');
        assert.deepEqual(r.autoParts.map((p) => p.key), ['pool', 'card']);
        assert.deepEqual(r.droppedKeys, ['task', 'output']);
    });

    it('manual 档：一类都不自动附加（全靠占位符）', () => {
        const r = splitPartsByVars(parts, [], 'manual', 'card');
        assert.deepEqual(r.autoParts, []);
        assert.deepEqual(r.droppedKeys, ['task', 'pool', 'output', 'card']);
    });

    it('manual 档 + 占位符接管 → 既不算 dropped 也不算 auto（记 taken）', () => {
        const r = splitPartsByVars(parts, ['task', 'material'], 'manual', 'card');
        assert.deepEqual(r.autoParts, []);
        assert.deepEqual(r.takenKeys, ['task', 'card']);
        assert.deepEqual(r.droppedKeys, ['pool', 'output']);
    });

    it('非数组 / 空 parts 安全', () => {
        assert.deepEqual(splitPartsByVars(null, [], 'compat').autoParts, []);
        assert.deepEqual(splitPartsByVars([], ['material'], 'semi').autoParts, []);
    });
});

describe('tagPromptVars — 变量表（buildVarsFromParts）', () => {
    it('卡片视图：material = card 段；候选池可从 extra 回退', () => {
        const v = buildVarsFromParts({
            parts: [{ key: 'task', body: 'T' }, { key: 'extra', body: 'E' }, { key: 'card', body: 'C' }],
            kind: 'card',
            jailbreak: 'JB'
        });
        assert.equal(v.material, 'C');
        assert.equal(v.card, 'C');
        assert.equal(v.wb, '');
        assert.equal(v.pool, 'E');   // 池关时「候选池」占位符回退到附加要求
        assert.equal(v.extra, 'E');
        assert.equal(v.task, 'T');
        assert.equal(v.jailbreak, 'JB');
    });

    it('世界书视图：material = wb 段', () => {
        const v = buildVarsFromParts({ parts: [{ key: 'wb', body: 'W' }], kind: 'wb' });
        assert.equal(v.material, 'W');
        assert.equal(v.card, '');
    });

    it('缺 parts / 缺 jailbreak → 全空串（不抛错）', () => {
        const v = buildVarsFromParts({});
        assert.equal(v.material, '');
        assert.equal(v.jailbreak, '');
    });
});
