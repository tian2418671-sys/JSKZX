/**
 * 🧹 分组清理 · 空组收集（DF-16）
 *
 * 背景：分组列表 = `customCategories`（**跨库累积**：切库 / 改名 / 迁移都会留名）+ 预设分组。
 * 既有 `cleanupEmptyCategories` 只处理「刚被删空」的自定义组，**历史遗留没有任何入口**
 * —— 配置项与磁盘空文件夹长期残留（用户报「怎么这么多空组」）。
 *
 * 本模块是**纯函数**（无 Vue / 无 IPC）：给定分组与卡片清单（按 `category` 字段），
 * 返回「0 卡片」的空分组名单，供 `useCardGroups.cleanupEmptyGroupsPrompt` 走两步确认后清理。
 *
 * 计数口径：
 * - 卡片 `category` 为空 / 非字符串 → 记入「未分类」（不是任何分组）；
 * - 预设分组按 `cn / en / key` 三种存储形态计数（卡片 `category` 可能是其中任意一种）；
 * - 系统视图（`all / has_lorebook / has_regex / uncategorized`）与「全部 / 未分类」永不进清理名单。
 */

/** 系统视图 key：不是真实分组，永不清理 */
export const SYSTEM_VIEW_KEYS = ['all', 'has_lorebook', 'has_regex', 'uncategorized'];

/** 常见「未分类」落名（不计入任何分组） */
const UNCATEGORIZED_NAMES = new Set(['未分类', 'uncategorized', '未分组']);

/**
 * 收集「零卡片」的空分组
 *
 * @param {Object} input
 * @param {string[]} [input.customCategories] 自定义分组名列表（配置持久化）
 * @param {Array<{key:string, cn:string, en?:string}>} [input.presetCategories] 预设分组定义
 * @param {Array<{category?: string}>} [input.cards] 卡片清单（判定用 `category` 字段）
 * @returns {{ customEmpties: string[], presetEmpties: Array<{key:string, cn:string, en?:string}> }}
 */
export function collectEmptyGroups(input = {}) {
    const customCategories = Array.isArray(input.customCategories) ? input.customCategories : [];
    const presetCategories = Array.isArray(input.presetCategories) ? input.presetCategories : [];
    const cards = Array.isArray(input.cards) ? input.cards : [];

    const counts = new Map(); // category → 卡片数
    for (const card of cards) {
        const raw = card && typeof card.category === 'string' ? card.category.trim() : '';
        if (!raw || UNCATEGORIZED_NAMES.has(raw)) continue; // 未分类不产生计数
        counts.set(raw, (counts.get(raw) || 0) + 1);
    }
    const hasAny = (names) => names.some(n => n && (counts.get(n) || 0) > 0);

    const customEmpties = Array.from(new Set(
        customCategories
            .filter(g => typeof g === 'string' && g.trim() !== '')
            .filter(g => !UNCATEGORIZED_NAMES.has(g.trim()) && !SYSTEM_VIEW_KEYS.includes(g.trim()))
            .filter(g => !hasAny([g]))
    ));

    const presetEmpties = presetCategories
        .filter(c => c && typeof c.key === 'string' && c.key && !SYSTEM_VIEW_KEYS.includes(c.key))
        .filter(c => !hasAny([c.cn, c.en, c.key]));

    return { customEmpties, presetEmpties };
}
