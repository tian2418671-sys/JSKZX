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

// 🌍 AI-20（2026-10-04）：卡内嵌世界书（`character_book`）也能被 {{世界书}} 引用 ——
//   用户实测「无法引用世界书的内容，是空的」。
describe('tagPromptVars — 卡内嵌世界书（AI-20）', () => {
    it('`{{世界书}}` 在没有库世界书段时**回退**到卡内嵌世界书段（卡片视图）', () => {
        const parts = [
            { key: 'card', body: 'CARD' },
            { key: 'embeddedWb', body: 'EMBEDDED', optional: true }
        ];
        const v = buildVarsFromParts({ parts, kind: 'card' });
        assert.equal(v.wb, 'EMBEDDED');            // 修复点：以前恒为 ''
        assert.equal(v.embeddedWb, 'EMBEDDED');
        assert.equal(v.material, 'CARD');
    });

    it('库世界书段存在时**优先**用它（卡片视图下若同时给了 wb 段）', () => {
        const v = buildVarsFromParts({
            parts: [{ key: 'wb', body: 'LIB' }, { key: 'embeddedWb', body: 'EMBEDDED' }],
            kind: 'card'
        });
        assert.equal(v.wb, 'LIB');
        assert.equal(v.embeddedWb, 'EMBEDDED');
    });

    it('世界书视图：`{{世界书}}` = 当前那本书（不回退、不受 embeddedWb 影响）', () => {
        const v = buildVarsFromParts({ parts: [{ key: 'wb', body: 'LIB' }], kind: 'wb' });
        assert.equal(v.material, 'LIB');
        assert.equal(v.wb, 'LIB');
    });

    it('内嵌世界书命中：段里写 `{{世界书}}` ⇒ 替换成卡内嵌书材料（非空）', () => {
        const parts = [{ key: 'card', body: 'CARD' }, { key: 'embeddedWb', body: '\n\n【卡内嵌世界书材料】\n书名：X', optional: true }];
        const vars = buildVarsFromParts({ parts, kind: 'card' });
        const r = applySegmentVars([seg('参考世界书：\n{{世界书}}\n再看卡：\n{{卡片}}')], vars);
        assert.ok(r.segments[0].content.includes('【卡内嵌世界书材料】'));
        assert.equal(r.used.includes('wb'), true);
        assert.equal(r.unknown.length, 0);
    });

    it('`{{卡内世界书}}` 显式别名：解析成 embeddedWb 且能取到值', () => {
        const r = parseSegmentVars([seg('{{卡内世界书}}')]);
        assert.deepEqual(r.used, ['embeddedWb']);
        const vars = buildVarsFromParts({ parts: [{ key: 'embeddedWb', body: 'EMB', optional: true }], kind: 'card' });
        assert.equal(applySegmentVars([seg('{{卡内世界书}}')], vars).segments[0].content, 'EMB');
    });

    it('库世界书命中（世界书视图）：`{{世界书}}` 替换成库书材料', () => {
        const vars = buildVarsFromParts({ parts: [{ key: 'wb', body: 'LIB_BODY' }], kind: 'wb' });
        assert.equal(applySegmentVars([seg('{{世界书}}')], vars).segments[0].content, 'LIB_BODY');
    });

    it('两者都没有 ⇒ 空串**且不报错**（占位符被替换成空、不进 unknown）', () => {
        const vars = buildVarsFromParts({ parts: [{ key: 'card', body: 'CARD' }], kind: 'card' });
        const r = applySegmentVars([seg('[{{世界书}}]')], vars);
        assert.equal(r.segments[0].content, '[]');
        assert.deepEqual(r.unknown, []);
        assert.deepEqual(r.used, ['wb']);
    });

    it('splitPartsByVars：`optional` 段**只有被引用才发送**（未引用既不算 auto 也不算 dropped）', () => {
        const parts = [
            { key: 'task', body: 'T' },
            { key: 'card', body: 'C' },
            { key: 'embeddedWb', body: 'EMB', optional: true }
        ];
        // 未引用 ⇒ 不发送（autoParts 里没有它），且不当成"档位不送"
        const r1 = splitPartsByVars(parts, [], 'compat', 'card');
        assert.deepEqual(r1.autoParts.map((p) => p.key), ['task', 'card']);
        assert.deepEqual(r1.takenKeys, []);
        assert.deepEqual(r1.optionalKeys, ['embeddedWb']);
        // 引用通用别名 {{世界书}}（逻辑键 material）⇒ 仍是「点名」：可选段随之发送并接管
        const r2 = splitPartsByVars(parts, ['material'], 'compat', 'card');
        assert.deepEqual(r2.takenKeys, ['card', 'embeddedWb']);
        assert.deepEqual(r2.autoParts.map((p) => p.key), ['task']);
        // 但「没写占位符」时世界书段不被 optional 段顶替：卡片段的 body 仍是卡材料（见 buildVarsFromParts 用例）
        const r2b = splitPartsByVars(parts, [], 'compat', 'card');
        assert.deepEqual(r2b.takenKeys, []);
        // 显式点名 {{卡内世界书}}（逻辑键 embeddedWb）⇒ 只接管可选段；全手动档下其余全丢
        const r3 = splitPartsByVars(parts, ['embeddedWb'], 'manual', 'card');
        assert.deepEqual(r3.takenKeys, ['embeddedWb']);
        assert.deepEqual(r3.droppedKeys, ['task', 'card']); // 只含「非可选」的那两段
        assert.deepEqual(r3.autoParts, []);
        // 声明可选但不引用：不因档位（semi/manual）而变成 dropped
        const r4 = splitPartsByVars(parts, [], 'semi', 'card');
        assert.deepEqual(r4.droppedKeys, ['task']);
        assert.deepEqual(r4.optionalKeys, ['embeddedWb']);
    });

    it('逻辑键归一：embeddedWb 与 card/wb 一样算「目标材料」', () => {
        const r = splitPartsByVars([{ key: 'embeddedWb', body: 'E', optional: true }], ['material'], 'compat', 'card');
        assert.deepEqual(r.takenKeys, ['embeddedWb']);
    });

    it('VAR_DEFS：`卡内世界书` / `内嵌世界书` 是 embeddedWb 的别名（图例可点即插入）', () => {
        const d = VAR_DEFS.find((x) => x.key === 'embeddedWb');
        assert.ok(d, '缺 embeddedWb 定义');
        assert.ok(d.aliases.includes('卡内世界书'));
        assert.ok(d.aliases.includes('内嵌世界书'));
        assert.deepEqual(parseSegmentVars([seg('{{内嵌世界书}}')]).used, ['embeddedWb']);
        // 共用一个别名不冲突：`{{世界书}}` 仍归 wb（世界书视图口径）
        assert.deepEqual(parseSegmentVars([seg('{{世界书}}')]).used, ['wb']);
    });
});
