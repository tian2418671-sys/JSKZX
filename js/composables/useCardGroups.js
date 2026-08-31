/**
 * 角色卡分组/分类功能组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：分组的新建/删除/重命名、当前卡分类映射、物理移动、右键快速移动、批量移动、空分组清理。
 * 分组「状态」仍在 App.vue（被多处引用），此处通过依赖注入传入，仅承载「操作」逻辑，保持原有行为不变。
 */
import { computed } from 'vue';

export function useCardGroups({
    // 共享状态
    library, cardData, currentFolderPath, appConfig, selectedIds,
    customCategories, defaultCategories, removedDefaultKeys, currentCategoryKey, allCategories, isCategoryKnown,
    // 工具方法
    nativeAlert, confirmDialog, appPrompt, appSelect, getCategoryDisplayName, addLog,
    persistCardCategory, refreshLibrary, clearSelection, syncConfigToDisk
}) {
    // 新增自定义分组（用自建弹窗替代 Electron 不支持的 prompt；Electron 环境创建物理子文件夹）
    const addNewCategory = async () => {
        const newName = await appPrompt('请输入新分组的名称：');
        if (!newName || newName.trim() === '') return;
        const cleanName = newName.trim();
        if (isCategoryKnown(cleanName)) {
            nativeAlert('该分组已存在！', 'warning');
            return;
        }

        // 📁 物理分组：在库目录下创建子文件夹（浏览器/旧版回退纯内存分组）
        if (window.electronAPI && typeof window.electronAPI.createGroupFolder === 'function') {
            if (!currentFolderPath.value) {
                return nativeAlert('尚未打开角色库目录，请先点击「📂 打开本地库」。', 'warning');
            }
            const res = await window.electronAPI.createGroupFolder({
                libraryPath: currentFolderPath.value,
                groupName: cleanName
            });
            if (!res || !res.success) {
                return nativeAlert(`创建分组文件夹失败: ${(res && res.error) || '未知错误'}`, 'error');
            }
            if (!customCategories.value.includes(res.folderName)) {
                customCategories.value.push(res.folderName);
            }
            currentCategoryKey.value = res.folderName;
            nativeAlert(`已创建物理分组文件夹：${res.folderName}`, 'info');
        } else {
            customCategories.value.push(cleanName);
            currentCategoryKey.value = cleanName; // 自动切换过去
        }
    };

    // 【修复】当前分组是否可删除（自定义分组 或 非系统必需的预设分组均可删）
    const currentCategoryDeletable = computed(() => {
        const key = currentCategoryKey.value;
        if (key === 'all' || key === 'has_lorebook' || key === 'has_regex') return false; // 视图/过滤模式
        if (key === 'uncategorized') return false; // 系统兜底分组不可删
        if (customCategories.value.includes(key)) return true;
        if (defaultCategories.value.some(c => c.key === key)) return true;
        return false;
    });
    // 【修复】当前分组是否可重命名（预设/自定义均可；全部/未分类/过滤视图不可）
    const currentCategoryRenamable = computed(() => {
        const key = currentCategoryKey.value;
        if (key === 'all' || key === 'has_lorebook' || key === 'has_regex' || key === 'uncategorized') return false;
        if (customCategories.value.includes(key)) return true;
        if (defaultCategories.value.some(c => c.key === key)) return true;
        return false;
    });

    // 删除分组（自定义 或 预设分组均可；【修复】预设删除持久化，重启不再重新生成；卡片自动归入未分类）
    const deleteCustomCategory = async (categoryName) => {
        const preset = defaultCategories.value.find(c => c.key === categoryName || c.cn === categoryName || c.en === categoryName);
        const isCustom = customCategories.value.includes(categoryName);
        if (!preset && !isCustom) {
            return nativeAlert('该分组不存在或不可删除！', 'warning');
        }
        if (preset && (preset.key === 'all' || preset.key === 'uncategorized')) {
            return nativeAlert('「全部」与「未分类」为系统必需视图，不可删除！', 'warning');
        }
        const ok = await confirmDialog(`确定要删除分组【${categoryName}】吗？\n（不会删除卡片，卡片将归入未分类）`);
        if (!ok) return;
        if (preset) {
            // 预设分组：记录已删除 + 从当前预设移除（持久化，重启不再恢复）
            if (!removedDefaultKeys.value.includes(preset.key)) removedDefaultKeys.value.push(preset.key);
            defaultCategories.value = defaultCategories.value.filter(c => c.key !== preset.key);
            // 卡片匹配中/英/key 三种存储形态归入未分类，并同步持久化
            library.value.forEach(card => {
                if (card.category === preset.cn || card.category === preset.en || card.category === preset.key) {
                    card.category = '未分类';
                    persistCardCategory(card);
                }
            });
        } else {
            customCategories.value = customCategories.value.filter(c => c !== categoryName);
            // 原属于该分组的卡片重置为未分类，并同步持久化
            library.value.forEach(card => { if (card.category === categoryName) { card.category = '未分类'; persistCardCategory(card); } });
        }
        const removedKey = preset ? preset.key : categoryName;
        if (currentCategoryKey.value === removedKey) currentCategoryKey.value = 'all';
        addLog(`🗑️ 已删除分组: ${categoryName}`, 'warning');
        nativeAlert(`已删除分组「${categoryName}」。`, 'info');
    };

    // 重命名当前选中的分组（预设与自定义均可，预设重命名后转为自定义分组；「全部」为视图模式不可改）
    const renameCurrentCategory = async () => {
        const currentKey = currentCategoryKey.value;
        
        // 特殊视图/过滤模式（非真实分组），不允许重命名
        if (currentKey === 'all' || currentKey === 'has_lorebook' || currentKey === 'has_regex' || currentKey === 'uncategorized') {
            nativeAlert('该选项为视图/过滤模式或系统兜底分组，无需重命名！', 'warning');
            return;
        }
        
        const oldPreset = defaultCategories.value.find(c => c.key === currentKey);
        const oldName = oldPreset ? oldPreset.cn : currentKey;
        
        const newName = await appPrompt(`请输入「${oldName}」的新分组名称：`, oldName);
        if (!newName || newName.trim() === '' || newName.trim() === oldName) return;
        const cleanNewName = newName.trim();
        
        // 检查新名字是否冲突
        if (isCategoryKnown(cleanNewName)) {
            nativeAlert('该分组名称已存在！', 'warning');
            return;
        }

        // 📁 物理重命名文件夹（仅当存在对应物理文件夹时；纯内存分组自动跳过）
        let physicalRenamed = false;
        if (window.electronAPI && typeof window.electronAPI.renameGroupFolder === 'function' && currentFolderPath.value) {
            const res = await window.electronAPI.renameGroupFolder({
                libraryPath: currentFolderPath.value,
                oldName: oldName,
                newName: cleanNewName
            });
            if (res && res.success) {
                physicalRenamed = true;
            } else if (res && res.error && !String(res.error).includes('不存在')) {
                // 其他错误（权限/越界等）中止重命名，避免内存与磁盘不一致
                return nativeAlert(`重命名分组文件夹失败: ${res.error}`, 'error');
            }
            // "原文件夹不存在" = 纯内存分组，静默继续内存重命名
        }
        
        // 1. 移除旧分组定义（预设重命名后转为自定义分组）
        if (oldPreset) {
            defaultCategories.value = defaultCategories.value.filter(c => c.key !== currentKey);
            // 【修复】记录旧预设 key 已移除，重启后不再重新生成原预设
            if (!removedDefaultKeys.value.includes(currentKey)) removedDefaultKeys.value.push(currentKey);
        } else {
            const idx = customCategories.value.indexOf(currentKey);
            if (idx !== -1) customCategories.value.splice(idx, 1);
        }
        
        // 2. 将新名称加入自定义分组列表
        customCategories.value.push(cleanNewName);
        
        // 3. 批量同步更新库中所有属于该旧分组的卡片归属（预设需匹配中/英/key 三种存储形态），并同步持久化分类
        library.value.forEach(item => {
            if (oldPreset) {
                if (item.category === oldPreset.cn || item.category === oldPreset.en || item.category === oldPreset.key) {
                    item.category = cleanNewName;
                    persistCardCategory(item);
                }
            } else if (item.category === currentKey) {
                item.category = cleanNewName;
                persistCardCategory(item);
            }
        });
        
        // 4. 自动将当前选中的分组切换为新名字
        currentCategoryKey.value = cleanNewName;

        // 📁 物理重命名成功：刷新整个库，让所有卡片的物理路径/子文件夹自动同步（文件位置是事实依据）
        if (physicalRenamed) {
            await refreshLibrary();
        } else {
            nativeAlert(`分组已成功重命名为：「${cleanNewName}」`, 'info');
        }
    };

    // 当前编辑卡片的分类（映射到库项目 libItem.category，避免污染卡片原始文件数据）
    const currentCardCategory = computed({
        get() {
            const libItem = library.value.find(item => item.data === cardData.value);
            if (!libItem) return '';
            const cat = libItem.category || '';
            // 尝试匹配预设分组（中/英/key 均可），自定义分组直接返回字符串
            const preset = defaultCategories.value.find(c => c.cn === cat || c.en === cat || c.key === cat);
            return preset ? preset.key : cat;
        },
        set(val) {
            const libItem = library.value.find(item => item.data === cardData.value);
            if (!libItem) return;
            const preset = defaultCategories.value.find(c => c.key === val);
            libItem.category = preset ? preset.cn : val;
            persistCardCategory(libItem); // 【修复】单卡改分类持久化
        }
    });

    // 当在右侧面板更改卡片分组时触发（同步左侧列表里的卡片归属 + 物理移动文件）
    const handleCardCategoryChange = async () => {
        if (!cardData.value) return;
        const libItem = library.value.find(item => item.data === cardData.value);
        if (!libItem) return;
        const targetKey = currentCardCategory.value;
        const preset = defaultCategories.value.find(c => c.key === targetKey);
        const targetName = preset ? preset.cn : targetKey;
        const oldCat = libItem.category;
        libItem.category = targetName; // 先回写内存（保持下拉响应）
        const ok = await moveCardToGroup(libItem, targetName); // 📁 物理移动 + 覆盖层迁移
        if (!ok) {
            libItem.category = oldCat; // 移动失败回滚，保持与文件系统一致
            persistCardCategory(libItem);
        }
    };

    // 📁 覆盖层 key 迁移：物理移动后卡片路径变化，卡片属性覆盖层跟随新路径
    const migrateOverlayKey = (oldPath, newPath) => {
        if (!oldPath || !newPath || oldPath === newPath) return;
        const overlays = appConfig.value.cardOverlays || {};
        if (overlays[oldPath]) {
            overlays[newPath] = overlays[oldPath];
            delete overlays[oldPath];
            syncConfigToDisk();
        }
    };

    // 📁 物理移动卡片到目标分组（移动文件 + 同步内存 path/subFolder/category/avatar + 覆盖层迁移）
    // 返回 true=成功（内存已与文件系统一致）；false=失败（内存状态不变，避免"幽灵归类"）
    const moveCardToGroup = async (item, targetGroup) => {
        if (!item || !targetGroup) return false;
        const cleanTarget = (targetGroup === '全部' || targetGroup === 'all') ? '未分类' : targetGroup;

        // 浏览器/旧版环境：electronAPI 不支持物理移动时回退纯内存分组（不移动文件）
        if (!window.electronAPI || typeof window.electronAPI.moveCardToGroup !== 'function') {
            item.category = cleanTarget;
            persistCardCategory(item);
            return true;
        }
        if (!currentFolderPath.value) {
            nativeAlert('尚未打开角色库目录，无法物理移动卡片。', 'warning');
            return false;
        }
        const res = await window.electronAPI.moveCardToGroup({
            libraryPath: currentFolderPath.value,
            cardPath: item.path,
            targetGroup: cleanTarget
        });
        if (res && res.success) {
            const oldPath = item.path;
            item.path = res.newFilePath;
            item.subFolder = res.newSubFolder || '';
            item.category = cleanTarget;
            const isImage = /\.(png|webp)$/i.test(res.newFilePath);
            item.avatar = isImage ? 'local-file://img/?path=' + encodeURIComponent(res.newFilePath) : null;
            migrateOverlayKey(oldPath, res.newFilePath);
            persistCardCategory(item);
            return true;
        }
        nativeAlert(`物理移动失败: ${(res && res.error) || '未知错误'}`, 'error');
        return false;
    };

    // 📁 组装分组选项列表（供换组/批量移动选择）：预设分组以中文名作为移动目标，自定义分组直接用名称；排除「全部」视图
    const buildGroupOptions = () => {
        return allCategories.value
            .filter(c => c.key !== 'all')
            .map(c => {
                const preset = defaultCategories.value.find(d => d.key === c.key);
                const label = getCategoryDisplayName ? getCategoryDisplayName(c) : (c.cn || c.key);
                const value = preset ? preset.cn : (c.cn || c.key);
                return { label, value };
            });
    };

    // 右键菜单：快速移动单个卡片分组（选项选择弹窗：从已有分组选择，避免手输名称与物理文件夹不一致导致换组失败；底部可新建）
    const quickMoveGroup = async (item) => {
        const chosen = await appSelect(`将卡片 [${item.name}] 移动到分组:`, buildGroupOptions(), { allowCreate: true, defaultValue: item.category || '' });
        if (chosen && chosen.trim() !== '') {
            const cleanCat = chosen.trim();
            // 📁 物理移动（目标分组文件夹不存在时主进程自动创建）
            const ok = await moveCardToGroup(item, cleanCat);
            if (ok) {
                if (!isCategoryKnown(cleanCat)) {
                    customCategories.value.push(cleanCat);
                }
                nativeAlert(`已将卡片移动至 [${cleanCat}]`, 'info');
            }
        }
    };

    // 批量移动分类
    const batchChangeCategory = async () => {
        if (selectedIds.value.length === 0) return;

        const newCat = await appPrompt(`将选中的 ${selectedIds.value.length} 张卡片移动到新分类:\n(输入新分类名称)`, '未分类');

        if (newCat && newCat.trim() !== '') {
            const cleanCat = newCat.trim();

            // 更新数据
            library.value.forEach(item => {
                if (selectedIds.value.includes(item.id)) {
                    item.category = cleanCat;
                    persistCardCategory(item); // 【修复】批量改分类持久化
                }
            });

            // 动态添加新分类
            if (!isCategoryKnown(cleanCat)) {
                customCategories.value.push(cleanCat);
            }

            await nativeAlert(`已成功将 ${selectedIds.value.length} 张卡片移动到 [${cleanCat}] 分类！`, 'info');
            clearSelection();
        }
    };

    // 批量移动到指定分组（选项选择弹窗：从已有分组选择 / 新建，与右键换组交互一致）
    const batchChangeCategoryModal = async () => {
        if (selectedIds.value.length === 0) return;
        const chosen = await appSelect(`将选中的 ${selectedIds.value.length} 张卡片移动到分组:`, buildGroupOptions(), { allowCreate: true });
        
        if (chosen && chosen.trim() !== '') {
            const cleanCat = chosen.trim();
            // 📁 批量物理移动（逐张移动并统计成功数）
            let successCount = 0;
            for (const item of library.value) {
                if (!selectedIds.value.includes(item.id)) continue;
                if (await moveCardToGroup(item, cleanCat)) successCount++;
            }
            if (successCount > 0 && !isCategoryKnown(cleanCat)) {
                customCategories.value.push(cleanCat);
            }
            nativeAlert(`成功将 ${successCount} / ${selectedIds.value.length} 张卡片移动至 [${cleanCat}]`, successCount > 0 ? 'info' : 'error');
            clearSelection();
        }
    };

    // 🧹 删除卡片后自动清理空分组（自定义分组 + 物理文件夹分组；预设/未分类/全部保留）
    const cleanupEmptyCategories = async () => {
        if (customCategories.value.length === 0) return;
        // 1. 统计各分组当前卡片数
        const catCount = {};
        library.value.forEach(item => {
            const cat = item.category || '未分类';
            catCount[cat] = (catCount[cat] || 0) + 1;
        });
        // 2. 找出已无卡片的自定义分组
        const emptyCats = customCategories.value.filter(c => !catCount[c]);
        if (emptyCats.length === 0) return;
        // 3. 从分组列表移除（watch deep 自动持久化）
        customCategories.value = customCategories.value.filter(c => catCount[c]);
        if (emptyCats.includes(currentCategoryKey.value)) currentCategoryKey.value = 'all';
        addLog(`🧹 已自动清理空分组: ${emptyCats.join(', ')}`, 'info');
        // 4. 物理删除空文件夹（仅 Electron + 已设置库目录；非空文件夹自动跳过，绝不误删）
        if (window.electronAPI && typeof window.electronAPI.deleteEmptyGroupFolder === 'function' && currentFolderPath.value) {
            for (const cat of emptyCats) {
                try {
                    await window.electronAPI.deleteEmptyGroupFolder({ libraryPath: currentFolderPath.value, groupName: cat });
                } catch (e) { /* 忽略 */ }
            }
        }
    };

    return {
        addNewCategory, currentCategoryDeletable, currentCategoryRenamable,
        deleteCustomCategory, renameCurrentCategory,
        currentCardCategory, handleCardCategoryChange, migrateOverlayKey, moveCardToGroup,
        quickMoveGroup, batchChangeCategory, batchChangeCategoryModal, cleanupEmptyCategories
    };
}