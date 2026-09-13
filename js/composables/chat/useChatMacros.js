/**
 * 宏替换引擎（对齐酒馆 SillyTavern 宏体系）
 * 在预设提示词、卡片描述、对话消息中替换 {{user}} {{char}} 等变量为实际值。
 *
 * 支持的宏：
 *   {{user}}         → 用户名
 *   {{char}}         → 角色卡名字
 *   {{description}}  → 角色卡描述
 *   {{personality}}  → 角色卡性格
 *   {{scenario}}     → 角色卡场景
 *   {{mes_example}}  → 角色卡对话示例
 *   {{first_mes}}    → 角色卡开场白
 *   {{persona}}      → 用户人设
 *   {{time}}         → 当前时间
 *   {{date}}         → 当前日期
 *   {{idle_duration}}→ 距最后一次用户消息的秒数(传入 lastActivityAt;缺省 0)
 */

/** 构建宏字典 */
export function buildMacroContext(card, userName, userPersona, lastActivityAt = 0) {
    const dd = (card && card.data && card.data.data) || {};
    const idleSec = lastActivityAt ? Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000)) : 0;
    return {
        '{{user}}': String(userName || '我'),
        '{{char}}': String((card && card.name) || dd.name || 'AI'),
        '{{description}}': String(dd.description || ''),
        '{{personality}}': String(dd.personality || ''),
        '{{scenario}}': String(dd.scenario || ''),
        '{{mes_example}}': String(dd.mes_example || ''),
        '{{first_mes}}': String(dd.first_mes || ''),
        '{{persona}}': String(userPersona || ''),
        '{{time}}': new Date().toTimeString().slice(0, 5),
        '{{date}}': new Date().toISOString().slice(0, 10),
        '{{idle_duration}}': String(idleSec),
    };
}

/**
 * 替换文本中的所有宏
 * @param {string} text - 原始文本
 * @param {Record<string,string>} ctx - buildMacroContext 返回的字典
 * @returns {string} 替换后的文本
 */
export function applyMacros(text, ctx) {
    if (!text || typeof text !== 'string') return text || '';
    let out = text;
    for (const [macro, value] of Object.entries(ctx)) {
        // 全局替换，大小写不敏感（酒馆宏不区分大小写）
        out = out.split(macro).join(value);
        const lower = macro.toLowerCase();
        if (lower !== macro) {
            out = out.split(lower).join(value);
        }
    }
    return out;
}
