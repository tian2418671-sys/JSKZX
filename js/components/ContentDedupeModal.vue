<!--
  ContentDedupeModal 内容级跨名称版本查重弹窗（子组件）
  扫描/清理逻辑留在父级，本组件展示聚类结果 + emits 操作
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-5xl w-full h-[80vh] flex flex-col shadow-2xl overflow-hidden">

            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-purple-500/10">
                <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-purple-400">🧬 内容级版本查重中心</span>
                    <span class="text-xs text-zinc-400">识别改名/复制的重复内容（与名称无关）</span>
                    <span class="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full font-mono">
                        发现 {{ groups.length }} 组疑似重复
                    </span>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <!-- 📊 内容级查重的扫描进度（设计依据：规格 TC-07 / 最终方案 §185） -->
            <dedupe-scan-progress
                :scanning="scanning"
                :progress="scanProgress"
                :percent="scanPercent"
                tone="purple"
                :label="scanLabel"
                :indeterminate="indeterminate"
            />

            <div class="flex-1 overflow-y-auto p-5 custom-scrollbar space-y-5">
                <div v-for="(group, gIdx) in groups" :key="gIdx" class="bg-zinc-900/50 border border-zinc-700/80 rounded-xl p-4">

                    <div class="mb-3 flex items-center justify-between">
                        <span class="text-sm font-bold text-purple-400">『{{ group.name }}』</span>
                        <span class="text-xs text-zinc-500">共 {{ group.list.length }} 个内容高度相似的版本</span>
                    </div>
                    <!-- 📊 排序口径说明（2026-09-24）：用户能知道「为什么这个排在前面」 -->
                    <div class="mb-2 text-[10px] text-zinc-500">
                        排序：📊 综合分从高到低（最相似的排最前）；最左为 👑 基准版（内容最长者）
                    </div>

                    <div class="flex gap-3 overflow-x-auto custom-scrollbar pb-2">
                        <div v-for="(v, vIdx) in group.list" :key="vIdx"
                             class="flex-shrink-0 w-64 bg-zinc-800/80 border rounded-lg p-3 flex flex-col justify-between"
                             :class="vIdx === 0 ? 'border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.15)]' : 'border-zinc-700'">

                            <div>
                                <div class="text-xs font-bold truncate mb-1" :title="v._name">📄 {{ v._name }}</div>
                                <!-- 🏷️ 相似类型（2026-09-23 采纳「多维度 + 类型分类」建议）：
                                     不同类型处理方式完全不同 —— 「触发重复」别删、「设定冲突」需人工裁决。
                                     旧版只有一个「相似度 %」，用户无法据此判断该怎么做。 -->
                                <div v-if="v._simLabel"
                                     class="text-[11px] font-bold mb-1 px-2 py-0.5 rounded border inline-block"
                                     :class="toneClass(v._simTone)"
                                     :title="v._simAdvice">
                                    {{ v._simLabel }}
                                </div>
                                <div class="text-[11px] font-mono text-purple-300 mb-1">
                                    🧬 内容重合: {{ v._simPct }}%
                                    <span v-if="v._keysSimPct !== null && v._keysSimPct !== undefined" class="text-amber-300/90">
                                        ｜ 🔑 触发词重合: {{ v._keysSimPct }}%
                                    </span>
                                </div>
                                <!-- 🛑 AR-50（2026-09-24）：**分口径展示**，不再取 max。
                                     旧实现取「全字段/ 5字段」的**较大者**，实测把「全字段 2.1% + 5字段 100%」
                                     显示成 100%，用户误以为「内容完全一样」（而两卡大小差 2.6 倍）。
                                     ⚠️ 现在主值（内容重合）= **全字段**；当「5 字段」与它**明显不同**时才另列
                                     —— 口径分歧本身就是「可疑」的信号，一致时不必扰民。 -->
                                <div v-if="vIdx !== 0 && v._legacyPct !== null && v._fullPct !== null && Math.abs(v._legacyPct - v._fullPct) >= 5"
                                     class="text-[10px] font-mono text-amber-300/80 mb-1 leading-snug"
                                     title="「5 字段」= 描述/人格/场景/开场白/示例对话；「内容重合」= 含卡内世界书等全部字段。两者差距大时说明“只有部分字段像”，需先对比再处理">
                                    ⚠️ 但仅 5 基础字段重合 {{ v._legacyPct }}%（其余字段不像）
                                </div>
                                <!-- 📊 综合分（2026-09-24，世界书查重方案「第 2 步」补完）：
                                     旧版 `_score` 算出来却**从未被消费**（不排序、不显示）。
                                     现在：列表按它降序（最像的排最前），并把构成写清便于核对。
                                     ⚠️ 权重未标定（真实库仅 8 对真重复）→ 只作**展示排序**，不参与闸门判定。 -->
                                <div v-if="vIdx !== 0 && typeof v._score === 'number'"
                                     class="text-[10px] font-mono text-fuchsia-300/90 mb-1"
                                     title="综合分 = 长度惩罚 × (0.75×内容重合 + 0.25×触发词重合)；仅供排序，不参与是否同组的判定">
                                    📊 综合分: {{ Math.round(v._score * 100) }}%
                                </div>
                                <!-- 🛡️ PK-29：给出**可验证依据** —— 旧版只显示 simhash 距离换算的
                                     「相似度」，实测会严重误导（距离 19 → 显示 70%，真实内容重叠仅 0.1%）。
                                     现在主指标是真实内容重合度，并把指纹距离作为辅助依据一并展示。 -->
                                <div class="text-[10px] text-zinc-500 font-mono mb-1">
                                    {{ vIdx === 0 ? '（基准版）' : `🧾 指纹距离 ${v._hamming}${v._lenPenalty !== undefined && v._lenPenalty < 0.99 ? ` ｜ 长度惩罚 ×${v._lenPenalty.toFixed(2)}` : ''}` }}
                                </div>
                                <div v-if="v._pctAdvice && vIdx !== 0" class="text-[10px] text-zinc-400 mb-1 leading-snug"
                                     title="按上方百分比分档给出（每 10% 一档，与上方数字同源）">
                                    💡 {{ v._pctAdvice }}
                                </div>
                                <div class="text-[10px] text-zinc-500 font-mono mb-1">
                                    {{ v._sizeKb }} KB
                                </div>
                                <div class="text-[10px] text-zinc-500 font-mono mb-2">
                                    🕒 {{ v._dateStr }}
                                </div>
                                <div class="text-[10px] text-zinc-400 font-mono truncate mb-2" :title="v.item.path">
                                    <!-- 🛡️ AR-39 同款加固：`path` 可能为空（未落盘条目）→ 不能裸 `split` 抛 TypeError -->
                                    📁 {{ (v.item.path || '').split(/[\\/]/).pop() || '（未知文件）' }}
                                </div>
                                <div class="text-[10px] px-2 py-1 rounded font-bold mb-3 bg-purple-500/10 text-purple-300 border border-purple-500/30">
                                    <!-- 🏷️ PK-31（2026-09-25）：徽标改由 `badgeForContentPct(v._simPct)` 产出
                                         （与「🧬 内容重合」百分比、与 💡 那行**同一张分档表**）。
                                         旧实现是内联硬编码（只看 ≥98）⇒ 实测 **9% 也说「⚠️ 高度相似，细节有差异」**，
                                         与同卡片的「⚠️ 仅名称相同」当场打架。 -->
                                    {{ vIdx === 0 ? '👑 内容最完整（推荐保留）' : (v._pctBadge || '—') }}
                                </div>
                            </div>

                            <div>
                                <button v-if="vIdx !== 0"
                                        @click="$emit('open-diff', group.list[0].item, v.item)"
                                        class="w-full px-2.5 py-1.5 mb-2 bg-zinc-800 hover:bg-zinc-700 text-purple-300 border border-purple-500/30 text-[11px] font-bold rounded shadow transition shrink-0">
                                    🔍 查看内容差异
                                </button>
                                <!-- 🛡️ 「设定冲突 / 仅名称相同」时**降级清理按钮**（红边警示 + 文案改「勿清理」）：
                                     这两类的共同点是「**内容并不可安全删除**」——
                                     · 设定冲突：两版矛盾，删掉任一侧都可能丢设定 ⇒ 必须人工裁决
                                     · 仅名称相同：本来就无关，误删等于丢真书
                                     与 AR-48（同名查重聚错组）的防护同口径。 -->
                                <button @click="$emit('resolve-group', gIdx, v.item.path)"
                                        :class="vIdx === 0
                                            ? (groupHasRisky(group) ? 'bg-rose-900/70 hover:bg-rose-800 border border-rose-500/50' : 'bg-purple-600 hover:bg-purple-500')
                                            : (isRisky(v) ? 'bg-rose-900/70 hover:bg-rose-800 border border-rose-500/50' : 'bg-zinc-700 hover:bg-zinc-600')"
                                        class="w-full py-1.5 text-white text-xs font-bold rounded shadow transition">
                                    <span v-if="vIdx === 0 && groupHasRisky(group)">🚨 清理其余（含高风险项，请先核对）</span>
                                    <span v-else-if="vIdx === 0">✅ 保留此版，清理其余</span>
                                    <span v-else-if="isRisky(v)">🚨 请先人工核对（勿直接清理）</span>
                                    <span v-else>⚠️ 保留此版本</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="groups.length === 0" class="text-center py-12 text-zinc-500 text-sm">
                    <template v-if="scanning">🔎 正在扫描并比对内容，请稍候…</template>
                    <template v-else>🔧 查重功能已下线（旧实现已移除，等待重构方案）</template>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import DedupeScanProgress from './DedupeScanProgress.vue';

export default {
    name: 'ContentDedupeModal',
    components: { DedupeScanProgress },
    methods: {
        /** 类型标签配色（与 `similarityType.js` 的 tone 对应） */
        toneClass(tone) {
            return {
                emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                amber: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
                blue: 'bg-blue-500/15 text-blue-300 border-blue-500/40',
                rose: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
                purple: 'bg-purple-500/15 text-purple-300 border-purple-500/40'
            }[tone] || 'bg-zinc-500/15 text-zinc-300 border-zinc-500/40';
        },
        /**
         * 🛡️ 「高风险」类型：清理按钮需降级警示。
         * 判据来自 `similarityType.js` 的 `SIM_TYPE`（此处只读 type，避免重复维护标签）。
         */
        isRisky(v) {
            return v && (v._simType === 'conflict' || v._simType === 'different');
        },
        /**
         * 🛡️ AR-52（2026-09-25）：**组级**风险 —— 只要组里有高风险成员，
         * 基准版那个「保留此版，清理其余」也必须降级警示。
         * 🐞 旧实现只对 `vIdx !== 0` 的按钮做 `isRisky` ⇒ 实测：对家是「⚠️ 仅名称相同」/ 9% 时，
         *    右侧写着「请先人工核对」，**左侧一键删除入口照常可用**（那组要删的卡含 7536 字独占词条）。
         */
        groupHasRisky(group) {
            return !!(group && Array.isArray(group.list)
                && group.list.some((x, i) => i > 0 && this.isRisky(x)));
        }
    },
    props: {
        show: { type: Boolean, default: false },
        groups: { type: Array, default: () => [] },
        // 📊 查重扫描进度（内容级查重对三种库通用，故文案可定制）
        scanning: { type: Boolean, default: false },
        scanProgress: { type: Object, default: () => ({ phase: 'idle', done: 0, total: 0, current: '' }) },
        scanPercent: { type: Number, default: 0 },
        scanLabel: { type: String, default: '正在扫描并比对内容…' },
        // 不定态：底层重扫无进度通道时用滑动动画，不编假百分比
        indeterminate: { type: Boolean, default: false }
    },
    emits: ['close', 'open-diff', 'resolve-group']
};
</script>
