/**
 * 🏷️ 重型卡 · 页标题自动命名单测
 * ─────────────────────────────────────────────────────────────
 * 回归保护（用户实测反馈 2026-10-18）：
 *   导入新重型卡链接后，侧边栏名字显示成地址路径段（`yd_rsdtq`），不是可读文本。
 *
 * 修复思路（三层）：
 *   ① URL 猜名更保守：纯英文标识符路径段不再当名字，回退域名；
 *   ② 主进程在 `did-stop-loading` 时回传 `document.title`（`heavycard:title`）；
 *   ③ 渲染层只覆盖**自动名**（`autoName === true`），用户改过的名字绝不被冲掉。
 *
 * 这里锁 ① 和 ③ 的纯逻辑（② 需真实 Electron，由冒烟/热测覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessNameFromUrl, normalizeHeavyCard } from '../js/composables/useHeavyCards.js';

// ─────────────────── ① URL 猜名策略 ───────────────────

test('中文路径 → 直接用作名字', () => {
    assert.equal(guessNameFromUrl('https://x.com/云端人生/index.html'), '云端人生');
});

test('纯英文标识符（下划线/无连续元音）→ 回退域名', () => {
    for (const u of [
        'https://jfdk.xxbjf.com/yd_rsdtq/index.html',
        'https://a.com/abc_def/',
        'https://a.com/x1y2z3/index.html'
    ]) {
        assert.equal(guessNameFromUrl(u), new URL(u).hostname, u);
    }
});

test('可读英文单词 → 保留', () => {
    assert.equal(guessNameFromUrl('https://a.com/adventure/index.html'), 'adventure');
    assert.equal(guessNameFromUrl('https://a.com/Story'), 'Story');
});

test('带扩展名的文件 → 去掉扩展名', () => {
    assert.equal(guessNameFromUrl('https://a.com/adventure.html'), 'adventure');
});

test('根路径 → 域名', () => {
    assert.equal(guessNameFromUrl('https://example.com/'), 'example.com');
});

test('非法 URL → 占位名，不抛错', () => {
    const n = guessNameFromUrl('not a url');
    assert.equal(typeof n, 'string');
    assert.ok(n.length > 0);
});

// ─────────────────── ③ autoName 标记 ───────────────────

test('normalizeHeavyCard：新卡默认 autoName=true（允许被页面标题覆盖）', () => {
    const c = normalizeHeavyCard({
        id: 'hc_1', name: 'yd_rsdtq', url: 'https://a.com/yd_rsdtq/index.html', autoName: true
    });
    assert.equal(c.autoName, true);
});

test('normalizeHeavyCard：显式 autoName=false 时用户改名受保护', () => {
    const c = normalizeHeavyCard({
        id: 'hc_2', name: '我的卡', url: 'https://a.com/xx/index.html', autoName: false
    });
    assert.equal(c.autoName, false);
});

test('normalizeHeavyCard：旧配置无 autoName 字段时按「名字等于猜名结果」推断', () => {
    // 旧配置里名字恰好是猜出来的 → 视为自动名
    const auto = normalizeHeavyCard({
        id: 'hc_3', name: 'jfdk.xxbjf.com', url: 'https://jfdk.xxbjf.com/yd_rsdtq/index.html'
    });
    assert.equal(auto.autoName, true);

    // 旧配置里名字是用户改过的 → 视为手动名，不可覆盖
    const manual = normalizeHeavyCard({
        id: 'hc_4', name: '我自己起的名字', url: 'https://jfdk.xxbjf.com/yd_rsdtq/index.html'
    });
    assert.equal(manual.autoName, false);
});

test('normalizeHeavyCard：autoName 会随配置往返保留', () => {
    const c = normalizeHeavyCard({ id: 'hc_5', name: 'x', url: 'https://a.com/', autoName: false });
    assert.equal(c.autoName, false);
    // 再用归一化过的对象跑一次（模拟从 app_config.json 读回）
    const again = normalizeHeavyCard({ ...c });
    assert.equal(again.autoName, false);
});

// ─────────────────── ① + ③ 组合：不被地址污染 ───────────────────

test('纯英文路径段的卡，名字不会等于原始路径段', () => {
    const url = 'https://jfdk.xxbjf.com/yd_rsdtq/index.html';
    const name = guessNameFromUrl(url);
    assert.notEqual(name, 'yd_rsdtq', '不应把无意义路径段当名字');
});
