import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    harvestCardPlugins,
    resolveScriptContainer,
    resolveVariablesContainer,
    buildScriptItem,
    writeScriptField,
    createScriptEntry,
    KNOWN_PLUGIN_EXTENSION_KEYS,
    ST_NATIVE_EXTENSION_KEYS
} from '../js/utils/cardPlugins.js';

/**
 * 契约测试：卡片里「真实存在的」插件形态都必须被读出来（一个都不能漏）
 *
 * 依据：2026-09-19 对 `E:\AI\酒馆工具\角色卡` 76 张真实卡做的形态统计（PNG tEXt/iTXt → chara/ccv3）：
 *   · extensions.tavern_helper = { scripts, variables }       25 张（主流）
 *   · extensions.tavern_helper = [["scripts",[...]], ...]     同字段的键值对数组形态（老导出）
 *   · extensions.TavernHelper_scripts = [{type,value:{...}}]   4 张（旧版，多包一层 value）
 * 历史教训：旧版只认「路径式键名」`extensions["tavern_helper/scripts"]` → 永远匹配不到 → 用户看到「没有脚本」。
 */

/** V3 卡片骨架（数据层） */
const card = (extensions) => ({ name: '测试卡', spec: 'chara_card_v3', extensions: extensions || {} });

const scriptEntry = (name, content, extra = {}) => ({
    type: 'script', enabled: true, name, id: `id-${name}`, content, info: '', button: {}, data: {}, ...extra
});

test('形态①：extensions.tavern_helper.scripts（主流形态）能读出全部脚本与正文', () => {
    const data = card({
        tavern_helper: {
            scripts: [scriptEntry('悬浮窗', 'console.log(1)'), scriptEntry('防奶人', 'console.log(2)', { enabled: false })],
            variables: { 好感度: 0 }
        }
    });
    const info = harvestCardPlugins(data);
    const group = info.groups.find(g => g.key === 'tavern-helper');
    assert.ok(group, '必须出「酒馆助手脚本」分组');
    assert.equal(group.sourcePath, 'extensions.tavern_helper.scripts');
    assert.equal(group.items.length, 2);
    assert.equal(info.total, 2);
    assert.equal(info.enabled, 1, '禁用脚本不计入启用数');
    assert.equal(group.items[0].name, '悬浮窗');
    assert.equal(group.items[0].content, 'console.log(1)');
    assert.equal(group.items[1].enabled, false);
});

test('形态②：tavern_helper 是键值对数组时也能读出脚本与变量（同字段两形态）', () => {
    const data = card({
        tavern_helper: [
            ['scripts', [scriptEntry('MVU', 'import "x"')]],
            ['variables', { 时间: '第一天' }]
        ]
    });
    const info = harvestCardPlugins(data);
    const group = info.groups.find(g => g.key === 'tavern-helper');
    assert.equal(group.items.length, 1, '键值对数组形态必须能读出脚本');
    assert.equal(group.items[0].name, 'MVU');
    assert.match(group.sourcePath, /键值对数组/);
    assert.equal(resolveVariablesContainer(data).keys.length, 1, '键值对数组形态的 variables 也要能读');
});

test('形态③：旧版 TavernHelper_scripts（value 包装）能读出且编辑落在内层对象', () => {
    const inner = { id: 'd944', name: '加载关键字', content: '// Kora' };
    const data = card({ TavernHelper_scripts: [{ type: 'script', value: inner }] });
    const info = harvestCardPlugins(data);
    const group = info.groups.find(g => g.key === 'tavern-helper');
    assert.equal(group.items.length, 1);
    const item = group.items[0];
    assert.equal(item.name, '加载关键字');
    assert.equal(item.legacy, true, 'value 包装形态要标记为 legacy');
    writeScriptField(item, 'content', '// 改过');
    assert.equal(inner.content, '// 改过', '编辑必须写进内层 value 对象（真实落点）');
    assert.equal(data.extensions.TavernHelper_scripts[0].value.name, '加载关键字');
    writeScriptField(item, 'name', '新名字');
    assert.equal(inner.name, '新名字');
    writeScriptField(item, 'enabled', false);
    assert.equal(inner.enabled, false);
});

test('容器存在但为空 → 仍要出分组并标记 empty（不许静默当作「没有」）', () => {
    const data = card({ tavern_helper: { scripts: [], variables: {} } });
    const info = harvestCardPlugins(data);
    const group = info.groups.find(g => g.key === 'tavern-helper');
    assert.ok(group, '空容器也要出分组');
    assert.equal(group.items.length, 0);
    assert.equal(group.empty, true);
    assert.equal(info.total, 0);
});

test('容器形态异常（scripts 不是数组）→ 出分组 + shapeWarning，且不得改动原数据', () => {
    const data = card({ tavern_helper: { scripts: { a: scriptEntry('字典脚本', 'x()') } } });
    const info = harvestCardPlugins(data);
    const group = info.groups.find(g => g.key === 'tavern-helper');
    // scripts 是对象字典 → 不是数组 → 不做危险转换，只报警
    assert.ok(group);
    assert.equal(group.writable, false);
    assert.match(group.shapeWarning, /形态/);
    assert.deepEqual(data.extensions.tavern_helper.scripts, { a: data.extensions.tavern_helper.scripts.a }, '原数据不得被改写');
});

test('完全没有插件容器 → 无分组，但 diagnostics 要列出 extensions 现有键', () => {
    const data = card({ talkativeness: '0.5', fav: false, world: '某世界书', depth_prompt: { prompt: '', depth: 4 } });
    const info = harvestCardPlugins(data);
    assert.equal(info.groups.length, 0);
    assert.equal(info.containerPath, '');
    assert.deepEqual(info.diagnostics.map(d => d.key).sort(), ['depth_prompt', 'fav', 'talkativeness', 'world']);
    assert.equal(info.foreignKeys.length, 0, 'ST 原生字段不进「未识别」列表');
});

test('未识别的第三方扩展键进入 foreignKeys，已知插件键不进', () => {
    const data = card({ talkativeness: '0.5', some_future_plugin: { a: 1 }, 'xiaobaix-tasks': { tasks: [] } });
    const info = harvestCardPlugins(data);
    assert.deepEqual(info.foreignKeys.map(f => f.key), ['some_future_plugin']);
    assert.ok(KNOWN_PLUGIN_EXTENSION_KEYS.includes('xiaobaix-tasks'));
    assert.ok(ST_NATIVE_EXTENSION_KEYS.includes('talkativeness'));
    const third = info.groups.find(g => g.key === 'ext-xiaobaix-tasks');
    assert.ok(third, '已知第三方扩展要出只读分组');
    assert.equal(third.writable, false);
});

test('新增脚本：跟随容器既有形态（主流→对象形态，旧版→value 包装）', () => {
    // 主流形态
    const modern = card({ tavern_helper: { scripts: [] } });
    const c1 = resolveScriptContainer(modern, { create: true });
    c1.list.push(createScriptEntry({ name: '新脚本' }));
    assert.ok(Array.isArray(modern.extensions.tavern_helper.scripts));
    assert.equal(modern.extensions.tavern_helper.scripts[0].name, '新脚本');
    assert.equal(modern.extensions.tavern_helper.scripts[0].content, '', '新脚本正文为空字符串，不能是 undefined');

    // 旧版形态：继续写 value 包装，不破坏结构
    const legacy = card({ TavernHelper_scripts: [] });
    const c2 = resolveScriptContainer(legacy, { create: true });
    c2.list.push(createScriptEntry({ legacy: true, name: '旧版新脚本' }));
    assert.equal(legacy.extensions.TavernHelper_scripts[0].type, 'script');
    assert.equal(legacy.extensions.TavernHelper_scripts[0].value.name, '旧版新脚本');

    // 键值对数组形态：补出 scripts 键值对，而不是塞一个对象进去
    const pair = card({ tavern_helper: [['variables', {}]] });
    const c3 = resolveScriptContainer(pair, { create: true });
    c3.list.push(createScriptEntry({ name: 'A' }));
    assert.ok(Array.isArray(pair.extensions.tavern_helper[1][1]), '须 push 键值对而非改变整体类型');
    assert.equal(pair.extensions.tavern_helper[1][0], 'scripts');
});

test('完全没有容器时 create 会补出主流形态（extensions.tavern_helper.scripts）', () => {
    const data = card({ talkativeness: '0.5' });
    const c = resolveScriptContainer(data, { create: true });
    assert.ok(Array.isArray(c.list));
    assert.equal(c.sourcePath, 'extensions.tavern_helper.scripts');
    assert.deepEqual(data.extensions.tavern_helper, { scripts: [] });
});

test('脚本条目的可选键（code/source、scriptName、active）都能识别', () => {
    const item = buildScriptItem({ type: 'script', scriptName: '别名脚本', code: 'x()', active: false }, 0, 'p');
    assert.equal(item.name, '别名脚本');
    assert.equal(item.content, 'x()');
    assert.equal(item.contentKey, 'code');
    assert.equal(item.enabled, false);
});

test('非对象输入（空卡 / undefined）不得抛错', () => {
    for (const bad of [undefined, null, 42, 'x', []]) {
        const info = harvestCardPlugins(bad);
        assert.equal(info.groups.length, 0);
        assert.equal(info.total, 0);
    }
});
