/**
 * 移动端测卡全局设置（设置页为唯一入口，测卡 Tab / AI 工具只读）
 *  - 回复数量：每次发送生成的候选回复条数（酒馆式 swipe，默认 1）
 *  - 用户名：对话中「我」的显示名 + 宏 {{user}}
 *  - 用户人设：{{user}} 的角色设定，注入 system 提示词
 * 存储键与 API 配置（stc-api-*）分离，互不干扰。
 */

import { chatStorage } from './chatStorage.js';

const LS_REPLY_COUNT = 'jsmobile-chat-reply-count';
const LS_USER_NAME = 'jsmobile-user-name';
const LS_USER_PERSONA = 'jsmobile-user-persona';
const LS_MAX_FLOORS = 'jsmobile-chat-max-floors'; // 自动隐藏楼层数:0=不限(全部发送),N=只发最近 N 层

const MIN_REPLY = 1;
const MAX_REPLY = 10;

export function getReplyCount() {
    const n = parseInt(chatStorage.get(LS_REPLY_COUNT) || '', 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(Math.max(n, MIN_REPLY), MAX_REPLY);
}

export function setReplyCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return;
    chatStorage.set(LS_REPLY_COUNT, String(Math.min(Math.max(Math.round(v), MIN_REPLY), MAX_REPLY)));
}

export function getUserName() {
    return (chatStorage.get(LS_USER_NAME) || '').trim() || '我';
}

export function setUserName(name) {
    const v = String(name == null ? '' : name).trim();
    if (v) chatStorage.set(LS_USER_NAME, v);
    else chatStorage.remove(LS_USER_NAME);
}

export function getUserPersona() {
    return (chatStorage.get(LS_USER_PERSONA) || '').trim();
}

export function setUserPersona(persona) {
    const v = String(persona == null ? '' : persona).trim();
    if (v) chatStorage.set(LS_USER_PERSONA, v);
    else chatStorage.remove(LS_USER_PERSONA);
}

/**
 * 🚀 自动隐藏楼层数:0=不限(全部历史发送给 AI),N>0=只把最近 N 层(一层=用户+AI 一对)发给 AI,
 * 远处楼层仅保留在界面显示,不进入请求 —— 防超长上下文/远处设定干扰新回复。
 */
export function getMaxFloors() {
    const n = parseInt(chatStorage.get(LS_MAX_FLOORS) || '', 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 200);
}

export function setMaxFloors(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return;
    chatStorage.set(LS_MAX_FLOORS, String(Math.min(Math.max(Math.round(v), 0), 200)));
}
