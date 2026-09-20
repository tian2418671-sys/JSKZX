<!--
  AutoGroupModal 自动分组设置 + 预览 + 执行 + 回滚（S2~S4）
  ─────────────────────────────────────────────────────────────
  · 「📋 收纳规则」：目标分组 + 收纳条件（声明式档案），可从真实库命名整理的推荐模板一键载入
  · 「🔍 预览与执行」：扫描计划（可勾选）→ 物理移动 → 进度/失败清单 → 重试 → 一键回滚
  ⚠️ 纯 props/emits 组件（执行/回滚等副作用全部 emit 给 App.vue 侧的 useAutoGroup）——模块级常量经
     computed 暴露给模板（坑 11）。
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[92vh]">

                <!-- 标题栏 -->
                <div class="px-5 py-4 bg-gray-900 text-white border-b border-gray-800 flex justify-between items-center shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        🗂️ 自动分组
                        <span class="text-[10px] font-normal text-gray-400">先预览 · 后执行 · 可回滚（物理移动卡片文件）</span>
                    </h3>
                    <button @click="$emit('close')" class="text-gray-400 hover:text-white transition">✕ 关闭</button>
                </div>

                <!-- 选项卡 -->
                <div class="flex border-b border-gray-200 gap-1 px-5 pt-3 shrink-0 bg-gray-50">
                    <button @click="tab = 'rules'"
                            :class="['px-3 py-1.5 text-xs font-bold rounded-t transition border-b-2',
                                     tab === 'rules' ? 'text-blue-700 border-blue-600 bg-white' : 'text-gray-500 border-transparent hover:text-gray-700']">
                        📋 收纳规则 <span class="text-[10px] font-normal">({{ localProfiles.length }})</span>
                    </button>
                    <button @click="tab = 'preview'"
                            :class="['px-3 py-1.5 text-xs font-bold rounded-t transition border-b-2',
                                     tab === 'preview' ? 'text-blue-700 border-blue-600 bg-white' : 'text-gray-500 border-transparent hover:text-gray-700']">
                        🔍 预览与执行
                        <span v-if="stats.willMove" class="text-[10px] font-normal text-emerald-600">（待移动 {{ stats.willMove }}）</span>
                    </button>
                </div>

                <div class="p-5 overflow-y-auto space-y-3 flex-1 custom-scrollbar text-xs">

                    <!-- ==================== 📋 收纳规则 ==================== -->
                    <div v-if="tab === 'rules'" class="space-y-3">
                        <p class="text-[11px] text-gray-500 leading-relaxed">
                            每行 = 一个 <strong>目标分组</strong> + 该分组声明的 <strong>收纳条件</strong>。
                            <strong class="text-blue-600">分组顺序即优先级</strong>（= 侧边栏分组顺序，首个命中者胜）；
                            默认<strong>只处理「未分类」卡片</strong>，已手动分组的卡不会被覆盖。
                        </p>

                        <!-- 推荐模板（按真实库分组命名整理） -->
                        <div class="border border-indigo-200 bg-indigo-50 rounded-lg p-3 flex items-start justify-between gap-3">
                            <div class="space-y-1">
                                <div class="text-xs font-bold text-indigo-700">📦 推荐模板（可选起点）</div>
                                <p class="text-[10px] text-indigo-600/90 leading-relaxed">
                                    共 {{ presetTotal }} 条常用分组模板（来源：{{ presetSource }}）；
                                    只载入你<strong>当前分组列表里已有</strong>的分组，不会凭空新建分组；
                                    执行时若文件夹不存在会自动创建（预览中有标注）。载入后请逐条检查再保存。
                                </p>
                                <p v-if="presetNote" class="text-[10px] text-emerald-700">{{ presetNote }}</p>
                            </div>
                            <button @click="loadPresets"
                                    class="shrink-0 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs transition">📦 载入推荐模板</button>
                        </div>

                        <!-- 规则行 -->
                        <div v-for="(p, idx) in localProfiles" :key="p.id || idx"
                             class="border border-gray-200 rounded-lg p-2.5 bg-gray-50 space-y-1.5"
                             :class="{ 'border-rose-400 bg-rose-50': p._error }">
                            <div class="flex items-center gap-2">
                                <label class="flex items-center gap-1 shrink-0 cursor-pointer" title="启用/停用这条规则">
                                    <input type="checkbox" v-model="p.enabled" class="w-3.5 h-3.5 accent-blue-600">
                                    <span class="text-[10px] text-gray-500">启用</span>
                                </label>
                                <select v-model="p.group"
                                        class="w-40 shrink-0 bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none">
                                    <option value="" disabled>选择目标分组…</option>
                                    <option v-for="o in groupOptions" :key="o.value" :value="o.value"
                                            :disabled="isGroupUsedByOther(o.value, idx)">{{ o.label }}</option>
                                    <option v-if="p.group && !groupValues.includes(p.group)" :value="p.group">{{ p.group }}（当前库不存在）</option>
                                </select>
                                <select v-model="p.match.type"
                                        class="w-40 shrink-0 bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none">
                                    <option v-for="t in matchTypeOptions" :key="t.value" :value="t.value">{{ t.label }}</option>
                                </select>
                                <template v-if="!patternlessTypes.includes(p.match.type)">
                                    <!-- 名称正则：高级模式（保留手写；只想匹配多个词请改用「名称包含关键词」） -->
                                    <input v-if="p.match.type === 'name-regex'" v-model="p.match.pattern" type="text"
                                           :placeholder="patternPlaceholder(p.match.type)"
                                           class="flex-1 min-w-0 bg-white border border-gray-300 rounded px-2 py-1 text-xs font-mono text-gray-800 focus:border-blue-500 focus:outline-none">
                                    <!-- 标签 / 名称关键词：多值 chips 编辑器（回车或点选添加，内部自动 OR；任一命中即命中） -->
                                    <div v-else
                                         class="flex-1 min-w-0 bg-white border border-gray-300 rounded px-1.5 py-1 flex flex-wrap items-center gap-1 focus-within:border-blue-500">
                                        <span v-for="w in wordsOf(p)" :key="w"
                                              class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-50 border border-blue-200 rounded text-[11px] text-blue-800">
                                            {{ w }}
                                            <button @click="removeWord(p, w)" class="text-blue-400 hover:text-rose-500 leading-none" title="移除这个词">✕</button>
                                        </span>
                                        <input :value="p._wordInput" @input="p._wordInput = $event.target.value"
                                               @keydown.enter.prevent="onWordEnter(p, $event)"
                                               @blur="addWord(p)"
                                               :placeholder="wordsOf(p).length ? '' : wordPlaceholder(p.match.type)"
                                               class="flex-1 min-w-[90px] bg-transparent border-0 p-0.5 text-xs text-gray-800 focus:outline-none">
                                    </div>
                                    <button v-if="p.match.type === 'tag' || p.match.type === 'name-keyword'" @click="toggleTagPicker(idx)"
                                            :class="openPickerIdx === idx ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-300 hover:bg-blue-600 hover:text-white'"
                                            class="shrink-0 px-2 py-1 border rounded text-[11px] transition"
                                            title="从已有标签/关键词点选（系统标签库 + 全库卡片标签）">🏷️ 点选</button>
                                </template>
                                <span v-else class="flex-1 text-[11px] text-gray-400 pl-1">（该条件无需参数）</span>
                                <button @click="removeProfile(idx)" class="text-gray-400 hover:text-rose-500 px-2 py-1 rounded hover:bg-gray-100 transition shrink-0" title="删除此规则">🗑️</button>
                            </div>
                            <!-- 🏷️ 点选面板：点击即把词语加入多值列表（可连点；多个词 = 任一命中） -->
                            <div v-if="openPickerIdx === idx && (p.match.type === 'tag' || p.match.type === 'name-keyword')" class="border border-blue-200 bg-white rounded-lg p-2 space-y-1">
                                <div class="flex items-center gap-2">
                                    <span class="text-[10px] font-bold text-blue-700 shrink-0">🏷️ 点击词语即加入（已加入的会标亮；可连点多个）</span>
                                    <input v-model="pickerFilter" type="text" placeholder="筛选标签…"
                                           class="flex-1 min-w-0 bg-white border border-gray-300 rounded px-2 py-0.5 text-[11px] text-gray-800 focus:border-blue-500 focus:outline-none">
                                    <button @click="closeTagPicker" class="text-[10px] text-gray-400 hover:text-gray-600 shrink-0 px-1">收起 ✕</button>
                                </div>
                                <div v-if="filteredTagGroups.length === 0" class="text-[10px] text-gray-400 py-1">没有可选标签（先在卡片上打标，或直接手动输入匹配内容）</div>
                                <div class="max-h-40 overflow-y-auto custom-scrollbar space-y-1">
                                    <template v-for="g in filteredTagGroups" :key="g.key">
                                        <div class="text-[10px] font-bold text-gray-500 mt-1 first:mt-0">{{ g.icon }} {{ g.name }} <span class="font-normal text-gray-400">({{ g.tags.length }})</span></div>
                                        <div class="flex flex-wrap gap-1">
                                            <button v-for="tag in g.tags" :key="tag" @click="pickWord(idx, tag)"
                                                    :class="wordsOf(p).some(w => w.toLowerCase() === String(tag).toLowerCase())
                                                        ? 'bg-blue-600 border-blue-600 text-white'
                                                        : 'bg-gray-50 border-gray-300 text-gray-600 hover:bg-blue-600 hover:border-blue-500 hover:text-white'"
                                                    class="px-1.5 py-0.5 text-[10px] border rounded transition">{{ tag }}</button>
                                        </div>
                                    </template>
                                </div>
                            </div>
                            <p v-if="p._error" class="text-[10px] text-rose-500">❌ {{ p._error }}</p>
                            <p v-else-if="p.note" class="text-[10px] text-gray-400 pl-1">💡 {{ p.note }}</p>
                            <!-- 🤖 LLM 判定层：判定标准（留空 = 该组不参与 AI 判定） -->
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] text-purple-600 shrink-0" title="给 AI 的判定说明：留空 = 该分组不参与 AI 判定。AI 只处理「未命中规则 / 冲突」的卡，建议默认不勾选。">🤖 判定标准</span>
                                <input v-model="p.llmCriteria" type="text" maxlength="300"
                                       placeholder="点「✨ 生成」自动起草，或直接输入；留空 = 不参与 AI 判定"
                                       class="flex-1 min-w-0 bg-white border border-purple-200 rounded px-2 py-1 text-xs text-gray-800 focus:border-purple-500 focus:outline-none">
                                <button @click="genLlmCriteria(p)"
                                        class="shrink-0 px-2 py-1 bg-purple-50 border border-purple-300 text-purple-700 rounded text-[11px] hover:bg-purple-600 hover:text-white transition"
                                        title="根据分组名与当前收纳条件一键生成草稿（生成后可修改）">✨ 生成</button>
                            </div>
                        </div>
                        <div v-if="localProfiles.length === 0" class="text-gray-400 text-center py-6 border border-dashed border-gray-300 rounded-lg">
                            还没有收纳规则 —— 点「➕ 添加规则」或「📦 载入推荐模板」开始
                        </div>
                        <p v-if="duplicateGroups.length" class="text-[10px] text-amber-600 leading-relaxed">
                            ⚠️ 同一分组存在多条规则：{{ duplicateGroups.join('、') }}（v1 语义为「同组多规则依次尝试」，建议每组合并成一条；S5 会正式放开条件组合）
                        </p>

                        <div class="flex items-center gap-2 pt-1">
                            <button @click="addProfile" class="px-3 py-1.5 bg-white border border-gray-300 rounded text-gray-700 hover:bg-gray-100 transition">➕ 添加规则</button>
                            <button @click="confirmReset ? doReset() : (confirmReset = true)"
                                    class="px-3 py-1.5 border rounded transition"
                                    :class="confirmReset ? 'bg-rose-600 text-white border-rose-600' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'">
                                {{ confirmReset ? '⚠️ 再点一次：清空全部规则' : '↩️ 清空全部规则' }}
                            </button>
                            <span class="flex-1"></span>
                            <button @click="doSave" class="px-5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold transition">💾 保存并生效</button>
                        </div>
                    </div>

                    <!-- ==================== 🔍 预览与执行 ==================== -->
                    <div v-if="tab === 'preview'" class="space-y-3">

                        <!-- 工具栏 -->
                        <div class="flex items-center gap-3 flex-wrap">
                            <label class="flex items-center gap-1.5 cursor-pointer select-none" title="默认只处理未分类卡片；勾选后连已分组的卡也参与判定">
                                <input type="checkbox" :checked="includeGrouped" @change="changeIncludeGrouped($event.target.checked)"
                                       class="w-3.5 h-3.5 accent-blue-600">
                                <span class="text-[11px] text-gray-600">包含已手动分组的卡片（<strong class="text-rose-500">会改变已有归档</strong>，默认不勾）</span>
                            </label>
                            <span class="flex-1"></span>
                            <button @click="doScan" :disabled="exec.running || rollback.running"
                                    class="px-3 py-1.5 bg-white border border-gray-300 rounded text-gray-700 hover:bg-gray-100 disabled:opacity-50 transition">🔄 重新扫描</button>
                            <button v-if="!llm.running" @click="$emit('llm-run')" :disabled="exec.running || rollback.running || !plan"
                                    class="px-3 py-1.5 bg-white border border-purple-300 text-purple-700 rounded hover:bg-purple-50 disabled:opacity-50 transition"
                                    title="对「未命中规则 / 冲突」的卡片调用 AI（按各分组填写的「判定标准」归类；建议默认不勾选，需人工确认）">🤖 AI 分辨</button>
                            <button v-else @click="$emit('llm-abort')"
                                    class="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded transition">⛔ 停止 AI</button>
                            <button v-if="!exec.running" @click="doExecute" :disabled="rollback.running || checkedCount === 0"
                                    class="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded font-bold transition">
                                ▶️ 执行选中（{{ checkedCount }}）
                            </button>
                            <button v-else @click="$emit('abort')"
                                    class="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold transition">⛔ 中止</button>
                        </div>

                        <!-- 🤖 AI 分辨状态 / 统计（建议默认不勾选，可一键勾选） -->
                        <div v-if="llm.running || llm.lastAt" class="text-[10px] text-purple-700 leading-relaxed">
                            🤖 {{ llm.running ? `AI 分辨中… ${llm.done} / ${llm.total}` : `AI 分辨完成：建议 ${llm.suggested} 张 · 未识别 ${llm.unmatched} 张 · 新请求 ${llm.requested} 次` }}
                            <span v-if="llm.errors && llm.errors.length" class="text-rose-500">（{{ llm.errors.length }} 个批次异常：{{ llm.errors.slice(0, 2).join('；') }}）</span>
                            <span v-if="llmMoves.length" class="ml-2">
                                <button @click="setLlmChecked(true)" class="underline hover:text-purple-900">勾选全部建议（{{ llmMoves.length }}）</button>
                                <button @click="setLlmChecked(false)" class="underline hover:text-purple-900 ml-2">全部取消</button>
                            </span>
                        </div>

                        <!-- 上次执行 / 回滚 -->
                        <div v-if="lastRun || rollback.finishedAt || exec.finishedAt" class="border border-gray-200 rounded-lg p-2.5 bg-gray-50 space-y-1.5">
                            <div v-if="lastRun" class="flex items-center gap-2 text-[11px] text-gray-600">
                                <span>🗂️ 上次自动分组：{{ fmtTime(lastRun.at) }} 移动 {{ lastRun.entries.length }} 张</span>
                                <span class="flex-1"></span>
                                <button @click="$emit('rollback')" :disabled="rollback.running || exec.running"
                                        class="px-2.5 py-1 bg-white border border-gray-300 rounded text-gray-700 hover:bg-amber-100 disabled:opacity-50 transition">↩️ 回滚自动分组（{{ lastRun.entries.length }} 张）</button>
                            </div>
                            <div v-if="lastRun && lastRun.lastRollback" class="text-[10px] text-gray-500">
                                最近一次回滚：{{ fmtTime(lastRun.lastRollback.at) }} · 已还原 {{ lastRun.lastRollback.rolled }} 张
                                <span v-if="lastRun.lastRollback.failed.length" class="text-rose-500">· {{ lastRun.lastRollback.failed.length }} 张未处理</span>
                            </div>
                            <!-- 本次回滚进度/结果 -->
                            <div v-if="rollback.running || rollback.finishedAt" class="text-[11px]">
                                <div v-if="rollback.running" class="text-amber-600">↩️ 回滚中… {{ rollback.done }} / {{ rollback.total }}</div>
                                <div v-else-if="rollback.failed.length" class="text-rose-600">回滚完成：已还原 {{ rollback.rolled }} 张，以下未处理：</div>
                                <ul v-if="!rollback.running && rollback.failed.length" class="mt-1 space-y-0.5 max-h-28 overflow-y-auto custom-scrollbar">
                                    <li v-for="(f, i) in rollback.failed" :key="i" class="text-[10px] text-rose-500">· {{ f.cardName }} —— {{ f.reason }}</li>
                                </ul>
                            </div>
                            <!-- 本次执行进度/失败 -->
                            <div v-if="exec.running || exec.finishedAt" class="space-y-1">
                                <div class="flex items-center gap-2 text-[11px]" :class="exec.running ? 'text-blue-600' : (exec.failed ? 'text-amber-600' : 'text-emerald-600')">
                                    <span>{{ exec.running ? '⏳ 执行中' : (exec.aborted ? '⛔ 已中止' : '✅ 执行完成') }}：{{ exec.done }} / {{ exec.total }}（成功 {{ exec.moved }}，失败 {{ exec.failed }}）</span>
                                    <span v-if="exec.aborted" class="text-[10px] text-gray-500">（已完成的不回退，剩余项仍在下方计划里）</span>
                                </div>
                                <div class="h-1.5 bg-gray-200 rounded overflow-hidden">
                                    <div class="h-full bg-blue-500 transition-all" :style="{ width: execPercent + '%' }"></div>
                                </div>
                                <div v-if="!exec.running && exec.failures.length" class="space-y-1">
                                    <div class="flex items-center gap-2">
                                        <span class="text-[10px] text-rose-500">失败 {{ exec.failures.length }} 张：</span>
                                        <button @click="retryFailed" class="px-2 py-0.5 bg-white border border-rose-300 text-rose-600 rounded text-[10px] hover:bg-rose-50 transition">🔁 重试失败项</button>
                                    </div>
                                    <ul class="max-h-24 overflow-y-auto custom-scrollbar space-y-0.5">
                                        <li v-for="(f, i) in exec.failures" :key="i" class="text-[10px] text-rose-500">· {{ f.cardName }} → {{ f.toGroup }}</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <!-- 无扫描结果（空态） -->
                        <div v-if="!plan" class="text-gray-400 text-center py-8 border border-dashed border-gray-300 rounded-lg space-y-1">
                            <div v-if="localProfiles.length === 0">尚未配置收纳规则 —— 请先到「📋 收纳规则」页添加或载入推荐模板</div>
                            <div v-else>尚未生成计划 —— 点上方「🔄 重新扫描」开始（只读，不动文件）</div>
                        </div>

                        <!-- 统计 + 计划 -->
                        <template v-if="plan">
                            <div class="flex flex-wrap items-center gap-2 text-[11px]">
                                <span class="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded">将移动 {{ stats.willMove }}</span>
                                <span class="px-2 py-0.5 bg-gray-50 border border-gray-200 text-gray-600 rounded">跳过 {{ stats.skipped }}</span>
                                <span class="px-2 py-0.5 rounded border"
                                      :class="stats.conflicts ? 'bg-amber-50 border-amber-300 text-amber-700' : 'bg-gray-50 border-gray-200 text-gray-600'">冲突 {{ stats.conflicts }}</span>
                                <span v-if="stats.newFolders" class="px-2 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded">将新建文件夹 {{ stats.newFolders }}</span>
                                <span class="text-[10px] text-gray-400">扫描于 {{ fmtTime(scan.at) }} · 启用规则 {{ stats.enabledProfiles }} 条</span>
                            </div>

                            <div v-if="newFolders.length" class="text-[10px] text-indigo-600 leading-relaxed">
                                🆕 将新建分组文件夹：{{ newFolders.join('、') }}
                                <span v-if="renamedFolders.length" class="text-amber-600">（名称被净化：{{ renamedFolders.join('；') }}）</span>
                            </div>

                            <div v-if="dupWarnings.length" class="border border-rose-200 bg-rose-50 rounded p-2 text-[10px] text-rose-600 leading-relaxed">
                                ⚠️ 同组同名文件 {{ dupWarnings.length }} 处：移动时后到的文件会加「_移动_时间戳」后缀（不覆盖），
                                <span v-for="(w, i) in dupWarnings.slice(0, 5)" :key="i" class="whitespace-nowrap">［{{ w.targetGroup }}：{{ w.fileName }}×{{ w.cards.length }}］</span>
                            </div>

                            <div v-if="conflicts.length" class="border border-amber-200 bg-amber-50 rounded p-2 text-[10px] text-amber-700 leading-relaxed">
                                ⚡ 冲突 {{ conflicts.length }} 张（同时命中多个分组，按侧边栏顺序取首个）：
                                <ul class="mt-1 space-y-0.5">
                                    <li v-for="(c, i) in conflicts.slice(0, 20)" :key="i">
                                        · {{ c.cardName }} → <strong>{{ c.winnerGroup }}</strong>
                                        <span class="text-amber-500">（命中：{{ c.hits.map(h => h.group).join('、') }}）</span>
                                    </li>
                                </ul>
                                <div v-if="conflicts.length > 20" class="text-amber-500">…仅显示前 20 条（共 {{ conflicts.length }}）</div>
                            </div>

                            <!-- 移动计划表 -->
                            <div v-if="moves.length" class="border border-gray-200 rounded-lg overflow-hidden">
                                <div class="px-3 py-1.5 bg-gray-100 flex items-center gap-2 text-[10px] text-gray-500">
                                    <label class="flex items-center gap-1 cursor-pointer" title="全选/全不选">
                                        <input type="checkbox" :checked="allChecked" @change="toggleAll($event.target.checked)" class="w-3 h-3 accent-emerald-600">
                                        <span>全选<span class="text-[9px] text-purple-500 ml-0.5">（🤖 建议默认不勾）</span></span>
                                    </label>
                                    <span class="flex-1">将移动 {{ checkedCount }} / {{ moves.length }} 张</span>
                                    <span v-if="moves.length > 500" class="text-amber-600">（仅显示前 500 条，执行仍按勾选统计）</span>
                                </div>
                                <div class="max-h-[38vh] overflow-y-auto custom-scrollbar">
                                    <table class="w-full text-[11px]">
                                        <thead class="sticky top-0 bg-white border-b border-gray-200 text-gray-500">
                                            <tr>
                                                <th class="w-8 px-2 py-1"></th>
                                                <th class="text-left px-2 py-1 font-normal">卡片</th>
                                                <th class="text-left px-2 py-1 font-normal w-32">当前分组</th>
                                                <th class="text-left px-2 py-1 font-normal w-32">目标分组</th>
                                                <th class="text-left px-2 py-1 font-normal">原因</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr v-for="m in visibleMoves" :key="m.cardId" class="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                                                <td class="px-2 py-1 align-top">
                                                    <input type="checkbox" :checked="isChecked(m)" @change="toggleCheck(m)"
                                                           class="w-3 h-3 accent-emerald-600">
                                                </td>
                                                <td class="px-2 py-1 align-top text-gray-800 break-all">{{ m.cardName }}</td>
                                                <td class="px-2 py-1 align-top text-gray-500">{{ m.fromGroup }}</td>
                                                <td class="px-2 py-1 align-top font-bold text-emerald-700">
                                                    <span v-if="m.source === 'llm'" class="text-[10px] mr-0.5 px-1 py-0.5 rounded bg-purple-100 border border-purple-300 text-purple-700"
                                                          :title="'AI 置信度 ' + Math.round((m.llm && m.llm.confidence || 0) * 100) + '%'">🤖</span>{{ m.toGroup }}
                                                </td>
                                                <td class="px-2 py-1 align-top text-gray-500">{{ m.reason }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <!-- 跳过项（按原因归组） -->
                            <div v-if="skippedGroups.length" class="border border-gray-200 rounded-lg bg-gray-50 p-2.5 space-y-1">
                                <button @click="expandedSkipped = !expandedSkipped" class="text-[11px] text-gray-600 font-bold hover:text-blue-700 transition">
                                    {{ expandedSkipped ? '🔽' : '▶️' }} 未移动 {{ stats.skipped }} 张（点开看原因）
                                </button>
                                <div v-for="g in skippedGroups" :key="g.reason" class="text-[10px] text-gray-500">
                                    · {{ g.reason }}：<strong>{{ g.count }}</strong> 张
                                    <span v-if="expandedSkipped && g.samples.length" class="text-gray-400">（如：{{ g.samples.join('、') }}{{ g.count > g.samples.length ? '…' : '' }}）</span>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>

                <div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 shrink-0">
                    <button @click="$emit('close')" class="px-5 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 transition">关闭</button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
// 模块级常量（模板访问须经 computed —— 坑 11）
import { AUTO_GROUP_MATCH_TYPES, AUTO_GROUP_MATCH_LABELS, MATCH_TYPES_WITHOUT_PATTERN, createProfileId } from '../utils/autoGroup.js';
import { AUTO_GROUP_PROFILE_PRESETS, AUTO_GROUP_PRESET_SOURCE, buildPresetProfiles } from '../utils/autoGroupPresets.js';
import { groupTagsByCategory } from '../utils/tagCategories.js'; // 🏷️ 标签按大分类分组（点选面板用，同打标弹窗「快速点击添加」）

export default {
    name: 'AutoGroupModal',
    props: {
        show: { type: Boolean, default: false },
        profiles: { type: Array, default: () => [] },              // 已保存的分组档案
        lastRun: { type: Object, default: null },                  // 最近一次移动日志 { at, entries, lastRollback? }
        scan: { type: Object, default: null },                     // { at, includeGrouped, plan }
        exec: { type: Object, default: () => ({}) },               // 执行进度状态
        rollback: { type: Object, default: () => ({}) },           // 回滚进度状态
        llm: { type: Object, default: () => ({}) },                // 🤖 LLM 分辨进度/结果
        groupOptions: { type: Array, default: () => [] },          // [{label, value}]（与侧边栏同序）
        availableTags: { type: Array, default: () => [] }          // 🏷️ 标签点选数据源（系统标签库 + 全库卡片标签）
    },
    emits: ['close', 'save-profiles', 'reset-profiles', 'scan', 'execute', 'abort', 'rollback', 'llm-run', 'llm-abort'],
    data() {
        return {
            tab: 'rules',
            localProfiles: [],      // 编辑工作副本
            includeGrouped: false,
            excludedIds: {},        // cardId → true 表示「不勾选」
            expandedSkipped: false,
            presetNote: '',
            confirmReset: false,
            openPickerIdx: -1,     // 🏷️ 当前展开「标签点选」面板的规则行（-1 = 全收起）
            pickerFilter: ''       // 点选面板内的筛选关键词
        };
    },
    computed: {
        // —— 模块常量转 computed（坑 11）——
        matchTypeOptions() {
            return AUTO_GROUP_MATCH_TYPES.map(v => ({ value: v, label: AUTO_GROUP_MATCH_LABELS[v] || v }));
        },
        patternlessTypes() { return MATCH_TYPES_WITHOUT_PATTERN; },
        // 🏷️ 标签点选面板数据：按大分类分组 + 关键词过滤（数据源 = 系统标签库 + 全库卡片标签）
        filteredTagGroups() {
            const kw = String(this.pickerFilter || '').trim().toLowerCase();
            const groups = groupTagsByCategory(this.availableTags || []);
            if (!kw) return groups;
            return groups
                .map(g => ({ ...g, tags: g.tags.filter(t => String(t).toLowerCase().includes(kw)) }))
                .filter(g => g.tags.length > 0);
        },
        presetTotal() { return AUTO_GROUP_PROFILE_PRESETS.length; },
        presetSource() { return AUTO_GROUP_PRESET_SOURCE; },

        groupValues() { return (this.groupOptions || []).map(o => o.value); },
        plan() { return (this.scan && this.scan.plan) || null; },
        moves() { return (this.plan && this.plan.moves) || []; },
        visibleMoves() { return this.moves.slice(0, 500); },
        stats() {
            return (this.plan && this.plan.counters)
                || { total: 0, willMove: 0, skipped: 0, conflicts: 0, newFolders: 0, enabledProfiles: 0 };
        },
        conflicts() { return (this.plan && this.plan.conflicts) || []; },
        dupWarnings() { return (this.plan && this.plan.duplicateWarnings) || []; },
        targetGroups() { return (this.plan && this.plan.targetGroups) || []; },
        newFolders() { return this.targetGroups.filter(g => g.isNew).map(g => g.folder); },
        renamedFolders() { return this.targetGroups.filter(g => g.renamed).map(g => `${g.name} → ${g.folder}`); },
        checkedCount() { return this.moves.filter(m => this.isChecked(m)).length; },
        allChecked() { return this.moves.length > 0 && this.checkedCount === this.moves.length; },
        llmMoves() { return this.moves.filter(m => m.source === 'llm'); },
        skippedGroups() {
            const map = new Map();
            for (const s of ((this.plan && this.plan.skipped) || [])) {
                if (!map.has(s.reason)) map.set(s.reason, { reason: s.reason, count: 0, samples: [] });
                const g = map.get(s.reason);
                g.count++;
                if (g.samples.length < 12) g.samples.push(s.cardName);
            }
            return Array.from(map.values()).sort((a, b) => b.count - a.count);
        },
        duplicateGroups() {
            const seen = new Map();
            for (const p of this.localProfiles) {
                const g = String(p.group || '').trim();
                if (!g) continue;
                seen.set(g, (seen.get(g) || 0) + 1);
            }
            return Array.from(seen.entries()).filter(([, n]) => n > 1).map(([g]) => g);
        },
        execPercent() {
            const t = Number(this.exec.total) || 0;
            const d = Number(this.exec.done) || 0;
            return t ? Math.min(100, Math.round(d / t * 100)) : 0;
        }
    },
    watch: {
        show: {
            immediate: true,
            handler(v) {
                if (v) {
                    this.syncLocal();
                    this.presetNote = '';
                    this.confirmReset = false;
                    this.openPickerIdx = -1;
                    this.pickerFilter = '';
                    this.tab = (this.profiles && this.profiles.length) ? 'preview' : 'rules';
                }
            }
        },
        profiles: {
            deep: true,
            handler() { if (this.show) this.syncLocal(); }
        },
        scan: {
            handler(v) {
                if (!v) return;
                this.includeGrouped = !!v.includeGrouped;
                this.excludedIds = {}; // 新计划 → 全部默认勾选
            }
        }
    },
    methods: {
        fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) : '—'; },
        syncLocal() {
            this.localProfiles = (this.profiles || []).map(p => ({
                id: p.id || createProfileId(),
                group: String(p.group || ''),
                enabled: p.enabled !== false,
                match: { type: (p.match && p.match.type) || 'tag', pattern: (p.match && p.match.pattern) || '' },
                note: p.note || '',
                llmCriteria: p.llmCriteria || '', // 🤖 判定标准（留空 = 不参与 AI 判定）
                _wordInput: '',                   // 🆕 多值编辑器：本行输入框中尚未回车提交的词
                _error: ''
            }));
        },
        // 该分组是否已被「其它行」使用（v1 每分组一条规则的 UI 级防呆）
        isGroupUsedByOther(value, idx) {
            return this.localProfiles.some((p, i) => i !== idx && String(p.group || '').trim() === value);
        },
        addProfile() {
            const used = new Set(this.localProfiles.map(p => String(p.group || '').trim()));
            // 默认目标跳过「未分类」——收纳规则的目标应是真实分组（「未分类」只是兜底视图，选它无意义）
            const firstFree = this.groupValues.find(g => !used.has(g) && g !== '未分类') || '';
            this.localProfiles.push({
                id: createProfileId(), group: firstFree, enabled: true,
                match: { type: 'tag', pattern: '' }, note: '', llmCriteria: '', _wordInput: '', _error: ''
            });
        },
        removeProfile(idx) { this.localProfiles.splice(idx, 1); },
        // 🏷️ 标签点选（2026-09-20 用户需求：收纳条件参考「标签分组」点选形式，不再全靠手填）
        toggleTagPicker(idx) {
            this.openPickerIdx = this.openPickerIdx === idx ? -1 : idx;
            this.pickerFilter = '';
        },
        closeTagPicker() { this.openPickerIdx = -1; this.pickerFilter = ''; },
        // —— 🆕 多值编辑器（2026-09-20 易用性打磨：标签/关键词不再逐个手写、不必懂正则）——
        //    pattern 仍是唯一数据源：多个值以 `|` 连接（tag / name-keyword 判定为「任一命中」）
        wordsOf(p) {
            return String((p && p.match && p.match.pattern) || '').split('|').map(s => s.trim()).filter(Boolean);
        },
        addWord(p, raw) {
            if (!p || !p.match) return;
            const text = String(raw === undefined ? (p._wordInput || '') : (raw || ''));
            const incoming = text.split('|').map(s => s.trim()).filter(Boolean);
            if (!incoming.length) { p._wordInput = ''; return; }
            const words = this.wordsOf(p);
            for (const w of incoming) {
                if (!words.some(x => x.toLowerCase() === w.toLowerCase())) words.push(w);
            }
            p.match.pattern = words.join('|');
            p._wordInput = '';
        },
        onWordEnter(p, ev) {
            if (ev && ev.isComposing) return; // 中文输入法组词期间的回车不提交
            this.addWord(p);
        },
        removeWord(p, w) {
            if (!p || !p.match) return;
            p.match.pattern = this.wordsOf(p).filter(x => x !== w).join('|');
        },
        // 🏷️ 点选：把词语**追加**进多值列表（不关面板，可连点多词）
        pickWord(idx, word) {
            const p = this.localProfiles[idx];
            if (!p || !p.match) return;
            this.addWord(p, word);
        },
        wordPlaceholder(type) {
            return type === 'name-keyword' ? '输入关键词后回车（可多个）…' : '点选或输入标签后回车（可多个）…';
        },
        // ✨ 一键生成 AI 判定标准草稿（本地模板；生成后可直接改）
        genLlmCriteria(p) {
            if (!p || !p.match) return;
            const g = String(p.group || '').trim() || '该分组';
            const words = this.wordsOf(p).slice(0, 6);
            const wpart = words.length ? `（涉及 ${words.join('、')} 等要素）` : '';
            let draft;
            switch (p.match.type) {
                case 'hasLorebook': draft = `以「${g}」为主题、且带内嵌世界书的角色卡。`; break;
                case 'hasRegex': draft = `以「${g}」为主题、且带正则脚本的角色卡。`; break;
                case 'name-regex': draft = `名称或内容明显属于「${g}」主题的角色卡${wpart}。`; break;
                case 'name-keyword': draft = `名称隐含「${g}」主题的角色卡${wpart}：符合该主题的设定、剧情或角色关系。`; break;
                default: draft = `以「${g}」为主题的角色卡${wpart}：符合该主题的设定、剧情或角色关系。`;
            }
            p.llmCriteria = draft;
        },
        patternPlaceholder(type) {
            if (type === 'name-regex') return '高级：名称正则（如 ^(?!.*NTR)；只想匹配多个词请改用「名称包含关键词」）';
            return '';
        },
        loadPresets() {
            const presets = buildPresetProfiles(this.groupValues, createProfileId);
            if (!presets.length) {
                this.presetNote = '当前库没有与模板匹配的分组（模板只载入已存在的分组）—— 请先在侧边栏创建/确认分组文件夹。';
                return;
            }
            const key = (p) => `${String(p.group).trim()}\u0000${p.match.type}\u0000${String(p.match.pattern || '').toLowerCase()}`;
            const have = new Set(this.localProfiles.map(key));
            let added = 0, skipped = 0;
            for (const p of presets) {
                if (have.has(key(p))) { skipped++; continue; }
                this.localProfiles.push({ ...p, match: { ...p.match }, _wordInput: '', _error: '' });
                have.add(key(p));
                added++;
            }
            const notInLib = this.presetTotal - presets.length;
            this.presetNote = `已载入 ${added} 条（重复 ${skipped} 条跳过，${notInLib} 条因库中无对应分组未载入）。载入后请逐条检查再保存。`;
        },
        validate() {
            let ok = true;
            const groupSeen = new Map();
            for (const p of this.localProfiles) {
                p._error = '';
                const group = String(p.group || '').trim();
                if (!group) { p._error = '请选择目标分组'; ok = false; continue; }
                const type = p.match && p.match.type;
                if (!this.matchTypeOptions.some(t => t.value === type)) { p._error = '收纳条件类型无效'; ok = false; continue; }
                if (!this.patternlessTypes.includes(type)) {
                    const pattern = String(p.match.pattern || '').trim();
                    if (!pattern) { p._error = '该条件需要填写匹配内容'; ok = false; continue; }
                    if (type === 'name-regex') {
                        try { new RegExp(pattern, 'i'); } catch (e) { p._error = '正则格式非法：' + e.message; ok = false; continue; }
                    }
                }
                groupSeen.set(group, (groupSeen.get(group) || 0) + 1);
            }
            return ok;
        },
        doSave() {
            // 提交各行输入框中未回车的词（防「输入了没按回车 → 保存后丢失」）
            for (const p of this.localProfiles) this.addWord(p);
            if (!this.validate()) return;
            this.$emit('save-profiles', this.localProfiles.map(p => ({
                id: p.id,
                group: String(p.group).trim(),
                enabled: p.enabled !== false,
                match: this.patternlessTypes.includes(p.match.type)
                    ? { type: p.match.type }
                    : { type: p.match.type, pattern: String(p.match.pattern).trim() },
                note: p.note || '',
                llmCriteria: String(p.llmCriteria || '').trim() // 🤖 判定标准（留空 = 不参与 AI 判定）
            })));
        },
        doReset() {
            this.confirmReset = false;
            this.localProfiles = [];
            this.presetNote = '';
            this.$emit('reset-profiles');
        },
        doScan() { this.$emit('scan', { includeGrouped: this.includeGrouped }); },
        changeIncludeGrouped(v) {
            this.includeGrouped = !!v;
            this.$emit('scan', { includeGrouped: this.includeGrouped }); // 勾选变化 → 父级重扫，保证预览与执行同源
        },
        toggleCheck(m) {
            const next = { ...this.excludedIds };
            next[m.cardId] = this.isChecked(m); // 当前勾选 → 置为排除；当前未勾 → 置为显式包含
            this.excludedIds = next;
        },
        // 🤖 建议默认不勾选（用户拍板）：规则命中行默认勾选；LLM 建议行默认不勾，可显式勾选
        isChecked(m) {
            const v = this.excludedIds[m.cardId];
            if (v === true) return false;
            if (v === false) return true;
            return m.source !== 'llm';
        },
        setLlmChecked(checked) {
            const next = { ...this.excludedIds };
            for (const m of this.llmMoves) next[m.cardId] = !checked;
            this.excludedIds = next;
        },
        toggleAll(checked) {
            if (checked) {
                // 全选：规则行恢复默认（清除覆盖），🤖 建议行显式包含
                const map = {};
                for (const m of this.moves) if (m.source === 'llm') map[m.cardId] = false;
                this.excludedIds = map;
                return;
            }
            const map = {};
            for (const m of this.moves) map[m.cardId] = true;
            this.excludedIds = map;
        },
        doExecute() {
            const ids = this.moves.filter(m => this.isChecked(m)).map(m => m.cardId);
            if (ids.length) this.$emit('execute', ids);
        },
        retryFailed() {
            const ids = (this.exec.failures || []).map(f => f.cardId).filter(Boolean);
            if (ids.length) this.$emit('execute', ids);
        }
    }
};
</script>
