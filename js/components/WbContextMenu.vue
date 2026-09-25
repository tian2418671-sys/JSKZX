<!--
  WbContextMenu 世界书右键快捷菜单（子组件）
  操作逻辑留在父级（openWbInFolder/renameWorldbook 等），本组件纯 UI + emits
-->
<template>
    <transition name="fade">
        <div v-if="show"
             class="fixed z-[100] w-44 theme-surface border border-zinc-700/80 rounded-lg shadow-2xl py-1.5 text-xs flex flex-col"
             :style="{ top: y + 'px', left: x + 'px' }"
             @click.stop>

            <!-- 世界书信息头 -->
            <div class="px-3 py-1.5 border-b border-zinc-700/50 mb-1">
                <span class="font-bold text-amber-400 truncate block">{{ wb?.data?.name || wb?.name || '未知世界书' }}</span>
                <span class="text-[9px] opacity-50 truncate font-mono mt-0.5 block" :title="wb?.path">
                    {{ wb?.path?.split(/[\\/]/).pop() || '（内存导入）' }}
                </span>
            </div>

            <button @click="$emit('open-folder')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                <span class="text-sm">📁</span> 在资源管理器中打开
            </button>
            <button @click="$emit('rename')" class="w-full text-left px-3 py-2 hover:bg-blue-600 hover:text-white flex items-center gap-2 transition-colors">
                <span class="text-sm">✏️</span> 重命名世界书
            </button>
            <!-- 🏷️ S1（2026-09-25）：标签编辑入口（标签存配置层，不写入世界书文件） -->
            <button @click="$emit('edit-tags')" class="w-full text-left px-3 py-2 hover:bg-amber-600 hover:text-white flex items-center gap-2 transition-colors">
                <span class="text-sm">🏷️</span> 编辑标签
            </button>
            <!-- 🤖 S3（2026-09-25）：对该书 AI 智能打标（统一入口按视图分发的右键快捷通道） -->
            <button @click="$emit('ai-tag')" class="w-full text-left px-3 py-2 hover:bg-amber-600 hover:text-white flex items-center gap-2 transition-colors">
                <span class="text-sm">🤖</span> AI 打标
            </button>
            <button @click="$emit('duplicate')" class="w-full text-left px-3 py-2 hover:bg-emerald-600 hover:text-white flex items-center gap-2 transition-colors">
                <span class="text-sm">📋</span> 复制为副本
            </button>
            <button @click="$emit('move-group')" class="w-full text-left px-3 py-2 hover:bg-purple-600 hover:text-white flex items-center gap-2 transition-colors">
                <span class="text-sm">📁</span> 移动分组
            </button>

            <div class="h-px bg-zinc-700/50 my-1 mx-2"></div>

            <button @click="$emit('delete')" class="w-full text-left px-3 py-2 hover:bg-rose-600 hover:text-white flex items-center gap-2 transition-colors text-rose-400">
                <span class="text-sm">🗑️</span> 删除世界书
            </button>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'WbContextMenu',
    props: {
        show: { type: Boolean, default: false },
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 },
        wb: { type: Object, default: null }
    },
    emits: ['open-folder', 'rename', 'edit-tags', 'ai-tag', 'duplicate', 'move-group', 'delete']
};
</script>
