/**
 * 测卡数据持久化适配层（桌面版）
 * ─────────────────────────────────────────────────────────────
 * 解决的问题：移动版测卡引擎用裸 `localStorage` 存全部状态，而桌面生产环境走 `app://`
 * 自定义协议，localStorage 不落盘（项目内已多次实测并记录：main.js:1199「实测重启后丢失」、
 * useConfigPersistence.js:72、RELEASE_NOTES.md:567）。
 * 若不处理，测卡「会话 / 变量树 / 聊天设置 / 激活预设 / 插件」全部重启即丢。
 *
 * 设计（双轨，不改造引擎语义）：
 *   - 同步层：内存缓存为权威 → 引擎的同步 get 立即拿到值（无需把引擎改成异步）；
 *             同时尽力写 localStorage（开发 http:// 环境可用，且便于调试）。
 *   - 持久层：经 chatBridge 的 chatStore:load / chatStore:save 落 `chat_store.json`
 *             （主进程原子写）。**刻意不走 app_config.json** ——
 *             后者是「整份全量替换」语义（useConfigPersistence 全量生成 payload 覆盖写），
 *             聊天记录混进去会被下一次 syncConfigToDisk 覆盖，且部分写入会反过来覆盖别人的字段。
 *
 * ⚠️ 启动时序（接线时务必遵守）：
 *   `hydrate()` 是异步的，且**磁盘优先于 localStorage**。挂载测卡 UI 前请先 await：
 *
 *       import { chatStorage } from './chatStorage.js';
 *       await chatStorage.hydrate();          // 早期调用一次（可与其他启动并行）
 *       replyCount.value = getReplyCount();   // 之后再读 getXxx()，拿到的是恢复后的值
 *
 *   未 await 也不会崩：读到的是 localStorage 的旧值（首次运行则为默认值），
 *   但「重启恢复」这条验收会不通过。hydrate 对同一进程是幂等的（复用同一 Promise）。
 */

import { ref } from 'vue';
import { api } from './chatBridge.js';

/** 内存缓存（同步读取的权威源） */
const mem = new Map();
/** 与内存缓存同构的纯对象镜像：给 chat_store.json 用（避免把 Map 传 IPC） */
let mirror = Object.create(null);
/** 是否至少从某个来源恢复过（供 UI 判断「是否已就绪」，可选使用） */
let hydrated = false;
let hydratePromise = null;
/** 落盘防抖定时器 */
let flushTimer = null;
/** hydrate 期间发生的写入标记：hydrate 结束时需重新落盘，避免被恢复值覆盖 */
let dirtyDuringHydrate = false;

/**
 * 🔑 存储版本号（响应式）
 * chatStorage.get() 本身是同步非响应式的，任何「读它的 computed」在 Vue 眼里都没有依赖，
 * 于是首次求值后**永久缓存**（实测：侧栏选了预设、localStorage 也写进去了，
 * 但引擎的 activePreset computed 永远停在初始 null → 预设装配分支走不到）。
 * 因此每次写入/恢复都 bump 本 ref；读存储的 computed 只要 `void chatStorageVersion.value`
 * 一下就能建立依赖，存储一变即重算。
 */
export const chatStorageVersion = ref(0);

const SAVE_DEBOUNCE_MS = 400;

/** localStorage 是否真的可用（app:// 下可能抛 SecurityError，必须存活探测） */
const LS_OK = (() => {
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem('__jsk_chat_probe__', '1');
        localStorage.removeItem('__jsk_chat_probe__');
        return true;
    } catch (e) { return false; }
})();

/** 写 localStorage（失败静默：内存缓存已生效，不影响本次会话） */
function lsSet(key, val) {
    if (!LS_OK) return;
    try { localStorage.setItem(key, val); } catch (e) { /* 配额满/不可用 */ }
}
function lsGet(key) {
    if (!LS_OK) return null;
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsRemove(key) {
    if (!LS_OK) return;
    try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
}

/** 批量落盘（防抖合并：一次对话会产生多条写入） */
function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNow();
    }, SAVE_DEBOUNCE_MS);
}

/** 立即落盘（失败静默：内存 + localStorage 仍是有效副本） */
function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    try {
        if (!api || typeof api.saveChatStore !== 'function') return;
        // JSON 往返剥离任何响应式 Proxy（IPC structured clone 不接受 Proxy）
        const payload = JSON.parse(JSON.stringify(mirror));
        const ret = api.saveChatStore(payload);
        // 主进程串行队列返回 Promise；失败已在主进程记录，这里吞掉避免 unhandled rejection
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (e) { /* 落盘失败不影响本次会话 */ }
}

/**
 * 从磁盘恢复全部键值 → 同时回填内存缓存与 localStorage。
 * 幂等：重复调用复用同一 Promise。
 * @returns {Promise<boolean>} true=从磁盘恢复成功
 */
function hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
        let ok = false;
        try {
            if (api && typeof api.loadChatStore === 'function') {
                const res = await api.loadChatStore();
                const data = res && res.success ? res.data : null;
                if (data && typeof data === 'object') {
                    // ① 回填内存（权威）
                    for (const k of Object.keys(data)) {
                        if (typeof data[k] === 'string') mem.set(k, data[k]);
                    }
                    // ② 重建镜像
                    mirror = Object.assign(Object.create(null), data);
                    // ③ 同步进 localStorage：让首屏的同步 getter（getReplyCount 等）也能读到
                    //    （磁盘优先于 localStorage 的旧残留）
                    for (const k of Object.keys(data)) lsSet(k, data[k]);
                    ok = true;
                }
            }
        } catch (e) {
            console.warn('[chatStorage] 磁盘恢复失败，回退 localStorage:', e && e.message);
        }
        // 无磁盘数据（首次运行 / 非 Electron）→ 用 localStorage 现有值兜底建镜像，
        // 保证后续 set 时不会把「localStorage 里已有的旧值」整体丢失
        if (!ok) {
            try {
                if (LS_OK) {
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && k.indexOf('jsmobile-') === 0) {
                            const v = lsGet(k);
                            if (typeof v === 'string') { mem.set(k, v); mirror[k] = v; }
                        }
                    }
                }
            } catch (e) { /* 忽略 */ }
        }
        hydrated = true;
        chatStorageVersion.value++;
        // hydrate 期间若有写入，恢复值可能盖掉了新写入 → 补一次落盘
        if (dirtyDuringHydrate) {
            dirtyDuringHydrate = false;
            flushNow();
        }
        return ok;
    })();
    return hydratePromise;
}

export const chatStorage = {
    /** 同步读取（内存权威；未命中再看 localStorage） */
    get(key) {
        const k = String(key);
        if (mem.has(k)) return mem.get(k);
        const v = lsGet(k);
        if (v !== null) {
            mem.set(k, v);
            // 🐞 2026-09-13 回归审计修正：原来只写 mem、不写 mirror，导致两个问题 ——
            //   ① flushNow() 落盘读的是 mirror ⇒ mem 里独有的键**永远不会被落盘**，
            //      与「内存为权威」的语义矛盾（读到的值重启后消失）；
            //   ② migrateChatKeys 原先只遍历 mirror ⇒ 这类键不会被迁移。
            //   这里同步回填 mirror，保持二者一致。
            mirror[k] = v;
        }
        return v;
    },
    /** 同步写入（内存 + localStorage 立即可见，磁盘防抖落盘） */
    set(key, val) {
        const k = String(key);
        const v = String(val == null ? '' : val);
        mem.set(k, v);
        mirror[k] = v;
        lsSet(k, v);
        chatStorageVersion.value++;
        if (!hydrated && !hydratePromise) hydrate();
        if (!hydrated) dirtyDuringHydrate = true;
        scheduleFlush();
        return true;
    },
    remove(key) {
        const k = String(key);
        mem.delete(k);
        delete mirror[k];
        lsRemove(k);
        chatStorageVersion.value++;
        if (!hydrated && !hydratePromise) hydrate();
        if (!hydrated) dirtyDuringHydrate = true;
        scheduleFlush();
        return true;
    },
    /** 是否已完成恢复（UI 可用它决定要不要等 hydrate） */
    isHydrated() { return hydrated; },
    hydrate,
    /** 立即冲刷挂起的落盘（窗口关闭前 / 关键操作后调用） */
    flush: flushNow,
    /** 调试/测试用：当前全量镜像的浅拷贝 */
    _snapshot() { return Object.assign({}, mirror); },
    /** 测试用：重置内部状态（仅供单测注入内存环境） */
    _reset() {
        mem.clear();
        mirror = Object.create(null);
        hydrated = false;
        hydratePromise = null;
        dirtyDuringHydrate = false;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    }
};

// 窗口关闭前冲刷最后一次挂起的落盘（与 useConfigPersistence 同策略，尽力而为）
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', () => { flushNow(); });
}

// ============================================================
// 💬 测卡引擎开关（booleans，默认全开）
// 统一收口到这里的原因：侧边栏 UI 与编排层（App.vue 发消息）必须读到同一份值，
// 若各持一个 ref，侧栏关掉 MVU 而编排层仍按开处理 → 典型的「开关不生效」。
// 故：侧栏只读写这里，编排层每次发消息时现读（无缓存、无同步问题）。
// ============================================================
const BOOL_DEFAULTS = { mvu: true, ejs: true, seg: true };

export function getChatFlag(key) {
    const k = String(key);
    if (!(k in BOOL_DEFAULTS)) return false;
    const raw = chatStorage.get('jsmobile-chat-' + k + '-enabled');
    if (raw === null || raw === '') return BOOL_DEFAULTS[k];
    return raw !== '0';
}
export function setChatFlag(key, value) {
    const k = String(key);
    if (!(k in BOOL_DEFAULTS)) return;
    chatStorage.set('jsmobile-chat-' + k + '-enabled', value ? '1' : '0');
}

export default chatStorage;

/**
 * 🧭 按 path 派生的键迁移（卡片被移动分组 / 分组重命名 / 换卡图后必须调用）
 *
 * 背景：测卡会话、变量树、最后会话指针都存在 `chat_store.json` 里，键里**嵌入了完整卡片路径**
 * （`jsmobile-chat-<path>:sessions`）。卡片物理路径一变，旧键就成了孤儿 —— 数据其实还在，
 * 但按新路径读不到，用户看到的是「测卡会话/变量树凭空消失」。
 *
 * ⚠️ 同类缺陷 2026-09-01 已在「覆盖层 app_config.json」上踩过一次：
 *    凡「物理路径会变」的操作，都必须同步迁移**所有**按 path 派生的键。
 *
 * 实现用**整键子串替换**，不依赖具体键格式（也适用于「目录前缀」式的分组重命名）。
 *
 * @param {string} oldPath 旧路径（或旧目录前缀）
 * @param {string} newPath 新路径（或新目录前缀）
 * @returns {number} 迁移的键数量
 */
export function migrateChatKeys(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return 0;
    let moved = 0;
    // 🐞 2026-09-13 回归审计修正：原来只 `for (const key of Object.keys(mirror))`，
    //    而 get() 未命中时只写 mem、**不写 mirror**（见本文件 get 实现），
    //    于是「仅存在于 localStorage / 仅被 get() 懒加载进 mem」的旧键**永远不会被迁移**。
    //    改为遍历 mem ∪ mirror 的并集，值优先取 mem（更可能是当前最新）。
    //    已知边界：只在 localStorage 里存在、两个缓存都没有的键仍无法枚举 ——
    //    桌面以 chat_store.json 为权威，启动 hydrate 后二者应一致，故窗口很窄。
    const keys = new Set([...Object.keys(mirror), ...mem.keys()]);
    for (const key of keys) {
        if (key.indexOf(oldPath) === -1) continue;
        const next = key.split(oldPath).join(newPath);
        if (next === key) continue;
        // 不覆盖已存在的目标键（镜像 / 内存 / localStorage 三处都查）
        if (Object.prototype.hasOwnProperty.call(mirror, next) || mem.has(next) || lsGet(next) !== null) continue;
        const val = mem.has(key) ? mem.get(key) : mirror[key];
        mirror[next] = val;
        delete mirror[key];
        mem.set(next, val);
        mem.delete(key);
        lsSet(next, val);
        lsRemove(key);
        moved++;
    }
    if (moved) {
        chatStorageVersion.value++;
        flushNow();   // 键迁移必须立刻落盘：拖到后面窗口一关就白迁了
    }
    return moved;
}
