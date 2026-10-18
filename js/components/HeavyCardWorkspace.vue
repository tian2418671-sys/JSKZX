<!--
  HeavyCardWorkspace 重型卡（独立前端角色卡）· 右侧工作区
  ─────────────────────────────────────────────────────────────
  为什么这里是「占位框」而不是 <iframe>/<webview>：
    · iframe 无法独立 partition（同一 webContents 共用 session）；
    · <webview> 需要开 webviewTag，等于给渲染层一条创建通道，违反安全基线；
    · 因此容器由**主进程**创建 WebContentsView，本组件只提供位置与尺寸。

  ⚠️ D1（原生层遮挡）：WebContentsView 处于 OS 合成层，CSS z-index 无效。
     主界面任何弹窗打开时必须让主进程 setVisible(false)。本组件监听 ctx 汇总的弹窗状态。
  ⚠️ D3（坐标）：hostBox 的 getBoundingClientRect() 与 setBounds() 同为 DIP，
     **绝不乘 devicePixelRatio**。
-->
<template>
    <div v-show="appMode === 'heavycards'" class="flex-1 flex flex-col h-full overflow-hidden relative bg-zinc-950">

        <!-- 空状态 -->
        <div v-if="!activeHeavyCard" class="flex-1 flex items-center justify-center text-zinc-500 flex-col gap-4">
            <div class="w-20 h-20 rounded-2xl flex items-center justify-center bg-rose-500/10 border border-rose-500/20 shadow-inner">
                <span class="text-4xl opacity-70">🎬</span>
            </div>
            <div class="text-center">
                <p class="text-sm tracking-widest text-zinc-300">请在左侧选择一张独立前端角色卡</p>
                <p class="text-[11px] text-zinc-600 mt-1">独立前端角色卡 · 展示与游玩 · 存档由本软件保管</p>
                <p class="text-[10px] text-zinc-600 mt-2">
                    当前仅支持 <span class="text-amber-500/90">HTML 网页链接</span> 形式的卡；exe、apk 等本地程序暂不支持
                </p>
            </div>
        </div>

        <template v-else>
            <!-- 顶部控制栏 -->
            <!-- ⚠️ 布局要点（UI 实测反馈）：
                 · 按钮组**不允许换行**，否则窄窗口下会溢到第二行压住下方内容；
                 · 但按钮太多时 `flex-nowrap` 只会让它们**向右溢出、被右边裁掉**（截图可见「离线/浏览器」消失）。
                 ⇒ 采用**两行折叠结构**：
                    第 1 行 = 卡片信息 + 常用操作（重新加载 / 备份 / 历史 / 全屏 / 窗口化 / 隐藏工具栏）+ 展开按钮；
                    第 2 行 = 折叠区（目录 / 清缓存 / 离线 / 浏览器 / 缩放），默认收起，需要时点 ▾ 展开。
                 这样任何窗口宽度下都不会有按钮被挡住或消失。 -->
            <div v-show="!panelHidden" class="px-3 py-2 border-b border-zinc-800 bg-zinc-900/90 shrink-0 shadow-sm">
                <div class="flex items-center gap-3 min-w-0 flex-nowrap">
                    <div class="flex items-center gap-3 min-w-0 shrink">
                        <div class="w-9 h-9 rounded-xl flex items-center justify-center bg-rose-500/15 border border-rose-500/30 text-lg shrink-0">
                            {{ activeHeavyCard.icon || '🎬' }}
                        </div>
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 min-w-0">
                                <h2 class="text-sm font-bold text-zinc-100 truncate">{{ activeHeavyCard.name }}</h2>
                                <span class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                                      :class="statusMeta.cls">{{ statusMeta.label }}</span>
                                <span class="px-1.5 py-0.5 rounded text-[10px] font-mono text-zinc-500 bg-zinc-800 border border-zinc-700/60 shrink-0">
                                    g{{ activeHeavyCard.gen }}
                                </span>
                            </div>
                            <p class="text-[10px] text-zinc-500 truncate mt-0.5" :title="activeHeavyCard.url">{{ hostOf(activeHeavyCard.url) }}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button @click="onReload" class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] transition whitespace-nowrap" title="重新加载（忽略缓存）">🔄 重新加载</button>
                        <button @click="onBackup" :disabled="heavyCardBackupBusy"
                                class="px-2.5 py-1.5 border rounded-lg text-[11px] transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                                :class="heavyCardBackupBusy ? 'theme-element opacity-50' : 'theme-element hover:border-emerald-500/60'"
                                title="立即备份当前存档">📦 {{ heavyCardBackupBusy ? '处理中…' : '备份' }}</button>
                        <button @click="toggleBackupPanel"
                                class="px-2.5 py-1.5 border rounded-lg text-[11px] transition whitespace-nowrap"
                                :class="showBackupPanel ? 'bg-rose-600/20 text-rose-200 border-rose-500/50' : 'theme-element hover:border-rose-500/60'"
                                :title="`历史备份（${heavyCardBackups.length} 份）`">🕘 {{ heavyCardBackups.length }}</button>

                        <!-- 🖵 沉浸式显示（本工作区专属）：全屏 / 窗口化 / 隐藏工具栏 -->
                        <!-- ⚠️ 这不是「窗口控制」而是「让卡占满屏幕游玩」—— 只能在重型卡工作区内出现 -->
                        <span class="w-px h-5 bg-zinc-700/60 mx-0.5 shrink-0"></span>
                        <button @click="onToggleFullScreen"
                                class="px-2.5 py-1.5 border rounded-lg text-[11px] transition whitespace-nowrap"
                                :class="immersiveFullScreen ? 'bg-rose-600/25 text-rose-200 border-rose-500/50' : 'theme-element hover:border-rose-500/60'"
                                :title="immersiveFullScreen ? '退出全屏（回到窗口模式）' : '全屏显示这张卡（F11 也可）'">
                            {{ immersiveFullScreen ? '🖥️ 退出全屏' : '🖥️ 全屏' }}
                        </button>
                        <button @click="onRestoreWindow"
                                class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] transition whitespace-nowrap"
                                title="窗口化：退出全屏/最大化，回到可调整大小的普通窗口">🪟 窗口化</button>
                        <button @click="togglePanelHidden"
                                class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] transition whitespace-nowrap"
                                title="隐藏顶部工具栏，让卡占满整个工作区（按 Esc 或再点一次恢复）">👁️ 隐藏</button>

                        <!-- ▾ 折叠开关：把「目录/缓存/离线/浏览器/缩放」收起来，避免按钮溢出被裁 -->
                        <button @click="toggleMoreActions"
                                class="px-2 py-1.5 border rounded-lg text-[11px] transition whitespace-nowrap"
                                :class="moreActionsOpen ? 'bg-sky-600/20 text-sky-200 border-sky-500/50' : 'theme-element hover:border-sky-500/60'"
                                :title="moreActionsOpen ? '收起更多操作' : '展开更多操作（目录 / 缓存 / 离线 / 浏览器 / 缩放）'">
                            {{ moreActionsOpen ? '▴ 收起' : '▾ 更多' }}
                        </button>
                    </div>
                </div>

                <!-- ▾ 折叠区：第二行（默认收起） -->
                <div v-show="moreActionsOpen" class="mt-2 pt-2 border-t border-zinc-800/70 flex flex-wrap items-center gap-1.5">
                    <button @click="onOpenDataDir" class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] transition whitespace-nowrap" title="打开该卡的存档数据目录">📂 目录</button>
                    <button @click="onClearCache" class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] transition whitespace-nowrap" title="只清 HTTP/代码缓存，不动存档">🧹 清缓存</button>
                    <button @click="onToggleOffline"
                            class="px-2.5 py-1.5 border rounded-lg text-[11px] transition whitespace-nowrap"
                            :class="isOffline ? 'bg-amber-600/20 text-amber-200 border-amber-500/50' : 'theme-element hover:border-rose-500/60'"
                            :title="isOffline ? '离线模式：仅放行本站域名，点击关闭' : '离线模式：拦截其它域名请求'">
                        {{ isOffline ? '📴 离线中' : '📴 离线' }}
                    </button>
                    <button @click="onOpenExternal" class="px-2.5 py-1.5 theme-element hover:border-rose-500/60 border rounded-lg text-[11px] transition whitespace-nowrap" title="用系统默认浏览器打开">↗ 浏览器</button>

                    <span class="w-px h-5 bg-zinc-700/60 mx-1 shrink-0"></span>
                    <span class="text-zinc-500 shrink-0">缩放</span>
                    <button @click="onZoom(-0.1)" class="w-6 h-6 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 rounded transition shrink-0" title="缩小">−</button>
                    <span class="font-mono w-12 text-center shrink-0">{{ Math.round(heavyCardZoom * 100) }}%</span>
                    <button @click="onZoom(0.1)" class="w-6 h-6 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 rounded transition shrink-0" title="放大">+</button>
                    <span class="flex-1"></span>
                    <span class="text-[10px] text-zinc-600">存档隔离于独立存储区，与主界面互不影响</span>
                </div>
            </div>

            <!-- 💾 备份历史面板 -->
            <!-- ⚠️ 布局修复（UI 实测反馈）：原来是 `absolute right-3 top-3` 的浮层，
                 会直接盖住右上角的「数据目录 / 清缓存 / 离线 / 浏览器」等按钮（截图可见）。
                 改为**在工具栏下方按正常文档流展开**：面板开着时把卡视图往下挤，
                 所有按钮始终可点，不产生遮挡。 -->
            <div v-if="showBackupPanel" class="shrink-0 border-b border-zinc-800 bg-zinc-900 flex flex-col max-h-[52%] overflow-hidden">
                <div class="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 shrink-0 flex-nowrap">
                    <span class="text-[11px] font-bold text-zinc-200 whitespace-nowrap">🕘 历史备份</span>
                    <span class="text-[10px] text-zinc-500 whitespace-nowrap">{{ heavyCardBackups.length }} 份</span>
                    <span class="flex-1"></span>
                    <button @click="onOpenBackupDir" class="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition whitespace-nowrap" title="打开备份所在文件夹">📂 目录</button>
                    <button @click="onExportBundle" class="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-sky-600 text-zinc-300 hover:text-white rounded transition whitespace-nowrap" title="导出为单文件包（搬到另一台机器用）">📤 导出</button>
                    <button @click="onImportBundle" class="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-sky-600 text-zinc-300 hover:text-white rounded transition whitespace-nowrap" title="从单文件包导入（导入后需再点恢复）">📥 导入</button>
                    <button @click="onRefreshBackups" class="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition" title="刷新列表">🔄</button>
                    <button @click="showBackupPanel = false" class="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-rose-600 text-zinc-300 hover:text-white rounded transition" title="收起">✕</button>
                </div>

                <!-- 📂 本地目录模式 -->
                <div class="px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/40 flex items-center gap-2 shrink-0 flex-nowrap">
                    <span class="text-[10px] text-zinc-500 whitespace-nowrap">来源</span>
                    <span class="text-[10px] flex-1 truncate"
                          :class="activeHeavyCard?.localDir ? 'text-emerald-400' : 'text-zinc-400'"
                          :title="activeHeavyCard?.localDir || activeHeavyCard?.url">
                        {{ activeHeavyCard?.localDir ? '本地目录：' + activeHeavyCard.localDir : '远程地址' }}
                    </span>
                    <button v-if="!activeHeavyCard?.localDir" @click="onUseLocalDir"
                            class="px-2 py-0.5 text-[10px] bg-zinc-800 hover:bg-emerald-600 text-zinc-300 hover:text-white rounded transition whitespace-nowrap"
                            title="选择本地文件夹（需含 index.html）">📂 用本地</button>
                    <button v-else @click="onClearLocalDir"
                            class="px-2 py-0.5 text-[10px] bg-zinc-800 hover:bg-rose-600 text-zinc-300 hover:text-white rounded transition"
                            title="改回远程地址">↩ 恢复远程</button>
                </div>

                <!-- ⏱️ 自动备份设置 -->
                <div class="px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0 space-y-1.5">
                    <div class="flex items-center gap-2">
                        <label class="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer">
                            <input type="checkbox" :checked="autoCfg.enabled" @change="onAutoToggle('enabled', $event.target.checked)" class="accent-rose-500">
                            自动备份
                        </label>
                        <label class="flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer">
                            <input type="checkbox" :checked="autoCfg.onExit" @change="onAutoToggle('onExit', $event.target.checked)" class="accent-rose-500">
                            关闭软件前
                        </label>
                        <span class="flex-1"></span>
                        <span class="text-[10px] text-zinc-500">保留</span>
                        <select :value="autoCfg.keep" @change="onAutoKeep($event.target.value)"
                                class="h-6 bg-zinc-800 border border-zinc-700/60 rounded px-1 text-[10px] text-zinc-300 focus:outline-none">
                            <option v-for="n in [3,5,10,20]" :key="n" :value="n">{{ n }} 份</option>
                        </select>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] text-zinc-500">游玩时每</span>
                        <select :value="autoCfg.intervalMin" @change="onAutoInterval($event.target.value)"
                                class="h-6 bg-zinc-800 border border-zinc-700/60 rounded px-1 text-[10px] text-zinc-300 focus:outline-none">
                            <option :value="0">关闭</option>
                            <option :value="5">5 分钟</option>
                            <option :value="10">10 分钟</option>
                            <option :value="30">30 分钟</option>
                            <option :value="60">60 分钟</option>
                        </select>
                        <span class="text-[10px] text-zinc-500">自动存一份</span>
                        <span class="flex-1"></span>
                        <span v-if="autoCfg.intervalMin > 0 && autoCfg.enabled" class="text-[9px] text-emerald-500/80">● 计时中</span>
                    </div>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                    <div v-for="b in backupsDesc" :key="b.name"
                         class="rounded-lg border border-zinc-700/60 bg-zinc-800/50 px-2.5 py-2">
                        <div class="flex items-center gap-1.5">
                            <span class="px-1 py-0.5 text-[9px] rounded shrink-0"
                                  :class="kindClass(b.kind)">{{ kindLabel(b.kind) }}</span>
                            <span class="text-[11px] text-zinc-200 font-mono truncate flex-1" :title="b.name">{{ formatStamp(b.createdAt) }}</span>
                            <span class="text-[9px] text-zinc-500 shrink-0 font-mono">g{{ b.gen }}</span>
                        </div>
                        <div class="flex items-center gap-2 mt-1">
                            <span class="text-[9px] text-zinc-500">{{ formatBytes(b.totalBytes) }}</span>
                            <span class="text-[9px] text-zinc-600">{{ b.fileCount }} 文件</span>
                            <span class="flex-1"></span>
                            <button @click="onRestore(b)" :disabled="heavyCardBackupBusy"
                                    class="px-2 py-0.5 text-[10px] bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white border border-amber-500/30 rounded transition disabled:opacity-40">↩ 恢复</button>
                            <button @click="onDeleteBackup(b)" class="px-2 py-0.5 text-[10px] bg-zinc-700/50 hover:bg-rose-600 text-zinc-400 hover:text-white rounded transition">🗑️</button>
                        </div>
                    </div>

                    <div v-if="heavyCardBackups.length === 0" class="py-8 text-center text-[11px] text-zinc-500">
                        还没有备份。<br>点顶部「📦 备份」立即生成一份。
                    </div>
                </div>
            </div>

            <!-- 视图占位框：主进程的 WebContentsView 会精确覆盖在这个矩形上 -->
            <div class="flex-1 relative min-h-0 overflow-hidden bg-black">
                <div ref="hostBox" id="heavycard-host-box" class="absolute inset-0"></div>

                <!-- 👁️ 工具栏已隐藏时的恢复入口（右上角悬浮，平时半透明不挡视线） -->
                <button v-if="panelHidden" ref="resumeBtn" @click="togglePanelHidden"
                        class="absolute top-2 right-2 z-30 px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900/85 hover:bg-rose-600 text-zinc-300 hover:text-white border border-zinc-700/70 shadow-lg transition opacity-60 hover:opacity-100"
                        title="显示顶部工具栏（Esc 也可）">👁️ 显示工具栏</button>

                <!-- loading / error 覆盖层（view 不可见时才显示，避免与原生层叠影） -->
                <div v-if="heavyCardStatus === 'loading'" class="absolute inset-0 flex items-center justify-center flex-col gap-3 text-zinc-400 bg-zinc-950/70 pointer-events-none">
                    <div class="w-10 h-10 rounded-full border-2 border-rose-500/30 border-t-rose-500 animate-spin"></div>
                    <p class="text-xs">正在加载独立前端角色卡…（首次可能需要几秒）</p>
                </div>
                <div v-else-if="heavyCardStatus === 'error' || heavyCardStatus === 'crashed'" class="absolute inset-0 flex items-center justify-center flex-col gap-3 text-zinc-400 bg-zinc-950/90">
                    <span class="text-3xl">⚠️</span>
                    <p class="text-xs">{{ heavyCardStatus === 'crashed' ? '渲染进程已崩溃' : '加载失败（可能是网络或站点问题）' }}</p>
                    <div class="flex gap-2">
                        <button @click="onReload" class="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-[11px] rounded-lg transition">重试</button>
                        <button @click="onOpenExternal" class="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] rounded-lg transition">用浏览器打开</button>
                    </div>
                </div>

                <!-- 😴 闲置隐藏覆盖层（P2-4）：视图只是隐藏，点一下即恢复，不重新加载 -->
                <div v-else-if="heavyCardIdle" class="absolute inset-0 flex items-center justify-center flex-col gap-3 text-zinc-400 bg-zinc-950/95 cursor-pointer" @click="onResumeFromIdle">
                    <span class="text-3xl">😴</span>
                    <p class="text-xs">已闲置 10 分钟，视图已暂停以节省内存</p>
                    <p class="text-[10px] text-zinc-600">页面状态仍保留，点任意处立即恢复</p>
                </div>
            </div>

            <!-- 底部状态条 -->
            <div class="px-3 py-1.5 border-t border-zinc-800 bg-zinc-900 shrink-0 flex items-center gap-3 text-[10px] text-zinc-500">
                <span>{{ statusMeta.hint }}</span>
                <span class="flex-1"></span>
                <span v-if="storageInfo" class="font-mono">占用 {{ formatBytes(storageInfo.bytes) }}</span>
            </div>
        </template>
    </div>
</template>

<script>
import { inject, ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';

export default {
    name: 'HeavyCardWorkspace',
    setup() {
        const ctx = inject('appCtx');
        // ⚠️ 名字必须与 App.vue 的 `ctx` 暴露键**逐字一致**（那里统一带 Heavy 前缀）。
        //    历史上这里写成 `reportRect` / `syncViewVisibility` ⇒ 运行时报 `x is not a function`
        //    （编译期查不出，因为解构自 any 类型的 ctx）。改动任一侧都要同步。
        const {
            appMode,
            heavyCards, activeHeavyCard,
            heavyCardStatus, heavyCardZoom, heavyCardMounted, heavyCardIdle,
            openHeavyCard,
            reportHeavyCardRect: reportRect,
            syncHeavyViewVisibility: syncViewVisibility,            reloadHeavyCard,
            changeHeavyCardZoom: changeZoom,
            openHeavyCardDataDir, clearHeavyCardCache,
            getHeavyCardStorageInfo: getStorageInfo,
            openExternalUrl,
            heavyCardBackups, heavyCardBackupBusy,
            refreshHeavyCardBackups, backupHeavyCard, restoreHeavyCard,
            deleteHeavyCardBackup, openHeavyCardBackupDir,
            applyHeavyCardAutoBackupSettings,
            exportHeavyCardBundle, importHeavyCardBundle,
            setHeavyCardOffline, refreshBlockedLog, heavyCardBlockedLog,
            setHeavyCardLocalDir, clearHeavyCardLocalDir,
            setHeavyCardIdleHidden, startHeavyCardIdleWatch, stopHeavyCardIdleWatch,
            markHeavyCardActivity,
            subscribeHeavyCardPageTitle,
            confirmDialog
        } = ctx;

        const hostBox = ref(null);
        const storageInfo = ref(null);
        const showBackupPanel = ref(false);
        // 👁️ 「显示工具栏」恢复按钮（用于计算原生视图让位区域）
        const resumeBtn = ref(null);
        let ro = null;
        let rafId = 0;

        // ── 状态徽标 ──────────────────────────────────────────
        const STATUS_MAP = {
            idle:     { label: '未加载', cls: 'bg-zinc-700/60 text-zinc-300 border border-zinc-600/50', hint: '未加载' },
            loading:  { label: '加载中', cls: 'bg-amber-500/15 text-amber-300 border border-amber-500/30', hint: '正在加载…' },
            ready:    { label: '已就绪', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30', hint: '就绪 · 存档随卡自动备份' },
            error:    { label: '加载失败', cls: 'bg-rose-500/15 text-rose-300 border border-rose-500/30', hint: '加载失败' },
            crashed:  { label: '已崩溃', cls: 'bg-rose-600/20 text-rose-200 border border-rose-500/40', hint: '渲染进程崩溃' }
        };
        const statusMeta = computed(() => STATUS_MAP[heavyCardStatus.value] || STATUS_MAP.idle);

        const hostOf = (url) => {
            try { return new URL(url).host; } catch (e) { return url || ''; }
        };
        const formatBytes = (n) => {
            const b = Number(n) || 0;
            if (b < 1024) return b + ' B';
            if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
            if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
            return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        };

        // ── 布局上报（D3：DIP 直传，绝不乘 DPR） ────────────────
        const pushRect = () => {
            if (!hostBox.value) return;
            // 尺寸为 0 时跳过（容器刚创建/正在过渡） —— useHeavyCards.reportRect 内部还会再拦一道
            const r = hostBox.value.getBoundingClientRect();
            if (!(r.width > 0) || !(r.height > 0)) return;
            // 🎯 让位计算：原生视图会盖住 DOM 浮层，必须把它从视图矩形里扣掉。
            //    当前唯一需要让位的是「👁️ 显示工具栏」恢复按钮（仅隐藏工具栏后出现），
            //    它是 `absolute top-2 right-2` 的小胶囊。这里按它实际测量值 + 边距动态算，
            //    而不是写死像素（改样式/改字号后仍然对）。
            let inset = null;
            try {
                const btn = resumeBtn.value;
                if (panelHidden.value && btn) {
                    const br = btn.getBoundingClientRect();
                    if (br.width > 0 && br.height > 0) {
                        inset = {
                            top: Math.max(0, Math.ceil(br.bottom - r.top) + 6),
                            right: Math.max(0, Math.ceil(r.right - br.left) + 6),
                            bottom: 0,
                            left: 0
                        };
                    }
                }
            } catch (e) { /* 量不到就不让位 */ }
            reportRect(hostBox.value, inset);
        };
        const scheduleRect = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                pushRect();
            });
        };

        // ── 工具条动作 ───────────────────────────────────────
        const onReload = async () => {
            await reloadHeavyCard(true);
            nextTick(scheduleRect);
        };
        const onZoom = async (d) => {
            await changeZoom(d);
        };
        const onOpenDataDir = async () => {
            await openHeavyCardDataDir();
        };
        const onClearCache = async () => {
            await clearHeavyCardCache();
        };
        const onOpenExternal = () => {
            const url = activeHeavyCard.value?.url;
            // ⚠️ 不能用 window.open：主窗口的 setWindowOpenHandler 无条件 deny，会静默失败。
            if (url && typeof openExternalUrl === 'function') openExternalUrl(url);
        };

        // ── 💾 备份面板 ──────────────────────────────────────
        /** 备份列表倒序（新的在上） */
        const backupsDesc = computed(() => {
            const arr = (heavyCardBackups && heavyCardBackups.value) || [];
            return arr.slice().reverse();
        });
        const KIND_META = {
            manual:       { label: '手动', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' },
            auto:         { label: '自动', cls: 'bg-sky-500/15 text-sky-300 border border-sky-500/30' },
            'pre-restore': { label: '恢复前', cls: 'bg-amber-500/15 text-amber-300 border border-amber-500/30' }
        };
        const kindLabel = (k) => (KIND_META[k] || KIND_META.auto).label;
        const kindClass = (k) => (KIND_META[k] || KIND_META.auto).cls;
        const formatStamp = (iso) => {
            const d = new Date(iso);
            if (!d.getTime()) return String(iso || '');
            const p = (n) => String(n).padStart(2, '0');
            return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        };

        const toggleBackupPanel = async () => {
            showBackupPanel.value = !showBackupPanel.value;
            // ⚠️ D1：原生图层会盖住浮层 —— 打开面板时必须让视图隐藏
            syncVisibility(anyModalOpen.value || showBackupPanel.value);
            if (showBackupPanel.value) await refreshHeavyCardBackups(activeHeavyCard.value);
        };
        const onRefreshBackups = async () => { await refreshHeavyCardBackups(activeHeavyCard.value); };
        const onOpenBackupDir = async () => { await openHeavyCardBackupDir(); };
        const onBackup = async () => {
            await backupHeavyCard('manual');
            await refreshHeavyCardBackups(activeHeavyCard.value);
            if (!showBackupPanel.value) showBackupPanel.value = true;
        };
        const onRestore = async (b) => {
            if (!b) return;
            // 恢复会切换世代并重建视图（= 覆盖当前存档），必须二次确认。
            // 恢复前主进程会自动做一份 pre-restore 兜底快照，所以这里只提示不阻止。
            const msg = `将把「${activeHeavyCard.value?.name || '该卡'}」恢复到 ${formatStamp(b.createdAt)} 的存档。\n\n`
                + `当前进度会先自动存一份「恢复前」备份（可再恢复回来）。\n\n确认恢复？`;
            const ok = (typeof confirmDialog === 'function')
                ? await confirmDialog('恢复存档', msg)
                : true;
            if (!ok) return;
            await restoreHeavyCard(b.name, hostBox.value);
            await refreshHeavyCardBackups(activeHeavyCard.value);
            showBackupPanel.value = false;
        };
        const onDeleteBackup = async (b) => {
            if (!b) return;
            const ok = await deleteHeavyCardBackup(b.name);
            if (ok) await refreshHeavyCardBackups(activeHeavyCard.value);
        };

        // ── ⏱️ 自动备份设置 ──────────────────────────────────
        const DEFAULT_AUTO = { enabled: true, onExit: true, onOpen: false, intervalMin: 30, keep: 5 };
        const autoCfg = computed(() => {
            const s = activeHeavyCard.value?.settings?.autoBackup || {};
            return { ...DEFAULT_AUTO, ...s };
        });

        /** 写入设置并通知定时器重排 */
        const patchAutoCfg = (patch) => {
            const card = activeHeavyCard.value;
            if (!card) return;
            const nextAutoBackup = { ...DEFAULT_AUTO, ...(card.settings?.autoBackup || {}), ...patch };
            ctx.updateHeavyCard(card.id, {
                settings: { ...card.settings, autoBackup: nextAutoBackup }
            });
            if (typeof applyHeavyCardAutoBackupSettings === 'function') {
                applyHeavyCardAutoBackupSettings(card.id);
            }
        };
        const onAutoToggle = (key, val) => patchAutoCfg({ [key]: !!val });
        const onAutoKeep = (val) => patchAutoCfg({ keep: Math.min(20, Math.max(1, Number(val) || 5)) });
        const onAutoInterval = (val) => patchAutoCfg({ intervalMin: Math.max(0, Number(val) || 0) });

        // ── 📴 离线模式 ──────────────────────────────────────
        const isOffline = computed(() => !!activeHeavyCard.value?.settings?.offline);
        const blockedCount = computed(() => ((heavyCardBlockedLog && heavyCardBlockedLog.value) || []).length);
        const onToggleOffline = async () => {
            await setHeavyCardOffline(!isOffline.value);
            await refreshBlockedLog();
        };

        // ── 📦 跨机迁移 ──────────────────────────────────────
        const onExportBundle = async () => {
            const res = await exportHeavyCardBundle(null);
            if (res && res.success) { await refreshHeavyCardBackups(activeHeavyCard.value); }
        };
        const onImportBundle = async () => {
            const res = await importHeavyCardBundle();
            if (res && res.success) { await refreshHeavyCardBackups(activeHeavyCard.value); }
        };

        // ── 📂 本地目录 ──────────────────────────────────────
        const onUseLocalDir = async () => {
            const res = await setHeavyCardLocalDir(true);
            if (res && res.success) { await onReload(); }
        };
        const onClearLocalDir = async () => {
            const ok = await clearHeavyCardLocalDir();
            if (ok) { await onReload(); }
        };

        // ── 😴 闲置恢复 ──────────────────────────────────────
        const onResumeFromIdle = async () => {
            markHeavyCardActivity();
            await setHeavyCardIdleHidden(false);
            scheduleRect();
        };

        // ── 🖵 沉浸式显示（重型卡工作区专属）──────────────────
        // 需求（用户 2026-10-18）：「窗口化按钮和全屏按钮」是**重型卡工作区的功能**，
        // 让别人玩这张卡时能全屏沉浸。与主界面其它部分无关，因此入口只放在本工作区工具栏。
        //
        // ⚠️ 与「最大化」的语义区分：
        //    · 全屏（setFullScreen）= 连任务栏一起隐藏，真正占满整块屏幕；
        //    · 窗口化（setFullScreen(false) + unmaximize）= 回到**可拖动调整大小**的普通窗口。
        const immersiveFullScreen = ref(false);
        const panelHidden = ref(false);      // 👁️ 隐藏工具栏（让卡占满工作区）
        // ▾ 折叠区：把低频操作（目录/缓存/离线/浏览器/缩放）收进第二行，避免工具栏按钮溢出被裁
        const moreActionsOpen = ref(false);
        const toggleMoreActions = () => {
            moreActionsOpen.value = !moreActionsOpen.value;
            // 展开/收起会改变下方视图可用高度，必须重新量一次占位框
            nextTick(scheduleRect);
            setTimeout(scheduleRect, 120);
        };
        let unsubWindowState = null;

        const syncImmersiveState = async () => {
            try {
                const st = await window.electronAPI?.windowGetState?.();
                if (st && st.success) immersiveFullScreen.value = !!st.fullScreen;
            } catch (e) { /* 忽略 */ }
        };

        const onToggleFullScreen = async () => {
            try {
                const r = await window.electronAPI?.windowToggleFullScreen?.();
                if (r && r.success) immersiveFullScreen.value = !!r.fullScreen;
            } catch (e) { /* 忽略 */ }
            // 全屏切换后可用区域变了，必须重新量一次占位框
            nextTick(scheduleRect);
            setTimeout(scheduleRect, 150);
        };

        /** 窗口化：退出全屏 + 取消最大化 → 回到可自由调整大小的普通窗口 */
        const onRestoreWindow = async () => {
            try {
                await window.electronAPI?.windowRestore?.();
            } catch (e) { /* 忽略 */ }
            immersiveFullScreen.value = false;
            nextTick(scheduleRect);
            setTimeout(scheduleRect, 150);
        };

        /** 👁️ 隐藏工具栏（Esc 恢复）—— 只是本地 UI 状态，不动窗口 */
        const togglePanelHidden = () => {
            panelHidden.value = !panelHidden.value;
            nextTick(scheduleRect);
            setTimeout(scheduleRect, 120);
        };

        const onEscRestorePanel = (e) => {
            if (e && e.key === 'Escape' && panelHidden.value) togglePanelHidden();
        };

        // ── D1：弹窗遮挡 ─────────────────────────────────────
        // WebContentsView 位于 OS 合成层，CSS z-index 无效 —— 任何主界面弹窗都必须让 view 隐藏。
        // 实现：不逐个改动现有弹窗代码，而是**统一扫描** appCtx 里所有布尔型弹窗状态，
        //      任一为 true 即视为「有弹窗打开」。
        // 识别的键名模式（覆盖本项目现有全部弹窗与菜单）：
        //   show* / *Visible / *Show / *Open / showXxxModal / contextMenu / wbContextMenu …
        //
        // ⚠️ ctx 里的字段名带 Heavy 前缀（`syncHeavyViewVisibility` / `reportHeavyCardRect`）；
        //    漏了前缀会在 watch 的 immediate 阶段直接抛 `xxx is not a function`（v2.4.1 冒烟抓获）。
        const syncVisibility = (open) => {
            if (typeof syncViewVisibility === 'function') syncViewVisibility(open);
        };

        const MODAL_KEY_RE = /^(show[A-Z]|.*ModalVisible$|.*ModalShow$|.*ModalOpen$|contextMenu$|wbContextMenu$|showCommandPalette$)/;
        const MODAL_KEY_EXCLUDE = new Set([
            'showEditorLogs',      // 日志面板：不是弹窗，不需要隐藏视图
            'showSidebar',         // 侧栏显示开关
            'showListTags',
            'showAdvancedFilters',
            'showWbAdvanced',
            'showWbStats',
            'showUpdateBadge',
            'showExperimentalMenu'
        ]);

        const anyModalOpen = computed(() => {
            // 优先使用 App.vue 显式汇总的字段（若后续提供）
            const explicit = ctx.anyModalOpen;
            if (explicit && typeof explicit.value === 'boolean') return explicit.value;
            // 🪟 顶部菜单展开：必须算作「遮挡」—— WebContentsView 在 OS 合成层，
            //    CSS z-index 无效，菜单会被它盖住（用户实测截图反馈）。
            const menuFlag = ctx.headerMenuOpen;
            if (menuFlag && typeof menuFlag === 'object' && 'value' in menuFlag && menuFlag.value === true) return true;
            // 回退：扫描 ctx 里的弹窗状态
            for (const [key, val] of Object.entries(ctx)) {
                if (!MODAL_KEY_RE.test(key) || MODAL_KEY_EXCLUDE.has(key)) continue;
                if (val && typeof val === 'object' && 'value' in val) {
                    if (val.value === true) return true;
                }
            }
            return false;
        });

        watch(anyModalOpen, (open) => {
            // 备份面板本身也要参与裁决（它同样被原生层遮挡）
            syncVisibility(open || showBackupPanel.value);
        }, { immediate: true });
        watch(appMode, (m) => {
            syncVisibility(anyModalOpen.value);
            if (m === 'heavycards') { nextTick(scheduleRect); }
        });
        // 打开某张卡后立即定位
        // ⚠️ 时序：activeHeavyCard 刚赋值时工作区可能还没渲染出 hostBox（v-show 切换 + 模板 v-if），
        //    因此要 await nextTick 再量；同时补一次延时重复上报，覆盖布局稳定前的过渡帧。
        watch(() => activeHeavyCard.value?.id, async (id) => {
            if (!id) return;
            await nextTick();
            scheduleRect();
            setTimeout(scheduleRect, 120);
            setTimeout(scheduleRect, 400);
            const info = await getStorageInfo(activeHeavyCard.value);
            storageInfo.value = info;
        });

        // 窗口可见性变化（最小化等）时同步
        const onVisibility = () => {
            syncVisibility(anyModalOpen.value);
        };

        onMounted(() => {
            if (hostBox.value && typeof ResizeObserver !== 'undefined') {
                ro = new ResizeObserver(() => scheduleRect());
                ro.observe(hostBox.value);
            }
            window.addEventListener('resize', scheduleRect);
            document.addEventListener('visibilitychange', onVisibility);

            // ⚠️ 必须订阅主进程的加载状态事件：否则 UI 永远停在「加载中」
            //    （冒烟实测：target 已出现、站点已渲染，但徽标一直是 loading）。
            try {
                window.electronAPI.heavyCard.onStatus((p) => {
                    if (!p) return;
                    // 只认当前卡的状态，避免切卡瞬间旧卡事件串台
                    if (activeHeavyCard.value && p.id && p.id !== activeHeavyCard.value.id) return;
                    if (p.state === 'loading' || p.state === 'ready' || p.state === 'error' || p.state === 'crashed') {
                        heavyCardStatus.value = p.state;
                    }
                });
            } catch (e) { /* 旧版本无该通道时忽略 */ }

            // 🏷️ 订阅页面真实标题：新加卡时名字是从 URL 猜的（`yd_rsdtq` 这种），
            //    页面加载完成后用 <title> 换成可读名字（用户实测反馈）。
            try { if (typeof subscribeHeavyCardPageTitle === 'function') subscribeHeavyCardPageTitle(); } catch (e) { /* 忽略 */ }

            nextTick(scheduleRect);

            // 😴 闲置检测（10 分钟无操作 → 隐藏视图省内存）
            try { if (typeof startHeavyCardIdleWatch === 'function') startHeavyCardIdleWatch(); } catch (e) { /* 忽略 */ }

            // 🖵 沉浸式显示：对齐真实全屏状态 + 订阅主进程推送（F11/系统键也能同步图标）
            syncImmersiveState();
            try {
                unsubWindowState = window.electronAPI?.onWindowStateChanged?.((p) => {
                    if (!p) return;
                    if (typeof p.fullScreen === 'boolean') {
                        immersiveFullScreen.value = p.fullScreen;
                        nextTick(scheduleRect);
                    }
                }) || null;
            } catch (e) { /* 旧版本无该通道时忽略 */ }

            // 👁️ 隐藏工具栏时按 Esc 恢复
            window.addEventListener('keydown', onEscRestorePanel);
        });

        onUnmounted(() => {
            try { if (typeof stopHeavyCardIdleWatch === 'function') stopHeavyCardIdleWatch(); } catch (e) { /* 忽略 */ }
            try { if (typeof unsubWindowState === 'function') unsubWindowState(); } catch (e) { /* 忽略 */ }
            window.removeEventListener('keydown', onEscRestorePanel);
            if (ro) { try { ro.disconnect(); } catch (e) { /* 忽略 */ } ro = null; }
            window.removeEventListener('resize', scheduleRect);
            document.removeEventListener('visibilitychange', onVisibility);
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        });

        return {
            // ⚠️ 模板引用的 ctx 状态**必须在这里显式返回**（Options API 的 setup 不会自动暴露闭包变量）。
            //    历史上漏了 appMode/activeHeavyCard ⇒ 模板里全是 undefined：
            //    工作区永远 v-show=false、永远显示"请选择"、诊断属性也只剩 `data-hc-active`。
            appMode, activeHeavyCard, heavyCards,
            heavyCardStatus, heavyCardZoom, heavyCardMounted,
            hostBox, storageInfo,
            statusMeta, hostOf, formatBytes,
            // 💾 备份面板
            showBackupPanel, backupsDesc, heavyCardBackupBusy, heavyCardBackups,
            kindLabel, kindClass, formatStamp,
            toggleBackupPanel, onRefreshBackups, onOpenBackupDir,
            onBackup, onRestore, onDeleteBackup,
            // ⏱️ 自动备份设置
            autoCfg, onAutoToggle, onAutoKeep, onAutoInterval,
            // 📴 离线 / 📦 迁移 / 📂 本地目录 / 😴 闲置
            isOffline, blockedCount, onToggleOffline,
            onExportBundle, onImportBundle,
            // 🖵 沉浸式显示（全屏 / 窗口化 / 隐藏工具栏）
            immersiveFullScreen, panelHidden,
            onToggleFullScreen, onRestoreWindow, togglePanelHidden,
            // ▾ 折叠区
            moreActionsOpen, toggleMoreActions,
            onUseLocalDir, onClearLocalDir,
            heavyCardIdle, onResumeFromIdle,
            onReload, onZoom, onOpenDataDir, onClearCache, onOpenExternal
        };
    }
};
</script>
