<!--
  ChatTestSidebar 测卡工作区侧边栏（桌面版，可折叠右侧抽屉）
  ─────────────────────────────────────────────────────────────
  对应移动版 TestSidebar.vue 的 7 个分区：配置 / 正则 / 世界书 / 变量 / 聊天 / 设置 / 插件
  （移动版用 Vant 组件，桌面端按项目规范重写为 Tailwind + Options API + props/emit）

  设计约定：
    - 「自己就能闭环」的持久化操作（预设激活/条目开关/会话增删改/插件增删改/设置项/变量树编辑）
      直接import引擎函数在组件内完成 —— 这些天然自洽，绕一圈 emit 只会增加出错面；
    - 「影响卡片/聊天管线」的操作（正则开关、世界书条目开关、变量重置）走 emit 交父级，
      因为它们要写回 cardData 或重建引擎实例（父级才是状态所有者）。
-->
<template>
    <!-- 折叠态：右侧贴边竖排拉手 -->
    <button v-if="!visible"
            @click="$emit('update:visible', true)"
            class="shrink-0 w-7 h-full bg-zinc-900 border-l border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 flex items-center justify-center transition"
            :title="'展开测卡工作区侧边栏'">
        <span class="text-[11px] tracking-widest [writing-mode:vertical-rl]">⚙ 测卡工作区</span>
    </button>

    <!-- 展开态：抽屉 -->
    <div v-else class="shrink-0 h-full bg-zinc-950 border-l border-zinc-800 flex flex-col" :style="{ width: width + 'px' }">
        <!-- 顶部：标题 + 分区 tab（自绘 tab 栏，不用 van-tabs） -->
        <div class="shrink-0 border-b border-zinc-800 bg-zinc-900/60">
            <div class="px-3 py-1.5 flex items-center gap-2">
                <span class="text-[11px] font-bold text-cyan-400">⚙ 测卡工作区</span>
                <span v-if="activePresetName" class="text-[10px] px-1.5 py-px rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 truncate max-w-[120px]">{{ activePresetName }}</span>
                <button @click="$emit('update:visible', false)" class="ml-auto text-zinc-500 hover:text-white text-sm leading-none" title="收起">✕</button>
            </div>
            <div class="flex flex-wrap border-t border-zinc-800/60">
                <div v-for="t in SECTIONS" :key="t.key"
                     @click="activeTab = t.key"
                     class="px-2.5 py-1.5 text-[10px] cursor-pointer border-b-2 transition select-none"
                     :class="activeTab === t.key
                        ? 'text-cyan-400 border-cyan-500 bg-cyan-500/5 font-bold'
                        : 'text-zinc-500 border-transparent hover:text-zinc-300'">
                    {{ t.icon }} {{ t.label }}
                </div>
            </div>
        </div>

        <!-- 分区内容 -->
        <div ref="bodyRef" class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2.5 space-y-2">

            <!-- ============ 1. 配置（预设与参数） ============ -->
            <template v-if="activeTab === 'config'">
                <div class="flex items-center gap-1.5">
                    <select :value="activePresetName"
                            @change="onPresetSelect($event.target.value)"
                            class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-cyan-500">
                        <option value="">（不使用预设）</option>
                        <option v-for="p in presetOptions" :key="p.key" :value="p.key">{{ p.name }}</option>
                    </select>
                    <button @click="clearPreset"
                            :disabled="!activePresetName"
                            class="px-2 py-1 rounded text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed hover:border-red-500/60 hover:text-red-300 transition"
                            title="清除激活的预设">清空</button>
                </div>
                <p v-if="!arr(presetOptions).length" class="text-[10px] text-zinc-500 leading-relaxed">
                    未检测到预设。请先在左侧「预设」库中导入预设，或到桌面「预设缝合中心」添加。
                </p>

                <template v-if="activePresetPrompts.length">
                    <div class="flex items-center justify-between pt-1">
                        <span class="text-[10px] font-bold text-zinc-400">预设条目（{{ enabledPromptCount }}/{{ activePresetPrompts.length }} 条启用）</span>
                        <button @click="ppAllExpanded = !ppAllExpanded" class="text-[10px] text-cyan-400 hover:text-cyan-300">{{ ppAllExpanded ? '全部收起' : '全部展开' }}</button>
                    </div>
                    <div class="space-y-1">
                        <div v-for="(p, i) in activePresetPrompts" :key="ppKey(p, i)"
                             class="bg-zinc-900/60 border border-zinc-800 rounded">
                            <div class="flex items-center gap-1.5 px-2 py-1.5">
                                <input type="checkbox" :checked="ppEnabled(p)" @change="togglePrompt(p, i, $event.target.checked)"
                                       class="rounded bg-zinc-900 border-zinc-700 text-cyan-500 focus:ring-0 shrink-0">
                                <span class="text-[11px] truncate flex-1 min-w-0" :class="ppEnabled(p) ? 'text-zinc-200' : 'text-zinc-500 line-through'">
                                    {{ p.name || p.identifier || ('条目' + (i + 1)) }}
                                </span>
                                <span class="text-[9px] px-1 rounded shrink-0"
                                      :class="roleClass(p.role)">{{ p.role || 'system' }}</span>
                                <button @click="ppExpanded[ppKey(p, i)] = !ppExpanded[ppKey(p, i)]"
                                        class="text-zinc-500 hover:text-zinc-300 text-[10px] shrink-0">{{ ppExpanded[ppKey(p, i)] ? '▲' : '▼' }}</button>
                            </div>
                            <div v-if="ppExpanded[ppKey(p, i)]" class="px-2 pb-2 space-y-1.5 border-t border-zinc-800/60 pt-1.5">
                                <div class="flex items-center gap-1">
                                    <span class="text-[9px] text-zinc-500 shrink-0">role</span>
                                    <select :value="p.role || 'system'" @change="setPromptRole(p, $event.target.value)"
                                            class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300 outline-none">
                                        <option value="system">system</option>
                                        <option value="user">user</option>
                                        <option value="assistant">assistant</option>
                                    </select>
                                </div>
                                <pre class="text-[10px] text-zinc-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scrollbar bg-zinc-950/60 rounded p-1.5 font-mono">{{ p.content || '(空内容)' }}</pre>
                            </div>
                        </div>
                    </div>
                    <p class="text-[9px] text-zinc-600 leading-relaxed">开关会同时写 prompt 自身与 prompt_order（含嵌套分组），保证导入的预设也真正生效。</p>
                </template>

                <div v-if="Object.keys(paramOverrides).length || true" class="pt-1">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold text-zinc-400">参数覆盖</span>
                        <button @click="resetParams" class="text-[10px] text-zinc-500 hover:text-red-300">全部还原</button>
                    </div>
                    <div class="space-y-1 mt-1">
                        <div v-for="k in PARAM_KEYS" :key="k.key" class="flex items-center gap-1.5">
                            <span class="text-[10px] text-zinc-400 w-[92px] shrink-0" :title="k.hint">{{ k.label }}</span>
                            <input type="number" :step="k.step" :min="k.min" :max="k.max"
                                   :value="paramOverrides[k.key] !== undefined ? paramOverrides[k.key] : ''"
                                   :placeholder="k.ph"
                                   @input="onParamInput(k.key, $event.target.value)"
                                   class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-cyan-500">
                        </div>
                    </div>
                    <p class="text-[9px] text-zinc-600 leading-relaxed mt-1">留空 = 使用预设自带值；填了则覆盖预设。</p>
                </div>
            </template>

            <!-- ============ 2. 正则 ============ -->
            <template v-else-if="activeTab === 'regex'">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] font-bold text-zinc-400">生效正则（{{ enabledRegexCount }}/{{ arr(regexList).length }}）</span>
                    <span class="text-[9px] text-zinc-600">卡内 + 预设 + 插件</span>
                </div>
                <p v-if="!arr(regexList).length" class="text-[10px] text-zinc-500">本卡与当前预设都没有正则脚本。</p>
                <div v-for="(r, i) in regexList" :key="'rx' + i"
                     class="bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 space-y-1">
                    <div class="flex items-center gap-1.5">
                        <input type="checkbox" :checked="!r.disabled" @change="toggleRegex(r)"
                               class="rounded bg-zinc-900 border-zinc-700 text-cyan-500 focus:ring-0 shrink-0">
                        <span class="text-[11px] truncate flex-1 min-w-0" :class="!r.disabled ? 'text-zinc-200' : 'text-zinc-500 line-through'">
                            {{ r.scriptName || ('正则' + (i + 1)) }}
                        </span>
                        <span class="text-[9px] px-1 rounded shrink-0"
                              :class="r._source === 'card' ? 'bg-blue-500/15 text-blue-300' : (r._source === 'preset' ? 'bg-amber-500/15 text-amber-300' : 'bg-purple-500/15 text-purple-300')">
                            {{ r._source === 'card' ? '卡' : (r._source === 'preset' ? '预设' : '插件') }}
                        </span>
                    </div>
                    <div class="flex flex-wrap gap-1 pl-5">
                        <span v-for="pl in (r.placement || [])" :key="pl"
                              class="text-[9px] px-1 rounded bg-zinc-800 text-zinc-400">{{ placementLabel(pl) }}</span>
                    </div>
                    <pre class="text-[9px] text-zinc-500 whitespace-pre-wrap break-all font-mono pl-5 max-h-20 overflow-y-auto custom-scrollbar">{{ r.findRegex }}</pre>
                </div>
            </template>

            <!-- ============ 3. 世界书 ============ -->
            <template v-else-if="activeTab === 'wb'">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] font-bold text-zinc-400">世界书条目（{{ arr(wbList).length }}）</span>
                    <span class="text-[9px] text-zinc-600">{{ wbConstantCount }} 条常驻</span>
                </div>
                <p v-if="!arr(wbList).length" class="text-[10px] text-zinc-500">本卡未内嵌世界书，且未加载独立世界书。测卡时不会注入世界书设定。</p>
                <div v-for="e in wbList" :key="e.key"
                     class="bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 space-y-1">
                    <div class="flex items-center gap-1.5">
                        <input type="checkbox" :checked="e.enabled !== false" @change="$emit('toggle-wb', { key: e.key, enabled: $event.target.checked })"
                               class="rounded bg-zinc-900 border-zinc-700 text-cyan-500 focus:ring-0 shrink-0">
                        <span class="text-[11px] truncate flex-1 min-w-0" :class="e.enabled !== false ? 'text-zinc-200' : 'text-zinc-500 line-through'">
                            {{ e.comment || e.key }}
                        </span>
                        <span v-if="e.constant === true" class="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-300 shrink-0">常驻</span>
                    </div>
                    <div class="flex items-center gap-1 pl-5">
                        <span class="text-[9px] text-zinc-500 shrink-0">位置</span>
                        <select :value="e.position === undefined ? 1 : Number(e.position)"
                                @change="$emit('set-wb-position', { key: e.key, position: Number($event.target.value) })"
                                class="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300 outline-none">
                            <option :value="0">顶</option>
                            <option :value="1">底</option>
                            <option :value="2">记前</option>
                            <option :value="3">@D</option>
                        </select>
                        <span class="text-[9px] text-zinc-500 shrink-0 ml-1">序</span>
                        <input type="number" :value="Number(e.insertion_order) || Number(e.order) || 100"
                               @change="$emit('set-wb-order', { key: e.key, order: Number($event.target.value) })"
                               class="w-14 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300 outline-none">
                    </div>
                    <div class="text-[9px] text-zinc-500 pl-5 truncate" :title="keysOf(e)">🔑 {{ keysOf(e) || '(无常驻/触发词)' }}</div>
                </div>
            </template>

            <!-- ============ 4. 变量 ============ -->
            <template v-else-if="activeTab === 'vars'">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] font-bold text-zinc-400">MVU 变量树</span>
                    <div class="flex gap-1">
                        <button @click="$emit('undo-var')" :disabled="!arr(varsLog).length"
                                class="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 disabled:opacity-40 hover:text-amber-300">撤销</button>
                        <button @click="$emit('reset-vars')"
                                class="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-red-300">重置</button>
                    </div>
                </div>
                <div class="text-[9px] text-zinc-500">
                    {{ varsStats.leaves }} 个值 · {{ varsStats.ops }} 条变更 · 已消费 {{ varsStats.aiCount }} 条 AI 消息
                </div>
                <p v-if="!arr(varRows).length" class="text-[10px] text-zinc-500 leading-relaxed">
                    变量树为空。当 AI 回复包含 <code class="text-cyan-400">&lt;UpdateVariable&gt;</code> 指令块时会自动写入。
                </p>
                <div v-for="row in varRows" :key="row.path" class="flex items-center gap-1 group">
                    <span class="shrink-0" :style="{ width: (row.depth * 10) + 'px' }"></span>
                    <span class="text-[10px] shrink-0" :class="row.isLeaf ? 'text-cyan-400' : 'text-amber-400'">{{ row.isLeaf ? '•' : (row.expanded ? '▾' : '▸') }}</span>
                    <button class="text-[10px] truncate text-left shrink-0 max-w-[38%]"
                            :class="row.isLeaf ? 'text-zinc-300' : 'text-amber-300 font-bold'"
                            @click="row.isLeaf ? null : $emit('toggle-var-node', row.path)"
                            :title="row.path">{{ row.label }}</button>
                    <template v-if="row.isLeaf">
                        <input :value="row.value === undefined ? '' : row.value"
                               @change="$emit('set-var', { path: row.path, value: coerce($event.target.value, row.value) })"
                               class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-cyan-500">
                        <span class="text-[9px] text-zinc-600 shrink-0">{{ typeName(row.value) }}</span>
                    </template>
                </div>

                <div v-if="arr(varsLog).length" class="pt-1.5 border-t border-zinc-800">
                    <div class="text-[10px] font-bold text-zinc-400 mb-1">变更日志（最近 {{ arr(varsLog).length }} 条）</div>
                    <div v-for="(log, i) in varsLog" :key="'lg' + i" class="text-[9px] text-zinc-500 font-mono truncate">
                        <span class="text-zinc-600">#{{ log.ai }}</span>
                        <span v-for="(op, j) in (log.ops || [])" :key="j" class="ml-1">
                            {{ op.type }}<span class="text-cyan-600">{{ op.path || '' }}</span>
                        </span>
                    </div>
                </div>
            </template>

            <!-- ============ 5. 聊天会话 ============ -->
            <template v-else-if="activeTab === 'chat'">
                <button @click="createNewSession"
                        class="w-full px-2 py-1.5 rounded text-[11px] font-bold bg-cyan-600 hover:bg-cyan-500 text-white transition">＋ 新建聊天</button>
                <p v-if="!arr(sessions).length" class="text-[10px] text-zinc-500">还没有会话。发送第一条消息时会自动创建。</p>
                <div v-for="s in sessions" :key="s.id"
                     @click="switchSession(s.id)"
                     class="group flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer border transition"
                     :class="s.id === activeSessionId
                        ? 'bg-cyan-500/10 border-cyan-500/40'
                        : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-700'">
                    <div class="flex-1 min-w-0">
                        <div class="text-[11px] truncate" :class="s.id === activeSessionId ? 'text-cyan-300 font-bold' : 'text-zinc-300'">{{ s.name }}</div>
                        <div class="text-[9px] text-zinc-600">{{ arr(s.messages).length }} 条 · {{ fmtTime(s.updatedAt) }}</div>
                    </div>
                    <button @click.stop="renameSession(s)" class="text-zinc-500 hover:text-zinc-300 text-[11px] shrink-0" title="重命名">✎</button>
                    <button @click.stop="removeSession(s)" class="text-zinc-500 hover:text-red-400 text-[11px] shrink-0" title="删除">🗑</button>
                </div>
            </template>

            <!-- ============ 6. 设置 ============ -->
            <template v-else-if="activeTab === 'settings'">
                <div class="text-[10px] font-bold text-zinc-400">接口</div>
                <div class="space-y-1">
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">协议</span>
                        <select :value="apiType" @change="$emit('set-api-type', $event.target.value)"
                                class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none">
                            <option value="openai">OpenAI 兼容</option>
                            <option value="anthropic">Anthropic</option>
                        </select>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">Endpoint</span>
                        <input :value="apiEndpoint" @change="$emit('set-api-endpoint', $event.target.value)"
                               class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-cyan-500 font-mono">
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">API Key</span>
                        <input type="password" :value="apiKey" @change="$emit('set-api-key', $event.target.value)"
                               placeholder="（留空则不发送）"
                               class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-cyan-500 font-mono">
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">模型</span>
                        <input :value="apiModel" @change="$emit('set-api-model', $event.target.value)"
                               class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-cyan-500 font-mono">
                    </div>
                </div>
                <p class="text-[9px] text-zinc-600">与桌面「API 设置」共用同一份配置（app_config.json 为权威），改这里等于改全局。</p>

                <div class="text-[10px] font-bold text-zinc-400 pt-1.5 border-t border-zinc-800">对话</div>
                <div class="space-y-1">
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">AI 回复数</span>
                        <input type="number" min="1" max="10" :value="replyCount" @change="setReplyCount($event.target.value)"
                               class="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none">
                        <span class="text-[9px] text-zinc-600">每条生成几个候选（swipe）</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">隐藏楼层</span>
                        <input type="number" min="0" max="200" :value="maxFloors" @change="setMaxFloors($event.target.value)"
                               class="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none">
                        <span class="text-[9px] text-zinc-600">0=全发；N=只发最近 N 层</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">用户名</span>
                        <input :value="userName" @change="setUserName($event.target.value)"
                               class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-cyan-500">
                    </div>
                    <div>
                        <span class="text-[10px] text-zinc-400">用户人设（宏 <code class="text-cyan-500" v-text="PERSONA_MACRO"></code>）</span>
                        <textarea :value="userPersona" @change="setUserPersona($event.target.value)" rows="3"
                                  placeholder="例如：我是这里的常客，性格随和。"
                                  class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-cyan-500 resize-y custom-scrollbar"></textarea>
                    </div>
                </div>

                <div class="text-[10px] font-bold text-zinc-400 pt-1.5 border-t border-zinc-800">引擎开关</div>
                <label v-for="f in FEATURE_FLAGS" :key="f.key" class="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" :checked="f.get()" @change="f.set($event.target.checked)"
                           class="mt-0.5 rounded bg-zinc-900 border-zinc-700 text-cyan-500 focus:ring-0 shrink-0">
                    <span class="text-[10px] text-zinc-300 leading-snug">{{ f.label }}<span class="block text-[9px] text-zinc-600">{{ f.hint }}</span></span>
                </label>

                <div class="text-[10px] font-bold text-zinc-400 pt-1.5 border-t border-zinc-800">长期记忆</div>
                <label class="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" :checked="memEnabled" @change="onMemToggle($event.target.checked)"
                           class="mt-0.5 rounded bg-zinc-900 border-zinc-700 text-cyan-500 focus:ring-0 shrink-0">
                    <span class="text-[10px] text-zinc-300 leading-snug">启用记忆<span class="block text-[9px] text-zinc-600">发送前检索相关记忆注入 system，发送后记录对话</span></span>
                </label>
                <div class="flex items-center gap-1.5">
                    <span class="text-[10px] text-zinc-400 w-[68px] shrink-0">检索条数</span>
                    <input type="number" min="1" max="200" :value="memLimit" @change="onMemLimit($event.target.value)"
                           class="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 outline-none">
                </div>
                <!-- 记忆库状态（桌面版 memory:* 通道已实现：memory_store.json） -->
                <div class="text-[9px] text-zinc-400 bg-zinc-800/60 border border-zinc-700/70 rounded p-1.5 space-y-1">
                    <div class="flex items-center justify-between gap-2">
                        <span>已存 <b class="text-cyan-300">{{ memStats.total }}</b> 条
                            <span class="text-zinc-500">（事实 {{ memStats.byType.fact || 0 }} · 摘要 {{ memStats.byType.summary || 0 }} · 消息 {{ memStats.byType.message || 0 }}）</span>
                        </span>
                        <button @click="refreshMemStats" class="text-cyan-400 hover:text-cyan-300 shrink-0">刷新</button>
                    </div>
                    <!-- 🧠 v4.1：遗留桶提示（未归属任何卡的旧记忆） -->
                    <div v-if="(memStats.orphans || 0) > 0" class="text-amber-400/90">⚠ {{ memStats.orphans }} 条未归属任何卡的旧记忆（同名多卡/卡已删时不会自动归属）</div>
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-zinc-600">存于 memory_store.json，与卡片配置互相独立</span>
                        <button v-if="!memClearArmed" @click="armMemClear"
                                class="text-rose-400 hover:text-rose-300 shrink-0">清空</button>
                        <button v-else @click="doMemClear"
                                class="text-white bg-rose-600 hover:bg-rose-500 rounded px-1.5 shrink-0">确认清空？</button>
                    </div>
                    <!-- 🧠 记忆查看器（CT-17：逐条查看/删除；默认只看本卡） -->
                    <div class="border-t border-zinc-700/60 pt-1">
                        <div class="flex items-center justify-between gap-2">
                            <span class="font-bold text-zinc-300">记忆列表</span>
                            <div class="flex items-center gap-1">
                                <button @click="memViewMode = 'card'"
                                        :class="memViewMode === 'card' ? 'text-cyan-300' : 'text-zinc-500 hover:text-zinc-300'">只看本卡</button>
                                <span class="text-zinc-700">|</span>
                                <button @click="memViewMode = 'all'"
                                        :class="memViewMode === 'all' ? 'text-cyan-300' : 'text-zinc-500 hover:text-zinc-300'">全部</button>
                            </div>
                        </div>
                        <div v-if="memItemsLoading" class="text-zinc-500 py-1">加载中...</div>
                        <template v-else>
                            <div v-if="!memItems.length" class="text-zinc-600 py-1">{{ memViewMode === 'card' ? '本卡暂无记忆（发送对话后会自动记录）' : '记忆库为空' }}</div>
                            <div v-for="it in memItems" :key="it.id"
                                 class="flex items-start justify-between gap-1.5 py-0.5 border-b border-zinc-800/60 last:border-b-0 group">
                                <div class="min-w-0">
                                    <span class="text-cyan-400/80">{{ it.type === 'fact' ? (it.key || '备忘') : (it.type === 'summary' ? '摘要' : '消息') }}：</span>
                                    <span class="text-zinc-300 break-all">{{ it.content }}</span>
                                    <span v-if="memViewMode === 'all' && !(it.cardPath)" class="ml-1 text-amber-500/80" title="未归属任何卡">◇</span>
                                </div>
                                <button @click="onMemRemove(it)" :disabled="memRemovingId === it.id"
                                        class="text-rose-400/70 hover:text-rose-300 shrink-0 opacity-60 group-hover:opacity-100 disabled:opacity-30"
                                        :title="memRemovingId === it.id ? '删除中...' : '删除这条记忆'">🗑</button>
                            </div>
                        </template>
                    </div>
                </div>
            </template>

            <!-- ============ 7. 插件 ============ -->
            <template v-else-if="activeTab === 'plugins'">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] font-bold text-zinc-400">JSON 扩展插件（{{ arr(pluginList).length }}）</span>
                    <button @click="showPluginImport = !showPluginImport" class="text-[10px] text-cyan-400 hover:text-cyan-300">{{ showPluginImport ? '收起' : '＋ 导入' }}</button>
                </div>
                <div v-if="showPluginImport" class="space-y-1">
                    <textarea v-model="pluginImportText" rows="4" placeholder='粘贴插件 JSON，例如：&#10;{ "name": "我的插件", "systemPrompts": ["额外指令"], "macros": {"{{x}}": "值"} }'
                              class="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-cyan-500 resize-y custom-scrollbar font-mono"></textarea>
                    <div class="flex gap-1">
                        <button @click="importPlugin" class="flex-1 px-2 py-1 rounded text-[10px] font-bold bg-cyan-600 hover:bg-cyan-500 text-white transition">导入</button>
                        <button @click="showPluginImport = false; pluginImportText = ''" class="px-2 py-1 rounded text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-300">取消</button>
                    </div>
                    <p v-if="pluginImportError" class="text-[9px] text-red-400">{{ pluginImportError }}</p>
                </div>
                <p v-if="!arr(pluginList).length" class="text-[10px] text-zinc-500 leading-relaxed">
                    还没有插件。插件是 JSON 格式扩展：可注入额外 system 提示词、自定义宏、批量正则与世界书触发词。
                </p>
                <div v-for="(p, i) in pluginList" :key="'pl' + i"
                     class="bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 space-y-1">
                    <div class="flex items-center gap-1.5">
                        <input type="checkbox" :checked="p.enabled !== false" @change="togglePluginAt(i, $event.target.checked)"
                               class="rounded bg-zinc-900 border-zinc-700 text-cyan-500 focus:ring-0 shrink-0">
                        <span class="text-[11px] truncate flex-1 min-w-0" :class="p.enabled !== false ? 'text-zinc-200' : 'text-zinc-500 line-through'">{{ p.name }}</span>
                        <span class="text-[9px] text-zinc-600 shrink-0">v{{ p.version || '1.0' }}</span>
                        <button @click="removePluginAt(i)" class="text-zinc-500 hover:text-red-400 text-[11px] shrink-0" title="删除">🗑</button>
                    </div>
                    <div v-if="p.description" class="text-[9px] text-zinc-500 pl-5">{{ p.description }}</div>
                    <div class="flex flex-wrap gap-1 pl-5">
                        <span v-if="arr(p.systemPrompts).length" class="text-[9px] px-1 rounded bg-blue-500/15 text-blue-300">{{ arr(p.systemPrompts).length }} 提示词</span>
                        <span v-if="objKeys(p.macros).length" class="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-300">{{ objKeys(p.macros).length }} 宏</span>
                        <span v-if="arr(p.regexScripts).length" class="text-[9px] px-1 rounded bg-amber-500/15 text-amber-300">{{ arr(p.regexScripts).length }} 正则</span>
                        <span v-if="arr(p.worldbookTriggers).length" class="text-[9px] px-1 rounded bg-purple-500/15 text-purple-300">{{ arr(p.worldbookTriggers).length }} 触发词</span>
                    </div>
                </div>
            </template>
        </div>

        <!-- 底部状态条 -->
        <div class="shrink-0 px-2.5 py-1 border-t border-zinc-800 bg-zinc-900/60 flex items-center gap-2 text-[9px] text-zinc-500">
            <span>{{ chatMessageCount }} 条消息</span>
            <span>·</span>
            <span>{{ varsStats.leaves }} 变量</span>
            <span>·</span>
            <span>{{ enabledRegexCount }} 正则</span>
            <span v-if="storageReady" class="ml-auto text-emerald-500">已恢复</span>
            <span v-else class="ml-auto text-amber-500">恢复中…</span>
        </div>
    </div>
</template>

<script>
import {
    getOrderedPrompts, setPromptEnabled, loadActivePreset, saveActivePreset, clearActivePreset
} from '../composables/chat/useChatPresets.js';
import {
    getReplyCount, setReplyCount, getUserName, setUserName, getUserPersona, setUserPersona, getMaxFloors, setMaxFloors
} from '../composables/chat/useChatSettings.js';
import {
    isMemoryEnabled, setMemoryEnabled, getMemoryLimit, setMemoryLimit, getMemoryStats, clearMemory,
    listMemory, removeMemory
} from '../composables/chat/useChatMemory.js';
import {
    loadSessions, setLastSessionId
} from '../composables/chat/useChatSessions.js';
import {
    loadPlugins, savePlugins, parsePlugin, addPlugin, togglePlugin
} from '../composables/chat/useChatPlugins.js';
import { PLACEMENT_LABELS } from '../composables/chat/useChatRegex.js';
import { chatStorage, chatStorageVersion, getChatFlag, setChatFlag } from '../composables/chat/chatStorage.js';

/**
 * ⚠️ 拖拽调宽把手：与桌面 SidebarPanel 同机制的极简实现
 *    （在抽屉左边缘按下 → 拖动改宽 → 松手缓存进组件本地，父级不关心）
 */
export default {
    name: 'ChatTestSidebar',
    props: {
        visible: { type: Boolean, default: true },
        width: { type: Number, default: 300 },
        // 卡片身份（会话/变量树按它隔离）
        cardPath: { type: String, default: '' },
        cardName: { type: String, default: '' },
        // 预设库（桌面预设域已有列表；本组件只读 + 可选激活）
        presetOptions: { type: Array, default: () => [] },
        // 正则（已由父级合并卡内/预设/插件来源，并打上 _source 标记）
        regexList: { type: Array, default: () => [] },
        // 世界书条目 [{ key, comment, content, enabled, constant, position, insertion_order }]
        wbList: { type: Array, default: () => [] },
        // MVU 变量
        varsTree: { type: Object, default: () => ({}) },
        varsLog: { type: Array, default: () => [] },
        varsStats: { type: Object, default: () => ({ leaves: 0, ops: 0, aiCount: 0 }) },
        // 会话
        sessions: { type: Array, default: () => [] },
        activeSessionId: { type: String, default: '' },
        chatMessageCount: { type: Number, default: 0 },
        // ⚠️ 引擎开关（MVU / EJS / 分段渲染）**不再走 props**：状态真源已统一为
        //    chatStorage 的 getChatFlag('mvu'|'ejs'|'seg')（见下方「设置」分区的开关描述符），
        //    避免「侧栏改了开关、发消息时仍按旧值处理」的双份状态不同步。
        //    历史上这里留了三个 Boolean prop，父级却没有传入（Vue 持续告警 undefined）——
        //    2026-09-13 清理：删除死 prop 与父级同名绑定。
        storageReady: { type: Boolean, default: false },
        // API（与桌面共有权威源）
        apiEndpoint: { type: String, default: '' },
        apiKey: { type: String, default: '' },
        apiModel: { type: String, default: '' },
        apiType: { type: String, default: 'openai' }
    },
    emits: [
        'update:visible',
        'toggle-wb', 'set-wb-position', 'set-wb-order', 'toggle-regex',
        'reset-vars', 'undo-var', 'toggle-var-node', 'set-var',
        'new-session', 'switch-session', 'rename-session', 'remove-session',
        'remove-plugin',
        'set-api-endpoint', 'set-api-key', 'set-api-model', 'set-api-type',
        'set-flag', 'params-changed'
    ],
    data() {
        return {
            activeTab: 'config',
            SECTIONS: [
                { key: 'config', label: '配置', icon: '⚙' },
                { key: 'regex', label: '正则', icon: '🧩' },
                { key: 'wb', label: '世界书', icon: '🌍' },
                { key: 'vars', label: '变量', icon: '📊' },
                { key: 'chat', label: '聊天', icon: '💬' },
                { key: 'settings', label: '设置', icon: '🎛' },
                { key: 'plugins', label: '插件', icon: '🔌' }
            ],
            PARAM_KEYS: [
                { key: 'temperature', label: 'temperature', step: 0.05, min: 0, max: 2, ph: '预设值', hint: '采样温度，越高越随机' },
                { key: 'max_tokens', label: 'max_tokens', step: 64, min: 1, max: 32000, ph: '预设值', hint: '单条回复最大 token' },
                { key: 'top_p', label: 'top_p', step: 0.05, min: 0, max: 1, ph: '预设值', hint: '核采样' },
                { key: 'frequency_penalty', label: 'freq_pen', step: 0.1, min: -2, max: 2, ph: '预设值', hint: '频率惩罚' },
                { key: 'presence_penalty', label: 'pres_pen', step: 0.1, min: -2, max: 2, ph: '预设值', hint: '存在惩罚' }
            ],
            // 预设条目展开态
            ppExpanded: {},
            ppAllExpanded: false,
            // ⚠️ 宏字样必须走 v-text 绑定：直接写 `{{ '{{persona}}' }}` 会让 Vue 模板编译器
            //    把内层 `{{` 当成嵌套插值，抛 "Unterminated string constant"。
            PERSONA_MACRO: '{{persona}}',
            // 参数覆盖（与父级双向同步）
            paramOverrides: {},
            // 插件导入
            showPluginImport: false,
            pluginImportText: '',
            pluginImportError: '',
            // 组件本地副本（引擎是无状态纯函数 + chatStorage，故编辑后同步刷新）
            localSessions: [],
            localPlugins: [],
            replyCount: 1,
            maxFloors: 0,
            userName: '我',
            userPersona: '',
            memEnabled: true,
            memLimit: 20,
            // 长期记忆库统计（memory:stats）：条数 + 分类；清空按钮两段式二次确认
            memStats: { total: 0, byType: {}, orphans: 0 },
            memClearArmed: false,
            // 🧠 记忆查看器（CT-17）：默认只看本卡；逐条删除
            memViewMode: 'card',
            memItems: [],
            memItemsLoading: false,
            memRemovingId: '',
            // 变量树展开态（路径集合）
            expandedVarPaths: {},
            _unwatch: null
        };
    },
    computed: {
        /** 当前激活预设（从 chatStorage 恢复） */
        /** 当前激活预设（从 chatStorage 恢复）
         *  ⚠️ 必须 void 一下 chatStorageVersion：getter 读的是同步存储，无响应式依赖时
         *     Vue 会永久缓存首次结果（实测：本组件选了预设、引擎却一直读到 null）。 */
        activePreset() { void chatStorageVersion.value; return loadActivePreset(); },
        activePresetName() { const p = this.activePreset; return (p && (p.name || (p.data && p.data.name))) || ''; },
        activePresetPrompts() {
            const p = this.activePreset;
            const data = p && p.data;
            if (!data) return [];
            // ⚠️ 这里要用「全部条目」而非仅启用的条目 —— 侧栏需要展示并可重新打开被关掉的条目
            const all = Array.isArray(data.prompts) ? data.prompts : [];
            const ordered = getOrderedPrompts(data);
            // 已启用的按 prompt_order 顺序在前，其余按原顺序补在后
            const seen = new Set(ordered.map((x) => x.identifier));
            const rest = all.filter((x) => x && !seen.has(x.identifier));
            return [...ordered, ...rest];
        },
        enabledPromptCount() { return this.activePresetPrompts.filter((p) => this.ppEnabled(p)).length; },
        enabledRegexCount() { return this.arr(this.regexList).filter((r) => r && !r.disabled).length; },
        wbConstantCount() { return this.arr(this.wbList).filter((e) => e && e.constant === true && e.enabled !== false).length; },
        // ⚠️ 不定义名为 sessions / pluginList 的 computed —— 会与同名 prop 冲突（Vue 直接报重复键）。
        //    模板里的 sessions / pluginList 直接取 prop；独立使用时由 refreshLocal 的 emit 交给父级回落。
        FEATURE_FLAGS() {
            // ⚠️ 开关直接读写 chatStorage（而非 props）—— 编排层发消息时现读同一份值，
            //    避免「侧栏关了 MVU、发消息时仍按开处理」的双份状态不同步问题。
            return [
                { key: 'mvu', label: 'MVU 变量系统', hint: '解析 AI 回复中的 <UpdateVariable> 指令', get: () => getChatFlag('mvu'), set: (v) => { setChatFlag('mvu', v); this.$forceUpdate(); } },
                { key: 'ejs', label: 'EJS 模板引擎', hint: '世界书/预设/开场白中的 <% %> 模板执行', get: () => getChatFlag('ejs'), set: (v) => { setChatFlag('ejs', v); this.$forceUpdate(); } },
                { key: 'seg', label: '分段渲染', hint: 'AI 回复按 ```html 围栏分段渲染面板（沙箱 iframe）', get: () => getChatFlag('seg'), set: (v) => { setChatFlag('seg', v); this.$forceUpdate(); } }
            ];
        },
        /** 变量树扁平化为可渲染行（带 depth / isLeaf / path） */
        varRows() {
            const rows = [];
            const walk = (node, prefix, depth) => {
                if (node === null || typeof node !== 'object') return;
                const keys = Array.isArray(node) ? node.map((_, i) => String(i)) : Object.keys(node);
                for (const k of keys) {
                    const v = node[k];
                    const path = prefix ? prefix + '.' + k : k;
                    const isLeaf = !(v !== null && typeof v === 'object');
                    rows.push({ path, label: k, value: v, depth, isLeaf, expanded: !!this.expandedVarPaths[path] });
                    if (!isLeaf && this.expandedVarPaths[path]) walk(v, path, depth + 1);
                }
            };
            walk((this.varsTree && typeof this.varsTree === 'object') ? this.varsTree : {}, '', 0);
            return rows;
        }
    },
    watch: {
        activeTab(t) {
            if (t === 'chat' || t === 'plugins' || t === 'settings') this.refreshLocal();
            // 🧠 切到设置分区时加载记忆列表（CT-17：查看器 + 逐条删除）
            if (t === 'settings') { this.refreshMemStats(); this.refreshMemItems(); }
        },
        // chatStorage.hydrate() 完成后重读一次：否则侧栏显示的是「首次运行的默认值」，
        // 而磁盘里其实有上次退出时保存的回复数/用户名/人设。
        storageReady(v) { if (v) this.refreshLocal(); },
        ppAllExpanded(v) {
            const next = {};
            if (v) this.activePresetPrompts.forEach((p, i) => { next[this.ppKey(p, i)] = true; });
            this.ppExpanded = next;
        }
    },
    created() {
        this.refreshLocal();
    },
    methods: {
        // ---------------- 本地副本同步 ----------------
        refreshLocal() {
            try { this.localSessions = loadSessions(this.cardPath) || []; } catch (e) { this.localSessions = []; }
            try { this.localPlugins = loadPlugins() || []; } catch (e) { this.localPlugins = []; }
            this.replyCount = getReplyCount();
            this.maxFloors = getMaxFloors();
            this.userName = getUserName();
            this.userPersona = getUserPersona();
            this.memEnabled = isMemoryEnabled();
            this.memLimit = getMemoryLimit();
            this.refreshMemStats();   // 切到「设置」/挂载时刷新记忆条数（异步，失败退化为 0）
        },
        ppKey(p, i) { return (p && p.identifier) ? p.identifier : ('idx' + i); },
        /** 数组兜底：任何来源的列表（props / 引擎 / 预设 JSON）都可能缺失或非数组，
         *  模板里直接 `.length` / `v-for` 会抛 "Cannot read properties of undefined (reading 'length')"
         *  并让整个组件渲染中断（实测：点「插件」分区时崩溃）。统一经此函数取。 */
        arr(v) { return Array.isArray(v) ? v : []; },
        objKeys(v) { return (v && typeof v === 'object') ? Object.keys(v) : []; },
        ppEnabled(p) {
            const data = this.activePreset && this.activePreset.data;
            if (!data || !p) return false;
            const id = p.identifier;
            if (!id) return p.enabled !== false;
            // 与 getOrderedPrompts 同口径：prompt_order 里 enabled===false 或 prompt.enabled===false 都算关
            const order = Array.isArray(data.prompt_order) ? data.prompt_order : [];
            for (const item of order) {
                if (!item || typeof item !== 'object') continue;
                if (item.identifier === id && item.enabled === false) return false;
                if (Array.isArray(item.order)) {
                    for (const sub of item.order) if (sub && sub.identifier === id && sub.enabled === false) return false;
                }
            }
            return p.enabled !== false;
        },
        roleClass(role) {
            if (role === 'user') return 'bg-blue-500/15 text-blue-300';
            if (role === 'assistant') return 'bg-emerald-500/15 text-emerald-300';
            return 'bg-zinc-800 text-zinc-400';
        },
        placementLabel(v) { return PLACEMENT_LABELS[v] || ('#' + v); },
        keysOf(e) {
            if (Array.isArray(e.keys)) return e.keys.filter(Boolean).join(', ');
            return String(e._keysText || '').trim();
        },
        typeName(v) {
            if (v === null) return 'null';
            if (Array.isArray(v)) return 'arr';
            return typeof v;
        },
        /** 文本输入 → 保持原类型的转换（数字仍存数字，避免变量树类型漂移） */
        coerce(raw, prev) {
            if (typeof prev === 'number') {
                const n = Number(raw);
                return Number.isFinite(n) ? n : prev;
            }
            if (typeof prev === 'boolean') return raw === 'true' || raw === '1';
            return raw;
        },
        fmtTime(ts) {
            if (!ts) return '—';
            try {
                const d = new Date(ts);
                return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            } catch (e) { return '—'; }
        },

        // ---------------- 1. 配置：预设 ----------------
        onPresetSelect(key) {
            if (!key) { this.clearPreset(); return; }
            const opt = this.presetOptions.find((p) => p.key === key);
            if (!opt) return;
            // 深拷贝一份存为「激活预设」，避免侧栏开关直接改动桌面预设库源对象
            let data;
            try { data = JSON.parse(JSON.stringify(opt.data || {})); } catch (e) { data = opt.data || {}; }
            saveActivePreset(Object.assign({}, data, { name: opt.name }));
            this.ppExpanded = {};
            this.$emit('params-changed', {});
        },
        clearPreset() {
            clearActivePreset();
            this.$emit('params-changed', {});
        },
        togglePrompt(p, i, enabled) {
            const preset = this.activePreset;
            if (!preset || !preset.data) return;
            setPromptEnabled(preset.data, p, enabled);
            saveActivePreset(preset.data);
            this.$forceUpdate();
        },
        setPromptRole(p, role) {
            const preset = this.activePreset;
            if (!preset || !preset.data) return;
            p.role = role;
            saveActivePreset(preset.data);
            this.$forceUpdate();
        },

        // ---------------- 1. 配置：参数覆盖 ----------------
        onParamInput(key, raw) {
            const next = Object.assign({}, this.paramOverrides);
            if (raw === '' || raw === null || raw === undefined) delete next[key];
            else {
                const n = Number(raw);
                if (Number.isFinite(n)) next[key] = n;
                else delete next[key];
            }
            this.paramOverrides = next;
            this.$emit('params-changed', next);
        },
        resetParams() {
            this.paramOverrides = {};
            this.$emit('params-changed', {});
        },

        // ---------------- 2. 正则 ----------------
        toggleRegex(r) {
            // 写回卡片数据属父级职责（要 refreshCardData / 落盘），故走 emit
            this.$emit('toggle-regex', { script: r, enabled: !!r.disabled });
        },

        // ---------------- 5. 聊天会话 ----------------
        // ⚠️ 重命名/删除必须交父级：Electron 中 window.prompt 静默返回 null、
        //    window.confirm 静默返回 null（见 App.vue:2012 注释），必须用 appPrompt / confirmDialog。
        createNewSession() {
            this.$emit('new-session', null);
        },
        switchSession(id) {
            setLastSessionId(this.cardPath, id);
            this.$emit('switch-session', id);
        },
        renameSession(s) {
            this.$emit('rename-session', s);
        },
        removeSession(s) {
            this.$emit('remove-session', s);
        },

        // ---------------- 6. 设置 ----------------
        setReplyCount(v) { setReplyCount(v); this.replyCount = getReplyCount(); },
        setUserName(v) { setUserName(v); this.userName = getUserName(); },
        setUserPersona(v) { setUserPersona(v); this.userPersona = getUserPersona(); },
        setMaxFloors(v) { setMaxFloors(v); this.maxFloors = getMaxFloors(); },
        onMemToggle(v) { setMemoryEnabled(v); this.memEnabled = isMemoryEnabled(); },
        onMemLimit(v) { setMemoryLimit(v); this.memLimit = getMemoryLimit(); },
    /** 读取记忆库统计（memory:stats → 条数/分类/遗留桶）；失败则退化为 0 条，不影响 UI */
    async refreshMemStats() {
        const s = await getMemoryStats();
        this.memStats = s;
        this.memClearArmed = false;
    },
    /** 🧠 记忆查看器（CT-17）：加载列表。card 模式只看本卡（按 cardPath 过滤） */
    async refreshMemItems() {
        this.memItemsLoading = true;
        try {
            const scope = this.memViewMode === 'card' ? (this.cardPath || '') : '';
            this.memItems = await listMemory('', 100, scope);
        } catch (e) {
            this.memItems = [];
        } finally {
            this.memItemsLoading = false;
        }
    },
    /** 逐条删除（CT-17）：删除后同时刷新统计与列表，双向反馈 */
    async onMemRemove(it) {
        if (!it || !it.id || this.memRemovingId) return;
        this.memRemovingId = it.id;
        try {
            const res = await removeMemory(it.id);
            if (res && res.success) {
                this.memItems = this.memItems.filter((x) => x.id !== it.id);
                await this.refreshMemStats();
                this.$emit('log', '🗑 已删除记忆：' + String(it.content || '').slice(0, 20));
            } else {
                this.$emit('log', '⚠️ 删除记忆失败' + (res && res.error ? ('：' + res.error) : ''));
            }
        } finally {
            this.memRemovingId = '';
        }
    },
    armMemClear() { this.memClearArmed = true; this.$emit('log', '⚠️ 再次点击「确认清空？」才会删除长期记忆'); },
    async doMemClear() {
        const before = this.memStats.total;
        const res = await clearMemory('');
        await this.refreshMemStats();
        this.$emit('log', res && res.success ? `🧹 已清空长期记忆（${before} 条）` : '⚠️ 清空长期记忆失败');
    },
        importPlugin() {
            this.pluginImportError = '';
            const raw = String(this.pluginImportText || '').trim();
            if (!raw) return;
            let parsed;
            try { parsed = JSON.parse(raw); } catch (e) { this.pluginImportError = 'JSON 解析失败：' + e.message; return; }
            const list = Array.isArray(parsed) ? parsed : [parsed];
            let added = 0;
            let current = loadPlugins();
            for (const item of list) {
                const p = parsePlugin(item);
                if (!p) continue;
                current = addPlugin(current, p);
                added++;
            }
            if (!added) { this.pluginImportError = '没有可导入的插件（缺少 name 字段？）'; return; }
            savePlugins(current);
            this.localPlugins = loadPlugins();
            this.pluginImportText = '';
            this.showPluginImport = false;
        },
        togglePluginAt(i, enabled) {
            const p = this.localPlugins[i];
            if (!p) return;
            savePlugins(togglePlugin(loadPlugins(), p.name));
            this.localPlugins = loadPlugins();
        },
        removePluginAt(i) {
            this.$emit('remove-plugin', this.localPlugins[i]);
        }
    }
};
</script>
