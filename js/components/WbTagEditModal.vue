<!--
  WbTagEditModal 世界书标签编辑面板（子组件，S1 · 2026-09-25）
  ─────────────────────────────────────────────────────────────
  纯 UI + emits：标签的增删一律回传父级（App.vue 接线 addWbTagOn / removeWbTagOn），
  本组件不直接读写数据层（与项目弹窗范式一致；操作逻辑留在父级）。
  用途：① 右键菜单「🏷️ 编辑标签」② 世界书列表项 🏷️ 按钮
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" @click.self="$emit('close')">
            <div class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[460px] max-w-full p-4 flex flex-col gap-3 text-zinc-200">
                <!-- 标题栏 -->
                <div class="flex items-center justify-between gap-2">
                    <h3 class="text-sm font-bold text-amber-400 shrink-0">🏷️ 编辑标签</h3>
                    <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-sm px-1 transition" title="关闭（Esc）">✕</button>
                </div>
                <!-- 目标书 -->
                <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-xs font-bold text-zinc-100 truncate" :title="wbPath || wbName">{{ wbName || '未命名世界书' }}</span>
                    <span class="text-[10px] text-zinc-600 shrink-0">（标签存在配置层，不写入世界书文件）</span>
                </div>

                <!-- 现有标签 -->
                <div class="flex flex-wrap items-center gap-1 min-h-[28px] bg-black/30 border border-zinc-800 rounded-lg px-2 py-1.5">
                    <span v-for="t in tags" :key="t"
                          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                        #{{ t }}
                        <button @click="$emit('remove', t)" class="text-indigo-400/70 hover:text-rose-400 transition" :title="`移除「${t}」`">✕</button>
                    </span>
                    <span v-if="!tags.length" class="text-[11px] text-zinc-600">（暂无标签）</span>
                </div>

                <!-- 输入框（回车 / 逗号分隔添加） -->
                <div class="flex items-center gap-1.5">
                    <input v-model="input" type="text"
                           placeholder="输入新标签，回车添加（逗号分隔可一次加多个）..."
                           class="flex-1 h-8 bg-zinc-800/80 border border-zinc-700/60 rounded-lg px-2.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/80 transition"
                           @keyup.enter="submit" @keyup.esc="$emit('close')">
                    <button @click="submit" :disabled="!input.trim()"
                            class="h-8 px-3 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-bold rounded-lg transition shrink-0">
                        ＋ 添加
                    </button>
                </div>

                <!-- 全库已有标签建议（点击即加） -->
                <div v-if="suggestions.length" class="flex flex-col gap-1.5">
                    <span class="text-[10px] text-zinc-500">全库已有标签（点击添加，数字 = 使用本数）：</span>
                    <div class="flex flex-wrap gap-1 max-h-36 overflow-y-auto custom-scrollbar pr-0.5">
                        <button v-for="s in suggestions" :key="s.tag"
                                @click="add(s.tag)" :disabled="tags.includes(s.tag)"
                                :class="tags.includes(s.tag)
                                    ? 'bg-zinc-800/50 border-zinc-700/50 text-zinc-600 cursor-not-allowed'
                                    : 'bg-zinc-800/80 border-zinc-700/60 text-zinc-300 hover:bg-sky-600 hover:text-white hover:border-sky-500'"
                                class="h-6 px-2 inline-flex items-center rounded-md border text-[10px] transition whitespace-nowrap">
                            {{ s.tag }}<span class="opacity-60 ml-0.5">{{ s.count }}</span>
                        </button>
                    </div>
                </div>

                <!-- 底部操作 -->
                <div class="flex justify-end gap-2 pt-0.5">
                    <button @click="$emit('close')"
                            class="h-7 px-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/60 text-zinc-300 text-xs rounded-lg transition">
                        完成
                    </button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'WbTagEditModal',
    props: {
        show: { type: Boolean, default: false },
        /** 目标世界书显示名 */
        wbName: { type: String, default: '' },
        /** 目标世界书路径（tooltip / 兜底显示；不直接用于读写） */
        wbPath: { type: String, default: '' },
        /** 该书当前标签（string[]） */
        tags: { type: Array, default: () => [] },
        /** 全库标签建议（[{tag, count}]，来自 wbAllTags） */
        suggestions: { type: Array, default: () => [] }
    },
    emits: ['add', 'remove', 'close'],
    data() {
        return { input: '' };
    },
    methods: {
        submit() {
            const v = this.input.trim();
            if (!v) return;
            // 逗号 / 顿号分隔可一次加多个（规范化去空由父级 addWbTagOn 负责）
            const parts = v.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
            for (const p of parts) this.$emit('add', p);
            this.input = '';
        },
        add(tag) {
            if (this.tags.includes(tag)) return;
            this.$emit('add', tag);
        }
    }
};
</script>
