<!--
  CommandMenuItem —— 单个命令按钮（P2）
  · 由 `HeaderBar` 用于渲染「菜单项」与「工具栏按钮」两种形态；命令对象来自命令注册表
    （见 `js/utils/commandRegistry.js` 与 `js/composables/useCommands.js`）。
  · ⚠️ 纯 props 组件：**不 inject ctx**（避免多一处 AR-13 式"四步"遗漏），`registry` 由父级显式传入。
-->
<template>
    <button @click="run"
            :disabled="disabled"
            :title="tooltip"
            class="command-item"
            :class="[baseClass, cmd.extraClass || '']">
        <span>{{ displayTitle }}</span>
        <template v-if="variant !== 'toolbar'">
            <span v-if="badgeText" class="text-[10px] font-mono opacity-70" :class="badgeClass">{{ badgeText }}</span>
            <span v-else-if="isChecked" class="text-indigo-400 font-bold">✓</span>
            <span v-else-if="cmd.shortcut" class="text-[10px] opacity-60 whitespace-nowrap">{{ cmd.shortcut }}</span>
        </template>
        <span v-else-if="isChecked" class="text-indigo-400 font-bold">✓</span>
    </button>
</template>

<script>
import { resolveCommandTitle, safeCall } from '../composables/useCommands.js';

export default {
    name: 'CommandMenuItem',
    props: {
        cmd: { type: Object, required: true },
        registry: { type: Object, required: true },
        variant: { type: String, default: 'menu' },     // 'menu' | 'toolbar'
        // 覆盖基础样式（工具栏里个别按钮样式不同，如右侧「备份配置」）
        baseClassOverride: { type: String, default: '' }
    },
    emits: ['executed'],
    computed: {
        displayTitle() { return resolveCommandTitle(this.cmd); },
        baseClass() {
            if (this.baseClassOverride) return this.baseClassOverride;
            return this.variant === 'toolbar'
                ? 'flex items-center gap-1.5 px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 rounded text-zinc-400 transition whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed'
                : 'px-3 py-1.5 text-left hover:bg-indigo-600 hover:text-white flex items-center justify-between gap-3 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed';
        },
        disabled() { return !!safeCall(this.cmd.disabled, false); },
        isChecked() { return !!safeCall(this.cmd.checked, false); },
        badgeText() { return safeCall(this.cmd.badge, ''); },
        badgeClass() { return safeCall(this.cmd.badgeClass, ''); },
        tooltip() {
            return safeCall(this.cmd.tooltipFn, null)
                || this.cmd.tooltip
                || safeCall(this.cmd.badgeTitle, null)
                || '';
        }
    },
    methods: {
        run() {
            if (this.disabled) return;
            const ok = this.registry.execute(this.cmd.id);
            this.$emit('executed', { id: this.cmd.id, ok });
        }
    }
};
</script>
