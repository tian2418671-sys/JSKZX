/**
 * 插件系统引擎（对齐酒馆 SillyTavern 扩展体系，移动端轻量实现）
 * 
 * 移动端"插件"= 可导入的 JSON 格式扩展脚本，在测卡对话中生效：
 *   - 注入额外 system 提示词（作者备注 / 全局指令）
 *   - 定义自定义宏（如 {{custom_xxx}}）
 *   - 预置正则脚本批量导入
 *   - 指定世界书激活关键词
 *
 * 插件 JSON 格式:
 *   {
 *     name: "插件名",
 *     description: "说明",
 *     version: "1.0",
 *     enabled: true,
 *     systemPrompts: ["额外提示词1", "额外提示词2"],
 *     macros: { "{{custom_var}}": "自定义值" },
 *     regexScripts: [ { scriptName, findRegex, replaceString, placement } ],
 *     worldbookTriggers: ["关键词1", "关键词2"]
 *   }
 */

import { chatStorage } from './chatStorage.js';

const LS_PLUGINS = 'jsmobile-chat-plugins';

/**
 * 从 JSON 解析插件对象，校验并归一化
 */
export function parsePlugin(data) {
    if (!data || typeof data !== 'object') return null;
    return {
        name: String(data.name || '未命名插件'),
        description: String(data.description || ''),
        version: String(data.version || '1.0'),
        enabled: data.enabled !== false,
        systemPrompts: Array.isArray(data.systemPrompts) ? data.systemPrompts.map(String) : [],
        macros: (data.macros && typeof data.macros === 'object') ? data.macros : {},
        regexScripts: Array.isArray(data.regexScripts) ? data.regexScripts : [],
        worldbookTriggers: Array.isArray(data.worldbookTriggers) ? data.worldbookTriggers.map(String) : [],
    };
}

/** 加载已保存的插件列表 */
export function loadPlugins() {
    try {
        const raw = chatStorage.get(LS_PLUGINS);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.map(parsePlugin).filter(Boolean);
    } catch (e) {
        return [];
    }
}

/** 保存插件列表 */
export function savePlugins(plugins) {
    try {
        const arr = (Array.isArray(plugins) ? plugins : []).map((p) => ({
            name: p.name || '未命名插件',
            description: p.description || '',
            version: p.version || '1.0',
            enabled: p.enabled !== false,
            systemPrompts: p.systemPrompts || [],
            macros: p.macros || {},
            regexScripts: p.regexScripts || [],
            worldbookTriggers: p.worldbookTriggers || [],
        }));
        chatStorage.set(LS_PLUGINS, JSON.stringify(arr));
    } catch (e) { /* 存储满或不可用 */ }
}

/** 添加/替换插件（按 name 去重） */
export function addPlugin(plugins, plugin) {
    const p = parsePlugin(plugin);
    if (!p) return plugins || [];
    const list = (plugins || []).filter((x) => x.name !== p.name);
    list.push(p);
    savePlugins(list);
    return list;
}

/** 删除插件 */
export function removePlugin(plugins, name) {
    const list = (plugins || []).filter((x) => x.name !== name);
    savePlugins(list);
    return list;
}

/** 切换插件启用状态 */
export function togglePlugin(plugins, name) {
    const list = (plugins || []).map((x) => {
        if (x.name === name) return { ...x, enabled: !x.enabled };
        return x;
    });
    savePlugins(list);
    return list;
}

/**
 * 合并所有已启用插件的宏到宏字典
 * @param {Array} plugins - 插件列表
 * @param {object} baseMacros - 基础宏字典（buildMacroContext 返回值）
 * @returns {object} 合并后的宏字典
 */
export function mergePluginMacros(plugins, baseMacros) {
    const merged = { ...baseMacros };
    if (!Array.isArray(plugins)) return merged;
    for (const p of plugins) {
        if (!p || !p.enabled) continue;
        if (p.macros && typeof p.macros === 'object') {
            for (const [k, v] of Object.entries(p.macros)) {
                merged[k] = String(v);
                const lower = k.toLowerCase();
                if (lower !== k) merged[lower] = String(v);
            }
        }
    }
    return merged;
}

/**
 * 收集所有已启用插件的额外 system 提示词
 * @param {Array} plugins
 * @returns {Array<string>} 提示词文本数组
 */
export function collectPluginSystemPrompts(plugins) {
    if (!Array.isArray(plugins)) return [];
    const out = [];
    for (const p of plugins) {
        if (!p || !p.enabled) continue;
        if (Array.isArray(p.systemPrompts)) {
            for (const s of p.systemPrompts) {
                if (s && String(s).trim()) out.push(String(s));
            }
        }
    }
    return out;
}

/**
 * 收集所有已启用插件的正则脚本
 * @param {Array} plugins
 * @returns {Array} 正则脚本数组（已归一化）
 */
export function collectPluginRegex(plugins) {
    if (!Array.isArray(plugins)) return [];
    const out = [];
    for (const p of plugins) {
        if (!p || !p.enabled) continue;
        if (Array.isArray(p.regexScripts)) {
            for (const s of p.regexScripts) {
                if (s && s.findRegex) {
                    out.push({
                        scriptName: s.scriptName || (p.name + ' 正则'),
                        findRegex: s.findRegex,
                        replaceString: s.replaceString || '',
                        disabled: s.disabled === true,
                        placement: Array.isArray(s.placement) ? s.placement : (s.placement ? [s.placement] : []),
                    });
                }
            }
        }
    }
    return out;
}
