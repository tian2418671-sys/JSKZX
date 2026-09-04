/**
 * 🏷️ 标签大分类体系单元测试（防回归，v2.1.4 十八分类版）
 * 覆盖：默认标签映射 / 中文标签 / 斜杠复合词首段优先 / 未知标签归「其他」/ 分组结构 / 大小写
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTagCategory, groupTagsByCategory, TAG_CATEGORIES, setCustomTagState, buildTagClassificationSystemPrompt, buildTagClassificationUserPrompt, resolveTagCategoryTarget } from '../js/utils/tagCategories.js';

test('默认标签池映射正确（英文+中文注释格式）', () => {
    const cases = [
        ['Male (男性)', 'character'],
        ['Female (女性)', 'character'],
        ['Human (人类)', 'species'],
        ['Elf (精灵)', 'species'],
        ['Vampire (吸血鬼)', 'species'],
        ['Furry (兽人/福瑞)', 'species'],
        ['Fantasy (奇幻/魔法)', 'worldview'],
        ['Sci-Fi (科幻)', 'worldview'],
        ['RPG (文字游戏/跑团)', 'cardtype'],
        ['School (校园)', 'setting'],
        ['Isekai (异世界/穿越)', 'worldview'],
        ['Yandere (病娇)', 'personality'],
        ['Tsundere (傲娇)', 'personality'],
        ['Maid/Butler (女仆/执事)', 'occupation'],
        ['Royalty (皇室/贵族)', 'occupation'],
        ['Narrator (旁白驱动)', 'cardtype'],
        ['Assistant (AI助手/工具卡)', 'cardtype'],
        ['Master/Slave (主仆)', 'relation'],
        ['Step-family (继亲)', 'relation'],
        ['Childhood Friend (青梅竹马)', 'relation'],
        ['MILF/Oyakodon (熟女/太太)', 'relation'],
        ['NSFW (成人/敏感)', 'rating'],
        ['SFW (全年龄/安全)', 'rating'],
        ['Wholesome (纯爱/温馨)', 'mood'],
        ['Dark (暗黑/虐心)', 'mood'],
        ['Romance (恋爱)', 'mood'],
        ['Smut (搞颜色)', 'rating'],
        ['Action (战斗/动作)', 'plot'],
        ['Modern (现代都市)', 'era'],
        ['Historical (历史/古代)', 'era'],
        ['Post-Apocalyptic (末世/废土)', 'era'],
        ['Scenario (特定情景剧)', 'cardtype']
    ];
    for (const [tag, expected] of cases) {
        assert.equal(getTagCategory(tag), expected, `标签「${tag}」应归 ${expected}`);
    }
});

test('中文标签映射正确', () => {
    const cases = [
        ['魔法', 'power'],
        ['恋爱', 'mood'],
        ['巨乳', 'appearance'],
        ['金发', 'appearance'],
        ['捆绑', 'sexual'],
        ['口交', 'sexual'],
        ['姐姐', 'relation'],
        ['妹妹', 'relation'],
        ['病娇', 'personality'],
        ['医生', 'occupation'],
        ['老师', 'occupation'],
        ['温柔', 'personality'],
        ['古代', 'era'],
        ['校园', 'setting'],
        ['文风', 'style'],
        ['沙盒', 'gameplay'],
        ['NSFW', 'rating'],
        ['精灵', 'species']
    ];
    for (const [tag, expected] of cases) {
        assert.equal(getTagCategory(tag), expected, `标签「${tag}」应归 ${expected}`);
    }
});

test('斜杠复合词按首段优先分类', () => {
    const cases = [
        ['主仆/女仆', 'relation'],       // 首段「主仆」= 人物关系
        ['老师/师生', 'occupation'],     // 首段「老师」= 身份职业
        ['游戏/异世界', 'worldview'],    // 首段「游戏」= 题材世界观
        ['魔法/骑士', 'power'],          // 首段「魔法」= 力量体系
        ['纯爱/温馨', 'mood'],           // 首段「纯爱」= 情感基调
        ['校园/学园', 'setting'],        // 首段「校园」= 情境场所
        ['病娇/黑化', 'personality'],    // 首段「病娇」= 性格特质
        ['古代/宫廷', 'era'],            // 首段「古代」= 时代背景
        ['机器人/仿生人', 'species'],    // 首段「机器人」= 种族物种
        ['克苏鲁/恐怖', 'worldview']     // 首段「克苏鲁」= 题材世界观
    ];
    for (const [tag, expected] of cases) {
        assert.equal(getTagCategory(tag), expected, `标签「${tag}」应归 ${expected}`);
    }
});

test('未知/自定义标签归「其他」', () => {
    assert.equal(getTagCategory('zzz乱码标签'), 'other');
    assert.equal(getTagCategory(''), 'other');
    assert.equal(getTagCategory(null), 'other');
    assert.equal(getTagCategory('AI'), 'cardtype'); // 精确匹配特例
});

test('分组结果：空分类剔除、顺序稳定、标签不丢', () => {
    const tags = ['魔法', '姐姐', '巨乳', '自定义XYZ', '病娇'];
    const groups = groupTagsByCategory(tags);
    // 每个标签恰好出现一次
    const flat = groups.flatMap(g => g.tags);
    assert.equal(flat.length, tags.length);
    for (const t of tags) assert.ok(flat.includes(t), `标签 ${t} 应在分组中`);
    // 分组顺序与 TAG_CATEGORIES 定义一致
    const keys = groups.map(g => g.key);
    const defOrder = TAG_CATEGORIES.filter(c => keys.includes(c.key)).map(c => c.key);
    assert.deepEqual(keys, defOrder, '分组顺序应与 TAG_CATEGORIES 定义一致');
    // 索引 0 的「人物关系」不能因 falsy 0 掉进其他（回归：groups[idx.get(key)||8] bug）
    const relation = groups.find(g => g.key === 'relation');
    assert.ok(relation && relation.tags.includes('姐姐'), 'relation 分类应包含「姐姐」');
});

test('大小写不敏感 + 大小写混合标签', () => {
    assert.equal(getTagCategory('YANDERE (病娇)'), 'personality');
    assert.equal(getTagCategory('fantasy'), 'worldview');
    assert.equal(getTagCategory('NSFW'), 'rating');
});

test('大分类数量不少于 17 个（含其他）', () => {
    assert.ok(TAG_CATEGORIES.length >= 17, `当前 ${TAG_CATEGORIES.length} 个分类，应至少 17 个`);
    const keys = new Set(TAG_CATEGORIES.map(c => c.key));
    for (const k of ['relation', 'occupation', 'personality', 'character', 'appearance', 'setting',
        'era', 'power', 'worldview', 'species', 'mood', 'plot', 'rating', 'sexual', 'gameplay',
        'cardtype', 'style', 'other']) {
        assert.ok(keys.has(k), `缺少分类 ${k}`);
    }
});

test('自定义大分类装载 + 分组顺序（内置→自定义→其他）', () => {
    setCustomTagState([], {}); // 先重置
    setCustomTagState(
        [{ key: 'c1', name: '游戏作品', icon: '🎮' }, { key: 'c2', name: '番剧', icon: '📺' }],
        { '原神': 'c1', 'Fate': 'c2' }
    );
    const tags = ['魔法', '原神', 'Fate', '未知垃圾XYZ', '巨乳'];
    const groups = groupTagsByCategory(tags);
    const flat = groups.flatMap(g => g.tags);
    assert.equal(flat.length, tags.length);
    const keys = groups.map(g => g.key);
    // 自定义分类应出现在内置(other 之前)之后、other 之前
    assert.ok(keys.indexOf('c1') > keys.indexOf('power'), '自定义分类应在对应内置分类之后');
    assert.ok(keys.indexOf('c1') < keys.indexOf('other'), '自定义分类应在 other 之前');
    const g1 = groups.find(g => g.key === 'c1');
    assert.ok(g1 && g1.tags.includes('原神'), '「原神」应被手动归属映射进 c1');
    const other = groups.find(g => g.key === 'other');
    assert.ok(other && other.tags.includes('未知垃圾XYZ'), '未知垃圾标签应保留在 other');
    // 清理，避免影响后续（同文件内顺序执行）
    setCustomTagState([], {});
});

test('手动归属优先于所有自动分类，解除后回归自动', () => {
    setCustomTagState([], {});
    setCustomTagState([{ key: 'c1', name: '测试分类', icon: '🏷️' }], { '魔法': 'c1', 'nsfw': 'c1' });
    assert.equal(getTagCategory('魔法'), 'c1', '手动归属应覆盖 power 自动分类');
    assert.equal(getTagCategory('NSFW'), 'c1', '英文标签归属大小写不敏感');
    // 解除归属（清空映射）
    setCustomTagState([{ key: 'c1', name: '测试分类', icon: '🏷️' }], {});
    assert.equal(getTagCategory('魔法'), 'power', '解除归属后应回归 power');
    setCustomTagState([], {});
});

test('非法/已删分类 key 的归属不崩、分组兜底到 other', () => {
    setCustomTagState([], {});
    // 防御性兜底：即使残留「已删分类」的归属 key（正常流程 removeCustomTagCategory 会同步清理），
    // getTagCategory/groupTagsByCategory 也不抛错，分组里该标签落 other 而非消失。
    setCustomTagState([{ key: 'ok', name: '保留分类', icon: '🏷️' }], { '原神': 'gone', '魔法': 'ok' });
    const groups = groupTagsByCategory(['原神', '魔法']);
    const flat = groups.flatMap(g => g.tags);
    assert.equal(flat.length, 2, '非法归属也不能让标签丢失');
    const other = groups.find(g => g.key === 'other');
    assert.ok(other && other.tags.includes('原神'), '归属到已删分类的标签应兜底落 other');
    const ok = groups.find(g => g.key === 'ok');
    assert.ok(ok && ok.tags.includes('魔法'), '合法自定义归属应进对应分类');
    setCustomTagState([], {});
});

test('AI 分类提示词包含内置分类语义与自定义分类、输出纪律', () => {
    setCustomTagState([], {});
    const sys = buildTagClassificationSystemPrompt([{ key: 'c1', name: '游戏作品', icon: '🎮' }]);
    assert.ok(sys.includes('personality'), '提示词应含内置分类 key');
    assert.ok(sys.includes('性格特质'), '提示词应含内置分类名');
    assert.ok(sys.includes('游戏作品'), '提示词应含自定义分类名');
    assert.ok(sys.includes('other'), '提示词应含 other 兜底');
    assert.ok(sys.includes('JSON'), '提示词应要求输出 JSON');
    assert.ok(sys.includes('自拟'), '提示词应允许 AI 自拟新分类名（未命中现有分组时自动建类承接）');
    const user = buildTagClassificationUserPrompt(['魔法', '原神']);
    assert.ok(user.includes('魔法') && user.includes('0. '), 'user 提示词应含编号标签');
});

// ---------- 🆕 AI 归类新分类名归一（v2.2.1 增强：未命中自动建类） ----------

const CUSTOM_FIXTURE = [{ key: 'c1', name: '游戏作品', icon: '🎮' }];

test('resolve：other / 空值 / undefined 一律回 other 不新建', () => {
    assert.deepEqual(resolveTagCategoryTarget('other', CUSTOM_FIXTURE), { key: 'other', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget(undefined, CUSTOM_FIXTURE), { key: 'other', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('', CUSTOM_FIXTURE), { key: 'other', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('   ', CUSTOM_FIXTURE), { key: 'other', isNew: false });
});

test('resolve：命中现有内置分类（key 或中文名）不新建', () => {
    assert.deepEqual(resolveTagCategoryTarget('worldview', CUSTOM_FIXTURE), { key: 'worldview', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('题材世界观', CUSTOM_FIXTURE), { key: 'worldview', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('性玩法', CUSTOM_FIXTURE), { key: 'sexual', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('WORLDVIEW', CUSTOM_FIXTURE), { key: 'worldview', isNew: false }, '大小写不敏感');
});

test('resolve：命中自定义分类（key 或 name）不新建', () => {
    assert.deepEqual(resolveTagCategoryTarget('c1', CUSTOM_FIXTURE), { key: 'c1', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('游戏作品', CUSTOM_FIXTURE), { key: 'c1', isNew: false });
});

test('resolve：现有分组都没命中 → 合理新名标记 isNew 待自动新建', () => {
    assert.deepEqual(resolveTagCategoryTarget('哥特', CUSTOM_FIXTURE), { key: '哥特', isNew: true });
    assert.deepEqual(resolveTagCategoryTarget('蒸汽朋克', CUSTOM_FIXTURE), { key: '蒸汽朋克', isNew: true });
});

test('resolve：超长 / 纯符号数字等异常值回 other，不建垃圾分类', () => {
    assert.deepEqual(resolveTagCategoryTarget('这是一个超级无敌长的分类名超过了十二个字长度限制', CUSTOM_FIXTURE), { key: 'other', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('12345', CUSTOM_FIXTURE), { key: 'other', isNew: false });
    assert.deepEqual(resolveTagCategoryTarget('###!!!', CUSTOM_FIXTURE), { key: 'other', isNew: false });
});
