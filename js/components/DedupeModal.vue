<!--
  DedupeModal 智能版本查重中心弹窗（子组件）
  查重扫描/清理逻辑留在父级，本组件展示聚类结果 + emits 操作
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700 rounded-xl max-w-5xl w-full h-[85vh] flex flex-col shadow-2xl">

            <!-- 弹窗头部 -->
            <div class="px-5 py-4 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between shrink-0 rounded-t-xl">
                <h3 class="text-lg font-bold text-amber-400 flex items-center gap-2">
                    <span>🔍 智能版本查重中心</span>
                    <span class="text-xs px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full">
                        发现 {{ groups.length }} 组多胞胎
                    </span>
                </h3>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white transition text-xl">✕</button>
            </div>

            <!-- 📊 查重/版本对比的扫描进度（设计依据：规格 TC-07 / 最终方案 §185） -->
            <dedupe-scan-progress
                :scanning="scanning"
                :progress="scanProgress"
                :percent="scanPercent"
                tone="amber"
                label="正在扫描角色卡库…"
                :indeterminate="indeterminate"
            />

            <!-- 🧹 批量清理工具条（规则勾选 + 预演 + 一键清理；判定/执行都在父级，本组件只收集规则） -->
            <dedupe-batch-bar
                :plan="batchPlan"
                :exec="batchExec"
                @preview="onBatchPreview"
                @execute="onBatchExecute"
                @abort="$emit('batch-abort')"
                @retry="$emit('batch-retry')"
                @purge-missing="$emit('batch-purge-missing')"
                @undo="$emit('batch-undo')"
                @open-trash="$emit('open-trash')"
                :selected-count="selectedGroupCount"
                :total-count="groups.length"
                @select-all="selectAllGroups"
                @select-none="selectNoneGroups"
                @invert-select="invertGroupSelection"
                @select-kind="selectGroupsOfKind"
            />

            <!-- 查重聚类列表 (滚动区) -->
            <div class="flex-1 overflow-y-auto p-5 custom-scrollbar space-y-6">
                <div v-for="(group, gIndex) in groups" :key="gIndex" v-memo="[group, excludedGroups]" class="bg-zinc-900/50 border border-zinc-700/80 rounded-xl p-4">

                    <!-- 组标题 -->
                    <div class="mb-3 flex items-center justify-between">
                        <div class="text-sm font-bold text-white flex items-center gap-2">
                            <input type="checkbox" class="w-3.5 h-3.5 accent-emerald-500 shrink-0"
                                   :checked="!isGroupExcluded(gIndex)"
                                   :title="isGroupExcluded(gIndex) ? '本组不参与批量清理' : '本组参与批量清理'"
                                   @change="toggleGroup(gIndex, $event.target.checked)">
                            🎎 角色名: <span class="text-amber-400 text-lg">『{{ group.name }}』</span>
                            <!-- 🛡️ 同名假阳性防护（2026-09-23）：组标题即给出「仅同名」比例 -->
                            <span v-if="group.nameOnlyCount"
                                  class="text-[10px] px-2 py-0.5 bg-rose-500/20 text-rose-300 border border-rose-500/40 rounded-full">
                                ⚠️ {{ group.nameOnlyCount }} 个仅名称相同（内容无关）
                            </span>
                        </div>
                        <span class="text-xs text-zinc-500">检测到 {{ group.cards.length }} 个重名/历史版本</span>
                    </div>

                    <!-- 组内卡片横向对比视图 -->
                    <div class="flex gap-4 overflow-x-auto custom-scrollbar pt-3 pb-2">
                        <div v-for="(c, cIndex) in group.cards" :key="cIndex"
                             class="flex-shrink-0 w-72 bg-zinc-800/80 border rounded-lg p-3 flex flex-col transition relative"
                             :class="cIndex === 0 ? 'border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.1)]' : (c._nameOnly ? 'border-rose-500/60' : 'border-zinc-700')">

                            <div v-if="cIndex === 0" class="absolute -top-3 left-1.5 flex items-center gap-1 bg-emerald-900/80 px-2 py-0.5 rounded-full border border-emerald-500 shadow-md z-10">
                                <span class="text-lg leading-none">👑</span>
                                <span class="text-[10px] text-emerald-400 font-bold">综合最优推荐</span>
                            </div>
                            <!-- 🛡️ 同名假阳性防护（2026-09-23）：内容与推荐版无关 → 明确标注，避免误删 -->
                            <div v-else-if="c._nameOnly" class="absolute -top-3 left-1.5 flex items-center gap-1 bg-rose-900/90 px-2 py-0.5 rounded-full border border-rose-500 shadow-md z-10">
                                <span class="text-sm leading-none">⚠️</span>
                                <span class="text-[10px] text-rose-300 font-bold">仅名称相同·内容无关</span>
                            </div>

                            <div class="flex gap-3 mb-2">
                                <img v-if="c.avatar" :src="c.avatar" class="w-14 h-14 rounded object-cover border border-zinc-700 bg-zinc-900 shrink-0">
                                <div v-else class="w-14 h-14 rounded border border-zinc-700 bg-zinc-900 flex items-center justify-center text-lg shrink-0">🎎</div>
                                <div class="flex flex-col justify-center min-w-0 overflow-hidden">
                                    <span class="text-[10px] text-zinc-400 font-mono truncate" :title="c.path">{{ c.path.split(/[\\/]/).pop() }}</span>
                                    <span class="text-xs font-bold" :class="cIndex === 0 ? 'text-emerald-400' : 'text-zinc-300'">
                                        📝 约 {{ c._tokens }} Tokens
                                    </span>
                                    <span class="text-[10px] text-amber-400/80 truncate">
                                        🕒 {{ c._dateStr || '时间未知' }}
                                    </span>
                                </div>
                            </div>

                            <div class="mb-2 px-2 py-1 rounded text-[10px] text-center font-bold"
                                 :class="{
                                    'bg-zinc-900 text-zinc-500': c._diffType === '推荐版',
                                    'bg-emerald-900/50 text-emerald-400': c._diffType === '可能包含更多设定',
                                    'bg-rose-900/50 text-rose-400': c._diffType === '设定可能有缺失',
                                    'bg-amber-900/50 text-amber-400': c._diffType === '设定细节不同',
                                    'bg-blue-900/50 text-blue-400': c._diffType === '设定完全一致'
                                 }">
                                {{ c._diffType }}
                            </div>
                            <!-- 🛡️ 仅名称相同：给出可验证的依据（内容指纹距离），而不是只说「不同」 -->
                            <div v-if="c._nameOnly" class="mb-2 px-2 py-1 rounded text-[10px] text-center bg-rose-950/50 text-rose-300 border border-rose-500/40">
                                🧬 内容指纹与推荐版相差 {{ c._nameOnlyDist }} 位（>24 判为不同源）<br>
                                <span class="text-rose-400/80">很可能是完全不同的角色，请先对比再清理</span>
                            </div>

                            <div class="flex-1 mt-1 mb-3">
                                <div class="text-[10px] text-zinc-500 mb-1">系统/自定义标签:</div>
                                <div class="flex flex-wrap gap-1">
                                    <span v-for="tag in (c.customTags || []).slice(0, 4)" :key="tag" class="text-[9px] bg-zinc-900 text-zinc-300 px-1.5 py-0.5 rounded border border-zinc-700">
                                        {{ tag }}
                                    </span>
                                    <span v-if="(c.customTags || []).length > 4" class="text-[9px] text-zinc-500">...</span>
                                    <span v-if="!(c.customTags || []).length" class="text-[9px] text-rose-400/50">无标签</span>
                                </div>
                            </div>

                            <div class="flex gap-1.5 mt-2">
                                <button v-if="cIndex !== 0"
                                        @click="$emit('open-diff', group.cards[0], c)"
                                        class="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-amber-400 border border-amber-500/30 text-xs font-bold rounded shadow transition shrink-0">
                                    🔍 对比差异
                                </button>
                                <button @click="$emit('resolve-group', gIndex, c.path)"
                                        :class="cIndex === 0 ? 'bg-emerald-600 hover:bg-emerald-500' : (c._nameOnly ? 'bg-rose-900/70 hover:bg-rose-800 border border-rose-500/50' : 'bg-zinc-700 hover:bg-zinc-600')"
                                        class="flex-1 py-1.5 text-white text-xs font-bold rounded shadow transition truncate">
                                    <span v-if="cIndex === 0">✅ 保留此版，清理其余</span>
                                    <span v-else-if="c._nameOnly">⚠️ 仅同名·保留旧版并清理其余</span>
                                    <span v-else>⚠️ 保留旧版，清理其余</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="groups.length === 0" class="h-full flex flex-col items-center justify-center text-zinc-500">
                    <!-- ⚠️ 扫描中不能显示「已完成」：弹窗先开再扫，否则扫描期间误报完成
                         🔧 2026-09-25：查重旧实现已整体下线 —— 空状态只能如实说「已下线」 -->
                    <template v-if="scanning">
                        <span class="text-5xl opacity-30 mb-4">🔎</span>
                        <p>正在扫描角色卡库，请稍候…</p>
                    </template>
                    <template v-else>
                        <span class="text-5xl opacity-30 mb-4">🔧</span>
                        <p>查重功能已下线（旧实现已移除，等待重构方案）</p>
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import DedupeScanProgress from './DedupeScanProgress.vue';
import DedupeBatchBar from './DedupeBatchBar.vue';
import { isGroupExcluded, toggleGroupExcluded, collectExcludeIds } from '../utils/dedupeBatchGroupState.js';

export default {
    name: 'DedupeModal',
    components: { DedupeScanProgress, DedupeBatchBar },
    props: {
        show: { type: Boolean, default: false },
        groups: { type: Array, default: () => [] },
        // 📊 查重扫描进度
        scanning: { type: Boolean, default: false },
        scanProgress: { type: Object, default: () => ({ phase: 'idle', done: 0, total: 0, current: '' }) },
        scanPercent: { type: Number, default: 0 },
        // 不定态：底层重扫无进度通道时用滑动动画，不编假百分比
        indeterminate: { type: Boolean, default: false },
        // 🧹 批量清理：预演计划 / 执行进度（父级 useDedupe 持有）
        batchPlan: { type: Object, default: null },
        batchExec: { type: Object, default: () => ({ running: false, done: 0, total: 0, deleted: 0, failed: [] }) }
    },
    emits: ['close', 'open-diff', 'resolve-group', 'batch-preview', 'batch-execute', 'batch-abort', 'batch-retry', 'batch-purge-missing', 'open-trash', 'batch-undo'],
    data() {
        return { excludedGroups: {} }; // 被取消勾选的组（只影响批量清理；单组按钮照旧可用）
    },
    watch: {
        groups() { this.excludedGroups = {}; } // 重新扫描 → 组级勾选复位
    },
    computed: {
        /** 已选组数（= 总组数 − 被取消勾选的组数），供工具条显示「已选 X / Y」 */
        selectedGroupCount() { return Math.max(0, (this.groups || []).length - Object.keys(this.excludedGroups || {}).length); }
    },
    methods: {
        isGroupExcluded(index) { return isGroupExcluded(this.excludedGroups, index); },
        toggleGroup(index, checked) { this.excludedGroups = toggleGroupExcluded(this.excludedGroups, index, checked); },
        excludeIds() { return collectExcludeIds(this.excludedGroups, this.groups); },
        /** 🎯 全选：所有组参与批量 */
        selectAllGroups() { this.excludedGroups = {}; },
        /** 🎯 全不选：所有组都退出批量（单组按钮仍可手动处理） */
        selectNoneGroups() {
            const map = {};
            (this.groups || []).forEach((g, i) => { map[i] = true; });
            this.excludedGroups = map;
        },
        /** 🎯 反选：已选 ↔ 未选 */
        invertGroupSelection() {
            const map = {};
            (this.groups || []).forEach((g, i) => { if (!this.excludedGroups[i]) map[i] = true; });
            this.excludedGroups = map;
        },
        /** 🎯 按类型只选：exact(L0) / similar(L1~L2) / nameonly(仅名称相同) */
        selectGroupsOfKind(kind) {
            const map = {};
            (this.groups || []).forEach((g, i) => {
                const k = (g && (g._nameOnly || g.type === 'nameonly')) ? 'nameonly' : (g && g.type === 'duplicate' ? 'exact' : 'similar');
                if (k !== kind) map[i] = true;
            });
            this.excludedGroups = map;
        },
        onBatchPreview(payload) { this.$emit('batch-preview', { ...payload, excludeIds: this.excludeIds() }); },
        onBatchExecute(payload) { this.$emit('batch-execute', { ...payload, excludeIds: this.excludeIds() }); }
    }
};
</script>
