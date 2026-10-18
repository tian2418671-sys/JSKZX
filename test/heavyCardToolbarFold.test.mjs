/**
 * 🗂️ 重型卡工具栏 · 折叠结构单测
 * ─────────────────────────────────────────────────────────────
 * 回归保护（用户实测 2026-10-18，截图「出现的遮挡问题」）：
 *   工具栏按钮太多，`flex-nowrap` 会让它们**向右溢出并被裁掉** ——
 *   截图中「离线 / 浏览器」直接消失，且溢出还会盖住相邻元素。
 *
 * 修复策略：**两行折叠结构**
 *   第 1 行（常驻）= 卡片信息 + 重新加载 / 备份 / 历史 / 全屏 / 窗口化 / 隐藏 / ▾更多
 *   第 2 行（可折叠）= 目录 / 清缓存 / 离线 / 浏览器 / 缩放
 *
 * 这里做源码级结构断言（真实溢出由 CDP 实测确认：900~1266px 全档零溢出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/components/HeavyCardWorkspace.vue'), 'utf-8');

test('折叠状态与切换函数已定义', () => {
    assert.ok(SRC.includes('const moreActionsOpen = ref(false)'), '缺 moreActionsOpen 状态');
    assert.ok(SRC.includes('const toggleMoreActions = '), '缺 toggleMoreActions');
    assert.ok(/moreActionsOpen, toggleMoreActions/.test(SRC), '未在 setup 返回值中暴露');
});

test('折叠开关按钮存在且有两种文案', () => {
    assert.ok(SRC.includes('▾ 更多'), '缺「▾ 更多」展开文案');
    assert.ok(SRC.includes('▴ 收起'), '缺「▴ 收起」收起文案');
});

test('折叠区由 moreActionsOpen 控制（v-show）', () => {
    const idx = SRC.indexOf('折叠区：第二行');
    assert.ok(idx > 0, '找不到折叠区分块');
    const block = SRC.slice(idx, idx + 400);
    assert.ok(/v-show="moreActionsOpen"/.test(block), '折叠区未绑定 moreActionsOpen');
});

test('低频操作已移入折叠区，不在常驻行', () => {
    const collapseIdx = SRC.indexOf('折叠区：第二行');
    const collapseBlock = SRC.slice(collapseIdx, collapseIdx + 3000);
    for (const label of ['📂 目录', '🧹 清缓存', '↗ 浏览器', '缩放']) {
        assert.ok(collapseBlock.includes(label), `折叠区缺少「${label}」`);
    }
    // 常驻行（折叠区之前）不应再直接出现这些低频按钮
    const topBlock = SRC.slice(SRC.indexOf('<div v-show="!panelHidden"'), collapseIdx);
    for (const label of ['🧹 清缓存', '↗ 浏览器']) {
        assert.ok(!topBlock.includes(label), `常驻行不应含「${label}」（会溢出）`);
    }
});

test('常驻行保留高频操作', () => {
    const collapseIdx = SRC.indexOf('折叠区：第二行');
    const topBlock = SRC.slice(SRC.indexOf('<div v-show="!panelHidden"'), collapseIdx);
    for (const label of ['🔄 重新加载', '📦', '🕘', '🖥️', '🪟 窗口化', '👁️ 隐藏']) {
        assert.ok(topBlock.includes(label), `常驻行缺少「${label}」`);
    }
});

test('折叠切换会重新上报布局（高度变化必须通知原生视图）', () => {
    const idx = SRC.indexOf('const toggleMoreActions = ');
    const block = SRC.slice(idx, idx + 400);
    assert.ok(block.includes('scheduleRect'), '折叠切换后未重新量占位框');
});

test('折叠区允许换行（flex-wrap），避免二次溢出', () => {
    const collapseIdx = SRC.indexOf('折叠区：第二行');
    const block = SRC.slice(collapseIdx, collapseIdx + 400);
    assert.ok(block.includes('flex-wrap'), '折叠区应允许换行兜底');
});
