/**
 * 正则脚本引擎（严格对齐酒馆 SillyTavern regex engine 逆向规范）
 * 在测卡中对用户输入和 AI 回复应用正则替换。
 *
 * ── placement 数字枚举（酒馆标准，此前本文件用字符串 'AI'/'USER' 匹配，
 *    导致卡内数字 placement 的正则运行时全部被跳过 —— 本次重写修复）──
 *   0 = 全局（酒馆旧 MD_DISPLAY 已废弃，本端按"全节点生效"处理）
 *   1 = 用户输入（发送前）
 *   2 = AI 输出（接收后）
 *   3 = 斜杠命令（本端无斜杠管线，按全节点兼容处理，保留旧版移动端"全文本"语义）
 *   5 = 世界书条目注入（本端并入 AI 输出阶段）
 *   6 = 推理/思维链块（本端并入 AI 输出阶段）
 *
 * 兼容旧字符串 placement：'AI'→2 'USER'→1 'slash'→3 'world'→5 'reasoning'→6
 *
 * ── 单条脚本字段（对齐酒馆）──
 *   scriptName / findRegex / replaceString / placement[] / disabled
 *   trimStrings[]（捕获组剔除表，取代旧自造 trimRange）
 *   substituteRegex 0|1|2（0=匹配式不做宏替换）
 *   markdownOnly（仅显示层 → 本端管线即显示层，生效）
 *   promptOnly（仅提示词层 → 本端显示管线跳过）
 *
 * ── 替换串能力（对齐酒馆 runRegexScript）──
 *   {{match}}=整体匹配  $1/$2=捕获组  $<name>=命名捕获组  {{user}}等宏二次替换
 */

/** 酒馆 placement 数字常量 */
export const PLACEMENT_GLOBAL = 0;
export const PLACEMENT_USER_INPUT = 1;
export const PLACEMENT_AI_OUTPUT = 2;
export const PLACEMENT_SLASH = 3;
export const PLACEMENT_WORLDBOOK = 5;
export const PLACEMENT_REASONING = 6;

/** 旧字符串 placement → 数字（兼容本端旧数据与第三方导出） */
const LEGACY_PLACEMENT_MAP = {
    ai: 2, ai_output: 2,
    user: 1, user_input: 1,
    slash: 3,
    world: 5, worldbook: 5,
    reasoning: 6,
    global: 0,
};

/** 运行阶段 → 数字节点（供 applyRegexScripts 内部使用） */
const STAGE_NODE = { AI: 2, USER: 1 };

/** placement 显示标签（侧边栏用） */
export const PLACEMENT_LABELS = { 0: '全局', 1: '用户', 2: 'AI', 3: '斜杠', 5: '世界书', 6: '思维' };

/**
 * 安全编译正则表达式（兼容酒馆 findRegex 格式）
 * 酒馆正则可能是 /pattern/flags 格式或纯 pattern
 */
function compileRegex(pattern) {
    if (!pattern || typeof pattern !== 'string') return null;
    const trimmed = pattern.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/s);
    try {
        if (match) return new RegExp(match[1], match[2]);
        return new RegExp(trimmed, 'gm');
    } catch (e) {
        console.warn('[Regex] 正则编译失败:', pattern, e.message);
        return null;
    }
}

/** 宏替换：{{user}} {{char}} 及自定义宏 */
function substituteMacros(str, macros) {
    if (!str || typeof str !== 'string' || !macros) return str || '';
    let out = str;
    for (const [macro, value] of Object.entries(macros)) {
        if (!macro) continue;
        out = out.split(macro).join(value == null ? '' : String(value));
    }
    return out;
}

/** 单个 placement 值归一为数字（无法识别返回 null） */
export function coercePlacement(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const t = v.trim();
        if (t === '') return null;
        const n = Number(t);
        if (!Number.isNaN(n)) return n;
        const key = t.toLowerCase();
        return LEGACY_PLACEMENT_MAP[key] !== undefined ? LEGACY_PLACEMENT_MAP[key] : null;
    }
    return null;
}

/**
 * 判断脚本在当前节点是否生效
 * 规则：空 placement → 全节点（兼容旧行为）；含 0/3 → 全节点（全局/旧"全文本"）；
 * 5、6 并入 AI 输出阶段；否则精确匹配节点号
 */
function placementMatches(placements, node) {
    if (!placements.length) return true;
    for (const p of placements) {
        if (p === 0 || p === 3) return true;
        if (p === node) return true;
        if (node === 2 && (p === 5 || p === 6)) return true;
    }
    return false;
}

/**
 * 对单条文本应用一组正则脚本
 * @param {string} text - 原始文本
 * @param {Array} scripts - 正则脚本数组（已归一或未归一均可）
 * @param {string} stage - 应用阶段 'AI' | 'USER'
 * @param {object} macros - 宏字典（{{user}} {{char}} 及插件宏）
 * @param {object} [opts] 选项:
 *   - promptOnlyExclusive=true 仅应用 promptOnly 脚本(构建发给 AI 的提示词历史用,对齐酒馆"对AI隐藏")
 * @returns {string} 处理后的文本
 */
export function applyRegexScripts(text, scripts, stage, macros, opts = {}) {
    if (!text || !scripts || !Array.isArray(scripts) || scripts.length === 0) return text || '';
    const promptOnlyExclusive = opts.promptOnlyExclusive === true;
    const node = STAGE_NODE[stage] || 2;
    let out = String(text);

    for (const raw of scripts) {
        if (!raw || raw.disabled === true) continue;
        const isPromptOnly = raw.promptOnly === true;
        // promptOnly = 仅作用于发给模型的提示词;markdownOnly = 仅显示层
        if (promptOnlyExclusive) { if (!isPromptOnly) continue; }
        else if (isPromptOnly) continue; // 显示管线跳过 promptOnly 脚本

        const placements = Array.isArray(raw.placement) ? raw.placement.map(coercePlacement).filter((v) => v !== null) : [];
        if (!placementMatches(placements, node)) continue;

        // 宏替换：先替换匹配式（substituteRegex=0 时跳过），再编译
        const findPattern = (raw.substituteRegex === 0)
            ? (raw.findRegex || raw.find_regex)
            : substituteMacros(raw.findRegex || raw.find_regex, macros);
        const re = compileRegex(findPattern);
        if (!re) continue;

        // 替换串宏替换（对齐酒馆：替换结果最后还会跑一次宏替换）
        const replacement = substituteMacros(String(raw.replaceString || raw.replace_string || ''), macros);
        const trimStrings = Array.isArray(raw.trimStrings) ? raw.trimStrings.filter((t) => typeof t === 'string' && t) : [];

        try {
            out = out.replace(re, (...m) => {
                const full = m[0];
                const groups = (typeof m[m.length - 1] === 'object' && m[m.length - 1] !== null) ? m[m.length - 1] : {};
                const hasNamed = typeof m[m.length - 1] === 'object' && m[m.length - 1] !== null;
                const captureEnd = hasNamed ? m.length - 2 : m.length - 1;
                let captures = m.slice(1, captureEnd);
                // trimStrings：从每个捕获组中剔除指定串（酒馆行为）
                if (trimStrings.length) {
                    captures = captures.map((c) => {
                        if (typeof c !== 'string') return c;
                        let cc = c;
                        for (const t of trimStrings) cc = cc.split(t).join('');
                        return cc;
                    });
                }
                let rep = replacement;
                // {{match}} → 整体匹配
                rep = rep.split('{{match}}').join(full);
                // $1/$2… → 捕获组
                rep = rep.replace(/\$(\d+)/g, (_, n) => {
                    const idx = Number(n) - 1;
                    return captures[idx] !== undefined ? captures[idx] : '';
                });
                // $<name> → 命名捕获组
                rep = rep.replace(/\$<([^>]+)>/g, (_, name) => (groups[name] !== undefined ? groups[name] : ''));
                return rep;
            });
        } catch (e) {
            console.warn('[Regex] 替换失败:', raw.scriptName || raw.findRegex, e.message);
        }
    }
    return out;
}

/**
 * 归一化正则脚本（兼容 enabled/disabled 双字段、蛇形命名、字符串/数字 placement 混用）
 */
export function normalizeRegexScript(s) {
    if (!s) return null;
    const out = { ...s };
    if (!out.findRegex && s.find_regex) out.findRegex = s.find_regex;
    if (!out.replaceString && s.replace_string) out.replaceString = s.replace_string;
    if (!out.scriptName && s.script_name) out.scriptName = s.script_name;
    if (out.enabled !== undefined && out.disabled === undefined) out.disabled = !out.enabled;
    const rawPlacement = Array.isArray(out.placement) ? out.placement : (out.placement !== undefined && out.placement !== null ? [out.placement] : []);
    out.placement = rawPlacement.map(coercePlacement).filter((v) => v !== null);
    return out;
}

/**
 * 从卡片数据提取正则脚本列表（全形态兼容）
 * 酒馆标准路径：data.extensions.regex_scripts（V2/V3 的 data 层 extensions 暗格）
 * 本端 card 对象结构：card.data = 规范化后的整卡 JSON，card.data.data = 数据层
 * 支持位置（按优先级）：
 *   ① card.data.data.extensions.regex_scripts — V2/V3 标准
 *   ② card.data.extensions.regex_scripts      — 归一化后旧 V1 卡
 *   ③ card.data.data.regex_scripts            — 非标：数据层顶层裸数组
 *   ④ card.data.regex_scripts                 — V1 顶层裸数组
 */
export function extractRegexFromCard(card) {
    const dd = (card && card.data && card.data.data) || {};
    const top = (card && card.data) || {};
    if (dd && dd.extensions && Array.isArray(dd.extensions.regex_scripts)) {
        return dd.extensions.regex_scripts.map(normalizeRegexScript).filter(Boolean);
    }
    if (top && top.extensions && Array.isArray(top.extensions.regex_scripts)) {
        return top.extensions.regex_scripts.map(normalizeRegexScript).filter(Boolean);
    }
    if (dd && Array.isArray(dd.regex_scripts)) {
        return dd.regex_scripts.map(normalizeRegexScript).filter(Boolean);
    }
    if (top && Array.isArray(top.regex_scripts)) {
        return top.regex_scripts.map(normalizeRegexScript).filter(Boolean);
    }
    return [];
}

/** 旧常量别名保留（避免潜在引用断裂；新代码请用 PLACEMENT_* 数字常量） */
export const REGEX_PLACEMENT_AI = PLACEMENT_AI_OUTPUT;
export const REGEX_PLACEMENT_USER = PLACEMENT_USER_INPUT;
export const REGEX_PLACEMENT_SLASH = PLACEMENT_SLASH;
export const REGEX_PLACEMENT_WORLD = PLACEMENT_WORLDBOOK;
