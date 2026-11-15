/**
 * 防线：右键菜单的「动态项」契约。
 *
 * 背景（2026-11-15 用户报）：
 *   在**预设库**里右击，弹出的却是**角色卡菜单**（查看/编辑卡片、换卡图、导出 PNG、
 *   推送到当前目标、单卡快捷 AI 打标、移入安全回收站…），点下去要么报错要么毫无反应，
 *   菜单头部还显示「未知角色」。
 *
 * 根因（两层叠加）：
 *   ① `ContextMenu.vue` 写死了角色卡那 11 个按钮，**从不读** `item.items`；
 *   ② `usePresets.js` / `usePlugins.js` 把菜单项挂在 `contextMenu.value.items`
 *      （顶层），且**没设 `item` 字段** ⇒ 头部 fallback 成「未知角色」。
 *
 * 也就是说：预设/插件各自准备的 items 一直是**死代码**，从未被渲染。
 *
 * 本测试锁死修复后的契约：
 *   · ContextMenu.vue 必须存在「按 item.items 渲染」的分支；
 *   · 动态项必须支持 separator 与 danger；
 *   · usePresets / usePlugins 的菜单项必须挂在 item.items 内（不是顶层 items）；
 *   · App.vue 必须监听 @close（动态项执行后要能收起菜单）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** 取某个「openXxxContextMenu」函数体（从函数名到下一个 `\n    };` 收尾） */
function extractFnBody(src, fnName) {
    const start = src.indexOf(`const ${fnName} = `);
    assert.ok(start >= 0, `未找到 ${fnName}`);
    const end = src.indexOf('\n    };', start);
    assert.ok(end > start, `${fnName} 函数体截取失败`);
    return src.slice(start, end);
}

test('ContextMenu.vue 支持动态菜单项（item.items）', () => {
    const src = read('js/components/ContextMenu.vue');

    // ① 必须有「按 item.items 判断」的计算属性
    assert.match(src, /hasCustomItems/, '缺少 hasCustomItems 判断');
    assert.match(
        src,
        /Array\.isArray\(\s*this\.item\.items\s*\)/,
        'hasCustomItems 必须基于 this.item.items'
    );

    // ② 模板里必须真的遍历 item.items 渲染
    assert.match(src, /v-for="\(it, i\) in item\.items"/, '模板未遍历 item.items');
    assert.match(src, /\{\{\s*it\.label\s*\}\}/, '动态项未渲染 it.label');

    // ③ 分隔符与危险项样式
    assert.match(src, /it\.type === 'separator'/, '未支持 separator');
    assert.match(src, /it\.danger/, '未支持 danger 样式');

    // ④ 执行回调 + 关闭菜单
    assert.match(src, /it\.action/, '未调用 it.action');
    assert.match(src, /\$emit\('close'\)/, '动态项执行后未通知关闭菜单');
});

test('ContextMenu.vue 仍保留角色卡默认菜单（不能为了动态项把旧行为删掉）', () => {
    const src = read('js/components/ContextMenu.vue');
    for (const label of [
        '查看 / 编辑卡片',
        '创建卡片物理副本',
        '换卡图',
        '导出单张卡片 (PNG)',
        '推送到当前目标',
        '单卡快捷 AI 打标',
        '移入安全回收站',
    ]) {
        assert.ok(src.includes(label), `默认模式缺失菜单项：${label}`);
    }
    // 默认分支必须挂在 v-else 上（即「没有 item.items 时才用角色卡菜单」）
    assert.match(src, /v-else/, '默认模式缺少 v-else 分支');
});

test('usePresets 的右键菜单项挂在 item.items 内，且不含角色卡专属项', () => {
    const src = read('js/composables/usePresets.js');
    const body = extractFnBody(src, 'openPresetContextMenu');

    assert.match(body, /item:\s*\{/, '菜单项必须放进 item 字段（否则头部显示「未知角色」）');
    assert.match(body, /items:\s*\[/, '缺少 items 数组');
    assert.match(body, /renamePreset\(/, '缺少「重命名」');
    assert.match(body, /duplicatePreset\(/, '缺少「复制副本」');
    assert.match(body, /openPresetInFolder\(/, '缺少「在资源管理器中定位」');
    assert.match(body, /deletePreset\(/, '缺少「删除」');

    // 角色卡专属能力绝不能出现在预设菜单里
    for (const forbidden of ['replaceCardImage', 'exportCard', 'pushToTarget', 'openFromLibrary', 'quickMoveGroup']) {
        assert.ok(
            !body.includes(forbidden),
            `预设右键菜单不应包含角色卡专属动作：${forbidden}`
        );
    }
});

test('usePlugins 的右键菜单项挂在 item.items 内，且不含角色卡专属项', () => {
    const src = read('js/composables/usePlugins.js');
    const body = extractFnBody(src, 'openPluginContextMenu');

    assert.match(body, /item:\s*\{/, '菜单项必须放进 item 字段');
    assert.match(body, /items:\s*\[/, '缺少 items 数组');
    assert.match(body, /openPluginInFolder\(/, '缺少「在资源管理器中定位」');
    assert.match(body, /deletePlugin\(/, '缺少「删除」');

    for (const forbidden of ['replaceCardImage', 'exportCard', 'pushToTarget', 'openFromLibrary', 'quickMoveGroup']) {
        assert.ok(
            !body.includes(forbidden),
            `插件右键菜单不应包含角色卡专属动作：${forbidden}`
        );
    }
});

test('App.vue 的 ContextMenu 监听 @close（动态项执行后收起菜单）', () => {
    const src = read('js/components/App.vue');
    // 模板里用的是 kebab-case：<context-menu ... />
    const i = src.indexOf('<context-menu');
    assert.ok(i >= 0, '未找到 <context-menu> 用法');
    const seg = src.slice(i, src.indexOf('/>', i));
    assert.match(seg, /@close="closeContextMenu\(\)"/, 'ContextMenu 未绑定 @close');
});
