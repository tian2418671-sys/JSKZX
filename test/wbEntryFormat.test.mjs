import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEmbeddedEntry } from '../js/utils/wbEntryFormat.js';

/**
 * DF-15 契约测试：库/旧世界书格式 → 角色卡内嵌 V2 格式
 *
 * ⚠️ 这里的字段名与取值取自**真实数据**：
 *   · 源：2026-09-14 从世界书库导入到 `星月私立高等学院 MVU 3.9.9_copy_*.png` 的那条词条（实测字段列表）
 *   · 目标：同一张卡原有 46 条原生词条的字段结构（V2 内嵌口径）
 */

/** 真实卡里「原生 V2 内嵌词条」的顶层字段白名单（实测：46/46 条都是这 12 个） */
const NATIVE_ENTRY_KEYS = [
    'id', 'keys', 'secondary_keys', 'comment', 'content', 'constant', 'selective',
    'insertion_order', 'enabled', 'position', 'use_regex', 'extensions',
];

/** 真实卡里那条「库格式」词条（字段与取值照抄） */
const LIBRARY_ENTRY = () => ({
    key: ['鬼遮眼', '灵异', '幻术', '眼'],
    keysecondary: [],
    comment: '鬼遮眼',
    content: '鬼遮眼是一种比鬼打墙更为高级…',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 4,
    disable: false,
    excludeRecursion: true,
    preventRecursion: true,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: false,
    automationId: '',
    role: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    triggers: [],
    displayIndex: 3,
});

test('核心四件套：keys / secondary_keys / insertion_order / enabled', () => {
    const out = toEmbeddedEntry(LIBRARY_ENTRY(), 47);
    assert.deepEqual(out.keys, ['鬼遮眼', '灵异', '幻术', '眼']);
    assert.deepEqual(out.secondary_keys, []);
    assert.equal(out.insertion_order, 100);
    assert.equal(out.enabled, true);
    assert.equal(out.use_regex, false, '源没有 use_regex → 必须为 false（true 会把触发词当正则）');
    assert.equal(out.id, 47, '源无 id → 用 fallback');
});

test('被消费的库字段必须删除（不允许两种口径并存）', () => {
    const out = toEmbeddedEntry(LIBRARY_ENTRY());
    for (const k of ['key', 'keysecondary', 'order', 'disable', 'useRegex']) {
        assert.ok(!(k in out), `库字段 ${k} 应被删除`);
    }
});

test('position：顶层归一为字符串，数值真相进 extensions', () => {
    const out = toEmbeddedEntry(LIBRARY_ENTRY());          // 源 position = 4（数值）
    assert.equal(out.position, 'after_char');
    assert.equal(out.extensions.position, 4, '数值位置必须保住（ST 读 extensions.position）');

    assert.equal(toEmbeddedEntry({ key: [], position: 0 }).position, 'before_char');
    assert.equal(toEmbeddedEntry({ key: [], position: 0 }).extensions.position, 0);
    assert.equal(toEmbeddedEntry({ key: [], position: 'before_char' }).extensions.position, 0);
    assert.equal(toEmbeddedEntry({ key: [] }).position, 'before_char', '未指定位置 → 世界书默认 before_char');
});

test('ST 选项字段搬进 extensions，命名与真实卡一致', () => {
    const out = toEmbeddedEntry(LIBRARY_ENTRY());
    const ext = out.extensions;
    // snake_case（真实卡如此）
    assert.equal(ext.exclude_recursion, true);
    assert.equal(ext.prevent_recursion, true);
    assert.equal(ext.delay_until_recursion, false);
    assert.equal(ext.display_index, 3);
    assert.equal(ext.group_override, false);
    assert.equal(ext.group_weight, 100);
    assert.equal(ext.use_group_scoring, false);
    assert.equal(ext.match_whole_words, null);
    assert.equal(ext.scan_depth, null);
    assert.equal(ext.case_sensitive, null);
    assert.equal(ext.automation_id, '');
    assert.equal(ext.match_persona_description, false);
    assert.equal(ext.match_creator_notes, false);
    // 真实卡里保持驼峰的两个
    assert.equal(ext.selectiveLogic, 0);
    assert.equal(ext.useProbability, true);
    // 数值/其它
    assert.equal(ext.probability, 100);
    assert.equal(ext.depth, 4);
    assert.equal(ext.role, 0);
    assert.equal(ext.sticky, 0);
    // 扁平旧键已被搬走
    for (const k of ['excludeRecursion', 'displayIndex', 'groupOverride', 'matchWholeWords']) {
        assert.ok(!(k in out), `扁平键 ${k} 应被搬进 extensions 后删除`);
    }
});

test('转换后的顶层字段 ⊆ 真实卡原生词条字段集（不引入陌生顶层键）', () => {
    const out = toEmbeddedEntry(LIBRARY_ENTRY(), 47);
    const unexpected = Object.keys(out).filter((k) => !NATIVE_ENTRY_KEYS.includes(k));
    assert.deepEqual(unexpected, [], '出现了真实卡里没有的顶层字段：' + unexpected.join(','));
    for (const k of NATIVE_ENTRY_KEYS) assert.ok(k in out, '缺少原生字段 ' + k);
});

test('幂等：已是内嵌格式的条目再转一次不改变语义', () => {
    const native = {
        id: 1,
        keys: ['墨诗雨'],
        secondary_keys: [],
        comment: '校长：墨诗雨',
        content: '设定…',
        constant: false,
        selective: true,
        insertion_order: 100,
        enabled: true,
        position: 'after_char',
        use_regex: true,
        extensions: { position: 1, exclude_recursion: true, display_index: 7 },
    };
    const out = toEmbeddedEntry(native, 99);
    assert.deepEqual(out, native, '内嵌格式条目应原样通过（keys 不被 key 覆盖、id 不被 fallback 覆盖）');
});

test('幂等：库格式连转两次结果一致', () => {
    const a = toEmbeddedEntry(LIBRARY_ENTRY(), 47);
    const b = toEmbeddedEntry(a, 47);
    assert.deepEqual(b, a);
});

test('不就地修改入参（调用方可能传的是内存活对象）', () => {
    const src = LIBRARY_ENTRY();
    const snapshot = JSON.parse(JSON.stringify(src));
    toEmbeddedEntry(src, 47);
    assert.deepEqual(src, snapshot, '入参必须保持原样');
});

test('未知第三方字段保守保留（不白名单式丢弃）', () => {
    const out = toEmbeddedEntry({
        key: ['a'], content: 'c',
        cfSortKey: 80, outlet_name: 'x', myExt: { deep: 1 },
    });
    assert.equal(out.cfSortKey, 80);
    assert.equal(out.outlet_name, 'x');
    assert.deepEqual(out.myExt, { deep: 1 });
});

test('与反向映射（extractWorldbookFromCard 口径）互逆', () => {
    const out = toEmbeddedEntry(LIBRARY_ENTRY(), 47);
    // 反向映射 = useWorldbookExtras.js:63-72 的规则
    const back = {
        key: out.keys,
        keysecondary: out.secondary_keys,
        order: out.insertion_order,
        comment: out.comment,
    };
    assert.deepEqual(back.key, ['鬼遮眼', '灵异', '幻术', '眼']);
    assert.deepEqual(back.keysecondary, []);
    assert.equal(back.order, 100);
    assert.equal(back.comment, '鬼遮眼');
});

test('退化输入：空对象 / null / 字符串 / 数组 不抛异常', () => {
    const empty = toEmbeddedEntry({});
    assert.deepEqual(empty.keys, []);
    assert.deepEqual(empty.secondary_keys, []);
    assert.equal(empty.insertion_order, 100);
    assert.equal(empty.enabled, true);
    assert.equal(empty.content, '');
    assert.equal(empty.id, 0);
    assert.equal(toEmbeddedEntry(null), null);
    assert.equal(toEmbeddedEntry('x'), 'x');
    assert.deepEqual(toEmbeddedEntry([1, 2]), [1, 2]);
});

test('单值触发词（字符串）也能归一为数组', () => {
    const out = toEmbeddedEntry({ key: '触发词', keysecondary: '次触发' });
    assert.deepEqual(out.keys, ['触发词']);
    assert.deepEqual(out.secondary_keys, ['次触发']);
});
