<!--
  DiffModal 数据版本差异深度比对 (Diff Inspector) 弹窗（子组件）
  纯展示组件：差异计算逻辑留在父级，本组件渲染两侧对比
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[110] bg-black/85 backdrop-blur-md flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-6xl w-full h-[90vh] flex flex-col shadow-2xl overflow-hidden">

            <div class="px-5 py-3 border-b border-zinc-800 bg-zinc-900/90 flex items-center justify-between shrink-0">
                <div class="flex items-center gap-3">
                    <span class="text-base font-bold text-amber-400">⚖️ 数据版本差异深度比对 (Diff Inspector)</span>
                    <span class="text-xs text-zinc-400 font-mono">👑 推荐保留版 vs 🔍 对比版</span>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg transition">✕</button>
            </div>

            <div class="grid grid-cols-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0 text-xs font-bold">
                <div class="p-3 border-r border-zinc-800 flex items-center gap-3">
                    <img v-if="masterItem && masterItem.avatar" :src="masterItem.avatar" class="w-10 h-10 rounded object-cover border border-emerald-500/50">
                    <span v-else class="text-3xl opacity-50">{{ iconFor(masterItem) }}</span>
                    <div class="flex flex-col min-w-0">
                        <span class="text-emerald-400 truncate">👑 推荐版: {{ (masterItem && masterItem.data && masterItem.data.name) || (masterItem ? masterItem.name : '未知') }}</span>
                        <span class="text-[10px] text-zinc-500 font-mono truncate">{{ masterItem ? masterItem.path.split(/[\\/]/).pop() : '' }}</span>
                    </div>
                </div>
                <div class="p-3 flex items-center gap-3">
                    <img v-if="compareItem && compareItem.avatar" :src="compareItem.avatar" class="w-10 h-10 rounded object-cover border border-amber-500/50">
                    <span v-else class="text-3xl opacity-50">{{ iconFor(compareItem) }}</span>
                    <div class="flex flex-col min-w-0">
                        <span class="text-amber-400 truncate">🔍 对比版: {{ (compareItem && compareItem.data && compareItem.data.name) || (compareItem ? compareItem.name : '未知') }}</span>
                        <span class="text-[10px] text-zinc-500 font-mono truncate">{{ compareItem ? compareItem.path.split(/[\\/]/).pop() : '' }}</span>
                    </div>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-5">
                <div v-for="(f, idx) in fieldResults" :key="idx" class="bg-zinc-900/50 border border-zinc-800 rounded-xl p-3 shadow-md">

                    <div class="flex items-center justify-between mb-2 pb-2 border-b border-zinc-800/80">
                        <span class="text-xs font-bold text-zinc-200">{{ f.label }}</span>
                        <span class="text-[10px] px-2 py-0.5 rounded font-mono font-bold"
                              :class="f.isSame ? 'bg-zinc-800 text-zinc-500' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'">
                            {{ f.isSame ? '✅ 设定完全一致' : `⚠️ 存在差异 (${f.len1} vs ${f.len2})` }}
                        </span>
                    </div>

                    <template v-if="f.isTags">
                        <div class="grid grid-cols-2 gap-4 text-xs">
                            <div class="border-r border-zinc-800 pr-2">
                                <span class="text-[10px] text-zinc-500 block mb-1">左版独有:</span>
                                <div class="flex flex-wrap gap-1">
                                    <span v-for="t in f.onlyMasterTags" :key="t" class="bg-emerald-900/40 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded text-[10px]">+ {{ t }}</span>
                                    <span v-if="!f.onlyMasterTags.length" class="text-zinc-600 italic">无</span>
                                </div>
                            </div>
                            <div>
                                <span class="text-[10px] text-zinc-500 block mb-1">右版独有:</span>
                                <div class="flex flex-wrap gap-1">
                                    <span v-for="t in f.onlyCompareTags" :key="t" class="bg-amber-900/40 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded text-[10px]">+ {{ t }}</span>
                                    <span v-if="!f.onlyCompareTags.length" class="text-zinc-600 italic">无</span>
                                </div>
                            </div>
                        </div>
                    </template>

                    <template v-else>
                        <div v-if="f.isSame" class="text-[11px] text-zinc-500 italic px-2 py-1">
                            两版内容完全一致，已自动折叠展示。
                        </div>
                        <div v-else class="grid grid-cols-2 gap-3 text-xs font-mono">
                            <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                <template v-for="(line, lIdx) in f.diffText.masterLines" :key="lIdx">
                                    <div :class="line.type === 'removed' ? 'bg-rose-950/60 text-rose-300 border-l-2 border-rose-500 px-1 my-0.5' : 'text-zinc-500 opacity-50'">
                                        {{ line.text || ' ' }}
                                    </div>
                                </template>
                            </div>
                            <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                <template v-for="(line, lIdx) in f.diffText.compareLines" :key="lIdx">
                                    <div :class="line.type === 'added' ? 'bg-emerald-950/60 text-emerald-300 border-l-2 border-emerald-500 px-1 my-0.5' : 'text-zinc-500 opacity-50'">
                                        {{ line.text || ' ' }}
                                    </div>
                                </template>
                            </div>
                        </div>
                    </template>

                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'DiffModal',
    props: {
        show: { type: Boolean, default: false },
        masterItem: { type: Object, default: null },
        compareItem: { type: Object, default: null },
        fieldResults: { type: Array, default: () => [] }
    },
    emits: ['close'],
    methods: {
        // 依据数据形态返回类型图标：世界书 🌍 / 预设 ⚙️ / 角色卡 🎎
        iconFor(item) {
            if (!item || !item.data) return '🎎';
            if (Array.isArray(item.data.entries)) return '🌍';
            if ('temperature' in item.data || 'prompts' in item.data || 'prompt_order' in item.data) return '⚙️';
            return '🎎';
        }
    }
};
</script>
