/**
 * 🧩 卡内插件页签（组合式函数）
 * =========================================================
 * 展示「当前打开这张角色卡」自带的所有酒馆插件：
 *   · 酒馆助手脚本（extensions.tavern_helper.scripts，含旧版 TavernHelper_scripts / 键值对数组形态）→ **可编辑**
 *   · 助手变量数据（MVU 初始变量）、MVU 变量组、第三方写卡扩展数据 → 只读查看（JSON 代码编辑器）
 *
 * ⚠️ 与项目既有概念的分工（避免出现「第 N 套插件」）：
 *   · `usePlugins.js` / `PluginWorkspace.vue` = **磁盘上的插件工程**（左侧「插件」主入口）
 *   · 本模块 = **卡片文件内嵌的插件**，跟着卡片走，随「保存卡片」一起写回
 *   · `extensions.regex_scripts` 归「正则脚本」页签，这里只统计条数
 *
 * ⚠️ 响应式：cardData 是 shallowRef → 深层编辑不触发渲染，改动后必须 refreshCardData()；
 *    但 CodeMirror 每次按键都会回传全文，逐键全卡刷新（含 Token 缓存失效）代价太大 →
 *    正文走 400ms 防抖，收起源码/收起全屏时立即 flush。
 */
import { ref, computed, watch } from 'vue';
import {
    harvestCardPlugins,
    resolveScriptContainer,
    createScriptEntry,
    writeScriptField
} from '../utils/cardPlugins.js';

export function useCardPlugins({
    cardData, safeData, cardContentVersion,
    refreshCardData, confirmDialog, addLog
}) {
    // 展开查看（内嵌代码编辑器）的条目 / 全屏放大的条目（uid 字符串）
    const pluginExpandedUid = ref({});
    const pluginFullscreenUid = ref('');

    // 只读 JSON 组的文本缓存（WeakMap：卡片对象不换就复用，避免每次渲染都 stringify 大对象）
    const jsonTextCache = new WeakMap();

    // -------- 刷新防抖（正文编辑） --------
    let refreshTimer = null;
    const flushPluginEdits = () => {
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        refreshCardData();
    };
    const schedulePluginRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { refreshTimer = null; refreshCardData(); }, 400);
    };

    // -------- 数据 --------
    const cardPluginInfo = computed(() => {
        cardContentVersion.value;   // 🔔 容器被整体替换（如首次新增脚本）也要重算
        return harvestCardPlugins(safeData.value);
    });
    const pluginScriptGroup = computed(() =>
        cardPluginInfo.value.groups.find(g => g.key === 'tavern-helper') || null);
    const pluginExtraGroups = computed(() =>
        cardPluginInfo.value.groups.filter(g => g.key !== 'tavern-helper'));
    const cardPluginCount = computed(() => cardPluginInfo.value.total);

    const scriptUid = (item, index) => `script::${item?.uid ?? index}`;

    const findScriptItem = (uid) => {
        const group = pluginScriptGroup.value;
        if (!group || !uid) return null;
        return group.items.find((it, i) => scriptUid(it, i) === uid) || null;
    };
    const pluginFullscreenItem = computed(() => findScriptItem(pluginFullscreenUid.value));

    const isPluginItemExpanded = (uid) => !!pluginExpandedUid.value[uid];
    const togglePluginItem = (uid) => {
        if (!uid) return;
        const next = { ...pluginExpandedUid.value };
        if (next[uid]) {
            delete next[uid];
            flushPluginEdits();          // 收起源码 → 立即结算本次编辑
        } else {
            next[uid] = true;
        }
        pluginExpandedUid.value = next;
    };

    const openPluginFullscreen = (uid) => { pluginFullscreenUid.value = uid || ''; };
    const closePluginFullscreen = () => {
        if (pluginFullscreenUid.value) flushPluginEdits();
        pluginFullscreenUid.value = '';
    };

    // -------- 编辑 --------
    /** 更新脚本字段（name / enabled / content）；正文防抖刷新，其余立即刷新视图 */
    const updatePluginItemField = (item, field, value) => {
        if (!item || !writeScriptField(item, field, value)) return;
        if (field === 'content') schedulePluginRefresh();
        else refreshCardData();
    };

    const addPluginScript = () => {
        const container = resolveScriptContainer(safeData.value, { create: true });
        if (!container.list) return;
        const entry = createScriptEntry({ legacy: container.legacy, name: `新建脚本 ${container.list.length + 1}` });
        container.list.push(entry);
        refreshCardData();
        addLog?.(`➕ 已为当前卡新增酒馆助手脚本（共 ${container.list.length} 条）`, 'info');
    };

    const deletePluginScript = async (item, index) => {
        const container = resolveScriptContainer(safeData.value);
        if (!container.list) return;
        const target = item?.entry || container.list[index];
        const idx = container.list.indexOf(target);
        if (idx < 0) return;
        const label = item?.name || `#${idx + 1}`;
        // ⚠️ confirmDialog 只接受**一个字符串**（Electron dialog.showMessageBox 的 message），
        //    传第二个参数会被静默丢弃 → 明细必须拼进同一个字符串（与 deleteRegexScript 写法一致）。
        const ok = await confirmDialog(
            `确定删除酒馆助手脚本「${label}」吗？\n\n` +
            `• 删除后立即从列表消失（共 ${container.list.length} 条 → ${container.list.length - 1} 条）\n` +
            `• 只改内存中的卡片数据，点「保存卡片」才会写回文件\n` +
            `• 未保存前关闭卡片可放弃改动`
        );
        if (!ok) return;
        container.list.splice(idx, 1);
        const next = { ...pluginExpandedUid.value };
        delete next[scriptUid(item, index)];
        pluginExpandedUid.value = next;
        if (pluginFullscreenUid.value === scriptUid(item, index)) pluginFullscreenUid.value = '';
        refreshCardData();
        addLog?.(`🗑️ 已删除酒馆助手脚本「${label}」（剩 ${container.list.length} 条）`, 'warning');
    };

    // -------- 只读 JSON 文本（懒生成 + 缓存） --------
    const pluginJsonText = (group) => {
        if (!group || group.text !== undefined) return group?.text || '';
        const host = group.host;
        if (!host || typeof host !== 'object') return String(host ?? '');
        const cached = jsonTextCache.get(host);
        if (cached !== undefined) return cached;
        let text = '';
        try { text = JSON.stringify(host, null, 2); } catch { text = String(host); }
        jsonTextCache.set(host, text);
        return text;
    };

    // 切换卡片 → 收起展开态，避免上一张卡的 uid 悬空
    watch(cardData, () => {
        pluginExpandedUid.value = {};
        pluginFullscreenUid.value = '';
    });

    return {
        cardPluginInfo, pluginScriptGroup, pluginExtraGroups, cardPluginCount,
        scriptUid, findScriptItem, pluginFullscreenItem,
        isPluginItemExpanded, togglePluginItem, openPluginFullscreen, closePluginFullscreen,
        updatePluginItemField, addPluginScript, deletePluginScript,
        pluginJsonText, flushPluginEdits
    };
}
