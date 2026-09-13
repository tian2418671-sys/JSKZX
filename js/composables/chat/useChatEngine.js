/**
 * 桌面版测卡编排层（useChatEngine）
 * ─────────────────────────────────────────────────────────────
 * 把移动版 CardDetailView.vue 的「测卡段」编排逻辑搬到桌面版，串起 12 个引擎文件：
 *   预设装配 → 世界书注入 → 宏替换 → MVU 变量 → EJS → 正则 → 发送 → 分段渲染 → swipe
 *
 * 与移动版的差异（刻意的桌面化改造）：
 *   1. 会话/变量树/设置/开关一律经 chatStorage 适配层（移动版用裸 localStorage，
 *      桌面 app:// 下不重启持久）；
 *   2. 卡片、世界书、正则、预设、API 配置全部由 App.vue 注入（桌面已有一整套域），
 *      本文件不新建数据源，只做「取用 + 编排」；
 *   3. 会话/变量树是「每卡」维度，切卡时由 App.vue 调 resetForCard() 重建。
 *
 * 纯函数引擎不受影响；本文件是唯一有副作用的编排层。
 */

import { ref, computed, shallowRef } from 'vue';
import { buildMacroContext, applyMacros } from './useChatMacros.js';
import { applyRegexScripts } from './useChatRegex.js';
import { createVariableEngine, countVars, extractMvu } from './useChatVariables.js';
import { renderEjs, looksLikeEjs, buildTemplateContext } from './useChatEjs.js';
import {
    getPresetParams, buildPresetMessages, loadActivePreset, isValidPresetStructure, extractRegexFromPreset
} from './useChatPresets.js';
import {
    loadSessions, createSession, upsertSession, persistMessages, deleteSession, renameSession,
    getLastSessionId, setLastSessionId
} from './useChatSessions.js';
import {
    getReplyCount, getUserName, getUserPersona, getMaxFloors
} from './useChatSettings.js';
import { buildMemoryContext, recordMessage, recordFact, extractFacts, isMemoryEnabled } from './useChatMemory.js';
import {
    loadPlugins, mergePluginMacros, collectPluginSystemPrompts, collectPluginRegex
} from './useChatPlugins.js';
import { messageText, shiftSwipe, replyToSwipe } from './useChatSwipe.js';
import { segmentMessage, promoteHtmlSegments } from './useChatRender.js';
import { getChatFlag, chatStorageVersion } from './chatStorage.js';
import { api } from './chatBridge.js';

/** 兜底：AI 回复里若没有 chatHistory 占位符，也要把历史拼进去 */
const HISTORY_IDS = ['chatHistory', 'chat_history'];

export function useChatEngine(deps = {}) {
    // ==================== 注入依赖 ====================
    const {
        // 卡片（card = 整卡 JSON；safeData = data.data 数据层）
        cardData, safeData,
        // 桌面已有域
        regexScripts,            // computed → 卡内正则数组
        worldbookEntries,        // computed → 内嵌世界书条目数组
        // API
        apiEndpoint, apiKey, apiModel, apiType,
        resolveApiModel, chatCardPath,
        // 变量/会话版本号（App.vue 持有，引擎变更时 bump → 侧栏 computed 重算）
        chatVarsVersion, chatSessionsVersion,
        // 反馈
        nativeAlert, showToast
    } = deps;

    // ==================== 状态 ====================
    const chatMessages = ref([]);   // [{ role, content? , swipes?, index? }]
    const chatDraft = ref('');
    const chatSending = ref(false);
    const lastUserActivity = ref(0); // {{idle_duration}} 基准

    const sessions = ref([]);
    const activeSessionId = ref('');

    const varEngine = shallowRef(null);

    // ==================== 卡片/会话键 ====================
    const cardPath = () => (chatCardPath && chatCardPath.value) || '_unknown';
    const varsStorageKey = () => 'jsmobile-chat-vars:' + cardPath() + ':' + (activeSessionId.value || 'default');

    // ==================== 变量引擎 ====================
    function ensureVarEngine() {
        varEngine.value = createVariableEngine({
            storageKey: varsStorageKey(),
            onChange: () => { if (chatVarsVersion) chatVarsVersion.value++; }
        });
        if (chatVarsVersion) chatVarsVersion.value++;
    }
    const varsTree = computed(() => (varEngine.value ? varEngine.value.root : {}));
    const varsLog = computed(() => (varEngine.value ? varEngine.value.log.slice(-30).reverse() : []));
    const varsStats = computed(() => {
        const e = varEngine.value;
        if (!e) return { leaves: 0, ops: 0, aiCount: 0 };
        return { leaves: countVars(e.root), ops: e.log.length, aiCount: e.aiCount };
    });
    function resetVars() {
        if (varEngine.value) varEngine.value.reset();
        if (chatVarsVersion) chatVarsVersion.value++;
    }
    function undoVar() {
        if (varEngine.value) varEngine.value.undoLast();
        if (chatVarsVersion) chatVarsVersion.value++;
    }
    /** 侧栏手动改变量值：走引擎唯一变更入口，保证 OpLog/持久化/事件一致 */
    function setVar(path, value) {
        if (!varEngine.value || !path) return;
        varEngine.value.applyOps([{ type: 'set', path, value }]);
    }

    // ==================== 宏 ====================
    // ⚠️ 下面两个 computed 的 getter 读的是 chatStorage（同步、非响应式）。
    //    若不显式依赖 chatStorageVersion，Vue 会认为它们「没有依赖」而**永久缓存首次结果**
    //    （实测：侧栏选了预设、localStorage 也写了，引擎仍停在 null → 预设分支走不到）。
    //    故每次读取都先 void 一下版本号建立依赖。
    const plugins = computed(() => {
        void chatStorageVersion.value;
        try { return loadPlugins(); } catch (e) { return []; }
    });
    const macroContext = computed(() => {
        const card = cardData && cardData.value;
        const sd = (safeData && safeData.value) || {};
        const fallbackCard = { name: sd.name || 'AI', data: { data: sd } };
        return buildMacroContext(card || fallbackCard, getUserName(), getUserPersona(), lastUserActivity.value);
    });
    const fullMacros = computed(() => mergePluginMacros(plugins.value, macroContext.value));
    const activePreset = computed(() => {
        void chatStorageVersion.value;
        return loadActivePreset();
    });

    // ==================== 正则（卡内 + 预设内嵌 + 插件） ====================
    /**
     * 生效正则合并列表（管线与侧栏展示必须同口径，否则「侧栏看到的」与「实际生效的」会不一致）
     * 顺序：卡内 → 预设内嵌 → 插件；调用方按需只取卡内或全部。
     */
    const mergedRegex = computed(() => {
        const out = [];
        const cardScripts = (regexScripts && regexScripts.value) || [];
        for (const s of cardScripts) if (s) out.push(s);
        const preset = activePreset.value;
        if (preset && preset.data) {
            for (const s of extractRegexFromPreset(preset.data)) if (s) out.push(s);
        }
        for (const s of collectPluginRegex(plugins.value)) if (s) out.push(s);
        return out;
    });
    /** 与移动版 applyRegexScripts 调用点同名，保持语义一致 */
    const allRegexScripts = mergedRegex;

    // ==================== EJS ====================
    const ejsEnabled = () => getChatFlag('ejs');
    const mvuEnabled = () => getChatFlag('mvu');
    const templateCtx = computed(() => buildTemplateContext({
        engine: varEngine.value,
        messages: chatMessages.value,
        macros: fullMacros.value,
        messageTextOf: messageText,
        cardName: ((safeData && safeData.value) || {}).name || '',
        userName: getUserName()
    }));
    /** 对文本执行 EJS（开关关闭或非模板 → 原样返回） */
    function renderTpl(text, label) {
        if (!ejsEnabled() || !text || !looksLikeEjs(text)) return text;
        return renderEjs(text, templateCtx.value, { fallback: 'raw', label: label || 'EJS' });
    }

    // ==================== 系统提示词（无预设兜底） ====================
    function buildSystem(cardObj) {
        const dd = (cardObj && cardObj.data && cardObj.data.data) || (safeData && safeData.value) || {};
        const parts = [];
        if (dd.description) parts.push(dd.description);
        if (dd.personality) parts.push('### 性格\n' + dd.personality);
        if (dd.scenario) parts.push('### 场景\n' + dd.scenario);
        return parts.join('\n\n');
    }

    // ==================== 世界书激活条目 ====================
    /**
     * 激活规则：常驻(constant) 或 触发词(keys)命中用户消息（大小写不敏感子串）
     * EJS 条目先渲染 → 再宏替换 → 按 position/insertion_order 排序
     */
    function collectActivatedWbText(userMsg) {
        const entries = (worldbookEntries && worldbookEntries.value) || [];
        if (!entries.length) return '';
        const um = String(userMsg || '').toLowerCase();
        const hits = [];
        for (const e of entries) {
            if (!e || e.enabled === false) continue;
            const content = String(e.content || '').trim();
            if (!content) continue;
            const keys = Array.isArray(e.keys) ? e.keys : String(e._keysText || '').split(',').map((s) => s.trim());
            const isConstant = e.constant === true;
            const keyHit = !!(um && keys.some((k) => k && um.includes(String(k).toLowerCase())));
            if (!isConstant && !keyHit) continue;
            let text = renderTpl(content, '世界书条目' + (e.comment ? '(' + e.comment + ')' : ''));
            text = applyMacros(text, fullMacros.value);
            hits.push({
                position: Number(e.position) || 1,
                order: Number(e.insertion_order) || Number(e.order) || 100,
                text
            });
        }
        if (!hits.length) return '';
        hits.sort((a, b) => (a.position - b.position) || (a.order - b.order));
        return '### 世界书设定\n' + hits.map((h) => h.text).join('\n\n');
    }

    // ==================== 提示词构建 ====================
    /**
     * @param {'openai'|'anthropic'} type
     * @param {object} paramOverrides 侧栏参数覆盖
     */
    async function buildPayload(type, paramOverrides = {}) {
        const macros = fullMacros.value;
        // 🚀 自动隐藏楼层数：只保留最近 N 层（N = 用户+AI 一对，即 2N 条）
        const maxFloorsN = Math.max(0, Number(getMaxFloors()) || 0);
        const msgs = chatMessages.value;
        let historySource = msgs.slice(0, -1).filter((m) => m.role === 'user' || m.role === 'assistant');
        if (maxFloorsN > 0) historySource = historySource.slice(-(maxFloorsN * 2));

        // 发给 AI 的 assistant 历史应用 promptOnly 正则（对 AI 隐藏状态栏/变量更新块）
        const chatHistory = historySource.map((m) => {
            const content = m.role === 'assistant'
                ? applyRegexScripts(messageText(m), mergedRegex.value, 'AI', macros, { promptOnlyExclusive: true })
                : messageText(m);
            return { role: m.role, content };
        });

        const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
        const wbText = collectActivatedWbText(lastUserMsg ? messageText(lastUserMsg) : '');

        // ===== 预设模式 =====
        const presetData = activePreset.value && activePreset.value.data;
        if (presetData && isValidPresetStructure(presetData)) {
            const presetMsgs = buildPresetMessages(presetData, macros, { chatHistory });
            const presetParams = Object.assign({}, getPresetParams(presetData), paramOverrides || {});
            const pluginSys = collectPluginSystemPrompts(plugins.value);

            let memCtx = '';
            if (isMemoryEnabled()) {
                const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
                memCtx = await buildMemoryContext(lastUser ? messageText(lastUser) : '');
            }

            const sysTexts = presetMsgs.filter((m) => m.role === 'system').map((m) => m.content);
            if (wbText) sysTexts.push(wbText);
            const persona = getUserPersona();
            if (persona) sysTexts.push(applyMacros('### 用户(你)的角色设定\n{{persona}}', macros));
            sysTexts.push(...pluginSys);
            if (memCtx) sysTexts.push(memCtx);
            const systemText = sysTexts.filter(Boolean).join('\n\n');

            const nonSysMsgs = presetMsgs.filter((m) => m.role !== 'system');
            const allMsgs = systemText ? [{ role: 'system', content: systemText }].concat(nonSysMsgs) : nonSysMsgs.slice();

            // 兜底：预设里没有 chatHistory 占位符 → 手动补历史
            const hasHistorySlot = (presetData.prompts || []).some((p) => p && HISTORY_IDS.includes(p.identifier));
            if (!hasHistorySlot) {
                const sysCount = allMsgs.filter((m) => m.role === 'system').length;
                allMsgs.splice(sysCount, 0, ...chatHistory);
            }

            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg) allMsgs.push({ role: lastMsg.role, content: applyMacros(messageText(lastMsg), macros) });

            if (type === 'anthropic') {
                return {
                    model: resolveApiModel ? resolveApiModel() : 'claude-3-haiku-20240307',
                    max_tokens: presetParams.max_tokens || 2048,
                    system: systemText,
                    messages: allMsgs.filter((m) => m.role !== 'system'),
                    ...(presetParams.temperature !== undefined ? { temperature: presetParams.temperature } : {})
                };
            }
            return {
                model: resolveApiModel ? resolveApiModel() : 'local-model',
                messages: allMsgs,
                stream: false,
                temperature: presetParams.temperature !== undefined ? presetParams.temperature : 0.7,
                ...(presetParams.max_tokens !== undefined ? { max_tokens: presetParams.max_tokens } : {}),
                ...(presetParams.top_p !== undefined ? { top_p: presetParams.top_p } : {}),
                ...(presetParams.frequency_penalty !== undefined ? { frequency_penalty: presetParams.frequency_penalty } : {}),
                ...(presetParams.presence_penalty !== undefined ? { presence_penalty: presetParams.presence_penalty } : {})
            };
        }

        // ===== 无预设：经典兜底 =====
        const sysParts = [];
        const system = buildSystem(cardData && cardData.value);
        if (system) sysParts.push(applyMacros(system, macros));
        if (wbText) sysParts.push(wbText);
        const persona = getUserPersona();
        if (persona) sysParts.push(applyMacros('### 用户(你)的角色设定\n{{persona}}', macros));
        sysParts.push(...collectPluginSystemPrompts(plugins.value));
        if (isMemoryEnabled()) {
            const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
            const memCtx = await buildMemoryContext(lastUser ? messageText(lastUser) : '');
            if (memCtx) sysParts.push(memCtx);
        }
        const systemText = sysParts.filter(Boolean).join('\n\n');
        const messages = chatHistory.map((m) => ({ role: m.role, content: applyMacros(m.content, macros) }));
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg) messages.push({ role: lastMsg.role, content: applyMacros(messageText(lastMsg), macros) });

        if (type === 'anthropic') {
            return {
                model: resolveApiModel ? resolveApiModel() : 'claude-3-haiku-20240307',
                max_tokens: 2048,
                system: systemText,
                messages
            };
        }
        return {
            model: resolveApiModel ? resolveApiModel() : 'local-model',
            messages: systemText ? [{ role: 'system', content: systemText }].concat(messages) : messages,
            stream: false,
            temperature: 0.7
        };
    }

    // ==================== 发送 ====================
    const curType = () => (apiType && apiType.value === 'anthropic' ? 'anthropic' : 'openai');

    /**
     * 统一 AI 请求入口
     * @param {boolean} applyVars true=应用 MVU 指令并剔块（正向发送/续写）；
     *   false=仅剔块不应用（候选重生成/追加：变量跟随对话时间线，防 add 类指令双重累加）
     */
    async function requestReply(payload, type, applyVars = true, paramOverrides = {}) {
        const ep = ((apiEndpoint && apiEndpoint.value) || '').trim();
        if (!ep) { nativeAlert && nativeAlert('请先配置 API 端点（右侧抽屉 → 设置）', 'warning'); return '⚠ 未配置 API 端点'; }
        const key = ((apiKey && apiKey.value) || '').trim();
        const res = await api.sendChatMessage(ep, payload, key, type);
        const reply = replyToSwipe(res, type);
        if (!reply || reply.startsWith('⚠')) return reply; // 错误占位不进变量层
        let out = reply;
        if (mvuEnabled() && varEngine.value) {
            out = applyVars ? varEngine.value.onAiMessage(reply) : extractMvu(reply).display;
        }
        // AI 方向正则统一后处理（发送/再生成/重新生成/续写同一管线）
        out = applyRegexScripts(out, mergedRegex.value, 'AI', fullMacros.value);
        return out;
    }

    async function sendChat(paramOverrides = {}) {
        const text = (chatDraft.value || '').trim();
        if (!text) return;
        const type = curType();
        if (!((apiEndpoint && apiEndpoint.value) || '').trim()) {
            nativeAlert && nativeAlert('请先在右侧抽屉「设置」里配置 API 端点！', 'warning');
            return;
        }
        // 对用户输入应用宏 + USER 方向正则（结果即显示文本，payload 复用不再二次应用）
        let processedText = applyMacros(text, fullMacros.value);
        processedText = applyRegexScripts(processedText, mergedRegex.value, 'USER', fullMacros.value);
        chatMessages.value.push({ role: 'user', content: processedText });
        lastUserActivity.value = Date.now();
        chatDraft.value = '';
        chatSending.value = true;

        const count = Math.max(1, getReplyCount() || 1);
        try {
            const payload = await buildPayload(type, paramOverrides);
            const swipes = [];
            for (let n = 0; n < count; n++) {
                // MVU 只对首条候选应用（防 add 双重计数）
                swipes.push(await requestReply(payload, type, n === 0, paramOverrides));
            }
            chatMessages.value.push({ role: 'assistant', swipes, index: 0 });
            // 长期记忆（不阻塞；错误占位由 recordMessage 过滤）
            recordMessage('user', processedText, cardName());
            if (swipes[0]) recordMessage('assistant', swipes[0], cardName());
            for (const f of extractFacts(processedText)) recordFact(f.key, f.value, cardName());
        } catch (e) {
            chatMessages.value.push({ role: 'assistant', swipes: ['⚠ 请求异常: ' + (e && e.message ? e.message : e)], index: 0 });
            nativeAlert && nativeAlert('请求异常: ' + (e && e.message ? e.message : e), 'error');
        } finally {
            chatSending.value = false;
            saveCurrentChat();
        }
    }

    const cardName = () => ((safeData && safeData.value) || {}).name || '';

    // ==================== swipe ====================
    function nextSwipe(i) {
        const m = chatMessages.value[i];
        if (!m || !Array.isArray(m.swipes) || m.swipes.length < 2) return;
        chatMessages.value[i] = shiftSwipe(m, 1);
    }
    function prevSwipe(i) {
        const m = chatMessages.value[i];
        if (!m || !Array.isArray(m.swipes) || m.swipes.length < 2) return;
        chatMessages.value[i] = shiftSwipe(m, -1);
    }
    /** 追加一条新候选（再生成一个） */
    async function moreSwipe(i, paramOverrides = {}) {
        const msg = chatMessages.value[i];
        if (!msg || msg.role !== 'assistant' || chatSending.value) return;
        const type = curType();
        chatSending.value = true;
        try {
            const payload = await buildPayload(type, paramOverrides);
            msg.swipes = Array.isArray(msg.swipes) ? msg.swipes.slice() : [messageText(msg)];
            const reply = await requestReply(payload, type, false, paramOverrides);
            msg.swipes.push(reply);
            msg.index = msg.swipes.length - 1;
            chatMessages.value[i] = Object.assign({}, msg);
        } catch (e) {
            showToast && showToast('生成失败: ' + (e && e.message ? e.message : e));
        } finally {
            chatSending.value = false;
            saveCurrentChat();
        }
    }
    /** 整组改写当前候选 */
    async function regenerateSwipe(i, paramOverrides = {}) {
        const msg = chatMessages.value[i];
        if (!msg || msg.role !== 'assistant' || chatSending.value) return;
        const type = curType();
        const count = Math.max(1, getReplyCount() || 1);
        chatSending.value = true;
        try {
            const payload = await buildPayload(type, paramOverrides);
            const swipes = [];
            for (let n = 0; n < count; n++) swipes.push(await requestReply(payload, type, false, paramOverrides));
            msg.swipes = swipes;
            msg.index = 0;
            chatMessages.value[i] = Object.assign({}, msg);
        } catch (e) {
            showToast && showToast('重新生成失败: ' + (e && e.message ? e.message : e));
        } finally {
            chatSending.value = false;
            saveCurrentChat();
        }
    }
    /** 以当前选中候选为起点续写 */
    async function continueSwipe(i, paramOverrides = {}) {
        const msg = chatMessages.value[i];
        if (!msg || msg.role !== 'assistant' || chatSending.value) return;
        const type = curType();
        chatSending.value = true;
        try {
            const prior = chatMessages.value
                .slice(0, i)
                .filter((m) => m.role === 'user' || m.role === 'assistant')
                .map((m) => ({
                    role: m.role,
                    content: m.role === 'assistant'
                        ? applyRegexScripts(messageText(m), mergedRegex.value, 'AI', fullMacros.value, { promptOnlyExclusive: true })
                        : messageText(m)
                }));
            prior.push({ role: 'assistant', content: messageText(msg) });
            prior.push({ role: 'user', content: '[continue]' });
            const sysParts = [];
            const system = buildSystem(cardData && cardData.value);
            if (system) sysParts.push(applyMacros(system, fullMacros.value));
            const persona = getUserPersona();
            if (persona) sysParts.push(applyMacros('### 用户(你)的角色设定\n{{persona}}', fullMacros.value));
            const systemText = sysParts.join('\n\n');
            const payload = type === 'anthropic'
                ? { model: resolveApiModel ? resolveApiModel() : 'claude-3-haiku-20240307', max_tokens: 2048, system: systemText, messages: prior }
                : { model: resolveApiModel ? resolveApiModel() : 'local-model', messages: [{ role: 'system', content: systemText }].concat(prior), stream: false, temperature: 0.7 };
            const reply = await requestReply(payload, type, true, paramOverrides);
            chatMessages.value.push({ role: 'assistant', swipes: [reply], index: 0 });
        } catch (e) {
            showToast && showToast('续写失败: ' + (e && e.message ? e.message : e));
        } finally {
            chatSending.value = false;
            saveCurrentChat();
        }
    }

    // ==================== 会话 ====================
    function syncSessions() {
        try { sessions.value = loadSessions(cardPath()) || []; } catch (e) { sessions.value = []; }
        if (chatSessionsVersion) chatSessionsVersion.value++;
    }
    function saveCurrentChat() {
        if (!activeSessionId.value) return;
        try {
            // 快照拷贝，避免 live reactive 对象与存储互相干扰
            persistMessages(cardPath(), activeSessionId.value, JSON.parse(JSON.stringify(chatMessages.value)));
            syncSessions();
        } catch (e) { /* 存储不可用时忽略 */ }
    }
    function newSession() {
        const s = createSession(cardPath());
        upsertSession(cardPath(), s);
        activeSessionId.value = s.id;
        setLastSessionId(cardPath(), s.id);
        chatMessages.value = [];
        ensureVarEngine();
        syncSessions();
    }
    function switchSession(id) {
        if (!id || id === activeSessionId.value) return;
        saveCurrentChat();
        activeSessionId.value = id;
        setLastSessionId(cardPath(), id);
        const s = sessions.value.find((x) => x.id === id);
        chatMessages.value = s && Array.isArray(s.messages) ? JSON.parse(JSON.stringify(s.messages)) : [];
        ensureVarEngine();
        if (!chatMessages.value.length) pushFirstMessage();
    }
    function renameSessionById(id, name) {
        renameSession(cardPath(), id, name);
        syncSessions();
    }
    function removeSessionById(id) {
        deleteSession(cardPath(), id);
        syncSessions();
        if (id === activeSessionId.value) {
            const first = sessions.value[0];
            activeSessionId.value = '';
            if (first) switchSession(first.id);
            else { newSession(); }
        }
    }

    // ==================== 开场白 ====================
    /** 开场白：EJS → 宏 → MVU 初始化 → AI 正则（对齐移动版 pushFirstMessage） */
    function pushFirstMessage() {
        const sd = (safeData && safeData.value) || {};
        const first = sd.first_mes || '';
        if (!first) return;
        let text = renderTpl(first, '开场白');
        text = applyMacros(text, fullMacros.value);
        if (mvuEnabled() && varEngine.value) text = varEngine.value.onAiMessage(text);
        text = applyRegexScripts(text, mergedRegex.value, 'AI', fullMacros.value);
        chatMessages.value = [{ role: 'assistant', swipes: [text], index: 0 }];
    }

    /** 初始化：恢复上次会话 / 新建；无消息则补开场白 */
    function initChat() {
        syncSessions();
        const last = getLastSessionId(cardPath());
        const target = (last && sessions.value.some((s) => s.id === last)) ? last : (sessions.value[0] && sessions.value[0].id) || '';
        activeSessionId.value = target || '';
        if (!activeSessionId.value) { newSession(); return; }
        const s = sessions.value.find((x) => x.id === activeSessionId.value);
        chatMessages.value = s && Array.isArray(s.messages) ? JSON.parse(JSON.stringify(s.messages)) : [];
        ensureVarEngine();
        if (!chatMessages.value.length) pushFirstMessage();
    }

    function clearChat() {
        chatMessages.value = [];
        if (activeSessionId.value) persistMessages(cardPath(), activeSessionId.value, []);
        resetVars();
        pushFirstMessage();
        saveCurrentChat();
    }

    /** 切卡时调用：重建会话列表与变量引擎，重载开场白 */
    function resetForCard() {
        activeSessionId.value = '';
        chatMessages.value = [];
        sessions.value = [];
        varEngine.value = null;
        initChat();
    }

    // ==================== 渲染 ====================
    const segRenderEnabled = () => getChatFlag('seg');
    /** 消息 → 分段数组（分段渲染关闭时退化为单段文本） */
    function segmentsOf(msg) {
        const text = messageText(msg);
        if (!segRenderEnabled()) return [{ type: 'text', content: text }];
        return promoteHtmlSegments(segmentMessage(text));
    }
    /** HTML 段需要的变量树 JSON（供 iframe 内 getVariables） */
    const varsJson = computed(() => {
        try { return JSON.stringify(varEngine.value ? varEngine.value.root : {}); } catch (e) { return '{}'; }
    });

    /** 卸载时落盘 */
    function teardown() { saveCurrentChat(); }

    return {
        // 状态
        chatMessages, chatDraft, chatSending, lastUserActivity,
        sessions, activeSessionId,
        varEngine, varsTree, varsLog, varsStats, varsJson,
        fullMacros, activePreset, templateCtx,
        // 动作
        initChat, resetForCard, clearChat, sendChat, buildPayload, requestReply,
        nextSwipe, prevSwipe, moreSwipe, regenerateSwipe, continueSwipe,
        newSession, switchSession, renameSessionById, removeSessionById, saveCurrentChat,
        resetVars, undoVar, setVar,
        segmentsOf, renderTpl, collectActivatedWbText,
        teardown,
        // 内部（供测试/调试）
        _internal: { messageText, applyRegexScripts, mergedRegex }
    };
}
