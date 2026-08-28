<!--
  SidebarPanel 左侧资源管理器（角色卡库/世界书库）+ 拖拽调宽把手（子组件）
  ⚠️ 所有状态/方法经 provide/inject 从 App.vue 共享（inject('appCtx') 后按名解构，
      ref 解构后模板自动解包；ref="sidebarEl" 写回父级 ref，父级 startSidebarResize 依赖）
-->
<template>
    <!-- 【左侧】资源管理器 (库列表) -->
    <aside v-if="viewOptions.showSidebar"
           ref="sidebarEl"
           class="bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0 relative"
           :style="sidebarStyle">
        <!-- ⚡ 双引擎模式切换 -->
        <div class="px-3 py-2.5 border-b border-zinc-800 bg-zinc-900 flex gap-2 select-none">
            <button @click="appMode = 'characters'"
                    :class="appMode === 'characters' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-900/30' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'"
                    class="flex-1 py-1.5 text-xs font-bold rounded-lg shadow transition flex items-center justify-center gap-1.5">
                🎎 角色卡库 <span class="opacity-70 font-normal">({{ library.length }})</span>
            </button>
            <button @click="appMode = 'worldbooks'"
                    :class="appMode === 'worldbooks' ? 'bg-amber-600 text-white shadow-md shadow-amber-900/30' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'"
                    class="flex-1 py-1.5 text-xs font-bold rounded-lg shadow transition flex items-center justify-center gap-1.5">
                🌍 世界书库 <span class="opacity-70 font-normal">({{ worldbooks.length }})</span>
            </button>
            <button @click="appMode = 'presets'"
                    :class="appMode === 'presets' ? 'bg-sky-600 text-white shadow-md shadow-sky-900/30' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'"
                    class="flex-1 py-1.5 text-xs font-bold rounded-lg shadow transition flex items-center justify-center gap-1.5">
                ⚙️ 预设 <span class="opacity-70 font-normal">({{ presets.length }})</span>
            </button>
        </div>

        <!-- ============ 角色卡模式 ============ -->
        <template v-if="appMode === 'characters'">
        <!-- ✅ [UI 方案1] 顶部搜索区：行1=搜索+多选+扫描+漏斗，行2=分类+排序 -->
        <div class="px-3 py-2.5 border-b border-zinc-800 bg-zinc-900 flex flex-col gap-2 shrink-0 z-10">
            <!-- 行1：搜索 + 多选 + 扫描 + 高级筛选漏斗 -->
            <div class="flex items-center gap-1.5">
                <div class="relative flex-1">
                    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 text-xs">🔍</span>
                    <input id="global-search-input" v-model="searchQueryInput" type="text"
                           placeholder="搜索名称/标签/世界书 (Ctrl+F)"
                           title="全局搜索名称、标签、世界书、关键词 (Ctrl+F 快速聚焦)"
                           class="w-full h-8 bg-zinc-800/80 border border-zinc-700/60 rounded-lg pl-8 pr-6 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500/80 transition">
                    <button v-if="searchQueryInput" @click="searchQueryInput = ''; searchQuery = ''" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs leading-none">✕</button>
                </div>
                <button @click="isMultiSelectMode = !isMultiSelectMode"
                        :title="isMultiSelectMode ? '退出批量多选' : '开启批量多选'"
                        class="h-8 w-8 flex items-center justify-center rounded-lg text-xs transition shrink-0"
                        :class="isMultiSelectMode ? 'bg-amber-600 text-white font-bold' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700/50'">
                    ☑️
                </button>
                <button @click="refreshLibrary" title="重新扫描当前库目录（读取新放入的卡片）" class="h-8 w-8 flex items-center justify-center rounded-lg text-xs transition shrink-0 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700/50">
                    🔄
                </button>
                <button @click="showAdvancedFilters = !showAdvancedFilters"
                        class="h-8 w-8 flex items-center justify-center rounded-lg transition shrink-0"
                        :class="hasActiveFilters ? 'text-amber-500 border border-amber-500/50 bg-amber-500/10' : 'text-zinc-400 hover:text-zinc-200 border border-zinc-700/50 bg-zinc-800'"
                        :title="showAdvancedFilters ? '收起高级筛选' : '展开高级筛选'">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h18M6 9h12M10 14h4M12 19h0"/></svg>
                </button>
            </div>

            <!-- 搜索语法提示（超级搜索引擎：多词 AND / 前缀语法 / 排除词） -->
            <p class="text-[10px] text-zinc-500 leading-relaxed px-1.5 py-1 bg-zinc-800/40 border border-zinc-800 rounded-md select-none">
                💡 <code class="text-zinc-400">傲娇 女仆</code>多词
                <span class="text-zinc-700">|</span> <code class="text-zinc-400">t:奇幻</code>标签
                <span class="text-zinc-700">|</span> <code class="text-zinc-400">a:作者</code>
                <span class="text-zinc-700">|</span> <code class="text-zinc-400">w:世界书</code>
                <span class="text-zinc-700">|</span> <code class="text-zinc-400">f:文件</code>
                <span class="text-zinc-700">|</span> <code class="text-zinc-400">-排除</code>
            </p>

            <!-- 行2：分类下拉 + 排序下拉 -->
            <div class="flex items-center gap-1.5 text-xs">
                <select v-model="currentCategoryKey" class="flex-1 min-w-0 h-7 bg-zinc-800/80 border border-zinc-700/60 rounded-lg px-2 text-zinc-300 focus:outline-none focus:border-blue-500/80 truncate">
                    <option v-for="cat in allCategories" :key="cat.key" :value="cat.key">
                        📁 {{ getCategoryDisplayName(cat) }}
                    </option>
                </select>
                <select v-model="sortBy" title="列表排序方式" class="w-28 h-7 bg-zinc-800/80 border border-zinc-700/60 rounded-lg px-2 text-zinc-400 focus:outline-none focus:border-blue-500/80 truncate shrink-0">
                    <option value="name">排序: 名称</option>
                    <option value="time">排序: 最新</option>
                    <option value="tokens">排序: Token</option>
                </select>
            </div>
        </div>

        <!-- 高级筛选折叠面板（点击漏斗展开；平时不占空间） -->
        <div v-if="showAdvancedFilters" class="px-3 py-2.5 border-b border-zinc-800 flex flex-col gap-2 bg-zinc-900 shadow-lg z-20">
            <!-- 行1：分组管理按钮（分类下拉已在顶部行2，避免重复的"All (全部)"下拉） -->
            <div class="flex items-center gap-1">
                <span class="text-[10px] text-zinc-500 font-medium shrink-0">📁 分组:</span>
                <button @click="addNewCategory" class="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-xs text-zinc-300 shrink-0" title="新增分组">➕</button>
                <button v-if="currentCategoryRenamable" @click="renameCurrentCategory" class="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-xs text-zinc-300 shrink-0" title="重命名分组">✏️</button>
                <!-- 【修复】预设分组也可删除（仅系统必需的全部分组不可删），无需先改名才出删除按钮 -->
                <button v-if="currentCategoryDeletable" @click="deleteCustomCategory(currentCategoryKey)" class="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-red-600 hover:text-white text-xs text-zinc-300 shrink-0" title="删除当前分组">🗑️</button>
            </div>

            <!-- 行2.5：快捷标签搜索（点击直接填入搜索框并立即过滤） -->
            <div class="flex flex-wrap gap-1 mt-1 px-1 max-h-16 overflow-y-auto custom-scrollbar">
                <span class="text-[10px] text-zinc-500 font-medium flex items-center shrink-0">🔍 快捷:</span>
                <span v-for="tag in systemCommonTags" :key="'search-'+tag"
                      @click="appendTagToSearch(tag)"
                      class="px-1.5 py-0.5 bg-zinc-800/80 text-zinc-400 text-[10px] rounded border border-zinc-700 cursor-pointer hover:bg-blue-600 hover:text-white hover:border-blue-500 transition whitespace-nowrap">
                    {{ tag }}
                </span>
            </div>

            <!-- 行3：快捷过滤 chips -->
            <div class="flex items-center gap-1">
                <button @click="currentCategoryKey = 'all'"
                        :class="currentCategoryKey === 'all' ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                        class="text-[10px] px-1.5 py-0.5 rounded transition font-medium whitespace-nowrap">
                    全部 ({{ library.length }})
                </button>
                <button @click="currentCategoryKey = 'has_lorebook'"
                        :class="currentCategoryKey === 'has_lorebook' ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                        class="text-[10px] px-1.5 py-0.5 rounded transition font-medium whitespace-nowrap">
                    📖 带世界书
                </button>
                <button @click="currentCategoryKey = 'has_regex'"
                        :class="currentCategoryKey === 'has_regex' ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'"
                        class="text-[10px] px-1.5 py-0.5 rounded transition font-medium whitespace-nowrap">
                    ⚡ 带正则
                </button>
            </div>

            <!-- 行4：语言切换（恢复为原单按钮循环） -->
            <div class="flex items-center justify-between px-0.5">
                <span class="text-[9px] text-zinc-500">显示语言:</span>
                <button @click="toggleTagLangMode" title="切换标签语言显示" class="px-1.5 py-0.5 bg-zinc-800 hover:bg-blue-600 hover:text-white rounded transition font-bold text-zinc-400">
                    {{ tagLangMode === 'both' ? '🌐 中英双语' : (tagLangMode === 'cn' ? '🇨🇳 纯中文' : '🇺🇸 纯英文') }}
                </button>
            </div>
        </div>

        <!-- 列表头部：计数 + 视图切换 + 紧凑开关 -->
        <div class="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-xs">
            <span class="font-bold text-zinc-400">卡片列表 <span class="text-zinc-600 font-normal">({{ filteredLibrary.length }})</span></span>
            <div class="flex items-center gap-1.5 shrink-0">
                <button @click="toggleViewMode"
                        class="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition font-medium border border-zinc-700 flex items-center gap-1 shadow-sm"
                        :title="viewMode === 'list' ? '当前：列表 (点击切换网格)' : '当前：网格 (点击切换列表)'">
                    <span v-if="viewMode === 'list'">🎴 网格</span>
                    <span v-else>📜 列表</span>
                </button>
                <!-- ✅ [UI 瘦身] 紧凑模式切换：仅列表视图下生效（隐藏副行/缩头像，一屏更多卡片） -->
                <button v-if="viewMode === 'list'" @click="isCompactMode = !isCompactMode"
                        :class="isCompactMode ? 'bg-indigo-600 text-white shadow-sm' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'"
                        class="px-2.5 py-1 rounded-lg transition font-medium" :title="isCompactMode ? '当前：紧凑模式 (点击切换常规)' : '当前：常规模式 (点击切换紧凑)'">
                    {{ isCompactMode ? '📱 常规' : '🗜️ 紧凑' }}
                </button>
            </div>
        </div>

        <!-- 紧凑型列表视图 -->
        <div v-if="viewMode === 'list'" class="flex-1 overflow-y-auto p-1 custom-scrollbar">
            <div v-for="(item, index) in paginatedLibrary" :key="item.id"
                 @click.prevent="handleCardClick($event, item, index)"
                 @contextmenu.prevent="openContextMenu($event, item)"
                 :class="['group relative flex items-center rounded-md cursor-pointer border select-none transition-all duration-150',
                          selectedIds.includes(item.id) ? 'bg-amber-950/20 border-amber-600/40' :
                          (cardData && cardData === item.data) ? 'bg-blue-600 border-blue-600 text-white shadow-inner' : 'bg-zinc-800 border-zinc-700 hover:border-zinc-500 hover:bg-zinc-700/50']"
                 :style="isCompactMode ? 'padding: 0.14em 0.35em; margin-bottom: 0.14em; gap: 0.45em;' : 'padding: 0.65em 0.75em; margin-bottom: 0.6em; gap: 0.8em;'">

                <input v-if="isMultiSelectMode" type="checkbox" :checked="selectedIds.includes(item.id)" @click.stop="toggleSelection(item.id)" :class="isCompactMode ? 'w-3 h-3' : 'w-3.5 h-3.5'" class="rounded border-zinc-600 bg-zinc-900 text-blue-500 focus:ring-0 cursor-pointer shrink-0 accent-blue-500">

                <!-- 头像：常规 3.2em 醒目大图 / 紧凑 1.5em 极小圆点 -->
                <img v-if="item.avatar" :src="item.avatar" loading="lazy" decoding="async" draggable="false"
                     class="object-cover shrink-0 bg-zinc-900 border border-zinc-700/40 transition-transform group-hover:scale-105"
                     :class="isCompactMode ? 'rounded' : 'rounded-lg'"
                     :style="isCompactMode ? 'width: 1.5em; height: 1.5em;' : 'width: 3.4em; height: 3.4em;'">
                <div v-else class="bg-zinc-700 border border-zinc-600 shrink-0 flex items-center justify-center text-zinc-500 font-bold"
                     :class="isCompactMode ? 'rounded' : 'rounded-lg'"
                     :style="isCompactMode ? 'width: 1.5em; height: 1.5em; font-size: 0.7em;' : 'width: 3.4em; height: 3.4em; font-size: 1.2em;'">{{ isCompactMode ? '' : (item.name || '?').charAt(0) }}</div>

                <!-- ===== 紧凑模式：仅单行小名字 ===== -->
                <div v-if="isCompactMode" class="flex-1 min-w-0 overflow-hidden">
                    <span class="text-[10px] font-medium truncate leading-tight" :class="(cardData && cardData === item.data) ? 'text-white' : 'text-zinc-200 group-hover:text-blue-400'">{{ item.name }}</span>
                </div>

                <!-- ===== 常规模式：三行信息（名字 / 分类·描述 / Token·标签） ===== -->
                <div v-else class="flex-1 min-w-0 flex flex-col overflow-hidden" style="gap: 0.25em;">
                    <!-- 行1：名字（粗体） + 分类徽章 -->
                    <div class="flex items-center justify-between gap-1">
                        <span class="text-sm font-bold truncate leading-tight" :class="(cardData && cardData === item.data) ? 'text-white' : 'text-zinc-100 group-hover:text-blue-400'">{{ item.name }}</span>
                        <span v-if="item.category && item.category !== '未分类'" class="text-[10px] px-2 py-0.5 rounded shrink-0 bg-zinc-800 text-zinc-400 border border-zinc-700/50">{{ item.category }}</span>
                    </div>
                    <!-- 行2：描述片段（截断一行） -->
                    <div class="truncate text-[11px] leading-snug" :class="(cardData && cardData === item.data) ? 'text-blue-100/80' : 'text-zinc-500'">
                        {{ cardDesc(item) || '无描述' }}
                    </div>
                    <!-- 行3：Token + 世界书 + 标签×2 +N -->
                    <div class="flex items-center gap-1.5 text-[10px] text-zinc-500 leading-none">
                        <span v-if="itemTokenCount(item) > 0" class="font-mono text-amber-500/80 shrink-0" title="Token 估算">{{ itemTokenCount(item) }}T</span>
                        <span v-if="hasLorebook(item)" class="text-emerald-500/80 shrink-0" title="包含世界书">🌍</span>
                        <div class="flex items-center gap-1 overflow-hidden truncate">
                            <span v-for="tag in listTags(item).slice(0, 2)" :key="tag" class="px-1.5 bg-zinc-800/80 text-zinc-400 rounded text-[9px] truncate max-w-[60px]">#{{ tag }}</span>
                            <span v-if="listTags(item).length > 2" class="text-[9px] text-zinc-600 shrink-0">+{{ listTags(item).length - 2 }}</span>
                        </div>
                    </div>
                </div>

                <!-- ✅ hover 快捷操作（紧凑模式隐藏，保持纯净单行） -->
                <div v-if="!isCompactMode" class="hidden group-hover:flex items-center gap-0.5 absolute right-2 top-1/2 -translate-y-1/2 bg-zinc-800/90 backdrop-blur-sm px-1.5 py-0.5 rounded-lg border border-zinc-700/50 z-10">
                    <button @click.stop="quickTag(item)" title="为这张卡添加标签" class="p-1.5 text-[11px] text-zinc-400 hover:text-amber-400">🏷️</button>
                    <button @click.stop="deleteCardItem(item)" title="删除卡片(移入回收站)" class="p-1.5 text-[11px] text-zinc-400 hover:text-rose-400">🗑️</button>
                </div>
            </div>

            <div v-if="library.length === 0" class="flex flex-col items-center justify-center h-full text-zinc-500 text-xs text-center p-4">
                将卡片拖拽到此处，<br>或点击左上角打开本地库
            </div>
            <div v-else-if="filteredLibrary.length === 0" class="flex flex-col items-center justify-center h-full text-zinc-500 text-xs text-center p-4">
                🔍 当前筛选/搜索条件下<br>没有匹配的卡片
            </div>

            <!-- 分页控制条 -->
            <div class="flex items-center justify-between px-3 py-2 border-t border-zinc-800 bg-zinc-900 text-xs sticky bottom-0">
                <button @click="changePage(currentPage - 1)" :disabled="currentPage === 1" class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">◀ 上一页</button>
                <span class="text-zinc-400 font-mono font-bold">{{ currentPage }} / {{ totalPages }} <span class="text-zinc-600 font-normal">({{ filteredLibrary.length }})</span></span>
                <button @click="changePage(currentPage + 1)" :disabled="currentPage === totalPages" class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">下一页 ▶</button>
            </div>
        </div>

        <!-- 🎴 网格视图（固定 2 列自适应竖卡 + 原生 2:3 比例） -->
        <div v-if="viewMode === 'grid'"
             class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2.5"
             style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-content: start;">

            <div v-for="(item, index) in paginatedLibrary" :key="item.id"
                 @click.prevent="handleCardClick($event, item, index)"
                 @contextmenu.prevent="openContextMenu($event, item)"
                 :class="['group relative rounded-lg overflow-hidden border cursor-pointer select-none transition-all duration-200 bg-zinc-800/80 hover:shadow-lg',
                          selectedIds.includes(item.id) ? 'border-blue-500 ring-2 ring-blue-500/50 shadow-blue-500/20' :
                          (cardData && cardData === item.data) ? 'border-amber-500 ring-2 ring-amber-500/50' : 'border-zinc-700/80 hover:border-zinc-400']"
                 style="position: relative; width: 100%; height: 0; padding-bottom: 150%;">

                <div v-if="isMultiSelectMode" class="absolute top-1.5 left-1.5 z-20">
                    <input type="checkbox" :checked="selectedIds.includes(item.id)"
                           @click.stop="toggleSelection(item.id)"
                           class="w-4 h-4 rounded border-zinc-600 text-blue-600 focus:ring-blue-600 bg-zinc-900/90 cursor-pointer accent-blue-500">
                </div>

                <!-- 卡片封面 -->
                <img v-if="item.avatar" :src="item.avatar" loading="lazy" decoding="async" draggable="false" class="absolute inset-0 w-full h-full object-cover block transition-transform duration-300 group-hover:scale-105">
                <div v-else class="absolute inset-0 w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-700 to-zinc-900 text-2xl font-bold text-zinc-500 select-none">
                    {{ (item.name || '?').charAt(0) }}
                </div>

                <div class="absolute inset-x-0 bottom-0 p-2 pt-8 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex flex-col justify-end pointer-events-none z-10">
                    <div class="font-bold text-white text-xs truncate leading-tight drop-shadow">{{ item.name }}</div>
                    <div class="flex items-center gap-1 mt-1 flex-wrap">
                        <span class="text-[9px] px-1 py-0.5 rounded bg-blue-600/80 text-white font-mono leading-none truncate max-w-[60px]">{{ item.category || '未分类' }}</span>
                        <span v-if="item.customTags && item.customTags.length" class="text-[9px] px-1 py-0.5 rounded bg-zinc-700/80 text-zinc-300 truncate max-w-[65px] leading-none">{{ displayTagText(item.customTags[0]) }}</span>
                    </div>
                </div>
            </div>

            <div v-if="library.length === 0" class="flex flex-col items-center justify-center h-40 text-zinc-500 text-xs text-center p-4" style="grid-column: 1 / -1;">
                将卡片拖拽到此处，<br>或点击左上角打开本地库
            </div>
            <div v-else-if="filteredLibrary.length === 0" class="flex flex-col items-center justify-center h-40 text-zinc-500 text-xs text-center p-4" style="grid-column: 1 / -1;">
                🔍 当前筛选/搜索条件下<br>没有匹配的卡片
            </div>

            <!-- 分页控制条 -->
            <div class="flex items-center justify-between px-3 py-2 border-t border-zinc-800 bg-zinc-900 text-xs sticky bottom-0" style="grid-column: 1 / -1;">
                <button @click="changePage(currentPage - 1)" :disabled="currentPage === 1" class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">◀ 上一页</button>
                <span class="text-zinc-400 font-mono font-bold">{{ currentPage }} / {{ totalPages }} <span class="text-zinc-600 font-normal">({{ filteredLibrary.length }})</span></span>
                <button @click="changePage(currentPage + 1)" :disabled="currentPage === totalPages" class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">下一页 ▶</button>
            </div>
        </div>

        <!-- 批量操作栏已迁移至 App.vue 全局底部悬浮控制台（fixed bottom-4），不再挤占侧边栏 -->
        </template>

        <!-- ============ 🌍 世界书模式 ============ -->
        <template v-if="appMode === 'worldbooks'">
            <!-- ✅ 顶部搜索行 + 折叠按钮（与角色卡模式同款） -->
            <!-- ✅ 世界书库顶部：搜索独立一行，操作/分组/统计分区清晰 -->
            <div class="px-3 pt-2.5 pb-2 border-b border-zinc-800 bg-zinc-900 flex flex-col gap-2 shrink-0 z-10">
                <!-- 行1：搜索（独立全宽，不与其他控件抢空间） -->
                <div class="relative">
                    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 text-xs">🔍</span>
                    <input v-model="wbSearchQuery" type="text" placeholder="搜索世界书名称 / 文件名..."
                           class="w-full h-8 bg-zinc-800/80 border border-zinc-700/60 rounded-lg pl-8 pr-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/80 transition">
                </div>

                <!-- 行2：高频操作（合并/查重/全库 等宽）+ 更多工具折叠 -->
                <div class="flex items-center gap-1.5">
                    <button @click="openWbMergeModal" title="选择多本世界书进行合并"
                            class="flex-1 h-8 flex items-center justify-center gap-1 rounded-lg text-xs font-bold transition bg-zinc-800 hover:bg-amber-600 text-amber-400 hover:text-white border border-amber-500/30">
                        🔗 合并
                    </button>
                    <button @click="startWorldbookDedupeScan" title="世界书对比与查重"
                            class="flex-1 h-8 flex items-center justify-center gap-1 rounded-lg text-xs font-bold transition bg-amber-600 hover:bg-amber-500 text-white">
                        🔍 查重
                    </button>
                    <button @click="openGlobalEntrySearch" title="跨独立世界书 + 角色卡内嵌世界书搜索词条，定位来源"
                            class="flex-1 h-8 flex items-center justify-center gap-1 rounded-lg text-xs font-bold transition bg-zinc-800 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/30">
                        🔎 全库
                    </button>
                    <button @click="showWbAdvanced = !showWbAdvanced"
                            class="h-8 w-8 flex items-center justify-center rounded-lg transition shrink-0"
                            :class="showWbAdvanced ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700/50'"
                            :title="showWbAdvanced ? '收起导入/工具区' : '展开导入/工具区'">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                </div>

                <!-- 行3：分组导航（常驻，横向滚动） -->
                <div class="flex items-center gap-1 overflow-x-auto custom-scrollbar">
                    <button @click="currentWbCategory = '全部'"
                            :class="currentWbCategory === '全部' ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/50' : 'bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'"
                            class="px-2.5 py-1 rounded-full text-[11px] font-bold whitespace-nowrap transition duration-200 border border-zinc-700/50 shrink-0">
                        🌍 全部
                    </button>
                    <button v-for="cat in wbCategories" :key="cat"
                            @click="currentWbCategory = cat"
                            :class="currentWbCategory === cat ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/50' : 'bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'"
                            class="px-2.5 py-1 rounded-full text-[11px] font-bold whitespace-nowrap transition duration-200 border border-zinc-700/50 shrink-0">
                        📁 {{ cat }}
                    </button>
                </div>

                <!-- 高级功能区折叠面板（URL导入 / 打开目录 / 分组 / 筛选） -->
                <div v-if="showWbAdvanced" class="flex flex-col gap-2 pt-1">
                    <!-- 🌐 网址导入世界书 -->
                    <div class="flex items-center gap-1.5">
                        <div class="flex-1 flex items-center bg-black/40 border border-zinc-700 rounded overflow-hidden transition focus-within:border-emerald-500/50 min-w-0">
                            <span class="pl-2.5 text-zinc-500 text-[10px] shrink-0">🔗 URL</span>
                            <input v-model="importUrl" type="text"
                                   placeholder="粘贴 Discord / GitHub 的 .json 直链..."
                                   class="w-full bg-transparent text-xs text-zinc-300 px-2 py-1 outline-none"
                                   @keyup.enter="importWorldbookFromUrl">
                        </div>
                        <button @click="importWorldbookFromUrl" :disabled="isImportingWb"
                                class="px-2.5 py-1 bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-bold rounded shadow transition flex items-center gap-1 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                                title="从 JSON 直链导入世界书">
                            <span v-if="isImportingWb" class="animate-spin">⌛</span>
                            <span v-else>⬇️</span>
                            云端导入
                        </button>
                    </div>
                    <!-- 📂 打开世界书目录 + 落盘 -->
                    <div class="flex items-center gap-1.5">
                        <label class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded border border-zinc-700/60 cursor-pointer transition shadow-sm"
                               title="选择世界书文件夹，自动穿透所有子文件夹扫描 .json 世界书">
                            📂 打开世界书目录
                            <input type="file" webkitdirectory directory multiple class="hidden" @change="handleWorldbookFolderSelect">
                        </label>
                        <button @click="syncWorldbooksToDisk" title="将仍停留在内存中（无本地文件）的世界书统一落盘保存到世界书目录"
                                class="px-3 py-1 bg-zinc-800 hover:bg-emerald-600 text-zinc-200 hover:text-white text-xs rounded border border-zinc-700/60 transition shadow-sm shrink-0">
                            💾 落盘
                        </button>
                    </div>
                    <!-- � JSONL 导入 + 📦 批量导出 -->
                    <div class="flex items-center gap-1.5">
                        <label class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded border border-zinc-700/60 cursor-pointer transition shadow-sm"
                               title="导入 JSONL / Rentry 格式世界书（逐行解析）">
                            📜 导入 JSONL
                            <input type="file" accept=".json,.jsonl,.txt" multiple class="hidden" @change="importWbFromJsonl">
                        </label>
                        <button @click="exportWorldbooksBatch" title="批量导出所有已落盘世界书到自选文件夹"
                                class="px-3 py-1 bg-zinc-800 hover:bg-blue-600 text-zinc-200 hover:text-white text-xs rounded border border-zinc-700/60 transition shadow-sm shrink-0">
                            📦 批量导出
                        </button>
                    </div>

                    <!-- 词条数筛选 chips -->
                    <div class="flex gap-1 text-[10px]">
                        <button @click="wbFilterType = 'all'" :class="wbFilterType === 'all' ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'" class="px-1.5 py-0.5 rounded border border-zinc-700">全部 ({{ worldbooks.length }})</button>
                        <button @click="wbFilterType = 'small'" :class="wbFilterType === 'small' ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'" class="px-1.5 py-0.5 rounded border border-zinc-700">1-15条</button>
                        <button @click="wbFilterType = 'large'" :class="wbFilterType === 'large' ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'" class="px-1.5 py-0.5 rounded border border-zinc-700">15+条</button>
                        <button @click="wbFilterType = 'empty'" :class="wbFilterType === 'empty' ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'" class="px-1.5 py-0.5 rounded border border-zinc-700">空书</button>
                    </div>
                </div>
            </div>

            <!-- 📊 世界书库统计（3x2 网格小卡，Token 已格式化） -->
            <div class="px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0 grid grid-cols-3 gap-1.5">
                <div class="bg-zinc-800/50 border border-zinc-700/40 rounded-md px-2 py-1 flex items-center justify-between gap-1" title="世界书总数">
                    <span class="text-[10px] text-zinc-500">📚 本</span>
                    <span class="text-[11px] font-bold text-amber-400 font-mono">{{ wbStats.bookCount }}</span>
                </div>
                <div class="bg-zinc-800/50 border border-zinc-700/40 rounded-md px-2 py-1 flex items-center justify-between gap-1" title="词条总数">
                    <span class="text-[10px] text-zinc-500">📄 词条</span>
                    <span class="text-[11px] font-bold text-amber-400 font-mono">{{ wbStats.entryCount }}</span>
                </div>
                <div class="bg-zinc-800/50 border border-zinc-700/40 rounded-md px-2 py-1 flex items-center justify-between gap-1" title="Token 总量">
                    <span class="text-[10px] text-zinc-500">⚡ 总量</span>
                    <span class="text-[11px] font-bold text-amber-400 font-mono">{{ fmtTokens(wbStats.tokenTotal) }}</span>
                </div>
                <div class="bg-zinc-800/50 border border-zinc-700/40 rounded-md px-2 py-1 flex items-center justify-between gap-1" title="常驻词条数">
                    <span class="text-[10px] text-zinc-500">🟣 常驻</span>
                    <span class="text-[11px] font-bold text-emerald-400 font-mono">{{ wbStats.constantCount }}</span>
                </div>
                <div class="bg-zinc-800/50 border border-zinc-700/40 rounded-md px-2 py-1 flex items-center justify-between gap-1" title="有触发词的词条占比">
                    <span class="text-[10px] text-zinc-500">🔑 触发</span>
                    <span class="text-[11px] font-bold text-sky-400 font-mono">{{ wbStats.keyCoverage }}%</span>
                </div>
                <div class="bg-zinc-800/50 border border-zinc-700/40 rounded-md px-2 py-1 flex items-center justify-between gap-1" title="平均每本词条数">
                    <span class="text-[10px] text-zinc-500">📊 均条</span>
                    <span class="text-[11px] font-bold text-zinc-300 font-mono">{{ wbStats.bookCount ? Math.round(wbStats.entryCount / wbStats.bookCount) : 0 }}</span>
                </div>
            </div>

            <!-- 世界书列表（筛选后） -->
            <div class="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                <div v-for="(wb, index) in filteredWorldbooks" :key="index"
                     @click="activeWorldbook = wb"
                     @contextmenu.prevent="openWbContextMenu($event, wb)"
                     :class="activeWorldbook && activeWorldbook.path === wb.path ? 'bg-amber-600/20 border-amber-500/50' : 'bg-zinc-800/50 border-zinc-700/50 hover:bg-zinc-700'"
                     class="p-3 rounded-lg border cursor-pointer transition flex flex-col gap-1.5">
                    <div class="flex justify-between items-center gap-1">
                        <span class="text-xs font-bold text-zinc-200 truncate">{{ (wb.data && wb.data.name) || wb.name }}</span>
                        <div class="flex items-center gap-1 shrink-0">
                            <span class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-zinc-800 text-zinc-400 border border-zinc-700 whitespace-nowrap">{{ (wb.data && wb.data.entries) ? wb.data.entries.length : 0 }} 词条</span>

                            <!-- ⚙️ 操作按钮折叠/展开 -->
                            <button @click.stop="wb._showActions = !wb._showActions"
                                    class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-amber-600 text-zinc-300 hover:text-white rounded transition whitespace-nowrap"
                                    title="展开/收起操作按钮">
                                ⚙️ {{ wb._showActions ? '收起' : '操作' }}
                            </button>

                            <transition name="fade">
                                <div v-show="wb._showActions" class="flex items-center gap-1 overflow-hidden">
                                    <button @click.stop="openWbInFolder(wb)" title="在资源管理器中定位该世界书"
                                            class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-indigo-600/80 text-zinc-300 hover:text-white rounded transition whitespace-nowrap">
                                        📂
                                    </button>
                                    <button @click.stop="renameWorldbook(wb)" title="重命名该世界书"
                                            class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-blue-600/80 text-zinc-300 hover:text-white rounded transition whitespace-nowrap">
                                        ✏️
                                    </button>
                                    <button @click.stop="duplicateWorldbook(wb)" title="复制为副本"
                                            class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-emerald-600/80 text-zinc-300 hover:text-white rounded transition whitespace-nowrap">
                                        📋
                                    </button>
                                    <button @click.stop="deleteWorldbook(wb)" title="删除该世界书（移入回收站）"
                                            class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-rose-600/80 text-zinc-300 hover:text-white rounded transition whitespace-nowrap">
                                        🗑️
                                    </button>
                                </div>
                            </transition>
                        </div>
                    </div>
                    <div class="text-[10px] opacity-60 truncate">📄 {{ wb.name }}</div>
                </div>

                <!-- 空状态提示 -->
                <div v-if="worldbooks.length === 0" class="flex flex-col items-center justify-center h-full text-zinc-500 text-xs text-center p-4 gap-3">
                    <span>尚未加载任何世界书。<br>可通过顶部 [文件(F)] 菜单打开世界书目录。</span>
                    <button @click="loadWorldbooks"
                            class="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded shadow transition">
                        📂 打开世界书文件夹
                    </button>
                </div>
                <div v-else-if="filteredWorldbooks.length === 0" class="text-center py-8 text-zinc-500 text-xs">
                    🔍 没有匹配的世界书
                </div>
            </div>
        </template>

        <!-- ============ ⚙️ 预设模式 ============ -->
        <template v-if="appMode === 'presets'">
            <div class="px-3 pt-2.5 pb-2 border-b border-zinc-800 bg-zinc-900 flex flex-col gap-2 shrink-0 z-10">
                <div class="relative">
                    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 text-xs">🔍</span>
                    <input v-model="presetSearchQuery" type="text" placeholder="搜索预设名称..."
                           class="w-full h-8 bg-zinc-800/80 border border-zinc-700/60 rounded-lg pl-8 pr-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-sky-500/80 transition">
                </div>
                <div class="flex items-center gap-1.5">
                    <button @click="loadPresets" class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-zinc-800 hover:bg-sky-600 text-zinc-200 text-xs rounded border border-zinc-700/60 transition">
                        📂 打开预设目录
                    </button>
                    <button @click="exportPresetsBatch" title="批量导出预设"
                            class="px-2.5 py-1.5 bg-zinc-800 hover:bg-blue-600 text-zinc-200 text-xs rounded border border-zinc-700/60 transition">
                        📦 导出
                    </button>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                <div v-for="(preset, index) in filteredPresets" :key="preset.path || index"
                     @click="activePreset = preset"
                     @contextmenu.prevent="openPresetContextMenu($event, preset)"
                     :class="activePreset && activePreset.path === preset.path ? 'bg-sky-600/20 border-sky-500/50' : 'bg-zinc-800/50 border-zinc-700/50 hover:bg-zinc-700'"
                     class="p-3 rounded-lg border cursor-pointer transition flex flex-col gap-1.5">
                    <div class="flex justify-between items-center gap-1">
                        <span class="text-xs font-bold text-zinc-200 truncate">{{ (preset.data && preset.data.name) || preset.name }}</span>
                        <div class="flex items-center gap-1 shrink-0">
                            <button @click.stop="renamePreset(preset)" title="重命名" class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-blue-600 text-zinc-300 hover:text-white rounded">✏️</button>
                            <button @click.stop="duplicatePreset(preset)" title="复制副本" class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-emerald-600 text-zinc-300 hover:text-white rounded">📋</button>
                            <button @click.stop="deletePreset(preset)" title="移入回收站" class="px-1.5 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-rose-600 text-zinc-300 hover:text-white rounded">🗑️</button>
                        </div>
                    </div>
                    <div class="text-[10px] opacity-60 truncate">📄 {{ preset.name }}</div>
                </div>
                <div v-if="presets.length === 0" class="flex flex-col items-center justify-center h-full text-zinc-500 text-xs text-center p-4 gap-3">
                    <span>尚未加载任何预设。<br>请选择酒馆的预设目录。</span>
                    <button @click="loadPresets" class="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs rounded shadow transition">📂 打开预设文件夹</button>
                </div>
                <div v-else-if="filteredPresets.length === 0" class="text-center py-8 text-zinc-500 text-xs">🔍 没有匹配的预设</div>
            </div>
        </template>

    </aside>

    <!-- 📏 侧边栏拖拽调节把手 -->
    <div v-if="viewOptions.showSidebar"
         class="w-1.5 shrink-0 cursor-col-resize bg-zinc-800 hover:bg-indigo-500/70 active:bg-indigo-500 transition-colors select-none flex items-center justify-center group"
         :title="sidebarWidth > 0 ? '拖动调整宽度 · 双击恢复默认' : '拖动调整侧边栏宽度'"
         @mousedown="startSidebarResize($event)"
         @dblclick="resetSidebarWidth">
        <div class="w-0.5 h-8 bg-zinc-600 group-hover:bg-white rounded"></div>
    </div>
</template>

<script>
import { inject, ref, computed } from 'vue';

export default {
    name: 'SidebarPanel',
    setup() {
        const ctx = inject('appCtx');

        // ✅ [UI 瘦身·方案1] 高级筛选折叠面板：平时只留搜索框+漏斗，点击才展开分类/标签/语言
        const showAdvancedFilters = ref(false);
        // 漏斗高亮提示：有激活的筛选条件（非全部 或 非默认双语）时点亮
        const hasActiveFilters = computed(() =>
            ctx.currentCategoryKey.value !== 'all' || ctx.tagLangMode.value !== 'both'
        );

        // ✅ [世界书模式] 顶部高级功能区折叠面板（URL导入/目录/分组/筛选收进面板，与角色卡模式一致）
        const showWbAdvanced = ref(false);

        return {
            showAdvancedFilters,
            hasActiveFilters,
            showWbAdvanced,
            viewOptions: ctx.viewOptions,
            sidebarEl: ctx.sidebarEl,
            sidebarStyle: ctx.sidebarStyle,
            sidebarWidth: ctx.sidebarWidth,
            startSidebarResize: ctx.startSidebarResize,
            resetSidebarWidth: ctx.resetSidebarWidth,
            appMode: ctx.appMode,
            library: ctx.library,
            worldbooks: ctx.worldbooks,
            presets: ctx.presets,
            activePreset: ctx.activePreset,
            presetSearchQuery: ctx.presetSearchQuery,
            filteredPresets: ctx.filteredPresets,
            loadPresets: ctx.loadPresets,
            exportPresetsBatch: ctx.exportPresetsBatch,
            renamePreset: ctx.renamePreset,
            duplicatePreset: ctx.duplicatePreset,
            deletePreset: ctx.deletePreset,
            openPresetContextMenu: ctx.openPresetContextMenu,
            openPresetInFolder: ctx.openPresetInFolder,
            currentCategoryKey: ctx.currentCategoryKey,
            allCategories: ctx.allCategories,
            customCategories: ctx.customCategories,
            getCategoryDisplayName: ctx.getCategoryDisplayName,
            addNewCategory: ctx.addNewCategory,
            renameCurrentCategory: ctx.renameCurrentCategory,
            deleteCustomCategory: ctx.deleteCustomCategory,
            currentCategoryDeletable: ctx.currentCategoryDeletable,
            currentCategoryRenamable: ctx.currentCategoryRenamable,
            searchQueryInput: ctx.searchQueryInput,
            searchQuery: ctx.searchQuery,
            appendTagToSearch: ctx.appendTagToSearch,
            systemCommonTags: ctx.systemCommonTags,
            toggleTagLangMode: ctx.toggleTagLangMode,
            tagLangMode: ctx.tagLangMode,
            filteredLibrary: ctx.filteredLibrary,
            paginatedLibrary: ctx.paginatedLibrary,
            viewMode: ctx.viewMode,
            toggleViewMode: ctx.toggleViewMode,
            isCompactMode: ctx.isCompactMode,
            isMultiSelectMode: ctx.isMultiSelectMode,
            selectedIds: ctx.selectedIds,
            handleCardClick: ctx.handleCardClick,
            openContextMenu: ctx.openContextMenu,
            toggleSelection: ctx.toggleSelection,
            cardData: ctx.cardData,
            displayTagText: ctx.displayTagText,
            sortBy: ctx.sortBy,
            runDiskScan: ctx.runDiskScan,
            refreshLibrary: ctx.refreshLibrary,
            deleteCardItem: ctx.deleteCardItem,
            // ✅ [UI 方案2] 列表项辅助：Token 估算 / 世界书标记 / 标签合并 / 快捷打标
            itemTokenCount: (item) => {
                if (!item || typeof ctx.estimateCardTokens !== 'function') return 0;
                const t = ctx.estimateCardTokens(item);
                return t >= 1000 ? (Math.round(t / 100) / 10) + 'k' : Math.round(t);
            },
            hasLorebook: (item) => {
                const d = (item && (item.data?.data || item.data)) || {};
                const book = d.character_book || (item && item.data && item.data.character_book) || {};
                // 🛡️ 全形态安全判定：字典形态 entries（SillyTavern 导出）与数组形态 book
                //    在旧写法 Array.isArray(book.entries) 下均漏判（不显示 🌍 标记）
                try {
                    const entries = Array.isArray(book) ? book
                        : (Array.isArray(book?.entries) ? book.entries
                            : (book?.entries && typeof book.entries === 'object' ? Object.values(book.entries) : []));
                    return entries.some(e => e && typeof e === 'object');
                } catch (e) { return false; }
            },
            listTags: (item) => {
                const d = (item && (item.data?.data || item.data)) || {};
                const arr = [...(item?.customTags || []), ...(Array.isArray(d.tags) ? d.tags : [])];
                return Array.from(new Set(arr.filter(t => t && String(t).trim() !== '')));
            },
            // ✅ 常规模式描述片段（截断 40 字）
            cardDesc: (item) => {
                const d = (item && (item.data?.data || item.data)) || {};
                const desc = d.description || '';
                return desc ? (desc.length > 40 ? desc.slice(0, 40) + '…' : desc) : '';
            },
            quickTag: (item) => {
                ctx.openFromLibrary(item);
                setTimeout(() => ctx.addSingleTag(), 60);
            },
            changePage: ctx.changePage,
            currentPage: ctx.currentPage,
            totalPages: ctx.totalPages,
            clearSelection: ctx.clearSelection,
            batchChangeCategoryModal: ctx.batchChangeCategoryModal,
            showBatchTagModal: ctx.showBatchTagModal,
            openAITagModal: ctx.openAITagModal,
            batchExportSelected: ctx.batchExportSelected,
            importUrl: ctx.importUrl,
            importWorldbookFromUrl: ctx.importWorldbookFromUrl,
            isImportingWb: ctx.isImportingWb,
            handleWorldbookFolderSelect: ctx.handleWorldbookFolderSelect,
            syncWorldbooksToDisk: ctx.syncWorldbooksToDisk,
            currentWbCategory: ctx.currentWbCategory,
            wbCategories: ctx.wbCategories,
            wbSearchQuery: ctx.wbSearchQuery,
            wbFilterType: ctx.wbFilterType,
            filteredWorldbooks: ctx.filteredWorldbooks,
            openWbMergeModal: ctx.openWbMergeModal,
            startWorldbookDedupeScan: ctx.startWorldbookDedupeScan,
            openGlobalEntrySearch: ctx.openGlobalEntrySearch,
            importWbFromJsonl: ctx.importWbFromJsonl,
            exportWorldbooksBatch: ctx.exportWorldbooksBatch,
            wbStats: ctx.wbStats,
            // 📊 统计数字格式化（1000+ → K，1000000+ → M）
            fmtTokens: (n) => {
                if (!n) return '0';
                if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
                if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
                return String(n);
            },
            activeWorldbook: ctx.activeWorldbook,
            openWbContextMenu: ctx.openWbContextMenu,
            openWbInFolder: ctx.openWbInFolder,
            renameWorldbook: ctx.renameWorldbook,
            duplicateWorldbook: ctx.duplicateWorldbook,
            deleteWorldbook: ctx.deleteWorldbook,
            loadWorldbooks: ctx.loadWorldbooks
        };
    }
};
</script>
