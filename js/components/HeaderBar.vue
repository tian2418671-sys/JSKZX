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

                <div class="relative" @mouseenter="setMenu('file')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition" @click="setMenu('file')">文件(F)</button>
                    <div :class="menuOpen === 'file' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[210px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <!-- 🆕 P2：命令由注册表渲染（定义见 js/composables/useCommands.js）—— 位置/样式/顺序与改动前一致 -->
                        <template v-for="(group, gi) in commandsByMenu.file || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <div v-if="group.sectionTitle" class="px-3 py-1 text-[10px] font-bold text-zinc-500">{{ group.sectionTitle }}</div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                        <!-- ⏳ P2-2：旧位置占位（一个版本后移除）—— 避免改版后找不到入口 -->
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <div class="px-3 py-1.5 text-[10px] text-zinc-500 leading-relaxed">
                            ⏱️ 历史快照 / 🗑️ 回收站 已移到「🔧 维护」菜单
                        </div>
                    </div>
                </div>

                <!-- 🏷️ 标签(T)：标签 / 打标 / 批量标签类命令的集合入口 -->
                <div class="relative" @mouseenter="setMenu('tags')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-emerald-300 transition font-bold" @click="setMenu('tags')">🏷️ 标签(T)</button>
                    <div :class="menuOpen === 'tags' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[250px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.tags || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <div v-if="group.sectionTitle" class="px-3 py-1 text-[10px] font-bold text-zinc-500">{{ group.sectionTitle }}</div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <div class="px-3 py-1.5 text-[10px] text-zinc-500 leading-relaxed">☑️ 选择 / 🏷️ 打标 已从「编辑」菜单并入本菜单；📁 分组相关命令已移至「📁 分组」菜单（2026-09-20）</div>
                    </div>
                </div>

                <!-- 📁 分组(G)：分组管理 / 收纳规则 / 批量归类类命令的集合入口（2026-09-20 用户需求：分组命令集中到独立菜单） -->
                <div class="relative" @mouseenter="setMenu('groups')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-sky-300 transition font-bold" @click="setMenu('groups')">📁 分组(G)</button>
                    <div :class="menuOpen === 'groups' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[260px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.groups || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <div v-if="group.sectionTitle" class="px-3 py-1 text-[10px] font-bold text-zinc-500">{{ group.sectionTitle }}</div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                    </div>
                </div>

                <div class="relative" @mouseenter="setMenu('push')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-emerald-400 transition font-bold" @click="setMenu('push')">🚀 推送(P)</button>
                    <div :class="menuOpen === 'push' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[240px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <div class="px-3 py-1.5 text-[10px] text-zinc-500 font-bold border-b border-zinc-700/50 mb-1">选择目标并推送勾选的卡片</div>
                        <template v-for="(group, gi) in commandsByMenu.push || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                        <!-- 静态块：当前推送目标（非命令） -->
                        <div class="h-px bg-zinc-700 my-1"></div>
                        <div class="px-3 py-1.5 flex items-center justify-between gap-2">
                            <span class="text-zinc-400">🎯 当前目标</span>
                            <span class="px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap"
                                  :class="appSettings.pushTargetMode === 'custom' ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'">
                                {{ currentPushTargetName }}
                            </span>
                        </div>
                        <div class="px-3 pb-1.5 text-[10px] text-zinc-500 truncate" :title="currentPushTargetHint">{{ currentPushTargetHint }}</div>
                    </div>
                </div>

                <div class="relative" @mouseenter="setMenu('view')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition" @click="setMenu('view')">视图(V)</button>
                    <div :class="menuOpen === 'view' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[220px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.view || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <div v-if="group.sectionTitle" class="px-3 py-1 text-[10px] font-bold text-zinc-500">{{ group.sectionTitle }}</div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                    </div>
                </div>

                <div class="relative" @mouseenter="setMenu('settings')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition" @click="setMenu('settings')">设置(S)</button>
                    <div :class="menuOpen === 'settings' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[200px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <button @click="runCommand('settings.api')" class="px-3 py-2 text-left hover:bg-indigo-600 hover:text-white font-medium flex items-center justify-between border-b border-zinc-700/50">
                            <span>⚡ API 引擎与模型设置...</span>
                            <span class="text-[10px] text-indigo-300">配置</span>
                        </button>
                        <button @click="runCommand('settings.resetApi')" class="px-3 py-1.5 text-left hover:bg-rose-600 hover:text-white text-rose-400 border-b border-zinc-700/50">🔄 重置 API 接口参数</button>

                        <!-- 🎨 外观与字号（二级子菜单，避免整条设置菜单过长） -->
                        <div class="relative group/appearance">
                            <div class="px-3 py-1.5 flex items-center justify-between hover:bg-indigo-600 hover:text-white cursor-pointer">
                                <span>🎨 外观与字号</span>
                                <span class="text-zinc-500 group-hover/appearance:text-white">▸</span>
                            </div>
                            <div class="hidden group-hover/appearance:flex flex-col absolute left-full top-0 -mt-1 min-w-[280px] bg-zinc-800 border border-zinc-700 rounded shadow-2xl py-1 z-[60]">
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <span class="block text-zinc-400 mb-1.5">🎨 界面主题风格</span>
                            <div class="grid grid-cols-3 gap-1">
                                <!-- 🔧 评审意见 二-2：这里与「视图 → 外观」**共用同一批 registry id**（状态单源） -->
                                <button @click="runCommand('appearance.themeDark')" :class="theme === 'dark' ? 'border-indigo-500 font-bold' : ''" class="px-1.5 py-1 bg-zinc-900 border text-[10px] rounded text-zinc-200">暗夜极客</button>
                                <button @click="runCommand('appearance.themeSlate')" :class="theme === 'slate' ? 'border-sky-500 font-bold' : ''" class="px-1.5 py-1 bg-slate-800 border text-[10px] rounded text-slate-200">雅致青灰</button>
                                <button @click="runCommand('appearance.themeLight')" :class="theme === 'light' ? 'border-amber-500 font-bold' : ''" class="px-1.5 py-1 bg-zinc-100 border text-[10px] rounded text-zinc-800">明亮白昼</button>
                            </div>
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <div class="flex items-center justify-between text-zinc-300 mb-1">
                                <span>🖼️ 界面 UI 字号</span>
                                <span class="flex items-center gap-1">
                                    <button @click="runCommand('appearance.fontUiDown')" :disabled="appSettings.uiFontSize <= 10" class="w-4 h-4 leading-none text-[11px] bg-zinc-700 hover:bg-zinc-600 rounded disabled:opacity-40">−</button>
                                    <span class="text-indigo-400 font-mono font-bold">{{ uiFontSizeDraft }}px</span>
                                    <button @click="runCommand('appearance.fontUiUp')" :disabled="appSettings.uiFontSize >= 28" class="w-4 h-4 leading-none text-[11px] bg-zinc-700 hover:bg-zinc-600 rounded disabled:opacity-40">＋</button>
                                </span>
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
                        <button @click="runCommand('appearance.reset')" class="px-3 py-2 w-full text-left hover:bg-zinc-700 text-zinc-300 border-t border-zinc-700/50">🎨 重置界面外观与字号</button>
                            </div>
                        </div>

                        <!-- 🧹 标签与导入（二级子菜单） -->
                        <div class="relative group/tags">
                            <div class="px-3 py-1.5 flex items-center justify-between hover:bg-indigo-600 hover:text-white cursor-pointer">
                                <span>🧹 标签与导入</span>
                                <span class="text-zinc-500 group-hover/tags:text-white">▸</span>
                            </div>
                            <div class="hidden group-hover/tags:flex flex-col absolute left-full top-0 -mt-1 min-w-[300px] bg-zinc-800 border border-zinc-700 rounded shadow-2xl py-1 z-[60]">
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
                            <span class="block text-[10px] text-zinc-500 mt-1">只管清掉作者写进卡片的原生标签（与下方"自动打标"相互独立，可任意组合）；仅对新导入卡片生效</span>
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-300">🏷️ 导入时自动为卡片打标</span>
                                <button @click="autoTagOnImport = !autoTagOnImport"
                                        :class="autoTagOnImport ? 'bg-indigo-600' : 'bg-zinc-700'"
                                        class="w-9 h-5 rounded-full relative transition-colors shrink-0">
                                    <span :class="autoTagOnImport ? 'translate-x-4' : 'translate-x-0'"
                                          class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"></span>
                                </button>
                            </div>
                            <span class="block text-[10px] text-zinc-500 mt-1">开=用系统规则给清洗后的新卡自动打标+自动分类；关=不自动打标，留给你手动标；仅对新导入卡片生效</span>
                        </div>
                        <div class="px-3 py-2 border-b border-zinc-700/50">
                            <span class="block text-[10px] text-zinc-500 mt-1 leading-relaxed">🧹 清洗历史外来标签 已移到「🧰 工具 → 🧹 整理与清理」菜单</span>
                        </div>
                            </div>
                        </div>

                        <!-- 🆕 P1：打标与分类（三层漏斗开关 + 规则表，二级子菜单） -->
                        <div class="relative group/tagging">
                            <div class="px-3 py-1.5 flex items-center justify-between hover:bg-indigo-600 hover:text-white cursor-pointer">
                                <span>🏷️ 打标与分类</span>
                                <span class="text-zinc-500 group-hover/tagging:text-white">▸</span>
                            </div>
                            <div class="hidden group-hover/tagging:flex flex-col absolute left-full top-0 -mt-1 min-w-[330px] bg-zinc-800 border border-zinc-700 rounded shadow-2xl py-1 z-[60]">
                                <!-- 三层开关 -->
                                <div class="px-3 py-2 border-b border-zinc-700/50">
                                    <span class="block text-[10px] text-zinc-500 mb-2">打标管线（① 规则 → ② 本地向量 → ③ LLM 兜底）</span>
                                    <div class="space-y-2">
                                        <div class="flex items-center justify-between gap-2">
                                            <span class="text-zinc-300">① 规则匹配 <span class="text-[10px] text-zinc-500">零成本</span></span>
                                            <button @click="setFunnelLayer('rule', !tagFunnel.rule)" :class="tagFunnel.rule ? 'bg-indigo-600' : 'bg-zinc-700'" class="w-9 h-5 rounded-full relative transition-colors shrink-0" title="关闭后不再用内置/自定义规则打标">
                                                <span :class="tagFunnel.rule ? 'translate-x-4' : 'translate-x-0'" class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"></span>
                                            </button>
                                        </div>
                                        <div class="flex items-center justify-between gap-2">
                                            <span class="text-zinc-300">② 本地向量 <span class="text-[10px] text-zinc-500">免费离线（首次需下载模型）</span></span>
                                            <button @click="setFunnelLayer('vector', !tagFunnel.vector)" :class="tagFunnel.vector ? 'bg-purple-600' : 'bg-zinc-700'" class="w-9 h-5 rounded-full relative transition-colors shrink-0" title="语义匹配补充标签（模型未就绪时会自动跳过并提示原因）">
                                                <span :class="tagFunnel.vector ? 'translate-x-4' : 'translate-x-0'" class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"></span>
                                            </button>
                                        </div>
                                        <div class="flex items-center justify-between gap-2">
                                            <span class="text-zinc-300">③ LLM 兜底 <span class="text-[10px] text-zinc-500">消耗 Token</span></span>
                                            <button @click="setFunnelLayer('llm', !tagFunnel.llm)" :class="tagFunnel.llm ? 'bg-blue-600' : 'bg-zinc-700'" class="w-9 h-5 rounded-full relative transition-colors shrink-0" title="关闭后不发起任何 API 请求">
                                                <span :class="tagFunnel.llm ? 'translate-x-4' : 'translate-x-0'" class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"></span>
                                            </button>
                                        </div>
                                    </div>
                                    <div v-if="funnelEmpty" class="mt-2 text-[10px] text-rose-400 leading-relaxed">⚠️ 三层已全部关闭：打标无法执行（开始按钮会被禁用）。</div>
                                </div>
                                <!-- 内置规则表 -->
                                <div class="px-3 py-2 border-b border-zinc-700/50">
                                    <div class="flex items-center justify-between mb-1 gap-2">
                                        <span class="text-zinc-300">内置规则表</span>
                                        <span class="text-[10px] text-zinc-400">生效 {{ autoTagRulesStats.enabled }} / 关闭 {{ autoTagRulesStats.disabled }}</span>
                                    </div>
                                    <button @click="runCommand('settings.tagging.manageRules')" class="w-full px-2 py-1.5 text-left rounded hover:bg-indigo-600 hover:text-white flex items-center justify-between gap-2">
                                        <span>📝 管理规则表（逐条开关）…</span>
                                        <span class="text-[10px] text-zinc-500">打开</span>
                                    </button>
                                    <button @click="runCommand('settings.tagging.resetDisabled')" :disabled="autoTagRulesStats.disabled === 0" class="mt-1 w-full px-2 py-1.5 text-left rounded hover:bg-emerald-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent flex items-center justify-between gap-2">
                                        <span>↩️ 恢复内置规则全开</span>
                                    </button>
                                </div>
                                <div class="px-3 py-2">
                                    <span class="block text-[10px] text-zinc-500 leading-relaxed">
                                        ①关闭后「导入时自动打标」同样不生效；<br>
                                        规则开关<strong class="text-amber-500/90">不影响</strong>「清洗历史外来标签」的保留词表。
                                    </span>
                                </div>
                            </div>
                        </div>

                        <!-- 📸 历史快照（二级子菜单） -->
                        <div class="relative group/snapshot">
                            <div class="px-3 py-1.5 flex items-center justify-between hover:bg-indigo-600 hover:text-white cursor-pointer">
                                <span>📸 历史快照</span>
                                <span class="text-zinc-500 group-hover/snapshot:text-white">▸</span>
                            </div>
                            <div class="hidden group-hover/snapshot:flex flex-col absolute left-full top-0 -mt-1 min-w-[300px] bg-zinc-800 border border-zinc-700 rounded shadow-2xl py-1 z-[60]">
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
                            <span class="block text-[10px] text-zinc-500 mt-2 leading-relaxed">🧹 清理全部快照 / 🗑️ 清理孤儿快照 已移到「🔧 维护」菜单</span>
                        </div>
                            </div>
                        </div>
                        <div class="h-px bg-zinc-700/50 my-1 mx-2"></div>
                        <span class="block px-3 py-1.5 text-[10px] text-zinc-500">🔄 检查应用更新 已移到「帮助(H)」菜单</span>
                    </div>
                </div>

                <!-- 🧰 工具（稳定工具专区；⚠️ 实验性/不稳定功能一律放「🧪 实验」，两者不混放） -->
                <div class="relative" @mouseenter="setMenu('tools')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-sky-300 transition font-bold" @click="setMenu('tools')">🧰 工具(G)</button>
                    <div :class="menuOpen === 'tools' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[250px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.tools || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <div v-if="group.sectionTitle" class="px-3 py-1 text-[10px] font-bold text-zinc-500">{{ group.sectionTitle }}</div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                    </div>
                </div>

                <!-- 🔧 维护（目录 / 回收站 / 快照清理） -->
                <div class="relative" @mouseenter="setMenu('maintenance')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition" @click="setMenu('maintenance')">🔧 维护(W)</button>
                    <div :class="menuOpen === 'maintenance' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[230px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.maintenance || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                    </div>
                </div>

                <!-- 🧪 实验（早期 / 不稳定功能专区） -->
                <div class="relative" @mouseenter="setMenu('lab')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-amber-400 transition font-bold" @click="setMenu('lab')">🧪 实验(L)</button>
                    <div :class="menuOpen === 'lab' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[230px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.lab || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
                    </div>
                </div>

                <!-- 🆕 P2-2：「帮助」菜单（原先「检查应用更新」藏在设置菜单里） -->
                <div class="relative" @mouseenter="setMenu('help')" @mouseleave="closeMenus()">
                    <button class="px-2 py-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition" @click="setMenu('help')">帮助(H)</button>
                    <div :class="menuOpen === 'help' ? 'flex' : 'hidden'" class="flex-col absolute top-full left-0 min-w-[210px] bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50 text-xs">
                        <template v-for="(group, gi) in commandsByMenu.help || []" :key="gi">
                            <div v-if="gi > 0" class="h-px bg-zinc-700 my-1"></div>
                            <div v-if="group.sectionTitle" class="px-3 py-1 text-[10px] font-bold text-zinc-500">{{ group.sectionTitle }}</div>
                            <command-menu-item v-for="cmd in group.commands" :key="cmd.id" :cmd="cmd" :registry="registry" @executed="closeMenus()" />
                        </template>
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
            <button @click="runCommand('toolbar.graph')" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0" :title="appMode === 'worldbooks' ? '生成当前世界书的词条关联图谱' : '生成全库角色关系图谱'">
                {{ appMode === 'worldbooks' ? '🌍' : '🌌' }} 关系图谱
            </button>
            <!-- ⛔ 已下线（2026-09-20，用户决定）：全局资产库入口隐藏（浏览器/菜单/快捷键均无其它入口）
            <button @click="runCommand('toolbar.globalAssets')" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0" title="查看全库收集的世界书与正则脚本">
                📚 全局资产库
            </button>
            -->
            <!-- 下线提示（一个版本后删除）：让习惯旧位置的你能确认是“功能下线”而不是“按钮丢了” -->
            <span class="px-2 py-1 text-[10px] text-zinc-600 whitespace-nowrap shrink-0" title="全局资产库功能已关闭（后续将作为「扩展」重新提供）">📚 全局资产库已下线</span>
            <label class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition cursor-pointer whitespace-nowrap shrink-0">
                📥 恢复配置 <input type="file" class="hidden" accept=".json" @change="importLibraryDB">
            </label>
            <button @click="runCommand('theme.toggle')" class="flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0" title="循环切换三套主题 (暗夜/青灰/白昼)">
                {{ theme === 'dark' ? '🌙 暗夜' : (theme === 'slate' ? '🌊 青灰' : '☀️ 白昼') }}
            </button>
        </div>

        <div class="flex items-center gap-3 shrink-0">
            <span class="text-xs text-zinc-500 whitespace-nowrap">总计: {{ library.length }} 张卡片</span>
            <button @click="runCommand('file.backupConfig')" class="flex items-center gap-1 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition whitespace-nowrap shrink-0">💾 备份配置</button>
        </div>
    </header>
</template>

<script>
import { inject, computed, ref, watch } from 'vue';
import CommandMenuItem from './CommandMenuItem.vue'; // 🎛️ P2：单命令按钮（菜单项 / 工具栏两种形态）

export default {
    name: 'HeaderBar',
    components: { CommandMenuItem },
    setup() {
        const ctx = inject('appCtx');
        // 🆕 P2：以下三个派生状态已**上移到 App.vue 的 ctx**（注册表命令的 `badge()` / `titleFn()` 也要用它们），
        //    本组件直接用 ctx 上的同一份，避免“同一逻辑两份实现”（曾因只在本组件内部定义而导致菜单显示 undefined）。
        const funnelBadge = ctx.funnelBadge;     // 打标管线短标签（规则✓ 向量✗ AI✓）
        const funnelEmpty = ctx.funnelEmpty;     // 三层全关（模板里的警告文案用）

        // ================= 🎛️ P2：命令注册表接线 =================
        // 菜单/工具栏的❰命令❱由注册表提供（定义见 js/composables/useCommands.js）；本组件只决定"显示在哪、长什么样"。
        // 这样同一命令不会在菜单/工具栏/快捷键各处重复定义（改动前 HeaderBar 内 47 处 @click 全硬编码）。
        const registry = ctx.commandRegistry;
        // 🆕 AR-34：顶部菜单的「显式关闭」通道。
        //    原用纯 CSS `hidden group-hover:flex`，而 `:hover` 由鼠标位置决定、**点击不会改变它** →
        //    点完菜单项菜单仍然开着（命令弹窗时更会与菜单叠在一起）。现改为状态控制：
        //    容器 mouseenter 开 / mouseleave 关 / 菜单项执行后关。
        const menuOpen = ref('');                       // '' = 全部关闭；否则为菜单 key
        const setMenu = (key) => { menuOpen.value = key; };
        const closeMenus = () => { menuOpen.value = ''; };
        // `when` 求值上下文（v1 只支持单值比较：`appMode == 'xxx'`）
        const whenContext = computed(() => ({ appMode: ctx.appMode.value }));
        /** 按菜单取命令（已按 section 分组 → 模板在 section 变化处渲染分隔线） */
        const commandsByMenu = computed(() => {
            const out = {};
            // 🆕 P2-2：菜单键与注册表 `menu` 字段一致（2026-09-20：「编辑」菜单已并入「标签」，故 key 列表不含 edit）
            // ⚠️ 新增菜单必须「三处同加」：注册表 menu 字段 + 上方模板块 + 本数组 —— 漏加本数组会让下拉渲染成空白
            //    （2026-09-20「分组」菜单踩过；pycheck「注册表菜单从未被渲染」已补防线）
            for (const key of ['file', 'tags', 'groups', 'push', 'view', 'tools', 'maintenance', 'lab', 'help']) {
                out[key] = registry.listByMenu(key, whenContext.value);
            }
            return out;
        });
        // 说明：设置菜单是「命令 + 开关/滑块/子菜单」交错结构，保持手写渲染，但**数据源同样走注册表**
        //      （按钮的 @click 调用 runCommand('settings.xxx')）—— 工具栏同理。
        /** 执行命令（供手写样式的按钮调用）
         *  🆕 AR-34：执行后一并关闭菜单 —— 设置菜单里的命令是手写按钮，不走 CommandMenuItem 的 @executed，
         *  所以这里是它们唯一的公共入口，一行即可覆盖全部手写入口（工具栏按钮调用它是空操作，无影响）。 */
        const runCommand = (id) => { registry.execute(id); closeMenus(); };
        // 🎯 智能查重目标标签（“角色卡 / 世界书 / 预设”）：同样改由 ctx 提供（注册表命令标题用）
        const dedupeTargetLabel = ctx.dedupeTargetLabel;

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
            autoTagOnImport: ctx.autoTagOnImport,
            cleanForeignTagsFromLibrary: ctx.cleanForeignTagsFromLibrary,
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
            // 🆕 P1：打标三层开关（设置子菜单用）+ 管线状态提示（编辑菜单用）
            tagFunnel: ctx.tagFunnel,
            autoTagRulesStats: ctx.autoTagRulesStats,
            setFunnelLayer: ctx.setFunnelLayer,
            resetAutoTagDisabledRules: ctx.resetAutoTagDisabledRules,
            funnelBadge,
            funnelEmpty,
            // 🆕 P2：命令注册表渲染入口（菜单按钮 v-for + 手写按钮的 runCommand）
            registry,
            commandsByMenu,
            runCommand,
            // 🆕 AR-34：菜单开关状态（模板里的 @mouseenter/@mouseleave/:class 用）
            menuOpen,
            setMenu,
            closeMenus,
            library: ctx.library
        };
    }
};
</script>
