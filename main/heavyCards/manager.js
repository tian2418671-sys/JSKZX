'use strict';
/**
 * 🎬 重型卡（独立前端角色卡）· WebContentsView 宿主管理器
 * ─────────────────────────────────────────────────────────────
 * 定位：主进程独占创建 `WebContentsView`，渲染层**无任何创建能力**（不开 `webviewTag`）。
 * 规格：`docs/规格与计划/功能规格/独立前端角色卡-承载方案-v3.md`
 *
 * 三条硬约束（实现中不可破坏）：
 *   D1. `WebContentsView` 处于 OS 合成层，CSS `z-index` 无效 —— 主界面任何弹窗打开
 *       或离开 heavycards 模式时，必须 `setVisible(false)`，否则弹窗被画面盖住。
 *   D2. 恢复存档时**禁止**先 `session.fromPartition(nextPartition)`；必须先用
 *       `path.join` 拼路径 + `fs` 写完文件，再初始化 session（见 backup.js）。
 *   D3. `getBoundingClientRect()` 与 `setBounds()` **同为 DIP**；绝不乘 `devicePixelRatio`。
 *
 * 安全基线：
 *   · sandbox: true / contextIsolation: true / nodeIntegration: false / 不注入 preload；
 *   · 每个 view 独立 partition（`persist:heavycard-<id>_g<N>`）；
 *   · 外链只 `shell.openExternal`（仅 http/https），窗口打开一律 deny；
 *   · 站内导航只放行与入口同源的地址。
 */

const { WebContentsView, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/** partition 命名空间前缀（与 v3 规格 §5.1 一致） */
const PARTITION_PREFIX = 'persist:heavycard-';

/** 允许设为 bounds 的最大尺寸（防异常 rect 撑爆窗口） */
const MAX_DIM = 20000;

/**
 * 计算某 partition 的磁盘目录（**纯字符串拼接**，不触碰 Chromium）
 * V10 实测：与 `session.getStoragePath()` 返回值完全一致。
 * @param {string} userDataPath app.getPath('userData')
 * @param {string} id 卡 id（如 `hc_7f3a2b`）
 * @param {number} gen 世代号（从 1 开始）
 */
function partitionDirOf(userDataPath, id, gen) {
    return path.join(userDataPath, 'Partitions', `heavycard-${id}_g${Math.max(1, Math.round(Number(gen) || 1))}`);
}

/** 由 id + gen 构造 partition 名 */
function partitionOf(id, gen) {
    return `${PARTITION_PREFIX}${id}_g${Math.max(1, Math.round(Number(gen) || 1))}`;
}

/** 是否为本模块管理的 partition 名 */
function isHeavyPartition(name) {
    return typeof name === 'string' && name.startsWith(PARTITION_PREFIX);
}

/** 归一化 rect：DIP 取整 + 边界保护（D3：绝不乘 devicePixelRatio） */
function normalizeRect(rect) {
    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n) : 0;
    };
    const x = num(rect && rect.x);
    const y = num(rect && rect.y);
    const width = Math.max(0, Math.min(MAX_DIM, num(rect && rect.width)));
    const height = Math.max(0, Math.min(MAX_DIM, num(rect && rect.height)));
    return { x, y, width, height };
}

/** rect 是否完全不可见（宽或高为 0） */
function isEmptyRect(r) {
    return !r || r.width <= 0 || r.height <= 0;
}

/**
 * 创建重型卡视图管理器
 * @param {object} opts
 * @param {import('electron').BrowserWindow} opts.win 主窗口
 * @param {string} opts.userDataPath
 * @param {(channel: string, payload: any) => void} [opts.emit] 向渲染层转发事件
 */
function createHeavyViewManager({ win, userDataPath, emit }) {
    /** @type {Map<string, { view: import('electron').WebContentsView, cardId: string, partition: string }>} */
    const views = new Map();
    /** 当前唯一活动卡 id（全局只保留 1 个） */
    let activeId = null;
    /** 全局可见性开关（弹窗打开 / 离开模式时为 false） */
    let globalVisible = true;

    const send = (channel, payload) => {
        try {
            if (typeof emit === 'function' && win && !win.isDestroyed()) emit(channel, payload);
        } catch (e) { /* 转发失败不影响主流程 */ }
    };

    /** 给 view 绑定外链 / 导航 / 生命周期事件 */
    const bindEvents = (cardId, view) => {
        const wc = view.webContents;

        // ① 新窗口：一律 deny，但 http(s) 交给系统浏览器
        wc.setWindowOpenHandler(({ url }) => {
            try {
                if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
            } catch (e) { /* 忽略 */ }
            return { action: 'deny' };
        });

        // ② 导航：只放行初始 URL 同源（防止卡把视图导航到任意页面）
        let allowedOrigin = null;
        try { allowedOrigin = new URL(view.__initialUrl || '').origin; } catch (e) { allowedOrigin = null; }
        wc.on('will-navigate', (e, url) => {
            let origin = null;
            try { origin = new URL(url).origin; } catch (err) { origin = null; }
            if (!allowedOrigin || origin !== allowedOrigin) e.preventDefault();
        });

        // ③ 加载状态转发给渲染层
        wc.on('did-start-loading', () => send('heavycard:status', { id: cardId, state: 'loading' }));
        wc.on('did-stop-loading', () => {
            send('heavycard:status', { id: cardId, state: 'ready' });
            // 🏷️ 回传页面真实标题：新加卡时只能从 URL 猜名（会猜出 yd_rsdtq 这种路径段），
            //    页面加载完成后拿到 <title> 才能显示人看得懂的名字。
            //    ⚠️ 必须在 did-stop-loading 里读：此时 document.title 才已是最终值
            //       （did-finish-load 早于 SPA 设标题，会读到 hosts 域名）。
            try {
                wc.executeJavaScript('document.title', true)
                    .then((title) => {
                        const t = String(title || '').trim();
                        if (t) send('heavycard:title', { id: cardId, title: t });
                    })
                    .catch(() => { /* 页面已被销毁或脚本被拦，忽略 */ });
            } catch (e) { /* 忽略 */ }
        });
        wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
            if (!isMainFrame) return;
            send('heavycard:status', { id: cardId, state: 'error', code, desc, url });
        });
        wc.on('render-process-gone', (_e, details) => {
            send('heavycard:status', { id: cardId, state: 'crashed', details: details && details.reason });
        });
        wc.on('destroyed', () => {
            if (views.has(cardId)) views.delete(cardId);
        });
    };

    /** 应用当前 rect + 可见性到某个 view */
    const applyLayout = (entry) => {
        if (!entry || !entry.view) return;
        const wc = entry.view.webContents;
        if (!wc || wc.isDestroyed()) return;
        const base = entry.rect || { x: 0, y: 0, width: 0, height: 0 };
        // 让位：把浮层占用的边距从视图矩形里扣掉（右下方向收缩，左上方向平移）
        const ins = entry.inset;
        const rect = ins
            ? {
                x: base.x + ins.left,
                y: base.y + ins.top,
                width: Math.max(0, base.width - ins.left - ins.right),
                height: Math.max(0, base.height - ins.top - ins.bottom)
            }
            : base;
        try {
            entry.view.setBounds(rect);
            // 可见性 = 全局开关 && 自身未隐藏 && rect 非空
            const shouldShow = globalVisible && entry.selfVisible !== false && !isEmptyRect(rect);
            if (typeof entry.view.setVisible === 'function') entry.view.setVisible(shouldShow);
            // 🔑 健康信号：只要拿到过一次有效尺寸，说明渲染视口已建立
            if (!isEmptyRect(rect)) entry.everSized = true;
        } catch (e) { /* view 已销毁等情况忽略 */ }
    };

    /** 销毁单个 view */
    const destroy = (cardId) => {
        const entry = views.get(cardId);
        if (!entry) return false;
        views.delete(cardId);
        if (activeId === cardId) activeId = null;
        try {
            if (entry.view) {
                try { win.contentView.removeChildView(entry.view); } catch (e) { /* 已移除 */ }
                if (entry.view.webContents && !entry.view.webContents.isDestroyed()) entry.view.webContents.close();
            }
        } catch (e) { /* 忽略 */ }
        return true;
    };

    /** 销毁当前活动 view（切卡 / 离开模式前调用） */
    const destroyActive = () => (activeId ? destroy(activeId) : false);

    // =========================================================
    // 📴 离线模式（P2-1）
    // =========================================================
    //  作用：只放行「本卡入口域名 + 显式白名单」，其余 http(s) 请求一律取消。
    //  为什么按 session 装：WebContentsView 每卡独立 partition ⇒ 拦截器天然只影响这张卡，
    //  不会误伤主界面或其它卡（这是 iframe/defaultSession 方案做不到的）。
    //  ⚠️ `webRequest.onBeforeRequest` 覆盖同一 session 的**所有**请求，重复注册会覆盖，
    //     因此用 Map 记录"是否已装"，避免反复切换模式时叠加。
    const offlineFilters = new Map();   // cardId -> { installed:boolean }
    /** 最近被拦截的请求（环形，最多 200 条，供 UI 展示明细） */
    const blockedLog = [];

    /** 由入口 URL 推导允许的域名（含子域） */
    const hostOfUrl = (url) => {
        try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
    };

    /** 判断请求是否允许（纯函数，便于单测） */
    const isAllowedRequest = (reqUrl, entryHost, whitelist) => {
        const u = String(reqUrl || '');
        // 内部资源与本地文件一律放行
        if (/^(app|local-file|devtools|chrome-extension|data|blob):/i.test(u)) return true;
        // 非 http(s) 协议（如 ws）默认放行，避免误伤站内长连接
        if (!/^https?:/i.test(u)) return true;
        let host = '';
        try { host = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
        if (entryHost && (host === entryHost || host.endsWith('.' + entryHost))) return true;
        for (const w of (Array.isArray(whitelist) ? whitelist : [])) {
            const wl = String(w || '').trim().toLowerCase().replace(/^\*\./, '');
            if (!wl) continue;
            if (host === wl || host.endsWith('.' + wl)) return true;
        }
        return false;
    };

    /**
     * 应用离线策略
     * @param {string} cardId
     * @param {boolean} offline
     * @param {string} entryUrl 该卡入口 URL（用于推导主域名）
     * @param {string[]} whitelist 额外放行域名
     */
    const applyOfflinePolicy = (cardId, offline, entryUrl, whitelist) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };

        // 先清掉旧拦截器（同一 session 上重复 filter 会覆盖，这里显式先移除）
        try {
            entry.view.webContents.session.webRequest.onBeforeRequest(null);
        } catch (e) { /* 未注册时忽略 */ }

        if (!offline) {
            offlineFilters.delete(cardId);
            return { success: true, offline: false };
        }

        const entryHost = hostOfUrl(entryUrl || view0Url(cardId));
        const blocked = [];
        try {
            entry.view.webContents.session.webRequest.onBeforeRequest(
                { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
                (details, callback) => {
                    const url = details && details.url;
                    // ws/wss 放行（站内长连接，拦了会白屏）
                    if (/^wss?:/i.test(String(url || ''))) return callback({});
                    if (isAllowedRequest(url, entryHost, whitelist)) return callback({});
                    blocked.push(String(url || '').slice(0, 200));
                    if (blocked.length > 200) blocked.shift();
                    blockedLog.push({ id: cardId, url: String(url || '').slice(0, 200), at: Date.now() });
                    if (blockedLog.length > 200) blockedLog.shift();
                    send('heavycard:blocked', { id: cardId, url: String(url || '').slice(0, 200) });
                    return callback({ cancel: true });
                }
            );
        } catch (e) {
            return { success: false, error: e.message };
        }
        offlineFilters.set(cardId, { installed: true });
        return { success: true, offline: true, entryHost, blocked };
    };

    /** 取已创建 view 的初始 URL（关闭后仍可从缓存读） */
    const view0Url = (cardId) => {
        const e = views.get(cardId);
        return (e && e.view && e.view.__initialUrl) || '';
    };

    /** 读被拦截记录 */
    const getBlockedLog = () => blockedLog.slice();

    /** 打开（或切换）到某张卡
     * @param {{ id: string, url: string, gen: number, settings?: object }} card
     * @param {{x:number,y:number,width:number,height:number}} rect
     */
    const open = (card, rect) => {
        if (!card || !card.id || !card.url) return { success: false, error: '卡信息不完整' };
        // 单实例：切换卡时销毁旧的
        if (activeId && activeId !== card.id) destroy(activeId);

        const partition = isHeavyPartition(card.partition) ? card.partition : partitionOf(card.id, card.gen || 1);
        const offline = !!(card.settings && card.settings.offline);
        const whitelist = (card.settings && card.settings.offlineWhitelist) || [];

        let entry = views.get(card.id);
        if (!entry) {
            const view = new WebContentsView({
                webPreferences: {
                    partition,
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    // 不设置 preload —— 卡内脚本永不接触我们的桥
                    spellcheck: false
                }
            });
            view.__initialUrl = card.url;
            bindEvents(card.id, view);
            try { win.contentView.addChildView(view); } catch (e) { /* 窗口未就绪 */ }
            entry = {
                view, cardId: card.id, partition,
                rect: normalizeRect(rect), selfVisible: true,
                // 🔧 重建用：0×0 创建的视图视口永久为 0，需要原样重建。
                //    ⚠️ 只留最小必要字段，且**不带 settings.offline 之外的响应式对象**。
                cardForRebuild: {
                    id: card.id,
                    name: card.name,
                    url: card.url,
                    gen: card.gen,
                    partition,
                    settings: card.settings && typeof card.settings === 'object'
                        ? JSON.parse(JSON.stringify(card.settings))
                        : undefined
                },
                everSized: false
            };
            views.set(card.id, entry);
            activeId = card.id;
            // 离线策略必须在 loadURL 之前装好，否则首屏请求会漏放
            if (offline) applyOfflinePolicy(card.id, true, card.url, whitelist);
            applyLayout(entry);
            view.webContents.loadURL(card.url).catch((err) => {
                send('heavycard:status', { id: card.id, state: 'error', desc: String(err && err.message || err) });
            });
        } else {
            // 已存在：仅更新布局并确保可见
            entry.rect = normalizeRect(rect);
            entry.selfVisible = true;
            activeId = card.id;
            applyLayout(entry);
            // 若被隐藏过，恢复显示
            try { win.contentView.addChildView(entry.view); } catch (e) { /* 已在层级中 */ }
            // 离线开关可能在别处改过 —— 与期望值不一致时重设
            const installed = offlineFilters.has(card.id);
            if (offline !== installed) applyOfflinePolicy(card.id, offline, card.url, whitelist);
        }
        return { success: true, partition, offline };
    };

    /** 更新布局（节流在前端做；此处只落地）
     * @param {string} cardId
     * @param {{x:number,y:number,width:number,height:number}} rect
     * @param {{top?:number,right?:number,bottom?:number,left?:number}|null} [inset]
     *        让出区域（DIP）。用于界面上方存在 DOM 浮层按钮时，避免原生层盖住它。
     *        ⚠️ WebContentsView 在 OS 合成层，DOM 的 z-index 对它无效 ⇒
     *           只能靠缩小视图矩形给浮层"腾地方"。
     */
    const setBounds = (cardId, rect, inset) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };

        // 🔧 自愈（2026-10-18 用户实测「角色卡渲染不到位」）：
        //    视图若在 **0×0** 状态下创建（从侧栏点卡时占位框还没布局出来，传的是 null），
        //    Chromium 会把渲染视口钉死在 0 —— **之后 setBounds 也救不回来**
        //    （实测：重发 920×593 后 innerWidth/innerHeight 仍为 0，页面文字在但完全不显示）。
        //    因此：检测到「从未拿到有效尺寸 + 本次尺寸有效」⇒ 直接重建视图。
        const nextRect = normalizeRect(rect);
        if (!entry.everSized && !isEmptyRect(nextRect)) {
            const card = entry.cardForRebuild;
            if (card) {
                const cleanInset = inset && typeof inset === 'object'
                    ? {
                        top: Math.max(0, Math.round(Number(inset.top) || 0)),
                        right: Math.max(0, Math.round(Number(inset.right) || 0)),
                        bottom: Math.max(0, Math.round(Number(inset.bottom) || 0)),
                        left: Math.max(0, Math.round(Number(inset.left) || 0))
                    }
                    : null;
                destroy(cardId);
                try {
                    const r = open(card, nextRect);
                    if (r && r.success) {
                        const fresh = views.get(cardId);
                        if (fresh) {
                            fresh.inset = cleanInset;
                            applyLayout(fresh);
                        }
                        return { success: true, rebuilt: true };
                    }
                } catch (e) { /* 重建失败则退回常规流程 */ }
            }
        }

        entry.rect = nextRect;
        entry.inset = inset && typeof inset === 'object'
            ? {
                top: Math.max(0, Math.round(Number(inset.top) || 0)),
                right: Math.max(0, Math.round(Number(inset.right) || 0)),
                bottom: Math.max(0, Math.round(Number(inset.bottom) || 0)),
                left: Math.max(0, Math.round(Number(inset.left) || 0))
            }
            : null;
        applyLayout(entry);
        return { success: true };
    };

    /** 全局可见性（D1：弹窗打开 / 离开模式） */
    const setGlobalVisible = (visible) => {
        globalVisible = !!visible;
        for (const entry of views.values()) applyLayout(entry);
        return { success: true };
    };

    /**
     * 单卡可见性（P2-4 闲置隐藏）
     * ⚠️ 与 `destroy` 的区别：只隐藏，不销毁 —— 页面状态（存档/当前画面）保留，
     *    用户切回来是「瞬间恢复」而不是重新加载 2 MB。
     */
    const setCardVisible = (cardId, visible) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };
        entry.selfVisible = !!visible;
        applyLayout(entry);
        return { success: true, visible: !!visible };
    };

    /** 重新加载 */
    const reload = (cardId, ignoreCache) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };
        try {
            if (ignoreCache) entry.view.webContents.reloadIgnoringCache();
            else entry.view.webContents.reload();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 缩放（DIP 之外的页面缩放，0.5~2.0） */
    const setZoom = (cardId, factor) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };
        const f = Math.min(2, Math.max(0.5, Number(factor) || 1));
        try {
            entry.view.webContents.setZoomFactor(f);
            return { success: true, zoom: f };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 截图（D1 的可选视觉无缝方案） */
    const capture = async (cardId) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };
        try {
            const img = await entry.view.webContents.capturePage();
            return { success: true, dataUrl: img.toDataURL() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 清缓存（只清 HTTP/Code 缓存，不动存储） */
    const clearCache = async (cardId) => {
        const entry = views.get(cardId);
        if (!entry) return { success: false, error: 'view 不存在' };
        try {
            const ses = entry.view.webContents.session;
            await ses.clearCache();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 取该卡 partition 的磁盘目录（供备份模块使用） */
    const storagePathOf = (cardId) => {
        const entry = views.get(cardId);
        if (!entry) return null;
        try {
            const p = entry.view.webContents.session.getStoragePath();
            return p || null;
        } catch (e) {
            return null;
        }
    };

    /**
     * 刷盘（备份前置，R2）
     * ⚠️ 只对**已创建**的 view 有效；若该卡当前没有 view（未打开），
     *    其存储已在上次关闭时落盘，无需刷新 —— 直接返回 true。
     * 另外顺带刷新 cookie，避免恢复后登录态丢失。
     */
    const flushStorage = async (cardId) => {
        const entry = views.get(cardId);
        if (!entry) return { success: true, skipped: true };
        try {
            const ses = entry.view.webContents.session;
            if (typeof ses.flushStorageData === 'function') await ses.flushStorageData();
            if (ses.cookies && typeof ses.cookies.flushStore === 'function') {
                try { await ses.cookies.flushStore(); } catch (e) { /* cookie 刷新失败不影响主流程 */ }
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /**
     * 临时隐藏（备份期间让 leveldb 空闲）
     * 返回一个 restore 函数，调用方在 finally 里恢复。
     */
    const suspendForBackup = (cardId) => {
        const entry = views.get(cardId);
        if (!entry) return () => {};
        const prev = entry.selfVisible;
        entry.selfVisible = false;
        applyLayout(entry);
        return () => {
            const e2 = views.get(cardId);
            if (!e2) return;
            e2.selfVisible = prev !== false;
            applyLayout(e2);
        };
    };

    /** 是否已有该卡的 view */
    const has = (cardId) => views.has(cardId);

    /** 当前活动卡 id */
    const getActiveId = () => activeId;

    /** 销毁全部（窗口关闭时） */
    const destroyAll = () => {
        for (const id of Array.from(views.keys())) destroy(id);
    };

    return {
        open,
        destroy,
        destroyActive,
        destroyAll,
        setBounds,
        setGlobalVisible,
        setCardVisible,
        reload,
        setZoom,
        capture,
        clearCache,
        storagePathOf,
        flushStorage,
        suspendForBackup,
        applyOfflinePolicy,
        isAllowedRequest,
        getBlockedLog,
        has,
        getActiveId
    };
}

module.exports = {
    createHeavyViewManager,
    partitionOf,
    partitionDirOf,
    isHeavyPartition,
    normalizeRect,
    isEmptyRect,
    isAllowedRequest: (reqUrl, entryHost, whitelist) => {
        // 复用管理器内部逻辑的独立导出（纯函数，便于单测）
        const u = String(reqUrl || '');
        if (/^(app|local-file|devtools|chrome-extension|data|blob):/i.test(u)) return true;
        if (!/^https?:/i.test(u)) return true;
        let host = '';
        try { host = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
        if (entryHost && (host === entryHost || host.endsWith('.' + entryHost))) return true;
        for (const w of (Array.isArray(whitelist) ? whitelist : [])) {
            const wl = String(w || '').trim().toLowerCase().replace(/^\*\./, '');
            if (!wl) continue;
            if (host === wl || host.endsWith('.' + wl)) return true;
        }
        return false;
    },
    PARTITION_PREFIX
};
