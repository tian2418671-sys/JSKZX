<!--
  CommandPaletteModal 命令面板（Ctrl+Shift+P）—— P2-C
  · 从命令注册表取全部命令：模糊搜索 → ↑↓ 选择 → Enter 执行 → Esc 关闭
  · 评审要求「命令面板与注册表同期上线」：面板可见即是注册表完整性的最强验收
    （43 项若漏注册，面板里就搜不到 → 立刻暴露）

  为什么**不复用** `OptionSelectModal.vue`（方案原设想）：
    后者是"点击即选"的简单选项弹窗，**没有键盘导航**，而命令面板的核心体验恰是纯键盘操作；
    强行复用会把两个用途不同的弹窗拧成一套 props（还要处理互斥的"新建输入框"分支）。
    本组件 120 行、与注册表强相关，独立更清晰。
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
             @click.self="$emit('close')">
            <div class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[620px] max-w-full overflow-hidden flex flex-col">
                <!-- 搜索输入 -->
                <div class="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 shrink-0">
                    <span class="text-zinc-500 text-sm">⌘</span>
                    <input ref="inputRef" v-model="keyword" @keydown="onKeydown" type="text"
                           placeholder="输入命令名称…（↑↓ 选择 · Enter 执行 · Esc 关闭）"
                           class="flex-1 bg-transparent outline-none text-sm text-zinc-100 placeholder-zinc-500">
                    <span class="text-[10px] text-zinc-500 whitespace-nowrap shrink-0">{{ filtered.length }} / {{ commands.length }}</span>
                </div>

                <!-- 命令列表（按 category 分组） -->
                <div class="max-h-[52vh] overflow-y-auto custom-scrollbar">
                    <template v-for="(group, gi) in grouped" :key="gi">
                        <div class="px-4 pt-2 pb-1 text-[10px] font-bold text-zinc-500 bg-zinc-900 sticky top-0">{{ group.category }}</div>
                        <button v-for="item in group.items" :key="item.cmd.id"
                                @click="run(item.cmd)" @mousemove="activeIndex = item.index"
                                class="w-full text-left px-4 py-2 flex items-center justify-between gap-3 transition"
                                :class="item.index === activeIndex ? 'bg-indigo-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'">
                            <span class="truncate">{{ displayTitle(item.cmd) }}</span>
                            <span class="text-[10px] opacity-60 whitespace-nowrap shrink-0">{{ item.cmd.shortcut || '' }}</span>
                        </button>
                    </template>
                    <div v-if="!filtered.length" class="px-4 py-6 text-center text-xs text-zinc-500">没有匹配的命令</div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
import { ref, computed, watch, nextTick } from 'vue';
import { resolveCommandTitle, safeCall } from '../composables/useCommands.js';

export default {
    name: 'CommandPaletteModal',
    props: {
        show: { type: Boolean, default: false },
        commands: { type: Array, default: () => [] },   // 父级传入（已完成 when 过滤 + 排序）
        registry: { type: Object, required: true }
    },
    emits: ['close'],
    setup(props, { emit }) {
        const keyword = ref('');
        const activeIndex = ref(0);
        const inputRef = ref(null);

        const displayTitle = (cmd) => resolveCommandTitle(cmd);

        /** 模糊匹配：按字符顺序在「标题 + 分类 + id + 快捷键」里找（对中文与英文都够用） */
        const filtered = computed(() => {
            const q = keyword.value.trim().toLowerCase();
            if (!q) return props.commands;
            return props.commands.filter(c => {
                const hay = (displayTitle(c) + ' ' + (c.category || '') + ' ' + c.id + ' ' + (c.shortcut || '')).toLowerCase();
                let i = 0;
                for (const ch of q) {
                    i = hay.indexOf(ch, i);
                    if (i < 0) return false;
                    i++;
                }
                return true;
            });
        });

        /** 按 category 分组（保留 filtered 的全局索引，供 ↑↓ 高亮使用） */
        const grouped = computed(() => {
            const out = [];
            filtered.value.forEach((cmd, index) => {
                const cat = cmd.category || '其他';
                const last = out[out.length - 1];
                if (!last || last.category !== cat) out.push({ category: cat, items: [{ cmd, index }] });
                else last.items.push({ cmd, index });
            });
            return out;
        });

        watch(() => props.show, async (v) => {
            if (!v) return;
            keyword.value = '';
            activeIndex.value = 0;
            await nextTick();
            if (inputRef.value && inputRef.value.focus) inputRef.value.focus();
        });
        watch(keyword, () => { activeIndex.value = 0; });

        const move = (delta) => {
            const n = filtered.value.length;
            if (!n) return;
            activeIndex.value = (activeIndex.value + delta + n) % n;
        };

        const run = (cmd) => {
            if (!cmd) return;
            if (safeCall(cmd.disabled, false)) return;   // 禁用命令不可执行
            props.registry.execute(cmd.id);
            emit('close');
        };

        const onKeydown = (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); run(filtered.value[activeIndex.value]); }
            else if (e.key === 'Escape') { e.preventDefault(); emit('close'); }
        };

        return { keyword, activeIndex, inputRef, filtered, grouped, displayTitle, run, onKeydown };
    }
};
</script>
