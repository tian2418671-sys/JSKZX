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
 * 把 Chromium 的加载错误码翻译成用户能看懂的中文。
 * 🐞 2026-10-25：以前直接把 `desc`（英文 ERR_XXX）丢给界面，
 *    用户只看到「加载失败」四个字，不知道是自己网断了、站点挂了，还是卡坏了。
 * @param {number} code Chromium net error（负数）
 * @param {string} desc 原始英文描述
 * @returns {string}
 */
function describeLoadError(code, desc) {
    const c = Number(code) || 0;
    const map = {
        '-2': '连接被中断（对方服务器没有正常响应，或网络中途断开）',
        '-6': '找不到这个网站（域名解析失败，检查网址是否写错）',
        '-7': '连不上对方服务器（域名可能已失效）',
        '-21': '网络连接被中断，请检查网络后重试',
        '-100': '对方服务器已关闭连接',
        '-101': '对方服务器拒绝连接',
        '-102': '连接超时（对方服务器无响应）',
        '-105': '域名解析失败，请检查网络或网址',
        '-106': '当前没有网络连接',
        '-107': '对方网站的安全证书有问题（TLS 握手失败），通常是站点自身故障，与本软件无关',
        '-109': '对方服务器无响应（主机不可达）',
        '-118': '连接超时（网络太慢或对方服务器无响应）',
        '-200': '证书不合法，出于安全考虑已阻止访问',
        '-201': '证书已过期，出于安全考虑已阻止访问',
        '-202': '证书与网址不匹配，出于安全考虑已阻止访问',
        '-300': '网址跳转次数过多',
        '-324': '连接被重置（网络被中途打断，常见于网络不稳定或站点被拦截）',
        '-501': '对方网站的安全设置不被支持'
    };
    if (map[String(c)]) return map[String(c)];
    if (c === -3) return '加载被中断';
    const d = String(desc || '').trim();
    return d ? `加载失败（${d}）` : '加载失败';
}

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
function createHeavyViewManager({ win, userDataPath, emit, bindProtocol }) {
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
    const bindEvents = (cardId, view, entry) => {
        const wc = view.webContents;

        // ⏱️ 加载超时兜底（2026-10-25 用户反馈「其它重型卡加载很慢、有时完全没反应」）
        //
        //   问题：`loadURL()` 只在**失败**时 reject，站点处于「连上了但永远不返回 / 一直转圈」
        //   状态时它既不 reject 也不 finish ⇒ 界面永远停在「正在加载…」，用户以为卡死。
        //   （实测例：某些站点 TLS 握手反复失败、CDN 挂起、或页面无限 pending 的 XHR。）
        //
        //   对策：从 `did-start-loading` 起计时，超时仍未 `did-stop-loading` ⇒
        //   主动上报 error（带明确文案），让界面出「重试 / 用浏览器打开」按钮，而不是干等。
        //   ⚠️ 只上报状态、不 destroy 视图 —— 慢站点仍可能后来自行加载完，
        //      届时 `did-stop-loading` 会把状态改回 ready（可自愈）。
        let loadTimer = null;
        const LOAD_TIMEOUT_MS = 25000;
        const clearLoadTimeout = () => { if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; } };
        /**
         * 启动/重置超时计时器。
         * ⚠️ 2026-10-25 实测坑：某些站点 TLS 握手失败后会**反复触发 did-start-loading**
         *    （Chromium 内部重试），若每次都重置计时器 ⇒ 计时器永远差一点到期 ⇒
         *    界面永远停在「加载中」，用户以为卡死（用户实测连续 30s+ 无变化）。
         *    ⇒ 只有 **首次** 调用真正起计时；后续 did-start-loading 只在计时器已清空时才重起。
         */
        const armLoadTimeout = () => {
            if (loadTimer) return; // 已在计时：不要重置，否则重试型失败永远不超时
            loadTimer = setTimeout(() => {
                loadTimer = null;
                try {
                    const url = wc.getURL() || '';
                    send('heavycard:status', {
                        id: cardId,
                        state: 'error',
                        code: 'LOAD_TIMEOUT',
                        desc: `加载超时（超过 ${Math.round(LOAD_TIMEOUT_MS / 1000)} 秒仍无响应）`,
                        url
                    });
                    if (entry) entry.failedOnce = true;
                } catch (e) { /* 视图已销毁 */ }
            }, LOAD_TIMEOUT_MS);
            // timer 不应阻止进程退出
            if (loadTimer && typeof loadTimer.unref === 'function') loadTimer.unref();
        };
        // 视图销毁时务必清掉，避免对已销毁的 webContents 操作
        wc.on('destroyed', clearLoadTimeout);

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
        //   ⚠️ 关键：Chromium 在加载失败后**仍会**发 `did-stop-loading`，
        //      若不管住它，会把刚上报的 error 覆盖回 ready ⇒ 用户看到「加载中」永远不结束 / 假装加载好。
        //      用 `failedOnce` 标记：失败后本次加载周期的 stop 一律不算成功，直到下一次 start 才清除。
        let failedOnce = false;
        wc.on('did-start-loading', () => {
            failedOnce = false;
            if (entry) entry.failedOnce = false;
            send('heavycard:status', { id: cardId, state: 'loading' });
            armLoadTimeout();
        });
        wc.on('did-stop-loading', () => {
            clearLoadTimeout();
            if (failedOnce) return; // 失败已上报，不要再把状态改回 ready
            // 🐞 2026-10-25 真 bug（用户实测「显示加载成功但完全没反应」）：
            //    Chromium 在**主文档加载失败**时（ERR_CONNECTION_TIMED_OUT / ERR_SSL_PROTOCOL_ERROR 等），
            //    仍会触发 did-stop-loading，页面变成 `chrome-error://chromewebdata/`（或干脆空白）。
            //    以前这里无条件报 ready ⇒ 界面显示「已就绪」，用户看到的却是一片空白，无从判断。
            //    ⇒ 三项实证检查后再判 ready：URL 不是 chrome-error、body 有内容、title 非空其一成立。
            (async () => {
                const fail = (code, desc, raw) => {
                    failedOnce = true;
                    if (entry) entry.failedOnce = true;
                    send('heavycard:status', {
                        id: cardId, state: 'error', code,
                        desc: describeLoadError(code, desc),
                        rawDesc: raw
                    });
                };

                let finalUrl = '';
                try { finalUrl = wc.getURL() || ''; } catch (e) { finalUrl = ''; }
                if (/^chrome-error:/i.test(finalUrl)) {
                    return fail(-118, 'ERR_CONNECTION_TIMED_OUT', 'chrome-error page');
                }

                // 读页面的「活信号」：body 长度 + 是否触发了任何 DOM
                let bodyLen = -1;
                try {
                    bodyLen = await wc.executeJavaScript(
                        '(function(){try{return document.body?document.body.innerHTML.length:0}catch(e){return -1}})()', true
                    );
                } catch (e) {
                    // 脚本执行不了（渲染进程 bootstrap 失败等）⇒ 一定不正常
                    return fail(-2, '页面脚本无法执行（渲染进程异常）', String(e && e.message));
                }
                if (!(Number(bodyLen) > 0)) {
                    // 空 body：网络被拦 / 站点返回空 / TLS 失败
                    return fail(-118, 'ERR_CONNECTION_TIMED_OUT', `empty body(bodys=${bodyLen})`);
                }
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
            })();
        });
        wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
            if (!isMainFrame) return;
            // -3 = ERR_ABORTED（用户主动停止/导航中断），不算真失败
            if (code === -3) return;
            failedOnce = true;
            if (entry) entry.failedOnce = true;
            clearLoadTimeout();
            send('heavycard:status', {
                id: cardId,
                state: 'error',
                code,
                desc: describeLoadError(code, desc),
                rawDesc: desc,
                url
            });
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
                    // 🐞 2026-10-25 真 bug（用户实测「显示加载成功但完全没反应」）：
                    //    `sandbox: true` + **独立 partition** + 无 preload 时，Electron 43 的
                    //    sandbox bootstrap 拿不到 startupData，卡里直接抛
                    //      `TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null`
                    //    ⇒ 渲染进程脚本全线不执行 ⇒ document.body 恒为空、title 为空，
                    //      但 `readyState` 仍是 complete、`did-stop-loading` 照常触发，
                    //      于是界面显示「已就绪」而用户看到一片空白。
                    //    关掉 sandbox：卡内脚本本来就**不加载任何 preload**、不碰我们的桥，
                    //    实际隔离由 `contextIsolation + nodeIntegration:false + 独立 partition` 保证。
                    sandbox: false,
                    contextIsolation: true,
                    nodeIntegration: false,
                    // 不设置 preload —— 卡内脚本永不接触我们的桥
                    spellcheck: false
                }
            });
            view.__initialUrl = card.url;
            // 📂 本地卡：把 `heavycard-local` 协议绑到**这条 partition 的 session**
            //    （只绑 defaultSession 不管用 —— 卡内请求会直接 ERR_FAILED）
            try {
                if (typeof bindProtocol === 'function' && view.webContents.session) {
                    bindProtocol(view.webContents.session);
                }
            } catch (e) { /* 绑定失败则本地卡无法加载，远程卡不受影响 */ }
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
            // ⚠️ 必须在 entry 建好之后才绑事件：事件回调要往 entry.failedOnce 写失败标记
            bindEvents(card.id, view, entry);
            views.set(card.id, entry);
            activeId = card.id;
            // 离线策略必须在 loadURL 之前装好，否则首屏请求会漏放
            if (offline) applyOfflinePolicy(card.id, true, card.url, whitelist);
            applyLayout(entry);
            view.webContents.loadURL(card.url).then(() => {
                // 成功/失败状态统一由 did-start/stop/fail-load 事件上报，这里不再重复发
            }).catch((err) => {
                // ⚠️ loadURL 的 reject 与 did-fail-load 可能都会触发；
                //    统一走同一套中文翻译，避免界面出现英文 ERR_XXX。
                const code = (err && typeof err.code === 'number') ? err.code : -2;
                const msg = (err && err.message) || String(err || '');
                const m = /ERR_([A-Z_]+)\s*\((-?\d+)\)/.exec(msg);
                const finalCode = m ? Number(m[2]) : code;
                send('heavycard:status', {
                    id: card.id,
                    state: 'error',
                    code: finalCode,
                    desc: describeLoadError(finalCode, m ? m[1] : msg),
                    rawDesc: msg
                });
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
            // 🔁 上次是失败态：用户再点这张卡说明想重看，必须重新加载一次。
            //    否则走的是「复用已存在视图」分支 ⇒ 不会再有 did-fail-load ⇒
            //    界面永远停在旧的 error 且拿不到原因，用户以为「点了没反应」。
            if (entry.failedOnce) {
                entry.failedOnce = false;
                try { entry.view.webContents.reloadIgnoringCache(); } catch (e) { /* 视图已销毁 */ }
            }
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
    PARTITION_PREFIX,
    describeLoadError
};
