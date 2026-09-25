/**
 * 世界书词条外连接对齐（alignEntryLists）单测
 *
 * 覆盖 TC-02 / TC-09（见 docs/规格与计划/查重引擎/查重扫描与检索-最终方案.md §六）：
 *   - 数量正确：A 3 条 / B 5 条（2 新增 1 删除）→ 恰好 1 条 only-a + 2 条 only-b
 *   - 不得出现「全部 only-a/only-b」（出现即主键退化）
 *   - 同一输入两次调用 key 一致（可断言性）
 *   - 脏数据不跨侧配对（带侧标识约束）
 *   - 重复 comment 一对一（mapB 桶约束）
 *   - uid 跨源重生成时仍能配上（三级回退）
 *   - 字典形态 entries 归一化
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    alignEntryLists, keyOf, prepareDiffPayload, summarizeAlignment,
    normalizeEntries, entryKeys, entrySecondaryKeys, entryName
} from '../js/utils/entryAlign.js';

/** 造一条库形态词条（uid 随机，模拟真实生成方式） */
const wbEntry = (comment, content = '', keys = []) => ({
    uid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    comment,
    content,
    key: keys,
    keysecondary: []
});

// ---------------------------------------------------------------- 基本对齐

test('A 3 条 / B 5 条（2 新增 1 删除）→ 恰好 1 only-a + 2 only-b + 3 both', () => {
    const A = [wbEntry('甲', '正文甲'), wbEntry('乙', '正文乙'), wbEntry('丙', '正文丙')];
    // B：去掉「丙」，新增「丁」「戊」
    const B = [wbEntry('甲', '正文甲'), wbEntry('乙', '正文乙'), wbEntry('丁', '正文丁'), wbEntry('戊', '正文戊'), wbEntry('己', '正文己')];

    const pairs = alignEntryLists(A, B);
    const stat = summarizeAlignment(pairs);

    assert.equal(pairs.length, 6, '总条数 = 3 both + 1 only-a + 2 only-b... 实为 2 both + 1 only-a + 3 only-b = 6');
    assert.equal(stat.onlyA, 1, '应恰好 1 条缺失（丙）');
    assert.equal(stat.onlyB, 3, '应恰好 3 条新增（丁/戊/己）');
    assert.equal(stat.both, 2, '应恰好 2 条双侧存在（甲/乙）');

    // 关键：不得出现「全部 only-a / only-b」——那是 keyOf 退化的信号
    assert.ok(stat.both > 0, '必须存在配对成功的条目（出现全 only-a/only-b 即主键退化）');
});

test('词条数相同且内容相同 → 全部 both 且无改动', () => {
    const A = [wbEntry('甲', '同一正文'), wbEntry('乙', '另一正文')];
    const B = [wbEntry('甲', '同一正文'), wbEntry('乙', '另一正文')];
    const stat = summarizeAlignment(alignEntryLists(A, B));
    assert.equal(stat.both, 2);
    assert.equal(stat.onlyA, 0);
    assert.equal(stat.onlyB, 0);
    assert.equal(stat.changed, 0, '正文一致不应计为改动');
});

test('同名条目正文改动 → both 且 changed 计数正确', () => {
    const A = [wbEntry('甲', '旧正文')];
    const B = [wbEntry('甲', '新正文')];
    const stat = summarizeAlignment(alignEntryLists(A, B));
    assert.equal(stat.both, 1);
    assert.equal(stat.changed, 1, '同一条目正文变了应计入 changed');
});

test('触发词改动也算改动', () => {
    const A = [wbEntry('甲', '同一正文', ['触发A'])];
    const B = [wbEntry('甲', '同一正文', ['触发B'])];
    const stat = summarizeAlignment(alignEntryLists(A, B));
    assert.equal(stat.both, 1);
    assert.equal(stat.changed, 1, '触发词变了也算改动');
});

// ---------------------------------------------------------------- 三项硬约束

test('约束①：脏数据（null / 非对象）不跨侧配对', () => {
    // 两侧都在同一位置放脏数据：若 key 不带侧标识，会误配成 both
    const A = [null, wbEntry('正常甲')];
    const B = [null, wbEntry('正常乙')];
    const pairs = alignEntryLists(A, B);
    const bothPairs = pairs.filter(p => p.side === 'both');
    // 只有「正常甲/正常乙」不配对，两个 null 各自 only —— 不能出现 null 配 null 的 both
    assert.equal(bothPairs.length, 0, 'null 与 null 不得配成 both（必须带侧标识）');
    assert.equal(pairs.filter(p => p.side === 'only-a').length, 2);
    assert.equal(pairs.filter(p => p.side === 'only-b').length, 2);
});

test('约束②：同书内重复 comment → 一对一配对，不漏渲染 B 侧条目', () => {
    // A 有 2 条同名「重复」，B 也有 2 条同名「重复」
    const A = [wbEntry('重复', 'A1'), wbEntry('重复', 'A2')];
    const B = [wbEntry('重复', 'B1'), wbEntry('重复', 'B2')];
    const pairs = alignEntryLists(A, B);
    assert.equal(pairs.length, 2, '两侧各 2 条同名 → 应产出恰好 2 对，不多不少');
    assert.equal(pairs.filter(p => p.side === 'both').length, 2, '两条都应配成 both');
    // 一对一：B 侧两条都被消费且不重复
    const usedB = pairs.map(p => p.b).filter(Boolean);
    assert.equal(usedB.length, 2, 'B 侧两条都必须被渲染到');
    assert.equal(new Set(usedB).size, 2, 'B 侧同一条不得被用两次');
});

test('约束②：A 侧多一条同名 → 多出的那条为 only-a，B 侧条目不被重复消费', () => {
    const A = [wbEntry('重复', 'A1'), wbEntry('重复', 'A2'), wbEntry('重复', 'A3')];
    const B = [wbEntry('重复', 'B1'), wbEntry('重复', 'B2')];
    const pairs = alignEntryLists(A, B);
    assert.equal(pairs.length, 3);
    assert.equal(pairs.filter(p => p.side === 'both').length, 2);
    assert.equal(pairs.filter(p => p.side === 'only-a').length, 1, 'A 侧多出的一条应为 only-a');
    assert.equal(pairs.filter(p => p.side === 'only-b').length, 0, 'B 侧不应有 only-b（都被消费了）');
});

test('约束③：uid 跨源重生成（同源词条换了 uid）仍能配上', () => {
    // 同一条词条，B 侧 uid 是新的（模拟「导入词条到角色卡」字段转换）
    const A = [{ uid: 'old_uid_1', comment: '系统提示', content: '同一正文', key: ['系统'] }];
    const B = [{ uid: 'brand_new_uid', comment: '系统提示', content: '同一正文', key: ['系统'] }];
    const pairs = alignEntryLists(A, B);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].side, 'both', 'uid 变了但 comment 相同 → 必须配上（三级回退，不认 uid 当主键）');
});

test('约束③：无 comment 时用触发词指纹配对', () => {
    const A = [{ uid: 'u1', key: ['触发一', '触发二'], content: '正文' }];
    const B = [{ uid: 'u2', keys: ['触发一', '触发二'], content: '正文' }];
    const pairs = alignEntryLists(A, B);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].side, 'both', '无 comment 时触发词指纹应能配对（且兼容 key/keys 两种字段名）');
});

// ---------------------------------------------------------------- 可断言性

test('同一输入两次调用，key 完全一致（不引入随机性）', () => {
    const A = [null, wbEntry('甲'), { uid: 'x' }];
    const B = [undefined, wbEntry('甲'), { uid: 'y' }];
    const k1 = alignEntryLists(A, B).map(p => p.key);
    const k2 = alignEntryLists(A, B).map(p => p.key);
    assert.deepEqual(k1, k2, '两次调用 key 序列必须一致（脏数据 key 不得用 Math.random）');
});

test('脏数据 key 带侧标识：A 侧与 B 侧同位置 key 不同', () => {
    const ka = keyOf(null, 'a', 3);
    const kb = keyOf(null, 'b', 3);
    assert.notEqual(ka, kb, '同位置的 A/B 脏数据 key 必须不同（否则会跨侧误配）');
    assert.ok(ka.includes('a'), 'A 侧 key 应含侧标识');
    assert.ok(kb.includes('b'), 'B 侧 key 应含侧标识');
});

test('keyOf 三级回退优先级：comment > 触发词 > uid', () => {
    assert.ok(keyOf({ comment: '名字', key: ['k'], uid: 'u' }).startsWith('c:'), '有 comment 用 comment');
    assert.ok(keyOf({ key: ['k'], uid: 'u' }).startsWith('k:'), '无 comment 用触发词指纹');
    assert.ok(keyOf({ uid: 'u' }).startsWith('u:'), '都无则用 uid');
    assert.ok(keyOf({}).startsWith('anon:'), '全空则为 anon');
});

// ---------------------------------------------------------------- 边界与鲁棒

test('空数组 / 非数组入参不抛异常', () => {
    assert.deepEqual(alignEntryLists([], []), []);
    assert.deepEqual(alignEntryLists(null, undefined), []);
    assert.deepEqual(alignEntryLists('x', 123), []);
    assert.equal(alignEntryLists([wbEntry('甲')], null).length, 1);
    assert.equal(alignEntryLists([wbEntry('甲')], null)[0].side, 'only-a');
});

test('A 全空 → 全部 only-b（新增）', () => {
    const pairs = alignEntryLists([], [wbEntry('甲'), wbEntry('乙')]);
    assert.equal(pairs.length, 2);
    assert.ok(pairs.every(p => p.side === 'only-b'));
});

test('prepareDiffPayload 防空指针 / 字段类型不匹配', () => {
    const p1 = prepareDiffPayload(null, null);
    assert.equal(typeof p1.name, 'string');
    assert.equal(p1.contentA, '');
    assert.deepEqual(p1.keysA, []);
    assert.equal(p1.changed, false, '两侧都空 → 不算改动');

    // content 是数字 / 对象 → 强制字符串
    const p2 = prepareDiffPayload({ comment: '甲', content: 123 }, { comment: '甲', content: { a: 1 } });
    assert.equal(typeof p2.contentA, 'string');
    assert.equal(p2.contentA, '123');
    assert.equal(typeof p2.contentB, 'string');
});

test('prepareDiffPayload 显示名优先取有名字的那一侧', () => {
    const p = prepareDiffPayload(null, { comment: '只有右侧有名字', content: 'x' });
    assert.equal(p.name, '只有右侧有名字');
});

test('entryName / entryKeys / entrySecondaryKeys 兼容两种字段口径', () => {
    // 库形态
    const lib = { comment: '库条目', key: ['a', 'b'], keysecondary: ['c'] };
    assert.equal(entryName(lib), '库条目');
    assert.deepEqual(entryKeys(lib), ['a', 'b']);
    assert.deepEqual(entrySecondaryKeys(lib), ['c']);
    // 卡内嵌形态
    const emb = { comment: '内嵌条目', keys: ['x'], secondary_keys: ['y'] };
    assert.equal(entryName(emb), '内嵌条目');
    assert.deepEqual(entryKeys(emb), ['x']);
    assert.deepEqual(entrySecondaryKeys(emb), ['y']);
    // 逗号串形态
    assert.deepEqual(entryKeys({ key: '甲, 乙，丙' }), ['甲', '乙', '丙']);
    // 无 comment 时 name 兜底
    assert.equal(entryName({ name: '兜底名' }), '兜底名');
    assert.equal(entryName({}), '未命名条目');
});

test('normalizeEntries 兼容数组与对象字典（V2 老格式）', () => {
    assert.deepEqual(normalizeEntries([1, 2]), [1, 2]);
    assert.deepEqual(normalizeEntries({ '0': 'a', '1': 'b' }), ['a', 'b']);
    assert.deepEqual(normalizeEntries(null), []);
    assert.deepEqual(normalizeEntries(undefined), []);
    assert.deepEqual(normalizeEntries('字符串'), []);
    // 字典形态经对齐后仍能正常工作
    const A = normalizeEntries({ '0': wbEntry('甲', 'x') });
    const B = normalizeEntries({ '0': wbEntry('甲', 'x'), '1': wbEntry('乙', 'y') });
    const stat = summarizeAlignment(alignEntryLists(A, B));
    assert.equal(stat.both, 1);
    assert.equal(stat.onlyB, 1);
});

test('改名场景：显示为「一条缺失 + 一条新增」（已知取舍，非缺陷）', () => {
    const A = [wbEntry('旧名字', '同一正文')];
    const B = [wbEntry('新名字', '同一正文')];
    const stat = summarizeAlignment(alignEntryLists(A, B));
    assert.equal(stat.onlyA, 1, '改名在语义上确实是删 + 增');
    assert.equal(stat.onlyB, 1);
    assert.equal(stat.both, 0);
});

test('大数据量：1000 条对 1000 条（含 50 增 50 删）不退化', () => {
    const A = [];
    for (let i = 0; i < 1000; i++) A.push(wbEntry('条目' + i, '正文' + i));
    const B = A.filter((_, i) => i >= 50).map(e => wbEntry(e.comment, e.content));  // 删掉前 50
    for (let i = 1000; i < 1050; i++) B.push(wbEntry('条目' + i, '正文' + i));      // 新增 50

    const stat = summarizeAlignment(alignEntryLists(A, B));
    assert.equal(stat.onlyA, 50, '应有 50 条缺失');
    assert.equal(stat.onlyB, 50, '应有 50 条新增');
    assert.equal(stat.both, 950, '应有 950 条配对成功');
    assert.ok(stat.both > stat.onlyA + stat.onlyB, '配对成功数应远多于增删数（防退化）');
});
