import test from 'node:test';
import assert from 'node:assert/strict';
import { probePluginSource, renderProbeHtml } from '../js/plugins/hostStubProbe.js';

test('probePluginSource：识别监听事件与 API', () => {
    const src = `
    eventSource.on(event_types.MESSAGE_RECEIVED, handler);
    eventSource.on(event_types.GENERATION_ENDED, done);
    const v = getVariables();
    TavernHelper.insertOrAssignVariables({ stat_data: v });
    await generateQuietPrompt('summarize');
    `;
    const p = probePluginSource({ source: src });
    assert.ok(p.events.includes('MESSAGE_RECEIVED'));
    assert.ok(p.events.includes('GENERATION_ENDED'));
    assert.ok(p.apis.includes('getVariables'));
    assert.ok(p.apis.includes('generateQuietPrompt'));
    assert.ok(p.globals.includes('TavernHelper'));
});

test('probePluginSource：纯逻辑脚本判定为无 UI 迹象', () => {
    const src = 'const x = getVariables(); insertOrAssignVariables({ a: 1 });';
    const p = probePluginSource({ source: src });
    assert.equal(p.hasUiSigns, false);
    assert.match(p.kindLabel, /后台逻辑脚本/);
});

test('probePluginSource：有 DOM 操作判定为界面类', () => {
    const src = "const $el = document.createElement('div'); $el.innerHTML = 'hi'; document.body.appendChild($el);";
    const p = probePluginSource({ source: src });
    assert.equal(p.hasUiSigns, true);
    assert.match(p.kindLabel, /界面类脚本/);
});

test('probePluginSource：有模板或 CSS 一律视为有 UI', () => {
    const p1 = probePluginSource({ source: '', hasTemplates: true });
    assert.equal(p1.hasUiSigns, true);
    const p2 = probePluginSource({ source: '', hasCss: true });
    assert.equal(p2.hasUiSigns, true);
});

test('probePluginSource：扩展工程类型标签正确', () => {
    const p = probePluginSource({ source: '', pluginKind: 'extension', hasTemplates: true });
    assert.match(p.kindLabel, /扩展工程/);
});

test('probePluginSource：避免子串误判', () => {
    // `getvar` 不应因为源码里出现 `insertOrAssignVariables` 之类而被命中
    const p = probePluginSource({ source: 'insertOrAssignVariables({});' });
    assert.ok(!p.apis.includes('getvar'));
    assert.ok(p.apis.includes('insertOrAssignVariables'));
});

test('probePluginSource：空源码不抛错', () => {
    const p = probePluginSource({});
    assert.deepEqual(p.events, []);
    assert.deepEqual(p.apis, []);
    assert.deepEqual(p.globals, []);
});

test('renderProbeHtml：输出含类型/事件/API 三段', () => {
    const p = probePluginSource({
        source: 'eventSource.on(event_types.CHAT_CHANGED, f); getVariables();'
    });
    const html = renderProbeHtml(p);
    assert.match(html, /插件能力透视/);
    assert.match(html, /类型/);
    assert.match(html, /监听事件/);
    assert.match(html, /CHAT_CHANGED/);
    assert.match(html, /调用 API/);
});

test('renderProbeHtml：未检测到时给出占位文案', () => {
    const html = renderProbeHtml(probePluginSource({}));
    assert.match(html, /未检测到/);
});

test('renderProbeHtml：转义尖括号防注入', () => {
    const html = renderProbeHtml({ kindLabel: '<img src=x onerror=alert(1)>', events: [], apis: [], globals: [] });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img'));
});
