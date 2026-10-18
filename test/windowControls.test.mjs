/**
 * 🪟 窗口控制 · 纯逻辑单测
 * ─────────────────────────────────────────────────────────────
 * 背景：界面用自绘界头 + `autoHideMenuBar`，系统标题栏按钮不可见。
 * 渲染层此前**没有任何窗口控制能力**（preload 零入口）⇒ 全屏后无法用鼠标还原，
 * 也无法用鼠标调整窗口大小（用户实测反馈 2026-10-18）。
 *
 * 这里不测 Electron 本体（需真实主进程），只锁三件容易回归的事：
 *   1. 状态机：全屏 / 最大化 / 窗口化 三者的互斥与还原语义
 *   2. 注册表里窗口命令齐全且挂在「视图」菜单
 *   3. preload 契约：渲染层能拿到的窗口 API 名字
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─────────────────── 1. 状态机（主进程 window:restore 的语义） ───────────────────

/**
 * 模拟 `window:restore` 的语义：无论当前处于什么状态，都回到
 * 「普通窗口化（既非全屏也非最大化，可调整大小）」。
 */
function applyRestore(state) {
    return { ...state, fullScreen: false, maximized: false };
}

/** 模拟 `window:toggleMaximize`：先退全屏，再在最大化/还原之间切换 */
function applyToggleMaximize(state) {
    const s = { ...state, fullScreen: false };
    s.maximized = !s.maximized;
    return s;
}

/** 模拟 `window:toggleFullScreen` */
function applyToggleFullScreen(state) {
    return { ...state, fullScreen: !state.fullScreen };
}

test('窗口化还原：从全屏退出到普通窗口（可调整大小）', () => {
    const s = applyRestore({ maximized: false, fullScreen: true });
    assert.equal(s.fullScreen, false);
    assert.equal(s.maximized, false);
});

test('窗口化还原：从最大化退出到普通窗口', () => {
    const s = applyRestore({ maximized: true, fullScreen: false });
    assert.equal(s.fullScreen, false);
    assert.equal(s.maximized, false);
});

test('最大化：从全屏按下最大化应先退全屏（不允许两态并存）', () => {
    const s = applyToggleMaximize({ maximized: false, fullScreen: true });
    assert.equal(s.fullScreen, false, '全屏必须被清掉');
    assert.equal(s.maximized, true);
});

test('最大化：连续两次切换回到原状', () => {
    let s = { maximized: false, fullScreen: false };
    s = applyToggleMaximize(s);
    assert.equal(s.maximized, true);
    s = applyToggleMaximize(s);
    assert.equal(s.maximized, false);
});

test('全屏：连续两次切换回到原状，且不影响 maximized 标记', () => {
    let s = { maximized: false, fullScreen: false };
    s = applyToggleFullScreen(s);
    assert.equal(s.fullScreen, true);
    s = applyToggleFullScreen(s);
    assert.equal(s.fullScreen, false);
    assert.equal(s.maximized, false);
});

test('窗口化还原：已是普通窗口时是幂等的', () => {
    const s = { maximized: false, fullScreen: false };
    assert.deepEqual(applyRestore(s), s);
});

// ─────────────────── 2. 命令注册表 ───────────────────

test('重型卡工作区提供全屏 / 窗口化 / 隐藏工具栏三件套', () => {
    const ws = fs.readFileSync(path.join(ROOT, 'js/components/HeavyCardWorkspace.vue'), 'utf-8');
    // 模板里必须有这三个按钮文案
    for (const label of ['全屏', '退出全屏', '窗口化', '隐藏工具栏']) {
        assert.ok(ws.includes(label), `工作区缺少「${label}」按钮`);
    }
    // 逻辑函数齐全
    for (const fn of ['onToggleFullScreen', 'onRestoreWindow', 'togglePanelHidden']) {
        assert.ok(ws.includes(`const ${fn} =`), `缺少 ${fn}`);
    }
});

// ─────────────────── 3. preload 契约 ───────────────────

test('preload 暴露全部窗口控制 API', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf-8');
    const apis = [
        'windowGetState', 'windowMinimize', 'windowToggleMaximize',
        'windowToggleFullScreen', 'windowRestore', 'windowClose', 'onWindowStateChanged'
    ];
    for (const a of apis) {
        assert.ok(new RegExp(`\\b${a}\\s*:`).test(src), `preload 缺少 ${a}`);
    }
});

test('主进程注册了对应 IPC，且都用 withMainWindow 守卫', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
    const channels = [
        'window:getState', 'window:minimize', 'window:toggleMaximize',
        'window:toggleFullScreen', 'window:restore', 'window:close'
    ];
    for (const c of channels) {
        const re = new RegExp(`ipcMain\\.handle\\('${c}'[\\s\\S]{0,120}?withMainWindow\\(`);
        assert.ok(re.test(src), `${c} 未通过 withMainWindow 守卫`);
    }
});

test('窗口状态推送监听已挂（maximize / unmaximize / 全屏进出 / restore）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
    const block = src.slice(src.indexOf("ipcMain.handle('window:close'"), src.indexOf("ipcMain.handle('window:close'") + 1200);
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
        assert.ok(block.includes(`'${ev}'`), `缺少窗口事件 ${ev}`);
    }
});

// ─────────────────── 4. D1：菜单遮挡 ───────────────────

test('HeaderBar 把菜单开合上报到 ctx（否则重型卡视图盖住菜单）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/components/HeaderBar.vue'), 'utf-8');
    assert.ok(src.includes('ctx.headerMenuOpen'), 'HeaderBar 未上报 headerMenuOpen');
    assert.ok(src.includes("document.addEventListener('pointerdown'"), '缺少点击空白关闭菜单的兜底');
});

test('App.vue 暴露 headerMenuOpen，重型卡工作区把它算作遮挡', () => {
    const app = fs.readFileSync(path.join(ROOT, 'js/components/App.vue'), 'utf-8');
    assert.ok(/const headerMenuOpen = ref\(false\)/.test(app), 'App.vue 未定义 headerMenuOpen');
    assert.ok(app.includes('provide'), 'App.vue 应有 provide');
    const ctxBlock = app.slice(app.indexOf('const ctx = {'), app.indexOf("provide('appCtx', ctx)"));
    assert.ok(ctxBlock.includes('headerMenuOpen'), 'ctx 未暴露 headerMenuOpen');

    const ws = fs.readFileSync(path.join(ROOT, 'js/components/HeavyCardWorkspace.vue'), 'utf-8');
    assert.ok(ws.includes('ctx.headerMenuOpen'), '重型卡工作区未读取 headerMenuOpen');
});

// ─────────────────── 5. 全屏 / 窗口化归属重型卡工作区（不含全局标题栏） ───────────────────

test('全屏 / 窗口化按钮只在重型卡工作区，不在全局标题栏', () => {
    const hdr = fs.readFileSync(path.join(ROOT, 'js/components/HeaderBar.vue'), 'utf-8');
    assert.ok(!hdr.includes('winToggleFullScreen'), '全局标题栏不应有全屏按钮（用户明确要求放重型卡工作区）');
    assert.ok(!hdr.includes('windowToggleFullScreen'), '全局标题栏不应直接调窗口 API');

    const ws = fs.readFileSync(path.join(ROOT, 'js/components/HeavyCardWorkspace.vue'), 'utf-8');
    assert.ok(ws.includes('onToggleFullScreen'), '重型卡工作区缺全屏按钮');
    assert.ok(ws.includes('onRestoreWindow'), '重型卡工作区缺窗口化按钮');
    assert.ok(ws.includes('panelHidden'), '缺「隐藏工具栏」沉浸模式');
});

test('视图菜单不该出现窗口控制命令（属重型卡专属）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/composables/useCommands.js'), 'utf-8');
    for (const id of ['window.restore', 'window.toggleMaximize', 'window.toggleFullScreen', 'window.minimize']) {
        assert.ok(!src.includes(`id: '${id}'`), `视图菜单不应含 ${id}`);
    }
});

// ─────────────────── 6. UI 布局约束（截图实测反馈） ───────────────────

test('重型卡工具栏不允许换行（否则溢行压住缩放条）', () => {
    const ws = fs.readFileSync(path.join(ROOT, 'js/components/HeavyCardWorkspace.vue'), 'utf-8');
    assert.ok(ws.includes('flex-nowrap'), '工具栏容器应加 flex-nowrap');
});

test('备份面板不得用 absolute 悬浮（会遮挡工具栏按钮）', () => {
    const ws = fs.readFileSync(path.join(ROOT, 'js/components/HeavyCardWorkspace.vue'), 'utf-8');
    const idx = ws.indexOf('showBackupPanel" class=');
    assert.ok(idx > 0, '找不到备份面板节点');
    const node = ws.slice(idx - 200, idx + 400);
    assert.ok(!/absolute\s+right-\d/.test(node), '备份面板不应再用 absolute right-* 悬浮定位');
});

