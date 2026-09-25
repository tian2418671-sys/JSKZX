<!--
  PresetDedupeModal 预设智能查重弹窗（子组件）
  扫描/清理逻辑留在父级，本组件展示聚类结果 + emits 操作
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-4xl w-full h-[80vh] flex flex-col shadow-2xl overflow-hidden">

            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-sky-500/10">
                <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-sky-400">⚙️ 预设智能查重中心</span>
                    <span class="text-xs text-zinc-400">按结构指纹比对（可发现改名同源）</span>
                    <span class="text-xs px-2 py-0.5 bg-sky-500/20 text-sky-300 rounded-full font-mono">
                        发现 {{ groups.length }} 组疑似重复
                    </span>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg">✕</button>
            </div>

            <div class="flex-1 overflow-y-auto p-5 custom-scrollbar space-y-5">
                <div v-for="(group, gIdx) in groups" :key="gIdx" class="bg-zinc-900/50 border border-zinc-700/80 rounded-xl p-4">

                    <div class="mb-3 flex items-center justify-between flex-wrap gap-2">
                        <span class="text-sm font-bold text-sky-400">
                            『{{ group.name }}』
                            <span v-if="group.byStructure" class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 font-normal">结构指纹聚类</span>
                        </span>
                        <div class="flex items-center gap-2">
                            <!-- 🔔 「改名同源」——旧版按名聚类会完全漏掉这一组 -->
                            <span v-if="group.renamedCount"
                                  class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40 font-bold">
                                🔔 含 {{ group.renamedCount }} 个改名同源
                            </span>
                            <span class="text-xs text-zinc-500">共 {{ group.list.length }} 个版本</span>
                        </div>
                    </div>

                    <div class="flex gap-3 overflow-x-auto custom-scrollbar pb-2">
                        <div v-for="(p, pIdx) in group.list" :key="pIdx"
                             class="flex-shrink-0 w-64 bg-zinc-800/80 border rounded-lg p-3 flex flex-col justify-between"
                             :class="pIdx === 0 ? 'border-sky-500 shadow-[0_0_15px_rgba(14,165,233,0.15)]' : 'border-zinc-700'">

                            <div>
                                <div class="text-xs font-bold truncate mb-1" :title="p.name">📄 {{ p.name }}</div>
                                <!-- 🏷️ 相似类型（2026-09-23）：不同类型处理方式完全不同 ——
                                     「改名同源」需人工核对、「参数变体」属有意调参、「同名无关」勿删。 -->
                                <div v-if="p._simLabel"
                                     class="text-[11px] font-bold mb-1 px-2 py-0.5 rounded border inline-block"
                                     :class="toneClass(p._simTone)"
                                     :title="p._simAdvice">
                                    {{ p._simLabel }}
                                </div>
                                <div class="text-[10px] text-zinc-400 font-mono mb-2" :title="p._settings">
                                    ⚙️ {{ p._settings }}
                                </div>
                                <div class="text-[11px] font-mono text-sky-400 mb-1">
                                    💬 提示词 {{ p._promptCount }} 段
                                </div>
                                <!-- 📐 结构与内容相似度（判定依据，可自行验证） -->
                                <div v-if="pIdx !== 0" class="text-[10px] font-mono text-sky-300/90 mb-1">
                                    🧬 结构 {{ fmtPct(p._structPct) }} ｜ 📝 内容 {{ fmtPct(p._contentPct) }}
                                    <span v-if="p._enabledPct !== null && p._enabledPct < 100" class="text-blue-300">
                                        ｜ 🎛️ 启用 {{ fmtPct(p._enabledPct) }}
                                    </span>
                                </div>
                                <div class="text-[10px] text-zinc-500 font-mono mb-2">
                                    🕒 {{ p._dateStr }} ({{ p._sizeKb }} KB)
                                </div>
                                <div class="text-[10px] px-2 py-1 rounded font-bold mb-2"
                                     :class="pIdx === 0 ? 'bg-sky-500/10 text-sky-400 border border-sky-500/30' : 'bg-zinc-700/40 text-zinc-300 border border-zinc-600/50'">
                                    {{ p._diffInfo }}
                                </div>
                                <div v-if="p._pctAdvice && pIdx !== 0" class="text-[10px] text-zinc-400 mb-2 leading-snug"
                                     title="按上方百分比分档给出（每 10% 一档，与上方数字同源）">
                                    💡 {{ p._pctAdvice }}
                                </div>
                            </div>

                            <div>
                                <button v-if="pIdx !== 0"
                                        @click="$emit('open-diff', group.list[0], p)"
                                        class="w-full px-2.5 py-1.5 mb-2 bg-zinc-800 hover:bg-zinc-700 text-sky-400 border border-sky-500/30 text-[11px] font-bold rounded shadow transition shrink-0">
                                    🔍 查看参数差异
                                </button>
                                <!-- 🛡️ 高风险类型（同名无关 / 参数变体 / 内容重排）→ 降级清理按钮 -->
                                <button @click="$emit('resolve-group', gIdx, p.path)"
                                        :class="pIdx === 0 ? 'bg-sky-600 hover:bg-sky-500'
                                            : (isRisky(p) ? 'bg-rose-900/70 hover:bg-rose-800 border border-rose-500/50' : 'bg-zinc-700 hover:bg-zinc-600')"
                                        class="w-full py-1.5 text-white text-xs font-bold rounded shadow transition">
                                    <span v-if="pIdx === 0">✅ 保留此版，清理其余</span>
                                    <span v-else-if="isRisky(p)">🚨 请先人工核对（勿直接清理）</span>
                                    <span v-else>⚠️ 保留此版本，清理其余</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="groups.length === 0" class="text-center py-10 text-zinc-500">
                    <span class="text-5xl opacity-30 mb-4 block">🔧</span>
                    <p>查重功能已下线（旧实现已移除，等待重构方案）</p>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'PresetDedupeModal',
    methods: {
        /** 类型标签配色（与 `presetStructure.js` 的 tone 对应） */
        toneClass(tone) {
            return {
                emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                amber: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
                blue: 'bg-blue-500/15 text-blue-300 border-blue-500/40',
                rose: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
                purple: 'bg-purple-500/15 text-purple-300 border-purple-500/40'
            }[tone] || 'bg-zinc-500/15 text-zinc-300 border-zinc-500/40';
        },
        fmtPct(v) {
            return (v === null || v === undefined) ? '—' : `${v}%`;
        },
        /**
         * 🛡️ 「高风险」类型：清理按钮需降级警示。
         * 判据来自 `presetStructure.js` 的 `PRESET_SIM_TYPE`（此处只读 type，避免重复维护标签）。
         * 🎚️ 保守档（2026-09-24 方案 A）：除「同名但无关 / 参数变体 / 内容重排」外，
         *    **「结构相同换皮」「启用状态不同」也纳入** ——
         *    前者结构一致但正文差异大（可能只是块结构碰巧相同的不同预设），
         *    后者开关不同 ⇒ **生效的提示词不同 ⇒ 行为不同**，同样不该直接删。
         */
        isRisky(p) {
            return !!p && (p._simType === 'different' || p._simType === 'sampler'
                || p._simType === 'reorder' || p._simType === 'flipped' || p._simType === 'reskin');
        }
    },
    props: {
        show: { type: Boolean, default: false },
        groups: { type: Array, default: () => [] }
    },
    emits: ['close', 'open-diff', 'resolve-group']
};
</script>
