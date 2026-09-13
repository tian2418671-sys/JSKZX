/**
 * 预设加载与应用引擎（对齐酒馆 SillyTavern OpenAI Presets 体系）
 * 从外部预设目录加载预设 JSON，在测卡中应用 prompts/prompt_order/temperature 等。
 *
 * 酒馆预设 JSON 结构:
 *   {
 *     name: "预设名",
 *     prompts: [
 *       { identifier: "main", name: "Main Prompt", content: "...", role: "system", ... },
 *       { identifier: "charDescription", name: "Char Description", content: "{{description}}", role: "system" },
 *       { identifier: "chatHistory", name: "Chat History", content: "", role: "system" },
 *       ...
 *     ],
 *     prompt_order: [{ identifier: "main", enabled: true }, ...],
 *     temperature: 0.8,
 *     max_tokens: 300,
 *     max_context: 16384,
 *     ...
 *   }
 */

import { chatStorage } from './chatStorage.js';

const LS_ACTIVE_PRESET = 'jsmobile-active-preset';

/** 预设参数白名单（只取这些参数覆盖测卡默认值） */
const PRESET_PARAM_KEYS = [
    'temperature', 'max_tokens', 'max_context', 'top_p', 'top_k',
    'rep_pen', 'rep_pen_range', 'frequency_penalty', 'presence_penalty',
    'min_p', 'top_a', 'typical_p', 'tail_free_sampling'
];

/**
 * 归一化 prompt_order（兼容酒馆两种形态）
 *   扁平: [{ identifier, enabled }, ...]
 *   嵌套: [{ character_id: 100000, order: [{ identifier, enabled }, ...] }, ...]
 * 移动端不做角色区分，嵌套形态取各分组并集（同 identifier 后者覆盖前者）。
 * @param {Array} raw
 * @returns {Array} [{ identifier, enabled }]
 */
export function normalizePromptOrder(raw) {
    if (!Array.isArray(raw)) return [];
    if (raw.some((it) => it && Array.isArray(it.order))) {
        const merged = new Map();
        for (const grp of raw) {
            if (!grp || !Array.isArray(grp.order)) continue;
            for (const sub of grp.order) {
                if (sub && sub.identifier) merged.set(sub.identifier, sub);
            }
        }
        return [...merged.values()];
    }
    return raw.filter((it) => it && it.identifier);
}

/**
 * 从预设 JSON 中提取生效的提示词列表（按 prompt_order 排序，跳过已关闭项）
 * 关闭判定同时看 prompt_order[].enabled === false 与 prompt.enabled === false，
 * 这样测卡侧边栏的开关无论预设用哪种结构都能真正生效。
 * @param {object} presetData - 预设 JSON 对象
 * @returns {Array} 生效的提示词数组 [{ identifier, name, content, role }]
 */
export function getOrderedPrompts(presetData) {
    if (!presetData) return [];
    const prompts = Array.isArray(presetData.prompts) ? presetData.prompts : [];
    const order = normalizePromptOrder(presetData.prompt_order);

    // 构建 identifier → prompt 映射
    const promptMap = new Map();
    for (const p of prompts) {
        if (p && p.identifier) promptMap.set(p.identifier, p);
    }

    // 按 prompt_order 排序，只取 enabled（去重防同一 identifier 出现多次）
    const ordered = [];
    const seen = new Set();
    for (const item of order) {
        if (!item || item.enabled === false) continue;
        const p = promptMap.get(item.identifier);
        if (p && p.enabled !== false && !seen.has(item.identifier)) {
            ordered.push(p);
            seen.add(item.identifier);
        }
    }

    // 如果没有可用的 prompt_order，直接用 prompts 数组
    if (ordered.length === 0 && prompts.length > 0) {
        return prompts.filter((p) => p && p.identifier !== 'chatHistory' && p.enabled !== false);
    }

    return ordered;
}

/**
 * 设置某条提示词的启用状态（同步 prompt 自身与 prompt_order，保证真正生效）
 * @param {object} presetData - 预设 JSON
 * @param {object} prompt - prompts 数组中的条目对象
 * @param {boolean} enabled
 */
export function setPromptEnabled(presetData, prompt, enabled) {
    if (!presetData || !prompt) return;
    prompt.enabled = !!enabled;
    const id = prompt.identifier;
    if (!id) return;
    const raw = presetData.prompt_order;
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        if (item.identifier === id) item.enabled = !!enabled;
        if (Array.isArray(item.order)) {
            for (const sub of item.order) {
                if (sub && sub.identifier === id) sub.enabled = !!enabled;
            }
        }
    }
}

/**
 * 从预设中提取生成参数（temperature/max_tokens 等）
 * @param {object} presetData
 * @returns {object} 参数字典 { temperature, max_tokens, ... }
 */
export function getPresetParams(presetData) {
    if (!presetData) return {};
    const params = {};
    for (const key of PRESET_PARAM_KEYS) {
        if (presetData[key] !== undefined && presetData[key] !== null) {
            params[key] = presetData[key];
        }
    }
    return params;
}

/**
 * 构建预设提示词消息列表
 * 将预设的 prompts 转换为 OpenAI/Anthropic 消息格式，应用宏替换
 *
 * @param {object} presetData - 预设 JSON
 * @param {object} macros - 宏字典 (buildMacroContext 返回值)
 * @param {object} options - { card, chatHistory }
 *   - card: 角色卡对象（用于注入 description/personality 等）
 *   - chatHistory: 已有对话历史 [{role, content}, ...]
 * @returns {Array} 消息数组 [{role, content}]
 */
export function buildPresetMessages(presetData, macros, options = {}) {
    const ordered = getOrderedPrompts(presetData);
    if (ordered.length === 0) return [];

    const { chatHistory = [] } = options;
    const messages = [];
    const macroApply = macros || {};

    for (const p of ordered) {
        const content = String(p.content || '');
        if (!content.trim()) {
            // chatHistory 占位符 → 插入实际对话历史
            if (p.identifier === 'chatHistory' && chatHistory.length > 0) {
                for (const m of chatHistory) {
                    messages.push({ role: m.role, content: String(m.content || '') });
                }
            }
            continue;
        }

        // 应用宏替换
        let text = content;
        for (const [macro, value] of Object.entries(macroApply)) {
            text = text.split(macro).join(value);
            const lower = macro.toLowerCase();
            if (lower !== macro) text = text.split(lower).join(value);
        }

        const role = (p.role === 'assistant' || p.role === 'user') ? p.role : 'system';
        messages.push({ role, content: text });
    }

    return messages;
}

/**
 * 判断预设是否包含有效的提示词结构
 */
export function isValidPresetStructure(data) {
    if (!data || typeof data !== 'object') return false;
    return Array.isArray(data.prompts) && data.prompts.length > 0;
}

/**
 * 从预设 JSON 中提取正则脚本(酒馆预设可内嵌 regex_scripts)
 * 兼容两种位置:预设顶层 extensions.regex_scripts / 预设顶层 regex_scripts
 */
export function extractRegexFromPreset(presetData) {
    if (!presetData || typeof presetData !== 'object') return [];
    const ext = presetData.extensions || {};
    const raw = Array.isArray(ext.regex_scripts) ? ext.regex_scripts
        : (Array.isArray(presetData.regex_scripts) ? presetData.regex_scripts : []);
    return raw.map((s) => {
        if (!s || typeof s !== 'object') return null;
        return {
            scriptName: s.scriptName || s.script_name || '预设正则',
            findRegex: s.findRegex || s.find_regex || '',
            replaceString: s.replaceString || s.replace_string || '',
            disabled: s.disabled === true || s.enabled === false,
            placement: Array.isArray(s.placement) ? s.placement : (s.placement ? [s.placement] : [2, 1]),
            fromPreset: true
        };
    }).filter((s) => s && s.findRegex);
}

/**
 * 从预设 JSON 中提取插件定义(酒馆预设可内嵌 prompts 插件标记,本移动端定义为:
 *   extensions.plugins / plugins 数组,每项 { name, description, systemPrompts, macros, regexScripts, worldbookTriggers })
 */
export function extractPluginsFromPreset(presetData) {
    if (!presetData || typeof presetData !== 'object') return [];
    const ext = presetData.extensions || {};
    const raw = Array.isArray(ext.plugins) ? ext.plugins
        : (Array.isArray(presetData.plugins) ? presetData.plugins : []);
    return raw.map((p) => {
        if (!p || typeof p !== 'object') return null;
        return {
            name: String(p.name || '预设插件'),
            description: String(p.description || ''),
            version: String(p.version || '1.0'),
            enabled: p.enabled !== false,
            systemPrompts: Array.isArray(p.systemPrompts) ? p.systemPrompts.map(String) : [],
            macros: (p.macros && typeof p.macros === 'object') ? p.macros : {},
            regexScripts: Array.isArray(p.regexScripts) ? p.regexScripts : [],
            worldbookTriggers: Array.isArray(p.worldbookTriggers) ? p.worldbookTriggers.map(String) : [],
            fromPreset: true
        };
    }).filter(Boolean);
}

// ========== 活跃预设持久化 ==========

/** 保存当前激活的预设(经 chatStorage 落盘) */
export function saveActivePreset(presetData) {
    try {
        if (presetData) {
            chatStorage.set(LS_ACTIVE_PRESET, JSON.stringify({
                name: presetData.name || '未命名预设',
                data: presetData,
                activatedAt: Date.now()
            }));
        } else {
            chatStorage.remove(LS_ACTIVE_PRESET);
        }
    } catch (e) { /* 存储满或不可用 */ }
}

/** 读取当前激活的预设 */
export function loadActivePreset() {
    try {
        const raw = chatStorage.get(LS_ACTIVE_PRESET);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && obj.data ? obj : null;
    } catch (e) {
        return null;
    }
}

/** 清除当前激活的预设 */
export function clearActivePreset() {
    try { chatStorage.remove(LS_ACTIVE_PRESET); } catch (e) { /* */ }
}
