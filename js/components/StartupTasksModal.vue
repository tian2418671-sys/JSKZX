<!--
  🚀 启动自动任务（设置）— 子组件（2026-10-03 · v2.3.6 五功能之五）

  可配置「启动后要做的事」：轻量体检 / 自动冷备 / 自动查重 —— **全默认关**，不改默认行为。
  ⚠️ 弹窗必须**顶层挂载**（项目历史坑：fixed 定位在子组件里会被裁切）—— 本组件只被 App.vue 挂载。
  规格：docs/规格与计划/功能规格/启动自动任务-实现规格.md §3.3
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">

                <div class="px-5 py-3.5 bg-gray-900 text-white border-b border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🚀 启动自动任务
                        <span class="text-[10px] font-normal text-gray-300">启动后附加任务 · 默认全关</span>
                    </h3>
                    <button @click="$emit('close')" class="text-gray-400 hover:text-white text-sm">✕ 关闭</button>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 custom-scrollbar">

                    <!-- 总开关 -->
                    <label class="flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 cursor-pointer">
                        <input type="checkbox" :checked="cfg.enabled" @change="patch({ enabled: $event.target.checked })" class="mt-0.5 accent-indigo-600">
                        <span class="text-[11px] text-gray-700">
                            <b>启用启动任务</b>（总开关）
                            <span class="block text-[10px] text-gray-500">关掉即完全恢复默认启动行为（不跑任何附加任务、不写日志、不弹提示）</span>
                        </span>
                    </label>

                    <!-- 三个任务 -->
                    <div v-for="t in tasks" :key="t.id" class="rounded-lg border border-gray-200 bg-white p-3"
                         :class="cfg.enabled ? '' : 'opacity-60'">
                        <label class="flex items-start gap-2 cursor-pointer">
                            <input type="checkbox" :checked="!!cfg[t.id]" :disabled="!cfg.enabled"
                                   @change="patch({ [t.id]: $event.target.checked })" class="mt-0.5 accent-indigo-600">
                            <span class="text-[11px] text-gray-700">
                                <b>{{ t.title }}</b>
                                <span class="block text-[10px] text-gray-500">{{ t.desc }}</span>
                                <span class="block text-[10px] mt-0.5" :class="/⚠️/.test(t.cost) ? 'text-amber-600' : 'text-emerald-700'">{{ t.cost }}</span>
                            </span>
                        </label>
                    </div>

                    <!-- 延迟 -->
                    <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 flex items-center gap-2 flex-wrap">
                        <span class="text-[11px] font-bold text-gray-700">延迟执行</span>
                        <input type="number" :min="delayMin" :max="delayMax" step="500" :value="cfg.delayMs" :disabled="!cfg.enabled"
                               @change="patch({ delayMs: Number($event.target.value) })"
                               class="w-24 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-gray-700 disabled:bg-gray-100">
                        <span class="text-[11px] text-gray-600">毫秒（{{ delayMin }}~{{ delayMax }}）</span>
                        <span class="text-[10px] text-gray-500">—— 等「配置恢复 + 首次扫描」完成后再等这么久，避免和首屏抢资源</span>
                    </div>

                    <p class="text-[9px] text-gray-500 leading-relaxed">
                        ⚠️ 冷备会**写外部盘**、查重在万张级大库上耗时较长 —— 两者默认关闭；
                        自动体检只跑统计（复用「🧪 一键质检」的同一套纯函数），结果合并成**一条**提示，点击可打开质检弹窗。
                        设置保存在 <code class="px-1 rounded bg-gray-100 border border-gray-200">app_config.json</code> 的 <code class="px-1 rounded bg-gray-100 border border-gray-200">ui.startupTasks</code>。
                    </p>
                </div>

                <div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
                    <span class="text-[10px] text-gray-500">{{ saved ? '✅ 已保存（自动写盘）' : '改动即时生效（下次启动）' }}</span>
                    <button @click="$emit('close')"
                            class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium transition">知道了</button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
import { STARTUP_TASK_DEFS, DELAY_MIN, DELAY_MAX } from '../utils/startupPlan.js';

export default {
    name: 'StartupTasksModal',
    props: {
        show: { type: Boolean, default: false },
        cfg: { type: Object, default: () => ({ enabled: false, autoAudit: false, autoBackup: false, autoDedupe: false, delayMs: 3000 }) }
    },
    emits: ['close', 'change'],
    data() {
        return { tasks: STARTUP_TASK_DEFS, delayMin: DELAY_MIN, delayMax: DELAY_MAX, saved: false, _t: null };
    },
    methods: {
        patch(p) {
            // 上抛完整新对象（App 侧归一 + 防抖写盘）；总开关关掉时三个子项保持原值，便于再次打开时恢复用户选择
            this.$emit('change', Object.assign({}, this.cfg, p));
            this.saved = true;
            clearTimeout(this._t);
            this._t = setTimeout(() => { this.saved = false; }, 1500);
        }
    },
    beforeUnmount() { clearTimeout(this._t); }
};
</script>
