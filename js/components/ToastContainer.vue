<!--
  ToastContainer 全局 Toast 消息容器（右上角，非阻塞）
  纯展示：接收 toasts 数组渲染消息卡片，自动堆叠动画
-->
<template>
    <!--
      ⚠️ AR-70：z-index 必须**低于弹窗**（本项目弹窗在 z-100 / z-110 / z-120）。
      原值 9999 会让 Toast 盖住一切弹窗（右上角正好压住「✕ 关闭」）⇒ 弹窗关不掉。
      取 90：高于普通内容与侧栏，低于全部弹窗；弹窗打开时 Toast 自动被压到其下方。
    -->
    <div class="fixed top-6 right-6 flex flex-col gap-3 pointer-events-none items-end" style="z-index: 90;">
        <transition-group name="toast" tag="div" class="flex flex-col gap-3 items-end">
            <div v-for="toast in toasts" :key="toast.id"
                 @click="toast.onClick && toast.onClick()"
                 :class="['px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 text-sm font-bold border backdrop-blur-sm',
                          toast.type === 'success' ? 'bg-emerald-600/95 border-emerald-500 text-white' :
                          toast.type === 'error' ? 'bg-rose-600/95 border-rose-500 text-white' :
                          'bg-zinc-800/95 border-zinc-600 text-zinc-200',
                          /* AR-70：只有**可点击**的 Toast 才接收鼠标；纯展示的一律穿透，绝不吞点击 */
                          toast.onClick ? 'cursor-pointer hover:brightness-110 pointer-events-auto' : 'pointer-events-none']"
                 :title="toast.onClick ? '点击查看详情' : ''"
                 style="min-width: 240px; max-width: 400px;">
                <span v-if="toast.type === 'success'" class="text-lg">✅</span>
                <span v-else-if="toast.type === 'error'" class="text-lg">❌</span>
                <span v-else class="text-lg">💡</span>
                <span class="leading-relaxed">{{ toast.message }}</span>
            </div>
        </transition-group>
    </div>
</template>

<script>
export default {
    name: 'ToastContainer',
    props: {
        toasts: { type: Array, default: () => [] }
    }
};
</script>
