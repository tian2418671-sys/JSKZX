/**
 * 🎬 重型卡（独立前端角色卡）· 组合式函数
 * ─────────────────────────────────────────────────────────────
 * 职责：卡清单 CRUD、打开/切换、布局同步、弹窗遮挡处理（D1）、持久化。
 * 规格：`docs/规格与计划/功能规格/独立前端角色卡-承载方案-v3.md`
 *
 * ⚠️ 三条来自评审的硬约束：
 *   D1. WebContentsView 处于 OS 合成层，CSS `z-index` 无效 ——
 *       任何主界面弹窗/菜单打开、或离开 heavycards 模式，都必须 `setVisible(false)`。
 *   D2. 恢复存档时禁止提前 `session.fromPartition`（本文件不涉及，见 backup 模块）。
 *   D3. rect 直接来自 `getBoundingClientRect()`（DIP），**绝不乘 devicePixelRatio**。
 */
import { ref, computed, watch } from 'vue';

/** 预置卡：开箱即用的「云端人生」 */
export const PRESET_HEAVY_CARD = {
    id: 'hc_ydrs',
    name: '云端人生',
    url: 'https://jfdk.xxbjf.com/yd_rsdtq/index.html',
    icon: '🎬',
    note: '云端人生 · 命卷推演',
    gen: 1,
    partition: 'persist:heavycard-hc_ydrs_g1',
    createdAt: 0,
    lastOpenedAt: 0,
    settings: {
        offline: false,
        zoom: 1,
        allowExternal: true,
        autoBackup: { enabled: true, onExit: true, onOpen: false, intervalMin: 30, keep: 5 }
    }
};

/**
 * 生成稳定 id（基于 URL 的简易哈希 + 时间 + 随机后缀）
 * ⚠️ 只有时间戳不够：同一毫秒内连点「添加」两次会生成**相同 id**（单测抓获），
 *    后果是两张卡共用一个 partition，存档互相覆盖。因此必须叠加随机位。
 */
export function makeHeavyCardId(url) {
    const s = String(url || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    const t = Date.now().toString(36).slice(-5);
    const r = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
    return `hc_${h.toString(36).slice(0, 6)}_${t}${r}`;
}

/**
 * settings 深度归一化为**纯对象**
 * ⚠️ 热测实锤（2026-10-18）：`settings: { ...card.settings }` 只拷贝第一层，
 *    `settings.autoBackup` 仍是 Vue 的 reactive Proxy ⇒ structured clone 抛
 *    `An object could not be cloned.` ⇒ openHeavyCard 直接 return false，
 *    表现为「点卡无反应、徽标永远 error、所有 view 操作报 view 不存在」。
 *    所有跨 IPC 的 settings 必须过这一层。
 */
export function toPlainSettings(s) {
    const src = (s && typeof s === 'object') ? s : {};
    const auto = (src.autoBackup && typeof src.autoBackup === 'object') ? src.autoBackup : {};
    const interval = Number(auto.intervalMin);
    const keep = Number(auto.keep);
    const zoom = Number(src.zoom);
    return {
        offline: !!src.offline,
        zoom: Number.isFinite(zoom) ? Math.min(2, Math.max(0.5, zoom)) : 1,
        allowExternal: src.allowExternal !== false,
        offlineWhitelist: Array.isArray(src.offlineWhitelist) ? src.offlineWhitelist.map((x) => String(x)) : [],
        autoBackup: {
            enabled: auto.enabled !== false,
            onExit: auto.onExit !== false,
            onOpen: !!auto.onOpen,
            intervalMin: Number.isFinite(interval) ? interval : 30,
            keep: Number.isFinite(keep) ? Math.min(20, Math.max(1, keep)) : 5
        }
    };
}

/**
 * 从 URL 猜一个**临时**显示名
 * ─────────────────────────────────────────────────────────────
 * ⚠️ 这只是占位名：路径段（`yd_rsdtq`）对人没有意义，用户实测反馈「名字显示成地址」。
 *    真正的名字由主进程在页面加载完成后回传 `<title>`（`heavycard:title`）来覆盖。
 * 策略：
 *   · 路径段含中文/明确语义 → 直接用（如 `/云端人生/`）；
 *   · 否则回退到域名（比 `yd_rsdtq` 更像"这是哪张卡"）；
 *   · 都没有 → 「未命名独立前端角色卡」。
 */
export function guessNameFromUrl(url) {
    try {
        const u = new URL(url);
        // pathname 是百分号编码的（中文会变成 %E4%BA%91…），必须解码后再判断
        let pathname = u.pathname;
        try { pathname = decodeURIComponent(pathname); } catch (e) { /* 非法编码保持原样 */ }
        const seg = pathname.split('/').filter(Boolean);
        // 常见形态：/yd_rsdtq/index.html → 取 yd_rsdtq 之前的部分判断
        const meaningful = seg.filter((x) => !/^index\.html?$/i.test(x));
        const last = meaningful.length ? meaningful[meaningful.length - 1] : '';
        // 去掉扩展名
        const stem = last.replace(/\.[a-z0-9]{1,5}$/i, '');

        // ① 含中文（或其它非 ASCII 文字）→ 一定是给人看的，直接用
        if (/[^\x00-\x7F]/.test(stem)) return stem;
        if (!stem) return u.hostname || '未命名独立前端角色卡';
        // ② 判断是否像"机器生成的标识符"：
        //    · 含下划线/连字符（yd_rsdtq、abc-def）→ 是
        //    · 同时含字母和数字且不像单词（x1y2z3）→ 是
        //    · 否则（adventure、story）→ 是人能读的词，保留
        //    ⚠️ 不能用「连续两个元音」判定：adventure / story 都不含连续元音，会被误伤。
        const hasLetter = /[a-z]/i.test(stem);
        const hasDigit = /\d/.test(stem);
        const looksLikeId = /[_-]/.test(stem) || (hasLetter && hasDigit) || !/[aeiouy]/i.test(stem);
        if (looksLikeId) return u.hostname || '未命名独立前端角色卡';
        return stem;
    } catch (e) {
        return '未命名独立前端角色卡';
    }
}

/** 归一化配置里读出来的条目（兼容旧字段缺失） */
export function normalizeHeavyCard(raw) {
    if (!raw || !raw.id) return null;
    const gen = Math.max(1, Math.round(Number(raw.gen) || 1));
    const settings = raw.settings || {};
    const auto = settings.autoBackup || {};
    return {
        id: String(raw.id),
        name: String(raw.name || '未命名独立前端角色卡'),
        url: String(raw.url || ''),
        icon: String(raw.icon || '🎬'),
        note: String(raw.note || ''),
        gen,
        partition: raw.partition || `persist:heavycard-${raw.id}_g${gen}`,
        createdAt: Number(raw.createdAt) || 0,
        lastOpenedAt: Number(raw.lastOpenedAt) || 0,
        totalPlayMs: Number(raw.totalPlayMs) || 0,
        // 🩹 C3：上次成功打开时的地址快照（用于换址判定；空 = 首次/旧配置）
        lastOpenUrl: String(raw.lastOpenUrl || ''),
        // 📂 本地目录模式：登记过的本地根目录（含 index.html）。
        //    ⚠️ 必须在白名单里显式保留 —— 这是白名单式归一化，漏一行就会被静默丢弃，
        //       表现为「导入本地卡后列表有了、一打开却还是走远程地址」。
        localDir: String(raw.localDir || ''),
        // 🏷️ 名字是否仍是"从 URL 自动猜的"（true ⇒ 页面加载后可用 <title> 覆盖）
        //    ⚠️ 旧配置没有这个字段：若名字与 guessNameFromUrl 的结果一致，也视为自动名
        autoName: raw.autoName !== undefined
            ? !!raw.autoName
            : (String(raw.name || '') === guessNameFromUrl(raw.url)),
        settings: {
            offline: !!settings.offline,
            zoom: Math.min(2, Math.max(0.5, Number(settings.zoom) || 1)),
            allowExternal: settings.allowExternal !== false,
            autoBackup: {
                enabled: auto.enabled !== false,
                onExit: auto.onExit !== false,
                onOpen: !!auto.onOpen,
                intervalMin: Number.isFinite(Number(auto.intervalMin)) ? Number(auto.intervalMin) : 30,
                keep: Math.min(20, Math.max(1, Number(auto.keep) || 5))
            }
        },
        backupStats: raw.backupStats || { lastBackupAt: 0, lastSize: 0, count: 0 }
    };
}

export function useHeavyCards({ appMode, syncConfigToDiskDebounced, addLog, showToast }) {
    /** 卡清单（与 app_config.json 的 ui.heavyCards 双向同步） */
    const heavyCards = ref([]);
    const activeHeavyCard = ref(null);
    const heavyCardSearchQuery = ref('');
    const heavyCardStatus = ref('idle'); // idle | loading | ready | error | crashed
    /** 加载失败的具体原因（主进程已翻译成中文，直接展示给用户） */
    const heavyCardErrorText = ref('');
    const heavyCardZoom = ref(1);
    const heavyCardFrameUrl = ref('');
    /** view 是否已挂载（手动备份等场景需要临时卸载） */
    const heavyCardMounted = ref(false);

    const filteredHeavyCards = computed(() => {
        const q = heavyCardSearchQuery.value.trim().toLowerCase();
        if (!q) return heavyCards.value;
        return heavyCards.value.filter((c) =>
            (c.name || '').toLowerCase().includes(q) ||
            (c.note || '').toLowerCase().includes(q) ||
            (c.url || '').toLowerCase().includes(q)
        );
    });

    const toPlainCard = (card) => ({
        id: String(card?.id || ''),
        name: String(card?.name || ''),
        url: String(card?.url || ''),
        gen: Math.max(1, Math.round(Number(card?.gen) || 1)),
        partition: String(card?.partition || '')
    });

    /** 持久化（走既有配置中枢） */
    const persist = () => {
        try { if (typeof syncConfigToDiskDebounced === 'function') syncConfigToDiskDebounced(); } catch (e) { /* 尚未就绪 */ }
    };

    /** 从配置恢复（由 useConfigPersistence 调用；首次自动补预置卡） */
    const loadFromConfig = (list) => {
        const arr = Array.isArray(list) ? list.map(normalizeHeavyCard).filter(Boolean) : [];
        heavyCards.value = arr.length ? arr : [normalizeHeavyCard({ ...PRESET_HEAVY_CARD, createdAt: Date.now() })];
        // 📂 本地卡用的 `heavycard-local://` 协议，其「根目录表」在主进程是**内存 Map**，
        //    应用重启后为空 ⇒ 必须在这里把每张本地卡重新登记一次，否则打开就是 404
        //    （用户看到的现象：卡还在列表里，一点就「加载失败」且毫无提示）。
        try { reRegisterLocalRoots(); } catch (e) { /* 不阻塞启动 */ }
    };

    /**
     * 📂 把所有带 localDir 的卡重新登记到主进程（幂等，可反复调）。
     * 失败的单张不影响其它卡，且不弹窗（启动阶段尽量安静），只记一条日志。
     */
    const reRegisterLocalRoots = async () => {
        try {
            if (!window.electronAPI?.heavyCard?.setLocalRoot) return;
            const locals = (heavyCards.value || []).filter((c) => c && c.localDir);
            for (const c of locals) {
                try { await window.electronAPI.heavyCard.setLocalRoot(toPlainCard(c), c.localDir); }
                catch (e) { /* 单张失败跳过 */ }
            }
        } catch (e) { /* 忽略 */ }
    };

    /** 供 useConfigPersistence 收集 */
    const collectForConfig = () => heavyCards.value.map((c) => ({
        id: c.id,
        name: c.name,
        url: c.url,
        icon: c.icon,
        note: c.note,
        gen: c.gen,
        partition: c.partition,
        createdAt: c.createdAt,
        lastOpenedAt: c.lastOpenedAt,
        totalPlayMs: c.totalPlayMs,
        autoName: !!c.autoName,
        settings: c.settings,
        backupStats: c.backupStats,
        // 📂 本地卡根目录 —— **必须收集**，否则写盘时被剥掉：
        //    重启后卡还在列表里，但 `localDir` 丢了 ⇒ 只剩一个假的
        //    `heavycard-local://<id>/index.html` 当 url ⇒ 一打开就 404、用户看到「加载失败」。
        //    ⚠️ 这是白名单式收集，与 normalizeHeavyCard 必须**成对维护**（漏一处就丢数据）。
        localDir: c.localDir || '',
        // 🩹 C3：换址判定用的地址快照，同样必须持久化
        lastOpenUrl: c.lastOpenUrl || ''
    }));

    /** 添加 */
    const addHeavyCard = ({ url, name, icon, note }) => {
        if (!url) return null;
        const autoName = guessNameFromUrl(url);
        const card = normalizeHeavyCard({
            id: makeHeavyCardId(url),
            name: name || autoName,
            url,
            icon: icon || '🎬',
            note: note || '',
            // 🏷️ 记录"这个名字是自动猜的" —— 页面加载后拿到 <title> 才允许覆盖它
            autoName: !name,
            gen: 1,
            createdAt: Date.now()
        });
        heavyCards.value = [...heavyCards.value, card];
        persist();
        return card;
    };

    /**
     * 📂 添加「本地 HTML」卡（2026-10-25 新增；用户反馈找不到导入入口）
     *
     * 支持的两种形态（主进程弹原生选择框）：
     *   · mode='dir'  → 选文件夹（含 index.html）
     *   · mode='file' → 选单个 .html 文件（会复制到 userData 内，不原地引用）
     *
     * ⚠️ 为什么单文件要复制：用户下完卡常把文件放桌面/下载夹，事后清理就删了。
     *    原地引用会导致「昨天还好好的卡，今天打不开」。复制一份自己保管更稳。
     *
     * @param {'dir'|'file'} mode
     * @returns {Promise<{success:boolean, card?:object, error?:string}>}
     */
    const addHeavyCardLocal = async (mode = 'dir') => {
        try {
            if (!window.electronAPI?.heavyCard?.importLocalHtml) {
                return { success: false, error: '当前版本不支持导入本地卡（IPC 通道缺失）' };
            }
            const res = await window.electronAPI.heavyCard.importLocalHtml({ mode });
            if (!res || !res.success) return { success: false, error: (res && res.error) || '导入失败' };

            const dir = res.dir;
            // 用目录名/标题作为卡名；单文件优先用 <title>
            const fallbackName = String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '本地卡';
            const name = String(res.title || '').trim() || fallbackName;

            // 本地卡的 url 用一个占位（真实加载走 heavycard-local:// 协议），便于列表展示
            const url = `heavycard-local://${encodeURIComponent(name)}/index.html`;
            const card = normalizeHeavyCard({
                id: makeHeavyCardId(`local:${dir}`),
                name,
                url,
                icon: '📁',
                note: res.isSingleFile ? `本地单文件：${res.sourcePath || ''}` : `本地目录：${dir}`,
                autoName: false,
                gen: 1,
                createdAt: Date.now(),
                localDir: dir
            });
            heavyCards.value = [...heavyCards.value, card];
            persist();

            // 立刻向主进程登记本地根目录（否则打开时会 404）
            try { await window.electronAPI.heavyCard.setLocalRoot(toPlainCard(card), dir); } catch (e) { /* 打开时会再登记一次 */ }

            if (typeof addLog === 'function') {
                addLog(`📂 已导入本地卡「${name}」${res.isSingleFile ? '（单文件已复制到软件数据目录）' : ''}`, 'success');
            }
            return { success: true, card };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 更新（浅合并） */
    const updateHeavyCard = (id, patch) => {        const idx = heavyCards.value.findIndex((c) => c.id === id);
        if (idx < 0) return false;
        const next = normalizeHeavyCard({ ...heavyCards.value[idx], ...patch });
        const arr = heavyCards.value.slice();
        arr[idx] = next;
        heavyCards.value = arr;
        if (activeHeavyCard.value && activeHeavyCard.value.id === id) activeHeavyCard.value = next;
        persist();
        return true;
    };

    /** 删除（同时销毁 view） */
    const removeHeavyCard = async (id) => {
        try { await window.electronAPI.heavyCard.close(id); } catch (e) { /* 忽略 */ }
        heavyCards.value = heavyCards.value.filter((c) => c.id !== id);
        if (activeHeavyCard.value && activeHeavyCard.value.id === id) {
            activeHeavyCard.value = null;
            heavyCardMounted.value = false;
            heavyCardStatus.value = 'idle';
            heavyCardErrorText.value = '';
        }
        persist();
        return true;
    };

    // =========================================================
    // 🏷️ 用页面真实标题改名
    // =========================================================
    //  背景（用户实测反馈）：「导入新链接后，侧边栏名字显示成地址」——
    //    新加卡时还不知道页面叫什么，只能从 URL 猜（`/yd_rsdtq/index.html` → `yd_rsdtq`）。
    //    主进程在 `did-stop-loading` 时回传 `<title>`，这里把「自动猜的名字」换掉。
    //  ⚠️ 只覆盖**自动名**：用户手动改过的名字（含添加时自定义的）绝不能被页面标题冲掉。
    const applyPageTitle = (id, rawTitle) => {
        const title = String(rawTitle || '').trim();
        if (!id || !title || title.length > 120) return false;
        const card = heavyCards.value.find((c) => c.id === id);
        if (!card) return false;
        // 用户改过名 / 添加时就指定了名字 → 不动
        if (card.autoName === false) return false;

        // 标题常带站点后缀（"云端人生 - 某某工作室" / "云端人生 | 官网"），取主标题段
        const primary = title.split(/\s+[-|–—·]\s+/)[0].trim() || title;
        // 标题就是域名 / 网址 → 还不如现在
        if (/^https?:\/\//i.test(primary) || /^[\w.-]+\.(com|cn|net|org|io|cc|top|xyz)$/i.test(primary)) return false;
        if (primary === card.name) {
            // 名字已经对了，只把 autoName 标记落定，避免下次重复比较
            updateHeavyCard(card.id, { autoName: false });
            return false;
        }

        updateHeavyCard(card.id, { name: primary, autoName: false });
        if (typeof addLog === 'function') addLog(`🏷️ 独立前端角色卡已按页面标题命名：${primary}`, 'info');
        return true;
    };

    /** 订阅主进程回传的页面标题（由 HeavyCardWorkspace 在 onMounted 调用一次） */
    const subscribePageTitle = () => {
        try {
            window.electronAPI.heavyCard.onTitle((p) => {
                if (p && p.id) applyPageTitle(p.id, p.title);
            });
        } catch (e) { /* 旧版本无该通道时忽略 */ }
    };

    // =========================================================
    // 布局同步（D3：DIP 直传）
    // =========================================================

    let rectTimer = null;
    let lastRectKey = '';

    /**
     * 上报占位框 rect 给主进程
     * @param {HTMLElement} hostEl 占位框
     * @param {{top?:number,right?:number,bottom?:number,left?:number}|null} [inset]
     *        让位区域（DIP）：原生视图需要**避开**的 DOM 浮层（如「显示工具栏」恢复按钮）。
     *        ⚠️ WebContentsView 在 OS 合成层，DOM 的 z-index 对它无效，点击也进不来；
     *           唯一可靠做法是把视图矩形缩小，给浮层腾出可点区域（用户实锤反馈）。
     * ⚠️ rect 必须是 `getBoundingClientRect()` 原值（DIP），此处只做取整与节流
     */
    const reportRect = (hostEl, inset) => {
        if (!hostEl || !activeHeavyCard.value) return;
        const r = hostEl.getBoundingClientRect();
        // ⚠️ 占位框尺寸为 0 时**绝不上报**（热测实锤）：
        //    从侧栏点卡 → openHeavyCard(card, null) 先建 view（rect 全 0，被判为空不可见）；
        //    随后 watch(activeHeavyCard) 在模板刚渲染、布局未稳定时量到 0×0，
        //    再上报一次就把 view 永久压扁 —— 徽标停在 error、所有 view 操作报「view 不存在」。
        //    宁可等下一帧（ResizeObserver 一定会再触发），也不能拿 0 尺寸覆盖有效 rect。
        if (!(r.width > 0) || !(r.height > 0)) return;
        const rect = {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height)
        };
        const cleanInset = inset && typeof inset === 'object'
            ? {
                top: Math.max(0, Math.round(Number(inset.top) || 0)),
                right: Math.max(0, Math.round(Number(inset.right) || 0)),
                bottom: Math.max(0, Math.round(Number(inset.bottom) || 0)),
                left: Math.max(0, Math.round(Number(inset.left) || 0))
            }
            : null;
        // 去重键必须带上 inset —— 否则「隐藏工具栏」切换时 rect 不变、inset 变了，会被误判为无变化而不上报
        const insKey = cleanInset
            ? `${cleanInset.top},${cleanInset.right},${cleanInset.bottom},${cleanInset.left}`
            : '';
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}|${insKey}`;
        if (key === lastRectKey) return;
        lastRectKey = key;
        if (rectTimer) clearTimeout(rectTimer);
        rectTimer = setTimeout(() => {
            try {
                window.electronAPI.heavyCard.setBounds(activeHeavyCard.value.id, rect, cleanInset)
                    .catch(() => { /* view 尚未创建 */ });
            } catch (e) { /* 忽略 */ }
        }, 16);
    };

    // =========================================================
    // 打开 / 关闭
    // =========================================================

    /**
     * 等待重型卡占位框出现并拿到有效尺寸（最多 ~1.5s，每 50ms 轮询一次）。
     * 为什么必须等：`WebContentsView` 以 0×0 创建后渲染视口会被钉死为 0，
     * 后续 setBounds 也救不回来（实测 2026-10-18）。
     * @returns {Promise<{x:number,y:number,width:number,height:number}>}
     */
    const waitForHostRect = async (timeoutMs = 1500) => {
        const deadline = Date.now() + timeoutMs;
        let last = { x: 0, y: 0, width: 0, height: 0 };
        while (Date.now() < deadline) {
            // 等一帧，让 Vue 完成 v-if / v-show 的 DOM 更新
            await new Promise((r) => requestAnimationFrame(() => r()));
            let el = null;
            try { el = document.getElementById('heavycard-host-box'); } catch (e) { el = null; }
            if (el) {
                const b = el.getBoundingClientRect();
                last = {
                    x: Math.round(b.left),
                    y: Math.round(b.top),
                    width: Math.round(b.width),
                    height: Math.round(b.height)
                };
                if (last.width > 0 && last.height > 0) return last;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        // 超时兜底：给一个保守的可用尺寸（窗口内固定区域），避免 0×0 建视图。
        // 主进程随后仍会收到渲染层的真实 setBounds 并纠正。
        return {
            x: last.x || 0,
            y: last.y || 0,
            width: last.width || Math.max(1, Math.floor((window.innerWidth || 1200) * 0.6)),
            height: last.height || Math.max(1, Math.floor((window.innerHeight || 800) * 0.6))
        };
    };

    const openHeavyCard = async (card, hostEl) => {
        if (!card) return false;
        const prev = activeHeavyCard.value;
        if (prev && prev.id !== card.id) {
            try { await window.electronAPI.heavyCard.close(prev.id); } catch (e) { /* 忽略 */ }
        }
        activeHeavyCard.value = card;
        heavyCardFrameUrl.value = card.url;
        heavyCardZoom.value = card.settings?.zoom || 1;
        heavyCardMounted.value = true;
        heavyCardStatus.value = 'loading';
        heavyCardErrorText.value = '';
        heavyCardIdle.value = false;
        markHeavyCardActivity();
        lastRectKey = '';

        const r = hostEl ? hostEl.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const rect = {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height)
        };
        // 🔑 关键（2026-10-18 用户实测「角色卡渲染不到位」）：
        //    `WebContentsView` 一旦以 **0×0** 创建，Chromium 会把渲染视口钉死在 0，
        //    之后 setBounds 再大多也救不回来（实测 innerWidth 恒为 0，页面文字在但完全看不见）。
        //    从侧栏点卡时 `<heavy-card-workspace>` 还没渲染出占位框 ⇒ hostEl 为 null ⇒ rect 全 0。
        //    ⇒ 拿不到有效尺寸就**先等布局**（最多 ~1.5s），宁晚一点打开，也不要用 0 尺寸建视图。
        let openRect = rect;
        if (openRect.width <= 0 || openRect.height <= 0) {
            openRect = await waitForHostRect();
        }
        try {
            // ⚠️ 必须转纯对象：activeHeavyCard 是 Vue 的 reactive Proxy，直接过 IPC 会报
            //    `An object could not be cloned.`（冒烟实测抓获）
            // 📂 本地目录模式：登记过 localDir 的卡优先走 heavycard-local://
            const plainSettings = toPlainSettings(card.settings);
            const effective = card.localDir
                ? { ...toPlainCard(card), url: `heavycard-local://${card.id}/index.html`, settings: plainSettings }
                : { ...toPlainCard(card), settings: plainSettings };
            if (card.localDir) {
                try {
                    await window.electronAPI.heavyCard.setLocalRoot(toPlainCard(card), card.localDir);
                } catch (e) { /* 登记失败则回退远程 */ }
            }
            const res = await window.electronAPI.heavyCard.open(effective, openRect);
            if (!res || !res.success) {
                heavyCardStatus.value = 'error';
                heavyCardErrorText.value = String((res && (res.desc || res.error)) || '无法启动内嵌浏览器进程');
                if (typeof addLog === 'function') addLog(`独立前端角色卡打开失败: ${(res && res.error) || '未知'}`, 'error');
                return false;
            }
            // 记录最近打开时间
            updateHeavyCard(card.id, { lastOpenedAt: Date.now() });
            // 🩹 C3（换址提示）：记住「这次成功打开时的地址」，下次打开时对比。
            //    用途：换了域名/端口/本地目录后，浏览器存储可能读不到旧存档 —— 必须明确告知用户，
            //    而不是让用户一脸懵「我的进度怎么没了」。
            try {
                const snapUrl = card.localDir ? `heavycard-local://${card.id}/index.html` : String(card.url || '');
                updateHeavyCard(card.id, { lastOpenUrl: snapUrl });
            } catch (e) { /* 忽略：不影响打开 */ }
            try { await window.electronAPI.heavyCard.setZoom(card.id, heavyCardZoom.value); } catch (e) { /* 忽略 */ }
            return true;
        } catch (e) {
            heavyCardStatus.value = 'error';
            heavyCardErrorText.value = String((e && e.message) || '未知异常');
            if (typeof addLog === 'function') addLog(`独立前端角色卡打开异常: ${e.message}`, 'error');
            return false;
        }
    };

    const closeHeavyCard = async () => {
        const card = activeHeavyCard.value;
        if (card) {
            try { await window.electronAPI.heavyCard.close(card.id); } catch (e) { /* 忽略 */ }
        }
        stopAutoBackupTimer();
        heavyCardMounted.value = false;
        heavyCardStatus.value = 'idle';
        heavyCardErrorText.value = '';
    };

    // =========================================================
    // ⏱️ 定时自动备份（游玩期间，规格 §6.1 第二行）
    // =========================================================
    //  设计取舍：
    //    · 用 `setTimeout` 链而非 `setInterval`：备份耗时可能超过间隔，
    //      链式调度能保证"上一次做完再排下一次"，不会堆积。
    //    · 只在「卡已打开 且 状态 ready」时计时：loading/error 时备份没意义，
    //      而且此时刷盘也可能撞上正在写入的 leveldb。
    //    · 切卡 / 关闭 / 关闭软件时清掉定时器，避免备份到已离开的卡。
    let autoBackupTimer = null;

    const stopAutoBackupTimer = () => {
        if (autoBackupTimer) {
            clearTimeout(autoBackupTimer);
            autoBackupTimer = null;
        }
    };


    // =========================================================
    // 工具条动作
    // =========================================================

    const reloadHeavyCard = async (ignoreCache = true) => {
        const card = activeHeavyCard.value;
        if (!card) return;
        heavyCardStatus.value = 'loading';
        heavyCardErrorText.value = '';
        try { await window.electronAPI.heavyCard.reload(card.id, ignoreCache); } catch (e) { /* 忽略 */ }
    };

    /** 变更缩放：主进程的 setZoomFactor 与 DIP 坐标无关，可放心叠加 */
    const changeZoom = async (delta) => {
        const card = activeHeavyCard.value;
        if (!card) return;
        const next = Math.min(2, Math.max(0.5, Math.round((heavyCardZoom.value + delta) * 10) / 10));
        heavyCardZoom.value = next;
        updateHeavyCard(card.id, { settings: { ...card.settings, zoom: next } });
        try { await window.electronAPI.heavyCard.setZoom(card.id, next); } catch (e) { /* 忽略 */ }
    };

    const openHeavyCardDataDir = async () => {
        const card = activeHeavyCard.value;
        if (!card) return;
        const res = await window.electronAPI.heavyCard.openDataDir(toPlainCard(card));
        if (!res || !res.success) {
            if (typeof showToast === 'function') showToast(`打开目录失败: ${(res && res.error) || '未知'}`, 'error');
        }
    };

    const clearHeavyCardCache = async () => {
        const card = activeHeavyCard.value;
        if (!card) return;
        const res = await window.electronAPI.heavyCard.clearCache(card.id);
        if (typeof showToast === 'function') {
            showToast(res && res.success ? '缓存已清理（存档未受影响）' : '清理缓存失败', res && res.success ? 'success' : 'error');
        }
    };

    /** 读取磁盘占用（面板展示用） */
    const getStorageInfo = async (card) => {
        try {
            const res = await window.electronAPI.heavyCard.storageInfo(toPlainCard(card));
            return res && res.success ? res : null;
        } catch (e) {
            return null;
        }
    };

    // =========================================================
    // 备份 / 恢复（一卡一备份）
    // =========================================================

    const heavyCardBackups = ref([]);        // 当前卡的备份列表（旧→新）
    const heavyCardBackupBusy = ref(false);  // 备份/恢复进行中

    /** 刷新当前卡的备份列表 */
    const refreshBackups = async (card = activeHeavyCard.value) => {
        if (!card) { heavyCardBackups.value = []; return []; }
        try {
            const res = await window.electronAPI.heavyCard.listBackups(toPlainCard(card));
            heavyCardBackups.value = (res && res.success && Array.isArray(res.list)) ? res.list : [];
        } catch (e) {
            heavyCardBackups.value = [];
        }
        return heavyCardBackups.value;
    };

    /**
     * 手动备份
     * @param {'manual'|'auto'} kind
     */
    const backupHeavyCard = async (kind = 'manual') => {
        const card = activeHeavyCard.value;
        if (!card || heavyCardBackupBusy.value) return { success: false, error: '忙碌或未选卡' };
        heavyCardBackupBusy.value = true;
        try {
            const keep = card.settings?.autoBackup?.keep || 5;
            const res = await window.electronAPI.heavyCard.backup(toPlainCard(card), kind, keep);
            if (res && res.success) {
                updateHeavyCard(card.id, {
                    backupStats: {
                        lastBackupAt: Date.now(),
                        lastSize: res.totalBytes || 0,
                        count: (heavyCardBackups.value.length || 0) + 1
                    }
                });
                if (typeof showToast === 'function') {
                    showToast(`备份完成（${res.fileCount} 个文件）`, 'success');
                }
            } else if (typeof showToast === 'function') {
                showToast(`备份失败: ${(res && res.error) || '未知'}`, 'error');
            }
            await refreshBackups(card);
            return res;
        } catch (e) {
            if (typeof showToast === 'function') showToast(`备份异常: ${e.message}`, 'error');
            return { success: false, error: e.message };
        } finally {
            heavyCardBackupBusy.value = false;
        }
    };

    /**
     * 恢复备份（世代轮换，免重启）
     * ⚠️ 恢复后 card.gen / partition 会变，必须重建视图
     */
    const restoreHeavyCard = async (backupName, hostEl = null) => {
        const card = activeHeavyCard.value;
        if (!card || !backupName || heavyCardBackupBusy.value) return { success: false, error: '忙碌或参数不完整' };
        heavyCardBackupBusy.value = true;
        try {
            const keep = card.settings?.autoBackup?.keep || 5;
            const res = await window.electronAPI.heavyCard.restore(toPlainCard(card), backupName, keep);
            if (!res || !res.success) {
                if (typeof showToast === 'function') showToast(`恢复失败: ${(res && res.error) || '未知'}`, 'error');
                return res;
            }
            // 世代切换：清理旧 view（主进程已在恢复流程中销毁）→ 更新清单 → 重新打开
            const next = {
                ...card,
                gen: res.nextGen,
                partition: res.nextPartition
            };
            heavyCardMounted.value = false;
            updateHeavyCard(card.id, { gen: next.gen, partition: next.partition });
            activeHeavyCard.value = normalizeHeavyCard(next);
            await openHeavyCard(activeHeavyCard.value, hostEl);
            await refreshBackups(activeHeavyCard.value);
            if (typeof showToast === 'function') {
                showToast(`已恢复到 ${backupName}`, 'success');
            }
            return res;
        } catch (e) {
            if (typeof showToast === 'function') showToast(`恢复异常: ${e.message}`, 'error');
            return { success: false, error: e.message };
        } finally {
            heavyCardBackupBusy.value = false;
        }
    };

    /** 删除一份备份 */
    const deleteHeavyCardBackup = async (backupName) => {
        const card = activeHeavyCard.value;
        if (!card || !backupName) return false;
        try {
            const res = await window.electronAPI.heavyCard.deleteBackup(toPlainCard(card), backupName);
            if (res && res.success) await refreshBackups(card);
            return !!(res && res.success);
        } catch (e) {
            return false;
        }
    };

    /** 打开备份目录 */
    const openHeavyCardBackupDir = async () => {
        const card = activeHeavyCard.value;
        if (!card) return;
        const res = await window.electronAPI.heavyCard.openBackupDir(toPlainCard(card));
        if (!res || !res.success) {
            if (typeof showToast === 'function') showToast(`打开备份目录失败: ${(res && res.error) || '未知'}`, 'error');
        }
    };

    // =========================================================
    // 📦 跨机迁移（P2-2）
    // =========================================================

    /** 导出当前卡最新（或指定）备份为单文件 tar */
    const exportHeavyCardBundle = async (backupName = null) => {
        const card = activeHeavyCard.value;
        if (!card) return { success: false, error: '未选卡' };
        try {
            const res = await window.electronAPI.heavyCard.exportBundle(toPlainCard(card), backupName);
            if (res && res.success) {
                if (typeof showToast === 'function') showToast(`已导出：${res.fileCount} 个文件`, 'success');
            } else if (res && res.error !== '用户取消') {
                if (typeof showToast === 'function') showToast(`导出失败: ${res.error}`, 'error');
            }
            return res;
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 从 tar 导入为一份新备份（导入后需手动点「恢复」） */
    const importHeavyCardBundle = async () => {
        const card = activeHeavyCard.value;
        if (!card) return { success: false, error: '未选卡' };
        try {
            const res = await window.electronAPI.heavyCard.importBundle(toPlainCard(card));
            if (res && res.success) {
                await refreshBackups(card);
                if (typeof showToast === 'function') showToast(`已导入 ${res.fileCount} 个文件，可在列表里恢复`, 'success');
            } else if (res && res.error !== '用户取消') {
                if (typeof showToast === 'function') showToast(`导入失败: ${res.error}`, 'error');
            }
            return res;
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // 📴 离线模式（P2-1）
    // =========================================================

    const heavyCardBlockedLog = ref([]);

    /** 切换离线模式（立即生效，无需重开卡） */
    const setHeavyCardOffline = async (offline) => {
        const card = activeHeavyCard.value;
        if (!card) return false;
        const next = !!offline;
        const whitelist = Array.isArray(card.settings?.offlineWhitelist) ? card.settings.offlineWhitelist.slice() : [];
        updateHeavyCard(card.id, { settings: { ...card.settings, offline: next } });
        try {
            const res = await window.electronAPI.heavyCard.setOffline(
                { ...toPlainCard(card), settings: toPlainSettings({ ...card.settings, offline: next }) }, next, whitelist
            );
            if (res && res.success) {
                if (typeof showToast === 'function') {
                    showToast(next ? '已开启离线模式（仅放行本站域名）' : '已关闭离线模式', 'info');
                }
            }
            return !!(res && res.success);
        } catch (e) {
            return false;
        }
    };

    const refreshBlockedLog = async () => {
        try {
            const res = await window.electronAPI.heavyCard.blockedLog();
            heavyCardBlockedLog.value = (res && res.list) || [];
        } catch (e) { /* 忽略 */ }
    };

    // =========================================================
    // 📂 本地目录模式（P2-3）
    // =========================================================

    /** 选一个本地文件夹并把它登记为该卡的来源（覆盖远程 URL） */
    const setHeavyCardLocalDir = async (withPick = true) => {
        const card = activeHeavyCard.value;
        if (!card) return { success: false, error: '未选卡' };
        try {
            let dir = card.localDir || '';
            if (withPick) {
                const picked = await window.electronAPI.heavyCard.pickLocalDir();
                if (!picked || !picked.success) {
                    if (picked && picked.error !== '用户取消' && typeof showToast === 'function') {
                        showToast(picked.error, 'error');
                    }
                    return picked || { success: false, error: '用户取消' };
                }
                dir = picked.dir;
            }
            if (!dir) return { success: false, error: '没有目录' };
            const reg = await window.electronAPI.heavyCard.setLocalRoot(toPlainCard(card), dir);
            if (!reg || !reg.success) {
                if (typeof showToast === 'function') showToast(`登记失败: ${(reg && reg.error) || '未知'}`, 'error');
                return reg;
            }
            // 记录到卡清单；下次打开优先用本地地址
            updateHeavyCard(card.id, { localDir: dir });
            activeHeavyCard.value = normalizeHeavyCard({ ...activeHeavyCard.value, localDir: dir });
            if (typeof showToast === 'function') showToast('已切换到本地目录模式', 'success');
            return { success: true, dir, url: reg.url };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    /** 清除本地目录，恢复远程 URL */
    const clearHeavyCardLocalDir = async () => {
        const card = activeHeavyCard.value;
        if (!card) return false;
        try {
            await window.electronAPI.heavyCard.setLocalRoot(toPlainCard(card), null);
            updateHeavyCard(card.id, { localDir: '' });
            activeHeavyCard.value = normalizeHeavyCard({ ...activeHeavyCard.value, localDir: '' });
            if (typeof showToast === 'function') showToast('已恢复远程地址', 'info');
            return true;
        } catch (e) {
            return false;
        }
    };

    // =========================================================
    // 😴 闲置自动隐藏（P2-4）
    // =========================================================

    let idleTimer = null;
    let lastActivityAt = Date.now();
    const IDLE_MS = 10 * 60 * 1000;   // 10 分钟无操作即隐藏
    const heavyCardIdle = ref(false);

    const markHeavyCardActivity = () => { lastActivityAt = Date.now(); };

    const setIdleHidden = async (idle) => {
        const card = activeHeavyCard.value;
        if (!card) return;
        heavyCardIdle.value = !!idle;
        try { await window.electronAPI.heavyCard.setIdle(card.id, !!idle); } catch (e) { /* 忽略 */ }
    };

    /** 启动闲置检测（离开 heavycards 模式时检查，避免影响其它模式） */
    const startIdleWatch = () => {
        stopIdleWatch();
        idleTimer = setInterval(async () => {
            if (appMode.value !== 'heavycards' || !heavyCardMounted.value) return;
            if (heavyCardIdle.value) return;
            if (Date.now() - lastActivityAt > IDLE_MS) {
                await setIdleHidden(true);
                if (typeof addLog === 'function') addLog('😴 独立前端角色卡已闲置 10 分钟，视图已隐藏以节省内存', 'info');
            }
        }, 60 * 1000);
    };
    const stopIdleWatch = () => {
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    };

    /**
     * (重)启动定时器
     * @param {object} card 目标卡
     */
    const startAutoBackupTimer = (card) => {
        stopAutoBackupTimer();
        if (!card) return;
        const s = card.settings?.autoBackup || {};
        if (s.enabled === false) return;
        const min = Number(s.intervalMin);
        if (!Number.isFinite(min) || min <= 0) return;   // 0 = 关闭
        const delayMs = Math.max(1, Math.min(24 * 60, min)) * 60 * 1000;

        const schedule = () => {
            autoBackupTimer = setTimeout(async () => {
                autoBackupTimer = null;
                // 期间可能已切卡/关闭/改配置 —— 每轮重新校验
                const cur = activeHeavyCard.value;
                const cs = cur?.settings?.autoBackup || {};
                if (!cur || cur.id !== card.id || cur.gen !== card.gen) return;
                if (cs.enabled === false || !(Number(cs.intervalMin) > 0)) return;
                if (heavyCardStatus.value !== 'ready') { schedule(); return; }
                if (heavyCardBackupBusy.value) { schedule(); return; }   // 手动操作优先，下一轮再试
                try {
                    await backupHeavyCard('auto');
                    if (typeof addLog === 'function') addLog('⏱️ 独立前端角色卡定时备份完成', 'info');
                } catch (e) {
                    if (typeof addLog === 'function') addLog(`独立前端角色卡定时备份失败: ${e.message}`, 'error');
                }
                schedule();
            }, delayMs);
        };
        schedule();
    };

    /** 修改某卡的自动备份设置后，若该卡正打开则立刻按新配置重排 */
    const applyAutoBackupSettings = (cardId) => {
        const card = heavyCards.value.find((c) => c.id === cardId);
        if (!card) return;
        if (activeHeavyCard.value && activeHeavyCard.value.id === cardId) {
            startAutoBackupTimer(card);
        }
    };
    
    // 卡状态变 ready 时启动计时；变其他状态时暂停
    watch(heavyCardStatus, (st) => {
        const card = activeHeavyCard.value;
        if (!card) return;
        if (st === 'ready') startAutoBackupTimer(card);
        else stopAutoBackupTimer();
    });
    // 切卡时重置
    watch(() => activeHeavyCard.value?.id, (id, old) => {
        if (!id || (old && old !== id)) stopAutoBackupTimer();
    });


    // =========================================================
    // D1：弹窗遮挡裁决
    // =========================================================

    /**
     * 主进程 view 是否应该可见
     * 规则：处于 heavycards 模式 + 已挂载 + 无任何主界面弹窗 + 文档可见
     * @param {boolean} anyModalOpen 由 App.vue 汇总的弹窗状态
     */
    const syncViewVisibility = (anyModalOpen) => {
        const shouldShow = appMode.value === 'heavycards' && heavyCardMounted.value && !anyModalOpen;
        try { window.electronAPI.heavyCard.setVisible(shouldShow).catch(() => {}); } catch (e) { /* 忽略 */ }
    };

    // 离开 heavycards 模式 → 立刻隐藏（不等下一帧，避免闪一下）
    watch(appMode, (mode) => {
        if (mode !== 'heavycards') {
            try { window.electronAPI.heavyCard.setVisible(false).catch(() => {}); } catch (e) { /* 忽略 */ }
        }
    });

    return {
        // 状态
        heavyCards, activeHeavyCard, heavyCardSearchQuery, filteredHeavyCards,
        heavyCardStatus, heavyCardZoom, heavyCardFrameUrl, heavyCardMounted,
        heavyCardErrorText,
        // 持久化
        loadFromConfig, collectForConfig,
        // 🏷️ 页面标题改名
        subscribePageTitle, applyPageTitle,
        // CRUD
        addHeavyCard, updateHeavyCard, removeHeavyCard,
        addHeavyCardLocal,   // 📂 导入本地卡（文件夹 / 单个 .html）
        // 打开关闭
        openHeavyCard, closeHeavyCard,
        // 备份 / 恢复
        heavyCardBackups, heavyCardBackupBusy,
        refreshBackups, backupHeavyCard, restoreHeavyCard,
        deleteHeavyCardBackup, openHeavyCardBackupDir,
        // ⏱️ 定时自动备份
        startAutoBackupTimer, stopAutoBackupTimer, applyAutoBackupSettings,
        // 📦 跨机迁移
        exportHeavyCardBundle, importHeavyCardBundle,
        // 📴 离线模式
        setHeavyCardOffline, refreshBlockedLog, heavyCardBlockedLog,
        // 📂 本地目录模式
        setHeavyCardLocalDir, clearHeavyCardLocalDir,
        // 😴 闲置自动隐藏
        heavyCardIdle, setHeavyCardIdleHidden: setIdleHidden,
        startHeavyCardIdleWatch: startIdleWatch, stopHeavyCardIdleWatch: stopIdleWatch,
        markHeavyCardActivity,
        // 布局与可见性
        reportRect, syncViewVisibility,
        // 工具条
        reloadHeavyCard, changeZoom, openHeavyCardDataDir, clearHeavyCardCache, getStorageInfo
    };
}
