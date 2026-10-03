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
                    <span class="text-[10px]" :class="(running || paused) ? 'text-amber-400' : 'text-emerald-400'">
                        {{ running ? '⏳ 打标中…' : (paused ? '⏸ 已暂停（可继续）' : '✅ 已结束（保留作记录）') }}
                    </span>
                    <span class="flex-1"></span>
                    <button v-if="running" @click="$emit('pause-tagging')"
                            class="px-2 py-1 bg-amber-600 hover:bg-amber-500 rounded text-[10px] text-white font-bold transition">⏸ 暂停</button>
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
                        <button v-if="l.detail" @click.stop="toggleDetail(i)"
                                class="ml-1.5 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 text-[10px] align-middle transition">
                            {{ isDetailOpen(i) ? '收起 ▲' : '🔍 查看' }}
                        </button>
                        <!-- 🔍 请求详情（过程透明化）：完整发送数据 + AI 原始回复/思考 -->
                        <div v-if="l.detail && isDetailOpen(i)"
                             class="mt-1.5 mb-2 border border-zinc-700 rounded-lg overflow-hidden bg-zinc-900/70 font-mono">
                            <div class="px-2.5 py-1.5 border-b border-zinc-800 flex items-center gap-2">
                                <span class="text-[10px] text-zinc-400 font-bold">🔍 {{ l.detail.title }}<template v-if="l.detail.mode"> · {{ l.detail.mode }}</template></span>
                                <span class="flex-1"></span>
                                <button @click.stop="copyDetail(i)"
                                        class="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 hover:bg-zinc-700 transition">
                                    {{ copiedIdx === i ? '已复制 ✓' : '📄 复制全部' }}
                                </button>
                            </div>
                            <div v-if="l.detail.error" class="px-2.5 py-2 text-rose-400 text-[10px] whitespace-pre-wrap break-all">❌ 失败：{{ l.detail.error }}</div>
                            <template v-for="(m, mi) in (l.detail.messages || [])" :key="mi">
                                <div class="px-2.5 pt-2 text-[10px] text-indigo-300 font-bold">📤 发送 · {{ roleLabel(m.role) }}（{{ String(m.content || '').length }} 字）</div>
                                <pre class="mx-2.5 mt-1 max-h-56 overflow-y-auto custom-scrollbar bg-zinc-950 border border-zinc-800 rounded p-2 text-[10px] text-zinc-300 whitespace-pre-wrap break-all font-mono">{{ m.content }}</pre>
                            </template>
                            <template v-if="l.detail.reasoning">
                                <div class="px-2.5 pt-2 text-[10px] text-amber-300 font-bold">🧠 模型思考（{{ l.detail.reasoning.length }} 字）</div>
                                <pre class="mx-2.5 mt-1 max-h-56 overflow-y-auto custom-scrollbar bg-zinc-950 border border-zinc-800 rounded p-2 text-[10px] text-amber-200/80 whitespace-pre-wrap break-all font-mono">{{ l.detail.reasoning }}</pre>
                            </template>
                            <div class="px-2.5 pt-2 text-[10px] text-emerald-300 font-bold">📥 AI 原始回复（{{ String(l.detail.rawReply || '').length }} 字）</div>
                            <pre class="mx-2.5 mt-1 mb-2.5 max-h-64 overflow-y-auto custom-scrollbar bg-zinc-950 border border-zinc-800 rounded p-2 text-[10px] text-zinc-200 whitespace-pre-wrap break-all font-mono">{{ l.detail.rawReply || (l.detail.rawData ? '（空 —— 未从返回中提取到回复文本，请见下方「🧾 API 原始响应」）' : '（空）') }}</pre>
                            <template v-if="l.detail.rawData">
                                <div class="px-2.5 pt-2 text-[10px] text-cyan-300 font-bold">🧾 API 原始响应（{{ l.detail.rawData.length }} 字）</div>
                                <pre class="mx-2.5 mt-1 mb-2.5 max-h-64 overflow-y-auto custom-scrollbar bg-zinc-950 border border-zinc-800 rounded p-2 text-[10px] text-cyan-100/70 whitespace-pre-wrap break-all font-mono">{{ l.detail.rawData }}</pre>
                            </template>
                        </div>
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
        paused: { type: Boolean, default: false },                // ⏸ 已暂停（可继续）
        progress: { type: Object, default: () => ({}) }           // { current, total, status }
    },
    emits: ['close', 'clear', 'pause-tagging'],
    data() {
        return { copied: false, openMap: {}, copiedIdx: -1 };
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
        // 新日志到达 → 自动滚到底（打标过程的"直播感"）；
        // 🔍 有详情展开时暂停自动滚底（避免把正在看详情的用户拉走）
        'log.length'() {
            if (!Object.keys(this.openMap).length) this.scrollToBottom();
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
        /** 复制文本（clipboard API + 老式选区兜底） */
        async copyText(text) {
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
            return ok;
        },
        async copyLog() {
            const text = this.log.map(l => `[${this.fmtTime(l.at)}] ${l.text}`).join('\n');
            this.copied = await this.copyText(text);
            setTimeout(() => { this.copied = false; }, 1500);
        },
        // 🔍 过程透明化（2026-09-27）：请求详情展开/收起 + 复制
        isDetailOpen(i) { return !!this.openMap[i]; },
        toggleDetail(i) {
            if (this.openMap[i]) delete this.openMap[i];
            else this.openMap[i] = true;
        },
        roleLabel(role) {
            if (role === 'system') return 'System';
            if (role === 'user') return 'User';
            if (role === 'assistant') return '预填充（assistant）';
            return String(role || '');
        },
        detailText(d) {
            const parts = [`🔍 ${d.title || ''}${d.mode ? ' · ' + d.mode : ''}`];
            for (const m of (d.messages || [])) parts.push(`\n───── 📤 发送 · ${this.roleLabel(m.role)}（${String(m.content || '').length} 字）─────\n${m.content || ''}`);
            if (d.reasoning) parts.push(`\n───── 🧠 模型思考（${d.reasoning.length} 字）─────\n${d.reasoning}`);
            if (d.error) parts.push(`\n❌ 失败：${d.error}`);
            parts.push(`\n───── 📥 AI 原始回复（${String(d.rawReply || '').length} 字）─────\n${d.rawReply || '（空）'}`);
            if (d.rawData) parts.push(`\n───── 🧾 API 原始响应（${d.rawData.length} 字）─────\n${d.rawData}`);
            return parts.join('\n');
        },
        async copyDetail(i) {
            const d = this.log[i] && this.log[i].detail;
            if (!d) return;
            const ok = await this.copyText(this.detailText(d));
            this.copiedIdx = ok ? i : -1;
            setTimeout(() => { this.copiedIdx = -1; }, 1500);
        }
    }
};
</script>
