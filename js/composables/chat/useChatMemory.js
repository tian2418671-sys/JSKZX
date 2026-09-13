/**
 * 移动端长期记忆（MemoryChat 方案 B 融合）
 *  - 底层走原生 MemoryPlugin（Android 内置 SQLite），与桌面版无关
 *  - L1 原始消息 / L2 摘要 / L3 事实 统一为 type 字段存储
 *  - 测卡发送前检索相关记忆注入 system；发送后异步记录对话
 */
import { api } from './chatBridge.js';
import { chatStorage } from './chatStorage.js';

const LS_ENABLED = 'jsmobile-memory-enabled';
const LS_LIMIT = 'jsmobile-memory-limit';

export function isMemoryEnabled() {
    return chatStorage.get(LS_ENABLED) !== '0';
}
export function setMemoryEnabled(v) {
    if (v) chatStorage.set(LS_ENABLED, '1');
    else chatStorage.set(LS_ENABLED, '0');
}
export function getMemoryLimit() {
    const n = parseInt(chatStorage.get(LS_LIMIT) || '20', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 20;
}
export function setMemoryLimit(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return;
    chatStorage.set(LS_LIMIT, String(Math.min(Math.max(Math.round(v), 1), 200)));
}

/** 记录一条记忆（不阻塞，失败静默） */
export async function recordMemory(type, content, key, cardName) {
    if (!isMemoryEnabled()) return null;
    try {
        return await api.memoryAdd({ type: type || 'message', content: content || '', key: key || '', cardName: cardName || '' });
    } catch (e) {
        return { success: false, error: (e && e.message) || '' };
    }
}

/**
 * 记录对话消息（user / assistant）
 * 治理：错误占位（⚠ 开头）与空内容不进记忆；去重与 L1 修剪由原生层完成
 */
export function recordMessage(role, content, cardName) {
    const text = String(content || '').trim();
    if (!text) return null;
    if (text.startsWith('⚠')) return null; // 请求失败占位文本不是记忆
    return recordMemory('message', `${role === 'user' ? '用户' : 'AI'}: ${text}`, '', cardName);
}

/** 记录事实（L3，记忆表格行：键=值） */
export function recordFact(key, value, cardName) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return null;
    return recordMemory('fact', v, String(key || '备忘').trim(), cardName);
}

/** 更新记忆表格行（改键/改值） */
export async function updateMemory(id, patch) {
    try {
        return await api.memoryUpdate(id, patch || {});
    } catch (e) {
        return { success: false, error: (e && e.message) || '' };
    }
}

// ---------- L3 事实提取（用户交代的关键信息 → 记忆表格行） ----------
// 启发式规则：命中即记（键 值）。值为句末截止（。！？!? 或行尾）。
const FACT_RULES = [
    { re: /(?:我叫|我的名字(?:叫|是)?|名字是|本名是)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '名字' },
    { re: /我(?:最喜欢|超喜欢|特别喜欢|喜欢)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '喜欢' },
    // 讨厌：允许逗号后省略「我」的口语写法（「我喜欢X，讨厌Y。」）
    { re: /(?<=^|[，,；;：:\s])我?(?:最讨厌|特别讨厌|讨厌|不喜欢)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '讨厌' },
    { re: /(?:记住|牢记|记下)\s*[:：]?\s*(.+?)(?:[。！？!?]|$)/, key: '备忘' },
    { re: /(?:你|您|老板娘|老板|管家|夫君|主人|哥哥|姐姐)(?:要)?(?:记住|记得|牢记)\s*[:：]?\s*(.+?)(?:[。！？!?]|$)/, key: '备忘' },
    { re: /我?(?:今年|现在)\s*(\d+)\s*岁/, key: '年龄', valueFrom: (m) => m[1] + '岁' },
    { re: /我?(?:现在|正在|身处)?(?:在|身处)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '位置' },
    { re: /我?(?:想去|要去|打算去|计划去)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: '目标' },
    { re: /我的(.+?)(?:是|为)\s*[:：]?\s*(.+?)(?:[。！？!?，,]|$)/, key: (m) => String(m[1] || '备忘').trim() },
];

/** 从用户消息提取事实列表：[{ key, value }]（纯函数，供单测）；同键同值去重 */
export function extractFacts(text) {
    const src = String(text || '');
    const facts = [];
    const seen = new Set();
    for (const rule of FACT_RULES) {
        const m = rule.re.exec(src);
        if (!m) continue;
        const key = typeof rule.key === 'function' ? rule.key(m) : rule.key;
        const value = rule.valueFrom ? rule.valueFrom(m) : String(m[m.length - 1] || '').trim();
        if (!key || !value) continue;
        const sig = key + '\u0000' + value;
        if (seen.has(sig)) continue; // 「记住X」与「你记住X」等重叠规则只记一次
        seen.add(sig);
        facts.push({ key, value });
    }
    return facts;
}

/** 检索相关记忆 */
export async function searchMemory(query, limit) {
    try {
        const res = await api.memorySearch({ query: query || '', limit: limit || getMemoryLimit() });
        return (res && res.success && res.items) ? res.items : [];
    } catch (e) {
        return [];
    }
}

/** 列出记忆（供查看器） */
export async function listMemory(type, limit) {
    try {
        const res = await api.memoryList({ type: type || '', limit: limit || 100 });
        return (res && res.success && res.items) ? res.items : [];
    } catch (e) {
        return [];
    }
}

export async function removeMemory(id) {
    try { return await api.memoryRemove(id); } catch (e) { return { success: false }; }
}

export async function clearMemory(type) {
    try { return await api.memoryClear(type); } catch (e) { return { success: false }; }
}

/**
 * 根据用户输入检索相关记忆，拼成可注入 system 的文本片段：
 *   - fact 事实 → 「记忆表格」（| 键 | 值 | Markdown 表格）
 *   - summary 摘要 → 要点列表
 * 空则返回 ''。
 */
export async function buildMemoryContext(query) {
    if (!isMemoryEnabled()) return '';
    try {
        const items = await searchMemory(query, getMemoryLimit());
        const facts = items.filter((it) => it && it.type === 'fact' && it.content);
        const summaries = items.filter((it) => it && it.type === 'summary' && it.content);
        const parts = [];
        if (facts.length) {
            parts.push('### 记忆表格（角色已记住的信息，请在对话中自然运用，不要逐条复述）');
            parts.push('| 记忆 | 内容 |');
            parts.push('| --- | --- |');
            for (const f of facts) {
                parts.push('| ' + escTable(f.key || '备忘') + ' | ' + escTable(f.content) + ' |');
            }
        }
        if (summaries.length) {
            parts.push('### 对话摘要（近期发生的事）');
            parts.push(summaries.map((s) => '- ' + s.content).join('\n'));
        }
        return parts.join('\n\n');
    } catch (e) {
        return '';
    }
}

/** Markdown 表格单元格转义：| → \|、换行 → 空格（防表格破行） */
function escTable(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
