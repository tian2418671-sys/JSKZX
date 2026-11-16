/**
 * 📥 下载进度读数（纯函数）单测
 * 背景（2026-11-16 用户反馈）：下载只有进度条没有数值，几十 MB 在慢网下看不出下到哪了；
 * 改为流式统计后必须保证「百分比不虚报 100%」「总量未知时不装懂」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    readTotalBytes,
    computePercent,
    computeSpeed,
    buildDownloadReadout,
    shouldEmit,
    mapToOverall,
} = require('../main/downloadProgress.js');

test('readTotalBytes：content-length（数字 / 字符串 / Headers 对象）', () => {
    assert.equal(readTotalBytes({ 'content-length': '36700160' }), 36700160);
    assert.equal(readTotalBytes({ 'Content-Length': 1024 }), 1024);
    const headers = new Map([['content-length', '2048']]);
    assert.equal(readTotalBytes({ get: (k) => headers.get(k) ?? null }), 2048);
});

test('readTotalBytes：没有长度（chunked）→ 0，绝不当成「总量为 0 已完成」', () => {
    assert.equal(readTotalBytes(null), 0);
    assert.equal(readTotalBytes({}), 0);
    assert.equal(readTotalBytes({ 'content-length': '0' }), 0);
    assert.equal(readTotalBytes({ 'content-length': 'abc' }), 0);
});

test('readTotalBytes：content-range 里的总量兜底', () => {
    assert.equal(readTotalBytes({ 'content-range': 'bytes 0-1023/36700160' }), 36700160);
    assert.equal(readTotalBytes({ 'content-range': 'bytes 0-1023/*' }), 0);
});

test('computePercent：中途不显示 100%，只有收完才 100%', () => {
    assert.equal(computePercent(0, 1000), 0);
    assert.equal(computePercent(500, 1000), 50);
    assert.equal(computePercent(999, 1000), 99);
    assert.equal(computePercent(1000, 1000), 100);
    assert.equal(computePercent(1200, 1000), 100); // 传输超额也封顶 100
});

test('computePercent：总量未知返回 -1（界面改说「已下载 X」）', () => {
    assert.equal(computePercent(0, 0), -1);
    assert.equal(computePercent(12345, 0), -1);
    assert.equal(computePercent(12345, -5), -1);
});

test('computeSpeed：太短时间内不出速度（防抖出几 TB/s）', () => {
    assert.equal(computeSpeed(1e6, 100), 0);
    assert.equal(computeSpeed(1e6, 0), 0);
    assert.equal(computeSpeed(2e6, 2000), 1e6);
});

test('buildDownloadReadout：正常情形读数形如 `37% · 13.0 MB / 35.0 MB · 3.1 MB/s`', () => {
    const total = 36700160;
    const received = 13600000; // 37.05%
    const r = buildDownloadReadout({ received, total, elapsedMs: 4000 });
    assert.equal(r.percent, 37);
    assert.match(r.text, /^37% · \d+\.\d MB \/ 35\.0 MB · \d+\.\d MB\/s$/);
    assert.match(r.detail, /^13\.0 MB \/ 35\.0 MB · /);
});

test('buildDownloadReadout：总量未知时只说已下载量', () => {
    const r = buildDownloadReadout({ received: 1048576, total: 0, elapsedMs: 1000 });
    assert.equal(r.percent, -1);
    assert.equal(r.text, r.detail);
    assert.match(r.detail, /^已下载 1\.0 MB/);
});

test('buildDownloadReadout：刚开始（无速度）也不出错', () => {
    const r = buildDownloadReadout({ received: 0, total: 1000, elapsedMs: 0 });
    assert.equal(r.percent, 0);
    assert.ok(!r.detail.includes('/s'));
});

test('shouldEmit：首个 tick 立即推送，之后按间隔节流', () => {
    assert.equal(shouldEmit(0, 1000, 250), true);
    assert.equal(shouldEmit(1000, 1100, 250), false);
    assert.equal(shouldEmit(1000, 1250, 250), true);
    assert.equal(shouldEmit(1000, 999, 250), false); // 时钟回拨不炸
});

test('mapToOverall：阶段内百分比映射到整条进度条区间', () => {
    assert.equal(mapToOverall(0, 10, 45), 10);
    assert.equal(mapToOverall(50, 10, 45), 28);
    assert.equal(mapToOverall(100, 10, 45), 45);
    assert.equal(mapToOverall(-1, 10, 45), 10); // 未知 → 停在区间起点
    assert.equal(mapToOverall(120, 10, 45), 45); // 越界夹住
    assert.equal(mapToOverall(NaN, 10, 45), 10);
});
