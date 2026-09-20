/**
 * 🗂️ 自动分组：内置「推荐规则模板」（按真实库分组命名整理）
 * ═════════════════════════════════════════════════════════════════
 * 由来：2026-09-20 实测采集真实角色卡库的**分组文件夹命名**（53 个分组样本）进行整理：
 *   · 分组名 = 磁盘上的一层中文文件夹名（`NTR`、`催眠`、`人外`、`百合，百破，扶她`…）
 *   · 卡名命名习惯 = 「关键词堆叠」（`被NTR的学姐…`）、**#标签式**（`…#媚黑.png`）、
 *     或长句标题 —— 因此模板以 **name-regex（名称正则）** 为主，用关键词或 `#标签` 捕获。
 *   ⚠️ 采集来源的完整记录（含样本库路径）只写在内部文档：`docs/规格与计划/卡片自动分组-实现规格.md`；
 *     本文件与 UI 文案**一律不出现本机路径**（会自动进入构建产物）。
 *
 * ⚠️ 使用约定（与方案 v2.0 一致）：
 *   1. **只是模板**：不自动启用、不落盘；用户在「收纳规则」页一键载入后**逐条检查再保存**。
 *   2. **只绑定已存在的分组**：`buildPresetProfiles(existingGroups)` 会过滤掉当前库没有的分组，
 *      避免凭空造文件夹（这是方案 §3.3 的模型保证）。
 *   3. 分组顺序 = 侧边栏顺序 = 优先级：模板之间关键词**刻意允许重叠**（如 NTR 与 调教），
 *      最终归属由用户在侧边栏调整顺序决定（预览里会显示冲突明细）。
 *   4. 正则统一大小写不敏感（`compileProfile` 用 'i'），ASCII 关键词一律小写书写。
 *
 * 维护提示：改动本表后必须跑 `test/autoGroupPresets.test.mjs`（逐条正则必须可编译 + 组名唯一）。
 */

import { createProfileId } from './autoGroup.js';

/** 采集来源说明（UI 展示用） */
export const AUTO_GROUP_PRESET_SOURCE = '常见角色卡库命名习惯整理（2026-09 采集）';

/**
 * 推荐模板（分组名必须与真实库文件夹**逐字一致**，含全角标点）
 * @type {Array<{group: string, match: {type: string, pattern: string}, note: string}>}
 */
export const AUTO_GROUP_PROFILE_PRESETS = [
    { group: 'NTR', match: { type: 'name-regex', pattern: String.raw`\bntrs?\b|\bntl\b|寝取|牛头人|绿帽|媚黑` }, note: 'NTR / 寝取 / 绿帽 / #媚黑 等命名' },
    { group: 'NTRS，NTL', match: { type: 'name-regex', pattern: String.raw`\bntrs\b|\bntl\b|ntr故事` }, note: 'NTRS / NTL 子分类（与 NTR 重叠时按侧边栏顺序取胜）' },
    { group: '纯爱', match: { type: 'name-regex', pattern: String.raw`纯爱|温馨|治愈|甜蜜|纯情` }, note: '纯爱 / 温馨治愈向命名' },
    { group: '催眠', match: { type: 'name-regex', pattern: String.raw`催眠|洗脑|常识改变|精神控制|认知|暗示` }, note: '催眠 / 洗脑 / 常识改变 等命名' },
    { group: '调教', match: { type: 'name-regex', pattern: String.raw`调教|驯|雌堕|母猪|肉便器|家畜|奴隶` }, note: '调教 / 雌堕 / 服从向命名' },
    { group: '人外', match: { type: 'name-regex', pattern: String.raw`人外|兽人|兽耳|兽娘|魔物娘|触手|史莱姆|精灵|妖精|龙娘|机娘|异形|哥布林|魅魔|猫娘|猫妖|狐娘|狐妖|蛇娘|蜘蛛娘|人鱼|半人马|拉米亚` }, note: '非人类种族 / 魔物娘 / 兽耳娘 等命名' },
    { group: '伪娘', match: { type: 'name-regex', pattern: String.raw`伪娘|男娘|女装` }, note: '伪娘 / 男娘 / 女装 等命名' },
    { group: '扶他', match: { type: 'name-regex', pattern: String.raw`扶他|扶她|\bfuta\b` }, note: '扶他 / 扶她 命名' },
    { group: '百合，百破，扶她', match: { type: 'name-regex', pattern: String.raw`百合|百破|女同|lesbian` }, note: '百合 / 百破 命名' },
    { group: '病娇', match: { type: 'name-regex', pattern: String.raw`病娇|黑化|占有欲|偏执|ヤンデレ` }, note: '病娇 / 黑化 / 占有欲 等命名' },
    { group: '后宫', match: { type: 'name-regex', pattern: String.raw`后宫|全员|多女|大后宫` }, note: '后宫 / 全员 等命名' },
    { group: '开大车', match: { type: 'name-regex', pattern: String.raw`开大车|大车|小马|正太` }, note: '开大车 / 正太 等命名' },
    { group: '乱伦', match: { type: 'name-regex', pattern: String.raw`乱伦|近亲|母女|母子|父女|兄妹|姐弟|岳母|继母|养母` }, note: '近亲关系题材命名' },
    { group: '校园', match: { type: 'name-regex', pattern: String.raw`校园|学园|学校|学院|学生|老师|教师|同学|班长|校花|学姐|学妹|学生会|社团|课堂|教室` }, note: '校园 / 师生 / JK 等命名' },
    { group: '修仙', match: { type: 'name-regex', pattern: String.raw`修仙|修真|仙侠|宗门|元婴|渡劫|剑仙|仙子|仙尊|合欢宗|道侣` }, note: '修仙 / 仙侠 / 宗门 等命名' },
    { group: '系统', match: { type: 'name-regex', pattern: String.raw`系统|金手指|面板|签到|抽奖|兑换|外挂|主神` }, note: '系统流 / 金手指 等命名' },
    { group: '超能力者', match: { type: 'name-regex', pattern: String.raw`超能力|异能|念力|超能|能力者` }, note: '异能 / 超能力 题材命名' },
    { group: 'RPG跑团', match: { type: 'name-regex', pattern: String.raw`\brpg\b|\btrpg\b|\bdnd\b|跑团|龙与地下城|桌游|冒险者|地下城` }, note: 'RPG / 跑团 / DND 等命名' },
    { group: '萝莉', match: { type: 'name-regex', pattern: String.raw`萝莉|\bloli\b|幼女|小萝莉` }, note: '萝莉 / 幼女 命名' },
    { group: '熟女', match: { type: 'name-regex', pattern: String.raw`熟女|人妻|太太|夫人|阿姨|岳母|妈妈|母亲|母性|寡妇|主妇` }, note: '熟女 / 人妻 / 母系 等命名' },
    { group: '御姐，人妻', match: { type: 'name-regex', pattern: String.raw`御姐|人妻|女上司|总裁` }, note: '御姐 / 人妻 专项命名' },
    { group: '男同', match: { type: 'name-regex', pattern: String.raw`男同|耽美|\bbl\b|\bgay\b` }, note: 'BL / 男同 命名' },
    { group: '重口注意！', match: { type: 'name-regex', pattern: String.raw`重口|猎奇|\br18g\b|断肢|血腥|食人` }, note: '重口 / 猎奇 / R18G 命名（载入后请自行收紧）' },
    { group: '假小子', match: { type: 'name-regex', pattern: String.raw`假小子|\btomboy\b` }, note: '假小子 / tomboy 命名' },
    { group: '古风', match: { type: 'name-regex', pattern: String.raw`古风|古代|武侠|江湖|宫廷|王朝|皇帝|皇后|公主|将军` }, note: '古风 / 古代 / 武侠 等命名' },
    { group: '女性向', match: { type: 'name-regex', pattern: String.raw`乙女|女性向|逆后宫` }, note: '乙女 / 女性向 命名' },
    { group: '英文卡', match: { type: 'name-regex', pattern: String.raw`^[\x20-\x7E]+$` }, note: '名称全为 ASCII（不含中文）的卡' }
];

/**
 * 按当前库已有分组过滤模板 → 可直接并入「收纳规则」的档案对象列表
 * @param {string[]} existingGroups 当前库已有分组名（预设中文名 + 自定义名）
 * @param {() => string} [idFactory] id 生成器（单测可注入固定值）
 * @returns {Array} 分组档案列表（形态与 autoGroupProfiles 一致；enabled 默认 true）
 */
export function buildPresetProfiles(existingGroups = [], idFactory = createProfileId) {
    const set = new Set(
        (Array.isArray(existingGroups) ? existingGroups : [])
            .map(g => String(g == null ? '' : g).trim())
            .filter(Boolean)
    );
    if (!set.size) return []; // 一个分组都没有 → 不载入任何模板（避免凭空造文件夹）
    const out = [];
    for (const p of AUTO_GROUP_PROFILE_PRESETS) {
        if (!set.has(p.group)) continue;
        out.push({
            id: idFactory(),
            group: p.group,
            enabled: true,
            match: { ...p.match },
            note: p.note || ''
        });
    }
    return out;
}
