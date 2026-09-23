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
                        <span class="text-emerald-400 truncate">👑 推荐版: {{ displayNameOf(masterItem) }}</span>
                        <span class="text-[10px] text-zinc-500 font-mono truncate">{{ fileNameOf(masterItem) }}</span>
                    </div>
                </div>
                <div class="p-3 flex items-center gap-3">
                    <img v-if="compareItem && compareItem.avatar" :src="compareItem.avatar" class="w-10 h-10 rounded object-cover border border-amber-500/50">
                    <span v-else class="text-3xl opacity-50">{{ iconFor(compareItem) }}</span>
                    <div class="flex flex-col min-w-0">
                        <span class="text-amber-400 truncate">🔍 对比版: {{ displayNameOf(compareItem) }}</span>
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
                            <!-- ⚡ 分页（2026-09-22）：397 个词条卡片 × 两侧 ≈ 1.2 万 DOM 节点，
                                 一次性全渲染是弹窗卡顿的两大来源之一（另一处是整篇比对） -->
                            <div class="text-[10px] text-zinc-500 px-1 pb-1">
                                显示前 {{ visiblePairs(idx, f.pairs).length }} / {{ (f.pairs || []).length }} 个词条
                            </div>
                            <div v-for="(p, pIdx) in visiblePairs(idx, f.pairs)" :key="pIdx"
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
                                                      class="border px-1.5 py-0.5 rounded text-[10px]"
                                                      :class="keyClass(payloadFor(p), k, 'a')">{{ k }}</span>
                                            </div>
                                            <!-- 🎨 行对齐差异着色：变更行红/绿底 + 行内精确高亮 -->
                                            <!-- ⚡ 分块渲染：单词条正文可达数千行，一次性全渲染会卡死主线程 -->
                                            <div v-if="p.side === 'both' && payloadFor(p).changed"
                                                 class="text-zinc-400 max-h-[220px] overflow-y-auto custom-scrollbar rounded border border-zinc-800/60 bg-black/20">
                                                <div v-for="(row, rIdx) in visibleEntryRows(idx, pIdx, payloadFor(p).diffRows)" :key="rIdx"
                                                     class="flex gap-2 px-1 py-px leading-relaxed"
                                                     :class="rowClass(row.kind)">
                                                    <span class="shrink-0 w-7 text-right text-[9px] text-zinc-600 select-none">{{ row.a ? row.a.no : '' }}</span>
                                                    <span class="min-w-0 whitespace-pre-wrap break-words"><template v-if="row.a"><template v-for="(sg, sIdx) in row.a.segs" :key="sIdx"><span :class="sg.hl ? hlClass(row.kind) : ''">{{ sg.text }}</span></template></template><span v-else class="text-zinc-700">·</span></span>
                                                </div>
                                                <div v-if="hasMoreEntryRows(idx, pIdx, payloadFor(p).diffRows)" class="text-center py-1">
                                                    <button @click="showMoreEntryRows(idx, pIdx)"
                                                            class="text-[10px] px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">
                                                        ▼ 显示更多（{{ visibleEntryRows(idx, pIdx, payloadFor(p).diffRows).length }} / {{ payloadFor(p).diffRows.length }} 行）
                                                    </button>
                                                </div>
                                            </div>
                                            <!-- 未变更 / 单侧新增：无差异可着色，原样输出 -->
                                            <div v-else class="text-zinc-400 whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto custom-scrollbar">{{ payloadFor(p).contentA || '（无正文）' }}</div>
                                        </div>
                                        <div v-else class="text-zinc-600 italic">本端无此词条</div>
                                    </div>
                                    <div class="min-w-0 border-l border-zinc-800 pl-3">
                                        <span class="text-[10px] text-amber-400 block mb-1">🔍 对比版</span>
                                        <div v-if="p.b" class="space-y-1">
                                            <div v-if="payloadFor(p).keysB.length" class="flex flex-wrap gap-1">
                                                <span v-for="k in payloadFor(p).keysB" :key="k"
                                                      class="border px-1.5 py-0.5 rounded text-[10px]"
                                                      :class="keyClass(payloadFor(p), k, 'b')">{{ k }}</span>
                                            </div>
                                            <div v-if="p.side === 'both' && payloadFor(p).changed"
                                                 class="text-zinc-400 max-h-[220px] overflow-y-auto custom-scrollbar rounded border border-zinc-800/60 bg-black/20">
                                                <div v-for="(row, rIdx) in visibleEntryRows(idx, pIdx, payloadFor(p).diffRows)" :key="rIdx"
                                                     class="flex gap-2 px-1 py-px leading-relaxed"
                                                     :class="rowClass(row.kind)">
                                                    <span class="shrink-0 w-7 text-right text-[9px] text-zinc-600 select-none">{{ row.b ? row.b.no : '' }}</span>
                                                    <span class="min-w-0 whitespace-pre-wrap break-words"><template v-if="row.b"><template v-for="(sg, sIdx) in row.b.segs" :key="sIdx"><span :class="sg.hl ? hlClass(row.kind) : ''">{{ sg.text }}</span></template></template><span v-else class="text-zinc-700">·</span></span>
                                                </div>
                                                <div v-if="hasMoreEntryRows(idx, pIdx, payloadFor(p).diffRows)" class="text-center py-1">
                                                    <button @click="showMoreEntryRows(idx, pIdx)"
                                                            class="text-[10px] px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">
                                                        ▼ 显示更多（{{ visibleEntryRows(idx, pIdx, payloadFor(p).diffRows).length }} / {{ payloadFor(p).diffRows.length }} 行）
                                                    </button>
                                                </div>
                                            </div>
                                            <div v-else class="text-zinc-400 whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto custom-scrollbar">{{ payloadFor(p).contentB || '（无正文）' }}</div>
                                        </div>
                                        <div v-else class="text-zinc-600 italic">本端无此词条</div>
                                    </div>
                                </div>
                            </div>
                            <div v-if="!f.pairs || !f.pairs.length" class="text-[11px] text-zinc-500 italic px-2 py-1">
                                两本世界书均无词条，无可对齐内容。
                            </div>
                            <div v-if="hasMorePairs(idx, f.pairs)" class="text-center pt-2">
                                <button @click="showMorePairs(idx)"
                                        class="text-[11px] px-3 py-1 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">
                                    ▼ 显示更多词条（已显示 {{ visiblePairs(idx, f.pairs).length }} / {{ f.pairs.length }}）
                                </button>
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
                        <!-- 🎨 改为「行对齐」渲染：两侧共用同一份 rows（行号一一对应）→ 天然对齐，
                             变更行加底色 + 行内精确高亮（此前两侧各自滚动、行与行对不齐） -->
                        <!-- ⚡ 性能（2026-09-22）：**默认折叠 + 分块渲染**。
                             实测真实 397 词条世界书对比会产生 **34,232 个 DOM 节点 / 单次长任务 750ms**，
                             而这段内容与下方「🧩 词条级对齐」重复 → 默认收起，要看再点开。 -->
                        <div v-else-if="f.diffText">
                            <div class="flex items-center justify-between mb-2">
                                <button @click="toggleExpanded(idx)"
                                        class="text-[11px] px-2 py-1 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">
                                    {{ isExpanded(idx) ? '▼ 收起整篇比对' : `▶ 展开整篇比对（共 ${f.diffText.rows.length} 行）` }}
                                </button>
                                <span class="text-[10px] text-zinc-500">
                                    逐条差异请看上方「🧩 词条级对齐」
                                </span>
                            </div>
                            <div v-if="isExpanded(idx)">
                                <div class="grid grid-cols-2 gap-3 text-xs font-mono">
                                    <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar leading-relaxed">
                                        <div v-for="(row, rIdx) in visibleRows(idx, f.diffText.rows)" :key="rIdx"
                                             class="flex gap-2 px-1 py-px rounded-sm"
                                             :class="rowClass(row.kind)">
                                            <span class="shrink-0 w-8 text-right text-[9px] text-zinc-600 select-none">{{ row.a ? row.a.no : '' }}</span>
                                            <span class="min-w-0 whitespace-pre-wrap break-words"><template v-if="row.a"><template v-for="(sg, sIdx) in row.a.segs" :key="sIdx"><span :class="sg.hl ? hlClass(row.kind) : ''">{{ sg.text }}</span></template></template><span v-else class="text-zinc-700">·</span></span>
                                        </div>
                                    </div>
                                    <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar leading-relaxed">
                                        <div v-for="(row, rIdx) in visibleRows(idx, f.diffText.rows)" :key="rIdx"
                                             class="flex gap-2 px-1 py-px rounded-sm"
                                             :class="rowClass(row.kind)">
                                            <span class="shrink-0 w-8 text-right text-[9px] text-zinc-600 select-none">{{ row.b ? row.b.no : '' }}</span>
                                            <span class="min-w-0 whitespace-pre-wrap break-words"><template v-if="row.b"><template v-for="(sg, sIdx) in row.b.segs" :key="sIdx"><span :class="sg.hl ? hlClass(row.kind) : ''">{{ sg.text }}</span></template></template><span v-else class="text-zinc-700">·</span></span>
                                        </div>
                                    </div>
                                </div>
                                <div v-if="hasMoreRows(idx, f.diffText.rows)" class="text-center mt-2">
                                    <button @click="showMoreRows(idx)"
                                            class="text-[11px] px-3 py-1 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">
                                        ▼ 显示更多（已渲染 {{ visibleRows(idx, f.diffText.rows).length }} / {{ f.diffText.rows.length }} 行）
                                    </button>
                                </div>
                            </div>
                        </div>
                        <!-- 🎨 兼容旧结构（masterLines/compareLines）：万一有未改造的调用方，仍能正常渲染 -->
                        <div v-else-if="f.diffLines" class="grid grid-cols-2 gap-3 text-xs font-mono">
                            <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                <template v-for="(line, lIdx) in f.diffLines.masterLines" :key="lIdx">
                                    <div :class="line.type === 'removed' ? 'bg-rose-950/60 text-rose-300 border-l-2 border-rose-500 px-1 my-0.5' : 'text-zinc-500 opacity-50'">
                                        {{ line.text || ' ' }}
                                    </div>
                                </template>
                            </div>
                            <div class="bg-zinc-950/80 border border-zinc-800 rounded p-2.5 max-h-[300px] overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                <template v-for="(line, lIdx) in f.diffLines.compareLines" :key="lIdx">
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
import { diffContentForDisplay } from '../utils/textDiff.js';

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
        return {
            _payloadCache: new WeakMap(),
            // ⚡ 渲染节流（2026-09-22 卡顿修复）
            //   实测：真实 397 词条世界书对比 → **34,232 个 DOM 节点**、单次长任务 **750ms**。
            //   根因是「整篇词条正文总集比对」（23745 行）一次性全部渲染，
            //   且该内容与下方「词条级对齐」重复。
            //   ⇒ ① 整篇比对**默认折叠**（用户要看才展开）；② 任何长列表**分块渲染**。
            expandedFields: {},   // idx → 是否展开整篇比对
            renderLimit: {},      // idx → 整篇比对已渲染行数
            rowLimit: {},         // `${idx}:${pIdx}` → 词条内已渲染行数
            pairsLimit: {},       // idx → 词条级对齐已渲染卡片数
            pageSize: 400,        // 每次「显示更多」递增的行数
            pairsPageSize: 30     // 词条卡片每页数量（397 个卡片 ≈ 1.2 万节点，必须分页）
        };
    },
    watch: {
        // 每次重新打开弹窗都回到「折叠 + 从头渲染」，避免上一次的展开状态与巨大 DOM 残留
        show(v) {
            if (v) {
                this.expandedFields = {};
                this.renderLimit = {};
                this.rowLimit = {};
                this.pairsLimit = {};
            }
        }
    },
    methods: {
        isExpanded(idx) { return !!this.expandedFields[idx]; },
        toggleExpanded(idx) { this.expandedFields = { ...this.expandedFields, [idx]: !this.expandedFields[idx] }; },
        // 词条级对齐：只渲染前 N 个词条卡片（默认 30），其余靠「显示更多」按需追加
        visiblePairs(idx, pairs) {
            const limit = this.pairsLimit[idx] || this.pairsPageSize;
            return pairs.length > limit ? pairs.slice(0, limit) : pairs;
        },
        hasMorePairs(idx, pairs) { return pairs.length > (this.pairsLimit[idx] || this.pairsPageSize); },
        showMorePairs(idx) {
            this.pairsLimit = { ...this.pairsLimit, [idx]: (this.pairsLimit[idx] || this.pairsPageSize) + this.pairsPageSize * 2 };
        },
        // 整篇比对：只渲染前 N 行（默认 400），其余靠「显示更多」按需追加
        visibleRows(idx, rows) {
            const limit = this.renderLimit[idx] || this.pageSize;
            return rows.length > limit ? rows.slice(0, limit) : rows;
        },
        hasMoreRows(idx, rows) { return rows.length > (this.renderLimit[idx] || this.pageSize); },
        showMoreRows(idx) { this.renderLimit = { ...this.renderLimit, [idx]: (this.renderLimit[idx] || this.pageSize) + this.pageSize * 2 }; },
        // 词条内正文行：同样分块（一个词条可达数千行）
        rowKey(idx, pIdx) { return idx + ':' + pIdx; },
        visibleEntryRows(idx, pIdx, rows) {
            const limit = this.rowLimit[this.rowKey(idx, pIdx)] || this.pageSize;
            return rows.length > limit ? rows.slice(0, limit) : rows;
        },
        hasMoreEntryRows(idx, pIdx, rows) { return rows.length > (this.rowLimit[this.rowKey(idx, pIdx)] || this.pageSize); },
        showMoreEntryRows(idx, pIdx) {
            const k = this.rowKey(idx, pIdx);
            this.rowLimit = { ...this.rowLimit, [k]: (this.rowLimit[k] || this.pageSize) + this.pageSize * 2 };
        },
        // 🎨 行底色：区分「新增 / 缺失 / 变更」三类，扫一眼就能定位
        //    ⚠️ 用左版视角：added = 右版独有（绿）→ 对左版而言是「本端缺失」
        rowClass(kind) {
            if (kind === 'removed') return 'bg-rose-950/40';
            if (kind === 'added') return 'bg-emerald-950/40';
            if (kind === 'changed') return 'bg-amber-950/25';
            return '';
        },
        // 🎨 行内高亮：变更行里的具体字符/词加底色（比整行变色精确得多）
        hlClass(kind) {
            if (kind === 'removed') return 'bg-rose-500/40 text-rose-100 rounded-sm px-px';
            if (kind === 'added') return 'bg-emerald-500/40 text-emerald-100 rounded-sm px-px';
            return 'bg-amber-500/35 text-amber-100 rounded-sm px-px';
        },
        // 🎨 触发词底色：本侧独有的词标红（缺）/ 绿（多），两侧都有的保持中性
        //    用户报的场景是「条目内容」看不出差异，但触发词改了同样该一眼看到。
        keyClass(payload, key, side) {
            if (!payload.changed) return 'bg-zinc-800 text-zinc-300 border-zinc-700';
            const inA = payload.keysA.includes(key);
            const inB = payload.keysB.includes(key);
            if (inA && inB) return 'bg-zinc-800 text-zinc-300 border-zinc-700';
            // side='a' 且只在 A 出现 → 右版缺失（红）；side='b' 且只在 B 出现 → 新增（绿）
            if (side === 'a') return 'bg-rose-900/50 text-rose-200 border-rose-500/40';
            return 'bg-emerald-900/50 text-emerald-200 border-emerald-500/40';
        },
        // 依据数据形态返回类型图标：世界书 🌍 / 预设 ⚙️ / 角色卡 🎎
        // ⚡ PK-26：秒开后世界书 `data` 为 null（懒加载）→ 旧写法直接落到 🎎（把世界书画成角色卡）。
        //    补轻量判据（`entryCount` / `wbName` 只在世界书扫描时产生）。
        iconFor(item) {
            if (!item) return '🎎';
            if (typeof item.entryCount === 'number' || item.wbName) return '🌍';
            if (!item.data) return '🎎';
            if (Array.isArray(item.data.entries)) return '🌍';
            if ('temperature' in item.data || 'prompts' in item.data || 'prompt_order' in item.data) return '⚙️';
            return '🎎';
        },
        // ⚡ PK-26：秒开后世界书 `data` 为 null（懒加载）→ 书名优先轻量 `wbName`，
        //    否则弹窗标题回退成文件名，用户看不到真实书名。
        displayNameOf(item) {
            if (!item) return '未知';
            return item.wbName || (item.data && item.data.name) || item.name || '未知';
        },
        // 🛡️ 文件名安全提取：path 缺失（未落盘条目）时不再裸 split 抛错（AR-39 次要崩点）
        fileNameOf(item) {
            if (!item) return '';
            const p = item.path;
            if (typeof p !== 'string' || !p) return item.fileName || item.name || '';
            return p.split(/[\\/]/).pop() || '';
        },
        // 🧩 词条对载荷（缓存：同一 pair 在模板里被读多次，避免重复构造）
        //    🎨 顺带在缓存里预计算「行对齐差异」（两侧共用同一份 rows → 天然对齐）
        payloadFor(pair) {
            if (!pair || typeof pair !== 'object') return prepareDiffPayload(null, null);
            const cached = this._payloadCache.get(pair);
            if (cached) return cached;
            const payload = prepareDiffPayload(pair.a, pair.b);
            // 只在「两侧都有内容且确实有改动」时才做行级 diff（避免无谓开销）
            payload.diffRows = payload.changed
                ? diffContentForDisplay(payload.contentA, payload.contentB).rows
                : [];
            this._payloadCache.set(pair, payload);
            return payload;
        }
    }
};
</script>
