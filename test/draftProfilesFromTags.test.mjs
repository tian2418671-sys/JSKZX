/**
 * 🏷️ B1：从标签生成分组草稿 — 单测（阶段一）
 * 规格：docs/规格与计划/功能规格/B1-B3-标签回灌闭环-实现规格.md §7.1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    draftProfilesFromTags, defaultMinCards, normalizeGroupProfiles
} from '../js/utils/autoGroup.js';

const M = (obj) => new Map(Object.entries(obj));

// ───────── defaultMinCards（Q5 双闸门之一） ─────────
test('★ defaultMinCards：89 张 ⇒ 5（下限）', () => {
    assert.equal(defaultMinCards(89), 5);
});

test('defaultMinCards：1000 张 ⇒ 20（公式生效）', () => {
    assert.equal(defaultMinCards(1000), 20);
});

test('★ defaultMinCards：11849 张 ⇒ 50（上限）', () => {
    assert.equal(defaultMinCards(11849), 50);
});

test('defaultMinCards：20000 张 ⇒ 50（封顶）', () => {
    assert.equal(defaultMinCards(20000), 50);
});

test('defaultMinCards：0 / 负数 / 非数字 ⇒ 5', () => {
    assert.equal(defaultMinCards(0), 5);
    assert.equal(defaultMinCards(-100), 5);
    assert.equal(defaultMinCards('abc'), 5);
});

// ───────── 闸门一：minCards ─────────
test('★ minCards 门槛：89 张库，count=5 通过、count=4 被过滤', () => {
    const r = draftProfilesFromTags(M({ '刚好5': 5, '差1': 4 }), [], { total: 89 });
    assert.equal(r.effectiveMinCards, 5);
    assert.deepEqual(r.drafts.map((d) => d.group), ['刚好5']);
    assert.equal(r.filtered.belowMinCards, 1);
});

test('★ minCards 门槛：11849 张库，count=49 被过滤、50 通过', () => {
    const r = draftProfilesFromTags(M({ 差一: 49, 刚好: 50 }), [], { total: 11849 });
    assert.equal(r.effectiveMinCards, 50);
    assert.deepEqual(r.drafts.map((d) => d.group), ['刚好']);
    assert.equal(r.filtered.belowMinCards, 1);
});

test('minCards 可手改覆盖动态值', () => {
    const r = draftProfilesFromTags(M({ a: 10 }), [], { total: 11849, minCards: 10 });
    assert.equal(r.effectiveMinCards, 10);
    assert.equal(r.drafts.length, 1);
});

// ───────── 闸门二：maxDrafts ─────────
test('★ maxDrafts：25 个达标标签 ⇒ 只输出 20 条，且是 count 最高的 20 个', () => {
    const counts = {};
    for (let i = 0; i < 25; i++) counts[`t${String(i).padStart(2, '0')}`] = 100 - i;
    const r = draftProfilesFromTags(M(counts), [], { total: 10000, minCards: 5 });
    assert.equal(r.drafts.length, 20);
    assert.equal(r.drafts[0].count, 100);
    assert.equal(r.drafts[19].count, 81);
});

test('maxDrafts 可手改', () => {
    const counts = {};
    for (let i = 0; i < 10; i++) counts[`t${i}`] = 20 - i;
    const r = draftProfilesFromTags(M(counts), [], { total: 1000, minCards: 5, maxDrafts: 3 });
    assert.equal(r.drafts.length, 3);
});

// ───────── 第 1 重过滤：标签池（天然黑名单） ─────────
test('★ 标签池内的基础标签不生成草稿（上游举例的 4 个全覆盖）', () => {
    const r = draftProfilesFromTags(
        M({ 'Male (男性)': 500, 'Female (女性)': 500, 'Furry (兽人/福瑞)': 300, 'NSFW (成人/敏感)': 200, '病娇': 100 }),
        [],
        { total: 1000, minCards: 5, commonTags: ['Male (男性)', 'Female (女性)', 'Furry (兽人/福瑞)', 'NSFW (成人/敏感)'] }
    );
    assert.deepEqual(r.drafts.map((d) => d.group), ['病娇']);
    assert.equal(r.filtered.inPool.length, 4);
    assert.equal(r.poolEmpty, false);
});

test('★ 池为空（用户主动清空）⇒ 不执行池过滤，并置 poolEmpty', () => {
    const r = draftProfilesFromTags(M({ 'Male (男性)': 500, '病娇': 100 }), [], { total: 1000, minCards: 5, commonTags: [] });
    assert.equal(r.poolEmpty, true);
    assert.equal(r.drafts.length, 2, '池空时两个都应成为候选');
});

// ───────── 第 3 重过滤：幂等去重 ─────────
test('★ 已有同 group+type+pattern 的档案 ⇒ 跳过（幂等）', () => {
    const existing = normalizeGroupProfiles([{ group: '病娇', match: { type: 'tag', pattern: '病娇' } }]);
    const r = draftProfilesFromTags(M({ '病娇': 100 }), existing, { total: 1000, minCards: 5 });
    assert.equal(r.drafts.length, 0);
    assert.equal(r.filtered.duplicate, 1);
});

test('已有档案 pattern 大小写不同也视为重复（与 normalizeGroupProfiles 同款 dedupeKey）', () => {
    const existing = normalizeGroupProfiles([{ group: 'Yandere', match: { type: 'tag', pattern: 'yandere' } }]);
    const r = draftProfilesFromTags(M({ Yandere: 100 }), existing, { total: 1000, minCards: 5 });
    assert.equal(r.drafts.length, 0, 'pattern 比对按小写归一 ⇒ 视为同一规则');
    assert.equal(r.filtered.duplicate, 1);
});

test('不同分组的同名条件不算重复', () => {
    const existing = normalizeGroupProfiles([{ group: '别组', match: { type: 'tag', pattern: '病娇' } }]);
    const r = draftProfilesFromTags(M({ '病娇': 100 }), existing, { total: 1000, minCards: 5 });
    assert.equal(r.drafts.length, 1);
});

// ───────── 大小写铁律（autoGroup.js 顶部铁律 1） ─────────
test('★ 草稿的 match.pattern 必须是小写（extractCardTags 输出已小写）', () => {
    const r = draftProfilesFromTags(M({ Yandere: 100, 'FEMALE WARRIOR': 60 }), [], { total: 1000, minCards: 5 });
    for (const d of r.drafts) {
        assert.equal(d.match.pattern, d.match.pattern.toLowerCase(), `pattern 应为小写：${d.match.pattern}`);
    }
    const y = r.drafts.find((d) => d.group === 'Yandere');
    assert.equal(y.match.pattern, 'yandere');
    assert.equal(y.label, 'Yandere', 'label 保留原始大小写供 UI 显示');
});

test('中文标签小写化无影响，pattern 与 label 一致', () => {
    const r = draftProfilesFromTags(M({ '病娇': 100 }), [], { total: 1000, minCards: 5 });
    assert.equal(r.drafts[0].match.pattern, '病娇');
    assert.equal(r.drafts[0].group, '病娇');
});

// ───────── 输出结构 ─────────
test('★ 草稿结构符合现有档案 schema（group / match.type / match.pattern）', () => {
    const r = draftProfilesFromTags(M({ 病娇: 100 }), [], { total: 1000, minCards: 5 });
    const d = r.drafts[0];
    assert.equal(d.match.type, 'tag');
    assert.equal(typeof d.group, 'string');
    assert.equal(typeof d.match.pattern, 'string');
    assert.equal(d.note, '');
    assert.equal(d.count, 100);
    assert.ok(d.reason.includes('100'));
    assert.equal(d.id, undefined, '不预生成 id（由 normalizeGroupProfiles 兜底）');
});

test('生成结果能被 normalizeGroupProfiles 正常接收（不丢条目）', () => {
    const r = draftProfilesFromTags(M({ a1: 100, a2: 80 }), [], { total: 1000, minCards: 5 });
    const normalized = normalizeGroupProfiles(r.drafts);
    assert.equal(normalized.length, 2);
    assert.deepEqual(normalized.map((p) => p.group).sort(), ['a1', 'a2']);
});

// ───────── 边界 ─────────
test('空 tagCounts ⇒ 空草稿、不抛错', () => {
    const r = draftProfilesFromTags(M({}), [], { total: 100 });
    assert.deepEqual(r.drafts, []);
    assert.equal(r.filtered.belowMinCards, 0);
    assert.equal(r.totalCandidates, 0);
});

test('非 Map / 非数组入参不抛错', () => {
    const r = draftProfilesFromTags(null, [], { total: 100 });
    assert.deepEqual(r.drafts, []);
});

test('支持 Array<[k,v]> 形式的 tagCounts（与 Map 结果一致）', () => {
    const a = draftProfilesFromTags(M({ x: 100 }), [], { total: 1000, minCards: 5 });
    const b = draftProfilesFromTags([['x', 100]], [], { total: 1000, minCards: 5 });
    assert.deepEqual(b.drafts.map((d) => d.group), a.drafts.map((d) => d.group));
});

test('空白标签被丢弃并计入 emptyTag', () => {
    const r = draftProfilesFromTags(M({ '   ': 100, 有效: 100 }), [], { total: 1000, minCards: 5 });
    assert.equal(r.filtered.emptyTag, 1);
    assert.deepEqual(r.drafts.map((d) => d.group), ['有效']);
});

test('标签名首尾空格被归一（与已去空格的池按 trim 后比对）', () => {
    const r = draftProfilesFromTags(M({ ' 病娇 ': 100 }), [], { total: 1000, minCards: 5 });
    assert.equal(r.drafts[0].group, '病娇');
    assert.equal(r.drafts[0].match.pattern, '病娇');
});

test('count 为 0 / 负数 / 非数字 ⇒ 按 0 计并被 minCards 过滤', () => {
    const r = draftProfilesFromTags(M({ a: 0, b: -5, c: 'abc' }), [], { total: 1000, minCards: 5 });
    assert.deepEqual(r.drafts, []);
});

test('同一卡数时的排序稳定（按名称升序）', () => {
    const r = draftProfilesFromTags(M({ zzz: 100, aaa: 100 }), [], { total: 1000, minCards: 5 });
    assert.deepEqual(r.drafts.map((d) => d.group), ['aaa', 'zzz']);
});
