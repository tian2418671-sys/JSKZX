/**
 * 测卡聊天会话持久化引擎
 * 与酒馆 chats 体系对齐的轻量实现:
 *   - 每张卡可建多个会话(新建聊天),每会话保存 messages(swipe 结构) + 元信息
 *   - 经 chatStorage 适配层落盘(桌面 app:// 下 localStorage 不持久),键按卡片 path 隔离
 *   - 删除会话 / 重命名会话 / 切换会话
 *
 * 会话结构:
 *   {
 *     id: "cs_1727xxx",          // 会话唯一 id
 *     name: "会话名",             // 默认「聊天 N」
 *     cardPath: "/library/x.json",
 *     createdAt: 0, updatedAt: 0,
 *     messages: [ {role, content|swipes, index}, ... ]
 *   }
 */

import { chatStorage } from './chatStorage.js';

const LS_KEY_PREFIX = 'jsmobile-chat-sessions:';

function storageKey(cardPath) {
    // 卡片路径直接作 key 后缀(含中文/斜杠均安全,存储键允许)
    return LS_KEY_PREFIX + String(cardPath || 'unknown');
}

/** 读取某卡的全部会话 */
export function loadSessions(cardPath) {
    try {
        const raw = chatStorage.get(storageKey(cardPath));
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.map((s) => ({
            id: s.id || ('cs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
            name: s.name || '未命名会话',
            cardPath: String(s.cardPath || cardPath || ''),
            createdAt: s.createdAt || 0,
            updatedAt: s.updatedAt || 0,
            messages: Array.isArray(s.messages) ? s.messages : []
        }));
    } catch (e) {
        return [];
    }
}

/** 保存某卡的全部会话 */
function saveSessions(cardPath, sessions) {
    try {
        chatStorage.set(storageKey(cardPath), JSON.stringify(sessions || []));
    } catch (e) { /* 存储满或不可用 */ }
}

/** 新建会话并返回(不落盘,由调用方 persist 或在发消息后 persist) */
export function createSession(cardPath, name) {
    const idx = loadSessions(cardPath).length + 1;
    return {
        id: 'cs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name || ('聊天 ' + idx),
        cardPath: String(cardPath || ''),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
    };
}

/** upsert 会话(存在同 id 则覆盖,不存在则追加) */
export function upsertSession(cardPath, session) {
    if (!session || !session.id) return loadSessions(cardPath);
    const list = loadSessions(cardPath);
    const i = list.findIndex((s) => s.id === session.id);
    session.updatedAt = Date.now();
    if (i >= 0) list[i] = session;
    else list.push(session);
    saveSessions(cardPath, list);
    return list;
}

/** 删除会话 */
export function deleteSession(cardPath, sessionId) {
    const list = loadSessions(cardPath).filter((s) => s.id !== sessionId);
    saveSessions(cardPath, list);
    return list;
}

/** 重命名会话 */
export function renameSession(cardPath, sessionId, newName) {
    const list = loadSessions(cardPath);
    const s = list.find((x) => x.id === sessionId);
    if (s) {
        s.name = String(newName || s.name).trim() || s.name;
        s.updatedAt = Date.now();
        saveSessions(cardPath, list);
    }
    return list;
}

/** 持久化当前消息列表到会话(消息为 live 引用,深拷贝快照存储) */
export function persistMessages(cardPath, sessionId, messages) {
    const list = loadSessions(cardPath);
    const s = list.find((x) => x.id === sessionId);
    if (!s) return list;
    // 快照拷贝,避免 live reactive 对象与存储互相干扰
    s.messages = JSON.parse(JSON.stringify(messages || []));
    s.updatedAt = Date.now();
    saveSessions(cardPath, list);
    return list;
}

/** 读取最近打开会话 id(便于恢复) */
export function getLastSessionId(cardPath) {
    try { return chatStorage.get(storageKey(cardPath) + ':last') || ''; } catch (e) { return ''; }
}

export function setLastSessionId(cardPath, sessionId) {
    try {
        if (sessionId) chatStorage.set(storageKey(cardPath) + ':last', sessionId);
        else chatStorage.remove(storageKey(cardPath) + ':last');
    } catch (e) { /* */ }
}
