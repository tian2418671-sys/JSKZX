/**
 * 统一配置持久化中枢（Composable）
 * 从 App.vue 拆分而来，收敛：app_config.json（最高权威）的收集 → API Key 加密 → 原子落盘、
 * 落盘防抖（500ms 合并写放大）、启动恢复期禁写保护（isRestoringConfig）、窗口关闭前冲刷。
 * appConfig（唯一权威源 ref 本体）与全部被收集的业务 ref 保留在 App.vue 顶层并注入。
 *
 * ⚠️ 调用时序约束（TDZ）：
 *   - 必须晚于全部被收集 ref 的定义（最晚者为 wbCategoryMap）；
 *   - 必须早于 useCardCrud / useChat / useTags / useCardGroups 等注入 syncConfigToDisk 的消费方；
 *   - App.vue 内各 watch（removedDefaultKeys/customCategories/localCategoryMap/apiXxx/systemCommonTags/tagLangMode 等）
 *     回调引用本组合式函数返回的 const —— 回调均为运行时执行（无 immediate 注册），闭包安全。
 *     onMounted 恢复期赋值 isRestoringConfig 须用 .value（ref 化）。
 */
import { ref } from 'vue';

export function useConfigPersistence({
    // —— 唯一权威源（App.vue 顶层持有） ——
    appConfig,
    // —— 收集源：全局状态 ——
    tagLangMode, customCategories, removedDefaultKeys, systemCommonTags,
    // —— 收集源：API 配置 ——
    apiEndpoint, apiKey, apiModel, apiType,
    // —— 收集源：UI 状态 ——
    theme, appSettings, sanitizeImportedTags, snapshotConfig, localCategoryMap,
    sidebarWidth, viewMode, isCompactMode, sortBy,
    systemPromptPresets, lastWorldbookDirPath, lastPresetDirPath, wbCategoryMap
}) {
    // 🛡️ 启动配置恢复保护：loadAppConfig 恢复字段时置 true，防止各 watch 触发写盘把「恢复值/旧残留」回写 app_config.json
    //    （否则旧文件 / localStorage 残留会在加载竞态中被写回权威文件，导致「删除/清空后重启复活」）
    const isRestoringConfig = ref(false);

    // 统一写入磁盘：从各响应式源收集完整配置 → JSON 剥离 Vue 响应式 Proxy → 原子落盘
    // ⚠️ 关键：ref 的 value 若为对象/数组会被 reactive 包装成 Proxy，直接传 IPC 会报
    //    "An object could not be cloned"（structured clone 失败）→ 必须统一 JSON 序列化剥离。
    const syncConfigToDisk = async () => {
        if (isRestoringConfig.value) return; // 启动恢复期间不落盘，避免把恢复值/旧值写回造成复活
        if (!window.electronAPI || typeof window.electronAPI.saveAppConfig !== 'function') return;
        // 🔐 加密 API Key 后落盘（代码审查修复 2）：密文写入 app_config.json，明文只存内存
        const rawKey = apiKey ? apiKey.value : (appConfig.value.api && appConfig.value.api.key) || '';
        let encKey = rawKey || '';
        if (rawKey && typeof window.electronAPI.encryptSecret === 'function') {
            try {
                const enc = await window.electronAPI.encryptSecret(rawKey);
                if (enc && enc.success && enc.value) encKey = enc.value;
            } catch (e) { /* 加密失败回退明文 */ }
        }
        const payload = {
            language: 'zh-CN',
            tagLangMode: tagLangMode.value,
            customCategories: JSON.parse(JSON.stringify(Array.isArray(customCategories.value) ? customCategories.value : [])),
            removedDefaultKeys: JSON.parse(JSON.stringify(Array.isArray(removedDefaultKeys.value) ? removedDefaultKeys.value : [])),
            globalTags: JSON.parse(JSON.stringify(Array.isArray(systemCommonTags.value) ? systemCommonTags.value : [])),
            cardOverlays: JSON.parse(JSON.stringify(appConfig.value.cardOverlays || {})),
            api: {
                endpoint: apiEndpoint ? apiEndpoint.value : (appConfig.value.api && appConfig.value.api.endpoint) || '',
                key: encKey,
                model: apiModel ? apiModel.value : (appConfig.value.api && appConfig.value.api.model) || '',
                type: apiType ? apiType.value : (appConfig.value.api && appConfig.value.api.type) || 'openai'
            },
            // 🧩 UI 状态统一收口：生产 app:// 下 localStorage 不持久，改存 app_config.json
            ui: {
                theme: theme.value,
                appSettings: JSON.parse(JSON.stringify(appSettings.value || {})),
                sanitizeImportedTags: sanitizeImportedTags.value,
                snapshotConfig: JSON.parse(JSON.stringify(snapshotConfig.value || {})),
                localCategoryMap: JSON.parse(JSON.stringify(localCategoryMap.value || {})),
                sidebarWidth: Number(sidebarWidth.value) || 0,
                viewMode: viewMode.value,
                isCompactMode: isCompactMode.value,
                sortBy: sortBy.value,
                systemPromptPresets: JSON.parse(JSON.stringify(Array.isArray(systemPromptPresets.value) ? systemPromptPresets.value : [])),
                lastWorldbookDirPath: lastWorldbookDirPath.value || '',
                lastPresetDirPath: lastPresetDirPath.value || '',
                wbCategoryMap: JSON.parse(JSON.stringify(wbCategoryMap.value || {}))
            }
        };
        window.electronAPI.saveAppConfig(payload).catch(() => { });
    };

    // 🔧 落盘防抖：批量操作（清空标签/批量删除/批量加标签等）会对每张卡
    // 调 persistCardUpdate → syncConfigToDisk（全量序列化 + 加密 IPC + 写盘），
    // 几千张卡 = 几千次写放大。500ms 内的变更合并为一次落盘。
    let syncTimer = null;
    const syncConfigToDiskDebounced = () => {
        if (isRestoringConfig.value) return;
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = null;
            syncConfigToDisk();
        }, 500);
    };
    // 窗口关闭前冲刷最后一次挂起的落盘（尽力而为：IPC 为异步，极端情况可能来不及）
    window.addEventListener('beforeunload', () => {
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
            syncConfigToDisk();
        }
    });

    // 【兼容保留】统一将关键 UI 状态（分组/语言/卡片分类等）持久化到主进程配置文件。
    // 现在内部直接走统一中枢 syncConfigToDisk（app_config.json 唯一权威），旧文件双写已移除（避免双权威竞态）。
    const saveUiSettingsToDisk = () => {
        if (!window.electronAPI) return;
        if (isRestoringConfig.value) return; // 启动恢复期间不落盘
        // 统一写入 app_config.json（唯一权威）；旧文件 uiSettings 双写已移除
        syncConfigToDisk();
    };

    return {
        isRestoringConfig,
        syncConfigToDisk,
        syncConfigToDiskDebounced,
        saveUiSettingsToDisk
    };
}
