/**
 * 🏷️ AI 打标 · **LLM 层「单套提示词链路」+ 结构化输出截取**（第二批改造 · D1~D14）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📖 本模块解决什么：**单套链路**（System → User → 预填充）+ 结构化输出截取
 * （第二批改造方案：`docs/规格与计划/AI打标/AI打标-提示词改造与批量提量方案.md`）
 * ───────────────────────────────────────────────────────────────
 * 🔴 **病根 1（R1）**：现有解析是 `rawReply.match(/\[[\s\S]*\]/)` —— **贪婪匹配**，
 *    取「第一个 `[`」到「最后一个 `]`」。而**思考型模型**（GLM / DeepSeek-V4 / 商汤）
 *    会先输出思维链，链里的方括号（示例 JSON、编号列表 `[1]`）会被**取错区间** ⇒ 标签乱。
 * ✅ 修：**结构化输出契约** —— 让模型把结果包在 `<tags>[...]</tags>` 里，
 *    解析用**非贪婪**精确边界；再保留两层降级（JSON 正则 → 暴力拆分），任一层成功即可。
 *
 * � **链路（2026-09-25 定稿）**：⚠️ 破限（拼到 System 末尾）→ 🧠 System → 👤 User → ⚡ 预填充（可选）
 *
 * · **单套**：全局只有一套提示词（`llmRolePrompts = { system, user, prefill }`）——
 *   预设库 / 五小页签 / Assistant 段 / 思维链段 **全部取消**（D2 / D14）。
 *
 * · `<tags>` 三层解析 / 剥思考块（`思考…` / `<thinking>…</thinking>`）/ 预填充 ——
 *   与上一批（R1+R2）一致，未动；解析前先剥思考块，剥完失败回退原始文本。
 *
 * · **降级重试简化为两级**（Assistant 取消后不再需要「去思维链」档）：
 *   ① 全量（含预填充） ② 去预填充。
 *
 * ═══════════════════════════════════════════════════════════════
 * 🎚️ **启用条件（用户 2026-09-24 明确指定）**
 * ───────────────────────────────────────────────────────────────
 * > 「挡规则，向量不启动时只启动 llm 的打标机制，则进行三层的思维链……
 * >   当只有 LLM 层单独启动时才启动 R1 的结构截取功能」
 *
 * ⇒ 仅当 **① 规则关 且 ② 向量关 且 ③ LLM 开**（`isLlmOnlyPlan()`）时，
 *   才启用「分角色链路 + 结构化截取」。
 *   其他组合（如 规则+LLM 同时开）**保持原有行为不变**（避免影响既有打标链路）。
 *
 * ⚠️ 为什么这样切：分角色结构是为「**纯 LLM 打标**」设计的（用户想让模型先思考再输出）；
 *    而规则/向量层命中时会直接写入标签，混用两套解析语义会让「标签来源」变得不可预测。
 *    ⇒ **按执行计划分流**，语义清晰且零回归风险。
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔑 兼容性（重要）
 * ───────────────────────────────────────────────────────────────
 * · **旧预设库数据保留在配置文件**（不删、可回滚）；首次启动用 `migrateLegacyPresets()`
 *   把「当前生效预设」搬进新单套链路。
 * · **`main.js` 无需改动**：`chat:send` 对 OpenAI 协议**原样透传 messages**，
 *   Anthropic 协议挑出 `system` 后其余原样传 ⇒ `assistant` 消息天然支持（方案 S7 已核实）。
 * · **预填充可能被中转站忽略 / 拒绝**：故保留「两层降级重试」+ `parseStructuredTags`
 *   的三层解析防线（预填充失效时模型仍会输出完整 JSON，第 ② 层能兜住）。
 *
 * 零 Vue / 零 Electron 依赖，可 `node --test` 直接测。
 */

/** 🏷️ 结构化输出的标签名（默认英文，模型训练数据里 XML 风格常见，遵守率更高） */
export const TAG_WRAPPER = 'tags';
/** 解析时同时兼容的中文标签名（照顾中文用户手写预设） */
export const TAG_WRAPPER_ALT = '标签';

/** 预填充默认值：模型会从 `<tags>[` 之后接着写，天然不含解释文字 */
export const DEFAULT_PREFILL = `<${TAG_WRAPPER}>[`;

// ═══════════════════════════════════════════════════════════════
// 🧠 System 默认文案 + 预设套用变体（D12）
// ═══════════════════════════════════════════════════════════════

/**
 * **System 默认文案**（§3.5 · 按真实卡字段重写）——
 * 用于：① 新装默认值；② 迁移无可用内容时的兜底；③ 「🎯 标准打标」变体。
 */
export const DEFAULT_SYSTEM_PROMPT = `你是「角色卡标签分析助手」，为 SillyTavern 角色卡生成便于检索的标签。
你会收到以下几类材料：
- 描述（description）：主要信息源；常含结构化设定（全名 / 别名 / 种族 / 年龄 / 外貌）与世界观段落；
- 首句（first_mes）：开场剧情 —— 用于判断场景、氛围与互动基调；
- 性格（personality）：可能为空，有则参考；
- 卡名：常含身份或称号；
- 如另附对话示例 / 世界书内容，一并参考。
打标原则：
1. 只依据材料中真实出现或可直接推断的内容，不脑补、不臆造；
2. 标签为简短中文词或词组（2~6 字），不写句子、不堆同义词；
3. 覆盖维度：题材 / 世界观、身份与职业、性格与气质、外貌特征、能力与特殊设定、关系与阵营、氛围与风格；
4. 避免过泛（如「女性」「有趣」）；卡库常用「大类/子类」写法（如「仙侠/修真」），候选池里有的优先复用，没有再用自己的词。
5. 输出前先在内部完成推理（题材 → 身份 → 关键词 → 归纳），只输出最终标签，不输出推理过程。`;

/** System 预设套用：3 个内置变体 + 末项「✏️ 自定义」（文案为草案，可随时改） */
export const SYSTEM_PROMPT_VARIANTS = [
    { id: 'standard', name: '🎯 标准打标（默认）', content: DEFAULT_SYSTEM_PROMPT },
    {
        id: 'deep',
        name: '🧭 深度解析（设定厚卡 / 长卡）',
        content: DEFAULT_SYSTEM_PROMPT.replace(
            '2. 标签为简短中文词或词组（2~6 字），不写句子、不堆同义词；',
            '2. 标签为简短中文词或词组（2~6 字），不写句子；设定厚的卡输出 10~15 个更细的标签（外貌细节 / 能力体系 / 关系网 / 场景元素），但不要堆同义词；'
        )
    },
    {
        id: 'brief',
        name: '✂️ 精简标签（只要核心 5~8 个）',
        content: DEFAULT_SYSTEM_PROMPT.replace(
            '2. 标签为简短中文词或词组（2~6 字），不写句子、不堆同义词；',
            '2. 标签为简短中文词或词组（2~6 字）；只保留最核心的 5~8 个标签，宁缺毋滥，同类合并；'
        )
    }
];

/**
 * 判断当前 System 文本命中了哪个内置变体（供下拉框回显）；
 * 与任何一个变体都不完全一致 → `'custom'`（✏️ 自定义）。
 * @param {string} system
 * @returns {string} 变体 id 或 'custom'
 */
export function resolveSystemVariantId(system) {
    const s = String(system == null ? '' : system);
    const hit = SYSTEM_PROMPT_VARIANTS.find(v => v.content === s);
    return hit ? hit.id : 'custom';
}

// ═══════════════════════════════════════════════════════════════
// 📝 数据归一化 + 旧预设库迁移
// ═══════════════════════════════════════════════════════════════

/**
 * 归一化「单套提示词链路」对象（容错调用方传入 undefined / 脏值）。
 * ⚠️ 注意：**`prefill` 为空字符串 = 关闭预填充**（不是「用默认」）——
 *    默认值（`<tags>[`）在迁移 / 新装时写入，运行期以用户当前值为准。
 * @param {object} raw
 * @returns {{system:string, user:string, prefill:string}}
 */
export function normalizeRolePrompts(raw) {
    const p = (raw && typeof raw === 'object') ? raw : {};
    return {
        system: typeof p.system === 'string' ? p.system : '',
        user: typeof p.user === 'string' ? p.user : '',
        prefill: typeof p.prefill === 'string' ? p.prefill : ''
    };
}

/**
 * 迁移：旧「预设库」→ 新单套链路（取当前生效预设 = 列表第一条）。
 * 缺失字段的兜底：`system` 空 → `DEFAULT_SYSTEM_PROMPT`；`prefill` 空 → `DEFAULT_PREFILL`。
 * 旧数据本身**留在配置文件里不动**（可回滚）。
 * @param {Array} list 旧 `systemPromptPresets`
 * @returns {{system:string, user:string, prefill:string}}
 */
export function migrateLegacyPresets(list) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    const p = arr[0] || {};
    const system = (typeof p.system === 'string' && p.system.trim())
        ? p.system
        : (typeof p.content === 'string' ? p.content : '');
    return {
        system: system.trim() ? system : DEFAULT_SYSTEM_PROMPT,
        user: typeof p.user === 'string' ? p.user : '',
        prefill: (typeof p.prefill === 'string' && p.prefill.trim()) ? p.prefill : DEFAULT_PREFILL
    };
}

/**
 * 思考型模型会把推理包在这些标签里（大小写不敏感）。
 * 解析前先剥掉，减少噪声；**剥完解析失败则回退到原始文本**（防误剥真结果）。
 */
export const THINK_BLOCK_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'analysis', '思考', '推理', '分析'];

/**
 * 剥掉模型输出的「思考块」。
 *
 * 支持两种常见包裹形式（都是实测见过的）：
 * · **尖括号**：` thinking…` / `<thinking>…</thinking>` / `<reasoning>…</reasoning>`
 * · **中文方头括号**：`【思考】…【/思考】` / `【推理】…【/推理】`（部分中文模型用这个）
 *
 * @param {string} text
 * @returns {string}
 */
export function stripThinkingBlocks(text) {
    let out = String(text == null ? '' : text);
    for (const name of THINK_BLOCK_NAMES) {
        // ① 尖括号形式：<name>…</name>
        out = out.replace(new RegExp(`<\\s*${name}\\s*>[\\s\\S]*?<\\s*/\\s*${name}\\s*>`, 'gi'), '');
        // ② 中文方头括号形式：【name】…【/name】
        out = out.replace(new RegExp(`【\\s*${name}\\s*】[\\s\\S]*?【\\s*/\\s*${name}\\s*】`, 'g'), '');
    }
    return out.trim();
}

// ═══════════════════════════════════════════════════════════════
// 🎚️ 启用条件判定
// ═══════════════════════════════════════════════════════════════

/**
 * 本次执行计划是否**只有 LLM 层**（① 规则关 且 ② 向量关 且 ③ LLM 开）。
 *
 * ⚠️ 这是「分角色结构 + R1 结构化截取」的**唯一启用条件**（用户明确指定）。
 *
 * @param {{rule?:boolean, vector?:boolean, llm?:boolean}} plan `resolveFunnelPlan()` 的结果
 * @returns {boolean}
 */
export function isLlmOnlyPlan(plan) {
    const p = plan || {};
    return p.rule === false && p.vector === false && p.llm === true;
}

// ═══════════════════════════════════════════════════════════════
// 🧩 消息组装（单套：System → User → 预填充）
// ═══════════════════════════════════════════════════════════════

/**
 * 组装 LLM 打标的消息数组（分角色链路，第二批改造版）。
 *
 * 消息顺序（与方案 §3.3 一致）：
 * ```text
 * [ system: 主提示词 + 破限 ]                              ← 破限拼在末尾（注意力权重最高）
 * [ user:   预设 user 段 或 程序生成的默认（候选池 + 卡片数据 + 输出要求） ]
 * [ assistant: 预填充（如 `<tags>[`） ]                     ← 可选，必须放最后
 * ```
 *
 * @param {object} p
 * @param {object} p.rolePrompts 单套提示词（`{system, user, prefill}`）
 * @param {string} [p.jailbreak] 破限词（非空则追加到 system 末尾）
 * @param {string} p.defaultUser 程序生成的默认 user 内容（预设 user 段为空时使用）
 * @param {boolean} [p.usePrefill] 是否使用预填充（false = 不用，用于「预填充被拒后重试」）
 * @returns {Array<{role:string, content:string}>}
 */
export function buildLlmMessages({ rolePrompts, jailbreak, defaultUser, usePrefill = true } = {}) {
    const p = normalizeRolePrompts(rolePrompts);
    const msgs = [];

    // ① system：主提示词 + 破限（破限**必须**在末尾 —— 注意力权重最高）
    let sys = p.system || '';
    const jb = String(jailbreak || '').trim();
    if (jb) sys = sys ? `${sys}\n\n${jb}` : jb;
    if (sys.trim()) msgs.push({ role: 'system', content: sys });

    // ② user：预设优先，留空用程序默认
    const userContent = p.user.trim() ? p.user : String(defaultUser || '');
    if (userContent.trim()) msgs.push({ role: 'user', content: userContent });

    // ③ assistant：预填充（可选，放最后 —— 紧邻模型输出位置）
    if (usePrefill && p.prefill.trim()) msgs.push({ role: 'assistant', content: p.prefill });

    return msgs;
}

/**
 * 本次是否**实际会用到预填充**（供「预填充失败后重试」判断，避免无意义重试）。
 * @param {object} rolePrompts
 * @returns {boolean}
 */
export function willUsePrefill(rolePrompts) {
    return normalizeRolePrompts(rolePrompts).prefill.trim().length > 0;
}

// ═══════════════════════════════════════════════════════════════
// 🔍 R1 · 结构化输出解析（三层降级）
// ═══════════════════════════════════════════════════════════════

/**
 * 从模型回复里解析标签数组（**三层降级**，任一层成功即可）。
 *
 * | 层 | 手段 | 适用 |
 * |---|---|---|
 * | ① | `<tags>…</tags>` / `<标签>…</标签>` **非贪婪**精确边界 | 新契约（默认） |
 * | ② | 现有 `\[[\s\S]*\]` JSON 数组正则 | 旧格式 / 模型不遵守 |
 * | ③ | 按 `[,，、\n]` 暴力拆分 | 最后兜底 |
 *
 * ⚠️ **第 ① 层用非贪婪 `([\s\S]*?)`** —— 这是修复「思考型模型思维链污染」的关键：
 *    贪婪匹配会取「第一个 `[`」到「最后一个 `]`」，思维链里的方括号会污染区间。
 *
 * 🧩 **预填充拼接（2026-09-25 根治 · AI-10）**：当 assistant 预填充存在时（如 `<tags>[`），
 *    模型回复是**续写**（只有 `…标签…</tags>`，不含开头标记）——若按原文解析，层①②
 *    必然够不着（开头在预填充里）→ 全部被推给③兜底（实测：每张卡都走③、`</tags>` 被当标签）。
 *    根治：把组装侧已知的**实际预填充**（`opts.prefill`）拼回来再解析 —— 「回复=续写」的假设
 *    在发送侧与解析侧对齐，①②按设计正常命中；③回归「真乱写才用」的最后防线。
 *    🛡️ 原文已含完整包裹（模型重写了开头）时不拼接，既有行为不变。
 *
 * @param {string} rawReply 模型原始回复（不含预填充）
 * @param {{prefill?:string}} [opts] `prefill` = 本次请求**实际使用**的预填充文本（空 = 未用）
 * @returns {{tags:string[], layer:1|2|3, ok:boolean, reason?:string}}
 *   `layer` = 实际命中的层（1/2/3）；`ok=false` 时 `tags=[]`
 */
export function parseStructuredTags(rawReply, opts = {}) {
    const original = String(rawReply == null ? '' : rawReply).trim();
    if (!original) return { tags: [], layer: 3, ok: false, reason: '回复为空' };

    const tryParse = (text) => {
        // 🧠 先剥「思考块」（`思考…` / `<thinking>…</thinking>`）—— 减少思维链噪声。
        //    🛡️ 剥完后解析失败 → 回退用未剥文本再解析（防误剥真结果）。
        const stripped = stripThinkingBlocks(text);
        if (stripped && stripped !== text) {
            const r = parseFromCleanText(stripped);
            if (r.ok) return r;
        }
        return parseFromCleanText(text);
    };

    // 候选顺序：① 拼回预填充的全文（回复=续写的常规情形）→ ② 原始回复（回退，保既有行为）
    const pf = String(opts.prefill == null ? '' : opts.prefill).replace(/\s+$/, '');
    const hasWrapper = /<\s*(?:tags?|标签)\s*>[\s\S]*?<\s*\/\s*(?:tags?|标签)\s*>/i.test(original);
    if (pf && !hasWrapper) {
        const r = tryParse(pf + original);
        if (r.ok) return r;
    }
    return tryParse(original);
}

/**
 * 从「已剥思考块」的文本里解析标签（**三层降级**，任一层成功即可）。
 *
 * | 层 | 手段 |
 * |---|---|
 * | ① | `<tags>…</tags>` / `<标签>…</标签>` 精确边界（**取最后一个有效包裹**） |
 * | ② | JSON 数组正则（**从后往前**找第一个能解析成数组的方括号组 → 贪婪兜底处理嵌套） |
 * | ③ | 按 `[,，、\n]` 暴力拆分 |
 *
 * @param {string} raw
 * @returns {{tags:string[], layer:1|2|3, ok:boolean, reason?:string}}
 */
function parseFromCleanText(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (!text) return { tags: [], layer: 3, ok: false, reason: '回复为空' };

    // 先剥 markdown 代码围栏（模型常把 JSON 包在 ``` 里）
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // ── 层①：结构化标签（精确边界 + **取最后一个有效包裹**）──
    //   ⚠️ 为什么要「最后一个」而不是「第一个」：**思考型模型**常在思维链里先给
    //      「示例：<tags>["示例"]</tags>」，再给真正结果。取第一个会**把示例当结果**
    //      （与 R1 要修的「思维链污染」是同一类病）。
    //   同时兼容 <tags> 与 <标签>（大小写不敏感）。
    const wrapperRe = new RegExp(
        `<\\s*(?:${TAG_WRAPPER}|${TAG_WRAPPER_ALT})\\s*>([\\s\\S]*?)<\\s*/\\s*(?:${TAG_WRAPPER}|${TAG_WRAPPER_ALT})\\s*>`,
        'gi'
    );
    const wraps = Array.from(text.matchAll(wrapperRe));
    // ①-a 优先：包裹内是**合法 JSON 数组**的（从后往前找 —— 真答案通常在最末）
    for (let i = wraps.length - 1; i >= 0; i--) {
        const arr = parseJsonArray(wraps[i][1]);
        if (arr.length) return { tags: arr, layer: 1, ok: true };
    }
    // ①-b 退一步：包裹内是**纯文本列表**（如 `奇幻, 骑士`）—— 同样从后往前
    for (let i = wraps.length - 1; i >= 0; i--) {
        const arr = parseArrayLike(wraps[i][1]);
        if (arr.length) return { tags: arr, layer: 1, ok: true };
    }

    // ── 层②：JSON 数组正则（旧格式 / 模型不遵守 <tags>）──
    //   ⚠️ 同样**从后往前**找第一个「能解析成数组」的方括号组 ——
    //      思维链里的 `[1]`、`["示例"]` 会被自动跳过（非数组或非法 JSON）。
    const brackets = Array.from(text.matchAll(/\[[\s\S]*?\]/g));
    for (let i = brackets.length - 1; i >= 0; i--) {
        const arr = parseJsonArray(brackets[i][0]);
        if (arr.length) return { tags: arr, layer: 2, ok: true };
    }
    // ②-b 二次兜底：**贪婪**匹配（处理嵌套数组 `["a",["b"]]` —— 非贪婪会截断成非法 JSON）
    const greedy = text.match(/\[[\s\S]*\]/);
    if (greedy) {
        const arr = parseJsonArray(greedy[0]);
        if (arr.length) return { tags: arr, layer: 2, ok: true };
    }

    // ── 层③：暴力拆分（最后兜底）──
    //   ⚠️ 只有前两层都失败才走这里 —— 它**无法区分标签与解释文字**，是最脏的一层
    //   🧽 结果必须过 sanitizeTagList（AI-10 实测：模型续写常残留 `</tags>`、中文引号、中文字间空格，
    //      不清理会被当成标签物理写入卡）
    const brute = sanitizeTagList(text.split(/[,，、\n]/));
    if (brute.length) return { tags: brute, layer: 3, ok: true };
    return { tags: [], layer: 3, ok: false, reason: '三层解析均未取到标签' };
}

/**
 * **严格**解析 JSON 数组（仅接受合法 JSON 数组 / JSON 字符串，不做标点拆分）。
 * 用于「从后往前找第一个真正是数组的候选」——避免把思维链里的 `[1]` / 解释文字当标签。
 * @param {string} text
 * @returns {string[]} 解析失败返回 `[]`
 */
function parseJsonArray(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
            // 展平嵌套数组（模型偶尔会输出 `["a",["b"]]`）→ 全部转成字符串标签
            return parsed.flat(Infinity).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
        }
        if (typeof parsed === 'string') return [parsed.trim()].filter(Boolean);
    } catch (e) { /* 非合法 JSON → 交给下一候选 */ }
    return [];
}

/**
 * 把「类数组」文本解析成字符串数组（容错 JSON 与纯文本列表两种形态）。
 * @param {string} text
 * @returns {string[]}
 */
function parseArrayLike(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    // 优先按 JSON 解析（`["a","b"]`）
    try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
        if (typeof parsed === 'string') return [parsed.trim()].filter(Boolean);
    } catch (e) { /* 不是 JSON，继续 */ }
    // 退化为「按标点拆分」（`a, b, c` 或 `a、b`）—— 统一过 sanitizeTagList
    // （🧩 根治配套：预填充拼接后，层①-b「包裹内纯文本」成为常规命中路径——如 `<tags>[现代/…、</tags>`；
    //   若不过清洗，`[`、中文字间空格等会随标签落盘）
    return sanitizeTagList(t.split(/[,，、\n]/));
}

/**
 * 🧽 标签清洗：把「准标签」列表过一遍统一清理 → 干净、去重（保序）的标签数组。
 *
 * 第③层（暴力拆分）拿到的就是**模型最不守规矩**的输出——它无法区分「标签」与「解释文字」，
 * 因此约束必须**按最脏输入设计，一次做全**（2026-09-25 真实打标实测 · AI-10）：
 *   A. 字符级：白空格变形（NBSP / 全角空格 / 零宽 / Tab）归一 → 剥 `<tags>/</tags>/<标签>` 包装标记
 *      → 剥引号（中英 `“”‘’「」『』` 与 ASCII）与方括号 → 剥 Markdown 粗斜体（`**` / `__`）
 *      → 剥行首列表符 / 编号（`- ` / `• ` / `1. ` / `2、`）→ 剥首尾残留标点（`、，,；;：:。`）
 *      → 折叠斜杠两侧与中文字间空格；
 *   B. 项级门槛：空项 / 纯标记 / 纯数字 / 超长（> 40 字符，基本是解释文字）→ 直接丢弃；
 *   C. 去重（保序）。
 *
 * @param {Iterable<string>} list 准标签列表（可为任意脏值）
 * @returns {string[]}
 */
export function sanitizeTagList(list) {
    const out = [];
    const seen = new Set();
    const MARK_RE = /<\s*\/?\s*(?:tags?|标签)\s*>/gi;
    const MAX_TAG_LEN = 40; // 超长项基本是解释文字（正常标签 ≤ 20 字），宁缺毋滥
    for (const raw of Array.isArray(list) ? list : []) {
        // ── A. 字符级清理 ──
        let t = String(raw == null ? '' : raw)
            .replace(/[\u00a0\u3000]/g, ' ')            // NBSP / 全角空格 → 普通空格
            .replace(/[\u200b-\u200d\ufeff]/g, '')      // 零宽字符删除
            .replace(/\t/g, ' ')                        // Tab → 空格
            .trim();
        if (!t) continue;
        t = t.replace(MARK_RE, '');                     // 剥包装标记（含 `</tags>` 残留）
        t = t.replace(/[\[\]"'`“”‘’「」『』]/g, '');     // 剥引号 / 方括号（中英 + 全角变体）
        t = t.replace(/[*_]+/g, '');                    // 剥 Markdown 粗斜体（`**粗体**` / `__` / `_斜体_`）
        t = t.replace(/^[-•·]+\s+/, '');                // 行首列表符（- • ·；`*` 已在上一步剥掉）
        t = t.replace(/^\d+[.、)）]\s*/, '');            // 行首编号（1. / 1、 / 1)）
        t = t.replace(/^[、，,；;：:。]+/, '');           // 首部残留标点
        t = t.replace(/[、，,；;：:。]+$/, '');           // 尾部残留标点（ASCII `.` 不剥，防误伤 v1.2）
        t = t.replace(/\s*\/\s*/g, '/');                // 斜杠两侧空格折叠
        t = t.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, ''); // 中文字间空格折叠
        t = t.trim();
        // ── B. 项级门槛 ──
        if (!t) continue;                               // 空 / 纯标记
        if (/^\d+$/.test(t)) continue;                  // 纯数字（编号残留）
        if (t.length > MAX_TAG_LEN) continue;           // 超长（疑似解释文字）
        // ── C. 去重（保序）──
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════
// 📢 结构化输出的「提示词片段」（注入到 user 段，告诉模型用标签包裹）
// ═══════════════════════════════════════════════════════════════

/**
 * 生成「输出格式要求」片段（追加到 user 末尾）。
 * @param {boolean} structured 是否要求结构化包裹（仅 LLM 单独启动时为 true）
 * @returns {string}
 */
export function outputFormatRule(structured) {
    if (structured) {
        return `【输出强制规则】：必须且只能返回一个 JSON 数组，并用 <${TAG_WRAPPER}> 标签包裹，格式严格为：\n`
            + `<${TAG_WRAPPER}>["标签1", "标签2"]</${TAG_WRAPPER}>\n`
            + `绝对不要包含 markdown 代码标记、前后解释文字或任何其他内容。`;
    }
    return `【输出强制规则】：必须只返回格式为 ["标签1", "标签2"] 的纯 JSON 数组，绝不要包含 markdown 标记或任何前导/后置解释文字。`;
}

// ═══════════════════════════════════════════════════════════════
// 📦 打包（多卡一次请求）· 输出规则 + 拆回解析（第二批改造 · 提量）
// ═══════════════════════════════════════════════════════════════

/**
 * 生成「多卡输出格式」要求片段（追加到打包请求的 user 末尾）。
 * 格式：`<tags>{"1": ["标签A"], "2": [...]}</tags>` —— 键 = 卡片编号（从 1 开始）。
 *
 * ⚠️ 为什么用**对象**而不是数组（`[["a"],["b"]]`）：
 *    对象键**显式**，模型漏掉/合并某张卡时可被逐卡校验发现；
 *    数组则可能错位（把第 3 张的标签放到第 2 位）而无法察觉。
 * @param {number} count 本包卡片数
 * @returns {string}
 */
export function packedOutputRule(count) {
    const n = Math.max(1, Number(count) || 1);
    return `【多卡输出格式】：本次共 ${n} 张卡片（编号 1~${n}）。必须且只能返回一个 JSON 对象，并用 <${TAG_WRAPPER}> 标签包裹，格式严格为：\n`
        + `<${TAG_WRAPPER}>{"1": ["标签1", "标签2"], "2": ["标签1"], ...}</${TAG_WRAPPER}>\n`
        + `键 = 卡片编号（从 1 开始，每张卡都要有一项），值 = 该卡片的标签数组。绝对不要包含 markdown 代码标记、前后解释文字或任何其他内容。`;
}

/**
 * 解析打包请求的回复 → `{ ok, map }`。
 *
 * `map` 的键为**卡片编号字符串**（`'1'`、`'2'`…），值为字符串数组。
 * 解析策略（宽松 → 严格多候选，任一成功即可）：
 *   ① `<tags>…</tags>` 包裹体（取**最后一个**有效包裹，防思维链里的示例污染）；
 *   ② 包裹体 JSON.parse 成功且为「对象 → 值转数组」或「数组的数组 → 按序号映射」；
 *   ③ 失败则回退裸文本（整体 / 最后一个 `{…}` / 最后一个 `[…]`）。
 *
 * ⚠️ 调用方必须**逐卡校验**（某一编号缺失 = 该卡拆回单发重试），不能把整包失败当成功。
 *
 * @param {string} rawReply 模型原始回复
 * @returns {{ok:boolean, map:Object<string,string[]>, reason?:string}}
 */
export function parsePackedTags(rawReply) {
    const original = String(rawReply == null ? '' : rawReply).trim();
    if (!original) return { ok: false, map: {}, reason: '回复为空' };
    // 与单卡解析同款防御：先剥思考块；剥完失败回退原始文本（防误剥真结果）
    const stripped = stripThinkingBlocks(original);
    const texts = (stripped && stripped !== original) ? [stripped, original] : [original];
    for (const text of texts) {
        const r = parsePackedFromText(text);
        if (r.ok) return r;
    }
    return { ok: false, map: {}, reason: '未解析出多卡结果' };
}

/** 从一段文本里尝试解析打包结果（内部用）。 */
function parsePackedFromText(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (!text) return { ok: false, map: {} };
    // 先剥 markdown 代码围栏（模型常把 JSON 包在 ``` 里）
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // ① 优先取 <tags> 包裹体（从后往前 —— 真答案通常在最末）
    const wrapperRe = new RegExp(
        `<\\s*(?:${TAG_WRAPPER}|${TAG_WRAPPER_ALT})\\s*>([\\s\\S]*?)<\\s*/\\s*(?:${TAG_WRAPPER}|${TAG_WRAPPER_ALT})\\s*>`,
        'gi'
    );
    const wraps = Array.from(text.matchAll(wrapperRe));
    for (let i = wraps.length - 1; i >= 0; i--) {
        const map = parsePackedBody(wraps[i][1]);
        if (map) return { ok: true, map };
    }
    // ② 裸文本兜底：整体 → 最后一个 {…} → 最后一个 […]
    const bodyCandidates = [];
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) bodyCandidates.push(objMatch[0]);
    bodyCandidates.push(text);
    for (const body of bodyCandidates) {
        const map = parsePackedBody(body);
        if (map) return { ok: true, map };
    }
    return { ok: false, map: {} };
}

/**
 * 把一段候选文本解析成「编号 → 标签数组」映射。
 * 支持两种形态：`{"1": [...], "2": [...]}`（对象）与 `[["a"],["b"]]`（数组的数组）。
 * @param {string} body
 * @returns {Object<string,string[]>|null} 解析失败返回 null
 */
function parsePackedBody(body) {
    const b = String(body || '').trim();
    if (!b) return null;
    let parsed;
    try {
        parsed = JSON.parse(b);
    } catch (e) {
        return null;
    }
    const toTags = (v) => {
        if (Array.isArray(v)) return v.flat(Infinity).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
        if (typeof v === 'string') return [v.trim()].filter(Boolean);
        return [];
    };
    // 形态 A：对象 → 键为编号
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const map = {};
        let any = false;
        for (const [k, v] of Object.entries(parsed)) {
            const tags = toTags(v);
            if (tags.length) { map[String(k)] = tags; any = true; }
        }
        return any ? map : null;
    }
    // 形态 B：数组的数组 → 序号映射（1 开始）
    if (Array.isArray(parsed) && parsed.length && parsed.every(x => Array.isArray(x))) {
        const map = {};
        let any = false;
        parsed.forEach((arr, i) => {
            const tags = toTags(arr);
            if (tags.length) { map[String(i + 1)] = tags; any = true; }
        });
        return any ? map : null;
    }
    return null;
}

/**
 * 🏷️ S2（2026-09-25）：组装打标 Prompt 头部（候选池 + 自由度规则 + 附加要求）。
 *
 * **单卡 / 超长分段 / 打包 / 世界书打标**共用 —— 抽成纯函数（可单测，且引擎与 UI 共用同一份文案口径）。
 *
 * 候选池开关语义（S2 拍板）：
 *   · `poolEnabled=false` → **不输出**候选池段落（也不输出「从池中选 / 自由提取」规则）→ LLM 完全自行打标；
 *     附加要求（customPrompt）仍然输出（它与池无关）。
 *   · `poolEnabled=true`  → 现状行为：池非空输出池段落；`enableExtraction` 决定「优先池+可自创」还是「严格只从池中选」。
 *
 * @param {object} p
 * @param {string[]} [p.poolTags] 候选池标签（调用方已按上限截断）
 * @param {boolean} [p.poolEnabled] 候选池开关（缺省 true，老行为）
 * @param {boolean} [p.enableExtraction] 允许自由提取（仅池开时有意义）
 * @param {string} [p.customPrompt] 附加要求
 * @returns {string} 头部文本（可能为空串）
 */
export function composeTagPromptHead({ poolTags, poolEnabled, enableExtraction, customPrompt } = {}) {
    let head = '';
    const pool = Array.isArray(poolTags) ? poolTags : [];
    const poolOn = poolEnabled !== false;
    // ⚠️ 缺省按**宽松**（允许自由提取）——与引擎默认（enableAIExtraction=true）同口径；仅显式 false 才用严格规则
    const extractionOn = enableExtraction !== false;
    if (poolOn && pool.length > 0) head += `【标签候选池】：[${pool.join(', ')}]\n`;
    if (poolOn) {
        if (extractionOn) {
            head += '【规则】：你可以优先从候选池中选择合适的标签。如果候选池中没有合适的，允许你结合卡片内容自由提取或生成最精准的标签。\n';
        } else {
            head += '【严格限制规则】：你 **绝对只能** 从【标签候选池】中挑选符合的标签，绝对不允许输出候选池以外的任何词汇！\n';
        }
    }
    if (customPrompt && String(customPrompt).trim() !== '') {
        head += `【附加要求】：${String(customPrompt).trim()}\n`;
    }
    return head;
}

/** 默认分段阈值（超出 → 按段落边界切段逐段打标） */
export const SEGMENT_DEFAULT_MAX_CHARS = 4000;
/** 单段目标上限（按段落边界切，尽量不超） */
export const SEGMENT_DEFAULT_CHUNK_CHARS = 3500;

/**
 * ✂️ 按段落边界切分长文本（找不到空行按行；仍超长则硬切）。
 *
 * **单卡超长分段 / 世界书大材料分段**共用 —— 纯函数（可单测）。
 * @param {string} text 原文
 * @param {number} [maxLen] 单段目标上限（默认 3500）
 * @returns {string[]} 段列表（已 trim，空段不保留）
 */
export function splitTextSegments(text, maxLen) {
    const limit = Math.max(200, Number(maxLen) || SEGMENT_DEFAULT_CHUNK_CHARS);
    const segs = [];
    let buf = '';
    const push = () => { if (buf.trim()) { segs.push(buf.trim()); buf = ''; } };
    for (const para of String(text == null ? '' : text).split(/\n{2,}/)) {
        if (buf && (buf.length + para.length + 2) > limit) push();
        let p = para;
        while (p.length > limit) { segs.push(p.slice(0, limit).trim()); p = p.slice(limit); }
        buf = buf ? `${buf}\n\n${p}` : p;
    }
    push();
    return segs;
}
