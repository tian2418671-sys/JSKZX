/**
 * 🗂️ S4（2026-09-25）世界书自动分组 —— 判定层纯函数单测
 * 覆盖：档案归一化 / 计划构建（首个命中者胜、已分组保护、已在目标跳过）/ 回滚解析 / LLM 消息与解析
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    WB_GROUP_MATCH_TYPES,
    WB_GROUP_ROOT_GROUP,
    createWbProfileId,
    normalizeWbGroupProfiles,
    buildWbAutoGroupPlan,
    resolveRollbackWb,
    buildWbLlmSpecs,
    wbLlmSpecsSignature,
    buildWbLlmMessages,
    parseWbLlmJudgement
} from '../js/utils/wbAutoGroup.js';

const P = (over = {}) => ({
    id: 'p1', group: '修仙', enabled: true,
    match: { type: 'name-keyword', pattern: '修仙|仙侠' },
    note: '', llmCriteria: '', ...over
});

describe('normalizeWbGroupProfiles — 归一化（落盘前收敛脏值）', () => {
    test('非数组 → []；非法项被过滤', () => {
        assert.deepEqual(normalizeWbGroupProfiles(null), []);
        assert.deepEqual(normalizeWbGroupProfiles('x'), []);
        assert.deepEqual(normalizeWbGroupProfiles([null, 1, { group: '' }]), []);
    });
    test('缺 pattern → 丢弃（永不命中的垃圾档案）', () => {
        const out = normalizeWbGroupProfiles([{ group: 'A', match: { type: 'name-keyword' } }]);
        assert.equal(out.length, 0);
    });
    test('非法条件类型回落 name-keyword；合法类型保留', () => {
        const out = normalizeWbGroupProfiles([
            { group: 'A', match: { type: 'weird', pattern: 'x' } },
            { group: 'B', match: { type: 'name-regex', pattern: '^b' } }
        ]);
        assert.equal(out[0].match.type, 'name-keyword');
        assert.equal(out[1].match.type, 'name-regex');
        for (const t of WB_GROUP_MATCH_TYPES) assert.ok(typeof t === 'string');
    });
    test('去重（同组+类型+pattern 小写）只保留第一条', () => {
        const out = normalizeWbGroupProfiles([
            { group: 'A', match: { type: 'name-keyword', pattern: 'Xy' } },
            { group: 'A', match: { type: 'name-keyword', pattern: 'xy' } }
        ]);
        assert.equal(out.length, 1);
    });
    test('llmCriteria 字符串收敛（空 → 空串）；enabled 缺省 true', () => {
        const out = normalizeWbGroupProfiles([{ group: 'A', match: { type: 'name-keyword', pattern: 'a' } }]);
        assert.equal(out[0].enabled, true);
        assert.equal(out[0].llmCriteria, '');
        const out2 = normalizeWbGroupProfiles([{ group: 'A', match: { type: 'name-keyword', pattern: 'a' }, llmCriteria: ' 修真  ' }]);
        assert.equal(out2[0].llmCriteria, '修真');
    });
    test('createWbProfileId：前缀 wgp_ 且唯一', () => {
        const a = createWbProfileId();
        const b = createWbProfileId();
        assert.ok(a.startsWith('wgp_'));
        assert.notEqual(a, b);
    });
});

describe('buildWbAutoGroupPlan — 判定计划', () => {
    const books = [
        { key: '/lib/a.json', name: '仙侠奇谭', group: WB_GROUP_ROOT_GROUP, keys: ['修仙体系', '宗门'], ref: {} },
        { key: '/lib/b.json', name: '赛博都市', group: WB_GROUP_ROOT_GROUP, keys: ['义体', '黑客'], ref: {} },
        { key: '/lib/c.json', name: '已有分组', group: '旧组', keys: [], ref: {} }
    ];
    test('关键词命中书名或词条名 → 生成移动项', () => {
        const plan = buildWbAutoGroupPlan({ books, profiles: [P()] });
        assert.equal(plan.moves.length, 1);
        assert.equal(plan.moves[0].bookKey, '/lib/a.json');
        assert.equal(plan.moves[0].toGroup, '修仙');
    });
    test('默认只处理「默认」组；已分组书进跳过项（不覆盖手动分组）', () => {
        const plan = buildWbAutoGroupPlan({ books, profiles: [P()] });
        assert.ok(plan.skipped.some(s => s.bookKey === '/lib/c.json'));
    });
    test('includeGrouped=true → 已分组书也参与判定', () => {
        const profiles = [P({ group: '新组', match: { type: 'name-keyword', pattern: '已有' } })];
        const plan = buildWbAutoGroupPlan({ books, profiles, options: { includeGrouped: true } });
        assert.ok(plan.moves.some(m => m.bookKey === '/lib/c.json' && m.toGroup === '新组'));
    });
    test('首个命中者胜（档案顺序 = 优先级）', () => {
        const profiles = [
            P({ id: 'p1', group: '第一', match: { type: 'name-keyword', pattern: '仙侠' } }),
            P({ id: 'p2', group: '第二', match: { type: 'name-keyword', pattern: '仙侠' } })
        ];
        const plan = buildWbAutoGroupPlan({ books, profiles });
        assert.equal(plan.moves[0].toGroup, '第一');
    });
    test('正则命中；非法正则不拖垮整表', () => {
        const profiles = [
            P({ id: 'bad', group: '坏', match: { type: 'name-regex', pattern: '([' } }),
            P({ id: 'good', group: '好', match: { type: 'name-regex', pattern: '^仙' } })
        ];
        const plan = buildWbAutoGroupPlan({ books, profiles });
        assert.equal(plan.moves.length, 1);
        assert.equal(plan.moves[0].toGroup, '好');
    });
    test('已在目标组 → 跳过（不算移动）', () => {
        const b2 = [{ key: '/lib/a.json', name: '仙侠录', group: '修仙', keys: [], ref: {} }];
        const plan = buildWbAutoGroupPlan({ books: b2, profiles: [P()], options: { includeGrouped: true } });
        assert.equal(plan.moves.length, 0);
        assert.ok(plan.skipped.some(s => String(s.reason).includes('已在')));
    });
    test('目标分组汇总：新建标记 + 计数 + 中文排序', () => {
        const b2 = [
            { key: '1', name: 'x', group: WB_GROUP_ROOT_GROUP, keys: ['修仙'], ref: {} },
            { key: '2', name: 'y', group: WB_GROUP_ROOT_GROUP, keys: ['仙侠'], ref: {} }
        ];
        const plan = buildWbAutoGroupPlan({ books: b2, profiles: [P()] });
        assert.equal(plan.targetGroups.length, 1);
        assert.equal(plan.targetGroups[0].count, 2);
        assert.equal(plan.targetGroups[0].isNew, true);
        assert.equal(plan.counters.willMove, 2);
    });
    test('无启用档案 → enabledProfiles=0 且无移动', () => {
        const plan = buildWbAutoGroupPlan({ books, profiles: [P({ enabled: false })] });
        assert.equal(plan.counters.enabledProfiles, 0);
        assert.equal(plan.moves.length, 0);
    });
});

describe('resolveRollbackWb — 回滚按书名定位', () => {
    const books = [
        { name: 'a.json', wbName: '甲书' },
        { name: 'b.json', wbName: '乙书' },
        { name: 'c.json', wbName: '乙书' }
    ];
    test('唯一命中 → ok', () => {
        const r = resolveRollbackWb(books, { bookName: '甲书', toGroup: 'X' });
        assert.equal(r.status, 'ok');
        assert.equal(r.book.name, 'a.json');
    });
    test('同名多本 → ambiguous', () => {
        const r = resolveRollbackWb(books, { bookName: '乙书' });
        assert.equal(r.status, 'ambiguous');
    });
    test('不存在 → missing', () => {
        assert.equal(resolveRollbackWb(books, { bookName: '丙' }).status, 'missing');
        assert.equal(resolveRollbackWb(books, {}).status, 'missing');
    });
});

describe('LLM 判定层 — 消息与解析', () => {
    test('buildWbLlmSpecs：只取 启用 + 有判定标准', () => {
        const specs = buildWbLlmSpecs([
            P({ group: 'A', llmCriteria: '标准A' }),
            P({ id: 'p2', group: 'B', llmCriteria: '' }),
            P({ id: 'p3', group: 'C', llmCriteria: '标准C', enabled: false })
        ]);
        assert.deepEqual(specs.map(s => s.group), ['A']);
    });
    test('签名稳定（顺序无关）', () => {
        const s1 = wbLlmSpecsSignature([{ group: 'A', criteria: '1' }, { group: 'B', criteria: '2' }]);
        const s2 = wbLlmSpecsSignature([{ group: 'B', criteria: '2' }, { group: 'A', criteria: '1' }]);
        assert.equal(s1, s2);
    });
    test('buildWbLlmMessages：包含标准与书材料', () => {
        const { system, user } = buildWbLlmMessages({
            specs: [{ group: '修仙', criteria: '以修仙为核心' }],
            books: [{ bookName: '仙境', keys: ['灵根', '宗门'], entryCount: 2 }]
        });
        assert.ok(system.includes('JSON'));
        assert.ok(user.includes('修仙') && user.includes('仙境') && user.includes('灵根'));
    });
    test('parseWbLlmJudgement：正常解析 + 非法分组/null 忽略 + 编造书名过滤', () => {
        const text = '分析如下：{"仙境": "修仙", "假书": "修仙", "乙书": null, "丙书": "不存在组"}';
        const r = parseWbLlmJudgement(text, {
            validGroups: ['修仙'],
            bookNames: ['仙境', '乙书', '丙书']
        });
        assert.deepEqual(r.assignments, [{ bookName: '仙境', group: '修仙', confidence: 0.8, reason: 'AI 判定' }]);
        assert.ok(r.unmatched.includes('乙书'));
        assert.ok(r.invalidGroups.includes('不存在组'));
    });
    test('parseWbLlmJudgement：非 JSON → parseError（不抛错）', () => {
        const r = parseWbLlmJudgement('没有 JSON 的回复', { validGroups: [], bookNames: [] });
        assert.ok(r.parseError);
        assert.equal(r.assignments.length, 0);
    });
});
