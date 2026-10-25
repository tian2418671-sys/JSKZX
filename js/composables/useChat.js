/**
 * 聊天测卡功能组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：聊天历史/输入/发送、API 配置保存与类型切换、模型列表拉取、渲染模式开关。
 * 共享响应式状态（apiEndpoint / apiKey / apiModel / apiType）与共享工具（resolveApiModel / extractReplyContent）
 * 保留在 App.vue 顶层并注入（被 syncConfigToDisk / useAITools / 模板引用），其余状态与操作方法在此定义，
 * 依赖通过参数注入，保持原有行为不变。
 */
import { ref } from 'vue';
import { partitionModelIds } from '../utils/modelId.js';   // 🏷️ AI-21：模型名合法性过滤

export function useChat({
    apiEndpoint, apiKey, apiModel, apiType,
    resolveApiModel, extractReplyContent,
    DEFAULT_API_ENDPOINT,
    syncConfigToDisk,
    nativeAlert,
    safeData,
    cardData
}) {
    const chatHistory = ref([]); // 聊天记录
    const chatInput = ref('');   // 用户输入
    const isChatting = ref(false); // 加载状态
    const chatContainer = ref(null); // 用于自动滚动

    // 手动保存 API 配置（按钮触发，立即落盘 + 提示）
    const saveApiConfig = async () => {
        try {
            localStorage.setItem('stc-api-endpoint', apiEndpoint.value);
            // 🔐 加密 API Key 后落盘（代码审查修复 2）
            let encKey = apiKey.value || '';
            if (encKey && window.electronAPI && typeof window.electronAPI.encryptSecret === 'function') {
                try { const enc = await window.electronAPI.encryptSecret(encKey); if (enc && enc.success && enc.value) encKey = enc.value; } catch (e) { /* 加密失败回退明文 */ }
            }
            localStorage.setItem('stc-api-key', encKey);
            localStorage.setItem('stc-api-model', apiModel.value);
            localStorage.setItem('stc-api-type', apiType.value);
            syncConfigToDisk(); // 🛡️ 统一中枢立即落盘（生产 app:// 下 localStorage 不持久，物理文件才是权威）
            nativeAlert('API 设置已成功保存！', 'info');
        } catch (e) {
            // 【修复】存储失败（配额超限/权限禁用）时必须如实告知，杜绝假成功
            console.error('API 设置存储失败:', e);
            nativeAlert('保存失败：可能是本地存储权限被禁用或存储空间已满。', 'error');
        }
    };

    // 切换 API 类型时自动填充常用默认 Endpoint / Model
    const handleApiTypeChange = () => {
        if (apiType.value === 'anthropic') {
            if (!apiEndpoint.value || apiEndpoint.value.includes('openai') || apiEndpoint.value.includes('1234')) {
                apiEndpoint.value = 'https://api.anthropic.com';
                apiModel.value = 'claude-3-5-sonnet-20241022';
            }
        } else {
            if (!apiEndpoint.value || apiEndpoint.value.includes('anthropic')) {
                apiEndpoint.value = DEFAULT_API_ENDPOINT;
                apiModel.value = '';
            }
        }
        saveApiConfig();
    };

    // ================= [ API 模型列表拉取（GET /v1/models，经主进程转发绕过 CORS）] =================
    const availableModels = ref([]);      // 拉取到的服务端模型列表
    const isFetchingModels = ref(false);  // 是否正在拉取
    const fetchModelStatus = ref('');     // 拉取状态提示

    const fetchAvailableModels = async () => {
        const ep = (apiEndpoint.value || '').trim();
        if (!ep) {
            nativeAlert('请先输入有效的 API Endpoint 地址！', 'warning');
            return;
        }
        isFetchingModels.value = true;
        fetchModelStatus.value = '⏳ 正在连接服务端拉取模型列表...';
        availableModels.value = [];
        try {
            const authKey = (apiKey.value && apiKey.value.trim()) ? apiKey.value : 'test-key';
            const result = await window.electronAPI.fetchModels(ep, authKey, apiType.value);
            if (!result || !result.success) {
                fetchModelStatus.value = `❌ 拉取失败: ${(result && result.error) || '未知错误'}`;
                return;
            }
            // 兼容 OpenAI / LM Studio 标准格式 { data: [{ id }] } 与裸数组
            const raw = result.data;
            let rawList = [];
            if (Array.isArray(raw.data)) {
                rawList = raw.data.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean);
            } else if (Array.isArray(raw)) {
                rawList = raw.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean);
            }
            // 🏷️ AI-21：先过「像不像模型名」这道闸（中转站会返回「当前无可用模型」这类提示语）
            const { valid: modelList, rejected } = partitionModelIds(rawList);
            if (modelList.length === 0) {
                // 一个合法模型都没有 ⇒ **保留用户已填的值**，且如实告知（绝不显示「✅ 成功」）
                fetchModelStatus.value = rawList.length
                    ? `⚠️ 接口返回的 ${rawList.length} 项均不像是模型名（示例：${String(rawList[0]).slice(0, 20)}），已保留当前模型「${apiModel.value || '（空）'}」`
                    : '⚠️ 接口已响应，但未抓取到有效模型列表';
                availableModels.value = [];   // 不把垃圾写进下拉候选
                return;
            }
            availableModels.value = modelList;
            const prevModel = String(apiModel.value || '').trim();
            // 🔒 根因级防线：**原值非空就绝不改写**；只有原本为空时才自动选第一项
            if (!prevModel) {
                apiModel.value = modelList[0];
                fetchModelStatus.value = `✅ 成功获取 ${modelList.length} 个模型（原模型为空，已自动选中「${modelList[0]}」）`;
            } else if (modelList.includes(prevModel)) {
                fetchModelStatus.value = `✅ 成功获取 ${modelList.length} 个模型（当前模型「${prevModel}」在列表中）`;
            } else {
                fetchModelStatus.value = `✅ 成功获取 ${modelList.length} 个模型；当前模型「${prevModel}」不在列表中（已保留，未改动）`;
            }
            if (rejected.length) {
                fetchModelStatus.value += ` ｜ 已忽略 ${rejected.length} 项无效返回`;
            }
        } catch (err) {
            console.error('拉取模型列表失败:', err);
            fetchModelStatus.value = `❌ 拉取失败: ${err.message}`;
        } finally {
            isFetchingModels.value = false;
        }
    };

    // 【新增】聊天界面的 渲染/代码 模式开关 (默认 false 为代码模式，true 为渲染模式)
    const isChatRenderMode = ref(false);

    // 构造系统提示词 (模拟 Tavern 的基础拼接逻辑)
    const buildSystemPrompt = () => {
        const d = safeData.value;
        const charName = d.name || '角色';
        const sysPrompt = d.system_prompt ? d.system_prompt + '\n\n' : '';

        return `${sysPrompt}你要扮演 ${charName}。\n【角色描述】: ${d.description || ''}\n【性格特征】: ${d.personality || ''}\n【当前场景】: ${d.scenario || ''}\n\n请保持角色的设定，使用符合角色性格的语气与我对话。`;
    };

    // 初始化聊天 (点击进入测卡 Tab 时调用)
    const initChat = () => {
        if (chatHistory.value.length === 0 && safeData.value.first_mes) {
            chatHistory.value = [
                { role: 'system', content: buildSystemPrompt() },
                { role: 'assistant', content: safeData.value.first_mes, name: safeData.value.name }
            ];
        }
    };

    // 发送消息
    const sendMessage = async () => {
        if (chatInput.value.trim() === '' || isChatting.value) return;

        const userText = chatInput.value.trim();
        chatHistory.value.push({ role: 'user', content: userText, name: '你' });
        chatInput.value = '';
        isChatting.value = true;

        scrollToBottom();

        // 【修复】记录发起请求时的卡片引用，防止在途请求期间切卡导致旧卡回复挂到新卡
        const targetCard = cardData.value;

        // 过滤掉 UI 用的 name 属性，只保留 OpenAI 标准的 role 和 content
        const payload = {
            model: resolveApiModel(), // 优先使用配置的模型名称，留空回退 local-model
            messages: chatHistory.value.map(msg => ({ role: msg.role, content: msg.content })),
            temperature: 0.7,
            max_tokens: 500
        };

        try {
            // 持久化 API Key（localStorage 可能不可用，做防御性写入）
            // 🔐 加密后落盘（代码审查修复 2）
            try {
                if (apiKey.value && window.electronAPI && typeof window.electronAPI.encryptSecret === 'function') {
                    const enc = await window.electronAPI.encryptSecret(apiKey.value);
                    localStorage.setItem('stc-api-key', (enc && enc.success && enc.value) ? enc.value : apiKey.value);
                } else {
                    localStorage.setItem('stc-api-key', apiKey.value);
                }
            } catch (e) { /* 忽略 */ }
            const result = await window.electronAPI.sendChatMessage(apiEndpoint.value, payload, apiKey.value, apiType.value);

            // 【修复】在途请求期间用户切卡 → chatHistory 已被清空/重建，直接丢弃回复，不污染新卡
            if (cardData.value !== targetCard) return;

            const reply = extractReplyContent(result);
            if (result.success && reply) {
                chatHistory.value.push({ role: 'assistant', content: reply, name: safeData.value.name });
            } else {
                nativeAlert(result.error || "模型返回了空数据", "error", "API 请求失败");
                // 撤回用户的发送以便重试
                chatHistory.value.pop();
                chatInput.value = userText;
            }
        } catch (e) {
            nativeAlert(`请求异常: ${e.message}`, "error");
        } finally {
            isChatting.value = false;
            scrollToBottom();
        }
    };

    const scrollToBottom = () => {
        setTimeout(() => {
            if (chatContainer.value) {
                chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
            }
        }, 100);
    };

    // 重置聊天
    const clearChat = () => {
        chatHistory.value = [];
        initChat();
    };

    return {
        chatHistory, chatInput, isChatting, chatContainer,
        saveApiConfig, handleApiTypeChange,
        availableModels, isFetchingModels, fetchModelStatus, fetchAvailableModels,
        isChatRenderMode,
        initChat, sendMessage, clearChat
    };
}