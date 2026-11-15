<!--
  PluginWorkspace 插件工作区（右侧面板，appMode === 'plugins' 时显示）
  📄 代码 / ✨ 效果(实验) 双选项卡：
    - 「代码」：展示插件源码（散落脚本/酒馆助手直出 content；扩展工程展示文件树 + 源码查看器）
    - 「效果(实验)」：在沙箱 iframe 内模拟酒馆运行环境，运行插件脚本，尝试渲染悬浮球/按钮/面板
      实验性预览：沙箱只实现了部分酒馆接口与 DOM 挂载点，依赖完整酒馆 API/DOM 的插件可能空白/不完整，结果仅供参考。
  ⚠️ 所有共享状态/方法经 inject('appCtx') 从 App.vue 获取
-->
<template>
    <div v-show="appMode === 'plugins'" class="flex-1 flex flex-col h-full overflow-hidden relative bg-zinc-950">

        <!-- 空状态 -->
        <div v-if="!activePlugin" class="flex-1 flex items-center justify-center text-zinc-500 flex-col gap-4">
            <div class="w-20 h-20 rounded-2xl flex items-center justify-center bg-violet-500/10 border border-violet-500/20 shadow-inner">
                <span class="text-4xl opacity-70">🧩</span>
            </div>
            <div class="text-center">
                <p class="text-sm tracking-widest text-zinc-300">请在左侧选择一个插件查看</p>
                <p class="text-[11px] text-zinc-600 mt-1">支持酒馆助手脚本 / 用户脚本 / 命令 / 扩展工程</p>
            </div>
        </div>

        <template v-else>
            <!-- 顶部控制栏 -->
            <div class="px-4 py-3 border-b border-zinc-800 bg-zinc-900/90 shrink-0 shadow-sm">
                <div class="flex items-center justify-between gap-3 min-w-0">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-9 h-9 rounded-xl flex items-center justify-center bg-violet-500/15 border border-violet-500/30 text-lg shrink-0">🧩</div>
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 min-w-0">
                                <h2 class="text-sm font-bold text-zinc-100 truncate">{{ activePlugin.name }}</h2>
                                <span class="px-1.5 py-0.5 rounded text-[10px] font-medium text-violet-300 bg-violet-500/10 border border-violet-500/20 shrink-0">{{ pluginKindLabel(activePlugin) }}</span>
                            </div>
                            <p class="text-[10px] text-zinc-500 truncate mt-0.5" :title="activePlugin.source?.origin">{{ activePlugin.source?.origin || '未落盘' }}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button @click="showAiModal = true" class="px-2.5 py-1.5 theme-element hover:border-violet-500/60 border rounded-lg text-[11px] transition" title="用大模型定位 / 修改当前代码">🤖 AI 修改</button>
                        <button @click="openPluginInFolder(activePlugin)" class="px-2.5 py-1.5 theme-element hover:border-violet-500/60 border rounded-lg text-[11px] transition" title="在资源管理器中定位插件">📂 定位</button>
                        <button @click="deletePlugin(activePlugin)" class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] text-rose-300 transition" title="移入回收站">🗑️ 删除</button>
                    </div>
                </div>
            </div>

            <!-- 📄 / ✨ 双选项卡 -->
            <div class="flex items-center gap-1 px-4 pt-2.5 shrink-0">
                <button @click="switchTab('code')"
                        :class="pluginTab === 'code' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-200'"
                        class="px-3 py-1.5 rounded-t-md text-[11px] font-medium transition">
                    📄 代码
                </button>
                <button @click="switchTab('effect')"
                        :class="pluginTab === 'effect' ? 'bg-violet-600 text-white' : 'text-zinc-500 hover:text-zinc-200'"
                        class="px-3 py-1.5 rounded-t-md text-[11px] font-medium transition">
                    ✨ 效果<span class="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 align-middle">实验</span>
                </button>
                <span class="ml-auto text-[10px] text-zinc-600 pr-1">{{ pluginKindHint(activePlugin) }}</span>
            </div>

            <!-- 📄 代码页 -->
            <div v-show="pluginTab === 'code'" class="flex-1 flex overflow-hidden min-h-0">
                <!-- 扩展工程：文件树 + 源码查看器 -->
                <template v-if="activePlugin.kind === 'extension'">
                    <aside class="w-52 shrink-0 border-r border-zinc-800 bg-zinc-900/60 overflow-y-auto custom-scrollbar">
                        <div class="px-3 py-2 text-[10px] font-bold text-zinc-500 border-b border-zinc-800">📦 文件树 ({{ relativeFiles.length }})</div>
                        <div v-for="f in relativeFiles" :key="f.abs"
                             @click="selectFile(f)"
                             :class="selectedFile && selectedFile.abs === f.abs ? 'bg-violet-600/20 text-violet-200 border-violet-500/40' : 'text-zinc-400 hover:bg-zinc-800 border-transparent'"
                             class="px-3 py-1.5 text-[11px] font-mono cursor-pointer border-l-2 transition truncate"
                             :title="f.rel">
                            {{ f.icon }} {{ f.rel }}
                        </div>
                    </aside>
                    <div class="flex-1 flex flex-col overflow-hidden min-w-0">
                        <div class="px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 shrink-0">
                            <span class="text-[10px] text-zinc-500 font-mono truncate flex-1" :title="selectedFile ? selectedFile.abs : ''">{{ selectedFile ? selectedFile.abs : '选择左侧文件查看/编辑源码' }}</span>
                            <span v-if="pluginDirty && selectedFile" class="text-[10px] text-amber-400 shrink-0" title="有未保存的修改">● 未保存</span>
                            <button v-if="selectedFile"
                                    @click="saveCode()"
                                    :disabled="savingPlugin"
                                    class="px-2.5 py-1 rounded text-[10px] font-bold shrink-0 transition"
                                    :class="savingPlugin ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed' : (pluginDirty ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow' : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300')"
                                    :title="savingPlugin ? '保存中…' : '保存修改到磁盘 (Ctrl+S)'">{{ savingPlugin ? '💾 保存中…' : '💾 保存' }}</button>
                        </div>
                        <div v-if="selectedFile" class="flex-1 min-h-0 overflow-hidden">
                            <CodeEditor :model-value="selectedSource" :filename="selectedFile.abs" height="100%"
                                        @update:model-value="selectedSource = $event"
                                        @change="pluginDirty = true" />
                        </div>
                        <div v-else class="flex-1 flex items-center justify-center text-zinc-600 text-xs">← 选择文件查看/编辑源码</div>
                    </div>
                </template>
                <!-- 散落脚本 / 酒馆助手：直出 content（可编辑） -->
                <div v-else class="flex-1 overflow-y-auto custom-scrollbar p-4">
                    <div v-for="(s, i) in (activePlugin.scripts || [])" :key="i" class="rounded-xl border overflow-hidden mb-4"
                         :class="pluginDirty && activePlugin.kind !== 'extension' ? 'border-amber-500/40' : 'border-zinc-800'">
                        <div class="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
                            <span class="text-[11px] font-mono text-zinc-400 truncate flex-1">{{ s.file }}</span>
                            <span v-if="pluginDirty && activePlugin.kind !== 'extension'" class="text-[10px] text-amber-400 shrink-0" title="有未保存的修改">● 未保存</span>
                            <span class="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 shrink-0">{{ scriptKindLabel(s.kind) }}</span>
                            <button @click="saveCode(i)"
                                    :disabled="savingPlugin"
                                    class="px-2.5 py-1 rounded text-[10px] font-bold shrink-0 transition"
                                    :class="savingPlugin ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed' : (pluginDirty ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow' : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300')"
                                    :title="savingPlugin ? '保存中…' : '保存修改到磁盘 (Ctrl+S)'">{{ savingPlugin ? '💾 保存中…' : '💾 保存' }}</button>
                        </div>
                        <CodeEditor v-model="s.content" :filename="s.file" language="javascript" height="420px"
                                    @change="pluginDirty = true" />
                    </div>
                </div>
            </div>

            <!-- ✨ 效果页 -->
            <div v-show="pluginTab === 'effect'" class="flex-1 flex flex-col overflow-hidden min-h-0 border-t border-zinc-800">
                <div class="px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between shrink-0">
                    <span class="text-[10px] text-amber-500/90">⚠️ 实验性预览：沙箱仅模拟了部分酒馆接口，依赖完整酒馆 API/DOM 的插件可能显示空白或不完整，结果仅供参考。</span>
                    <button @click="buildPreview" class="px-2.5 py-1 bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-bold rounded transition">🔄 {{ previewState.loading ? '加载中…' : '重新渲染' }}</button>
                </div>
                <div class="flex-1 relative bg-[#18181b]">
                    <div v-if="previewState.loading" class="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs">⏳ 正在读取插件资源…</div>
                    <iframe v-else-if="previewState.url" :src="previewState.url" sandbox="allow-scripts" class="w-full h-full border-0" title="插件效果预览"></iframe>
                    <div v-else class="absolute inset-0 flex items-center justify-center text-rose-400 text-xs px-6 text-center">{{ previewState.error || '无法预览：插件无可运行脚本。' }}</div>
                </div>
            </div>
        </template>

        <!-- 🤖 AI 代码定位/修改对话窗 -->
        <AiCodeModal v-if="showAiModal" @close="showAiModal = false" @apply="applyAiCode" />
    </div>
</template>

<script>
import { inject, ref, computed, watch } from 'vue';
import { resolvePreviewAssets } from '../utils/pluginScanner.js';
import { buildPluginPreviewHtml, rewritePluginResourcePaths } from '../plugins/hostStub.js';
import { classifyPlugin, PLUGIN_KIND, pluginKindLabel } from '../plugins/pluginClassify.js';
import { buildThemePreviewHtml } from '../plugins/themePreview.js';
import { renderCapabilityCard, capabilityCardCss } from '../plugins/capabilityCard.js';
import CodeEditor from './CodeEditor.vue'; // 🧩 轻量代码编辑器（CodeMirror 封装：语法高亮+行号）
import AiCodeModal from './AiCodeModal.vue'; // 🤖 AI 代码定位/修改对话窗

export default {
    name: 'PluginWorkspace',
    components: { CodeEditor, AiCodeModal },
    setup() {
        const ctx = inject('appCtx');
        const activePlugin = ctx.activePlugin;
        const appMode = ctx.appMode;

        // 工作区选项卡 / 选中文件 / 文件源码 —— 提升为共享状态（App.vue），
        // 使侧边栏树状子条目点击后能直接定位到代码页对应文件。
        const pluginTab = ctx.pluginTab;
        const selectedFile = ctx.pluginSelectedFile;
        const selectedSource = ctx.pluginSelectedSource;
        const pluginDirty = ctx.pluginDirty;          // 代码页未保存脏标记（App.vue 共享，防误切换丢改动）
        const savingPlugin = ctx.savingPlugin;        // 保存中状态（防重复点击）
        const previewState = ref({ url: null, error: null, loading: false });
// 🧭 插件分类结果（主题 / 后台逻辑 / 界面脚本 / 扩展工程）——「效果」页顶栏展示
const pluginKindInfo = ref(null);
const pluginKindText = computed(() => {
    const k = pluginKindInfo.value && pluginKindInfo.value.kind;
    return k ? pluginKindLabel(k) : '';
});
        const showAiModal = ref(false);              // 🤖 AI 对话窗开关

        // 🤖 让 AiCodeModal 能读到当前代码（扩展工程=选中文件源码；脚本类=脚本 content）
        //    通过给 activePlugin 挂临时字段注入（组件内 collectCode 读取）
        watch([activePlugin, selectedFile, selectedSource], () => {
            const p = activePlugin.value;
            if (!p || p.kind !== 'extension') return;
            p._selectedFile = selectedFile.value;
            p._selectedSource = selectedSource.value;
        }, { immediate: true, deep: false });

        // 🤖 应用 AI 返回的代码：按插件形态回写对应编辑区
        const applyAiCode = (code) => {
            if (typeof code !== 'string' || !code.trim()) return;
            const p = activePlugin.value;
            if (!p) return;
            if (p.kind === 'extension') {
                if (!selectedFile.value) { ctx.showToast('请先在文件树选择一个文件', 'error'); return; }
                selectedSource.value = code;
            } else {
                const scripts = p.scripts || [];
                if (!scripts.length) return;
                scripts[0].content = code;
            }
            pluginDirty.value = true;
        };

        // 类型徽标文案（与侧边栏一致）
        const pluginKindLabel = (p) => {
            if (!p) return '';
            if (p.kind === 'extension') return '扩展工程';
            if (p.kind === 'theme') return '主题';
            if (p.kind === 'slash') return '命令';
            if (p.kind === 'userscript') return '用户脚本';
            return '酒馆助手';
        };
        // 顶部右侧提示
        const pluginKindHint = (p) => {
            if (!p) return '';
            if (p.kind === 'extension') return '扩展工程 · bundle 整包加载';
            if (p.kind === 'theme') return 'UI 主题 · 纯配色配置';
            if (p.scriptKind === 'B') return 'userscript 头 · jQuery 注入';
            if (p.scriptKind === 'C') return 'SlashRunner 命令 · 依赖 JS-Slash-Runner';
            return 'jQuery 注入脚本';
        };
        const scriptKindLabel = (k) => ({ A: 'jQuery 注入', B: 'userscript', C: '命令', bundle: 'bundle', theme: '主题' })[k] || k;

        // 扩展工程文件树：绝对路径 → 相对路径 + 图标
        const relativeFiles = computed(() => {
            const p = activePlugin.value;
            if (!p || p.kind !== 'extension') return [];
            const root = (p.source && p.source.origin) || '';
            return (p.files || []).map(abs => {
                let rel = abs;
                if (root && abs.startsWith(root)) rel = abs.slice(root.length).replace(/^[/\\]+/, '');
                const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
                const icon = ext === 'js' || ext === 'mjs' ? '🟨' : ext === 'css' ? '🎨' : ext === 'json' ? '📄' : ext === 'html' ? '🌐' : '📃';
                return { abs, rel, icon };
            }).sort((a, b) => a.rel.localeCompare(b.rel));
        });

        const selectFile = async (f) => {
            // 有未保存修改时先确认：同一插件内切换文件会直接覆盖编辑区草稿
            if (pluginDirty.value && selectedFile.value && selectedFile.value.abs !== f.abs) {
                const ok = await ctx.confirmDialog('当前文件有未保存的修改，切换文件将丢弃这些改动。确定继续吗？');
                if (!ok) return;
            }
            selectedFile.value = f;
            pluginDirty.value = false;
            selectedSource.value = '读取中…';
            try {
                const res = await window.electronAPI.readPluginFile(f.abs);
                selectedSource.value = res && res.success ? res.data : ((res && res.error) || '读取失败');
            } catch (e) {
                selectedSource.value = '读取失败: ' + e.message;
            }
        };

        // 切换选项卡（代码/效果）：内容经 v-model 绑定，切换不会丢失编辑内容
        const switchTab = (tab) => {
            pluginTab.value = tab;
            if (tab === 'effect' && !previewState.value.url) buildPreview();
        };

        // ================= 💾 保存（三种插件形态统一走 ctx.savePluginSource）=================
        // extension: 保存当前选中文件；tavern-helper/userscript/slash: 保存对应脚本 content
        const saveCode = async (scriptIndex = 0) => {
            const p = activePlugin.value;
            if (!p || savingPlugin.value) return;

            if (p.kind === 'extension') {
                // 扩展工程：保存当前选中文件（selectedSource 即编辑器内容）
                if (!selectedFile.value) return;
                const ok = await ctx.savePluginSource({
                    plugin: p,
                    filePath: selectedFile.value.abs,
                    content: selectedSource.value
                });
                if (ok) pluginDirty.value = false;
                return;
            }

            // 脚本类（酒馆助手/用户脚本/命令）：编辑区直接 v-model 到 s.content，保存指定脚本
            const scripts = p.scripts || [];
            const s = scripts[scriptIndex] || scripts[0];
            if (!s) return;
            const ok = await ctx.savePluginSource({
                plugin: p,
                filePath: s.file,
                content: s.content,
                scriptIndex
            });
            if (ok) pluginDirty.value = false;
        };

        // 构建效果预览：非扩展内联 content；扩展读取 bundle js/css 后整包注入
        const buildPreview = async () => {
            const p = activePlugin.value;
            if (!p) return;
            previewState.value = { url: null, error: null, loading: true };
            try {
                let html = '';
                // 🗂️ 先算插件根目录：真实 ESM 加载时，浏览器会向
                //    app://…/__jsk_plugin_res__/<id>/<相对路径> 请求模块文件，
                //    主进程必须**此时**就知道 rootDir，否则一律 404。
                //    （旧实现是最后才登记 rootDir，导致「分配 id 后立即 fetch 模块」必然失败。）
                const pluginRootRawEarly = (p.kind === 'extension')
                    ? ((p.source && p.source.origin) || '')
                    : String((p.source && (p.source.dir || p.source.origin)) || '');
                // 🗂️ 先让主进程分配预览 id：插件内的相对资源路径要改写成「带 id 的代理 URL」，
                //    否则图片/字体/样式会被解析到应用根目录 ⇒ 404（用户实测「资源加载不出来」）。
                    const idRes = await window.electronAPI.setPluginPreview('', { reserveId: true, rootDir: pluginRootRawEarly });
                if (!idRes || !idRes.success || !idRes.id) throw new Error('预览 id 分配失败');
                const previewId = idRes.id;

                    // 🧭 先分类：主题类 / 纯逻辑类不走脚本沙箱（走各自的专用视图）
                    const cls = classifyPlugin(p);
                    pluginKindInfo.value = cls;
                    console.log('[plugin-preview] 分类=', cls.kind, '|', cls.reason);

                    // ① UI 主题：把配色 JSON 映射成 CSS 变量，渲染静态示意页（不跑任何脚本）
                    if (cls.kind === PLUGIN_KIND.THEME) {
                        // 扫描阶段已把原始配色挂在 themeData 上；兜底才去解析 content
                        let themeObj = (p.themeData && typeof p.themeData === 'object') ? p.themeData : null;
                        if (!themeObj) {
                            try {
                                themeObj = typeof p.content === 'string' ? JSON.parse(p.content) : null;
                            } catch (e) { themeObj = null; }
                        }
                        if (!themeObj) {
                            const s0 = (p.scripts || [])[0];
                            if (s0 && s0.content) {
                                try { themeObj = JSON.parse(s0.content); } catch (e) { themeObj = null; }
                            }
                        }
                        html = buildThemePreviewHtml(themeObj || {}, { name: p.name });
                        const res = await window.electronAPI.setPluginPreview(html, { reuseId: previewId });
                        if (!res || !res.success) throw new Error((res && res.error) || '预览登记失败');
                        previewState.value = { url: res.url, error: null, loading: false };
                        return;
                    }

                    // ② 纯逻辑插件：**仍然先跑沙箱**（上游 Q5 拍板：透视卡绝不阻止渲染）。
                    //    只是把「能力说明书」预先算好挂在分类结果上，由 hostStub 在
                    //    2 秒空白自检时展示 —— 避免「本来有界面但没跑出来」的插件被误杀。
                    if (cls.kind === PLUGIN_KIND.LOGIC) {
                        try {
                            pluginKindInfo.value = {
                                ...cls,
                                capHtml: renderCapabilityCard(p),
                                capCss: capabilityCardCss(),
                            };
                        } catch (e) {
                            console.warn('[plugin-preview] 能力卡生成失败', e);
                        }
                    }

                    if (p.kind === 'extension') {
                        const assets = resolvePreviewAssets(p);
                        const bundleJs = [];
                        const bundleCss = [];
                        // 🧩 扩展模板收集：工程内所有 .html 按相对 manifest 根的 POSIX 路径注入 __jskTemplates，
                        //    宿主 renderExtensionTemplate/Async 据此做 Handlebars 渲染。
                        const templates = {};
                        const root = (p.source && p.source.origin) || '';
                        for (const abs of (p.files || [])) {
                            const low = String(abs).toLowerCase();
                            if (!low.endsWith('.html') && !low.endsWith('.htm')) continue;
                            let rel = abs;
                        if (root && abs.startsWith(root)) rel = abs.slice(root.length).replace(/^[/\\]+/, '');
                        rel = String(rel).replace(/\\/g, '/');
                        const res = await window.electronAPI.readPluginFile(abs);
                        if (res && res.success && typeof res.data === 'string' && res.data) {
                            templates[rel] = rewritePluginResourcePaths(res.data, previewId);
                        }
                    }
                    for (const f of assets.js) {
                        const res = await window.electronAPI.readPluginFile(f);
                        if (res && res.success && res.data) bundleJs.push(res.data);
                    }
                    for (const f of assets.css) {
                        const res = await window.electronAPI.readPluginFile(f);
                        if (res && res.success && res.data) bundleCss.push(res.data);
                    }
                    // 🧩 不再收集/改写源码模块表。
                    //    改用**真实 ESM**：由 manifest 声明入口，浏览器自己解析整棵依赖树。
                    //    这样 test/、dev/、src/(TS)、vite.config 等永远不会被加载，
                    //    也不需要为「源码工程 vs 构建工程」写任何判定规则。
                    //    —— 这正是之前反复打补丁（顶层 await / NOOP / 误收 dev）的根治办法。
                    const entryRel = (() => {
                        const first = (assets.js || [])[0];
                        if (!first) return '';
                        let r = first;
                        if (root && first.startsWith(root)) r = first.slice(root.length).replace(/^[/\\]+/, '');
                        return String(r).replace(/\\/g, '/');
                    })();
                    console.log('[plugin-preview] 扩展资源:',
                        'assets.js=' + JSON.stringify(assets.js),
                        'assets.css=' + JSON.stringify(assets.css),
                        'bundleJs=' + bundleJs.length,
                        'bundleCss=' + bundleCss.length,
                        'entry=' + (entryRel || '(空)'));
                    // 真实 ESM 模式下，只要 manifest 声明了入口就不算「无脚本」——
                    // 入口文件由浏览器自行下载，不依赖我们预读的内容。
                    if (!entryRel && bundleJs.length === 0 && bundleCss.length === 0) {
                        throw new Error(`无法定位可运行脚本：manifest 未声明 js/style 入口，也未读到 bundle（assets.js=${JSON.stringify(assets.js)}）。`);
                    }
                        html = buildPluginPreviewHtml(p, { bundleJs, bundleCss, entry: entryRel, templates, previewId, capability: pluginKindInfo.value && pluginKindInfo.value.capHtml ? pluginKindInfo.value : null });
                } else {
                    const hasContent = (p.scripts || []).some(s => s.content && s.content.trim());
                    if (!hasContent) throw new Error('插件没有可运行的脚本 内容。');
                    html = buildPluginPreviewHtml(p, { previewId, capability: pluginKindInfo.value && pluginKindInfo.value.capHtml ? pluginKindInfo.value : null });
                }
                // 🧩 预览 HTML 存主进程内存，取独立 app:// URL（内联脚本不再被父页 CSP 拦截）
                //    rootDir：插件根目录，供资源代理读取插件内图片/字体/样式
                const pluginRootRaw = (p.kind === 'extension')
                    ? ((p.source && p.source.origin) || '')
                    : String((p.source && (p.source.dir || p.source.origin)) || '');
                const pluginRoot = pluginRootRaw
                    ? (p.kind === 'extension' ? String(pluginRootRaw) : String(pluginRootRaw).replace(/[\\/][^\\/]*$/, ''))
                    : '';
                console.log('[plugin-preview] rootDir=', pluginRoot || '(空)', '| previewId=', previewId);
                const res = await window.electronAPI.setPluginPreview(html, { rootDir: pluginRoot, reuseId: previewId });
                if (!res || !res.success) throw new Error((res && res.error) || '预览登记失败');
                previewState.value = { url: res.url, error: null, loading: false };
            } catch (e) {
                previewState.value = { url: null, error: e.message || '预览构建失败', loading: false };
            }
        };

        // 切换插件时重置预览缓存；选中文件由侧边栏子条目/代码页文件树显式管理，
        // 不在此重置，避免覆盖「侧边栏子条目点击 → 定位到代码页对应文件」的选中状态）
        // ⚠️ 关键：重置后若用户**正停在「效果」页**，必须立即重建，否则 previewState
        //    停在 {url:null, error:null} 的空状态，模板会显示默认文案
        //    「无法预览：插件无可运行脚本。」—— 看起来像构建失败，其实根本没开始构建。
        //    （用户实测反馈的正是这一条。）
        watch(activePlugin, (next) => {
            const wasOnEffect = pluginTab.value === 'effect';
            pluginDirty.value = false;
            previewState.value = { url: null, error: null, loading: false };
            if (next && wasOnEffect) buildPreview();
        });

        return {
            appMode,
            activePlugin,
            pluginTab,
            pluginDirty,
            savingPlugin,
            saveCode,
            pluginKindLabel,
            pluginKindHint,
            scriptKindLabel,
            relativeFiles,
            selectedFile,
            selectedSource,
            selectFile,
            switchTab,
            previewState,
            buildPreview,
            showAiModal,
            applyAiCode,
            openPluginInFolder: ctx.openPluginInFolder,
            deletePlugin: ctx.deletePlugin
        };
    }
};
</script>
