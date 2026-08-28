/**
 * 预设管理组合式函数（Composable）
 * 管理 SillyTavern 的 OpenAI Settings / Presets 目录下的 JSON 预设文件。
 * 状态（presets/activePreset/lastPresetDirPath 等）保留在 App.vue 并注入。
 */
import { ref, computed } from 'vue';

export function usePresets({
    // 共享状态
    presets, activePreset, lastPresetDirPath,
    // 工具方法
    nativeAlert, confirmDialog, addLog, appPrompt,
    contextMenu, closeContextMenu,
    // 视图模式
    appMode
}) {
    // =========================================================
    // 预设扫描与加载
    // =========================================================

    const presetSearchQuery = ref('');   // 预设搜索关键字
    const isImportingPreset = ref(false); // 导入中 loading 状态
    const importPresetUrl = ref('');      // 网址导入输入框绑定

    // 打开预设目录（弹目录选择；扫描 .json 预设文件）
    const loadPresets = async () => {
        const dirPath = await window.electronAPI.selectGenericFolder();
        if (!dirPath) return;
        await scanPresetDir(dirPath);
        appMode.value = 'presets';
    };

    // 扫描指定预设目录（供手动选择与启动自动恢复共用；自动持久化记忆路径）
    const scanPresetDir = async (dirPath) => {
        if (!dirPath) return;
        lastPresetDirPath.value = dirPath;
        try { localStorage.setItem('jsTavern_lastPresetDir', dirPath); } catch (e) { /* 忽略 */ }

        addLog(`开始扫描预设目录: ${dirPath}`);
        const res = await window.electronAPI.scanPresets(dirPath);
        if (res.success) {
            presets.value = res.data;
            // 重扫后按路径重绑当前编辑对象，找不到则清空
            if (activePreset.value) {
                const prevPath = activePreset.value.path;
                activePreset.value = res.data.find(p => p.path === prevPath) || null;
            }
            addLog(`扫描完成，共加载 ${res.data.length} 个预设`, 'success');
        } else {
            addLog(`扫描失败: ${res.error}`, 'error');
            nativeAlert(`预设扫描失败: ${res.error}`, 'error');
        }
    };

    // =========================================================
    // 预设筛选
    // =========================================================

    const filteredPresets = computed(() => {
        const q = presetSearchQuery.value.trim().toLowerCase();
        if (!q) return presets.value;
        return presets.value.filter(p => {
            const name = (p.data && p.data.name) || p.name || '';
            return name.toLowerCase().includes(q);
        });
    });

    // =========================================================
    // 预设保存
    // =========================================================

    const saveActivePreset = async () => {
        if (!activePreset.value) return;
        const p = activePreset.value;
        if (!p.path) {
            nativeAlert('该预设尚未落盘，无法保存。请先选择保存位置。', 'warning');
            return;
        }
        try {
            const res = await window.electronAPI.savePreset({ filePath: p.path, data: p.data });
            if (res && res.success) {
                addLog(`💾 预设已保存: ${p.name}`, 'success');
                nativeAlert(`✅ 预设已保存: ${p.name}`, 'info');
            } else {
                nativeAlert(`保存失败: ${(res && res.error) || '未知错误'}`, 'error');
            }
        } catch (err) {
            nativeAlert(`保存失败: ${err.message}`, 'error');
        }
    };

    // =========================================================
    // 预设重命名
    // =========================================================

    const renamePreset = async (p) => {
        if (!p) return;
        const oldName = ((p.data && p.data.name) || p.name || '未命名预设').replace(/\.json$/i, '');
        const newName = await appPrompt('✏️ 请输入新的预设名称：', oldName);
        if (newName === null || newName.trim() === '' || newName.trim() === oldName) return;
        const finalName = newName.trim();

        if (p.data) p.data.name = finalName;

        const safeFileName = `${finalName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
        if (p.path) {
            const oldPath = p.path;
            const dir = oldPath.replace(/[\\/][^\\/]*$/, '');
            const newPath = `${dir}\\${safeFileName}`;
            if (oldPath !== newPath) {
                const res = await window.electronAPI.renamePresetFile({ oldPath, newPath });
                if (res && res.success) {
                    p.path = newPath;
                    p.name = safeFileName;
                    addLog(`📝 已重命名预设: ${oldName} → ${finalName}`, 'success');
                    nativeAlert(`✏️ 重命名成功！\n新名称: ${finalName}`, 'info');
                } else {
                    nativeAlert(`内部名称已更新，但物理文件改名失败: ${(res && res.error) || '未知错误'}`, 'warning');
                }
            }
        } else {
            p.name = safeFileName;
            addLog(`📝 已重命名预设: ${oldName} → ${finalName}`, 'success');
        }
    };

    // =========================================================
    // 预设删除（移入回收站）
    // =========================================================

    const deletePreset = async (p) => {
        if (!p) return;
        const name = (p.data && p.data.name) || p.name || '未命名预设';
        const ok = await confirmDialog(`🗑️ 确认删除预设？`, `即将删除预设「${name}」。\n文件将移入回收站，可恢复。\n\n确认删除？`);
        if (!ok) return;
        try {
            if (p.path) {
                const res = await window.electronAPI.trashFiles([p.path]);
                if (!res || !res.success) {
                    nativeAlert(`删除失败: ${(res && res.error) || '未知错误'}`, 'error');
                    return;
                }
            }
            // 从列表移除
            const idx = presets.value.indexOf(p);
            if (idx >= 0) presets.value.splice(idx, 1);
            if (activePreset.value === p) activePreset.value = null;
            addLog(`🗑️ 已删除预设: ${name}`, 'success');
            nativeAlert(`✅ 已删除预设: ${name}`, 'info');
        } catch (err) {
            nativeAlert(`删除失败: ${err.message}`, 'error');
        }
    };

    // =========================================================
    // 预设复制
    // =========================================================

    const duplicatePreset = async (p) => {
        if (!p) return;
        const name = (p.data && p.data.name) || p.name || '未命名预设';
        const copyName = await appPrompt('📋 复制为副本', `${name}_副本`);
        if (copyName === null || copyName.trim() === '') return;
        const finalName = copyName.trim();
        const safeFileName = `${finalName.replace(/[\\/:*?"<>|]/g, '_')}.json`;

        // 深拷贝数据
        const copyData = JSON.parse(JSON.stringify(p.data || {}));
        copyData.name = finalName;

        // 落盘
        let saveDir = lastPresetDirPath.value;
        if (!saveDir) {
            saveDir = await window.electronAPI.selectGenericFolder();
        }
        if (saveDir) {
            lastPresetDirPath.value = saveDir;
            try { localStorage.setItem('jsTavern_lastPresetDir', saveDir); } catch (e) { /* 忽略 */ }
            const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
            const saveRes = await window.electronAPI.createPreset({ filePath, data: copyData });
            if (saveRes && saveRes.success) {
                const newP = { path: filePath, name: safeFileName, data: copyData };
                presets.value.push(newP);
                activePreset.value = newP;
                addLog(`📋 已复制预设: ${name} → ${finalName}`, 'success');
                nativeAlert(`✅ 已复制为副本: ${finalName}`, 'info');
            } else {
                nativeAlert(`复制失败: ${(saveRes && saveRes.error) || '未知错误'}`, 'error');
            }
        }
    };

    // =========================================================
    // 预设右键菜单
    // =========================================================

    const openPresetContextMenu = (event, p) => {
        contextMenu.value = {
            visible: true,
            x: event.clientX,
            y: event.clientY,
            items: [
                { label: '✏️ 重命名', action: () => renamePreset(p) },
                { label: '📋 复制副本', action: () => duplicatePreset(p) },
                { label: '📂 在资源管理器中定位', action: () => openPresetInFolder(p) },
                { type: 'separator' },
                { label: '🗑️ 删除（移入回收站）', action: () => deletePreset(p), danger: true }
            ]
        };
    };

    const openPresetInFolder = (p) => {
        if (!p || !p.path) {
            nativeAlert('该预设尚未落盘，无法在资源管理器中定位。', 'warning');
            return;
        }
        window.electronAPI.showItemInFolder(p.path);
    };

    // =========================================================
    // 网址导入预设
    // =========================================================

    const importPresetFromUrl = async () => {
        const url = importPresetUrl.value.trim();
        if (!url) {
            nativeAlert('请先输入预设的 JSON 直链网址！', 'warning');
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            nativeAlert('网址格式不正确，请粘贴以 http:// 或 https:// 开头的 .json 直链。', 'warning');
            return;
        }

        isImportingPreset.value = true;
        try {
            addLog(`开始从网址导入预设: ${url}`);
            const text = await fetchRemoteText(url);
            const pData = JSON.parse(text);

            // 归一化预设数据
            const presetName = (pData.name || `网络导入预设_${Date.now()}`).trim();
            pData.name = presetName;

            const safeFileName = `${presetName.replace(/[\\/:*?"<>|]/g, '_')}.json`;

            // 落盘
            let saveDir = lastPresetDirPath.value;
            if (!saveDir) {
                addLog('未检测到上次预设目录，请选择保存位置...', 'warning');
                saveDir = await window.electronAPI.selectGenericFolder();
            }
            if (saveDir) {
                lastPresetDirPath.value = saveDir;
                try { localStorage.setItem('jsTavern_lastPresetDir', saveDir); } catch (e) { /* 忽略 */ }
                const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
                const saveRes = await window.electronAPI.createPreset({ filePath, data: pData });
                if (saveRes && saveRes.success) {
                    const newP = { path: filePath, name: safeFileName, data: pData };
                    presets.value.push(newP);
                    activePreset.value = newP;
                    addLog(`🎉 成功导入预设: ${presetName}`, 'success');
                    nativeAlert(`🎉 成功导入预设: ${presetName}`, 'info');
                    importPresetUrl.value = '';
                } else {
                    nativeAlert(`落盘失败: ${(saveRes && saveRes.error) || '未知错误'}`, 'error');
                }
            } else {
                addLog('用户取消选择目录，导入的预设仅保留在当前会话。', 'warning');
            }
        } catch (error) {
            console.error('预设导入失败:', error);
            addLog(`❌ 预设导入失败: ${error.message}`, 'error');
            nativeAlert(`❌ 导入失败！请确保网址是直接指向 JSON 文件的有效直链。\n错误详情: ${error.message}`, 'error');
        } finally {
            isImportingPreset.value = false;
        }
    };

    // 拉取远程 JSON 文本
    const fetchRemoteText = async (url) => {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`网络请求失败 (状态码: ${response.status})`);
            return await response.text();
        } catch (err) {
            if (window.electronAPI && typeof window.electronAPI.fetchWbUrl === 'function') {
                const res = await window.electronAPI.fetchWbUrl(url);
                if (res && res.success) return res.data;
                throw new Error((res && res.error) || err.message);
            }
            throw err;
        }
    };

    // =========================================================
    // 批量导出
    // =========================================================

    const exportPresetsBatch = async () => {
        const filePaths = presets.value.filter(p => p.path).map(p => p.path);
        if (filePaths.length === 0) {
            nativeAlert('没有已落盘的预设可导出。', 'warning');
            return;
        }
        try {
            const res = await window.electronAPI.exportPresetsBatch(filePaths);
            if (res && res.success) {
                addLog(`📦 已批量导出 ${res.count} 个预设到: ${res.outDir}`, 'success');
                nativeAlert(`✅ 已导出 ${res.count} 个预设。\n保存到: ${res.outDir}`, 'info');
            } else if (res && res.error !== '用户取消操作') {
                nativeAlert(`导出失败: ${res.error}`, 'error');
            }
        } catch (err) {
            nativeAlert(`导出失败: ${err.message}`, 'error');
        }
    };

    // =========================================================
    // 快照管理
    // =========================================================

    const listPresetSnapshots = (filePath) => window.electronAPI.listPresetSnapshots(filePath);
    const restorePresetSnapshot = (payload) => window.electronAPI.restorePresetSnapshot(payload);
    const deletePresetSnapshot = (snapshotPath) => window.electronAPI.deletePresetSnapshot(snapshotPath);

    return {
        // 状态
        presetSearchQuery,
        isImportingPreset,
        importPresetUrl,
        // 扫描
        loadPresets,
        scanPresetDir,
        // 筛选
        filteredPresets,
        // 保存
        saveActivePreset,
        // 重命名
        renamePreset,
        // 删除
        deletePreset,
        // 复制
        duplicatePreset,
        // 右键菜单
        openPresetContextMenu,
        openPresetInFolder,
        // 网址导入
        importPresetFromUrl,
        // 批量导出
        exportPresetsBatch,
        // 快照
        listPresetSnapshots,
        restorePresetSnapshot,
        deletePresetSnapshot
    };
}
