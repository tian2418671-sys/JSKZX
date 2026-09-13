<template>
    <transition name="ts-slide">
        <div v-show="visible" class="test-sidebar">
            <!-- 遮罩层：点击关闭 + 阻止底层滚动穿透 -->
            <div class="ts-overlay" @click="$emit('update:visible', false)" />
            <div class="ts-panel-wrap">
                <div class="ts-header">
                    <span class="ts-title">测卡配置</span>
                    <van-icon name="cross" size="18" class="ts-close" @click="$emit('update:visible', false)" />
                </div>
                <!-- 顶部选项卡：自定义 tab 栏，避免 van-tabs 的 __content/Swipe 容器占高 -->
                <div class="ts-tabs">
                    <div class="ts-tab-item" :class="{ active: activeTab === 'config' }" @click="switchTab('config')">配置</div>
                    <div class="ts-tab-item" :class="{ active: activeTab === 'regex' }" @click="switchTab('regex')">正则插件</div>
                    <div class="ts-tab-item" :class="{ active: activeTab === 'wb' }" @click="switchTab('wb')">世界书</div>
                    <div class="ts-tab-item" :class="{ active: activeTab === 'vars' }" @click="switchTab('vars')">变量</div>
                    <div class="ts-tab-item" :class="{ active: activeTab === 'chat' }" @click="switchTab('chat')">聊天</div>
                    <div class="ts-tab-item" :class="{ active: activeTab === 'settings' }" @click="switchTab('settings')">设置</div>
                </div>
                <div ref="bodyRef" class="ts-body">
                    <!-- ========== 配置 Tab ========== -->
                    <div v-show="activeTab === 'config'" class="ts-panel">
                    <!-- 预设 -->
                    <div class="ts-sec-title"><span>📋 预设</span>
                        <van-tag v-if="activePresetName" type="primary" size="mini" round>{{ activePresetName }}</van-tag>
                    </div>
                    <div v-if="activePresetName" class="ts-preset-active">
                        <span class="ts-preset-name">{{ activePresetName }}</span>
                        <van-button size="mini" plain type="danger" @click="$emit('clear-preset')">取消</van-button>
                    </div>
                    <!-- 文件导入 -->
                    <van-button block plain icon="description" type="primary" size="small" :loading="fileImporting"
                        @click="importPresetFromFile" style="margin-bottom: 6px">从文件导入预设</van-button>
                    <!-- 扫描外部目录 -->
                    <van-button block plain icon="folder-o" type="primary" size="small" :loading="presetScanning"
                        @click="$emit('scan-presets')" style="margin-bottom: 8px">扫描预设目录</van-button>
                    <div v-if="externalPresets && externalPresets.length" class="ts-preset-list">
                        <div v-for="(p, i) in externalPresets" :key="i" class="ts-preset-item"
                            @click="$emit('apply-preset', p.data)">
                            <div class="ts-preset-item-name">{{ (p.data && p.data.name) || p.name || '未命名' }}</div>
                            <div class="ts-preset-item-meta">{{ (p.data && p.data.prompts && p.data.prompts.length) || 0 }} 条提示词</div>
                        </div>
                    </div>
                    <van-empty v-else-if="!presetScanning" description="点击上方导入或扫描" image-size="40" />
                    <!-- 粘贴导入 -->
                    <van-field v-model="presetPasteText" type="textarea" rows="3" autosize
                        placeholder="粘贴预设 JSON..." spellcheck="false" class="ts-paste-field" />
                    <van-button block type="primary" size="small" @click="applyPastedPreset" style="margin-top: 6px">导入粘贴的预设</van-button>

                    <!-- 预设参数 -->
                    <template v-if="activePresetName">
                        <div class="ts-sec-title" style="margin-top: 12px"><span>⚙️ 预设参数</span></div>
                        <div v-for="pk in paramKeys" :key="pk.key" class="ts-param-row">
                            <div class="ts-param-label">{{ pk.label }}</div>
                            <div class="ts-param-control">
                                <van-stepper v-model="paramOverrides[pk.key]" :min="pk.min" :max="pk.max"
                                    :step="pk.step" :decimal-length="pk.decimal || 0" allow-empty @change="emitParams" />
                            </div>
                            <div v-if="presetParams && presetParams[pk.key] !== undefined" class="ts-param-default">默认: {{ presetParams[pk.key] }}</div>
                        </div>
                        <van-button size="mini" plain @click="resetParams" style="margin-top: 6px">重置为预设默认值</van-button>
                    </template>
                </div>

                <!-- ========== 正则插件 Tab ========== -->
                <div v-show="activeTab === 'regex'" class="ts-panel">
                    <!-- 正则列表 -->
                    <div class="ts-sec-title"><span>🔤 正则脚本</span>
                        <van-tag size="mini" round>{{ regexCount }}</van-tag>
                    </div>
                    <div v-if="allRegexScripts && allRegexScripts.length" class="ts-regex-list">
                        <div v-for="(r, i) in allRegexScripts" :key="i" class="ts-regex-item">
                            <van-icon :name="r.disabled ? 'circle' : 'success'" :color="r.disabled ? '#c8c9cc' : '#06b6d4'" size="16" />
                            <div class="ts-regex-info">
                                <span class="ts-regex-name" :class="{ disabled: r.disabled }">{{ r.scriptName || '未命名' }}</span>
                                <span class="ts-regex-source">{{ regexSourceLabel(r) }}</span>
                            </div>
                            <span class="ts-regex-placement">{{ formatPlacement(r.placement) }}</span>
                        </div>
                    </div>
                    <van-empty v-else description="无正则脚本（角色卡/插件/预设中均无）" image-size="40" />
                    <!-- 导入正则：文件 + 粘贴 -->
                    <div class="ts-import-row">
                        <van-button size="small" plain icon="description" @click="importRegexFromFile" :loading="fileImporting">文件导入</van-button>
                    </div>
                    <van-field v-model="regexPasteText" type="textarea" rows="3" autosize
                        placeholder='粘贴正则 JSON，如 [{"findRegex":"old","replaceString":"new","placement":[2]}]（2=AI回复 1=用户输入）'
                        spellcheck="false" class="ts-paste-field" style="margin-top: 6px" />
                    <van-button block type="primary" size="small" @click="importPastedRegex" style="margin-top: 6px">导入正则</van-button>

                    <!-- 插件列表 -->
                    <div class="ts-sec-title" style="margin-top: 12px"><span>🧩 插件</span>
                        <van-tag size="mini" round>{{ (plugins && plugins.length) || 0 }}</van-tag>
                    </div>
                    <div v-if="plugins && plugins.length" class="ts-plugin-list">
                        <div v-for="p in plugins" :key="p.name" class="ts-plugin-item">
                            <van-switch :model-value="p.enabled" size="18px" @update:model-value="$emit('toggle-plugin', p.name)" />
                            <div class="ts-plugin-info">
                                <div class="ts-plugin-name">{{ p.name }}
                                    <span v-if="p._source === 'preset'" class="ts-source-tag">预设</span>
                                </div>
                                <div v-if="p.description" class="ts-plugin-desc">{{ p.description }}</div>
                            </div>
                            <van-icon v-if="p._source !== 'preset'" name="delete-o" color="#ee0a24" size="16" @click="$emit('remove-plugin', p.name)" />
                        </div>
                    </div>
                    <van-empty v-else description="无插件" image-size="40" />
                    <div class="ts-import-row">
                        <van-button size="small" plain icon="description" @click="importPluginFromFile" :loading="fileImporting">文件导入</van-button>
                    </div>
                    <van-field v-model="pluginPasteText" type="textarea" rows="3" autosize
                        placeholder='粘贴插件 JSON，如 {"name":"插件","systemPrompts":["指令"]}'
                        spellcheck="false" class="ts-paste-field" style="margin-top: 6px" />
                    <van-button block type="primary" size="small" @click="importPastedPlugin" style="margin-top: 6px">导入插件</van-button>
                </div>

                <!-- ========== 世界书 Tab ========== -->
                <div v-show="activeTab === 'wb'" class="ts-panel">
                    <div class="ts-sec-title"><span>📖 世界书</span>
                        <van-tag size="mini" round>{{ wbCount }}</van-tag>
                    </div>
                    <div class="ts-wb-tip">条目来自角色卡内嵌数据，修改会同步到卡片世界书页。</div>
                    <div v-if="wbCount" class="ts-wb-list">
                        <div v-for="(e, key) in wbEntries" :key="key" class="ts-wb-item-block">
                            <div class="ts-wb-item-head" @click="toggleWbExpand(key)">
                                <van-switch v-model="e.enabled" size="18px" @update:model-value="$emit('toggle-wb-entry', key)" />
                                <span class="ts-wb-name" :class="{ disabled: !e.enabled }">{{ e.comment || '(未命名)' }}</span>
                                <span v-if="e.constant" class="ts-wb-tag">常驻</span>
                                <van-icon :name="wbExpanded[key] ? 'arrow-up' : 'arrow-down'" size="14" class="ts-wb-arrow" />
                            </div>
                            <div v-if="wbExpanded[key]" class="ts-wb-item-body">
                                <van-field v-model="e._keysText" label="触发词" placeholder="逗号分隔" @blur="$emit('sync-wb-keys', key)" />
                                <van-field v-model="e.content" label="内容" type="textarea" rows="2" autosize />
                                <div class="ts-wb-pos-row">
                                    <span class="ts-wb-pos-label">位置</span>
                                    <van-radio-group v-model="e.position" direction="horizontal" @update:model-value="$emit('update-wb-entry', key)">
                                        <van-radio :name="0">顶</van-radio>
                                        <van-radio :name="1">底</van-radio>
                                        <van-radio :name="2">记前</van-radio>
                                        <van-radio :name="3">@D</van-radio>
                                    </van-radio-group>
                                </div>
                            </div>
                        </div>
                    </div>
                    <van-empty v-else description="当前卡片无内嵌世界书" image-size="40" />
                </div>

                <!-- ========== 变量 Tab（MVU 变量系统 + EJS 引擎，对齐方案文档） ========== -->
                <div v-show="activeTab === 'vars'" class="ts-panel">
                    <!-- 引擎开关 -->
                    <div class="ts-sec-title"><span>🧬 引擎开关</span></div>
                    <van-cell title="MVU 变量系统" label="解析 AI 回复中的 &lt;UpdateVariable&gt; 指令">
                        <template #right-icon><van-switch :model-value="mvuEnabled" size="20px" @update:model-value="$emit('update-mvu-enabled', $event)" /></template>
                    </van-cell>
                    <van-cell title="EJS 模板引擎" label="世界书/预设/开场白中的 <% %> 模板执行">
                        <template #right-icon><van-switch :model-value="ejsEnabled" size="20px" @update:model-value="$emit('update-ejs-enabled', $event)" /></template>
                    </van-cell>
                    <van-cell title="分段渲染" label="AI 回复按 ```html 围栏分段渲染面板">
                        <template #right-icon><van-switch :model-value="segRenderEnabled" size="20px" @update:model-value="$emit('update-seg-render', $event)" /></template>
                    </van-cell>

                    <!-- 变量树 -->
                    <div class="ts-sec-title" style="margin-top: 10px"><span>🌳 变量树</span>
                        <van-tag size="mini" round>{{ varsStats.leaves }} 值 · {{ varsStats.ops }} 楼</van-tag>
                    </div>
                    <div class="ts-vars-actions">
                        <van-button size="mini" plain icon="revoke" :disabled="!varsStats.ops" @click="$emit('undo-vars')">撤销</van-button>
                        <van-button size="mini" plain type="danger" icon="delete-o" :disabled="!varsStats.leaves" @click="confirmResetVars">重置</van-button>
                    </div>
                    <van-field
                        v-model="varsJsonDraft"
                        type="textarea"
                        rows="6"
                        autosize
                        spellcheck="false"
                        placeholder="变量树 JSON（可编辑后应用合并）"
                        class="ts-paste-field"
                        @focus="varsEditing = true"
                        @blur="varsEditing = false"
                    />
                    <van-button block size="small" type="primary" plain style="margin-top: 6px" @click="applyVarsJsonEdit">应用变量树修改</van-button>

                    <!-- OpLog 最近记录 -->
                    <div class="ts-sec-title" style="margin-top: 10px"><span>📜 更新日志</span>
                        <van-tag size="mini" round>最近 {{ varsOpLog.length }}</van-tag>
                    </div>
                    <div v-if="varsOpLog.length" class="ts-oplog-list">
                        <div v-for="(entry, i) in varsOpLog" :key="i" class="ts-oplog-item">
                            <span class="ts-oplog-ai">#{{ entry.ai }}</span>
                            <span class="ts-oplog-ops">{{ formatOps(entry.ops) }}</span>
                        </div>
                    </div>
                    <van-empty v-else description="暂无变量更新（AI 回复含 UpdateVariable 指令后显示）" image-size="40" />
                </div>

                <!-- ========== 聊天记录 Tab ========== -->
                <div v-show="activeTab === 'chat'" class="ts-panel">
                    <div class="ts-sec-title">
                        <span>💬 聊天记录</span>
                        <van-button size="mini" type="primary" icon="plus" @click="$emit('new-session')">新建</van-button>
                    </div>
                    <div v-if="chatSessions && chatSessions.length" class="ts-session-list">
                        <div v-for="s in chatSessions" :key="s.id" class="ts-session-item"
                            :class="{ active: s.id === activeSessionId }" @click="$emit('switch-session', s.id)">
                            <div class="ts-session-info">
                                <div class="ts-session-name">{{ s.name }}</div>
                                <div class="ts-session-meta">{{ s.messages ? s.messages.length : 0 }} 条 · {{ formatTime(s.updatedAt) }}</div>
                            </div>
                            <div class="ts-session-actions" @click.stop>
                                <van-icon name="edit" size="15" @click="promptRename(s)" />
                                <van-icon name="delete-o" color="#ee0a24" size="15" @click="confirmDelete(s)" />
                            </div>
                        </div>
                    </div>
                    <van-empty v-else description="暂无聊天记录，点击「新建」开始" image-size="40" />
                </div>

                <!-- ========== 设置 Tab ========== -->
                <div v-show="activeTab === 'settings'" class="ts-panel">
                    <!-- API 配置 -->
                    <div class="ts-sec-title"><span>🔗 API 配置</span></div>
                    <van-field v-model="localApiEndpoint" label="端点" placeholder="http://127.0.0.1:1234/v1/chat/completions" />
                    <van-field v-model="localApiKey" label="Key" type="password" placeholder="sk-... 或留空" />
                    <van-field v-model="localApiModel" label="模型" placeholder="local-model" />
                    <van-cell title="协议">
                        <template #value>
                            <van-radio-group v-model="localApiType" direction="horizontal">
                                <van-radio name="openai">OpenAI</van-radio>
                                <van-radio name="anthropic">Anthropic</van-radio>
                            </van-radio-group>
                        </template>
                    </van-cell>
                    <van-button block size="small" type="primary" @click="emitApiConfig" style="margin-top: 6px">保存 API 配置</van-button>

                    <!-- 测卡设置 -->
                    <div class="ts-sec-title" style="margin-top: 12px"><span>🎛️ 测卡设置</span></div>
                    <van-cell title="AI 回复数量" label="每次生成几条候选回复">
                        <template #value>
                            <van-stepper v-model="localReplyCount" min="1" max="10" integer @change="$emit('update-reply-count', localReplyCount)" />
                        </template>
                    </van-cell>
                    <van-field v-model="localUserName" label="用户名" placeholder="我" @blur="$emit('update-user-name', localUserName)" />
                    <van-field v-model="localUserPersona" label="用户人设" type="textarea" rows="2" autosize
                        placeholder="{{user}} 的角色设定" @blur="$emit('update-user-persona', localUserPersona)" />
                    <van-cell title="自动隐藏楼层数" label="0=全部发送；N=只把最近 N 层发给 AI，远处楼层仅显示">
                        <template #value>
                            <van-stepper v-model="localMaxFloors" min="0" max="200" integer @change="$emit('update-max-floors', localMaxFloors)" />
                        </template>
                    </van-cell>

                    <!-- 长期记忆 -->
                    <div class="ts-sec-title" style="margin-top: 12px"><span>🧠 长期记忆</span></div>
                    <van-cell title="启用记忆" label="测卡时自动记录并检索相关记忆">
                        <template #right-icon><van-switch v-model="localMemoryEnabled" size="20px" @update:model-value="$emit('update-memory-enabled', $event)" /></template>
                    </van-cell>
                    <van-cell title="检索条数" label="每次注入的最多相关记忆">
                        <template #value>
                            <van-stepper v-model="localMemoryLimit" min="1" max="50" integer @change="$emit('update-memory-limit', localMemoryLimit)" />
                        </template>
                    </van-cell>
                    <!-- 🚀 记忆数据查看:黑箱变透明,可浏览/删除/清空 -->
                    <van-cell title="查看记忆数据" label="浏览已存储的对话与事实记忆" is-link @click="openMemoryViewer" />
                </div>
            </div>
        </div>
        </div>
    </transition>

    <!-- 🚀 记忆表格查看器:黑箱变透明(类型筛选/行编辑/删除/清空) -->
    <van-popup v-model:show="memoryViewerShow" position="bottom" round closeable
        :style="{ height: '72vh' }" class="mem-viewer">
        <div class="mem-v-head">
            <span class="mem-v-title">🧠 记忆表格（{{ memoryItems.length }} 条）</span>
            <van-button size="mini" plain type="danger" :disabled="!memoryItems.length" @click="clearMemoryAll">{{ memFilter === 'fact' ? '清空事实' : (memFilter === 'summary' ? '清空摘要' : (memFilter === 'message' ? '清空消息' : '清空全部')) }}</van-button>
        </div>
        <!-- 类型筛选 -->
        <div class="mem-v-tabs">
            <div v-for="t in memFilters" :key="t.key" class="mem-v-tab" :class="{ active: memFilter === t.key }" @click="setMemFilter(t.key)">{{ t.label }}</div>
        </div>
        <div class="mem-v-body">
            <van-loading v-if="memoryLoading" size="22">读取中…</van-loading>
            <van-empty v-else-if="!memoryItems.length" description="暂无记忆数据（发送消息后自动记录，关键信息自动入表）" image-size="60" />
            <div v-else v-for="it in memoryItems" :key="it.id" class="mem-v-item">
                <div class="mem-v-meta">
                    <van-tag :type="it.type === 'fact' ? 'warning' : (it.type === 'summary' ? 'success' : 'primary')" size="mini">{{ typeLabel(it.type) }}</van-tag>
                    <span v-if="it.type === 'fact'" class="mem-v-key">{{ it.key || '备忘' }}</span>
                    <span class="mem-v-card">{{ it.cardName || '' }}</span>
                    <span class="mem-v-time">{{ fmtMemTime(it.createdAt) }}</span>
                </div>
                <div class="mem-v-content">{{ it.content }}</div>
                <div class="mem-v-actions">
                    <van-icon name="edit" class="mem-v-edit" @click="editMemoryRow(it)" />
                    <van-icon name="delete-o" class="mem-v-del" @click="deleteMemoryOne(it)" />
                </div>
            </div>
        </div>
    </van-popup>
</template>

<script>
import { ref, reactive, computed, watch } from 'vue';
import { showToast, showSuccessToast, showConfirmDialog } from 'vant';
import { api } from '../../bridge/api';
import { countVars } from '../useChatVariables.js';

export default {
    name: 'TestSidebar',
    props: {
        visible: { type: Boolean, default: false },
        activePresetName: { type: String, default: '' },
        plugins: { type: Array, default: () => [] },
        allRegexScripts: { type: Array, default: () => [] },
        externalPresets: { type: Array, default: () => [] },
        presetScanning: { type: Boolean, default: false },
        wbEntries: { type: Object, default: () => ({}) },
        presetParams: { type: Object, default: () => ({}) },
        chatSessions: { type: Array, default: () => [] },
        activeSessionId: { type: String, default: '' },
        apiEndpoint: { type: String, default: '' },
        apiKey: { type: String, default: '' },
        apiModel: { type: String, default: '' },
        apiType: { type: String, default: 'openai' },
        replyCount: { type: Number, default: 1 },
        userName: { type: String, default: '我' },
        userPersona: { type: String, default: '' },
        memoryEnabled: { type: Boolean, default: true },
        memoryLimit: { type: Number, default: 20 },
        maxFloors: { type: Number, default: 0 },
        // MVU 变量 + EJS + 分段渲染（变量 Tab）
        mvuEnabled: { type: Boolean, default: true },
        ejsEnabled: { type: Boolean, default: true },
        segRenderEnabled: { type: Boolean, default: true },
        varsStats: { type: Object, default: () => ({ leaves: 0, ops: 0, aiCount: 0 }) },
        varsTreeJson: { type: String, default: '{}' },
        varsOpLog: { type: Array, default: () => [] },
    },
    emits: [
        'update:visible', 'scan-presets', 'apply-preset', 'clear-preset',
        'import-regex', 'import-plugin', 'remove-plugin', 'toggle-plugin',
        'update-params', 'toggle-wb-entry', 'update-wb-entry', 'sync-wb-keys',
        'new-session', 'switch-session', 'delete-session', 'rename-session',
        'update-api-config', 'update-reply-count', 'update-user-name', 'update-user-persona',
        'update-memory-enabled', 'update-memory-limit', 'update-max-floors',
        'update-mvu-enabled', 'update-ejs-enabled', 'update-seg-render',
        'apply-vars-json', 'undo-vars', 'reset-vars'
    ],
    setup(props, { emit }) {
        const activeTab = ref('config');
        const bodyRef = ref(null);
        // 切换 Tab 时把内容区滚回顶部，避免残留上一个 Tab 的滚动位置导致「大片空白/内容被顶出」
        function onTabChange() {
            if (bodyRef.value) bodyRef.value.scrollTop = 0;
        }
        function switchTab(tab) {
            activeTab.value = tab;
            onTabChange();
        }
        const presetPasteText = ref('');
        const regexPasteText = ref('');
        const pluginPasteText = ref('');
        const fileImporting = ref(false);
        const wbExpanded = reactive({});

        const paramOverrides = reactive({});

        const paramKeys = [
            { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, decimal: 1 },
            { key: 'max_tokens', label: 'Max Tokens', min: 1, max: 32768, step: 1, decimal: 0 },
            { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05, decimal: 2 },
            { key: 'top_k', label: 'Top K', min: 0, max: 100, step: 1, decimal: 0 },
            { key: 'frequency_penalty', label: 'Freq Penalty', min: -2, max: 2, step: 0.1, decimal: 1 },
            { key: 'presence_penalty', label: 'Pres Penalty', min: -2, max: 2, step: 0.1, decimal: 1 },
            { key: 'rep_pen', label: 'Rep Penalty', min: 1, max: 2, step: 0.01, decimal: 2 },
            { key: 'max_context', label: 'Max Context', min: 1024, max: 200000, step: 1024, decimal: 0 },
        ];

        const regexCount = computed(() => (props.allRegexScripts && props.allRegexScripts.length) || 0);
        const wbCount = computed(() => (props.wbEntries ? Object.keys(props.wbEntries).length : 0));

        // 本地 API 配置副本（编辑后点保存才 emit）
        const localApiEndpoint = ref(props.apiEndpoint);
        const localApiKey = ref(props.apiKey);
        const localApiModel = ref(props.apiModel);
        const localApiType = ref(props.apiType);
        const localReplyCount = ref(props.replyCount);
        const localUserName = ref(props.userName);
        const localUserPersona = ref(props.userPersona);
        const localMemoryEnabled = ref(props.memoryEnabled);
        const localMemoryLimit = ref(props.memoryLimit);
        const localMaxFloors = ref(props.maxFloors);

        // ---------- 🚀 记忆表格查看器(黑箱变透明:类型筛选/行编辑/删除/清空) ----------
        const memoryViewerShow = ref(false);
        const memoryLoading = ref(false);
        const memoryItems = ref([]);
        const memFilters = [
            { key: '', label: '全部' },
            { key: 'fact', label: '事实' },
            { key: 'summary', label: '摘要' },
            { key: 'message', label: '消息' }
        ];
        const memFilter = ref('');
        function typeLabel(t) {
            return t === 'fact' ? '事实' : (t === 'summary' ? '摘要' : (t === 'message' ? '消息' : (t || '未知')));
        }
        function setMemFilter(k) {
            memFilter.value = k;
            refreshMemoryList();
        }
        async function openMemoryViewer() {
            memoryViewerShow.value = true;
            await refreshMemoryList();
        }
        async function refreshMemoryList() {
            memoryLoading.value = true;
            try {
                const res = await api.memoryList({ type: memFilter.value, limit: 300 });
                memoryItems.value = (res && res.success && Array.isArray(res.items)) ? res.items : [];
            } catch (e) {
                memoryItems.value = [];
            } finally {
                memoryLoading.value = false;
            }
        }
        /** 编辑记忆表格行：改键（fact）/改值（prompt 输入，与 promptRename 同套路） */
        async function editMemoryRow(it) {
            if (!it || it.id == null) return;
            const isFact = it.type === 'fact';
            let key = it.key || '备忘';
            let value = it.content || '';
            if (isFact) {
                const k = window.prompt('记忆键（事实分类）', key);
                if (k == null) return;
                key = k.trim() || '备忘';
            }
            const v = window.prompt('记忆内容', value);
            if (v == null) return;
            value = v.trim();
            if (!value) { showToast('内容不能为空'); return; }
            try {
                const res = await api.memoryUpdate(it.id, { key, content: value });
                if (res && res.success) { showSuccessToast('已更新'); await refreshMemoryList(); }
                else showToast((res && res.error) || '更新失败');
            } catch (e) {
                showToast('更新失败');
            }
        }
        async function deleteMemoryOne(it) {
            if (!it || it.id == null) return;
            try {
                const res = await api.memoryRemove(it.id);
                if (res && res.success) { showSuccessToast('已删除'); refreshMemoryList(); }
                else showToast((res && res.error) || '删除失败');
            } catch (e) {
                showToast('删除失败');
            }
        }
        async function clearMemoryAll() {
            if (!memoryItems.value.length) return;
            const typeStr = memFilter.value === 'fact' ? '事实' : (memFilter.value === 'summary' ? '摘要' : (memFilter.value === 'message' ? '消息' : '全部'));
            try {
                await showConfirmDialog({ title: '清空记忆', message: `确定清空当前筛选「${typeStr}」下的 ${memoryItems.value.length} 条记忆？此操作不可恢复。` });
            } catch (e) { return; }
            try {
                const res = await api.memoryClear(memFilter.value);
                if (res && res.success) { showSuccessToast('已清空'); memoryItems.value = []; }
                else showToast((res && res.error) || '清空失败');
            } catch (e) {
                showToast('清空失败');
            }
        }
        function fmtMemTime(t) {
            const n = Number(t);
            if (!Number.isFinite(n) || n <= 0) return '';
            try { return new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
        }

        // 外部 prop 变化时同步本地副本
        watch(() => props.apiEndpoint, (v) => { localApiEndpoint.value = v; });
        watch(() => props.apiKey, (v) => { localApiKey.value = v; });
        watch(() => props.apiModel, (v) => { localApiModel.value = v; });
        watch(() => props.apiType, (v) => { localApiType.value = v; });
        watch(() => props.replyCount, (v) => { localReplyCount.value = v; });
        watch(() => props.userName, (v) => { localUserName.value = v; });
        watch(() => props.userPersona, (v) => { localUserPersona.value = v; });
        watch(() => props.memoryEnabled, (v) => { localMemoryEnabled.value = v; });
        watch(() => props.memoryLimit, (v) => { localMemoryLimit.value = v; });
        watch(() => props.maxFloors, (v) => { localMaxFloors.value = v; });

        watch(() => props.presetParams, (params) => {
            if (params) {
                for (const pk of paramKeys) {
                    if (params[pk.key] !== undefined && paramOverrides[pk.key] === undefined) {
                        paramOverrides[pk.key] = params[pk.key];
                    }
                }
            }
        }, { immediate: true, deep: true });

        watch(() => props.activePresetName, (name) => {
            if (!name) {
                for (const k of Object.keys(paramOverrides)) delete paramOverrides[k];
            }
        });

        function emitParams() {
            const out = {};
            for (const k of Object.keys(paramOverrides)) {
                if (paramOverrides[k] !== null && paramOverrides[k] !== undefined && paramOverrides[k] !== '') {
                    out[k] = Number(paramOverrides[k]);
                }
            }
            emit('update-params', out);
        }

        function resetParams() {
            for (const k of Object.keys(paramOverrides)) delete paramOverrides[k];
            if (props.presetParams) {
                for (const pk of paramKeys) {
                    if (props.presetParams[pk.key] !== undefined) paramOverrides[pk.key] = props.presetParams[pk.key];
                }
            }
            emitParams();
            showToast('已重置为预设默认值');
        }

        function applyPastedPreset() {
            const raw = (presetPasteText.value || '').trim();
            if (!raw) { showToast('请粘贴预设 JSON'); return; }
            try { emit('apply-preset', JSON.parse(raw)); presetPasteText.value = ''; }
            catch (e) { showToast('JSON 解析失败: ' + e.message); }
        }

        function importPastedRegex() {
            const raw = (regexPasteText.value || '').trim();
            if (!raw) { showToast('请粘贴正则 JSON'); return; }
            try { emit('import-regex', JSON.parse(raw)); regexPasteText.value = ''; }
            catch (e) { showToast('JSON 解析失败: ' + e.message); }
        }

        function importPastedPlugin() {
            const raw = (pluginPasteText.value || '').trim();
            if (!raw) { showToast('请粘贴插件 JSON'); return; }
            try { emit('import-plugin', JSON.parse(raw)); pluginPasteText.value = ''; }
            catch (e) { showToast('JSON 解析失败: ' + e.message); }
        }

        // 文件导入（预设/正则/插件）
        async function importPresetFromFile() {
            fileImporting.value = true;
            try {
                const res = await api.pickJsonFile();
                if (res && res.success && res.text) {
                    const data = JSON.parse(res.text);
                    emit('apply-preset', data);
                    showSuccessToast('已从文件导入预设：' + (data.name || res.name || ''));
                } else if (res && res.error && !res.error.includes('取消')) {
                    showToast(res.error);
                }
            } catch (e) {
                showToast('文件解析失败: ' + (e.message || e));
            } finally { fileImporting.value = false; }
        }
        async function importRegexFromFile() {
            fileImporting.value = true;
            try {
                const res = await api.pickJsonFile();
                if (res && res.success && res.text) {
                    emit('import-regex', JSON.parse(res.text));
                    showSuccessToast('已从文件导入正则');
                } else if (res && res.error && !res.error.includes('取消')) {
                    showToast(res.error);
                }
            } catch (e) {
                showToast('文件解析失败: ' + (e.message || e));
            } finally { fileImporting.value = false; }
        }
        async function importPluginFromFile() {
            fileImporting.value = true;
            try {
                const res = await api.pickJsonFile();
                if (res && res.success && res.text) {
                    emit('import-plugin', JSON.parse(res.text));
                    showSuccessToast('已从文件导入插件');
                } else if (res && res.error && !res.error.includes('取消')) {
                    showToast(res.error);
                }
            } catch (e) {
                showToast('文件解析失败: ' + (e.message || e));
            } finally { fileImporting.value = false; }
        }

        function emitApiConfig() {
            emit('update-api-config', {
                endpoint: localApiEndpoint.value,
                key: localApiKey.value,
                model: localApiModel.value,
                type: localApiType.value,
            });
            showSuccessToast('API 配置已保存');
        }

        // 世界书展开
        function toggleWbExpand(key) { wbExpanded[key] = !wbExpanded[key]; }

        // ---------- 变量 Tab（MVU/EJS） ----------
        const varsJsonDraft = ref(props.varsTreeJson || '{}');
        // 用户正在编辑变量树 JSON 的标记：编辑期间变量树变更不打断草稿（应用/撤销/重置/AI 回复后
        // 树变化触发宿主 props 更新，若此刻强制覆盖会把用户未完成的编辑冲掉）
        const varsEditing = ref(false);
        // 宿主变量树变化 → 同步草稿（仅当用户未在编辑时；编辑中交给用户自己收尾）
        watch(() => props.varsTreeJson, (v) => { if (!varsEditing.value) varsJsonDraft.value = v || '{}'; });
        function applyVarsJsonEdit() {
            emit('apply-vars-json', varsJsonDraft.value);
        }
        async function confirmResetVars() {
            try {
                await showConfirmDialog({
                    title: '重置变量树', message: '将清空当前会话的全部变量与更新日志，确定？',
                    confirmButtonText: '重置', confirmButtonColor: '#ee0a24',
                });
                emit('reset-vars');
            } catch (e) { /* 用户取消 */ }
        }
        function formatOps(ops) {
            if (!Array.isArray(ops)) return '';
            return ops.map((o) => {
                if (!o || !o.type) return '';
                // init 按并入的值数展示（与变量树「N 值」口径一致；数顶层键会把
                // {stat_data:{…}} 这类整树粘贴误显示成 1）
                if (o.type === 'init') return 'init(' + countVars(o.data || {}) + '值)';
                if (o.type === 'patch') return 'patch(' + (o.ops || []).length + '条)';
                const v = o.value === undefined ? '' : '=' + (typeof o.value === 'object' ? JSON.stringify(o.value) : o.value);
                return o.type + ' ' + (o.path || '') + v;
            }).filter(Boolean).join(' · ');
        }

        // 聊天记录操作
        async function promptRename(session) {
            const name = window.prompt('会话名称', session.name);
            if (name && name.trim()) emit('rename-session', session.id, name.trim());
        }
        async function confirmDelete(session) {
            try {
                await showConfirmDialog({
                    title: '删除会话', message: `确定删除「${session.name}」？`,
                    confirmButtonText: '删除', confirmButtonColor: '#ee0a24',
                });
                emit('delete-session', session.id);
            } catch (e) { /* 用户取消 */ }
        }

        function formatPlacement(placement) {
            if (!placement || !Array.isArray(placement) || !placement.length) return '全部';
            const LABELS = { 0: '全局', 1: '用户', 2: 'AI', 3: '斜杠', 5: '世界书', 6: '思维' };
            return placement.map((p) => LABELS[p] !== undefined ? LABELS[p] : String(p)).join('/');
        }
        function regexSourceLabel(r) {
            if (r.fromPreset) return '预设';
            if (r._source === 'plugin') return '插件';
            return '角色卡';
        }
        function formatTime(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        }

        return {
            activeTab, bodyRef, onTabChange, switchTab, presetPasteText, regexPasteText, pluginPasteText, fileImporting,
            paramOverrides, paramKeys, regexCount, wbCount, wbExpanded,
            localApiEndpoint, localApiKey, localApiModel, localApiType,
            localReplyCount, localUserName, localUserPersona, localMemoryEnabled, localMemoryLimit, localMaxFloors,
            memoryViewerShow, memoryLoading, memoryItems, openMemoryViewer, deleteMemoryOne, clearMemoryAll, fmtMemTime,
            memFilters, memFilter, setMemFilter, editMemoryRow, typeLabel,
            emitParams, resetParams, applyPastedPreset, importPastedRegex, importPastedPlugin,
            importPresetFromFile, importRegexFromFile, importPluginFromFile,
            emitApiConfig, toggleWbExpand, promptRename, confirmDelete,
            varsJsonDraft, varsEditing, applyVarsJsonEdit, confirmResetVars, formatOps,
            formatPlacement, regexSourceLabel, formatTime,
        };
    }
};
</script>

<style scoped>
/* 容器：全屏固定，用于承载遮罩层 + 侧边栏面板 */
.test-sidebar {
    position: fixed; inset: 0; z-index: 500;
    display: flex; justify-content: flex-end;
}
/* 半透明遮罩层：点击关闭 + 遮住底层内容 */
.ts-overlay {
    position: absolute; inset: 0; z-index: 1;
    background: rgba(0, 0, 0, 0.35);
}
/* 侧边栏面板：从右侧滑出 */
.ts-panel-wrap {
    position: relative; z-index: 2;
    width: 300px; max-width: 82vw; height: 100%;
    padding-top: env(safe-area-inset-top, 0px);
    box-sizing: border-box;
    background: var(--van-background, #fff);
    box-shadow: -2px 0 12px rgba(0,0,0,0.12);
    display: flex; flex-direction: column; overflow: hidden;
}
.ts-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 14px; border-bottom: 1px solid var(--van-gray-2, #ebedf0); flex-shrink: 0;
}
.ts-title { font-size: 14px; font-weight: 600; }
.ts-close { cursor: pointer; color: var(--van-gray-5, #969799); }
.ts-tabs { flex: 0 0 auto; display: flex; overflow-x: auto; -webkit-overflow-scrolling: touch; border-bottom: 1px solid var(--van-gray-2, #ebedf0); background: var(--van-background-2, #fff); }
/* 双保险:禁止外部深选择器(如详情页 .detail-page :deep(.van-tabs))把本组件二级标签栏拉伸成 flex:1,
   避免标签栏下方出现大面积空白塌陷 */
.ts-tabs :deep(.van-tabs) { flex: none; }
.ts-tabs::-webkit-scrollbar { display: none; }
.ts-tab-item { flex-shrink: 0; padding: 0 12px; height: 40px; line-height: 40px; font-size: 13px; color: var(--van-gray-7, #646566); cursor: pointer; white-space: nowrap; position: relative; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
.ts-tab-item.active { color: var(--van-primary-color, #1989fa); font-weight: 600; }
.ts-tab-item.active::after { content: ''; position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 20px; height: 3px; background: var(--van-primary-color, #1989fa); border-radius: 3px; }
.ts-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 16px; -webkit-overflow-scrolling: touch; }
.ts-panel { padding-top: 8px; }
.ts-sec-title { display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px 0 6px; font-size: 13px; font-weight: 600; }
.ts-sec-title .van-button { margin-left: auto; }

.ts-preset-active { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; margin-bottom: 6px; border-bottom: 1px solid var(--van-gray-2, #ebedf0); }
.ts-preset-name { font-size: 13px; font-weight: 600; color: #06b6d4; }
.ts-preset-list { margin-bottom: 8px; }
.ts-preset-item { padding: 10px 12px; border-radius: 8px; background: var(--van-background-2, #f7f8fa); margin-bottom: 6px; cursor: pointer; }
.ts-preset-item:active { background: var(--van-active-color, #f2f3f5); }
.ts-preset-item-name { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.ts-preset-item-meta { font-size: 11px; color: var(--van-gray-5, #969799); }

.ts-param-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.ts-param-label { width: 80px; flex-shrink: 0; font-size: 12px; color: var(--van-gray-6, #646566); }
.ts-param-control { flex-shrink: 0; }
.ts-param-default { font-size: 10px; color: var(--van-gray-5, #969799); }

.ts-regex-list, .ts-plugin-list { margin-bottom: 4px; }
.ts-regex-item { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--van-gray-1, #f7f8fa); }
.ts-regex-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ts-regex-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-regex-name.disabled { color: var(--van-gray-5, #c8c9cc); text-decoration: line-through; }
.ts-regex-source { font-size: 9px; color: var(--van-gray-5, #969799); }
.ts-regex-placement { font-size: 10px; color: var(--van-gray-5, #969799); flex-shrink: 0; }

.ts-plugin-item { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--van-gray-1, #f7f8fa); }
.ts-plugin-info { flex: 1; min-width: 0; }
.ts-plugin-name { font-size: 13px; font-weight: 600; }
.ts-plugin-desc { font-size: 11px; color: var(--van-gray-5, #969799); margin-top: 2px; }
.ts-source-tag { font-size: 9px; color: #06b6d4; background: #eef7fb; padding: 1px 4px; border-radius: 3px; margin-left: 4px; }

.ts-wb-tip { font-size: 10px; color: var(--van-gray-5, #969799); padding: 4px 0 8px; line-height: 1.5; }
.ts-wb-item-block { border-bottom: 1px solid var(--van-gray-1, #f7f8fa); padding: 4px 0; }
.ts-wb-item-head { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.ts-wb-name { font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-wb-name.disabled { color: var(--van-gray-5, #c8c9cc); }
.ts-wb-tag { font-size: 9px; color: #06b6d4; background: #eef7fb; padding: 1px 4px; border-radius: 3px; flex-shrink: 0; }
.ts-wb-arrow { color: var(--van-gray-5, #969799); flex-shrink: 0; }
.ts-wb-item-body { padding: 4px 0 8px; }
.ts-wb-pos-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.ts-wb-pos-label { font-size: 12px; color: var(--van-gray-6, #646566); flex-shrink: 0; }

.ts-session-list { margin-bottom: 4px; }
.ts-session-item { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--van-gray-1, #f7f8fa); cursor: pointer; }
.ts-session-item.active { background: var(--van-active-color, #f2f3f5); border-radius: 6px; padding-left: 8px; }
.ts-session-info { flex: 1; min-width: 0; }
.ts-session-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-session-meta { font-size: 10px; color: var(--van-gray-5, #969799); margin-top: 2px; }
.ts-session-actions { display: flex; gap: 12px; flex-shrink: 0; }

.ts-import-row { display: flex; gap: 8px; margin-top: 6px; }
.ts-paste-field { border: 1px solid var(--van-gray-3, #dcdee0); border-radius: 6px; margin-top: 4px; }
.ts-paste-field :deep(textarea) { font-size: 11px; }

/* 变量 Tab */
.ts-vars-actions { display: flex; gap: 8px; padding: 4px 0 6px; }
.ts-oplog-list { max-height: 200px; overflow-y: auto; }
.ts-oplog-item { display: flex; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--van-gray-1, #f7f8fa); font-size: 11px; }
.ts-oplog-ai { flex-shrink: 0; color: #06b6d4; font-weight: 600; }
.ts-oplog-ops { color: var(--van-gray-7, #646566); word-break: break-all; }

.ts-slide-enter-active, .ts-slide-leave-active { transition: transform 0.3s ease; }
.ts-slide-enter-from, .ts-slide-leave-to { transform: translateX(100%); }

/* 🚀 记忆数据查看器 */
.mem-viewer { display: flex; flex-direction: column; }
.mem-v-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px 10px; border-bottom: 1px solid var(--van-gray-3, #ebedf0);
}
.mem-v-title { font-size: 15px; font-weight: 600; }
/* 记忆表格类型筛选 Tab */
.mem-v-tabs { display: flex; gap: 6px; padding: 8px 16px 0; flex-shrink: 0; }
.mem-v-tab {
    padding: 3px 12px; font-size: 12px; border-radius: 12px;
    background: var(--van-background-2, #f7f8fa); color: var(--van-gray-6, #646566); cursor: pointer;
}
.mem-v-tab.active { background: #eef7fb; color: #06b6d4; font-weight: 600; }
.mem-v-body { flex: 1; overflow-y: auto; padding: 4px 16px 16px; }
.mem-v-item {
    position: relative;
    padding: 10px 56px 10px 12px;
    margin-top: 8px;
    border-radius: 10px;
    background: var(--van-background-2, #f7f8fa);
}
.mem-v-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.mem-v-key { font-size: 11px; color: #b8860b; background: #fdf6e3; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.mem-v-card { font-size: 11px; color: var(--van-gray-5, #969799); }
.mem-v-time { margin-left: auto; font-size: 11px; color: var(--van-gray-5, #969799); }
.mem-v-content { font-size: 13px; line-height: 1.5; word-break: break-all; white-space: pre-wrap; }
.mem-v-actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 10px; }
.mem-v-edit { color: var(--van-gray-6, #646566); }
.mem-v-del { color: var(--van-gray-5, #969799); }

/* van-tabs 已替换为自定义 tab 栏，无需隐藏 __content */
</style>
