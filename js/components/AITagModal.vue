<!--
  AITagModal AI 智能批量打标弹窗（子组件）
  ⚠️ 复杂交互组件：候选池/规则/预设/API 设置全部由父级状态驱动，本组件 emits 回传操作
     注：systemPromptPresets 为响应式数组 props，name/content/expanded 直接编辑嵌套属性（Vue3 允许），
         每次输入后 emit 'save-system-prompts' 让父级持久化
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <!-- 🧭 布局重构（2026-09-22）：max-w-2xl 单列长滚动 → max-w-5xl + 左导航分区
                 对齐项目既有范式：TagCategoryModal（左导航 w-80 + 右内容）/ AutoGroupModal（max-w-5xl）
                 病灶（用户反馈「窗口有点混乱、布局不合理」）：
                   ① 单列 672px 太窄，8 个区块堆叠要滚很久才够到「开始打标」
                   ② 编号体系断裂（无编号 → 1. → 1.5 → 2. → 3. → 无编号）
                   ③ 本次任务（层开关/候选池）与配置（向量/API/提示词/破限）混在一列
                   ④ 「📝 管理规则表」重复出现两处
                   ⑤ 进度条在最底部 —— 打标时必须滚到底才能看进度
                 ⚠️ 本次只重排布局：props / emits / 业务逻辑一行未动。 -->
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[92vh]">

                <div class="px-5 py-4 bg-gray-900 text-white border-b border-gray-800 flex justify-between items-center shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">🤖 AI 智能批量打标 (已选 {{ selectedCount }} 张)</h3>
                    <button @click="$emit('close')" :disabled="isAITagging" class="text-gray-400 hover:text-white disabled:opacity-50">✕ 关闭</button>
                </div>

                <!-- 🚀 进度条常驻区：打标时在顶部（此前在最底部，用户必须滚到底才能看到进度） -->
                <div v-if="isAITagging || aiTaggingProgress.total > 0" class="px-5 py-2.5 bg-blue-50 border-b border-blue-200 shrink-0">
                    <div class="flex justify-between items-center mb-1.5 text-xs">
                        <span class="font-bold text-blue-800">{{ aiTaggingProgress.status || '准备中…' }}</span>
                        <span class="text-blue-600 font-mono">{{ aiTaggingProgress.current }} / {{ aiTaggingProgress.total }}</span>
                    </div>
                    <div class="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                        <div class="bg-blue-600 h-2 rounded-full transition-all duration-300"
                             :style="{ width: (aiTaggingProgress.current / (aiTaggingProgress.total || 1) * 100) + '%' }"></div>
                    </div>
                </div>

                <!-- 主体：左导航 + 右内容 -->
                <div class="flex flex-1 overflow-hidden min-h-0">

                    <!-- 🧭 左导航（分区切换；纯 UI 状态，不涉及业务） -->
                    <div class="w-52 shrink-0 border-r border-gray-200 bg-gray-50 p-2 flex flex-col gap-0.5 overflow-y-auto custom-scrollbar">
                        <template v-for="grp in navGroups()" :key="grp.title">
                            <div class="text-[10px] font-bold text-gray-400 px-2 pt-2.5 pb-0.5 first:pt-1">{{ grp.title }}</div>
                            <button v-for="it in grp.items" :key="it.key"
                                    @click="activeSection = it.key"
                                    class="w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center gap-1.5 transition"
                                    :class="activeSection === it.key ? 'bg-indigo-600 text-white font-bold' : 'text-gray-600 hover:bg-gray-200'">
                                <span>{{ it.icon }}</span>
                                <span class="truncate">{{ it.label }}</span>
                                <span v-if="it.badge" class="ml-auto shrink-0 text-[9px] px-1 rounded"
                                      :class="activeSection === it.key ? 'bg-white/25' : 'bg-gray-200 text-gray-500'">{{ it.badge }}</span>
                            </button>
                        </template>
                    </div>

                    <!-- 右内容区（只显示当前分区，消除长滚动） -->
                    <div class="flex-1 p-5 overflow-y-auto custom-scrollbar space-y-4 text-xs min-w-0">

                    <!-- 🏷️ P1：执行管线（这里的开关 = 本次任务；全局默认在「设置 → 🏷️ 打标与分类」，两处共用同一状态） -->
                    <div v-show="activeSection === 'pipeline'" class="bg-indigo-50 p-3 rounded-lg border border-indigo-200">
                        <div class="flex items-center justify-between mb-2 gap-2">
                            <label class="block font-bold text-indigo-900">
                                ⚙️ 执行管线
                                <span class="text-[10px] font-normal text-indigo-700/70">（① 规则 → ② 本地向量 → ③ LLM 兜底）</span>
                            </label>
                            <span class="text-[10px] text-indigo-700/70 shrink-0">规则表：生效 {{ rulesStats.enabled }} / 关闭 {{ rulesStats.disabled }}</span>
                        </div>
                        <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
                            <label class="flex items-center gap-1.5 cursor-pointer">
                                <input type="checkbox" :checked="tagFunnel.rule" :disabled="isAITagging"
                                       @change="$emit('set-funnel-layer', 'rule', $event.target.checked)" class="w-3.5 h-3.5 accent-indigo-600">
                                <span class="text-gray-800">① 规则匹配</span>
                                <span class="text-gray-400">零成本</span>
                            </label>
                            <label class="flex items-center gap-1.5 cursor-pointer">
                                <input type="checkbox" :checked="tagFunnel.vector" :disabled="isAITagging"
                                       @change="$emit('set-funnel-layer', 'vector', $event.target.checked)" class="w-3.5 h-3.5 accent-purple-600">
                                <span class="text-gray-800">② 本地向量</span>
                                <span class="text-gray-400">免费离线</span>
                            </label>
                            <label class="flex items-center gap-1.5 cursor-pointer">
                                <input type="checkbox" :checked="tagFunnel.llm" :disabled="isAITagging"
                                       @change="$emit('set-funnel-layer', 'llm', $event.target.checked)" class="w-3.5 h-3.5 accent-blue-600">
                                <span class="text-gray-800">③ LLM 兜底</span>
                                <span class="text-gray-400">消耗 Token</span>
                            </label>
                            <button @click="$emit('open-auto-tag-rules')" :disabled="isAITagging"
                                    class="ml-auto px-2 py-0.5 bg-white border border-purple-300 text-purple-700 rounded text-[11px] hover:bg-purple-600 hover:text-white transition disabled:opacity-50">📝 管理规则表</button>
                        </div>
                        <!-- 执行计划预览：提前告知哪层会被跳过（含跳过原因），避免"点了没反应" -->
                        <div class="mt-2 text-[10px] leading-relaxed">
                            <span v-if="funnelEmpty" class="text-rose-600 font-bold">⚠️ 三层均已关闭：打标无法执行，请至少启用一层。</span>
                            <template v-else>
                                <span class="text-indigo-800">本次将执行：</span>
                                <span class="font-mono text-indigo-900">{{ plannedLayers }}</span>
                                <span v-if="funnelPlan.skip && funnelPlan.skip.vector" class="text-amber-600 ml-2">· ②跳过原因：{{ funnelPlan.skip.vector }}</span>
                                <span v-if="funnelPlan.skip && funnelPlan.skip.llm" class="text-amber-600 ml-2">· ③跳过原因：{{ funnelPlan.skip.llm }}</span>
                                <span class="text-indigo-700/70 ml-2">（①关闭后「导入时自动打标」同样不生效）</span>
                            </template>
                        </div>
                        <!-- 🧠 R1+R2：仅 LLM 层启动时，分角色结构 + 结构化截取生效（在此明确告知 + 直达编辑入口） -->
                        <div v-if="llmOnlyActive" class="mt-1.5 text-[10px] leading-relaxed bg-emerald-50 border border-emerald-200 rounded px-2 py-1 text-emerald-800 flex items-center gap-1.5 flex-wrap">
                            <span>🧠 <b>仅 LLM 层启动</b> → 已启用「提示词分角色（System / Assistant / User / 预填充）+ <code>&lt;tags&gt;</code> 结构化截取」</span>
                            <span class="px-1.5 rounded border"
                                  :class="activeCotPrompt.trim() ? 'bg-emerald-100 border-emerald-300' : 'bg-gray-100 border-gray-300 text-gray-600'">
                                {{ activeCotPrompt.trim() ? '🔗 思维链：' + ((activePromptPreset && activePromptPreset.cotMode === 'custom') ? '自定义' : '默认版') : '🔗 思维链：关闭' }}
                            </span>
                            <button @click="activeSection = 'prompts'" class="ml-auto shrink-0 underline hover:text-emerald-950">去分段编辑 →</button>
                        </div>
                    </div>

                    <!-- 🧩🏷️ 1. 候选标签池 -->
                    <div v-show="activeSection === 'candidates'" class="bg-gray-50 p-3 rounded-lg border border-gray-200">
                        <label class="block font-bold text-gray-700 mb-2">🏷️ 1. 候选标签池 <span class="text-[10px] font-normal text-gray-500">(AI 将优先从中挑选)</span>:</label>

                        <div class="flex flex-wrap gap-2 mb-2 p-2 border border-gray-200 bg-white rounded min-h-[40px]">
                            <span v-for="(tag, idx) in aiCandidateTags" :key="idx"
                                  class="px-2 py-1 bg-blue-600/30 text-blue-700 text-xs rounded-full flex items-center gap-1 cursor-pointer hover:bg-red-500 hover:text-white transition"
                                  @click="$emit('remove-ai-candidate-tag', idx)" title="点击移除">
                                {{ tag }} ✕
                            </span>
                            <span v-if="aiCandidateTags.length === 0" class="text-gray-400 text-xs self-center">尚未添加候选标签（点击下方常用标签，或手动输入）</span>
                        </div>

                        <div class="flex gap-2 mb-2">
                            <input :value="newAICandidateTag" @input="$emit('update:newAICandidateTag', $event.target.value)" @keyup.enter="$emit('add-ai-candidate-tag-manual')" :disabled="isAITagging"
                                   type="text" placeholder="手动输入候选标签后回车..."
                                   class="flex-1 bg-white border border-gray-300 rounded px-2.5 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none">
                            <button @click="$emit('add-ai-candidate-tag-manual')" :disabled="isAITagging || !newAICandidateTag.trim()"
                                    class="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded text-xs transition shrink-0">＋ 添加</button>
                        </div>

                        <div class="text-[11px] text-gray-500 mb-1">💡 快速点击添加系统/常用标签（按大分类分组，✕ 可彻底删除）：</div>
                        <div class="max-h-44 overflow-y-auto p-1 custom-scrollbar">
                            <template v-for="group in groupedSystemTags" :key="group.key">
                                <div class="flex items-baseline gap-1 mb-1 mt-1.5 first:mt-0 cursor-pointer select-none" @click="toggleTagGroup(group.key)" :title="collapsedTagGroups[group.key] ? '点击展开' : '点击折叠'">
                                    <span class="text-[10px] text-gray-400">{{ collapsedTagGroups[group.key] ? '▸' : '▾' }}</span>
                                    <span class="text-[11px] font-bold text-gray-700">{{ group.icon }} {{ group.name }}</span>
                                    <span class="text-[9px] text-gray-400">({{ group.tags.length }})</span>
                                </div>
                                <div v-show="!collapsedTagGroups[group.key]" class="flex flex-wrap gap-1.5">
                                    <div v-for="tag in group.tags" :key="tag" class="group flex items-center shadow-sm rounded">
                                        <button @click="$emit('add-ai-candidate-tag', tag)"
                                                :disabled="isAITagging || aiCandidateTags.includes(tag)"
                                                :class="['px-2 py-0.5 text-[11px] border transition-colors rounded-l',
                                                         aiCandidateTags.includes(tag) ? 'bg-gray-200 border-gray-300 text-gray-400 cursor-not-allowed' : 'bg-white border-gray-300 text-gray-600 hover:bg-blue-600 hover:border-blue-500 hover:text-white']">
                                            + {{ tag }}
                                        </button>
                                        <button @click.stop="$emit('remove-system-common-tag', tag)" :disabled="isAITagging"
                                                class="px-1.5 py-0.5 text-[11px] border border-l-0 border-gray-300 bg-gray-100 text-gray-400 hover:bg-red-500 hover:text-white hover:border-red-500 rounded-r transition-colors" title="从全局系统库中彻底删除此标签">
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            </template>
                        </div>
                    </div>

                    <!-- 🧠 1.5 本地向量引擎（三层漏斗第二层：免费离线语义匹配） -->
                    <div v-show="activeSection === 'vector'" class="bg-gray-50 p-3 rounded-lg border border-gray-200">
                        <label class="flex items-center gap-2 font-bold text-gray-700 mb-2 cursor-pointer">
                            <input type="checkbox" :checked="useLocalVector"
                                   @change="$emit('update:useLocalVector', $event.target.checked)" :disabled="isAITagging"
                                   class="w-4 h-4 text-purple-600 bg-white border-gray-300 rounded focus:ring-purple-600">
                            🧠 启用本地向量匹配 <span class="text-[10px] font-normal text-gray-500">(免费·离线·不消耗 Token)</span>
                        </label>

                        <div v-if="useLocalVector" class="space-y-2 ml-6">
                            <!-- 状态行 -->
                            <div class="flex items-center gap-3 text-[11px]">
                                <span v-if="vectorStatus.ready" class="text-green-600">✅ 模型已就绪 ({{ vectorStatus.cacheSizeMB }}MB)</span>
                                <span v-else-if="vectorDownloading" class="text-blue-600">⏳ 下载中... {{ Math.round(vectorDownloadProgress.progress || 0) }}%<span v-if="vectorDownloadSource.label" class="text-gray-400"> ({{ vectorDownloadSource.label }}{{ vectorDownloadSource.total > 1 ? ' · 源 ' + vectorDownloadSource.attempt + '/' + vectorDownloadSource.total : '' }})</span></span>
                                <span v-else-if="vectorStatus.cacheExists" class="text-amber-600">📦 缓存已存在，点击加载</span>
                                <span v-else class="text-gray-500">未下载 (约 120MB)</span>

                                <button v-if="!vectorStatus.ready && !vectorDownloading"
                                        @click="$emit('init-vector-engine')"
                                        class="px-2 py-0.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-[11px] transition">
                                    📥 下载模型
                                </button>
                                <button v-if="vectorStatus.cacheExists"
                                        @click="$emit('delete-vector-cache')" :disabled="isAITagging"
                                        class="px-2 py-0.5 bg-gray-300 hover:bg-red-500 hover:text-white text-gray-600 rounded text-[11px] transition">
                                    🗑️ 删除缓存
                                </button>
                            </div>

                            <!-- 下载进度条 -->
                            <div v-if="vectorDownloading" class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div class="bg-purple-600 h-2 rounded-full transition-all duration-300"
                                     :style="{ width: Math.min(100, Math.round(vectorDownloadProgress.progress || 0)) + '%' }"></div>
                            </div>

                            <!-- 阈值与 TopK -->
                            <div class="flex gap-4 items-center">
                                <label class="text-[11px] text-gray-600 flex items-center gap-1">
                                    相似度阈值:
                                    <input type="range" min="0.3" max="0.9" step="0.05"
                                           :value="vectorThreshold" :disabled="isAITagging"
                                           @input="$emit('update:vectorThreshold', parseFloat($event.target.value))"
                                           class="w-20 accent-purple-600">
                                    {{ Number(vectorThreshold).toFixed(2) }}
                                </label>
                                <label class="text-[11px] text-gray-600 flex items-center gap-1">
                                    Top-K:
                                    <input type="number" min="1" max="10" :value="vectorTopK" :disabled="isAITagging"
                                           @input="$emit('update:vectorTopK', parseInt($event.target.value))"
                                           class="w-12 border border-gray-300 rounded px-1 text-xs">
                                </label>
                            </div>
                            <p class="text-[10px] text-gray-500">阈值越高越精确（漏标多），越低越宽泛（误标多）。建议 0.30-0.45。规则 + 向量配合使用：规则精确命中，向量从候选池补充语义标签，两者都未命中才调用 LLM。</p>
                            <!-- ⚠️ 此处原有的「📝 管理规则表」已移除（与「执行管线」区重复）——
                                 规则表入口统一保留在「⚙️ 执行管线」区，避免同一功能两处入口。 -->
                        </div>
                    </div>

                    <!-- 🤖 AI 提取设置（本次任务相关：是否允许 AI 自创标签 + 附加要求） -->
                    <div v-show="activeSection === 'extract'" class="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
                        <h4 class="text-sm font-bold text-gray-700">🤖 AI 提取设置</h4>

                        <label class="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" :checked="enableAIExtraction" @change="$emit('update:enableAIExtraction', $event.target.checked)" :disabled="isAITagging"
                                   class="w-4 h-4 text-blue-600 bg-white border-gray-300 rounded focus:ring-blue-600 focus:ring-2">
                            <span class="text-sm text-gray-700">允许 AI 自由提取标签</span>
                        </label>
                        <p class="text-[10px] text-gray-500 ml-6 -mt-1">关闭后，AI 将<strong class="text-rose-500">严格只能</strong>从候选池中为你选择标签，不会自行创造新标签。</p>

                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-600">附加自定义提示词 (可选)</label>
                            <textarea :value="customAIPrompt" @input="$emit('update:customAIPrompt', $event.target.value)" :disabled="isAITagging" rows="2"
                                      placeholder="例如：请重点分析角色的性格特征，忽略外观描述..."
                                      class="w-full bg-white border border-gray-300 rounded p-2 text-xs text-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-400 resize-y shadow-sm"></textarea>
                        </div>
                    </div>

                    <!-- 🚨 强制破限（独立分区：与「AI 提取设置」拆开，不再嵌在它内部） -->
                    <div v-show="activeSection === 'jailbreak'" class="border border-rose-300 bg-rose-50 rounded-lg p-3">
                        <div class="flex items-center justify-between mb-2">
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" :checked="useJailbreak" @change="$emit('update:useJailbreak', $event.target.checked)" :disabled="isAITagging"
                                       class="w-4 h-4 text-rose-600 bg-white border-gray-300 rounded focus:ring-rose-600 focus:ring-2">
                                <span class="text-sm font-bold text-rose-600 flex items-center gap-1">⚠️ 启用强制破限 (Jailbreak)</span>
                            </label>
                            <span class="text-[10px] text-gray-500">用于对抗模型拒答及道德审查</span>
                        </div>
                        <transition name="fade">
                            <div v-show="useJailbreak" class="mt-2 space-y-2">
                                <!-- 📚 预设快速套用：选中即覆盖当前破限词 -->
                                <div class="flex items-center gap-2" v-if="jailbreakPresets.length > 0">
                                    <label class="text-[10px] text-rose-500 shrink-0">📚 预设套用:</label>
                                    <select :value="''" @change="$emit('update:jailbreakPrompt', $event.target.value)" :disabled="isAITagging"
                                            class="flex-1 h-7 bg-white border border-rose-300 rounded px-1.5 text-xs text-rose-700 focus:outline-none focus:border-rose-500">
                                        <option value="" disabled>— 选择预设覆盖当前破限词 —</option>
                                        <option v-for="p in jailbreakPresets" :key="p.id" :value="p.content">{{ p.name }}</option>
                                    </select>
                                </div>
                                <textarea :value="jailbreakPrompt" @input="$emit('update:jailbreakPrompt', $event.target.value)" :disabled="isAITagging" rows="6"
                                          class="w-full bg-white/80 border border-rose-300 rounded p-2 text-xs text-rose-800 focus:border-rose-500 focus:outline-none resize-y shadow-sm placeholder-rose-400 custom-scrollbar"
                                          placeholder="输入你的强力破限咒语 (Jailbreak Prompt)..."></textarea>
                                <p class="text-[10px] text-rose-500/80 mt-1">💡 破限词自动拼接在系统提示词最末尾（注意力权重最高），输入一次永久保存，重启不丢。</p>
                            </div>
                        </transition>
                    </div>

                    <!-- 📝 系统提示词预设库 -->
                    <div v-show="activeSection === 'prompts'">
                        <label class="font-bold text-gray-700 mb-2 flex justify-between items-center">
                            <span>📝 系统级微调全局提示词 (System Prompts):</span>
                            <span class="text-[10px] text-amber-600 font-normal bg-amber-50 px-2 py-0.5 rounded border border-amber-200">勾选即生效 · 建议保留 JSON 输出指令</span>
                        </label>
                        <div class="bg-gray-50 border border-gray-200 rounded-lg p-3.5 shadow-inner">
                            <div class="flex items-center justify-between mb-2.5 pb-2 border-b border-gray-200">
                                <span class="font-bold text-amber-600 flex items-center gap-1.5">📝 预设库 ({{ systemPromptPresets.length }} 条)</span>
                                <button @click="$emit('add-system-prompt-preset')" :disabled="isAITagging" class="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded text-[11px] font-medium transition flex items-center gap-1">➕ 新增提示词</button>
                            </div>
                            <div class="space-y-2.5 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                                <div v-for="(preset, index) in systemPromptPresets" :key="preset.id"
                                     class="bg-white border rounded-lg p-2.5 transition"
                                     :class="activeSystemPromptId === preset.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'">
                                    <div class="flex items-center justify-between gap-2">
                                        <div class="flex items-center gap-2 flex-1">
                                            <input type="radio" :checked="activeSystemPromptId === preset.id" @change="$emit('update:activeSystemPromptId', preset.id)" :disabled="isAITagging" class="accent-indigo-600 cursor-pointer shrink-0" title="设为当前生效">
                                            <input v-model="preset.name" @input="$emit('save-system-prompts')" :disabled="isAITagging" type="text" class="bg-white border border-gray-300 rounded px-2 py-0.5 text-gray-800 font-medium text-xs w-full focus:border-indigo-500 focus:outline-none">
                                        </div>
                                        <div class="flex items-center gap-1.5 shrink-0">
                                            <button @click="preset.expanded = !preset.expanded" :disabled="isAITagging" class="text-gray-500 hover:text-gray-800 px-2 py-0.5 rounded hover:bg-gray-100 transition">{{ preset.expanded ? '🔼 折叠' : '🔽 展开' }}</button>
                                            <button @click="$emit('delete-system-prompt-preset', index)" :disabled="isAITagging" class="text-gray-400 hover:text-rose-500 px-1.5 py-0.5 rounded hover:bg-gray-100 transition" title="删除">🗑️</button>
                                        </div>
                                    </div>
                                    <div v-if="preset.expanded" class="mt-2.5 pt-2 border-t border-gray-200">
                                        <!-- 🧠 R1+R2 分角色结构：仅「只有 LLM 层启动」时生效 -->
                                        <div class="flex items-center justify-between mb-1.5">
                                            <label class="text-[10px] text-gray-500">提示词分角色设定（System / Assistant / User / 预填充）：</label>
                                            <span class="text-[9px] px-1.5 py-0.5 rounded border"
                                                  :class="llmOnlyActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'"
                                                  :title="llmOnlyActive ? '当前组合 = 只有 LLM 层 → 分角色结构已生效' : '只有 ①规则关 + ②向量关 + ③LLM开 时才生效'">
                                                {{ llmOnlyActive ? '🟢 分角色结构已生效' : '⚪ 未生效（非「仅 LLM」组合）' }}
                                            </span>
                                        </div>
                                        <div class="flex items-center gap-1 mb-1.5">
                                            <button v-for="t in [{k:'system',i:'🧠',n:'System'},{k:'assistant',i:'💬',n:'Assistant'},{k:'user',i:'👤',n:'User'},{k:'prefill',i:'⚡',n:'预填充'},{k:'cot',i:'🔗',n:'思维链'}]" :key="t.k"
                                                    @click="presetEditorTab = t.k" :disabled="isAITagging"
                                                    class="px-2 py-0.5 rounded text-[10px] font-medium border transition flex items-center gap-1"
                                                    :class="presetEditorTab === t.k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'">
                                                <span>{{ t.i }}</span><span>{{ t.n }}</span>
                                                <span v-if="t.k === 'cot' ? presetCotText(preset).trim() : presetField(preset, t.k).trim()" class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                            </button>
                                            <span class="ml-auto text-[9px] text-gray-400">{{ presetHasRoles(preset) ? '走预设三段' : '副字段留空 → 走程序默认' }}</span>
                                        </div>

                                        <!-- 🧠 System：角色与规则（主提示词） -->
                                        <div v-show="presetEditorTab === 'system'">
                                            <textarea :value="presetField(preset, 'system')" @input="setPresetField(preset, 'system', $event.target.value)" :disabled="isAITagging" rows="5"
                                                      class="w-full bg-white border border-gray-300 rounded p-2 text-gray-700 font-mono text-xs focus:border-indigo-500 focus:outline-none resize-y shadow-sm"
                                                      placeholder="给 AI 的角色设定与打标规则（如：你是资深角色卡标签分析助手…）"></textarea>
                                            <p class="text-[9px] text-gray-500 mt-0.5">🧠 <b>System</b>：角色 + 任务规则。开启破限时，破限词会自动追加在本段<b>最末尾</b>（注意力权重最高）。</p>
                                        </div>
                                        <!-- 💬 Assistant：示例推理 / 格式示范（few-shot） -->
                                        <div v-show="presetEditorTab === 'assistant'">
                                            <textarea :value="presetField(preset, 'assistant')" @input="setPresetField(preset, 'assistant', $event.target.value)" :disabled="isAITagging" rows="5"
                                                      class="w-full bg-white border border-gray-300 rounded p-2 text-gray-700 font-mono text-xs focus:border-indigo-500 focus:outline-none resize-y shadow-sm"
                                                      placeholder="（可选）示例输出，示范 AI 该怎么思考与输出，如：&#10;<tags>[&quot;奇幻&quot;,&quot;骑士&quot;]</tags>"></textarea>
                                            <p class="text-[9px] text-gray-500 mt-0.5">💬 <b>Assistant</b>：few-shot 示范（示例推理 / 期望输出格式）。会作为「助手已说过的内容」插在对话中，引导模型模仿。</p>                                        </div>
                                        <!-- 👤 User：本次任务指令（留空则用程序自动生成的任务） -->
                                        <div v-show="presetEditorTab === 'user'">
                                            <textarea :value="presetField(preset, 'user')" @input="setPresetField(preset, 'user', $event.target.value)" :disabled="isAITagging" rows="5"
                                                      class="w-full bg-white border border-gray-300 rounded p-2 text-gray-700 font-mono text-xs focus:border-indigo-500 focus:outline-none resize-y shadow-sm"
                                                      placeholder="（留空 = 用程序自动生成的卡片任务指令；填写则覆盖）"></textarea>
                                            <p class="text-[9px] text-gray-500 mt-0.5">👤 <b>User</b>：本次任务指令。留空时使用程序自动拼装的「当前卡片内容 + 输出要求」，一般无需填写。</p>
                                        </div>
                                        <!-- ⚡ 预填充：强制模型从指定开头续写 -->
                                        <div v-show="presetEditorTab === 'prefill'">
                                            <textarea :value="presetField(preset, 'prefill')" @input="setPresetField(preset, 'prefill', $event.target.value)" :disabled="isAITagging" rows="2"
                                                      class="w-full bg-white border border-gray-300 rounded p-2 text-gray-700 font-mono text-xs focus:border-indigo-500 focus:outline-none resize-y shadow-sm"
                                                      placeholder="默认：<tags>["></textarea>
                                            <p class="text-[9px] text-gray-500 mt-0.5">⚡ <b>预填充</b>：强制模型从这个开头往下写（默认 <code class="text-indigo-600">&lt;tags&gt;[</code>），能大幅提高「结构化输出」遵守率。留空则用默认值。</p>
                                        </div>

                                        <!-- 🧠 思维链（CoT）+ 破限：默认版 / 自定义 / 关闭 -->
                                        <div v-show="presetEditorTab === 'cot'">
                                            <div class="flex items-center gap-1 mb-1.5 flex-wrap">
                                                <button v-for="m in [{k:'default',i:'🟢',n:'默认版'},{k:'custom',i:'✏️',n:'自定义'},{k:'off',i:'⚪',n:'关闭'}]" :key="m.k"
                                                        @click="setCotMode(preset, m.k)" :disabled="isAITagging"
                                                        class="px-2 py-0.5 rounded text-[10px] font-medium border transition flex items-center gap-1"
                                                        :class="((preset.cotMode || 'default') === m.k) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'">
                                                    <span>{{ m.i }}</span><span>{{ m.n }}</span>
                                                </button>
                                                <span class="ml-auto text-[9px] text-gray-400">当前将注入 {{ presetCotText(preset).length }} 字</span>
                                            </div>

                                            <!-- 默认版：只读展示（开箱即用，不需编辑） -->
                                            <div v-if="(preset.cotMode || 'default') === 'default'">
                                                <textarea :value="defaultCotPrompt" readonly rows="6"
                                                          class="w-full bg-emerald-50/60 border border-emerald-200 rounded p-2 text-emerald-900 font-mono text-[10px] focus:outline-none resize-y shadow-inner custom-scrollbar"></textarea>
                                                <p class="text-[9px] text-gray-500 mt-0.5">🟢 <b>默认版</b>（内置只读）：已融合「思维链引导 + 破限」—— 先让模型在心里过一遍题材/身份/关键词，同时声明这是虚构文本特征归纳、不受内容审查影响。需修改请切到「✏️ 自定义」。</p>
                                            </div>

                                            <!-- 自定义：可编辑 -->
                                            <div v-else-if="preset.cotMode === 'custom'">
                                                <textarea :value="presetField(preset, 'cot')" @input="setPresetField(preset, 'cot', $event.target.value)" :disabled="isAITagging" rows="6"
                                                          class="w-full bg-white border border-emerald-300 rounded p-2 text-gray-700 font-mono text-[10px] focus:border-emerald-500 focus:outline-none resize-y shadow-sm custom-scrollbar"
                                                          placeholder="在此写你自己的思维链 / 破限提示词..."></textarea>
                                                <p class="text-[9px] text-gray-500 mt-0.5">✏️ <b>自定义</b>：留空则自动回退到内置默认版（不会静默失效）。</p>
                                            </div>

                                            <!-- 关闭 -->
                                            <div v-else class="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded p-2">
                                                ⚪ <b>已关闭</b>：不注入思维链段。模型仍会被要求用 <code class="text-indigo-600">&lt;tags&gt;</code> 包裹结果。
                                            </div>

                                            <p class="text-[9px] text-emerald-700 mt-1.5">📌 该段以 <b>assistant 角色</b>插在 <b>user 之后</b>（Anthropic 协议要求第一条非 system 消息必须是 user，放前面会报错）；被中转站拒绝时会<b>自动逐级降级重试</b>。</p>
                                        </div>

                                        <p class="text-[9px] text-amber-600 mt-1.5">⚠️ 以上 5 段<b>仅在「①规则关 + ②向量关 + ③LLM 开」</b>（只有 LLM 层启动）时启用；其他组合仍沿用原有单段系统提示词。</p>
                                    </div>
                                </div>
                            </div>
                            <p class="text-[10px] text-gray-500 mt-2">
                                💡 勾选左侧单选按钮指定当前 AI 打标生效的系统提示词，支持随时折叠管理、自动保存。
                            </p>
                        </div>
                    </div>

                    <!-- ⚡ API 引擎设置 -->
                    <div v-show="activeSection === 'api'" class="bg-gray-50 border border-gray-200 rounded-lg p-3.5 shadow-inner">
                        <div class="flex items-center justify-between mb-2.5">
                            <span class="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                                ⚡ API 引擎设置 <span class="text-[10px] font-normal text-gray-500">(打标与测卡对话实时同步)</span>
                            </span>
                            <button @click="$emit('fetch-available-models')" :disabled="isFetchingModels" class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-300 disabled:text-gray-500 text-white text-[11px] font-medium rounded shadow flex items-center gap-1 transition">
                                <span v-if="isFetchingModels" class="animate-spin">🌀</span>
                                <span v-else>🔄</span> 拉取模型列表
                            </button>
                        </div>
                        <div class="grid grid-cols-2 gap-2.5 mb-2.5">
                            <div>
                                <label class="block text-[11px] text-gray-600 mb-1">API Endpoint</label>
                                <input :value="apiEndpoint" @input="$emit('update:apiEndpoint', $event.target.value)" type="text" placeholder="http://127.0.0.1:1234/v1/chat/completions" class="w-full bg-white border border-gray-300 rounded px-2.5 py-1 text-xs text-gray-800 focus:border-indigo-500 focus:outline-none">
                            </div>
                            <div>
                                <label class="block text-[11px] text-gray-600 mb-1">API Key</label>
                                <input :value="apiKey" @input="$emit('update:apiKey', $event.target.value)" type="password" placeholder="sk-... 或留空" class="w-full bg-white border border-gray-300 rounded px-2.5 py-1 text-xs text-gray-800 focus:border-indigo-500 focus:outline-none">
                            </div>
                        </div>

                        <!-- 🔌 测试连通性：一条最小请求验证 Endpoint / Key / Model 三要素（避免跑一半才发现连不上） -->
                        <div class="flex items-center gap-2 mb-2.5">
                            <button @click="$emit('test-connection')" :disabled="isTestingConn || isAITagging"
                                    class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-300 disabled:text-gray-500 text-white text-[11px] font-medium rounded shadow flex items-center gap-1 transition shrink-0"
                                    title="发送一条最小请求（hi）验证 Endpoint / Key / Model 是否真的可用">
                                <span v-if="isTestingConn" class="animate-spin">🌀</span>
                                <span v-else>🔌</span> 测试连通性
                            </button>
                            <span v-if="connTestStatus" class="text-[10px] leading-tight"
                                  :class="connTestStatus.includes('❌') ? 'text-rose-600' : (connTestStatus.includes('✅') ? 'text-emerald-600' : 'text-gray-500')">{{ connTestStatus }}</span>
                            <span v-else class="text-[10px] text-gray-400">打标前建议先测一下 —— 批量打标中途才发现连不上会白等很久</span>
                        </div>
                        <div>
                            <label class="text-[11px] text-gray-600 mb-1 flex justify-between items-center">
                                <span>当前选中模型 (Model)</span>
                                <span v-if="fetchModelStatus" class="text-[10px]" :class="fetchModelStatus.includes('❌') ? 'text-red-500' : 'text-emerald-600'">{{ fetchModelStatus }}</span>
                            </label>
                            <div class="flex gap-2">
                                <select v-if="availableModels.length > 0" :value="apiModel" @change="$emit('update:apiModel', $event.target.value)" class="w-full bg-white border border-indigo-400 rounded px-2.5 py-1 text-xs text-gray-800 focus:outline-none">
                                    <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                                </select>
                                <input v-else :value="apiModel" @input="$emit('update:apiModel', $event.target.value)" list="model-suggestions" type="text" placeholder="例: gpt-4o, local-model" class="w-full bg-white border border-gray-300 rounded px-2.5 py-1 text-xs text-gray-800 focus:border-indigo-500 focus:outline-none">
                            </div>
                            <p class="text-[10px] text-gray-500 mt-1.5 leading-relaxed">
                                本地 LM Studio / Ollama 可留空或填 <code class="text-indigo-600 bg-indigo-500/10 px-1 rounded">local-model</code>；第三方 API 需严格填写模型 ID。
                            </p>
                        </div>
                    </div>
                    <!-- ⚠️ 旧版「底部进度条」已删除：进度条已移到顶部常驻区（见文件开头），
                         重复渲染会让用户看到两个进度条，且占据右内容区一层高度。 -->
                    </div>
                </div>

                <div class="px-5 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 shrink-0">
                    <button @click="$emit('close')" :disabled="isAITagging" class="px-5 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-50 transition">取消</button>
                    <button @click="$emit('start-tagging')" :disabled="isAITagging || funnelEmpty"
                            :title="funnelEmpty ? '三层打标管线均已关闭 —— 请在上方执行管线或「设置 → 🏷️ 打标与分类」至少启用一层' : ''"
                            class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold disabled:opacity-75 disabled:cursor-not-allowed flex items-center gap-2 shadow-md transition">
                        <svg v-if="isAITagging" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        {{ isAITagging ? '打标处理中...' : (funnelEmpty ? '🚫 管线已全关' : '🚀 开始智能打标') }}
                    </button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
import { groupTagsByCategory } from '../utils/tagCategories.js';
// 🧠 内置默认思维链提示词（只读展示用；与引擎 resolveCotPrompt 的默认值同源，避免两处文案漂移）
import { DEFAULT_COT_PROMPT } from '../utils/llmPromptRoles.js';

export default {
    name: 'AITagModal',
    props: {
        show: { type: Boolean, default: false },
        selectedCount: { type: Number, default: 0 },
        systemCommonTags: { type: Array, default: () => [] },
        aiCandidateTags: { type: Array, default: () => [] },
        newAICandidateTag: { type: String, default: '' },
        enableAIExtraction: { type: Boolean, default: true },
        customAIPrompt: { type: String, default: '' },
        useJailbreak: { type: Boolean, default: true },
        jailbreakPrompt: { type: String, default: '' },
        jailbreakPresets: { type: Array, default: () => [] },
        systemPromptPresets: { type: Array, default: () => [] },
        activeSystemPromptId: { type: String, default: '' },
        // 🧠 R1+R2（2026-09-24）：是否「只有 LLM 层启动」（决定分角色结构 + 结构化截取是否生效）
        llmOnlyActive: { type: Boolean, default: false },
        // 当前生效的预设（已归一化：system/assistant/user/prefill/cot；旧 content 自动迁到 system）
        activePromptPreset: { type: Object, default: null },
        // 🧠 思维链：当前预设实际会注入的 CoT 提示词（'' = 已关闭）
        activeCotPrompt: { type: String, default: '' },
        // 🔌 连通性测试
        isTestingConn: { type: Boolean, default: false },
        connTestStatus: { type: String, default: '' },
        apiEndpoint: { type: String, default: '' },
        apiKey: { type: String, default: '' },
        apiModel: { type: String, default: '' },
        availableModels: { type: Array, default: () => [] },
        isFetchingModels: { type: Boolean, default: false },
        fetchModelStatus: { type: String, default: '' },
        isAITagging: { type: Boolean, default: false },
        aiTaggingProgress: { type: Object, default: () => ({ current: 0, total: 0, status: '' }) },
        // 🧠 本地向量引擎
        useLocalVector: { type: Boolean, default: false },
        vectorThreshold: { type: Number, default: 0.35 }, // 与 useAITools / vectorManager 默认值对齐（0.65 命中率≈0）
        vectorTopK: { type: Number, default: 3 },
        vectorStatus: { type: Object, default: () => ({ ready: false, cacheExists: false, cacheSizeMB: 0, cachePath: '' }) },
        vectorDownloading: { type: Boolean, default: false },
        vectorDownloadProgress: { type: Object, default: () => ({ status: '', file: '', progress: 0 }) },
        vectorDownloadSource: { type: Object, default: () => ({ source: '', attempt: 0, total: 0, label: '' }) },
        // 🆕 P1：三层漏斗开关 + 执行计划 + 规则表统计（均来自 App.vue；本组件只展示 + emit）
        tagFunnel: { type: Object, default: () => ({ rule: true, vector: false, llm: true }) },
        funnelPlan: { type: Object, default: () => ({ rule: true, vector: false, llm: true, skip: {} }) },
        rulesStats: { type: Object, default: () => ({ total: 0, enabled: 0, disabled: 0 }) }
    },
    emits: [
        'close', 'remove-ai-candidate-tag', 'update:newAICandidateTag', 'add-ai-candidate-tag-manual',
        'add-ai-candidate-tag', 'update:enableAIExtraction', 'update:customAIPrompt',
        'update:useJailbreak', 'update:jailbreakPrompt',
        'add-system-prompt-preset', 'update:activeSystemPromptId', 'save-system-prompts',
        'delete-system-prompt-preset', 'fetch-available-models', 'update:apiEndpoint',
        'update:apiKey', 'update:apiModel', 'start-tagging', 'remove-system-common-tag',
        // 🧠 本地向量引擎
        'update:useLocalVector', 'update:vectorThreshold', 'update:vectorTopK',
        'init-vector-engine', 'delete-vector-cache',
        // 📝 自动打标规则表管理
        'open-auto-tag-rules',
        // 🆕 P1：三层开关（(layer, enabled)，与 App.vue 的 setFunnelLayer 签名一致）
        'set-funnel-layer',
        // 🔌 测试 API 连通性（用户 2026-09-24 要求）
        'test-connection'
    ],
    // 🏷️ [标签大分类] 系统标签池按大分类分组（人物关系/角色设定/外貌身材...），候选标签更好找
    computed: {
        groupedSystemTags() {
            return groupTagsByCategory(this.systemCommonTags || []);
        },
        // 🆕 P1：三层全关 → 禁用「开始打标」（硬验收 H1：绝不出现"静默 0 结果"）
        funnelEmpty() {
            const f = this.tagFunnel || {};
            return !f.rule && !f.vector && !f.llm;
        },
        // 🆕 P1：本次实际会执行的层（①→②→③ 可读串，用于提前告知会被跳过的层）
        plannedLayers() {
            const p = this.funnelPlan || {};
            return [p.rule ? '①' : null, p.vector ? '②' : null, p.llm ? '③' : null].filter(Boolean).join(' → ') || '（无）';
        }
    },
    // 🏷️ [大分类折叠] 记录被折叠的分类 key（点击分组标题折叠/展开）
    data() {
        return {
            collapsedTagGroups: {},
            // 🧭 左导航当前分区（纯 UI 状态；不涉及任何业务逻辑）
            activeSection: 'pipeline',
            // 🧠 R1+R2：预设编辑器的小页签（system / assistant / user / prefill / cot）
            presetEditorTab: 'system',
            // 🧠 内置默认思维链提示词（只读展示用；与 js/utils/llmPromptRoles.js 的 DEFAULT_COT_PROMPT 一致）
            defaultCotPrompt: DEFAULT_COT_PROMPT
        };
    },
    methods: {
        toggleTagGroup(key) {
            this.collapsedTagGroups[key] = !this.collapsedTagGroups[key];
        },
        // 🧠 R1+R2：读取某个预设的分段值（旧预设只有 content → 归一化到 system，兼容不迁移数据）
        presetField(preset, field) {
            if (!preset) return '';
            if (field === 'system') return preset.system ?? preset.content ?? '';
            return preset[field] ?? '';
        },
        // 🧠 R1+R2：写入某个预设的分段值（同时同步旧 content，保持向后兼容）
        setPresetField(preset, field, value) {
            if (!preset) return;
            preset[field] = value;
            if (field === 'system') preset.content = value; // 旧字段镜像，旧逻辑仍能读到
            this.$emit('save-system-prompts');
        },
        // 🧠 思维链：切换模式（default / custom / off）
        setCotMode(preset, mode) {
            if (!preset) return;
            preset.cotMode = mode;
            // 首次切到「自定义」且尚未写过内容时，用内置默认版预填，方便改
            if (mode === 'custom' && !String(preset.cot || '').trim()) {
                preset.cot = this.defaultCotPrompt;
            }
            this.$emit('save-system-prompts');
        },
        // 🧠 该预设实际会注入的思维链文本（'' = 关闭）
        presetCotText(preset) {
            const mode = (preset && preset.cotMode) || 'default';
            if (mode === 'off') return '';
            if (mode === 'custom') return String((preset && preset.cot) || '').trim() ? preset.cot : this.defaultCotPrompt;
            return this.defaultCotPrompt;
        },
        // 🧠 R1+R2：该预设是否填了副字段（决定「走预设三段」还是「走程序默认」）
        presetHasRoles(preset) {
            if (!preset) return false;
            return ['assistant', 'user', 'prefill'].some(k => String(preset[k] ?? '').trim() !== '');
        },
        // 🧭 左导航分区定义（分组标题 + 条目），模板据此渲染
        navGroups() {
            return [
                {
                    title: '本次打标',
                    items: [
                        { key: 'pipeline', icon: '⚙️', label: '执行管线' },
                        { key: 'candidates', icon: '🏷️', label: '候选标签池', badge: this.aiCandidateTags.length || '' },
                        { key: 'extract', icon: '📝', label: 'AI 提取设置' }
                    ]
                },
                {
                    title: '引擎设置',
                    items: [
                        { key: 'vector', icon: '🧠', label: '本地向量', badge: this.useLocalVector ? '开' : '' },
                        { key: 'api', icon: '⚡', label: 'API 引擎' }
                    ]
                },
                {
                    title: '提示词',
                    items: [
                        { key: 'prompts', icon: '📝', label: '系统提示词库', badge: this.systemPromptPresets.length || '' },
                        { key: 'jailbreak', icon: '⚠️', label: '强制破限', badge: this.useJailbreak ? '开' : '' }
                    ]
                }
            ];
        }
    }
};
</script>
