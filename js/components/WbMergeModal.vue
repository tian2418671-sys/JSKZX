<!--
  WbMergeModal 多本世界书智能合并弹窗（子组件）
  合并执行逻辑留在父级，本组件勾选目标书 + emits
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-amber-500/10">
                <span class="text-base font-bold text-amber-500">🔗 多本世界书智能合并</span>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <div class="p-4 flex-1 overflow-y-auto custom-scrollbar space-y-2">
                <p class="text-xs text-zinc-400 mb-2">请勾选需要合并的世界书（将自动剔除相同的重复词条）：</p>
                <label v-for="wb in worldbooks" :key="wb.path" class="flex items-center gap-3 p-2.5 bg-zinc-900/50 border border-zinc-700 rounded-lg cursor-pointer hover:border-amber-500/50 transition">
                    <input type="checkbox" :checked="selectedPaths.includes(wb.path)" @change="togglePath(wb.path, $event.target.checked)" class="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0">
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-xs font-bold text-zinc-200 truncate">{{ wbNameOf(wb) }}</span>
                        <span class="text-[10px] text-zinc-500 font-mono">{{ wbCountOf(wb) }} 个词条 | {{ wb.name }}</span>
                    </div>
                </label>
            </div>

            <div class="p-3 border-t border-zinc-800 flex justify-between items-center shrink-0 bg-zinc-900/50">
                <span class="text-xs text-amber-400 font-mono">已选 {{ selectedPaths.length }} 本</span>
                <div class="flex gap-2">
                    <button @click="$emit('close')" class="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300">取消</button>
                    <button @click="$emit('merge')" class="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded shadow transition">🚀 开始合并</button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'WbMergeModal',
    props: {
        show: { type: Boolean, default: false },
        worldbooks: { type: Array, default: () => [] },
        selectedPaths: { type: Array, default: () => [] }
    },
    emits: ['close', 'update:selectedPaths', 'merge'],
    methods: {
        togglePath(path, checked) {
            const next = checked
                ? [...this.selectedPaths, path]
                : this.selectedPaths.filter(p => p !== path);
            this.$emit('update:selectedPaths', next);
        },
        // ⚡ PK-26：秒开后 `wb.data` 为 null → 书名/词条数走**轻量字段**（否则全显「0 个词条」）
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
