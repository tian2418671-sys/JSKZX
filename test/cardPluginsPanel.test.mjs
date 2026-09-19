import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref, shallowRef, computed, triggerRef, nextTick } from 'vue';
import { useCardPlugins } from '../js/composables/useCardPlugins.js';

/**
 * 组合式函数契约测试（卡内插件页签）
 *
 * 为什么要有这份：页签的「新增 / 删除 / 编辑 / 展开」在**运行时**验证受限于
 * Electron 原生确认框（`dialog.showMessageBox` 系统对话框，CDP 点不到、contextBridge 对象
 * 也不能被劫持），所以把这条链路固定在单测里。
 *
 * 关键契约（历史缺陷高发点）：
 *   · 编辑必须写进**卡片数据本体**（shallowRef 深层改动不会自动响应 → 必须 refreshCardData）
 *   · 新增/删除后 computed 必须重算出新列表（数组被整体替换时靠 cardContentVersion 标脏）
 *   · 旧版形态（value 包装）删除要按**外层条目身份**定位，不能按内层对象
 *   · 取消确认框 → 一条都不能删
 */

/** 造一个「迷你 App.vue 环境」：卡片数据 + 与真实实现等价的 refreshCardData */
function makeEnv(cardJson) {
    const cardData = shallowRef(cardJson);
    const cardContentVersion = ref(0);
    const calls = { refresh: 0, logs: [], confirms: 0 };
    const env = {
        cardData,
        safeData: computed(() => (cardData.value && cardData.value.data) || {}),
        cardContentVersion,
        refreshCardData: () => { calls.refresh++; cardContentVersion.value++; triggerRef(cardData); },
        confirmDialog: async () => { calls.confirms++; return calls.confirmResult !== false; },
        addLog: (msg) => calls.logs.push(msg)
    };
    return { env, calls };
}

const modernCard = () => ({
    name: '测试卡',
    data: {
        name: '测试卡',
        extensions: {
            tavern_helper: {
                scripts: [
                    { type: 'script', enabled: true, name: 'A', id: 'id-a', content: 'a()' },
                    { type: 'script', enabled: false, name: 'B', id: 'id-b', content: 'b()' }
                ],
                variables: { 好感度: 0 }
            }
        }
    }
});

test('读取：条目分组/可编辑标记/只读分组都正确', () => {
    const { env } = makeEnv(modernCard());
    const p = useCardPlugins(env);
    const group = p.pluginScriptGroup.value;
    assert.equal(group.items.length, 2);
    assert.equal(group.writable, true);
    assert.equal(p.cardPluginCount.value, 2);
    assert.deepEqual(p.pluginExtraGroups.value.map(g => g.key), ['tavern-variables']);
    assert.equal(p.pluginExtraGroups.value[0].writable, false, '变量分组必须只读');
});

test('编辑：改名/启用/正文都写回卡片数据本体，并触发刷新', async () => {
    const card = modernCard();
    const { env, calls } = makeEnv(card);
    const p = useCardPlugins(env);
    const item = p.pluginScriptGroup.value.items[0];

    p.updatePluginItemField(item, 'name', '改名了');
    assert.equal(card.data.extensions.tavern_helper.scripts[0].name, '改名了', '必须落在卡片数据上');

    p.updatePluginItemField(item, 'enabled', false);
    assert.equal(card.data.extensions.tavern_helper.scripts[0].enabled, false);

    p.updatePluginItemField(item, 'content', 'x'.repeat(10));
    assert.equal(card.data.extensions.tavern_helper.scripts[0].content, 'x'.repeat(10));
    assert.equal(item.chars, 10, '字符数要即时更新（列表头显示用）');
    assert.equal(calls.refresh >= 2, true, '名称/启用改动立即刷新；正文走防抖');

    // 正文防抖：flush 后应再刷新一次，且行数惰性值已失效重算
    p.flushPluginEdits();
    await nextTick();
    assert.equal(item.lines, 1);
});

test('新增：没有容器时按主流形态创建，且新条目正文是空串', async () => {
    const card = { name: '空卡', data: { name: '空卡', extensions: { talkativeness: '0.5' } } };
    const { env, calls } = makeEnv(card);
    const p = useCardPlugins(env);
    assert.equal(p.pluginScriptGroup.value, null, '没有容器 → 无脚本分组（页面显示空态）');

    p.addPluginScript();
    await nextTick();
    const list = card.data.extensions.tavern_helper.scripts;
    assert.equal(list.length, 1);
    assert.equal(list[0].content, '');
    assert.equal(p.pluginScriptGroup.value.items.length, 1, 'computed 必须重算出新条目');
    assert.equal(p.cardPluginCount.value, 1, '页签徽标数据源要同步');
    assert.equal(calls.refresh, 1);
});

test('新增：旧版容器（TavernHelper_scripts）继续写 value 包装，不改坏结构', async () => {
    const card = { name: '旧卡', data: { name: '旧卡', extensions: { TavernHelper_scripts: [] } } };
    const { env } = makeEnv(card);
    const p = useCardPlugins(env);
    p.addPluginScript();
    await nextTick();
    const list = card.data.extensions.TavernHelper_scripts;
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'script');
    assert.ok(list[0].value && typeof list[0].value === 'object', '旧版形态必须保持 value 包装');
    assert.equal(list[0].value.content, '');
    assert.equal(p.pluginScriptGroup.value.legacy, true);
});

test('删除：确认后按外层条目身份移除，列表与徽标同步', async () => {
    const card = modernCard();
    const { env, calls } = makeEnv(card);
    const p = useCardPlugins(env);
    const itemsBefore = p.pluginScriptGroup.value.items;
    await p.deletePluginScript(itemsBefore[1], 1);
    await nextTick();

    assert.equal(calls.confirms, 1);
    assert.equal(card.data.extensions.tavern_helper.scripts.length, 1);
    assert.equal(card.data.extensions.tavern_helper.scripts[0].name, 'A', '删掉的应是第 2 条 B');
    assert.equal(p.pluginScriptGroup.value.items.length, 1);
    assert.equal(p.cardPluginCount.value, 1);
});

test('删除：旧版形态按外层条目定位（列表里是 value 包装）', async () => {
    const card = {
        name: '旧卡',
        data: { name: '旧卡', extensions: { TavernHelper_scripts: [{ type: 'script', enabled: true, value: { id: 'x', name: 'X', content: 'x()' } }] } }
    };
    const { env } = makeEnv(card);
    const p = useCardPlugins(env);
    await p.deletePluginScript(p.pluginScriptGroup.value.items[0], 0);
    await nextTick();
    assert.equal(card.data.extensions.TavernHelper_scripts.length, 0);
    assert.equal(p.pluginScriptGroup.value.items.length, 0);
});

test('删除：用户点「取消」→ 一条都不删', async () => {
    const card = modernCard();
    const { env, calls } = makeEnv(card);
    calls.confirmResult = false;
    const p = useCardPlugins(env);
    await p.deletePluginScript(p.pluginScriptGroup.value.items[0], 0);
    await nextTick();
    assert.equal(card.data.extensions.tavern_helper.scripts.length, 2);
    assert.equal(p.cardPluginCount.value, 2);
});

test('展开态：切换条目独立、全屏目标解析、切卡后清空', async () => {
    const { env } = makeEnv(modernCard());
    const p = useCardPlugins(env);
    const uid0 = p.scriptUid(p.pluginScriptGroup.value.items[0], 0);
    const uid1 = p.scriptUid(p.pluginScriptGroup.value.items[1], 1);
    p.togglePluginItem(uid0);
    assert.equal(p.isPluginItemExpanded(uid0), true);
    assert.equal(p.isPluginItemExpanded(uid1), false, '展开态必须互不影响');

    p.openPluginFullscreen(uid1);
    await nextTick();
    assert.equal(p.pluginFullscreenItem.value.name, 'B');
    p.closePluginFullscreen();
    assert.equal(p.pluginFullscreenItem.value, null);

    // 切卡 → 展开态清空（不残留上一张卡的 uid）
    env.cardData.value = modernCard();
    await nextTick();
    assert.equal(p.isPluginItemExpanded(uid0), false);
});

test('只读 JSON 文本：懒生成并缓存（同一对象只序列化一次）', () => {
    const card = modernCard();
    const { env } = makeEnv(card);
    const p = useCardPlugins(env);
    const group = p.pluginExtraGroups.value[0];
    const t1 = p.pluginJsonText(group);
    const t2 = p.pluginJsonText(group);
    assert.equal(t1, t2);
    assert.match(t1, /好感度/);
    // 非对象（value 类分组）直接回文本
    assert.equal(p.pluginJsonText({ kind: 'value', text: '某世界书' }), '某世界书');
    assert.equal(p.pluginJsonText(null), '');
});

test('没有卡片（safeData 为空）时所有入口都不抛错', async () => {
    const { env } = makeEnv({ name: '空', data: {} });
    env.cardData.value = null;
    const p = useCardPlugins(env);
    assert.equal(p.cardPluginCount.value, 0);
    assert.equal(p.pluginScriptGroup.value, null);
    assert.equal(p.pluginFullscreenItem.value, null);
    await p.deletePluginScript(null, 0);   // 不应抛
    assert.doesNotThrow(() => p.pluginJsonText(null));
});
