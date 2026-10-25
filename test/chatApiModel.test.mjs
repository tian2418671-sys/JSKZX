/**
 * 🔒 拉取模型列表的行为单测 —— 原模型名不被静默覆盖（AI-21 / #hot-bug-1）
 *
 * 规格：docs/规格与计划/功能规格/G1-拉取模型列表静默覆盖-修复规格.md §6.1（T8~T11）
 *
 * 做法：直接调用真实的 useChat()，用 stub 替换 window.electronAPI.fetchModels，
 *       断言 apiModel 的最终值 —— 不 mock 被测逻辑本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { useChat } from '../js/composables/useChat.js';

/** 构造一个最小可用的 useChat 环境 */
function makeHarness(initialModel = '') {
    const apiEndpoint = ref('https://api.example.com/v1');
    const apiKey = ref('sk-test');
    const apiModel = ref(initialModel);
    const apiType = ref('openai');
    const alerts = [];
    const chat = useChat({
        apiEndpoint, apiKey, apiModel, apiType,
        resolveApiModel: (m) => m,
        extractReplyContent: (r) => r,
        DEFAULT_API_ENDPOINT: 'https://api.example.com/v1',
        syncConfigToDisk: () => { },
        nativeAlert: (msg, type) => alerts.push({ msg, type }),
        safeData: ref({}),
        cardData: ref(null)
    });
    return { chat, apiModel, alerts };
}

/** 让 fetchModels 返回指定列表（模拟 { data: [{id}] } 标准格式） */
function stubModels(list) {
    globalThis.window = globalThis.window || {};
    globalThis.window.electronAPI = globalThis.window.electronAPI || {};
    globalThis.window.electronAPI.fetchModels = async () => ({
        success: true,
        data: { data: list.map((id) => ({ id })) }
    });
}

function cleanup() {
    if (globalThis.window && globalThis.window.electronAPI) {
        delete globalThis.window.electronAPI.fetchModels;
    }
}

// ───────── 核心：绝不静默覆盖 ─────────

test('T8 原模型非空、且不在返回列表中 ⇒ 保留原值', async () => {
    try {
        stubModels(['gpt-4o', 'gpt-4o-mini']);
        const { chat, apiModel } = makeHarness('my-private-model');

        await chat.fetchAvailableModels();

        assert.equal(apiModel.value, 'my-private-model', '原模型名必须逐字保留');
        assert.deepEqual(chat.availableModels.value, ['gpt-4o', 'gpt-4o-mini']);
        assert.ok(chat.fetchModelStatus.value.includes('已保留'), '文案须说明「已保留」');
        assert.ok(!chat.fetchModelStatus.value.includes('已自动选中'), '不得声称自动选中');
    } finally { cleanup(); }
});

test('T9 原模型为空 ⇒ 自动选中第一项', async () => {
    try {
        stubModels(['gpt-4o', 'gpt-4o-mini']);
        const { chat, apiModel } = makeHarness('');

        await chat.fetchAvailableModels();

        assert.equal(apiModel.value, 'gpt-4o');
        assert.ok(chat.fetchModelStatus.value.includes('已自动选中'));
    } finally { cleanup(); }
});

test('T10 接口返回全是垃圾串 ⇒ 保留原值、候选为空、如实提示（不显示 ✅）', async () => {
    try {
        stubModels(['当前无可用模型']);
        const { chat, apiModel } = makeHarness('my-private-model');

        await chat.fetchAvailableModels();

        assert.equal(apiModel.value, 'my-private-model');
        assert.deepEqual(chat.availableModels.value, [], '垃圾串不得写进下拉候选');
        assert.ok(chat.fetchModelStatus.value.includes('均不像是模型名'));
        assert.ok(!chat.fetchModelStatus.value.includes('✅'), '全部被过滤时不得显示成功');
    } finally { cleanup(); }
});

test('T11 接口返回空列表 ⇒ 保留原值', async () => {
    try {
        stubModels([]);
        const { chat, apiModel } = makeHarness('my-private-model');

        await chat.fetchAvailableModels();

        assert.equal(apiModel.value, 'my-private-model');
        assert.ok(chat.fetchModelStatus.value.includes('未抓取到有效模型列表'));
    } finally { cleanup(); }
});

test('原模型在返回列表中 ⇒ 保持原值（不被改成列表首项）', async () => {
    try {
        stubModels(['aaa-model', 'my-model']);
        const { chat, apiModel } = makeHarness('my-model');

        await chat.fetchAvailableModels();

        assert.equal(apiModel.value, 'my-model');
        assert.ok(chat.fetchModelStatus.value.includes('在列表中'));
    } finally { cleanup(); }
});

test('混合列表：垃圾项被忽略且文案说明忽略数量', async () => {
    try {
        stubModels(['gpt-4o', '当前无可用模型']);
        const { chat, apiModel } = makeHarness('my-model');

        await chat.fetchAvailableModels();

        assert.deepEqual(chat.availableModels.value, ['gpt-4o']);
        assert.equal(apiModel.value, 'my-model');
        assert.ok(chat.fetchModelStatus.value.includes('已忽略 1 项'));
    } finally { cleanup(); }
});

test('拉取失败时不动 apiModel', async () => {
    try {
        globalThis.window = globalThis.window || {};
        globalThis.window.electronAPI = globalThis.window.electronAPI || {};
        globalThis.window.electronAPI.fetchModels = async () => ({ success: false, error: 'HTTP 500' });
        const { chat, apiModel } = makeHarness('my-model');

        await chat.fetchAvailableModels();

        assert.equal(apiModel.value, 'my-model');
        assert.ok(chat.fetchModelStatus.value.includes('拉取失败'));
    } finally { cleanup(); }
});
