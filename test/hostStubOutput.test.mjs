/**
 * 宿主 DOM 骨架输出门禁（防回归）
 *
 * 背景：项目曾有 90 个测试文件，但没有一个断言过**输出** —— 只测了 hostStubPure.js
 * 的纯函数。结果 `buildHostDom()` 的函数头在某次编辑中丢失后，一半宿主骨架
 * （15 个 wand 容器、#message_template、#extensionsMenuButton）变成游离代码、
 * **永不输出**，却安静存活了两个月，表现为「所有插件都没效果」。
 *
 * 本文件专门盯输出结果。被测模块是 hostStubDom.js（纯字符串生成，不依赖 ?raw），
 * 因此 Node 可以直接 import —— 这是它从 hostStub.js 里被抽出来的唯一原因。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHostDom, buildTavernThemeCss } from '../js/plugins/hostStubDom.js';

const html = buildHostDom();

/** 抽出所有 id="xxx" */
function collectIds(s) {
    return (s.match(/\bid="([^"]+)"/g) || []).map((x) => x.slice(4, -1));
}

test('输出必须包含全部关键宿主挂载点', () => {
    const required = [
        'jsk-host-workbench',
        'options',
        'extensionsMenu',
        'extensionsMenuButton',
        'chat',
        'chat-history',
        'send_form',
        'leftSendForm',
        'rightSendForm',
        'extensions_settings',
        'extensions_settings2',
        'message_template',
        'zoomed_avatar_template',
    ];
    const missing = required.filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `缺失关键宿主 DOM 节点: ${missing.join(', ')}`);
});

test('魔法棒容器必须完整输出 15 个', () => {
    const n = (html.match(/class="extension_wand_container"/g) || []).length;
    assert.equal(n, 15, `extension_wand_container 数量应为 15，实际为 ${n}`);
});

test('扩展设置容器不得少于 25 个', () => {
    const n = (html.match(/class="extension_container"/g) || []).length;
    assert.ok(n >= 25, `extension_container 至少应有 25 个，实际为 ${n}`);
});

test('全局 DOM ID 严禁重复', () => {
    const ids = collectIds(html);
    const counts = {};
    for (const id of ids) counts[id] = (counts[id] || 0) + 1;
    const dups = Object.entries(counts).filter(([, c]) => c > 1);
    assert.deepEqual(dups, [], `检测到重复 DOM ID: ${JSON.stringify(dups)}`);
});

test('#options 内必须有 hr（更好的聊天记录管理 靠它定位插入点）', () => {
    const m = html.match(/id="options"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(m, '未找到 #options 容器');
    assert.ok(/<hr\s*\/?>/.test(m[1]), '#options 内缺少 hr，插件无法定位插入点');
});

test('#message_template 必须含 .mes 子元素（插件按该选择器 clone）', () => {
    const idx = html.indexOf('id="message_template"');
    assert.ok(idx >= 0, '未找到 #message_template');
    const seg = html.slice(idx, idx + 600);
    // [BUG] 曾把 .mes 挂在 #message_template 自己身上，
    //       插件 $('#message_template .mes').clone() 取不到 -> cloneNode null
    assert.match(seg, /<div class="mes"/, '#message_template 内部必须有 .mes 子元素');
    for (const cls of ['mes_block', 'ch_name', 'mes_text']) {
        assert.ok(seg.includes(cls), `#message_template 缺少 .${cls}`);
    }
});

test('挂载区必须有 data-jsk-zone 标记（供挂载嗅探器识别）', () => {
    const zones = (html.match(/data-jsk-zone="/g) || []).length;
    assert.ok(zones >= 4, `data-jsk-zone 标记至少应有 4 个，实际为 ${zones}`);
});

test('extensionsMenu 与 extensions_settings 各只能出现一次', () => {
    assert.equal((html.match(/id="extensionsMenu"/g) || []).length, 1, '#extensionsMenu 重复');
    assert.equal((html.match(/id="extensions_settings"/g) || []).length, 1, '#extensions_settings 重复');
    assert.equal((html.match(/id="extensions_settings2"/g) || []).length, 1, '#extensions_settings2 重复');
});

test('主题 CSS 变量齐全', () => {
    const css = buildTavernThemeCss();
    const vars = [
        '--SmartThemeBodyColor',
        '--SmartThemeEmColor',
        '--SmartThemeBorderColor',
        '--SmartThemeQuoteColor',
        '--SmartThemeBlurTintColor',
        '--SmartThemeUserMesBlurTintColor',
        '--SmartThemeBotMesBlurTintColor',
        '--SmartThemeChatTintColor',
        '--SmartThemeShadowColor',
    ];
    const missing = vars.filter((v) => !css.includes(v));
    assert.deepEqual(missing, [], `主题 CSS 缺少变量: ${missing.join(', ')}`);
});

test('主题 CSS 必须含酒馆常用组件类', () => {
    const css = buildTavernThemeCss();
    for (const cls of ['.menu_button', '.list-group-item', '.text_pole', '.mes']) {
        assert.ok(css.includes(cls), `主题 CSS 缺少 ${cls}`);
    }
});

test('输出稳定：连续两次调用结果一致', () => {
    assert.equal(buildHostDom(), buildHostDom());
    assert.equal(buildTavernThemeCss(), buildTavernThemeCss());
});

test('div 标签开闭平衡', () => {
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    assert.equal(open, close, `div 未闭合：开 ${open} 个，闭 ${close} 个`);
});

test('空容器必须撑出可见高度（否则用户看到全空白）', () => {
    // 🐞 回归：重建骨架时只写 id、丢掉 min-height，空 div 天然 0 高度，
    //    用户实测「只有一个🪄和一个输入框，其余全空白」。
    const minHeights = (html.match(/min-height:/g) || []).length;
    assert.ok(minHeights >= 5, `min-height 至少应有 5 处，实际 ${minHeights} 处`);

    for (const id of ['chat', 'options', 'extensionsMenu', 'extensions_settings']) {
        const re = new RegExp(`#${id}[^{]*\\{[^}]*min-height`, 'i');
        assert.match(html, re, `#${id} 缺少 min-height，空状态下不可见`);
    }
});

test('骨架自带样式块（不能依赖外部 CSS）', () => {
    assert.match(html, /<style>[\s\S]*#jsk-host-workbench[\s\S]*<\/style>/, '骨架缺少自带 <style> 布局块');
});

test('#chat-history 必须嵌在 #chat 内部（插件按 #chat .mes 取消息）', () => {
    // 🐞 回归：两者曾是兄弟节点，导致插件 $('#chat .mes') 拿到 0 个
    const m = html.match(/<div id="chat"[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(m, '未找到 #chat 容器');
    assert.ok(m[0].includes('id="chat-history"'), '#chat-history 不在 #chat 内部');
});

test('酒馆布局变量必须齐全（否则插件弹窗会遮挡顶部）', () => {
    // 🐞 回归：「更好的聊天记录管理」弹窗用 position:absolute;top:0 + width:var(--sheldWidth)，
    //    变量缺失时 width 失效、弹窗扑到 body 顶部盖住横幅 —— 用户看到「一条色块压在顶部」。
    const css = buildTavernThemeCss();
    const required = [
        '--sheldWidth',
        '--black70a',
        '--black30a',
        '--mainFontFamily',
        '--mainFontSize',
    ];
    const missing = required.filter((v) => !css.includes(v + ':'));
    assert.deepEqual(missing, [], `缺少酒馆布局变量: ${missing.join(', ')}`);
});

test('工作台必须是定位上下文（限制 absolute 弹窗不扑到顶部）', () => {
    assert.match(html, /#jsk-host-workbench\{[^}]*position:\s*relative/, '#jsk-host-workbench 缺少 position:relative');
});

test('横幅与导航条 z-index 必须高于插件弹窗（防止被遮挡）', () => {
    // 插件弹窗常见 z-index:9999，横幅必须在其之上
    const bannerRule = html.match(/#host-banner\{[^}]*z-index:\s*(\d+)/);
    assert.ok(bannerRule, '未找到 #host-banner 的 z-index');
    assert.ok(Number(bannerRule[1]) > 9999, `#host-banner z-index 应 > 9999，实际 ${bannerRule[1]}`);
});

test('不得残留旧版 #extensionsMenu 纵向布局覆盖新骨架', () => {
    // 旧样式 display:flex;flex-direction:column 会覆盖骨架里的 flex-wrap 横向布局
    assert.doesNotMatch(html, /#extensionsMenu\{display:flex;flex-direction:column/, '残留旧版 #extensionsMenu 纵向布局');
});

test('顶部条不得 sticky / 不得压住内容区', () => {
    // 🐞 回归：sticky + 超高 z-index 会让顶部条叠在 #options 上，把按钮行整条盖掉
    const m = html.match(/#jsk-topbar\{[^}]*\}/);
    assert.ok(m, '未找到 #jsk-topbar 样式');
    assert.doesNotMatch(m[0], /position:\s*sticky/, '#jsk-topbar 不得用 sticky（会盖住内容）');
    assert.doesNotMatch(m[0], /z-index:\s*21474/, '#jsk-topbar 不得使用超高 z-index');
});

test('顶部条必须与内容区是兄弟关系，且内容区承载弹窗定位', () => {
    assert.match(html, /id="jsk-topbar"[\s\S]*?id="jsk-host-content"/, '顶部条与内容区结构不正确');
    const css = html.match(/#jsk-host-content\{[^}]*\}/);
    assert.ok(css, '未找到 #jsk-host-content 样式');
    assert.match(css[0], /position:\s*relative/, '#jsk-host-content 必须是定位上下文');
});

test('#options 必须位于内容区内（不在顶部条里）', () => {
    const topbarEnd = html.indexOf('id="jsk-host-content"');
    const optIdx = html.indexOf('id="options"');
    assert.ok(topbarEnd > 0 && optIdx > topbarEnd, '#options 应在 #jsk-host-content 内部');
});
