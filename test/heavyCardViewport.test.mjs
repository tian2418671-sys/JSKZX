/**
 * 🖼️ 重型卡视图视口尺寸 · 单测
 * ─────────────────────────────────────────────────────────────
 * 回归保护（用户实测 2026-10-18：「角色卡渲染不到位」）：
 *   `WebContentsView` 一旦以 **0×0** 创建，Chromium 会把渲染视口钉死在 0，
 *   **之后 setBounds 再大也救不回来**（实测：重发 920×593 后 innerWidth 恒为 0，
 *   `document.body.innerText` 有文字、但整页不可见 ⇒ 用户感知为「渲染不到位」）。
 *
 * 从侧栏点卡时 `<heavy-card-workspace>` 还没渲染出占位框 ⇒ `openHeavyCard(card, null)`。
 * 修复：渲染层先用 `waitForHostRect()` 等到有效尺寸再 open；主进程再加一道
 *      「从未拿到有效尺寸 + 本次有效 ⇒ 重建视图」的自愈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPOSABLE = fs.readFileSync(path.join(ROOT, 'js/composables/useHeavyCards.js'), 'utf-8');
const MANAGER = fs.readFileSync(path.join(ROOT, 'main/heavyCards/manager.js'), 'utf-8');

// ─────────────────── 渲染层：先等尺寸再打开 ───────────────────

test('openHeavyCard 在矩形无效时会先等待占位框', () => {
    assert.ok(COMPOSABLE.includes('const waitForHostRect = '), '缺 waitForHostRect');
    const idx = COMPOSABLE.indexOf('const openHeavyCard = ');
    const block = COMPOSABLE.slice(idx, idx + 2500);
    assert.ok(/openRect\.width <= 0 \|\| openRect\.height <= 0/.test(block), '未判断矩形是否有效');
    assert.ok(block.includes('waitForHostRect()'), '无效矩形时未调用 waitForHostRect');
    assert.ok(block.includes('heavyCard.open(effective, openRect)'), 'open 仍在使用未等待的 rect');
});

test('waitForHostRect 有超时兜底，绝不返回 0 尺寸', () => {
    const idx = COMPOSABLE.indexOf('const waitForHostRect = ');
    const block = COMPOSABLE.slice(idx, idx + 1800);
    assert.ok(block.includes('deadline'), '缺超时保护');
    assert.ok(/Math\.max\(1,/.test(block), '兜底尺寸未做正数保护（0 尺寸会钉死视口）');
    assert.ok(block.includes('heavycard-host-box'), '未按约定 id 查询占位框');
});

test('等待逻辑用 requestAnimationFrame，让 Vue 先完成 DOM 更新', () => {
    const idx = COMPOSABLE.indexOf('const waitForHostRect = ');
    const block = COMPOSABLE.slice(idx, idx + 1200);
    assert.ok(block.includes('requestAnimationFrame'), '缺 rAF 等待帧');
});

// ─────────────────── 主进程：自愈重建 ───────────────────

test('视图条目记录 everSized，并在拿到有效尺寸时置位', () => {
    assert.ok(MANAGER.includes('everSized: false'), 'entry 未初始化 everSized');
    assert.ok(MANAGER.includes('entry.everSized = true'), 'applyLayout 未标记 everSized');
});

test('setBounds 检测「从未有效 + 本次有效」时重建视图', () => {
    const idx = MANAGER.indexOf('const setBounds = ');
    const block = MANAGER.slice(idx, idx + 2200);
    assert.ok(/!entry\.everSized && !isEmptyRect\(nextRect\)/.test(block), '缺自愈条件判断');
    assert.ok(block.includes('destroy(cardId)'), '重建前未销毁旧视图');
    assert.ok(block.includes('open(card, nextRect)'), '未用有效矩形重建');
    assert.ok(block.includes('rebuilt: true'), '未回报重建标志（便于诊断）');
});

test('重建所需的卡片信息在创建时已留存', () => {
    assert.ok(MANAGER.includes('cardForRebuild'), 'entry 未留存 cardForRebuild');
    const idx = MANAGER.indexOf('cardForRebuild: {');
    const block = MANAGER.slice(idx, idx + 700);
    for (const k of ['id:', 'name:', 'url:', 'gen:', 'partition']) {
        assert.ok(block.includes(k), `重建信息缺 ${k}`);
    }
    // settings 必须深拷贝，避免持有渲染层传来后又变动的对象
    assert.ok(block.includes('JSON.parse(JSON.stringify(card.settings))'), 'settings 未深拷贝');
});

// ─────────────────── 语义保护 ───────────────────

test('isEmptyRect 判定仍是「宽或高 <= 0」', () => {
    assert.ok(/function isEmptyRect\(r\) \{\s*return !r \|\| r\.width <= 0 \|\| r\.height <= 0;/.test(MANAGER.replace(/\r\n/g, '\n')),
        'isEmptyRect 语义被改动，自愈条件会失效');
});
