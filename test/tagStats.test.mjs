/**
 * 🏷️ 标签统计 / 🧪 卡片巡检 单测
 * 覆盖规格 §四.5：`computeTagStats` / `auditCards` 边界（空库、全无标签、超长判定阈值）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTagStats, tagsOf, nameOf } from '../js/utils/tagStats.js';
import { auditCards, cardInnerOf, AUDIT_RULES, DEFAULT_TOKEN_THRESHOLD } from '../js/utils/cardAudit.js';

const card = (name, tags, inner = {}, extra = {}) => Object.assign({
    name, path: `E:\\lib\\${name}.png`, tags,
    data: { data: Object.assign({ description: '简介', first_mes: '开场白' }, inner) }
}, extra);

// ───────── tagsOf / nameOf ─────────
test('tagsOf：tags → customTags 回退；非字符串归一；空白项剔除', () => {
    assert.deepEqual(tagsOf({ tags: ['a', ' b '] }), ['a', 'b']);
    assert.deepEqual(tagsOf({ customTags: ['x'] }), ['x']);
    assert.deepEqual(tagsOf({ tags: [1, null, ' ok '] }), ['1', 'ok']);
    assert.deepEqual(tagsOf({ tags: [], customTags: ['fallback'] }), [], '空 tags 数组**不**回退（与 dedupeContract 口径一致：只判「是不是数组」）');
    assert.deepEqual(tagsOf({ customTags: ['only'] }), ['only'], 'tags 非数组时才吃 customTags');
    assert.deepEqual(tagsOf({}), []);
    assert.deepEqual(tagsOf(null), []);
    assert.deepEqual(tagsOf({ tags: 'not-array' }), []);
});

test('nameOf：name → fileName → 路径末段 → 兜底', () => {
    assert.equal(nameOf({ name: 'A' }), 'A');
    assert.equal(nameOf({ fileName: 'B' }), 'B');
    assert.equal(nameOf({ path: 'E:\\lib\\C.png' }), 'C.png');
    assert.equal(nameOf({}), '(未命名)');
});

// ───────── computeTagStats ─────────
test('★ computeTagStats：空库边界（除零不崩）', () => {
    const s = computeTagStats([]);
    assert.equal(s.total, 0);
    assert.equal(s.untagged, 0);
    assert.equal(s.coveragePct, 0, '空库覆盖率 = 0（不能 NaN）');
    assert.equal(s.singleTag, 0);
    assert.equal(s.tagCount, 0);
    assert.deepEqual(s.topTags, []);
});

test('★ computeTagStats：全无标签 ⇒ 覆盖率 0、untagged = total', () => {
    const s = computeTagStats([card('a', []), card('b', undefined), card('c', [])]);
    assert.equal(s.total, 3);
    assert.equal(s.untagged, 3);
    assert.equal(s.coveragePct, 0);
    assert.equal(s.untaggedItems.length, 3);
    assert.equal(s.topTags.length, 0);
});

test('computeTagStats：覆盖率 / 单标签卡 / 标签总数 / 榜单排序', () => {
    const s = computeTagStats([
        card('a', ['魔法', '女性']),
        card('b', ['魔法']),
        card('c', ['魔法', '现代']),
        card('d', [])
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.tagged, 3);
    assert.equal(s.untagged, 1);
    assert.equal(s.coveragePct, 75);
    assert.equal(s.singleTag, 1);
    assert.equal(s.tagCount, 3);
    assert.deepEqual(s.topTags, [
        { tag: '魔法', count: 3 },
        { tag: '女性', count: 1 },
        { tag: '现代', count: 1 }
    ], '同票按标签名稳定排序');
    assert.equal(s.untaggedItems[0].name, 'd');
    assert.equal(s.singleTagItems[0].tag, '魔法');
});

test('computeTagStats：topN / capItems 生效，tagCounts 为 Map', () => {
    const items = [];
    for (let i = 0; i < 5; i++) items.push(card('c' + i, ['t' + i]));
    const s = computeTagStats(items, { topN: 2, capItems: 2 });
    assert.equal(s.topTags.length, 2);
    assert.equal(s.singleTagItems.length, 2, '问题清单受限');
    assert.equal(s.singleTag, 5, '计数不受 capItems 影响');
    assert.equal(s.tagCounts instanceof Map, true);
    assert.equal(s.tagCounts.get('t0'), 1);
});

// ───────── cardInnerOf / auditCards ─────────
test('cardInnerOf：`data.data` → `data` → 自身（与 estimateCardTokens 同口径）', () => {
    assert.deepEqual(cardInnerOf({ data: { data: { description: 'x' } } }), { description: 'x' });
    assert.deepEqual(cardInnerOf({ data: { description: 'y' } }), { description: 'y' });
    assert.deepEqual(cardInnerOf({ description: 'z' }), { description: 'z' });
    assert.deepEqual(cardInnerOf(null), {});
});

test('★ auditCards：四条规则各自命中（含空白字符串判空）', () => {
    const items = [
        card('ok', ['tag']),
        card('noDesc', ['tag'], { description: '   ' }),
        card('noTags', []),
        card('noFirst', ['tag'], { first_mes: '' }),
        card('huge', ['tag'], { description: 'x' })
    ];
    const r = auditCards(items, { tokenThreshold: 100, estimateCardTokens: (c) => (c.name === 'huge' ? 5000 : 10) });
    const byId = Object.fromEntries(r.rules.map((x) => [x.id, x]));
    assert.equal(r.total, 5);
    assert.equal(r.tokenThreshold, 100);
    assert.equal(byId['desc-empty'].count, 1);
    assert.equal(byId['desc-empty'].hits[0].name, 'noDesc');
    assert.equal(byId['no-tags'].count, 1);
    assert.equal(byId['no-tags'].hits[0].name, 'noTags');
    assert.equal(byId['first-mes-empty'].count, 1);
    assert.equal(byId['token-over'].count, 1);
    assert.equal(byId['token-over'].hits[0].detail, '5000 token');
    assert.deepEqual(r.rules.map((x) => x.id), AUDIT_RULES.map((x) => x.id), '规则顺序稳定');
});

test('★ auditCards：阈值边界（等于阈值不算超；负数/脏值回退默认）', () => {
    const items = [card('exact', ['t']), card('over', ['t'])];
    const at = auditCards(items, { tokenThreshold: 100, estimateCardTokens: (c) => (c.name === 'exact' ? 100 : 101) });
    assert.equal(at.rules.find((x) => x.id === 'token-over').count, 1, '恰等于阈值不报');
    assert.equal(DEFAULT_TOKEN_THRESHOLD, 8000);
    const dirty = auditCards(items, { tokenThreshold: -5, estimateCardTokens: () => 9000 });
    assert.equal(dirty.tokenThreshold, 8000, '脏阈值回退默认 8000');
    assert.equal(dirty.rules.find((x) => x.id === 'token-over').count, 2);
});

test('auditCards：空库 / 非数组 / 无 estimateCardTokens 时回退 `_tokens`', () => {
    const empty = auditCards([]);
    assert.equal(empty.total, 0);
    assert.equal(empty.rules.every((r) => r.count === 0), true);
    assert.equal(auditCards(null).total, 0);
    const noEst = auditCards([
        Object.assign(card('big', ['t']), { _tokens: 99999 }),
        Object.assign(card('small', ['t']), { _tokens: 1 })
    ]);
    assert.equal(noEst.rules.find((x) => x.id === 'token-over').count, 1);
});

test('auditCards：estimateCardTokens 抛错不崩（记为 0）', () => {
    const r = auditCards([card('a', ['t'])], { estimateCardTokens: () => { throw new Error('boom'); } });
    assert.equal(r.rules.find((x) => x.id === 'token-over').count, 0);
    assert.equal(r.rules.find((x) => x.id === 'no-tags').count, 0);
});

test('auditCards：maxHits 限制清单长度但计数完整', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push(card('c' + i, []));
    const r = auditCards(items, { maxHits: 3 });
    const noTags = r.rules.find((x) => x.id === 'no-tags');
    assert.equal(noTags.count, 10);
    assert.equal(noTags.hits.length, 3);
});
