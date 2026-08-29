<!--
  ContentDedupeModal 内容级跨名称版本查重弹窗（子组件）
  扫描/清理逻辑留在父级，本组件展示聚类结果 + emits 操作
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-5xl w-full h-[80vh] flex flex-col shadow-2xl overflow-hidden">

            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-purple-500/10">
                <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-purple-400">🧬 内容级版本查重中心</span>
                    <span class="text-xs text-zinc-400">识别改名/复制的重复内容（与名称无关）</span>
                    <span class="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full font-mono">
                        发现 {{ groups.length }} 组疑似重复
                    </span>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <div class="flex-1 overflow-y-auto p-5 custom-scrollbar space-y-5">
                <div v-for="(group, gIdx) in groups" :key="gIdx" class="bg-zinc-900/50 border border-zinc-700/80 rounded-xl p-4">

                    <div class="mb-3 flex items-center justify-between">
                        <span class="text-sm font-bold text-purple-400">『{{ group.name }}』</span>
                        <span class="text-xs text-zinc-500">共 {{ group.list.length }} 个内容高度相似的版本</span>
                    </div>

                    <div class="flex gap-3 overflow-x-auto custom-scrollbar pb-2">
                        <div v-for="(v, vIdx) in group.list" :key="vIdx"
                             class="flex-shrink-0 w-64 bg-zinc-800/80 border rounded-lg p-3 flex flex-col justify-between"
                             :class="vIdx === 0 ? 'border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.15)]' : 'border-zinc-700'">

                            <div>
                                <div class="text-xs font-bold truncate mb-1" :title="v._name">📄 {{ v._name }}</div>
                                <div class="text-[11px] font-mono text-purple-300 mb-1">
                                    🧬 相似度: {{ v._simPct }}%
                                </div>
                                <div class="text-[10px] text-zinc-500 font-mono mb-1">
                                    {{ v._sizeKb }} KB
                                </div>
                                <div class="text-[10px] text-zinc-500 font-mono mb-2">
                                    🕒 {{ v._dateStr }}
                                </div>
                                <div class="text-[10px] text-zinc-400 font-mono truncate mb-2" :title="v.item.path">
                                    📁 {{ v.item.path.split(/[\\/]/).pop() }}
                                </div>
                                <div class="text-[10px] px-2 py-1 rounded font-bold mb-3 bg-purple-500/10 text-purple-300 border border-purple-500/30">
                                    {{ vIdx === 0 ? '👑 内容最完整（推荐保留）' : (v._simPct >= 98 ? '🧬 内容几乎完全一致' : '⚠️ 高度相似，细节有差异') }}
                                </div>
                            </div>

                            <div>
                                <button v-if="vIdx !== 0"
                                        @click="$emit('open-diff', group.list[0].item, v.item)"
                                        class="w-full px-2.5 py-1.5 mb-2 bg-zinc-800 hover:bg-zinc-700 text-purple-300 border border-purple-500/30 text-[11px] font-bold rounded shadow transition shrink-0">
                                    🔍 查看内容差异
                                </button>
                                <button @click="$emit('resolve-group', gIdx, v.item.path)"
                                        :class="vIdx === 0 ? 'bg-purple-600 hover:bg-purple-500' : 'bg-zinc-700 hover:bg-zinc-600'"
                                        class="w-full py-1.5 text-white text-xs font-bold rounded shadow transition">
                                    <span v-if="vIdx === 0">✅ 保留此版，清理其余</span>
                                    <span v-else>⚠️ 保留此版本</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="groups.length === 0" class="text-center py-12 text-zinc-500 text-sm">
                    🎉 未发现内容高度相似的重复项
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'ContentDedupeModal',
    props: {
        show: { type: Boolean, default: false },
        groups: { type: Array, default: () => [] }
    },
    emits: ['close', 'open-diff', 'resolve-group']
};
</script>
