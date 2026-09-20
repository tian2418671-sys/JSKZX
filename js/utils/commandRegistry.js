/**
 * 🎛️ 命令注册表（Command Registry）—— P2 的「单一真相源」
 *
 * 为什么需要它（方案 §三 P2-1）：
 *   改动前 `HeaderBar.vue` 内 **47 处 `@click` 全部硬编码**、同一命令在菜单 / 工具栏 / 快捷键各写一遍；
 *   快捷键处理散落在 `App.vue` 两处 `keydown`（`:2418` / `:2472`），且 `Ctrl+S` 靠**手写分支**路由到
 *   `pluginWorkspaceRef`（`:2399`）→ 改一处文案或快捷键要 grep 全项目，且极易漏改（AR-13 同类静默失效）。
 *   本模块把「命令是什么」与「命令显示在哪」分开：**菜单 / 工具栏 / 命令面板 / 快捷键全部从注册表渲染**。
 *
 * 设计与借鉴（方案 §十一）：
 *   · 结构参考 **VS Code**（`contributes` + 命令面板为统一入口）
 *   · `when` 条件 **v1 只支持单值相等比较**（评审意见 二-3：不做表达式引擎，语法留扩展空间）
 *   · 快捷键冲突策略 **后注册拒绝 + 明确报错**（评审意见 二-2：绝不静默覆盖）
 *
 * 零 Vue / 零 Electron 依赖，可 `node --test` 直接测。
 */

/** 修饰键固定顺序，保证归一化结果稳定 */
const MOD_ORDER = { ctrl: 0, alt: 1, shift: 2, meta: 3 };

/**
 * KeyboardEvent.key 在"只按下修饰键"时的取值 —— 这些不能被当成主键。
 * ⚠️ 注意 `Control`（事件里的键名）与 `ctrl`（归一化用的键名）**拼写不同**，两者都要过滤。
 */
const MOD_KEY_NAMES = new Set(['ctrl', 'control', 'alt', 'altgraph', 'shift', 'meta', 'os']);

/**
 * 归一化快捷键：大小写 / 空格 / 修饰键顺序不敏感。
 * 例：`'Ctrl + Shift + P'` → `'ctrl+shift+p'`
 * @param {string} raw
 * @returns {string} 空串表示无效
 */
export function normalizeShortcut(raw) {
    const parts = String(raw == null ? '' : raw)
        .toLowerCase()
        .split('+')
        .map(s => s.trim())
        .filter(Boolean);
    if (!parts.length) return '';
    const mods = parts.filter(p => p in MOD_ORDER).sort((a, b) => MOD_ORDER[a] - MOD_ORDER[b]);
    const keys = parts.filter(p => !(p in MOD_ORDER));
    return [...mods, ...keys].join('+');
}

/**
 * 从 KeyboardEvent 生成归一化快捷键串（供 keydown 分发查找命令）。
 * ⚠️ 仅取"是否按了修饰键 + 主键"，不做平台差异处理（macOS 的 Cmd 映射为 `meta`）。
 * @param {KeyboardEvent|{ctrlKey?:boolean,altKey?:boolean,shiftKey?:boolean,metaKey?:boolean,key?:string}} e
 * @returns {string}
 */
export function shortcutFromEvent(e) {
    if (!e) return '';
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('meta');
    const key = String(e.key == null ? '' : e.key).toLowerCase();
    if (key && !MOD_KEY_NAMES.has(key)) parts.push(key);
    return normalizeShortcut(parts.join('+'));
}

/**
 * `when` 条件求值 —— **v1 只支持** `key == 'value'` / `key === 'value'`（允许点号路径）。
 *
 * 语法不认识时**返回 true**（宽松策略）：宁可多显示一个命令，也不因写法不认识而把命令藏掉
 * （藏掉 = 用户看不见、又查不出原因，正是 AR-13 那类"静默失效"的体感）。
 *
 * @param {string} expr 形如 `appMode == 'worldbooks'`
 * @param {object} context 条件求值上下文（如 `{ appMode: 'cards', hasCard: true }`）
 * @returns {boolean}
 */
export function evaluateWhen(expr, context = {}) {
    if (!expr) return true;
    const m = String(expr).match(/^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*===?\s*'([^']*)'\s*$/);
    if (!m) return true; // 语法不支持 → 不拦截
    const path = m[1].split('.');
    let cur = context;
    for (const k of path) {
        if (cur == null || typeof cur !== 'object') return false;
        cur = cur[k];
    }
    return String(cur) === m[2];
}

/**
 * 创建命令注册表实例。
 *
 * 命令对象字段（全部可选，除 `id` / `title` / `run`）：
 * ```
 * {
 *   id: 'file.openLibrary',        // 唯一 id（必填）
 *   title: '📁 打开角色库目录…',     // 显示名（必填，或 `titleFn()` 动态标题）
 *   category: '文件',               // 命令面板分组
 *   menu: 'file',                  // 归属菜单：字符串或**数组**（数组 = 同一命令多菜单镜像入口）
 *   section: 1,                    // 菜单内分组序号（section 变化处渲染分隔线）
 *   sectionTitle: '🧹 维护',        // 可选：该分组的标题（只认组内第一条的声明）
 *   order: 10,                     // 组内排序（小在前）
 *   shortcut: 'Ctrl+O',            // 快捷键（冲突 → 后注册拒绝）
 *   danger: false,                 // 危险命令（菜单/面板红字 + 二次确认由调用方负责）
 *   when: "appMode == 'cards'",    // 显示/可用条件（v1 单值比较）
 *   tooltip: '',                   // 悬停说明
 *   badge: () => string,           // 动态状态后缀（如打标管线「规则✓ 向量✗ AI✓」）
 *   checked: () => boolean,        // 是否显示 ✓（视图开关类）
 *   run: () => void                // 执行体（必填）
 * }
 * ```
 */
export function createCommandRegistry() {
    const byId = new Map();          // id -> command
    const byShortcut = new Map();    // normalized shortcut -> id
    const problems = [];             // 注册期问题（id 重复 / 快捷键冲突 / 字段非法）

    /**
     * 注册一条命令。**id 重复或快捷键冲突一律拒绝**（保留先注册者）并记入 problems —— 不静默覆盖。
     * @param {object} cmd
     * @returns {boolean} 是否注册成功
     */
    function register(cmd) {
        if (!cmd || typeof cmd !== 'object') {
            problems.push({ type: 'invalid', reason: '命令不是对象' });
            return false;
        }
        const id = String(cmd.id || '').trim();
        const title = String(cmd.title || '').trim();
        // ⚠️ 标题可以是静态 `title`，也可以是动态 `titleFn()`（如「窗口」里的主题名、工具栏图谱按模式切换）
        const hasTitle = !!title || typeof cmd.titleFn === 'function';
        if (!id || !hasTitle || typeof cmd.run !== 'function') {
            problems.push({ type: 'invalid', id, reason: '缺少 id / title（或 titleFn）/ run' });
            return false;
        }
        if (byId.has(id)) {
            problems.push({ type: 'duplicate-id', id, reason: `命令 id 重复，已拒绝后注册者（保留「${byId.get(id).title}」）` });
            return false;
        }
        const shortcut = normalizeShortcut(cmd.shortcut);          // 归一化：仅用于匹配/冲突检测
        const shortcutLabel = String(cmd.shortcut || '').trim();   // 原始文案：用于菜单显示（如「Ctrl+O」）
        if (shortcut && byShortcut.has(shortcut)) {
            const owner = byShortcut.get(shortcut);
            problems.push({ type: 'shortcut-conflict', id, reason: `快捷键 ${cmd.shortcut} 已被「${byId.get(owner).title}」占用，已拒绝后注册者` });
            return false;
        }
        // ⚠️ `menu` 允许是数组：**同一命令可出现在多个菜单**（评审意见 二-2 的镜像入口要求
        //     「主题/字号/重置外观」在「视图 → 外观」与「设置」两处必须是**同一条命令**，
        //     否则两处入口各自持一份状态，必然出现同步 bug）。`menus[0]` 为无关排序时用的主菜单。
        const menus = (Array.isArray(cmd.menu) ? cmd.menu : [cmd.menu])
            .map(m => String(m || '').trim()).filter(Boolean);
        // ⚠️ `shortcut` 保留原始大小写（菜单要显示「Ctrl+O」而不是「ctrl+o」），`shortcutKey` 才是归一化匹配键
        const normalized = { ...cmd, id, title, menus, menu: menus[0] || '', shortcut: shortcutLabel, shortcutKey: shortcut };
        byId.set(id, normalized);
        if (shortcut) byShortcut.set(shortcut, id);
        return true;
    }

    /** 批量注册（遇到失败继续注册其余，最后可用 problems 汇报） */
    function registerMany(list) {
        let n = 0;
        for (const c of (Array.isArray(list) ? list : [])) if (register(c)) n++;
        return n;
    }

    /** 取单条命令（不存在返回 null） */
    function get(id) {
        return byId.get(String(id || '')) || null;
    }

    /** 全部命令（按 menu / section / order 排序，渲染与面板共用同一顺序） */
    function list() {
        return [...byId.values()].sort((a, b) => {
            const ma = String(a.menus && a.menus[0] || ''), mb = String(b.menus && b.menus[0] || '');
            if (ma !== mb) return ma < mb ? -1 : 1;
            const sa = Number(a.section || 0), sb = Number(b.section || 0);
            if (sa !== sb) return sa - sb;
            const oa = Number(a.order || 0), ob = Number(b.order || 0);
            if (oa !== ob) return oa - ob;
            return a.title.localeCompare(b.title);
        });
    }

    /**
     * 取某菜单下的命令（已按 section 分组：`[{ section, commands }]`，供模板渲染分隔线）。
     * @param {string} menu
     * @param {object} [context] when 求值上下文（不传则不过滤）
     */
    function listByMenu(menu, context) {
        // ⚠️ 必须**按本菜单的 section/order 独立排序**，不能复用 `list()` 的顺序：
        //    `list()` 是按 `menus[0]`（主菜单）排的，多菜单命令（镜像入口）在**非主菜单**里
        //    就会按主菜单名落到错误位置（实测：把「标签」菜单里的「反选」「批量加标签」甩到末尾，
        //    并让 sectionTitle 重复出现）。这是 P2 实施期踩到的排序 bug。
        const items = [...byId.values()]
            .filter(c => (c.menus || []).includes(menu))
            .filter(c => (context === undefined ? true : evaluateWhen(c.when, context)))
            .sort((a, b) => {
                const sa = Number(a.section || 0), sb = Number(b.section || 0);
                if (sa !== sb) return sa - sb;
                const oa = Number(a.order || 0), ob = Number(b.order || 0);
                if (oa !== ob) return oa - ob;
                return String(a.title || '').localeCompare(String(b.title || ''));
            });
        const groups = [];
        for (const c of items) {
            const s = Number(c.section || 0);
            const last = groups[groups.length - 1];
            if (!last || last.section !== s) {
                // 🆕 `sectionTitle`：分组小标题（只认该组第一条的声明，渲染在分隔线之后）
                groups.push({ section: s, sectionTitle: String(c.sectionTitle || ''), commands: [c] });
            } else last.commands.push(c);
        }
        return groups;
    }

    /**
     * 按快捷键查命令 id（keydown 分发入口）。
     * @param {KeyboardEvent|string} evOrShortcut
     * @param {object} [context] when 求值上下文
     * @returns {string|null} 命中的命令 id（被 when 拦下则返回 null）
     */
    function findShortcut(evOrShortcut, context) {
        const s = typeof evOrShortcut === 'string' ? normalizeShortcut(evOrShortcut) : shortcutFromEvent(evOrShortcut);
        if (!s) return null;
        const id = byShortcut.get(s);
        if (!id) return null;
        const cmd = byId.get(id);
        if (context !== undefined && !evaluateWhen(cmd.when, context)) return null;
        return id;
    }

    /**
     * 执行命令。未知 id 返回 false（不抛错 —— 调用方多为 UI 事件）。
     * 执行体抛错时记入 problems 并返回 false：**单条命令出错不得拖垮宿主**（P5 同款纪律）。
     */
    function execute(id, ...args) {
        const cmd = byId.get(String(id || ''));
        if (!cmd) {
            problems.push({ type: 'unknown-command', id, reason: '执行了未注册的命令' });
            return false;
        }
        try {
            cmd.run(...args);
            return true;
        } catch (e) {
            problems.push({ type: 'run-error', id, reason: (e && e.message) || String(e) });
            return false;
        }
    }

    /** 注册期与运行期问题清单（CI/自检用；正常应为空） */
    function getProblems() {
        return [...problems];
    }

    return { register, registerMany, get, list, listByMenu, findShortcut, execute, getProblems };
}
