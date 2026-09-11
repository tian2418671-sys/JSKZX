<!--
  PresetStitchModal 预设缝合中心（子组件）
  三栏工作台：左=源预设池 + ⭐常用库 ／ 中=缝合工作台（staging，行内编辑）／ 右=基座时间线（锚点定位）
  纯展示 + emits；业务逻辑在 usePresetStitch（父级）
-->
<template>
    <div v-if="show" class="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" @click.self="$emit('close')">
        <div class="bg-zinc-950 border border-zinc-700/80 rounded-xl w-full max-w-[1400px] h-[92vh] flex flex-col shadow-2xl overflow-hidden">

            <!-- 标题栏 -->
            <div class="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-gradient-to-r from-sky-500/15 to-transparent">
                <div class="flex items-center gap-3">
                    <span class="text-base font-bold text-sky-400">🧵 预设缝合中心</span>
                    <span class="text-[10px] text-zinc-500">把多条条目缝进目标预设 · prompts 与 prompt_order 双写</span>
                    <button @click="showGuide" class="px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-[10px] text-sky-300 hover:bg-sky-500/20 transition" title="重新显示引导说明（基座 / 冲突 / 落位 / order 分别是什么）">❔ 说明</button>
                </div>
                <button @click="$emit('close')" class="text-zinc-400 hover:text-white text-lg leading-none">✕</button>
            </div>

            <!-- 🧭 流程引导条（可展开详细说明 / 可关闭，关闭状态记忆在本地） -->
            <div v-if="!guideHidden" class="px-5 py-2 border-b border-sky-500/20 bg-sky-500/5 shrink-0 flex items-start gap-2">
                <span class="text-[13px] leading-none shrink-0 mt-0.5">🧭</span>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-[11px] text-sky-200/90">
                        <span class="font-bold shrink-0">缝合流程</span>
                        <span class="shrink-0">① 左上「📚 源预设」勾选 1~N 本</span>
                        <span class="text-zinc-600">→</span>
                        <span class="shrink-0">② 点条目名（或分组「＋全部」）加入中间「🧵 工作台」</span>
                        <span class="text-zinc-600">→</span>
                        <span class="shrink-0">③ 逐条选「冲突决策」与「落位」</span>
                        <span class="text-zinc-600">→</span>
                        <span class="shrink-0 text-emerald-300 font-bold">④ 右下角执行</span>
                    </div>
                    <div v-show="guideExpanded" class="mt-1.5 space-y-0.5 text-[10px] leading-relaxed text-zinc-400">
                        <div>• <b class="text-zinc-300">基座 / 目标</b>：结果的底子。右上角三种模式 —— <b>新建</b>=以「基座预设」为底生成新文件（原件不受影响）；<b>覆盖已有</b>=写回选中的那一本（执行前自动快照，可回滚）；<b>写回当前</b>=只改内存，需自己点保存。</div>
                        <div>• <b class="text-zinc-300">冲突</b>：待缝条目的 <code>identifier</code> 与基座（或工作台内其他条目）同名时会标⚠️，必须逐条选：<b>用来源覆盖</b>（换内容、位置不变）/ <b>保留基座</b>（不写入该条）/ <b>重命名都保留</b>（自动造新标识，两条共存）/ <b>跳过</b>。<b class="text-rose-300">未决策不会执行</b>。</div>
                        <div>• <b class="text-zinc-300">落位</b>：新条目插进结果 order 的哪里 —— <b>追加尾部</b>（最稳）/ <b>按内置序</b>（main→…→jailbreak 位次）/ <b>锚点前·后</b>（先点工作台某行，再点右侧时间线任一条目 = 锚定到它后面）。</div>
                        <div>• <b class="text-zinc-300">为什么 prompts 和 order 会一起重建</b>：酒馆按 <code>prompt_order</code> 里的 identifier+enabled 执行，所以缝合会同时写 <code>prompts[]</code> 与 <code>prompt_order[]</code>；因此「工作台条目数」≠「结果 order 条数」是正常的。</div>
                        <div>• 只想凭空写一条？点「✏️ 新建自定义条目」；常用的可点行尾「⭐」收藏到左下的「⭐ 常用条目库」。</div>
                    </div>
                    <button @click="guideExpanded = !guideExpanded" class="mt-1 text-[10px] text-sky-400 hover:text-sky-300 transition">{{ guideExpanded ? '▴ 收起详细说明' : '▾ 展开详细说明（基座/冲突/落位/order 是什么）' }}</button>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button @click="guideHidden = true" class="text-[10px] text-zinc-500 hover:text-zinc-300 transition" title="本次关闭（重开弹窗会恢复）">✕</button>
                    <button @click="hideGuideForever" class="text-[10px] text-zinc-500 hover:text-zinc-300 transition whitespace-nowrap" title="以后不再显示这条引导">不再提示</button>
                </div>
            </div>

            <!-- 顶部配置条 -->
            <div class="px-5 py-2.5 border-b border-zinc-800 flex flex-wrap items-center gap-3 shrink-0 bg-zinc-900/50">
                <div class="flex items-center gap-1 rounded-lg border border-zinc-700 overflow-hidden text-[11px]">
                    <button v-for="m in targetModes" :key="m.key"
                            @click="$emit('update:targetMode', m.key)"
                            :class="targetMode === m.key ? 'bg-sky-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'"
                            class="px-2.5 py-1.5 transition">{{ m.icon }} {{ m.label }}</button>
                </div>
                <span class="text-[10px] text-zinc-500 leading-tight max-w-[300px]" :title="targetModeHint">{{ targetModeHint }}</span>

                <label v-if="targetMode !== 'current'" class="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <span>{{ targetMode === 'new' ? '基座（继承参数）' : '覆盖目标' }}:</span>
                    <select :value="targetMode === 'new' ? basePath : overwritePath"
                            @change="$emit('update:basePath', $event.target.value)"
                            class="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 max-w-[220px]">
                        <option v-for="p in sourceCandidates" :key="p.path" :value="p.path">{{ (p.data && p.data.name) || p.name }}</option>
                    </select>
                </label>
                <span v-else class="text-[11px] text-amber-400">🎯 写回当前预设：{{ basePreset ? ((basePreset.data && basePreset.data.name) || basePreset.name) : '未打开' }}（内存，需手动保存）</span>

                <label v-if="targetMode === 'new'" class="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <span>新预设名:</span>
                    <input :value="newName" @input="$emit('update:newName', $event.target.value)" type="text" placeholder="缝合预设名"
                           class="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-100 w-48 outline-none focus:border-sky-500">
                </label>

                <div class="flex-1"></div>
                <span class="text-[10px] text-zinc-500">工作台 {{ items.length }} 条 · 冲突 {{ conflictCount }}{{ pendingCount ? ' · ⚠️ 待决策 ' + pendingCount : '' }}</span>
            </div>

            <!-- 三栏主体 -->
            <div class="flex-1 flex overflow-hidden min-h-0">

                <!-- 左：源预设池 + 常用库 -->
                <div class="w-[300px] shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-900/40">
                    <div class="p-2 border-b border-zinc-800 shrink-0 space-y-1.5">
                        <!-- 📚 源预设：下拉多选（展开时在文档流内撑开 → 不会浮层遮挡条目池） -->
                        <div ref="srcBox">
                            <button @click="srcOpen = !srcOpen"
                                    class="w-full h-7 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg px-2 flex items-center gap-2 text-[11px] transition">
                                <span class="font-bold text-sky-400 shrink-0">📚 源预设</span>
                                <span class="flex-1 text-left truncate" :class="sourcePaths.length ? 'text-zinc-200' : 'text-zinc-500'">
                                    {{ sourcePaths.length ? '已选 ' + sourcePaths.length + ' 本' : '未选择（点此多选）' }}
                                </span>
                                <span class="text-zinc-500 text-[9px] shrink-0">{{ sourcePaths.length }}/{{ sourceCandidates.length }}</span>
                                <span class="text-zinc-400 shrink-0 text-[9px]">{{ srcOpen ? '▲' : '▼' }}</span>
                            </button>

                            <div v-if="srcOpen" data-stitch-srcpanel class="mt-1.5 rounded-lg border border-zinc-600 overflow-hidden" style="background-color: #18181b;">
                                <div class="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-700" style="background-color: #09090b;">
                                    <button @click="$emit('select-all-sources')" class="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-sky-600 text-[10px] text-zinc-300 border border-zinc-700 transition">全选</button>
                                    <button @click="$emit('clearSources')" class="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-rose-600 text-[10px] text-zinc-300 border border-zinc-700 transition">清空</button>
                                    <span class="flex-1"></span>
                                    <span class="text-[9px] text-zinc-500">已选 {{ sourcePaths.length }} 本</span>
                                </div>
                                <div class="max-h-[30vh] overflow-y-auto custom-scrollbar" style="background-color: #18181b;">
                                    <label v-for="p in sourceCandidates" :key="p.path"
                                           class="flex items-center gap-2 px-2 py-1 cursor-pointer border-t border-zinc-800 hover:bg-zinc-700/60"
                                           style="background-color: #18181b;">
                                        <input type="checkbox" :checked="sourcePaths.includes(p.path)" @change="$emit('toggle-source', p)" class="accent-sky-500 shrink-0">
                                        <span class="text-[11px] text-zinc-200 truncate flex-1" :title="(p.data && p.data.name) || p.name">{{ (p.data && p.data.name) || p.name }}</span>
                                        <span class="text-[9px] text-zinc-500 shrink-0">{{ promptCountOf(p) }} 条</span>
                                    </label>
                                </div>
                                <div class="px-2 py-1 border-t border-zinc-700 text-[9px] text-zinc-500" style="background-color: #09090b;">勾选后，其条目池会出现在下方</div>
                            </div>
                        </div>

                        <p class="text-[9px] text-zinc-500 leading-relaxed mt-0.5">勾选的本子只被<b class="text-zinc-400">读取</b>，不会被修改；下方出现它们的条目池，点条目即加入工作台。</p>

                        <input :value="poolQuery" @input="$emit('update:poolQuery', $event.target.value)" type="text" placeholder="🔍 搜索条目名 / identifier / 内容…"
                               class="w-full h-7 bg-zinc-900 border border-zinc-700 rounded-lg px-2 text-[11px] text-zinc-200 placeholder-zinc-500 outline-none focus:border-sky-500 transition">
                    </div>

                    <div data-stitch-pool class="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
                        <div v-if="sourcePaths.length === 0" class="text-[10px] text-zinc-500 text-center py-6">请先在上方点选 1 本或多本源预设</div>
                        <div v-for="g in poolGroups" :key="g.path" class="border border-zinc-800 rounded-lg overflow-hidden">
                            <div class="px-2 py-1.5 bg-zinc-900 flex items-center gap-2 cursor-pointer select-none hover:bg-zinc-800/80" @click="toggleGroup(g.path)">
                                <span class="text-[9px] text-zinc-500 shrink-0">{{ isGroupOpen(g.path) ? '▾' : '▸' }}</span>
                                <span class="text-[10px] font-bold text-zinc-300 truncate flex-1" :title="g.name">{{ g.name }}</span>
                                <span class="text-[9px] text-zinc-500 shrink-0">{{ g.total }} 条</span>
                                <button @click.stop="$emit('add-all-from-preset', g)" class="px-1.5 py-0.5 rounded bg-sky-600/80 hover:bg-sky-500 text-white text-[9px] shrink-0" title="把该书全部条目加入工作台">＋全部</button>
                            </div>
                            <div v-show="isGroupOpen(g.path)" class="max-h-[38vh] overflow-y-auto custom-scrollbar">
                                <div v-for="row in g.shown" :key="g.path + '#' + row.srcIndex"
                                     @click="$emit('add-item', row.prompt, g)"
                                     class="px-2 py-1 flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800/70 border-t border-zinc-800/60">
                                    <span class="text-[10px] text-zinc-300 truncate flex-1" :title="row.prompt.name || row.prompt.identifier">{{ row.prompt.name || row.prompt.identifier || '(未命名)' }}</span>
                                    <span v-if="row.prompt.enabled === false" class="text-[9px] text-zinc-500 shrink-0">停用</span>
                                    <span class="text-[9px] text-zinc-600 shrink-0">{{ ((row.prompt.content || '').length / 1024).toFixed(1) }}K</span>
                                    <span class="text-[9px] text-sky-500/70 shrink-0">＋</span>
                                </div>
                            </div>
                        </div>

                        <!-- ⭐ 常用库 -->
                        <div class="border border-amber-500/30 rounded-lg overflow-hidden">
                            <div class="px-2 py-1.5 bg-amber-500/10 flex items-center gap-2">
                                <span class="text-[10px] font-bold text-amber-400 flex-1">⭐ 常用条目库 ({{ snippets.length }})</span>
                                <button @click="$emit('add-custom')" class="px-1.5 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white text-[9px] shrink-0" title="凭空新建一条自定义条目">✏️ 新建条目</button>
                            </div>
                            <div v-if="!snippets.length" class="px-2 py-2 text-[10px] text-zinc-500">还没有常用条目。把工作台里的条目点「⭐」即可收藏复用。</div>
                            <div v-for="s in snippets" :key="s.id" class="px-2 py-1 flex items-center gap-1.5 border-t border-zinc-800/60">
                                <span class="text-[10px] text-zinc-300 truncate flex-1" :title="s.name">{{ s.name }}</span>
                                <button @click="$emit('snippet-insert', s)" class="text-[9px] text-emerald-400 hover:text-emerald-300 shrink-0" title="插入到工作台">📥</button>
                                <button @click="$emit('snippet-rename', s)" class="text-[9px] text-zinc-400 hover:text-zinc-200 shrink-0" title="改名">✏️</button>
                                <button @click="$emit('snippet-delete', s)" class="text-[9px] text-rose-400 hover:text-rose-300 shrink-0" title="删除">🗑</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 中：缝合工作台 -->
                <div class="flex-1 flex flex-col min-w-0">
                    <div class="px-3 py-2 border-b border-zinc-800 flex flex-wrap items-center gap-1.5 shrink-0 bg-zinc-900/60">
                        <span class="text-[11px] font-bold text-emerald-400">🧵 缝合工作台</span>
                        <span class="text-[9px] text-zinc-500">待写入目标预设的条目清单</span>
                        <button @click="$emit('add-custom')" class="h-6 px-2 rounded border border-emerald-600 bg-emerald-600/80 hover:bg-emerald-500 text-white text-[10px] transition" title="凭空写一条新条目（可自定义名称/内容/角色/注入位置等）">✏️ 新建自定义条目</button>
                        <div class="h-4 w-px bg-zinc-700"></div>
                        <span class="text-[10px] text-zinc-500" title="把所有⚠️冲突项一次性设为同一处理方式（之后仍可逐条改）">冲突批量:</span>
                        <button @click="$emit('apply-decision', 'source')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 transition" title="所有冲突项：用来源覆盖基座">✏️ 覆盖</button>
                        <button @click="$emit('apply-decision', 'target')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 transition" title="所有冲突项：保留基座条目">🔒 保留基座</button>
                        <button @click="$emit('apply-decision', 'rename')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 transition" title="所有冲突项：来源改名后一并保留">🔀 都保留</button>
                        <button @click="$emit('apply-decision', 'skip')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 transition" title="所有冲突项：跳过来源">⏭ 跳过</button>
                        <div class="h-4 w-px bg-zinc-700"></div>
                        <span class="text-[10px] text-zinc-500" title="把所有条目一次性设为同一种插入位置；若已选中某行则只作用于该行">落位批量:</span>
                        <button @click="$emit('apply-place', 'append')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 transition" title="追加到结果 order 的最后（最稳，不影响基座原有顺序）">⬇ 尾部</button>
                        <button @click="$emit('apply-place', 'builtin')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 transition" title="按酒馆内置位次插入（main→…→jailbreak）">🏛 内置序</button>
                        <div class="flex-1"></div>
                        <label class="flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer select-none">
                            <input type="checkbox" :checked="conflictOnly" @change="$emit('update:conflictOnly', $event.target.checked)" class="accent-rose-500"> 只看冲突
                        </label>
                        <button @click="$emit('clearItems')" class="h-6 px-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-rose-600/70 text-[10px] text-zinc-300 transition">清空</button>
                    </div>

                    <div class="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                        <div v-if="!items.length" class="h-full flex flex-col items-center justify-center text-zinc-500 gap-2 text-xs px-6">
                            <span class="text-3xl opacity-30">🧵</span>
                            <p class="text-zinc-400">工作台是空的 —— 这里放「准备写入目标预设的条目」</p>
                            <div class="space-y-1 mt-1 text-[10px] leading-relaxed text-zinc-500">
                                <div>① 左上点「📚 源预设」下拉 → 勾选 1~N 本预设（可搜、可全选）</div>
                                <div>② 下方出现条目池 → 点条目名加入这里，或点分组标题的「＋全部」整本加入</div>
                                <div>③ 也可以「✏️ 新建自定义条目」（凭空写一条）或从「⭐ 常用条目库」插入</div>
                                <div>④ 逐条选「冲突决策 / 落位」→ 点右下角 「🚀」执行</div>
                            </div>
                            <p class="text-[10px] text-zinc-600 mt-1">提示：不确定就先「👁 预览缝合结果」，不写盘</p>
                        </div>

                        <div v-for="(it, idx) in items" :key="it.uid"
                             @click="$emit('update:selectedUid', it.uid)"
                             :class="selectedUid === it.uid ? 'border-sky-500/70 bg-sky-500/5' : 'border-zinc-800 bg-zinc-900/50'"
                             class="rounded-lg border transition overflow-hidden">
                            <!-- 行头 -->
                            <div class="flex items-center gap-1.5 px-2 py-1.5">
                                <input type="checkbox" v-model="it.selected" class="accent-emerald-500 shrink-0">
                                <span class="text-[9px] px-1 py-px rounded shrink-0 border"
                                      :class="it.origin === 'custom' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-sky-500/10 text-sky-400 border-sky-500/30'">
                                    {{ it.origin === 'custom' ? '✏️ 自定义' : '📚 ' + (it.sourceName || '源') }}
                                </span>
                                <input v-model="it.name" type="text" placeholder="条目名称"
                                       class="flex-1 min-w-[80px] bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-sky-500 text-[11px] text-zinc-100 outline-none px-1 py-0.5">

                                <span v-if="it.conflict"
                                      class="text-[9px] px-1.5 py-0.5 rounded shrink-0 border"
                                      :class="it.conflict.builtin ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'"
                                      :title="'与' + (it.conflict.type === 'base' ? '基座' : '工作台内其他条目') + '同名：' + it.conflict.withName + (it.conflict.builtin ? '（内置 identifier，注意别覆盖了基座的核心提示词）' : '') + ' —— 需要选择处理方式'">
                                    ⚠️ 冲突{{ it.conflict.builtin ? '(内置)' : '' }}
                                </span>
                                <select v-if="it.conflict" v-model="it.decision"
                                        class="h-6 rounded border text-[10px] px-1 shrink-0"
                                        :title="'与 ' + it.conflict.withName + ' 同名（' + (it.conflict.type === 'base' ? '在基座中' : '在工作台内') + '）。用来源覆盖 = 换内容留原位置；保留基座 = 这条不写入；重命名都保留 = 造新标识两条共存；跳过 = 忽略来源这条'"
                                        :class="it.decision ? 'bg-zinc-800 border-zinc-700 text-zinc-200' : 'bg-rose-600/30 border-rose-500 text-rose-200'">
                                    <option value="">— 待决策 —</option>
                                    <option value="source">✏️ 用来源覆盖</option>
                                    <option value="target">🔒 保留基座</option>
                                    <option value="rename">🔀 重命名都保留</option>
                                    <option value="skip">⏭ 跳过来源</option>
                                </select>
                                <select v-else v-model="it.decision" class="hidden"></select>

                                <select v-model="it.place" class="h-6 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 px-1 shrink-0" title="落位：新条目插到结果的哪个位置（追加尾部 / 按酒馆内置位次 / 锚点前·后）">
                                    <option value="append">⬇ 追加尾部</option>
                                    <option value="builtin">🏛 按内置序</option>
                                    <option value="after">📍 锚点之后</option>
                                    <option value="before">📍 锚点之前</option>
                                </select>
                                <span class="text-[9px] text-zinc-500 shrink-0 max-w-[110px] truncate" :title="'锚点：' + anchorLabelFn(it.anchorUid)">{{ it.anchorUid ? '📍' : '' }}</span>
                                <button @click.stop="$emit('snippet-save', it)" class="text-[10px] text-amber-400 hover:text-amber-300 shrink-0" title="⭐ 存为常用条目（以后可从左下常用库一键插入）">⭐</button>
                                <button @click.stop="$emit('move-item', it.uid, -1)" :disabled="idx === 0" class="text-[10px] text-zinc-400 hover:text-white disabled:opacity-25 shrink-0" title="上移（影响工作台顺序，仅对「追加尾部」的条目生效）">↑</button>
                                <button @click.stop="$emit('move-item', it.uid, 1)" :disabled="idx === items.length - 1" class="text-[10px] text-zinc-400 hover:text-white disabled:opacity-25 shrink-0" title="下移（影响工作台顺序，仅对「追加尾部」的条目生效）">↓</button>
                                <button @click.stop="toggleExpand(it)" class="text-[10px] text-zinc-400 hover:text-sky-300 shrink-0" :title="it._expanded ? '收起（编辑 名称/内容/标识/注入参数）' : '展开编辑名称 / 内容 / 标识 / 注入位置 / 落位'">{{ it._expanded ? '▾' : '▸' }}</button>
                                <button @click.stop="$emit('remove-item', it.uid)" class="text-[10px] text-rose-400 hover:text-rose-300 shrink-0" title="从工作台移除（不影响源预设）">🗑</button>
                            </div>

                            <!-- 行体（展开编辑） -->
                            <div v-if="it._expanded" class="px-2 pb-2 pt-1 border-t border-zinc-800/70 space-y-1.5">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400">
                                        角色
                                        <select v-model="it.role" class="h-6 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1">
                                            <option value="system">system</option>
                                            <option value="user">user</option>
                                            <option value="assistant">assistant</option>
                                        </select>
                                    </label>
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer">
                                        <input type="checkbox" v-model="it.enabled" class="accent-emerald-500"> 启用
                                    </label>
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400">
                                        注入位置
                                        <select v-model.number="it.injection_position" class="h-6 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1">
                                            <option :value="0">相对（按深度）</option>
                                            <option :value="1">绝对（按顺序）</option>
                                        </select>
                                    </label>
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400">深度<input v-model.number="it.injection_depth" type="number" class="h-6 w-14 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1"></label>
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400">顺序<input v-model.number="it.injection_order" type="number" class="h-6 w-14 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1"></label>
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer" title="marker 标记条目（不产生内容，仅作分割/锚点）">
                                        <input type="checkbox" v-model="it.marker" class="accent-amber-500"> marker
                                    </label>
                                    <label class="flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer" title="允许系统提示词覆盖（injections）">
                                        <input type="checkbox" v-model="it.forbid_overrides" class="accent-amber-500"> 禁止覆盖
                                    </label>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-[10px] text-zinc-500 shrink-0">标识</span>
                                    <input v-model="it.identifier" @change="$emit('refresh-conflicts')" type="text"
                                           class="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 font-mono text-[10px] text-zinc-300 outline-none focus:border-sky-500"
                                           :title="it.identifier">
                                    <button @click="regenIdentifier(it)" class="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[9px] text-zinc-300 border border-zinc-700 shrink-0" title="生成新的唯一标识（避免覆盖基座同名条目）">🔄</button>
                                </div>
                                <div class="flex items-start gap-2">
                                    <textarea v-model="it.content" rows="4" placeholder="条目内容（AI 实际收到的提示词文本）"
                                              class="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500 resize-y font-mono custom-scrollbar"></textarea>
                                    <div class="flex flex-col gap-1 shrink-0">
                                        <button @click="$emit('open-text-modal', `🧵 ${it.name || '条目'} 内容`, it, 'content')"
                                                class="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[10px] text-sky-300 whitespace-nowrap">🔍 放大</button>
                                        <span class="text-[9px] text-zinc-500 text-center">{{ ((it.content || '').length / 1024).toFixed(1) }}K</span>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-[10px] text-zinc-500">落位：</span>
                                    <span class="text-[10px] text-zinc-300">{{ it.place === 'append' ? '追加到尾部' : it.place === 'builtin' ? '按内置序插入' : (it.place === 'after' ? '插到锚点之后' : '插到锚点之前') }}</span>
                                    <span class="text-[10px] text-zinc-500">锚点：{{ anchorLabelFn(it.anchorUid) }}</span>
                                    <button @click="$emit('set-anchor-hint', it)" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-sky-700 border border-zinc-700 text-[10px] text-zinc-300">→ 右栏点选锚点</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 右：基座时间线（锚点定位） -->
                <div class="w-[280px] shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-900/40">
                    <div class="px-2 py-2 border-b border-zinc-800 shrink-0">
                        <div class="flex items-center gap-1.5">
                            <span class="text-[11px] font-bold text-amber-400">🎯 基座时间线</span>
                            <span class="text-[9px] text-zinc-500">{{ baseTimeline.length }} 条</span>
                        </div>
                        <p class="text-[9px] text-zinc-500 mt-0.5 truncate">{{ basePreset ? ((basePreset.data && basePreset.data.name) || basePreset.name) : '未选择基座' }}</p>
                        <p class="text-[9px] text-sky-400/80 mt-1">点任意条目 = 把工作台当前选中项<b>锚定到它后面</b></p>
                        <p class="text-[9px] text-zinc-500 mt-0.5">结果以此预设为底子：这里原有的条目会<b class="text-zinc-400">原样保留</b>，工作台条目只是插进去/覆盖同名项</p>
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
                        <div v-for="t in baseTimeline" :key="t.identifier"
                             @click="$emit('set-anchor', 'b:' + t.identifier)"
                             class="px-2 py-1 rounded cursor-pointer hover:bg-zinc-800/80 border border-transparent flex items-center gap-1.5"
                             :title="t.identifier">
                            <span class="text-[9px] text-zinc-600 w-5 shrink-0 font-mono">{{ t.index + 1 }}</span>
                            <span class="text-[10px] truncate flex-1" :class="t.enabled ? 'text-zinc-200' : 'text-zinc-500 line-through'">{{ t.name }}</span>
                            <span v-if="t.isBuiltin" class="text-[8px] px-1 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">内置</span>
                            <span v-if="t.missing" class="text-[8px] text-rose-400 shrink-0" title="order 中的该 identifier 在 prompts 里找不到">?</span>
                        </div>
                        <div v-if="!baseTimeline.length" class="text-[10px] text-zinc-500 text-center py-6">基座无条目（新建预设将只用工作台内容）</div>
                    </div>
                </div>
            </div>

            <!-- 底部：干跑摘要 + 执行 -->
            <div class="border-t border-zinc-800 shrink-0 bg-zinc-900/60">
                <div class="px-4 py-2 flex items-center gap-3 flex-wrap">
                    <span class="text-[11px]" :class="plan && plan.ok && !plan.stats.pending ? 'text-emerald-400' : 'text-amber-400'" title="新增=写入的新条目；覆盖=替换基座同名条目的内容；重命名=冲突项改名后两条都保留；跳过=不写入；结果 prompts/order=执行后的总条数">{{ summary }}</span>
                    <button @click="$emit('update:showPlanDetail', !showPlanDetail)" class="text-[10px] text-sky-400 hover:text-sky-300" title="展开完整结果 order 列表（不写盘，可反复看）">👁 {{ showPlanDetail ? '收起结果预览' : '预览缝合结果' }}</button>
                    <div class="flex-1"></div>
                    <button @click="$emit('close')" class="px-3 py-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition">取消</button>
                    <button @click="$emit('execute')" :disabled="busy || !plan || !plan.ok || plan.stats.pending > 0 || (plan.stats.added + plan.stats.overwritten === 0)"
                            class="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-bold shadow transition">
                        {{ busy ? '⏳ 缝合中…' : (targetMode === 'new' ? '🚀 生成新预设' : targetMode === 'overwrite' ? '🚀 覆盖写入（先快照）' : '🚀 写回当前预设') }}
                    </button>
                </div>
                <div v-if="showPlanDetail" class="border-t border-zinc-700/70 bg-zinc-950 flex flex-col shrink-0">
                    <div class="px-4 py-1.5 flex items-center gap-3 flex-wrap text-[10px] text-zinc-400 border-b border-zinc-800/70 bg-zinc-900/60 shrink-0">
                        <span class="font-bold text-sky-400">👁 缝合结果预览</span>
                        <span>共 <b class="text-zinc-200">{{ previewStats.total }}</b> 条</span>
                        <span class="text-zinc-700">|</span>
                        <span>🔒 基座 {{ previewStats.fromBase }}</span>
                        <span>📚 来源 {{ previewStats.fromSource }}</span>
                        <span>✏️ 自定义 {{ previewStats.fromCustom }}</span>
                        <span class="text-emerald-400">🆕 新增 {{ (plan && plan.stats) ? plan.stats.added : 0 }}</span>
                        <span class="text-amber-400">✏️ 覆盖 {{ (plan && plan.stats) ? plan.stats.overwritten : 0 }}</span>
                        <label class="flex items-center gap-1 cursor-pointer select-none">
                            <input type="checkbox" :checked="planChangedOnly" @change="$emit('update:planChangedOnly', $event.target.checked)" class="accent-sky-500"> 只看改动
                        </label>
                        <span class="flex-1"></span>
                        <button @click="$emit('update:showPlanDetail', false)" class="text-zinc-400 hover:text-white transition">✕ 收起</button>
                    </div>
                    <div class="h-[40vh] overflow-auto custom-scrollbar">
                        <table class="w-full text-[11px] border-collapse">
                            <thead class="text-zinc-500 sticky top-0 bg-zinc-900 z-10">
                                <tr>
                                    <th class="text-left py-1.5 px-2 w-12 font-normal">#</th>
                                    <th class="text-left px-2 font-normal min-w-[240px]">条目名称</th>
                                    <th class="text-left px-2 font-normal min-w-[320px]">identifier</th>
                                    <th class="text-left px-2 w-16 font-normal">启用</th>
                                    <th class="text-left px-2 w-20 font-normal">大小</th>
                                    <th class="text-left px-2 w-48 font-normal">来源</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="row in previewRows" :key="row.i"
                                    class="border-t border-zinc-800/50 hover:bg-zinc-900/60"
                                    :class="row.isNew ? 'bg-emerald-500/5' : (row.isOverwritten ? 'bg-amber-500/5' : '')">
                                    <td class="py-1 px-2 text-zinc-600 font-mono">{{ row.i }}</td>
                                    <td class="px-2 text-zinc-200" :title="row.name">{{ row.name }}</td>
                                    <td class="px-2 text-zinc-500 font-mono whitespace-nowrap">{{ row.identifier }}</td>
                                    <td class="px-2" :class="row.enabled ? 'text-emerald-400' : 'text-zinc-500'">{{ row.enabled ? '启用' : '停用' }}</td>
                                    <td class="px-2 text-zinc-500">{{ (row.contentLen / 1024).toFixed(1) }}K</td>
                                    <td class="px-2">
                                        <span v-if="row.isNew" class="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 mr-1">🆕 新增</span>
                                        <span v-else-if="row.isOverwritten" class="text-[9px] px-1 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 mr-1">✏️ 覆盖</span>
                                        <span class="text-zinc-400">{{ row.from }}</span>
                                    </td>
                                </tr>
                                <tr v-if="!previewRows.length">
                                    <td colspan="6" class="px-2 py-8 text-center text-zinc-500">没有符合条件的条目（试试取消「只看改动」）</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'PresetStitchModal',
    props: {
        show: { type: Boolean, default: false },
        targetMode: { type: String, default: 'new' },
        basePath: { type: String, default: '' },
        overwritePath: { type: String, default: '' },
        newName: { type: String, default: '' },
        sourcePaths: { type: Array, default: () => [] },
        sourceCandidates: { type: Array, default: () => [] },
        poolQuery: { type: String, default: '' },
        poolGroups: { type: Array, default: () => [] },
        items: { type: Array, default: () => [] },
        selectedUid: { type: String, default: '' },
        conflictOnly: { type: Boolean, default: false },
        showPlanDetail: { type: Boolean, default: false },
        busy: { type: Boolean, default: false },
        snippets: { type: Array, default: () => [] },
        basePreset: { type: Object, default: null },
        baseTimeline: { type: Array, default: () => [] },
        plan: { type: Object, default: null },
        summary: { type: String, default: '' },
        conflictCount: { type: Number, default: 0 },
        pendingCount: { type: Number, default: 0 },
        // 👁 预览面板：只看改动 + 过滤后的行 + 来源分布统计
        planChangedOnly: { type: Boolean, default: false },
        previewRows: { type: Array, default: () => [] },
        previewStats: { type: Object, default: () => ({ total: 0, fromBase: 0, fromSource: 0, fromCustom: 0, changed: 0 }) },
        // 锚点标签解析函数（由父级注入：uid → 可读文案）
        anchorLabelFn: { type: Function, default: () => '未设置' }
    },
    emits: [
        'close', 'execute',
        'update:targetMode', 'update:basePath', 'update:newName', 'update:poolQuery',
        'update:selectedUid', 'update:conflictOnly', 'update:showPlanDetail', 'update:planChangedOnly',
        'toggle-source', 'clearSources', 'select-all-sources', 'add-item', 'add-all-from-preset', 'add-custom', 'clearItems',
        'remove-item', 'move-item', 'refresh-conflicts', 'apply-decision', 'apply-place', 'set-anchor', 'set-anchor-hint',
        'open-text-modal',
        'snippet-insert', 'snippet-save', 'snippet-rename', 'snippet-delete'
    ],
    data() {
        return {
            srcOpen: false,          // 📚 源预设下拉是否展开
            openGroups: {},          // 条目池分组折叠状态（key=预设 path，默认展开）
            guideHidden: false,      // 🧭 流程引导条是否隐藏
            guideExpanded: true,     // 引导条里的详细说明是否展开（首次默认开，方便上手）
            targetModes: [
                { key: 'new', icon: '🆕', label: '新建预设' },
                { key: 'overwrite', icon: '💾', label: '覆盖已有' },
                { key: 'current', icon: '🎯', label: '写回当前' }
            ]
        };
    },
    computed: {
        // 当前目标模式的一句话说明（降低理解成本）
        targetModeHint() {
            if (this.targetMode === 'overwrite') return '写回选中的那一本（执行前自动快照，可回滚）';
            if (this.targetMode === 'current') return '只改内存不落盘：执行后需手动点「💾 保存」';
            return '以「基座」为底生成新文件；原预设不受影响（参数/文本模板等一并继承）';
        }
    },
    watch: {
        // 弹窗每次打开：收起源预设下拉（否则会沿用上次的展开状态，一开窗就遮住条目池）+ 恢复引导条偏好
        show(v) {
            if (!v) return;
            this.srcOpen = false;
            let hidden = false;
            try { hidden = localStorage.getItem('stt-stitch-guide-hidden') === '1'; } catch (e) { hidden = false; }
            this.guideHidden = hidden;
            this.guideExpanded = !hidden;
        }
    },
    mounted() {
        // 点击下拉外部关闭（否则遮住条目池）
        this._onDocClick = (e) => {
            if (this.srcOpen && this.$refs.srcBox && !this.$refs.srcBox.contains(e.target)) this.srcOpen = false;
        };
        document.addEventListener('click', this._onDocClick);
    },
    unmounted() {
        if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
    },
    methods: {
        // 重新显示引导说明（顶部「❔ 说明」按钮）
        showGuide() {
            this.guideHidden = false;
            this.guideExpanded = true;
        },
        // 以后不再显示引导条（记住偏好）
        hideGuideForever() {
            this.guideHidden = true;
            try { localStorage.setItem('stt-stitch-guide-hidden', '1'); } catch (e) { /* 忽略 */ }
        },
        // 该源预设含多少条提示词（下拉里显示）
        promptCountOf(p) {
            const list = p && p.data && Array.isArray(p.data.prompts) ? p.data.prompts : [];
            return list.length;
        },
        isGroupOpen(path) { return this.openGroups[path] !== false; },
        toggleGroup(path) { this.openGroups[path] = !this.isGroupOpen(path); },
        // 展开/收起行体（UI 状态挂在 item 上，不落盘；_ 前缀字段写盘时会被 main.js 剔除）
        toggleExpand(it) {
            it._expanded = !it._expanded;
        },
        // 重新生成唯一标识（防误覆盖基座同名条目）
        regenIdentifier(it) {
            let id = '';
            try {
                if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') id = crypto.randomUUID();
            } catch (e) { /* 忽略 */ }
            if (!id) id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
            it.identifier = id;
            it.decision = '';
            this.$emit('refresh-conflicts');
        }
    }
};
</script>
