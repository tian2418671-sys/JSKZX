/**
 * 🎬 重型卡 · IPC 克隆安全单测
 * ─────────────────────────────────────────────────────────────
 * 回归保护：2026-10-18 自动热测抓获的真 bug ——
 *   `settings: { ...card.settings }` 只拷贝第一层，`settings.autoBackup` 仍是 Vue 的
 *   reactive Proxy，structured clone 抛 `An object could not be cloned.`，
 *   导致 openHeavyCard 直接 return false（表现为点卡无反应、徽标永远 error）。
 *
 * 这里用真实的 Vue reactive/ref 复现，并用 structuredClone 模拟 IPC 序列化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, ref } from 'vue';
import {
    toPlainSettings,
    normalizeHeavyCard,
    PRESET_HEAVY_CARD
} from '../js/composables/useHeavyCards.js';

/** 构造一个与 App.vue 里一致的响应式卡对象 */
function reactiveCard() {
    return reactive(normalizeHeavyCard({ ...PRESET_HEAVY_CARD, createdAt: 1 }));
}

test('toPlainSettings：返回对象可被 structuredClone（IPC 可传）', () => {
    const card = reactiveCard();
    const plain = toPlainSettings(card.settings);
    assert.doesNotThrow(() => structuredClone(plain), '纯对象应能跨 IPC');
});

test('toPlainSettings：原始 reactive settings 直接 clone 会抛错（证明该 bug 真实存在）', () => {
    const card = reactiveCard();
    // 这正是旧实现 `settings: { ...card.settings }` 的行为：一层浅拷贝
    const shallow = { ...card.settings };
    assert.throws(() => structuredClone(shallow), /could not be cloned/i);
});

test('toPlainSettings：嵌套 autoBackup 被完全展开为普通对象', () => {
    const card = reactiveCard();
    const plain = toPlainSettings(card.settings);
    assert.equal(Object.getPrototypeOf(plain), Object.prototype);
    assert.equal(Object.getPrototypeOf(plain.autoBackup), Object.prototype);
    assert.equal(plain.autoBackup.enabled, true);
    assert.equal(plain.autoBackup.intervalMin, 30);
    assert.equal(plain.autoBackup.keep, 5);
});

test('toPlainSettings：白名单数组拷成新数组（不与源共享引用）', () => {
    const src = { offline: true, offlineWhitelist: ['a.com', 'b.com'] };
    const plain = toPlainSettings(src);
    assert.deepEqual(plain.offlineWhitelist, ['a.com', 'b.com']);
    plain.offlineWhitelist.push('c.com');
    assert.equal(src.offlineWhitelist.length, 2, '不应污染源数组');
});

test('toPlainSettings：空/非法输入回退到安全默认值', () => {
    for (const bad of [null, undefined, 0, 'x', []]) {
        const p = toPlainSettings(bad);
        assert.equal(p.offline, false);
        assert.equal(p.zoom, 1);
        assert.equal(p.allowExternal, true);
        assert.equal(p.autoBackup.intervalMin, 30);
        assert.equal(p.autoBackup.keep, 5);
    }
});

test('toPlainSettings：数值字段越界时被夹紧', () => {
    const p1 = toPlainSettings({ zoom: 99, autoBackup: { keep: 999, intervalMin: 5 } });
    assert.equal(p1.zoom, 2);
    assert.equal(p1.autoBackup.keep, 20);

    const p2 = toPlainSettings({ zoom: 0.01, autoBackup: { keep: -3 } });
    assert.equal(p2.zoom, 0.5);
    assert.equal(p2.autoBackup.keep, 1);
});

test('toPlainSettings：NaN 不穿透（避免 NaN 序列化成 null）', () => {
    const p = toPlainSettings({ zoom: NaN, autoBackup: { intervalMin: NaN, keep: NaN } });
    assert.equal(p.zoom, 1);
    assert.equal(p.autoBackup.intervalMin, 30);
    assert.equal(p.autoBackup.keep, 5);
    assert.doesNotThrow(() => JSON.stringify(p));
});

test('toPlainSettings：在 ref 包装下同样可用', () => {
    const c = ref(normalizeHeavyCard({ ...PRESET_HEAVY_CARD }));
    const plain = toPlainSettings(c.value.settings);
    assert.doesNotThrow(() => structuredClone(plain));
});
