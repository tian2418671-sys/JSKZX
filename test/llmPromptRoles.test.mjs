/**
 * 🧠 LLM 层「单套提示词链路 + 结构化输出截取」单测（第二批改造 · D1~D14）
 *
 * 覆盖：
 *  · `isLlmOnlyPlan`          —— 启用条件（①规则关 且 ②向量关 且 ③LLM开）
 *  · `normalizeRolePrompts`   —— 单套链路（system / user / prefill）归一化
 *  · `migrateLegacyPresets`   —— 旧「预设库」→ 单套链路迁移（兜底默认文案 / 预填充）
 *  · `resolveSystemVariantId` —— System 预设套用变体识别（standard / deep / brief / custom）
 *  · `buildLlmMessages`       —— 消息顺序（system+破限 / user / prefill）
 *  · `willUsePrefill`
 *  · `parseStructuredTags`    —— 三层降级（含**思考型模型思维链污染**用例）
 *  · `outputFormatRule`
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    TAG_WRAPPER, TAG_WRAPPER_ALT, DEFAULT_PREFILL,
    isLlmOnlyPlan, normalizeRolePrompts, migrateLegacyPresets,
    DEFAULT_SYSTEM_PROMPT, SYSTEM_PROMPT_VARIANTS, resolveSystemVariantId,
    buildLlmMessages, willUsePrefill, parseStructuredTags, outputFormatRule,
    packedOutputRule, parsePackedTags, stripThinkingBlocks, sanitizeTagList,
    composeTagPromptHead, splitTextSegments
} from '../js/utils/llmPromptRoles.js';

// ═══════════════════════════════════════════════════════════════
// 🎚️ 启用条件
// ═══════════════════════════════════════════════════════════════
describe('isLlmOnlyPlan — 仅「①关 ②关 ③开」才为真', () => {
    test('规则关 + 向量关 + LLM 开 → true（唯一启用组合）', () => {
        assert.equal(isLlmOnlyPlan({ rule: false, vector: false, llm: true }), true);
    });
    test('规则开 → false', () => {
        assert.equal(isLlmOnlyPlan({ rule: true, vector: false, llm: true }), false);
    });
    test('向量开 → false', () => {
        assert.equal(isLlmOnlyPlan({ rule: false, vector: true, llm: true }), false);
    });
    test('LLM 关 → false', () => {
        assert.equal(isLlmOnlyPlan({ rule: false, vector: false, llm: false }), false);
    });
    test('空 / null / undefined → false（不抛错）', () => {
        assert.equal(isLlmOnlyPlan(null), false);
        assert.equal(isLlmOnlyPlan(undefined), false);
        assert.equal(isLlmOnlyPlan({}), false);
    });
});

// ═══════════════════════════════════════════════════════════════
// 📝 单套链路归一化 + 旧预设库迁移
// ═══════════════════════════════════════════════════════════════
describe('normalizeRolePrompts — 单套链路', () => {
    test('正常对象 → 原样保留三个字段', () => {
        const p = normalizeRolePrompts({ system: 'S', user: 'U', prefill: '<tags>[' });
        assert.deepEqual(p, { system: 'S', user: 'U', prefill: '<tags>[' });
    });
    test('缺失 / 脏值 → 空字符串（不抛错）', () => {
        assert.deepEqual(normalizeRolePrompts(null), { system: '', user: '', prefill: '' });
        assert.deepEqual(normalizeRolePrompts('x'), { system: '', user: '', prefill: '' });
        assert.deepEqual(normalizeRolePrompts({ system: 123, user: null, prefill: undefined }), { system: '', user: '', prefill: '' });
    });
    test('⚠️ prefill 为空串 = 关闭预填充（不是「用默认」）', () => {
        assert.equal(normalizeRolePrompts({ prefill: '' }).prefill, '');
    });
});

describe('migrateLegacyPresets — 旧预设库 → 单套链路', () => {
    test('取第一条的 system（无则 content）；user / prefill 照搬', () => {
        const r = migrateLegacyPresets([
            { system: '主要指令', user: '任务', prefill: '<tags>[' },
            { system: '第二条不会用' }
        ]);
        assert.equal(r.system, '主要指令');
        assert.equal(r.user, '任务');
        assert.equal(r.prefill, '<tags>[');
    });
    test('旧预设只有 content → 迁移到 system（保底）', () => {
        const r = migrateLegacyPresets([{ content: '老指令' }]);
        assert.equal(r.system, '老指令');
        assert.equal(r.prefill, DEFAULT_PREFILL); // 空 → 默认 <tags>[
    });
    test('空 / 非数组 → 新默认文案 + 默认预填充', () => {
        for (const input of [[], null, 'x', undefined]) {
            const r = migrateLegacyPresets(input);
            assert.equal(r.system, DEFAULT_SYSTEM_PROMPT);
            assert.equal(r.user, '');
            assert.equal(r.prefill, DEFAULT_PREFILL);
        }
    });
    test('空白 system / content → 回退新默认文案', () => {
        assert.equal(migrateLegacyPresets([{ system: '   ' }]).system, DEFAULT_SYSTEM_PROMPT);
        assert.equal(migrateLegacyPresets([{ content: '' }]).system, DEFAULT_SYSTEM_PROMPT);
    });
});

describe('System 预设套用 — 变体与识别', () => {
    test('内置 3 个变体，standard 即默认文案', () => {
        assert.equal(SYSTEM_PROMPT_VARIANTS.length, 3);
        assert.equal(SYSTEM_PROMPT_VARIANTS[0].id, 'standard');
        assert.equal(SYSTEM_PROMPT_VARIANTS[0].content, DEFAULT_SYSTEM_PROMPT);
    });
    test('resolveSystemVariantId：命中变体 → 对应 id；否则 custom', () => {
        assert.equal(resolveSystemVariantId(DEFAULT_SYSTEM_PROMPT), 'standard');
        assert.equal(resolveSystemVariantId(SYSTEM_PROMPT_VARIANTS[1].content), 'deep');
        assert.equal(resolveSystemVariantId(SYSTEM_PROMPT_VARIANTS[2].content), 'brief');
        assert.equal(resolveSystemVariantId('我自己写的内容'), 'custom');
        assert.equal(resolveSystemVariantId(''), 'custom');
        assert.equal(resolveSystemVariantId(null), 'custom');
    });
    test('默认文案包含真实性与第 5 条推理句', () => {
        assert.ok(DEFAULT_SYSTEM_PROMPT.includes('不脑补'));
        assert.ok(DEFAULT_SYSTEM_PROMPT.includes('大类/子类'));
        assert.ok(DEFAULT_SYSTEM_PROMPT.includes('输出前先在内部完成推理'));
    });
});

// ═══════════════════════════════════════════════════════════════
// 🧩 消息组装（单套链路）
// ═══════════════════════════════════════════════════════════════
describe('buildLlmMessages — 单套链路消息顺序', () => {
    test('顺序：system → user → assistant(预填充)（破限拼在 system 末尾）', () => {
        const msgs = buildLlmMessages({
            rolePrompts: { system: 'S', user: 'U', prefill: '<tags>[' },
            jailbreak: '破限词',
            defaultUser: '默认任务'
        });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant']);
        assert.equal(msgs[0].content, 'S\n\n破限词'); // 破限在 system 末尾（注意力权重最高）
        assert.equal(msgs[1].content, 'U');          // 预设 user 优先
        assert.equal(msgs[2].content, '<tags>[');    // 预填充放最后
    });
    test('预设 user 留空 → 用 defaultUser', () => {
        const msgs = buildLlmMessages({ rolePrompts: { system: 'S', prefill: '' }, defaultUser: '默认任务' });
        assert.equal(msgs[1].content, '默认任务');
    });
    test('破限为空白 → 不追加（也不产生多余换行）', () => {
        const msgs = buildLlmMessages({ rolePrompts: { system: 'S' }, jailbreak: '   ', defaultUser: 'U' });
        assert.equal(msgs[0].content, 'S');
    });
    test('usePrefill=false → 不含预填充（降级第二级）', () => {
        const msgs = buildLlmMessages({
            rolePrompts: { system: 'S', prefill: '<tags>[' },
            defaultUser: 'U', usePrefill: false
        });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user']);
    });
    test('⚠️ 预填充（assistant）必须排在 user 之后（Anthropic 硬要求）', () => {
        const msgs = buildLlmMessages({
            rolePrompts: { system: 'S', prefill: '<tags>[' },
            defaultUser: 'U'
        });
        const firstNonSystem = msgs.find(m => m.role !== 'system');
        assert.equal(firstNonSystem.role, 'user');
        const roles = msgs.map(m => m.role);
        assert.equal(roles.indexOf('user') < roles.indexOf('assistant'), true);
    });
    test('system 与 defaultUser 均空 → 只返回必要消息（不产生空消息）', () => {
        const msgs = buildLlmMessages({ rolePrompts: { prefill: '' }, defaultUser: '' });
        assert.deepEqual(msgs, []);
    });
    test('只有 system 为空但 user 有内容 → 不产生空 system 消息', () => {
        const msgs = buildLlmMessages({ rolePrompts: { system: '', user: 'U', prefill: '' } });
        assert.deepEqual(msgs.map(m => m.role), ['user']);
    });
    test('无参调用不抛错', () => {
        assert.equal(Array.isArray(buildLlmMessages()), true);
        assert.equal(Array.isArray(buildLlmMessages({})), true);
    });
});

describe('willUsePrefill — 是否实际会用到预填充', () => {
    test('prefill 非空 → true', () => {
        assert.equal(willUsePrefill({ prefill: '<tags>[' }), true);
    });
    test('prefill 空白 / 缺失 → false', () => {
        assert.equal(willUsePrefill({ prefill: '   ' }), false);
        assert.equal(willUsePrefill({}), false);
        assert.equal(willUsePrefill(null), false);
    });
});

// ═══════════════════════════════════════════════════════════════
//  思考块剥离
// ═══════════════════════════════════════════════════════════════
describe('stripThinkingBlocks — 剥思考块', () => {
    test('英文 <thinking> 块', () => {
        assert.equal(stripThinkingBlocks('<thinking>我在想</thinking>结果'), '结果');
    });
    test('中文【思考】块（方头括号形式）', () => {
        assert.equal(stripThinkingBlocks('【思考】我推理一下【/思考】答案'), '答案');
    });
    test('多个思考块全部剥掉', () => {
        assert.equal(stripThinkingBlocks('<thinking>a</thinking>中间<analysis>b</analysis>尾'), '中间尾');
    });
    test('大小写不敏感', () => {
        assert.equal(stripThinkingBlocks('<THINKING>x</THINKING>y'), 'y');
    });
    test('无思考块 → 原样返回', () => {
        assert.equal(stripThinkingBlocks('<tags>["a"]</tags>'), '<tags>["a"]</tags>');
    });
    test('null / 空 → 空串', () => {
        assert.equal(stripThinkingBlocks(null), '');
        assert.equal(stripThinkingBlocks(''), '');
    });
});

// ═══════════════════════════════════════════════════════════════
// 🔍 R1 · 三层降级解析
// ═══════════════════════════════════════════════════════════════
describe('parseStructuredTags — 第①层 <tags> 精确边界', () => {
    test('标准结构化输出 → layer 1', () => {
        const r = parseStructuredTags('<tags>["奇幻", "骑士"]</tags>');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
    test('中文标签名 <标签> 兼容', () => {
        const r = parseStructuredTags('<标签>["a","b"]</标签>');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('大小写 / 空格容错', () => {
        const r = parseStructuredTags('< TAGS >["x"]</ tags >');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['x']);
    });
    test('标签内为纯文本列表 → 仍走第①层（parseArrayLike 容错）', () => {
        const r = parseStructuredTags('<tags>奇幻, 骑士, 魔法</tags>');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['奇幻', '骑士', '魔法']);
    });
    test('外层 markdown 代码围栏被剥离', () => {
        const r = parseStructuredTags('```json\n<tags>["a"]</tags>\n```');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['a']);
    });
    test('🔴 思考型模型思维链污染：链里有 [1] 与 ["示例"]，正确结果仍在 <tags> 内', () => {
        // ⚠️ 这是 R1 要修的核心场景：旧贪婪匹配 /\[[\s\S]*\]/ 会取「第一个 [」到「最后一个 ]」
        const raw = '让我思考一下：\n1. 步骤 [1] 先看描述\n2. 参考格式 ["示例", "格式"]\n'
            + '所以最终结果应该是：\n<tags>["奇幻", "骑士"]</tags>\n以上。';
        const r = parseStructuredTags(raw);
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1, '必须命中第①层精确边界，而非被思维链污染');
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
});

describe('parseStructuredTags — 第②层 JSON 正则（模型未遵守 <tags>）', () => {
    test('裸 JSON 数组 → layer 2', () => {
        const r = parseStructuredTags('["奇幻", "骑士"]');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
    test('带解释文字的裸 JSON → layer 2', () => {
        const r = parseStructuredTags('好的，结果是：["a", "b"]');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('markdown 代码围栏包裹 → layer 2', () => {
        const r = parseStructuredTags('```json\n["a", "b"]\n```');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('空包裹 → 退回层②（不误判为 layer 1）', () => {
        const r = parseStructuredTags('<tags></tags> 但这里 ["a","b"]');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('思维链里的 [1] / 非法 JSON 方括号被跳过（不污染）', () => {
        const r = parseStructuredTags('步骤 [1] 完成，参考 [示例] 后结果：["a", "b"]');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('嵌套数组 → 贪婪兜底仍能解析（非贪婪会截断成非法 JSON）', () => {
        const r = parseStructuredTags('结果：["a", ["b", "c"]]');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['a', 'b', 'c']); // 嵌套数组被展平
    });
});

describe('parseStructuredTags — 多包裹时取「最后一个有效」', () => {
    test('思维链先给示例包裹、末尾给真结果 → 取末尾', () => {
        const raw = '我先示范一下格式：<tags>["示例", "格式"]</tags>\n'
            + '现在给出真实结果：<tags>["奇幻", "骑士"]</tags>';
        const r = parseStructuredTags(raw);
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['奇幻', '骑士'], '必须取最后一个包裹，而非思维链里的示例');
    });
});

describe('parseStructuredTags — 🧹 思考块剥离（思维链模型专用）', () => {
    test('<thinking> 块里的方括号不污染结果', () => {
        const raw = '<thinking>步骤 [1] 参考 ["示例","格式"] 然后……</thinking>\n<tags>["奇幻","骑士"]</tags>';
        const r = parseStructuredTags(raw);
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
    test('思考 块（中文方头括号）也能剥掉', () => {
        const raw = '【思考】这里我在推理 [1] [2]【/思考】<tags>["a","b"]</tags>';
        const r = parseStructuredTags(raw);
        assert.equal(r.ok, true);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('🛡️ 防御性：模型把真结果写在思考块里 → 剥完失败则回退原文仍能取到', () => {
        // 剥掉 <thinking> 后剩余为空 → 回退用原文解析，仍能拿到标签
        const raw = '<thinking>其实答案是 ["奇幻","骑士"]</thinking>';
        const r = parseStructuredTags(raw);
        assert.equal(r.ok, true);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
    test('🛡️ 防御性：思考块 + 无 <tags> 的裸 JSON → 剥完走层②', () => {
        const raw = '<thinking>[1] 干扰项</thinking>\n最终：["奇幻", "骑士"]';
        const r = parseStructuredTags(raw);
        assert.equal(r.ok, true);
        assert.equal(r.layer, 2);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
    test('无思考块时行为不变（回归）', () => {
        assert.deepEqual(parseStructuredTags('<tags>["a"]</tags>').tags, ['a']);
        assert.deepEqual(parseStructuredTags('["a","b"]').tags, ['a', 'b']);
    });
});

describe('parseStructuredTags — 第③层兜底拆分', () => {
    test('纯文本顿号分隔 → layer 3', () => {
        const r = parseStructuredTags('奇幻、骑士、魔法');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 3);
        assert.deepEqual(r.tags, ['奇幻', '骑士', '魔法']);
    });
    test('换行分隔 → layer 3', () => {
        const r = parseStructuredTags('奇幻\n骑士');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 3);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
});

describe('parseStructuredTags — 空 / 异常输入', () => {
    test('空串 → ok=false', () => {
        const r = parseStructuredTags('');
        assert.equal(r.ok, false);
        assert.deepEqual(r.tags, []);
        assert.ok(r.reason);
    });
    test('null / undefined → ok=false（不抛错）', () => {
        assert.equal(parseStructuredTags(null).ok, false);
        assert.equal(parseStructuredTags(undefined).ok, false);
    });
    test('纯空白 → ok=false', () => {
        assert.equal(parseStructuredTags('   \n  ').ok, false);
    });
    test('空数组 → ok=false（无标签视为失败）', () => {
        const r = parseStructuredTags('[]');
        assert.equal(r.ok, false);
    });
});

// ═══════════════════════════════════════════════════════════════
// 📢 输出格式片段
// ═══════════════════════════════════════════════════════════════
describe('outputFormatRule — 结构化 / 普通两种口径', () => {
    test('structured=true → 含 <tags> 包裹要求', () => {
        const s = outputFormatRule(true);
        assert.ok(s.includes(`<${TAG_WRAPPER}>`));
        assert.ok(s.includes('绝对不要'));
    });
    test('structured=false → 纯 JSON 数组要求（不含 <tags>）', () => {
        const s = outputFormatRule(false);
        assert.ok(!s.includes(`<${TAG_WRAPPER}>`));
        assert.ok(s.includes('JSON 数组'));
    });
    test('常量一致性', () => {
        assert.equal(TAG_WRAPPER, 'tags');
        assert.equal(TAG_WRAPPER_ALT, '标签');
        assert.equal(DEFAULT_PREFILL, '<tags>[');
    });
});

// ═══════════════════════════════════════════════════════════════
// 📦 打包（多卡请求）解析
// ═══════════════════════════════════════════════════════════════
describe('packedOutputRule — 多卡输出格式要求', () => {
    test('含数量与编号约定（1 开始）', () => {
        const s = packedOutputRule(5);
        assert.ok(s.includes('5 张卡片'));
        assert.ok(s.includes('从 1 开始'));
        assert.ok(s.includes(`<${TAG_WRAPPER}>`));
    });
    test('非法数量兜底为 1', () => {
        assert.ok(packedOutputRule(0).includes('1 张卡片'));
        assert.ok(packedOutputRule(null).includes('1 张卡片'));
    });
});

describe('parsePackedTags — 对象形态', () => {
    test('标准对象输出 → 逐卡映射', () => {
        const r = parsePackedTags('<tags>{"1": ["奇幻","骑士"], "2": ["日常"]}</tags>');
        assert.equal(r.ok, true);
        assert.deepEqual(r.map['1'], ['奇幻', '骑士']);
        assert.deepEqual(r.map['2'], ['日常']);
    });
    test('带解释文字 / 代码围栏 → 仍能解析', () => {
        const r = parsePackedTags('好的：\n```json\n<tags>{"1":["a"],"2":["b"]}</tags>\n```\n以上。');
        assert.equal(r.ok, true);
        assert.deepEqual(r.map['2'], ['b']);
    });
    test('裸对象（无 <tags> 包裹）→ 兜底解析', () => {
        const r = parsePackedTags('{"1": ["a"], "2": ["b"]}');
        assert.equal(r.ok, true);
        assert.deepEqual(r.map['1'], ['a']);
    });
    test('思考块里的示例对象不污染（取最后一个有效包裹）', () => {
        const raw = '让我想想…示例 <tags>{"1": ["示例"]}</tags>\n最终结果：\n<tags>{"1": ["真结果"], "2": ["b"]}</tags>';
        const r = parsePackedTags(raw);
        assert.equal(r.ok, true);
        assert.deepEqual(r.map['1'], ['真结果']);
    });
    test('字符串值 / 嵌套数组 → 统一成字符串数组', () => {
        const r = parsePackedTags('<tags>{"1": "单标签", "2": [["嵌套"]]}</tags>');
        assert.deepEqual(r.map['1'], ['单标签']);
        assert.deepEqual(r.map['2'], ['嵌套']);
    });
});

describe('parsePackedTags — 数组的数组 / 异常', () => {
    test('数组的数组 → 按序号映射（1 开始）', () => {
        const r = parsePackedTags('<tags>[["a","b"], ["c"]]</tags>');
        assert.equal(r.ok, true);
        assert.deepEqual(r.map['1'], ['a', 'b']);
        assert.deepEqual(r.map['2'], ['c']);
    });
    test('单卡数组（非打包格式）→ 不误判为打包结果', () => {
        const r = parsePackedTags('<tags>["a","b"]</tags>');
        assert.equal(r.ok, false);
    });
    test('空 / null → ok=false（不抛错）', () => {
        assert.equal(parsePackedTags('').ok, false);
        assert.equal(parsePackedTags(null).ok, false);
    });
    test('无 JSON → ok=false', () => {
        assert.equal(parsePackedTags('完全不是 JSON').ok, false);
    });
});

// ═══════════════════════════════════════════════════════════════
// 🧽 AI-10：兜底拆分清理（sanitizeTagList + 层③真实脏输出回归）
// ═══════════════════════════════════════════════════════════════
describe('sanitizeTagList — 标签统一清洗（AI-10）', () => {
    test('剥 <tags>/</tags> 标记（独立项 / 内嵌残留）', () => {
        assert.deepEqual(
            sanitizeTagList(['现代/都市', '</tags>', '教程/指南 </tags>', '<tags>', '  ']),
            ['现代/都市', '教程/指南']
        );
    });
    test('剥中英文引号与方括号', () => {
        assert.deepEqual(
            sanitizeTagList(['“奇幻/异世界”', '"公路片"', '[召唤/勇者]', "'傲娇/JK'"]),
            ['奇幻/异世界', '公路片', '召唤/勇者', '傲娇/JK']
        );
    });
    test('折叠中文字间空格与斜杠两侧空格', () => {
        assert.deepEqual(
            sanitizeTagList(['现代/都 市', '温柔/ 体贴', '温 柔']),
            ['现代/都市', '温柔/体贴', '温柔']
        );
    });
    test('剥行首列表符与编号（- * • · / 1. / 2、）', () => {
        assert.deepEqual(
            sanitizeTagList(['- 奇幻', '* 骑士', '• 都市', '1. 日常', '2、校园']),
            ['奇幻', '骑士', '都市', '日常', '校园']
        );
    });
    test('空白变形归一：NBSP / 全角空格 / 零宽 / Tab', () => {
        assert.deepEqual(
            sanitizeTagList(['现代/都\u00a0市', '温\u3000柔', '奇\u200b幻', '日\t常']),
            ['现代/都市', '温柔', '奇幻', '日常']
        );
    });
    test('剥 Markdown 粗斜体与全角引号变体（「」『』）', () => {
        assert.deepEqual(
            sanitizeTagList(['**奇幻**', '_骑士_', '「都市」', '『日常』']),
            ['奇幻', '骑士', '都市', '日常']
        );
    });
    test('剥首尾残留标点（不误伤 v1.2 类）', () => {
        assert.deepEqual(
            sanitizeTagList(['、奇幻、', '，骑士。', 'v1.2', '日常；']),
            ['奇幻', '骑士', 'v1.2', '日常']
        );
    });
    test('项级门槛：纯数字与超长项（疑似解释文字）丢弃', () => {
        assert.deepEqual(
            sanitizeTagList(['奇幻', '1', '这是一段很长的解释文字'.repeat(4), '骑士']),
            ['奇幻', '骑士']
        );
    });
    test('去重（保序）+ 丢空项', () => {
        assert.deepEqual(sanitizeTagList(['A', 'B', 'A', '', null, '  ', 'B']), ['A', 'B']);
    });
    test('英文标签的空格不被误伤（Sci-Fi (科幻)）', () => {
        assert.deepEqual(sanitizeTagList(['Sci-Fi (科幻)', 'Romance (恋爱)']), ['Sci-Fi (科幻)', 'Romance (恋爱)']);
    });
});

describe('parseStructuredTags — 第③层兜底的真实脏输出（AI-10 回归）', () => {
    test('顿号列表 + 尾部 </tags>（gemini 假流式真实输出形态）', () => {
        const r = parseStructuredTags('现代/都市、熟女/人妻、救赎/补偿、</tags>');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 3);
        assert.deepEqual(r.tags, ['现代/都市', '熟女/人妻', '救赎/补偿']);
    });
    test('无分隔符内嵌标记：教程/指南</tags>', () => {
        const r = parseStructuredTags('工具/实用、系统/辅助、教程/指南</tags>');
        assert.deepEqual(r.tags, ['工具/实用', '系统/辅助', '教程/指南']);
    });
    test('中文引号 + 中文字间空格混合', () => {
        const r = parseStructuredTags('“奇幻/异世界”、“公路片”、现代/都 市');
        assert.deepEqual(r.tags, ['奇幻/异世界', '公路片', '现代/都市']);
    });
    test('包裹内纯文本 + 尾逗号 → 层①-b 命中且清洗', () => {
        const r = parseStructuredTags('<tags>奇幻、骑士、</tags>');
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
});

describe('parseStructuredTags — 预填充拼接（2026-09-25 根治）', () => {
    test('模型按 JSON 续写 → 拼回 `<tags>[` 后层①-a 命中（不再落③）', () => {
        const r = parseStructuredTags('"奇幻","骑士"]</tags>', { prefill: '<tags>[' });
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['奇幻', '骑士']);
    });
    test('模型写顿号文本续写 → 拼回后层①-b 命中且清洗干净', () => {
        const r = parseStructuredTags('现代/都 市、熟女/人妻、</tags>', { prefill: '<tags>[' });
        assert.equal(r.ok, true);
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['现代/都市', '熟女/人妻']);
    });
    test('原文已含完整包裹 → 不拼接，保持既有行为（仍是①）', () => {
        const r = parseStructuredTags('<tags>["a","b"]</tags>', { prefill: '<tags>[' });
        assert.equal(r.layer, 1);
        assert.deepEqual(r.tags, ['a', 'b']);
    });
    test('不传 prefill → 行为与旧版一致（回归保护，仍走③兜底）', () => {
        const r = parseStructuredTags('现代/都市、救赎/补偿、</tags>');
        assert.equal(r.layer, 3);
        assert.deepEqual(r.tags, ['现代/都市', '救赎/补偿']);
    });
    test('空回复 → ok=false（不拼接不报错）', () => {
        const r = parseStructuredTags('', { prefill: '<tags>[' });
        assert.equal(r.ok, false);
    });
});

// ═══════════════════════════════════════════════════════════════
// 🏷️ S2（2026-09-25）：composeTagPromptHead —— 候选池开关 / 联动矩阵（卡版与世界书版共用）
// ═══════════════════════════════════════════════════════════════
describe('composeTagPromptHead — 池开关 / 自由提取 / 附加要求', () => {
    test('池开 + 自由提取开 → 池段落 + 宽松规则（现状默认）', () => {
        const h = composeTagPromptHead({ poolTags: ['a', 'b'], poolEnabled: true, enableExtraction: true, customPrompt: '' });
        assert.ok(h.includes('【标签候选池】：[a, b]'));
        assert.ok(h.includes('优先从候选池'));
        assert.ok(!h.includes('严格限制'));
    });
    test('池开 + 自由提取关 → 池段落 + 严格规则（现状）', () => {
        const h = composeTagPromptHead({ poolTags: ['a'], poolEnabled: true, enableExtraction: false, customPrompt: '' });
        assert.ok(h.includes('【标签候选池】：[a]'));
        assert.ok(h.includes('严格限制规则'));
        assert.ok(h.includes('绝对只能'));
    });
    test('池关 → **不输出**池段落、也不输出任意规则（LLM 完全自由）', () => {
        const h = composeTagPromptHead({ poolTags: ['a', 'b'], poolEnabled: false, enableExtraction: true, customPrompt: '' });
        assert.ok(!h.includes('【标签候选池】'));
        assert.ok(!h.includes('【规则】'));
        assert.ok(!h.includes('严格限制'));
        assert.equal(h, '');
    });
    test('池关 + 附加要求 → 只保留附加要求（与池无关）', () => {
        const h = composeTagPromptHead({ poolTags: ['a'], poolEnabled: false, enableExtraction: false, customPrompt: '重点分析性格' });
        assert.ok(!h.includes('【标签候选池】'));
        assert.ok(h.includes('【附加要求】：重点分析性格'));
    });
    test('池开但池空 → 不输出池段落（规则仍输出）', () => {
        const h = composeTagPromptHead({ poolTags: [], poolEnabled: true, enableExtraction: true, customPrompt: '' });
        assert.ok(!h.includes('【标签候选池】'));
        assert.ok(h.includes('优先从候选池'));
    });
    test('poolEnabled 缺省 → 按开处理（老调用方零回归）', () => {
        const h = composeTagPromptHead({ poolTags: ['x'], enableExtraction: true });
        assert.ok(h.includes('【标签候选池】：[x]'));
    });
    test('空参数 / undefined → 不抛错（默认：池开 + 宽松规则）', () => {
        const h = composeTagPromptHead();
        assert.ok(typeof h === 'string');
        assert.ok(h.includes('【规则】'));
        assert.ok(!h.includes('严格限制'));
        assert.equal(composeTagPromptHead({}), composeTagPromptHead());
    });
});

// ═══════════════════════════════════════════════════════════════
// ✂️ S3（2026-09-25）：splitTextSegments —— 长材料分段（卡版与世界书版共用）
// ═══════════════════════════════════════════════════════════════
describe('splitTextSegments — 按段落边界切段', () => {
    test('短文本 → 单段', () => {
        assert.deepEqual(splitTextSegments('hello', 100), ['hello']);
    });
    test('按空行切分：每段不超限', () => {
        const p = (c, n) => c.repeat(n);
        const text = `${p('a', 150)}\n\n${p('b', 150)}\n\n${p('c', 150)}`;
        const segs = splitTextSegments(text, 200);
        assert.equal(segs.length, 3);
        assert.ok(segs.every(s => s.length <= 200));
    });
    test('超长无空行 → 硬切不丢内容', () => {
        const text = 'x'.repeat(500);
        const segs = splitTextSegments(text, 200);
        assert.deepEqual(segs, ['x'.repeat(200), 'x'.repeat(200), 'x'.repeat(100)]);
    });
    test('空文本 → 空数组', () => {
        assert.deepEqual(splitTextSegments('', 100), []);
        assert.deepEqual(splitTextSegments(null, 100), []);
    });
    test('最大长度下限保护（过小值被抬到 200，防段数爆炸）', () => {
        const segs = splitTextSegments('y'.repeat(300), 1);
        assert.ok(segs.length <= 2);
    });
});
