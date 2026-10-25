/**
 * 🏷️ 模型 ID 合法性判定（纯函数 · 可单测）
 *
 * 用途：`useChat.fetchAvailableModels` 拉取 `/v1/models` 后，过滤掉「不像模型名」的返回项。
 *
 * 背景（AI-21 / #hot-bug-1）：某些中转站的 `/v1/models` 会返回 `{id:"当前无可用模型"}` 这类
 * 提示语，旧代码只做 `.filter(Boolean)` ⇒ 垃圾串通过 ⇒ 覆盖用户已填的模型名并落盘。
 *
 * 判定规则（三条全部通过才算合法）：
 *   1. 长度 2~128 —— HuggingFace 完整路径（`organization/model-name-finetuned-xxxx-gguf`）
 *      实测可达 80~100 字符，上限放宽到 128 避免误杀；
 *   2. 字符集 `^[a-zA-Z0-9._\-:/@+]+$` —— 允许 Vertex AI 的 `@`（`claude-3-5-sonnet@20240620`）
 *      与部分中转的 `+`；同时天然拦截空格 / 换行 / 中文提示语 / HTML 标签（`<!DOCTYPE`）；
 *   3. 排除提示语（无可用 / 不可用 / 暂无 / 未找到 / not available / no model）与纯数字串。
 *
 * ⚠️ 本函数**只做「像不像」判断**，不代表模型真实可用。
 *    即使全部合法，也**不得**用它来覆盖用户的已选模型（真正的防线在调用方：
 *    「原值非空则绝不改写」）。
 *
 * 规格：`docs/规格与计划/功能规格/G1-拉取模型列表静默覆盖-修复规格.md`
 */

/** 模型 ID 允许的字符集（长度在 isLikelyModelId 内单独判，便于报错定位） */
export const MODEL_ID_RE = /^[a-zA-Z0-9._\-:/@+]+$/;

/** 服务端「没有可用模型」类提示语（大小写不敏感） */
export const JUNK_HINTS = /无可用|不可用|暂无|未找到|not\s*available|no\s*model|not\s*found/i;

export const MODEL_ID_MIN_LEN = 2;
export const MODEL_ID_MAX_LEN = 128;

/**
 * 判断一个字符串是否「像模型 ID」
 * @param {*} s
 * @returns {boolean}
 */
export function isLikelyModelId(s) {
    if (typeof s !== 'string') return false;
    // ⚠️ 顺序要紧：**先拦掉内部空白**，再只容忍「首尾普通空格」。
    //    若先 trim 再校验，`'gpt-4o\n'` 会被 trim 成 `'gpt-4o'` 而蒙混过关（实测踩到）。
    if (/[\r\n\t\f\v]/.test(s)) return false;
    const v = s.trim();
    if (v.length < MODEL_ID_MIN_LEN || v.length > MODEL_ID_MAX_LEN) return false;
    if (!MODEL_ID_RE.test(v)) return false;   // 内部空格也会在这里被拦（字符集不含空格）
    if (JUNK_HINTS.test(v)) return false;
    if (/^\d+$/.test(v)) return false;       // 纯数字多为错误码
    return true;
}

/**
 * 过滤原始列表，返回 { valid, rejected }
 * @param {Array<*>} rawList
 * @returns {{ valid: string[], rejected: string[] }}
 */
export function partitionModelIds(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const valid = [];
    const rejected = [];
    for (const item of list) {
        const s = typeof item === 'string' ? item.trim() : '';
        if (isLikelyModelId(s)) valid.push(s);
        else rejected.push(String(item));
    }
    return { valid, rejected };
}
