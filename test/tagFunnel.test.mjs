/**
 * tagFunnel 纯函数层单元测试（P1 打标三层开关）
 * 规格：`docs/规格与计划/AI打标/打标三层开关-P1实现规格.md` §5.1
 *
 * 关注三件事：
 *   1. 默认值唯一来源且容错（老配置 / 手改坏的文件都不能抛错）
 *   2. 层决策顺序正确 —— 尤其「关①不得顺带关②③」（历史缺陷 AI-02 的同类耦合）
 *   3. skip 原因只在「用户开了该层但条件不满足」时出现（避免文案说"模型未就绪"但其实用户没开）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
    DEFAULT_TAG_FUNNEL,
    normalizeTagFunnel,
    normalizeDisabledRules,
    isFunnelEmpty,
    resolveFunnelPlan,
    formatFunnelSummary,
    formatFunnelBadge
} from '../js/utils/tagFunnel.js';

const DEF = { rule: true, vector: false, llm: true };

test('DEFAULT_TAG_FUNNEL：冻结，且默认 rule=开 / vector=关 / llm=开', () => {
    assert.deepStrictEqual({ ...DEFAULT_TAG_FUNNEL }, DEF);
    assert.ok(Object.isFrozen(DEFAULT_TAG_FUNNEL));
});

test('normalizeTagFunnel：非对象 / 缺键 / 非布尔 → 逐键回落默认', () => {
    assert.deepStrictEqual(normalizeTagFunnel(undefined), DEF);
    assert.deepStrictEqual(normalizeTagFunnel(null), DEF);
    assert.deepStrictEqual(normalizeTagFunnel('abc'), DEF);
    assert.deepStrictEqual(normalizeTagFunnel(123), DEF);
    assert.deepStrictEqual(normalizeTagFunnel({}), DEF);
    assert.deepStrictEqual(normalizeTagFunnel({ rule: 'yes', llm: 1 }), DEF);
    assert.deepStrictEqual(normalizeTagFunnel({ rule: true }), DEF);
});

test('normalizeTagFunnel：合法布尔值原样保留，忽略多余键', () => {
    assert.deepStrictEqual(
        normalizeTagFunnel({ rule: false, vector: true, llm: false, extra: 1 }),
        { rule: false, vector: true, llm: false }
    );
});

test('normalizeTagFunnel：返回新对象（不得返回 DEFAULT 引用，防调用方改坏默认值）', () => {
    const a = normalizeTagFunnel({});
    a.rule = false;
    assert.strictEqual(DEFAULT_TAG_FUNNEL.rule, true);
    assert.notStrictEqual(normalizeTagFunnel({}), DEFAULT_TAG_FUNNEL);
});

test('normalizeDisabledRules：非数组 → []；过滤空与非字符串；trim；去重保序', () => {
    assert.deepStrictEqual(normalizeDisabledRules(undefined), []);
    assert.deepStrictEqual(normalizeDisabledRules(null), []);
    assert.deepStrictEqual(normalizeDisabledRules('NSFW (限制级)'), []);
    assert.deepStrictEqual(normalizeDisabledRules({ 0: 'x' }), []);
    assert.deepStrictEqual(
        normalizeDisabledRules([null, 12, undefined, '', '   ', 'NSFW (限制级)']),
        ['NSFW (限制级)']
    );
    assert.deepStrictEqual(normalizeDisabledRules([' a ', 'b', 'a', 'b']), ['a', 'b']);
});

test('isFunnelEmpty：只有三层全关才为 true', () => {
    assert.strictEqual(isFunnelEmpty({ rule: false, vector: false, llm: false }), true);
    assert.strictEqual(isFunnelEmpty({ rule: false, vector: false }), false);  // 缺 llm → 回落默认 true → 不算空
    assert.strictEqual(isFunnelEmpty({ rule: true, vector: false, llm: false }), false);
    assert.strictEqual(isFunnelEmpty({ rule: false, vector: true, llm: false }), false);
    assert.strictEqual(isFunnelEmpty({ rule: false, vector: false, llm: true }), false);
    assert.strictEqual(isFunnelEmpty(undefined), false);
});

test('resolveFunnelPlan：三层全关 → 全 false', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: false, vector: false, llm: false },
        vectorReady: true, hasCandidateTags: true, hasApiConfig: true
    });
    assert.deepStrictEqual({ rule: p.rule, vector: p.vector, llm: p.llm }, { rule: false, vector: false, llm: false });
});

test('resolveFunnelPlan：关①不影响②③（关键回归 —— 层间不得互相短路，AI-02 同类）', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: false, vector: true, llm: true },
        vectorReady: true, hasCandidateTags: true, hasApiConfig: true
    });
    assert.deepStrictEqual({ rule: p.rule, vector: p.vector, llm: p.llm }, { rule: false, vector: true, llm: true });
    assert.deepStrictEqual(p.skip, {});
});

test('resolveFunnelPlan：只开①（关②③）→ 只跑规则层', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: true, vector: false, llm: false },
        vectorReady: true, hasCandidateTags: true, hasApiConfig: true
    });
    assert.deepStrictEqual({ rule: p.rule, vector: p.vector, llm: p.llm }, { rule: true, vector: false, llm: false });
});

test('resolveFunnelPlan：②开关开但模型未就绪 → vector=false 且给出原因', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: true, vector: true, llm: true },
        vectorReady: false, hasCandidateTags: true, hasApiConfig: true
    });
    assert.strictEqual(p.vector, false);
    assert.strictEqual(p.skip.vector, '模型未就绪');
});

test('resolveFunnelPlan：②模型就绪但候选池为空 → vector=false 且给出原因', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: true, vector: true, llm: true },
        vectorReady: true, hasCandidateTags: false, hasApiConfig: true
    });
    assert.strictEqual(p.vector, false);
    assert.strictEqual(p.skip.vector, '候选标签池为空');
});

test('resolveFunnelPlan：③开关开但未配置 API → llm=false 且给出原因', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: true, vector: false, llm: true },
        vectorReady: true, hasCandidateTags: true, hasApiConfig: false
    });
    assert.strictEqual(p.llm, false);
    assert.strictEqual(p.skip.llm, '未配置 API');
});

test('resolveFunnelPlan：用户本就没开的层不出现在 skip（避免误导性原因）', () => {
    const p = resolveFunnelPlan({
        funnel: { rule: true, vector: false, llm: false },
        vectorReady: false, hasCandidateTags: false, hasApiConfig: false
    });
    assert.strictEqual(p.skip.vector, undefined);
    assert.strictEqual(p.skip.llm, undefined);
});

test('resolveFunnelPlan：空参数安全（回落默认，不抛错）', () => {
    const p = resolveFunnelPlan();
    assert.strictEqual(p.rule, true);
    assert.strictEqual(p.llm, false);          // 默认开但 hasApiConfig=false → 未执行
    assert.strictEqual(p.skip.llm, '未配置 API');
});

test('formatFunnelSummary：三层全跑 → 不含「已跳过」', () => {
    const msg = formatFunnelSummary({ rule: 12, vector: 5, llm: 3 }, { rule: true, vector: true, llm: true, skip: {} });
    assert.match(msg, /① 规则命中: 12/);
    assert.match(msg, /② 向量命中: 5/);
    assert.match(msg, /③ LLM: 3/);
    assert.ok(!msg.includes('已跳过'));
    assert.ok(!msg.includes('未处理'));
});

test('formatFunnelSummary：关① → 文案列出跳过的层', () => {
    const msg = formatFunnelSummary({ rule: 0, vector: 4, llm: 2 }, { rule: false, vector: true, llm: true, skip: {} });
    assert.ok(msg.includes('已跳过'));
    assert.ok(msg.includes('① 规则层'));
});

test('formatFunnelSummary：②未就绪 → 文案带上具体原因', () => {
    const msg = formatFunnelSummary({ rule: 3, vector: 0, llm: 1 },
        { rule: true, vector: false, llm: true, skip: { vector: '模型未就绪' } });
    assert.ok(msg.includes('② 向量层（模型未就绪）'));
});

test('formatFunnelSummary：关③且有剩余 → 含「未处理 N 张」', () => {
    const msg = formatFunnelSummary({ rule: 3, vector: 0, llm: 0, unprocessed: 7 },
        { rule: true, vector: false, llm: false, skip: {} });
    assert.ok(msg.includes('未处理: 7 张'));
});

test('formatFunnelSummary：空 stats / 空 plan 不崩，计数显示 0', () => {
    const msg = formatFunnelSummary(undefined, undefined);
    assert.match(msg, /① 规则命中: 0/);
});

test('formatFunnelBadge：生成状态短标签', () => {
    assert.strictEqual(formatFunnelBadge({ rule: true, vector: false, llm: true }), '规则✓ 向量✗ AI✓');
    assert.strictEqual(formatFunnelBadge({ rule: false, vector: true, llm: false }), '规则✗ 向量✓ AI✗');
    assert.strictEqual(formatFunnelBadge(undefined), '规则✓ 向量✗ AI✓');
});
