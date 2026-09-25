/**
 * 🗂️ 世界书自动分组（S4 · 2026-09-25）—— 判定层纯函数
 * ═════════════════════════════════════════════════════════════════
 * 对齐卡片自动分组（`utils/autoGroup.js`）范式：
 *   分组档案（profile）= 分组自己声明的「收纳条件」+ 目标分组名（= 物理文件夹名）
 *   判定：世界书 → 依次尝试各档案（按侧边栏分组顺序）→ **首个命中者胜**
 *
 * 世界书特有口径：
 *   · 判定材料 = **书名 + 全部词条 key**（轻量、不读正文——6MB 级大书零加载成本）；
 *     「词条内容包含」类条件不放开（需读正文，内存/耗时不可控）；
 *     内容语义交给 🤖 LLM 判定层（其材料含逐条内容摘要）。
 *   · 目标分组 = 物理子文件夹名（Q6 甲：物理为唯一标准）。
 *
 * 铁律（与卡片版一致）：
 *   1. 本文件**不碰文件系统**、不读 window/electronAPI —— 只产出「计划」；
 *   2. **绝不覆盖用户已手动的分组**：默认只处理「默认」（库根）的书（见 includeGrouped）；
 *   3. 归一化落盘前收敛脏值；判定纯函数可单测。
 */

import {
    sanitizeFolderName, createProfileId, normalizeAutoGroupLastRun,
    AUTO_GROUP_ROOT_GROUP
} from './autoGroup.js';

// 复用卡片的通用件（避免二次实现漂移）
export { sanitizeFolderName, createProfileId, normalizeAutoGroupLastRun, AUTO_GROUP_ROOT_GROUP };

/** 世界书支持的条件类型（v1：只放开**零正文读取成本**的两类） */
export const WB_GROUP_MATCH_TYPES = ['name-keyword', 'name-regex'];
export const WB_GROUP_MATCH_LABELS = {
    'name-keyword': '书名 / 词条名包含关键词',
    'name-regex': '书名正则'
};

/** 「默认」= 世界书在库根（与物理推导口径一致） */
export const WB_GROUP_ROOT_GROUP = '默认';

let _wbProfileSeq = 0;
/** 生成档案稳定 id */
export function createWbProfileId() {
    _wbProfileSeq += 1;
    return `wgp_${Date.now().toString(36)}_${_wbProfileSeq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 归一化世界书分组档案（落盘前收敛脏值；与卡片版 normalizeGroupProfiles 同构，仅条件类型白名单不同）。
 */
export function normalizeWbGroupProfiles(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    raw.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const group = typeof item.group === 'string' ? item.group.trim() : '';
        if (!group) return;
        const match = item.match && typeof item.match === 'object' ? item.match : {};
        const type = WB_GROUP_MATCH_TYPES.includes(match.type) ? match.type : 'name-keyword';
        const pattern = typeof match.pattern === 'string' ? match.pattern.trim() : '';
        if (!pattern) return; // 无参类型不存在；缺 pattern = 永不命中的垃圾档案
        const dedupeKey = `${group}\u0000${type}\u0000${pattern.toLowerCase()}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        out.push({
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `wgp_restored_${idx}`,
            group,
            enabled: item.enabled !== false,
            match: { type, pattern },
            note: typeof item.note === 'string' ? item.note : '',
            // 🤖 LLM 判定层：「判定标准」（留空 = 该组不参与 AI 判定）
            llmCriteria: typeof item.llmCriteria === 'string' ? item.llmCriteria.trim() : ''
        });
    });
    return out;
}

/** LLM 规格签名（用于建议缓存失效判定）：任一分组的标准/开关变化 → 签名变化 */
export function wbLlmSpecsSignature(specs) {
    return (Array.isArray(specs) ? specs : [])
        .map(s => `${s.group}\u0000${s.criteria}`)
        .sort()
        .join('\u0001');
}

/** 取「参与 LLM 判定」的分组规格（有判定标准 + 启用） */
export function buildWbLlmSpecs(profiles) {
    return normalizeWbGroupProfiles(profiles)
        .filter(p => p.enabled !== false && p.llmCriteria)
        .map(p => ({ group: p.group, criteria: p.llmCriteria }));
}

/** 预编译档案（正则只编译一次；非法正则标记 invalid，不拖垮整表） */
function compileWbProfile(p) {
    const type = p.match.type;
    const pattern = p.match.pattern || '';
    let regex = null;
    let invalid = false;
    if (type === 'name-regex') {
        try { regex = new RegExp(pattern, 'i'); } catch (e) { invalid = true; }
    }
    const keywords = type === 'name-keyword'
        ? pattern.split('|').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];
    return { id: p.id, group: p.group, type, pattern, regex, invalid, keywords };
}

/**
 * 对单本世界书跑一次档案判定（纯函数）。
 * @param {object} book { name, keys: string[] } —— 判定材料（keys = 全部词条 key/触发词，小写化由内部处理）
 * @param {object} compiled compileWbProfile 的产物
 * @returns {boolean}
 */
export function matchWbProfile(book, compiled) {
    if (!book || !compiled || compiled.invalid) return false;
    const name = String(book.name || '');
    if (compiled.type === 'name-regex') {
        return compiled.regex ? compiled.regex.test(name) : false;
    }
    if (compiled.type === 'name-keyword') {
        if (!compiled.keywords.length) return false;
        const haystackName = name.toLowerCase();
        for (const kw of compiled.keywords) if (haystackName.includes(kw)) return true;
        const keys = Array.isArray(book.keys) ? book.keys : [];
        for (const k of keys) {
            const lk = String(k || '').toLowerCase();
            if (!lk) continue;
            for (const kw of compiled.keywords) if (lk.includes(kw)) return true;
        }
        return false;
    }
    return false;
}

/**
 * 构建全量自动分组计划（只读；不落地）。
 *
 * @param {object} p
 * @param {Array<{key:string, name:string, group:string, keys:string[], ref:object}>} p.books
 *        世界书判定材料（group = 当前物理分组；ref = 原对象活引用）
 * @param {Array} p.profiles 分组档案（normalizeWbGroupProfiles 前原始值也可）
 * @param {{includeGrouped?:boolean, groupOrder?:string[], knownGroups?:string[]}} [p.options]
 * @returns {{moves:Array, skipped:Array, targetGroups:Array, counters:object}}
 */
export function buildWbAutoGroupPlan({ books, profiles, options } = {}) {
    const o = options || {};
    const includeGrouped = !!o.includeGrouped;
    const profileList = normalizeWbGroupProfiles(profiles);
    const enabledProfiles = profileList.filter(p => p.enabled !== false);
    const compiled = enabledProfiles.map(compileWbProfile);

    const moves = [];
    const skipped = [];
    for (const bk of (Array.isArray(books) ? books : [])) {
        if (!bk || !bk.key) continue;
        const current = (typeof bk.group === 'string' && bk.group.trim()) ? bk.group.trim() : WB_GROUP_ROOT_GROUP;
        // 铁律 2：默认只处理「默认」（库根）的书——不覆盖用户手动分组的书
        if (current !== WB_GROUP_ROOT_GROUP && !includeGrouped) {
            skipped.push({ bookKey: bk.key, bookName: bk.name, currentGroup: current, reason: '已分组（未勾选「包含已分组的书」）' });
            continue;
        }
        let hit = null;
        for (const c of compiled) {
            if (matchWbProfile(bk, c)) { hit = c; break; } // 首个命中者胜（顺序 = 档案顺序 = 侧边栏分组顺序）
        }
        if (!hit) {
            skipped.push({ bookKey: bk.key, bookName: bk.name, currentGroup: current, reason: '未命中任何收纳条件' });
            continue;
        }
        if (hit.group === current) {
            skipped.push({ bookKey: bk.key, bookName: bk.name, currentGroup: current, reason: `已在「${current}」` });
            continue;
        }
        moves.push({
            bookKey: bk.key,
            bookName: bk.name,
            fromGroup: current,
            toGroup: hit.group,
            reason: hit.type === 'name-regex' ? `正则命中：${hit.pattern}` : `关键词命中：${hit.pattern}`,
            profileId: hit.id,
            ref: bk.ref
        });
    }

    // 目标分组汇总（是否新建 = 不在已知分组集合里）
    const known = new Set((o.knownGroups || []).map(s => String(s)));
    for (const bk of (Array.isArray(books) ? books : [])) {
        if (bk && typeof bk.group === 'string' && bk.group.trim() && bk.group !== WB_GROUP_ROOT_GROUP) known.add(bk.group.trim());
    }
    const counts = new Map();
    for (const m of moves) counts.set(m.toGroup, (counts.get(m.toGroup) || 0) + 1);
    const targetGroups = Array.from(counts.entries())
        .map(([name, count]) => {
            const folder = sanitizeFolderName(name);
            return { name, folder, renamed: folder !== name, isNew: !known.has(name) && !known.has(folder), count };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    return {
        moves,
        skipped,
        targetGroups,
        counters: {
            total: Array.isArray(books) ? books.length : 0,
            willMove: moves.length,
            skipped: skipped.length,
            newFolders: targetGroups.filter(g => g.isNew).length,
            enabledProfiles: enabledProfiles.length
        }
    };
}

/** 回滚解析：按「书名」在现有世界书列表定位（日志不记绝对路径——安全约定） */
export function resolveRollbackWb(books, entry) {
    const name = String((entry && entry.bookName) || '');
    if (!name) return { status: 'missing' };
    const hits = (Array.isArray(books) ? books : []).filter(wb => {
        const dn = (wb && (wb.wbName || (wb.data && wb.data.name) || wb.name)) || '';
        return dn === name;
    });
    if (!hits.length) return { status: 'missing' };
    if (hits.length > 1) return { status: 'ambiguous' };
    const wb = hits[0];
    const cur = (entry && entry.toGroup) || '';
    return { status: 'ok', book: wb, currentGroup: cur };
}

// ═══════════════════════════════════════════════════════════════
// 🤖 LLM 判定层（材料 = 书名 + 词条 key 摘要；与规则层互补——只喂规则未命中的书）
// ═══════════════════════════════════════════════════════════════

export const WB_LLM_DEFAULT_BATCH_SIZE = 12;

/**
 * 构建 LLM 判定消息（纯函数）。
 * @param {{specs:Array<{group:string, criteria:string}>, books:Array<{bookName:string, keys:string[], entryCount:number}>}} p
 * @returns {{system:string, user:string}}
 */
export function buildWbLlmMessages({ specs, books } = {}) {
    const list = Array.isArray(specs) ? specs : [];
    const items = Array.isArray(books) ? books : [];
    const system = [
        '你是「世界书归类助手」。用户会给出若干本世界书的名称与词条名列表，以及若干目标分组的判定标准。',
        '请为每本世界书判断最合适的**唯一**目标分组。',
        '规则：',
        '1. 只允许从给出的目标分组里选；没有合适的就标 null。',
        '2. 严格按判定标准判断，不要凭想象；不确定就标 null。',
        '3. 输出必须是 JSON 对象：{"书名": "目标分组名 或 null", ...}，不要输出任何解释文字。'
    ].join('\n');
    const specText = list.map((s, i) => `${i + 1}. 【${s.group}】判定标准：${s.criteria}`).join('\n');
    const bookText = items.map((b, i) => {
        const keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 40).join('、');
        return `${i + 1}. 书名：${b.bookName}（${b.entryCount || 0} 条词条）\n   词条名：${keys || '（无）'}`;
    }).join('\n');
    const user = `【目标分组与判定标准】\n${specText}\n\n【待归类世界书】\n${bookText}\n\n请输出 JSON（键 = 书名，值 = 分组名或 null）：`;
    return { system, user };
}

/** 解析 LLM 判定输出（宽松：从文本里截取第一个 JSON 对象；非法分组忽略） */
export function parseWbLlmJudgement(text, { validGroups, bookNames } = {}) {
    const out = { assignments: [], unmatched: [], parseError: null, invalidGroups: [] };
    const raw = String(text || '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { out.parseError = '未找到 JSON 对象'; return out; }
    let obj;
    try { obj = JSON.parse(m[0]); } catch (e) { out.parseError = 'JSON 解析失败'; return out; }
    if (!obj || typeof obj !== 'object') { out.parseError = 'JSON 非对象'; return out; }
    const valid = new Set(Array.isArray(validGroups) ? validGroups : []);
    const names = new Set(Array.isArray(bookNames) ? bookNames : []);
    for (const [name, group] of Object.entries(obj)) {
        if (names.size && !names.has(name)) continue;   // 防模型编造书名
        if (group === null || group === undefined || String(group).toLowerCase() === 'null') { out.unmatched.push(name); continue; }
        const g = String(group).trim();
        if (!valid.has(g)) { out.invalidGroups.push(g); out.unmatched.push(name); continue; }
        out.assignments.push({ bookName: name, group: g, confidence: 0.8, reason: 'AI 判定' });
    }
    return out;
}
