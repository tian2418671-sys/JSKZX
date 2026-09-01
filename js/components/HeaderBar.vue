<!--
  HeaderBar 顶部菜单栏 + 紧凑工具栏（子组件）
  ⚠️ 所有状态/方法经 provide/inject 从 App.vue 共享（inject('appCtx') 后按名解构，
      ref 解构后由模板顶层自动解包；importFileInput 模板 ref 绑定会写回父级 ref，
      保证父级 importCards() 仍可触发本组件内隐藏文件输入）
-->
<template>
    <!-- ================= [ 顶部菜单栏 (Top Menu Bar) ] ================= -->
    <header class="h-12 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-4 shrink-0 shadow-sm z-30 select-none">
        <!-- 左侧：Logo 与主菜单项 -->
        <div class="flex items-center gap-6">
            <div class="font-bold text-zinc-100 text-base tracking-wide flex items-center gap-2 cursor-pointer">
                <span class="text-xl drop-shadow-md">🌌</span>
                <span>角色卡管理中心</span>
            </div>

            <!-- 顶部下拉菜单系统 -->
            <nav class="flex items-center gap-1 text-xs text-zinc-300 border-b border-zinc-800 bg-zinc-900/90 px-3 py-1.5 shrink-0 select-none z-30">
                <!-- 隐藏文件输入：供【文件→导入角色卡】使用 -->
                <input ref="importFileInput" type="file" accept=".png,.webp,.jpg,.jpeg,.json" multiple class="hidden" @change="handleImportFiles">

                <div class="relative group">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition">文件(F)</button>
                    <div class="hidden group-hover:flex flex-col absolute top-full left-0 min-w-[210px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <button @click="selectFixedDirectory" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between">📁 打开角色库目录... <span>Ctrl+O</span></button>
                        <button @click="loadWorldbooks" class="px-3 py-1.5 text-left hover:bg-amber-600 hover:text-white flex justify-between">🌍 打开世界书目录...</button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="importCards" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between">➕ 导入角色卡 <span>Ctrl+I</span></button>
                        <button @click="downloadCardFromUrl" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between">🌐 从链接导入角色卡...</button>
                        <button @click="saveCurrentAsset" :disabled="!cardData && !activeWorldbook" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed">💾 物理保存修改 <span>Ctrl+S</span></button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="batchExportSelected" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">📦 导出选中卡片...</button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="openBakFolder" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">⏱️ 查看历史快照 (.bak)</button>
                        <button @click="openTrashFolder" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">🗑️ 查看回收站 (.trash)</button>
                        <button @click="openGlobalTrash" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">🗑️ 打开全局回收站 (jsTavern_Trash)</button>
                    </div>
                </div>

                <div class="relative group">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition">编辑(E)</button>
                    <div class="hidden group-hover:flex flex-col absolute top-full left-0 min-w-[170px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <button @click="isMultiSelectMode = !isMultiSelectMode" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between">
                            ☑️ 批量选择模式 <span v-if="isMultiSelectMode">✓</span>
                        </button>
                        <button @click="selectAllCards" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">全选所有卡片</button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="openAITagModal" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">🏷️ AI 智能批量打标</button>
                        <button @click="batchChangeCategoryModal" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">📂 批量修改分类分组</button>
                        <button @click="cleanGlobalTagsPrompt" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">🧹 清理无效全局标签</button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="startSmartDedupe" class="px-3 py-1.5 text-left hover:bg-amber-600 hover:text-white flex items-center justify-between text-amber-400">
                            <span>🔍 同名查重与版本清理（{{ dedupeTargetLabel }}）...</span>
                        </button>
                        <button @click="startContentDedupeScan" class="px-3 py-1.5 text-left hover:bg-purple-600 hover:text-white flex items-center justify-between text-purple-400">
                            <span>🧬 版本查重：跨名称识别相似内容（{{ dedupeTargetLabel }}）...</span>
                        </button>
                    </div>
                </div>

                <div class="relative group">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-emerald-400 transition font-bold">🚀 推送(P)</button>
                    <div class="hidden group-hover:flex flex-col absolute top-full left-0 min-w-[240px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <div class="px-3 py-1.5 text-[10px] text-zinc-500 font-bold border-b border-zinc-700/50 mb-1">选择目标并推送勾选的卡片</div>
                        <button @click="showPushModal = true" class="px-3 py-1.5 text-left hover:bg-emerald-600 hover:text-white font-medium">🚀 推送选中卡片...</button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <div class="px-3 py-1.5 flex items-center justify-between gap-2">
                            <span class="text-zinc-400">🎯 当前目标</span>
                            <span class="px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap"
                                  :class="appSettings.pushTargetMode === 'custom' ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'">
                                {{ currentPushTargetName }}
                            </span>
                        </div>
                        <div class="px-3 pb-1.5 text-[10px] text-zinc-500 truncate" :title="currentPushTargetHint">{{ currentPushTargetHint }}</div>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="addCustomPushTarget" class="px-3 py-1.5 text-left hover:bg-emerald-600 hover:text-white">🗂️ 新增卡库目标...</button>
                    </div>
                </div>

                <div class="relative group">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition">窗口(W)</button>
                    <div class="hidden group-hover:flex flex-col absolute top-full left-0 min-w-[220px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <button @click="viewOptions.showSidebar = !viewOptions.showSidebar" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>📁 侧边栏 (角色卡列表)</span> <span v-if="viewOptions.showSidebar" class="text-indigo-400 font-bold">✓</span>
                        </button>
                        <button @click="viewOptions.showToolbar = !viewOptions.showToolbar" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>🛠️ 快捷工具栏</span> <span v-if="viewOptions.showToolbar" class="text-indigo-400 font-bold">✓</span>
                        </button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="viewOptions.showAvatarPreview = !viewOptions.showAvatarPreview" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>🖼️ 高清大立绘面板</span> <span v-if="viewOptions.showAvatarPreview" class="text-indigo-400 font-bold">✓</span>
                        </button>
                        <button @click="viewOptions.showTokenStats = !viewOptions.showTokenStats" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>📊 Token 分析看板</span> <span v-if="viewOptions.showTokenStats" class="text-indigo-400 font-bold">✓</span>
                        </button>
                        <button @click="viewOptions.showWorldbook = !viewOptions.showWorldbook" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>🌍 世界书 Lorebook 区域</span> <span v-if="viewOptions.showWorldbook" class="text-indigo-400 font-bold">✓</span>
                        </button>
                        <button @click="viewOptions.showRegex = !viewOptions.showRegex" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>⚡ 正则脚本对照区</span> <span v-if="viewOptions.showRegex" class="text-indigo-400 font-bold">✓</span>
                        </button>
                        <button @click="viewOptions.showRawJson = !viewOptions.showRawJson" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex justify-between items-center">
                            <span>📄 Raw JSON 代码区</span> <span v-if="viewOptions.showRawJson" class="text-indigo-400 font-bold">✓</span>
                        </button>
                    </div>
                </div>

                <div class="relative group">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition">设置(S)</button>
                    <div class="hidden group-hover:flex flex-col absolute top-full left-0 min-w-[230px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <button @click="showApiModal = true" class="px-3 py-2 text-left hover:bg-indigo-600 hover:text-white font-medium flex items-center justify-between border-b border-zinc-700/50">
                            <span>⚡ API 引擎与模型设置...</span>
                            <span class="text-[10px] text-indigo-300">配置</span>
                        </button>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <span class="block text-zinc-400 mb-1.5">🎨 界面主题风格</span>
                            <div class="grid grid-cols-3 gap-1">
                                <button @click="setTheme('dark')" :class="theme === 'dark' ? 'border-indigo-500 font-bold' : ''" class="px-1.5 py-1 bg-zinc-900 border text-[10px] rounded text-zinc-200">暗夜极客</button>
                                <button @click="setTheme('slate')" :class="theme === 'slate' ? 'border-sky-500 font-bold' : ''" class="px-1.5 py-1 bg-slate-800 border text-[10px] rounded text-slate-200">雅致青灰</button>
                                <button @click="setTheme('light')" :class="theme === 'light' ? 'border-amber-500 font-bold' : ''" class="px-1.5 py-1 bg-zinc-100 border text-[10px] rounded text-zinc-800">明亮白昼</button>
                            </div>
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-300">🧹 导入时忽略卡片自带标签</span>
                                <button @click="sanitizeImportedTags = !sanitizeImportedTags"
                                        :class="sanitizeImportedTags ? 'bg-indigo-600' : 'bg-zinc-700'"
                                        class="w-9 h-5 rounded-full relative transition-colors shrink-0">
                                    <span :class="sanitizeImportedTags ? 'translate-x-4' : 'translate-x-0'"
                                          class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"></span>
                                </button>
                            </div>
                            <span class="block text-[10px] text-zinc-500 mt-1">开启后，新导入的卡片不采用其自带的杂乱标签，防止污染全局标签池</span>
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <div class="flex items-center justify-between mb-1">
                                <span class="text-zinc-300">📸 历史快照自动备份</span>
                                <button @click="snapshotConfig.enabled = !snapshotConfig.enabled"
                                        :class="snapshotConfig.enabled ? 'bg-emerald-600' : 'bg-zinc-700'"
                                        class="w-9 h-5 rounded-full relative transition-colors shrink-0">
                                    <span :class="snapshotConfig.enabled ? 'translate-x-4' : 'translate-x-0'"
                                          class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"></span>
                                </button>
                            </div>
                            <div v-if="snapshotConfig.enabled" class="flex gap-2 mt-1">
                                <div class="flex-1 min-w-0">
                                    <label class="block text-[10px] text-zinc-400 mb-0.5">冷却间隔</label>
                                    <select v-model.number="snapshotConfig.intervalMinutes" class="w-full h-6 bg-zinc-800/80 border border-zinc-700/60 rounded px-1 text-[10px] text-zinc-200 focus:outline-none focus:border-emerald-500">
                                        <option :value="1">1 分钟</option>
                                        <option :value="5">5 分钟</option>
                                        <option :value="15">15 分钟</option>
                                        <option :value="30">30 分钟</option>
                                        <option :value="60">1 小时</option>
                                    </select>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <label class="block text-[10px] text-zinc-400 mb-0.5">最大保留</label>
                                    <select v-model.number="snapshotConfig.maxSnapshots" class="w-full h-6 bg-zinc-800/80 border border-zinc-700/60 rounded px-1 text-[10px] text-zinc-200 focus:outline-none focus:border-emerald-500">
                                        <option :value="3">3 份</option>
                                        <option :value="5">5 份</option>
                                        <option :value="10">10 份</option>
                                        <option :value="20">20 份</option>
                                        <option :value="50">50 份</option>
                                    </select>
                                </div>
                            </div>
                            <span v-else class="block text-[10px] text-amber-500/80 mt-1">自动快照已关闭，可在卡片工具栏手动创建快照</span>
                            <button @click="cleanAllSnapshots" class="mt-2 w-full px-2 py-1.5 bg-rose-600/80 hover:bg-rose-500 text-white text-[11px] font-medium rounded transition" title="删除库目录下所有 .bak_history 快照文件夹，释放硬盘空间">
                                🧹 一键清理全部历史快照
                            </button>
                            <button @click="cleanOrphanSnapshots" class="mt-1.5 w-full px-2 py-1.5 bg-amber-600/80 hover:bg-amber-500 text-white text-[11px] font-medium rounded transition" title="仅删除「对应卡片已被删除」的孤儿快照目录，仍有卡片存活的快照会保留">
                                🗑️ 清理孤儿快照（已删卡残留）
                            </button>
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <div class="flex items-center justify-between text-zinc-300 mb-1">
                                <span>🖼️ 界面 UI 字号</span>
                                <span class="text-indigo-400 font-mono font-bold">{{ uiFontSizeDraft }}px</span>
                            </div>
                            <input type="range" v-model.number="uiFontSizeDraft" min="10" max="28" step="1" @change="commitUiFontSize" class="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500">
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <div class="flex items-center justify-between text-zinc-300 mb-1">
                                <span>📝 工作区编辑字号</span>
                                <span class="text-amber-400 font-mono font-bold">{{ fontSizeDraft }}px</span>
                            </div>
                            <input type="range" v-model.number="fontSizeDraft" min="10" max="36" step="1" @change="commitFontSize" class="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-amber-500">
                        </div>
                        <button @click="resetPersonalizationSettings" class="px-3 py-1.5 text-left hover:bg-zinc-700 text-zinc-300 mt-1">🎨 重置界面外观与字号</button>
                        <button @click="resetApiSettings" class="px-3 py-1.5 text-left hover:bg-rose-600 hover:text-white text-rose-400">🔄 重置 API 接口参数</button>
                        <div class="h-px bg-zinc-700/50 my-1 mx-2"></div>
                        <button @click="checkForUpdatesManual" class="px-3 py-1.5 text-left hover:bg-emerald-600 hover:text-white flex items-center justify-between text-emerald-400 font-bold transition">
                            <span>🔄 检查应用更新...</span>
                        </button>
                    </div>
                </div>

                <div class="relative group">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-amber-400 transition font-bold">🧪 实验与工具</button>
                    <div class="hidden group-hover:flex flex-col absolute top-full left-0 min-w-[210px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <div class="px-3 py-1.5 text-xs text-zinc-500 font-bold border-b border-zinc-700/50 mb-1">本地资产检索 (I/O)</div>
                        <button @click="showDiskScanModal = true" class="px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white">🛰️ 全盘打捞卡片</button>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <button @click="openChatTab" class="px-3 py-1.5 text-left hover:bg-amber-600 hover:text-white font-medium">💬 本地 AI 对话测卡</button>
                    </div>
                </div>
            </nav>
        </div>

    </header>

    <!-- ================= [ 顶部紧凑工具栏（可由 窗口(W) 菜单收起）] ================= -->
    <header v-if="viewOptions.showToolbar" class="h-10 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-3 shrink-0 shadow-sm z-10">
        <div class="flex items-center gap-2 overflow-x-auto custom-scrollbar-x">
            <span class="font-bold text-zinc-100 flex items-center gap-2 whitespace-nowrap shrink-0">
                <svg class="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd"/></svg>
                SillyTavern Core
            </span>
            <div class="h-4 w-px bg-zinc-700 shrink-0"></div>
            <button @click="selectFixedDirectory" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0">📂 打开本地库</button>
            <button @click="downloadCardFromUrl" title="从 URL 直链下载导入角色卡（Discord/GitHub 等 CDN）" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0">🌐 链接导入</button>
            <button @click="openGraphSmart" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0" :title="appMode === 'worldbooks' ? '生成当前世界书的词条关联图谱' : '生成全库角色关系图谱'">
                {{ appMode === 'worldbooks' ? '🌍' : '🌌' }} 关系图谱
            </button>
            <button @click="showGlobalAssetModal = true" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0" title="查看全库收集的世界书与正则脚本">
                📚 全局资产库
            </button>
            <label class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition cursor-pointer whitespace-nowrap shrink-0">
                📥 恢复配置 <input type="file" class="hidden" accept=".json" @change="importLibraryDB">
            </label>
            <button @click="toggleTheme" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0" title="循环切换三套主题 (暗夜/青灰/白昼)">
                {{ theme === 'dark' ? '🌙 暗夜' : (theme === 'slate' ? '🌊 青灰' : '☀️ 白昼') }}
            </button>
        </div>

        <div class="flex items-center gap-3 shrink-0">
            <span class="text-xs text-zinc-500 whitespace-nowrap">总计: {{ library.length }} 张卡片</span>
            <button @click="exportLibraryDB" class="flex items-center gap-1 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition whitespace-nowrap shrink-0">备份配置</button>
        </div>
    </header>
</template>

<script>
import { inject, computed, ref, watch } from 'vue';

export default {
    name: 'HeaderBar',
    setup() {
        const ctx = inject('appCtx');
        // 🎯 智能查重目标标签：随当前视图（角色卡/世界书/预设）动态变化
        const dedupeTargetLabel = computed(() => {
            if (ctx.appMode.value === 'worldbooks') return '世界书';
            if (ctx.appMode.value === 'presets') return '预设';
            return '角色卡';
        });

        // 🔧 字号滑块性能修复：滑块绑定本地草稿值（拖动只更新旁边数字，零全局副作用），
        //    松手(@change)才提交到全局 appSettings——避免拖动期间每帧触发全局 CSS 变量
        //    变更 + localStorage 写入 + 全页面 reflow/repaint 导致的卡顿。
        const uiFontSizeDraft = ref(ctx.appSettings.value.uiFontSize ?? 13);
        const fontSizeDraft = ref(ctx.appSettings.value.fontSize ?? 14);
        // 外部变更（如「重置外观与字号」按钮）时同步草稿值
        watch(() => [ctx.appSettings.value.uiFontSize, ctx.appSettings.value.fontSize], ([u, f]) => {
            uiFontSizeDraft.value = u;
            fontSizeDraft.value = f;
        });
        // 松手一次性提交 → 全局字号生效 + 持久化各只触发一次
        const commitUiFontSize = () => { ctx.appSettings.value.uiFontSize = uiFontSizeDraft.value; };
        const commitFontSize = () => { ctx.appSettings.value.fontSize = fontSizeDraft.value; };
        return {
            importFileInput: ctx.importFileInput,
            handleImportFiles: ctx.handleImportFiles,
            selectFixedDirectory: ctx.selectFixedDirectory,
            loadWorldbooks: ctx.loadWorldbooks,
            importCards: ctx.importCards,
            downloadCardFromUrl: ctx.downloadCardFromUrl,
            saveCurrentAsset: ctx.saveCurrentAsset,
            cardData: ctx.cardData,
            activeWorldbook: ctx.activeWorldbook,
            batchExportSelected: ctx.batchExportSelected,
            openBakFolder: ctx.openBakFolder,
            openTrashFolder: ctx.openTrashFolder,
            openGlobalTrash: ctx.openGlobalTrash,
            isMultiSelectMode: ctx.isMultiSelectMode,
            selectAllCards: ctx.selectAllCards,
            openAITagModal: ctx.openAITagModal,
            batchChangeCategoryModal: ctx.batchChangeCategoryModal,
            cleanGlobalTagsPrompt: ctx.cleanGlobalTagsPrompt,
            startSmartDedupe: ctx.startSmartDedupe,
            startContentDedupeScan: ctx.startContentDedupeScan,
            dedupeTargetLabel,
            viewOptions: ctx.viewOptions,
            sanitizeImportedTags: ctx.sanitizeImportedTags,
            snapshotConfig: ctx.snapshotConfig,
            cleanAllSnapshots: ctx.cleanAllSnapshots,
            cleanOrphanSnapshots: ctx.cleanOrphanSnapshots,
            showApiModal: ctx.showApiModal,
            setTheme: ctx.setTheme,
            theme: ctx.theme,
            appSettings: ctx.appSettings,
            uiFontSizeDraft,
            fontSizeDraft,
            commitUiFontSize,
            commitFontSize,
            resetPersonalizationSettings: ctx.resetPersonalizationSettings,
            resetApiSettings: ctx.resetApiSettings,
            checkForUpdatesManual: ctx.checkForUpdatesManual,
            showDiskScanModal: ctx.showDiskScanModal,
            openGraphSmart: ctx.openGraphSmart,
            appMode: ctx.appMode,
            openChatTab: ctx.openChatTab,
            showPushModal: ctx.showPushModal,
            currentPushTargetName: ctx.currentPushTargetName,
            currentPushTargetHint: ctx.currentPushTargetHint,
            addCustomPushTarget: ctx.addCustomPushTarget,
            showGlobalAssetModal: ctx.showGlobalAssetModal,
            importLibraryDB: ctx.importLibraryDB,
            exportLibraryDB: ctx.exportLibraryDB,
            toggleTheme: ctx.toggleTheme,
            library: ctx.library
        };
    }
};
</script>
