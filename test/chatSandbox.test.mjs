/**
 * CT-22~25 同族 bug 的去根回归测试
 *
 * 背景：卡内面板脚本按「酒馆 + 酒馆助手」运行时编写。历史上我们的 sandbox
 * 桥接是**发现一个补一个**（getVariables → getCurrentMessageId → getChatMessages
 * → formatAsDisplayedMessage），每漏一个就在某张卡上翻成空白白框。
 * 这里把「真库扫描出的全部 API」变成断言表，漏一个就红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSandboxApiScript, OBSERVED_APIS } from '../js/composables/chat/useChatSandbox.js';

/** 在干净 VM 里执行一次沙箱脚本，返回 sandbox 全局 */
function runSandbox(ctx = {}) {
    const src = buildSandboxApiScript({
        varsJson: '{"stat_data":{"hp":10}}',
        messageId: 3,
        messageText: '楼层正文',
        lastMessageId: 5,
        macros: { '{{user}}': '玩家' },
        worldbooks: [{ name: '书A', entries: [{ uid: 0, content: '词条' }] }],
        ...ctx
    });
    const g = { console, Promise, JSON, Object, Array, String, Number, Math, Date, isNaN };
    g.window = g;
    g.parent = { postMessage() {} };
    g.addEventListener = () => {};
    g.setTimeout = () => {};
    g.MutationObserver = undefined;
    vm.createContext(g);
    vm.runInContext(src, g);
    return { g, src };
}

test('CT-26：沙箱脚本必须语法合法且可执行', () => {
    const { src } = runSandbox();
    assert.doesNotThrow(() => new vm.Script(src), '生成的桥接脚本语法必须合法');
});

test('CT-26：真库扫描出的每一个 API 都必须存在且可调用（不是 undefined）', () => {
    const { g } = runSandbox();
    const missing = [];
    for (const name of OBSERVED_APIS) {
        if (typeof g[name] !== 'function') missing.push(name);
    }
    assert.deepEqual(missing, [], `面板直接裸调这些 API，缺失即 ReferenceError → 白框：${missing.join(', ')}`);
});

test('CT-26：调用扫描出的 API 不得抛错', () => {
    const { g } = runSandbox();
    for (const name of OBSERVED_APIS) {
        assert.doesNotThrow(() => {
            const r = g[name]();
            // 同步返回或 Promise 均可，但不能是 undefined 崩点
            assert.notEqual(r, undefined, `${name}() 返回了 undefined`);
        }, `${name}() 抛错会导致面板 setup 中断`);
    }
});

test('CT-26：tavern_events / Mvu.events / SillyTavern 必须齐备（属性访问即崩点）', () => {
    const { g } = runSandbox();
    assert.ok(g.tavern_events && typeof g.tavern_events === 'object', '缺 tavern_events');
    assert.equal(typeof g.tavern_events.MESSAGE_SWIPED, 'string');
    assert.equal(typeof g.tavern_events.CHAT_CHANGED, 'string');
    assert.ok(g.Mvu && g.Mvu.events, '缺 Mvu.events');
    assert.equal(typeof g.Mvu.events.VARIABLE_UPDATE_ENDED, 'string');
    assert.ok(g.SillyTavern && typeof g.SillyTavern.getCurrentChatId === 'function');
    assert.equal(typeof g.toastr.success, 'function');
    assert.equal(typeof g.waitGlobalInitialized, 'function');
});

test('CT-26：事件总线必须真连通（面板靠它做变量更新后重绘）', () => {
    const { g } = runSandbox();
    let n = 0;
    const h = g.eventOn(g.Mvu.events.VARIABLE_UPDATE_ENDED, () => { n++; });
    g.eventEmit(g.Mvu.events.VARIABLE_UPDATE_ENDED, { stat_data: {} });
    assert.equal(n, 1, 'eventOn + eventEmit 必须触发监听器');
    h.stop();
    g.eventEmit(g.Mvu.events.VARIABLE_UPDATE_ENDED, {});
    assert.equal(n, 1, 'stop() 后不应再触发');
});

test('CT-26：只读数据必须是真实值（不是空壳）', () => {
    const { g } = runSandbox();
    assert.equal(g.getCurrentMessageId(), 3);
    assert.equal(g.getLastMessageId(), 5);
    assert.equal(g.getChatMessages(3)[0].message, '楼层正文');
    assert.equal(g.getVariables().stat_data.hp, 10);
    assert.equal(g.getAllVariables().stat_data.hp, 10);
    assert.equal(g.substitudeMacros('你好 {{user}}'), '你好 玩家');
    assert.deepEqual([...g.getWorldbookNames()], ['书A']);
    assert.equal(g.getLorebookEntries().length, 1);
});

test('CT-26：正文里的 </script 不得破出桥接脚本', () => {
    const { src } = runSandbox({ messageText: '危险</script><img src=x>' });
    assert.ok(!src.includes('</script><img'), '正文应被转义');
});

test('CT-26：未知全局名兜底 —— 常见面 API 缺失时也必须是函数', () => {
    const { g } = runSandbox();
    const extras = ['getChatHistory', 'getLastMessage', 'createChatMessages', 'deleteChatMessages',
        'stopGeneration', 'getTavernHelperVersion', 'getPresetNames', 'playAudio',
        'insertOrAssignVariables', 'getLorebookEntry', 'formatAsTavernRegexedString'];
    for (const k of extras) {
        assert.equal(typeof g[k], 'function', `兜底缺失：${k}`);
    }
});

test('CT-26：兜底不得覆盖已有实现（写 API 否则会被空壳顶掉）', () => {
    const { g } = runSandbox();
    // getChatMessages 有真实实现（返回正文），不能被兜底空壳替换
    assert.equal(g.getChatMessages(3)[0].message, '楼层正文');
    // eventOn 必须是真总线
    let hit = 0;
    const h = g.eventOn('X', () => hit++);
    g.eventEmit('X');
    assert.equal(hit, 1);
    h.stop();
});
