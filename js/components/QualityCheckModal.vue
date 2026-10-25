<!--
  🧪 一键质检流水线（v2.3.6 五功能之四）— 子组件

  定位：把散落的**只读**检查能力串成一条流水线，出一份综合报告（可复制 / 导出 Markdown）。
  ⚠️ 全流程只读：不动库、不删文件、不保存配置（规格 §五「只读承诺」）。
  ⚠️ 弹窗必须**顶层挂载**（项目历史坑：fixed 定位在子组件里会被裁切）—— 本组件只被 App.vue 挂载。
  规格：docs/规格与计划/功能规格/一键质检流水线-实现规格.md
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">

                <!-- 头部 -->
                <div class="px-5 py-3.5 bg-gray-900 text-white border-b border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🧪 一键质检
                        <span class="text-[10px] font-normal text-gray-300">只读检查 · 不动库 · 不删文件</span>
                    </h3>
                    <div class="flex items-center gap-2 shrink-0">
                        <button @click="activeTab = 'help'"
                                class="px-2.5 py-1 rounded text-[11px] transition"
                                :class="activeTab === 'help' ? 'bg-indigo-600 text-white' : 'bg-gray-700 hover:bg-indigo-600 text-gray-200 hover:text-white'"
                                title="这是什么？怎么用？点开看说明与教程">❓ 说明</button>
                        <button @click="$emit('close')" :disabled="running" class="text-gray-400 hover:text-white text-sm disabled:opacity-40">✕ 关闭</button>
                    </div>
                </div>

                <div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 custom-scrollbar">

                    <!-- 页签栏（📊 结构画像 = 上游 Q2 裁决：并入本弹窗，不建独立弹窗） -->
                    <div class="flex items-center gap-1 border-b border-gray-200 -mt-1">
                        <button @click="activeTab = 'list'"
                                class="px-3 py-1.5 text-[11px] font-bold rounded-t transition"
                                :class="activeTab === 'list' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'">📋 巡检清单</button>
                        <button @click="activeTab = 'portrait'"
                                class="px-3 py-1.5 text-[11px] font-bold rounded-t transition"
                                :class="activeTab === 'portrait' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'">📊 结构画像</button>
                        <button @click="activeTab = 'help'"
                                class="px-3 py-1.5 text-[11px] font-bold rounded-t transition"
                                :class="activeTab === 'help' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'">❓ 使用说明</button>
                        <span v-if="activeTab === 'portrait'" class="ml-auto text-[9px] text-gray-400">只读诊断 · 不修改任何内容</span>
                    </div>

                    <!-- ==================== ❓ 使用说明（教程 · 只读介绍） ==================== -->
                    <div v-if="activeTab === 'help'" class="space-y-3 text-[11px] text-gray-700 leading-relaxed">

                        <div class="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                            <p class="font-bold text-[12px] text-indigo-800 mb-1">🧪 一键质检是做什么的？</p>
                            <p>把散落在各处的<strong>只读检查</strong>串成一条流水线，跑完给你一份综合报告。</p>
                            <p class="mt-1.5 text-[10px] text-indigo-700">
                                ⚠️ <strong>全程只读</strong>：不修改卡片、不删除文件、不改任何设置。放心点。
                                报告可以「复制」或「导出 Markdown」，方便存档或发给别人看。
                            </p>
                        </div>

                        <div class="rounded-lg border border-gray-200 bg-white p-3">
                            <p class="font-bold text-[12px] text-gray-800 mb-2">📋 巡检清单：五个检查项</p>
                            <p class="text-[10px] text-gray-500 mb-2">每一项都可以单独勾选 / 取消。按顺序跑，前面的结果会被后面的步骤复用（不会重复读盘）。</p>
                            <div class="space-y-2">
                                <div class="rounded border border-gray-200 bg-gray-50 p-2">
                                    <p class="font-bold text-gray-800">1. 刷新卡库数据</p>
                                    <p class="text-[10px] text-gray-600">重新扫描一遍卡库，确保下面所有检查用的都是<strong>最新数据</strong>。如果你刚改过卡片，建议勾上。</p>
                                </div>
                                <div class="rounded border border-gray-200 bg-gray-50 p-2">
                                    <p class="font-bold text-gray-800">2. 查重扫描</p>
                                    <p class="text-[10px] text-gray-600">找出重复或高度相似的卡片。详细结果在<strong>查重弹窗</strong>里逐组查看和清理。</p>
                                </div>
                                <div class="rounded border border-gray-200 bg-gray-50 p-2">
                                    <p class="font-bold text-gray-800">3. 标签分析</p>
                                    <p class="text-[10px] text-gray-600">统计：没打标签的卡、标签覆盖率、只打了一个标签的卡、最常用的标签排行。</p>
                                    <p class="text-[10px] text-amber-700 mt-1">💡 「结构画像」里的<strong>标签矩阵</strong>和<strong>标签池健康度</strong>必须靠它才能出数据。</p>
                                </div>
                                <div class="rounded border border-gray-200 bg-gray-50 p-2">
                                    <p class="font-bold text-gray-800">4. 卡片质量巡检</p>
                                    <p class="text-[10px] text-gray-600">检查常见毛病：简介为空、没打标签、开场白为空、内容过大（Token 超过阈值）。</p>
                                </div>
                                <div class="rounded border border-gray-200 bg-gray-50 p-2">
                                    <p class="font-bold text-gray-800">5. 世界书词条体检</p>
                                    <p class="text-[10px] text-gray-600">检查<strong>当前打开的那本世界书</strong>：空词条、孤儿词条（没有关键词）、重复词条。</p>
                                    <p class="text-[10px] text-gray-500 mt-1">没打开世界书时会自动跳过，这不是出错。</p>
                                </div>
                            </div>
                        </div>

                        <div class="rounded-lg border border-gray-200 bg-white p-3">
                            <p class="font-bold text-[12px] text-gray-800 mb-2">📊 结构画像：三个新增视角</p>
                            <div class="space-y-2">
                                <div class="rounded border border-emerald-200 bg-emerald-50 p-2">
                                    <p class="font-bold text-emerald-800">① 标签 × 分组交叉矩阵</p>
                                    <p class="text-[10px] text-emerald-700">行=标签，列=分组，格子里的数字表示「这个分组里有多少张卡带这个标签」。
                                        <strong>点数字可直接按该标签筛卡</strong>。颜色越深表示越多，一眼看出哪个分组缺什么标签。</p>
                                </div>
                                <div class="rounded border border-sky-200 bg-sky-50 p-2">
                                    <p class="font-bold text-sky-800">② 标签池健康度</p>
                                    <p class="text-[10px] text-sky-700">两栏对照：
                                        <strong>「池内从未使用」</strong>（标签池里有、但没卡在用 → 可能是多余的）；
                                        <strong>「已用但不在池内」</strong>（卡在用、但标签池里没有 → 可以补进池，方便以后点选）。</p>
                                </div>
                                <div class="rounded border border-amber-200 bg-amber-50 p-2">
                                    <p class="font-bold text-amber-800">③ Token 分位数</p>
                                    <p class="text-[10px] text-amber-700">看整库卡片体积分布：P50 是中位数，P90/P99 是尾部，外加最大的几张。
                                        如果 P99 特别大，说明有少数「巨无霸卡」可能拖慢加载。</p>
                                </div>
                            </div>
                        </div>

                        <div class="rounded-lg border border-amber-200 bg-amber-50 p-3">
                            <p class="font-bold text-[12px] text-amber-800 mb-1.5">🕹️ 推荐怎么用（三步）</p>
                            <ol class="list-decimal list-inside space-y-1 text-[10px] text-amber-800">
                                <li><strong>第一次用</strong>：五个检查项全勾上，点运行，等它跑完看报告。</li>
                                <li><strong>日常复查</strong>：只勾「卡片质量巡检」（快），不用每次都全跑。</li>
                                <li><strong>只想看画像</strong>：至少勾「标签分析」，跑到「📊 结构画像」页签看矩阵。</li>
                            </ol>
                        </div>

                        <div class="rounded-lg border border-gray-200 bg-gray-50 p-3">
                            <p class="font-bold text-[12px] text-gray-800 mb-1.5">❓ 常见疑问</p>
                            <div class="space-y-1.5 text-[10px] text-gray-600">
                                <p><strong>Q：跑很久是卡住了吗？</strong><br>不是。卡库大时「查重扫描」最慢（要读每张卡正文）。顶部有进度与耗时，可以随时点「取消」。</p>
                                <p><strong>Q：为什么画像里某块是灰的？</strong><br>因为它依赖「标签分析」。去「📋 巡检清单」勾上它重跑一次即可。<strong>这里不显示 0</strong>，避免把「没跑」误看成「真的是 0」。</p>
                                <p><strong>Q：报告里的数字会变吗？</strong><br>会。每次运行都是按当时卡库实时算的，不会存旧结果。</p>
                                <p><strong>Q：会不会误删我的东西？</strong><br>不会。整个流程没有写操作。要清理请去对应的查重 / 标签功能里手动操作。</p>
                            </div>
                        </div>

                        <div class="flex justify-end pt-1">
                            <button @click="activeTab = 'list'"
                                    class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[11px] transition">
                                知道了，去巡检 →
                            </button>
                        </div>
                    </div>

                    <!-- ==================== 📋 巡检清单（原有内容，逻辑零改动） ==================== -->
                    <template v-if="activeTab === 'list'">

                    <!-- 步骤勾选 + 控制 -->
                    <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
                            <label v-for="s in stepsMeta" :key="s.id" class="flex items-start gap-2 cursor-pointer">
                                <input type="checkbox" :checked="!!enabled[s.id]" :disabled="running"
                                       @change="$emit('toggle-step', s.id, $event.target.checked)"
                                       class="mt-0.5 accent-indigo-600">
                                <span class="text-[11px] text-gray-700">
                                    <b>{{ s.title }}</b>
                                    <span class="block text-[10px] text-gray-500">{{ s.desc }}</span>
                                </span>
                            </label>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap pt-0.5">
                            <span class="text-[11px] text-gray-600">Token 阈值</span>
                            <input type="number" min="100" step="500" :value="tokenThreshold" :disabled="running"
                                   @change="$emit('update:tokenThreshold', Number($event.target.value) || 8000)"
                                   class="w-24 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-gray-700">
                                <span class="text-[10px] text-gray-500">（超过即计入「卡片质量巡检」的 Token 超阀值，默认 8000）</span>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <button @click="$emit('run')" :disabled="running || !anyEnabled"
                                    :title="!anyEnabled ? '至少勾选一个步骤' : '开始质检（只读）'"
                                    class="px-3.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold disabled:bg-gray-300 disabled:cursor-not-allowed transition">▶ 开始质检</button>
                            <button v-if="running" @click="$emit('cancel')"
                                    class="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-bold transition">⛔ 中止</button>
                            <span v-if="running" class="text-[11px] text-indigo-700">第 {{ currentIndex + 1 }}/{{ stepsMeta.length }} 步 · 已用 {{ elapsedSec }}s</span>
                            <span v-else-if="elapsedSec !== '0.0'" class="text-[11px] text-gray-600">上次用时 {{ elapsedSec }}s</span>
                        </div>
                    </div>

                    <!-- 结果分区 -->
                    <div v-for="(s, i) in steps" :key="s.id" class="rounded-lg border border-gray-200 bg-white overflow-hidden">
                        <button @click="toggle(i)" class="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-gray-50 transition">
                            <span class="text-[11px] font-bold text-gray-700 flex items-center gap-2">
                                {{ statusIcon(s.status) }} {{ s.title }}
                                <span v-if="s.ms" class="text-[9px] font-normal text-gray-400">（{{ (s.ms / 1000).toFixed(2) }}s）</span>
                            </span>
                            <span class="text-[10px] text-gray-500">{{ open[i] ? '▾' : '▸' }}</span>
                        </button>
                        <div v-if="open[i]" class="px-3 pb-2.5 space-y-1.5 border-t border-gray-100">
                            <p class="text-[11px]" :class="s.status === 'failed' ? 'text-rose-700' : (s.status === 'skipped' ? 'text-gray-500' : 'text-gray-700')">
                                {{ s.summary || '—' }}<span v-if="s.error" class="block text-rose-700">错误：{{ s.error }}</span>
                            </p>
                            <div v-if="s.items && s.items.length" class="space-y-0.5">
                                <div v-for="(it, j) in s.items.slice(0, 50)" :key="s.id + '-' + j"
                                     class="flex items-center gap-2 text-[10px] text-gray-600">
                                    <span class="flex-1 min-w-0 truncate" :title="it.name || it.path">
                                        {{ it.kind === 'tag' ? '🏷' : (it.kind === 'wb-entry' ? '📚' : '🃏') }} {{ it.name || it.path }}
                                        <span v-if="it.detail" class="text-gray-400">— {{ it.detail }}</span>
                                    </span>
                                    <button v-if="it.kind === 'card' && it.path" @click="$emit('locate', it)"
                                            class="px-1.5 py-0.5 rounded border border-indigo-300 bg-white text-indigo-700 hover:bg-indigo-50 transition shrink-0">定位</button>
                                </div>
                                <p v-if="s.items.length > 50" class="text-[9px] text-gray-400">（仅显示前 50 条，共 {{ s.items.length }} 条）</p>
                            </div>
                        </div>
                    </div>

                    <p class="text-[9px] text-gray-500 leading-relaxed">
                        ⚠️ 本流水线**只读**：不修改、不删除、不保存任何数据；查重的「清理」按钮不在流水线内触发。
                        动手清理前建议先做「📦 整库冷备」留一个时间点。
                    </p>

                    </template>

                    <!-- ==================== 📊 结构画像（阶段二新增） ==================== -->
                    <!-- ==================== 📊 结构画像 ====================
                         ⚠️ 必须写 `v-else-if="activeTab === 'portrait'"`，不能只写 `v-else`：
                            加了「❓ 使用说明」页签后，`v-else` 会把画像内容**漏到说明页下面**
                            （实测：说明页滚到底会跟着出现①②③三个区块）。 -->
                    <template v-else-if="activeTab === 'portrait'">

                        <!-- 空态：从没跑过质检 -->
                        <div v-if="!hasPortrait" class="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
                            <p class="text-[12px] text-gray-600 font-bold">还没有画像数据</p>
                            <p class="text-[11px] text-gray-500 mt-1">
                                请先切到「📋 巡检清单」点 <b>▶ 开始质检</b> —— 画像直接复用那次结果，不会重复扫描。
                            </p>
                            <button @click="activeTab = 'list'"
                                    class="mt-3 px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold transition">← 去巡检清单</button>
                        </div>

                        <!-- ① 标签 × 分组交叉矩阵 -->
                        <div class="rounded-lg border border-gray-200 bg-white overflow-hidden">
                            <div class="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                                <span class="text-[11px] font-bold text-gray-700">① 标签 × 分组交叉矩阵</span>
                                <span v-if="portrait.readiness && portrait.readiness.matrix" class="text-[9px] text-gray-500">
                                    全库 {{ portrait.matrix.totalTags }} 标签 / {{ portrait.matrix.totalGroups }} 分组
                                </span>
                            </div>
                            <div v-if="portrait.readiness && portrait.readiness.matrix" class="p-2 overflow-x-auto custom-scrollbar">
                                <table class="text-[10px] border-collapse">
                                    <thead>
                                        <tr>
                                            <th class="sticky left-0 bg-white px-2 py-1 text-left font-bold text-gray-600 border-b border-gray-200">标签 \ 分组</th>
                                            <th v-for="c in portrait.matrix.cols" :key="c.name"
                                                class="px-2 py-1 text-center font-bold text-gray-600 border-b border-gray-200 whitespace-nowrap"
                                                :title="`${c.name}：共 ${c.total} 次标签命中`">{{ c.name }}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="r in portrait.matrix.rows" :key="r.tag">
                                            <td class="sticky left-0 bg-white px-2 py-1 text-gray-700 border-b border-gray-100 whitespace-nowrap max-w-[160px] truncate" :title="r.tag">
                                                🏷 {{ r.tag }} <span class="text-gray-400">({{ r.total }})</span>
                                            </td>
                                            <td v-for="(n, i) in r.cells" :key="i"
                                                class="px-2 py-1 text-center border-b border-gray-100"
                                                :class="cellClass(n, r.total)"
                                                :title="n ? `「${r.tag}」@「${portrait.matrix.cols[i].name}」：${n} 张` : ''">
                                                <button v-if="n" @click="$emit('filter-tag', { tag: r.tag, group: portrait.matrix.cols[i].name })"
                                                        class="hover:underline">{{ n }}</button>
                                                <span v-else class="text-gray-300">·</span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <div v-if="portrait.matrix.truncatedTags || portrait.matrix.truncatedGroups" class="mt-1.5 text-[9px] text-gray-500">
                                    另有 {{ portrait.matrix.truncatedTags }} 个标签、{{ portrait.matrix.truncatedGroups }} 个分组未展开；
                                    点数字可按该标签筛选。
                                </div>
                            </div>
                            <p v-else class="px-3 py-3 text-[10px] text-gray-500">
                                ⏭ 需要先做一次<strong>「标签分析」</strong>—— 请到「📋 巡检清单」勾选它并重新运行（这里不显示 0，避免与真实值混淆）。
                            </p>
                        </div>

                        <!-- ② 标签池健康度 -->
                        <div class="rounded-lg border border-gray-200 bg-white overflow-hidden">
                            <div class="px-3 py-2 bg-gray-50 border-b border-gray-200 text-[11px] font-bold text-gray-700">② 标签池健康度</div>
                            <div v-if="portrait.readiness && portrait.readiness.poolHealth" class="p-3 space-y-2">
                                <div v-if="portrait.poolHealth.poolEmpty" class="rounded bg-amber-50 border border-amber-200 px-2 py-1.5 text-[10px] text-amber-800">
                                    ⚠️ 标签池为空（你曾主动清空，本工具不会自动回填默认）—— 因此「池内未使用」无从谈起。
                                </div>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <div class="rounded border border-gray-200 p-2">
                                        <p class="text-[10px] font-bold text-gray-700 mb-1">
                                            池内从未使用 <span class="text-gray-400">（{{ portrait.poolHealth.unusedInPoolCount }} / {{ portrait.poolHealth.poolSize }}）</span>
                                        </p>
                                        <div v-if="portrait.poolHealth.unusedInPoolCount" class="flex flex-wrap gap-1">
                                            <span v-for="t in portrait.poolHealth.unusedInPool.slice(0, 20)" :key="t"
                                                  class="px-1.5 py-0.5 rounded bg-gray-100 text-[9px] text-gray-600">{{ t }}</span>
                                            <span v-if="portrait.poolHealth.unusedInPoolCount > 20" class="text-[9px] text-gray-400">…另有 {{ portrait.poolHealth.unusedInPoolCount - 20 }} 个</span>
                                        </div>
                                        <p v-else class="text-[10px] text-gray-400">👍 池里的标签都在用</p>
                                    </div>
                                    <div class="rounded border border-gray-200 p-2">
                                        <p class="text-[10px] font-bold text-gray-700 mb-1">
                                            已用但不在池内 <span class="text-gray-400">（{{ portrait.poolHealth.usedNotInPoolCount }}）</span>
                                        </p>
                                        <div v-if="portrait.poolHealth.usedNotInPoolCount" class="flex flex-wrap gap-1">
                                            <span v-for="x in portrait.poolHealth.usedNotInPool.slice(0, 20)" :key="x.tag"
                                                  class="px-1.5 py-0.5 rounded bg-indigo-50 text-[9px] text-indigo-700"
                                                  :title="`${x.count} 张卡`">{{ x.tag }}<span class="text-indigo-400">({{ x.count }})</span></span>
                                            <span v-if="portrait.poolHealth.usedNotInPoolCount > 20" class="text-[9px] text-gray-400">…另有 {{ portrait.poolHealth.usedNotInPoolCount - 20 }} 个</span>
                                        </div>
                                        <p v-else class="text-[10px] text-gray-400">👍 没有野生标签</p>
                                    </div>
                                </div>
                            </div>
                            <p v-else class="px-3 py-3 text-[10px] text-gray-500">
                                ⏭ 需要先做一次<strong>「标签分析」</strong>—— 请勾选它并重新运行。
                            </p>
                        </div>

                        <!-- ③ Token 分位数 -->
                        <div class="rounded-lg border border-gray-200 bg-white overflow-hidden">
                            <div class="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                                <span class="text-[11px] font-bold text-gray-700">③ Token 分位数</span>
                                <span v-if="portrait.tokenStats && portrait.tokenStats.reusedFromS4" class="text-[9px] text-emerald-600">♻️ 复用「卡片质量巡检」的结果（未重复扫描）</span>
                            </div>
                            <div v-if="portrait.readiness && portrait.readiness.tokenStats" class="p-3">
                                <div class="grid grid-cols-4 gap-2 text-center">
                                    <div v-for="q in tokenQuartiles" :key="q.label" class="rounded border border-gray-200 py-1.5">
                                        <p class="text-[9px] text-gray-500">{{ q.label }}</p>
                                        <p class="text-[12px] font-bold text-gray-800">{{ q.value }}</p>
                                    </div>
                                </div>
                                <div v-if="portrait.tokenStats.heaviest && portrait.tokenStats.heaviest.length" class="mt-2">
                                    <button @click="showHeavy = !showHeavy" class="text-[10px] text-indigo-600 hover:underline">
                                        {{ showHeavy ? '▾' : '▸' }} 最重 {{ portrait.tokenStats.heaviest.length }} 张
                                    </button>
                                    <div v-if="showHeavy" class="mt-1 space-y-0.5">
                                        <div v-for="h in portrait.tokenStats.heaviest" :key="h.path"
                                             class="flex items-center gap-2 text-[10px] text-gray-600">
                                            <span class="flex-1 min-w-0 truncate" :title="h.path">{{ h.name }}</span>
                                            <span class="text-gray-400 shrink-0">{{ h.tokens }} token</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <p v-else class="px-3 py-3 text-[10px] text-gray-500">
                                ⏭ 暂不可用（缺少 Token 估算入口）。
                            </p>
                        </div>

                        <!-- B3：低覆盖 → 一键去处理 -->
                        <div v-if="portrait.readiness && portrait.readiness.poolHealth" class="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                            <p class="text-[10px] text-indigo-900 font-bold mb-1.5">下一步</p>
                            <div class="flex flex-wrap gap-2">
                                <button @click="$emit('open-ai-tag')"
                                        class="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] transition">🤖 去 AI 打标</button>
                                <button @click="$emit('open-auto-group')"
                                        class="px-2.5 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100 text-[10px] transition">🗂 去自动分组</button>
                            </div>
                        </div>

                    </template>
                </div>

                <!-- 底部 -->
                <!-- ⚠️ 说明页（activeTab === 'help'）**不显示**这条栏：
                     说明页自带「知道了，去巡检」按钮，底部再摆一份「复制报告/导出/知道了」
                     既重复又抢占高度（实测会把说明正文挤到滚动区外，用户以为内容没写完）。 -->
                <div v-if="activeTab !== 'help'" class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
                    <span class="text-[10px]" :class="msg ? 'text-emerald-700' : 'text-gray-500'">{{ msg || (running ? '质检进行中…' : (hasReport ? '报告可复制或导出 Markdown' : '💡 建议先做整库冷备，再按报告动手清理')) }}</span>
                    <div class="flex items-center gap-2">
                        <button @click="copyReport" :disabled="!hasReport"
                                class="px-2.5 py-1.5 rounded border border-gray-300 bg-white text-gray-700 text-[11px] hover:bg-gray-100 disabled:opacity-40 transition">📋 复制报告</button>
                        <button @click="exportReport" :disabled="!hasReport || exporting"
                                class="px-2.5 py-1.5 rounded border border-indigo-300 bg-white text-indigo-700 text-[11px] hover:bg-indigo-50 disabled:opacity-40 transition">{{ exporting ? '导出中…' : '💾 导出 Markdown' }}</button>
                        <button @click="$emit('close')" :disabled="running"
                                class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-50 transition">知道了</button>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
/**
 * 纯展示 + 动作上抛：状态全部在 `useQualityCheck`（App.vue 侧），组件不自己算任何数字。
 */
export default {
    name: 'QualityCheckModal',
    props: {
        show: { type: Boolean, default: false },
        steps: { type: Array, default: () => [] },
        stepsMeta: { type: Array, default: () => [] },
        enabled: { type: Object, default: () => ({}) },
        running: { type: Boolean, default: false },
        currentIndex: { type: Number, default: 0 },
        elapsedSec: { type: String, default: '0.0' },
        tokenThreshold: { type: Number, default: 8000 },
        report: { type: String, default: '' },
        // 📊 结构画像（阶段二）：由 useQualityCheck 的 `portrait` computed 传入
        portrait: { type: Object, default: () => ({ matrix: null, poolHealth: null, tokenStats: null, readiness: {} }) },
        hasPortrait: { type: Boolean, default: false }
    },
    emits: ['close', 'run', 'cancel', 'locate', 'toggle-step', 'update:tokenThreshold', 'filter-tag', 'open-ai-tag', 'open-auto-group'],
    data() {
        // ⚠️ AR-56 教训：data 键**绝不能**与 methods 同名（Vue 中 methods 会覆盖 data，
        //    模板拿到函数对象 ⇒ 插值渲染成空串且**不报错**）。
        return { open: {}, exporting: false, msg: '', activeTab: 'list', showHeavy: false };
    },
    computed: {
        anyEnabled() { return Object.values(this.enabled || {}).some(Boolean); },
        hasReport() { return !!(this.report && this.report.length); },
        /** ③ Token 四档摘要（P50/P90/P99/最大） */
        tokenQuartiles() {
            const t = (this.portrait && this.portrait.tokenStats) || null;
            if (!t) return [];
            const f = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString());
            return [
                { label: 'P50 中位', value: f(t.p50) },
                { label: 'P90', value: f(t.p90) },
                { label: 'P99', value: f(t.p99) },
                { label: '最大', value: f(t.max) }
            ];
        }
    },
    watch: {
        show(v) {
            if (v) {
                // 默认只展开「有内容或非待执行」的步骤，避免一屏全是空区
                const o = {};
                this.steps.forEach((s, i) => { o[i] = !!(s.summary || s.error); });
                this.open = o;
                this.msg = '';
                // 每次打开先回到巡检清单（画像只是第二个视角，不抢默认）
                this.activeTab = 'list';
                this.showHeavy = false;
            }
        }
    },
    methods: {
        toggle(i) { this.open = Object.assign({}, this.open, { [i]: !this.open[i] }); },
        statusIcon(st) {
            return { pending: '⏸', running: '⏳', done: '✅', skipped: '⏭', failed: '❌', cancelled: '⛔' }[st] || '⏸';
        },
        /** 热力单元格配色：按**该行最大值**归一（不跨行比较），0 值弱化 */
        cellClass(n, rowMax) {
            if (!n) return 'text-gray-300';
            const ratio = rowMax ? n / rowMax : 0;
            if (ratio >= 0.75) return 'bg-indigo-600 text-white font-bold';
            if (ratio >= 0.5) return 'bg-indigo-300 text-indigo-900';
            if (ratio >= 0.25) return 'bg-indigo-100 text-indigo-800';
            return 'bg-indigo-50 text-indigo-700';
        },
        async copyReport() {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(this.report);
                    this.msg = '已复制';
                    return;
                }
                throw new Error('剪贴板不可用');
            } catch (e) {
                // 兜底：临时 textarea + execCommand（Electron 下 clipboard API 在个别环境受限）
                try {
                    const ta = document.createElement('textarea');
                    ta.value = this.report;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    this.msg = '已复制';
                } catch (e2) {
                    this.msg = '复制失败：' + ((e2 && e2.message) || '请手动选择文本');
                }
            }
        },
        async exportReport() {
            const api = window.electronAPI;
            if (!api || typeof api.saveTextFile !== 'function') { this.msg = '导出失败：当前环境不支持保存文件'; return; }
            this.exporting = true;
            try {
                const stamp = (() => {
                    const d = new Date(); const p = (x) => String(x).padStart(2, '0');
                    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
                })();
                const r = await api.saveTextFile({
                    defaultName: `一键质检报告_${stamp}.md`,
                    content: this.report,
                    filters: [{ name: 'Markdown', extensions: ['md'] }]
                });
                if (r && r.ok) this.msg = `已导出 ${Math.round((r.bytes || 0) / 1024)} KB`;
                else if (r && r.canceled) this.msg = '';
                else this.msg = '导出失败：' + ((r && r.error) || '未知错误');
            } catch (e) {
                this.msg = '导出失败：' + ((e && e.message) || String(e));
            } finally {
                this.exporting = false;
            }
        }
    }
};
</script>
