<!--
  ChatPanelSeg 测卡消息分段渲染组件（对齐「渲染方案.MD」第 4/5 节）
  文本段 → renderChatHtml（Markdown 子集 + DOMPurify）
  HTML 段 → sandbox iframe（srcdoc，禁同源权限；高度由 iframe 内 postMessage 上报自适应）
-->
<template>
    <div class="seg-wrap">
        <template v-for="(seg, si) in segments" :key="si">
            <div v-if="seg.type === 'text'" class="seg-text" v-html="renderText(seg.content)"></div>
            <div v-else class="seg-html">
                <iframe
                    class="seg-iframe"
                    :style="{ height: panelHeights[si] ? panelHeights[si] + 'px' : '60px' }"
                    :srcdoc="srcdocOf(seg, si)"
                    sandbox="allow-scripts"
                    frameborder="0"
                    scrolling="no"
                />
            </div>
        </template>
    </div>
</template>

<script>
import { reactive, onMounted, onBeforeUnmount, watch } from 'vue';
import { buildHtmlSrcdoc } from './useChatRender.js';

let SEG_UID = 0;

export default {
    name: 'ChatPanelSeg',
    props: {
        segments: { type: Array, default: () => [] },
        varsJson: { type: String, default: '' },
        // 文本段渲染函数由宿主注入（复用 CardDetailView.renderChatHtml，避免双份实现）
        renderText: { type: Function, required: true }
    },
    setup(props) {
        const panelHeights = reactive({});
        const uid = 'seg' + (++SEG_UID);
        const heights = {}; // panelId → px（不响应式，收齐后批量写入）
        let flushTimer = null;
        // 🚀 srcdoc 缓存:父组件每次重渲染(输入/发送/变量变更)若重新生成 srcdoc 字符串,
        //    全部 iframe 会被浏览器整体重载 → 面板闪烁。按 内容+变量 键缓存,仅在真正变化时重载。
        const srcdocCache = new Map();
        let lastVarsJson = '';

        function srcdocOf(seg, si) {
            const varsKey = String(props.varsJson || '');
            if (varsKey !== lastVarsJson) { srcdocCache.clear(); lastVarsJson = varsKey; }
            const key = varsKey + '\u0000' + si + '\u0000' + seg.content;
            const hit = srcdocCache.get(key);
            if (hit !== undefined) return hit;
            const doc = buildHtmlSrcdoc(seg.content, props.varsJson, uid + '_' + si);
            if (srcdocCache.size > 60) {
                const first = srcdocCache.keys().next().value;
                srcdocCache.delete(first);
            }
            srcdocCache.set(key, doc);
            return doc;
        }

        // 段结构变化（会话切换/重新生成）→ 已量高度作废，等 iframe 重新上报
        watch(() => props.segments.map((s) => s.type + ':' + (s.content || '').length).join(','), () => {
            for (const k of Object.keys(panelHeights)) delete panelHeights[k];
        });

        function onMsg(ev) {
            const d = ev && ev.data;
            if (!d || d.type !== 'jsx-panel-height') return;
            const pid = String(d.id || '');
            if (!pid.startsWith(uid + '_')) return;
            const h = Math.min(Math.max(Number(d.h) || 0, 24), 4000); // 钳制 24~4000px
            if (!h) return;
            const si = Number(pid.slice(uid.length + 1));
            if (!Number.isInteger(si)) return;
            // 300ms 合并窗口：多个 iframe 上报批量写入，避免连环重排
            heights[si] = Math.max(heights[si] || 0, h);
            if (!flushTimer) {
                flushTimer = setTimeout(() => {
                    flushTimer = null;
                    for (const k of Object.keys(heights)) panelHeights[k] = heights[k];
                }, 300);
            }
        }

        onMounted(() => window.addEventListener('message', onMsg));
        onBeforeUnmount(() => {
            window.removeEventListener('message', onMsg);
            if (flushTimer) clearTimeout(flushTimer);
        });

        return { panelHeights, srcdocOf };
    }
};
</script>

<style scoped>
.seg-wrap { display: flex; flex-direction: column; gap: 6px; }
.seg-text { white-space: pre-wrap; word-break: break-word; }
.seg-html { width: 100%; border-radius: 8px; overflow: hidden; background: transparent; }
.seg-iframe {
    display: block; width: 100%; border: 0; background: transparent;
    transition: height 0.2s ease;
}
</style>
