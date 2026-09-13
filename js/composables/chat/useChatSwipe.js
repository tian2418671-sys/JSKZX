/**
 * 泰卡酒馆式 swipe 与送代生成逻辑（多候选回复 / 开场白滑动 / 再生成 / 继续生成 / 重新生成）
 * 从 CardDetailView 抽离，保持视图文件精简、逻辑可测。
 * 纯函数式：传入状态与工厂，不直接依赖 Vue 响应式。
 */

/** 单条消息的显示文本：assistant 走 swipes 当前 index，其余取 content */
export function messageText(m) {
    if (m && m.role === 'assistant' && Array.isArray(m.swipes) && m.swipes.length) {
        const idx = Math.max(0, Math.min(Number(m.index) || 0, m.swipes.length - 1));
        return m.swipes[idx] || '';
    }
    return (m && m.content) || '';
}

/** 用字符数 4≈1 token 的粗估（与 tokenEstimate 对齐，仅用于本地提示） */
export function approxTokens(text) {
    return Math.ceil((text || '').length / 4);
}

/** 组装一条 assistant 消息的展示（用于模板绑定），含表情/序号等元信息 */
export function assistantView(m, charName) {
    const text = messageText(m);
    return {
        name: charName || 'AI',
        text,
        count: (m && m.swipes && m.swipes.length) || 1,
        index: (m && m.index) || 0,
        tokens: approxTokens(text)
    };
}

/** 横向滑动阈值判定：返回 -1 / 1 / 0（0=不切换） */
export function swipeDelta(startX, startY, endX, endY) {
    if (startX == null || startY == null || endX == null || endY == null) return 0;
    const dx = endX - startX;
    const dy = endY - startY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return 0;
    return dx < 0 ? 1 : -1; // 1=下一个, -1=上一个
}

/** 切换 index（带循环） */
export function shiftSwipe(m, delta) {
    if (!m || !Array.isArray(m.swipes) || m.swipes.length < 2) return m;
    const len = m.swipes.length;
    let next = ((m.index || 0) + delta) % len;
    if (next < 0) next += len;
    return { ...m, index: next };
}

/** 从云端回复对象提取文本（OpenAI / Anthropic 兼容） */
export function extractReplyText(res, type) {
    if (!res || !res.data) return '';
    const dd = res.data;
    if (type === 'anthropic') {
        return (dd.content && dd.content[0] && dd.content[0].text) || '';
    }
    return (dd.choices && dd.choices[0] && dd.choices[0].message && dd.choices[0].message.content) || '';
}

/** 把响应规整为候选文本（失败时给占位错误文本） */
export function replyToSwipe(res, type) {
    const text = extractReplyText(res, type);
    if (res && res.success && text) return text;
    return '⚠ ' + ((res && res.error) || '返回为空');
}