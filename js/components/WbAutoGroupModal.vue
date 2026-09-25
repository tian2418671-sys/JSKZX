<!--
  WbAutoGroupModal 世界书自动分组 + 预览 + 执行 + 回滚（S4 · 2026-09-25）
  ─────────────────────────────────────────────────────────────
  · 「📋 收纳规则」：目标分组 + 收纳条件（世界书判定材料 = 书名 + 词条名），含虚拟分组迁移助手
  · 「🔍 预览与执行」：扫描计划（可勾选）→ 物理移动 → 进度/失败清单 → 一键回滚 + 🤖 AI 判定
  窗口形态对齐 AutoGroupModal（双选项卡）；⚠️ 纯 props/emits 组件——执行/回滚副作用全部 emit 给 App.vue 侧。
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[92vh]">

                <!-- 标题栏 -->
                <div class="px-5 py-4 bg-gray-900 text-white border-b border-gray-800 flex justify-between items-center shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🗂️ 世界书自动分组
                        <span class="text-[10px] font-normal text-gray-400">先预览 · 后执行 · 可回滚（物理移动世界书文件）</span>
                    </h3>
                    <button @click="$emit('close')" class="text-gray-400 hover:text-white transition">✕ 关闭</button>
                </div>

                <!-- 选项卡 -->
                <div class="flex border-b border-gray-200 gap-1 px-5 pt-3 shrink-0 bg-gray-50">
                    <button @click="tab = 'rules'"
                            :class="['px-3 py-1.5 text-xs font-bold rounded-t transition border-b-2',
                                     tab === 'rules' ? 'text-amber-700 border-amber-600 bg-white' : 'text-gray-500 border-transparent hover:text-gray-700']">
                        📋 收纳规则 <span class="text-[10px] font-normal">({{ localProfiles.length }})</span>
                    </button>
                    <button @click="tab = 'preview'"
                            :class="['px-3 py-1.5 text-xs font-bold rounded-t transition border-b-2',
                                     tab === 'preview' ? 'text-amber-700 border-amber-600 bg-white' : 'text-gray-500 border-transparent hover:text-gray-700']">
                        🔍 预览与执行
                        <span v-if="stats.willMove" class="text-[10px] font-normal text-emerald-600">（待移动 {{ stats.willMove }}）</span>
                    </button>
                </div>

                <div class="p-5 overflow-y-auto space-y-3 flex-1 custom-scrollbar text-xs">

                    <!-- ==================== 📋 收纳规则 ==================== -->
                    <div v-if="tab === 'rules'" class="space-y-3">
                        <p class="text-[11px] text-gray-500 leading-relaxed">
                            每行 = 一个 <strong>目标分组</strong> + 该分组声明的 <strong>收纳条件</strong>。
                            判定材料 = <strong>书名 + 全部词条名</strong>（只读轻量索引，不加载大书正文）；
                            <strong class="text-amber-600">分组顺序即优先级</strong>（首个命中者胜）；
                            默认<strong>只处理库根（「默认」）的世界书</strong>，已手动分组的书不会被覆盖。
                        </p>

                        <!-- 迁移助手：虚拟分组 → 物理文件夹（Q6 甲） -->
                        <div class="border border-amber-200 bg-amber-50 rounded-lg p-3 flex items-start justify-between gap-3">
                            <div class="space-y-1">
                                <div class="text-xs font-bold text-amber-700">📦 虚拟分组迁移（一次性）</div>
                                <p class="text-[10px] text-amber-700/90 leading-relaxed">
                                    旧版「移动分组」只记在配置里、文件不动。本助手把存量虚拟分组<strong>物理化</strong>
                                    （按映射把书移进同名子文件夹），完成后清空映射表——此后<strong>物理文件夹为唯一标准</strong>。
                                </p>
                            </div>
                            <button @click="$emit('migrate-virtual')" :disabled="busy"
                                    class="shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white rounded text-xs transition">📦 一键迁移</button>
                        </div>

                        <!-- 规则行 -->
                        <div v-for="(p, idx) in localProfiles" :key="p.id || idx"
                             class="border border-gray-200 rounded-lg p-2.5 bg-gray-50 space-y-1.5">
                            <div class="flex items-center gap-2 flex-wrap">
                                <label class="flex items-center gap-1 shrink-0 cursor-pointer" title="启用/停用这条规则">
                                    <input type="checkbox" v-model="p.enabled" class="w-3.5 h-3.5 accent-amber-600">
                                    <span class="text-[10px] text-gray-500">启用</span>
                                </label>
                                <input v-model="p.group" type="text" list="wbg-group-suggest"
                                       placeholder="目标分组名（新名字 = 自动建同名文件夹）"
                                       class="w-44 shrink-0 bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-amber-500 focus:outline-none">
                                <select v-model="p.match.type"
                                        class="w-48 shrink-0 bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-amber-500 focus:outline-none">
                                    <option v-for="t in matchTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
                                </select>
                                <input v-model="p.match.pattern" type="text"
                                       :placeholder="p.match.type === 'name-regex' ? '例：^修仙|^仙侠（正则）' : '多词用 | 分隔，例：修仙|仙侠|灵根'"
                                       :class="['flex-1 min-w-[160px] bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-amber-500 focus:outline-none', p.match.type === 'name-regex' ? 'font-mono' : '']">
                                <button @click="removeProfile(idx)" class="text-gray-400 hover:text-rose-500 px-2 py-1 rounded hover:bg-gray-100 transition shrink-0" title="删除此规则">🗑️</button>
                            </div>
                            <!-- 🤖 LLM 判定标准（可选；留空 = 该组不参与 AI 判定） -->
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] text-gray-500 shrink-0">🤖 AI 判定标准（可选）：</span>
                                <input v-model="p.llmCriteria" type="text"
                                       placeholder="例：以修仙/宗门/丹道为核心的世界观设定（留空 = 不参与 AI 判定）"
                                       class="flex-1 min-w-0 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-gray-800 focus:border-amber-500 focus:outline-none">
                            </div>
                        </div>
                        <datalist id="wbg-group-suggest">
                            <option v-for="o in groupOptions" :key="o.value" :value="o.value"></option>
                        </datalist>

                        <!-- 操作行 -->
                        <div class="flex items-center gap-2 pt-1">
                            <button @click="addProfile"
                                    class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 text-gray-700 rounded text-xs transition">➕ 添加规则</button>
                            <span class="flex-1"></span>
                            <button @click="$emit('reset-profiles')" :disabled="busy"
                                    class="px-3 py-1.5 bg-white hover:bg-rose-50 border border-rose-300 text-rose-600 rounded text-xs transition disabled:opacity-50">🗑️ 清空规则</button>
                            <button @click="saveProfiles" :disabled="busy"
                                    class="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white rounded text-xs font-bold transition">💾 保存并重扫预览</button>
                        </div>
                        <p v-if="saveHint" class="text-[10px] text-emerald-600">{{ saveHint }}</p>
                    </div>

                    <!-- ==================== 🔍 预览与执行 ==================== -->
                    <div v-else class="space-y-3">
                        <!-- 扫描控制 -->
                        <div class="flex items-center gap-3 flex-wrap">
                            <button @click="rescan" :disabled="busy"
                                    class="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white rounded text-xs font-bold transition">🔄 扫描预览</button>
                            <label class="flex items-center gap-1.5 cursor-pointer">
                                <input type="checkbox" v-model="includeGrouped" @change="rescan" :disabled="busy" class="w-3.5 h-3.5 accent-amber-600">
                                <span class="text-[11px] text-gray-600">包含已分组的书（默认不碰）</span>
                            </label>
                            <span class="flex-1"></span>
                            <button @click="$emit('run-llm')" :disabled="busy || !llmActive"
                                    :title="llmActive ? '对未命中规则的书按各分组「判定标准」请求 AI 归类建议' : '需先在「设置 → API」配置接口'"
                                    class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white rounded text-xs transition">🤖 AI 判定</button>
                            <button v-if="llm.running" @click="$emit('abort-llm')"
                                    class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs transition">⏹ 中止 AI</button>
                        </div>
                        <p class="text-[10px] text-gray-400">判定材料：书名 + 词条名（零正文读取）；🤖 AI 判定需「%s」…耗时取决于候选数量。</p>

                        <!-- LLM 进度 -->
                        <div v-if="llm.running || llm.lastAt" class="border border-indigo-200 bg-indigo-50 rounded-lg p-2.5 text-[11px] space-y-1">
                            <div class="flex justify-between">
                                <span class="font-bold text-indigo-700">🤖 AI 判定{{ llm.running ? '（进行中）' : '（完成）' }}：{{ llm.done }}/{{ llm.total }}</span>
                                <span class="text-indigo-500">建议 {{ llm.suggested }} · 请求 {{ llm.requested }} 次<span v-if="llm.unmatched"> · 未识别 {{ llm.unmatched }}</span></span>
                            </div>
                            <div v-if="llm.errors && llm.errors.length" class="text-amber-700 text-[10px] leading-relaxed">
                                <div v-for="(e, i) in llm.errors.slice(0, 5)" :key="i">· {{ e }}</div>
                            </div>
                        </div>

                        <!-- 无规则提示 -->
                        <div v-if="!stats.enabledProfiles" class="border border-rose-200 bg-rose-50 rounded-lg p-3 text-[11px] text-rose-700">
                            没有启用中的收纳规则 —— 请先到「📋 收纳规则」页配置。
                        </div>

                        <template v-else>
                            <!-- 汇总 -->
                            <div class="flex items-center gap-4 flex-wrap text-[11px] text-gray-600 border border-gray-200 rounded-lg px-3 py-2 bg-gray-50">
                                <span>共 {{ stats.total }} 本 · 将移动 <b class="text-emerald-600">{{ stats.willMove }}</b> 本 · 跳过 {{ stats.skipped }} 本 · 新建文件夹 {{ stats.newFolders }} 个</span>
                                <label class="flex items-center gap-1 cursor-pointer">
                                    <input type="checkbox" :checked="allChecked" @change="toggleAll($event.target.checked)" class="w-3.5 h-3.5 accent-amber-600">
                                    <span>全选可移动项</span>
                                </label>
                            </div>

                            <!-- 计划表 -->
                            <div class="border border-gray-200 rounded-lg overflow-hidden">
                                <div v-if="scan && scan.plan && scan.plan.moves.length" class="max-h-64 overflow-y-auto custom-scrollbar">
                                    <table class="w-full text-[11px]">
                                        <thead class="bg-gray-100 text-gray-500 sticky top-0">
                                            <tr>
                                                <th class="px-2 py-1.5 text-left w-8"></th>
                                                <th class="px-2 py-1.5 text-left">世界书</th>
                                                <th class="px-2 py-1.5 text-left w-32">当前 → 目标</th>
                                                <th class="px-2 py-1.5 text-left">原因</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr v-for="m in scan.plan.moves" :key="m.bookKey" class="border-t border-gray-100 hover:bg-amber-50/40">
                                                <td class="px-2 py-1.5"><input type="checkbox" v-model="checkedKeys" :value="m.bookKey" class="w-3.5 h-3.5 accent-amber-600"></td>
                                                <td class="px-2 py-1.5 font-bold text-gray-800 truncate max-w-[220px]" :title="m.bookKey">{{ m.bookName }}</td>
                                                <td class="px-2 py-1.5 whitespace-nowrap text-gray-600">{{ m.fromGroup }} <span class="text-gray-300">→</span> <b class="text-emerald-700">{{ m.toGroup }}</b></td>
                                                <td class="px-2 py-1.5 text-gray-500 truncate max-w-[260px]" :title="m.reason">{{ m.reason }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                <div v-else class="text-center py-6 text-gray-400 text-[11px]">
                                    {{ scan ? '没有需要移动的世界书（全部已就位或未命中）' : '尚未扫描 —— 点「🔄 扫描预览」生成计划' }}
                                </div>
                            </div>

                            <!-- 新文件夹预告 -->
                            <div v-if="newFolderList.length" class="text-[10px] text-amber-700">
                                📁 将新建文件夹：{{ newFolderList.join('、') }}
                            </div>

                            <!-- 执行 / 中止 / 回滚 -->
                            <div class="flex items-center gap-2 pt-1">
                                <button @click="doExecute" :disabled="busy || checkedKeys.length === 0"
                                        class="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded text-xs font-bold transition">▶ 执行移动（{{ checkedKeys.length }} 本）</button>
                                <button v-if="exec.running" @click="$emit('abort')"
                                        class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs transition">⏹ 中止</button>
                                <span class="flex-1"></span>
                                <button v-if="lastRun && lastRun.entries && lastRun.entries.length" @click="$emit('rollback')" :disabled="busy"
                                        class="px-3 py-1.5 bg-white border border-gray-300 hover:bg-amber-100 disabled:opacity-50 text-gray-700 rounded text-xs transition">
                                    ↩️ 回滚上一次（{{ lastRun.entries.length }} 本）
                                </button>
                            </div>

                            <!-- 执行进度 / 结果 -->
                            <div v-if="exec.running || exec.finishedAt" class="border border-gray-200 rounded-lg p-2.5 text-[11px] space-y-1 bg-gray-50">
                                <div class="flex justify-between">
                                    <span class="font-bold text-gray-700">执行{{ exec.running ? '中' : (exec.aborted ? '（已中止）' : '完成') }}：{{ exec.done }}/{{ exec.total }}</span>
                                    <span class="text-gray-500">成功 {{ exec.moved }} · 失败 {{ exec.failed }}</span>
                                </div>
                                <div v-if="exec.failures && exec.failures.length" class="text-rose-600 text-[10px]">
                                    <div v-for="(f, i) in exec.failures.slice(0, 6)" :key="i">· {{ f.bookName }} → {{ f.toGroup }} 移动失败</div>
                                </div>
                            </div>
                            <div v-if="rollback.running || rollback.finishedAt" class="border border-gray-200 rounded-lg p-2.5 text-[11px] space-y-1 bg-gray-50">
                                <div class="flex justify-between">
                                    <span class="font-bold text-gray-700">回滚{{ rollback.running ? '中' : '完成' }}：{{ rollback.done }}/{{ rollback.total }}</span>
                                    <span class="text-gray-500">已还原 {{ rollback.rolled }}</span>
                                </div>
                                <div v-if="rollback.failed && rollback.failed.length" class="text-amber-700 text-[10px]">
                                    <div v-for="(f, i) in rollback.failed.slice(0, 6)" :key="i">· {{ f.bookName }}：{{ f.reason }}</div>
                                </div>
                            </div>

                            <!-- 跳过项（折叠展示） -->
                            <details v-if="scan && scan.plan && scan.plan.skipped.length" class="text-[11px]">
                                <summary class="cursor-pointer text-gray-500 hover:text-gray-700 select-none">跳过 {{ scan.plan.skipped.length }} 本（点开查看原因）</summary>
                                <div class="mt-1 max-h-40 overflow-y-auto custom-scrollbar border border-gray-100 rounded p-2 space-y-0.5">
                                    <div v-for="(s, i) in scan.plan.skipped" :key="i" class="text-[10px] text-gray-500">
                                        · {{ s.bookName }}（{{ s.currentGroup }}）：{{ s.reason }}
                                    </div>
                                </div>
                            </details>
                        </template>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'WbAutoGroupModal',
    props: {
        show: { type: Boolean, default: false },
        /** 保存的分组档案（App.vue 的 wbAutoGroupProfiles） */
        profiles: { type: Array, default: () => [] },
        /** 目标分组候选（[{value,label}]——当前库已有分组） */
        groupOptions: { type: Array, default: () => [] },
        scan: { type: Object, default: null },
        exec: { type: Object, default: () => ({ running: false, done: 0, total: 0, moved: 0, failed: 0, aborted: false, failures: [], finishedAt: 0 }) },
        rollback: { type: Object, default: () => ({ running: false, done: 0, total: 0, rolled: 0, failed: [], finishedAt: 0 }) },
        lastRun: { type: Object, default: null },
        llm: { type: Object, default: () => ({ running: false, done: 0, total: 0, requested: 0, suggested: 0, unmatched: 0, errors: [], lastAt: 0 }) },
        llmActive: { type: Boolean, default: false }
    },
    emits: ['close', 'save-profiles', 'reset-profiles', 'rescan', 'execute', 'abort', 'rollback', 'run-llm', 'abort-llm', 'migrate-virtual'],
    data() {
        return {
            tab: 'rules',
            localProfiles: [],
            checkedKeys: [],
            includeGrouped: false,
            saveHint: '',
            matchTypes: [
                { value: 'name-keyword', label: '📛 书名 / 词条名包含关键词' },
                { value: 'name-regex', label: '🔣 书名正则（高级）' }
            ]
        };
    },
    computed: {
        busy() {
            return this.exec.running || this.rollback.running || this.llm.running;
        },
        stats() {
            const c = (this.scan && this.scan.plan && this.scan.plan.counters) || {};
            return { total: c.total || 0, willMove: c.willMove || 0, skipped: c.skipped || 0, newFolders: c.newFolders || 0, enabledProfiles: c.enabledProfiles || 0 };
        },
        allChecked() {
            const moves = (this.scan && this.scan.plan && this.scan.plan.moves) || [];
            return moves.length > 0 && this.checkedKeys.length === moves.length;
        },
        newFolderList() {
            const tg = (this.scan && this.scan.plan && this.scan.plan.targetGroups) || [];
            return tg.filter(g => g.isNew).map(g => g.folder);
        }
    },
    watch: {
        // 外部档案变化 → 刷新本地编辑副本（弹窗关闭时也同步，避免下次打开带旧草稿）
        profiles: {
            immediate: true,
            handler(v) {
                this.localProfiles = JSON.parse(JSON.stringify(Array.isArray(v) ? v : []));
            }
        },
        // 扫描结果变化 → 默认全选可移动项（人工可在表内逐条取消）
        'scan.at'(v) {
            const moves = (this.scan && this.scan.plan && this.scan.plan.moves) || [];
            this.checkedKeys = moves.map(m => m.bookKey);
        },
        // 打开弹窗 → 默认滚到预览页（如果有计划）
        show(v) {
            if (v) {
                this.saveHint = '';
                if (this.scan && this.scan.plan && this.scan.plan.moves.length) this.tab = 'preview';
            }
        }
    },
    methods: {
        addProfile() {
            this.localProfiles.push({
                id: `wgp_new_${Date.now().toString(36)}_${this.localProfiles.length}`,
                group: '',
                enabled: true,
                match: { type: 'name-keyword', pattern: '' },
                note: '',
                llmCriteria: ''
            });
        },
        removeProfile(idx) {
            this.localProfiles.splice(idx, 1);
        },
        saveProfiles() {
            // 清洗：缺分组 / 缺 pattern 的行直接丢弃（并提示）
            const cleaned = [];
            let dropped = 0;
            for (const p of this.localProfiles) {
                const group = String(p.group || '').trim();
                const pattern = String((p.match && p.match.pattern) || '').trim();
                if (!group || !pattern) { dropped++; continue; }
                cleaned.push({
                    id: p.id,
                    group,
                    enabled: p.enabled !== false,
                    match: { type: p.match.type, pattern },
                    note: p.note || '',
                    llmCriteria: String(p.llmCriteria || '').trim()
                });
            }
            this.$emit('save-profiles', cleaned);
            this.saveHint = `✅ 已保存 ${cleaned.length} 条规则${dropped ? `（丢弃 ${dropped} 条不完整行）` : ''}，正在重扫预览…`;
            setTimeout(() => { this.saveHint = ''; }, 4000);
        },
        rescan() {
            this.$emit('rescan', { includeGrouped: this.includeGrouped });
        },
        toggleAll(on) {
            const moves = (this.scan && this.scan.plan && this.scan.plan.moves) || [];
            this.checkedKeys = on ? moves.map(m => m.bookKey) : [];
        },
        doExecute() {
            this.$emit('execute', this.checkedKeys.slice());
        }
    }
};
</script>
