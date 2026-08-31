<!--
  EditorPanel 右侧编辑器面板（角色卡编辑工作区 + 世界书 Entry IDE + 全局终端控制台）（子组件）
  ⚠️ 所有状态/方法经 provide/inject 从 App.vue 共享（inject('appCtx') 后按名解构）；
      ref="chatContainer" 写回父级 ref（sendMessage 滚动依赖）
-->
<template>
    <main class="flex-1 flex flex-col bg-zinc-950 overflow-hidden relative">

        <!-- 🎴 引擎 A：角色卡编辑工作区 -->
        <div v-show="appMode === 'characters'" class="flex-1 flex flex-col overflow-hidden min-h-0">

        <template v-if="cardData">
            <!-- 编辑器头部: 角色名与保存动作 -->
            <div class="h-12 border-b border-zinc-800 flex items-center justify-between px-4 shrink-0 bg-zinc-900">
                <div class="flex items-center gap-3 w-1/2">
                    <!-- 立绘缩略卡 -->
                    <div v-if="imgUrl && viewOptions.showAvatarPreview" class="relative group cursor-pointer shrink-0 rounded-lg overflow-hidden border border-zinc-700 shadow-sm" @click="openImageModal(imgUrl)" title="点击查看高清大立绘">
                        <img :src="imgUrl" class="w-10 h-10 object-cover object-top transition-transform duration-300 group-hover:scale-110" alt="角色立绘">
                        <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <span class="text-sm">🔍</span>
                        </div>
                    </div>
                    <input :value="safeData.name" @input="updateName($event.target.value)" class="font-bold text-base bg-transparent border-b border-transparent hover:border-zinc-600 focus:border-blue-500 outline-none w-full px-1 py-0.5 transition text-zinc-100 placeholder-zinc-500" placeholder="角色名称">
                    <div v-if="viewOptions.showTokenStats" class="hidden md:flex items-center gap-1 px-2.5 py-1 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 text-[11px] shrink-0" title="预估总 Token 消耗量">
                        <span>⚡ 预估 Token:</span>
                        <span class="font-bold">{{ cardTokenStats.total }}</span>
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <!-- ⚙️ 操作下拉菜单开关（菜单本体经 <Teleport to="body"> 渲染到 body 顶层 + fixed 定位，物理上不可能被编辑器内任何元素遮挡或裁剪） -->
                    <button ref="toolbarMenuBtn" @click="toggleToolbarMenu"
                            :title="isToolbarMenuOpen ? '收起操作菜单' : '展开操作菜单'"
                            class="tb-btn bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white">
                        <span class="ico">⚙️</span>{{ isToolbarMenuOpen ? '收起' : '菜单' }}
                    </button>

                    <div class="w-px h-4 bg-zinc-700 mx-1"></div>
                    <button @click="reset" class="px-2 py-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 rounded transition" title="关闭卡片">✕</button>
                </div>
            </div>

            <!-- 分组与标签工具栏（合并紧凑版） -->
            <div class="px-3 py-1.5 border-b border-zinc-800 bg-zinc-900 flex flex-wrap gap-x-3 gap-y-1 items-center shrink-0">
                <div class="flex items-center gap-1.5 shrink-0">
                    <span class="text-[11px] text-zinc-400 font-medium whitespace-nowrap">分组:</span>
                    <select :value="currentCardCategory" @change="handleCardCategoryChange($event.target.value)" class="bg-zinc-800 border border-zinc-700 text-[11px] rounded px-1.5 py-0.5 outline-none focus:border-blue-500 font-medium text-zinc-300">
                        <option v-for="cat in allCategories.filter(c => c.key !== 'all')" :key="cat.key" :value="cat.key">
                            📁 {{ getCategoryDisplayName(cat) }}
                        </option>
                    </select>
                    <button @click="addNewCategory" class="text-[11px] text-blue-400 hover:text-blue-300 font-bold" title="创建新分组">➕</button>
                </div>
                <div class="flex items-center gap-1.5 flex-wrap min-w-0">
                    <span class="text-[11px] font-bold text-zinc-400 whitespace-nowrap">标签:</span>
                    <button @click="toggleTagLangMode" title="切换标签语言显示" class="text-[10px] px-1.5 py-0.5 bg-zinc-800 hover:bg-blue-600 hover:text-white rounded transition font-bold text-zinc-400">
                        {{ tagLangMode === 'both' ? '🌐' : (tagLangMode === 'cn' ? '🇨🇳' : '🇺🇸') }}
                    </button>
                    <span v-for="tag in activeCardTags" :key="tag"
                          class="text-[10px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 flex items-center gap-1">
                        {{ displayTagText(tag) }}
                        <button @click="removeSingleTag(tag)" class="hover:text-red-400 hover:bg-indigo-500/20 rounded-full w-3 h-3 flex items-center justify-center transition-colors">✕</button>
                    </span>
                    <button @click="addSingleTag" class="text-[10px] text-zinc-500 hover:text-indigo-400 border border-dashed border-zinc-700 hover:border-indigo-500 rounded px-1.5 py-0.5 transition-colors whitespace-nowrap">
                        + 贴标签
                    </button>
                </div>
            </div>

            <!-- 系统/全局标签快捷添加（默认收起，点击展开；支持输入新增与 × 彻底删除） -->
            <div class="px-3 py-1 border-b border-zinc-800 bg-zinc-900 shrink-0 flex items-center justify-between cursor-pointer select-none" @click="isEditingSystemTags = !isEditingSystemTags">
                <span class="text-[11px] text-zinc-400">💡 系统/常用标签快速添加 <span class="text-zinc-500">({{ globalAvailableTags.length }})</span></span>
                <span class="text-[10px] text-blue-400 font-medium">{{ isEditingSystemTags ? '收起 ▲' : '展开 ▼' }}</span>
            </div>
            <div v-if="isEditingSystemTags" class="px-3 pb-2 pt-2 bg-zinc-900 border-b border-zinc-800 shrink-0">
                <div class="flex items-center gap-2 mb-2">
                    <input v-model="newGlobalTagInput" @keyup.enter="addTagToGlobalPool" type="text" placeholder="输入并回车直接新增全局标签..." class="flex-1 bg-zinc-800 border border-zinc-700 text-[11px] px-2 py-1 rounded outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50">
                    <button @click="addTagToGlobalPool" class="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[11px] rounded transition shadow-sm font-bold">添加</button>
                    <button @click="clearAllTagsFromPool" title="一键清空所有标签（系统库 + 全库卡片）" class="px-3 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-[11px] rounded transition shadow-sm font-bold whitespace-nowrap">🧹 一键清空</button>
                    <button @click="isBatchDeleteTags = !isBatchDeleteTags; if (!isBatchDeleteTags) batchSelectedTags = new Set()"
                            :class="isBatchDeleteTags ? 'bg-red-600 text-white border-red-600' : 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/30'"
                            class="px-3 py-1 text-[11px] rounded transition shadow-sm font-bold whitespace-nowrap border" title="进入批量模式，勾选多个标签后一键删除">☑️ 批量删除</button>
                </div>

                <div class="flex flex-wrap gap-1 p-1.5 bg-zinc-800/60 rounded border border-zinc-700 overflow-y-auto custom-scrollbar max-h-40">
                    <span v-for="tag in globalAvailableTags" :key="tag"
                          :class="isBatchDeleteTags
                              ? (batchSelectedTags.has(tag) ? 'bg-red-600 text-white border-red-600' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border-zinc-700')
                              : (activeCardTags.includes(tag) ? 'bg-blue-600 text-white border-blue-600' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border-zinc-700')"
                          class="text-[10px] px-2 py-0.5 rounded transition shadow-sm border flex items-center gap-1 group cursor-pointer"
                          @click="isBatchDeleteTags ? toggleBatchTagSelect(tag) : addGlobalTag(tag)">
                        <template v-if="isBatchDeleteTags">
                            <span>{{ batchSelectedTags.has(tag) ? '☑' : '☐' }} {{ tag }}</span>
                        </template>
                        <template v-else>
                            <span>+ {{ tag }}</span>
                            <span @click.stop="removeTagFromGlobalPool(tag)" class="text-zinc-500 group-hover:text-red-400 hover:bg-red-500/20 hover:text-red-400 rounded-full w-3 h-3 flex items-center justify-center transition-colors font-bold ml-1" title="彻底删除此标签">×</span>
                        </template>
                    </span>
                    <div v-if="globalAvailableTags.length === 0" class="text-xs text-zinc-500 py-1">暂无可选标签，请输入后添加</div>
                </div>

                <!-- 批量删除标签操作栏 -->
                <div v-if="isBatchDeleteTags" class="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-zinc-700">
                    <span class="text-[10px] text-red-400 font-bold">已选 {{ batchSelectedTags.size }} 个标签</span>
                    <div class="flex-1"></div>
                    <button @click="selectAllBatchTags" class="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded border border-zinc-700 transition">全选</button>
                    <button @click="exitBatchDeleteTags" class="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded border border-zinc-700 transition">取消</button>
                    <button @click="confirmBatchDeleteTags" :disabled="batchSelectedTags.size === 0" class="px-2.5 py-1 bg-red-600 hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed text-white text-[10px] rounded font-bold transition">🗑️ 删除选中 ({{ batchSelectedTags.size }})</button>
                </div>
            </div>

            <!-- 紧凑型 Tab 栏 -->
            <div class="flex border-b border-zinc-800 bg-zinc-900 px-2 shrink-0 overflow-x-auto custom-scrollbar-x">
                <button v-for="tab in tabs" :key="tab.id" @click="currentTab = tab.id; if(tab.action) tab.action()"
                    :class="['px-4 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5',
                    currentTab === tab.id ? 'border-blue-500 text-blue-400 bg-zinc-950' : 'border-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200']">
                    {{ tab.icon }} {{ tab.name }}
                    <span v-if="tab.badge" class="px-1.5 py-0.5 bg-zinc-700 text-zinc-300 text-[9px] rounded-full ml-1">{{ tab.badge }}</span>
                </button>
            </div>

            <!-- 核心内容滚动区 -->
            <div class="flex-1 overflow-y-auto bg-zinc-950 p-4 pb-10 custom-scrollbar text-zinc-200">

                <!-- 1. 基础设定 (Basic) -->
                <div v-if="currentTab === 'basic'" class="space-y-4">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <div class="flex justify-between items-center mb-1">
                                <label class="text-xs font-bold text-zinc-400 uppercase">性格特征 (Personality)</label>
                                <button @click="openTextModal('性格特征 (Personality)', safeData, 'personality')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大</button>
                            </div>
                            <textarea v-model="safeData.personality" @input="refreshCardData" rows="4" class="w-full text-xs p-2 border border-zinc-700 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                        </div>
                        <div class="flex flex-col gap-1">
                            <div class="flex justify-between items-center mb-1">
                                <label class="text-xs font-bold text-zinc-400 uppercase">初始场景 (Scenario)</label>
                                <button @click="openTextModal('初始场景 (Scenario)', safeData, 'scenario')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大</button>
                            </div>
                            <textarea v-model="safeData.scenario" @input="refreshCardData" rows="4" class="w-full text-xs p-2 border border-zinc-700 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                        </div>
                    </div>

                    <div class="flex flex-col gap-1">
                        <div class="flex justify-between items-center mb-1">
                            <label class="text-xs font-bold text-zinc-400 uppercase">详细设定 (Description)</label>
                            <button @click="openTextModal('详细设定 (Description)', safeData, 'description')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大全屏查看 / 编辑</button>
                        </div>
                        <textarea v-model="safeData.description" @input="refreshCardData" rows="8" class="w-full text-xs p-2 border border-zinc-700 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                    </div>

                    <div class="flex flex-col gap-1">
                        <div class="flex justify-between items-center mb-1">
                            <label class="text-xs font-bold text-blue-400 uppercase">初次问候 (First Message)</label>
                            <button @click="openTextModal('初次问候 (First Message)', safeData, 'first_mes')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大全屏查看 / 编辑</button>
                        </div>
                        <textarea v-model="safeData.first_mes" @input="refreshCardData" rows="8" class="w-full text-xs p-2 border border-blue-500/40 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                    </div>

                    <div v-if="viewOptions.showTokenStats" class="mt-6 p-3 bg-zinc-900 border border-zinc-800 rounded text-xs space-y-2">
                        <div class="font-bold text-zinc-300 flex justify-between items-center">
                            <span>📊 卡片重量与 Token 消耗明细</span>
                            <span class="text-amber-400 font-bold">总计: ~{{ cardTokenStats.total }} Tokens</span>
                        </div>
                        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] text-zinc-400">
                            <div class="bg-zinc-800 p-1.5 rounded border border-zinc-700">详细设定: <b>{{ cardTokenStats.desc }}</b></div>
                            <div class="bg-zinc-800 p-1.5 rounded border border-zinc-700">性格特征: <b>{{ cardTokenStats.pers }}</b></div>
                            <div class="bg-zinc-800 p-1.5 rounded border border-zinc-700">初始场景: <b>{{ cardTokenStats.scen }}</b></div>
                            <div class="bg-zinc-800 p-1.5 rounded border border-zinc-700">初次问候: <b>{{ cardTokenStats.first }}</b></div>
                            <div class="bg-zinc-800 p-1.5 rounded border border-zinc-700">世界书合集: <b>{{ cardTokenStats.book }}</b></div>
                        </div>
                    </div>
                </div>

                <!-- 进阶设定 -->
                <div v-if="currentTab === 'advanced'" class="space-y-4">
                    <div class="flex flex-col gap-1">
                        <div class="flex justify-between items-center mb-1">
                            <label class="text-xs font-bold text-zinc-400 uppercase">系统提示词 (System Prompt)</label>
                            <button @click="openTextModal('系统提示词 (System Prompt)', safeData, 'system_prompt')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大</button>
                        </div>
                        <textarea v-model="safeData.system_prompt" @input="refreshCardData" rows="5" class="w-full text-xs p-2 border border-zinc-700 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                    </div>
                    <div class="flex flex-col gap-1">
                        <div class="flex justify-between items-center mb-1">
                            <label class="text-xs font-bold text-zinc-400 uppercase">历史记录后注入 (Post History Instructions)</label>
                            <button @click="openTextModal('历史记录后注入 (Post History Instructions)', safeData, 'post_history_instructions')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大</button>
                        </div>
                        <textarea v-model="safeData.post_history_instructions" @input="refreshCardData" rows="5" class="w-full text-xs p-2 border border-zinc-700 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                    </div>
                    <div v-if="safeData.extensions?.depth_prompt" class="flex flex-col gap-1">
                        <div class="flex justify-between items-center mb-1">
                            <label class="text-xs font-bold text-purple-400 uppercase">深度提示词 (深度: {{ safeData.extensions.depth_prompt.depth }})</label>
                            <button @click="openTextModal('深度提示词', safeData.extensions.depth_prompt, 'prompt')" class="text-xs text-purple-400 hover:text-purple-300 font-medium flex items-center gap-1 transition">🔍 放大</button>
                        </div>
                        <textarea v-model="safeData.extensions.depth_prompt.prompt" @input="refreshCardData" rows="4" class="w-full text-xs p-2 border border-purple-500/40 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500"></textarea>
                    </div>
                    <div v-if="safeData.alternate_greetings && safeData.alternate_greetings.length > 0">
                        <label class="text-xs font-bold text-zinc-400 uppercase mb-2 block">附加问候语 (Alternate Greetings)</label>
                        <div class="space-y-2">
                            <div v-for="(greeting, index) in safeData.alternate_greetings" :key="index" class="relative">
                                <span class="absolute top-1 right-2 bg-zinc-800 text-zinc-500 text-[10px] font-bold px-1.5 py-0.5 rounded">#{{index + 1}}</span>
                                <textarea v-model="safeData.alternate_greetings[index]" @input="refreshCardData" rows="3" class="w-full text-xs p-2 pr-10 border border-zinc-700 rounded outline-none bg-zinc-900 text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 2. 世界书 (Worldbook) —— 增强版：搜索过滤 + 词条增删/克隆/排序 + 启用/常驻/条件开关 + 标签化触发词 -->
                <div v-if="currentTab === 'worldbook'">
                    <div v-if="worldbookEntries.length > 0">

                        <!-- 工具栏：计数 + 搜索 + 新增 + 折叠 -->
                        <div class="bg-zinc-900 p-2 rounded border border-zinc-800 mb-3">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-xs text-zinc-400 font-bold">共 {{ worldbookEntries.length }} 条世界书设定<span v-if="characterWorldbookSearchQuery.trim()" class="text-blue-400">（筛选后 {{ filteredCharacterWorldbookEntries.length }} 条）</span></span>
                                <div class="flex gap-2">
                                    <button @click="expandAllWorldbook" class="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition whitespace-nowrap">全部展开</button>
                                    <button @click="collapseAllWorldbook" class="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition whitespace-nowrap">全部折叠</button>
                                    <button @click="extractWorldbookFromCard(cardData, safeData.name)" class="text-xs px-2.5 py-1 bg-amber-600/80 hover:bg-amber-500 border border-amber-500/30 rounded text-amber-100 transition whitespace-nowrap" title="把该卡片内嵌世界书提取为独立世界书">📤 提取为世界书</button>
                                    <button @click="openCardWbImportModal" class="text-xs px-2.5 py-1 bg-emerald-600/80 hover:bg-emerald-500 border border-emerald-500/30 rounded text-emerald-100 transition whitespace-nowrap" title="从世界书库勾选词条导入到该卡片内嵌世界书">📥 从世界书库导入</button>
                                </div>
                            </div>
                            <div class="flex gap-2 items-center">
                                <input v-model="characterWorldbookSearchQuery" type="text" placeholder="🔍 搜索: 触发词 / 正文 / 备注..." class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 outline-none text-xs text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50">
                                <button @click="addCharacterWorldbookEntry" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded whitespace-nowrap">➕ 新增词条</button>
                            </div>
                        </div>

                        <!-- 词条列表 -->
                        <div class="space-y-2">
                            <div v-if="filteredCharacterWorldbookEntries.length === 0" class="text-zinc-500 text-center py-8 border border-dashed border-zinc-800 rounded">无匹配词条</div>
                            <div v-for="(entry, index) in filteredCharacterWorldbookEntries" :key="getEntryUid(entry)" class="bg-zinc-900 border border-zinc-800 rounded shadow-sm overflow-hidden transition-all" :class="{ 'opacity-60': entry.enabled === false }">

                                <!-- 词条头部 -->
                                <div @click="toggleWorldbookEntry(entry)" class="px-3 py-2.5 bg-zinc-800/60 hover:bg-zinc-800 cursor-pointer flex justify-between items-center select-none">
                                    <div class="flex items-center gap-2 overflow-hidden">
                                        <span class="text-zinc-500 text-xs transition-transform inline-block" :class="worldbookExpanded[getEntryUid(entry)] ? 'rotate-90' : ''">▶</span>
                                        <span class="font-bold text-xs text-zinc-200 truncate">{{ entry.comment || entry.name || '未命名条目' }}</span>
                                        <span v-if="entry.enabled === false" class="text-[10px] px-1.5 py-0.5 rounded border border-zinc-600 bg-zinc-800 text-zinc-500 whitespace-nowrap">禁用</span>
                                        <span v-if="entry.constant" class="text-[10px] px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-400 whitespace-nowrap">常驻</span>
                                        <span class="text-[10px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded border border-green-500/30 truncate max-w-xs" v-if="entry.keys && entry.keys.length">
                                            🔑 {{ entry.keys.join(', ') }}
                                        </span>
                                    </div>
                                    <div class="flex items-center gap-1.5 shrink-0">
                                        <span class="text-[10px] px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400 border border-zinc-700">优先级: {{ entry.insertion_order ?? 50 }}</span>
                                        <button @click.stop="moveCharacterWorldbookEntry(entry, -1)" class="text-zinc-400 hover:text-white hover:bg-zinc-700 px-1 py-0.5 rounded text-xs" title="上移">↑</button>
                                        <button @click.stop="moveCharacterWorldbookEntry(entry, 1)" class="text-zinc-400 hover:text-white hover:bg-zinc-700 px-1 py-0.5 rounded text-xs" title="下移">↓</button>
                                        <button @click.stop="duplicateCharacterWorldbookEntry(entry)" class="text-zinc-400 hover:text-blue-400 hover:bg-zinc-700 px-1 py-0.5 rounded text-xs" title="克隆">⧉</button>
                                        <button @click.stop="deleteCharacterWorldbookEntry(entry)" class="text-zinc-400 hover:text-rose-400 hover:bg-zinc-700 px-1 py-0.5 rounded text-xs" title="删除">🗑</button>
                                    </div>
                                </div>

                                <!-- 词条展开详情 -->
                                <div v-if="worldbookExpanded[getEntryUid(entry)]" class="p-3 border-t border-zinc-800 bg-zinc-950/60 space-y-3 text-xs">

                                    <!-- 名称 + 优先级 + 权重 -->
                                    <div class="grid grid-cols-4 gap-2">
                                        <div class="col-span-2 flex flex-col gap-1">
                                            <label class="font-bold text-zinc-400">名称 / 备注 (Comment):</label>
                                            <input :value="entry.comment || entry.name || ''" @input="updateEntryComment(entry, $event.target.value)" class="bg-zinc-800 border border-zinc-700 rounded p-1.5 outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50" placeholder="条目名称/备注">
                                        </div>
                                        <div class="flex flex-col gap-1">
                                            <label class="font-bold text-zinc-400">优先级:</label>
                                            <input v-model.number="entry.insertion_order" type="number" @input="refreshCardData" class="bg-zinc-800 border border-zinc-700 rounded p-1.5 outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50" placeholder="50">
                                        </div>
                                        <div class="flex flex-col gap-1">
                                            <label class="font-bold text-zinc-400">权重:</label>
                                            <input v-model.number="entry.order" type="number" @input="refreshCardData" class="bg-zinc-800 border border-zinc-700 rounded p-1.5 outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50" placeholder="50">
                                        </div>
                                    </div>

                                    <!-- 状态开关 + 插入位置 -->
                                    <div class="grid grid-cols-4 gap-2 items-center">
                                        <label class="flex items-center gap-1.5 cursor-pointer select-none">
                                            <input type="checkbox" :checked="entry.enabled !== false" @change="entry.enabled = $event.target.checked; refreshCardData()" class="rounded bg-zinc-900 border-zinc-700 text-emerald-500 focus:ring-0">
                                            <span :class="entry.enabled !== false ? 'text-emerald-400 font-bold' : 'text-zinc-500'">启用</span>
                                        </label>
                                        <label class="flex items-center gap-1.5 cursor-pointer select-none">
                                            <input type="checkbox" :checked="!!entry.constant" @change="entry.constant = $event.target.checked; refreshCardData()" class="rounded bg-zinc-900 border-zinc-700 text-purple-500 focus:ring-0">
                                            <span :class="entry.constant ? 'text-purple-400 font-bold' : 'text-zinc-500'">常驻显示</span>
                                        </label>
                                        <label class="flex items-center gap-1.5 cursor-pointer select-none">
                                            <input type="checkbox" :checked="!!entry.selective" @change="entry.selective = $event.target.checked; refreshCardData()" class="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0">
                                            <span :class="entry.selective ? 'text-amber-400 font-bold' : 'text-zinc-500'">条件触发</span>
                                        </label>
                                        <div class="flex flex-col gap-1">
                                            <label class="font-bold text-zinc-400">插入位置:</label>
                                            <select :value="entry.position ?? 1" @change="entry.position = Number($event.target.value); refreshCardData()" class="bg-zinc-800 border border-zinc-700 rounded p-1 outline-none text-zinc-200">
                                                <option :value="0">顶部（定义前）</option>
                                                <option :value="1">底部（定义后）</option>
                                                <option :value="2">聊天记录前</option>
                                                <option :value="3">@D 深度提示内</option>
                                            </select>
                                        </div>
                                    </div>

                                    <!-- 触发关键词（标签化） -->
                                    <div class="flex flex-col gap-1">
                                        <label class="font-bold text-zinc-400">触发关键词 (Keys):</label>
                                        <div class="flex flex-wrap gap-1 p-1.5 bg-zinc-800 border border-zinc-700 rounded min-h-[34px] items-center">
                                            <span v-for="k in (entry.keys || [])" :key="k" class="text-[10px] bg-green-500/10 text-green-400 px-2 py-0.5 rounded border border-green-500/30 flex items-center gap-1">
                                                {{ k }}
                                                <button @click="removeEntryKey(entry, k, 'keys')" class="hover:text-red-400">×</button>
                                            </span>
                                            <input @keydown="handleEntryKeyInput(entry, $event, 'keys')" @blur="addEntryKey(entry, $event.target.value, 'keys'); $event.target.value=''" type="text" placeholder="输入后回车/逗号添加" class="flex-1 min-w-[120px] bg-transparent outline-none text-zinc-200 placeholder-zinc-500 text-[11px]">
                                        </div>
                                    </div>

                                    <!-- 次级关键词（标签化） -->
                                    <div class="flex flex-col gap-1">
                                        <label class="font-bold text-zinc-400">次级关键词 (Secondary Keys):</label>
                                        <div class="flex flex-wrap gap-1 p-1.5 bg-zinc-800 border border-zinc-700 rounded min-h-[34px] items-center">
                                            <span v-for="k in (entry.secondary_keys || [])" :key="k" class="text-[10px] bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded border border-amber-500/30 flex items-center gap-1">
                                                {{ k }}
                                                <button @click="removeEntryKey(entry, k, 'secondary_keys')" class="hover:text-red-400">×</button>
                                            </span>
                                            <input @keydown="handleEntryKeyInput(entry, $event, 'secondary_keys')" @blur="addEntryKey(entry, $event.target.value, 'secondary_keys'); $event.target.value=''" type="text" placeholder="输入后回车/逗号添加" class="flex-1 min-w-[120px] bg-transparent outline-none text-zinc-200 placeholder-zinc-500 text-[11px]">
                                        </div>
                                    </div>

                                    <!-- 正文 -->
                                    <div class="flex flex-col gap-1">
                                        <div class="flex justify-between items-center">
                                            <label class="font-bold text-zinc-400">注入正文内容 (Content):</label>
                                            <button @click="openTextModal('世界书条目正文 (Content)', entry, 'content')" class="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition">🔍 放大</button>
                                        </div>
                                        <textarea v-model="entry.content" @input="refreshCardData" rows="6" class="w-full bg-zinc-900 border border-zinc-700 rounded p-2 outline-none text-zinc-200 resize-y leading-relaxed font-medium custom-scrollbar font-mono text-[11px] transition-all focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"></textarea>
                                    </div>

                                </div>
                            </div>
                        </div>
                    </div>
                    <div v-else class="text-zinc-500 text-center py-10">此卡片未内置世界书数据
                        <button @click="addCharacterWorldbookEntry" class="ml-2 text-blue-400 hover:underline">+ 立即新增一条</button>
                        <button @click="openCardWbImportModal" class="ml-2 text-emerald-400 hover:underline">📥 从世界书库导入</button>
                    </div>
                </div>

                <!-- 正则脚本：兼容 V2/V3 的可视化编辑器 -->
                <div v-if="currentTab === 'regex'">
                    <div class="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 mb-4 shadow-sm">
                        <div class="flex items-center justify-between mb-3 pb-2 border-b border-zinc-800">
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-bold text-amber-400">⚡ 正则与脚本配置 (Regex Scripts)</span>
                                <span class="text-xs px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full font-mono">{{ regexScripts.length }} 条脚本</span>
                            </div>
                            <button @click="addRegexScript" class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded shadow flex items-center gap-1 transition">
                                ➕ 添加正则脚本
                            </button>
                        </div>

                        <div v-if="regexScripts.length > 0" class="space-y-3">
                            <div v-for="(script, index) in regexScripts" :key="getRegexUid(script)" class="bg-zinc-800/80 border border-zinc-700/80 rounded-lg p-3 transition" :class="{ 'opacity-50 border-dashed': script.disabled }">
                                <div class="flex items-center justify-between gap-3 mb-2.5">
                                    <div class="flex items-center gap-2 flex-1">
                                        <span class="text-xs font-mono text-zinc-400 shrink-0">#{{ index + 1 }}</span>
                                        <input :value="script.scriptName || script.script_name || ''" @input="syncRegexScriptField(script, 'scriptName', $event.target.value)" type="text" placeholder="脚本名称 (如: 去除思考词)" class="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-100 font-medium focus:border-amber-500 focus:outline-none">
                                        <span class="text-[10px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 shrink-0 whitespace-nowrap">作用域: {{ getRegexPlacement(script.placement) }}</span>
                                    </div>
                                    <div class="flex items-center gap-3 shrink-0">
                                        <label class="flex items-center gap-1.5 cursor-pointer text-xs select-none">
                                            <input type="checkbox" :checked="!script.disabled" @change="syncRegexScriptField(script, 'disabled', !$event.target.checked)" class="rounded bg-zinc-900 border-zinc-700 text-indigo-600 focus:ring-0">
                                            <span :class="!script.disabled ? 'text-emerald-400 font-bold' : 'text-zinc-500'">{{ !script.disabled ? '已启用' : '已禁用' }}</span>
                                        </label>
                                        <button @click="deleteRegexScript(index)" class="text-zinc-400 hover:text-rose-400 p-1 rounded hover:bg-zinc-700/50 transition text-xs" title="删除此正则">🗑️ 删除</button>
                                    </div>
                                </div>
                                <div class="grid grid-cols-2 gap-2.5">
                                    <div>
                                        <label class="block text-[10px] text-zinc-400 mb-1">🔍 查找正则表达式 (Find Regex)</label>
                                        <input :value="script.findRegex || script.find_regex || ''" @input="syncRegexScriptField(script, 'findRegex', $event.target.value)" type="text" placeholder="例: &lt;think&gt;.*?&lt;/think&gt;" class="regex-input-find w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-amber-300 font-mono focus:border-amber-500 focus:outline-none">
                                    </div>
                                    <div>
                                        <label class="block text-[10px] text-zinc-400 mb-1">✏️ 替换为文本 (Replace With)</label>
                                        <input :value="script.replaceString !== undefined ? script.replaceString : (script.replace_string || '')" @input="syncRegexScriptField(script, 'replaceString', $event.target.value)" type="text" placeholder="留空表示直接删除匹配项" class="regex-input-replace w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-emerald-300 font-mono focus:border-amber-500 focus:outline-none">
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div v-else class="text-center py-6 border border-dashed border-zinc-800 rounded-lg text-zinc-500 text-xs">
                            <p class="mb-2">此角色卡暂未配置正则替换脚本</p>
                            <button @click="addRegexScript" class="text-indigo-400 hover:underline">+ 立即新增一条正则脚本</button>
                        </div>
                    </div>
                </div>

                <!-- 📊 渲染预览器：应用卡内渲染型正则脚本，实时预览 HTML 美化/状态栏效果 -->
                <div v-if="currentTab === 'statusbar'">
                    <div class="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 shadow-sm">
                        <!-- 标题栏 -->
                        <div class="flex items-center justify-between mb-3 pb-2 border-b border-zinc-800 flex-wrap gap-2">
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-bold text-emerald-400">📊 渲染预览（美化 / 状态栏）</span>
                                <span v-if="renderableScripts.length > 0" class="text-xs px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full font-mono">{{ renderableScripts.length }} 个渲染脚本</span>
                            </div>
                            <div v-if="renderableScripts.length > 0" class="flex items-center gap-2">
                                <button @click="showStatusDataPanel = !showStatusDataPanel" :class="showStatusDataPanel ? 'bg-emerald-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'" class="px-2.5 py-1 border border-zinc-700 rounded text-xs transition flex items-center gap-1" title="从开场白/备用开场白/聊天测试记录自动导入状态文本">📥 导入数据</button>
                                <div class="flex rounded overflow-hidden border border-zinc-700 text-xs">
                                    <button @click="statusbarViewMode = 'render'" :class="statusbarViewMode === 'render' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'" class="px-2.5 py-1 transition">✨ 渲染效果</button>
                                    <button @click="statusbarViewMode = 'source'" :class="statusbarViewMode === 'source' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'" class="px-2.5 py-1 transition">📄 替换后源码</button>
                                </div>
                                <button @click="resetStatusbarDemo" class="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-xs text-zinc-300 transition" title="恢复预置的状态文本示例">↩️ 示例</button>
                            </div>
                        </div>

                        <!-- 🧩 状态栏模板库：📚 渲染模板 / 📜 世界书指令 双选项卡合并（可折叠） -->
                        <div class="mb-4 rounded-lg border border-zinc-700/60 bg-zinc-500/[0.02] p-3">
                            <div class="flex items-center justify-between mb-2">
                                <div class="flex rounded overflow-hidden border border-zinc-700 text-xs">
                                    <button @click="statusLibTab = 'render'" :class="statusLibTab === 'render' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'" class="px-3 py-1 transition">📚 渲染模板（正则脚本）</button>
                                    <button @click="statusLibTab = 'prompt'" :class="statusLibTab === 'prompt' ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'" class="px-3 py-1 transition">📜 世界书指令</button>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-[10px] text-zinc-500">{{ statusLibTab === 'render' ? statusbarTemplateMeta.length + ' 套风格' : statusbarPromptMeta.length + ' 套指令' }}</span>
                                    <button @click="statusLibCollapsed = !statusLibCollapsed" :title="statusLibCollapsed ? '展开模板库' : '收起模板库'"
                                        class="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-zinc-300 transition">
                                        {{ statusLibCollapsed ? '▸ 展开' : '▾ 收起' }}
                                    </button>
                                </div>
                            </div>
                            <div v-show="!statusLibCollapsed">
                                <template v-if="statusLibTab === 'render'">
                                    <p class="text-[10px] text-zinc-500 leading-snug mb-2">点击卡片注入正则脚本（渲染 AI 输出的状态文本），注入后可在「正则脚本」Tab 微调。</p>
                                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                        <button v-for="tpl in statusbarTemplateMeta" :key="tpl.key" @click="injectStatusbarTemplate(tpl.key)"
                                            class="text-left bg-zinc-900/70 hover:bg-zinc-800 border border-zinc-700/70 hover:border-emerald-500/50 rounded-lg p-2.5 transition group">
                                            <div class="flex items-center gap-1.5 mb-1">
                                                <span class="text-base leading-none">{{ tpl.icon }}</span>
                                                <span class="text-xs font-bold text-zinc-200 truncate">{{ tpl.name }}</span>
                                            </div>
                                            <p class="text-[10px] text-zinc-500 leading-snug mb-1 line-clamp-2">{{ tpl.desc }}</p>
                                            <p class="text-[9px] text-zinc-600 font-mono truncate">📊 {{ tpl.fields }}</p>
                                            <p class="text-[9px] text-emerald-500/70 mt-1 opacity-0 group-hover:opacity-100 transition">⚡ 点击注入此模板</p>
                                        </button>
                                    </div>
                                </template>
                                <template v-else>
                                    <p class="text-[10px] text-zinc-500 leading-snug mb-2">指导 AI 在回复末尾按规则输出 &lt;Status&gt;...&lt;/Status&gt; 文本状态栏（含数值映射 / 趋势箭头 / 变化原因 / 严格格式）；注入后会在世界书中自动生成对应条目。</p>
                                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                        <button v-for="tpl in statusbarPromptMeta" :key="tpl.key" @click="injectStatusbarPrompt(tpl.key)"
                                            class="text-left bg-zinc-900/70 hover:bg-zinc-800 border border-zinc-700/70 hover:border-amber-500/50 rounded-lg p-2.5 transition group">
                                            <div class="flex items-center gap-1.5 mb-1">
                                                <span class="text-base leading-none">{{ tpl.icon }}</span>
                                                <span class="text-xs font-bold text-zinc-200 truncate">{{ tpl.name }}</span>
                                            </div>
                                            <p class="text-[10px] text-zinc-500 leading-snug mb-1 line-clamp-2">{{ tpl.desc }}</p>
                                            <p class="text-[9px] text-zinc-600 font-mono truncate">📊 {{ tpl.fields }}</p>
                                            <p class="text-[9px] text-amber-500/70 mt-1 opacity-0 group-hover:opacity-100 transition">⚡ 点击注入此指令</p>
                                        </button>
                                    </div>
                                </template>
                            </div>
                        </div>

                        <!-- 空状态：无渲染型脚本 → 提示 -->
                        <div v-if="renderableScripts.length === 0" class="text-center py-8 border border-dashed border-zinc-800 rounded-lg text-zinc-500 text-xs flex flex-col items-center gap-3">
                            <span class="text-4xl opacity-30">📊</span>
                            <div>
                                <p>当前卡片没有「渲染型」正则脚本（美化 / 状态栏均无）</p>
                                <p class="mt-1 text-[10px] opacity-80">从上方模板库选择一套注入，或用 AI 输出 &lt;status&gt;...&lt;/status&gt; 格式状态块</p>
                            </div>
                        </div>

                        <template v-else>
                            <!-- 🎨 卡内美化模板检测（核心）：美化代码写在正则替换串里，逐脚本独立成卡自动预览 -->
                            <div class="mb-4">
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="text-[11px] font-bold text-emerald-400">🎨 卡内美化模板</span>
                                    <span class="text-[10px] text-zinc-500">从正则脚本自动检测，点击卡片展开预览（已自动代入数据源）</span>
                                </div>
                                <div class="space-y-2">
                                    <div v-for="tpl in statusbarTemplates" :key="tpl.uid" class="border border-zinc-700/80 rounded-lg overflow-hidden">
                                        <!-- 卡头：脚本名 + 类型/匹配状态徽章，点击展开 -->
                                        <div class="flex items-center gap-2 px-3 py-2 bg-zinc-800/80 hover:bg-zinc-800 cursor-pointer select-none transition" @click="toggleTemplateCard(tpl.uid)">
                                            <span class="text-[10px] text-zinc-500 w-3 shrink-0">{{ expandedTemplateUid === tpl.uid ? '▾' : '▸' }}</span>
                                            <span class="text-xs font-bold text-zinc-200 truncate flex-1 min-w-0">{{ tpl.name }}</span>
                                            <span v-if="tpl.type === 'loader'" class="text-[9px] px-1.5 py-px rounded bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0">🌐 外链GUI</span>
                                            <span v-else-if="tpl.type === 'code'" class="text-[9px] px-1.5 py-px rounded bg-violet-500/15 text-violet-400 border border-violet-500/30 shrink-0">📜 脚本/样式</span>
                                            <span v-else class="text-[9px] px-1.5 py-px rounded bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 shrink-0">🎨 HTML模板</span>
                                            <span v-if="tpl.matched" class="text-[9px] px-1.5 py-px rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0" title="数据来源">✅ {{ tpl.matchedFrom }}</span>
                                            <span v-else class="text-[9px] px-1.5 py-px rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0" title="所有数据源均未命中该脚本的正则">⚠️ 未匹配数据</span>
                                        </div>
                                        <!-- 卡体：渲染效果 -->
                                        <div v-if="expandedTemplateUid === tpl.uid" class="p-3 bg-zinc-900/60">
                                            <template v-if="tpl.type === 'loader'">
                                                <div class="px-2 py-1 bg-sky-500/10 border border-sky-500/20 rounded text-[10px] text-sky-300 font-mono break-all mb-2">{{ tpl.loaderUrl }}</div>
                                                <iframe :src="tpl.loaderUrl" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" loading="lazy" class="w-full h-[420px] bg-white rounded border border-zinc-700" title="外链界面预览"></iframe>
                                                <p class="text-[10px] text-zinc-500 mt-1.5">沙箱加载 · 预览环境下酒馆变量接口不可用，界面可能显示默认值</p>
                                            </template>
                                            <template v-else-if="tpl.type === 'code'">
                                                <iframe :srcdoc="tpl.previewSrcdoc" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" class="w-full h-[420px] bg-white rounded border border-zinc-700" title="代码形态状态栏预览"></iframe>
                                                <p class="text-[10px] text-zinc-500 mt-1.5">📜 代码形态模板 · 沙箱运行（JS/CSS 全量生效；预览环境无酒馆变量接口，界面可能显示默认值）</p>
                                                <p v-if="!tpl.matched" class="text-[10px] text-amber-500/80 mt-1">⚠️ 未匹配数据源，当前运行的是模板骨架（$1 等捕获组未代入）。可在下方输入框粘贴符合格式的 AI 输出后再试。</p>
                                            </template>
                                            <template v-else>
                                                <div class="rounded-lg border border-zinc-700 bg-white p-4 max-w-[720px] overflow-x-auto custom-scrollbar">
                                                    <div v-if="tpl.previewHtml" class="statusbar-preview-body text-[13px] leading-relaxed" v-html="tpl.previewHtml"></div>
                                                    <p v-else class="text-zinc-400 text-xs">（模板为空或清洗后无内容）</p>
                                                </div>
                                                <p v-if="!tpl.matched" class="text-[10px] text-amber-500/80 mt-1.5">⚠️ 输入框/开场白/世界书/聊天记录/内置示例均未命中该脚本的正则，当前展示的是模板骨架（$1 等捕获组未代入数据）。可在下方输入框粘贴符合格式的 AI 输出后再试。</p>
                                            </template>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- 📥 候选数据导入面板：仅列出命中渲染脚本正则的来源（开场白/世界书/聊天记录） -->
                            <div v-if="showStatusDataPanel" class="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                                <div class="flex items-center justify-between mb-2">
                                    <span class="text-[11px] font-bold text-emerald-400">📥 检测到的状态数据（已按正则命中筛选：开场白 / 世界书条目 / 聊天记录）</span>
                                    <button v-if="statusDataCandidates.length > 1" @click="importAllStatusData" class="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold rounded transition">拼接导入全部</button>
                                </div>
                                <div v-if="statusDataCandidates.length === 0" class="text-[11px] text-zinc-500 py-2">
                                    未检测到能命中卡内渲染脚本正则的文本：开场白、世界书条目与聊天记录里都没有符合格式约定的状态块。可在下方输入框手动粘贴 AI 输出。
                                </div>
                                <div v-else class="space-y-1.5 max-h-56 overflow-y-auto custom-scrollbar">
                                    <div v-for="(item, idx) in statusDataCandidates" :key="idx" class="flex items-start gap-2 bg-zinc-900/80 border border-zinc-700/70 rounded p-2">
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-1.5 mb-0.5">
                                                <span class="text-[10px] text-zinc-400 font-bold shrink-0">{{ item.source }}</span>
                                                <span class="text-[9px] px-1 py-px rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">✅ 命中脚本</span>
                                                <span class="text-[9px] text-zinc-600 shrink-0">{{ item.text.length }} 字</span>
                                            </div>
                                            <p class="text-[10px] text-zinc-500 font-mono leading-relaxed line-clamp-2 break-all">{{ item.text.slice(0, 150) }}{{ item.text.length > 150 ? '…' : '' }}</p>
                                        </div>
                                        <button @click="importStatusData(item)" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold rounded shrink-0 transition">导入</button>
                                    </div>
                                </div>
                            </div>

                            <!-- 参与预览的脚本勾选（默认全选；取消勾选可隔离单个脚本效果） -->
                            <div class="mb-3 flex items-center flex-wrap gap-x-4 gap-y-1.5">
                                <span class="text-[10px] text-zinc-500 shrink-0">参与预览的脚本：</span>
                                <label v-for="s in renderableScripts" :key="getRegexUid(s)" class="flex items-center gap-1.5 cursor-pointer text-xs select-none">
                                    <input type="checkbox" :checked="isScriptEnabled(s)" @change="toggleStatusbarScript(s)" class="rounded bg-zinc-900 border-zinc-700 text-emerald-600 focus:ring-0">
                                    <span :class="isScriptEnabled(s) ? 'text-zinc-200' : 'text-zinc-500'">{{ s.scriptName || s.script_name || '未命名脚本' }}</span>
                                </label>
                            </div>

                            <!-- 输入区：粘贴 AI 输出的状态文本块，或经上方按钮自动导入 -->
                            <div class="mb-3">
                                <label class="block text-[10px] text-zinc-400 mb-1">📝 状态文本（粘贴 AI 的输出内容，含状态块即可实时渲染；支持 &lt;body&gt;&lt;script&gt;$('body').load('URL')&lt;/script&gt;&lt;/body&gt; 外链界面格式）</label>
                                <textarea v-model="statusbarInput" rows="7" placeholder="粘贴 AI 输出的状态文本块…（点上方「📥 导入数据」可自动从卡片/聊天记录导入）" class="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-2 text-xs text-zinc-200 font-mono focus:border-emerald-500 focus:outline-none resize-y custom-scrollbar"></textarea>
                            </div>

                            <!-- 🌐 外链 GUI 预览：检测到 $('body').load('URL') 格式时，沙箱 iframe 直接加载远程界面 -->
                            <div v-if="loaderUrls.length > 0" class="mb-3">
                                <label class="block text-[10px] text-sky-400 mb-1">🌐 外链界面（$('body').load 格式，沙箱加载 · 预览环境下酒馆变量接口不可用，界面可能显示默认值）</label>
                                <div v-for="url in loaderUrls" :key="url" class="rounded-lg border border-sky-500/30 bg-zinc-950 overflow-hidden mb-2">
                                    <div class="px-2 py-1 bg-sky-500/10 border-b border-sky-500/20 text-[10px] text-sky-300 font-mono break-all">{{ url }}</div>
                                    <iframe :src="url" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" loading="lazy" class="w-full h-[420px] bg-white" title="外链状态栏界面预览"></iframe>
                                </div>
                            </div>

                            <!-- 预览区 -->
                            <div v-if="statusbarViewMode === 'render'">
                                <label class="block text-[10px] text-zinc-400 mb-1">✨ 渲染效果（模拟酒馆聊天气泡，经安全清洗）</label>
                                <div class="rounded-lg border border-zinc-700 bg-white p-4 max-w-[720px] overflow-x-auto custom-scrollbar">
                                    <div v-if="previewHtml" class="statusbar-preview-body text-[13px] leading-relaxed" v-html="previewHtml"></div>
                                    <p v-else class="text-zinc-400 text-xs">（无内容：输入为空或未命中任何正则）</p>
                                </div>
                            </div>
                            <div v-else>
                                <label class="block text-[10px] text-zinc-400 mb-1">📄 替换后源码（应用勾选脚本得到的原始结果）</label>
                                <pre class="rounded-lg border border-zinc-700 bg-zinc-950 p-3 max-w-[720px] overflow-x-auto text-[11px] text-emerald-300 font-mono whitespace-pre-wrap custom-scrollbar">{{ statusSourcePreview || '（无内容）' }}</pre>
                                <div v-if="statusSourceIsLong" class="mt-1.5 flex items-center gap-2">
                                    <button @click="statusSourceExpanded = !statusSourceExpanded" class="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-emerald-300 transition">{{ statusSourceExpanded ? '↩️ 收起源码' : '📄 展开全文' }}</button>
                                    <span class="text-[10px] text-zinc-600">源码较长，默认折叠（压缩 JS / 内联样式可能占数千字符）</span>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>

                <!-- 3. 聊天测卡 (Chat) -->
                <div v-if="currentTab === 'chat'" class="flex flex-col h-full max-w-4xl mx-auto border border-zinc-700 rounded">
                    <div class="bg-zinc-900 p-2 text-xs flex items-center justify-between border-b border-zinc-800 flex-wrap gap-2">
                        <div class="flex items-center gap-2 flex-1 flex-wrap">
                            <span class="font-bold text-zinc-400">API:</span>
                            <input v-model="apiEndpoint" type="text" class="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded w-64 outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50" placeholder="http://127.0.0.1:1234/v1/chat/completions">
                            <span class="font-bold text-zinc-400 shrink-0">Key:</span>
                            <input v-model="apiKey" type="password" placeholder="留空则使用 test-key" title="远端 API 的鉴权密钥，本地 API 可留空" class="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded w-24 outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50">
                            <span class="font-bold text-zinc-400 shrink-0">Model:</span>
                            <select v-if="availableModels.length > 0" v-model="apiModel" class="px-2 py-1 bg-zinc-800 border border-indigo-500/80 rounded outline-none text-zinc-200 text-xs max-w-[11rem]">
                                <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                            </select>
                            <input v-else v-model="apiModel" list="model-suggestions" type="text" placeholder="local-model 或模型 ID" title="OpenAI 兼容接口的模型名称，本地 API 可留空" class="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded w-28 outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50">
                            <button @click="fetchAvailableModels" :disabled="isFetchingModels" class="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-[11px] font-medium rounded shadow flex items-center gap-1 transition" title="拉取服务端可用模型列表">
                                <span v-if="isFetchingModels" class="animate-spin">🌀</span>
                                <span v-else>🔄</span> 拉取模型
                            </button>
                            <span v-if="fetchModelStatus" class="text-[10px] shrink-0" :class="fetchModelStatus.includes('❌') ? 'text-red-400' : 'text-emerald-400'">{{ fetchModelStatus }}</span>
                        </div>
                        <div class="flex items-center shrink-0">
                            <button @click="isChatRenderMode = !isChatRenderMode"
                                    :class="isChatRenderMode ? 'text-indigo-400' : 'text-zinc-400'"
                                    class="font-bold mr-4 hover:opacity-80 transition-opacity">
                                {{ isChatRenderMode ? '👁️ 渲染模式' : '💻 代码模式' }}
                            </button>
                            <button @click="clearChat" class="text-red-400 hover:text-red-300 font-bold">清空记录</button>
                        </div>
                    </div>
                    <div ref="chatContainer" class="flex-1 overflow-y-auto p-4 space-y-4 bg-zinc-950 custom-scrollbar">
                        <template v-for="(msg, idx) in chatHistory" :key="idx">
                            <div v-if="msg.role !== 'system'" class="flex gap-3" :class="msg.role === 'user' ? 'flex-row-reverse' : ''">
                                <div class="w-8 h-8 rounded shrink-0 shadow-sm border border-zinc-700 overflow-hidden" :class="msg.role === 'user' ? 'bg-blue-600' : 'bg-zinc-700'">
                                    <img v-if="msg.role === 'assistant' && imgUrl" :src="imgUrl" class="w-full h-full object-cover">
                                </div>
                                <div class="max-w-[75%]">
                                    <div class="text-[10px] text-zinc-400 mb-0.5" :class="msg.role === 'user' ? 'text-right' : ''">{{ msg.name }}</div>
                                    <div :class="msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-800 border border-zinc-700 text-zinc-200'" class="p-2.5 rounded shadow-sm leading-relaxed text-[12px]">
                                        <div v-if="!isChatRenderMode" v-html="renderHTML(cleanMarkdownFences(msg.content))"></div>
                                        <div v-else v-html="renderSafeHTML(cleanMarkdownFences(msg.content))"></div>
                                    </div>
                                </div>
                            </div>
                        </template>
                        <div v-if="isChatting" class="text-xs text-zinc-500 italic">对方正在输入...</div>
                    </div>
                    <div class="p-2 bg-zinc-900 border-t border-zinc-800 flex gap-2">
                        <textarea v-model="chatInput" @keydown.enter.exact.prevent="sendMessage" rows="2" class="flex-1 bg-zinc-800 border border-zinc-700 rounded py-1.5 px-2 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 resize-none text-[12px] text-zinc-200 placeholder-zinc-500 custom-scrollbar" placeholder="输入对话... (Enter 发送)"></textarea>
                        <button @click="sendMessage" :disabled="isChatting || chatInput.trim() === ''" class="px-4 bg-blue-600 text-white rounded font-bold disabled:bg-zinc-700 disabled:text-zinc-500">发送</button>
                    </div>
                </div>

                <!-- 4. 原始代码 (Raw JSON) -->
                <div v-if="currentTab === 'raw'" class="h-full">
                    <pre class="bg-[#1e1e1e] text-[#d4d4d4] p-4 rounded text-[11px] overflow-auto h-full font-mono leading-tight custom-scrollbar">{{ formattedJson }}</pre>
                </div>

            </div>
        </template>

        <div v-else class="flex flex-col items-center justify-center h-full text-zinc-500 bg-zinc-950">
            <p class="text-sm font-medium">在左侧选择角色卡进行编辑</p>
        </div>
        </div>

        <!-- ⚙️ 预设编辑工作区 -->
        <div v-show="appMode === 'presets'" class="flex-1 flex flex-col h-full overflow-hidden relative bg-zinc-950">
            <!-- 空状态：保持与世界书编辑器一致的视觉层级 -->
            <div v-if="!activePreset" class="flex-1 flex items-center justify-center text-zinc-500 flex-col gap-4">
                <div class="w-20 h-20 rounded-2xl flex items-center justify-center bg-sky-500/10 border border-sky-500/20 shadow-inner">
                    <span class="text-4xl opacity-70">⚙️</span>
                </div>
                <div class="text-center">
                    <p class="text-sm tracking-widest text-zinc-300">请在左侧选择一个预设进行编辑</p>
                    <p class="text-[11px] text-zinc-600 mt-1">预设内容将在这里集中管理</p>
                </div>
            </div>
            <template v-else>
                <!-- 预设 IDE 顶部控制栏 -->
                <div class="px-4 py-3 border-b border-zinc-800 bg-zinc-900/90 shrink-0 shadow-sm">
                    <div class="flex items-center justify-between gap-3 min-w-0">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="w-9 h-9 rounded-xl flex items-center justify-center bg-sky-500/15 border border-sky-500/30 text-lg shrink-0">⚙️</div>
                            <div class="min-w-0">
                                <div class="flex items-center gap-2 min-w-0">
                                    <h2 class="text-sm font-bold text-zinc-100 truncate">{{ activePreset.data.name || activePreset.name }}</h2>
                                    <span class="px-1.5 py-0.5 rounded text-[10px] font-medium text-sky-300 bg-sky-500/10 border border-sky-500/20 shrink-0">预设</span>
                                </div>
                                <p class="text-[10px] text-zinc-500 truncate mt-0.5" :title="activePreset.path">{{ activePreset.name }}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <button @click="openPresetInFolder(activePreset)" class="px-2.5 py-1.5 theme-element hover:border-sky-500/60 border rounded-lg text-[11px] transition" title="在资源管理器中定位预设">📂 定位</button>
                            <button @click="renamePreset(activePreset)" class="px-2.5 py-1.5 theme-element hover:border-sky-500/60 border rounded-lg text-[11px] transition">✏️ 重命名</button>
                            <button @click="saveActivePreset" class="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-bold rounded-lg shadow-lg shadow-sky-900/20 transition">💾 保存</button>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 mt-3 pt-2.5 border-t border-zinc-800/80 text-[10px] text-zinc-500">
                        <span class="text-sky-400">● 已加载</span>
                        <span class="text-zinc-700">|</span>
                        <span>JSON 编辑模式</span>
                        <span class="ml-auto">修改内容后离开编辑区前请点击保存</span>
                    </div>
                </div>

                <!-- 预设内容编辑卡片 -->
                <div class="flex-1 overflow-auto p-4 md:p-6 custom-scrollbar">
                    <div class="flex items-center justify-between mb-4 rounded-lg border border-zinc-800 bg-zinc-900/70 p-1.5">
                        <span class="px-2 text-[11px] text-zinc-500">编辑视图</span>
                        <div class="flex items-center gap-1 flex-wrap justify-end">
                            <button @click="presetEditorMode = 'visual'" :class="presetEditorMode === 'visual' ? 'bg-sky-600 text-white' : 'text-zinc-500 hover:text-zinc-200'" class="px-3 py-1.5 rounded-md text-[11px] transition">⚙️ 基础参数</button>
                            <button @click="presetEditorMode = 'scripts'" :class="presetEditorMode === 'scripts' ? 'bg-violet-600 text-white' : 'text-zinc-500 hover:text-zinc-200'" class="px-3 py-1.5 rounded-md text-[11px] transition">📜 脚本 ({{ presetScripts.length }})</button>
                            <button @click="presetEditorMode = 'regex'" :class="presetEditorMode === 'regex' ? 'bg-amber-600 text-white' : 'text-zinc-500 hover:text-zinc-200'" class="px-3 py-1.5 rounded-md text-[11px] transition">⚡ 正则 ({{ presetRegexScripts.length }})</button>
                            <button @click="presetEditorMode = 'json'" :class="presetEditorMode === 'json' ? 'bg-sky-600 text-white' : 'text-zinc-500 hover:text-zinc-200'" class="px-3 py-1.5 rounded-md text-[11px] transition">原始 JSON</button>
                        </div>
                    </div>
                    <template v-if="presetEditorMode === 'visual'">
                    <!-- 第一批常用参数：仅映射已存在的 JSON 字段，不改变预设数据结构 -->
                    <section class="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-xl shadow-black/10 overflow-hidden">
                        <div class="px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                            <div>
                                <h3 class="text-xs font-bold text-zinc-200">基础参数</h3>
                                <p class="text-[10px] text-zinc-500 mt-0.5">常用生成参数 · 修改后会同步到下方 JSON</p>
                            </div>
                            <span class="text-[10px] text-zinc-600">第 1 / 4 步</span>
                        </div>
                        <div class="grid grid-cols-2 lg:grid-cols-3 gap-3 p-4">
                            <label v-for="param in presetBasicParams" :key="param.key" class="block">
                                <span class="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
                                    <span>{{ param.label }}</span>
                                    <span class="text-[10px] text-zinc-600 font-mono">{{ param.key }}</span>
                                </span>
                                <input :value="getPresetParam(param.key)" @change="updatePresetParam(param.key, $event.target.value, param.type)" :type="param.type" :step="param.step" :min="param.min" :max="param.max" :placeholder="param.placeholder" class="w-full px-2.5 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-xs text-zinc-200 outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500/20">
                            </label>
                        </div>
                    </section>

                    <!-- 第三批：高级生成参数 -->
                    <section class="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-xl shadow-black/10 overflow-hidden">
                        <div class="px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                            <div>
                                <h3 class="text-xs font-bold text-zinc-200">高级参数</h3>
                                <p class="text-[10px] text-zinc-500 mt-0.5">不同模型支持的字段可能不同，未识别字段请使用原始 JSON 编辑</p>
                            </div>
                            <span class="text-[10px] text-zinc-600">第 3 / 4 步</span>
                        </div>
                        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4">
                            <label v-for="param in presetAdvancedParams" :key="param.key" class="block">
                                <span class="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
                                    <span>{{ param.label }}</span><span class="text-[10px] text-zinc-600 font-mono">{{ param.key }}</span>
                                </span>
                                <input :value="getPresetParam(param.key)" @change="updatePresetParam(param.key, $event.target.value, param.type)" :type="param.type" :step="param.step" :min="param.min" :max="param.max" :placeholder="param.placeholder" class="w-full px-2.5 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-xs text-zinc-200 outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500/20">
                            </label>
                        </div>
                    </section>

                    <!-- 第二批：Prompt 顺序与内容编辑 -->
                    <section class="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-xl shadow-black/10 overflow-hidden">
                        <div class="px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                            <div>
                                <h3 class="text-xs font-bold text-zinc-200">Prompt 列表</h3>
                                <p class="text-[10px] text-zinc-500 mt-0.5">调整提示词顺序、启用状态与正文内容</p>
                            </div>
                            <div class="flex items-center gap-2">
                                <button @click="toggleAllPresetPrompts" class="px-2 py-1 rounded-md border border-zinc-700 text-[10px] text-zinc-400 hover:text-zinc-200 hover:border-sky-500 transition">{{ allPresetPromptsExpanded ? '全部收起' : '全部展开' }}</button>
                                <span class="text-[10px] text-zinc-600">{{ presetPrompts.length }} 条</span>
                                <button @click="addPresetPrompt" class="px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[10px] font-bold transition">＋ 添加 Prompt</button>
                            </div>
                        </div>
                        <div v-if="presetPrompts.length" class="p-3 space-y-2">
                            <article v-for="(prompt, index) in presetPrompts" :key="prompt.__editorId" draggable="true" @dragstart="startPromptDrag(index, $event)" @dragover.prevent @drop="dropPrompt(index, $event)" @dragend="endPromptDrag" :class="promptDragIndex === index ? 'border-sky-500/70 bg-sky-500/5' : 'border-zinc-800 bg-zinc-950/70'" class="rounded-lg border overflow-hidden transition-colors">
                                <div class="flex items-center gap-2 px-3 py-2">
                                    <button @click="togglePresetPrompt(index)" class="w-5 h-5 rounded text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-sky-400 transition" :title="prompt.expanded ? '收起 Prompt' : '展开 Prompt'">{{ prompt.expanded ? '▼' : '▶' }}</button>
                                    <span class="cursor-grab active:cursor-grabbing text-zinc-600 hover:text-sky-400" title="拖拽调整顺序">⠿</span>
                                    <span class="w-6 h-6 rounded-md bg-zinc-800 text-zinc-500 text-[10px] flex items-center justify-center font-mono">{{ index + 1 }}</span>
                                    <input v-model="prompt.name" @change="syncPresetJson" class="flex-1 min-w-0 bg-transparent text-xs font-medium text-zinc-200 outline-none border-b border-transparent focus:border-sky-500" placeholder="Prompt 名称">
                                    <span class="hidden md:block max-w-[35%] truncate text-[10px] text-zinc-600">{{ prompt.content || '暂无内容' }}</span>
                                    <label class="flex items-center gap-1.5 text-[10px] text-zinc-500 cursor-pointer">
                                        <input type="checkbox" v-model="prompt.enabled" @change="syncPresetJson" class="accent-sky-500"> 启用
                                    </label>
                                    <button @click="movePresetPrompt(index, -1)" :disabled="index === 0" class="px-1.5 py-1 rounded text-[11px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-25">↑</button>
                                    <button @click="movePresetPrompt(index, 1)" :disabled="index === presetPrompts.length - 1" class="px-1.5 py-1 rounded text-[11px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-25">↓</button>
                                    <button @click="removePresetPrompt(index)" class="px-1.5 py-1 rounded text-[11px] text-red-400 hover:bg-red-500/10">删除</button>
                                </div>
                                <div v-if="prompt.expanded" class="grid grid-cols-1 md:grid-cols-3 gap-2 p-3 border-t border-zinc-800/80">
                                    <input v-model="prompt.role" @change="syncPresetJson" class="px-2.5 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 outline-none focus:border-sky-500" placeholder="角色 role，例如 system">
                                    <input v-model="prompt.identifier" @change="syncPresetJson" class="px-2.5 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 outline-none focus:border-sky-500" placeholder="唯一标识 identifier">
                                    <input v-model="prompt.injection_depth" @change="syncPresetJson" type="number" min="0" step="1" class="px-2.5 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 outline-none focus:border-sky-500" placeholder="注入深度 depth">
                                    <select v-model="prompt.injection_position" @change="syncPresetJson" class="px-2.5 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 outline-none focus:border-sky-500">
                                        <option :value="undefined">默认注入位置</option>
                                        <option :value="0">相对底部</option>
                                        <option :value="1">相对顶部</option>
                                    </select>
                                    <label class="flex items-center gap-2 px-2.5 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 cursor-pointer">
                                        <input type="checkbox" v-model="prompt.forbid_overrides" @change="syncPresetJson" class="accent-sky-500"> 禁止覆盖
                                    </label>
                                </div>
                                <textarea v-if="prompt.expanded" v-model="prompt.content" @change="syncPresetJson" class="mx-3 mb-3 w-[calc(100%-1.5rem)] min-h-[96px] resize-y px-3 py-2 rounded-md bg-[#181818] border border-zinc-800 text-[11px] leading-relaxed text-zinc-300 outline-none focus:border-sky-500" placeholder="Prompt 内容"></textarea>
                            </article>
                        </div>
                        <div v-else class="px-4 py-8 text-center text-[11px] text-zinc-600">当前预设没有 prompts 数组，点击右上角添加第一条 Prompt。</div>
                    </section>

                    </template>
                    <section v-if="presetEditorMode === 'scripts'" class="rounded-xl border-[color:var(--border-color)] bg-[color:var(--bg-surface)] shadow-xl overflow-hidden">
                        <div class="px-4 py-3 border-b border-[color:var(--border-color)] flex items-center justify-between">
                            <div><h3 class="text-xs font-bold text-violet-400">📜 脚本</h3><p class="text-[10px] text-[color:var(--text-sub)] mt-0.5">编辑当前预设附加的脚本</p></div>
                            <button @click="addPresetScript" class="px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-bold">＋ 添加脚本</button>
                        </div>
                        <div v-if="presetScripts.length" class="p-3 space-y-3">
                            <article v-for="(script, index) in presetScripts" :key="index" class="rounded-lg border-[color:var(--border-color)] bg-[color:var(--bg-element)] p-3 space-y-2">
                                <!-- 头部：折叠按钮 + 名称 + 标记 + 操作 -->
                                <div class="flex items-center gap-2 flex-wrap">
                                    <button @click="togglePresetScriptCollapse(index)" class="text-[color:var(--text-sub)] hover:text-[color:var(--text-main)] text-xs shrink-0 w-4 text-center" :title="presetScriptCollapsed[getScriptPreviewKey(script, index)] ? '展开脚本' : '折叠脚本'">{{ presetScriptCollapsed[getScriptPreviewKey(script, index)] ? '▸' : '▾' }}</button>
                                    <input v-model="script.name" @input="syncPresetResources('scripts')" class="flex-1 min-w-[120px] bg-transparent border-b border-[color:var(--border-color)] text-xs text-[color:var(--text-main)] px-1 py-1 outline-none focus:border-violet-500" :placeholder="`脚本 ${index + 1} 名称`">
                                    <span v-if="isRenderScript(script)" class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 whitespace-nowrap" title="脚本含 DOM 渲染逻辑，识别为渲染脚本，可预览渲染效果">✨ 渲染脚本</span>
                                    <label class="text-[10px] text-[color:var(--text-sub)] whitespace-nowrap"><input type="checkbox" v-model="script.enabled" @change="syncPresetResources('scripts')" class="accent-violet-500"> 启用</label>
                                    <button @click="togglePresetScriptPreview(index)" class="text-[10px] text-emerald-400 hover:text-emerald-300 whitespace-nowrap" :title="presetScriptPreviews[getScriptPreviewKey(script, index)]?.open ? '收起渲染预览' : '在沙箱 iframe 中预览脚本渲染效果'">✨ {{ presetScriptPreviews[getScriptPreviewKey(script, index)]?.open ? '收起预览' : '渲染预览' }}</button>
                                    <button @click="removePresetScript(index)" class="text-red-400 text-xs">删除</button>
                                </div>
                                <!-- 主体：折叠时隐藏（代码 / 渲染预览 / 说明） -->
                                <template v-if="!presetScriptCollapsed[getScriptPreviewKey(script, index)]">
                                    <!-- ✨ 渲染脚本预览区（沙箱 iframe 隔离，脚本运行于无权限环境） -->
                                    <div v-if="isRenderScript(script) && presetScriptPreviews[getScriptPreviewKey(script, index)]?.open" class="rounded-md border border-emerald-800/50 overflow-hidden bg-[color:var(--bg-surface)]">
                                        <div v-if="presetScriptPreviews[getScriptPreviewKey(script, index)]?.url" class="relative">
                                            <div class="px-2 py-1 bg-[color:var(--bg-element)] border-b border-[color:var(--border-color)] flex items-center justify-between">
                                                <span class="text-[9px] text-emerald-400">✨ 渲染效果（沙箱隔离预览 · 依赖酒馆环境的 API 可能无法运行）</span>
                                                <button @click="buildPresetScriptPreview(index)" class="text-[9px] text-[color:var(--text-sub)] hover:text-[color:var(--text-main)]">🔄 重新渲染</button>
                                            </div>
                                            <iframe :src="presetScriptPreviews[getScriptPreviewKey(script, index)]?.url" sandbox="allow-scripts" class="w-full h-[260px] bg-[#18181b] border-0" title="渲染脚本预览"></iframe>
                                        </div>
                                        <div v-else class="p-3 text-[10px] text-red-400">{{ presetScriptPreviews[getScriptPreviewKey(script, index)]?.error || '无法预览' }}</div>
                                    </div>
                                    <textarea v-model="script.content" @input="syncPresetResources('scripts')" class="w-full min-h-[180px] resize-y rounded-md bg-[color:var(--bg-element)] border border-[color:var(--border-color)] p-3 font-mono text-[11px] leading-relaxed text-[color:var(--text-main)] outline-none focus:border-violet-500" placeholder="脚本内容"></textarea>
                                    <input v-if="script.info !== undefined" v-model="script.info" @input="syncPresetResources('scripts')" class="w-full bg-[color:var(--bg-element)] border border-[color:var(--border-color)] rounded-md px-2 py-1 text-[10px] text-[color:var(--text-sub)]" placeholder="脚本说明">
                                </template>
                            </article>
                        </div>
                        <div v-else class="p-10 text-center text-xs text-[color:var(--text-sub)]">当前预设没有脚本，点击右上角添加。</div>
                    </section>
                    <section v-if="presetEditorMode === 'regex'" class="rounded-xl border-[color:var(--border-color)] bg-[color:var(--bg-surface)] shadow-xl overflow-hidden">
                        <div class="px-4 py-3 border-b border-[color:var(--border-color)] flex items-center justify-between"><div><h3 class="text-xs font-bold text-amber-400">⚡ 正则脚本</h3><p class="text-[10px] text-[color:var(--text-sub)] mt-0.5">编辑当前预设附加的正则脚本</p></div><button @click="addPresetRegex" class="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-bold">＋ 添加正则</button></div>
                        <div v-if="presetRegexScripts.length" class="p-3 space-y-3">
                            <article v-for="(regex, index) in presetRegexScripts" :key="index" class="rounded-lg border-[color:var(--border-color)] bg-[color:var(--bg-element)] p-3 space-y-2">
                                <div class="flex items-center gap-2"><input v-model="regex.scriptName" @input="syncPresetResources('regex')" class="flex-1 bg-transparent border-b border-[color:var(--border-color)] text-xs text-[color:var(--text-main)] px-1 py-1 outline-none focus:border-amber-500" :placeholder="`正则 ${index + 1} 名称`"><label class="text-[10px] text-[color:var(--text-sub)] whitespace-nowrap"><input type="checkbox" :checked="!regex.disabled" @change="regex.disabled = !$event.target.checked; syncPresetResources('regex')" class="accent-amber-500"> 启用</label><button @click="removePresetRegex(index)" class="text-red-400 text-xs">删除</button></div>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-2"><label class="text-[10px] text-[color:var(--text-sub)]">匹配表达式<textarea v-model="regex.findRegex" @input="syncPresetResources('regex')" class="mt-1 w-full min-h-[100px] resize-y rounded-md bg-[color:var(--bg-element)] border border-[color:var(--border-color)] p-2 font-mono text-[11px] text-amber-400 outline-none focus:border-amber-500"></textarea></label><label class="text-[10px] text-[color:var(--text-sub)]">替换文本<textarea v-model="regex.replaceString" @input="syncPresetResources('regex')" class="mt-1 w-full min-h-[100px] resize-y rounded-md bg-[color:var(--bg-element)] border border-[color:var(--border-color)] p-2 font-mono text-[11px] text-emerald-400 outline-none focus:border-amber-500"></textarea></label></div>
                                <div v-if="regex.trimStrings !== undefined" class="grid grid-cols-1 md:grid-cols-3 gap-2"><label class="text-[10px] text-[color:var(--text-sub)]">去除字符串<textarea v-model="regex.trimStrings" @input="syncPresetResources('regex')" class="mt-1 w-full min-h-[60px] resize-y rounded-md bg-[color:var(--bg-element)] border border-[color:var(--border-color)] p-2 font-mono text-[10px] text-[color:var(--text-main)] outline-none focus:border-amber-500"></textarea></label><label class="text-[10px] text-[color:var(--text-sub)]">应用位置<textarea v-model="regex.placement" @input="syncPresetResources('regex')" class="mt-1 w-full min-h-[60px] resize-y rounded-md bg-[color:var(--bg-element)] border border-[color:var(--border-color)] p-2 font-mono text-[10px] text-[color:var(--text-main)] outline-none focus:border-amber-500"></textarea></label><label class="text-[10px] text-[color:var(--text-sub)]">深度范围<input v-model="regex.minDepth" @input="syncPresetResources('regex')" class="mt-1 w-full bg-[color:var(--bg-element)] border border-[color:var(--border-color)] rounded-md px-2 py-1 text-[10px] text-[color:var(--text-main)]"></label></div>
                            </article>
                        </div>
                        <div v-else class="p-10 text-center text-xs text-[color:var(--text-sub)]">当前预设没有正则脚本，点击右上角添加。</div>
                    </section>
                    <section v-if="presetEditorMode === 'json'" class="min-h-[460px] flex flex-col rounded-xl border-[color:var(--border-color)] bg-[color:var(--bg-surface)] shadow-2xl shadow-black/20 overflow-hidden">
                        <div class="px-4 py-3 border-b border-[color:var(--border-color)] bg-[color:var(--bg-surface)] flex items-center justify-between gap-2 shrink-0">
                            <div>
                                <h3 class="text-xs font-bold text-[color:var(--text-main)]">预设内容</h3>
                                <p class="text-[10px] text-[color:var(--text-sub)] mt-0.5">直接编辑 JSON，支持酒馆不同版本的预设字段</p>
                            </div>
                            <span class="px-2 py-1 rounded-md text-[10px] font-mono text-[color:var(--text-sub)] bg-[color:var(--bg-element)] border border-[color:var(--border-color)]">JSON</span>
                        </div>
                        <div class="flex-1 p-3 bg-[color:var(--bg-element)]">
                            <textarea v-model="presetJsonText" @change="applyPresetJson" class="w-full h-full min-h-[400px] resize-none bg-[color:var(--bg-element)] text-[color:var(--text-main)] p-4 rounded-lg border border-[color:var(--border-color)] font-mono text-xs leading-relaxed focus:outline-none focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/30 transition" spellcheck="false"></textarea>
                        </div>
                    </section>
                </div>
            </template>
        </div>

        <!-- 🌍 引擎 B：世界书深度编辑工作区 (Entry IDE) -->
        <div v-show="appMode === 'worldbooks'" class="flex-1 flex flex-col h-full overflow-hidden relative">

            <!-- 空状态提示 -->
            <div v-if="!activeWorldbook" class="flex-1 flex items-center justify-center text-zinc-500 flex-col gap-3">
                <span class="text-5xl opacity-30">🌍</span>
                <p class="text-sm tracking-widest">请在左侧选择一本世界书进行编辑</p>
            </div>

            <!-- 深度编辑器主体 -->
            <template v-else>
                <!-- 🎛️ IDE 控制栏 -->
                <div class="px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80 flex flex-wrap items-center justify-between shrink-0 gap-2 shadow-sm min-w-0">

                    <div class="flex items-center gap-2 flex-1 min-w-[120px]">
                        <span class="text-xs font-bold text-amber-500 shrink-0 truncate">📖 {{ activeWorldbook.data.name || activeWorldbook.name }}</span>
                    </div>

                    <div class="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                        <button @click="openWbSnapshots(activeWorldbook)" class="px-2 py-1 theme-element hover:border-amber-500 border rounded text-[11px] font-medium transition whitespace-nowrap" title="查看当前世界书的历史快照并回滚">🕒 快照</button>
                        <button @click="openWbGraphModal" class="px-2 py-1 theme-element hover:border-amber-500 border rounded text-[11px] font-medium transition whitespace-nowrap" title="查看当前世界书的词条关联图谱">
                            🌐 关系图谱
                        </button>
                        <button @click="openWbImportModal" class="px-2 py-1 theme-element hover:border-emerald-500 border rounded text-[11px] font-medium transition whitespace-nowrap" title="从其他世界书按需导入词条到当前书">
                            🔀 导入词条
                        </button>
                        <button @click="exportFilteredWorldbook" class="px-2 py-1 theme-element hover:border-amber-500 border rounded text-[11px] font-medium transition whitespace-nowrap" title="将当前搜索过滤出的词条拆分为独立世界书">
                            📤 拆分导出
                        </button>
                        <button @click="exportActiveWorldbook" class="px-2 py-1 theme-element hover:border-indigo-500 border rounded text-[11px] font-medium transition whitespace-nowrap" title="导出单文件">📤</button>
                        <button @click="addWorldbookEntry" class="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold rounded shadow transition whitespace-nowrap">➕ 新增</button>
                        <button @click="saveActiveWorldbook" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold rounded shadow transition whitespace-nowrap">💾 保存</button>
                    </div>
                </div>

                <!-- ✅ 世界书编辑器：左侧词条列表（可收起）+ 右侧详情编辑 -->
                <div class="flex-1 flex overflow-hidden min-h-0 relative">

                    <!-- 左：词条列表侧栏 -->
                    <div class="relative h-full flex flex-col border-r border-zinc-800 bg-zinc-900/90 transition-all duration-300 shrink-0"
                         :style="{ width: isWbSidebarCollapsed ? '48px' : '260px' }">

                        <!-- ✅ 竖直长条折叠按钮（浮在栏边缘，垂直居中） -->
                        <button @click="isWbSidebarCollapsed = !isWbSidebarCollapsed"
                                class="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-12 bg-zinc-800 border border-zinc-700 rounded-r-md flex items-center justify-center text-xs text-zinc-400 hover:text-white hover:bg-zinc-700 shadow-lg z-20 transition"
                                :title="isWbSidebarCollapsed ? '展开词条列表' : '收起词条列表'">
                            {{ isWbSidebarCollapsed ? '▶' : '◀' }}
                        </button>

                        <!-- 收起态：📖 可点击展开 + 竖排词条数 -->
                        <div v-if="isWbSidebarCollapsed" class="flex-1 py-4 flex flex-col items-center gap-3 text-zinc-500">
                            <span class="cursor-pointer text-lg hover:text-emerald-400 transition" @click="isWbSidebarCollapsed = false" title="展开词条列表">📖</span>
                            <span class="text-[10px] font-mono font-bold writing-vertical-rl">{{ (activeWorldbook.data && activeWorldbook.data.entries) ? activeWorldbook.data.entries.length : 0 }} 词条</span>
                        </div>

                        <!-- 展开态：搜索 + 筛选/排序 + 批量 + 词条列表 -->
                        <div v-else class="flex-1 flex flex-col overflow-hidden">
                            <div class="p-2 border-b border-zinc-800 flex gap-1 items-center shrink-0 bg-zinc-900 flex-wrap">
                                <div class="relative flex-1 min-w-[120px]">
                                    <span class="absolute left-2 top-1.5 text-zinc-500 text-xs">🔍</span>
                                    <input v-model="entrySearchQuery" type="text" placeholder="搜索名字或触发词..."
                                           class="w-full h-7 bg-zinc-800/80 border border-zinc-700 rounded pl-7 pr-2 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none transition">
                                </div>
                                <button @click="addWorldbookEntry" title="新建词条" class="h-7 px-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs shrink-0 transition flex items-center justify-center">➕</button>
                            </div>

                            <!-- 筛选 / 排序 / 批量 / 体检 工具行 -->
                            <div class="px-2 py-1.5 border-b border-zinc-800 flex flex-wrap gap-1.5 items-center shrink-0 bg-zinc-900/60">
                                <select v-model="entryFilterState" class="h-6 bg-zinc-800 border border-zinc-700 rounded px-1 text-[10px] text-zinc-300 focus:outline-none">
                                    <option value="all">全部状态</option>
                                    <option value="enabled">仅启用</option>
                                    <option value="disabled">仅停用</option>
                                    <option value="constant">仅常驻</option>
                                    <option value="selective">仅条件触发</option>
                                </select>
                                <select v-model="entrySortBy" class="h-6 bg-zinc-800 border border-zinc-700 rounded px-1 text-[10px] text-zinc-300 focus:outline-none">
                                    <option value="default">默认顺序</option>
                                    <option value="orderAsc">权重升序</option>
                                    <option value="orderDesc">权重降序</option>
                                    <option value="name">按名称</option>
                                    <option value="contentLen">按正文长度</option>
                                </select>
                                <button @click="toggleBatchMode"
                                        :class="batchMode ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700'"
                                        class="h-6 px-1.5 border rounded text-[10px] transition shrink-0">☑️ 批量</button>
                                <button @click="runEntryHealthCheck" title="查重 + 空词条/孤儿触发词体检"
                                        class="h-6 px-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-amber-400 transition shrink-0">🩺 体检</button>
                            </div>

                            <!-- 批量操作栏（仅批量模式显示） -->
                            <div v-if="batchMode" class="px-2 py-1.5 border-b border-zinc-800 flex flex-wrap gap-1.5 items-center shrink-0 bg-emerald-500/10">
                                <span class="text-[10px] text-emerald-400 font-bold">已选 {{ batchSelected.size }} 条</span>
                                <button @click="selectAllEntries" class="h-6 px-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-zinc-300 transition">全选</button>
                                <button @click="clearBatchSelection" class="h-6 px-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-zinc-300 transition">清空</button>
                                <div class="flex-1"></div>
                                <button @click="batchToggleEnabled(true)" class="h-6 px-1.5 bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-600 rounded text-[10px] transition">启用</button>
                                <button @click="batchToggleEnabled(false)" class="h-6 px-1.5 bg-zinc-700 hover:bg-zinc-600 text-white border border-zinc-600 rounded text-[10px] transition">停用</button>
                                <button @click="batchDeleteEntries" class="h-6 px-1.5 bg-rose-600 hover:bg-rose-500 text-white border border-rose-600 rounded text-[10px] transition">删除</button>
                            </div>

                            <div class="flex-1 overflow-y-auto pt-1 px-1 custom-scrollbar" :class="showEditorLogs ? 'pb-40' : 'pb-8'">
                                <div v-for="(entry, index) in filteredWorldbookEntries" :key="entry.uid || index"
                                     :id="'wb-entry-' + ensureUid(entry)"
                                     @click="batchMode ? toggleBatchSelect(entry) : selectEntry(entry)"
                                     class="group relative flex items-center gap-1.5 p-1.5 mb-0.5 rounded cursor-pointer border border-transparent hover:bg-zinc-800/80 transition"
                                     :class="currentEntry === entry ? 'bg-zinc-800 border-emerald-500/50' : ''">

                                    <input v-if="batchMode" type="checkbox" :checked="batchSelected.has(ensureUid(entry))"
                                           @click.stop @change="toggleBatchSelect(entry)"
                                           class="shrink-0 rounded accent-emerald-500">

                                    <button v-else @click.stop="toggleEntryState(entry)" class="shrink-0 w-2 h-2 rounded-full transition"
                                            :title="entry.enabled === false ? '已停用，点击启用' : '已启用，点击停用'"
                                            :class="entry.enabled !== false ? 'bg-emerald-500 shadow-[0_0_4px_#10b981]' : 'bg-zinc-600'"></button>

                                    <div class="flex-1 min-w-0 flex flex-col justify-center">
                                        <span class="text-[11px] font-bold truncate leading-tight" :class="entry.enabled !== false ? 'text-emerald-400' : 'text-zinc-500'"
                                              :title="entry.comment || entry.name || '未命名词条'">
                                            {{ entry.comment || entry.name || '未命名词条' }}
                                        </span>
                                        <span v-if="Array.isArray(entry.key) && entry.key.length" class="text-[9px] text-zinc-500 truncate mt-0.5">🔑 {{ formatKeys(entry.key) }}</span>
                                        <span class="text-[9px] text-amber-500/70 font-mono mt-0.5">⚡ {{ entryTokens(entry) }}</span>
                                    </div>

                                    <div class="hidden group-hover:flex items-center gap-1 absolute right-1 bg-zinc-800/95 backdrop-blur px-1 py-0.5 rounded border border-zinc-700 shadow-sm z-10">
                                        <button @click.stop="moveEntry(entry, -1)" class="text-[10px] hover:text-white" title="上移">↑</button>
                                        <button @click.stop="moveEntry(entry, 1)" class="text-[10px] hover:text-white" title="下移">↓</button>
                                        <button @click.stop="duplicateWorldbookEntry(entry)" class="text-[10px] hover:text-blue-400" title="复制词条">📋</button>
                                        <button @click.stop="deleteWorldbookEntry(entry)" class="text-[10px] hover:text-rose-400" title="删除词条">🗑️</button>
                                    </div>
                                </div>

                                <div v-if="filteredWorldbookEntries.length === 0" class="text-center py-8 text-zinc-500 text-xs">
                                    <p>🔍 没有匹配「{{ entrySearchQuery }}」的词条</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 右：详情编辑（点击左侧词条后显示） -->
                    <div v-if="currentEntry" class="flex-1 pt-4 px-4 overflow-y-auto custom-scrollbar" :class="showEditorLogs ? 'pb-40' : 'pb-8'">
                        <div class="grid grid-cols-2 gap-4 mb-4">
                            <div>
                                <label class="block text-xs font-bold text-zinc-300 mb-1">🔑 主触发词 (Key)</label>
                                <input v-model="primaryKeysStr" placeholder="逗号分隔，例如: sword, magic" class="w-full h-8 bg-zinc-900 border border-zinc-700 rounded px-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500" />
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-zinc-300 mb-1">📝 名称 / 备注 (Comment)</label>
                                <input v-model="currentEntry.comment" placeholder="输入条目名称（大模型不可见，仅作标识）" class="w-full h-8 bg-zinc-900 border border-zinc-700 rounded px-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500" />
                            </div>
                        </div>

                        <div class="p-3 bg-zinc-900/50 border border-zinc-800 rounded-lg mb-4 grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-bold text-zinc-400 mb-1">🛡️ 次要触发词 (Key Secondary)</label>
                                <input v-model="secondaryKeysStr" placeholder="逗号分隔..." class="w-full h-8 bg-zinc-900/50 border border-zinc-700/80 rounded px-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500" />
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-zinc-400 mb-1">⭐ 权重 / 优先级 (Order)</label>
                                <input v-model.number="currentEntry.order" type="number" class="w-full h-8 bg-zinc-900/50 border border-zinc-700/80 rounded px-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500" />
                            </div>
                        </div>

                        <div class="p-3 bg-zinc-900/50 border border-zinc-800 rounded-lg mb-4">
                            <label class="block text-xs text-zinc-400 mb-1">📌 插入位置 (Position)</label>
                            <select v-model.number="currentEntry.position" class="w-full h-8 bg-zinc-900/50 border border-zinc-700/80 rounded px-2 text-xs text-zinc-300 focus:outline-none focus:border-emerald-500">
                                <option :value="0">0 - 顶部 (全局设定)</option>
                                <option :value="1">1 - 用户输入前</option>
                                <option :value="2">2 - AI回复前</option>
                                <option :value="3">3 - 全文本</option>
                                <option :value="4">4 - 系统提示词</option>
                            </select>
                        </div>

                        <div class="flex flex-col min-h-[300px]">
                            <label class="block text-xs font-bold text-emerald-400 mb-1 flex justify-between">
                                <span>📖 词条内容 (Content)</span>
                                <span class="text-zinc-500 font-mono">字数: {{ currentEntry.content?.length || 0 }}</span>
                            </label>
                            <textarea v-model="currentEntry.content" class="w-full flex-1 bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500 custom-scrollbar leading-relaxed min-h-[200px] resize-y" placeholder="在此输入核心设定..."></textarea>
                        </div>
                    </div>

                    <!-- 未选择词条时的占位 -->
                    <div v-else class="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                        <div class="text-center flex flex-col items-center gap-2">
                            <span class="text-3xl opacity-30">📖</span>
                            <p>在左侧选择一个词条进行编辑</p>
                        </div>
                    </div>
                </div>

            </template>
        </div>


        <!-- 📟 全局终端控制台（悬浮于 main 底部） -->
        <div class="absolute bottom-0 left-0 right-0 bg-black/95 border-t border-zinc-800 shadow-[0_-10px_30px_rgba(0,0,0,0.8)] flex flex-col z-30 transition-all duration-300"
             :class="showEditorLogs ? 'h-36' : 'h-7'">

            <div @click="showEditorLogs = !showEditorLogs"
                 class="flex items-center justify-between px-3 py-1 bg-zinc-900/90 border-b border-zinc-800 shrink-0 cursor-pointer hover:bg-zinc-800 transition select-none">
                <div class="flex items-center gap-2">
                    <span class="text-[10px] font-bold tracking-wider" :class="appMode === 'characters' ? 'text-indigo-400' : 'text-amber-400'">
                        TERMINAL LOGS // {{ appMode === 'characters' ? '🎴 角色卡控制器' : '🌍 世界书控制器' }}
                    </span>
                    <span class="text-[9px] text-zinc-500">
                        {{ showEditorLogs ? '▼ 点击折叠面板' : '▲ 点击展开控制台' }}
                    </span>
                </div>

                <div class="flex items-center gap-3">
                    <span class="text-[10px] text-zinc-500 font-mono">Logs: {{ editorLogs.length }}</span>
                    <button v-show="showEditorLogs" @click.stop="editorLogs = []" class="text-[10px] text-zinc-500 hover:text-white transition">
                        清空日志
                    </button>
                </div>
            </div>

            <div v-show="showEditorLogs" class="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] space-y-1 custom-scrollbar">
                <div v-for="(log, i) in editorLogs" :key="i" class="flex gap-2">
                    <span class="text-zinc-600 shrink-0">[{{ log.time }}]</span>
                    <span :class="{
                        'text-emerald-400': log.type === 'success',
                        'text-rose-400': log.type === 'error',
                        'text-amber-400': log.type === 'warning',
                        'text-indigo-300': log.type === 'info'
                    }">{{ log.msg }}</span>
                </div>
                <div v-if="editorLogs.length === 0" class="text-zinc-700 text-center mt-4 italic">
                    系统就绪，等待操作指令...
                </div>
            </div>
        </div>
    </main>

    <!-- ⚙️ 操作下拉菜单：<Teleport> 渲染到 body 顶层，fixed 定位在按钮正下方；外层全屏透明遮罩，点击任意处关闭 -->
    <Teleport to="body">
        <div v-if="isToolbarMenuOpen" class="fixed inset-0 z-[9999]" @click="isToolbarMenuOpen = false">
            <div class="fixed w-48 max-h-[70vh] overflow-y-auto flex flex-col gap-1 p-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg shadow-2xl custom-scrollbar"
                 :style="{ left: toolbarMenuPos.x + 'px', top: toolbarMenuPos.y + 'px' }" @click.stop>
                <button @click="translateCardContent(); isToolbarMenuOpen = false" :disabled="isTranslating" class="tb-btn w-full bg-indigo-600 hover:bg-indigo-500 text-white" title="调用 AI 翻译角色设定/首条消息/场景/对话示例">
                    <span class="ico">🌐</span><span v-if="!isTranslating">一键汉化</span><span v-else class="animate-pulse">翻译中...</span>
                </button>
                <button @click="refactorCardFormat(); isToolbarMenuOpen = false" :disabled="isRefactoring" class="tb-btn w-full bg-emerald-600 hover:bg-emerald-500 text-white" title="将旧格式（W++/JSON）设定重构为高密度 Markdown，大幅降低 Token 占用">
                    <span class="ico">✨</span><span v-if="!isRefactoring">格式升维</span><span v-else class="animate-pulse">重构中...</span>
                </button>
                <button @click="triggerManualSnapshot(); isToolbarMenuOpen = false" class="tb-btn w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white" title="绕过冷却机制，立即将当前卡片状态备份至历史目录">
                    <span class="ico">📸</span>快照
                </button>
                <button @click="replaceCardImage(); isToolbarMenuOpen = false" class="tb-btn w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white" title="选择新立绘替换当前卡片（PNG 卡原地替换；WebP/JSON 卡转为标准 PNG 卡）">
                    <span class="ico">🖼️</span>换卡图
                </button>
                <button @click="saveToLocalDisk(); isToolbarMenuOpen = false" class="tb-btn w-full bg-blue-600 hover:bg-blue-700 text-white">
                    <span class="ico">💾</span>覆盖保存
                </button>
                <button @click="exportPackage(); isToolbarMenuOpen = false" class="tb-btn w-full bg-indigo-600 hover:bg-indigo-700 text-white" title="一键打包卡片、独立世界书与正则脚本">
                    <span class="ico">📦</span>导出
                </button>
                <button @click="deleteCard(); isToolbarMenuOpen = false" class="tb-btn w-full bg-red-600 hover:bg-red-700 text-white">
                    <span class="ico">🗑️</span>删除
                </button>
            </div>
        </div>
    </Teleport>
</template>

<script>
import { inject, ref, computed, watch } from 'vue';
import { estimateTokens } from '../utils/tokenEstimate.js';

export default {
    name: 'EditorPanel',
    setup() {
        const ctx = inject('appCtx');

        // ✅ [工具栏下拉菜单] 操作菜单开关（本地视觉状态，不落盘；菜单 <Teleport to="body"> 渲染到顶层，fixed 定位在按钮下方，永不被遮挡/裁剪）
        const isToolbarMenuOpen = ref(false);
        const toolbarMenuBtn = ref(null);          // ⚙ 按钮 DOM（取定位坐标）
        const toolbarMenuPos = ref({ x: 0, y: 0 }); // 菜单 fixed 坐标
        const toggleToolbarMenu = () => {
            if (isToolbarMenuOpen.value) { isToolbarMenuOpen.value = false; return; }
            const rect = toolbarMenuBtn.value.getBoundingClientRect();
            const PANEL_W = 192; // w-48 = 192px
            let x = rect.right - PANEL_W; // 菜单右对齐按钮
            if (x < 8) x = 8; // 防左溢出屏幕
            toolbarMenuPos.value = { x, y: rect.bottom + 6 }; // 出现在按钮正下方
            isToolbarMenuOpen.value = true;
        };

        // ✅ [批量删除标签] 标签云批量勾选删除模式（本组件本地状态）
        const isBatchDeleteTags = ref(false); // 是否处于批量删除标签模式
        const batchSelectedTags = ref(new Set()); // 批量模式下选中的标签集合

        // ✅ [状态栏预览] 源码视图折叠（超长源码默认折叠，避免一坨压缩 JS 刷屏）
        const statusSourceExpanded = ref(false);
        const SOURCE_PREVIEW_LIMIT = 800; // 超过此长度默认折叠
        const statusSourcePreview = computed(() => {
            const s = (ctx.appliedResult && ctx.appliedResult.value) ? ctx.appliedResult.value : '';
            if (!s) return '';
            if (s.length <= SOURCE_PREVIEW_LIMIT || statusSourceExpanded.value) return s;
            return s.slice(0, SOURCE_PREVIEW_LIMIT) + '\n\n…（已折叠，共 ' + s.length + ' 字符；点击下方「展开全文」查看完整源码）';
        });
        const statusSourceIsLong = computed(() => {
            const s = (ctx.appliedResult && ctx.appliedResult.value) ? ctx.appliedResult.value : '';
            return s.length > SOURCE_PREVIEW_LIMIT;
        });
        const toggleBatchTagSelect = (tag) => {
            const s = new Set(batchSelectedTags.value);
            if (s.has(tag)) s.delete(tag);
            else s.add(tag);
            batchSelectedTags.value = s;
        };
        const selectAllBatchTags = () => {
            batchSelectedTags.value = new Set(ctx.globalAvailableTags?.value || []);
        };
        const exitBatchDeleteTags = () => {
            isBatchDeleteTags.value = false;
            batchSelectedTags.value = new Set();
        };
        const confirmBatchDeleteTags = async () => {
            const tags = Array.from(batchSelectedTags.value);
            if (tags.length === 0) return;
            const count = await ctx.batchRemoveTags(tags);
            if (count > 0) exitBatchDeleteTags();
        };

        // ✅ [世界书编辑器] 左侧词条列表可收起（纯视觉，不影响数据）
        const isWbSidebarCollapsed = ref(false);
        // ✅ [世界书编辑器] 当前选中编辑的词条（列表+详情布局）
        const currentEntry = ref(null);
        // 【修复】切换世界书时清空当前选中词条（防旧书词条残留，详情面板 v-model 误改旧书对象）
        watch(
            () => (ctx.activeWorldbook?.value || null),
            () => { currentEntry.value = null; }
        );
        const selectEntry = (entry) => {
            if (!entry) return;
            currentEntry.value = entry;
            if (isWbSidebarCollapsed.value) isWbSidebarCollapsed.value = false; // 选中时自动展开侧栏
        };
        // ✅ [世界书编辑器] 侧栏列表触发词格式化（只读展示；空则提示）
        const formatKeys = (keys) => {
            if (!keys || keys.length === 0) return '无触发词';
            return Array.isArray(keys) ? keys.join(', ') : String(keys);
        };
        // ✅ [世界书编辑器] 单条词条 Token 估算（触发词 + 次级触发词 + 正文）
        const entryTokens = (entry) => {
            if (!entry) return 0;
            const keyText = Array.isArray(entry.key) ? entry.key.join(' ') : String(entry.key || '');
            const secText = Array.isArray(entry.keysecondary) ? entry.keysecondary.join(' ') : '';
            return estimateTokens([keyText, secText, entry.content || ''].join(' '));
        };
        // ✅ [世界书编辑器] 主触发词 key 逗号分隔双向绑定（原生字段映射，不污染 JSON）
        const primaryKeysStr = computed({
            get() {
                if (!currentEntry.value || !currentEntry.value.key) return '';
                return Array.isArray(currentEntry.value.key) ? currentEntry.value.key.join(', ') : currentEntry.value.key;
            },
            set(val) {
                if (!currentEntry.value) return;
                currentEntry.value.key = val.split(',').map(k => k.trim()).filter(k => k !== '');
            }
        });
        // ✅ [世界书编辑器] 次级触发词 keysecondary 逗号分隔双向绑定
        const secondaryKeysStr = computed({
            get() {
                if (!currentEntry.value || !currentEntry.value.keysecondary) return '';
                return Array.isArray(currentEntry.value.keysecondary) ? currentEntry.value.keysecondary.join(', ') : currentEntry.value.keysecondary;
            },
            set(val) {
                if (!currentEntry.value) return;
                currentEntry.value.keysecondary = val.split(',').map(k => k.trim()).filter(k => k !== '');
            }
        });

        // ⚙️ 预设编辑模式与参数配置
        const presetEditorMode = ref('visual');
        // 预设编辑器内部 Tab：只针对当前 activePreset，不与角色卡 currentTab 混用
        const presetScripts = ref([]);
        const presetRegexScripts = ref([]);
        const resourceKeys = {
            scripts: ['scripts', 'script', 'custom_scripts', 'customScripts'],
            regex: ['regex_scripts', 'regexScripts', 'regex', 'regexes']
        };
        // 酒馆预设的资源并不统一放在顶层：酒馆助手脚本实际存于
        // extensions.tavern_helper.scripts（嵌套对象），旧版误用路径式键名
        // extensions["tavern_helper/scripts"] 永远匹配不到 → 预设脚本读不出来（v1.8.6 修复）。
        // 正则也可能位于 SPreset.RegexBinding.regexes。
        const resourceSource = (data, type) => {
            const extensions = data?.extensions;
            const candidates = type === 'scripts'
                ? [
                    [extensions?.tavern_helper, 'scripts'], // 🔧 修复：嵌套对象，酒馆助手脚本真实位置
                    [extensions, 'tavern_helper/scripts'],
                    [extensions, 'tavern_helper\u002fscripts'],
                    [data, 'scripts'], [data, 'script'],
                    [extensions, 'scripts'], [extensions, 'script'],
                    [data, 'custom_scripts'], [data, 'customScripts']
                ]
                : [
                    [data, 'regex_scripts'], [data, 'regexScripts'],
                    [extensions, 'regex_scripts'], [extensions, 'regexScripts'],
                    [extensions?.SPreset?.RegexBinding, 'regexes'],
                    [data, 'regex'], [data, 'regexes']
                ];
            const found = candidates.find(([container, key]) => container && container[key] !== undefined);
            return found ? { container: found[0], key: found[1] } : { container: data, key: resourceKeys[type][0] };
        };
        const normalizeResourceList = value => {
            if (Array.isArray(value)) return value;
            if (value && typeof value === 'object') return Object.values(value);
            if (typeof value === 'string' && value.trim()) return [{ content: value }];
            return [];
        };
        const refreshPresetResources = data => {
            if (!data || typeof data !== 'object') {
                presetScripts.value = [];
                presetRegexScripts.value = [];
                return;
            }
            const scriptSource = resourceSource(data, 'scripts');
            const regexSource = resourceSource(data, 'regex');
            presetScripts.value = normalizeResourceList(scriptSource.container[scriptSource.key]).map(item =>
                item && typeof item === 'object' ? item : { content: String(item ?? '') });
            presetRegexScripts.value = normalizeResourceList(regexSource.container[regexSource.key]).map(item =>
                item && typeof item === 'object' ? item : { findRegex: String(item ?? ''), replaceString: '' });
        };
        const syncPresetResources = type => {
            const data = ctx.activePreset?.value?.data;
            if (!data) return;
            const source = resourceSource(data, type);
            source.container[source.key] = type === 'scripts' ? presetScripts.value : presetRegexScripts.value;
            presetJsonText.value = JSON.stringify(data, null, 4);
        };
        const addPresetScript = () => {
            presetScripts.value.push({ name: `脚本 ${presetScripts.value.length + 1}`, content: '', enabled: true, type: 'script' });
            syncPresetResources('scripts');
        };
        const removePresetScript = index => { presetScripts.value.splice(index, 1); syncPresetResources('scripts'); };

        // =========================================================
        // ✨ 预设「渲染脚本」识别与预览（v1.8.6 新增）
        //   酒馆助手（tavern_helper）脚本的 content 是向聊天 DOM 注入 UI 的 JS 代码
        //   （悬浮窗/状态栏/面板等），读出来不应只是代码文本 —— 识别为「渲染脚本」
        //   并在脚本工作区提供沙箱 iframe 预览渲染效果（所见即所得）。
        // =========================================================
        const isRenderScript = (script) => {
            const c = String(script?.content || '');
            if (!c) return false;
            // 渲染特征：DOM 注入 / HTML 模板 / 外链加载
            return /\x3C(?:\/?\s*(?:body|div|span|table|iframe|style|link)\b)|innerHTML|insertAdjacentHTML|createElement|document\.write|\.load\(\s*['"]|srcdoc/i.test(c);
        };
        // 每个脚本的预览状态（open 展开 / url 沙箱地址 / error 构建失败信息）
        const presetScriptPreviews = ref({});
        // 🔧 v1.8.6 脚本卡片折叠状态（独立 ref map，不写回预设数据，避免污染 JSON）
        const presetScriptCollapsed = ref({});
        const getScriptPreviewKey = (script, index) => script?.id || `idx_${index}`;
        const togglePresetScriptCollapse = (index) => {
            const script = presetScripts.value[index];
            if (!script) return;
            const key = getScriptPreviewKey(script, index);
            presetScriptCollapsed.value[key] = !presetScriptCollapsed.value[key];
        };
        // 构建沙箱 iframe srcdoc：注入最小兼容环境（$ / jQuery / errorCatched 占位），执行脚本 content
        const buildPresetScriptPreview = (index) => {
            const script = presetScripts.value[index];
            if (!script) return;
            const key = getScriptPreviewKey(script, index);
            const state = presetScriptPreviews.value[key] || (presetScriptPreviews.value[key] = { open: false, url: null, error: null });
            try {
                const content = String(script.content || '');
                if (!content) { state.error = '脚本内容为空，无法预览。'; state.url = null; return; }
                // 🔒 安全：data: URL + iframe sandbox（无 allow-same-origin），脚本运行于隔离环境，无法访问应用
                // ⚠️ 所有 HTML 标签的尖括号用 \x3C 十六进制转义（\x3C → 左尖括号）：源码不含
                //    script 与 style 标签序列，Vue SFC 解析器不会把 script 块内的 HTML 字符串
                //    误当成标签 tokenize（否则报 Invalid end tag）；运行时 \x3C 还原为左尖括号，
                //    HTML 输出完全正常。content 内 script 闭合标签替换为带反斜杠形式防提前终止。
                const html = [
                    '\x3C!DOCTYPE html>\x3Chtml>\x3Chead>\x3Cmeta charset="utf-8">',
                    '\x3Cstyle>html,body{width:100%;height:100%;margin:0;background:#18181b;color:#e4e4e7;font-family:system-ui,sans-serif;overflow:auto}\x3C/style>',
                    '\x3C/head>\x3Cbody>',
                    '\x3Cscript>',
                    "window.errorCatched = (fn) => function(...a){ try { return fn.apply(this, a); } catch (e) { try{console.error('脚本异常:', e);}catch(_){} } };",
                    "window.$ = window.jQuery = (fn) => { const obj = { ready:(cb)=>{try{cb&&cb();}catch(e){}}, on:()=>obj, off:()=>obj, load:()=>obj, css:()=>obj, html:(v)=>v===undefined?null:obj, text:(v)=>v===undefined?'':obj, append:()=>obj, prepend:()=>obj, remove:()=>obj, show:()=>obj, hide:()=>obj, toggle:()=>obj, attr:()=>obj, addClass:()=>obj, removeClass:()=>obj, val:(v)=>v===undefined?'':obj, find:()=>[], each:(cb)=>{try{cb&&cb(0,obj);}catch(e){}} }; if (typeof fn === 'function') { try { fn(); } catch (e) { try{console.error(e);}catch(_){} } } return obj; };",
                    "window.jQuery.ajax = () => ({ done: (cb)=>{try{cb&&cb({});}catch(e){}} , fail: (cb)=>{try{cb&&cb();}catch(e){}} });",
                    '\x3C/script>\x3Cscript>' + content.replace(/<\/script>/gi, '<\\/script>') + '\x3C/script>',
                    '\x3C/body>\x3C/html>'
                ].join('\n');
                state.url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
                state.error = null;
            } catch (e) {
                state.url = null;
                state.error = '渲染预览构建失败: ' + e.message;
            }
        };
        const togglePresetScriptPreview = (index) => {
            const script = presetScripts.value[index];
            if (!script) return;
            const key = getScriptPreviewKey(script, index);
            const state = presetScriptPreviews.value[key] || (presetScriptPreviews.value[key] = { open: false, url: null, error: null });
            state.open = !state.open;
            if (state.open) buildPresetScriptPreview(index);
        };
        const addPresetRegex = () => {
            presetRegexScripts.value.push({ scriptName: `正则 ${presetRegexScripts.value.length + 1}`, findRegex: '', replaceString: '', disabled: false });
            syncPresetResources('regex');
        };
        const removePresetRegex = index => { presetRegexScripts.value.splice(index, 1); syncPresetResources('regex'); };
        const presetAdvancedParams = [
            { key: 'seed', label: '随机种子', type: 'number', step: '1', min: '0', placeholder: '留空表示随机' },
            { key: 'min_p', label: 'Min P', type: 'number', step: '0.01', min: '0', max: '1', placeholder: '例如 0.05' },
            { key: 'repetition_penalty', label: '重复惩罚', type: 'number', step: '0.05', min: '0', max: '3', placeholder: '例如 1.0' },
            { key: 'stop', label: '停止序列', type: 'text', placeholder: '多个值用逗号分隔' }
        ];
        const presetBasicParams = [
            { key: 'temperature', label: 'Temperature', type: 'number', step: '0.1', min: '0', max: '2', placeholder: '例如 1.0' },
            { key: 'top_p', label: 'Top P', type: 'number', step: '0.05', min: '0', max: '1', placeholder: '例如 1.0' },
            { key: 'top_k', label: 'Top K', type: 'number', step: '1', min: '0', max: '200', placeholder: '例如 40' },
            { key: 'max_tokens', label: '最大回复长度', type: 'number', step: '1', min: '1', max: '200000', placeholder: '例如 4096' },
            { key: 'frequency_penalty', label: 'Frequency Penalty', type: 'number', step: '0.1', min: '-2', max: '2', placeholder: '例如 0' },
            { key: 'presence_penalty', label: 'Presence Penalty', type: 'number', step: '0.1', min: '-2', max: '2', placeholder: '例如 0' }
        ];
        const presetPrompts = ref([]);
        const refreshPresetPrompts = (data) => {
            const prompts = data && Array.isArray(data.prompts) ? data.prompts : [];
            presetPrompts.value = prompts.map((prompt, index) => ({
                __editorId: prompt.__editorId || `${Date.now()}-${index}-${Math.random()}`,
                ...prompt,
                name: prompt.name || prompt.identifier || `Prompt ${index + 1}`,
                role: prompt.role || 'system',
                content: prompt.content || '',
                enabled: prompt.enabled !== false,
                expanded: false
            }));
        };
        const allPresetPromptsExpanded = computed(() => presetPrompts.value.length > 0 && presetPrompts.value.every(prompt => prompt.expanded));
        const togglePresetPrompt = (index) => {
            const prompt = presetPrompts.value[index];
            if (prompt) prompt.expanded = !prompt.expanded;
        };
        const toggleAllPresetPrompts = () => {
            const expanded = !allPresetPromptsExpanded.value;
            presetPrompts.value.forEach(prompt => { prompt.expanded = expanded; });
        };
        const syncPresetJson = () => {
            if (!ctx.activePreset?.value?.data) return;
            ctx.activePreset.value.data.prompts = presetPrompts.value.map(({ __editorId, expanded, ...prompt }) => prompt);
            presetJsonText.value = JSON.stringify(ctx.activePreset.value.data, null, 4);
        };
        const addPresetPrompt = () => {
            presetPrompts.value.push({ __editorId: `${Date.now()}-${Math.random()}`, name: `Prompt ${presetPrompts.value.length + 1}`, role: 'system', identifier: '', content: '', enabled: true, expanded: true });
            syncPresetJson();
        };
        const removePresetPrompt = (index) => {
            presetPrompts.value.splice(index, 1);
            syncPresetJson();
        };
        const movePresetPrompt = (index, offset) => {
            const target = index + offset;
            if (target < 0 || target >= presetPrompts.value.length) return;
            const [prompt] = presetPrompts.value.splice(index, 1);
            presetPrompts.value.splice(target, 0, prompt);
            syncPresetJson();
        };
        const promptDragIndex = ref(null);
        const startPromptDrag = (index, event) => {
            promptDragIndex.value = index;
            if (event?.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
            }
        };
        const dropPrompt = (targetIndex, event) => {
            const sourceIndex = Number(event?.dataTransfer?.getData('text/plain'));
            if (!Number.isInteger(sourceIndex) || sourceIndex === targetIndex) return;
            const [prompt] = presetPrompts.value.splice(sourceIndex, 1);
            presetPrompts.value.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, prompt);
            syncPresetJson();
        };
        const endPromptDrag = () => { promptDragIndex.value = null; };
        const getPresetParam = (key) => {
            const data = ctx.activePreset?.value?.data;
            return data && data[key] !== undefined && data[key] !== null ? data[key] : '';
        };
        const updatePresetParam = (key, value, type) => {
            if (!ctx.activePreset?.value?.data || value === '') return;
            ctx.activePreset.value.data[key] = type === 'number' ? Number(value) : value;
            presetJsonText.value = JSON.stringify(ctx.activePreset.value.data, null, 4);
        };

        // ⚙️ 预设 JSON 编辑器：文本编辑便于兼容不同酒馆预设格式
        const presetJsonText = ref('');
        watch(() => ctx.activePreset && ctx.activePreset.value, (preset) => {
            presetJsonText.value = preset ? JSON.stringify(preset.data || {}, null, 4) : '';
            refreshPresetPrompts(preset && preset.data);
            refreshPresetResources(preset && preset.data);
        }, { immediate: true });
        const applyPresetJson = () => {
            if (!ctx.activePreset || !ctx.activePreset.value) return;
            try {
                const parsed = JSON.parse(presetJsonText.value);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('预设必须是 JSON 对象');
                ctx.activePreset.value.data = parsed;
                refreshPresetPrompts(parsed);
                refreshPresetResources(parsed);
            } catch (err) {
                ctx.nativeAlert(`预设 JSON 格式错误: ${err.message}`, 'error');
                presetJsonText.value = JSON.stringify(ctx.activePreset.value.data || {}, null, 4);
            }
        };
        return {
            // ✅ [状态栏预览] 模板库合并：📚 渲染模板 / 📜 世界书指令 双选项卡 + 整体折叠
            statusLibTab: ref('render'),
            statusLibCollapsed: ref(false),
            isWbSidebarCollapsed,
            isToolbarMenuOpen,
            toolbarMenuBtn,
            toolbarMenuPos,
            toggleToolbarMenu,
            // ✅ [状态栏预览] 源码折叠
            statusSourceExpanded,
            statusSourcePreview,
            statusSourceIsLong,
            currentEntry,
            selectEntry,
            formatKeys,
            primaryKeysStr,
            secondaryKeysStr,
            presetEditorMode,
            presetScripts,
            presetRegexScripts,
            addPresetScript,
            removePresetScript,
            addPresetRegex,
            removePresetRegex,
            isRenderScript,
            presetScriptPreviews,
            presetScriptCollapsed,
            getScriptPreviewKey,
            togglePresetScriptPreview,
            buildPresetScriptPreview,
            togglePresetScriptCollapse,
            presetBasicParams,
            presetAdvancedParams,
            getPresetParam,
            updatePresetParam,
            presetPrompts,
            allPresetPromptsExpanded,
            togglePresetPrompt,
            toggleAllPresetPrompts,
            addPresetPrompt,
            removePresetPrompt,
            movePresetPrompt,
            promptDragIndex,
            startPromptDrag,
            dropPrompt,
            endPromptDrag,
            syncPresetJson,
            presetJsonText,
            applyPresetJson,
            activePreset: ctx.activePreset,
            saveActivePreset: ctx.saveActivePreset,
            renamePreset: ctx.renamePreset,
            openPresetInFolder: ctx.openPresetInFolder,
            appMode: ctx.appMode,
            cardData: ctx.cardData,
            imgUrl: ctx.imgUrl,
            viewOptions: ctx.viewOptions,
            openImageModal: ctx.openImageModal,
            safeData: ctx.safeData,
            updateName: ctx.updateName,
            cardTokenStats: ctx.cardTokenStats,
            translateCardContent: ctx.translateCardContent,
            isTranslating: ctx.isTranslating,
            refactorCardFormat: ctx.refactorCardFormat,
            isRefactoring: ctx.isRefactoring,
            saveToLocalDisk: ctx.saveToLocalDisk,
            triggerManualSnapshot: ctx.triggerManualSnapshot,
            replaceCardImage: ctx.replaceCardImage,
            exportPackage: ctx.exportPackage,
            deleteCard: ctx.deleteCard,
            reset: ctx.reset,
            currentCardCategory: ctx.currentCardCategory,
            handleCardCategoryChange: ctx.handleCardCategoryChange,
            allCategories: ctx.allCategories,
            getCategoryDisplayName: ctx.getCategoryDisplayName,
            addNewCategory: ctx.addNewCategory,
            toggleTagLangMode: ctx.toggleTagLangMode,
            tagLangMode: ctx.tagLangMode,
            activeCardTags: ctx.activeCardTags,
            displayTagText: ctx.displayTagText,
            removeSingleTag: ctx.removeSingleTag,
            addSingleTag: ctx.addSingleTag,
            isEditingSystemTags: ctx.isEditingSystemTags,
            globalAvailableTags: ctx.globalAvailableTags,
            newGlobalTagInput: ctx.newGlobalTagInput,
            addTagToGlobalPool: ctx.addTagToGlobalPool,
            removeTagFromGlobalPool: ctx.removeTagFromGlobalPool,
            clearAllTagsFromPool: ctx.clearAllTagsFromPool,
            addGlobalTag: ctx.addGlobalTag,
            // ✅ [批量删除标签] 标签云批量勾选删除
            isBatchDeleteTags,
            batchSelectedTags,
            toggleBatchTagSelect,
            selectAllBatchTags,
            exitBatchDeleteTags,
            confirmBatchDeleteTags,
            tabs: ctx.tabs,
            currentTab: ctx.currentTab,
            openTextModal: ctx.openTextModal,
            refreshCardData: ctx.refreshCardData,
            worldbookEntries: ctx.worldbookEntries,
            getEntryUid: ctx.getEntryUid,
            toggleWorldbookEntry: ctx.toggleWorldbookEntry,
            worldbookExpanded: ctx.worldbookExpanded,
            expandAllWorldbook: ctx.expandAllWorldbook,
            collapseAllWorldbook: ctx.collapseAllWorldbook,
            getKeysString: ctx.getKeysString,
            updateEntryKeys: ctx.updateEntryKeys,
            // 🎛️ 角色卡内嵌世界书细化操作（词条增删/克隆/排序/搜索/标签化触发词）
            characterWorldbookSearchQuery: ctx.characterWorldbookSearchQuery,
            filteredCharacterWorldbookEntries: ctx.filteredCharacterWorldbookEntries,
            addCharacterWorldbookEntry: ctx.addCharacterWorldbookEntry,
            deleteCharacterWorldbookEntry: ctx.deleteCharacterWorldbookEntry,
            duplicateCharacterWorldbookEntry: ctx.duplicateCharacterWorldbookEntry,
            moveCharacterWorldbookEntry: ctx.moveCharacterWorldbookEntry,
            addEntryKey: ctx.addEntryKey,
            removeEntryKey: ctx.removeEntryKey,
            handleEntryKeyInput: ctx.handleEntryKeyInput,
            updateEntryComment: ctx.updateEntryComment,
            // ✅ [紧凑化] 点击启用圆点切换词条启用/停用（缺失 enabled 视为启用，首次点击=停用）
            toggleEntryState: (entry) => {
                if (!entry) return;
                if (entry.enabled === undefined) entry.enabled = false;
                else entry.enabled = !entry.enabled;
            },
            regexScripts: ctx.regexScripts,
            addRegexScript: ctx.addRegexScript,
            getRegexUid: ctx.getRegexUid,
            syncRegexScriptField: ctx.syncRegexScriptField,
            getRegexPlacement: ctx.getRegexPlacement,
            deleteRegexScript: ctx.deleteRegexScript,
            // 📊 渲染预览器（美化/状态栏）
            statusbarInput: ctx.statusbarInput,
            statusbarViewMode: ctx.statusbarViewMode,
            resetStatusbarDemo: ctx.resetStatusbarDemo,
            statusbarTemplateMeta: ctx.statusbarTemplateMeta,
            statusbarPromptMeta: ctx.statusbarPromptMeta,
            statusbarTemplates: ctx.statusbarTemplates,
            expandedTemplateUid: ctx.expandedTemplateUid,
            toggleTemplateCard: ctx.toggleTemplateCard,
            showStatusDataPanel: ctx.showStatusDataPanel,
            statusDataCandidates: ctx.statusDataCandidates,
            importStatusData: ctx.importStatusData,
            importAllStatusData: ctx.importAllStatusData,
            renderableScripts: ctx.renderableScripts,
            toggleStatusbarScript: ctx.toggleStatusbarScript,
            isScriptEnabled: ctx.isScriptEnabled,
            appliedResult: ctx.appliedResult,
            previewHtml: ctx.previewHtml,
            loaderUrls: ctx.loaderUrls,
            injectStatusbarTemplate: ctx.injectStatusbarTemplate,
            injectStatusbarPrompt: ctx.injectStatusbarPrompt,
            apiEndpoint: ctx.apiEndpoint,
            apiKey: ctx.apiKey,
            apiModel: ctx.apiModel,
            availableModels: ctx.availableModels,
            isFetchingModels: ctx.isFetchingModels,
            fetchAvailableModels: ctx.fetchAvailableModels,
            fetchModelStatus: ctx.fetchModelStatus,
            isChatRenderMode: ctx.isChatRenderMode,
            clearChat: ctx.clearChat,
            chatContainer: ctx.chatContainer,
            chatHistory: ctx.chatHistory,
            renderHTML: ctx.renderHTML,
            renderSafeHTML: ctx.renderSafeHTML,
            cleanMarkdownFences: ctx.cleanMarkdownFences,
            isChatting: ctx.isChatting,
            chatInput: ctx.chatInput,
            sendMessage: ctx.sendMessage,
            formattedJson: ctx.formattedJson,
            activeWorldbook: ctx.activeWorldbook,
            entrySearchQuery: ctx.entrySearchQuery,
            entryFilterState: ctx.entryFilterState,
            entrySortBy: ctx.entrySortBy,
            batchMode: ctx.entryBatchMode,
            batchSelected: ctx.batchSelected,
            toggleBatchMode: ctx.toggleEntryBatchMode,
            toggleBatchSelect: ctx.toggleBatchSelect,
            selectAllEntries: ctx.selectAllEntries,
            clearBatchSelection: ctx.clearBatchSelection,
            batchToggleEnabled: ctx.batchToggleEnabled,
            batchDeleteEntries: ctx.batchDeleteEntries,
            moveEntry: ctx.moveEntry,
            entryHealthReport: ctx.entryHealthReport,
            runEntryHealthCheck: ctx.runEntryHealthCheck,
            ensureUid: ctx.ensureUid,
            entryTokens,
            extractWorldbookFromCard: ctx.extractWorldbookFromCard,
            openCardWbImportModal: ctx.openCardWbImportModal,
            openWbSnapshots: ctx.openWbSnapshots,
            openWbGraphModal: ctx.openWbGraphModal,
            openWbImportModal: ctx.openWbImportModal,
            exportFilteredWorldbook: ctx.exportFilteredWorldbook,
            exportActiveWorldbook: ctx.exportActiveWorldbook,
            addWorldbookEntry: ctx.addWorldbookEntry,
            saveActiveWorldbook: ctx.saveActiveWorldbook,
            filteredWorldbookEntries: ctx.filteredWorldbookEntries,
            duplicateWorldbookEntry: ctx.duplicateWorldbookEntry,
            deleteWorldbookEntry: ctx.deleteWorldbookEntry,
            showEditorLogs: ctx.showEditorLogs,
            editorLogs: ctx.editorLogs
        };
    }
};
</script>

<style scoped>
/* ================= 统一工具栏按钮外壳 =================
   所有操作按钮：同高 / 同最小宽 / 同圆角 / 同边框 / 同字体 / 同图标尺寸，仅颜色不同。 */
.tb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;            /* 统一高度 */
    min-width: 84px;         /* 统一最小宽度（文字居中，短按钮也同宽） */
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    user-select: none;
    cursor: pointer;
    transition: all 0.15s ease;
}
.tb-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
}
.tb-btn .ico {
    font-size: 13px;         /* 统一图标尺寸 */
    line-height: 1;
}
</style>
