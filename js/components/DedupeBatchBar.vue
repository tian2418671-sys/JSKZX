<!--
  🧹 查重批量清理工具条（四个查重弹窗共用）
  规格：docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md §二 / §三
  · 本组件**只负责收集规则并发事件**，不做任何判定/删除（判定在 dedupeBatch.js，执行在 useDedupe）
-->
<template>
    <div class="border-b border-zinc-800 bg-zinc-900/80 shrink-0">
        <!-- 折叠头（标题可点，右侧另有显式的「收起 / 展开」按钮） -->
        <div class="px-5 py-2.5 flex items-center justify-between gap-3">
            <button class="flex items-center gap-2 text-sm font-bold text-emerald-400 hover:text-emerald-300 transition min-w-0"
                    @click="toggleOpen" :title="open ? '收起批量清理操作区' : '展开批量清理操作区'">
                <span>{{ open ? '▾' : '▸' }}</span>
                <span class="shrink-0">🧹 批量清理</span>
                <span v-if="plan && plan.stats.files" class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 truncate">
                    预演：{{ plan.stats.groupsPlanned }} 组 / {{ plan.stats.files }} 个文件
                </span>
                <span v-else class="text-[10px] text-zinc-500 font-normal truncate">（勾规则 → 预演 → 一键清理）</span>
            </button>
            <span class="flex items-center gap-2 shrink-0">
                <span v-if="exec.running" class="text-xs text-amber-300">
                    {{ exec.done }} / {{ exec.total }} · 已清理 {{ exec.deleted }}
                    <button class="ml-2 px-2 py-0.5 bg-rose-600/80 hover:bg-rose-500 rounded text-white text-[11px]"
                            @click="$emit('abort')">⏹ 中止</button>
                </span>
                <button class="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 hover:border-zinc-500 text-zinc-300 text-[11px] rounded transition"
                        :title="open ? '收起操作区（只留标题栏）' : '展开操作区'"
                        @click="toggleOpen">
                    {{ open ? '▲ 收起' : '▼ 展开' }}
                </button>
            </span>
        </div>

        <!-- 展开区 -->
        <div v-if="open" class="px-5 pb-3 space-y-2.5">
            <!-- 保留策略（互斥） -->
            <div class="flex items-start gap-2 flex-wrap">
                <span class="text-[11px] text-zinc-400 w-16 shrink-0 pt-1">保留策略</span>
                <label v-for="s in keepOptions" :key="s.value"
                       class="flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer transition"
                       :class="keepBy === s.value ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-300' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-600'">
                    <input type="radio" :value="s.value" v-model="keepBy" class="accent-emerald-500">
                    {{ s.label }}
                </label>
            </div>

            <!-- 处理范围（多选） -->
            <div class="flex items-start gap-2 flex-wrap">
                <span class="text-[11px] text-zinc-400 w-16 shrink-0 pt-1">处理范围</span>
                <label v-for="s in scopeOptions" :key="s.value"
                       class="flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer transition"
                       :class="scopes[s.value] ? 'bg-amber-600/20 border-amber-500/60 text-amber-200' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'">
                    <input type="checkbox" v-model="scopes[s.value]" class="accent-amber-500">
                    {{ s.label }}
                </label>
            </div>

            <!-- 保护 -->
            <div class="flex items-start gap-2 flex-wrap">
                <span class="text-[11px] text-zinc-400 w-16 shrink-0 pt-1">保护</span>
                <label class="flex items-center gap-1 px-2 py-1 rounded border text-[11px] bg-emerald-900/30 border-emerald-600/50 text-emerald-300"
                       title="硬闸门：任何策略都不会把一组删空">
                    <input type="checkbox" checked disabled class="accent-emerald-500">
                    每组必留 1 张
                </label>
                <label class="flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer transition"
                       :class="guards.skipOpen ? 'bg-zinc-700/60 border-zinc-600 text-zinc-200' : 'bg-zinc-800 border-zinc-700 text-zinc-400'">
                    <input type="checkbox" v-model="guards.skipOpen" class="accent-zinc-400">
                    跳过正在编辑的卡
                </label>
                <label class="flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer transition"
                       :class="guards.skipOutside ? 'bg-zinc-700/60 border-zinc-600 text-zinc-200' : 'bg-zinc-800 border-zinc-700 text-zinc-400'">
                    <input type="checkbox" v-model="guards.skipOutside" class="accent-zinc-400">
                    跳过库外路径
                </label>
            </div>

            <!-- 🎯 组选择（全选 / 全不选 / 反选）—— 只影响「哪些组参与批量」，不改处理范围 -->
            <div class="flex items-center gap-2 flex-wrap pt-1">
                <span class="text-[11px] text-zinc-400 w-16 shrink-0">组选择</span>
                <span class="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                    已选 <b class="text-emerald-300">{{ selectedCount }}</b> / {{ totalCount }} 组
                </span>
                <button class="px-2 py-1 text-[11px] rounded border border-zinc-600 bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                        title="所有组都参与批量清理" @click="$emit('select-all')">☑ 全选</button>
                <button class="px-2 py-1 text-[11px] rounded border border-zinc-600 bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                        title="所有组都不参与（只留单组按钮手动处理）" @click="$emit('select-none')">☐ 全不选</button>
                <button class="px-2 py-1 text-[11px] rounded border border-zinc-600 bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                        title="已选的取消、未选的选中" @click="$emit('invert-select')">↔ 反选</button>
                <span class="w-2"></span>
                <button class="px-2 py-1 text-[11px] rounded border border-emerald-700/60 bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-300"
                        title="只勾选「内容完全一致(L0)」的组，并自动打开对应处理范围" @click="selectKind('exact')">✅ 只选 L0</button>
                <button class="px-2 py-1 text-[11px] rounded border border-amber-700/60 bg-amber-900/30 hover:bg-amber-900/50 text-amber-300"
                        title="只勾选「高度相似(L1/L2)」的组，并自动打开对应处理范围" @click="selectKind('similar')">⚠️ 只选相似</button>
                <button class="px-2 py-1 text-[11px] rounded border border-rose-700/60 bg-rose-900/30 hover:bg-rose-900/50 text-rose-300"
                        title="只勾选「仅名称相同」的组（内容无关，谨慎），并自动打开对应处理范围" @click="selectKind('nameonly')">⚠️ 只选仅同名</button>
                <span class="text-[10px] text-zinc-500">（每组的复选框也可单独取消）</span>
            </div>

            <!-- 预演摘要 + 动作 -->
            <div class="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-zinc-800">
                <div class="text-[11px] text-zinc-400 leading-5">
                    <template v-if="plan">
                        <span class="text-emerald-300 font-bold">将清理 {{ plan.stats.groupsPlanned }} 组 / {{ plan.stats.files }} 个文件</span>
                        <span class="text-zinc-500">（约 {{ mbText }}）</span>
                        <span v-if="skipText" class="text-amber-300/90">｜跳过 {{ skippedTotal }} 组：{{ skipText }}</span>
                    </template>
                    <template v-else>
                        点「👁 预演」先看清删哪些、留哪些、跳过哪些（零写入）
                    </template>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 text-xs font-bold rounded"
                            title="预演只读、随时可点：重新计算结果并列出将删除的文件"
                            @click="$emit('preview', payload())">👁 预演</button>
                    <button class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold rounded shadow"
                            :disabled="exec.running || !plan || !plan.stats.files" @click="$emit('execute', payload())">
                        🧹 清理选中{{ plan && plan.stats.files ? `（${plan.stats.files}）` : '' }}
                    </button>
                    <button class="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-300 text-xs rounded"
                            title="在系统文件管理器里打开回收站（删掉的文件都在这里）" @click="$emit('open-trash')">♻️ 回收站</button>
                    <button v-if="undoCount" class="px-2.5 py-1.5 bg-sky-700 hover:bg-sky-600 border border-sky-500/50 text-white text-xs font-bold rounded"
                            title="把本次移入回收站的文件按原路径还原（原位已有同名文件时另存为 _restored_*，绝不覆盖）"
                            @click="$emit('undo')">↩️ 撤销本次（{{ undoCount }}）</button>
                </div>
            </div>

            <!-- 失败清单 -->
            <div v-if="exec.failed && exec.failed.length" class="mt-1 bg-rose-950/40 border border-rose-600/40 rounded p-2 text-[11px]">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-rose-300 font-bold">⚠️ 失败 {{ exec.failed.length }} 个</span>
                    <span class="flex gap-2">
                        <button class="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded" @click="$emit('retry')">↻ 重试失败项</button>
                        <button v-if="missingCount" class="px-2 py-0.5 bg-amber-700 hover:bg-amber-600 text-white rounded"
                                title="只从列表里移除磁盘上已不存在的条目，不动任何文件"
                                @click="$emit('purge-missing')">🧹 移除失效条目（{{ missingCount }}）</button>
                        <button class="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded" @click="copyFailures">📋 复制清单</button>
                    </span>
                </div>
                <div class="max-h-24 overflow-y-auto custom-scrollbar text-zinc-400 space-y-0.5">
                    <div v-for="(f, i) in exec.failed.slice(0, 50)" :key="i" class="truncate" :title="f.path">
                        · {{ baseName(f.path) }} —— {{ f.error }}
                    </div>
                    <div v-if="exec.failed.length > 50" class="text-zinc-500">…还有 {{ exec.failed.length - 50 }} 个</div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
/**
 * 默认规则与方案 §八 一致：只勾「内容完全一致」；保留推荐版；保护全开。
 * 所有状态都是**组件本地**的（弹窗关掉即重置），不落盘。
 */
export default {
    name: 'DedupeBatchBar',
    props: {
        /** 预演计划（`useDedupe.dedupeBatchPlan`） */
        plan: { type: Object, default: null },
        /** 执行进度/结果（`useDedupe.dedupeBatchExec`） */
        exec: { type: Object, default: () => ({ running: false, done: 0, total: 0, deleted: 0, failed: [] }) },
        /** 组级勾选：已选组数 / 总组数（快捷全选/反选用） */
        selectedCount: { type: Number, default: 0 },
        totalCount: { type: Number, default: 0 }
    },
    emits: ['preview', 'execute', 'abort', 'retry', 'open-trash', 'purge-missing', 'undo', 'select-all', 'select-none', 'invert-select', 'select-kind'],
    data() {
        return {
            open: true,
            keepBy: 'center',
            scopes: { exact: true, similar: false, nameonly: false },
            guards: { skipOpen: true, skipOutside: true },
            keepOptions: [
                { value: 'center', label: '👑 推荐版' },
                { value: 'tokens', label: '📝 Token 最多' },
                { value: 'newest', label: '🕒 最新' },
                { value: 'clean-name', label: '📄 文件名最干净' },
                { value: 'size', label: '💾 文件最大' }
            ],
            scopeOptions: [
                { value: 'exact', label: '✅ 内容完全一致(L0)' },
                { value: 'similar', label: '⚠️ 高度相似(L1/L2)' },
                { value: 'nameonly', label: '⚠️ 仅名称相同' }
            ]
        };
    },
    computed: {
        mbText() {
            const b = (this.plan && this.plan.stats && this.plan.stats.bytes) || 0;
            if (!b) return '0 MB';
            return b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
        },
        skippedTotal() {
            const m = (this.plan && this.plan.stats && this.plan.stats.skipByReason) || null;
            if (!m) return 0;
            return Object.values(m).reduce((a, b) => a + b, 0);
        },
        skipText() {
            const m = (this.plan && this.plan.stats && this.plan.stats.skipByReason) || null;
            if (!m) return '';
            return Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ');
        },
        /** 失败清单里「文件不存在」的条数（决定是否显示「移除失效条目」按钮） */
        missingCount() {
            const list = this.exec && Array.isArray(this.exec.failed) ? this.exec.failed : [];
            return list.filter((f) => f && /文件不存在|不存在|ENOENT/i.test(String(f.error || ''))).length;
        },
        /** 本次可撤销的文件数（= 成功移入回收站且尚未撤销的） */
        undoCount() {
            const list = this.exec && Array.isArray(this.exec.deletedPaths) ? this.exec.deletedPaths : [];
            return list.length;
        }
    },
    watch: {
        /** 开始执行时自动展开，保证进度条与失败清单可见 */
        'exec.running'(running) {
            if (running) this.open = true;
        }
    },
    methods: {
        /** 收起 / 展开操作区（标题与右上角按钮共用） */
        toggleOpen() { this.open = !this.open; },
        /**
         * 🎯 按类型只选：**同时自动打开对应处理范围** ——
         * 否则用户点「只选相似」再预演会看到 0 个文件（范围默认只勾 L0），像是功能坏了。
         */
        selectKind(kind) {
            if (kind && kind in this.scopes) this.scopes[kind] = true;
            this.$emit('select-kind', kind);
        },
        payload() {
            return {
                keepBy: this.keepBy,
                scopes: { ...this.scopes },
                guards: { ...this.guards }
            };
        },
        baseName(p) {
            return String(p == null ? '' : p).split(/[\\/]/).pop() || '';
        },
        async copyFailures() {
            const text = (this.exec.failed || []).map((f) => `${f.path}\t${f.error}`).join('\n');
            try { await navigator.clipboard.writeText(text); } catch (e) { /* 剪贴板不可用时静默 */ }
        }
    }
};
</script>
