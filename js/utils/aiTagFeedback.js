/**
 * 🏷️ 打标过程反馈（纯函数）：错误归类 + 失败聚合
 * ═════════════════════════════════════════════════════════════════
 * 背景（用户实测 2026-09-20）：打标完成弹窗只给原始 `HTTP 错误: 401 - {"message":"invalid API key"...}`，
 * 用户看不懂"为什么我关了（一层）还会调用大模型报错"。本模块把原始错误**归类为可读结论**：
 *   auth    → 密钥问题（401/403）→ 指引到设置检查密钥
 *   rate    → 限流（429）→ 重试建议
 *   network → 网络/超时/连不上
 *   format  → 模型没按格式返回
 *   other   → 原文兜底（截断）
 *
 * 同时提供 summarizeFailures：把失败清单按类别聚合（如「API 认证失败 ×8」），
 * 供「打标过程」实时日志窗口的收尾总结使用。
 *
 * 本模块纯函数：无 window / electronAPI / fetch。
 */

/** 归类原始错误信息 → { code, label }（label 为可直接面向用户的结论文案） */
export function classifyApiError(msg) {
    const raw = String(msg == null ? '' : msg).trim();
    const t = raw.toLowerCase();
    // 🔐 认证类（401 / invalid api key / authentication_error / unauthorized）——最常见的用户困惑源
    if (/401|invalid[ _-]?api[ _-]?key|invalid_api_key|authentication[_ -]?error|unauthorized/.test(t)) {
        return { code: 'auth', label: 'API 认证失败（密钥无效/过期）——请到「设置 → API」检查或重新粘贴密钥' };
    }
    if (/403|forbidden|permission[ _-]?denied/.test(t)) {
        return { code: 'auth', label: 'API 拒绝访问（403）：密钥无权限或被禁用' };
    }
    if (/429|rate[ _-]?limit|too many requests/.test(t)) {
        return { code: 'rate', label: '请求限流（429）：稍后重试或降低批量速度' };
    }
    if (/timeout|timed out|econnreset|econnrefused|fetch failed|network|aborted/i.test(t)) {
        return { code: 'network', label: '网络/超时/无法连接 API（检查接口地址与网络）' };
    }
    if (/未返回有效的\s*json/i.test(raw)) {
        return { code: 'format', label: '模型返回格式异常（未返回有效 JSON 数组）' };
    }
    return { code: 'other', label: raw.slice(0, 200) || '未知错误' };
}

/**
 * 失败清单 → 归类聚合行（如 ["API 认证失败（密钥无效/过期）——请到「设置 → API」检查或重新粘贴密钥 ×8"]）
 * @param {Array<{raw?:string}|string>} failReasons 失败项（对象取 raw，或直接字符串）
 */
export function summarizeFailures(failReasons) {
    const counts = new Map();
    for (const item of (Array.isArray(failReasons) ? failReasons : [])) {
        const raw = (item && typeof item === 'object') ? item.raw : item;
        const cls = classifyApiError(raw);
        const key = cls.label;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([label, n]) => `${label} ×${n}`);
}
