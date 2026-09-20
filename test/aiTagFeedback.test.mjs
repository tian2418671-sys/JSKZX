/**
 * 🏷️ 打标过程反馈（错误归类 + 失败聚合）单测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyApiError, summarizeFailures } from '../js/utils/aiTagFeedback.js';

test('classifyApiError：401 / invalid api key → 认证失败（用户截图原样报错）', () => {
    const raw = 'HTTP 错误: 401 - {"error":{"message":"invalid API key","type":"authentication_error","param":null,"code":"invalid_api_key"}}';
    const r = classifyApiError(raw);
    assert.equal(r.code, 'auth');
    assert.ok(r.label.includes('密钥'));
});

test('classifyApiError：403 / unauthorized 同样归认证类', () => {
    assert.equal(classifyApiError('HTTP 错误: 403 - Forbidden').code, 'auth');
    assert.equal(classifyApiError('Unauthorized').code, 'auth');
});

test('classifyApiError：429 / timeout / fetch failed / ECONNREFUSED 各归其类', () => {
    assert.equal(classifyApiError('HTTP 错误: 429 - rate limit exceeded').code, 'rate');
    assert.equal(classifyApiError('TimeoutError: The operation was aborted').code, 'network');
    assert.equal(classifyApiError('fetch failed').code, 'network');
    assert.equal(classifyApiError('connect ECONNREFUSED 127.0.0.1:1234').code, 'network');
});

test('classifyApiError：模型格式异常与其他错误', () => {
    assert.equal(classifyApiError('模型未返回有效的 JSON 数组: 你好呀').code, 'format');
    const other = classifyApiError('一些奇怪的自定义错误');
    assert.equal(other.code, 'other');
    assert.equal(other.label, '一些奇怪的自定义错误');
});

test('classifyApiError：空值兜底不抛异常', () => {
    assert.equal(classifyApiError(null).code, 'other');
    assert.equal(classifyApiError(undefined).label, '未知错误');
    assert.equal(classifyApiError(123).code, 'other');
});

test('classifyApiError：other 类原文截断 200 字', () => {
    const r = classifyApiError('X'.repeat(500));
    assert.equal(r.label.length, 200);
});

test('summarizeFailures：同类聚合计数（用户场景：8 张全部 401）', () => {
    const one = 'HTTP 错误: 401 - {"error":{"message":"invalid API key"}}';
    const list = Array.from({ length: 8 }, (_, i) => ({ name: `卡${i}`, raw: one }));
    const out = summarizeFailures(list);
    assert.equal(out.length, 1);
    assert.ok(out[0].includes('×8'));
    assert.ok(out[0].includes('密钥'));
});

test('summarizeFailures：混合类别分别聚合；兼容纯字符串输入；空输入空输出', () => {
    const out = summarizeFailures([
        { raw: 'HTTP 错误: 401 - invalid api key' },
        'TimeoutError: aborted',
        { raw: 'HTTP 错误: 401 - invalid api key' }
    ]);
    assert.equal(out.length, 2);
    assert.ok(out.some(l => l.includes('×2')));
    assert.deepEqual(summarizeFailures([]), []);
    assert.deepEqual(summarizeFailures(null), []);
});
