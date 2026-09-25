<!--
  WbDedupeModal 世界书智能版本对比查重弹窗（子组件）
  扫描/清理逻辑留在父级，本组件展示聚类结果 + emits 操作
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-4xl w-full h-[80vh] flex flex-col shadow-2xl overflow-hidden">

            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-amber-500/10">
                <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-amber-500">📖 世界书智能版本对比中心</span>
                    <span class="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full font-mono">
                        发现 {{ groups.length }} 组同名世界书
                    </span>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <!-- 📊 查重/版本对比的扫描进度（设计依据：规格 TC-07 / 最终方案 §185）
                 进度条属于查重流程，不属于浏览库 —— 详见 SidebarPanel.vue 的留痕注释 -->
            <dedupe-scan-progress
                :scanning="scanning"
                :progress="scanProgress"
                :percent="scanPercent"
                tone="amber"
                label="正在扫描世界书库…"
                :indeterminate="indeterminate"
            />

            <div class="flex-1 overflow-y-auto p-5 custom-scrollbar space-y-5">
                <div v-for="(group, gIdx) in groups" :key="gIdx" class="bg-zinc-900/50 border border-zinc-700/80 rounded-xl p-4">

                    <div class="mb-3 flex items-center justify-between">
                        <span class="text-sm font-bold text-amber-400 flex items-center gap-2">『{{ group.name }}』
                            <!-- 🛡️ 同名假阳性防护（2026-09-23）：组标题即给出「仅同名」数量 -->
                            <span v-if="group.nameOnlyCount"
                                  class="text-[10px] px-2 py-0.5 bg-rose-500/20 text-rose-300 border border-rose-500/40 rounded-full">
                                ⚠️ {{ group.nameOnlyCount }} 本仅书名相同
                            </span>
                        </span>
                        <span class="text-xs text-zinc-500">共 {{ group.list.length }} 个重名版本</span>
                    </div>

                    <div class="flex gap-3 overflow-x-auto custom-scrollbar pb-2">
                        <div v-for="(wb, wIdx) in group.list" :key="wIdx"
                             class="flex-shrink-0 w-64 bg-zinc-800/80 border rounded-lg p-3 flex flex-col justify-between"
                             :class="wIdx === 0 ? 'border-amber-500 shadow-[0_0_15px_rgba(217,119,6,0.15)]' : (wb._nameOnly ? 'border-rose-500/60' : 'border-zinc-700')">

                            <div>
                                <div class="text-xs font-bold truncate mb-1" :title="wb.name">📄 {{ wb.name }}</div>
                                <div class="text-[11px] font-mono text-amber-400 mb-1">
                                    📚 词条数: {{ wb._entryCount }} 个
                                </div>
                                <div class="text-[10px] text-zinc-500 font-mono mb-2">
                                    🕒 {{ wb._dateStr }} ({{ wb._sizeKb }} KB)
                                </div>
                                <div class="text-[10px] px-2 py-1 rounded font-bold mb-3"
                                     :class="wb._nameOnly ? 'bg-rose-950/50 text-rose-300 border border-rose-500/40' : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'">
                                    {{ wb._diffInfo }}
                                </div>
                            </div>

                            <div>
                                <button v-if="wIdx !== 0"
                                        @click="$emit('open-diff', group.list[0], wb)"
                                        class="w-full px-2.5 py-1.5 mb-2 bg-zinc-800 hover:bg-zinc-700 text-amber-400 border border-amber-500/30 text-[11px] font-bold rounded shadow transition shrink-0">
                                    🔍 查看词条差异
                                </button>
                                <button @click="$emit('resolve-group', gIdx, wb.path)"
                                        :class="wIdx === 0 ? 'bg-amber-600 hover:bg-amber-500' : (wb._nameOnly ? 'bg-rose-900/70 hover:bg-rose-800 border border-rose-500/50' : 'bg-zinc-700 hover:bg-zinc-600')"
                                        class="w-full py-1.5 text-white text-xs font-bold rounded shadow transition">
                                    <span v-if="wIdx === 0">✅ 保留此本，清理其余</span>
                                    <span v-else-if="wb._nameOnly">⚠️ 仅同名·保留此版本并清理其余</span>
                                    <span v-else>⚠️ 保留此版本，清理其余</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="groups.length === 0" class="text-center py-10 text-zinc-500">
                    <!-- ⚠️ 扫描中不能显示「已完成」—— 弹窗现在**先开再扫**，
                         否则扫描期间会误报「已完成」（对照 AR-38：零反馈/错反馈都算坏）
                         🔧 2026-09-25：查重旧实现已整体下线 —— 空状态只能如实说「已下线」 -->
                    <template v-if="scanning">
                        <span class="text-5xl opacity-30 mb-4 block">🔎</span>
                        <p>正在扫描世界书库，请稍候…</p>
                    </template>
                    <template v-else>
                        <span class="text-5xl opacity-30 mb-4 block">🔧</span>
                        <p>查重功能已下线（旧实现已移除，等待重构方案）</p>
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import DedupeScanProgress from './DedupeScanProgress.vue';

export default {
    name: 'WbDedupeModal',
    components: { DedupeScanProgress },
    props: {
        show: { type: Boolean, default: false },
        groups: { type: Array, default: () => [] },
        // 📊 查重扫描进度（由 useWorldbooks 的 wbScanProgress 注入）
        scanning: { type: Boolean, default: false },
        scanProgress: { type: Object, default: () => ({ phase: 'idle', done: 0, total: 0, current: '' }) },
        scanPercent: { type: Number, default: 0 },
        // 不定态：底层重扫无进度通道时用滑动动画，不编假百分比
        indeterminate: { type: Boolean, default: false }
    },
    emits: ['close', 'open-diff', 'resolve-group']
};
</script>
