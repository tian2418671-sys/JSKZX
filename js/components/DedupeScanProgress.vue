<!--
  DedupeScanProgress 查重 / 版本对比的扫描进度条（子组件）
  ---------------------------------------------------------------
  · 纯展示组件：只吃 props（scanning / progress / percent / label / tone），不持有任何状态。
  · 为什么单独成组件：WbDedupeModal / DedupeModal / ContentDedupeModal 三处都要用，
    复制三遍必然走样（历史上进度条就是被挂到了错误的位置 —— 见 SidebarPanel.vue 的留痕注释）。

  ⚠️ 设计定位（2026-09-22 用户拍板，务必不要改回去）：
    进度条属于「**查重 / 版本对比**」流程，不属于「浏览 / 加载库」。
    规格依据：`docs/规格与计划/查重引擎/查重扫描与检索-最终方案.md`
      · TC-07：「上百本世界书查重：有进度指示 + 当前项名，平滑前推至 100%」
      · §185：「进度应挂到扫描阶段」
-->
<template>
    <div v-if="visible" class="px-5 py-3 border-b shrink-0"
         data-testid="dedupe-scan-progress"
         :class="toneClass.bg + ' ' + toneClass.border">
        <div class="flex items-center justify-between mb-1.5">
            <span class="text-[11px] font-bold" :class="toneClass.text">
                {{ scanning ? '📊 ' + label : doneText }}
            </span>
            <span class="text-[11px] font-mono text-zinc-400" data-testid="dedupe-scan-numbers">
                <template v-if="indeterminate && scanning">⏳ 扫描中…</template>
                <template v-else>
                    {{ progress.done }} / {{ progress.total || '?' }}
                    <span v-if="progress.total" :class="toneClass.text">（{{ percent }}%）</span>
                </template>
            </span>
        </div>
        <!-- 不定态：滑动动画（不编假百分比）；确定态：按真实进度铺满 -->
        <div class="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden relative"
             data-testid="dedupe-scan-bar">
            <div v-if="indeterminate && scanning"
                 class="h-full w-1/3 bg-gradient-to-r rounded-full absolute dedupe-scan-indeterminate"
                 :class="toneClass.gradient"></div>
            <div v-else class="h-full bg-gradient-to-r transition-all duration-200 ease-out"
                 :class="toneClass.gradient"
                 :style="{ width: percent + '%' }"></div>
        </div>
        <div v-if="progress.current" class="mt-1 text-[10px] text-zinc-500 truncate"
             :title="progress.current">📄 {{ progress.current }}</div>
    </div>
</template>

<script>
export default {
    name: 'DedupeScanProgress',
    props: {
        // 是否正在扫描（false 时若 total>0 则显示「已完成」态）
        scanning: { type: Boolean, default: false },
        // 进度对象（与 useWorldbooks 的 wbScanProgress 同构）
        progress: { type: Object, default: () => ({ phase: 'idle', done: 0, total: 0, current: '' }) },
        // 0~100
        percent: { type: Number, default: 0 },
        // 扫描中显示的文案
        label: { type: String, default: '正在扫描库文件…' },
        // 配色主题（静态类映射，避免 Tailwind 动态类被 purge）
        tone: { type: String, default: 'amber' },
        // 不定态：底层重扫没有进度通道（如角色卡 refreshLibrary）时用滑动动画，不编假百分比
        indeterminate: { type: Boolean, default: false }
    },
    emits: [],
    computed: {
        // 只在「扫描中」或「刚扫完且有总数」时占位，避免空闲时留一条空条
        visible() {
            // 不定态时可能没有 total，故单独放行
            if (this.scanning && this.indeterminate) return true;
            return this.scanning || (this.progress && this.progress.total > 0 && this.progress.phase !== 'idle');
        },
        doneText() {
            return `✅ 扫描完成：共 ${this.progress.total} 个文件`;
        },
        // ⚠️ 不能叫 tone（与同名 prop 冲突），故命名 toneClass
        toneClass() {
            const map = {
                amber: {
                    bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400',
                    gradient: 'from-amber-600 to-amber-400'
                },
                purple: {
                    bg: 'bg-purple-500/10', border: 'border-purple-500/20', text: 'text-purple-400',
                    gradient: 'from-purple-600 to-purple-400'
                },
                emerald: {
                    bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400',
                    gradient: 'from-emerald-600 to-emerald-400'
                }
            };
            return map[this.tone] || map.amber;
        }
    }
};
</script>

<style scoped>
/* 不定态进度：左右往返滑动，向用户传达「在进行中」而不谎报进度 */
@keyframes dedupeScanIndeterminate {
    0% { left: -33%; }
    100% { left: 100%; }
}
.dedupe-scan-indeterminate {
    animation: dedupeScanIndeterminate 1.2s ease-in-out infinite;
}
</style>
