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
 *
 * 🚀 编译结果缓存：同一 pattern 不再逐次重编译（引擎一条消息要跑几十条脚本、
 *    发送时还要对全历史再跑一遍，重复编译开销可观）。
 *    ⚠️ 只在 String.replace 场景使用，replace 对 /g 正则会在结束时重置 lastIndex，
 *    故复用实例是安全的（调用处仍会显式重置一次 lastIndex 以策万全）。
 */
const REGEX_CACHE_MAX = 500;
const regexCache = new Map();   // pattern → RegExp | null（null = 已知编译失败，不重复 warn）
function compileRegex(pattern) {
    if (!pattern || typeof pattern !== 'string') return null;
    if (regexCache.has(pattern)) return regexCache.get(pattern);
    const trimmed = pattern.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/s);
    let re = null;
    try {
        if (match) re = new RegExp(match[1], match[2]);
        else re = new RegExp(trimmed, 'gm');
    } catch (e) {
        console.warn('[Regex] 正则编译失败:', pattern, e.message);
        re = null;
    }
    if (regexCache.size >= REGEX_CACHE_MAX) regexCache.clear();
    regexCache.set(pattern, re);
    return re;
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
/**
 * 单条脚本 / 单次调用的时间预算（毫秒）
 * ─ 防用户预设里的灾难性回溯把界面冻死（实测：`([\s\S]*)<\/konatan_planning~>` 在
 *   137KB 文本上单条就要 11.7s，整条管线 20s+ → 打开卡就“卡死”）。
 *   注：JS 无法中途打断已在执行的正则，预算是**累计守卫**（超预算就不再跑剩余脚本）。
 */
export const REGEX_SCRIPT_BUDGET_MS = 120;
export const REGEX_TOTAL_BUDGET_MS = 1500;
/** 替换串 ≥ 该长度视为「界面注入型」→ 延后物化（见 BIG_REPLACEMENT 注释） */
export const BIG_REPLACEMENT_THRESHOLD = 8192;
/** 延后物化的占位符（用控制字符开头，用户文本里几乎不可能出现） */
const TOKEN_PREFIX = '\u0000\u0001JSKBIG';

/**
 * 对单条文本应用一组正则脚本
 * @param {string} text - 原始文本
 * @param {Array} scripts - 正则脚本数组（已归一或未归一均可）
 * @param {string} stage - 应用阶段 'AI' | 'USER'
 * @param {object} macros - 宏字典（{{user}} {{char}} 及插件宏）
 * @param {object} [opts] 选项:
 *   - promptOnlyExclusive=true 仅应用 promptOnly 脚本(构建发给 AI 的提示词历史用,对齐酒馆"对AI隐藏")
 *   - scriptBudgetMs / totalBudgetMs  覆盖默认预算
 *   - deferBigReplacements=false  关闭「巨型替换串延后物化」（默认开启）
 *   - onSkip(list)  超预算被跳过的脚本回调（UI 可据此提示用户）
 *
 * 🧠 巨型替换串为何要「延后物化」：
 *   酒馆助手类卡片会把 `<StatusPlaceHolderImpl/>` 替成**整包状态栏 HTML（100~280KB）**，
 *   这是**显示层注入**。旧实现把它当成普通文本立即写入，于是
 *   ① 后续几十条脚本（含用户预设里的宽松贪婪正则）全部在膨胀后的文本上跑 → 灾难性回溯、卡死；
 *   ② 置入 `chatMessages` 后还会写进聊天存档。
 *   改为：匹配与计算照旧（`$1`/`{{match}}` 行为不变），但**注入文本用占位符代替**，
 *   等本趟管线全部跑完再统一回填 → 后续脚本始终面对小文本（实测 20s+ → 毫秒级）。
 *   ⚠️ 已知语义边界（极罕见）：若某条后期脚本需要匹配前面脚本注入的 HTML 正文，本方案下它看到的是占位符。
 * @returns {string} 处理后的文本
 */
export function applyRegexScripts(text, scripts, stage, macros, opts = {}) {
    if (!text || !scripts || !Array.isArray(scripts) || scripts.length === 0) return text || '';
    const promptOnlyExclusive = opts.promptOnlyExclusive === true;
    const node = STAGE_NODE[stage] || 2;
    const scriptBudget = Number.isFinite(opts.scriptBudgetMs) ? opts.scriptBudgetMs : REGEX_SCRIPT_BUDGET_MS;
    const totalBudget = Number.isFinite(opts.totalBudgetMs) ? opts.totalBudgetMs : REGEX_TOTAL_BUDGET_MS;
    const bigThreshold = Number.isFinite(opts.bigThreshold) ? opts.bigThreshold : BIG_REPLACEMENT_THRESHOLD;
    const deferBig = opts.deferBigReplacements !== false;
    const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
        ? () => performance.now() : () => Date.now();
    const skipped = [];
    const pendingBig = [];   // [占位符, 真实替换结果]
    let tokenSeq = 0;
    let spent = 0;
    let out = String(text);

    for (let si = 0; si < scripts.length; si++) {
        const raw = scripts[si];
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
        // 🧠 界面注入型（替换串巨大）→ 本趟用占位符代替，管线末尾统一回填
        const deferThis = deferBig && replacement.length >= bigThreshold;
        const scriptName = raw.scriptName || raw.script_name || raw.findRegex || raw.find_regex || '(未命名)';

        const t0 = now();
        try {
            re.lastIndex = 0;   // 缓存复用同一实例，显式重置（/g 状态）
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
                if (deferThis) {
                    const token = TOKEN_PREFIX + (tokenSeq++) + '\u0001';
                    pendingBig.push([token, rep]);
                    return token;
                }
                return rep;
            });
        } catch (e) {
            console.warn('[Regex] 替换失败:', raw.scriptName || raw.findRegex, e.message);
        }

        // ⏱️ 时间预算：单条超预算记一笔；累计超总预算 → 剩余全部跳过（宁可少美化，不可冻界面）
        const cost = now() - t0;
        spent += cost;
        if (cost > scriptBudget) {
            skipped.push({ name: scriptName, ms: Math.round(cost), reason: 'single' });
        }
        if (spent > totalBudget && si < scripts.length - 1) {
            skipped.push({ name: scriptName, ms: Math.round(spent), reason: 'total', remaining: scripts.length - si - 1 });
            break;
        }
    }

    // 🧠 回填延后物化的巨型替换（保持脚本顺序语义：它们的内容最终位置上仍与旧实现一致）
    if (pendingBig.length) {
        for (const [token, value] of pendingBig) out = out.split(token).join(value);
    }
    if (skipped.length) {
        console.warn('[Regex] 预设/正则在当前文本上过重，已跳过部分脚本:', skipped);
        if (typeof opts.onSkip === 'function') { try { opts.onSkip(skipped); } catch (e) { /* 忽略 */ } }
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
