<!--
  WbImportModal 条目级导入合并弹窗（子组件）
  源书选择/导入执行逻辑留在父级，本组件提供选择 UI + emits
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-emerald-500/10">
                <span class="text-base font-bold text-emerald-400">🔀 从其他世界书导入词条</span>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <!-- ① 源书选择 -->
            <div class="px-4 pt-3 shrink-0">
                <div class="text-[10px] text-zinc-500 mb-1.5">
                    ① 选择源世界书（将导入到当前编辑的「<span class="text-emerald-400 font-bold">{{ activeWorldbookName }}</span>」）：
                </div>
                <div class="flex flex-wrap gap-1.5">
                    <button v-for="wb in sourceBooks" :key="wb.path"
                            @click="$emit('pick-source', wb)"
                            :class="sourceBook && sourceBook.path === wb.path ? 'bg-emerald-600 text-white border-emerald-500' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border-zinc-700'"
                            class="px-2.5 py-1 rounded border text-xs font-bold transition shrink-0">
                        {{ wbNameOf(wb) }} <span class="opacity-60">({{ wbCountOf(wb) }})</span>
                    </button>
                </div>
            </div>

            <!-- ② 条目勾选 -->
            <div class="p-4 flex-1 overflow-y-auto custom-scrollbar space-y-2">
                <div v-if="!sourceBook" class="text-center py-8 text-zinc-500 text-xs">👈 请先选择一本源世界书</div>
                <label v-for="c in candidates" :key="c._srcUid"
                       class="flex items-start gap-3 p-2.5 bg-zinc-900/50 hover:bg-zinc-800 rounded border border-zinc-700/50 cursor-pointer transition">
                    <input type="checkbox" :checked="selectedEntries.includes(c._srcUid)" @change="toggleEntry(c._srcUid, $event.target.checked)" class="mt-0.5 rounded accent-emerald-500">
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-bold text-emerald-400 truncate" :title="c.comment || c.name || '未命名词条'">{{ c.comment || c.name || '未命名词条' }}</div>
                        <div v-if="Array.isArray(c.key) && c.key.length" class="text-[10px] text-zinc-500 mt-0.5 truncate">🔑 {{ c.key.join(', ') }}</div>
                        <div class="text-[10px] text-zinc-500 mt-0.5 line-clamp-2">{{ c.content || '（无内容）' }}</div>
                    </div>
                </label>
            </div>

            <!-- 底部操作 -->
            <div class="px-5 py-3 border-t border-zinc-800 bg-zinc-900/50 flex items-center justify-between shrink-0">
                <span class="text-xs text-zinc-400">已选 <span class="text-emerald-400 font-bold">{{ selectedEntries.length }}</span> / {{ candidates.length }} 项</span>
                <div class="flex gap-2">
                    <button @click="$emit('close')" class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300">取消</button>
                    <button @click="$emit('confirm-import')" class="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded shadow transition">🚀 确认导入</button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'WbImportModal',
    props: {
        show: { type: Boolean, default: false },
        activeWorldbookName: { type: String, default: '未命名' },
        sourceBooks: { type: Array, default: () => [] },
        sourceBook: { type: Object, default: null },
        candidates: { type: Array, default: () => [] },
        selectedEntries: { type: Array, default: () => [] }
    },
    emits: ['close', 'pick-source', 'update:selectedEntries', 'confirm-import'],
    methods: {
        toggleEntry(uid, checked) {
            const next = checked
                ? [...this.selectedEntries, uid]
                : this.selectedEntries.filter(u => u !== uid);
            this.$emit('update:selectedEntries', next);
        },
        // ⚡ PK-26：秒开后 `wb.data` 为 null（懒加载）→ 书名/词条数必须走**轻量字段**，
        //    否则列表里所有源世界书都显示「0 词条」（用户会以为源库空了）。
        wbNameOf(wb) {
            return (wb && (wb.wbName || (wb.data && wb.data.name) || wb.name)) || '未命名';
        },
        wbCountOf(wb) {
            if (!wb) return 0;
            if (typeof wb.entryCount === 'number') return wb.entryCount;
            return (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries.length : 0;
        }
    }
};
</script>
