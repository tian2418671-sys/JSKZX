/**
 * 测卡记忆规则集（v4.1 · D2 检索治理 + D3 事实规则收紧）
 * ─────────────────────────────────────────────────────────────
 * 纯函数、零依赖（供 useChatMemory.js 与单测共同使用，单一事实源）。
 * 对齐移动版 `JSK管理APP/js/mobile/useChatMemory.js` v4.1 评审定案：
 *   · D2：停用词表 + 有效词 <2 → 降级「本卡最近 N 条」
 *   · D3：显式陈述优先；排除疑问句/否定假设/引用；空泛键跳过；值截断先于转义
 * 不搬移动版 `useChatFactExtractor.js`（置信度体系与本项目提取链是两套并行体系，
 * 桌面沿用 D3 收紧版 extractFacts 作为唯一提取路径，避免双源分叉）。
 */

// ---------- D2：停用词表（集中常量；命中后有效词 <2 → 降级最近 N 条） ----------
export const STOP_WORDS = new Set([
    '我', '你', '您', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
    '的', '了', '是', '在', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '唔',
    '继续', '好', '好的', '可以', '嗯嗯', '然后', '但是', '所以', '因为',
    '这个', '那个', '什么', '怎么', '为什么', '这样', '那样', '一下', '一个',
    '不要', '没有', '不是', '真的', '感觉', '觉得', '知道', '想', '要', '说',
    '喂', '嗨', '哈喽', 'hello', 'hi', 'ok', 'okay', 'yes', 'no', '谢谢', '不客气'
]);

// ---------- D3：key 枚举（提取与注入分类共用单一常量源） ----------
export const FACT_KEYS = ['名字', '年龄', '喜欢', '讨厌', '备忘', '位置', '目标'];

/** D3：空泛键排除 —— 「我的想法是…/我在思考…」类不产生 fact */
export const VAGUE_KEYS = /^(想法|思考|感觉|心情|猜测|疑问|问题|打算|计划|意见|观点|建议)$/;

/** 值上限：普通 30 字；显式指示词（记住/我叫/我今年）80 字（D3：统一截断先于转义） */
export const VALUE_LIMIT_NORMAL = 30;
export const VALUE_LIMIT_EXPLICIT = 80;

/** D3：排除条件 —— 疑问句 / 否定假设 / 引用（提取层整体跳过） */
export function isExcluded(text) {
    const s = String(text || '');
    if (!s) return true;
    if (/[?？]/.test(s)) return true;                                    // 疑问句
    if (/(如果|要是|假如|万一|假设)/.test(s)) return true;                // 否定假设
    if (/(他|她|他们|她们|别人|人家)说/.test(s)) return true;            // 引用
    return false;
}

/** D3：截断（先于转义） */
export function clampValue(v, limit) {
    return String(v == null ? '' : v).trim().slice(0, limit);
}

/** D3：启发式规则 —— 显式陈述优先（键 值），值为句末截止（。！？!? 或行尾） */
export const FACT_RULES = [
    // 显式指示词：记住/牢记/记下 → 80 字上限
    { re: /(?:记住|牢记|记下)\s*[:：]?\s*(.+?)(?:[。！？!?]|$)/, key: '备忘', limit: VALUE_LIMIT_EXPLICIT },
    { re: /(?:你|您|老板娘|老板|管家|夫君|主人|哥哥|姐姐)(?:要)?(?:记住|记得|牢记)\s*[:：]?\s*(.+?)(?:[。！？!?]|$)/, key: '备忘', limit: VALUE_LIMIT_EXPLICIT },
    // 名字
    { re: /(?:我叫|我的名字(?:叫|是)?|名字是|本名是)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '名字', limit: VALUE_LIMIT_EXPLICIT },
    // 年龄
    { re: /我?(?:今年|现在)\s*(\d+)\s*岁/, key: '年龄', valueFrom: (m) => m[1] + '岁', limit: VALUE_LIMIT_NORMAL },
    // 喜欢
    { re: /我(?:最喜欢|超喜欢|特别喜欢|喜欢)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '喜欢', limit: VALUE_LIMIT_NORMAL },
    // 讨厌：允许逗号后省略「我」的口语写法（「我喜欢X，讨厌Y。」）
    { re: /(?<=^|[，,；;：:\s])我?(?:最讨厌|特别讨厌|讨厌|不喜欢)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '讨厌', limit: VALUE_LIMIT_NORMAL },
    // 位置（D3：排除「我在思考/我在想…」等认知活动——它们是心理活动，不是位置）
    { re: /我?(?:现在|正在|身处)?(?:在|身处)\s*[:：]?\s*(?!(?:思考|想|考虑|琢磨|回忆|怀疑|纠结|担心|盘算|寻思))(.+?)(?:[。！？!?，,]|$)/, key: '位置', limit: VALUE_LIMIT_NORMAL },
    // 目标
    { re: /我?(?:想去|要去|打算去|计划去)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '目标', limit: VALUE_LIMIT_NORMAL },
    // 泛化：我的X是Y → X 为键（D3：空泛键在提取主入口统一跳过）
    { re: /我的(.+?)(?:是|为)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: (m) => String(m[1] || '备忘').trim(), limit: VALUE_LIMIT_NORMAL }
];

/** 从用户消息提取事实列表 [{ key, value }]（纯函数，供单测）；同键同值去重 */
export function extractFacts(text) {
    const src = String(text || '');
    if (isExcluded(src)) return [];
    const facts = [];
    const seen = new Set();
    for (const rule of FACT_RULES) {
        const m = rule.re.exec(src);
        if (!m) continue;
        const key = typeof rule.key === 'function' ? rule.key(m) : rule.key;
        const raw = rule.valueFrom ? rule.valueFrom(m) : String(m[m.length - 1] || '').trim();
        if (!key || !raw) continue;
        // D3：空泛键直接跳过（「我的想法是…」类，泛化键不做值长度判断）
        if (VAGUE_KEYS.test(String(key))) continue;
        const value = clampValue(raw, rule.limit || VALUE_LIMIT_NORMAL);
        if (!value) continue;
        const sig = key + '\u0000' + value;
        if (seen.has(sig)) continue;   // 「记住X」与「你记住X」等重叠规则只记一次
        seen.add(sig);
        facts.push({ key, value });
    }
    return facts;
}

/** D2：query 切词 → 有效词列表（去停用词） */
export function tokenizeQuery(query) {
    const src = String(query || '');
    return src.split(/[\s,，。.!！?？;；:：、]+/).filter((w) => w && !STOP_WORDS.has(w));
}
