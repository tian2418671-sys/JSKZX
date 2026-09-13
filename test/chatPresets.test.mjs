/**
 * 预设装配引擎单测（useChatPresets）
 * 运行：node --test "test/**\/*.test.mjs"
 *
 * 重点覆盖「桌面暂存区曾落后于移动版」的三处修复，防止再次回退：
 *   ① normalizePromptOrder 兼容嵌套形态（[{character_id, order:[…]}]）
 *   ② setPromptEnabled 双写（prompt 自身 + prompt_order 扁平/嵌套）
 *   ③ getOrderedPrompts 对 enabled===false 的剔除（含 prompt.enabled 与 prompt_order.enabled 两处）
 *   ④ 无 prompt_order 时的兜底过滤（跳过 chatHistory，尊重 prompt.enabled===false）
 *   ⑤ identifier 去重
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
    normalizePromptOrder,
    getOrderedPrompts,
    setPromptEnabled,
    getPresetParams,
    buildPresetMessages,
    isValidPresetStructure,
    extractRegexFromPreset,
    extractPluginsFromPreset
} from '../js/composables/chat/useChatPresets.js';

// ---------------------------------------------------------------- ① 归一化

test('normalizePromptOrder：扁平形态原样保留', () => {
    const flat = [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: false }];
    assert.deepEqual(normalizePromptOrder(flat), flat);
});

test('normalizePromptOrder：嵌套形态取各分组并集（移动端不做角色区分）', () => {
    const nested = [
        { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
        { character_id: 100001, order: [{ identifier: 'nsfw', enabled: false }, { identifier: 'main', enabled: false }] }
    ];
    const out = normalizePromptOrder(nested);
    assert.equal(out.length, 2, '同 identifier 应合并为一条（后者覆盖前者）');
    const main = out.find((x) => x.identifier === 'main');
    assert.equal(main.enabled, false, '后出现的分组应覆盖前者的 enabled');
    assert.ok(out.find((x) => x.identifier === 'nsfw'));
});

test('normalizePromptOrder：非数组输入返回空数组', () => {
    assert.deepEqual(normalizePromptOrder(null), []);
    assert.deepEqual(normalizePromptOrder(undefined), []);
    assert.deepEqual(normalizePromptOrder({}), []);
});

// ---------------------------------------------------------------- ③④⑤ 装配

test('getOrderedPrompts：按 prompt_order 排序并剔除 enabled===false', () => {
    const preset = {
        prompts: [
            { identifier: 'main', content: '主提示', role: 'system' },
            { identifier: 'nsfw', content: '不该出现', role: 'system' },
            { identifier: 'jailbreak', content: '破限', role: 'system' }
        ],
        prompt_order: [
            { identifier: 'jailbreak', enabled: true },
            { identifier: 'nsfw', enabled: false },
            { identifier: 'main', enabled: true }
        ]
    };
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), ['jailbreak', 'main']);
});

test('getOrderedPrompts：prompt.enabled===false 同样剔除（旧版只看 prompt_order 会漏）', () => {
    const preset = {
        prompts: [
            { identifier: 'main', content: '主提示', enabled: true },
            { identifier: 'off', content: '被 prompt 自身关掉', enabled: false }
        ],
        prompt_order: [{ identifier: 'main', enabled: true }, { identifier: 'off', enabled: true }]
    };
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), ['main']);
});

test('getOrderedPrompts：identifier 去重（同一条目在 prompt_order 出现两次只取一次）', () => {
    const preset = {
        prompts: [{ identifier: 'main', content: '主提示' }],
        prompt_order: [{ identifier: 'main', enabled: true }, { identifier: 'main', enabled: true }]
    };
    assert.equal(getOrderedPrompts(preset).length, 1);
});

test('getOrderedPrompts：嵌套 prompt_order 可用（旧版会全部丢失）', () => {
    const preset = {
        prompts: [{ identifier: 'main', content: '主提示' }, { identifier: 'x', content: '扩展' }],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'x', enabled: true }] }]
    };
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), ['main', 'x']);
});

test('getOrderedPrompts：无可用 prompt_order 时回退 prompts，并跳过 chatHistory', () => {
    const preset = {
        prompts: [
            { identifier: 'main', content: '主提示' },
            { identifier: 'chatHistory', content: '' },
            { identifier: 'off', content: '关掉的', enabled: false }
        ]
    };
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), ['main']);
});

test('getOrderedPrompts：空/非法预设返回空数组', () => {
    assert.deepEqual(getOrderedPrompts(null), []);
    assert.deepEqual(getOrderedPrompts({}), []);
});

// ---------------------------------------------------------------- ② 双写

test('setPromptEnabled：同时写 prompt 自身与扁平 prompt_order', () => {
    const prompt = { identifier: 'main' };
    const preset = { prompts: [prompt], prompt_order: [{ identifier: 'main', enabled: true }] };
    setPromptEnabled(preset, prompt, false);
    assert.equal(prompt.enabled, false);
    assert.equal(preset.prompt_order[0].enabled, false);
    // 关掉后装配层确实看不到它
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), []);
});

test('setPromptEnabled：嵌套 prompt_order 的分组内条目也要同步', () => {
    const prompt = { identifier: 'main' };
    const preset = {
        prompts: [prompt],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }]
    };
    setPromptEnabled(preset, prompt, false);
    assert.equal(preset.prompt_order[0].order[0].enabled, false);
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), []);
});

test('setPromptEnabled：重复开关可逆', () => {
    const prompt = { identifier: 'main' };
    const preset = { prompts: [prompt], prompt_order: [{ identifier: 'main', enabled: true }] };
    setPromptEnabled(preset, prompt, false);
    setPromptEnabled(preset, prompt, true);
    assert.equal(prompt.enabled, true);
    assert.equal(preset.prompt_order[0].enabled, true);
    assert.deepEqual(getOrderedPrompts(preset).map((p) => p.identifier), ['main']);
});

test('setPromptEnabled：非法入参不抛错', () => {
    assert.doesNotThrow(() => setPromptEnabled(null, null, true));
    assert.doesNotThrow(() => setPromptEnabled({}, { identifier: 'x' }, true));
});

// ---------------------------------------------------------------- 参数与装配

test('getPresetParams：只取白名单参数', () => {
    const params = getPresetParams({
        temperature: 0.8, max_tokens: 300, top_p: 0.9,
        unrelated: 'x', nested: { a: 1 }
    });
    assert.deepEqual(params, { temperature: 0.8, max_tokens: 300, top_p: 0.9 });
});

test('getPresetParams：null/undefined 参数值不写入', () => {
    assert.deepEqual(getPresetParams({ temperature: null, max_tokens: undefined, top_p: 0.5 }), { top_p: 0.5 });
});

test('buildPresetMessages：chatHistory 占位符处插入真实历史', () => {
    const preset = {
        prompts: [
            { identifier: 'main', content: '你是{{char}}', role: 'system' },
            { identifier: 'chatHistory', content: '', role: 'system' }
        ],
        prompt_order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }]
    };
    const msgs = buildPresetMessages(preset, { '{{char}}': '小美' }, {
        chatHistory: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }]
    });
    assert.deepEqual(msgs, [
        { role: 'system', content: '你是小美' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' }
    ]);
});

test('buildPresetMessages：非法 role 归一为 system', () => {
    const preset = {
        prompts: [{ identifier: 'x', content: '内容', role: 'weird' }],
        prompt_order: [{ identifier: 'x', enabled: true }]
    };
    assert.deepEqual(buildPresetMessages(preset, {}), [{ role: 'system', content: '内容' }]);
});

test('buildPresetMessages：无可装配条目返回空数组', () => {
    assert.deepEqual(buildPresetMessages(null, {}), []);
    assert.deepEqual(buildPresetMessages({ prompts: [] }, {}), []);
});

// ---------------------------------------------------------------- 结构与抽取

test('isValidPresetStructure：需有非空 prompts 数组', () => {
    assert.equal(isValidPresetStructure(null), false);
    assert.equal(isValidPresetStructure({}), false);
    assert.equal(isValidPresetStructure({ prompts: [] }), false);
    assert.equal(isValidPresetStructure({ prompts: [{ identifier: 'main' }] }), true);
});

test('extractRegexFromPreset：兼容 extensions 内嵌与顶层两种位置', () => {
    const inExt = extractRegexFromPreset({
        extensions: { regex_scripts: [{ scriptName: 'A', findRegex: '/a/g', replaceString: 'b' }] }
    });
    assert.equal(inExt.length, 1);
    assert.equal(inExt[0].fromPreset, true);

    const top = extractRegexFromPreset({
        regex_scripts: [{ script_name: 'B', find_regex: '/b/g', replace_string: 'c', enabled: false }]
    });
    assert.equal(top.length, 1);
    assert.equal(top[0].disabled, true, 'enabled:false 应归一为 disabled:true');
});

test('extractRegexFromPreset：缺 findRegex 的条目被丢弃', () => {
    assert.deepEqual(extractRegexFromPreset({ regex_scripts: [{ scriptName: '无正则' }] }), []);
});

test('extractPluginsFromPreset：归一化插件定义', () => {
    const out = extractPluginsFromPreset({
        extensions: { plugins: [{ name: '插件A', systemPrompts: ['p1'], macros: { '{{m}}': 'v' } }] }
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, '插件A');
    assert.deepEqual(out[0].systemPrompts, ['p1']);
    assert.deepEqual(out[0].macros, { '{{m}}': 'v' });
    assert.equal(out[0].fromPreset, true);
});
