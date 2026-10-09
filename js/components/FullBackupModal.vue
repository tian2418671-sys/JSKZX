<!--
  📦 整库冷备（一键全量快照）— 子组件（2026-10-03 · v2.3.6 五功能之一）

  定位：配置备份 / 单文件快照之上的「整库时间点」——把当前库整个目录树冷备到指定目录，
        保留最近 N 份自动轮转，可浏览 / 恢复 / 删除。
  规格：docs/规格与计划/功能规格/整库冷备-实现规格.md（主进程实现见 main/fullBackup.js）
  ⚠️ 弹窗必须顶层挂载（项目历史坑：fixed 定位在子组件里会被裁切）—— 本组件只被 App.vue 挂载。
  ⚠️ 恢复是**写操作**：一律在隔离副本库上演练；本组件只负责发起 + 显示，防呆全在主进程。
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">

                <!-- 头部 -->
                <div class="px-5 py-3.5 bg-gray-900 text-white border-b border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        📦 整库冷备
                        <span class="text-[10px] font-normal text-gray-300">把当前库整个目录树快照到指定目录（可放备份盘）</span>
                    </h3>
                    <button @click="$emit('close')" :disabled="busy" class="text-gray-400 hover:text-white text-sm disabled:opacity-40">✕ 关闭</button>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 custom-scrollbar">

                    <!-- 配置区 -->
                    <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-[11px] font-bold text-gray-700 shrink-0">冷备目录</span>
                            <input :value="backupDir" readonly placeholder="（未选择 · 建议指向其它硬盘）"
                                   class="flex-1 min-w-[220px] bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-gray-700 focus:outline-none">
                            <button @click="pickDir" :disabled="busy"
                                    class="px-2.5 py-1 rounded border border-indigo-300 bg-white text-indigo-700 text-[11px] hover:bg-indigo-50 disabled:opacity-50 transition shrink-0">选择目录…</button>
                            <button v-if="backupDir" @click="openDir" :disabled="busy"
                                    class="px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-600 text-[11px] hover:bg-gray-100 disabled:opacity-50 transition shrink-0">打开</button>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-[11px] font-bold text-gray-700 shrink-0">保留份数</span>
                            <input type="range" min="1" max="10" :value="keep" :disabled="busy"
                                   @input="$emit('update:keep', parseInt($event.target.value))" class="w-36 accent-indigo-600">
                            <span class="text-[11px] font-bold text-indigo-700">{{ keep }} 份</span>
                            <span class="text-[9px] text-gray-500">超出后**最旧**一份进系统回收站（不是硬删）；默认 3</span>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-[11px] font-bold text-gray-700 shrink-0">当前库</span>
                            <span class="text-[11px] text-gray-600 break-all">{{ libraryPath || '（未打开库）' }}</span>
                        </div>
                        <div class="flex items-center gap-2 pt-0.5">
                            <button @click="startBackup" :disabled="busy || !libraryPath || !backupDir"
                                    :title="!backupDir ? '请先选择冷备目录' : (!libraryPath ? '当前未打开库' : '开始整库冷备（逐文件复制，可取消）')"
                                    class="px-3.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold disabled:bg-gray-300 disabled:cursor-not-allowed transition">📦 立即冷备</button>
                            <button v-if="busy" @click="cancelBackup"
                                    class="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-bold transition">⏹ 取消</button>
                            <span v-if="!backupDir" class="text-[10px] text-amber-600">⚠️ 先选冷备目录（建议与库**不同盘**）</span>
                        </div>
                    </div>

                    <!-- 进度 -->
                    <div v-if="busy || progress.phase" class="rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-1.5">
                        <div class="flex items-center justify-between text-[11px] text-gray-700">
                            <span class="font-bold text-indigo-700">{{ phaseLabel }}</span>
                            <span>{{ fmtNum(progress.done) }} / {{ fmtNum(progress.total) }} 文件 · {{ fmtBytes(progress.bytesDone) }} / {{ fmtBytes(progress.bytesTotal) }}</span>
                        </div>
                        <div class="w-full bg-white rounded-full h-2 overflow-hidden border border-indigo-200">
                            <div class="bg-indigo-500 h-2 transition-all" :style="{ width: pctWidth + '%' }"></div>
                        </div>
                        <p class="text-[9px] text-gray-500">{{ busy ? '执行中…（可点「⏹ 取消」；半成品会被自动清理）' : '已完成' }}</p>
                    </div>

                    <!-- 提示 / 错误 -->
                    <p v-if="msg" class="text-[11px]" :class="/失败|错误|不足|拒绝|过长|不可用/.test(msg) ? 'text-rose-700' : 'text-emerald-700'">{{ msg }}</p>

                    <!-- 备份列表 -->
                    <div class="space-y-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-[11px] font-bold text-gray-700">已有冷备（{{ items.length }} 份）</span>
                            <button @click="refresh" :disabled="busy || !backupDir"
                                    class="text-[10px] px-1.5 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 disabled:opacity-40 transition">⟳ 刷新</button>
                        </div>
                        <p v-if="!backupDir" class="text-[11px] text-gray-500">选择冷备目录后，这里会列出该目录下的全部冷备。</p>
                        <p v-else-if="!items.length" class="text-[11px] text-gray-500">该目录下还没有冷备。点「📦 立即冷备」创建第一份。</p>
                        <div v-for="it in items" :key="it.dir"
                             class="rounded-lg border border-gray-200 bg-white p-2.5 flex items-center gap-2 flex-wrap">
                            <div class="flex-1 min-w-[200px]">
                                <div class="text-[11px] font-bold text-gray-700 break-all">{{ it.name }}</div>
                                <div class="text-[9px] text-gray-500">
                                    {{ fmtTime(it.createdAt) }} · {{ fmtNum(it.fileCount) }} 文件 · {{ fmtBytes(it.bytes) }}
                                    <span v-if="it.appVersion" class="ml-1">· 应用 {{ it.appVersion }}</span>
                                </div>
                                <div class="text-[9px] text-gray-400 break-all">源库：{{ it.libraryPath || '—' }}</div>
                            </div>
                            <button @click="restore(it)" :disabled="busy"
                                    class="px-2 py-1 rounded border border-amber-300 bg-white text-amber-700 text-[10px] hover:bg-amber-50 disabled:opacity-40 transition shrink-0">♻️ 恢复</button>
                            <button @click="remove(it)" :disabled="busy"
                                    class="px-2 py-1 rounded border border-gray-300 bg-white text-rose-600 text-[10px] hover:border-rose-300 disabled:opacity-40 transition shrink-0">🗑 删除</button>
                        </div>
                    </div>

                    <p class="text-[9px] text-gray-500 leading-relaxed">
                        ⚠️ 恢复是**写操作**：会先把当前库**原地改名**为 <code class="px-1 rounded bg-gray-100 border border-gray-200">库名_恢复前_时间戳</code>，
                        再把备份复制回原路径（旧库体不会丢，确认无误后可自行删除）。演练请用副本库。
                        冷备不含隐藏目录（<code class="px-1 rounded bg-gray-100 border border-gray-200">.bak_history</code> 历史快照等）与 <code class="px-1 rounded bg-gray-100 border border-gray-200">*.tmp</code>。
                    </p>
                </div>

                <!-- 底部 -->
                <div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
                    <span class="text-[10px] text-gray-500">逐文件复制 · 可取消 · 完成后自动轮转</span>
                    <button @click="$emit('close')" :disabled="busy"
                            class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-50 transition">知道了</button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
/**
 * 只做「发起 + 显示」：所有防呆（目标嵌套 / 空间不足 / 并发 / 备份中禁恢复）在主进程，
 * 本组件不重复实现，也**不信任**自己算出来的结果。
 */
export default {
    name: 'FullBackupModal',
    props: {
        show: { type: Boolean, default: false },
        libraryPath: { type: String, default: '' },
        backupDir: { type: String, default: '' },
        keep: { type: Number, default: 3 },
        /** 二次确认（App 注入：主进程 showMessageBox 包装，避免 window.confirm 在 Electron 下的坑） */
        confirm: { type: Function, default: null },
        /** 原生提示（App 注入） */
        alert: { type: Function, default: null }
    },
    emits: ['close', 'update:backupDir', 'update:keep', 'restored'],
    data() {
        return {
            busy: false,
            items: [],
            msg: '',
            progress: { phase: '', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 },
            _offProgress: null
        };
    },
    computed: {
        phaseLabel() {
            const m = { scan: '🔍 正在列文件…', copy: '📦 正在复制…', 'restore-rename': '♻️ 正在改名当前库…', 'restore-copy': '♻️ 正在复制备份内容…', done: '✅ 完成' };
            return m[this.progress.phase] || '⏳ 执行中…';
        },
        pctWidth() {
            const t = Number(this.progress.total) || 0;
            if (!t) return this.progress.phase === 'scan' ? 3 : 0;
            return Math.min(100, Math.round((Number(this.progress.done) || 0) / t * 100));
        }
    },
    watch: {
        show(v) {
            if (v) { this.msg = ''; this.refresh(); this.bindProgress(); }
        },
        backupDir() { if (this.show) this.refresh(); }
    },
    mounted() { this.bindProgress(); },
    beforeUnmount() { /* 事件订阅由 preload 的 on 通道持有；组件卸载后回调里已做 show 判断 */ },
    methods: {
        api() { return (window.electronAPI && window.electronAPI.fullBackup) || null; },
        bindProgress() {
            if (this._offProgress) return;
            const api = this.api();
            if (!api || typeof api.onProgress !== 'function') return;
            api.onProgress((p) => {
                if (!this.show) return;
                this.progress = Object.assign({}, this.progress, p || {});
            });
            this._offProgress = true;
        },
        fmtNum(n) { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString('en-US') : '0'; },
        fmtBytes(n) {
            const v = Number(n) || 0;
            if (v < 1024) return v + ' B';
            if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
            if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
            return (v / 1073741824).toFixed(2) + ' GB';
        },
        fmtTime(iso) {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return String(iso || '—');
            const p = (x) => String(x).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        },
        async pickDir() {
            try {
                const dir = await window.electronAPI.selectGenericFolder();
                if (dir) { this.$emit('update:backupDir', dir); this.msg = ''; }
            } catch (e) { this.msg = '选择目录失败：' + ((e && e.message) || String(e)); }
        },
        async openDir() {
            // 走专用入口（`system:openPath` 有白名单，冷备目录通常不在其中）
            try {
                const r = await window.electronAPI.fullBackup.openDir(this.backupDir);
                if (!r || !r.ok) this.msg = '打开目录失败：' + ((r && r.error) || '未知错误');
            } catch (e) { this.msg = '打开目录失败：' + ((e && e.message) || String(e)); }
        },
        async refresh() {
            const api = this.api();
            if (!api || !this.backupDir) { this.items = []; return; }
            const r = await api.list({ destRoot: this.backupDir });
            this.items = (r && r.items) || [];
        },
        async startBackup() {
            const api = this.api();
            if (!api) { this.msg = '当前环境不支持冷备（preload 未暴露 fullBackup）'; return; }
            this.busy = true; this.msg = '';
            this.progress = { phase: 'scan', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 };
            try {
                const r = await api.create({ libraryPath: this.libraryPath, destRoot: this.backupDir, keep: this.keep });
                if (r && r.ok) {
                    this.msg = `✅ 冷备完成：${this.fmtNum(r.fileCount)} 个文件 · ${this.fmtBytes(r.bytes)}${r.trashed && r.trashed.length ? ` · 轮转移走 ${r.trashed.length} 份` : ''}`;
                    await this.refresh();
                } else if (r && r.canceled) {
                    this.msg = '已取消（半成品已清理）';
                    await this.refresh();
                } else {
                    this.msg = '冷备失败：' + ((r && r.error) || '未知错误');
                }
            } catch (e) {
                this.msg = '冷备失败：' + ((e && e.message) || String(e));
            } finally {
                this.busy = false;
            }
        },
        async cancelBackup() {
            const api = this.api();
            if (!api) return;
            const r = await api.cancel();
            this.msg = (r && r.ok) ? '已请求取消…（等当前文件写完）' : '当前没有进行中的任务';
        },
        async restore(it) {
            const ask = this.confirm || ((m) => Promise.resolve(true));
            const ok = await ask(
                `确定用这份冷备恢复库吗？\n\n备份：${it.name}\n源库：${it.libraryPath || '—'}\n\n` +
                '恢复流程：当前库先改名为「库名_恢复前_时间戳」（不会丢），再把备份复制回原路径。'
            );
            if (!ok) return;
            this.busy = true; this.msg = '';
            try {
                const r = await this.api().restore({ backupDir: it.dir, libraryPath: this.libraryPath });
                if (r && r.ok) {
                    this.msg = `✅ 已恢复 ${this.fmtNum(r.restored)} 个文件${r.safeCopyPath ? `（旧库保留在 ${r.safeCopyPath}）` : ''}`;
                    this.$emit('restored', r.safeCopyPath || '');
                } else {
                    this.msg = '恢复失败：' + ((r && r.error) || '未知错误');
                }
            } catch (e) {
                this.msg = '恢复失败：' + ((e && e.message) || String(e));
            } finally {
                this.busy = false;
            }
        },
        async remove(it) {
            const ask = this.confirm || ((m) => Promise.resolve(true));
            const ok = await ask(`删除这份冷备？（会移入系统回收站，可从回收站还原）\n\n${it.name}`);
            if (!ok) return;
            const r = await this.api().remove({ backupDir: it.dir });
            if (r && r.ok) { this.msg = '已移入回收站：' + it.name; await this.refresh(); } else this.msg = '删除失败：' + ((r && r.error) || '未知错误');
        }
    }
};
</script>
