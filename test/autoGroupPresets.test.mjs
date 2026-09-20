/**
 * autoGroupPresets 单元测试（内置「推荐规则模板」）
 *
 * 关注三件事：
 *   1. 模板表**永远可编译**（逐条正则 new RegExp 必须成功，组名唯一、类型合法）
 *   2. 模板表能 100% 通过 `normalizeGroupProfiles` 归一化（否则载入 UI 会静默丢条目）
 *   3. `buildPresetProfiles` 的安全语义：只绑定已存在分组；无分组 → 不载入；
 *      返回对象是副本（改返回值不得污染模块级模板）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { AUTO_GROUP_PROFILE_PRESETS, buildPresetProfiles } from '../js/utils/autoGroupPresets.js';
import { AUTO_GROUP_MATCH_TYPES, normalizeGroupProfiles } from '../js/utils/autoGroup.js';

test('模板表：组名非空且唯一；类型合法；正则可编译（大小写不敏感）', () => {
    assert.ok(AUTO_GROUP_PROFILE_PRESETS.length >= 20, '模板数量应覆盖真实库主要分组');
    const groups = new Set();
    for (const p of AUTO_GROUP_PROFILE_PRESETS) {
        assert.ok(typeof p.group === 'string' && p.group.trim(), `组名无效: ${JSON.stringify(p)}`);
        assert.ok(!groups.has(p.group), `组名重复: ${p.group}`);
        groups.add(p.group);
        assert.ok(AUTO_GROUP_MATCH_TYPES.includes(p.match.type), `类型非法: ${p.group} / ${p.match.type}`);
        assert.ok(typeof p.match.pattern === 'string' && p.match.pattern.trim(), `缺少 pattern: ${p.group}`);
        assert.doesNotThrow(() => new RegExp(p.match.pattern, 'i'), `正则编译失败: ${p.group} / ${p.match.pattern}`);
    }
});

test('模板表：全部能通过 normalizeGroupProfiles（不丢条目、pattern 原样保留）', () => {
    const raw = AUTO_GROUP_PROFILE_PRESETS.map(p => ({ group: p.group, match: { ...p.match } }));
    const out = normalizeGroupProfiles(raw);
    assert.strictEqual(out.length, AUTO_GROUP_PROFILE_PRESETS.length);
    for (let i = 0; i < out.length; i++) {
        assert.strictEqual(out[i].group, AUTO_GROUP_PROFILE_PRESETS[i].group);
        assert.strictEqual(out[i].match.pattern, AUTO_GROUP_PROFILE_PRESETS[i].match.pattern);
    }
});

test('buildPresetProfiles：只绑定已存在分组；无分组 → 空', () => {
    const out = buildPresetProfiles(['NTR', '催眠', '不存在的分组']);
    assert.deepStrictEqual(out.map(p => p.group), ['NTR', '催眠']);
    assert.strictEqual(buildPresetProfiles([]).length, 0);
    assert.strictEqual(buildPresetProfiles(undefined).length, 0);
    // 全角标点组名要能精确匹配（真实库 `百合，百破，扶她` 是单条分组名）
    const out2 = buildPresetProfiles(['百合，百破，扶她']);
    assert.deepStrictEqual(out2.map(p => p.group), ['百合，百破，扶她']);
});

test('buildPresetProfiles：返回独立副本（改返回值不污染模板）+ 注入 id 工厂', () => {
    let seq = 0;
    const out = buildPresetProfiles(['NTR'], () => `fixed_${++seq}`);
    assert.strictEqual(out[0].id, 'fixed_1');
    assert.strictEqual(out[0].enabled, true);
    out[0].match.pattern = 'TAMPERED';
    const again = buildPresetProfiles(['NTR'], () => 'x');
    assert.notStrictEqual(again[0].match.pattern, 'TAMPERED');
});

test('模板行为抽查：NTR / 催眠 / 英文卡 / 全角组名（按真实库命名习惯）', () => {
    const byGroup = (g) => new RegExp(AUTO_GROUP_PROFILE_PRESETS.find(p => p.group === g).match.pattern, 'i');

    // NTR：中文关键词与 #标签 命名都能命中；不误伤普通英文单词（contrast）
    assert.ok(byGroup('NTR').test('被NTR的学姐'));
    assert.ok(byGroup('NTR').test('大华淫堕#媚黑'));
    assert.ok(byGroup('NTR').test('～清纯又温顺的妻子被寝取时会兴奋～'));
    assert.ok(!byGroup('NTR').test('contrast'));
    // NTRS，NTL：缩写与「ntr故事」命名
    assert.ok(byGroup('NTRS，NTL').test('ntrs故事集，一个专门给你讲ntrs故事的女朋友'));
    // 催眠
    assert.ok(byGroup('催眠').test('校园催眠奴隶'));
    // 英文卡：全 ASCII 命中；含中文不命中
    assert.ok(byGroup('英文卡').test('Sister Anna 2.0'));
    assert.ok(!byGroup('英文卡').test('芙宁娜 v2'));
    // 人外：常见种族/魔物娘命名
    assert.ok(byGroup('人外').test('【猫妖】抢你野怪和人头的夜苓'));
    assert.ok(byGroup('人外').test('半人马娘'));
});
