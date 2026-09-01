<!--
  AITagModal AI 智能批量打标弹窗（子组件）
  ⚠️ 复杂交互组件：候选池/规则/预设/API 设置全部由父级状态驱动，本组件 emits 回传操作
     注：systemPromptPresets 为响应式数组 props，name/content/expanded 直接编辑嵌套属性（Vue3 允许），
         每次输入后 emit 'save-system-prompts' 让父级持久化
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">

                <div class="px-5 py-4 bg-gray-900 text-white border-b border-gray-800 flex justify-between items-center shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">🤖 AI 智能批量打标 (已选 {{ selectedCount }} 张)</h3>
                    <button @click="$emit('close')" :disabled="isAITagging" class="text-gray-400 hover:text-white disabled:opacity-50">✕ 关闭</button>
                </div>

                <div class="p-5 overflow-y-auto space-y-5 flex-1 custom-scrollbar text-xs">

                    <!-- 🏷️ 1. 候选标签池 -->
                    <div class="bg-gray-50 p-3 rounded-lg border border-gray-200">
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

                        <div class="text-[11px] text-gray-500 mb-1">💡 快速点击添加系统/常用标签（✕ 可彻底删除）：</div>
                        <div class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 custom-scrollbar">
                            <div v-for="tag in systemCommonTags" :key="tag" class="group flex items-center shadow-sm rounded">
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
                    </div>

                    <!-- 🧠 1.5 本地向量引擎（三层漏斗第二层：免费离线语义匹配） -->
                    <div class="bg-gray-50 p-3 rounded-lg border border-gray-200">
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
                            <!-- 📝 规则层入口（第一层规则 + 第二层向量配合，未命中才进第三层 LLM） -->
                            <div class="flex items-center justify-between pt-2 border-t border-gray-200">
                                <span class="text-[10px] text-gray-500">① 第一层：规则匹配（系统预设已内置，可自定义）</span>
                                <button @click="$emit('open-auto-tag-rules')" class="px-2 py-1 bg-purple-600/10 hover:bg-purple-600 hover:text-white border border-purple-300 text-purple-700 rounded text-[11px] transition" title="编辑自动打标规则表（导入自动分类 / AI 打标第一层共用）">📝 管理规则表</button>
                            </div>
                        </div>
                    </div>

                    <!-- 🤖 2. AI 打标规则设置 -->
                    <div class="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
                        <h4 class="text-sm font-bold text-gray-700">🤖 AI 打标规则设置</h4>

                        <label class="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" :checked="enableAIExtraction" @change="$emit('update:enableAIExtraction', $event.target.checked)" :disabled="isAITagging"
                                   class="w-4 h-4 text-blue-600 bg-white border-gray-300 rounded focus:ring-blue-600 focus:ring-2">
                            <span class="text-sm text-gray-700">允许 AI 自由提取标签</span>
                        </label>
                        <p class="text-[10px] text-gray-500 ml-6 -mt-1">关闭后，AI 将<strong class="text-rose-500">严格只能</strong>从上方的候选池中为你选择标签，不会自行创造新标签。</p>

                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-600">附加自定义提示词 (可选)</label>
                            <textarea :value="customAIPrompt" @input="$emit('update:customAIPrompt', $event.target.value)" :disabled="isAITagging" rows="2"
                                      placeholder="例如：请重点分析角色的性格特征，忽略外观描述..."
                                      class="w-full bg-white border border-gray-300 rounded p-2 text-xs text-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-400 resize-y shadow-sm"></textarea>
                        </div>

                        <!-- 🚨 破限 (Jailbreak) 强制越狱：对抗模型拒答及道德审查，破限词自动保存 -->
                        <div class="mt-3 border border-rose-300 bg-rose-50 rounded-lg p-3">
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
                                    <textarea :value="jailbreakPrompt" @input="$emit('update:jailbreakPrompt', $event.target.value)" :disabled="isAITagging" rows="3"
                                              class="w-full bg-white/80 border border-rose-300 rounded p-2 text-xs text-rose-800 focus:border-rose-500 focus:outline-none resize-y shadow-sm placeholder-rose-400 custom-scrollbar"
                                              placeholder="输入你的强力破限咒语 (Jailbreak Prompt)..."></textarea>
                                    <p class="text-[10px] text-rose-500/80 mt-1">💡 破限词自动拼接在系统提示词最末尾（注意力权重最高），输入一次永久保存，重启不丢。</p>
                                </div>
                            </transition>
                        </div>
                    </div>

                    <!-- 📝 3. 系统级微调全局提示词预设库 -->
                    <div>
                        <label class="block font-bold text-gray-700 mb-2 flex justify-between items-center">
                            <span>📝 3. 系统级微调全局提示词 (System Prompts):</span>
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
                                        <label class="block text-[10px] text-gray-500 mb-1">System Prompt 详细内容设定：</label>
                                        <textarea v-model="preset.content" @input="$emit('save-system-prompts')" :disabled="isAITagging" rows="3" class="w-full bg-white border border-gray-300 rounded p-2 text-gray-700 font-mono text-xs focus:border-indigo-500 focus:outline-none resize-y shadow-sm" placeholder="在此输入给 AI 的系统级微调指令..."></textarea>
                                    </div>
                                </div>
                            </div>
                            <p class="text-[10px] text-gray-500 mt-2">
                                💡 勾选左侧单选按钮指定当前 AI 打标生效的系统提示词，支持随时折叠管理、自动保存。
                            </p>
                        </div>
                    </div>

                    <div class="bg-gray-50 border border-gray-200 rounded-lg p-3.5 shadow-inner">
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
                        <div>
                            <label class="block text-[11px] text-gray-600 mb-1 flex justify-between items-center">
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

                    <div v-if="isAITagging || aiTaggingProgress.total > 0" class="p-4 bg-gray-50 border border-gray-200 rounded-lg shadow-inner">
                        <div class="flex justify-between items-center mb-2 font-bold text-gray-700 text-sm">
                            <span>{{ aiTaggingProgress.status }}</span>
                            <span class="text-blue-600">{{ aiTaggingProgress.current }} / {{ aiTaggingProgress.total }}</span>
                        </div>
                        <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden shadow-sm">
                            <div class="bg-blue-600 h-3 rounded-full transition-all duration-300" :style="{ width: (aiTaggingProgress.current / (aiTaggingProgress.total || 1) * 100) + '%' }"></div>
                        </div>
                    </div>
                </div>

                <div class="px-5 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 shrink-0">
                    <button @click="$emit('close')" :disabled="isAITagging" class="px-5 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-50 transition">取消</button>
                    <button @click="$emit('start-tagging')" :disabled="isAITagging" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold disabled:opacity-75 flex items-center gap-2 shadow-md transition">
                        <svg v-if="isAITagging" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        {{ isAITagging ? '打标处理中...' : '🚀 开始智能打标' }}
                    </button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
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
        vectorDownloadSource: { type: Object, default: () => ({ source: '', attempt: 0, total: 0, label: '' }) }
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
        'open-auto-tag-rules'
    ]
};
</script>
