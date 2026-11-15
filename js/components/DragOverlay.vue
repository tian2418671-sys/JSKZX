<!--
  DragOverlay 拖拽导入全屏遮罩（纯展示组件）
  拖文件到窗口任意处时提示松开导入
  ⚠️ 文案用「文件」而非「角色卡」—— 2026-10-25 用户要求：
     现在拖入支持角色卡 / 世界书 / 预设 / 插件脚本，说「角色卡」会让人误以为只能拖卡。
-->
<template>
    <transition name="fade">
        <div v-if="isDragging" class="fixed inset-0 bg-blue-900/40 backdrop-blur-sm flex items-center justify-center border-8 border-blue-500 border-dashed pointer-events-none" style="z-index: 9999;">
            <div class="text-4xl font-bold text-white flex flex-col items-center gap-4" style="text-shadow: 0 0 15px rgba(59,130,246,0.8);">
                <span class="text-6xl">📥</span>
                <span>松开鼠标，立即导入文件</span>
                <span class="text-sm font-normal text-blue-100/90">支持角色卡 · 世界书 · 预设 · 插件脚本</span>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'DragOverlay',
    props: {
        isDragging: { type: Boolean, default: false }
    }
};
</script>
