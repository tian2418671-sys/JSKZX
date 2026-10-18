/**
 * 🎬 重型卡（独立前端角色卡）· 纯函数单测
 * 覆盖：id 派生 / 名称猜测 / 清单归一化 / 配置收集与恢复容错
 * 不测 iframe / WebContentsView（需要真实 Electron，由冒烟覆盖）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeHeavyCardId,
    guessNameFromUrl,
    normalizeHeavyCard,
    PRESET_HEAVY_CARD
} from '../js/composables/useHeavyCards.js';

test('makeHeavyCardId：稳定前缀 + 不重复', () => {
    const a = makeHeavyCardId('https://jfdk.xxbjf.com/yd_rsdtq/index.html');
    const b = makeHeavyCardId('https://jfdk.xxbjf.com/yd_rsdtq/index.html');
    assert.match(a, /^hc_/);
    assert.notEqual(a, b, '两次调用应生成不同 id（含时间后缀）');
});

test('makeHeavyCardId：空输入也能生成合法 id', () => {
    const id = makeHeavyCardId('');
    assert.match(id, /^hc_/);
    assert.ok(id.length > 3);
});

// ─────────────────────────────────────────────────────────────
// ⚠️ 2026-10-18 行为变更（用户实测反馈「名字显示成地址」）：
//    `yd_rsdtq` 这类**纯英文路径段**对人没有意义，不再是好名字。
//    现在：中文路径段才直接用；纯英文标识符（无连续元音）回退到域名。
//    真正的名字由主进程在页面加载后回传 <title> 覆盖（heavycard:title）。
// ─────────────────────────────────────────────────────────────

test('guessNameFromUrl：中文路径段直接用作名字', () => {
    assert.equal(
        guessNameFromUrl('https://example.com/%E4%BA%91%E7%AB%AF%E4%BA%BA%E7%94%9F/index.html'),
        '云端人生'
    );
});

test('guessNameFromUrl：纯英文标识符路径段回退到域名（不再显示 yd_rsdtq）', () => {
    assert.equal(
        guessNameFromUrl('https://jfdk.xxbjf.com/yd_rsdtq/index.html'),
        'jfdk.xxbjf.com'
    );
});

test('guessNameFromUrl：可读英文单词仍保留', () => {
    assert.equal(guessNameFromUrl('https://example.com/adventure/index.html'), 'adventure');
});

test('guessNameFromUrl：无有效路径段时回退到域名', () => {
    assert.equal(guessNameFromUrl('https://example.com/'), 'example.com');
});

test('guessNameFromUrl：非法 URL 不抛错', () => {
    const n = guessNameFromUrl('not a url');
    assert.equal(typeof n, 'string');
    assert.ok(n.length > 0);
});

test('normalizeHeavyCard：补齐缺失字段', () => {
    const c = normalizeHeavyCard({ id: 'hc_x', url: 'https://a.com/' });
    assert.equal(c.gen, 1);
    assert.match(c.partition, /^persist:heavycard-hc_x_g1$/);
    assert.equal(c.icon, '🎬');
    assert.equal(c.settings.autoBackup.enabled, true);
    assert.equal(c.settings.autoBackup.onExit, true);
    assert.equal(c.settings.autoBackup.keep, 5);
    assert.equal(c.settings.autoBackup.intervalMin, 30);
});

test('normalizeHeavyCard：clamp 非法值', () => {
    const c = normalizeHeavyCard({
        id: 'hc_y',
        gen: -5,
        settings: { zoom: 99, autoBackup: { keep: 999, intervalMin: NaN } }
    });
    assert.equal(c.gen, 1, 'gen 不得 < 1');
    assert.equal(c.settings.zoom, 2, 'zoom 上限 2');
    assert.equal(c.settings.autoBackup.keep, 20, 'keep 上限 20');
    assert.equal(c.settings.autoBackup.intervalMin, 30, 'NaN 回退默认 30');
});

test('normalizeHeavyCard：缺 id 返回 null（脏数据不进清单）', () => {
    assert.equal(normalizeHeavyCard({}), null);
    assert.equal(normalizeHeavyCard(null), null);
});

test('normalizeHeavyCard：partition 与 gen 保持一致', () => {
    const c = normalizeHeavyCard({ id: 'hc_z', gen: 3 });
    assert.equal(c.partition, 'persist:heavycard-hc_z_g3');
});

test('PRESET_HEAVY_CARD：预置卡字段完整', () => {
    const c = normalizeHeavyCard({ ...PRESET_HEAVY_CARD });
    assert.equal(c.id, 'hc_ydrs');
    assert.equal(c.name, '云端人生');
    assert.match(c.url, /^https:\/\//);
    assert.equal(c.gen, 1);
});
