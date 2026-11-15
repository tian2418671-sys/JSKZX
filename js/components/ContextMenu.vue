<!--
  ContextMenu 右键快捷菜单（子组件）
  操作逻辑留在父级（handleContextMenuAction / 预设与插件的 action 闭包），本组件纯 UI + emits

  两种模式：
    ① 动态模式：item.items 是非空数组 ⇒ 按它逐条渲染（预设库 / 插件库走这条）
    ② 默认模式：没有 item.items ⇒ 渲染角色卡的 11 个固定项（保持历史行为不变）

  🐞 2026-11-15（用户报）：预设库右击弹出的是**角色卡菜单**（换卡图 / 导出 PNG / 推送目标 / AI 打标…），
     点下去要么报错要么无效，头部还显示「未知角色」。
     根因：预设与插件各自往 contextMenu.value 里塞了 items，但本组件写死了角色卡菜单、根本不读 items，
     且它们没设 item 字段 ⇒ 头部 fallback 成「未知角色」。
-->
<template>
    <transition name="fade">
        <div v-if="visible"
             class="fixed z-[100] min-w-[210px] theme-surface border border-zinc-700/80 rounded-lg shadow-2xl py-1.5 text-xs flex flex-col"
             :style="{ top: y + 'px', left: x + 'px' }"
             @click.stop>

            <!-- 卡片 / 条目信息头 -->
            <div class="px-3 py-1.5 border-b border-zinc-700/50 mb-1 flex flex-col">
                <span class="font-bold text-amber-400 truncate">{{ item?.name || '未知角色' }}</span>
                <span class="text-[9px] opacity-50 truncate font-mono mt-0.5" :title="item?.path">
                    {{ item?.path?.split(/[\\/]/).pop() }}
                </span>
            </div>

            <!-- ① 动态模式：预设 / 插件自带菜单项 -->
            <template v-if="hasCustomItems">
                <template v-for="(it, i) in item.items" :key="'c' + i">
                    <div v-if="it && it.type === 'separator'" class="h-px bg-zinc-700/50 my-1 mx-2"></div>
                    <button v-else-if="it" @click.stop="runItem(it)"
                            class="w-full text-left px-3 py-2 flex items-center gap-2 transition-colors"
                            :class="it.danger ? 'hover:bg-rose-600 hover:text-white text-rose-400' : 'hover:bg-indigo-600 hover:text-white'">
                        {{ it.label }}
                    </button>
                </template>
            </template>

            <!-- ② 默认模式：角色卡菜单 -->
            <template v-else>
                <button @click="$emit('view')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">👁️</span> 查看 / 编辑卡片
                </button>
                <button @click.stop="$emit('open-folder')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">📁</span> 在资源管理器中打开
                </button>
                <button @click.stop="$emit('duplicate')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">📋</span> 创建卡片物理副本
                </button>

                <div class="h-px bg-zinc-700/50 my-1 mx-2"></div>

                <button @click.stop="$emit('move-group')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">📂</span> 移动到指定分组...
                </button>
                <button @click.stop="$emit('snapshots')" class="w-full text-left px-3 py-2 hover:bg-amber-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">📸</span> 历史快照 / 一键恢复...
                </button>
                <button @click.stop="$emit('replace-image')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">🖼️</span> 换卡图
                </button>
                <button @click="$emit('export')" class="w-full text-left px-3 py-2 hover:bg-indigo-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">💾</span> 导出单张卡片 (PNG)
                </button>
                <button @click.stop="$emit('push-target')" class="w-full text-left px-3 py-2 hover:bg-emerald-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">🚀</span> 推送到当前目标
                </button>
                <button @click.stop="$emit('ai-tag')" class="w-full text-left px-3 py-2 hover:bg-amber-600 hover:text-white flex items-center gap-2 transition-colors">
                    <span class="text-sm">🤖</span> 单卡快捷 AI 打标...
                </button>

                <div class="h-px bg-zinc-700/50 my-1 mx-2"></div>

                <button @click.stop="$emit('trash')" class="w-full text-left px-3 py-2 hover:bg-rose-600 hover:text-white flex items-center gap-2 transition-colors text-rose-400">
                    <span class="text-sm">🗑️</span> 移入安全回收站
                </button>
            </template>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'ContextMenu',
    props: {
        visible: { type: Boolean, default: false },
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 },
        item: { type: Object, default: null }
    },
    emits: ['view', 'open-folder', 'duplicate', 'move-group', 'snapshots', 'replace-image', 'export', 'push-target', 'ai-tag', 'trash', 'close'],
    computed: {
        /** 是否走「动态菜单项」模式（预设库 / 插件库） */
        hasCustomItems() {
            return !!(this.item && Array.isArray(this.item.items) && this.item.items.length > 0);
        }
    },
    methods: {
        /** 执行动态菜单项的回调，并关闭菜单（否则 action 里再开弹窗时菜单会叠在上面） */
        runItem(it) {
            try {
                if (typeof it.action === 'function') it.action();
            } catch (e) {
                // 不吞掉：带上菜单项名称便于定位
                console.error('[ContextMenu] 菜单项执行失败:', it.label, e);
            } finally {
                this.$emit('close');
            }
        }
    }
};
</script>
