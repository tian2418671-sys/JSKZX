/**
 * ⏯️ 断点续传（纯函数）单测
 * 背景（2026-11-16 用户需求）：软件被意外关闭后，36.7MB 的安装包不该从头再下。
 * 这里锁住三条铁律：① 只有 206 且起点对得上才允许追加；② 不支持 Range 必须能退回从头下；
 * ③ 元数据一旦版本/结构不符就当作没有，绝不拿错位的片段拼出一个坏 zip。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    META_VERSION,
    parseContentRange,
    buildRangeHeaders,
    decideResume,
    normalizeMeta,
    makeMeta,
    isPartComplete,
    prioritizeResumeSource,
    checkZipTail,
    isRangeProbeOk,
    pickResumeSource,
    shouldAbandonResume,
} = require('../main/downloadResume.js');

test('parseContentRange：正常 / 未知总量 / 垃圾输入', () => {
    assert.deepEqual(parseContentRange('bytes 1024-2047/36700160'), { start: 1024, end: 2047, total: 36700160 });
    assert.deepEqual(parseContentRange('bytes 0-0/*'), { start: 0, end: 0, total: 0 });
    assert.equal(parseContentRange(''), null);
    assert.equal(parseContentRange('bytes abc/1'), null);
});

test('buildRangeHeaders：没有偏移就不加头；有偏移带 Range + If-Range', () => {
    assert.deepEqual(buildRangeHeaders({ offset: 0 }), {});
    assert.deepEqual(buildRangeHeaders({ offset: -5 }), {});
    const h = buildRangeHeaders({ offset: 1234, etag: '"abc"' });
    assert.equal(h.Range, 'bytes=1234-');
    assert.equal(h['If-Range'], '"abc"');
    // 没有 ETag 时退而用 Last-Modified 做校验
    assert.equal(buildRangeHeaders({ offset: 1, lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' })['If-Range'], 'Wed, 21 Oct 2015 07:28:00 GMT');
    // 两个都没有也不能崩
    assert.deepEqual(Object.keys(buildRangeHeaders({ offset: 1 })), ['Range']);
});

test('decideResume：206+起点吻合 → append；起点不符 → restart', () => {
    assert.equal(decideResume({ offset: 1000, status: 206, contentRange: 'bytes 1000-1999/5000' }), 'append');
    assert.equal(decideResume({ offset: 1000, status: 206, contentRange: 'bytes 0-1999/5000' }), 'restart');
    assert.equal(decideResume({ offset: 1000, status: 206, contentRange: 'garbage' }), 'restart');
});

test('decideResume：不支持 Range（200）/ 416 / 无偏移 → 都从头来（416 视为可能已完整）', () => {
    assert.equal(decideResume({ offset: 1000, status: 200 }), 'restart');
    assert.equal(decideResume({ offset: 0, status: 206, contentRange: 'bytes 0-1/2' }), 'restart');
    assert.equal(decideResume({ offset: 5000, status: 416 }), 'complete');
    assert.equal(decideResume(), 'restart');
});

test('normalizeMeta：版本不符 / 垃圾 → null（宁可不续传，也不拼坏文件）', () => {
    assert.equal(normalizeMeta(null), null);
    assert.equal(normalizeMeta('x'), null);
    assert.equal(normalizeMeta({ version: META_VERSION - 1, url: 'u', total: 10 }), null);
    assert.equal(normalizeMeta({ url: 'u', total: 10 }), null); // 无 version
    assert.deepEqual(
        normalizeMeta({ version: META_VERSION, url: 'u', total: 10, etag: '"e"' }),
        { url: 'u', total: 10, etag: '\"e\"', lastModified: '', rateBps: 0 },
    );
    // total 非法（<=0 / NaN）→ 视为未知，但仍可用于识别源
    assert.equal(normalizeMeta({ version: META_VERSION, total: 'abc' }).total, 0);
});

test('makeMeta / normalizeMeta 往返一致', () => {
    const m = makeMeta({ url: 'https://x/z.zip', total: 123.9, etag: '"v1"', lastModified: 'lm' });
    assert.equal(m.version, META_VERSION);
    assert.equal(m.total, 123);
    assert.ok(m.savedAt);
    assert.deepEqual(normalizeMeta(m), { url: 'https://x/z.zip', total: 123, etag: '\"v1\"', lastModified: 'lm', rateBps: 0 });
});

test('isPartComplete：只有「知道总量且片段够长」才算完成', () => {
    assert.equal(isPartComplete({ partBytes: 100, total: 100 }), true);
    assert.equal(isPartComplete({ partBytes: 120, total: 100 }), true);
    assert.equal(isPartComplete({ partBytes: 99, total: 100 }), false);
    assert.equal(isPartComplete({ partBytes: 100, total: 0 }), false); // 不知道总量就不猜
    assert.equal(isPartComplete(), false);
});

test('prioritizeResumeSource：把上次的源提到最前；没有则不乱动', () => {
    const a = 'https://codeload.github.com/x/zip';
    const b = 'https://ghfast.top/https://codeload.github.com/x/zip';
    const c = 'https://gh-proxy.com/https://codeload.github.com/x/zip';
    assert.deepEqual(prioritizeResumeSource([a, b, c], c), { list: [c, a, b], resumedSource: true });
    assert.deepEqual(prioritizeResumeSource([a, b, c], a), { list: [a, b, c], resumedSource: true });
    // 上次的源不在候选里（例如探测结果变了）→ 仍然优先它，才可能续传
    assert.deepEqual(prioritizeResumeSource([a], b), { list: [b, a], resumedSource: false });
    assert.deepEqual(prioritizeResumeSource([a], ''), { list: [a], resumedSource: false });
});

test('isRangeProbeOk：只有 206 且起点为 0 才算支持续传（实测 codeload 恒 200）', () => {
    assert.equal(isRangeProbeOk({ status: 206, contentRange: 'bytes 0-0/38439126' }), true);
    assert.equal(isRangeProbeOk({ status: 200, contentRange: null }), false);
    assert.equal(isRangeProbeOk({ status: 206, contentRange: 'bytes 5-5/38439126' }), false);
    assert.equal(isRangeProbeOk({ status: 206, contentRange: '' }), false);
    assert.equal(isRangeProbeOk(), false);
});

test('pickResumeSource：优先能续传且总量一致的源；没有则空', () => {
    const probes = [
        { url: 'direct', ok: false, total: 0, ms: 700 },
        { url: 'proxy-slow', ok: true, total: 38439126, ms: 900 },
        { url: 'proxy-fast', ok: true, total: 38439126, ms: 300 },
    ];
    assert.equal(pickResumeSource(probes, { total: 38439126 }), 'proxy-fast');
    // 指定偏好源可用 → 用偏好源
    assert.equal(pickResumeSource(probes, { total: 38439126, preferUrl: 'proxy-slow' }), 'proxy-slow');
    // 大小对不上的源要排除（换分支/换文件不能拼）
    assert.equal(pickResumeSource([
        { url: 'wrong-size', ok: true, total: 123, ms: 100 },
        { url: 'right', ok: true, total: 38439126, ms: 900 },
    ], { total: 38439126 }), 'right');
    // 谁都不支持 → 空字符串（调用方会退回从头下载）
    assert.equal(pickResumeSource([{ url: 'direct', ok: false, total: 0 }], { total: 1 }), '');
    assert.equal(pickResumeSource([], {}), '');
    // 总量严格比对：大小对不上 / 探测拿不到总量 都不能拼（不同版本/不同产物）
    assert.equal(pickResumeSource([
        { url: 'wrong-size', ok: true, total: 123, ms: 100 },
        { url: 'unknown-size', ok: true, total: 0, ms: 200 },
    ], { total: 38439126 }), '');
    assert.equal(pickResumeSource([{ url: 'unknown-size', ok: true, total: 0, ms: 200 }], { total: 0 }), 'unknown-size');
});

test('checkZipTail：合法 EOCD 通过；没有 EOCD / 中央目录越界都判坏', () => {
    // 手工构造一个最小 EOCD（22 字节）：entries=2, cdSize=100, cdOffset=200
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(2, 10);
    eocd.writeUInt32LE(100, 12);
    eocd.writeUInt32LE(200, 16);
    const good = checkZipTail(Buffer.concat([Buffer.alloc(50), eocd]), 400);
    assert.equal(good.ok, true);
    assert.equal(good.entries, 2);
    // 中央目录超出文件大小 → 坏
    assert.equal(checkZipTail(eocd, 100).ok, false);
    // 找不到 EOCD 签名 → 坏（截断文件的典型特征）
    assert.equal(checkZipTail(Buffer.alloc(1000)).ok, false);
    assert.equal(checkZipTail(Buffer.alloc(0)).ok, false);
});



test('shouldAbandonResume：镜像明显更慢才放弃续传（实测直连 2.4MB/s vs 镜像 70KB/s）', () => {
    assert.equal(shouldAbandonResume({ resumeRateBps: 70 * 1024, previousRateBps: 2.4 * 1024 * 1024 }), true);
    assert.equal(shouldAbandonResume({ resumeRateBps: 900 * 1024, previousRateBps: 1000 * 1024 }), false);
    // 不知道上次多快 / 测不出速度 → 不放弃（别乱切换源）
    assert.equal(shouldAbandonResume({ resumeRateBps: 1000, previousRateBps: 0 }), false);
    assert.equal(shouldAbandonResume({ resumeRateBps: 0, previousRateBps: 1e6 }), false);
    assert.equal(shouldAbandonResume(), false);
    // 阈值可调
    assert.equal(shouldAbandonResume({ resumeRateBps: 500, previousRateBps: 1000, factor: 0.4 }), false);
    assert.equal(shouldAbandonResume({ resumeRateBps: 500, previousRateBps: 1000, factor: 0.8 }), true);
});

