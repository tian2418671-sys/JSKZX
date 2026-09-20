<!--
  🏷️ 打标过程实时日志窗口（应用内窗口 —— 替代「打标完成」系统弹框）
  ─────────────────────────────────────────────────────────────
  · 打标一启动自动打开（useAITools.startAITagging 负责 showAiTagLog=true 并写入日志流）
  · 终端风：逐张卡展示 ①规则 / ②向量 / ③LLM 的处理过程与失败归类，肉眼可检查
  · 结束后保留（可复制日志 / 清空 / 关闭）；仅 props 驱动（log/running/progress）
-->
<template>
    <transition name="fade">
        <!-- z-[60]：必须高于打标弹窗（z-50）——打标进行中两窗同开，过程窗口必须浮在最上（AR-36） -->
        <div v-if="show" class="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4">
            <div class="bg-zinc-950 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh] overflow-hidden">

                <!-- 标题栏 -->
                <div class="px-4 py-3 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 shrink-0">
                    <h3 class="font-bold text-sm text-zinc-100">🏷️ 打标过程</h3>
                    <span class="text-[10px]" :class="running ? 'text-amber-400' : 'text-emerald-400'">
                        {{ running ? '⏳ 打标中…' : '✅ 已结束（保留作记录）' }}
                    </span>
                    <span class="flex-1"></span>
                    <button @click="copyLog" :disabled="!log.length"
                            class="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 transition">
                        {{ copied ? '已复制 ✓' : '📄 复制日志' }}
                    </button>
                    <button @click="$emit('clear')" :disabled="running || !log.length"
                            class="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 transition">🧹 清空</button>
                    <button @click="$emit('close')" class="text-zinc-400 hover:text-white transition text-sm px-1">✕ 关闭</button>
                </div>

                <!-- 进度条 -->
                <div v-if="total > 0" class="px-4 py-2 bg-zinc-900/60 border-b border-zinc-800 shrink-0">
                    <div class="flex items-center gap-2 text-[10px] text-zinc-400">
                        <span class="truncate">{{ progressText || '—' }}</span>
                        <span class="flex-1"></span>
                        <span class="shrink-0">{{ doneCount }} / {{ total }}</span>
                    </div>
                    <div class="mt-1 h-1.5 bg-zinc-800 rounded overflow-hidden">
                        <div class="h-full bg-emerald-500 transition-all" :style="{ width: percent + '%' }"></div>
                    </div>
                </div>

                <!-- 日志主体（终端风） -->
                <div ref="box" class="flex-1 overflow-y-auto custom-scrollbar px-4 py-3 font-mono text-[11px] leading-relaxed">
                    <div v-if="!log.length" class="text-zinc-600 text-center py-10">
                        暂无日志 —— 启动打标后，这里会实时展示每张卡的处理过程（①规则 / ②向量 / ③LLM）
                    </div>
                    <div v-for="(l, i) in log" :key="i" class="whitespace-pre-wrap break-all" :class="levelClass(l.level)">
                        <span class="text-zinc-600 select-none">{{ fmtTime(l.at) }}</span>
                        <span class="ml-1.5">{{ l.text }}</span>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    name: 'AiTagLogModal',
    props: {
        show: { type: Boolean, default: false },
        log: { type: Array, default: () => [] },                  // [{ at, level, text }]
        running: { type: Boolean, default: false },               // 打标进行中
        progress: { type: Object, default: () => ({}) }           // { current, total, status }
    },
    emits: ['close', 'clear'],
    data() {
        return { copied: false };
    },
    computed: {
        total() { return Number(this.progress && this.progress.total) || 0; },
        doneCount() { return Number(this.progress && this.progress.current) || 0; },
        progressText() { return (this.progress && this.progress.status) || ''; },
        percent() {
            return this.total ? Math.min(100, Math.round(this.doneCount / this.total * 100)) : 0;
        }
    },
    watch: {
        // 新日志到达 → 自动滚到底（打标过程的"直播感"）
        'log.length'() {
            this.scrollToBottom();
        },
        show(v) {
            if (v) this.scrollToBottom();
        }
    },
    methods: {
        fmtTime(ts) {
            const d = new Date(Number(ts) || Date.now());
            const p = (n) => String(n).padStart(2, '0');
            return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        },
        levelClass(level) {
            if (level === 'ok') return 'text-emerald-400';
            if (level === 'err') return 'text-rose-400';
            if (level === 'warn') return 'text-amber-400';
            if (level === 'dim') return 'text-zinc-500';
            return 'text-zinc-300';
        },
        scrollToBottom() {
            this.$nextTick(() => {
                const el = this.$refs.box;
                if (el) el.scrollTop = el.scrollHeight;
            });
        },
        async copyLog() {
            const text = this.log.map(l => `[${this.fmtTime(l.at)}] ${l.text}`).join('\n');
            let ok = false;
            try {
                await navigator.clipboard.writeText(text);
                ok = true;
            } catch (e) { ok = false; }
            if (!ok) {
                // 兜底：老式选区复制（app:// 下 clipboard API 可能不可用）
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                } catch (e) { ok = false; }
            }
            this.copied = ok;
            setTimeout(() => { this.copied = false; }, 1500);
        }
    }
};
</script>
