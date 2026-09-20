/**
 * 打标三层漏斗（① 规则匹配 → ② 本地向量 → ③ LLM 兜底）的**层决策**纯函数集。
 *
 * 为什么要单独抽一层：
 *   `useAITools.startAITagging()` 依赖 `window.electronAPI`（IPC / 向量引擎），整函数难以单测；
 *   而"某一层该不该跑"是纯逻辑 —— 抽到这里后既可以单测，又能让 UI（按钮可用性、菜单状态提示）
 *   与引擎（实际是否执行）**共用同一个判定**，避免出现「按钮说能跑、引擎却不跑」的不一致。
 *
 * 零 Vue / 零 Electron 依赖，可 `node --test` 直接测。
 * 消费方：`useAITools.js`（引擎短路）、`AITagModal.vue`（开始按钮可用性 + 管线区）、
 *        `HeaderBar.vue`（编辑菜单状态提示）、`useConfigPersistence.js`（落盘归一化）。
 *
 * 规格：`docs/规格与计划/打标三层开关-P1实现规格.md` §3.2
 */

/**
 * 默认三层开关：**唯一默认值来源**（UI / 持久化 / 容错共用，改这里即全局生效）。
 * ⚠️ `vector` 默认为 false：与改动前 `useLocalVector = ref(false)` 的行为一致。
 *    若默认 true，老用户重启后会突然开始下载 ~120MB 向量模型 —— 属静默行为变化，禁止。
 */
export const DEFAULT_TAG_FUNNEL = Object.freeze({ rule: true, vector: false, llm: true });

/** 三层开关的键名（顺序即 UI 展示顺序） */
const FUNNEL_KEYS = ['rule', 'vector', 'llm'];

/**
 * 归一化三层开关：非对象 / 缺键 / 非布尔 → 逐键回落默认值（**不抛错**）。
 * @param {any} raw 配置里的原始值（可能来自老配置、手改坏的文件）
 * @returns {{rule: boolean, vector: boolean, llm: boolean}} 新对象（不返回 DEFAULT_TAG_FUNNEL 引用，防调用方改坏默认值）
 */
export function normalizeTagFunnel(raw) {
    const out = { ...DEFAULT_TAG_FUNNEL };
    if (raw && typeof raw === 'object') {
        for (const k of FUNNEL_KEYS) {
            if (typeof raw[k] === 'boolean') out[k] = raw[k];
        }
    }
    return out;
}

/**
 * 归一化「内置规则关闭清单」：仅保留非空字符串，trim + 去重（保持插入顺序）。
 * @param {any} raw
 * @returns {string[]}
 */
export function normalizeDisabledRules(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const s = item.trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/**
 * 三层是否全部关闭（UI 禁用「开始打标」与引擎入口拦截**共用**此函数）。
 * @param {any} funnel
 * @returns {boolean}
 */
export function isFunnelEmpty(funnel) {
    const f = normalizeTagFunnel(funnel);
    return !f.rule && !f.vector && !f.llm;
}

/**
 * 解析本次打标的「执行计划」：把"用户开关"与"运行条件"合成"到底跑哪几层"。
 *
 * 判定顺序（**不要改**，否则会出现"关掉的层仍被计入"）：
 *   1. rule   = funnel.rule
 *   2. vector = funnel.vector && vectorReady && hasCandidateTags（不成立时给出 skip 原因）
 *   3. llm    = funnel.llm && hasApiConfig（不成立时给出 skip 原因）
 *
 * ⚠️ 关键契约：`vectorReady` 只影响"②能不能跑"，**绝不影响**"①是否执行"——
 *    层与层之间不得互相短路（历史缺陷 AI-02：曾把"规则命中就跳过向量"写死）。
 *
 * @param {object} p
 * @param {any} p.funnel               三层开关
 * @param {boolean} [p.vectorReady]    向量模型是否已就绪（vectorStatus.ready）
 * @param {boolean} [p.hasCandidateTags] 候选标签池是否非空
 * @param {boolean} [p.hasApiConfig]   API 是否已配置
 * @returns {{rule: boolean, vector: boolean, llm: boolean, skip: {vector?: string, llm?: string}}}
 */
export function resolveFunnelPlan({ funnel, vectorReady, hasCandidateTags, hasApiConfig } = {}) {
    const f = normalizeTagFunnel(funnel);
    const skip = {};

    let vector = false;
    if (f.vector) {
        if (!vectorReady) skip.vector = '模型未就绪';
        else if (!hasCandidateTags) skip.vector = '候选标签池为空';
        else vector = true;
    }

    let llm = false;
    if (f.llm) {
        if (!hasApiConfig) skip.llm = '未配置 API';
        else llm = true;
    }

    return { rule: f.rule, vector, llm, skip };
}

/**
 * 组装打标结果文案（含「已跳过」与「未处理」），纯函数便于单测。
 * @param {{rule?: number, vector?: number, llm?: number, unprocessed?: number}} stats
 * @param {{rule: boolean, vector: boolean, llm: boolean, skip?: object}} plan
 * @returns {string}
 */
export function formatFunnelSummary(stats, plan) {
    const s = stats || {};
    const p = plan || {};
    const skipOf = p.skip || {};

    let msg = `🎉 打标完成！\n① 规则命中: ${s.rule || 0} | ② 向量命中: ${s.vector || 0} | ③ LLM: ${s.llm || 0}`;

    const skipped = [];
    if (!p.rule) skipped.push('① 规则层');
    if (!p.vector) skipped.push(`② 向量层（${skipOf.vector || '已关闭'}）`);
    if (!p.llm) skipped.push(`③ LLM 层（${skipOf.llm || '已关闭'}）`);
    if (skipped.length) msg += `\n⏭️ 已跳过: ${skipped.join(' | ')}`;

    if (s.unprocessed > 0) msg += `\n⚠️ 未处理: ${s.unprocessed} 张（③ LLM 层未执行）`;

    return msg;
}

/**
 * 生成"当前策略"短标签（编辑菜单状态提示用）：如 `规则✓ 向量✗ AI✓`。
 * @param {any} funnel
 * @returns {string}
 */
export function formatFunnelBadge(funnel) {
    const f = normalizeTagFunnel(funnel);
    const mark = (on) => (on ? '✓' : '✗');
    return `规则${mark(f.rule)} 向量${mark(f.vector)} AI${mark(f.llm)}`;
}
