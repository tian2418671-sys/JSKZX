/**
 * 🏷️ 模型 ID 合法性判定 — 单测（AI-21 / #hot-bug-1）
 * 规格：docs/规格与计划/功能规格/G1-拉取模型列表静默覆盖-修复规格.md §6.1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isLikelyModelId, partitionModelIds,
    MODEL_ID_RE, JUNK_HINTS, MODEL_ID_MAX_LEN
} from '../js/utils/modelId.js';

// ───────── 合法模型名 ─────────
test('isLikelyModelId：常见 OpenAI 风格命名通过', () => {
    assert.equal(isLikelyModelId('gpt-4o-mini'), true);
    assert.equal(isLikelyModelId('deepseek-v4.1-flash'), true);
    assert.equal(isLikelyModelId('gemini-3.8-flash'), true);
});

test('isLikelyModelId：含 @ 的 Vertex AI 命名通过（上游指出的误杀点）', () => {
    assert.equal(isLikelyModelId('claude-3-5-sonnet@20240620'), true);
});

test('isLikelyModelId：含 + 的命名通过', () => {
    assert.equal(isLikelyModelId('model+beta'), true);
});

test('isLikelyModelId：带命名空间斜杠（HuggingFace 形态）通过', () => {
    assert.equal(isLikelyModelId('org/model-name'), true);
});

test('isLikelyModelId：长度 90 字符的长路径通过（原设想上限 64 会误杀）', () => {
    const long = 'organization/model-name-finetuned-' + 'x'.repeat(60);
    assert.ok(long.length > 64, '样例应超过 64 字符');
    assert.ok(long.length <= MODEL_ID_MAX_LEN, '样例应在 128 以内');
    assert.equal(isLikelyModelId(long), true);
});

test('isLikelyModelId：本地推理后端 冒号/斜杠 形态通过', () => {
    assert.equal(isLikelyModelId('localhost:11434/llama3'), true);
});

test('isLikelyModelId：前后空格 trim 后通过', () => {
    assert.equal(isLikelyModelId('  gpt-4o  '), true);
});

// ───────── 垃圾返回被拦截 ─────────
test('isLikelyModelId：中文提示语被拒绝（真实触发场景）', () => {
    assert.equal(isLikelyModelId('当前无可用模型'), false);
});

test('isLikelyModelId：英文提示语被拒绝', () => {
    assert.equal(isLikelyModelId('model not available'), false);
    assert.equal(isLikelyModelId('no model'), false);
});

test('isLikelyModelId：含空格 / 换行被拒绝', () => {
    assert.equal(isLikelyModelId('gpt 4o'), false);
    assert.equal(isLikelyModelId('gpt-4o\n'), false);
});

test('isLikelyModelId：HTML 被拒绝', () => {
    assert.equal(isLikelyModelId('<!DOCTYPE html>'), false);
});

test('isLikelyModelId：纯数字被拒绝（多为错误码）', () => {
    assert.equal(isLikelyModelId('12345'), false);
});

test('isLikelyModelId：过短被拒绝', () => {
    assert.equal(isLikelyModelId('a'), false);
    assert.equal(isLikelyModelId(''), false);
});

test('isLikelyModelId：超长（129 字符）被拒绝', () => {
    assert.equal(isLikelyModelId('a'.repeat(129)), false);
});

test('isLikelyModelId：非字符串被拒绝', () => {
    assert.equal(isLikelyModelId(null), false);
    assert.equal(isLikelyModelId(undefined), false);
    assert.equal(isLikelyModelId(123), false);
    assert.equal(isLikelyModelId({ id: 'gpt-4o' }), false);
});

// ───────── partitionModelIds ─────────
test('partitionModelIds：混合列表中合法项与垃圾项被正确分开', () => {
    const { valid, rejected } = partitionModelIds([
        'gpt-4o', '当前无可用模型', 'gpt-4o-mini', 'model not available'
    ]);
    assert.deepEqual(valid, ['gpt-4o', 'gpt-4o-mini']);
    assert.equal(rejected.length, 2);
    assert.equal(rejected[0], '当前无可用模型');
});

test('partitionModelIds：空数组 / 非数组入参不抛错', () => {
    assert.deepEqual(partitionModelIds([]), { valid: [], rejected: [] });
    assert.deepEqual(partitionModelIds(null), { valid: [], rejected: [] });
    assert.deepEqual(partitionModelIds(undefined), { valid: [], rejected: [] });
});

test('partitionModelIds：全部合法时 rejected 为空', () => {
    const r = partitionModelIds(['a-b', 'c-d']);
    assert.deepEqual(r.valid, ['a-b', 'c-d']);
    assert.deepEqual(r.rejected, []);
});

// ───────── 常量 ─────────
test('常量导出：MODEL_ID_RE / JUNK_HINTS 可用', () => {
    assert.equal(MODEL_ID_RE.test('gpt-4o'), true);
    assert.equal(MODEL_ID_RE.test('有中文'), false);
    assert.equal(JUNK_HINTS.test('无可用模型'), true);
});
