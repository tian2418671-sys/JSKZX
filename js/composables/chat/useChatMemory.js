/**
 * 桌面版测卡·长期记忆（v4.1 对齐移动版同名文件，2026-09-18）
 *  - L1 原始消息 / L2 摘要 / L3 事实 统一为 type 字段存储
 *  - 测卡发送前检索相关记忆注入 system；发送后异步记录对话
 * v4.1 主线（对齐移动版评审定案，规格见 docs/规格与计划/测卡工作区/桌面版测卡记忆v4.1-实现规格.md）：
 *  · D1 卡级分桶：记忆按 cardPath 隔离（换卡=换记忆）；cardName 降级纯展示
 *  · D2 检索治理：停用词 + 有效词 <2 降级「本卡最近 N 条（updatedAt DESC）」
 *  · D3 事实提取收紧：显式陈述优先；排除疑问句/假设/引用；空泛键跳过；值截断
 *  · D4 同 key 覆盖：同 (fact, key, cardPath) → 覆盖更新（存储层实现）
 *  · I2 注入双预算：条数 + 估算 token（默认 200 / 硬上限 400）
 *  · I4 注入格式：XML 格式 C（默认）/ markdown 表格
 *  · I5 返回 { text, meta }：meta 供侧栏 debug（灰度关闭时 meta=null）
 * 与移动版差异（刻意的桌面化改造）：
 *  · localStorage → chatStorage（桌面 app:// 下裸 localStorage 不持久）
 *  · api ← chatBridge（透传 memory:* IPC，底层 main/memoryStore.js JSON 存储）
 *  · 去 B1 批量抑制（桌面无批量测卡场景）
 *  · D3 规则集/停用词抽到 memoryRules.js（纯函数单一事实源，供单测）
 */
import { api } from './chatBridge.js';
import { chatStorage } from './chatStorage.js';
import { estimateTokens } from '../../utils/tokenEstimate.js';
import { extractFacts as extractFactsRules, tokenizeQuery } from './memoryRules.js';

const LS_ENABLED = 'jsmobile-memory-enabled';
const LS_LIMIT = 'jsmobile-memory-limit';
const LS_INJECT_TOKENS = 'jsmobile-memory-inject-tokens';
const LS_FORMAT = 'jsmobile-memory-format';
const LS_V2 = 'jsmobile-memory-v2';   // 灰度 flag：v4.1 新分桶/新格式/新条数（关=旧行为）

const DEFAULT_LIMIT = 8;              // I2：默认注入条数 20 → 8
const MAX_LIMIT = 200;
const DEFAULT_INJECT_TOKENS = 200;    // I2：默认注入 token 预算
const MAX_INJECT_TOKENS = 400;        // I2：硬上限（防中文 token 估算误差）
const FORMAT_C = 'C';                 // I4：XML 格式

export function isMemoryEnabled() {
    return chatStorage.get(LS_ENABLED) !== '0';
}
export function setMemoryEnabled(v) {
    chatStorage.set(LS_ENABLED, v ? '1' : '0');
}
export function isMemoryV2() {
    return chatStorage.get(LS_V2) !== '0';   // 默认开
}
export function setMemoryV2(v) {
    chatStorage.set(LS_V2, v ? '1' : '0');
}
export function getMemoryLimit() {
    const n = parseInt(chatStorage.get(LS_LIMIT) || String(DEFAULT_LIMIT), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}
export function setMemoryLimit(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return;
    chatStorage.set(LS_LIMIT, String(Math.min(Math.max(Math.round(v), 1), MAX_LIMIT)));
}
/** I2：注入 token 预算 */
export function getMemoryInjectTokens() {
    const n = parseInt(chatStorage.get(LS_INJECT_TOKENS) || String(DEFAULT_INJECT_TOKENS), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_INJECT_TOKENS) : DEFAULT_INJECT_TOKENS;
}
export function setMemoryInjectTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return;
    chatStorage.set(LS_INJECT_TOKENS, String(Math.min(Math.max(Math.round(v), 1), MAX_INJECT_TOKENS)));
}
/** I4：注入格式（'C' = XML / 'markdown' = 表格） */
export function getMemoryFormat() {
    return chatStorage.get(LS_FORMAT) === 'markdown' ? 'markdown' : FORMAT_C;
}
export function setMemoryFormat(f) {
    chatStorage.set(LS_FORMAT, f === 'markdown' ? 'markdown' : FORMAT_C);
}

/** 归一化卡参数：接受 string（旧调用兼容）或 object { path, name }（v4.1 新调用，R1/R2 载体） */
function normalizeCard(card) {
    if (card && typeof card === 'object') {
        return { path: String(card.path || ''), name: String(card.name || '') };
    }
    const s = String(card == null ? '' : card);
    return { path: s, name: s };
}

/** 记录一条记忆（不阻塞，失败静默）；card 支持 string|object */
export async function recordMemory(type, content, key, card) {
    if (!isMemoryEnabled()) return null;
    const { path, name } = normalizeCard(card);
    try {
        return await api.memoryAdd({
            type: type || 'message', content: content || '', key: key || '',
            cardName: name, cardPath: path
        });
    } catch (e) {
        return { success: false, error: (e && e.message) || '' };
    }
}

/**
 * 记录对话消息（user / assistant）。
 * 治理：错误占位（⚠ 开头）与空内容不进记忆；去重与修剪由存储层完成。
 * card: string（旧调用兼容）或 object { path, name }（v4.1 R1/R2 修复载体）。
 */
export function recordMessage(role, content, card) {
    const text = String(content || '').trim();
    if (!text) return null;
    if (text.startsWith('⚠')) return null; // 请求失败占位文本不是记忆
    const { path, name } = normalizeCard(card);
    return recordMemory('message', `${role === 'user' ? '用户' : 'AI'}: ${text}`, '', { path, name });
}

/** 记录事实（L3，记忆表格行：键=值） */
export function recordFact(key, value, card) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return null;
    const { path, name } = normalizeCard(card);
    return recordMemory('fact', v, String(key || '备忘').trim(), { path, name });
}

/** 更新记忆（R2 回写实际候选 / 侧栏编辑）：patch = { content?, key?, cardName?, cardPath? } */
export async function updateMemory(id, patch) {
    try {
        return await api.memoryUpdate(id, patch || {});
    } catch (e) {
        return { success: false, error: (e && e.message) || '' };
    }
}

/** 确认/拒绝（P1 预留）：confirmed=1 注入 / 0 待确认 / -1 软删可恢复 */
export async function confirmMemory(id, confirmed) {
    try {
        return await api.memoryConfirm(id, confirmed);
    } catch (e) {
        return { success: false, error: (e && e.message) || '' };
    }
}

/** D3 事实提取（收紧版，规则在 memoryRules.js 纯函数单一事实源） */
export function extractFacts(text) {
    return extractFactsRules(text);
}

/** D2：query → 有效词（去停用词），供注入层降级判定与 debug meta */
export { tokenizeQuery };

/** 检索相关记忆（v4.1：cardPath 强制隔离；D1 参数名沿用移动版桥接契约 cardName） */
export async function searchMemory(query, limit, cardPath) {
    try {
        const res = await api.memorySearch({ query: query || '', limit: limit || getMemoryLimit(), cardName: cardPath || '' });
        return (res && res.success && res.items) ? res.items : [];
    } catch (e) {
        return [];
    }
}

/** 列出记忆（供查看器）；cardPath 非空 → 只看本卡 */
export async function listMemory(type, limit, cardPath) {
    try {
        const res = await api.memoryList({ type: type || '', limit: limit || 100, cardName: cardPath || '' });
        return (res && res.success && res.items) ? res.items : [];
    } catch (e) {
        return [];
    }
}

/**
 * 记忆库统计（条数 + 分类 + 遗留桶），供侧栏「设置」分区显示。
 * 桌面版 memory:* 通道已实现（main/memoryStore.js + memory_store.json）；
 * 非 Electron 环境下 chatBridge 会给出失败桩 → 这里退化为 0 条，不报错。
 */
export async function getMemoryStats() {
    try {
        if (typeof api.memoryStats !== 'function') return { total: 0, byType: {}, orphans: 0 };
        const res = await api.memoryStats();
        if (!res || !res.success) return { total: 0, byType: {}, orphans: 0 };
        return {
            total: Number(res.total) || 0,
            byType: (res.byType && typeof res.byType === 'object') ? res.byType : {},
            orphans: Number(res.orphans) || 0
        };
    } catch (e) {
        return { total: 0, byType: {}, orphans: 0 };
    }
}

export async function removeMemory(id) {
    try { return await api.memoryRemove(id); } catch (e) { return { success: false }; }
}

export async function clearMemory(type) {
    try { return await api.memoryClear(type); } catch (e) { return { success: false }; }
}

/** D1a：删卡清记忆 */
export async function clearMemoryByCard(cardPath) {
    try { return await api.memoryClearByCard(cardPath); } catch (e) { return { success: false }; }
}

/** D1a：路径变更跟随（rename/move 后记忆跟随） */
export async function migrateMemoryCard(from, to) {
    try { return await api.memoryMigrateCard({ from: from || '', to: to || '' }); } catch (e) { return { success: false }; }
}

/**
 * 一次性迁移（D1）：显示名 → card_path（幂等可重跑）。
 * @param {Array<{name?, path?}>} cardList 卡列表（library 的轻量投影即可）
 * 唯一匹配：某显示名只对应一个 path → 绑定；同名多卡/无匹配 → 遗留桶（不丢数据）。
 */
export async function migrateMemoryToV2(cardList) {
    if (!Array.isArray(cardList) || !cardList.length) return { success: false, error: '卡列表为空' };
    const nameCount = new Map();
    const nameToPath = new Map();
    for (const c of cardList) {
        const name = c && c.name ? String(c.name).trim() : '';
        const path = c && c.path ? String(c.path) : '';
        if (!name || !path) continue;   // 空名/空 path 防御
        nameCount.set(name, (nameCount.get(name) || 0) + 1);
        nameToPath.set(name, path);
    }
    const mappings = [];
    for (const [name, count] of nameCount) {
        mappings.push([name, count === 1 ? nameToPath.get(name) : null]);   // 同名多卡 → 遗留桶
    }
    try {
        return await api.memoryMigrateData(mappings);
    } catch (e) {
        return { success: false, error: (e && e.message) || '' };
    }
}

// ---------- 注入文本拼装（I4） ----------

/** Markdown 表格单元格转义：| → \|、换行 → 空格（防表格破行） */
function escTable(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** XML 转义（I4 格式 C；截断已先于转义） */
function escXml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/\r?\n/g, ' ');
}

/** I4：按格式拼装注入文本（C = XML / markdown = 表格） */
function buildInjectionText(facts, summaries, format) {
    const parts = [];
    if (format === FORMAT_C) {
        if (facts.length) {
            parts.push('<memory>');
            parts.push('<user_profile>');
            parts.push(facts.map((f) => `${escXml(f.key || '备忘')}：${escXml(f.content)}`).join('\n'));
            parts.push('</user_profile>');
            if (summaries.length) {
                parts.push('<recent_events>');
                parts.push(summaries.map((s) => '- ' + escXml(s.content)).join('\n'));
                parts.push('</recent_events>');
            }
            parts.push('</memory>');
        } else if (summaries.length) {
            parts.push('<memory>');
            parts.push('<recent_events>');
            parts.push(summaries.map((s) => '- ' + escXml(s.content)).join('\n'));
            parts.push('</recent_events>');
            parts.push('</memory>');
        }
    } else {
        if (facts.length) {
            parts.push('### 记忆表格（角色已记住的信息，请在对话中自然运用，不要逐条复述）');
            parts.push('| 记忆 | 内容 |');
            parts.push('| --- | --- |');
            for (const f of facts) parts.push('| ' + escTable(f.key || '备忘') + ' | ' + escTable(f.content) + ' |');
        }
        if (summaries.length) {
            parts.push('### 对话摘要（近期发生的事）');
            parts.push(summaries.map((s) => '- ' + s.content).join('\n'));
        }
    }
    return parts.join('\n\n');
}

/**
 * 根据用户输入检索相关记忆，拼成可注入 system 的文本片段（v4.1）。
 * @param {string} query 用户输入
 * @param {string} cardPath 当前卡 path（D1 强制隔离）
 * @returns {Promise<{text: string, meta: object|null}>} I5：meta 供 debug（灰度关时 null）
 *   D2：有效词 <2 → 降级「本卡最近 N 条（updatedAt DESC）」
 *   I2：条数 + 估算 token 双预算；I4：格式 C（XML）/ markdown
 */
export async function buildMemoryContext(query, cardPath) {
    if (!isMemoryEnabled()) return { text: '', meta: null };
    const v2 = isMemoryV2();
    const limit = getMemoryLimit();
    const budget = getMemoryInjectTokens();
    const format = getMemoryFormat();
    try {
        let items = [];
        let degraded = false;
        const words = tokenizeQuery(query || '');
        if (words.length < 2) {
            // D2：有效词 <2 → 降级本卡最近 N 条（updatedAt DESC，存储层保证）
            degraded = true;
            items = await searchMemory('', limit, cardPath);
        } else {
            items = await searchMemory(words.join(' '), limit, cardPath);
        }
        // 只注入未软删/待确认的记忆（P0 confirmed 恒 1；P1 收紧后 0/-1 均不注入）
        const usable = items.filter((it) => it && it.content && it.confirmed !== -1 && it.confirmed !== 0);
        const facts = usable.filter((it) => it.type === 'fact');
        const summaries = usable.filter((it) => it.type === 'summary');

        // I2：条数 + 估算 token 双约束，逐步收窄
        let factsTake = facts.slice(0, limit);
        let summariesTake = summaries.slice(0, Math.max(1, Math.floor(limit / 2)));
        let text = buildInjectionText(factsTake, summariesTake, format);
        while (text && estimateTokens(text) > budget) {
            if (summariesTake.length) summariesTake = summariesTake.slice(0, -1);
            else if (factsTake.length) factsTake = factsTake.slice(0, -1);
            else break;
            text = buildInjectionText(factsTake, summariesTake, format);
        }

        if (!text) return { text: '', meta: v2 ? { injectedCount: 0, cardPath: cardPath || '', isDegraded: degraded, estimatedTokens: 0 } : null };
        const meta = v2 ? {
            injectedCount: factsTake.length + summariesTake.length,
            cardPath: cardPath || '',
            isDegraded: degraded,
            estimatedTokens: estimateTokens(text)
        } : null;
        return { text, meta };
    } catch (e) {
        return { text: '', meta: null };
    }
}
