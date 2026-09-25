/**
 * autoGroup 纯函数层单元测试（S1 自动分组判定层）
 * 设计文档：`docs/技术支持/世界书与卡片/方案-卡片自动分组.md`（v2.0 声明式分组档案）
 * 实现规格：`docs/规格与计划/功能规格/卡片自动分组-实现规格.md`
 *
 * 重点验证（方案 §六 验收 1 / 11 / 12 的机器化部分）：
 *   1. 判定顺序 = 分组顺序（侧边栏顺序即优先级），首个命中者胜，且冲突有明细
 *   2. 大小写口径：extractCardTags 全小写 + pattern 小写化 → 混排大小写仍能命中
 *   3. 安全默认：已手动分组的卡默认一张都不动；「已在目标分组」不重复移动
 *   4. 边界：布尔条件无 pattern、非法正则只跳过该条、库外卡片跳过、同组同名警告
 *   5. 回滚定位：按卡名 + 当前分组判定（missing / changed / ambiguous / already 全分支）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
    AUTO_GROUP_MATCH_TYPES,
    MATCH_TYPES_WITHOUT_PATTERN,
    sanitizeFolderName,
    currentGroupOf,
    normalizeGroupProfiles,
    normalizeAutoGroupLastRun,
    matchProfile,
    buildAutoGroupPlan,
    resolveRollbackCard
} from '../js/utils/autoGroup.js';

// ───────────────────────── 测试夹具 ─────────────────────────

/** 库根（未分类）卡片 */
function rootCard(name, extra = {}) {
    return {
        id: `c_${name}`,
        name,
        category: '未分类',
        subFolder: '',
        path: `E:/lib/${name}.png`,
        customTags: [],
        data: { name },
        ...extra
    };
}

/** 已在某分组里的卡片 */
function groupedCard(name, group, extra = {}) {
    return { ...rootCard(name, extra), category: group, subFolder: group, path: `E:/lib/${group}/${name}.png` };
}

const PROFILE_TAG = { id: 'p1', group: '纯爱', enabled: true, match: { type: 'tag', pattern: '纯爱' } };

// ───────────────────────── 常量与工具 ─────────────────────────

test('常量：5 种条件类型；布尔型条件（无 pattern）名单正确', () => {
    assert.deepStrictEqual(AUTO_GROUP_MATCH_TYPES, ['tag', 'name-keyword', 'name-regex', 'hasLorebook', 'hasRegex']);
    assert.deepStrictEqual(MATCH_TYPES_WITHOUT_PATTERN, ['hasLorebook', 'hasRegex']);
});

test('sanitizeFolderName：与主进程同规则（非法字符→_；CJK / 全角标点不受影响）', () => {
    assert.strictEqual(sanitizeFolderName('C++:基础'), 'C++_基础'); // : → _
    assert.strictEqual(sanitizeFolderName('a/b\\c'), 'a_b_c');     // / \ → _
    assert.strictEqual(sanitizeFolderName('  NTR  '), 'NTR');      // trim
    assert.strictEqual(sanitizeFolderName('重口注意！'), '重口注意！'); // 全角感叹号合法
    assert.strictEqual(sanitizeFolderName('御姐，人妻'), '御姐，人妻'); // 全角逗号合法
    assert.strictEqual(sanitizeFolderName('正常向(不分类)'), '正常向(不分类)');
    assert.strictEqual(sanitizeFolderName(null), '');
});

test('currentGroupOf：空 / 缺失一律归「未分类」', () => {
    assert.strictEqual(currentGroupOf({ category: '催眠' }), '催眠');
    assert.strictEqual(currentGroupOf({ category: '' }), '未分类');
    assert.strictEqual(currentGroupOf({}), '未分类');
    assert.strictEqual(currentGroupOf(null), '未分类');
});

// ───────────────────────── 档案归一化 ─────────────────────────

test('normalizeGroupProfiles：非数组 → []；逐条过滤非法项', () => {
    assert.deepStrictEqual(normalizeGroupProfiles(undefined), []);
    assert.deepStrictEqual(normalizeGroupProfiles('x'), []);
    assert.deepStrictEqual(normalizeGroupProfiles([null, 1, 'a', {}, { group: '  ' }]), []);
    // 非法 type 回落 tag；有参类型缺 pattern → 丢弃
    assert.deepStrictEqual(normalizeGroupProfiles([{ group: '催眠', match: { type: 'bad-type', pattern: '催眠' } }]).length, 1);
    assert.deepStrictEqual(normalizeGroupProfiles([{ group: '催眠', match: { type: 'tag' } }]), []);
    assert.deepStrictEqual(normalizeGroupProfiles([{ group: '催眠', match: { type: 'name-keyword', pattern: '   ' } }]), []);
});

test('normalizeGroupProfiles：布尔条件无 pattern 字段；enabled 默认 true；id 兜底', () => {
    const out = normalizeGroupProfiles([
        { group: '带世界书组', match: { type: 'hasLorebook', pattern: '多余参数应被丢弃' } },
        { id: 'keep_me', group: '纯爱', enabled: false, match: { type: 'tag', pattern: '纯爱' } }
    ]);
    assert.deepStrictEqual(out[0].match, { type: 'hasLorebook' }); // 布尔条件不带 pattern
    assert.strictEqual(out[0].enabled, true);
    assert.strictEqual(out[0].id, 'gp_restored_0');
    assert.strictEqual(out[1].enabled, false);
    assert.strictEqual(out[1].id, 'keep_me');
});

test('normalizeGroupProfiles：同「分组+类型+pattern(小写)」去重保序；不做每分组唯一性裁剪', () => {
    const out = normalizeGroupProfiles([
        { group: '纯爱', match: { type: 'tag', pattern: '纯爱' } },
        { group: '纯爱', match: { type: 'tag', pattern: '纯爱' } },
        { group: '纯爱', match: { type: 'tag', pattern: 'PURE' } },
        { group: '纯爱', match: { type: 'name-keyword', pattern: '爱' } } // 同分组第二条规则：保留（S5 语义）
    ]);
    assert.strictEqual(out.length, 3);
});

// ───────────────────────── 单条判定 ─────────────────────────

test('matchProfile：tag 精确匹配（大小写混排，pattern 小写化）', () => {
    const card = rootCard('某卡', { customTags: ['Genshin', '原神'] });
    assert.strictEqual(matchProfile(card, { group: '原神', match: { type: 'tag', pattern: 'genshin' } }).hit, true);
    assert.strictEqual(matchProfile(card, { group: '原神', match: { type: 'tag', pattern: '原神' } }).hit, true);
    assert.strictEqual(matchProfile(card, { group: '原神', match: { type: 'tag', pattern: '崩铁' } }).hit, false);
    // 原生 data.tags 也要被 extractCardTags 看到
    const c2 = rootCard('落', { data: { name: '落', tags: ['催眠'] } });
    assert.strictEqual(matchProfile(c2, { group: '催眠', match: { type: 'tag', pattern: '催眠' } }).hit, true);
});

test('matchProfile：ignoreNativeTags 开启时忽略原生 data.tags（跟随导入忽略开关）', () => {
    const c2 = rootCard('落', { data: { name: '落', tags: ['催眠'] } });
    assert.strictEqual(matchProfile(c2, { group: '催眠', match: { type: 'tag', pattern: '催眠' } }, { ignoreNativeTags: true }).hit, false);
    assert.strictEqual(matchProfile(c2, { group: '催眠', match: { type: 'tag', pattern: '催眠' } }, { ignoreNativeTags: false }).hit, true);
});

test('matchProfile：tag / name-keyword 多值 OR（`|` 拆分；任一命中即命中；单值行为不变）', () => {
    const card = rootCard('山村物语', { customTags: ['洗脑', '乡村'] });
    // tag 多值：命中任一
    assert.strictEqual(matchProfile(card, { group: '催眠', match: { type: 'tag', pattern: '催眠|洗脑' } }).hit, true);
    assert.strictEqual(matchProfile(card, { group: '催眠', match: { type: 'tag', pattern: '催眠|精神控制' } }).hit, false);
    // name-keyword 多值
    assert.strictEqual(matchProfile(card, { group: '乡村', match: { type: 'name-keyword', pattern: '山村|小镇' } }).hit, true);
    assert.strictEqual(matchProfile(card, { group: '乡村', match: { type: 'name-keyword', pattern: '都市|校园' } }).hit, false);
    // 空段 / 前后空白容错（chips 编辑器边界）
    assert.strictEqual(matchProfile(card, { group: '催眠', match: { type: 'tag', pattern: ' | 洗脑 | ' } }).hit, true);
    // name-regex 不受影响（`|` 仍为正则语法）
    assert.strictEqual(matchProfile(card, { group: '乡村', match: { type: 'name-regex', pattern: '山村|小镇' } }).hit, true);
});

test('matchProfile：name-keyword 忽略大小写；name-regex 非法只失效该条', () => {
    const card = rootCard('NTR庄园');
    assert.strictEqual(matchProfile(card, { group: 'NTR', match: { type: 'name-keyword', pattern: 'ntr' } }).hit, true);
    assert.strictEqual(matchProfile(card, { group: 'NTR', match: { type: 'name-regex', pattern: '^NTR.*园$' } }).hit, true);
    const bad = matchProfile(card, { group: 'NTR', match: { type: 'name-regex', pattern: '([未闭合' } });
    assert.strictEqual(bad.hit, false);
    assert.match(bad.reason, /正则无效/);
});

test('matchProfile：hasLorebook（字典 entries / 数组形态都认）；hasRegex（extensions.regex_scripts）', () => {
    const dictBook = rootCard('A', { data: { name: 'A', character_book: { entries: { '0': { content: 'x' } } } } });
    assert.strictEqual(matchProfile(dictBook, { group: 'G', match: { type: 'hasLorebook' } }).hit, true);
    const arrayBook = rootCard('B', { data: { name: 'B', character_book: [{ content: 'y' }] } });
    assert.strictEqual(matchProfile(arrayBook, { group: 'G', match: { type: 'hasLorebook' } }).hit, true);
    assert.strictEqual(matchProfile(rootCard('C'), { group: 'G', match: { type: 'hasLorebook' } }).hit, false);

    const withRegex = rootCard('D', { data: { name: 'D', extensions: { regex_scripts: [{}] } } });
    assert.strictEqual(matchProfile(withRegex, { group: 'G', match: { type: 'hasRegex' } }).hit, true);
    assert.strictEqual(matchProfile(rootCard('E'), { group: 'G', match: { type: 'hasRegex' } }).hit, false);
});

// ───────────────────────── 计划生成 ─────────────────────────

test('buildAutoGroupPlan：基础移动（未分类卡 + 标签命中）', () => {
    const cards = [rootCard('芙宁娜', { customTags: ['纯爱'] })];
    const plan = buildAutoGroupPlan({ cards, profiles: [PROFILE_TAG], options: { now: 1 } });
    assert.strictEqual(plan.moves.length, 1);
    assert.strictEqual(plan.moves[0].toGroup, '纯爱');
    assert.strictEqual(plan.moves[0].fromGroup, '未分类');
    assert.strictEqual(plan.moves[0].reason, '标签：纯爱');
    assert.strictEqual(plan.moves[0].card, cards[0]); // 活引用（执行层要用）
    assert.strictEqual(plan.counters.willMove, 1);
    assert.strictEqual(plan.generatedAt, 1);
});

test('buildAutoGroupPlan：未命中 → 跳过并给原因；已在目标分组 → 不重复移动', () => {
    const cards = [
        rootCard('路人甲'),
        groupedCard('已在纯爱', '纯爱', { customTags: ['纯爱'] })
    ];
    const plan = buildAutoGroupPlan({ cards, profiles: [PROFILE_TAG] });
    assert.strictEqual(plan.moves.length, 0);
    assert.strictEqual(plan.skipped.length, 2);
    const reasons = plan.skipped.map(s => s.reason).join('|');
    assert.match(reasons, /未命中任何启用中的收纳条件/);
    assert.match(reasons, /已在目标分组「纯爱」/);
});

test('buildAutoGroupPlan：安全默认——已手动分组的卡一张不动；勾选 includeGrouped 才动', () => {
    const cards = [groupedCard('在催眠里的纯爱卡', '催眠', { customTags: ['纯爱'] })];
    const planA = buildAutoGroupPlan({ cards, profiles: [PROFILE_TAG] });
    assert.strictEqual(planA.moves.length, 0);
    assert.match(planA.skipped[0].reason, /已手动分组「催眠」/);

    const planB = buildAutoGroupPlan({ cards, profiles: [PROFILE_TAG], options: { includeGrouped: true } });
    assert.strictEqual(planB.moves.length, 1);
    assert.strictEqual(planB.moves[0].fromGroup, '催眠');
    assert.strictEqual(planB.moves[0].toGroup, '纯爱');
});

test('buildAutoGroupPlan：冲突按「分组顺序」取胜（与配置数组顺序无关），并记录全部分组', () => {
    const cards = [rootCard('双标签卡', { customTags: ['纯爱', '催眠'] })];
    const profiles = [
        { id: 'p_hy', group: '催眠', match: { type: 'tag', pattern: '催眠' } },
        { id: 'p_ca', group: '纯爱', match: { type: 'tag', pattern: '纯爱' } }
    ];
    // 侧边栏顺序：纯爱在前 → 即使档案数组里催眠排先，也应进纯爱
    const plan = buildAutoGroupPlan({ cards, profiles, options: { groupOrder: ['纯爱', '催眠'] } });
    assert.strictEqual(plan.moves[0].toGroup, '纯爱');
    assert.strictEqual(plan.conflicts.length, 1);
    assert.strictEqual(plan.conflicts[0].winnerGroup, '纯爱');
    assert.deepStrictEqual(plan.conflicts[0].hits.map(h => h.group), ['纯爱', '催眠']);

    // 顺序反转 → 结果反转（顺序即优先级）
    const plan2 = buildAutoGroupPlan({ cards, profiles, options: { groupOrder: ['催眠', '纯爱'] } });
    assert.strictEqual(plan2.moves[0].toGroup, '催眠');
});

test('buildAutoGroupPlan：disabled 档案不参与；库外卡片跳过', () => {
    const cards = [
        rootCard('外部卡', { path: 'D:/other/外部卡.png', customTags: ['纯爱'] })
    ];
    const plan = buildAutoGroupPlan({
        cards, profiles: [PROFILE_TAG, { group: '催眠', enabled: false, match: { type: 'tag', pattern: '纯爱' } }],
        options: { libraryPath: 'E:/lib' }
    });
    assert.strictEqual(plan.moves.length, 0);
    assert.match(plan.skipped[0].reason, /不在库目录内/);
});

test('buildAutoGroupPlan：目标分组汇总（将新建 / 名称被净化提示 / 已有空文件夹不算新建）', () => {
    const cards = [
        rootCard('甲', { customTags: ['C++:基础'] }),
        groupedCard('乙', '旧组') // 用于贡献一个「已知分组」
    ];
    const profiles = [{ group: 'C++:基础', match: { type: 'tag', pattern: 'c++:基础' } }];
    const plan = buildAutoGroupPlan({
        cards, profiles,
        options: { knownGroups: ['旧组'], groupOrder: ['旧组', 'C++:基础'] }
    });
    assert.strictEqual(plan.targetGroups.length, 1);
    assert.strictEqual(plan.targetGroups[0].folder, 'C++_基础');
    assert.strictEqual(plan.targetGroups[0].renamed, true);
    assert.strictEqual(plan.targetGroups[0].isNew, true);
    assert.strictEqual(plan.counters.newFolders, 1);

    // 卡片里已有 subFolder === 目标组（磁盘上文件夹存在）→ 不算「将新建」
    const plan2 = buildAutoGroupPlan({
        cards: [rootCard('丙', { customTags: ['纯爱'] }), groupedCard('占位', '纯爱')],
        profiles: [PROFILE_TAG]
    });
    assert.strictEqual(plan2.targetGroups[0].isNew, false);
});

test('buildAutoGroupPlan：同组同名 → duplicateWarnings（预览要显式警告）', () => {
    const cards = [
        rootCard('同名A', { customTags: ['纯爱'] }),
        rootCard('同名B', { customTags: ['纯爱'], path: 'E:/lib/子目录/同名A.png' }) // 同 basename
    ];
    const plan = buildAutoGroupPlan({ cards, profiles: [PROFILE_TAG] });
    assert.strictEqual(plan.duplicateWarnings.length, 1);
    assert.strictEqual(plan.duplicateWarnings[0].targetGroup, '纯爱');
});

test('buildAutoGroupPlan：counter 统计口径 + 空档案表不误报', () => {
    const cards = [rootCard('甲', { customTags: ['纯爱'] }), rootCard('乙')];
    const plan = buildAutoGroupPlan({ cards, profiles: [] });
    assert.deepStrictEqual(plan.counters, { total: 2, willMove: 0, skipped: 2, conflicts: 0, newFolders: 0, enabledProfiles: 0 });
    assert.strictEqual(plan.moves.length, 0);
});

// ───────────────────────── 回滚定位 ─────────────────────────

test('resolveRollbackCard：ok / already / missing / changed / ambiguous 全分支', () => {
    const entry = { cardName: '芙宁娜', fromGroup: '未分类', toGroup: '纯爱' };

    // ok：唯一命中且仍在 toGroup
    assert.strictEqual(resolveRollbackCard([groupedCard('芙宁娜', '纯爱')], entry).status, 'ok');
    // already：已回到 fromGroup（算已还原）
    assert.strictEqual(resolveRollbackCard([rootCard('芙宁娜')], entry).status, 'already');
    // missing：找不到
    assert.strictEqual(resolveRollbackCard([rootCard('别人')], entry).status, 'missing');
    // changed：唯一命中但两个分组都不是
    const ch = resolveRollbackCard([groupedCard('芙宁娜', '催眠')], entry);
    assert.strictEqual(ch.status, 'changed');
    assert.strictEqual(ch.actualGroup, '催眠');
    // ambiguous：两张同名卡
    assert.strictEqual(resolveRollbackCard([rootCard('芙宁娜'), rootCard('芙宁娜')], entry).status, 'ambiguous');
    // ambiguous 但有唯一一张在 toGroup → 可消歧
    assert.strictEqual(resolveRollbackCard([rootCard('芙宁娜'), groupedCard('芙宁娜', '纯爱')], entry).status, 'ok');
});

// ───────────────────────── 日志归一化 ─────────────────────────

test('normalizeAutoGroupLastRun：垃圾入参 → null；条目清洗；保留回滚记录', () => {
    assert.strictEqual(normalizeAutoGroupLastRun(undefined), null);
    assert.strictEqual(normalizeAutoGroupLastRun('x'), null);
    assert.strictEqual(normalizeAutoGroupLastRun({ entries: [{ cardName: '', toGroup: 'x' }] }), null);

    const run = normalizeAutoGroupLastRun({
        at: 100,
        entries: [
            { cardName: 'A', fromGroup: '', toGroup: '纯爱', movedAt: 90 },
            { cardName: 'B', toGroup: '催眠' },
            { cardName: '', toGroup: 'X' }, // 无效 → 丢弃
            null
        ],
        lastRollback: { at: 200, rolled: 1, failed: [{ cardName: 'C', reason: '卡片已变动' }, null] }
    });
    assert.strictEqual(run.entries.length, 2);
    assert.strictEqual(run.entries[0].fromGroup, '未分类'); // 空 → 未分类
    assert.strictEqual(run.entries[1].movedAt, 100);        // 缺 movedAt → 顶层 at
    assert.strictEqual(run.lastRollback.rolled, 1);
    assert.deepStrictEqual(run.lastRollback.failed, [{ cardName: 'C', reason: '卡片已变动' }]);
});
