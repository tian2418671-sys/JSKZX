import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIEW_FIELDS, buildGroup } from '../js/utils/dedupeView.js';
import { normalizeCard, normalizePreset, normalizeWorldbook } from '../js/utils/dedupeContract.js';
import { buildStarClusters } from '../js/utils/dedupeCluster.js';
import { evaluateGate } from '../js/utils/dedupeGates.js';

/**
 * v4 §9 —— 视图契约测试（四弹窗字段 / 推荐版固定 index 0 / `_simType` 白名单对齐）
 *
 * 为什么必须有：弹窗直接渲染 `group.cards[0]`、`isRisky(v._simType)` 等——
 * 一旦契约漂移（字段改名 / 白名单外取值），**渲染期才炸**（编译期无感）。
 */

const T_LONG = '她是一位来自昆仑的年轻修士，性格温柔却异常坚定。修炼路上，她始终相信善意会带来回响。面对险境，她从不退缩，总在关键时刻挺身而出。';

const mkCard = (name, repeat) => normalizeCard({
    path: `/p/${name}.png`, name,
    data: {
        description: T_LONG.repeat(repeat),
        character_book: { entries: [{ key: ['公共甲', '公共乙'], content: '词条正文' }] },
    },
});

test('VIEW_FIELDS：四视图字段清单非空且无重复', () => {
    for (const kind of ['card', 'wb', 'preset', 'content']) {
        assert.ok(Array.isArray(VIEW_FIELDS[kind]) && VIEW_FIELDS[kind].length > 0, `${kind} 清单为空`);
        assert.equal(new Set(VIEW_FIELDS[kind]).size, VIEW_FIELDS[kind].length, `${kind} 存在重复字段`);
    }
});

test('推荐版固定 index 0：中心必须排到 cards[0]（真实链路：归一化→判定→聚类→视图）', () => {
    const a = mkCard('甲样本', 3);
    const b = mkCard('乙样样本', 5); // 更长 → textLen 更大 → 中心
    const g0 = evaluateGate(a, b);
    assert.equal(g0.pass, true, '样本应通过 L1');
    const { clusters } = buildStarClusters([{ a, b, gate: g0 }]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].center.name, '乙样样本', '更长的一方应为中心');
    const g = buildGroup('card', clusters[0], { estimateCardTokens: () => 0 });
    assert.equal(g.cards.length, 2);
    assert.equal(g.cards[0].name, '乙样样本', '推荐版（中心）必须在 index 0');
    assert.equal(g.cards[0].item, clusters[0].center.raw, 'index 0 的 item 必须是中心原对象');
    assert.ok(String(g.cards[0]._diffType).includes('参照'), `中心行 _diffType 应显示参照版本：${g.cards[0]._diffType}`);
});

test('_simType 与 ContentDedupeModal.isRisky 白名单对齐（duplicate 直梯 / 其余必须被 isRisky 捕获）', () => {
    const src = readFileSync(new URL('../js/components/ContentDedupeModal.vue', import.meta.url), 'utf8');
    const allowed = new Set([...src.matchAll(/_simType === '([^']+)'/g)].map((m) => m[1]));
    assert.ok(allowed.size >= 2, `未能解析 Content 白名单：${[...allowed]}`);

    const a = mkCard('甲样本', 3);
    const b = mkCard('乙样样本', 5);
    const { clusters } = buildStarClusters([{ a, b, gate: evaluateGate(a, b) }]);
    const g = buildGroup('card', clusters[0], { asContent: true });
    for (const m of g.cards) {
        assert.ok(m._simType === 'duplicate' || allowed.has(m._simType),
            `_simType='${m._simType}' 既非 duplicate 又不在 Content 白名单内 → 会被误显示为「可安全清理」`);
    }
});

test('preset 视图：_simType 与 PresetDedupeModal.isRisky 白名单对齐', () => {
    const src = readFileSync(new URL('../js/components/PresetDedupeModal.vue', import.meta.url), 'utf8');
    const allowed = new Set([...src.matchAll(/_simType === '([^']+)'/g)].map((m) => m[1]));
    assert.ok(allowed.size >= 2, `未能解析 Preset 白名单：${[...allowed]}`);

    const p1 = normalizePreset({ name: '预设甲', path: '/pp/1.json', data: { prompts: [{ content: T_LONG.repeat(3) }] } });
    const p2 = normalizePreset({ name: '预设乙', path: '/pp/2.json', data: { prompts: [{ content: T_LONG.repeat(4) }] } });
    assert.equal(p1.degraded, null);
    const g0 = evaluateGate(p1, p2);
    assert.equal(g0.pass, true, '预设样本应通过 L2（同内容 MinHash）');
    const { clusters } = buildStarClusters([{ a: p1, b: p2, gate: g0 }]);
    const g = buildGroup('preset', clusters[0]);
    assert.equal(g.list.length, 2);
    assert.equal(g.list[0].name, '预设乙', '推荐版固定 index 0');
    for (const m of g.list) {
        assert.ok(m._simType === 'duplicate' || allowed.has(m._simType),
            `_simType='${m._simType}' 不在 Preset 白名单内`);
    }
});

test('wb 视图：L1 组产出 _diffInfo 与推荐版置首', () => {
    const kh = Uint32Array.from([11, 22, 33]);
    const wb1 = normalizeWorldbook({ path: '/w/1.json', wbName: '甲书', keyHashes: kh, exactContentHash: 'h1', entryCount: 5 });
    const wb2 = normalizeWorldbook({ path: '/w/2.json', wbName: '乙书', keyHashes: kh, exactContentHash: 'h2', entryCount: 6 });
    assert.equal(wb1.degraded, null);
    const g0 = evaluateGate(wb1, wb2);
    assert.equal(g0.pass, true, 'keys 全同应通过 L1');
    const { clusters } = buildStarClusters([{ a: wb1, b: wb2, gate: g0 }]);
    const g = buildGroup('wb', clusters[0], { wbDisplayName: (raw) => raw.wbName, wbEntryCount: () => 0 });
    assert.equal(g.list.length, 2);
    assert.ok(String(g.list[0]._diffInfo).includes('参照'), `中心行应显示参照版本：${g.list[0]._diffInfo}`);
    assert.ok(String(g.list[1]._diffInfo).includes('触发词'), `非中心行 _diffInfo 异常：${g.list[1]._diffInfo}`);
});

test('反向守卫：弹窗模板引用的 `_字段` 必须都在 VIEW_FIELDS 并集内（防拼写漂移）', () => {
    const union = new Set(Object.values(VIEW_FIELDS).flat());
    const files = ['DedupeModal.vue', 'WbDedupeModal.vue', 'PresetDedupeModal.vue', 'ContentDedupeModal.vue'];
    const unknown = [];
    for (const f of files) {
        const src = readFileSync(new URL(`../js/components/${f}`, import.meta.url), 'utf8');
        for (const m of src.matchAll(/\.(_[a-zA-Z][A-Za-z0-9]+)\b/g)) {
            const field = m[1];
            if (!union.has(field)) unknown.push(`${f}: ${field}`);
        }
    }
    assert.deepEqual([...new Set(unknown)], [], `发现契约外字段引用：${[...new Set(unknown)].join('；')}`);
});

test('正向守卫：每类视图至少 3 个契约字段被弹窗实际引用', () => {
    const map = { card: 'DedupeModal.vue', wb: 'WbDedupeModal.vue', preset: 'PresetDedupeModal.vue', content: 'ContentDedupeModal.vue' };
    for (const [kind, f] of Object.entries(map)) {
        const src = readFileSync(new URL(`../js/components/${f}`, import.meta.url), 'utf8');
        const hits = VIEW_FIELDS[kind].filter((x) => x.startsWith('_') && src.includes(x));
        assert.ok(hits.length >= 3, `${f} 引用契约字段过少（${hits.length}）：${hits.join(',')}`);
    }
});
