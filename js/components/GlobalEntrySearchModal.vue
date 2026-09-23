<!--
  GlobalEntrySearchModal 全库词条搜索弹窗（子组件）
  索引/搜索/跳转逻辑留在父级，本组件纯展示 + emits
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-3xl w-full h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-blue-500/10">
                <span class="text-base font-bold text-blue-400">🔎 全库词条搜索</span>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <div class="px-4 pt-3 shrink-0">
                <div class="relative">
                    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500">🔍</span>
                    <input :value="query" @input="$emit('update:query', $event.target.value)" type="text" autofocus
                           placeholder="搜索触发词 / 正文 / 备注 / 来源名（跨独立世界书 + 角色卡内嵌世界书）..."
                           class="w-full h-9 bg-zinc-900 border border-zinc-700 rounded pl-9 pr-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500">
                </div>
                <div class="text-[10px] text-zinc-500 mt-1.5 mb-2">
                    <span v-if="indexing" class="text-amber-400">⏳ 正在建立全库索引…（部分世界书需按需读取正文）</span>
                    <template v-else>
                        共索引 {{ indexCount }} 条词条<span v-if="query.trim()">，命中 <span class="text-blue-400 font-bold">{{ results.length }}</span> 条</span>
                    </template>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto px-4 pb-4 space-y-2 custom-scrollbar">
                <div v-if="indexing && indexCount === 0" class="text-center py-16 text-zinc-500 text-xs">⏳ 正在建立全库索引，请稍候…</div>
                <div v-else-if="!query.trim()" class="text-center py-16 text-zinc-500 text-xs">👆 输入关键词开始全库搜索</div>
                <div v-else-if="results.length === 0" class="text-center py-16 text-zinc-500 text-xs">未找到匹配词条</div>

                <div v-else v-for="(r, i) in results" :key="i" @click="$emit('jump', r)"
                     class="bg-zinc-900/60 border border-zinc-700/70 hover:border-blue-500/50 rounded-lg p-3 cursor-pointer transition">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-[10px] px-1.5 py-0.5 rounded font-bold"
                              :class="r.sourceType === 'worldbook' ? 'bg-amber-500/20 text-amber-400' : 'bg-indigo-500/20 text-indigo-400'">
                            {{ r.sourceType === 'worldbook' ? '🌍 世界书' : '🎴 角色卡' }}
                        </span>
                        <span class="text-xs font-bold text-zinc-200 truncate">{{ r.sourceName }}</span>
                        <span v-if="!r.enabled" class="text-[10px] text-zinc-500">· 停用</span>
                    </div>
                    <div class="flex flex-wrap gap-1 mb-1.5" v-if="r.keys.length">
                        <span v-for="k in r.keys.slice(0, 8)" :key="k" class="text-[10px] bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded border border-green-500/20">{{ k }}</span>
                        <span v-if="r.keys.length > 8" class="text-[10px] text-zinc-500">+{{ r.keys.length - 8 }}</span>
                    </div>
                    <div class="text-[11px] text-zinc-400 line-clamp-2 font-mono">{{ r.content || '（无正文）' }}</div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'GlobalEntrySearchModal',
    props: {
        show: { type: Boolean, default: false },
        query: { type: String, default: '' },
        results: { type: Array, default: () => [] },
        indexCount: { type: Number, default: 0 },
        // ⚡ PK-26：索引已改异步（秒开后需按需读入世界书正文）——
        //    无此标志时，大库索引期间弹窗会显示「共索引 0 条 / 未找到匹配词条」，用户会判定为坏了。
        indexing: { type: Boolean, default: false }
    },
    emits: ['close', 'update:query', 'jump']
};
</script>
