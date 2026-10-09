/**
 * 🔗 打标「材料占位符」—— 纯函数（自定义模式的**材料插入点**；方案 v1 §4.1 / Q1(c) / Q6）
 *
 * ═══════════════════════════════════════════════════════════════
 * 解决什么（用户批注 ②③）：
 *   · 现状：程序材料（任务说明 / 候选池 / 输出要求 / 目标材料）被**硬编码**拼进「最后一条 USER 段」——
 *     想只去掉其中一段只能把它覆盖成空串，想**放进 SYSTEM 段**根本做不到 ⇒「反而限制了自由度」。
 *   · 现在：段内容里写占位符 ⇒ 发送时**就地替换**成对应材料，且该材料**不再自动附加**；
 *     没被任何占位符引用的材料才照旧尾随（= 零回归）。
 * ═══════════════════════════════════════════════════════════════
 * 🔒 硬约束（**改这个文件前先读**）：
 *   1. **只替换「段内容」** —— 绝不替换材料正文里的宏（世界书正文自带 `{{user}}` / `{{char}}`，
 *      二次替换会污染原文）；
 *   2. **不递归**：替换出来的值里若还含占位符，不再展开（防自引用死循环）；
 *   3. 未知占位符**原样保留**并收集（供 UI 提示），绝不静默吞掉用户文本；
 *   4. `$1` 是 `{{材料}}` 的**别名**（用户原话里就是这么想的）—— ⚠️ 若提示词里有正则反向引用 `$1`，
 *      请改用 `{{材料}}`（UI 有明确提示；预览=实发，替换结果可见）。
 *
 * 零 Vue / 零 Electron 依赖，可 `node --test` 直接测。
 */

/** 占位符定义表（`key` = 逻辑材料键，与 `buildXxxPromptParts` 的 part.key 对应） */
export const VAR_DEFS = [
    { key: 'material', label: '目标材料', aliases: ['材料', 'material', '卡片或世界书', '内容'] },
    { key: 'card', label: '卡片材料', aliases: ['卡片', 'card'] },
    { key: 'wb', label: '世界书材料', aliases: ['世界书', 'wb', 'worldbook'] },
    { key: 'pool', label: '候选池与规则', aliases: ['候选池', '候选池与规则', 'pool'] },
    { key: 'extra', label: '附加要求', aliases: ['附加要求', '附加', 'extra'] },
    { key: 'task', label: '任务说明', aliases: ['任务说明', '任务', 'task'] },
    { key: 'output', label: '输出要求', aliases: ['输出要求', '格式要求', 'output'] },
    { key: 'jailbreak', label: '破限词', aliases: ['破限', '破限词', 'jailbreak'] }
];

/** `$1` 别名 → 逻辑键（用户建议的写法） */
export const DOLLAR_ALIASES = { '$1': 'material' };

/** 生成 `别名 → 逻辑键` 查表（小写、去空格后比对） */
function buildAliasMap() {
    const m = new Map();
    for (const def of VAR_DEFS) {
        for (const a of def.aliases) m.set(normalizeName(a), def.key);
    }
    return m;
}
const ALIAS_MAP = buildAliasMap();

/** 归一化占位符名（去空白 + 小写） */
function normalizeName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
}

/** `{{...}}` 匹配（容忍内部空格） */
const MUSTACHE_RE = /\{\{\s*([^{}]{1,40}?)\s*\}\}/g;

/**
 * 解析段列表里用到了哪些占位符。
 * @param {Array<{id?:string, role?:string, content?:string}>} segments
 * @returns {{ used: string[], unknown: string[], perSegment: Array<{ id: string, keys: string[] }> }}
 *   `used` = 逻辑材料键（去重、按首次出现顺序）；`unknown` = 未识别的原名（去重）
 */
export function parseSegmentVars(segments) {
    const used = [];
    const unknown = [];
    const perSegment = [];
    const list = Array.isArray(segments) ? segments : [];
    for (const seg of list) {
        const content = String((seg && seg.content) || '');
        const keys = [];
        const push = (k) => { if (!used.includes(k)) used.push(k); if (!keys.includes(k)) keys.push(k); };
        MUSTACHE_RE.lastIndex = 0;
        let m;
        while ((m = MUSTACHE_RE.exec(content))) {
            const key = ALIAS_MAP.get(normalizeName(m[1]));
            if (key) push(key);
            else if (!unknown.includes(m[1])) unknown.push(m[1]);
        }
        for (const [alias, key] of Object.entries(DOLLAR_ALIASES)) {
            if (content.includes(alias)) push(key);
        }
        perSegment.push({ id: String((seg && seg.id) || ''), keys });
    }
    return { used, unknown, perSegment };
}

/**
 * 把占位符替换成实际材料文本（**只作用于段内容**，不递归、不碰材料正文）。
 * @param {Array} segments 段列表
 * @param {Object<string,string>} vars 逻辑键 → 文本（缺失 / 非字符串按空串）
 * @returns {{ segments: Array, used: string[], unknown: string[], perSegment: Array }}
 *   `segments` = **新数组**（不可变更新；原数组不动）
 */
export function applySegmentVars(segments, vars) {
    const parsed = parseSegmentVars(segments);
    const v = (vars && typeof vars === 'object') ? vars : {};
    const val = (key) => (typeof v[key] === 'string' ? v[key] : '');
    const list = Array.isArray(segments) ? segments : [];
    const out = list.map((seg) => {
        const content = String((seg && seg.content) || '');
        if (!content) return { ...seg, content };
        let text = content.replace(MUSTACHE_RE, (whole, name) => {
            const key = ALIAS_MAP.get(normalizeName(name));
            return key ? val(key) : whole;   // 未知占位符原样保留（不吞用户文本）
        });
        for (const [alias, key] of Object.entries(DOLLAR_ALIASES)) {
            if (text.includes(alias)) text = text.split(alias).join(val(key));
        }
        return { ...seg, content: text };
    });
    return { segments: out, used: parsed.used, unknown: parsed.unknown, perSegment: parsed.perSegment };
}

/**
 * 把「材料段（parts）」按当前档位分成两份：**已被占位符接管的**与**仍需自动附加的**。
 * @param {Array<{key:string, body:string}>} parts `buildCardPromptParts` / `buildWbPromptParts` 的结果
 * @param {string[]} usedKeys `applySegmentVars().used`（逻辑键）
 * @param {string} [mode] `'compat'`（默认，全自动）/ `'semi'`（只自动附加材料 + 候选池）/ `'manual'`（全手动）
 * @param {'card'|'wb'} [kind] 目标类型（把 part.key `card`/`wb` 归一到逻辑键 `material`）
 * @returns {{ autoParts: Array, takenKeys: string[], droppedKeys: string[] }}
 *   `autoParts` = 仍要尾随的材料段（保持原顺序）；`takenKeys` = 被占位符接管；
 *   `droppedKeys` = 因档位不送（半自动丢 task/output；全手动全丢）
 */
export function splitPartsByVars(parts, usedKeys, mode = 'compat', kind = 'card') {
    const list = Array.isArray(parts) ? parts : [];
    const used = Array.isArray(usedKeys) ? usedKeys : [];
    const logicalOf = (partKey) => ((partKey === 'card' || partKey === 'wb') ? 'material' : partKey);
    const DROP_SEMI = ['task', 'output'];
    const drop = mode === 'manual'
        ? ['task', 'pool', 'extra', 'output', 'material']
        : (mode === 'semi' ? DROP_SEMI : []);
    const autoParts = [];
    const takenKeys = [];
    const droppedKeys = [];
    for (const p of list) {
        const lk = logicalOf(p && p.key);
        if (used.includes(lk)) { takenKeys.push(p.key); continue; }
        if (drop.includes(lk)) { droppedKeys.push(p.key); continue; }
        autoParts.push(p);
    }
    return { autoParts, takenKeys, droppedKeys };
}

/**
 * 组装「占位符变量表」（发送与预览共用；`kind` 决定谁是目标材料）。
 * @param {object} p
 * @param {Array<{key:string, body:string}>} p.parts 材料段（含 task / pool / extra / output / card|wb）
 * @param {'card'|'wb'} [p.kind]
 * @param {string} [p.jailbreak] 破限词（`{{破限}}` 用；未启用破限时传空串）
 * @returns {Object<string,string>} 逻辑键 → 文本
 */
export function buildVarsFromParts({ parts, kind = 'card', jailbreak = '' } = {}) {
    const list = Array.isArray(parts) ? parts : [];
    const byKey = new Map();
    for (const p of list) if (p && p.key) byKey.set(p.key, String(p.body || ''));
    const material = byKey.get(kind) || '';
    return {
        material,
        card: byKey.get('card') || '',
        wb: byKey.get('wb') || '',
        pool: byKey.get('pool') || byKey.get('extra') || '',
        extra: byKey.get('extra') || '',
        task: byKey.get('task') || '',
        output: byKey.get('output') || '',
        jailbreak: String(jailbreak || '')
    };
}

export default {
    VAR_DEFS, DOLLAR_ALIASES,
    parseSegmentVars, applySegmentVars, splitPartsByVars, buildVarsFromParts
};
