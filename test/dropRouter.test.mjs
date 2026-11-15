import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DROP_KIND, looksLikeWorldbook, looksLikePreset, isCardLike, classifyDroppedJson, planDrop,
    looksLikePlugin, isScriptFileName
} from '../js/utils/dropRouter.js';

// ── 造数据的小工具 ────────────────────────────────────────────
const v2Card = () => ({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: '测试卡', description: '一个角色', first_mes: '你好' }
});
const v1Card = () => ({ name: '老卡', description: '旧格式', first_mes: '嗨' });
const wbDict = () => ({ entries: { 0: { uid: 0, key: ['魔法'], content: '设定' } } });
const wbArray = () => ({ name: '世界书A', entries: [{ uid: 0, key: ['a'], content: 'x' }] });
const wbInData = () => ({ data: { name: 'WB', entries: [{ uid: 0, content: 'y' }] } });
const presetFull = () => ({
    prompts: [{ identifier: 'main', content: '你是{{char}}' }],
    prompt_order: [{ character_id: 100000, order: [] }],
    temperature: 0.8,
    max_context: 4096,
    wrap_in_quotes: false
});
const presetMin = () => ({ temperature: 1.0, max_context: 8192 });

test('【拖拽分流】角色卡 V2 判定为 card', () => {
    assert.equal(isCardLike(v2Card()), true);
    assert.equal(classifyDroppedJson(v2Card()).kind, DROP_KIND.CARD);
});

test('【拖拽分流】角色卡 V1 判定为 card', () => {
    assert.equal(isCardLike(v1Card()), true);
    assert.equal(classifyDroppedJson(v1Card()).kind, DROP_KIND.CARD);
    assert.equal(classifyDroppedJson(v1Card()).reason.includes('角色卡'), true);
});

test('【拖拽分流】世界书字典形态 entries 判定为 worldbook', () => {
    assert.equal(looksLikeWorldbook(wbDict()), true);
    assert.equal(classifyDroppedJson(wbDict()).kind, DROP_KIND.WORLDBOOK);
});

// 🐞 2026-10-25 热测抓获的真 bug：酒馆世界书形如 {name, description, entries}，
//    带 name + description 会被「V1 角色卡」判定误吞 ⇒ 世界书永远进卡库。
test('【拖拽分流】带 name+description 的世界书不得被判成角色卡（热测 bug）', () => {
    const realWb = {
        name: '我的世界书',
        description: '这是一本世界书',
        entries: { 0: { uid: 0, key: ['魔法'], content: '设定正文', order: 100 } }
    };
    assert.equal(isCardLike(realWb), false, '带 name+description 的世界书不能被判成角色卡');
    assert.equal(looksLikeWorldbook(realWb), true);
    assert.equal(classifyDroppedJson(realWb).kind, DROP_KIND.WORLDBOOK);
});

test('【拖拽分流】带 name+description 的数组形态世界书也不得被判成角色卡', () => {
    const realWb = {
        name: '世界书B',
        description: '说明',
        entries: [{ uid: 0, key: ['a'], content: 'x' }]
    };
    assert.equal(isCardLike(realWb), false);
    assert.equal(classifyDroppedJson(realWb).kind, DROP_KIND.WORLDBOOK);
});

test('【拖拽分流】世界书数组形态判定为 worldbook', () => {
    assert.equal(looksLikeWorldbook(wbArray()), true);
    assert.equal(classifyDroppedJson(wbArray()).kind, DROP_KIND.WORLDBOOK);
});

test('【拖拽分流】世界书包在 data 下也判定为 worldbook', () => {
    assert.equal(looksLikeWorldbook(wbInData()), true);
    assert.equal(classifyDroppedJson(wbInData()).kind, DROP_KIND.WORLDBOOK);
});

test('【拖拽分流】角色卡内嵌世界书不得被误判成独立世界书', () => {
    const card = v2Card();
    card.data.character_book = { entries: [{ uid: 0, content: '内嵌' }] };
    assert.equal(looksLikeWorldbook(card), false);
    assert.equal(classifyDroppedJson(card).kind, DROP_KIND.CARD);
});

test('【拖拽分流】空 entries 外壳不算世界书', () => {
    assert.equal(looksLikeWorldbook({ entries: {} }), false);
    assert.equal(looksLikeWorldbook({ entries: [] }), false);
});

test('【拖拽分流】完整预设（prompts + 采样参数）判定为 preset', () => {
    assert.equal(looksLikePreset(presetFull()), true);
    assert.equal(classifyDroppedJson(presetFull()).kind, DROP_KIND.PRESET);
});

test('【拖拽分流】最小预设（temperature + max_context）判定为 preset', () => {
    assert.equal(looksLikePreset(presetMin()), true);
    assert.equal(classifyDroppedJson(presetMin()).kind, DROP_KIND.PRESET);
});

test('【拖拽分流】只有 temperature 一个字段不算预设（防误判）', () => {
    assert.equal(looksLikePreset({ temperature: 0.7 }), false);
});

test('【拖拽分流】角色卡自带 temperature 不得被误判成预设', () => {
    const card = v2Card();
    card.data.temperature = 0.9;
    card.data.max_context = 4096;
    assert.equal(looksLikePreset(card), false);
    assert.equal(classifyDroppedJson(card).kind, DROP_KIND.CARD);
});

test('【拖拽分流】酒馆配置文件不算角色卡', () => {
    const cfg = { name: 'config', api_keys: {}, system_settings: {} };
    assert.equal(isCardLike(cfg), false);
});

test('【拖拽分流】无法判定的数据归 unknown（保持旧行为）', () => {
    assert.equal(classifyDroppedJson({ foo: 'bar' }).kind, DROP_KIND.UNKNOWN);
    assert.equal(classifyDroppedJson(null).kind, DROP_KIND.UNKNOWN);
    assert.equal(classifyDroppedJson([]).kind, DROP_KIND.UNKNOWN);
});

test('【拖拽分流】planDrop 按类型分组', () => {
    const plan = planDrop([
        { name: 'a.png', kind: DROP_KIND.CARD },
        { name: 'b.json', kind: DROP_KIND.WORLDBOOK },
        { name: 'c.json', kind: DROP_KIND.PRESET },
        { name: 'd.json', kind: DROP_KIND.UNKNOWN },
        { name: 'e.json', kind: DROP_KIND.CARD }
    ]);
    assert.equal(plan.cards.length, 2);
    assert.equal(plan.worldbooks.length, 1);
    assert.equal(plan.presets.length, 1);
    assert.equal(plan.unknown.length, 1);
});

test('【拖拽分流】planDrop 容忍非法输入', () => {
    const plan = planDrop(null);
    assert.deepEqual(plan, { cards: [], worldbooks: [], presets: [], plugins: [], unknown: [] });
    assert.doesNotThrow(() => planDrop([null, undefined, {}]));
});

// ── 🧩 插件 / 脚本（2026-10-25 用户需求：「脚本 = 插件库」） ──────────
test('【拖拽分流】酒馆助手 JSON 脚本（content + name）判定为 plugin', () => {
    const p = { name: '我的脚本', content: 'jQuery(()=>{})', buttons: [] };
    assert.equal(looksLikePlugin(p), true);
    assert.equal(classifyDroppedJson(p).kind, DROP_KIND.PLUGIN);
});

test('【拖拽分流】扩展工程 manifest 判定为 plugin', () => {
    assert.equal(classifyDroppedJson({ manifest_version: 3, name: 'ext' }).kind, DROP_KIND.PLUGIN);
    assert.equal(classifyDroppedJson({ display_name: '扩展', js: 'index.js' }).kind, DROP_KIND.PLUGIN);
    assert.equal(classifyDroppedJson({ extensions: [{ name: 'a' }] }).kind, DROP_KIND.PLUGIN);
});

test('【拖拽分流】正则脚本（scriptName + findRegex）判定为 plugin', () => {
    const p = { scriptName: '去格式', findRegex: '/<div>/g', replaceString: '' };
    assert.equal(looksLikePlugin(p), true);
    assert.equal(classifyDroppedJson(p).kind, DROP_KIND.PLUGIN);
});

test('【拖拽分流】快捷回复集（QR）判定为 plugin', () => {
    assert.equal(classifyDroppedJson({ disableSend: false, injectInput: true }).kind, DROP_KIND.PLUGIN);
});

test('【拖拽分流】酒馆配置文件判定为 plugin', () => {
    assert.equal(classifyDroppedJson({ api_keys: {}, system_settings: {} }).kind, DROP_KIND.PLUGIN);
    assert.equal(classifyDroppedJson({ apiType: 'openai' }).kind, DROP_KIND.PLUGIN);
});

// 🐞 2026-10-25 真实文件实测：`晦明v2.6.json` 是酒馆 UI 主题，39 个字段全是配色/界面项，
//    旧判定认不出 → unknown → 被当角色卡拒掉（用户反馈「一个都没识别到」）。
test('【拖拽分流】酒馆 UI 主题判定为 plugin（真实文件形态）', () => {
    const theme = {
        name: '晦明v2.6',
        blur_strength: 10, main_text_color: '#fff', italics_text_color: '#ccc',
        quote_text_color: '#aaa', blur_tint_color: '#000', chat_tint_color: '#111',
        shadow_color: '#000', border_color: '#222', font_scale: 1,
        custom_css: '', chat_width: 50, avatar_style: 1, fast_ui_mode: true,
        compact_input_area: false
    };
    assert.equal(looksLikePlugin(theme), true);
    assert.equal(classifyDroppedJson(theme).kind, DROP_KIND.PLUGIN);
});

test('【拖拽分流】只有 2 个主题字段不算主题（防误判）', () => {
    assert.equal(classifyDroppedJson({ name: 'x', blur_strength: 1, font_scale: 1 }).kind, DROP_KIND.UNKNOWN);
});

test('【拖拽分流】.js / .mjs / .cjs 文件名识别为脚本', () => {
    assert.equal(isScriptFileName('a.js'), true);
    assert.equal(isScriptFileName('b.mjs'), true);
    assert.equal(isScriptFileName('c.cjs'), true);
    assert.equal(isScriptFileName('d.json'), false);
    assert.equal(isScriptFileName('e.png'), false);
});

test('【拖拽分流】脚本判定不得误吞角色卡/世界书/预设', () => {
    // 带 content 的角色卡仍是卡
    const card = v2Card();
    card.data.content = 'x';
    assert.equal(classifyDroppedJson(card).kind, DROP_KIND.CARD);
    // 世界书
    assert.equal(classifyDroppedJson(wbDict()).kind, DROP_KIND.WORLDBOOK);
    // 预设
    assert.equal(classifyDroppedJson(presetFull()).kind, DROP_KIND.PRESET);
});

test('【拖拽分流】planDrop 支持 plugins 分组', () => {
    const plan = planDrop([
        { name: 'a.js', kind: DROP_KIND.PLUGIN },
        { name: 'b.json', kind: DROP_KIND.PLUGIN },
        { name: 'c.png', kind: DROP_KIND.CARD }
    ]);
    assert.equal(plan.plugins.length, 2);
    assert.equal(plan.cards.length, 1);
});
