// 🌍 世界书打标材料构建（AI-14 修复）—— 纯函数单测
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    WB_MATERIAL_DEFAULTS, WB_MATERIAL_PENDING_NOTE, toKeyArray, listWbEntries, isEntryDisabled,
    entryPrimaryKeys, entrySecondaryKeys, entryTitle, entryTriggerLine, buildWbMaterial, isWbBodyLoaded,
    resolveWbBook, resolveWbEntries, hasEmbeddedBook, isEmbeddedBodyLoaded
} from '../js/utils/wbMaterial.js';

/** 造一本世界书（默认：库口径 `key`） */
const mkBook = (entries, extra = {}) => ({
    name: '测试书',
    data: { description: '', entries, ...extra }
});

describe('wbMaterial — 世界书打标材料（AI-14）', () => {
    it('toKeyArray：数组 / 字符串 / 空值 / 去空白', () => {
        assert.deepEqual(toKeyArray(['a', 'b']), ['a', 'b']);
        assert.deepEqual(toKeyArray('solo'), ['solo']);
        assert.deepEqual(toKeyArray(['  a  ', '', null, 'b']), ['a', 'b']);
        assert.deepEqual(toKeyArray(null), []);
        assert.deepEqual(toKeyArray(undefined), []);
        assert.deepEqual(toKeyArray(0), ['0']);
    });

    it('listWbEntries：数组 / 字典形态 / data 本身是数组 / 无 data', () => {
        assert.equal(listWbEntries(mkBook([{ content: 'x' }])).length, 1);
        assert.equal(listWbEntries({ data: { entries: { 0: { content: 'x' }, 1: { content: 'y' } } } }).length, 2);
        assert.equal(listWbEntries({ data: [{ content: 'x' }, { content: 'y' }] }).length, 2);
        assert.deepEqual(listWbEntries({}), []);
        assert.deepEqual(listWbEntries(null), []);
        // 脏条目过滤
        assert.equal(listWbEntries(mkBook([null, 1, { content: 'ok' }])).length, 1);
    });

    it('isEntryDisabled：内嵌 enabled / 库 disable 双向识别', () => {
        assert.equal(isEntryDisabled({ enabled: false }), true);
        assert.equal(isEntryDisabled({ disable: true }), true);
        assert.equal(isEntryDisabled({ enabled: true }), false);
        assert.equal(isEntryDisabled({ disable: false }), false);
        assert.equal(isEntryDisabled({}), false);
        assert.equal(isEntryDisabled(null), true);
    });

    it('entryPrimaryKeys：库口径 key 优先，内嵌 keys 回退', () => {
        assert.deepEqual(entryPrimaryKeys({ key: ['库'] }), ['库']);
        assert.deepEqual(entryPrimaryKeys({ keys: ['卡'] }), ['卡']);
        // 两者都有：库口径优先（独立世界书路径）
        assert.deepEqual(entryPrimaryKeys({ key: ['库'], keys: ['卡'] }), ['库']);
        assert.deepEqual(entryPrimaryKeys({}), []);
    });

    it('entrySecondaryKeys：keysecondary → secondary_keys 回退', () => {
        assert.deepEqual(entrySecondaryKeys({ keysecondary: ['次级'] }), ['次级']);
        assert.deepEqual(entrySecondaryKeys({ secondary_keys: ['内嵌次级'] }), ['内嵌次级']);
        assert.deepEqual(entrySecondaryKeys({}), []);
    });

    it('entryTitle：comment 第一优先（AI-14 核心）', () => {
        // 有 comment ⇒ 用 comment，**不用**触发词
        assert.equal(entryTitle({ comment: '世界观-魔法体系', key: ['{{user}}', '你'] }), '世界观-魔法体系');
        // 旧卡用 name
        assert.equal(entryTitle({ name: '旧卡词条名', key: ['x'] }), '旧卡词条名');
        // 无 comment ⇒ 回退主触发词首个
        assert.equal(entryTitle({ key: ['触发A', '触发B'] }), '触发A');
        assert.equal(entryTitle({ keys: ['内嵌触发'] }), '内嵌触发');
        // 只有次级
        assert.equal(entryTitle({ keysecondary: ['只有次级'] }), '只有次级');
        // 什么都没有
        assert.equal(entryTitle({}), '');
        assert.equal(entryTitle({ comment: '   ' }), '');
    });

    it('entryTriggerLine：触发词 / 次级 / 常驻 组合', () => {
        assert.equal(entryTriggerLine({ key: ['a', 'b'], keysecondary: ['c'], constant: true }), '触发词：a、b · 次级：c · 常驻');
        assert.equal(entryTriggerLine({ key: ['a'] }), '触发词：a');
        assert.equal(entryTriggerLine({ constant: true }), '常驻');
        assert.equal(entryTriggerLine({}), '');
    });

    it('buildWbMaterial：书名 + 简介 + 词条数 + 词条结构', () => {
        const wb = mkBook([
            { comment: '主线', key: ['开场'], content: '正文一' },
            { comment: '支线', key: ['支线词'], keysecondary: ['次'], constant: true, content: '正文二' }
        ], { description: '这是简介' });
        const m = buildWbMaterial(wb, { name: '我的世界书' });
        assert.ok(m.startsWith('书名：我的世界书'));
        assert.ok(m.includes('简介：这是简介'));
        assert.ok(m.includes('词条数：2'));
        assert.ok(m.includes('【主线】\n触发词：开场\n正文一'));
        assert.ok(m.includes('【支线】\n触发词：支线词 · 次级：次 · 常驻\n正文二'));
        // 词条之间空行（与 splitTextSegments 的段落切分对齐）
        assert.ok(m.includes('正文一\n\n【支线】'));
    });

    it('buildWbMaterial：无 comment 时用触发词当标题，且触发词行照旧列出', () => {
        const m = buildWbMaterial(mkBook([{ key: ['{{user}}', '你'], content: '正文' }]));
        assert.ok(m.includes('【{{user}}】'));
        assert.ok(m.includes('触发词：{{user}}、你'));
        assert.ok(m.includes('正文'));
    });

    it('buildWbMaterial：**跳过禁用词条** + 计数提示（AI-14）', () => {
        const wb = mkBook([
            { comment: '启用A', key: ['a'], content: '甲' },
            { comment: '禁用B', key: ['b'], content: '乙', enabled: false },
            { comment: '禁用C（库口径）', key: ['c'], content: '丙', disable: true }
        ]);
        const m = buildWbMaterial(wb);
        assert.ok(m.includes('【启用A】'));
        assert.ok(!m.includes('【禁用B】'));
        assert.ok(!m.includes('乙'));
        assert.ok(!m.includes('丙'));
        assert.ok(m.includes('词条数：1（另有 2 条已禁用，未送）'));
    });

    it('buildWbMaterial：skipDisabled=false 时禁用词条照送（不写提示）', () => {
        const wb = mkBook([
            { comment: '启用A', key: ['a'], content: '甲' },
            { comment: '禁用B', key: ['b'], content: '乙', enabled: false }
        ]);
        const m = buildWbMaterial(wb, { skipDisabled: false });
        assert.ok(m.includes('【禁用B】'));
        assert.ok(m.includes('词条数：2'));
        assert.ok(!m.includes('已禁用'));
    });

    it('buildWbMaterial：includeComment=false 时不产标题行（只留触发词 + 正文）', () => {
        const m = buildWbMaterial(mkBook([{ comment: '标题', key: ['k'], content: '正文' }]), { includeComment: false });
        assert.ok(!m.includes('【标题】'));
        assert.ok(m.includes('触发词：k'));
        assert.ok(m.includes('正文'));
    });

    it('buildWbMaterial：字段可逐项关闭（简介 / 触发词 / 计数）', () => {
        const wb = mkBook([{ comment: 'T', key: ['k'], constant: true, content: '正文' }], { description: '简介' });
        const m = buildWbMaterial(wb, { includeDescription: false, includeTriggers: false, includeCount: false });
        assert.ok(!m.includes('简介'));
        assert.ok(!m.includes('触发词'));
        assert.ok(!m.includes('词条数'));
        assert.ok(m.includes('【T】\n正文'));
    });

    it('buildWbMaterial：字典形态 entries + 内嵌口径 keys（卡内书混入也不空）', () => {
        const wb = { name: '字典书', data: { entries: { '0': { comment: 'C0', keys: ['k0'], content: 'v0' }, '1': { content: 'v1' } } } };
        const m = buildWbMaterial(wb);
        assert.ok(m.includes('书名：字典书'));
        assert.ok(m.includes('【C0】\n触发词：k0\nv0'));
        assert.ok(m.includes('【无标题】\nv1'));
        assert.ok(m.includes('词条数：2'));
    });

    it('buildWbMaterial：边界——空 wb / 无 data / 无词条 / content 为空', () => {
        assert.equal(buildWbMaterial(null), '');
        assert.equal(buildWbMaterial(undefined), '');
        assert.equal(buildWbMaterial('x'), '');
        // 🩹 2026-10-03：没有 data（= 正文未载入）⇒ **显式标注**，不再是「词条数：0」（真实 UI 手动测试暴露）
        assert.equal(buildWbMaterial({ name: '裸书' }), `书名：裸书\n\n${WB_MATERIAL_PENDING_NOTE}`);
        assert.equal(buildWbMaterial(mkBook([])), '书名：测试书\n\n词条数：0');
        // 空 content 不产空行
        const m = buildWbMaterial(mkBook([{ comment: '只有标题', key: ['k'] }]));
        assert.ok(m.includes('【只有标题】\n触发词：k'));
        assert.ok(!m.includes('触发词：k\n\n\n'));
    });

    it('🩹 正文未载入：显式标注 + isWbBodyLoaded 判定（PK-31 同类坑）', () => {
        const lazy = { name: '懒加载书', dataLoaded: false, data: null };
        assert.equal(isWbBodyLoaded(lazy), false);
        const m = buildWbMaterial(lazy);
        assert.ok(m.includes('书名：懒加载书'));
        assert.ok(m.includes(WB_MATERIAL_PENDING_NOTE));
        assert.ok(!m.includes('词条数：0'), '绝不能装作「0 词条」');
        // 关闭标注开关 → 退回旧行为（词条数：0），供需要旧口径的调用方使用
        assert.equal(buildWbMaterial(lazy, { pendingNote: false }), '书名：懒加载书\n\n词条数：0');
        // dataLoaded 为 undefined 但 data 存在 ⇒ 视为已载入
        assert.equal(isWbBodyLoaded(mkBook([{ content: 'x' }])), true);
        assert.equal(isWbBodyLoaded({ dataLoaded: true, data: { entries: [] } }), true);
        assert.equal(isWbBodyLoaded(null), false);
        // 已载入的书**不出现**标注
        assert.ok(!buildWbMaterial(mkBook([{ comment: 'C', content: 'v' }])).includes('未载入'));
    });

    it('buildWbMaterial：name 选项优先于 wb 自带名（显示名口径）', () => {
        const m1 = buildWbMaterial({ wbName: '显示名', name: '文件名', data: { entries: [] } });
        assert.ok(m1.startsWith('书名：显示名'));
        const m2 = buildWbMaterial({ wbName: '显示名', name: '文件名', data: { entries: [] } }, { name: '外部传入' });
        assert.ok(m2.startsWith('书名：外部传入'));
        // 缺名兜底
        assert.ok(buildWbMaterial({ data: { entries: [] } }).startsWith('书名：未命名'));
    });

    it('默认选项：全开 + 跳过禁用（与文档口径一致）', () => {
        assert.deepEqual(WB_MATERIAL_DEFAULTS, {
            name: '', includeDescription: true, includeComment: true,
            includeTriggers: true, skipDisabled: true, includeCount: true, pendingNote: true
        });
    });
});

// 🌍 AI-20（2026-10-04）：**卡内嵌世界书**（`character_book`）与库世界书**同一套材料实现**
//   背景：用户实测「{{世界书}} 无法引用世界书的内容，是空的」—— 卡内嵌书从未被纳入任何材料来源。
//   真库取证：`E:\AI\酒馆工具\角色卡` 93 张可解析卡里 **78 张**带内嵌世界书（4755 条 / 798 万字）。
describe('wbMaterial — 卡内嵌世界书（AI-20）', () => {
    /**
     * 造一张**真实形态**的库卡片条目（2026-10-04 真机实测的层级，别只探一层）：
     *   `item = { id, path, name, data: <PNG 内嵌 JSON> }`
     *   PNG 内嵌 JSON = `{ spec, spec_version, data: { name, description, character_book } }`
     *   ⇒ `character_book` 实际在 **`item.data.data.character_book`**
     */
    const mkCard = (book, extra = {}) => ({
        id: 'card-1',
        path: 'E:\\卡\\测试卡.png',
        name: '测试卡',
        data: {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: '测试卡',
                description: '卡的描述',
                character_book: book,
                ...extra
            }
        }
    });
    /** 只包一层的历史形态（已解包 / V1 扁平） */
    const mkCardShallow = (book) => ({ id: 'c2', name: '浅层卡', data: { character_book: book } });
    const mkCardFlat = (book) => ({ id: 'c3', name: '扁平卡', character_book: book });

    it('resolveWbBook：库世界书 / V2 双层卡 / 浅层卡 / V1 扁平卡 / 裸载荷 五种形态都取到', () => {
        const lib = { name: '库书', data: { description: 'd', entries: [{ content: 'x' }] } };
        assert.equal(resolveWbBook(lib).entries.length, 1);
        assert.equal(resolveWbBook(mkCard({ entries: [{ content: 'a' }] })).entries.length, 1);
        assert.equal(resolveWbBook(mkCardShallow({ entries: [{ content: 'b' }] })).entries.length, 1);
        assert.equal(resolveWbBook(mkCardFlat({ entries: [{ content: 'c' }] })).entries.length, 1);
        assert.equal(resolveWbBook({ entries: [{ content: 'w' }] }).entries.length, 1);
        assert.equal(resolveWbBook([{ content: 'v' }]).length, 1);
        // ❌ 关键回归：**不能**把「卡的外层 data（含 spec/description/name）」当成书
        //    （真机实测：只探一层会命中卡片外层 data ⇒ 词条数 0 ⇒ 材料空，用户看到的就是「空的」）
        const card = mkCard({ entries: [{ content: 'a' }] });
        assert.equal(resolveWbBook(card).entries, card.data.data.character_book.entries);
        assert.equal(resolveWbEntries(card).length, 1, '必须认到 data.data.character_book');
        // 取不到 ⇒ null / []（不抛错）
        assert.equal(resolveWbBook(null), null);
        assert.equal(resolveWbBook({}), null);
        assert.equal(resolveWbBook({ name: '只有名字' }), null);
        assert.equal(resolveWbBook({ data: { spec: 'chara_card_v2', name: '只有外层' } }), null);
    });

    it('resolveWbEntries / hasEmbeddedBook：字典形态 + V1（book 本身是数组）+ 无书', () => {
        assert.equal(resolveWbEntries(mkCard({ entries: { 0: { content: 'a' }, 1: { content: 'b' } } })).length, 2);
        // ⚠️ V1 形态：`character_book` 就是条目数组（数组自带 `.entries` 原型方法，是历史坑）
        assert.equal(resolveWbEntries(mkCardFlat([{ content: 'a' }])).length, 1);
        assert.equal(hasEmbeddedBook(mkCard({ entries: [{ content: 'a' }] })), true);
        assert.equal(hasEmbeddedBook(mkCard({ entries: [] })), false);
        assert.equal(hasEmbeddedBook({ data: { name: '无书的卡', description: 'd' } }), false);
        assert.equal(hasEmbeddedBook(null), false);
        // 库世界书喂进来也算「有书」（判据同源，调用方不必区分形态）
        assert.equal(hasEmbeddedBook({ data: { entries: [{ content: 'a' }] } }), true);
    });

    it('isEmbeddedBodyLoaded：有正文 true / 瘦身态（词条在、content 全空）false / 无书 true', () => {
        assert.equal(isEmbeddedBodyLoaded(mkCard({ entries: [{ content: 'a' }] })), true);
        assert.equal(isEmbeddedBodyLoaded(mkCard({ entries: [{ content: 'a' }, { content: '' }] })), true);
        // 大库瘦身态：词条对象还在、正文被清空 ⇒ 必须报「未载入」（不能演成"这本书是空的"）
        assert.equal(isEmbeddedBodyLoaded(mkCard({ entries: [{ comment: 'C', keys: ['k'], content: '' }] })), false);
        assert.equal(isEmbeddedBodyLoaded(mkCard({ entries: [] })), true);
        // 一致性：`isWbBodyLoaded` 对**两种入参**都要给对答案（库里看 `data.entries`，卡里看内嵌正文）
        assert.equal(isWbBodyLoaded(mkCard({ entries: [{ content: 'a' }] })), true);
        assert.equal(isWbBodyLoaded(mkCard({ entries: [{ comment: 'C', content: '' }] })), false);
        assert.equal(isWbBodyLoaded(mkBook([{ content: 'a' }])), true);
    });

    it('buildWbMaterial（传真实形态角色卡）：内嵌书正文**非空**，书名走传入的显示名', () => {
        const card = mkCard({
            name: '卡里那本书',
            entries: [
                { comment: '世界观-魔法体系', keys: ['魔法'], content: '魔力来自星辰' },
                { comment: '禁用词条', keys: ['x'], content: '不该出现', enabled: false },
                { keys: ['无备注'], secondary_keys: ['次'], constant: true, content: '次级正文' }
            ]
        });
        const m = buildWbMaterial(card, { name: '🌍 测试卡 · 内嵌世界书' });
        assert.ok(m.startsWith('书名：🌍 测试卡 · 内嵌世界书'));
        assert.ok(m.includes('词条数：2（另有 1 条已禁用，未送）'));
        assert.ok(m.includes('【世界观-魔法体系】\n触发词：魔法\n魔力来自星辰'));
        assert.ok(m.includes('【无备注】\n触发词：无备注 · 次级：次 · 常驻\n次级正文'));
        assert.ok(!m.includes('不该出现'));
        assert.ok(m.length > 30); // 修复前卡片视图下这里根本产不出材料
        // 🐞 修复前（只探一层）的真实症状：把卡片外层 data 当书 ⇒ 拿到 `书名`/`简介` 却「词条数：0」
        assert.ok(!/词条数：0/.test(m));
    });

    it('buildWbMaterial（传角色卡）：书级简介也送（内嵌 `character_book.description`）', () => {
        const m = buildWbMaterial(mkCard({ description: '这本书讲魔法', entries: [{ comment: 'A', content: 'a' }] }));
        assert.ok(m.includes('简介：这本书讲魔法'));
    });

    it('**没有**内嵌世界书的卡：`hasEmbeddedBook` = false ⇒ 调用方不追加材料段（不报错）', () => {
        const plain = { id: 'x', name: '无书卡', data: { data: { description: 'd' } } };
        assert.equal(hasEmbeddedBook(plain), false);
        assert.deepEqual(resolveWbEntries(plain), []);
        // 空书（有 `character_book` 但 0 条）同样判 false；`buildWbMaterial` 的调用点先过 `hasEmbeddedBook`
        assert.equal(hasEmbeddedBook(mkCard({ entries: [] })), false);
        assert.equal(buildWbMaterial(mkCard({ entries: [] })), '书名：测试卡\n\n词条数：0');
    });

    it('buildWbMaterial：内嵌书处于**瘦身态**（词条在、正文空）⇒ 显式「未载入」标注，绝不演成空书', () => {
        const card = mkCard({ entries: [{ comment: '瘦身词条', keys: ['k'], content: '' }] });
        // 判据必须走内嵌口径（卡对象上没有库世界书的 `data.entries`）
        assert.equal(isEmbeddedBodyLoaded(card), false);
        const m = buildWbMaterial(card);
        assert.ok(m.includes(WB_MATERIAL_PENDING_NOTE));
        assert.ok(!m.includes('词条数：0'), '绝不能装作「0 词条」');
        // 读回正文后（`cardSlim` 反向操作）⇒ 正常出材料
        card.data.data.character_book.entries[0].content = '读回来的正文';
        assert.equal(isEmbeddedBodyLoaded(card), true);
        const m2 = buildWbMaterial(card);
        assert.ok(m2.includes('【瘦身词条】\n触发词：k\n读回来的正文'));
        assert.ok(m2.includes('词条数：1'));
    });

    it('库世界书路径未回归：`listWbEntries` 仍只认 `wb.data`（不吃卡的层级）', () => {
        // 卡对象传给 listWbEntries 时取到的是卡片内嵌 JSON（不是 entries）⇒ []（保持旧口径，不与 resolveWbEntries 混用）
        assert.deepEqual(listWbEntries(mkCard({ entries: [{ content: 'a' }] })), []);
        assert.equal(listWbEntries(mkBook([{ content: 'a' }])).length, 1);
    });
});
