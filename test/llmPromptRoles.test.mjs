/**
 * 🧠 LLM 层「提示词分角色 + 结构化输出截取」单测（方案 R1 + R2）
 *
 * 覆盖：
 *  · `isLlmOnlyPlan`     —— 启用条件（①规则关 且 ②向量关 且 ③LLM开）
 *  · `normalizePromptPreset` / `normalizePromptPresets` —— 旧 `content` → `system` 迁移
 *  · `hasRoleFields`     —— 是否用了副字段
 *  · `buildLlmMessages`  —— 消息顺序（system+破限 / user / assistant / prefill）
 *  · `willUsePrefill`
 *  · `parseStructuredTags` —— 三层降级（含**思考型模型思维链污染**用例）
 *  · `outputFormatRule`
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    TAG_WRAPPER, TAG_WRAPPER_ALT, DEFAULT_PREFILL,
    isLlmOnlyPlan, normalizePromptPreset, normalizePromptPresets, hasRoleFields,
    buildLlmMessages, willUsePrefill, parseStructuredTags, outputFormatRule,
    DEFAULT_COT_PROMPT, COT_MODE_DEFAULT, COT_MODE_OFF, COT_MODE_CUSTOM,
    resolveCotPrompt, willUseCot, stripThinkingBlocks
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
// 📝 预设归一化（向后兼容）
// ═══════════════════════════════════════════════════════════════
describe('normalizePromptPreset — 旧 content 自动迁移', () => {
    test('旧预设只有 content → system 拿到 content，且 content 保留', () => {
        const p = normalizePromptPreset({ id: 'a', name: '旧', content: '老指令' });
        assert.equal(p.system, '老指令');
        assert.equal(p.content, '老指令'); // 旧字段保留，降级不丢数据
        assert.equal(p.assistant, '');
        assert.equal(p.user, '');
        assert.equal(p.prefill, '');
        assert.equal(p.cotMode, COT_MODE_DEFAULT); // 🧠 旧预设默认走内置思维链
        assert.equal(p.cot, '');
    });
    test('新字段优先（system 非空时不被 content 覆盖）', () => {
        const p = normalizePromptPreset({ system: '新的', content: '旧的' });
        assert.equal(p.system, '新的');
        assert.equal(p.content, '旧的'); // content 原样保留
    });
    test('缺失字段有安全默认（不抛错）', () => {
        const p = normalizePromptPreset({});
        assert.equal(p.id, '');
        assert.equal(p.name, '未命名提示词');
        assert.equal(p.expanded, true);
        assert.equal(p.system, '');
    });
    test('null / 非对象 → 安全默认', () => {
        assert.equal(normalizePromptPreset(null).system, '');
        assert.equal(normalizePromptPreset('x').system, '');
    });
    test('normalizePromptPresets 非数组 → 空数组', () => {
        assert.deepEqual(normalizePromptPresets(null), []);
        assert.deepEqual(normalizePromptPresets('x'), []);
    });
    test('normalizePromptPresets 逐条迁移', () => {
        const list = normalizePromptPresets([{ content: 'a' }, { system: 'b' }]);
        assert.equal(list.length, 2);
        assert.equal(list[0].system, 'a');
        assert.equal(list[1].system, 'b');
    });
});

describe('hasRoleFields — 是否使用了副字段', () => {
    test('只有 content/system → false', () => {
        assert.equal(hasRoleFields({ content: 'x' }), false);
        assert.equal(hasRoleFields({ system: 'x' }), false);
    });
    test('任一为空白字符串 → false（trim 后判定）', () => {
        assert.equal(hasRoleFields({ system: 'x', assistant: '   ' }), false);
    });
    test('assistant 非空 → true', () => {
        assert.equal(hasRoleFields({ system: 'x', assistant: '示例' }), true);
    });
    test('user / prefill 非空 → true', () => {
        assert.equal(hasRoleFields({ user: '任务' }), true);
        assert.equal(hasRoleFields({ prefill: '<tags>[' }), true);
    });
    test('⚠️ 思维链默认版不算「副字段」（它是内置默认，非用户填写）', () => {
        assert.equal(hasRoleFields({ system: 'x', cotMode: COT_MODE_DEFAULT }), false);
        assert.equal(hasRoleFields({ system: 'x', cotMode: COT_MODE_CUSTOM, cot: '自定义' }), false);
    });
});

// ═══════════════════════════════════════════════════════════════
// 🧩 消息组装
// ═══════════════════════════════════════════════════════════════
describe('buildLlmMessages — 分角色消息顺序', () => {
    test('顺序：system → user → assistant(示例) → assistant(思维链) → assistant(预填充)', () => {
        const msgs = buildLlmMessages({
            preset: { system: 'S', assistant: 'A', user: 'U', prefill: '<tags>[', cotMode: COT_MODE_DEFAULT },
            defaultUser: '默认任务'
        });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant', 'assistant', 'assistant']);
        assert.equal(msgs[0].content, 'S');
        assert.equal(msgs[1].content, 'U'); // 预设 user 优先
        assert.equal(msgs[2].content, 'A');
        assert.equal(msgs[3].content, DEFAULT_COT_PROMPT); // 🧠 思维链
        assert.equal(msgs[4].content, '<tags>[');         // ⚡ 预填充放最后
    });
    test('⚠️ 所有 assistant 消息必须排在 user 之后（Anthropic 硬要求）', () => {
        const msgs = buildLlmMessages({
            preset: { system: 'S', assistant: 'A', prefill: '<tags>[', cotMode: COT_MODE_DEFAULT },
            defaultUser: 'U'
        });
        const firstNonSystem = msgs.find(m => m.role !== 'system');
        assert.equal(firstNonSystem.role, 'user', '第一条非 system 消息必须是 user，否则 Anthropic 报错');
        const roles = msgs.map(m => m.role);
        assert.equal(roles.indexOf('user') < roles.indexOf('assistant'), true);
    });
    test('预设 user 留空 → 用 defaultUser', () => {
        const msgs = buildLlmMessages({ preset: { system: 'S', cotMode: COT_MODE_OFF }, defaultUser: '默认任务' });
        assert.equal(msgs[1].content, '默认任务');
    });
    test('破限追加到 system 最末尾（注意力权重最高）', () => {
        const msgs = buildLlmMessages({ preset: { system: 'S', cotMode: COT_MODE_OFF }, jailbreak: '破限词', defaultUser: 'U' });
        assert.equal(msgs[0].content, 'S\n\n破限词');
        assert.equal(msgs[0].role, 'system');
    });
    test('破限为空白 → 不追加（也不产生多余换行）', () => {
        const msgs = buildLlmMessages({ preset: { system: 'S', cotMode: COT_MODE_OFF }, jailbreak: '   ', defaultUser: 'U' });
        assert.equal(msgs[0].content, 'S');
    });
    test('usePrefill=false → 不含预填充（但 assistant / 思维链仍在）', () => {
        const msgs = buildLlmMessages({
            preset: { system: 'S', assistant: 'A', prefill: '<tags>[', cotMode: COT_MODE_DEFAULT },
            defaultUser: 'U', usePrefill: false
        });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant', 'assistant']);
        assert.equal(msgs[2].content, 'A');
        assert.equal(msgs[3].content, DEFAULT_COT_PROMPT);
    });
    test('useCot=false → 不含思维链（预填充仍在）', () => {
        const msgs = buildLlmMessages({
            preset: { system: 'S', prefill: '<tags>[', cotMode: COT_MODE_DEFAULT },
            defaultUser: 'U', useCot: false
        });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant']);
        assert.equal(msgs[2].content, '<tags>[');
    });
    test('usePrefill=false 且 useCot=false → 退化为 system + user（降级阶梯末档）', () => {
        const msgs = buildLlmMessages({
            preset: { system: 'S', assistant: 'A', prefill: '<tags>[', cotMode: COT_MODE_DEFAULT },
            defaultUser: 'U', usePrefill: false, useCot: false
        });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant']);
        assert.equal(msgs[2].content, 'A');
    });
    test('旧预设（只有 content）→ 迁移到 system；思维链默认版生效', () => {
        const msgs = buildLlmMessages({ preset: { content: '老指令' }, defaultUser: 'U' });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant']);
        assert.equal(msgs[0].content, '老指令');
        assert.equal(msgs[2].content, DEFAULT_COT_PROMPT);
    });
    test('system 与 defaultUser 均空 → 只返回必要消息（不产生空消息）', () => {
        const msgs = buildLlmMessages({ preset: { cotMode: COT_MODE_OFF }, defaultUser: '' });
        assert.deepEqual(msgs, []);
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
// 🧠 思维链（CoT）模式
// ═══════════════════════════════════════════════════════════════
describe('resolveCotPrompt — 三档模式（默认 / 自定义 / 关闭）', () => {
    test('旧预设无 cotMode → 默认走内置默认版（用户指定为默认）', () => {
        assert.equal(resolveCotPrompt({ system: 'S' }), DEFAULT_COT_PROMPT);
        assert.equal(normalizePromptPreset({ system: 'S' }).cotMode, COT_MODE_DEFAULT);
    });
    test('cotMode=default → 内置默认版（不受 preset.cot 影响）', () => {
        assert.equal(resolveCotPrompt({ cotMode: COT_MODE_DEFAULT, cot: '我自己的' }), DEFAULT_COT_PROMPT);
    });
    test('cotMode=custom + 有内容 → 用自定义', () => {
        assert.equal(resolveCotPrompt({ cotMode: COT_MODE_CUSTOM, cot: '我自己的思维链' }), '我自己的思维链');
    });
    test('cotMode=custom 但内容为空 → 回退默认版（不静默失效）', () => {
        assert.equal(resolveCotPrompt({ cotMode: COT_MODE_CUSTOM, cot: '   ' }), DEFAULT_COT_PROMPT);
        assert.equal(resolveCotPrompt({ cotMode: COT_MODE_CUSTOM }), DEFAULT_COT_PROMPT);
    });
    test('cotMode=off → 空字符串（不注入）', () => {
        assert.equal(resolveCotPrompt({ cotMode: COT_MODE_OFF, cot: '写了也不生效' }), '');
    });
    test('非法 cotMode 值 → 归为默认版', () => {
        assert.equal(resolveCotPrompt({ cotMode: 'garbage' }), DEFAULT_COT_PROMPT);
        assert.equal(normalizePromptPreset({ cotMode: 'garbage' }).cotMode, COT_MODE_DEFAULT);
    });
    test('willUseCot 与 resolveCotPrompt 一致', () => {
        assert.equal(willUseCot({ cotMode: COT_MODE_OFF }), false);
        assert.equal(willUseCot({ cotMode: COT_MODE_DEFAULT }), true);
        assert.equal(willUseCot({}), true);
    });
    test('默认版内容同时含「思维链引导」与「破限」两个要素', () => {
        assert.ok(DEFAULT_COT_PROMPT.includes('推理'), '应含推理引导');
        assert.ok(DEFAULT_COT_PROMPT.includes('虚构'), '应含虚构/破限声明');
        assert.ok(DEFAULT_COT_PROMPT.includes('不要输出'), '应明确要求不输出推理过程');
        assert.ok(DEFAULT_COT_PROMPT.includes(`<${TAG_WRAPPER}>`), '应写死最终输出格式');
    });
});

// ═══════════════════════════════════════════════════════════════
// 🧹 思考块剥离
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
