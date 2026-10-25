/**
 * 🗂️ 卡片自动分组（声明式分组档案）—— 判定层纯函数（S1）
 * ═════════════════════════════════════════════════════════════════
 * 设计文档：`docs/技术支持/世界书与卡片/方案-卡片自动分组.md`（v2.0：否决「标签即分组」，改为声明式档案）
 * 实现规格：`docs/规格与计划/功能规格/卡片自动分组-实现规格.md`
 *
 * 核心概念（视角反转：**分组声明成员资格**，而不是「规则产出分组」）：
 *   · 分组档案（profile）= 某个分组自己声明的「收纳条件」+ 目标分组名（= 物理文件夹名）
 *   · 判定：卡片 → 依次尝试各分组档案（按**侧边栏分组顺序**）→ 首个命中者胜
 *
 * 铁律（违反会静默出错，评审裁定，不许偏离）：
 *   1. 取标签**只调** `extractCardTags`（useSearch.js）—— 它输出已小写化；
 *      本层 `tag` 条件的 pattern 必须 `toLowerCase()` 后再比较（大小写口径不一致 = 漏判）。
 *   2. 取内嵌世界书**只调** `extractBookEntries`（cardLoader.js）—— 全形态脏数据安全。
 *   3. 本文件**不许**碰文件系统、不许读 window/electronAPI —— 只产出「计划」，
 *      由执行层（useAutoGroup）落地。纯函数 = 可单测、预览/执行天然同源。
 *   4. **绝不覆盖用户已手动的分组**：默认只处理「未分类」卡片（见 includeGrouped）。
 */

import { extractCardTags } from '../composables/useSearch.js';
import { extractBookEntries } from './cardLoader.js';
import { normalizeLlmCriteria } from './autoGroupLLM.js'; // 🤖 LLM 判定层：判定标准归一化（纯函数，无环依赖）

/** 支持的收纳条件类型（v1 只放开「已取证」的 5 种；author 字段未取证 → 不放开） */
export const AUTO_GROUP_MATCH_TYPES = ['tag', 'name-keyword', 'name-regex', 'hasLorebook', 'hasRegex'];

/** 条件类型的中文标签（UI 用） */
export const AUTO_GROUP_MATCH_LABELS = {
    'tag': '标签（精确匹配）',
    'name-keyword': '名称包含关键词',
    'name-regex': '名称正则',
    'hasLorebook': '有内嵌世界书',
    'hasRegex': '有正则脚本'
};

/** 布尔型条件（无 pattern 参数） */
export const MATCH_TYPES_WITHOUT_PATTERN = ['hasLorebook', 'hasRegex'];

/** 「未分类」= 卡片放在库根（与 moveCardToGroup 的 isRootTarget 口径一致） */
export const AUTO_GROUP_ROOT_GROUP = '未分类';

// =====================================================================
// 小工具
// =====================================================================

let _profileSeq = 0;

/** 生成档案稳定 id（只在「新增档案」时调用；已落盘的 id 不重生成） */
export function createProfileId() {
    _profileSeq += 1;
    return `gp_${Date.now().toString(36)}_${_profileSeq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 分组名 → 文件夹名（与主进程 `main.js` 的净化规则**逐字一致**，防预览与执行不一致）
 * `[\\/:*?"<>|]` → `_`，再 trim。
 */
export function sanitizeFolderName(name) {
    return String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').trim();
}

/** 卡片当前分组（空值一律归「未分类」，与侧边栏口径一致） */
export function currentGroupOf(card) {
    const raw = card && typeof card.category === 'string' ? card.category.trim() : '';
    return raw || AUTO_GROUP_ROOT_GROUP;
}

/** 路径归一化（Windows 分隔符 + 大小写；仅用于「是否在库目录内」的粗判定） */
function normPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** cardPath 是否在 libraryPath 之下（相等也算，理论不存在） */
function isUnderPath(cardPath, libraryPath) {
    const c = normPath(cardPath);
    const l = normPath(libraryPath);
    if (!c || !l) return true;
    return c === l || c.startsWith(l + '/');
}

function baseNameOf(p) {
    const s = String(p == null ? '' : p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
}

/** 卡片数据层（V2/V3 取 card.data.data；V1 扁平卡取 card.data；再兜底卡片自身） */
function dataLayerOf(card) {
    return (card && card.data && card.data.data) || (card && card.data) || {};
}

// =====================================================================
// 归一化（落盘前收敛脏值；与 P1 的 normalizeTagFunnel / normalizeDisabledRules 同构）
// =====================================================================

/**
 * 归一化分组档案列表。规则：
 *   · 非数组 → []；逐条过滤非法项（缺 group / 非法 type / 有参类型缺 pattern）
 *   · 布尔型条件（hasLorebook / hasRegex）**没有** pattern 字段（v1 遗留瑕疵修正）
 *   · 去重：同「分组 + 类型 + pattern（小写）」只保留第一条
 *   · enabled 默认 true（老配置零迁移）；id 缺失时补稳定兜底 id
 *   · ⚠️ 不做「每分组仅一条」的强制裁剪：手改配置多挂规则时**不静默丢数据**，
 *     由 UI 负责提示（S5 会正式放开同分组多规则）
 */
export function normalizeGroupProfiles(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    raw.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const group = typeof item.group === 'string' ? item.group.trim() : '';
        if (!group) return;
        const match = item.match && typeof item.match === 'object' ? item.match : {};
        const type = AUTO_GROUP_MATCH_TYPES.includes(match.type) ? match.type : 'tag';
        const needsPattern = !MATCH_TYPES_WITHOUT_PATTERN.includes(type);
        let pattern = typeof match.pattern === 'string' ? match.pattern.trim() : '';
        if (needsPattern && !pattern) return; // 有参类型缺参数 = 永远不可能命中的垃圾档案
        if (!needsPattern) pattern = '';
        const dedupeKey = `${group}\u0000${type}\u0000${pattern.toLowerCase()}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        out.push({
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `gp_restored_${idx}`,
            group,
            enabled: item.enabled !== false,
            match: needsPattern ? { type, pattern } : { type },
            note: typeof item.note === 'string' ? item.note : '',
            // 🤖 LLM 判定层：「判定标准」（留空 = 该组不参与 AI 判定；S-LLM 新增，老配置零迁移）
            llmCriteria: normalizeLlmCriteria(item.llmCriteria)
        });
    });
    return out;
}

/** 归一化「最近一次自动分组」日志（§4.1：按卡名 + fromGroup 记，不记绝对路径） */
export function normalizeAutoGroupLastRun(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const at = Number(raw.at) || 0;
    const entries = (Array.isArray(raw.entries) ? raw.entries : [])
        .filter(e => e && typeof e === 'object')
        .map(e => ({
            cardName: typeof e.cardName === 'string' ? e.cardName : '',
            fromGroup: (typeof e.fromGroup === 'string' && e.fromGroup.trim()) ? e.fromGroup.trim() : AUTO_GROUP_ROOT_GROUP,
            toGroup: typeof e.toGroup === 'string' ? e.toGroup.trim() : '',
            movedAt: Number(e.movedAt) || at
        }))
        .filter(e => e.cardName && e.toGroup);
    let lastRollback = null;
    if (raw.lastRollback && typeof raw.lastRollback === 'object') {
        lastRollback = {
            at: Number(raw.lastRollback.at) || 0,
            rolled: Number(raw.lastRollback.rolled) || 0,
            failed: (Array.isArray(raw.lastRollback.failed) ? raw.lastRollback.failed : [])
                .filter(f => f && f.cardName)
                .map(f => ({ cardName: String(f.cardName), reason: String(f.reason || '') }))
        };
    }
    if (!entries.length && !lastRollback) return null;
    const out = { at, entries };
    if (lastRollback) out.lastRollback = lastRollback;
    return out;
}

// =====================================================================
// 判定（单条档案 / 全量计划）
// =====================================================================

/** 预编译一条档案（正则只编译一次；非法正则标记 invalid，不拖垮整表） */
function compileProfile(p) {
    const type = p.match.type;
    const pattern = typeof p.match.pattern === 'string' ? p.match.pattern : '';
    const c = {
        id: p.id, group: p.group, type,
        pattern,
        // 🆕 多值 OR（2026-09-20 易用性打磨）：tag / name-keyword 的 pattern 按 `|` 拆成多个候选，
        //    任一命中即命中——用户不用写正则就能表达「催眠|洗脑|暗示」式多词（UI 为 chips 编辑器）。
        //    单值 = 拆出 1 个，行为与旧版一致；name-regex 不拆（`|` 是正则语法本身）。
        pieces: (type === 'tag' || type === 'name-keyword')
            ? pattern.split('|').map(s => s.trim()).filter(Boolean)
            : [],
        invalid: false,
        regex: null
    };
    if (type === 'name-regex') {
        try { c.regex = new RegExp(pattern, 'i'); } catch (e) { c.invalid = true; }
    }
    return c;
}

/** 单条（已编译）档案对单卡判定 → { hit, reason } */
function testCompiled(card, c, opts) {
    const ignoreNativeTags = !!(opts && opts.ignoreNativeTags);
    switch (c.type) {
        case 'tag': {
            // 唯一取标签入口（内部已全小写去重）；多值 OR：任一候选标签命中即命中（大小写不敏感）
            const tags = extractCardTags(card, { ignoreNative: ignoreNativeTags });
            const hit = c.pieces.find(piece => tags.includes(piece.toLowerCase()));
            if (hit) return { hit: true, reason: `标签：${hit}` };
            return { hit: false, reason: '' };
        }
        case 'name-keyword': {
            const name = String((card && card.name) || '').toLowerCase();
            const hit = c.pieces.find(piece => name.includes(piece.toLowerCase()));
            if (hit) return { hit: true, reason: `名称包含：${hit}` };
            return { hit: false, reason: '' };
        }
        case 'name-regex': {
            if (c.invalid) return { hit: false, reason: `名称正则无效（已跳过）：${c.pattern}` };
            const name = String((card && card.name) || '');
            if (name && c.regex.test(name)) return { hit: true, reason: `名称匹配：${c.pattern}` };
            return { hit: false, reason: '' };
        }
        case 'hasLorebook': {
            // 与 useSearch 的「带世界书」过滤视图同口径（extractBookEntries 全形态安全）
            const d = dataLayerOf(card);
            const book = d.character_book
                || (card && card.data && card.data.character_book)
                || (card && card.character_book);
            return { hit: extractBookEntries(book).length > 0, reason: '有世界书' };
        }
        case 'hasRegex': {
            // 与 useSearch 的「带正则脚本」过滤视图同口径
            const d = dataLayerOf(card);
            const regex = d.extensions?.regex_scripts || d.regex_scripts || [];
            return { hit: (regex || []).length > 0, reason: '有正则脚本' };
        }
        default:
            return { hit: false, reason: '' };
    }
}

/**
 * 单条档案对单卡判定（对外可测入口）
 * @param {object} card 库条目
 * @param {object} profile 分组档案（未编译形态）
 * @param {{ ignoreNativeTags?: boolean }} [opts]
 * @returns {{ hit: boolean, reason: string }}
 */
export function matchProfile(card, profile, opts = {}) {
    if (!profile || !profile.match) return { hit: false, reason: '' };
    return testCompiled(card, compileProfile(profile), opts);
}

/**
 * 生成自动分组计划（**只读**：不改卡片、不碰磁盘）
 *
 * @param {object} args
 * @param {Array} args.cards 库条目数组（library.value）
 * @param {Array} args.profiles 分组档案列表（原始形态，内部会归一化）
 * @param {object} [args.options]
 *   · includeGrouped  false（默认）只处理未分类卡片；true 时连已手动分组的卡一起判定
 *   · groupOrder     侧边栏分组顺序（**顺序即优先级**，首个命中者胜；不在表里的排最后）
 *   · knownGroups    现有分组名列表（含预设中文名 / 自定义名），用于「将新建文件夹」提示
 *   · libraryPath    库根路径（用于「库外卡片」跳过标记）
 *   · ignoreNativeTags 是否忽略卡片原生 data.tags（跟随「导入时忽略卡片自带标签」开关）
 *   · now            注入时间戳（单测确定性用）
 * @returns {{
 *   generatedAt: number,
 *   moves: Array, skipped: Array, conflicts: Array,
 *   targetGroups: Array, duplicateWarnings: Array,
 *   counters: object
 * }}
 */
export function buildAutoGroupPlan({ cards = [], profiles = [], options = {} } = {}) {
    const {
        includeGrouped = false,
        groupOrder = [],
        knownGroups = [],
        libraryPath = '',
        ignoreNativeTags = false,
        now = 0
    } = options || {};

    const list = Array.isArray(cards) ? cards : [];
    const profs = normalizeGroupProfiles(profiles);

    // —— 档案排序：分组顺序即优先级；同组（S5 前同组只应一条）按配置顺序稳定 ——
    const orderIndex = (name) => {
        const i = Array.isArray(groupOrder) ? groupOrder.indexOf(name) : -1;
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const enabled = profs
        .map((p, i) => ({ p, i }))
        .filter(x => x.p.enabled !== false)
        .sort((a, b) => (orderIndex(a.p.group) - orderIndex(b.p.group)) || (a.i - b.i))
        .map(x => compileProfile(x.p));

    // 「已知分组」= 配置里的分组 + 卡片上实际存在的 subFolder（防把已存在的空文件夹报成"将新建"）
    const knownSet = new Set([
        ...(Array.isArray(knownGroups) ? knownGroups : []),
        ...list.map(c => c && c.subFolder).filter(Boolean)
    ]);

    const moves = [];
    const skipped = [];
    const conflicts = [];
    const groupCount = new Map();

    for (const card of list) {
        if (!card || typeof card !== 'object') continue;
        const cardName = String(card.name || '(未命名卡片)');
        const cardId = card.id;
        const currentGroup = currentGroupOf(card);

        // 库外卡片：主进程会拒绝移动 → 预览阶段就必须说清楚（而不是执行时才报错）
        if (libraryPath && card.path && !isUnderPath(card.path, libraryPath)) {
            skipped.push({ cardId, cardName, currentGroup, reason: '不在库目录内（请先收编入库）' });
            continue;
        }

        const hits = [];
        for (const c of enabled) {
            const r = testCompiled(card, c, { ignoreNativeTags });
            if (r.hit) hits.push({ profileId: c.id, group: c.group, type: c.type, pattern: c.pattern, reason: r.reason });
        }
        if (!hits.length) {
            skipped.push({ cardId, cardName, currentGroup, reason: '未命中任何启用中的收纳条件' });
            continue;
        }

        const winner = hits[0];
        const distinctGroups = new Set(hits.map(h => h.group));
        if (distinctGroups.size > 1) {
            conflicts.push({
                cardId, cardName,
                winnerGroup: winner.group,
                hits: hits.map(h => ({ group: h.group, reason: h.reason }))
            });
        }

        if (currentGroup === winner.group) {
            skipped.push({ cardId, cardName, currentGroup, reason: `已在目标分组「${winner.group}」` });
            continue;
        }
        if (!includeGrouped && currentGroup !== AUTO_GROUP_ROOT_GROUP) {
            skipped.push({ cardId, cardName, currentGroup, reason: `已手动分组「${currentGroup}」（未勾选「包含已分组」）` });
            continue;
        }

        moves.push({
            cardId, cardName,
            fromGroup: currentGroup,
            toGroup: winner.group,
            reason: winner.reason,
            profileId: winner.profileId,
            card // ⚠️ 活引用：仅本进程内存内使用，**禁止**序列化落盘
        });
        groupCount.set(winner.group, (groupCount.get(winner.group) || 0) + 1);
    }

    // —— 目标分组汇总（含「将新建」与「名称非法被净化」提示）——
    const targetGroups = Array.from(groupCount.entries())
        .map(([name, count]) => {
            const folder = sanitizeFolderName(name);
            return { name, folder, renamed: folder !== name, isNew: !knownSet.has(name) && !knownSet.has(folder), count };
        })
        .sort((a, b) => (orderIndex(a.name) - orderIndex(b.name)) || a.name.localeCompare(b.name));

    // —— 同组同名警告（moveCardToGroup 遇同名会加时间戳后缀 → 用户会看到"文件名变了"，提前提示）——
    const dupMap = new Map();
    for (const m of moves) {
        const fileKey = (baseNameOf(m.card && m.card.path) || m.cardName).toLowerCase();
        const key = `${sanitizeFolderName(m.toGroup)}\u0000${fileKey}`;
        if (!dupMap.has(key)) dupMap.set(key, { targetGroup: m.toGroup, fileName: baseNameOf(m.card && m.card.path) || m.cardName, cards: [] });
        dupMap.get(key).cards.push(m.cardName);
    }
    const duplicateWarnings = Array.from(dupMap.values()).filter(w => w.cards.length > 1);

    return {
        generatedAt: Number(now) || Date.now(),
        moves,
        skipped,
        conflicts,
        targetGroups,
        duplicateWarnings,
        counters: {
            total: list.length,
            willMove: moves.length,
            skipped: skipped.length,
            conflicts: conflicts.length,
            newFolders: targetGroups.filter(g => g.isNew).length,
            enabledProfiles: enabled.length
        }
    };
}

/**
 * 回滚条目定位（§4.1：**按卡名在当前库定位**，不死守日志路径）
 *
 * 状态：
 *   ok        → 唯一命中且仍位于 toGroup（可回滚）
 *   already   → 唯一命中且已回到 fromGroup（无需移动，算已还原）
 *   missing   → 找不到该卡（被删/改名）
 *   changed   → 唯一命中但两边都不是（被手动移动）
 *   ambiguous → 多张同名卡且无法消歧
 */
export function resolveRollbackCard(cards, entry) {
    const name = entry && entry.cardName;
    if (!name) return { status: 'missing' };
    const list = (Array.isArray(cards) ? cards : []).filter(c => c && String(c.name || '') === String(name));
    if (!list.length) return { status: 'missing' };
    const toGroup = entry.toGroup || '';
    const fromGroup = entry.fromGroup || AUTO_GROUP_ROOT_GROUP;
    const inTarget = list.filter(c => currentGroupOf(c) === toGroup);
    if (inTarget.length === 1) return { status: 'ok', card: inTarget[0] };
    if (inTarget.length > 1) return { status: 'ambiguous' };
    if (list.length === 1) {
        const g = currentGroupOf(list[0]);
        if (g === fromGroup) return { status: 'already', card: list[0] };
        return { status: 'changed', card: list[0], actualGroup: g };
    }
    return { status: 'ambiguous' };
}

// =====================================================================
// 🏷️ B1：从高频标签生成「自动分组档案草稿」（纯函数 · 只读）
// =====================================================================
//
// 上游裁决（Q4 / Q5）定的双闸门：
//   · minCards  = 单标签最低卡数门槛 = clamp(total*0.02, 5, 50)（可手改）
//   · maxDrafts = 最多输出条数 = 20（可手改）
//
// ⚠️ 三重过滤顺序不可换：
//   ① 在标签池内 ⇒ 跳过（`systemCommonTags` 天然是「基础分类维度」，不该再生成分组）
//   ② 卡数 < minCards ⇒ 跳过（长尾）
//   ③ 已有同 group+type+pattern 档案 ⇒ 跳过（幂等，绝不重复）
//
// ⚠️ 大小写铁律（见本文件顶部铁律 1）：`extractCardTags` 输出**已小写**，
//   而 `compileProfile` 用 `piece.toLowerCase()` 去比对 ⇒ 草稿的 `match.pattern`
//   **必须写小写**，否则「病娇」这类含中文的标签虽无影响，但英文标签会漏判。
//   本函数返回的 `label` 保留原始大小写（供 UI 显示）。
//
// 🚫 本函数**不落盘、不调 IPC、不碰 moveCardToGroup** —— 只产出草稿，供 UI 预览。

/** minCards 动态默认值（上游 Q5 定锤） */
export function defaultMinCards(total) {
    const n = Math.max(0, Number(total) || 0);
    return Math.min(50, Math.max(5, Math.floor(n * 0.02)));
}

/**
 * 从标签计数生成分组档案草稿
 * @param {Map<string,number>|Array<[string,number]>} tagCounts  computeTagStats().tagCounts
 * @param {Array} existingProfiles  normalizeGroupProfiles() 结果（用于幂等去重）
 * @param {object} opts
 * @param {number} opts.total       库总卡数（算动态 minCards）
 * @param {string[]} [opts.commonTags=[]]  标签池（第 1 重过滤）
 * @param {number} [opts.minCards]  不传则用 defaultMinCards(total)
 * @param {number} [opts.maxDrafts=20]
 * @returns {{drafts:Array, filtered:object, effectiveMinCards:number, effectiveMaxDrafts:number, poolEmpty:boolean}}
 */
export function draftProfilesFromTags(tagCounts, existingProfiles, opts = {}) {
    // 兼容 Map 与 Array<[k,v]>
    let counts = new Map();
    if (tagCounts instanceof Map) counts = tagCounts;
    else if (Array.isArray(tagCounts)) counts = new Map(tagCounts);

    const total = Math.max(0, Number(opts.total) || 0);
    const effectiveMinCards = Number.isFinite(Number(opts.minCards)) && Number(opts.minCards) > 0
        ? Number(opts.minCards)
        : defaultMinCards(total);
    const effectiveMaxDrafts = Math.min(100, Math.max(1, Number(opts.maxDrafts) || 20));

    const pool = Array.isArray(opts.commonTags)
        ? opts.commonTags.map((t) => String(t == null ? '' : t).trim()).filter(Boolean)
        : [];
    const poolEmpty = pool.length === 0;
    const poolSet = new Set(pool);

    // 已有档案的 dedupeKey 集合（与 normalizeGroupProfiles 的键构造**逐字一致**）
    const existingKeys = new Set();
    for (const p of (Array.isArray(existingProfiles) ? existingProfiles : [])) {
        if (!p || typeof p !== 'object') continue;
        const g = typeof p.group === 'string' ? p.group.trim() : '';
        const m = p.match && typeof p.match === 'object' ? p.match : {};
        const t = m.type || 'tag';
        const pat = typeof m.pattern === 'string' ? m.pattern.trim() : '';
        if (g) existingKeys.add(`${g}\u0000${t}\u0000${pat.toLowerCase()}`);
    }

    const filtered = { inPool: [], belowMinCards: 0, duplicate: 0, emptyTag: 0 };
    const candidates = [];

    for (const [rawTag, rawCount] of counts.entries()) {
        const label = String(rawTag == null ? '' : rawTag).trim();
        if (!label) { filtered.emptyTag++; continue; }
        const count = Math.max(0, Number(rawCount) || 0);

        // ① 池内基础标签 ⇒ 跳过（池为空时该重过滤自动失效）
        if (!poolEmpty && poolSet.has(label)) {
            filtered.inPool.push({ tag: label, count });
            continue;
        }
        // ② 卡数不足
        if (count < effectiveMinCards) { filtered.belowMinCards++; continue; }
        // ③ 已有同档案
        const key = `${label}\u0000tag\u0000${label.toLowerCase()}`;
        if (existingKeys.has(key)) { filtered.duplicate++; continue; }

        candidates.push({ group: label, pattern: label.toLowerCase(), label, count });
    }

    // 按卡数降序；同数按名称（稳定，便于单测与 UI 可预期）
    candidates.sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));

    const picked = candidates.slice(0, effectiveMaxDrafts);
    const drafts = picked.map((c) => ({
        group: c.group,
        label: c.label,
        match: { type: 'tag', pattern: c.pattern },
        note: '',
        count: c.count,
        reason: `命中 ${c.count} 张卡 ≥ 门槛 ${effectiveMinCards}`
    }));

    filtered.duplicate += Math.max(0, candidates.length - picked.length);   // 被 maxDrafts 截掉的数量并入「已存在/未采用」

    return {
        drafts,
        filtered,
        effectiveMinCards,
        effectiveMaxDrafts,
        poolEmpty,
        totalCandidates: candidates.length
    };
}
