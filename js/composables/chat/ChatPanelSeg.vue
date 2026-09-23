<!--
  ChatPanelSeg 测卡消息分段渲染组件（对齐「渲染方案.MD」第 4/5 节）
  文本段 → renderChatHtml（Markdown 子集 + DOMPurify）
  HTML 段 → sandbox iframe（srcdoc，禁同源权限；高度由 iframe 内 postMessage 上报自适应）
-->
<template>
    <div class="seg-wrap" ref="rootEl">
        <template v-for="(seg, si) in segments" :key="si">
            <div v-if="seg.type === 'text'" class="seg-text" v-html="renderText(seg.content)"></div>
            <!-- 🌐 外链界面（loader）：$('body').load('URL') / <iframe src> —— 直接 src 加载远程 URL
                 （sandbox 只给 allow-scripts，不带 srcdoc；与卡编辑器预览面板同口径） -->
            <div v-else-if="seg.type === 'loader'" class="seg-html">
                <iframe
                    class="seg-iframe"
                    :style="{ height: panelHeights[si] ? panelHeights[si] + 'px' : '60px' }"
                    :src="seg.url"
                    sandbox="allow-scripts allow-popups"
                    referrerpolicy="no-referrer"
                    frameborder="0"
                    scrolling="no"
                />
            </div>
            <div v-else class="seg-html">
                <iframe
                    v-if="segUrls[si] || !ipcAvailable"
                    class="seg-iframe"
                    :style="{ height: panelHeights[si] ? panelHeights[si] + 'px' : '60px' }"
                    :src="segUrls[si]"
                    :srcdoc="segUrls[si] ? undefined : srcdocOf(seg, si)"
                    sandbox="allow-scripts"
                    frameborder="0"
                    scrolling="no"
                />
                <!-- 有 IPC 时先不渲染 srcdoc（生产 CSP 会拦掉内联脚本，加载一份废文档反而闪），
                     等 app:// 路由就绪再一次性上市 -->
                <div v-else class="seg-iframe" :style="{ height: panelHeights[si] ? panelHeights[si] + 'px' : '60px' }"></div>
            </div>
        </template>
    </div>
</template>

<script>
import { reactive, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { buildHtmlSrcdoc } from './useChatRender.js';
import { ensureChatVendor, chatVendorScriptTags } from './useChatVendor.js';

let SEG_UID = 0;

export default {
    name: 'ChatPanelSeg',
    props: {
        segments: { type: Array, default: () => [] },
        varsJson: { type: String, default: '' },
        // goCurrentMessageId() 返回值（状态栏靠它分辨自己属于哪一层消息）
        messageId: { type: Number, default: 0 },
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
            const doc = buildHtmlSrcdoc(seg.content, props.varsJson, uid + '_' + si, '', { messageId: props.messageId });
            if (srcdocCache.size > 60) {
                const first = srcdocCache.keys().next().value;
                srcdocCache.delete(first);
            }
            srcdocCache.set(key, doc);
            return doc;
        }

        // 🧩 状态栏等「界面型」段：生产 CSP 会拦掉 srcdoc 里的内联脚本（JS-Slash-Runner 状态栏
        //    正是 webpack SPA 模板）→ 改为把同一份文档经 IPC 存到主进程，用 app:// 独立 URL 加载
        //    （该路由跳过 CSP 注入）；未提供 IPC（纯浏览器/dev 早期）时自动回退 srcdoc。
        const segUrls = reactive({});
        let regSeq = 0;
        function canRegisterSeg() {
            return typeof window !== 'undefined' && window.electronAPI
                && typeof window.electronAPI.setChatHtmlSegment === 'function';
        }
        // 有 IPC（Electron 环境）：srcdoc 阶段直接跳过，避免先加载一份被 CSP 拦死的废文档
        const ipcAvailable = canRegisterSeg();
        async function registerSegments() {
            if (!canRegisterSeg()) return;
            const my = ++regSeq;
            const segs = props.segments || [];
            // 第三方库（Vue/jQuery/lodash）先就位：卡内状态栏模板靠 window.Vue 运行
            await ensureChatVendor();
            if (my !== regSeq) return;
            const vendor = chatVendorScriptTags();
            for (let si = 0; si < segs.length; si++) {
                const seg = segs[si];
                if (!seg || seg.type === 'text') continue;
                // 与 srcdoc 用同一生成器：变量桥 / 高度上报桥（panelId 配对）保持一致
                const doc = buildHtmlSrcdoc(seg.content, props.varsJson, uid + '_' + si, vendor, { messageId: props.messageId });
                try {
                    const res = await window.electronAPI.setChatHtmlSegment(doc);
                    if (my !== regSeq) return;              // 期间段结构又变了 → 丢弃本次结果
                    if (res && res.success && res.url) segUrls[si] = res.url;
                } catch (e) { /* 失败则维持 srcdoc 回退 */ }
            }
        }

        // 段结构变化（会话切换/重新生成）→ 已量高度作废，等 iframe 重新上报
        watch(() => props.segments.map((s) => s.type + ':' + (s.content || '').length).join(','), () => {
            for (const k of Object.keys(panelHeights)) delete panelHeights[k];
            for (const k of Object.keys(segUrls)) delete segUrls[k];
            registerSegments();
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

        // 🪟 窗口回前台 / 重新可见时，让所有界面段重新量高。
        //    原因：后台窗口的 setTimeout 会被节流（实测 ~1s 一跳），iframe 内依靠 load 后
        //    几次定时上报可能一直没跑到 → 父层高度永远停在默认 60px（用户看到「列被压扁」）。
        const rootEl = ref(null);
        function requestHeights() {
            const el = rootEl.value;
            if (!el) return;
            for (const f of el.querySelectorAll('iframe.seg-iframe')) {
                try { f.contentWindow && f.contentWindow.postMessage({ type: 'jsx-panel-height-request' }, '*'); } catch (e) { /* 跨域失败忽略 */ }
            }
        }
        function onVisibility() {
            if (document.visibilityState === 'visible') setTimeout(requestHeights, 120);
        }

        onMounted(() => {
            window.addEventListener('message', onMsg);
            window.addEventListener('focus', requestHeights);
            document.addEventListener('visibilitychange', onVisibility);
            registerSegments();          // 🧩 把已有界面段换成 app:// 路由（绕过 CSP）
        });
        onBeforeUnmount(() => {
            window.removeEventListener('message', onMsg);
            window.removeEventListener('focus', requestHeights);
            document.removeEventListener('visibilitychange', onVisibility);
            if (flushTimer) clearTimeout(flushTimer);
            regSeq++;                    // 卸载后到来的注册结果直接作废
        });

        return { panelHeights, srcdocOf, segUrls, ipcAvailable, rootEl };
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
