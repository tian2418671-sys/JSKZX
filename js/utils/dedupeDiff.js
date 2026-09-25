/**
 * ⚖️ 差异窗口三分支构建（v4 §10.3）—— 纯函数层
 * ═══════════════════════════════════════════════════════════════
 * 把「推荐版 vs 对比版」整理成 `DiffModal` 可直接渲染的 `fieldResults` 数组。
 * 三分支（自动识别）：世界书 / 预设 / 角色卡。
 *
 * 结构契约（DiffModal.vue 消费，逐一对应）：
 *   · 通用行：`{ label, isSame, len1, len2, diffText: null|rows, hint }`
 *   · 词条对齐行：`{ isEntryPairs: true, pairs }`（pairs 来自 `alignEntryLists`）
 *   · 标签行：`{ isTags: true, commonTags, onlyMasterTags, onlyCompareTags }`
 *
 * 红线（历史事故，改前必读）：
 *   · **字段口径必须与查重口径对齐**（P1-6 / DF-23）：差异比对看不到的字段 = 用户误删的依据缺失；
 *   · **内嵌书判形态不得用 `Array.isArray(entries)`**（DF-19）——走 `cardBookEntries` 全形态提取器；
 *   · **世界书识别不得只看 `data.entries`**（PK-26：懒加载 `data` 为 null）——补 `entryCount/wbName` 判据；
 *   · 本文件零案例字面量（守卫扫描）。
 */
import { alignEntryLists, summarizeAlignment, normalizeEntries } from './entryAlign.js';
import { diffContentForDisplay } from './textDiff.js';
import { cardBookEntries } from './dedupeCommon.js';
import { PRESET_PARAM_FIELDS } from './dedupePreset.js';
// 预设采样参数字段统一在 `dedupePreset.js` 定义（唯一定义处）——此处转发供既有使用方
export { PRESET_PARAM_FIELDS };

/** 角色卡对比字段（**与查重字段池对齐** —— DF-23/P1-6 教训：含内嵌书以外全部文本字段） */
export const CARD_DIFF_FIELDS = [
    { key: 'description', label: '📝 角色描述 (Description)' },
    { key: 'personality', label: '🎭 性格设定 (Personality)' },
    { key: 'scenario', label: '🎬 当前场景 (Scenario)' },
    { key: 'first_mes', label: '💬 开场首句 (First Message)' },
    { key: 'mes_example', label: '🗣️ 示例对话 (Mes Example)' },
    { key: 'creator_notes', label: '📋 作者备注 (Creator Notes)' },
    { key: 'system_prompt', label: '⚙️ 系统提示词 (System Prompt)' },
    { key: 'post_history_instructions', label: '📜 历史后指令 (Post History Instructions)' },
];

/**
 * 识别比对类型。
 * @returns {'wb'|'preset'|'card'}
 */
export const pickDiffKind = (masterItem, compareItem) => {
    const looksWorldbook = (it) => !!it && (
        (it.data && it.data.entries && typeof it.data.entries === 'object')
        || typeof it.entryCount === 'number'
        || !!it.wbName
    );
    if (looksWorldbook(masterItem) || looksWorldbook(compareItem)) return 'wb';
    const looksPreset = (it) => !!it && !!it.data && (
        'temperature' in it.data || 'prompts' in it.data || 'prompt_order' in it.data
    );
    if (looksPreset(masterItem) || looksPreset(compareItem)) return 'preset';
    return 'card';
};

/** DF-17 口径：`data?.data || data` */
const cardDataOfItem = (it) => (it && it.data && (it.data.data || it.data)) || {};

const diffOf = (a, b) => {
    const s1 = String(a == null ? '' : a);
    const s2 = String(b == null ? '' : b);
    const same = s1.trim() === s2.trim();
    return { isSame: same, len1: `${s1.length} 字`, len2: `${s2.length} 字`, diffText: same ? null : diffContentForDisplay(s1, s2) };
};

/** 世界书（四行：词条数 / 词条级对齐 / 触发词池 / 正文总集） */
export const buildWbFieldResults = (masterItem, compareItem) => {
    const entries1 = normalizeEntries(masterItem && masterItem.data && masterItem.data.entries);
    const entries2 = normalizeEntries(compareItem && compareItem.data && compareItem.data.entries);
    const rows = [];

    // 0 条 + 未载入 → 明确提示（防把「没读到」当「没有」——PK-31 同精神）
    const unloaded = (it, n) => n === 0 && it && it.dataLoaded === false;
    const countSame = entries1.length === entries2.length;
    const loadHint = (unloaded(masterItem, entries1.length) || unloaded(compareItem, entries2.length))
        ? '⚠️ 任一侧正文未载入（0 条）——结果可能不完整，请关闭后重开差异窗口重试。'
        : (countSame ? '词条数一致。' : `词条数不同（${entries1.length} vs ${entries2.length}）——逐条增删见下方「🧩 词条级对齐」。`);
    rows.push({
        label: '📚 世界书词条总数 (Entries Count)',
        isSame: countSame,
        len1: `${entries1.length} 条`, len2: `${entries2.length} 条`,
        diffText: null, hint: loadHint,
    });

    const pairs = alignEntryLists(entries1, entries2);
    const stat = summarizeAlignment(pairs);
    rows.push({
        label: '🧩 词条级对齐 (Entry Alignment)',
        isEntryPairs: true,
        isSame: stat.onlyA === 0 && stat.onlyB === 0 && stat.changed === 0,
        len1: `新增 ${stat.onlyB} / 缺失 ${stat.onlyA} / 改动 ${stat.changed}`,
        len2: `共 ${pairs.length} 条`,
        pairs,
    });

    const keysOf = (entries) => new Set(entries
        .map((e) => (e && typeof e === 'object' ? (Array.isArray(e.key) ? e.key.join(', ') : e.key) : null))
        .filter(Boolean));
    const keys1 = keysOf(entries1);
    const keys2 = keysOf(entries2);
    rows.push({
        label: '🔑 触发词池覆盖差异 (Trigger Keys)',
        isSame: keys1.size === keys2.size && [...keys1].every((k) => keys2.has(k)),
        isTags: true,
        commonTags: [...keys1].filter((k) => keys2.has(k)),
        onlyMasterTags: [...keys1].filter((k) => !keys2.has(k)),
        onlyCompareTags: [...keys2].filter((k) => !keys1.has(k)),
    });

    const text1 = entries1.map((e) => (e && typeof e === 'object' ? String(e.content || '') : '')).join('\n');
    const text2 = entries2.map((e) => (e && typeof e === 'object' ? String(e.content || '') : '')).join('\n');
    const textSame = text1 === text2;
    rows.push({
        label: '📝 词条正文总集比对 (All Content Diff)',
        isSame: textSame,
        len1: `${text1.length} 字`, len2: `${text2.length} 字`,
        diffText: textSame ? null : diffContentForDisplay(text1, text2),
        hint: '正文总集无逐行差异可展开，逐条对比见「🧩 词条级对齐」。',
    });
    return rows;
};

/** 预设（采样参数逐项 + 提示词正文） */
export const buildPresetFieldResults = (masterItem, compareItem) => {
    const rows = [];
    const mData = cardDataOfItem(masterItem);
    const cData = cardDataOfItem(compareItem);
    const presetVal = (d, k) => {
        const v = d[k];
        if (v === undefined || v === null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    };
    for (const f of PRESET_PARAM_FIELDS) {
        const v1 = presetVal(mData, f.key);
        const v2 = presetVal(cData, f.key);
        rows.push({
            label: f.label,
            isSame: v1 === v2,
            len1: v1 || '未设置', len2: v2 || '未设置',
            diffText: v1 === v2 ? null : diffContentForDisplay(v1, v2),
        });
    }

    // 提示词正文（数组元素是块对象——绝不能 `join('\n')` 直拼，会出 `[object Object]`）
    const formatPrompts = (d) => {
        const prompts = d.prompts;
        if (!prompts) return '';
        if (Array.isArray(prompts)) {
            return prompts.map((p, i) => {
                if (typeof p === 'string') return `${i}: ${p}`;
                if (!p || typeof p !== 'object') return `${i}: ${String(p == null ? '' : p)}`;
                const id = (typeof p.identifier === 'string' && p.identifier) ? p.identifier : `#${i}`;
                return `[${id}]${p.enabled === false ? '(已禁用)' : ''}: ${String(p.content == null ? '' : p.content)}`;
            }).join('\n');
        }
        if (typeof prompts === 'object') {
            return Object.keys(prompts).map((k) => `${k}: ${String(prompts[k] || '')}`).join('\n');
        }
        return String(prompts);
    };
    const pt1 = formatPrompts(mData);
    const pt2 = formatPrompts(cData);
    rows.push({
        label: '💬 提示词正文 (Prompts)',
        isSame: pt1 === pt2,
        len1: `${pt1.length} 字`, len2: `${pt2.length} 字`,
        diffText: pt1 === pt2 ? null : diffContentForDisplay(pt1, pt2),
    });
    return rows;
};

/** 角色卡（8 文本字段 + 备用开场白 + 内嵌书逐条对齐 + 标签） */
export const buildCardFieldResults = (masterItem, compareItem) => {
    const rows = [];
    const mData = cardDataOfItem(masterItem);
    const cData = cardDataOfItem(compareItem);

    for (const f of CARD_DIFF_FIELDS) {
        const v1 = String(mData[f.key] || masterItem[f.key] || '');
        const v2 = String(cData[f.key] || compareItem[f.key] || '');
        rows.push({ label: f.label, ...diffOf(v1, v2) });
    }

    // 备用开场白（逐条编号）
    const ag1 = Array.isArray(mData.alternate_greetings) ? mData.alternate_greetings : [];
    const ag2 = Array.isArray(cData.alternate_greetings) ? cData.alternate_greetings : [];
    const agText = (arr) => arr.map((g, i) => `#${i + 1}: ${String(g == null ? '' : g)}`).join('\n\n');
    const agSame = ag1.length === ag2.length
        && ag1.every((g, i) => String(g || '').trim() === String(ag2[i] || '').trim());
    rows.push({
        label: '🎁 备用开场白 (Alternate Greetings)',
        isSame: agSame,
        len1: `${ag1.length} 条`, len2: `${ag2.length} 条`,
        diffText: agSame ? null : diffContentForDisplay(agText(ag1), agText(ag2)),
    });

    // 内嵌世界书（按词条逐条对齐；全形态提取器——DF-19）
    const book1 = cardBookEntries(mData);
    const book2 = cardBookEntries(cData);
    const bookPairs = alignEntryLists(book1, book2);
    const bookStat = summarizeAlignment(bookPairs);
    rows.push({
        label: '📚 内嵌世界书 (Character Book)',
        isEntryPairs: true,
        isSame: bookStat.onlyA === 0 && bookStat.onlyB === 0 && bookStat.changed === 0,
        len1: `新增 ${bookStat.onlyB} / 缺失 ${bookStat.onlyA} / 改动 ${bookStat.changed}`,
        len2: `共 ${bookPairs.length} 条`,
        pairs: bookPairs,
    });

    // 标签
    const tags1 = new Set([...(masterItem.customTags || []), ...((mData && mData.tags) || [])]);
    const tags2 = new Set([...(compareItem.customTags || []), ...((cData && cData.tags) || [])]);
    rows.push({
        label: '🏷️ 自定义/系统标签 (Tags)',
        isSame: tags1.size === tags2.size && [...tags1].every((t) => tags2.has(t)),
        isTags: true,
        commonTags: [...tags1].filter((t) => tags2.has(t)),
        onlyMasterTags: [...tags1].filter((t) => !tags2.has(t)),
        onlyCompareTags: [...tags2].filter((t) => !tags1.has(t)),
    });
    return rows;
};

/** 统一入口：自动识别类型 → 产出 fieldResults */
export const buildFieldResults = (masterItem, compareItem) => {
    const kind = pickDiffKind(masterItem, compareItem);
    if (kind === 'wb') return buildWbFieldResults(masterItem, compareItem);
    if (kind === 'preset') return buildPresetFieldResults(masterItem, compareItem);
    return buildCardFieldResults(masterItem, compareItem);
};
