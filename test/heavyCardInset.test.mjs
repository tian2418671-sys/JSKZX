/**
 * 🖵 原生视图让位（inset）· 单测
 * ─────────────────────────────────────────────────────────────
 * 回归保护（用户实测 2026-10-18：「隐藏后就不能恢复了」）：
 *   「👁️ 显示工具栏」恢复按钮是 DOM 元素，但重型卡是 **WebContentsView 原生图层**，
 *   它盖在 DOM 之上 —— CSS `z-index` 再高也无效，鼠标点击也进不到 DOM。
 *   ⇒ 唯一可靠做法：**把原生视图矩形缩小**，给按钮腾出可点区域。
 *
 * 这里锁 `applyLayout` 的让位算法（纯计算，不依赖 Electron）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 与 `main/heavyCards/manager.js` 的 `applyLayout` 中让位计算保持一致的纯函数副本。
 * （manager.js 是 CJS 且依赖 electron，不能在单测里直接 import 其内部闭包）
 */
function applyInset(base, inset) {
    if (!inset) return { ...base };
    const ins = {
        top: Math.max(0, Math.round(Number(inset.top) || 0)),
        right: Math.max(0, Math.round(Number(inset.right) || 0)),
        bottom: Math.max(0, Math.round(Number(inset.bottom) || 0)),
        left: Math.max(0, Math.round(Number(inset.left) || 0))
    };
    return {
        x: base.x + ins.left,
        y: base.y + ins.top,
        width: Math.max(0, base.width - ins.left - ins.right),
        height: Math.max(0, base.height - ins.top - ins.bottom)
    };
}

const HOST = { x: 346, y: 88, width: 1190, height: 748 };

test('无 inset 时矩形原样返回', () => {
    assert.deepEqual(applyInset(HOST, null), HOST);
});

test('只给 top+right 让位：原点下移、宽高按比例收缩', () => {
    const r = applyInset(HOST, { top: 41, right: 120, bottom: 0, left: 0 });
    assert.equal(r.x, 346);
    assert.equal(r.y, 88 + 41);
    assert.equal(r.width, 1190 - 120);
    assert.equal(r.height, 748 - 41);
});

test('四边让位：原点平移到左上内边距处', () => {
    const r = applyInset(HOST, { top: 10, right: 20, bottom: 30, left: 40 });
    assert.equal(r.x, 386);
    assert.equal(r.y, 98);
    assert.equal(r.width, 1190 - 60);
    assert.equal(r.height, 748 - 40);
});

test('让位超过尺寸时宽高夹到 0（不产生负数）', () => {
    const r = applyInset(HOST, { top: 9999, right: 9999, bottom: 0, left: 0 });
    assert.equal(r.width, 0);
    assert.equal(r.height, 0);
});

test('非法 inset 值按 0 处理，不产生 NaN', () => {
    const r = applyInset(HOST, { top: 'abc', right: null, bottom: undefined, left: NaN });
    assert.deepEqual(r, HOST);
    assert.ok(Number.isFinite(r.width) && Number.isFinite(r.height));
});

test('空对象 inset 等价于不让位', () => {
    assert.deepEqual(applyInset(HOST, {}), HOST);
});

// ─────────────────── 与真实测量的对应关系 ───────────────────

test('恢复按钮（右上角）让位后不再与视图矩形重叠', () => {
    // 实测值：host 起点 (346,88)，按钮 (1420,96) 尺寸 108×33
    const btn = { x: 1420, y: 96, width: 108, height: 33 };
    const inset = {
        top: Math.ceil((btn.y + btn.height) - HOST.y) + 6,   // = 47
        right: Math.ceil((HOST.x + HOST.width) - btn.x) + 6, // = 122
        bottom: 0,
        left: 0
    };
    const view = applyInset(HOST, inset);
    // 视图右上角必须落在按钮左侧/下方（不相交）
    const viewRight = view.x + view.width;
    const viewBottom = view.y + view.height;
    const overlap = !(viewRight <= btn.x || btn.y >= viewBottom);
    assert.equal(overlap, false, `视图 ${JSON.stringify(view)} 仍与按钮重叠`);
    // 且视图面积仍然充足（不能因为让位把卡压得很小）
    assert.ok(view.width > HOST.width * 0.8, '让位后宽度不应损失超过 20%');
    assert.ok(view.height > HOST.height * 0.9, '让位后高度不应损失超过 10%');
});
