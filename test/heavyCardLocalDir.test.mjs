/**
 * 📂 重型卡「本地 HTML」导入：字段保真回归
 *
 * 背景（2026-10-25 用户反馈）：重型卡宣称支持本地 HTML，但**找不到导入入口** ——
 * 补了入口之后还有一个更隐蔽的坑：`normalizeHeavyCard` 是**白名单式归一化**，
 * 没被显式列出的字段会被静默丢弃。
 * 如果 `localDir` 不在白名单里，表现就是：
 *   「导入本地卡后列表里有了、点开却还是走远程地址 / 打不开」 —— 极难定位。
 *
 * 这些用例就是钉住这一点：只要 `localDir` 被丢弃，这里立刻红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHeavyCard } from '../js/composables/useHeavyCards.js';

test('★ normalizeHeavyCard 必须保留 localDir（白名单回归）', () => {
    const c = normalizeHeavyCard({
        id: 'hc_test1',
        name: '本地测试卡',
        url: 'heavycard-local://x/index.html',
        localDir: 'D:\\Cards\\MyLocalCard'
    });
    assert.equal(c.localDir, 'D:\\Cards\\MyLocalCard', 'localDir 被丢弃了 ⇒ 本地卡会走远程地址');
});

test('★ localDir 缺省时为空字符串（不是 undefined）', () => {
    const c = normalizeHeavyCard({ id: 'hc_test2', name: 'x', url: 'https://a.com' });
    assert.equal(c.localDir, '');
    assert.equal(typeof c.localDir, 'string');
});

test('★ localDir 非字符串时不崩（脏配置防御）', () => {
    const c = normalizeHeavyCard({ id: 'hc_test3', name: 'x', url: 'https://a.com', localDir: 12345 });
    assert.equal(c.localDir, '12345');
    const c2 = normalizeHeavyCard({ id: 'hc_test4', name: 'x', url: 'https://a.com', localDir: null });
    assert.equal(c2.localDir, '');
});

test('★ 本地卡往返归一化不丢 localDir（模拟重启后从配置读回）', () => {
    const once = normalizeHeavyCard({
        id: 'hc_test5', name: '卡', url: 'heavycard-local://x/index.html', localDir: 'E:\\a\\b', gen: 2
    });
    const twice = normalizeHeavyCard(once);
    assert.equal(twice.localDir, 'E:\\a\\b');
    assert.equal(twice.gen, 2);
});
