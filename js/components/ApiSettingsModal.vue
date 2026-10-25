<!--
  ApiSettingsModal API 引擎与模型设置弹窗（子组件）
  配置读写逻辑留在父级（持久化/拉取模型），本组件纯 UI + emits
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" @click.self="$emit('close')">
            <div class="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full p-5 shadow-2xl">
                <div class="flex items-center justify-between mb-4 pb-2 border-b border-zinc-800">
                    <h3 class="text-sm font-bold text-amber-400 flex items-center gap-1.5">⚡ API 接口与大模型配置</h3>
                    <button @click="$emit('close')" class="text-zinc-400 hover:text-white">✕</button>
                </div>
                <div class="space-y-3.5 mb-5">
                    <div>
                        <label class="block text-xs text-zinc-400 mb-1">API 接入格式 / 协议类型：</label>
                        <select :value="apiType" @change="onApiTypeChange" class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none cursor-pointer">
                            <option value="openai">OpenAI 兼容格式 (OpenAI / DeepSeek / Kimi / 聚合中转)</option>
                            <option value="anthropic">Anthropic 兼容格式 (Claude 官方或兼容中转)</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs text-zinc-400 mb-1">API Endpoint (接口地址)</label>
                        <input :value="apiEndpoint" @input="$emit('update:apiEndpoint', $event.target.value)" type="text" placeholder="http://127.0.0.1:1234/v1/chat/completions" class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none">
                    </div>
                    <div>
                        <label class="block text-xs text-zinc-400 mb-1">API Key (密钥)</label>
                        <input :value="apiKey" @input="$emit('update:apiKey', $event.target.value)" type="password" placeholder="sk-... 或留空" class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none">
                    </div>
                    <div>
                        <div class="flex items-center justify-between mb-1">
                            <label class="text-xs text-zinc-400">模型名称 (Model Name)</label>
                            <button @click="$emit('fetch-models')" :disabled="isFetchingModels" class="text-[10px] text-indigo-400 hover:underline">
                                {{ isFetchingModels ? '⏳ 正在拉取...' : '🔄 自动拉取服务端模型' }}
                            </button>
                        </div>
                        <!-- 🐛 AI-22：拉取成功后**不切换控件形态**（旧实现 v-if/v-else 把 input 换成 select，
                             而 select 的 option 只来自服务端返回 ⇒ 手填的私有模型名在界面上「消失」，用户
                             误以为配置被清空）。现在统一用一个 input + datalist：既能自由手填，又能从拉取
                             到的候选里选；`apiModel` 永远完整显示，不依赖候选列表。
                             ⚠️ datalist 用**全局** `#model-suggestions`（App.vue 常驻），HTML 规定一个 input
                                只能绑一个 datalist，因此动态候选由 App.vue 合并进那一个列表。 -->
                        <input :value="apiModel" @input="$emit('update:apiModel', $event.target.value)" list="model-suggestions" type="text" placeholder="例: gpt-4o, local-model" class="w-full bg-zinc-800 border rounded px-3 py-1.5 text-xs text-zinc-200 focus:outline-none" :class="availableModels.length > 0 ? 'border-indigo-500' : 'border-zinc-700'">
                        <p v-if="availableModels.length > 0 && apiModel && !availableModels.includes(apiModel)" class="text-[10px] text-amber-400 mt-1">
                            ⚠️ 当前模型不在服务端返回的 {{ availableModels.length }} 个候选中（可能是自定义/私有模型，已原样保留）
                        </p>
                        <p v-else-if="availableModels.length > 0" class="text-[10px] text-zinc-500 mt-1">
                            已拉取 {{ availableModels.length }} 个候选 · 输入框可直接手填，或从候选中选
                        </p>
                    </div>
                    <p v-if="fetchModelStatus" class="text-[10px]" :class="fetchModelStatus.includes('❌') ? 'text-red-400' : 'text-emerald-400'">{{ fetchModelStatus }}</p>
                    <div class="border-t border-zinc-800 pt-3">
                        <label class="block text-xs text-zinc-400 mb-1">🍻 酒馆本地目录（物理推送绑定）：</label>
                        <div class="flex items-center gap-2">
                            <input :value="tavernLocalPath || '（未绑定）'" readonly type="text" class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-300 truncate focus:outline-none" :title="tavernLocalPath">
                            <button @click="$emit('rebind-path')" class="px-2 py-1.5 bg-zinc-700 hover:bg-indigo-600 text-white rounded text-[11px] shrink-0 transition" title="重新选择酒馆根目录">📁 重新选择</button>
                            <button v-if="tavernLocalPath" @click="$emit('clear-path')" class="px-2 py-1.5 bg-zinc-700 hover:bg-rose-600 text-white rounded text-[11px] shrink-0 transition" title="解除绑定">✕</button>
                        </div>
                    </div>
                    <p class="text-[10px] text-zinc-500 leading-relaxed">设置自动保存，重启后自动恢复；与 AI 打标 / 聊天测卡实时同步。</p>
                </div>
                <div class="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                    <button @click="$emit('close')" class="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-xs font-bold rounded shadow">关闭</button>
                    <button @click="$emit('save')" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded shadow flex items-center gap-1.5">💾 保存 API 配置</button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'ApiSettingsModal',
    props: {
        show: { type: Boolean, default: false },
        apiType: { type: String, default: 'openai' },
        apiEndpoint: { type: String, default: '' },
        apiKey: { type: String, default: '' },
        apiModel: { type: String, default: '' },
        availableModels: { type: Array, default: () => [] },
        isFetchingModels: { type: Boolean, default: false },
        fetchModelStatus: { type: String, default: '' },
        tavernLocalPath: { type: String, default: '' }
    },
    emits: ['close', 'update:apiType', 'api-type-change', 'update:apiEndpoint', 'update:apiKey', 'update:apiModel', 'fetch-models', 'rebind-path', 'clear-path', 'save'],
    methods: {
        onApiTypeChange(e) {
            this.$emit('update:apiType', e.target.value);
            this.$emit('api-type-change');
        }
    }
};
</script>
