/**
 * 预设结构指纹与相似类型判定单测（2026-09-23 采纳「预设查重方案」评估的 P0-3）
 *
 * 覆盖：
 *   · `buildPresetStructure` 对 **两种真实形态**（数组 / 数字键对象）的兼容
 *   · 结构 Jaccard / 内容 Jaccard / Kendall tau 顺序 / 采样参数一致性
 *   · 6 种类型判定（完全重复 / 结构相同换皮 / 内容相同重排 / 参数变体 / 高度相似 / 同名但无关）
 *   · 「改名同源」标注（**本方案要补的核心能力** —— 旧实现按名聚类会完全漏掉）
 *   · `pickOrderGroup` **不写死 `character_id`**（真实库 100000 / 100001 并存）
 *   · ⚠️ **关键契约**：判定**只产出标签**，不决定分组
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPresetStructure, structureSimilarity, contentSimilarity, orderSimilarity,
    enabledAgreement, samplerAgreement, classifyPresetSimilarity, pickOrderGroup, setJaccard,
    PRESET_SIM_TYPE, PRESET_SIM_TYPE_META, STRUCT_HIGH, STRUCT_LOW,
    CONTENT_HIGH, CONTENT_LOW, PRESET_DEFAULT_CHARACTER_IDS, PRESET_CLUSTER_THRESHOLD
} from '../js/utils/presetStructure.js';

/** 造一个 OpenAI 预设（`prompts` 为**数组** —— 真实库形态） */
const presetArray = (name, blocks, sampler = {}) => ({
    name,
    prompts: blocks.map(([id, content, enabled = true]) => ({ identifier: id, content, enabled })),
    prompt_order: [{ character_id: 100001, order: blocks.map(([id]) => ({ identifier: id, enabled: true })) }],
    temperature: sampler.temperature ?? 1,
    top_p: sampler.top_p ?? 0.95,
    ...sampler
});

/** 造一个 OpenAI 预设（`prompts` 为**数字键对象** —— 旧导出形态） */
const presetObject = (name, contents) => {
    const prompts = {};
    contents.forEach((c, i) => { prompts[String(i)] = c; });
    return { name, prompts };
};

// ══════════════════════════════════════════════════════════════
// buildPresetStructure：两种真实形态
// ══════════════════════════════════════════════════════════════
test('buildPresetStructure：数组形态（真实库）—— identifier 集合与正文都要收到', () => {
    const s = buildPresetStructure(presetArray('A', [
        ['main', '主提示词内容'], ['jailbreak', '破限内容'], ['customX', '自定义块']
    ]));
    assert.equal(s.ids.size, 3);
    assert.ok(s.ids.has('main') && s.ids.has('jailbreak') && s.ids.has('customX'));
    assert.equal(s.contentById.get('customX'), '自定义块');
    assert.ok(s.totalChars > 0);
});

test('buildPresetStructure：对象形态（旧导出）—— 用下标兜底为 identifier', () => {
    const s = buildPresetStructure(presetObject('B', ['一', '二', '三']));
    assert.equal(s.ids.size, 3);
    assert.equal(s.contentById.get('#0'), '一');
    assert.equal(s.contentById.get('#2'), '三');
});

test('buildPresetStructure：无 identifier 的块**不能丢**（否则两种形态指纹不同）', () => {
    const s = buildPresetStructure({
        prompts: [{ content: '无 id 的块' }, { identifier: 'has', content: '有 id' }]
    });
    assert.equal(s.ids.size, 2, '无 identifier 的块必须用兜底 id 收进来');
    assert.ok([...s.contentById.values()].includes('无 id 的块'));
});

test('buildPresetStructure：enabled 默认 true，显式 false 要读到', () => {
    const s = buildPresetStructure({
        prompts: [{ identifier: 'a', content: 'x' }, { identifier: 'b', content: 'y', enabled: false }]
    });
    assert.equal(s.enabledById.get('a'), true);
    assert.equal(s.enabledById.get('b'), false);
});

test('buildPresetStructure：脏输入不崩（null / 非对象 / prompts 为字符串）', () => {
    for (const bad of [null, undefined, 42, 'str', [], { prompts: 'not-an-object' }]) {
        const s = buildPresetStructure(bad);
        assert.equal(s.ids.size, 0);
        assert.equal(s.blockCount, 0);
        assert.equal(s.orders.size, 0);
    }
});

// ══════════════════════════════════════════════════════════════
// pickOrderGroup：**不写死 character_id**
// ══════════════════════════════════════════════════════════════
test('pickOrderGroup：100000 / 100001 **并存**时取覆盖度最高的那组（不写死常量）', () => {
    assert.deepEqual(PRESET_DEFAULT_CHARACTER_IDS, [100000, 100001],
        '两个默认 id 都必须被承认（真实库并存）');
    const s = buildPresetStructure({
        prompts: [
            { identifier: 'a', content: 'x' }, { identifier: 'b', content: 'y' },
            { identifier: 'c', content: 'z' }
        ],
        prompt_order: [
            // 100000 只覆盖 1 个块（不完整）
            { character_id: 100000, order: [{ identifier: 'a' }] },
            // 100001 覆盖 3 个块 → 应被选中
            { character_id: 100001, order: [{ identifier: 'a' }, { identifier: 'b' }, { identifier: 'c' }] }
        ]
    });
    const g = pickOrderGroup(s);
    assert.equal(g.cid, '100001', '必须选覆盖度最高的那组，而不是按常量硬取');
    assert.equal(g.list.length, 3);
});

test('pickOrderGroup：无 prompt_order → 返回 null / 空数组（不臆断）', () => {
    const g = pickOrderGroup(buildPresetStructure({ prompts: [{ identifier: 'a', content: 'x' }] }));
    assert.equal(g.cid, null);
    assert.deepEqual(g.list, []);
});

// ══════════════════════════════════════════════════════════════
// 四维相似度
// ══════════════════════════════════════════════════════════════
test('structureSimilarity：相同结构 = 1.0；完全不同 = 0', () => {
    const a = buildPresetStructure(presetArray('A', [['x', '1'], ['y', '2']]));
    const b = buildPresetStructure(presetArray('B', [['x', '完全不同'], ['y', '也不一样']]));
    assert.equal(structureSimilarity(a, b), 1, 'identifier 相同 → 结构 100%');
    const c = buildPresetStructure(presetArray('C', [['p', '1'], ['q', '2']]));
    assert.equal(structureSimilarity(a, c), 0);
});

test('setJaccard：两侧皆空 → null（**不是 NaN**，不臆断）', () => {
    assert.equal(setJaccard(new Set(), new Set()), null);
    assert.equal(setJaccard([], []), null);
    assert.equal(setJaccard(new Set(['a']), new Set()), 0);
});

test('contentSimilarity：完全无共有块 → **0**（Jaccard 语义：交集为空）；两侧皆空 → null', () => {
    const same = buildPresetStructure(presetArray('A', [['x', '完全相同的一段正文内容']]));
    const same2 = buildPresetStructure(presetArray('B', [['x', '完全相同的一段正文内容']]));
    assert.equal(contentSimilarity(same, same2), 1);
    // 🛑 语义（2026-09-24 标定后修正）：无共有块 ⇒ 交集为空 ⇒ Jaccard = **0**（不是 null）
    //    ⚠️ 旧实现只累加共有块 ⇒ 无共有块时 `counted = 0` 返回 null；
    //       新实现（Jaccard 语义）分母含单侧独有块 ⇒ 返回 0，更准确且能正确驱动「无关」判定。
    const disjoint = buildPresetStructure(presetArray('C', [['zzz', '另一段']]));
    assert.equal(contentSimilarity(same, disjoint), 0, '无共有块 ⇒ 内容相似度 0（交集为空）');
    // 两侧都没有块 → 无法判定 → null
    assert.equal(contentSimilarity(buildPresetStructure({}), buildPresetStructure({})), null);
});

// ══════════════════════════════════════════════════════════════
// 🛑 阈值标定暴露的真实缺陷（2026-09-24）：内容相似度被「骨架块」虚高到 100%
// ══════════════════════════════════════════════════════════════
test('★★ 内容相似度必须是 **Jaccard 语义**（缺失块计入分母）—— 防「骨架块」虚高', () => {
    // 复刻真实场景：12 个骨架块正文相同 + 各自 40 个自定义块（内容完全不同）
    const skeleton = ['main', 'jailbreak', 'chatHistory'].map(id => [id, '骨架正文内容'.repeat(50)]);
    const a = buildPresetStructure(presetArray('A', [
        ...skeleton, ...Array.from({ length: 40 }, (_, i) => [`magic_${i}`, `魔法主题正文${i}`.repeat(50)])
    ]));
    const b = buildPresetStructure(presetArray('B', [
        ...skeleton, ...Array.from({ length: 40 }, (_, i) => [`cooking_${i}`, `料理主题正文${i}`.repeat(50)])
    ]));
    const c = contentSimilarity(a, b);
    assert.ok(c !== null && c < 0.5,
        `只有骨架块相同时内容相似度必须**很低**（实测 ${c === null ? 'null' : (c * 100).toFixed(1)}%）；`
        + '旧实现只累加共有块 ⇒ 会算出 100% ⇒ 无关对被误判「高度相似」');
});

test('★★ 骨架块虚高的**后果**回归：无关对必须判「无关」，不得判「高度相似」', () => {
    const skeleton = ['main', 'jailbreak'].map(id => [id, '骨架正文'.repeat(80)]);
    const a = buildPresetStructure(presetArray('A', [
        ...skeleton, ...Array.from({ length: 40 }, (_, i) => [`magic_${i}`, `魔法${i}`.repeat(60)])
    ]));
    const b = buildPresetStructure(presetArray('B', [
        ...skeleton, ...Array.from({ length: 40 }, (_, i) => [`sports_${i}`, `体育${i}`.repeat(60)])
    ]));
    const cls = classifyPresetSimilarity({
        structSim: structureSimilarity(a, b),
        contentSim: contentSimilarity(a, b),
        sameName: true
    });
    assert.equal(cls.type, PRESET_SIM_TYPE.DIFFERENT,
        '「只有骨架块相同」的对必须判「无关」—— 旧实现会判「高度相似」并给「清理其余」按钮');
});

test('★ 内容相似度：完全相同 → 1.0（Jaccard 语义下分子等于分母）', () => {
    const mk = () => buildPresetStructure(presetArray('X', [
        ['a', '正文甲'.repeat(30)], ['b', '正文乙'.repeat(30)], ['c', '正文丙'.repeat(30)]
    ]));
    assert.equal(contentSimilarity(mk(), mk()), 1);
});

test('★ 内容相似度：一侧多出大量块 → 相似度被**拉低**（分母含独有块）', () => {
    const base = [['a', '共同正文'.repeat(50)]];
    const extra = Array.from({ length: 20 }, (_, i) => [`x${i}`, `独有正文${i}`.repeat(50)]);
    const a = buildPresetStructure(presetArray('A', base));
    const b = buildPresetStructure(presetArray('B', [...base, ...extra]));
    const c = contentSimilarity(a, b);
    assert.ok(c !== null && c < 0.1,
        `一侧多出 20 倍正文时相似度必须很低（实测 ${c === null ? 'null' : (c * 100).toFixed(1)}%），`
        + '否则「骨架 + 独有块」的组合会虚高');
});

test('orderSimilarity：Kendall tau —— 顺序一致 = 1；完全颠倒 = 0', () => {
    const mk = (order) => ({
        prompts: [{ identifier: 'a', content: 'A' }, { identifier: 'b', content: 'B' }, { identifier: 'c', content: 'C' }],
        prompt_order: [{ character_id: 100001, order: order.map(id => ({ identifier: id })) }]
    });
    const fwd = buildPresetStructure(mk(['a', 'b', 'c']));
    const fwd2 = buildPresetStructure(mk(['a', 'b', 'c']));
    assert.equal(orderSimilarity(fwd, fwd2), 1);
    const rev = buildPresetStructure(mk(['c', 'b', 'a']));
    assert.equal(orderSimilarity(fwd, rev), 0);
});

test('orderSimilarity：交集 < 2 或无 order → null（不臆断）', () => {
    const a = buildPresetStructure(presetArray('A', [['x', '1']]));
    const b = buildPresetStructure({ prompts: [{ identifier: 'x', content: '1' }] });   // 无 order
    assert.equal(orderSimilarity(a, b), null);
});

test('samplerAgreement：值相同比例；无共有参数 → null', () => {
    // ⚠️ 契约：入参是**库条目**（`{data}`），不是裸数据 —— 采样参数挂在 `item.data` 上
    const a = { data: presetArray('A', [['x', '1']], { temperature: 1, top_p: 0.95 }) };
    const b = { data: presetArray('B', [['x', '1']], { temperature: 1, top_p: 0.95 }) };
    assert.equal(samplerAgreement(a, b), 1);
    const c = { data: presetArray('C', [['x', '1']], { temperature: 0.5, top_p: 0.95 }) };
    assert.equal(samplerAgreement(a, c), 0.5);
    assert.equal(samplerAgreement({}, {}), null);
});

// ══════════════════════════════════════════════════════════════
// ★ P1-5：启用状态一致性（块开关是「生效与否」的硬开关）
// ══════════════════════════════════════════════════════════════
test('★ enabledAgreement：共有块中开关相同的比例；无共有块 → null', () => {
    const mk = (blocks) => buildPresetStructure({
        prompts: blocks.map(([id, enabled]) => ({ identifier: id, content: '正文', enabled }))
    });
    const a = mk([['x', true], ['y', true], ['z', true]]);
    const same = mk([['x', true], ['y', true], ['z', true]]);
    assert.equal(enabledAgreement(a, same), 1, '全部一致 → 1.0');
    const oneOff = mk([['x', true], ['y', false], ['z', true]]);
    assert.equal(enabledAgreement(a, oneOff), 2 / 3, '1 个不同 / 3 个共有 → 2/3');
    const allOff = mk([['x', false], ['y', false], ['z', false]]);
    assert.equal(enabledAgreement(a, allOff), 0);
    // 无共有块 → null（不臆断）
    const disjoint = mk([['p', true], ['q', true]]);
    assert.equal(enabledAgreement(a, disjoint), null);
});

test('★ enabledAgreement：`enabled` 缺省视为启用（与 buildPresetStructure 的 `!== false` 同口径）', () => {
    const withDefault = buildPresetStructure({
        prompts: [{ identifier: 'x', content: '正文' }]                      // 无 enabled 字段
    });
    const explicitOn = buildPresetStructure({
        prompts: [{ identifier: 'x', content: '正文', enabled: true }]
    });
    assert.equal(enabledAgreement(withDefault, explicitOn), 1,
        '`enabled` 缺省与显式 true 必须视为**一致**（否则会凭空报「启用状态不同」）');
});

test('★ 类型⑦：结构 + 内容 + 顺序 + 参数全一致，但**启用状态不同** → 启用状态不同（不得判「完全重复」）', () => {
    const r = classifyPresetSimilarity({
        structSim: 1, contentSim: 1, orderSim: 1, enabledSim: 0.9, samplerSim: 1, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.FLIPPED,
        '块开关不同 ⇒ 生效的提示词不同 ⇒ 行为不同，绝不能判「完全重复」给「清理其余」');
});

test('★ 判定顺序：顺序差异优先于启用差异（都不同时标「内容相同重排」）', () => {
    const r = classifyPresetSimilarity({
        structSim: 1, contentSim: 1, orderSim: 0.3, enabledSim: 0.5, samplerSim: 1, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.REORDER);
});

test('★ 启用状态一致性缺失（null）时**不得**误判为「启用状态不同」', () => {
    const r = classifyPresetSimilarity({
        structSim: 1, contentSim: 1, orderSim: 1, enabledSim: null, samplerSim: 1, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.EXACT, '无启用数据时应回落为「完全重复」（不臆断为差异）');
});

// ══════════════════════════════════════════════════════════════
// 6 种类型判定
// ══════════════════════════════════════════════════════════════
test('类型①：结构高 + 内容高 + 顺序一致 + 参数一致 → 完全重复', () => {
    const r = classifyPresetSimilarity({
        structSim: 1, contentSim: 1, orderSim: 1, samplerSim: 1, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.EXACT);
    assert.equal(r.renamed, false);
});

test('类型②：★ 结构高 + 内容低 → 结构相同换皮（**本方案核心能力**）', () => {
    const r = classifyPresetSimilarity({
        structSim: 0.993, contentSim: 0.57, orderSim: null, samplerSim: null, sameName: false
    });
    assert.equal(r.type, PRESET_SIM_TYPE.RESKIN);
    assert.equal(r.renamed, true, '结构高 + 名称不同 → 必须标「改名同源」');
    assert.ok(r.label.includes('改名同源'));
});

test('类型③：结构高 + 内容高 + 顺序不一致 → 内容相同重排（应合并而非删除）', () => {
    const r = classifyPresetSimilarity({
        structSim: 1, contentSim: 1, orderSim: 0.2, samplerSim: 1, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.REORDER);
});

test('类型④：结构高 + 内容高 + 参数不同 → 参数变体（属有意调参）', () => {
    const r = classifyPresetSimilarity({
        structSim: 1, contentSim: 1, orderSim: 1, samplerSim: 0.3, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.SAMPLER_VARIANT);
});

test('类型⑤：结构高 + 内容中等 → 高度相似', () => {
    const r = classifyPresetSimilarity({
        structSim: 0.95, contentSim: 0.7, orderSim: null, samplerSim: null, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.SIMILAR);
});

test('类型⑥：🛑 结构低 + 内容低 → 同名但无关（**绝不能标成高度相似**）', () => {
    const r = classifyPresetSimilarity({
        structSim: 0.04, contentSim: 0.01, orderSim: null, samplerSim: null, sameName: true
    });
    assert.equal(r.type, PRESET_SIM_TYPE.DIFFERENT,
        '两侧都低必须判「无关」—— 否则弹窗「清理其余」会一键误删（PK-29 / AR-48 同型）');
    assert.equal(r.renamed, false);
});

test('降级路径：两侧都无数据 → 保守判「无关」（不臆断）', () => {
    const r = classifyPresetSimilarity({});
    assert.equal(r.type, PRESET_SIM_TYPE.DIFFERENT);
    assert.equal(r.score, null);
});

test('降级路径：只有结构（无内容）→ 按结构分档', () => {
    assert.equal(classifyPresetSimilarity({ structSim: 0.95 }).type, PRESET_SIM_TYPE.SIMILAR);
    assert.equal(classifyPresetSimilarity({ structSim: 0.05 }).type, PRESET_SIM_TYPE.DIFFERENT);
});

test('降级路径：只有内容（无结构）→ 按内容分档', () => {
    assert.equal(classifyPresetSimilarity({ contentSim: 0.95 }).type, PRESET_SIM_TYPE.SIMILAR);
    assert.equal(classifyPresetSimilarity({ contentSim: 0.1 }).type, PRESET_SIM_TYPE.DIFFERENT);
});

test('改名同源标注：结构低时**不得**误标（避免误导用户）', () => {
    const r = classifyPresetSimilarity({
        structSim: 0.05, contentSim: 0.05, sameName: false
    });
    assert.equal(r.renamed, false);
    assert.ok(!r.label.includes('改名同源'));
});

test('阈值分档：常量取值与文档一致（防止悄悄改动）', () => {
    // 🎚️ 2026-09-24 用户拍板方案 A：取**保守档**（宁可漏报、绝不误报）
    assert.equal(STRUCT_HIGH, 0.95);
    assert.equal(STRUCT_LOW, 0.3);
    assert.equal(CONTENT_HIGH, 0.9);
    assert.equal(CONTENT_LOW, 0.7);
    // 🧲 聚类阈值必须与结构高线同值（且是**单一来源**）
    assert.equal(PRESET_CLUSTER_THRESHOLD, STRUCT_HIGH,
        '聚类阈值必须与 STRUCT_HIGH 同值 —— 分组的风险最高，不能用更松的线');
});

test('🎚️ 保守档契约：低线与高线之间必须留有「中间带」（不误判为「完全重复」）', () => {
    assert.ok(CONTENT_LOW < CONTENT_HIGH, 'CONTENT_LOW 必须小于 CONTENT_HIGH');
    // 中间带的样本 → 只能判「高度相似」，不得判「完全重复」
    const mid = (CONTENT_LOW + CONTENT_HIGH) / 2;
    const r = classifyPresetSimilarity({ structSim: 1, contentSim: mid, orderSim: 1, samplerSim: 1 });
    assert.equal(r.type, PRESET_SIM_TYPE.SIMILAR, '中间带必须保守判「高度相似」而非「完全重复」');
});

test('每种类型都有展示元数据（标签 / 配色 / 建议）—— 防止模板渲染 undefined', () => {
    for (const [key, meta] of Object.entries(PRESET_SIM_TYPE_META)) {
        assert.ok(meta.label && meta.tone && meta.advice, `${key} 的元数据不完整`);
    }
    assert.equal(Object.keys(PRESET_SIM_TYPE_META).length, Object.keys(PRESET_SIM_TYPE).length);
});

// ══════════════════════════════════════════════════════════════
// ⚠️ 关键契约
// ══════════════════════════════════════════════════════════════
test('★ 契约：判定结果里**没有**任何「是否同组 / 是否该删」的字段（只产出标签）', () => {
    const r = classifyPresetSimilarity({ structSim: 1, contentSim: 1, sameName: true });
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, ['advice', 'label', 'renamed', 'score', 'tone', 'type'],
        '不得出现 group / same / duplicate / shouldDelete 一类会诱导「自动分组/自动删除」的字段');
});
test('★ 契约：score 只用于展示排序，**不参与**类型判定（改 score 不改 type）', () => {
    const a = classifyPresetSimilarity({ structSim: 0.95, contentSim: 0.7, samplerSim: 1 });
    const b = classifyPresetSimilarity({ structSim: 0.95, contentSim: 0.7, samplerSim: 0 });
    assert.equal(a.type, b.type, '采样参数变化不得改变类型判定（只影响展示分）');
    assert.notEqual(a.score, b.score);
});
