<!--
  DiffModal 数据版本差异深度比对 (Diff Inspector) 弹窗（子组件）
  纯展示组件：差异计算逻辑留在父级，本组件渲染两侧对比
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[110] bg-black/85 backdrop-blur-md flex items-center justify-center p-6" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl max-w-6xl w-full h-[90vh] flex flex-col shadow-2xl overflow-hidden">

            <div class="px-5 py-3 border-b border-zinc-800 bg-zinc-900/90 flex items-center justify-between shrink-0">
                <div class="flex items-center gap-3">
                    <span class="text-base font-bold text-amber-400">⚖️ 数据版本差异深度比对 (Diff Inspector)</span>
                    <span class="text-xs text-zinc-400 font-mono">👑 推荐保留版 vs 🔍 对比版</span>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg transition">✕</button>
            </div>

            <div class="grid grid-cols-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0 text-xs font-bold">
                <div class="p-3 border-r border-zinc-800 flex items-center gap-3">
                    <img v-if="masterItem && masterItem.avatar" :src="masterItem.avatar" class="w-10 h-10 rounded object-cover border border-emerald-500/50">
                    <span v-else class="text-3xl opacity-50">{{ iconFor(masterItem) }}</span>
                    <div class="flex flex-col min-w-0">
                        <span class="text-emerald-400 truncate">👑 推荐版: {{ (masterItem && masterItem.data && masterItem.data.name) || (masterItem ? masterItem.name : '未知') }}</span>
                        <span class="text-[10px] text-zinc-500 font-mono truncate">{{ fileNameOf(masterItem) }}</span>
                    </div>
                </div>
                <div class="p-3 flex items-center gap-3">
                    <img v-if="compareItem && compareItem.avatar" :src="compareItem.avatar" class="w-10 h-10 rounded object-cover border border-amber-500/50">
                    <span v-else class="text-3xl opacity-50">{{ iconFor(compareItem) }}</span>
                    <div class="flex flex-col min-w-0">
                        <span class="text-amber-400 truncate">🔍 对比版: {{ (compareItem && compareItem.data && compareItem.data.name) || (compareItem ? compareItem.name : '未知') }}</span>
                        <span class="text-[10px] text-zinc-500 font-mono truncate">{{ fileNameOf(compareItem) }}</span>
                    </div>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-5">
                <div v-for="(f, idx) in fieldResults" :key="idx" class="bg-zinc-900/50 border border-zinc-800 rounded-xl p-3 shadow-md">

                    <div class="flex items-center justify-between mb-2 pb-2 border-b border-zinc-800/80">
                        <span class="text-xs font-bold text-zinc-200">{{ f.label }}</span>
                        <span class="text-[10px] px-2 py-0.5 rounded font-mono font-bold"
                              :class="f.isSame ? 'bg-zinc-800 text-zinc-500' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'">
                            {{ f.isSame ? '✅ 设定完全一致' : `⚠️ 存在差异 (${f.len1} vs ${f.len2})` }}
                        </span>
                    </div>

                    <!-- 🧩 词条级对齐：把「不对称增删」表达成 only-a / only-b / both 三类 -->
                    <template v-if="f.isEntryPairs">
                        <div class="space-y-1.5">
                            <div v-for="(p, pIdx) in f.pairs" :key="pIdx"
                                 class="border rounded-lg overflow-hidden"
                                 :class="p.side === 'only-b' ? 'border-emerald-500/40 bg-emerald-950/20'
                                       : p.side === 'only-a' ? 'border-rose-500/40 bg-rose-950/20'
                                       : 'border-zinc-800 bg-zinc-950/40'">
                                <!-- 条目头 -->
                                <div class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] border-b"
                                     :class="p.side === 'only-b' ? 'border-emerald-500/30 bg-emerald-950/30'
                                           : p.side === 'only-a' ? 'border-rose-500/30 bg-rose-950/30'
                                           : 'border-zinc-800'">
                                    <span class="font-bold shrink-0"
                                          :class="p.side === 'only-b' ? 'text-emerald-300' : p.side === 'only-a' ? 'text-rose-300' : 'text-zinc-300'">
                                        {{ p.side === 'only-b' ? '[新增]' : p.side === 'only-a' ? '[缺失]' : '●' }}
                                    </span>
                                    <span class="text-zinc-200 truncate font-mono">{{ payloadFor(p).name }}</span>
                                    <span v-if="p.side === 'both' && payloadFor(p).changed"
                                          class="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                        正文有改动
                                    </span>
                                    <span v-else-if="p.side === 'both'"
                                          class="ml-auto shrink-0 text-[10px] text-zinc-500">一致</span>
                                </div>
                                <!-- 触发词 + 正文 -->
                                <div class="grid grid-cols-2 gap-3 p-2.5 text-[11px] font-mono">
                                    <div class="min-w-0">
                                        <span class="text-[10px] text-emerald-400 block mb-1">👑 推荐版</span>
                                        <div v-if="p.a" class="space-y-1">
                                            <div v-if="payloadFor(p).keysA.length" class="flex flex-wrap gap-1">
                                                <span v-for="k in payloadFor(p).keysA" :key="k"
                                                      class="bg-zinc-800 text-zinc-300 border border-zinc-700 px-1.5 py-0.5 rounded text-[10px]">{{ k }}</span>
                                            </div>
                                            <div class="text-zinc-400 whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto custom-scrollbar">{{ payloadFor(p).contentA || '（无正文）' }}</div>
                                        </div>
                                        <div v-else class="text-zinc-600 italic">本端无此词条</div>
                                    </div>
                                    <div class="min-w-0 border-l border-zinc-800 pl-3">
                                        <span class="text-[10px] text-amber-400 block mb-1">🔍 对比版</span>
                                        <div v-if="p.b" class="space-y-1">
                                            <div v-if="payloadFor(p).keysB.length" class="flex flex-wrap gap-1">
                                                <span v-for="k in payloadFor(p).keysB" :key="k"
                                                      class="bg-zinc-800 text-zinc-300 border border-zinc-700 px-1.5 py-0.5 rounded text-[10px]">{{ k }}</span>
                                            </div>
                                            <div class="text-zinc-400 whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto custom-scrollbar">{{ payloadFor(p).contentB || '（无正文）' }}</div>
                                        </div>
                                        <div v-else class="text-zinc-600 italic">本端无此词条</div>
                                    </div>
                                </div>
                            </div>
                            <div v-if="!f.pairs || !f.pairs.length" class="text-[11px] text-zinc-500 italic px-2 py-1">
                                两本世界书均无词条，无可对齐内容。
                            </div>
                        </div>
                    </template>

                    <template v-else-if="f.isTags">
                        <div class="grid grid-cols-2 gap-4 text-xs">
                            <div class="border-r border-zinc-800 pr-2">
                                <span class="text-[10px] text-zinc-500 block mb-1">左版独有:</span>
                                <div class="flex flex-wrap gap-1">
                                    <span v-for="t in f.onlyMasterTags" :key="t" class="bg-emerald-900/40 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded text-[10px]">+ {{ t }}</span>
                                    <span v-if="!f.onlyMasterTags.length" class="text-zinc-600 italic">无</span>
                                </div>
                            </div>
                            <div>
                                <span class="text-[10px] text-zinc-500 block mb-1">右版独有:</span>
                                <div class="flex flex-wrap gap-1">
                                    <span v-for="t in f.onlyCompareTags" :key="t" class="bg-amber-900/40 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded text-[10px]">+ {{ t }}</span>
                                    <span v-if="!f.onlyCompareTags.length" class="text-zinc-600 italic">无</span>
                                </div>
                            </div>
                        </div>
                    </template>

                    <template v-else>
                        <div v-if="f.isSame" class="text-[11px] text-zinc-500 italic px-2 py-1">
                            两版内容完全一致，已自动折叠展示。
                        </div>
                        <!-- 🛡️ 行级比对必须有 diffText 才渲染：diffText 是「有差异才有值」的可空字段，
                             直读 f.diffText.masterLines 会 null.masterLines → 渲染期 TypeError（AR-39） -->
                        <div v-else-if="f.diffText" class="grid grid-cols-2 gap-3 text-xs font-mono">
                            <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                <template v-for="(line, lIdx) in f.diffText.masterLines" :key="lIdx">
                                    <div :class="line.type === 'removed' ? 'bg-rose-950/60 text-rose-300 border-l-2 border-rose-500 px-1 my-0.5' : 'text-zinc-500 opacity-50'">
                                        {{ line.text || ' ' }}
                                    </div>
                                </template>
                            </div>
                            <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                <template v-for="(line, lIdx) in f.diffText.compareLines" :key="lIdx">
                                    <div :class="line.type === 'added' ? 'bg-emerald-950/60 text-emerald-300 border-l-2 border-emerald-500 px-1 my-0.5' : 'text-zinc-500 opacity-50'">
                                        {{ line.text || ' ' }}
                                    </div>
                                </template>
                            </div>
                        </div>
                        <!-- 无 diffText 但有差异：给占位文案，避免留白（观感像坏了） -->
                        <div v-else class="text-[11px] text-amber-400/80 italic px-2 py-1">
                            {{ f.hint || '此项存在差异，但无可展开的逐行对比内容。' }}
                        </div>
                    </template>

                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { prepareDiffPayload } from '../utils/entryAlign.js';

export default {
    name: 'DiffModal',
    props: {
        show: { type: Boolean, default: false },
        masterItem: { type: Object, default: null },
        compareItem: { type: Object, default: null },
        fieldResults: { type: Array, default: () => [] }
    },
    emits: ['close'],
    data() {
        return { _payloadCache: new WeakMap() };
    },
    methods: {
        // 依据数据形态返回类型图标：世界书 🌍 / 预设 ⚙️ / 角色卡 🎎
        iconFor(item) {
            if (!item || !item.data) return '🎎';
            if (Array.isArray(item.data.entries)) return '🌍';
            if ('temperature' in item.data || 'prompts' in item.data || 'prompt_order' in item.data) return '⚙️';
            return '🎎';
        },
        // 🛡️ 文件名安全提取：path 缺失（未落盘条目）时不再裸 split 抛错（AR-39 次要崩点）
        fileNameOf(item) {
            if (!item) return '';
            const p = item.path;
            if (typeof p !== 'string' || !p) return item.fileName || item.name || '';
            return p.split(/[\\/]/).pop() || '';
        },
        // 🧩 词条对载荷（缓存：同一 pair 在模板里被读多次，避免重复构造）
        payloadFor(pair) {
            if (!pair || typeof pair !== 'object') return prepareDiffPayload(null, null);
            const cached = this._payloadCache.get(pair);
            if (cached) return cached;
            const payload = prepareDiffPayload(pair.a, pair.b);
            this._payloadCache.set(pair, payload);
            return payload;
        }
    }
};
</script>
