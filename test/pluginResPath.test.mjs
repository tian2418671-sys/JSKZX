import test from 'node:test';
import assert from 'node:assert/strict';
import { rewritePluginResourcePaths } from '../js/utils/pluginResPath.js';

const ID = 'pre_1';

test('【资源改写】img src 相对路径 → 代理 URL', () => {
    const out = rewritePluginResourcePaths('<img src="./img/a.png">', ID);
    assert.match(out, /src="__jsk_plugin_res__\/pre_1\/img\/a\.png"/);
});

test('【资源改写】link href 相对路径 → 代理 URL', () => {
    const out = rewritePluginResourcePaths('<link rel="stylesheet" href="style.css">', ID);
    assert.match(out, /href="__jsk_plugin_res__\/pre_1\/style\.css"/);
});

test('【资源改写】CSS url() 与 @import 都被改写', () => {
    const out = rewritePluginResourcePaths(
        "body{background:url('./bg.jpg')} @import './theme.css';", ID
    );
    assert.match(out, /url\("__jsk_plugin_res__\/pre_1\/bg\.jpg"\)/);
    assert.match(out, /@import "__jsk_plugin_res__\/pre_1\/theme\.css"/);
});

test('【资源改写】srcset 多个候选都改写', () => {
    const out = rewritePluginResourcePaths('<img srcset="a.png 1x, b.png 2x">', ID);
    assert.match(out, /a\.png/);
    assert.match(out, /b\.png/);
    assert.equal((out.match(/__jsk_plugin_res__/g) || []).length, 2);
});

test('【资源改写】../ 被正确消解（不越界）', () => {
    const out = rewritePluginResourcePaths('<img src="../../../../etc/passwd">', ID);
    // 全部 ../ 被吃掉，不会逃出根
    assert.equal(out.includes('..'), false);
});

test('【资源改写】绝对 URL / data: / blob: / #锚点 / // 协议相对 都不改', () => {
    const cases = [
        '<img src="https://cdn.example.com/a.png">',
        '<img src="data:image/png;base64,AAA">',
        '<img src="blob:app://x">',
        '<a href="#section">x</a>',
        '<img src="//cdn.example.com/a.png">',
        '<img src="app://index.html/x.png">'
    ];
    for (const c of cases) {
        const out = rewritePluginResourcePaths(c, ID);
        assert.equal(out.includes('__jsk_plugin_res__'), false, '不该改写: ' + c);
    }
});

test('【资源改写】没有 previewId 时原样返回', () => {
    const c = '<img src="./a.png">';
    assert.equal(rewritePluginResourcePaths(c, ''), c);
});

test('【资源改写】空输入安全', () => {
    assert.equal(rewritePluginResourcePaths('', ID), '');
    assert.equal(rewritePluginResourcePaths(null, ID), '');
});
