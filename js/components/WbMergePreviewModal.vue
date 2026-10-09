<!--
  🔀 世界书合并 · 执行前预览（2026-10-03 · v2.3.6 五功能之三）

  防误合并三层的第一层：**先看清要合并什么、产出多少、有没有键冲突**，再决定执行。
  与 `WbMergeModal.vue` 的分工：那个是「勾选哪些书」，这个是「结果预览 + 执行」。
  规格：docs/规格与计划/查重引擎/世界书合并-查重组一键合并-实现规格.md §2.2
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">

                <div class="px-5 py-3.5 bg-gray-900 text-white border-b border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🔀 世界书合并 · 预览
                        <span class="text-[10px] font-normal text-gray-300">{{ sources.length }} 本 → {{ mergeName }}</span>
                    </h3>
                    <button @click="$emit('close')" :disabled="busy" class="text-gray-400 hover:text-white text-sm disabled:opacity-40">✕ 关闭</button>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 custom-scrollbar">

                    <!-- 汇总 -->
                    <div class="rounded-lg border border-indigo-200 bg-indigo-50 p-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-gray-700">
                        <span>来源 <b>{{ sources.length }}</b> 本</span>
                        <span>原词条 <b>{{ fmt(stats.total) }}</b> 条</span>
                        <span>产出 <b class="text-indigo-700">{{ fmt(stats.added) }}</b> 条</span>
                        <span>跳过重复 <b class="text-amber-600">{{ fmt(stats.skippedDup) }}</b> 条</span>
                        <span :class="conflictCount ? 'text-rose-700' : 'text-gray-500'">键冲突 <b>{{ conflictCount }}</b> 组</span>
                    </div>

                    <!-- 逐本 -->
                    <div class="overflow-x-auto">
                        <table class="w-full text-[11px] border border-gray-200 rounded">
                            <thead class="bg-gray-100 text-gray-700">
                                <tr>
                                    <th class="text-left px-2.5 py-1.5 border-b border-gray-200">来源世界书</th>
                                    <th class="text-right px-2.5 py-1.5 border-b border-gray-200">词条</th>
                                    <th class="text-right px-2.5 py-1.5 border-b border-gray-200">将并入</th>
                                    <th class="text-right px-2.5 py-1.5 border-b border-gray-200">与前面重复</th>
                                </tr>
                            </thead>
                            <tbody class="text-gray-600">
                                <tr v-for="(s, i) in sources" :key="'s' + i">
                                    <td class="px-2.5 py-1 border-b border-gray-100 break-all">{{ s.name }}</td>
                                    <td class="px-2.5 py-1 border-b border-gray-100 text-right">{{ fmt(s.total) }}</td>
                                    <td class="px-2.5 py-1 border-b border-gray-100 text-right font-bold text-indigo-700">{{ fmt(s.added) }}</td>
                                    <td class="px-2.5 py-1 border-b border-gray-100 text-right" :class="s.skipped ? 'text-amber-600' : ''">{{ fmt(s.skipped) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- 键冲突（只统计不取舍） -->
                    <div v-if="conflictCount" class="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-1.5">
                        <p class="text-[11px] font-bold text-rose-700">
                            ⚠️ {{ conflictCount }} 组「同名触发词、不同正文」——**两组词条都会保留**（本工具不自动取舍，请在合并后自行整理）
                        </p>
                        <details class="text-[10px] text-gray-700">
                            <summary class="cursor-pointer select-none">展开查看前 {{ Math.min(conflictCount, 20) }} 组</summary>
                            <div v-for="(c, i) in conflictsShown" :key="'c' + i" class="mt-1.5 pl-2 border-l-2 border-rose-300">
                                <div class="font-mono text-rose-700">触发词：{{ (c.keys || []).join(' / ') || '(空)' }}</div>
                                <div v-for="(it, j) in c.items" :key="'ci' + j" class="text-gray-600">
                                    · <b>{{ it.source }}</b>：{{ it.contentHead || '(空)' }}
                                </div>
                            </div>
                        </details>
                    </div>

                    <!-- 选项 -->
                    <label class="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 cursor-pointer">
                        <input type="checkbox" v-model="trashSources" :disabled="busy" class="mt-0.5 accent-rose-600">
                        <span class="text-[11px] text-gray-700">
                            <b>合并后把源书移入回收站</b>（默认不勾）
                            <span class="block text-[10px] text-gray-500">
                                勾选后源书移入应用回收站（**可从回收站取回**）；不勾选则源书全部保留（推荐先核对新书无误再清理）。
                            </span>
                        </span>
                    </label>

                    <p class="text-[9px] text-gray-500 leading-relaxed">
                        📌 合并产出的是**一本新书**（词条 uid 全部重生成、内部前端字段已清理）：执行后会**立即保存到世界书目录**，并自动切换为当前编辑对象。
                        去重按「触发词（顺序不敏感）+ 正文」归一判定；隐藏字段与 extensions 里的 `_filename` 会保留。
                    </p>
                </div>

                <div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
                    <span class="text-[10px] text-gray-500">{{ busy ? '执行中…' : '执行前请再核对上方数字' }}</span>
                    <div class="flex items-center gap-2">
                        <button @click="$emit('close')" :disabled="busy"
                                class="px-3 py-1.5 rounded border border-gray-300 bg-white text-gray-700 text-[11px] hover:bg-gray-100 disabled:opacity-40 transition">取消</button>
                        <button @click="$emit('confirm', { trashSources })" :disabled="busy"
                                class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold disabled:opacity-50 transition">
                            {{ busy ? '合并中…' : '🚀 执行合并' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'WbMergePreviewModal',
    props: {
        show: { type: Boolean, default: false },
        sources: { type: Array, default: () => [] },
        stats: { type: Object, default: null },
        mergeName: { type: String, default: '' },
        busy: { type: Boolean, default: false }
    },
    emits: ['close', 'confirm'],
    data() {
        return { trashSources: false };
    },
    computed: {
        safeStats() {
            return this.stats || { total: 0, added: 0, skippedDup: 0, bySource: [], keyConflicts: [] };
        },
        conflictCount() {
            return (this.safeStats.keyConflicts || []).length;
        },
        conflictsShown() {
            return (this.safeStats.keyConflicts || []).slice(0, 20);
        }
    },
    watch: {
        show(v) { if (v) this.trashSources = false; }   // 每次打开都回到保守默认（不勾清理）
    },
    methods: {
        fmt(n) { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString('en-US') : '0'; }
    }
};
</script>
