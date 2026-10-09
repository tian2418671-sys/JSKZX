/**
 * 🧩 预填充兼容判定 单测（`js/utils/prefillCompat.js`）
 * 覆盖：键归一 / 错误识别（含包装 JSON）/ 三态决策矩阵 / 记忆更新（纯函数）/ 脏配置清洗。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PREFILL_MODES, DEFAULT_PREFILL_MODE, normalizePrefillMode, hostOf, apiCompatKey,
    isPrefillRejected, decidePrefill, recordCompat, sanitizeCompatTable, describeCompat
} from '../js/utils/prefillCompat.js';

test('normalizePrefillMode：三态白名单，脏值回退 auto', () => {
    assert.equal(PREFILL_MODES.length, 3);
    assert.deepEqual(PREFILL_MODES.map((m) => m.id), ['auto', 'always', 'never']);
    assert.equal(normalizePrefillMode('always'), 'always');
    assert.equal(normalizePrefillMode('never'), 'never');
    for (const v of ['', null, undefined, 'AUTO', 'x', 42, {}]) assert.equal(normalizePrefillMode(v), DEFAULT_PREFILL_MODE);
});

test('hostOf：从 endpoint 取主机；脏值不崩', () => {
    assert.equal(hostOf('https://api.example.com/v1/chat/completions'), 'api.example.com');
    assert.equal(hostOf('api.example.com/v1'), 'api.example.com');
    assert.equal(hostOf(''), '(未配置)');
    assert.equal(hostOf(null), '(未配置)');
    assert.ok(hostOf('http://127.0.0.1:8000/api').startsWith('127.0.0.1'));
});

test('★ apiCompatKey：按「主机 + 模型 + 类型」记忆，换模型/换端点各自记', () => {
    const a = apiCompatKey({ endpoint: 'https://api.gemini.example.com/v1', model: 'Gemini-2.5-Pro', type: 'openai' });
    const b = apiCompatKey({ endpoint: 'https://api.gemini.example.com/v1', model: 'gemini-2.5-pro', type: 'openai' });
    assert.equal(a, b, '模型大小写不敏感');
    assert.notEqual(a, apiCompatKey({ endpoint: 'https://api.gemini.example.com/v1', model: 'other', type: 'openai' }));
    assert.notEqual(a, apiCompatKey({ endpoint: 'https://other.host/v1', model: 'Gemini-2.5-Pro', type: 'openai' }));
    assert.ok(apiCompatKey({}).includes('*'), '空模型/空类型用 * 占位');
});

test('★★ isPrefillRejected：识别用户实测那条错误（含被包装成 HTTP 错误串）', () => {
    const real = 'HTTP 错误: 400 - {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error"}}';
    assert.equal(isPrefillRejected(new Error(real)), true, '用户实测原文必须命中');
    assert.equal(isPrefillRejected(real), true, '字符串也能判');
    assert.equal(isPrefillRejected(new Error('last message must be a user message')), true);
    assert.equal(isPrefillRejected(new Error('messages must end with a user turn')), true);
    assert.equal(isPrefillRejected(new Error('该接口不支持以模型轮结尾的请求')), true);
    assert.equal(isPrefillRejected(new Error('HTTP 错误: 429 - rate limit')), false, '限流不算');
    assert.equal(isPrefillRejected(new Error('HTTP 错误: 401 - invalid api key')), false);
    assert.equal(isPrefillRejected(null), false);
    assert.equal(isPrefillRejected({}), false);
});

test('★ decidePrefill：三态决策矩阵', () => {
    const key = 'k1';
    const t = { [key]: { support: false, samples: 1 } };
    // 没配预填充 ⇒ 一律不带
    assert.deepEqual(decidePrefill({ mode: 'auto', key, table: t, hasPrefill: false }).usePrefill, false);
    assert.equal(decidePrefill({ mode: 'auto', key, table: t, hasPrefill: false }).reason, 'no-prefill-text');
    // auto + 已记住不支持 ⇒ 跳过；未判定 ⇒ 先试
    assert.equal(decidePrefill({ mode: 'auto', key, table: t, hasPrefill: true }).usePrefill, false);
    assert.equal(decidePrefill({ mode: 'auto', key, table: t, hasPrefill: true }).reason, 'learned-unsupported');
    assert.match(decidePrefill({ mode: 'auto', key, table: t, hasPrefill: true }).label, /已记住/);
    assert.equal(decidePrefill({ mode: 'auto', key, table: {}, hasPrefill: true }).usePrefill, true, '未判定先试');
    assert.equal(decidePrefill({ mode: 'auto', key, table: { [key]: { support: true } }, hasPrefill: true }).usePrefill, true);
    // 手动覆盖
    assert.equal(decidePrefill({ mode: 'always', key, table: t, hasPrefill: true }).usePrefill, true, 'always 忽略记忆');
    assert.equal(decidePrefill({ mode: 'always', key, table: t, hasPrefill: true }).reason, 'mode-always');
    assert.equal(decidePrefill({ mode: 'never', key, table: {}, hasPrefill: true }).usePrefill, false);
    assert.equal(decidePrefill({ mode: 'never', key, table: {}, hasPrefill: true }).reason, 'mode-never');
});

test('★ recordCompat：纯函数（不动原表）+ 计数累加', () => {
    const table = {};
    const t1 = recordCompat({ table, key: 'k', ok: false, note: 'model turn', at: '2026-10-03T00:00:00.000Z' });
    assert.deepEqual(table, {}, '原表未被修改');
    assert.equal(t1.k.support, false);
    assert.equal(t1.k.samples, 1);
    const t2 = recordCompat({ table: t1, key: 'k', ok: true, at: '2026-10-03T01:00:00.000Z' });
    assert.equal(t2.k.support, true, '后来成功可覆盖（用户换模型/改上游）');
    assert.equal(t2.k.samples, 2);
    assert.equal(recordCompat({ table: t1 }).k.support, false, '无 key ⇒ 原样返回副本');
});

test('sanitizeCompatTable：脏配置清洗（恢复配置时用）', () => {
    const out = sanitizeCompatTable({
        good: { support: false, at: 'x', note: 'y', samples: 3 },
        dirty: { support: 'yes', samples: -5 },
        bad1: null, bad2: 'str', '': { support: true }
    });
    assert.deepEqual(Object.keys(out), ['good', 'dirty']);
    assert.equal(out.good.support, false);
    assert.equal(out.dirty.support, false, '非布尔 true 一律 false');
    assert.equal(out.dirty.samples, 0, '负数归零');
    assert.deepEqual(sanitizeCompatTable(null), {});
    assert.deepEqual(sanitizeCompatTable('x'), {});
});

test('describeCompat：UI 文案（含"已自动判定"）', () => {
    assert.match(describeCompat({ mode: 'auto', key: 'k', table: {}, hasPrefill: false }).text, /关闭/);
    assert.match(describeCompat({ mode: 'never', key: 'k', table: {}, hasPrefill: true }).text, /从不发/);
    assert.match(describeCompat({ mode: 'auto', key: 'k', table: { k: { support: false } }, hasPrefill: true }).text, /不支持.*自动跳过/);
    assert.match(describeCompat({ mode: 'auto', key: 'k', table: { k: { support: true } }, hasPrefill: true }).text, /支持预填充/);
    assert.match(describeCompat({ mode: 'auto', key: 'k', table: {}, hasPrefill: true }).text, /尚未判定/);
});
