import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractSlashCommandNames, extractListenedEvents, usesLlm, probePluginSource,
} from '../js/plugins/hostStubProbe.js';
import { renderCapabilityCard, capabilityCardCss } from '../js/plugins/capabilityCard.js';

// ── probe 扩展 ────────────────────────────────────────────────────────────

test('extractSlashCommandNames：识别 registerCommand 对象写法', () => {
    const src = `
    SlashRunner.registerCommand({
      name: "状态栏",
      description: "显示当前状态",
      handler: () => {}
    });`;
    assert.deepEqual(extractSlashCommandNames(src), ['状态栏']);
});

test('extractSlashCommandNames：识别 registerSlashCommand', () => {
    const src = 'registerSlashCommand({ name: "一键写卡", cb: () => {} });';
    assert.deepEqual(extractSlashCommandNames(src), ['一键写卡']);
});

test('extractSlashCommandNames：多个命令去重', () => {
    const src = `
      SlashRunner.registerCommand({ name: "A", handler(){} });
      SlashRunner.registerCommand({ name: "B", handler(){} });
      SlashRunner.registerCommand({ name: "A", handler(){} });`;
    const names = extractSlashCommandNames(src);
    assert.equal(names.length, 2);
    assert.ok(names.includes('A') && names.includes('B'));
});

test('extractSlashCommandNames：无命令返回空数组', () => {
    assert.deepEqual(extractSlashCommandNames('var a = 1;'), []);
});

test('extractListenedEvents：识别 event_types.X 写法', () => {
    const src = 'eventSource.on(event_types.MESSAGE_SENT, fn);\neventSource.on(event_types.CHAT_CHANGED, fn2);';
    const evs = extractListenedEvents(src);
    assert.ok(evs.includes('MESSAGE_SENT'));
    assert.ok(evs.includes('CHAT_CHANGED'));
});

test('extractListenedEvents：识别字符串字面量写法', () => {
    const src = "eventSource.on('message_received', fn);";
    const evs = extractListenedEvents(src);
    assert.deepEqual(evs, ['message_received']);
});

test('usesLlm：识别 generateQuietPrompt', () => {
    assert.equal(usesLlm('await generateQuietPrompt("总结一下")'), true);
});

test('usesLlm：识别 generateRaw / /gen 命令', () => {
    assert.equal(usesLlm('generateRaw({ prompt })'), true);
    assert.equal(usesLlm("triggerSlash('/gen')"), true);
});

test('usesLlm：纯变量脚本不算', () => {
    assert.equal(usesLlm('insertOrAssignVariables({ a: 1 });'), false);
});

test('probePluginSource：返回能力说明书所需字段', () => {
    const src = `
      eventSource.on(event_types.MESSAGE_SENT, fn);
      SlashRunner.registerCommand({ name: "状态栏", handler(){} });
      await generateQuietPrompt("x");`;
    const r = probePluginSource({ source: src });
    assert.ok(Array.isArray(r.listenedEvents));
    assert.ok(Array.isArray(r.slashCommands));
    assert.equal(r.needsLlm, true);
    assert.ok(r.slashCommands.includes('状态栏'));
});

// ── 能力卡渲染 ────────────────────────────────────────────────────────────

test('renderCapabilityCard：包含插件名与「后台逻辑」说明', () => {
    const html = renderCapabilityCard({
        name: '发送前最后正则',
        scripts: [{ content: 'eventSource.on(event_types.MESSAGE_SENT, f);' }],
    });
    assert.ok(html.includes('发送前最后正则'));
    assert.ok(html.includes('后台逻辑插件'));
});

test('renderCapabilityCard：列出监听的时机（含中文说明）', () => {
    const html = renderCapabilityCard({
        name: 'x',
        scripts: [{ content: 'eventSource.on(event_types.MESSAGE_SENT, f);' }],
    });
    assert.ok(html.includes('MESSAGE_SENT'));
    assert.ok(html.includes('用户发送消息后'));
});

test('renderCapabilityCard：列出命令并标注可用斜杠触发', () => {
    const html = renderCapabilityCard({
        name: 'x',
        scripts: [{ content: 'SlashRunner.registerCommand({ name: "状态栏", handler(){} });' }],
    });
    assert.ok(html.includes('/状态栏'));
    assert.ok(html.includes('输入这些命令'));
});

test('renderCapabilityCard：调用模型的插件给出醒目警告', () => {
    const html = renderCapabilityCard({
        name: 'x',
        scripts: [{ content: 'await generateQuietPrompt("hi");' }],
    });
    assert.ok(html.includes('会调用模型'));
    assert.ok(html.includes('不消耗额度'));
});

test('renderCapabilityCard：无事件/无 API 时给空态而非空白', () => {
    const html = renderCapabilityCard({ name: 'x', scripts: [{ content: 'var a = 1;' }] });
    assert.ok(html.includes('未检测到事件监听'));
    assert.ok(html.includes('未检测到明确的 API 调用'));
});

test('renderCapabilityCard：插件名被转义', () => {
    const html = renderCapabilityCard({ name: '<img src=x onerror=alert(1)>', scripts: [{ content: '' }] });
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('&lt;img'));
});

test('renderCapabilityCard：空插件不抛错', () => {
    assert.doesNotThrow(() => renderCapabilityCard(null));
    assert.doesNotThrow(() => renderCapabilityCard({}));
});

test('capabilityCardCss：含关键类名', () => {
    const css = capabilityCardCss();
    for (const cls of ['.jsk-cap', '.jsk-cap-head', '.jsk-list', '.jsk-cmd']) {
        assert.ok(css.includes(cls), `缺少样式 ${cls}`);
    }
});
