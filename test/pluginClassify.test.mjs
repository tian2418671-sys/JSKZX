import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PLUGIN_KIND, classifyPlugin, pluginKindLabel,
    extractAllScriptCode, countThemeColorKeys, hasHtmlOrCssAssets,
} from '../js/plugins/pluginClassify.js';
import { themeToCssVars, buildThemePreviewHtml, THEME_VAR_MAP } from '../js/plugins/themePreview.js';

// ── 分类器 ────────────────────────────────────────────────────────────────

test('classifyPlugin：扩展工程', () => {
    const r = classifyPlugin({ kind: 'extension', name: 'ext' });
    assert.equal(r.kind, PLUGIN_KIND.EXTENSION);
});

test('classifyPlugin：主题 JSON（顶层配色字段 >= 3）', () => {
    const rawJson = {
        name: '晦明v2.6',
        blur_tint_color: 'rgba(248,247,245,1)',
        main_text_color: 'rgba(57,56,60,1)',
        chat_tint_color: 'rgba(238,237,237,1)',
    };
    const r = classifyPlugin({ name: '晦明v2.6', scripts: [] }, { rawJson });
    assert.equal(r.kind, PLUGIN_KIND.THEME);
    assert.ok(r.themeKeys.length >= 3);
});

test('classifyPlugin：配色字段不足 3 个不算主题', () => {
    const rawJson = { name: 'x', main_text_color: '#fff' };
    const r = classifyPlugin({ name: 'x', scripts: [] }, { rawJson });
    assert.notEqual(r.kind, PLUGIN_KIND.THEME);
});

test('classifyPlugin：含 .css 资产判为界面脚本', () => {
    const r = classifyPlugin({ name: 'x', files: ['/a/b/style.css'], scripts: [] });
    assert.equal(r.kind, PLUGIN_KIND.DOM_SCRIPT);
});

test('classifyPlugin：源码含 DOM 操作判为界面脚本', () => {
    const r = classifyPlugin({
        name: 'x',
        scripts: [{ content: 'const el = document.createElement("div"); el.innerHTML = "hi";' }],
    });
    assert.equal(r.kind, PLUGIN_KIND.DOM_SCRIPT);
});

test('classifyPlugin：jQuery 选择器也算界面迹象', () => {
    const r = classifyPlugin({
        name: 'x',
        scripts: [{ content: '$(".options-content").append("<a>xx</a>");' }],
    });
    assert.equal(r.kind, PLUGIN_KIND.DOM_SCRIPT);
});

test('classifyPlugin：酒馆助手包装函数 $(fn) 不得误判为界面插件', () => {
    // 🐞 真实踩坑：「发送前最后正则」首行是 $(errorCatched(() => {...}))
    //    这是酒馆助手的包装函数（等价 IIFE），不是 jQuery 选择器。
    //    旧正则 /$\(/ 把它当成 DOM 操作 → 误判 domScript → 能力卡不触发 → 用户看到空白。
    const r = classifyPlugin({
        name: '发送前最后正则',
        scripts: [{
            content: `$(errorCatched(() => {
                eventSource.on(event_types.GENERATE_AFTER_DATA, async () => {
                    const v = getVariables();
                });
            }));`,
        }],
    });
    assert.equal(r.kind, PLUGIN_KIND.LOGIC);
});

test('classifyPlugin：$( 后跟引号/尖括号才算是 DOM 操作', () => {
    const cases = [
        ['$(".x")', true],
        ["$('#id')", true],
        ['$("<div>")', true],
        ['$(fn)', false],
        ['$(errorCatched(fn))', false],
        ['$(async () => {})', false],
    ];
    for (const [snippet, expectDom] of cases) {
        const r = classifyPlugin({ name: 't', scripts: [{ content: snippet }] });
        const isDom = r.kind === PLUGIN_KIND.DOM_SCRIPT;
        assert.equal(isDom, expectDom, `${snippet} 期望 DOM=${expectDom}，实际=${isDom}`);
    }
});

test('classifyPlugin：纯逻辑脚本', () => {
    const r = classifyPlugin({
        name: '发送前最后正则',
        scripts: [{ content: 'eventSource.on(event_types.MESSAGE_SENT, () => { getVariables(); });' }],
    });
    assert.equal(r.kind, PLUGIN_KIND.LOGIC);
});

test('classifyPlugin：扫描阶段标记 kind=theme 直接识别', () => {
    // pluginScanner 对主题 JSON 会打 kind='theme' + themeData
    const r = classifyPlugin({
        name: '晦明v2.6',
        kind: 'theme',
        themeData: { name: '晦明v2.6', blur_tint_color: '#fff', main_text_color: '#111', chat_tint_color: '#eee' },
        scripts: [],
    });
    assert.equal(r.kind, PLUGIN_KIND.THEME);
    assert.ok(r.themeKeys.length >= 3);
});

test('normalizeJsonPlugin：主题条目得到 kind=theme 且带 themeData', async () => {
    const { normalizeJsonPlugin } = await import('../js/utils/pluginScanner.js');
    const themeData = {
        name: '晦明v2.6',
        blur_tint_color: 'rgba(248,247,245,1)',
        main_text_color: 'rgba(57,56,60,1)',
        chat_tint_color: 'rgba(238,237,237,1)',
    };
    const p = normalizeJsonPlugin({
        type: 'json', path: 'E:/x/晦明v2.6.json', name: '晦明v2.6.json', data: themeData, isTheme: true,
    });
    assert.equal(p.kind, 'theme');
    assert.equal(p.name, '晦明v2.6');
    assert.deepEqual(p.themeData, themeData);
    assert.equal(p.scripts[0].kind, 'theme');
});

test('normalizeJsonPlugin：普通脚本条目不受影响', async () => {
    const { normalizeJsonPlugin } = await import('../js/utils/pluginScanner.js');
    const p = normalizeJsonPlugin({
        type: 'json', path: 'E:/x/a.json', name: 'a.json',
        data: { id: 'abc', name: 'A脚本', content: '$(".x").append("y");' },
    });
    assert.equal(p.kind, 'tavern-helper');
    assert.ok(!p.themeData);
});

test('classifyPlugin：themeData 可直接用于分类（无需 rawJson）', () => {
    const r = classifyPlugin({
        name: 'x',
        themeData: { blur_tint_color: '#a', main_text_color: '#b', quote_text_color: '#c' },
        scripts: [],
    });
    assert.equal(r.kind, PLUGIN_KIND.THEME);
});


test('classifyPlugin：空插件不抛错', () => {
    assert.equal(classifyPlugin(null).kind, PLUGIN_KIND.LOGIC);
    assert.equal(classifyPlugin({}).kind, PLUGIN_KIND.LOGIC);
});

test('classifyPlugin：content 里塞整体 JSON 也能识别主题', () => {
    const content = JSON.stringify({
        name: '主题A', blur_tint_color: '#111', main_text_color: '#eee', quote_text_color: '#abc',
    });
    const r = classifyPlugin({ name: '主题A', content, scripts: [] });
    assert.equal(r.kind, PLUGIN_KIND.THEME);
});

test('extractAllScriptCode：拼接多段脚本', () => {
    const code = extractAllScriptCode({
        scripts: [{ content: 'AAA' }, { content: 'BBB' }, { content: '' }],
    });
    assert.equal(code, 'AAA\nBBB');
});

test('hasHtmlOrCssAssets：识别 html/htm/css', () => {
    assert.equal(hasHtmlOrCssAssets({ files: ['a/b.html'] }), true);
    assert.equal(hasHtmlOrCssAssets({ files: ['a/b.htm'] }), true);
    assert.equal(hasHtmlOrCssAssets({ files: ['a/b.css'] }), true);
    assert.equal(hasHtmlOrCssAssets({ files: ['a/b.js'] }), false);
});

test('countThemeColorKeys：忽略数组与 null', () => {
    assert.equal(countThemeColorKeys(null), 0);
    assert.equal(countThemeColorKeys([]), 0);
    assert.equal(countThemeColorKeys({ main_text_color: '#fff' }), 1);
});

test('pluginKindLabel：四种类型都有中文标签', () => {
    for (const k of Object.values(PLUGIN_KIND)) {
        assert.ok(pluginKindLabel(k) && pluginKindLabel(k) !== '未知', `${k} 缺少标签`);
    }
});

// ── 主题预览 ──────────────────────────────────────────────────────────────

test('themeToCssVars：字段正确映射到 CSS 变量', () => {
    const { css, vars } = themeToCssVars({
        main_text_color: '#eee',
        blur_tint_color: '#111',
        blur_strength: 8,
    });
    assert.ok(vars.some((v) => v.varName === '--SmartThemeBodyColor' && v.value === '#eee'));
    assert.ok(vars.some((v) => v.varName === '--SmartThemeBlurTintColor' && v.value === '#111'));
    // blur_strength 纯数字补 px
    assert.ok(vars.some((v) => v.varName === '--SmartThemeBlurStrength' && v.value === '8px'));
    assert.ok(css.includes('--SmartThemeBodyColor:#eee;'));
});

test('themeToCssVars：空值/缺失字段被跳过', () => {
    const { vars } = themeToCssVars({ main_text_color: '', blur_tint_color: null });
    assert.equal(vars.length, 0);
});

test('themeToCssVars：非法输入不抛错', () => {
    assert.equal(themeToCssVars(null).vars.length, 0);
    assert.equal(themeToCssVars('abc').vars.length, 0);
});

test('THEME_VAR_MAP：覆盖酒馆核心主题变量', () => {
    const vals = Object.values(THEME_VAR_MAP);
    for (const v of ['--SmartThemeBodyColor', '--SmartThemeBlurTintColor',
        '--SmartThemeUserMesBlurTintColor', '--SmartThemeBotMesBlurTintColor']) {
        assert.ok(vals.includes(v), `缺少映射 ${v}`);
    }
});

test('buildThemePreviewHtml：输出完整 HTML 且含色板与气泡', () => {
    const html = buildThemePreviewHtml({
        name: '晦明v2.6',
        blur_tint_color: 'rgba(248,247,245,1)',
        main_text_color: 'rgba(57,56,60,1)',
        chat_tint_color: 'rgba(238,237,237,1)',
    });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('晦明v2.6'));
    assert.ok(html.includes('jsk-swatch'));
    assert.ok(html.includes('data-role="user"'));
    assert.ok(html.includes('data-role="bot"'));
    assert.ok(html.includes('rgba(248,247,245,1)'));
});

test('buildThemePreviewHtml：无配色字段时给出空态提示', () => {
    const html = buildThemePreviewHtml({ name: '空主题' });
    assert.ok(html.includes('没有可识别的配色字段'));
});

test('buildThemePreviewHtml：主题名被转义，防注入', () => {
    const html = buildThemePreviewHtml({ name: '<img src=x onerror=alert(1)>' });
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('&lt;img'));
});

test('buildThemePreviewHtml：样式值被转义，防破坏 CSS', () => {
    const html = buildThemePreviewHtml({ name: 'x', main_text_color: 'red;}</style><script>' });
    assert.ok(!html.includes('</style><script>'));
});
