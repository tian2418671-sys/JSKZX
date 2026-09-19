<!--
  CardPluginModal 卡内插件脚本 · 全屏放大编辑器
  ------------------------------------------------------------
  用途：角色卡工作区「插件」页签里点「⛶ 放大」时打开，用**项目已有**的 CodeEditor
       （CodeMirror 6：语法高亮 / 行号 / 查找替换 / ✨ 格式化）全屏编辑该脚本正文。
  为什么单独做成组件：项目全局样式给 `.border/.border-b/.border-r/.border-t` 加了
       `transform: translateZ(0)`（见 App.vue 末段 DPI 锐化样式），带这些类的祖先会成为
       fixed 定位的包含块 → 页签内部的 `fixed inset-0` 会跑偏。放在 App.vue 顶层（#app 内）
       与其它弹窗一致才不会出这个问题（缺陷记录：弹窗必须在 #app 内）。
  数据流：不自己保存 —— 编辑实时 `emit('field', 字段, 值)` 交给 useCardPlugins 写回卡片数据，
          最终由「保存卡片」写盘。
-->
<template>
    <div class="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" @click.self="$emit('close')">
        <div class="w-[95vw] h-[92vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden shadow-2xl">
            <!-- 顶部工具栏 -->
            <header class="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/95 shrink-0">
                <span class="text-base shrink-0">📜</span>
                <div class="min-w-0 flex flex-col">
                    <span class="text-xs font-bold text-cyan-400">卡内插件 · 酒馆助手脚本</span>
                    <span class="text-[10px] text-zinc-500 font-mono truncate" :title="sourcePath">{{ sourcePath || 'extensions.tavern_helper.scripts' }}</span>
                </div>
                <input :value="item.name" @input="$emit('field', 'name', $event.target.value)"
                       class="ml-2 flex-1 min-w-0 max-w-md bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-100 focus:border-cyan-500 focus:outline-none"
                       placeholder="脚本名称">
                <span class="text-[10px] text-zinc-500 font-mono shrink-0 whitespace-nowrap">{{ item.lines }} 行 / {{ item.chars }} 字符</span>
                <label class="flex items-center gap-1.5 text-[11px] shrink-0 cursor-pointer select-none">
                    <input type="checkbox" :checked="item.enabled" @change="$emit('field', 'enabled', $event.target.checked)" class="rounded bg-zinc-900 border-zinc-700 accent-cyan-500">
                    <span :class="item.enabled ? 'text-emerald-400 font-bold' : 'text-zinc-500'">{{ item.enabled ? '已启用' : '已停用' }}</span>
                </label>
                <span class="text-[10px] text-zinc-600 shrink-0">✨ 格式化 Ctrl+Shift+F · 查找 Ctrl+F · Esc 关闭</span>
                <button @click="$emit('close')" class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-xs text-zinc-200 transition shrink-0">✕ 关闭</button>
            </header>

            <!-- 正文：复用项目已有 CodeEditor（CodeMirror） -->
            <div class="flex-1 min-h-0">
                <CodeEditor :model-value="item.content" language="javascript" height="100%"
                            @update:model-value="$emit('field', 'content', $event)" />
            </div>
        </div>
    </div>
</template>

<script>
import { onMounted, onBeforeUnmount } from 'vue';
import CodeEditor from './CodeEditor.vue'; // 💻 轻量代码编辑器（CodeMirror：语法高亮/行号/查找/格式化）

export default {
    name: 'CardPluginModal',
    components: { CodeEditor },
    props: {
        // 脚本条目模型（useCardPlugins → buildScriptItem 产出：name/content/enabled/lines/chars/...）
        item: { type: Object, required: true },
        sourcePath: { type: String, default: '' }
    },
    emits: ['close', 'field'],
    setup(props, { emit }) {
        const onKeydown = (e) => {
            if (e.key === 'Escape') emit('close');
        };
        onMounted(() => window.addEventListener('keydown', onKeydown));
        onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
        return {};
    }
};
</script>
