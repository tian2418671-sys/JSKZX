/**
 * 世界书库 + 世界书分组功能组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：世界书的加载/扫描/网址导入/重命名/文件夹导入/删除/克隆/右键菜单，以及世界书分组。
 * 世界书「状态」（worldbooks/activeWorldbook/wbCategoryMap 等）被配置持久化、保存、词条编辑等多处共享，保留在 App.vue 并注入。
 */
import { ref, computed, triggerRef } from 'vue';

export function useWorldbooks({
    // 共享状态
    worldbooks, activeWorldbook, lastWorldbookDirPath,
    wbSearchQuery, wbFilterType, currentWbCategory, wbCategoryMap,
    // 工具方法
    saveWbCategoriesMap, syncWorldbooksToDisk, appMode,
    appPrompt, nativeAlert, confirmDialog, addLog,
    contextMenu, closeContextMenu
}) {
    // =========================================================
    // 🌍 世界书扩展功能：网址导入与重命名
    // =========================================================
    const importUrl = ref('');          // 网址导入输入框绑定
    const isImportingWb = ref(false);   // 导入中 loading 状态

    // 扫描世界书文件夹（弹目录选择；复用 selectGenericFolder 返回纯路径字符串，selectFolder 返回扫描结果对象不适用）
    const loadWorldbooks = async () => {
        const dirPath = await window.electronAPI.selectGenericFolder();
        if (!dirPath) return;
        await scanWorldbookDir(dirPath);
        // 【修复】打开世界书目录后自动切换到世界书模式，界面立即显示世界书列表
        // （此前 appMode 不切换，用户打开世界书目录后界面仍停留在角色卡，误以为"没分开"）
        appMode.value = 'worldbooks';
    };

    // 扫描指定世界书目录（供手动选择与启动自动恢复共用；自动持久化记忆路径）
    const scanWorldbookDir = async (dirPath) => {
        if (!dirPath) return;
        lastWorldbookDirPath.value = dirPath;
        try { localStorage.setItem('jsTavern_lastWbDir', dirPath); } catch (e) { /* 忽略 */ }

        addLog(`开始扫描世界书目录: ${dirPath}`);
        const res = await window.electronAPI.scanWorldbooks(dirPath);
        if (res.success) {
            // 统一清洗：确保每本世界书的 entries 均为纯数组（兼容旧版/第三方工具的对象字典格式）
            res.data.forEach(wb => {
                if (wb.data && wb.data.entries && typeof wb.data.entries === 'object' && !Array.isArray(wb.data.entries)) {
                    wb.data.entries = Object.values(wb.data.entries);
                }
            });
            worldbooks.value = res.data;
            // 【修复】重扫后按路径重绑当前编辑对象，找不到则清空，避免编辑已失效的旧对象
            if (activeWorldbook.value) {
                const prevPath = activeWorldbook.value.path;
                activeWorldbook.value = res.data.find(w => w.path === prevPath) || null;
            }
            addLog(`扫描完成，共加载 ${res.data.length} 本世界书`, 'success');
        } else {
            addLog(`扫描失败: ${res.error}`, 'error');
            nativeAlert(`世界书扫描失败: ${res.error}`, 'error');
        }
    };

    // 拉取远程 JSON 文本：优先渲染层 fetch（Discord/GitHub 等允许 CORS 的直链），
    // 失败时回退主进程 net.fetch 转发（彻底绕开渲染层跨域限制）
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

    // 1. 网址导入世界书（Discord / GitHub 等 .json 直链）
    const importWorldbookFromUrl = async () => {
        const url = importUrl.value.trim();
        if (!url) {
            nativeAlert('请先输入世界书的 JSON 直链网址！', 'warning');
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            nativeAlert('网址格式不正确，请粘贴以 http:// 或 https:// 开头的 .json 直链。', 'warning');
            return;
        }

        isImportingWb.value = true;
        try {
            addLog(`开始从网址导入世界书: ${url}`);
            const text = await fetchRemoteText(url);
            const wbData = JSON.parse(text);

            // 【加固】拒绝角色卡 JSON（与文件夹导入同一套校验口径）
            const isRoleCard = wbData && typeof wbData === 'object' &&
                (wbData.spec || wbData.char_name || (wbData.data && (wbData.data.description || wbData.data.first_mes)));
            if (isRoleCard) {
                throw new Error('检测到这是角色卡 JSON（含 char_name/spec 字段），并非世界书，已拒绝导入。');
            }

            // 归一化词条：兼容酒馆 V1/V2 数组与第三方对象字典格式
            let entries = Array.isArray(wbData) ? wbData : (wbData.entries || []);
            if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
                entries = Object.values(entries);
            }
            if (!Array.isArray(entries)) entries = [];

            // 组装世界书（复用本应用 worldbooks 列表的 { path, name, data } 结构）
            const bookName = (wbData.name || `网络导入世界书_${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '-')}`).trim();
            const plainData = {
                ...wbData,
                name: bookName,
                description: wbData.description || '通过网址 URL 导入的世界书',
                entries
            };
            const safeFileName = `${bookName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
            const newWb = {
                path: '',
                name: safeFileName,
                data: plainData,
                imported: true // 标记为网络导入（尚未落盘时路径为空）
            };

            // 落盘保存：优先存到上次世界书目录，否则询问用户选择目录
            let saveDir = lastWorldbookDirPath.value;
            if (!saveDir) {
                addLog('未检测到上次世界书目录，请选择保存位置...', 'warning');
                saveDir = await window.electronAPI.selectGenericFolder();
            }
            if (saveDir) {
                const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
                const saveRes = await window.electronAPI.createWorldbook({ filePath, data: plainData });
                if (saveRes && saveRes.success) {
                    newWb.path = filePath;
                    addLog(`💾 已保存到: ${filePath}`, 'success');
                } else {
                    addLog(`⚠️ 落盘失败: ${(saveRes && saveRes.error) || '未知错误'}，已保留在内存`, 'warning');
                }
            } else {
                addLog('用户取消选择目录，导入的世界书仅保留在当前会话。', 'warning');
            }

            // 加入世界书库并设为当前编辑对象
            worldbooks.value.push(newWb);
            triggerRef(worldbooks); // shallowRef：手动触发响应式
            activeWorldbook.value = newWb;
            importUrl.value = '';
            addLog(`🎉 成功导入世界书: ${bookName}（共 ${entries.length} 个词条）`, 'success');
            nativeAlert(`🎉 成功导入世界书: ${bookName}\n共包含 ${entries.length} 个词条。`, 'info');
        } catch (error) {
            console.error('世界书导入失败:', error);
            addLog(`❌ 世界书导入失败: ${error.message}`, 'error');
            nativeAlert(`❌ 导入失败！请确保网址是直接指向 JSON 文件的有效直链，并且没有被跨域拦截。\n错误详情: ${error.message}`, 'error');
        } finally {
            isImportingWb.value = false;
        }
    };

    // 2. 世界书重命名（更新内部名称 + 物理文件同步改名）
    const renameWorldbook = async (wb) => {
        if (!wb) return;
        const oldName = ((wb.data && wb.data.name) || wb.name || '未命名世界书').replace(/\.json$/i, '');
        const newName = await appPrompt('✏️ 请输入新的世界书名称：', oldName);
        if (newName === null || newName.trim() === '' || newName.trim() === oldName) return;
        const finalName = newName.trim();

        // 更新世界书内部名称（列表与 IDE 标题即时生效）
        if (wb.data) wb.data.name = finalName;

        const safeFileName = `${finalName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
        const prevKey = wb.path || wb.name || ''; // 记录旧持久化键（改名后迁移分组）

        // 本地文件：同步重命名物理文件，保持磁盘与内存一致
        if (wb.path) {
            const oldPath = wb.path;
            const dir = oldPath.replace(/[\\/][^\\/]*$/, '');
            const newPath = `${dir}\\${safeFileName}`;
            if (oldPath !== newPath) {
                const res = await window.electronAPI.renameWorldbookFile({ oldPath, newPath });
                if (res && res.success) {
                    wb.path = newPath;
                    wb.name = safeFileName;
                    migrateWbCategoryKey(prevKey, wb.path); // 分组键随文件路径迁移
                    addLog(`📝 已重命名世界书: ${oldName} → ${finalName}`, 'success');
                    nativeAlert(`✏️ 重命名成功！\n新名称: ${finalName}\n文件已同步改名为: ${safeFileName}`, 'info');
                } else {
                    addLog(`⚠️ 物理文件改名失败: ${(res && res.error) || '未知错误'}（内部名称已更新）`, 'warning');
                    nativeAlert(`内部名称已更新，但物理文件改名失败: ${(res && res.error) || '未知错误'}`, 'warning');
                }
            }
        } else {
            // 内存书（本次会话导入但未落盘）：仅同步显示文件名
            wb.name = safeFileName;
            migrateWbCategoryKey(prevKey, wb.name); // 分组键随文件名迁移
            addLog(`📝 已重命名世界书: ${oldName} → ${finalName}`, 'success');
        }
    };

    // 1. 世界书专用文件夹导入（独立 input 与处理函数，绝不与角色卡导入混用）
    //    - 深度穿透所有层级子文件夹读取 .json (Bug 3)
    //    - 严格世界书格式校验，杜绝误导入角色卡 JSON (Bug 1)
    //    - 读取后清空 input 缓存，保证下次可随意更换目录 (Bug 2)
    const handleWorldbookFolderSelect = async (event) => {
        const files = Array.from(event.target.files || []);
        if (files.length === 0) return;

        let loadedCount = 0;
        const addedNames = [];
        for (const file of files) {
            // 只处理 .json（webkitdirectory 已含所有层级的文件）
            if (!file.name.toLowerCase().endsWith('.json')) continue;
            try {
                const text = await file.text();
                const json = JSON.parse(text);

                // 严格校验：必须有世界书特征（entries / 纯数组），且不是角色卡 JSON
                const isRoleCard = json && typeof json === 'object' &&
                    (json.spec || json.char_name || (json.data && (json.data.description || json.data.first_mes)));
                const hasEntries = json && typeof json === 'object' &&
                    (Array.isArray(json.entries) || (json.entries && typeof json.entries === 'object'));
                if (isRoleCard || (!hasEntries && !Array.isArray(json))) {
                    console.warn(`跳过非世界书文件: ${file.name}`);
                    continue;
                }

                // 归一化词条：兼容 V1/V2 数组与对象字典格式
                let entries = Array.isArray(json) ? json : json.entries;
                if (entries && typeof entries === 'object' && !Array.isArray(entries)) entries = Object.values(entries);
                if (!Array.isArray(entries)) entries = [];

                const bookName = (json.name || file.name.replace(/\.json$/i, '')).trim();
                const plainData = {
                    ...json,
                    name: bookName,
                    description: json.description || '从本地文件夹导入的世界书',
                    entries
                };

                // 取文件绝对路径（Electron webUtils 支持 webkitdirectory 文件），保证可继续编辑保存
                let realPath = '';
                try {
                    if (window.electronAPI && typeof window.electronAPI.getPathForFile === 'function') {
                        realPath = window.electronAPI.getPathForFile(file) || '';
                    }
                } catch (e) { /* 忽略 */ }

                // 同路径已存在则跳过
                if (realPath && worldbooks.value.some(w => w.path === realPath)) {
                    console.warn(`已存在，跳过: ${realPath}`);
                    continue;
                }

                worldbooks.value.push({ path: realPath, name: file.name, data: plainData });
                triggerRef(worldbooks); // shallowRef：手动触发响应式
                loadedCount++;
                addedNames.push(bookName);
                addLog(`📂 导入世界书: ${bookName}`, 'success');
            } catch (e) {
                console.warn(`跳过无效文件 ${file.name}:`, e);
            }
        }

        // ⚠️ 关键修复：清空 input 缓存，确保下次打开其他目录能正常触发 @change (Bug 2)
        event.target.value = '';

        // 统一 IPC 落盘：把路径获取失败（仍在内存）的世界书补齐保存到世界书目录
        await syncWorldbooksToDisk();

        if (loadedCount > 0) {
            if (!activeWorldbook.value) activeWorldbook.value = worldbooks.value[worldbooks.value.length - 1];
            nativeAlert(`🎉 成功扫描并导入 ${loadedCount} 本世界书！\n${addedNames.join('、')}`, 'info');
        } else {
            nativeAlert('⚠️ 未在该文件夹及子文件夹中找到有效的世界书 JSON 文件！', 'warning');
        }
    };

    // 2. 删除世界书（列表移除 + 物理文件移入全局回收站，绝不物理删除）
    const deleteWorldbook = async (wb) => {
        if (!wb) return;
        const displayName = (wb.data && wb.data.name) || wb.name || '未命名世界书';
        const ok = await confirmDialog(`⚠️ 确定要删除世界书《${displayName}》吗？\n物理文件将移入全局回收站（可在 文件菜单>打开全局回收站 找回）。`);
        if (!ok) return;

        const index = worldbooks.value.findIndex(item => item === wb);
        if (index === -1) return;
        worldbooks.value.splice(index, 1);
        triggerRef(worldbooks); // shallowRef：手动触发响应式

        // 清理持久化分组记录（删除后不留孤儿键）
        const delKey = wb.path || wb.name || '';
        if (delKey && wbCategoryMap.value[delKey] !== undefined) {
            delete wbCategoryMap.value[delKey];
            saveWbCategoriesMap();
        }

        // 若删除的是当前编辑对象，自动切换到下一本
        if (activeWorldbook.value === wb) {
            activeWorldbook.value = worldbooks.value[Math.min(index, worldbooks.value.length - 1)] || null;
        }

        // 物理文件移入全局回收站（存在本地文件时）
        if (wb.path) {
            try {
                const res = await window.electronAPI.trashFiles([wb.path]);
                if (res && res.success) addLog(`🗑️ 已将 ${res.count} 个世界书文件移入全局回收站`, 'warning');
                else addLog(`⚠️ 回收站移动失败: ${(res && res.error) || '未知错误'}`, 'warning');
            } catch (e) {
                addLog(`⚠️ 回收站移动异常: ${e.message}`, 'warning');
            }
        }

        addLog(`🗑️ 已删除世界书: ${displayName}`, 'warning');
        nativeAlert(`已删除世界书《${displayName}》。\n物理文件已移入全局回收站（文件菜单>打开全局回收站 可找回）。`, 'info');
    };

    // 3. 复制/克隆世界书（深拷贝 + 副本文件落盘）
    const duplicateWorldbook = async (wb) => {
        if (!wb) return;
        const sourceName = (wb.data && wb.data.name) || wb.name || '未命名世界书';
        const cloneName = `${sourceName} - 副本`;
        const cloneData = JSON.parse(JSON.stringify(wb.data || {}));
        cloneData.name = cloneName;

        // ✅ [补丁] 深度遍历清洗：重新生成所有词条的唯一 UID，防止与母本冲突
        if (cloneData && Array.isArray(cloneData.entries)) {
            cloneData.entries.forEach(entry => {
                entry.uid = Date.now() + Math.random().toString(36).substring(2, 9);
                delete entry._collapsed;
            });
        }

        const safeFileName = `${cloneName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
        const newWb = { path: '', name: safeFileName, data: cloneData };

        // 落盘位置：源文件同目录 → 上次世界书目录 → 询问用户
        let saveDir = wb.path ? wb.path.replace(/[\\/][^\\/]*$/, '') : '';
        if (!saveDir) saveDir = lastWorldbookDirPath.value;
        if (!saveDir) {
            addLog('请选择副本的保存位置...', 'warning');
            saveDir = await window.electronAPI.selectGenericFolder();
        }
        if (saveDir) {
            const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
            const saveRes = await window.electronAPI.createWorldbook({ filePath, data: cloneData });
            if (saveRes && saveRes.success) {
                newWb.path = filePath;
                addLog(`💾 副本已保存到: ${filePath}`, 'success');
            } else {
                addLog(`⚠️ 副本落盘失败: ${(saveRes && saveRes.error) || '未知错误'}，仅保留在内存`, 'warning');
            }
        } else {
            addLog('用户取消选择目录，副本仅保留在当前会话。', 'warning');
        }

        worldbooks.value.push(newWb);
        triggerRef(worldbooks); // shallowRef：手动触发响应式
        // 继承源书分组并持久化（副本默认归入源书所在分组）
        const srcCat = getWbCategory(wb);
        if (srcCat && srcCat.trim() !== '') {
            newWb.category = srcCat;
            const key = newWb.path || newWb.name || '';
            if (key) {
                wbCategoryMap.value[key] = srcCat;
                saveWbCategoriesMap();
            }
        }
        addLog(`📋 已创建世界书副本: ${cloneName}`, 'success');
        nativeAlert(`📋 已复制世界书为: ${cloneName}\n共 ${Array.isArray(cloneData.entries) ? cloneData.entries.length : 0} 个词条。`, 'info');
    };

    // 4. 世界书专属右键快捷菜单
    const wbContextMenu = ref({ show: false, x: 0, y: 0, wb: null });

    const openWbContextMenu = (event, wb) => {
        event.preventDefault(); // 阻止浏览器默认右键菜单
        if (contextMenu.value.visible) closeContextMenu(); // 先收起角色卡菜单
        // 边缘碰撞检测（菜单约 180x260，防越界）
        const menuW = 180, menuH = 260;
        let x = event.clientX, y = event.clientY;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH;
        wbContextMenu.value = { show: true, x: Math.max(4, x), y: Math.max(4, y), wb };
    };

    const closeWbContextMenu = () => {
        wbContextMenu.value.show = false;
    };

    // 打开世界书所在文件夹（定位并选中实际文件，绝不使用全局根目录）
    const openWbInFolder = async (wb) => {
        if (!wb) return;
        if (!wb.path) {
            nativeAlert('该世界书尚无本地文件（内存导入），无法定位文件夹。', 'warning');
            return;
        }
        if (!window.electronAPI || typeof window.electronAPI.showItemInFolder !== 'function') {
            nativeAlert('当前环境不支持打开文件夹。', 'warning');
            return;
        }
        try {
            await window.electronAPI.showItemInFolder(wb.path);
            addLog(`📁 已在资源管理器中定位: ${(wb.data && wb.data.name) || wb.name}`, 'info');
        } catch (e) {
            addLog(`📁 定位失败: ${e.message}`, 'error');
            nativeAlert(`打开文件夹失败: ${e.message}`, 'error');
        }
    };

    // =========================================================
    // 📁 世界书库：分组功能
    // =========================================================
    // 重命名后迁移持久化分组键（旧 path/name -> 新 path/name），避免分类在重扫后丢失
    const migrateWbCategoryKey = (oldKey, newKey) => {
        if (!oldKey || !newKey || oldKey === newKey) return;
        if (wbCategoryMap.value[oldKey] !== undefined) {
            wbCategoryMap.value[newKey] = wbCategoryMap.value[oldKey];
            delete wbCategoryMap.value[oldKey];
            saveWbCategoriesMap();
        }
    };

    // 获取世界书分组：wb.category → 持久化映射 → '默认'
    const getWbCategory = (wb) => {
        if (!wb) return '默认';
        if (wb.category && wb.category.trim() !== '') return wb.category.trim();
        const key = wb.path || wb.name || '';
        if (key && wbCategoryMap.value[key] && wbCategoryMap.value[key].trim() !== '') {
            return wbCategoryMap.value[key].trim();
        }
        return '默认';
    };

    // 1. 自动提取所有分组（Set 去重；'默认' 始终保留；无书的分类自动消失）
    const wbCategories = computed(() => {
        const categories = new Set(['默认']);
        worldbooks.value.forEach(wb => {
            const cat = getWbCategory(wb);
            if (cat && cat.trim() !== '') categories.add(cat.trim());
        });
        return Array.from(categories);
    });

    // 3. 修改世界书分组（自建弹窗替代 Electron 不支持的 prompt）
    const changeWbCategory = async (wb) => {
        if (!wb) return;
        const displayName = (wb.data && wb.data.name) || wb.name || '未命名世界书';
        const currentCat = getWbCategory(wb);
        const newCat = await appPrompt(
            `📁 将《${displayName}》移动到新分组\n\n请输入目标分组名称（当前：${currentCat}）：\n提示：输入全新的名字将自动创建新分组。`,
            currentCat
        );
        if (newCat !== null && newCat.trim() !== '') {
            const finalCat = newCat.trim();
            wb.category = finalCat;
            const key = wb.path || wb.name || '';
            if (key) {
                wbCategoryMap.value[key] = finalCat;
                saveWbCategoriesMap();
            }
            addLog(`📁 已将《${displayName}》移动到分组: ${finalCat}`, 'info');
            // 若当前筛选的分组已被移空，自动回落"全部"避免空列表困惑
            if (currentWbCategory.value !== '全部' && currentWbCategory.value !== finalCat) {
                const stillHas = worldbooks.value.some(w => getWbCategory(w) === currentWbCategory.value);
                if (!stillHas) currentWbCategory.value = '全部';
            }
        }
    };

    // 计算属性：世界书列表筛选（搜索 + 词条数过滤 + 📁 分组过滤）
    const filteredWorldbooks = computed(() => {
        return worldbooks.value.filter(wb => {
            const name = ((wb.data && wb.data.name) || wb.name || '').toLowerCase();
            const matchesSearch = !wbSearchQuery.value || name.includes(wbSearchQuery.value.toLowerCase());

            const entryCount = (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries.length : 0;
            let matchesFilter = true;
            if (wbFilterType.value === 'empty') matchesFilter = entryCount === 0;
            else if (wbFilterType.value === 'small') matchesFilter = entryCount > 0 && entryCount <= 15;
            else if (wbFilterType.value === 'large') matchesFilter = entryCount > 15;

            // 📁 分组过滤（'全部' 不过滤）
            let matchesCategory = true;
            if (currentWbCategory.value !== '全部') {
                matchesCategory = getWbCategory(wb) === currentWbCategory.value;
            }

            return matchesSearch && matchesFilter && matchesCategory;
        });
    });

    return {
        importUrl, isImportingWb, wbContextMenu,
        loadWorldbooks, scanWorldbookDir, importWorldbookFromUrl, renameWorldbook,
        handleWorldbookFolderSelect, deleteWorldbook, duplicateWorldbook,
        openWbContextMenu, closeWbContextMenu, openWbInFolder,
        wbCategories, changeWbCategory, filteredWorldbooks
    };
}