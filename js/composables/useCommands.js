/**
 * 🎛️ 应用内置命令注册（P2）
 *
 * 把原先**硬编码在 `HeaderBar.vue` 模板里的菜单命令**集中到这一份定义里：
 * 菜单 / 工具栏 / 命令面板 / 快捷键以后全部从注册表渲染与分发（方案 §三 P2-1）。
 *
 * 为什么这样拆：
 *   · 命令的**执行体**都在 `App.vue` 的 ctx 上（方法 / ref），所以注册必须发生在 ctx 就绪之后；
 *   · 本文件只声明「命令是什么、显示在哪、何时可用」，不碰渲染（渲染在 HeaderBar）。
 *
 * 用法（`App.vue`）：
 *   setup 早期：`const commandRegistry = createCommandRegistry();`
 *   ctx 定义之后：`registerAppCommands(commandRegistry, ctx);`
 *
 * ⚠️ 字段说明见 `js/utils/commandRegistry.js`；本文件额外用到的扩展字段：
 *   · `titleFn()`    —— 动态标题（替代静态 `title`）
 *   · `badge()`      —— 标题右侧状态后缀（如打标管线状态）
 *   · `checked()`    —— 左侧 ✓（开关型命令）
 *   · `disabled()`   —— 是否禁用
 *   · `extraClass`   —— 附加样式类（保持与改动前视觉一致）
 */

/** 命令 `title` 取值（支持 titleFn 动态标题） */
export function resolveCommandTitle(cmd) {
    if (!cmd) return '';
    if (typeof cmd.titleFn === 'function') {
        try { return String(cmd.titleFn() || ''); } catch (e) { return String(cmd.title || ''); }
    }
    return String(cmd.title || '');
}

/** 安全求值命令的可选函数字段（disabled / checked / badge） */
export function safeCall(fn, fallback = undefined) {
    if (typeof fn !== 'function') return fallback;
    try { return fn(); } catch (e) { return fallback; }
}

/**
 * 注册全部内置命令。
 * @param {ReturnType<import('../utils/commandRegistry.js').createCommandRegistry>} registry
 * @param {object} ctx App.vue 的 ctx 对象（含全部方法 / ref）
 * @returns {number} 成功注册条数
 */
export function registerAppCommands(registry, ctx) {
    const v = (ref) => (ref && typeof ref === 'object' && 'value' in ref ? ref.value : ref);

    return registry.registerMany([
        // ==================== 文件（F） ====================
        {
            id: 'file.openLibrary', title: '📁 打开角色库目录...', category: '文件',
            menu: 'file', section: 1, order: 10, shortcut: 'Ctrl+O',
            run: () => ctx.selectFixedDirectory()
        },
        {
            id: 'file.openWorldbooks', title: '🌍 打开世界书目录...', category: '文件',
            menu: 'file', section: 1, order: 20, extraClass: 'hover:bg-amber-600',
            run: () => ctx.loadWorldbooks()
        },
        // 🆕 打开预设目录：**功能早已存在**（侧边栏预设视图里的按钮调 `loadPresets`），但一直没进顶部菜单
        {
            id: 'file.openPresets', title: '📂 打开预设目录...', category: '文件',
            menu: 'file', section: 1, order: 30, extraClass: 'hover:bg-sky-600',
            tooltip: '选择酒馆的预设目录并扫描 .json 预设（顶部「预设」标签页里查看结果）',
            run: () => ctx.loadPresets()
        },
        {
            id: 'file.importCards', title: '➕ 导入角色卡', category: '文件',
            menu: 'file', section: 2, order: 10, shortcut: 'Ctrl+I',
            run: () => ctx.importCards()
        },
        {
            id: 'file.importFromUrl', title: '🌐 从链接导入角色卡...', category: '文件',
            menu: 'file', section: 2, order: 20,
            run: () => ctx.downloadCardFromUrl()
        },
        {
            id: 'file.saveCurrentAsset', title: '💾 物理保存修改', category: '文件',
            menu: 'file', section: 2, order: 30, shortcut: 'Ctrl+S',
            disabled: () => !v(ctx.cardData) && !v(ctx.activeWorldbook),
            run: () => ctx.saveCurrentAssetSmart()
        },
        {
            id: 'file.exportSelected', title: '📦 导出选中卡片...', category: '文件',
            menu: 'file', section: 3, order: 10,
            run: () => ctx.batchExportSelected()
        },
        {
            id: 'file.openBakFolder', title: '⏱️ 查看历史快照', category: '维护',
            menu: 'maintenance', section: 1, order: 10,
            tooltip: '打开库目录下的 .bak_history 快照文件夹',
            run: () => ctx.openBakFolder()
        },
        {
            id: 'file.openTrashFolder', title: '🗑️ 查看回收站', category: '维护',
            menu: 'maintenance', section: 1, order: 20,
            tooltip: '打开当前库目录下的回收站文件夹',
            run: () => ctx.openTrashFolder()
        },
        {
            id: 'file.openGlobalTrash', title: '🗑️ 打开全局回收站', category: '维护',
            menu: 'maintenance', section: 1, order: 30,
            tooltip: '打开跨库共用的全局回收站目录',
            run: () => ctx.openGlobalTrash()
        },

        // ==================== 选择 / 打标（原「编辑」菜单已并入「标签」菜单，2026-09-20 按用户决定） ====================
        {
            id: 'edit.multiSelect', title: '☑️ 批量选择模式', category: '标签',
            menu: 'tags', section: 1, order: 5, sectionTitle: '☑️ 选择',
            checked: () => !!v(ctx.isMultiSelectMode),
            run: () => { ctx.isMultiSelectMode.value = !ctx.isMultiSelectMode.value; }
        },
        {
            id: 'edit.selectAll', title: '全选所有卡片', category: '标签',
            menu: 'tags', section: 1, order: 20,
            tooltip: '把当前搜索结果里的卡片全部选中（自动进入批量选择模式）',
            run: () => ctx.selectAllCards()
        },
        // 🆕 反选：与「全选」同口径（只作用于当前搜索结果）—— 用户 2026-09-20 提出的「标签」菜单里补齐
        {
            id: 'edit.selectInvert', title: '反选', category: '标签',
            menu: 'tags', section: 1, order: 30,
            tooltip: '把当前搜索结果里「没选中的」选上、「已选中的」取消（与全选同一范围）',
            run: () => ctx.selectInvertCards()
        },
        // 🆕 批量加标签：**功能早已存在**（批量操作悬浮台里的 `batchAddTag`），但一直没有菜单入口
        {
            id: 'tag.batchAdd', title: '🏷️ 批量加标签…', category: '标签',
            menu: 'tags', section: 2, order: 15, extraClass: 'hover:bg-emerald-600',
            tooltip: '给当前选中的卡片批量打上指定标签（会物理落盘）',
            run: () => ctx.batchAddTag()
        },
        {
            id: 'edit.aiTag', title: '🏷️ AI 智能批量打标', category: '标签',
            menu: 'tags', section: 2, order: 10, sectionTitle: '🏷️ 打标',
            badge: () => safeCall(() => v(ctx.funnelBadge), ''),
            badgeTitle: () => (v(ctx.funnelEmpty) ? '三层打标管线均已关闭，打标无法执行' : '当前打标管线（「设置 → 🏷️ 打标与分类」可调整）'),
            badgeClass: () => (v(ctx.funnelEmpty) ? 'text-rose-400' : ''),
            run: () => ctx.openAITagModal()
        },
        {
            id: 'edit.batchCategory', title: '📂 批量修改分类分组', category: '标签',
            menu: 'tags', section: 2, order: 20,
            run: () => ctx.batchChangeCategoryModal()
        },
        {
            id: 'edit.cleanGlobalTags', title: '🧹 清理无效全局标签', category: '标签',
            menu: ['tools', 'tags'], section: 3, order: 30, sectionTitle: '🧹 整理与清理',
            tooltip: '扫描并清理没有被任何卡片引用的全局标签',
            run: () => ctx.cleanGlobalTagsPrompt()
        },
        {
            id: 'edit.dedupeSmart', titleFn: () => `🔍 同名查重与版本清理（${v(ctx.dedupeTargetLabel)}）...`, category: '工具',
            menu: 'tools', section: 3, order: 40, extraClass: 'hover:bg-amber-600 text-amber-400',
            tooltip: '按名称查重，保留最新版本并把旧版送入回收站',
            run: () => ctx.startSmartDedupe()
        },
        {
            id: 'edit.dedupeContent', titleFn: () => `🧬 版本查重：跨名称识别相似内容（${v(ctx.dedupeTargetLabel)}）...`, category: '工具',
            menu: 'tools', section: 3, order: 50, extraClass: 'hover:bg-purple-600 text-purple-400',
            tooltip: '不依赖名称，按内容相似度识别同一张卡的多个版本',
            run: () => ctx.startContentDedupeScan()
        },

        // ==================== 推送（P） ====================
        {
            id: 'push.openModal', title: '🚀 推送选中卡片...', category: '推送',
            menu: 'push', section: 1, order: 10, extraClass: 'hover:bg-emerald-600 font-medium',
            run: () => { ctx.showPushModal.value = true; }
        },
        {
            id: 'push.addTarget', title: '🗂️ 新增卡库目标...', category: '推送',
            menu: 'push', section: 2, order: 10, extraClass: 'hover:bg-emerald-600',
            run: () => ctx.addCustomPushTarget()
        },

        // ==================== 窗口（W）= 视图开关 ====================
        {
            id: 'view.sidebar', title: '📁 侧边栏 (角色卡列表)', category: '视图',
            menu: 'view', section: 1, order: 10,
            checked: () => !!ctx.viewOptions.value.showSidebar,
            run: () => { ctx.viewOptions.value.showSidebar = !ctx.viewOptions.value.showSidebar; }
        },
        {
            id: 'view.toolbar', title: '🛠️ 快捷工具栏', category: '视图',
            menu: 'view', section: 1, order: 20,
            checked: () => !!ctx.viewOptions.value.showToolbar,
            run: () => { ctx.viewOptions.value.showToolbar = !ctx.viewOptions.value.showToolbar; }
        },
        {
            id: 'view.avatarPreview', title: '🖼️ 高清大立绘面板', category: '视图',
            menu: 'view', section: 2, order: 10,
            checked: () => !!ctx.viewOptions.value.showAvatarPreview,
            run: () => { ctx.viewOptions.value.showAvatarPreview = !ctx.viewOptions.value.showAvatarPreview; }
        },
        {
            id: 'view.tokenStats', title: '📊 Token 分析看板', category: '视图',
            menu: 'view', section: 2, order: 20,
            checked: () => !!ctx.viewOptions.value.showTokenStats,
            run: () => { ctx.viewOptions.value.showTokenStats = !ctx.viewOptions.value.showTokenStats; }
        },
        {
            id: 'view.worldbook', title: '🌍 世界书 Lorebook 区域', category: '视图',
            menu: 'view', section: 2, order: 30,
            checked: () => !!ctx.viewOptions.value.showWorldbook,
            run: () => { ctx.viewOptions.value.showWorldbook = !ctx.viewOptions.value.showWorldbook; }
        },
        {
            id: 'view.regex', title: '⚡ 正则脚本对照区', category: '视图',
            menu: 'view', section: 2, order: 40,
            checked: () => !!ctx.viewOptions.value.showRegex,
            run: () => { ctx.viewOptions.value.showRegex = !ctx.viewOptions.value.showRegex; }
        },
        {
            id: 'view.plugins', title: '🧩 卡内插件页签', category: '视图',
            menu: 'view', section: 2, order: 50,
            checked: () => !!ctx.viewOptions.value.showPlugins,
            run: () => { ctx.viewOptions.value.showPlugins = !ctx.viewOptions.value.showPlugins; }
        },
        {
            id: 'view.rawJson', title: '📄 Raw JSON 代码区', category: '视图',
            menu: 'view', section: 2, order: 60,
            checked: () => !!ctx.viewOptions.value.showRawJson,
            run: () => { ctx.viewOptions.value.showRawJson = !ctx.viewOptions.value.showRawJson; }
        },

        // ==================== 外观（只挂在「设置 → 🎨 外观与字号」） ====================
        // 2026-09-20 用户决定：**视图菜单不再放外观组**（与设置里的完全重复）。
        //    外观属“设置项”，只从设置进入；工具栏的「主题」快捷按钮仍保留（循环切换）。
        {
            id: 'appearance.themeDark', title: '🌙 暗夜极客', category: '外观',
            menu: 'settings', section: 3, order: 10,
            checked: () => v(ctx.theme) === 'dark',
            run: () => ctx.setTheme('dark')
        },
        {
            id: 'appearance.themeSlate', title: '🌊 雅致青灰', category: '外观',
            menu: 'settings', section: 3, order: 20,
            checked: () => v(ctx.theme) === 'slate',
            run: () => ctx.setTheme('slate')
        },
        {
            id: 'appearance.themeLight', title: '☀️ 明亮白昼', category: '外观',
            menu: 'settings', section: 3, order: 30,
            checked: () => v(ctx.theme) === 'light',
            run: () => ctx.setTheme('light')
        },
        {
            id: 'appearance.fontUiUp', title: '🔠 界面字号 +1', category: '外观',
            menu: 'settings', section: 3, order: 40,
            tooltip: '界面 UI 字号上限 28px（设置里的滑块可精细调整）',
            disabled: () => Number(v(ctx.appSettings).uiFontSize || 13) >= 28,
            // ⚠️ 直写 `appSettings`（真实来源），HeaderBar 的草稿值有 watch 会同步回来 —— 不需要额外跨组件通道
            run: () => { const s = ctx.appSettings.value; s.uiFontSize = Math.min(28, Number(s.uiFontSize || 13) + 1); }
        },
        {
            id: 'appearance.fontUiDown', title: '🔡 界面字号 -1', category: '外观',
            menu: 'settings', section: 3, order: 50,
            tooltip: '界面 UI 字号下限 10px（设置里的滑块可精细调整）',
            disabled: () => Number(v(ctx.appSettings).uiFontSize || 13) <= 10,
            run: () => { const s = ctx.appSettings.value; s.uiFontSize = Math.max(10, Number(s.uiFontSize || 13) - 1); }
        },
        {
            id: 'appearance.reset', title: '🎨 重置界面外观与字号', category: '外观',
            menu: 'settings', section: 3, order: 60,
            tooltip: '主题、界面 UI 字号、工作区编辑字号一并恢复默认',
            run: () => ctx.resetPersonalizationSettings()
        },

        // ==================== 设置（S）—— 仅"命令"，开关/滑块等控件仍留在模板 ====================
        {
            id: 'settings.api', title: '⚡ API 引擎与模型设置...', category: '设置',
            menu: 'settings', section: 1, order: 10, extraClass: 'hover:bg-indigo-600 font-medium',
            run: () => { ctx.showApiModal.value = true; }
        },
        {
            id: 'settings.resetApi', title: '🔄 重置 API 接口参数', category: '设置',
            menu: 'settings', section: 1, order: 20, danger: true, extraClass: 'hover:bg-rose-600 text-rose-400',
            run: () => ctx.resetApiSettings()
        },
        {
            id: 'settings.cleanForeignTags', title: '🧹 清洗历史外来标签', category: '标签',
            menu: ['tools', 'tags'], section: 3, order: 60, danger: true, extraClass: 'hover:bg-amber-600',
            tooltip: '清除开关开启前已收编进卡片的外来标签（保留系统标签库/自动规则/已归类标签），物理落盘；执行前有二次确认',
            run: () => ctx.cleanForeignTagsFromLibrary()
        },
        {
            id: 'settings.tagging.manageRules', title: '📝 管理规则表（逐条开关）…', category: '标签',
            menu: ['settings', 'tags'], section: 3, order: 10, sectionTitle: '🧹 整理与清理',
            tooltip: '内置打标规则逐条启停（也能按组一键全开/全关）',
            run: () => { ctx.showAutoTagRulesModal.value = true; }
        },
        {
            id: 'settings.tagging.resetDisabled', title: '↩️ 恢复内置规则全开', category: '标签',
            menu: ['settings', 'tags'], section: 3, order: 20, extraClass: 'hover:bg-emerald-600',
            disabled: () => v(ctx.autoTagRulesStats).disabled === 0,
            run: () => ctx.resetAutoTagDisabledRules()
        },
        {
            id: 'settings.cleanAllSnapshots', title: '🧹 一键清理全部历史快照', category: '维护',
            menu: 'maintenance', section: 1, order: 40, danger: true,
            tooltip: '删除库目录下所有历史快照文件夹，释放硬盘空间；执行前有二次确认',
            run: () => ctx.cleanAllSnapshots()
        },
        {
            id: 'settings.cleanOrphanSnapshots', title: '🗑️ 清理孤儿快照（已删卡残留）', category: '维护',
            menu: 'maintenance', section: 1, order: 50, danger: true,
            tooltip: '仅删除「对应卡片已被删除」的孤儿快照目录，仍有卡片存活的快照会保留',
            run: () => ctx.cleanOrphanSnapshots()
        },
        {
            id: 'settings.checkUpdate', title: '🔄 检查应用更新...', category: '帮助',
            menu: 'help', section: 1, order: 10, extraClass: 'hover:bg-emerald-600 text-emerald-400 font-bold',
            tooltip: '手动检查是否有新版本可用',
            run: () => ctx.checkForUpdatesManual()
        },

        // ==================== 实验与工具 ====================
        {
            id: 'app.commandPalette', titleFn: () => '⌘ 命令面板...', category: '通用',
            menu: 'tools', section: 1, order: 1, shortcut: 'Ctrl+Shift+P',
            tooltip: '搜索并执行任意命令（菜单里的命令都可在这里找到）',
            run: () => ctx.openCommandPalette()
        },
        // ==================== 实验（早期/不稳定功能专区；稳定工具请放「工具」菜单） ====================
        {
            id: 'tools.diskScan', title: '🛰️ 全盘打捞卡片', category: '实验',
            menu: 'lab', section: 1, order: 10,
            run: () => { ctx.showDiskScanModal.value = true; }
        },
        {
            id: 'tools.chatTest', title: '💬 本地 AI 对话测卡', category: '实验',
            menu: 'lab', section: 2, order: 10, extraClass: 'hover:bg-amber-600 font-medium',
            run: () => ctx.openChatTab()
        },

        // ==================== 工具栏（紧凑栏，位置与样式保持不变） ====================
        // 🆕 P2-2 归位：删掉与「文件」菜单重复的两项（📂 打开本地库 / 🌐 链接导入）—— 工具栏只留高频按钮。
        //             「备份配置」改为 `file.backupConfig`（`menu` 数组 = 文件菜单 + 工具栏共用同一 id）。
        {
            id: 'toolbar.graph', titleFn: () => (v(ctx.appMode) === 'worldbooks' ? '🌍 关系图谱' : '🌌 关系图谱'), category: '工具',
            menu: 'toolbar', section: 1, order: 30,
            tooltipFn: () => (v(ctx.appMode) === 'worldbooks' ? '生成当前世界书的词条关联图谱' : '生成全库角色关系图谱'),
            run: () => ctx.openGraphSmart()
        },
        // ⛔ 已下线（2026-09-20，用户决定）：全局资产库功能关闭 —— 入口隐藏、代码保留备查。
        //    恢复：取消本段注释 + `HeaderBar.vue` 工具栏按钮 + `App.vue` 的弹窗渲染（三处都留了标记）。
        //    日后若转「扩展」重启，见 docs/规格与计划/后续升级计划.md 第四节（P3）+ 方案 §四 P3。
        // {
        //     id: 'toolbar.globalAssets', title: '📚 全局资产库', category: '工具',
        //     menu: 'toolbar', section: 1, order: 40,
        //     tooltip: '查看全库收集的世界书与正则脚本',
        //     run: () => { ctx.showGlobalAssetModal.value = true; }
        // },
        {
            id: 'theme.toggle', titleFn: () => (v(ctx.theme) === 'dark' ? '🌙 暗夜' : (v(ctx.theme) === 'slate' ? '🌊 青灰' : '☀️ 白昼')), category: '外观',
            // ⚠️ 只留在工具栏（手写按钮）：它是「循环切换」快捷方式，与「视图 → 🎨 外观」的 3 个直选
            //    作用于**同一份主题状态**（= 评审 2-2「状态单源」的本意）；若也塞进视图菜单，
            //    菜单里会同时出现「🌙 暗夜（循环）」和「🌙 暗夜极客（直选）」两项，图标相同、语义难分（截图核对时发现）。
            menu: 'toolbar', section: 1, order: 50,
            tooltip: '循环切换三套主题 (暗夜/青灰/白昼)',
            run: () => ctx.toggleTheme()
        },
        {
            id: 'file.backupConfig', title: '💾 备份配置', category: '文件',
            menu: ['file', 'toolbar'], section: 4, order: 10, sectionTitle: '💾 配置备份与恢复',
            tooltip: '把当前的库索引与设置导出成一个 JSON 备份文件',
            run: () => ctx.exportLibraryDB()
        }
    ]);
}

export { createCommandRegistry } from '../utils/commandRegistry.js';
