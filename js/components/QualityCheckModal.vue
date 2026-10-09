<!--
  🧪 一键质检流水线（v2.3.6 五功能之四）— 子组件

  定位：把散落的**只读**检查能力串成一条流水线，出一份综合报告（可复制 / 导出 Markdown）。
  ⚠️ 全流程只读：不动库、不删文件、不保存配置（规格 §五「只读承诺」）。
  ⚠️ 弹窗必须**顶层挂载**（项目历史坑：fixed 定位在子组件里会被裁切）—— 本组件只被 App.vue 挂载。
  规格：docs/规格与计划/功能规格/一键质检流水线-实现规格.md
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">

                <!-- 头部 -->
                <div class="px-5 py-3.5 bg-gray-900 text-white border-b border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🧪 一键质检
                        <span class="text-[10px] font-normal text-gray-300">只读检查 · 不动库 · 不删文件</span>
                    </h3>
                    <button @click="$emit('close')" :disabled="running" class="text-gray-400 hover:text-white text-sm disabled:opacity-40">✕ 关闭</button>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 custom-scrollbar">

                    <!-- 步骤勾选 + 控制 -->
                    <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
                            <label v-for="s in stepsMeta" :key="s.id" class="flex items-start gap-2 cursor-pointer">
                                <input type="checkbox" :checked="!!enabled[s.id]" :disabled="running"
                                       @change="$emit('toggle-step', s.id, $event.target.checked)"
                                       class="mt-0.5 accent-indigo-600">
                                <span class="text-[11px] text-gray-700">
                                    <b>{{ s.title }}</b>
                                    <span class="block text-[10px] text-gray-500">{{ s.desc }}</span>
                                </span>
                            </label>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap pt-0.5">
                            <span class="text-[11px] text-gray-600">Token 阈值</span>
                            <input type="number" min="100" step="500" :value="tokenThreshold" :disabled="running"
                                   @change="$emit('update:tokenThreshold', Number($event.target.value) || 8000)"
                                   class="w-24 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-gray-700">
                            <span class="text-[10px] text-gray-500">（超过即计入 S4「Token 超阈值」，默认 8000）</span>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <button @click="$emit('run')" :disabled="running || !anyEnabled"
                                    :title="!anyEnabled ? '至少勾选一个步骤' : '开始质检（只读）'"
                                    class="px-3.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold disabled:bg-gray-300 disabled:cursor-not-allowed transition">▶ 开始质检</button>
                            <button v-if="running" @click="$emit('cancel')"
                                    class="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-bold transition">⛔ 中止</button>
                            <span v-if="running" class="text-[11px] text-indigo-700">第 {{ currentIndex + 1 }}/{{ stepsMeta.length }} 步 · 已用 {{ elapsedSec }}s</span>
                            <span v-else-if="elapsedSec !== '0.0'" class="text-[11px] text-gray-600">上次用时 {{ elapsedSec }}s</span>
                        </div>
                    </div>

                    <!-- 结果分区 -->
                    <div v-for="(s, i) in steps" :key="s.id" class="rounded-lg border border-gray-200 bg-white overflow-hidden">
                        <button @click="toggle(i)" class="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-gray-50 transition">
                            <span class="text-[11px] font-bold text-gray-700 flex items-center gap-2">
                                {{ statusIcon(s.status) }} {{ s.title }}
                                <span v-if="s.ms" class="text-[9px] font-normal text-gray-400">（{{ (s.ms / 1000).toFixed(2) }}s）</span>
                            </span>
                            <span class="text-[10px] text-gray-500">{{ open[i] ? '▾' : '▸' }}</span>
                        </button>
                        <div v-if="open[i]" class="px-3 pb-2.5 space-y-1.5 border-t border-gray-100">
                            <p class="text-[11px]" :class="s.status === 'failed' ? 'text-rose-700' : (s.status === 'skipped' ? 'text-gray-500' : 'text-gray-700')">
                                {{ s.summary || '—' }}<span v-if="s.error" class="block text-rose-700">错误：{{ s.error }}</span>
                            </p>
                            <div v-if="s.items && s.items.length" class="space-y-0.5">
                                <div v-for="(it, j) in s.items.slice(0, 50)" :key="s.id + '-' + j"
                                     class="flex items-center gap-2 text-[10px] text-gray-600">
                                    <span class="flex-1 min-w-0 truncate" :title="it.name || it.path">
                                        {{ it.kind === 'tag' ? '🏷' : (it.kind === 'wb-entry' ? '📚' : '🃏') }} {{ it.name || it.path }}
                                        <span v-if="it.detail" class="text-gray-400">— {{ it.detail }}</span>
                                    </span>
                                    <button v-if="it.kind === 'card' && it.path" @click="$emit('locate', it)"
                                            class="px-1.5 py-0.5 rounded border border-indigo-300 bg-white text-indigo-700 hover:bg-indigo-50 transition shrink-0">定位</button>
                                </div>
                                <p v-if="s.items.length > 50" class="text-[9px] text-gray-400">（仅显示前 50 条，共 {{ s.items.length }} 条）</p>
                            </div>
                        </div>
                    </div>

                    <p class="text-[9px] text-gray-500 leading-relaxed">
                        ⚠️ 本流水线**只读**：不修改、不删除、不保存任何数据；查重的「清理」按钮不在流水线内触发。
                        动手清理前建议先做「📦 整库冷备」留一个时间点。
                    </p>
                </div>

                <!-- 底部 -->
                <div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
                    <span class="text-[10px]" :class="msg ? 'text-emerald-700' : 'text-gray-500'">{{ msg || (running ? '质检进行中…' : (hasReport ? '报告可复制或导出 Markdown' : '💡 建议先做整库冷备，再按报告动手清理')) }}</span>
                    <div class="flex items-center gap-2">
                        <button @click="copyReport" :disabled="!hasReport"
                                class="px-2.5 py-1.5 rounded border border-gray-300 bg-white text-gray-700 text-[11px] hover:bg-gray-100 disabled:opacity-40 transition">📋 复制报告</button>
                        <button @click="exportReport" :disabled="!hasReport || exporting"
                                class="px-2.5 py-1.5 rounded border border-indigo-300 bg-white text-indigo-700 text-[11px] hover:bg-indigo-50 disabled:opacity-40 transition">{{ exporting ? '导出中…' : '💾 导出 Markdown' }}</button>
                        <button @click="$emit('close')" :disabled="running"
                                class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-50 transition">知道了</button>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
/**
 * 纯展示 + 动作上抛：状态全部在 `useQualityCheck`（App.vue 侧），组件不自己算任何数字。
 */
export default {
    name: 'QualityCheckModal',
    props: {
        show: { type: Boolean, default: false },
        steps: { type: Array, default: () => [] },
        stepsMeta: { type: Array, default: () => [] },
        enabled: { type: Object, default: () => ({}) },
        running: { type: Boolean, default: false },
        currentIndex: { type: Number, default: 0 },
        elapsedSec: { type: String, default: '0.0' },
        tokenThreshold: { type: Number, default: 8000 },
        report: { type: String, default: '' }
    },
    emits: ['close', 'run', 'cancel', 'locate', 'toggle-step', 'update:tokenThreshold'],
    data() {
        return { open: {}, exporting: false, msg: '' };
    },
    computed: {
        anyEnabled() { return Object.values(this.enabled || {}).some(Boolean); },
        hasReport() { return !!(this.report && this.report.length); }
    },
    watch: {
        show(v) {
            if (v) {
                // 默认只展开「有内容或非待执行」的步骤，避免一屏全是空区
                const o = {};
                this.steps.forEach((s, i) => { o[i] = !!(s.summary || s.error); });
                this.open = o;
                this.msg = '';
            }
        }
    },
    methods: {
        toggle(i) { this.open = Object.assign({}, this.open, { [i]: !this.open[i] }); },
        statusIcon(st) {
            return { pending: '⏸', running: '⏳', done: '✅', skipped: '⏭', failed: '❌', cancelled: '⛔' }[st] || '⏸';
        },
        async copyReport() {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(this.report);
                    this.msg = '已复制';
                    return;
                }
                throw new Error('剪贴板不可用');
            } catch (e) {
                // 兜底：临时 textarea + execCommand（Electron 下 clipboard API 在个别环境受限）
                try {
                    const ta = document.createElement('textarea');
                    ta.value = this.report;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    this.msg = '已复制';
                } catch (e2) {
                    this.msg = '复制失败：' + ((e2 && e2.message) || '请手动选择文本');
                }
            }
        },
        async exportReport() {
            const api = window.electronAPI;
            if (!api || typeof api.saveTextFile !== 'function') { this.msg = '导出失败：当前环境不支持保存文件'; return; }
            this.exporting = true;
            try {
                const stamp = (() => {
                    const d = new Date(); const p = (x) => String(x).padStart(2, '0');
                    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
                })();
                const r = await api.saveTextFile({
                    defaultName: `一键质检报告_${stamp}.md`,
                    content: this.report,
                    filters: [{ name: 'Markdown', extensions: ['md'] }]
                });
                if (r && r.ok) this.msg = `已导出 ${Math.round((r.bytes || 0) / 1024)} KB`;
                else if (r && r.canceled) this.msg = '';
                else this.msg = '导出失败：' + ((r && r.error) || '未知错误');
            } catch (e) {
                this.msg = '导出失败：' + ((e && e.message) || String(e));
            } finally {
                this.exporting = false;
            }
        }
    }
};
</script>
