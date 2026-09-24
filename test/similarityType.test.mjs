/**
 * 相似类型判定单测（2026-09-23 采纳「多维度 + 类型分类」建议）
 *
 * 覆盖：
 *   · 6 种类型各自的判定边界（完全重复 / 触发重复 / 内容可合并 / 设定冲突 / 高度相似 / 仅名称相同）
 *   · 长度惩罚公式（0.7 + 0.3 × min/max）
 *   · **降级路径**：缺 keys 索引 / 缺内容指纹时不能臆断（返回保守类型，不崩）
 *   · ⚠️ **关键契约**：判定**只产出标签**，不得影响「是否同组」
 *   · 📊 **综合分排序**（2026-09-24「第 2 步」补完）：三级回退 / null 排最后 / 不改入参
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifySimilarity, lengthPenalty, sortByCompositeScore, SIM_TYPE, SIM_TYPE_META,
    KEYS_HIGH, KEYS_LOW, CONTENT_HIGH, CONTENT_LOW
} from '../js/utils/similarityType.js';

// ══════════════════════════════════════════════════════════════
// 长度惩罚
// ══════════════════════════════════════════════════════════════
test('长度惩罚：等长 → 1.0（不降权）', () => {
    assert.equal(lengthPenalty(1000, 1000), 1);
    assert.equal(lengthPenalty(898436, 898436), 1);
});

test('长度惩罚：极端悬殊 → 趋近下限 0.7（降权但不否决）', () => {
    const p = lengthPenalty(1000000, 1);
    assert.ok(p >= 0.7 && p < 0.701, `长度悬殊应趋近下限 0.7，实测 ${p}`);
    // ⚠️ 下限必须是 0.7 而非 0 —— 长度悬殊也可能是同一本的删减版
    assert.ok(p > 0, '惩罚绝不能归零（否则「删减版」会被彻底忽略）');
});

test('长度惩罚：真实库实例（83727 vs 270615）应落在合理区间', () => {
    const p = lengthPenalty(83727, 270615);
    const expect = 0.7 + 0.3 * (83727 / 270615);
    assert.ok(Math.abs(p - expect) < 1e-9, `应等于 0.7+0.3×min/max = ${expect.toFixed(4)}，实测 ${p}`);
    assert.ok(p > 0.7 && p < 0.8, `实测值 ${p.toFixed(3)} 应在 0.7~0.8`);
});

test('长度惩罚：长度未知（0 / null / undefined）→ 取最保守值 0.7', () => {
    assert.equal(lengthPenalty(0, 100), 0.7);
    assert.equal(lengthPenalty(null, 100), 0.7);
    assert.equal(lengthPenalty(undefined, undefined), 0.7);
    assert.equal(lengthPenalty('abc', 100), 0.7);
});

// ══════════════════════════════════════════════════════════════
// 6 种类型判定
// ══════════════════════════════════════════════════════════════
test('类型①：指纹一致 → 完全重复（优先级最高）', () => {
    const r = classifySimilarity({ keysSim: 1, contentSim: 1, exactSame: true, lenA: 1000, lenB: 1000 });
    assert.equal(r.type, SIM_TYPE.EXACT);
    assert.equal(r.label, SIM_TYPE_META[SIM_TYPE.EXACT].label);
});

test('类型②：keys 高 + content 低 + 长度相近 → 触发重复（别删）', () => {
    const r = classifySimilarity({
        keysSim: KEYS_HIGH + 0.1, contentSim: CONTENT_LOW - 0.2, exactSame: false,
        lenA: 10000, lenB: 9500
    });
    assert.equal(r.type, SIM_TYPE.TRIGGER_ONLY);
    assert.match(r.advice, /不要直接删|合并触发词/, '建议必须明确「别删」');
});

test('类型③：content 高 + keys 低 → 内容可合并', () => {
    const r = classifySimilarity({
        keysSim: KEYS_LOW - 0.05, contentSim: CONTENT_HIGH + 0.05, exactSame: false,
        lenA: 10000, lenB: 10000
    });
    assert.equal(r.type, SIM_TYPE.MERGEABLE);
    assert.match(r.advice, /合并/);
});

test('类型④：keys 高 + content 低 + **长度悬殊** → 设定冲突（需人工裁决）', () => {
    const r = classifySimilarity({
        keysSim: KEYS_HIGH + 0.1, contentSim: CONTENT_LOW - 0.2, exactSame: false,
        lenA: 100000, lenB: 10000    // ratio = 0.1 < 0.5
    });
    assert.equal(r.type, SIM_TYPE.CONFLICT);
    assert.match(r.advice, /人工裁决|勿自动清理/, '必须提示需人工裁决');
});

test('类型⑤：keys 高 + content 高但指纹不同 → 高度相似（有微小差异）', () => {
    const r = classifySimilarity({
        keysSim: KEYS_HIGH + 0.1, contentSim: CONTENT_HIGH + 0.05, exactSame: false,
        lenA: 10000, lenB: 10000
    });
    assert.equal(r.type, SIM_TYPE.SIMILAR);
    assert.match(r.advice, /逐条对比/);
});

test('类型⑥：两侧都低 → 仅名称相同（请勿清理）', () => {
    const r = classifySimilarity({
        keysSim: 0.02, contentSim: 0.001, exactSame: false, lenA: 3192, lenB: 13840
    });
    assert.equal(r.type, SIM_TYPE.DIFFERENT);
    assert.match(r.advice, /请勿清理/);
});

// ══════════════════════════════════════════════════════════════
// 降级路径（数据缺失时**不臆断、不崩**）
// ══════════════════════════════════════════════════════════════
test('降级：缺 keys 索引（oversized 书）→ 只按 content 判定，不崩', () => {
    const r1 = classifySimilarity({ keysSim: null, contentSim: 0.95, exactSame: false, lenA: 5000, lenB: 5000 });
    assert.equal(r1.type, SIM_TYPE.SIMILAR, '内容高但无 keys → 保守判「高度相似」');
    const r2 = classifySimilarity({ keysSim: null, contentSim: 0.1, exactSame: false, lenA: 5000, lenB: 5000 });
    assert.equal(r2.type, SIM_TYPE.DIFFERENT, '内容低且无 keys → 判「仅名称相同」');
});

test('降级：只有 keys（内容过短/读取失败）→ 只按 keys 判定', () => {
    const r1 = classifySimilarity({ keysSim: 0.8, contentSim: null, exactSame: false, lenA: 10, lenB: 10 });
    assert.equal(r1.type, SIM_TYPE.SIMILAR);
    const r2 = classifySimilarity({ keysSim: 0.02, contentSim: null, exactSame: false, lenA: 10, lenB: 10 });
    assert.equal(r2.type, SIM_TYPE.DIFFERENT);
});

test('降级：两侧都无数据 → 保守判「仅名称相同」（不臆断为相似）', () => {
    const r = classifySimilarity({ keysSim: null, contentSim: null, exactSame: false });
    assert.equal(r.type, SIM_TYPE.DIFFERENT);
    assert.equal(r.score, null, '无数据时综合分必须为 null（不能编一个数）');
});

test('健壮性：空参 / 非数字输入不抛错', () => {
    assert.doesNotThrow(() => classifySimilarity());
    assert.doesNotThrow(() => classifySimilarity({}));
    assert.doesNotThrow(() => classifySimilarity({ keysSim: NaN, contentSim: NaN, lenA: 'x', lenB: {} }));
    assert.doesNotThrow(() => classifySimilarity({ keysSim: Infinity, contentSim: -Infinity }));
    const r = classifySimilarity({ keysSim: NaN, contentSim: NaN });
    assert.equal(r.type, SIM_TYPE.DIFFERENT);
});

// ══════════════════════════════════════════════════════════════
// 综合分
// ══════════════════════════════════════════════════════════════
test('综合分：内容权重 0.75 / keys 权重 0.25，再乘长度惩罚', () => {
    const r = classifySimilarity({
        keysSim: 1, contentSim: 1, exactSame: false, lenA: 1000, lenB: 1000
    });
    // penalty = 1 → score = 1*0.75 + 1*0.25 = 1
    assert.equal(r.score, 1);
});

test('综合分：长度惩罚确实生效（同相似度、长度悬殊 → 分数更低）', () => {
    const same = classifySimilarity({ keysSim: 0.5, contentSim: 0.9, exactSame: false, lenA: 10000, lenB: 10000 });
    const diff = classifySimilarity({ keysSim: 0.5, contentSim: 0.9, exactSame: false, lenA: 100000, lenB: 10000 });
    assert.ok(diff.score < same.score,
        `长度悬殊时综合分应更低（实测 ${diff.score.toFixed(3)} < ${same.score.toFixed(3)}）`);
});

// ══════════════════════════════════════════════════════════════
// ⚠️ 关键契约：判定只产出标签，不决定分组
// ══════════════════════════════════════════════════════════════
test('★ 契约：类型判定**不得**参与「是否同组」（防误删风险回归）', () => {
    // 反证：两本「仅名称相同」（最不该同组）也**必须能**被判出类型 ——
    // 若本模块被误用于分组，会把这些书剔除；但它只返回标签，分组由 PK-29 三闸门负责。
    const r = classifySimilarity({ keysSim: 0, contentSim: 0, exactSame: false, lenA: 100, lenB: 200 });
    assert.equal(r.type, SIM_TYPE.DIFFERENT);
    // 返回值里**只有**标签/建议/分数，没有任何「是否同组」的布尔字段
    assert.ok(!('inGroup' in r) && !('sameGroup' in r) && !('keep' in r) && !('remove' in r),
        '返回值不得包含分组/清理决策字段 —— 分组是 PK-29 三闸门的职责');
    assert.deepEqual(Object.keys(r).sort(), ['advice', 'label', 'penalty', 'score', 'tone', 'type']);
});

test('★ 契约：所有类型的建议都必须可执行（不能是空话）', () => {
    for (const [type, meta] of Object.entries(SIM_TYPE_META)) {
        assert.ok(meta.label && meta.label.length >= 3, `${type} 必须有标签`);
        assert.ok(meta.advice && meta.advice.length >= 8, `${type} 必须有可执行建议（实测过短：${meta.advice}）`);
        assert.ok(meta.tone, `${type} 必须有配色`);
    }
});

test('★ 边界：阈值本身必须自洽（LOW < HIGH，且分档不重叠）', () => {
    assert.ok(KEYS_LOW < KEYS_HIGH, `KEYS_LOW(${KEYS_LOW}) 必须小于 KEYS_HIGH(${KEYS_HIGH})`);
    assert.ok(CONTENT_LOW < CONTENT_HIGH, `CONTENT_LOW(${CONTENT_LOW}) 必须小于 CONTENT_HIGH(${CONTENT_HIGH})`);
    // 内容高阈值必须与查重复核闸门（0.85）同口径 —— 否则「同组」与「类型」会自相矛盾
    assert.equal(CONTENT_HIGH, 0.85, 'CONTENT_HIGH 必须等于查重复核闸门 0.85（口径统一）');
});

// ══════════════════════════════════════════════════════════════
// 📊 综合分排序（2026-09-24「第 2 步」补完）
// ══════════════════════════════════════════════════════════════
test('排序：按 _score 降序（最相似的排最前）', () => {
    const items = [
        { name: 'c', _score: 0.4 },
        { name: 'a', _score: 0.95 },
        { name: 'b', _score: 0.7 }
    ];
    const out = sortByCompositeScore(items);
    assert.deepEqual(out.map(x => x.name), ['a', 'b', 'c']);
});

test('排序：_score 相同时回退 _simPct，再回退 textLen（三级回退，顺序稳定）', () => {
    const items = [
        { name: 'x', _score: 0.8, _simPct: 50, textLen: 9999 },
        { name: 'y', _score: 0.8, _simPct: 90, textLen: 10 },
        { name: 'z', _score: 0.8, _simPct: 90, textLen: 500 }
    ];
    const out = sortByCompositeScore(items);
    assert.deepEqual(out.map(x => x.name), ['z', 'y', 'x'],
        '先比 _simPct（90 > 50），同分再比 textLen（500 > 10）');
});

test('排序：_score 为 null / undefined / NaN → 排最后（不能编一个数）', () => {
    const items = [
        { name: 'null', _score: null },
        { name: 'good', _score: 0.3 },
        { name: 'undef' },
        { name: 'nan', _score: NaN }
    ];
    const out = sortByCompositeScore(items);
    assert.equal(out[0].name, 'good', '有分数的必须排最前');
    assert.deepEqual(out.slice(1).map(x => x.name).sort(), ['nan', 'null', 'undef'], '无分数的全排后面');
});

test('★ 契约：排序**不修改入参数组**（返回新数组）', () => {
    const items = [{ _score: 0.1 }, { _score: 0.9 }];
    const before = items.map(x => x._score);
    const out = sortByCompositeScore(items);
    assert.notEqual(out, items, '必须返回新数组');
    assert.deepEqual(items.map(x => x._score), before, '入参数组不得被就地排序');
});

test('排序：空数组 / 非数组 → 安全返回空数组', () => {
    assert.deepEqual(sortByCompositeScore([]), []);
    assert.deepEqual(sortByCompositeScore(null), []);
    assert.deepEqual(sortByCompositeScore(undefined), []);
    assert.deepEqual(sortByCompositeScore('x'), []);
});

test('排序：单元素 / 全同分 → 保持可用（不抛错）', () => {
    assert.equal(sortByCompositeScore([{ _score: 0.5 }]).length, 1);
    const same = sortByCompositeScore([{ name: 'a', _score: 0.5 }, { name: 'b', _score: 0.5 }]);
    assert.equal(same.length, 2);
});
