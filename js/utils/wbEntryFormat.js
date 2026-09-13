/**
 * 🌍 世界书词条**口径转换**（库/旧世界书格式 → 角色卡内嵌 V2 格式）
 *
 * 背景（见 docs/bugs/BUG-数据与文件.md 的 **DF-15**）：
 *   「📥 从世界书库导入词条到角色卡」此前**不做任何字段映射**，把库格式的
 *   `key` / `keysecondary` / `order` / `disable` 直接写进卡内嵌世界书 ——
 *   而酒馆读卡内嵌世界书按 V2 规范取 `keys` / `secondary_keys` / `insertion_order` / `enabled`
 *   ⇒ 导入进去的词条**触发词不生效**（本应用自己读时 `keys || key` 双向回退，所以看着正常，
 *   问题只在导出到酒馆后才暴露）。
 *   反方向的 `extractWorldbookFromCard`（`useWorldbookExtras.js`）是做了映射的，本函数补上逆向。
 *
 * 字段口径（以**真实卡**为准，取自 `星月私立高等学院 MVU 3.9.9.png` 的 46 条原生词条）：
 *   顶层：`id keys secondary_keys comment content constant selective insertion_order enabled position use_regex extensions`
 *         —— 其中 `position` 是**字符串** `before_char` / `after_char`
 *   `extensions`：ST 选项，多数 snake_case（`exclude_recursion` / `display_index` / `group_override` /
 *         `match_whole_words` / `scan_depth` …），但 `selectiveLogic` 与 `useProbability` **保持驼峰**，
 *         且 `extensions.position` 存**数字**（0=before_char，1=after_char，其余为 ST 的数值位置）。
 *
 * ⚠️ 设计取舍：**未知字段保守保留**（不做白名单式丢弃）——同 DF-14 的教训，
 *    第三方世界书可能带自己的字段，删掉就是数据丢失。
 */

/** 库/旧格式的选项字段 → 内嵌 `extensions` 的键名（命名对齐真实卡） */
const OPTION_KEY_MAP = {
    excludeRecursion: 'exclude_recursion',
    preventRecursion: 'prevent_recursion',
    delayUntilRecursion: 'delay_until_recursion',
    displayIndex: 'display_index',
    matchPersonaDescription: 'match_persona_description',
    matchCharacterDescription: 'match_character_description',
    matchCharacterPersonality: 'match_character_personality',
    matchCharacterDepthPrompt: 'match_character_depth_prompt',
    matchScenario: 'match_scenario',
    matchCreatorNotes: 'match_creator_notes',
    groupOverride: 'group_override',
    groupWeight: 'group_weight',
    scanDepth: 'scan_depth',
    caseSensitive: 'case_sensitive',
    matchWholeWords: 'match_whole_words',
    useGroupScoring: 'use_group_scoring',
    automationId: 'automation_id',
};

/** 移进 `extensions` 但**不改名**的选项字段（真实卡里就是这些名字） */
const OPTION_KEY_SAME = [
    'probability', 'useProbability', 'depth', 'selectiveLogic', 'group', 'role',
    'vectorized', 'sticky', 'cooldown', 'delay', 'triggers', 'addMemo',
];

/** 被本函数消费掉的库格式字段（转换后删除，避免两种口径并存） */
const CONSUMED_LIBRARY_KEYS = ['key', 'keysecondary', 'order', 'disable', 'useRegex'];

/** 数组归一：任意形态 → 干净数组（去空值） */
function toArray(v) {
    if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null && x !== '');
    if (v === undefined || v === null || v === '') return [];
    return [v];
}

/** 位置归一：数字或字符串 → { numeric, str } */
function normalizePosition(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        return { numeric: v, str: v === 0 ? 'before_char' : 'after_char' };
    }
    if (v === 'after_char') return { numeric: 1, str: 'after_char' };
    return { numeric: 0, str: 'before_char' };   // 未指定时按世界书默认「角色卡之前」
}

/**
 * 把一条**库/旧世界书格式**词条转换为**角色卡内嵌 V2 格式**。
 * @param {object} source 源词条（库条目、ST 世界书条目、甚至已经是内嵌格式的条目）
 * @param {number} fallbackId 源词条没有合法 `id` 时用的编号（建议传目标数组长度）
 * @returns {object} 全新的条目对象（深拷贝，**不修改入参**）；非法输入原样返回
 */
export function toEmbeddedEntry(source, fallbackId = 0) {
    let e;
    try {
        e = JSON.parse(JSON.stringify(source));
    } catch (err) {
        return source;   // 循环引用等异常形态：绝不因转换失败丢数据
    }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e;

    // 1) 核心四件套（库 → 内嵌）；已是内嵌格式的条目保持原值（幂等）
    e.keys = e.keys !== undefined ? toArray(e.keys) : toArray(e.key);
    e.secondary_keys = e.secondary_keys !== undefined ? toArray(e.secondary_keys) : toArray(e.keysecondary);
    e.comment = String(e.comment || e.name || '');
    e.content = String(e.content || '');
    e.constant = !!e.constant;
    e.selective = !!e.selective;
    e.insertion_order = e.insertion_order ?? e.order ?? 100;
    e.enabled = e.enabled !== undefined ? e.enabled !== false : e.disable !== true;
    e.use_regex = !!(e.use_regex ?? e.useRegex);

    // 2) 位置：顶层字符串（V2 规范）+ extensions.position 数字（真实卡如此，保住数值真相）
    const pos = normalizePosition(e.position);
    e.position = pos.str;

    // 3) 条目 id：真实卡内嵌词条都有 id（ST 拿它当 uid）
    if (!Number.isInteger(e.id)) e.id = Number.isInteger(fallbackId) ? fallbackId : 0;

    // 4) 选项字段搬进 extensions（源已有 extensions 则合并，源优先）
    const ext = (e.extensions && typeof e.extensions === 'object' && !Array.isArray(e.extensions)) ? e.extensions : {};
    if (typeof ext.position !== 'number') ext.position = pos.numeric;
    for (const [from, to] of Object.entries(OPTION_KEY_MAP)) {
        if (e[from] !== undefined) { ext[to] = e[from]; delete e[from]; }
    }
    for (const k of OPTION_KEY_SAME) {
        if (e[k] !== undefined) { ext[k] = e[k]; delete e[k]; }
    }
    e.extensions = ext;

    // 5) 删掉被消费的库字段，避免「一张卡里两种口径并存」
    for (const k of CONSUMED_LIBRARY_KEYS) delete e[k];

    return e;
}

export default { toEmbeddedEntry };
