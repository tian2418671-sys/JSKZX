<!--
  AiCodeModal AI 代码定位/修改对话窗
  🤖 把当前插件代码作为上下文发给大模型，用户描述定位/修改需求，
     模型回复代码块后一键应用到编辑器对应编辑区。

  工作流：
    1. 打开时自动拼接「当前代码」上下文（扩展工程 = 选中文件源码；脚本类 = 各脚本 content）
    2. 用户在输入框描述需求 → 发送 → 走 window.electronAPI.sendChatMessage
    3. 回复用 extractReplyContent 解析 → 从 ```代码块 提取完整代码
    4. 用户点击「应用到编辑器」→ 回写对应 CodeEditor（触发 pluginDirty = true）
-->
<template>
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" @click.self="close">
        <div class="w-[min(860px,92vw)] h-[min(720px,88vh)] flex flex-col rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden">
            <!-- 头部 -->
            <div class="px-5 py-3.5 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-violet-500/15 border border-violet-500/30 text-base">🤖</div>
                <div class="min-w-0">
                    <h2 class="text-sm font-bold text-zinc-100">AI 代码定位 / 修改</h2>
                    <p class="text-[10px] text-zinc-500 truncate" :title="targetName">{{ targetName }}</p>
                </div>
                <button @click="close" class="ml-auto w-7 h-7 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition">✕</button>
            </div>

            <!-- 上下文预览（可折叠） -->
            <div class="px-5 pt-3 shrink-0">
                <button @click="showCtx = !showCtx" class="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 transition">
                    <span class="transition-transform inline-block" :style="{ transform: showCtx ? 'rotate(90deg)' : '' }">▶</span>
                    📋 已载入代码上下文（{{ ctxCharCount }} 字符）
                </button>
                <div v-if="showCtx" class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <pre class="text-[10px] font-mono text-zinc-500 whitespace-pre-wrap break-all">{{ contextPreview }}</pre>
                </div>
            </div>

            <!-- 对话区 -->
            <div ref="chatRef" class="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 flex flex-col gap-3 min-h-0">
                <div v-if="messages.length === 0" class="text-center text-zinc-600 text-xs py-10">
                    <p class="text-2xl mb-2">💡</p>
                    <p>描述你要定位或修改的地方，例如：</p>
                    <p class="text-zinc-700 mt-1">「把悬浮球按钮的颜色改成蓝色」「定位处理消息发送的函数」</p>
                </div>
                <div v-for="(m, i) in messages" :key="i" class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
                    <div class="max-w-[85%] rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words"
                         :class="m.role === 'user' ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-200'">
                        <!-- 助手消息若含代码块，额外渲染「应用到编辑器」按钮 -->
                        <template v-if="m.role === 'assistant'">
                            <div class="whitespace-pre-wrap break-words">{{ m.text }}</div>
                            <button v-if="m.code" @click="applyCode(m.code)"
                                    class="mt-2 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition">
                                ✅ 应用到编辑器（{{ m.code.split('\n').length }} 行）
                            </button>
                        </template>
                        <template v-else>{{ m.text }}</template>
                    </div>
                </div>
                <div v-if="loading" class="flex justify-start">
                    <div class="rounded-xl bg-zinc-800 text-zinc-400 px-3.5 py-2.5 text-[12px] flex items-center gap-2">
                        <span class="inline-block w-2 h-2 rounded-full bg-violet-400 animate-pulse"></span> AI 正在分析…
                    </div>
                </div>
            </div>

            <!-- 输入区 -->
            <div class="px-5 py-3.5 border-t border-zinc-800 shrink-0">
                <div class="flex items-end gap-2">
                    <textarea v-model="input" @keydown.ctrl.enter="send" @keydown.meta.enter="send"
                              rows="2" placeholder="描述定位/修改需求…（Ctrl+Enter 发送）"
                              class="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-200 text-[12px] px-3 py-2 focus:border-violet-500 focus:outline-none custom-scrollbar"></textarea>
                    <button @click="send" :disabled="loading || !input.trim()"
                            class="px-4 py-2 rounded-lg text-[12px] font-bold transition shrink-0"
                            :class="loading || !input.trim() ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed' : 'bg-violet-600 hover:bg-violet-500 text-white'">
                        {{ loading ? '…' : '发送' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { inject, ref, computed, nextTick } from 'vue';

const collectCode = (p) => {
    if (!p) return { name: '未选择插件', code: '' };
    if (p.kind === 'extension') {
        // 扩展工程：优先用当前选中文件源码
        const file = p._selectedFile;
        if (file) return { name: file.abs, code: p._selectedSource || '' };
        const first = (p.files || [])[0] || '';
        return { name: first, code: '' };
    }
    const scripts = p.scripts || [];
    if (scripts.length === 1) return { name: scripts[0].file || p.name, code: scripts[0].content || '' };
    // 多脚本：拼接带文件头注释
    const code = scripts.map(s => `/* ==== ${s.file} ==== */\n${s.content || ''}`).join('\n\n');
    return { name: `${p.name}（${scripts.length} 个脚本）`, code };
};

export default {
    name: 'AiCodeModal',
    emits: ['close', 'apply'],
    setup(props, { emit }) {
        const ctx = inject('appCtx');
        const activePlugin = ctx.activePlugin;

        const showCtx = ref(false);
        const input = ref('');
        const loading = ref(false);
        const messages = ref([]);
        const chatRef = ref(null);

        const targetName = computed(() => {
            const p = activePlugin.value;
            if (!p) return '未选择插件';
            if (p.kind === 'extension') return (p._selectedFile && p._selectedFile.abs) || '扩展工程（未选文件）';
            return p.name;
        });

        const contextPreview = computed(() => {
            const { code } = collectCode(activePlugin.value);
            return code ? code.slice(0, 2000) + (code.length > 2000 ? '\n…（截断）' : '') : '（无代码）';
        });
        const ctxCharCount = computed(() => collectCode(activePlugin.value).code.length);

        const close = () => emit('close');
        const scrollToBottom = () => nextTick(() => {
            if (chatRef.value) chatRef.value.scrollTop = chatRef.value.scrollHeight;
        });

        // 从 AI 回复文本中提取代码块（```lang ... ``` 或纯 ``` ... ```），无代码块返回 null
        const extractCode = (text) => {
            const fence = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n\s*```/g;
            const matches = [];
            let m;
            while ((m = fence.exec(text)) !== null) matches.push(m[1]);
            if (matches.length === 0) return null;
            // 优先取最长代码块（通常是完整重写）
            return matches.reduce((a, b) => (b.length > a.length ? b : a), matches[0]);
        };

        const send = async () => {
            const q = input.value.trim();
            if (!q || loading.value) return;
            const { name, code } = collectCode(activePlugin.value);
            if (!code) {
                ctx.showToast('当前插件无可用代码，请先在左侧选择一个含代码的插件', 'error');
                return;
            }

            messages.value.push({ role: 'user', text: q });
            input.value = '';
            loading.value = true;
            scrollToBottom();

            const system = `你是一名精通前端/SillyTavern 插件开发的高级工程师。用户会给你一段插件代码和一条定位/修改需求。\n` +
                `请严格遵守：\n` +
                `1. 直接完成任务；如需修改代码，请把【完整的新代码】放在一个 \`\`\` 代码块中（Markdown 格式，语言标注可选），必须是可直接替换的完整文件内容，不要用「省略号」「…」「保持不变」等省略。\n` +
                `2. 如果是「定位」类问题，用文字+行号说明位置，不要输出代码块。\n` +
                `3. 回复精炼，避免冗长寒暄。`;

            const userMsg = `【插件/文件】${name}\n【当前代码】\n${code}\n\n【需求】${q}`;

            try {
                const payload = {
                    model: ctx.resolveApiModel(),
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: userMsg }
                    ],
                    temperature: 0.2,
                    max_tokens: 4000
                };
                const result = await window.electronAPI.sendChatMessage(
                    ctx.apiEndpoint.value, payload, ctx.apiKey.value, ctx.apiType.value
                );
                const text = ctx.extractReplyContent(result) || '（AI 未返回内容）';
                const parsed = extractCode(text);
                messages.value.push({ role: 'assistant', text, code: parsed });
            } catch (e) {
                messages.value.push({ role: 'assistant', text: '请求失败：' + (e && e.message ? e.message : e) });
            } finally {
                loading.value = false;
                scrollToBottom();
            }
        };

        // 应用到编辑器：emit('apply', code) 由父组件回写
        const applyCode = (code) => {
            emit('apply', code);
            ctx.showToast('已应用到编辑器，记得保存（Ctrl+S）', 'success');
        };

        return {
            showCtx, input, loading, messages, chatRef,
            targetName, contextPreview, ctxCharCount,
            close, send, applyCode
        };
    }
};
</script>