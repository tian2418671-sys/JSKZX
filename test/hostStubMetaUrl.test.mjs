/**
 * 宿主桩 import.meta.url 门禁（防回归）
 *
 * 真实事故（AutoRandomInput 随机指令）：
 *   插件 init() 里用
 *       fetch(new URL('./index.html', window.__jskMeta.url))
 *   读取同目录的界面模板。而桩里 __jskMeta.url 硬编码成
 *       file:///plugin/dist/bundle.js
 *   ⇒ new URL 得到 file:///plugin/dist/index.html ⇒ fetch 必然失败。
 *   模板拿不到 → template.innerHTML 为空 → append 后 DOM 里没有 #ari-workbench
 *   → 后续 getElementById 全 null → 报一句完全无法定位的
 *       Cannot read properties of undefined (reading 'function(){ return undefined; }')
 *
 * 本文件锁死：
 *   1. __jskMeta.url 不得再是硬编码的 file:///plugin/... 假地址；
 *   2. 有 previewId 时必须指向主进程的插件资源代理路由。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../js/plugins/hostStub.js'), 'utf8');

test('__jskMeta.url 不得硬编码 file:///plugin 假地址', () => {
    // 允许出现在注释里说明「历史上的错误值」，但赋值语句不能是它
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        const code = line.replace(/\/\/.*$/, '');
        if (/__jskMeta\s*=\s*\{[^}]*url:\s*'file:\/\/\/plugin/.test(code)) {
            offenders.push(i + 1);
        }
    });
    assert.deepEqual(
        offenders, [],
        `第 ${offenders.join(', ')} 行把 __jskMeta.url 写成了 file:///plugin/… —— `
        + '插件 fetch(new URL("index.html", __jskMeta.url)) 会 Failed to fetch',
    );
});

test('buildModuleResolver 必须接收 opts 并据此生成 metaUrl', () => {
    assert.match(src, /function buildModuleResolver\(\s*opts/, 'buildModuleResolver 必须接收 opts');
    assert.match(src, /__jsk_plugin_res__/, 'metaUrl 必须走插件资源代理路由 /__jsk_plugin_res__/');
});

test('buildGlobalStubs 必须把 previewId 透传给 buildModuleResolver', () => {
    assert.match(
        src,
        /buildModuleResolver\(opts\)/,
        '调用 buildModuleResolver 时必须传 opts（内含 previewId）',
    );
    assert.match(
        src,
        /buildGlobalStubs\(plugin,\s*\{\s*previewId/,
        '调用 buildGlobalStubs 时必须传 { previewId }',
    );
});

test('metaUrl 必须能解析出同目录资源（new URL 语义正确）', () => {
    // 用 Node 的 URL 验证语义：'./index.html' 相对 '.../previewId/index.js'
    const id = '1-abcdef';
    const metaUrl = 'app://index.html/__jsk_plugin_res__/' + id + '/index.js';
    const resolved = new URL('./index.html', metaUrl);
    assert.equal(resolved.href, 'app://index.html/__jsk_plugin_res__/' + id + '/index.html');
    // 必须保留 previewId 段，否则主进程找不到 rootDir
    assert.ok(resolved.pathname.includes(id), '解析后的路径必须仍包含 previewId');
});
