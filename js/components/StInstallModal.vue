<!--
  🛠️ 酒馆「安装与维护」弹窗（一键装桌面版酒馆 / 启停 / 升级 / 两档卸载）

  规格：资料库/一键安装桌面版酒馆-方案-v1.md
  主进程：main/stManager.js（检测/安装/启停/升级/卸载），纯逻辑：js/utils/stInstallCore.js

  ⚠️ 必须顶层挂载（项目历史坑：fixed 定位在子组件里会被裁切）—— 只由 App.vue 挂载。
  ⚠️ 卸载是最危险操作：备份默认开启、需手输 DELETE、注册表按 Publisher 校验（防误删 Chrome PWA）。
-->
<template>
    <!--
      ⚠️ 这里不能用 <transition name="fade"> 包裹：
      全局 .fade-leave-from 只设 opacity:0，与 .fade-leave-active 的 transition 组合后，
      浏览器等不到 transitionend，Vue 会永远停在 leave 阶段 ——
      表现就是「点关闭没反应，遮罩一直挡着，之后点什么都没反应」（实测踩坑）。
      弹窗不需要淡出动画，直接不要 transition。
    -->
    <div v-if="show" class="fixed inset-0 z-[120] bg-black/75 flex items-center justify-center p-4">
        <div class="bg-zinc-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[94vh] flex flex-col overflow-hidden border border-zinc-700">

                <!-- 头部 -->
                <div class="px-5 py-3.5 bg-zinc-950 text-zinc-100 border-b border-zinc-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🛠️ 酒馆安装与维护
                        <span class="text-[10px] font-normal text-zinc-400">一键安装 · 升级 · 卸载</span>
                    </h3>
                    <button @click="close" :disabled="busy" class="text-zinc-400 hover:text-white text-sm disabled:opacity-40">✕ 关闭</button>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 custom-scrollbar">

                    <!-- ① 安装位置 -->
                    <section class="rounded-lg border border-zinc-700 bg-zinc-950/60 p-3 space-y-2">
                        <div class="text-[11px] font-bold text-zinc-300">① 安装位置</div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <input :value="dirPath" readonly placeholder="（未选择）"
                                   class="flex-1 min-w-[240px] bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none">
                            <button @click="pickDir" :disabled="busy"
                                    class="px-2.5 py-1 rounded border border-cyan-600 bg-zinc-800 text-cyan-300 text-[11px] hover:bg-cyan-600 hover:text-white disabled:opacity-50 transition">选择目录…</button>
                            <button @click="scanLocal" :disabled="busy || scanning"
                                    class="px-2.5 py-1 rounded border border-violet-600 bg-zinc-800 text-violet-300 text-[11px] hover:bg-violet-600 hover:text-white disabled:opacity-50 transition"
                                    title="扫描各磁盘与常用目录（桌面/下载/文档），自动找出已安装的酒馆">{{ scanning ? '⏳ 扫描中…' : '🔍 自动查找' }}</button>
                            <button v-if="dirPath" @click="recheck" :disabled="busy"
                                    class="px-2.5 py-1 rounded border border-zinc-600 bg-zinc-800 text-zinc-300 text-[11px] hover:bg-zinc-700 disabled:opacity-50 transition">重新检测</button>
                            <button v-if="dirPath" @click="runDiagnose" :disabled="busy || diagnosing"
                                    class="px-2.5 py-1 rounded border border-emerald-600 bg-zinc-800 text-emerald-300 text-[11px] hover:bg-emerald-600 hover:text-white disabled:opacity-50 transition"
                                    title="体检酒馆环境：程序文件 / Node / 依赖 / 配置 / 数据 / 端口 / 磁盘 / git / 运行状态">{{ diagnosing ? '⏳ 体检中…' : '🩺 检查环境' }}</button>
                            <button v-if="dirPath" @click="openFolder" :disabled="busy"
                                    class="px-2.5 py-1 rounded border border-zinc-600 bg-zinc-800 text-zinc-300 text-[11px] hover:bg-zinc-700 disabled:opacity-50 transition">打开</button>
                        </div>

                        <!-- 环境体检结果 -->
                        <div v-if="diagChecks.length" class="rounded border border-emerald-800/60 bg-emerald-950/20 p-2 space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <div class="text-[10px] font-bold"
                                     :class="diagSummary.error > 0 ? 'text-rose-300' : (diagSummary.warn > 0 ? 'text-amber-300' : 'text-emerald-300')">
                                    🩺 环境体检：{{ diagSummary.verdict }}
                                    <span class="font-normal text-zinc-400">
                                        （{{ diagSummary.ok }} 项正常<template v-if="diagSummary.warn"> · {{ diagSummary.warn }} 项留意</template><template v-if="diagSummary.error"> · {{ diagSummary.error }} 项需修复</template>）
                                    </span>
                                </div>
                                <button @click="diagChecks = []" class="text-[10px] text-zinc-500 hover:text-zinc-300">收起</button>
                            </div>
                            <div v-for="c in diagChecks" :key="c.id"
                                 class="flex items-start gap-1.5 text-[10px] leading-relaxed">
                                <span class="shrink-0">{{ c.status === 'ok' ? '✅' : (c.status === 'warn' ? '⚠️' : '❌') }}</span>
                                <span class="shrink-0 font-bold"
                                      :class="c.status === 'ok' ? 'text-zinc-300' : (c.status === 'warn' ? 'text-amber-300' : 'text-rose-300')">{{ c.label }}</span>
                                <span class="text-zinc-400 break-all">
                                    {{ c.detail }}
                                    <span v-if="c.hint" class="text-zinc-500">｜{{ c.hint }}</span>
                                </span>
                            </div>
                        </div>

                        <!-- 扫描结果（找到多个时让用户挑） -->
                        <div v-if="scanResults.length" class="rounded border border-violet-800/60 bg-violet-950/30 p-2 space-y-1">
                            <div class="text-[10px] text-violet-300 font-bold">
                                找到 {{ scanResults.length }} 个已安装的酒馆{{ scanTruncated ? '（扫描已达时间上限，可能还有遗漏）' : '' }}：
                            </div>
                            <button v-for="r in scanResults" :key="r.dir" @click="useScanResult(r)"
                                    :disabled="busy"
                                    class="w-full text-left px-2 py-1 rounded border border-zinc-700 bg-zinc-900 hover:border-violet-500 hover:bg-violet-950/60 transition disabled:opacity-50">
                                <div class="text-[11px] text-zinc-200 font-mono break-all">{{ r.dir }}</div>
                                <div class="text-[10px] text-zinc-400">
                                    <span v-if="r.version">版本 v{{ r.version }}</span>
                                    <span v-else>版本未知</span>
                                    · {{ r.hasNodeModules ? '依赖完整' : '⚠️ 缺依赖' }}
                                    <span v-if="r.hasGit"> · git</span>
                                    <span v-if="dirPath && r.dir === dirPath" class="text-emerald-400"> · 当前已选</span>
                                </div>
                            </button>
                        </div>
                        <div v-else-if="scanDone && !scanning" class="text-[10px] text-zinc-500">
                            本机未找到已安装的酒馆{{ scanTruncated ? '（扫描已达时间上限）' : '' }}，可直接「选择目录…」或「一键安装」。
                        </div>

                        <!-- 状态 -->
                        <div v-if="checking" class="text-[11px] text-zinc-400">正在检测…</div>
                        <div v-else-if="status" class="text-[11px] space-y-1">
                            <div v-if="status.state === 'ready'" class="text-emerald-400">
                                ✅ 已安装 <span class="font-mono">v{{ status.version || '?' }}</span>
                                · 依赖完整 · {{ serverRunning ? '运行中' : '未运行' }}
                            </div>
                            <div v-else-if="status.state === 'running'" class="text-emerald-400">
                                ✅ 已安装 <span class="font-mono">v{{ status.version || '?' }}</span> · <span class="text-cyan-300">正在运行</span>
                            </div>
                            <div v-else-if="status.state === 'incomplete'" class="text-amber-400">
                                ⚠️ 检测到酒馆但依赖未安装，请点「重装依赖」
                            </div>
                            <div v-else class="text-zinc-400">📂 该目录尚未安装酒馆</div>

                            <div v-if="status.dataInfo" class="text-zinc-500">
                                数据：{{ status.dataInfo.cards || 0 }} 张角色卡 · {{ fmtBytes(status.dataInfo.bytes) }}
                            </div>
                            <div v-if="status.node" :class="status.node.level === 'ok' ? 'text-zinc-500' : 'text-rose-400'">
                                Node.js：{{ status.node.level === 'ok' ? ('v' + status.node.version) : status.node.message }}
                                <span v-if="status.node.level !== 'ok' && status.winget && status.winget.available" class="text-cyan-400">（可用 winget 一键安装）</span>
                            </div>
                        </div>
                        <div v-if="pathWarn" class="text-[11px] text-amber-400">⚠️ {{ pathWarn }}</div>
                    </section>

                    <!-- ② 操作 -->
                    <section class="rounded-lg border border-zinc-700 bg-zinc-950/60 p-3 space-y-2">
                        <div class="text-[11px] font-bold text-zinc-300">② 操作</div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <button v-if="!isInstalled" @click="doInstall" :disabled="busy || !dirPath"
                                    class="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold disabled:opacity-40 transition">⬇️ 一键安装</button>
                            <!-- 已是最新版本时按钮变灰且写明版本，不再出现「点完还能再点一次升级」的困惑 -->
                            <button v-else-if="hasUpdate === false" disabled
                                    class="px-3 py-1.5 rounded bg-zinc-700 text-emerald-300 text-[11px] font-bold opacity-70 cursor-default"
                                    title="已与官方最新版一致，无需升级">✅ 已是最新版{{ versionInfo.currentVersion ? ' v' + versionInfo.currentVersion : '' }}</button>
                            <button v-else @click="doUpdate" :disabled="busy || serverRunning || versionChecking"
                                    class="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-bold disabled:opacity-40 transition"
                                    :title="serverRunning ? '请先停止酒馆' : (hasUpdate === true ? '升级到 v' + versionInfo.latestVersion : '')">
                                <template v-if="versionChecking">⏳ 检查版本…</template>
                                <template v-else-if="hasUpdate === true">⬆️ 升级到 v{{ versionInfo.latestVersion }}</template>
                                <template v-else>⬆️ 升级</template>
                            </button>
                            <button v-if="isInstalled" @click="checkVersion" :disabled="busy || versionChecking"
                                    class="px-2 py-1.5 rounded border border-zinc-600 bg-zinc-800 text-zinc-400 text-[10px] hover:bg-zinc-700 disabled:opacity-40 transition"
                                    title="重新检查官方是否有新版本">🔄 检查更新</button>
                            <button v-if="isInstalled" @click="doInstallDeps" :disabled="busy"
                                    class="px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] disabled:opacity-40 transition">🔄 重装依赖</button>
                            <button v-if="isInstalled && !serverRunning" @click="doStart" :disabled="busy"
                                    class="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-40 transition">▶️ 启动</button>
                            <button v-if="serverRunning" @click="doStop" :disabled="busy"
                                    class="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold disabled:opacity-40 transition">⏹ 停止</button>
                            <button v-if="serverRunning && serverUrl" @click="openUrl"
                                    class="px-3 py-1.5 rounded border border-emerald-600 bg-zinc-800 text-emerald-300 text-[11px] hover:bg-emerald-600 hover:text-white transition">🌐 打开酒馆</button>
                            <button @click="doBackup" :disabled="busy || !isInstalled"
                                    class="px-3 py-1.5 rounded border border-amber-600 bg-zinc-800 text-amber-300 text-[11px] hover:bg-amber-600 hover:text-white disabled:opacity-40 transition">💾 备份数据</button>
                            <button @click="openUninstall" :disabled="busy || !isInstalled"
                                    class="px-3 py-1.5 rounded border border-rose-700 bg-zinc-800 text-rose-300 text-[11px] hover:bg-rose-700 hover:text-white disabled:opacity-40 transition">🧹 卸载…</button>
                        </div>
                        <div v-if="isInstalled && status && status.stRoot" class="text-[10px] text-zinc-600 font-mono break-all">
                            程序目录：{{ status.stRoot }}
                        </div>
                    </section>

                    <!-- ③ 进度与日志 -->
                    <section v-if="stageText || logs.length" class="rounded-lg border border-zinc-700 bg-zinc-950/60 p-3 space-y-2">
                        <div class="flex items-center justify-between">
                            <div class="text-[11px] font-bold text-zinc-300">③ 进度</div>
                            <button v-if="busy" @click="doCancel"
                                    class="px-2 py-0.5 rounded border border-zinc-600 text-zinc-300 text-[10px] hover:bg-zinc-700 transition">取消任务</button>
                        </div>
                        <div v-if="stageText" class="text-[11px] text-cyan-300">{{ stageText }}</div>
                        <div v-if="percent > 0" class="h-1.5 bg-zinc-800 rounded overflow-hidden">
                            <div class="h-full bg-cyan-500 transition-all duration-300" :style="{ width: percent + '%' }"></div>
                        </div>
                        <div ref="logBox" class="max-h-40 overflow-y-auto bg-black/50 rounded p-2 text-[10px] font-mono text-zinc-400 space-y-0.5 custom-scrollbar">
                            <div v-for="(l, i) in logs" :key="i" :class="l.type === 'stderr' ? 'text-amber-400' : (l.type === 'server' ? 'text-zinc-500' : '')">{{ l.text }}</div>
                        </div>
                    </section>
                </div>

                <!-- 卸载二级弹窗 -->
                <div v-if="uninstallOpen" class="absolute inset-0 z-[130] bg-black/80 flex items-center justify-center p-4">
                    <div class="bg-zinc-900 rounded-xl shadow-2xl w-full max-w-xl border border-rose-800/60 flex flex-col overflow-hidden">
                        <div class="px-4 py-3 bg-rose-950/60 border-b border-rose-900/60 text-rose-200 text-sm font-bold">⚠️ 卸载 · 请确认</div>
                        <div class="p-4 space-y-3 text-[11px] text-zinc-300 overflow-y-auto max-h-[60vh] custom-scrollbar">
                            <div class="space-y-1.5">
                                <label class="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" :value="1" v-model.number="uninstallMode" class="accent-cyan-600">
                                    <span>只删除酒馆（保留本软件）</span>
                                </label>
                                <label class="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" :value="2" v-model.number="uninstallMode" class="accent-rose-600">
                                    <span class="text-rose-300">彻底删除（含本软件与全部数据）</span>
                                </label>
                            </div>

                            <div v-if="invLoading" class="text-zinc-400">正在统计…</div>
                            <div v-else-if="inv" class="rounded border border-zinc-700 bg-zinc-950/60 p-2.5 space-y-1">
                                <div class="text-zinc-400 mb-1">将删除：</div>
                                <div v-for="(it, i) in inv.formatted" :key="i" class="flex justify-between gap-2">
                                    <span class="truncate">{{ it.label }}</span>
                                    <span class="font-mono text-zinc-500 shrink-0">{{ it.text }}</span>
                                </div>
                                <div class="border-t border-zinc-700 pt-1 mt-1 flex justify-between font-bold text-zinc-200">
                                    <span>合计</span><span class="font-mono">{{ inv.totalText }}</span>
                                </div>
                                <div class="text-[10px] text-amber-400 pt-1">
                                    其中：{{ inv.inventory.counts.cards }} 张角色卡 · {{ inv.inventory.counts.worldbooks }} 本世界书 · {{ inv.inventory.counts.chats }} 个会话
                                </div>
                            </div>

                            <label class="flex items-center gap-2 cursor-pointer text-amber-300">
                                <input type="checkbox" v-model="doBackupOnUninstall" class="accent-amber-600">
                                <span>删除前先打包备份 data/（强烈建议）</span>
                            </label>

                            <label v-if="uninstallMode === 2" class="flex items-center gap-2 cursor-pointer text-rose-300">
                                <input type="checkbox" v-model="ackIrreversible" class="accent-rose-600">
                                <span>我已知悉：此操作不可恢复</span>
                            </label>

                            <div class="space-y-1">
                                <div class="text-zinc-400">请输入 <span class="font-mono text-rose-300 font-bold">DELETE</span> 以确认：</div>
                                <input v-model="confirmText" placeholder="DELETE"
                                       class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] font-mono focus:outline-none focus:border-rose-600">
                            </div>
                        </div>
                        <div class="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
                            <button @click="uninstallOpen = false" :disabled="busy"
                                    class="px-3 py-1.5 rounded border border-zinc-600 text-zinc-300 text-[11px] hover:bg-zinc-700 disabled:opacity-40">取消</button>
                            <button @click="doUninstall" :disabled="!canUninstall || busy"
                                    class="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold disabled:opacity-40">确认卸载</button>
                        </div>
                    </div>
                </div>

                <!-- 卸载结果 -->
                <div v-if="reportOpen" class="absolute inset-0 z-[140] bg-black/85 flex items-center justify-center p-4">
                    <div class="bg-zinc-900 rounded-xl shadow-2xl w-full max-w-lg border border-zinc-700 flex flex-col overflow-hidden">
                        <div class="px-4 py-3 bg-zinc-950 border-b border-zinc-800 text-zinc-200 text-sm font-bold">卸载结果</div>
                        <div class="p-4 space-y-1 text-[11px] max-h-[55vh] overflow-y-auto custom-scrollbar">
                            <div v-for="(r, i) in uninstallReport" :key="i" class="flex gap-2">
                                <span class="shrink-0">{{ r.status === 'ok' ? '✅' : (r.status === 'skip' ? '⚠️' : (r.status === 'delegated' ? '↗️' : '❌')) }}</span>
                                <span class="text-zinc-400 shrink-0">{{ r.item }}：</span>
                                <span :class="r.status === 'fail' ? 'text-rose-400' : 'text-zinc-300'" class="break-all">{{ r.detail }}</span>
                            </div>
                        </div>
                        <div class="px-4 py-3 border-t border-zinc-800 flex justify-end">
                            <button @click="reportOpen = false" class="px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px]">关闭</button>
                        </div>
                    </div>
                </div>
        </div>
    </div>
</template>

<script>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { formatBytes } from '../utils/stInstallCore.js';

export default {
    name: 'StInstallModal',
    props: {
        show: { type: Boolean, default: false },
        // App.vue 注入：原生目录选择
        selectFolder: { type: Function, default: null },
        // App.vue 注入：提示
        notify: { type: Function, default: null },
    },
    // ⚠️ 不能用 'close' 作事件名：它和浏览器原生 close 事件同名，
    //    在某些结构下会被当成原生事件处理而不触发父组件监听（实测点「关闭」无反应）。
    emits: ['st-close'],
    setup(props, { emit }) {
        const dirPath = ref('');
        const status = ref(null);
        const checking = ref(false);
        const busy = ref(false);
        const stageText = ref('');
        const percent = ref(0);
        const logs = ref([]);
        const logBox = ref(null);
        const serverRunning = ref(false);
        const serverUrl = ref('');
        const pathWarn = ref('');

        // 卸载
        const uninstallOpen = ref(false);
        const uninstallMode = ref(1);
        const doBackupOnUninstall = ref(true);
        const ackIrreversible = ref(false);
        const confirmText = ref('');
        const inv = ref(null);
        const invLoading = ref(false);
        const reportOpen = ref(false);
        const uninstallReport = ref([]);

        // 自动查找本地已装酒馆
        const scanning = ref(false);
        const scanDone = ref(false);
        const scanResults = ref([]);
        const scanTruncated = ref(false);

        // 环境体检
        const diagnosing = ref(false);
        const diagChecks = ref([]);
        const diagSummary = ref({ ok: 0, warn: 0, error: 0, total: 0, verdict: '' });

        // 版本检查（本地 package.json vs 远程最新）
        const versionChecking = ref(false);
        const versionInfo = ref({ currentVersion: '', latestVersion: '', hasUpdate: null, source: '' });
        /** null = 未知（检查失败/未检查）；true/false = 明确结论 */
        const hasUpdate = computed(() => versionInfo.value.hasUpdate);

        let unsub = null;
        let pollTimer = null;

        const isInstalled = computed(() => {
            const s = status.value && status.value.state;
            return s === 'ready' || s === 'running' || s === 'incomplete';
        });
        const canUninstall = computed(() => {
            if (confirmText.value.trim() !== 'DELETE') return false;
            if (uninstallMode.value === 2 && !ackIrreversible.value) return false;
            return true;
        });

        const fmtBytes = (b) => formatBytes(b);

        const pushLog = (type, text) => {
            logs.value.push({ type, text });
            if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500);
            nextTick(() => {
                try { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; } catch (e) { /* 忽略 */ }
            });
        };

        const toast = (msg, level) => {
            if (props.notify) { try { props.notify(msg, level); } catch (e) { /* 忽略 */ } }
            else console.log('[st-install]', msg);
        };

        // ==================== 检测 ====================
        const recheck = async () => {
            if (!dirPath.value) return;
            checking.value = true;
            pathWarn.value = '';
            try {
                const r = await window.electronAPI.st.inspect(dirPath.value);
                if (r && r.success) {
                    status.value = r;
                    serverRunning.value = r.state === 'running';
                    serverUrl.value = (r.server && r.server.url) || '';
                } else {
                    status.value = null;
                    pushLog('stderr', (r && r.error) || '检测失败');
                }

                // 路径校验警告。
                // ⚠️ 注意：「该目录已安装酒馆，请改用『升级』或换一个目录」这句是给
                //    **准备新装** 的场景写的。当前目录本来就是已安装的酒馆时，
                //    用户要的就是管理它，再提示「请换一个目录」纯属添乱 —— 一律不显示。
                const chk = await window.electronAPI.st.checkPath(dirPath.value);
                if (chk && chk.success && chk.valid && !chk.valid.ok) {
                    const installedState = !!(r && r.success && ['ready', 'running', 'incomplete'].includes(r.state));
                    const sameSt = installedState
                        && chk.stRoot
                        && String(chk.stRoot).toLowerCase() === String(r.stRoot || '').toLowerCase();
                    if (!sameSt) pathWarn.value = chk.valid.reason;
                }

                // 已安装时顺带查一次「是否真的该升级」——不 await，不拖慢检测；
                // 查不到就保持按钮原样（hasUpdate=null），不阻断用户
                if (r && r.success && ['ready', 'running', 'incomplete'].includes(r.state)) {
                    checkVersion();
                }
            } finally {
                checking.value = false;
            }
        };

        const pickDir = async () => {
            // 不再静默 return：props 缺失是「点了没反应」的典型成因（AR-77），必须留痕
            if (!props.selectFolder) {
                toast('目录选择器未接入（App.vue 未注入 selectFolder），请反馈此问题', 'error');
                pushLog('stderr', '❌ 目录选择器未接入：props.selectFolder 为空');
                return;
            }
            let dir = '';
            try {
                dir = await props.selectFolder();
            } catch (e) {
                toast('打开目录选择器失败：' + ((e && e.message) || e), 'error');
                return;
            }
            if (!dir) return;   // 用户取消，静默即可
            dirPath.value = dir;
            try { localStorage.setItem('jsTavern_stInstallDir', dir); } catch (e) { /* 忽略 */ }
            await recheck();
        };

        /**
         * 自动查找本机已安装的酒馆。
         *
         * 主进程按「盘根 → 二级 → 用户目录」分层扫描并受时间预算约束；
         * 这里只负责触发、展示结果、以及在只找到一个时**自动选中**（少让用户点一次）。
         */
        const scanLocal = async () => {
            if (scanning.value) return;
            scanning.value = true;
            scanDone.value = false;
            scanResults.value = [];
            scanTruncated.value = false;
            try {
                let r = await window.electronAPI.st.scan({ deep: false });
                if (!r || !r.success) {
                    toast('扫描失败：' + ((r && r.error) || '未知错误'), 'error');
                    pushLog('stderr', '❌ 扫描本机酒馆失败：' + ((r && r.error) || '未知错误'));
                    return;
                }
                let items = Array.isArray(r.items) ? r.items : [];
                // 常规扫描没找到 → 自动再深一层扫地（用户可能把酒馆来了好几层）
                if (items.length === 0 && !r.hitTimeLimit) {
                    pushLog('info', '常规位置未找到，正在深度扫描…');
                    const d = await window.electronAPI.st.scan({ deep: true });
                    if (d && d.success) { r = d; items = Array.isArray(d.items) ? d.items : []; }
                }
                scanResults.value = items;
                scanTruncated.value = !!(r.hitTimeLimit);   // 只有“时间用完”才可能遗漏
                scanDone.value = true;
                pushLog('info', `扫描完成：检查 ${r.scannedDirs || 0} 个目录，用时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s，找到 ${items.length} 个酒馆`);
                if (items.length === 1) {
                    // 只有一个就直接选中，省一次点击
                    await useScanResult(items[0], true);
                } else if (items.length > 1) {
                    toast(`找到 ${items.length} 个已安装的酒馆，请在上面列表里选一个`, 'info');
                } else {
                    toast('本机未找到已安装的酒馆', 'info');
                }
            } catch (e) {
                toast('扫描异常：' + ((e && e.message) || e), 'error');
                pushLog('stderr', '❌ 扫描异常：' + ((e && e.message) || e));
            } finally {
                scanning.value = false;
            }
        };

        /**
         * 检查是否有新版本。
         *
         * 背景（用户实测吐槽）：「本地已经是最新版本了点击升级后怎么还要升升级」——
         * 原先 UI 只要装了酒馆就永远显示「⬆️ 升级」，升级完也还是那个按钮，
         * 用户无从得知到底升没升到最新。现在把真实版本差异摆出来：
         *   有新版 → 「⬆️ 升级到 v1.19.0」
         *   已最新 → 「✅ 已是最新版 v1.19.0」（禁用）
         *   查不到 → 保持「⬆️ 升级」可点（不阻断用户）
         */
        const checkVersion = async () => {
            if (!dirPath.value || versionChecking.value) return;
            versionChecking.value = true;
            try {
                const r = await window.electronAPI.st.checkUpdate({ dirPath: dirPath.value });
                if (r && r.success) {
                    versionInfo.value = {
                        currentVersion: r.currentVersion || '',
                        latestVersion: r.latestVersion || '',
                        hasUpdate: typeof r.hasUpdate === 'boolean' ? r.hasUpdate : null,
                        source: r.source || '',
                    };
                    if (r.hasUpdate === true) {
                        pushLog('info', `发现新版本：v${r.currentVersion} → v${r.latestVersion}`);
                    } else if (r.hasUpdate === false) {
                        pushLog('info', `已是最新版：v${r.currentVersion}`);
                    } else {
                        pushLog('warn', '版本检查：无法获取远程版本号（可手动点「升级」重试）');
                    }
                } else {
                    // 检查失败不阻断，保持「升级」可点
                    versionInfo.value = { currentVersion: '', latestVersion: '', hasUpdate: null, source: '' };
                }
            } catch (e) {
                versionInfo.value = { currentVersion: '', latestVersion: '', hasUpdate: null, source: '' };
            } finally {
                versionChecking.value = false;
            }
        };

        /** 采用某个扫描结果作为当前目录 */
        const useScanResult = async (item, silent = false) => {
            if (!item || !item.dir) return;
            dirPath.value = item.dir;
            try { localStorage.setItem('jsTavern_stInstallDir', item.dir); } catch (e) { /* 忽略 */ }
            if (!silent) toast('已选用：' + item.dir, 'success');
            await recheck();
        };

        /**
         * 环境体检：一次性查出「装完跑不起来」的常见成因，
         * 并把每项的详情与修复建议直接列在弹窗里。
         */
        const runDiagnose = async () => {
            if (!dirPath.value || diagnosing.value) return;
            diagnosing.value = true;
            diagChecks.value = [];
            try {
                const r = await window.electronAPI.st.diagnose({ dirPath: dirPath.value });
                if (!r || !r.success) {
                    toast('体检失败：' + ((r && r.error) || '未知错误'), 'error');
                    pushLog('stderr', '❌ 体检失败：' + ((r && r.error) || '未知错误'));
                    return;
                }
                diagChecks.value = Array.isArray(r.checks) ? r.checks : [];
                diagSummary.value = r.summary || { ok: 0, warn: 0, error: 0, total: 0, verdict: '' };
                pushLog('info', `🩺 体检完成：${diagSummary.value.verdict}（用时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s）`);
                if (diagSummary.value.error > 0) {
                    toast(`体检发现 ${diagSummary.value.error} 个必须修复的问题`, 'error');
                } else if (diagSummary.value.warn > 0) {
                    toast(`体检通过，有 ${diagSummary.value.warn} 项建议留意`, 'info');
                } else {
                    toast('🩺 体检通过：一切正常', 'success');
                }
            } catch (e) {
                toast('体检异常：' + ((e && e.message) || e), 'error');
                pushLog('stderr', '❌ 体检异常：' + ((e && e.message) || e));
            } finally {
                diagnosing.value = false;
            }
        };

        const openFolder = async () => {
            if (!dirPath.value) return;
            await window.electronAPI.st.openFolder(dirPath.value);
        };

        // ==================== 进度订阅 ====================
        const ensureSubscribed = () => {
            if (unsub) return;
            unsub = window.electronAPI.st.onProgress((p) => {
                if (!p) return;
                if (p.type === 'stage') { stageText.value = p.text || ''; }
                else if (p.type === 'progress') { if (typeof p.percent === 'number') percent.value = p.percent; }
                else if (p.type === 'log' || p.type === 'stdout' || p.type === 'stderr' || p.type === 'server') {
                    pushLog(p.type, p.text || '');
                } else if (p.type === 'server-exit') {
                    serverRunning.value = false;
                    serverUrl.value = '';
                    pushLog('stderr', `酒馆进程已退出（code=${p.code}）${p.error ? '：' + p.error : ''}`);
                }
            });
        };

        const resetProgress = () => { stageText.value = ''; percent.value = 0; };

        // ==================== 操作 ====================
        const doInstall = async () => {
            if (!dirPath.value) return;
            busy.value = true; logs.value = []; resetProgress();
            try {
                const r = await window.electronAPI.st.install({ dirPath: dirPath.value, taskId: 'install-' + Date.now() });
                if (r.success) {
                    toast('酒馆安装完成', 'success');
                    pushLog('stdout', `✅ 安装完成，版本 v${r.version || '?'}`);
                } else {
                    toast('安装失败：' + r.error, 'error');
                    pushLog('stderr', '❌ ' + r.error);
                    if (r.needManualNode && r.downloadUrl) {
                        pushLog('stderr', `请手动安装 Node.js：${r.downloadUrl}`);
                    }
                }
                await recheck();
            } finally { busy.value = false; }
        };

        const doInstallDeps = async () => {
            busy.value = true; logs.value = []; resetProgress();
            try {
                const r = await window.electronAPI.st.installDeps({ dirPath: dirPath.value, taskId: 'deps-' + Date.now() });
                if (r.success) { toast('依赖安装完成', 'success'); }
                else { toast('依赖安装失败：' + r.error, 'error'); pushLog('stderr', '❌ ' + r.error); }
                await recheck();
            } finally { busy.value = false; }
        };

        const doUpdate = async () => {
            // ⚠️ 升级会真的改动用户酒馆仓库（git pull / zip 覆盖），必须先确认。
            //    另外「升级」按钮与「一键安装」处在同一位置，DOM 变化后极易误触，
            //    没有确认就会直接拉代码 —— 实测踩过（测试脚本点击穿透误触发）。
            const ok = typeof window.confirm === 'function'
                ? window.confirm(
                    '确认升级这个酒馆？\n\n'
                    + '目录：' + dirPath.value + '\n\n'
                    + '· 会从官方仓库拉取最新代码\n'
                    + '· 本地改动（含插件自动注入的改动）会先自动备份，升级后尽量自动保留\n'
                    + '· 角色卡 / 世界书 / 聊天记录不会被删除',
                )
                : true;
            if (!ok) return;
            busy.value = true; logs.value = []; resetProgress();
            try {
                const r = await window.electronAPI.st.update({ dirPath: dirPath.value, taskId: 'update-' + Date.now() });
                if (r.success) {
                    toast(r.restoreNote ? ('升级完成：' + r.restoreNote) : '升级完成', 'success');
                    if (r.backup) pushLog('stdout', '已备份到：' + r.backup);
                    if (r.restoreNote) pushLog('stdout', r.restoreNote);
                    if (r.backupDir) pushLog('stdout', '本地改动备份目录：' + r.backupDir);
                } else {
                    toast('升级失败：' + r.error, 'error');
                    pushLog('stderr', '❌ ' + r.error);
                }
                await recheck();
                // 升级完必须重新比对版本，否则按钮还是「升级」，用户会以为没升成功
                await checkVersion();
            } finally { busy.value = false; }
        };

        const doStart = async () => {
            busy.value = true;
            try {
                const r = await window.electronAPI.st.start({ dirPath: dirPath.value });
                if (r.success) {
                    serverRunning.value = true;
                    serverUrl.value = r.url || '';
                    toast('酒馆已启动：' + (r.url || ''), 'success');
                    pushLog('stdout', '🌐 ' + (r.url || ''));
                } else {
                    toast('启动失败：' + r.error, 'error');
                    pushLog('stderr', '❌ ' + r.error);
                }
                await recheck();
            } finally { busy.value = false; }
        };

        const doStop = async () => {
            busy.value = true;
            try {
                const r = await window.electronAPI.st.stop();
                if (r.success) { toast('已停止', 'success'); }
                await recheck();
            } finally { busy.value = false; }
        };

        const openUrl = async () => {
            if (serverUrl.value) await window.electronAPI.st.openUrl(serverUrl.value);
        };

        const doBackup = async () => {
            busy.value = true;
            try {
                const r = await window.electronAPI.st.backup({ dirPath: dirPath.value, tag: 'manual' });
                if (r.success) {
                    toast(r.skipped ? '没有 data/ 目录，无需备份' : ('备份完成：' + r.path), 'success');
                    if (r.path) pushLog('stdout', '💾 ' + r.path);
                } else { toast('备份失败：' + r.error, 'error'); }
            } finally { busy.value = false; }
        };

        const doCancel = async () => {
            await window.electronAPI.st.cancel();
        };

        // ==================== 卸载 ====================
        const openUninstall = async () => {
            uninstallMode.value = 1;
            confirmText.value = '';
            ackIrreversible.value = false;
            doBackupOnUninstall.value = true;
            uninstallOpen.value = true;
            await loadInventory();
        };

        const loadInventory = async () => {
            invLoading.value = true;
            try {
                const r = await window.electronAPI.st.inventory({ dirPath: dirPath.value, mode: uninstallMode.value });
                inv.value = r.success ? r : null;
                if (!r.success) pushLog('stderr', r.error || '统计失败');
            } finally { invLoading.value = false; }
        };

        watch(uninstallMode, () => { if (uninstallOpen.value) loadInventory(); });

        const doUninstall = async () => {
            if (!canUninstall.value) return;
            busy.value = true;
            try {
                const r = await window.electronAPI.st.uninstall({
                    dirPath: dirPath.value,
                    mode: uninstallMode.value,
                    confirmText: confirmText.value.trim(),
                    doBackup: doBackupOnUninstall.value,
                });
                uninstallOpen.value = false;
                if (r.success) {
                    uninstallReport.value = r.report || [];
                    reportOpen.value = true;
                    status.value = null;
                    await recheck();
                } else {
                    toast('卸载失败：' + r.error, 'error');
                    pushLog('stderr', '❌ ' + r.error);
                }
            } finally { busy.value = false; }
        };

        // ==================== 生命周期 ====================
        const close = () => { if (!busy.value) emit('st-close'); };

        watch(() => props.show, async (v) => {
            if (!v) {
                if (unsub) { try { unsub(); } catch (e) { /* 忽略 */ } unsub = null; }
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                return;
            }
            ensureSubscribed();
            if (!dirPath.value) {
                try {
                    const saved = localStorage.getItem('jsTavern_stInstallDir');
                    if (saved) dirPath.value = saved;
                } catch (e) { /* 忽略 */ }
            }
            if (dirPath.value) await recheck();
            else {
                // 没记过目录：至少把 Node 状态显示出来
                const r = await window.electronAPI.st.nodeStatus();
                if (r && r.success) status.value = { state: 'notFound', node: r.node, winget: r.winget, dataInfo: null };
                // 自动找一下本机装没装（不 await，避免阻塞弹窗；进度实时走日志区）
                if (!scanning.value && !scanDone.value) scanLocal();
            }
            // 定时刷新运行状态
            pollTimer = setInterval(async () => {
                try {
                    const s = await window.electronAPI.st.status();
                    if (s && s.success) {
                        serverRunning.value = !!s.running;
                        serverUrl.value = s.url || '';
                    }
                } catch (e) { /* 忽略 */ }
            }, 3000);
        });

        onBeforeUnmount(() => {
            if (unsub) { try { unsub(); } catch (e) { /* 忽略 */ } }
            if (pollTimer) clearInterval(pollTimer);
        });

        return {
            dirPath, status, checking, busy, stageText, percent, logs, logBox,
            serverRunning, serverUrl, pathWarn,
            isInstalled, uninstallOpen, uninstallMode, doBackupOnUninstall,
            ackIrreversible, confirmText, inv, invLoading, canUninstall,
            reportOpen, uninstallReport,
            // 自动查找本地已装酒馆
            scanning, scanDone, scanResults, scanTruncated, scanLocal, useScanResult,
            // 环境体检
            diagnosing, diagChecks, diagSummary, runDiagnose,
            // 版本检查
            versionChecking, versionInfo, hasUpdate, checkVersion,
            fmtBytes,
            pickDir, recheck, openFolder,
            doInstall, doInstallDeps, doUpdate, doStart, doStop, doCancel, openUrl, doBackup,
            openUninstall, doUninstall, close,
        };
    },
};
</script>
