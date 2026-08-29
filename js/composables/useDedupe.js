/**
 * 查重与差异比对功能组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：角色卡查重、世界书查重、以及双屏差异比对器（Diff Inspector）。
 * 依赖通过参数注入；estimateCardTokens 为共享工具保留在 App.vue，此处作为依赖传入。行为保持不变。
 */
import { ref } from 'vue';

export function useDedupe({
    library, worldbooks, activeWorldbook, cardData,
    presets, activePreset, appMode,
    estimateCardTokens,
    nativeAlert, confirmDialog, addLog, reset, cleanupEmptyCategories, deleteCardOverlays
}) {
    // =========================================================
    // 🔍 智能查重与版本清洗系统
    // =========================================================
    const showDedupeModal = ref(false);
    const duplicateGroups = ref([]);

    // 提取核心描述以便于对比差异
    const getCoreDescription = (card) => {
        const d = card.data?.data || card.data || {};
        return d.description || '';
    };

    // 启动全库查重扫描（升级版：综合 Token 丰度 + 物理文件修改时间判定；整体 try-catch 防静默崩溃）
    const startDedupeScan = async () => {
        try {
            if (library.value.length === 0) {
                nativeAlert('卡片库为空，无法查重！', 'warning');
                return;
            }

            // 【防崩溃检查】底层 API 是否真的连接上了
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                nativeAlert('❌ 查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            const groups = {};
            // 1. 聚类：按角色名称分组
            library.value.forEach(card => {
                const name = (card.name || '未命名').trim();
                if (!groups[name]) groups[name] = [];
                groups[name].push(card);
            });

            const potentialGroups = Object.entries(groups).filter(([name, cards]) => cards.length > 1);

            if (potentialGroups.length === 0) {
                nativeAlert('🎉 恭喜！当前库中极为整洁，未发现同名重复的角色卡！', 'info');
                return;
            }

            // 2. 收集所有需要获取 stats 的文件路径
            const pathsToStat = [];
            potentialGroups.forEach(([name, cards]) => cards.forEach(c => pathsToStat.push(c.path)));

            // 3. 批量获取文件物理状态 (修改时间/大小)；失败时降级为仅 Token 判定
            let fileStats = {};
            try {
                const statsRes = await window.electronAPI.getFileStats(pathsToStat);
                if (statsRes && statsRes.success) fileStats = statsRes.data || {};
            } catch (e) {
                console.warn('获取文件信息失败，将仅依据 Token 判定:', e);
            }

            // 4. 组装查重分组并综合排序
            duplicateGroups.value = potentialGroups.map(([name, cards]) => {
                cards.forEach(c => {
                    c._tokens = estimateCardTokens(c);
                    c._desc = getCoreDescription(c);
                    // 优先使用物理文件修改时间（可空链保护），兜底使用内部数据时间
                    const fallback = (c.data && c.data.create_date) ? new Date(c.data.create_date).getTime() : 0;
                    c._mtime = fileStats?.[c.path]?.mtimeMs || fallback || Date.now();
                    c._dateStr = new Date(c._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                });

                // 【综合排序策略】Token 差异 > 5% 视为有实质差异，Token 多者优先；相近则比较物理修改时间，越新越优先
                cards.sort((a, b) => {
                    const tokenDiff = b._tokens - a._tokens;
                    const tokenRatio = Math.abs(tokenDiff) / Math.max(a._tokens, b._tokens, 1);
                    if (tokenRatio > 0.05) {
                        return tokenDiff;
                    } else {
                        return b._mtime - a._mtime;
                    }
                });

                // 【差异计算】将第一张（推荐保留）与其他卡片对比描述长度差异
                cards.forEach((c, idx) => {
                    if (idx === 0) {
                        c._diffType = '推荐版';
                        return;
                    }
                    const diffLen = c._desc.length - cards[0]._desc.length;
                    if (diffLen > 100) c._diffType = '可能包含更多设定';
                    else if (diffLen < -100) c._diffType = '设定可能有缺失';
                    else if (c._desc !== cards[0]._desc) c._diffType = '设定细节不同';
                    else c._diffType = '设定完全一致';
                });

                return { name, cards };
            });

            // 只要逻辑没报错，就一定能打开弹窗！
            showDedupeModal.value = true;
        } catch (err) {
            console.error('查重引擎崩溃:', err);
            nativeAlert(`❌ 查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理：保留指定卡片，其余送入回收站
    const resolveDedupeGroup = async (groupIndex, keepCardPath) => {
        const group = duplicateGroups.value[groupIndex];
        if (!group) return;

        // 选出所有不等于 keepCardPath 的卡片路径（即准备扔掉的冗余版本）
        const pathsToTrash = group.cards
            .filter(c => c.path !== keepCardPath)
            .map(c => c.path);

        if (pathsToTrash.length === 0) return;

        // ⚠️ 必须用 confirmDialog（window.confirm 在 Electron 中静默返回 null）
        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个历史版本/重复卡移入回收站吗？`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            // 🔧 按实际删除成功的路径过滤内存（失败项保留在库中，与磁盘一致，杜绝幽灵卡）
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));

            const currentLibItem = library.value.find(item => item.data === cardData.value);
            const currentTrashed = !!(currentLibItem && trashedPaths.includes(currentLibItem.path));

            library.value = library.value.filter(c => !trashedPaths.includes(c.path));
            // 组内全部删净才移除该组；有残留则只剔除已删项，保持弹窗数据与磁盘一致
            if (failedPaths.size === 0) {
                duplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.cards = group.cards.filter(c => !trashedPaths.includes(c.path));
            }

            if (currentTrashed) reset();

            deleteCardOverlays(trashedPaths); // 🔧 清理覆盖层，防配置膨胀
            await cleanupEmptyCategories(); // 🧹 自动清理空分组

            // 🔧 分项结果提示（渲染进程无 path 模块，用 split 取文件名）
            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                nativeAlert(`已清理 ${res.count} 张；${failedPaths.size} 张失败（可能被其他程序占用）：\n${names}`, 'warning');
            } else {
                nativeAlert(`清理成功！已将 ${res.count} 张冗余卡片移入回收站。`, 'info');
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // 🌍 世界书查重弹窗状态
    const showWbDedupeModal = ref(false);  // 世界书对比查重弹窗开关
    const wbDuplicateGroups = ref([]);     // 世界书查重分组

    // 提取世界书的所有触发词集合（用于计算重合度）
    const getWorldbookKeysSet = (wb) => {
        const keys = new Set();
        const entries = (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries : [];
        entries.forEach(e => {
            if (!e || typeof e !== 'object') return; // 脏数据条目防护
            const kArr = Array.isArray(e.key) ? e.key : (typeof e.key === 'string' ? e.key.split(/[,，]/) : []);
            kArr.forEach(k => {
                const clean = String(k).trim().toLowerCase();
                if (clean) keys.add(clean);
            });
        });
        return keys;
    };

    // 启动世界书智能查重扫描
    const startWorldbookDedupeScan = async () => {
        try {
            if (worldbooks.value.length === 0) {
                nativeAlert('世界书库为空，无法进行查重！', 'warning');
                return;
            }

            // 【防崩溃检查】底层 API 是否真的连接上了
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                nativeAlert('❌ 世界书查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            const groups = {};
            // 1. 按书名或文件名聚类
            worldbooks.value.forEach(wb => {
                const name = ((wb.data && wb.data.name) || (wb.name || '').replace(/\.json$/i, '') || '未命名世界书').trim();
                if (!groups[name]) groups[name] = [];
                groups[name].push(wb);
            });

            const potentialGroups = Object.entries(groups).filter(([_, list]) => list.length > 1);

            if (potentialGroups.length === 0) {
                nativeAlert('🎉 恭喜！当前库中未发现同名的重复世界书！', 'info');
                return;
            }

            // 2. 收集物理文件状态（带空安全保护）
            const pathsToStat = [];
            potentialGroups.forEach(([_, list]) => list.forEach(wb => pathsToStat.push(wb.path)));
            let fileStats = {};
            try {
                const statsRes = await window.electronAPI.getFileStats(pathsToStat);
                if (statsRes && statsRes.success) fileStats = statsRes.data || {};
            } catch (e) {
                console.warn('获取世界书文件信息失败:', e);
            }

            wbDuplicateGroups.value = potentialGroups.map(([name, list]) => {
                list.forEach(wb => {
                    const entries = (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries : [];
                    wb._entryCount = entries.length;
                    wb._keysSet = getWorldbookKeysSet(wb);
                    wb._mtime = fileStats?.[wb.path]?.mtimeMs || Date.now();
                    wb._dateStr = new Date(wb._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                    wb._sizeKb = ((fileStats?.[wb.path]?.size || 0) / 1024).toFixed(1);
                });

                // 排序：词条数多的排前面，词条数相近则新的排前面
                list.sort((a, b) => {
                    if (b._entryCount !== a._entryCount) return b._entryCount - a._entryCount;
                    return b._mtime - a._mtime;
                });

                // 计算相对第一本（推荐版本）的差异与触发词交集
                const masterKeys = list[0]._keysSet;
                list.forEach((wb, idx) => {
                    if (idx === 0) {
                        wb._diffInfo = '👑 建议保留 (词条最全/最新)';
                    } else {
                        let overlapCount = 0;
                        wb._keysSet.forEach(k => { if (masterKeys.has(k)) overlapCount++; });
                        const ratio = wb._keysSet.size > 0 ? Math.round((overlapCount / wb._keysSet.size) * 100) : 0;

                        if (wb._entryCount === list[0]._entryCount && ratio === 100) {
                            wb._diffInfo = '⚠️ 词条内容完全重合 (可安全清理)';
                        } else {
                            wb._diffInfo = `🔍 触发词重合度: ${ratio}% (${wb._entryCount}条)`;
                        }
                    }
                });

                return { name, list };
            });

            // 只要逻辑没报错，就一定能打开弹窗！
            showWbDedupeModal.value = true;
        } catch (err) {
            console.error('世界书查重引擎崩溃:', err);
            nativeAlert(`❌ 世界书查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理重复世界书
    const resolveWbDedupeGroup = async (groupIndex, keepPath) => {
        const group = wbDuplicateGroups.value[groupIndex];
        if (!group) return;
        const pathsToTrash = group.list.filter(wb => wb.path !== keepPath).map(wb => wb.path);
        if (pathsToTrash.length === 0) return;

        // ⚠️ confirm 在 Electron 中静默返回 null，必须用 confirmDialog
        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 本冗余/旧版世界书放入回收站吗？`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            // 🔧 按实际删除成功的路径过滤内存（失败项保留，与磁盘一致）
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));
            if (trashedPaths.length === 0) {
                return nativeAlert('全部世界书移入回收站失败（可能被其他程序占用），未做任何更改。', 'error');
            }

            worldbooks.value = worldbooks.value.filter(wb => !trashedPaths.includes(wb.path));
            // 组内全部删净才移除该组；有残留则只剔除已删项，保持弹窗数据与磁盘一致
            if (failedPaths.size === 0) {
                wbDuplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.list = group.list.filter(wb => !trashedPaths.includes(wb.path));
            }
            if (activeWorldbook.value && trashedPaths.includes(activeWorldbook.value.path)) {
                activeWorldbook.value = worldbooks.value[0] || null;
            }
            addLog(`🗑️ 已清理 ${res.count} 本冗余世界书`, 'warning');

            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                nativeAlert(`已清理 ${res.count} 本；${failedPaths.size} 本失败（可能被占用）：\n${names}`, 'warning');
            } else {
                nativeAlert(`清理完成！已移入回收站 ${res.count} 本世界书。`, 'info');
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // ⚙️ 预设查重弹窗状态
    // =========================================================
    const showPresetDedupeModal = ref(false);  // 预设对比查重弹窗开关
    const presetDuplicateGroups = ref([]);     // 预设查重分组

    // 预设关键采样参数字段（用于「内容指纹」与差异提示）
    const PRESET_KEYS = [
        'temperature', 'max_tokens', 'max_context', 'rep_pen', 'rep_pen_range',
        'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'tfs',
        'epsilon_cutoff', 'eta_cutoff', 'openai_model', 'prompt_order'
    ];

    // 预设关键采样参数摘要（用于卡片展示，人类可读）
    const getPresetSettingsSummary = (p) => {
        const d = p.data || {};
        const map = {
            temperature: 'temp', max_context: 'ctx', max_tokens: 'max',
            rep_pen: 'rep', top_p: 'top_p', top_k: 'top_k', min_p: 'min_p',
            typical_p: 'typical', tfs: 'tfs', openai_model: 'model'
        };
        const parts = [];
        for (const [k, label] of Object.entries(map)) {
            if (d[k] !== undefined && d[k] !== null) {
                // 🔧 对象/数组值序列化，避免摘要出现 [object Object]
                const v = typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k];
                parts.push(`${label}=${v}`);
            }
        }
        return parts.join(' · ') || '（无采样参数）';
    };

    // 预设提示词条数（prompts 对象或数组、prompt_order 数组）
    const getPresetPromptCount = (p) => {
        const d = p.data || {};
        if (Array.isArray(d.prompts) && d.prompts.length) return d.prompts.length;
        // 🔧 SillyTavern 预设的 prompts 通常是对象 {"0":"…","1":"…"}，按键数统计，与指纹逻辑一致
        if (d.prompts && typeof d.prompts === 'object') return Object.keys(d.prompts).length;
        if (Array.isArray(d.prompt_order)) return d.prompt_order.length;
        return 0;
    };

    // 预设「内容指纹」：采样参数 + 归一化提示词正文，用于判定「完全相同」
    const getPresetFingerprint = (p) => {
        const d = p.data || {};
        const subset = {};
        PRESET_KEYS.forEach(k => { if (d[k] !== undefined) subset[k] = d[k]; });
        if (d.prompts && typeof d.prompts === 'object') {
            const prompts = {};
            // 🔧 数字键按数值升序（字典序会把 "10" 排在 "2" 前，导致同内容不同键集合误判）
            Object.keys(d.prompts).map(Number).sort((a, b) => a - b).forEach(k => { prompts[k] = String(d.prompts[k] || '').trim(); });
            subset._prompts = prompts;
        }
        return JSON.stringify(subset);
    };

    // 启动预设智能查重扫描
    const startPresetDedupeScan = async () => {
        try {
            if (presets.value.length === 0) {
                nativeAlert('预设库为空，无法进行查重！', 'warning');
                return;
            }
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                nativeAlert('❌ 预设查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            const groups = {};
            // 1. 按预设名称聚类（data.name 优先，兜底文件名）
            presets.value.forEach(p => {
                const name = ((p.data && p.data.name) || (p.name || '').replace(/\.json$/i, '') || '未命名预设').trim();
                if (!groups[name]) groups[name] = [];
                groups[name].push(p);
            });

            const potentialGroups = Object.entries(groups).filter(([_, list]) => list.length > 1);
            if (potentialGroups.length === 0) {
                nativeAlert('🎉 恭喜！当前库中未发现同名的重复预设！', 'info');
                return;
            }

            // 2. 批量获取物理文件状态（带空安全保护）
            const pathsToStat = [];
            potentialGroups.forEach(([_, list]) => list.forEach(p => pathsToStat.push(p.path)));
            let fileStats = {};
            try {
                const statsRes = await window.electronAPI.getFileStats(pathsToStat);
                if (statsRes && statsRes.success) fileStats = statsRes.data || {};
            } catch (e) {
                console.warn('获取预设文件信息失败:', e);
            }

            presetDuplicateGroups.value = potentialGroups.map(([name, list]) => {
                list.forEach(p => {
                    p._settings = getPresetSettingsSummary(p);
                    p._promptCount = getPresetPromptCount(p);
                    p._fingerprint = getPresetFingerprint(p);
                    p._fingerLen = p._fingerprint.length;
                    p._mtime = fileStats?.[p.path]?.mtimeMs || Date.now();
                    p._dateStr = new Date(p._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                    p._sizeKb = ((fileStats?.[p.path]?.size || 0) / 1024).toFixed(1);
                });

                // 排序：提示词更全的排前面，参数更丰富的其次，再按修改时间新→旧
                list.sort((a, b) => {
                    if (b._promptCount !== a._promptCount) return b._promptCount - a._promptCount;
                    if (b._fingerLen !== a._fingerLen) return b._fingerLen - a._fingerLen;
                    return b._mtime - a._mtime;
                });

                // 计算相对第一份（推荐保留）的差异
                const masterFp = list[0]._fingerprint;
                list.forEach((p, idx) => {
                    if (idx === 0) {
                        p._diffInfo = '👑 建议保留 (参数最全/最新)';
                    } else if (p._fingerprint === masterFp) {
                        p._diffInfo = '⚠️ 参数内容完全一致 (可安全清理)';
                    } else {
                        p._diffInfo = '🔍 参数配置存在差异';
                    }
                });

                return { name, list };
            });

            showPresetDedupeModal.value = true;
        } catch (err) {
            console.error('预设查重引擎崩溃:', err);
            nativeAlert(`❌ 预设查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理重复预设
    const resolvePresetDedupeGroup = async (groupIndex, keepPath) => {
        const group = presetDuplicateGroups.value[groupIndex];
        if (!group) return;
        const pathsToTrash = group.list.filter(p => p.path !== keepPath).map(p => p.path);
        if (pathsToTrash.length === 0) return;

        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个冗余/旧版预设移入回收站吗？`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));
            if (trashedPaths.length === 0) {
                return nativeAlert('全部预设移入回收站失败（可能被其他程序占用），未做任何更改。', 'error');
            }

            presets.value = presets.value.filter(p => !trashedPaths.includes(p.path));
            if (failedPaths.size === 0) {
                presetDuplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.list = group.list.filter(p => !trashedPaths.includes(p.path));
            }
            if (activePreset.value && trashedPaths.includes(activePreset.value.path)) {
                activePreset.value = presets.value[0] || null;
            }
            addLog(`🗑️ 已清理 ${res.count} 个冗余预设`, 'warning');

            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                nativeAlert(`已清理 ${res.count} 个；${failedPaths.size} 个失败（可能被占用）：\n${names}`, 'warning');
            } else {
                nativeAlert(`清理完成！已移入回收站 ${res.count} 个预设。`, 'info');
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 🔍 查重双屏差异比对器 (Diff Inspector) 终极修复版
    // =========================================================
    const showDiffDetailModal = ref(false);
    const diffMasterItem = ref(null);
    const diffCompareItem = ref(null);
    const diffFieldResults = ref([]);

    // 智能句级切块算法 (取代简陋的段落比对，精确到每一个标点符号)
    const chunkTextForDiff = (text) => {
        if (!text) return [];
        try {
            // 按标点或换行进行精细分句，保留标点，极大提升长段落对比体验
            return text.split(/(?<=[。！？.!?\n]+)/).map(s => s.trim()).filter(Boolean);
        } catch (e) {
            // 兜底降级
            return text.split('\n').map(s => s.trim()).filter(Boolean);
        }
    };

    const computeTextDiffLines = (str1 = '', str2 = '') => {
        const chunks1 = chunkTextForDiff(str1);
        const chunks2 = chunkTextForDiff(str2);

        const set1 = new Set(chunks1);
        const set2 = new Set(chunks2);

        const res1 = chunks1.map(chunk => ({
            text: chunk,
            type: set2.has(chunk) ? 'same' : 'removed'
        }));

        const res2 = chunks2.map(chunk => ({
            text: chunk,
            type: set1.has(chunk) ? 'same' : 'added'
        }));

        return { masterLines: res1, compareLines: res2 };
    };

    // 全能通用比对唤起 (自动识别世界书 / 角色卡)
    const openDiffDetailModal = (masterItem, compareItem) => {
        if (!masterItem || !compareItem) return;

        diffMasterItem.value = masterItem;
        diffCompareItem.value = compareItem;
        diffFieldResults.value = [];

        // 智能识别：当前是在查重世界书 / 角色卡 / 预设？
        const isWorldbook = !!(masterItem.data && Array.isArray(masterItem.data.entries));
        const isPreset = !isWorldbook && !!(
            masterItem.data &&
            ('temperature' in masterItem.data || 'prompts' in masterItem.data || 'prompt_order' in masterItem.data)
        );

        const masterData = (masterItem.data && (masterItem.data.data || masterItem.data)) || {};
        const compareData = (compareItem.data && (compareItem.data.data || compareItem.data)) || {};

        if (isWorldbook) {
            // ---------- 🌍 世界书对比逻辑 ----------
            const entries1 = masterItem.data.entries || [];
            const entries2 = compareItem.data.entries || [];

            diffFieldResults.value.push({
                label: '📚 世界书词条总数 (Entries Count)',
                isSame: entries1.length === entries2.length,
                len1: `${entries1.length} 条`,
                len2: `${entries2.length} 条`,
                diffText: null
            });

            // 提取所有触发词 Key
            const getKeys = (entries) => entries.map(e => (Array.isArray(e.key) ? e.key.join(', ') : e.key)).filter(Boolean);
            const keys1 = new Set(getKeys(entries1));
            const keys2 = new Set(getKeys(entries2));

            diffFieldResults.value.push({
                label: '🔑 触发词池覆盖差异 (Trigger Keys)',
                isSame: keys1.size === keys2.size && [...keys1].every(k => keys2.has(k)),
                isTags: true,
                commonTags: [...keys1].filter(k => keys2.has(k)),
                onlyMasterTags: [...keys1].filter(k => !keys2.has(k)),
                onlyCompareTags: [...keys2].filter(k => !keys1.has(k))
            });

            // 将所有词条内容拼接起来进行宏观文本对比（【加固】entry 判空 + String 强转，防脏数据崩溃）
            const text1 = entries1.map(e => (e && typeof e === 'object') ? String(e.content || '') : '').join('\n');
            const text2 = entries2.map(e => (e && typeof e === 'object') ? String(e.content || '') : '').join('\n');
            const isTextSame = text1 === text2;

            diffFieldResults.value.push({
                label: '📝 词条正文总集比对 (All Content Diff)',
                isSame: isTextSame,
                len1: `${text1.length} 字`,
                len2: `${text2.length} 字`,
                diffText: isTextSame ? null : computeTextDiffLines(text1, text2)
            });

        } else if (isPreset) {
            // ---------- ⚙️ 预设对比逻辑 ----------
            const presetFields = [
                { key: 'temperature', label: '🌡️ 温度 (Temperature)' },
                { key: 'max_tokens', label: '📏 最大输出 (Max Tokens)' },
                { key: 'max_context', label: '🧠 上下文 (Context)' },
                { key: 'rep_pen', label: '🚫 重复惩罚 (Rep Pen)' },
                { key: 'top_p', label: '🎯 Top P' },
                { key: 'top_k', label: '🔝 Top K' },
                { key: 'min_p', label: '📉 Min P' },
                { key: 'openai_model', label: '🧩 模型 (Model)' }
            ];
            const presetVal = (d, k) => {
                const v = d[k];
                if (v === undefined || v === null) return '';
                return typeof v === 'object' ? JSON.stringify(v) : String(v);
            };
            presetFields.forEach(f => {
                const v1 = presetVal(masterData, f.key);
                const v2 = presetVal(compareData, f.key);
                diffFieldResults.value.push({
                    label: f.label,
                    isSame: v1 === v2,
                    len1: v1 || '未设置',
                    len2: v2 || '未设置',
                    diffText: (v1 === v2) ? null : computeTextDiffLines(v1, v2)
                });
            });

            // 提示词正文对比
            const formatPrompts = (d) => {
                const prompts = d.prompts;
                if (!prompts) return '';
                if (Array.isArray(prompts)) return prompts.join('\n');
                if (typeof prompts === 'object') {
                    return Object.keys(prompts).map(k => `${k}: ${String(prompts[k] || '')}`).join('\n');
                }
                return String(prompts);
            };
            const promptText1 = formatPrompts(masterData);
            const promptText2 = formatPrompts(compareData);
            const isPromptSame = promptText1 === promptText2;
            diffFieldResults.value.push({
                label: '💬 提示词正文 (Prompts)',
                isSame: isPromptSame,
                len1: `${promptText1.length} 字`,
                len2: `${promptText2.length} 字`,
                diffText: isPromptSame ? null : computeTextDiffLines(promptText1, promptText2)
            });
        } else {
            // ---------- 🎴 角色卡对比逻辑 ----------
            const fieldsToCompare = [
                { key: 'description', label: '📝 角色描述 (Description)' },
                { key: 'personality', label: '🎭 性格设定 (Personality)' },
                { key: 'scenario', label: '🎬 当前场景 (Scenario)' }, // ✅ 补上漏掉的场景字段（此前场景改动在查重面板上不显示，可能误删新版本）
                { key: 'first_mes', label: '💬 开场首句 (First Message)' },
                { key: 'mes_example', label: '🗣️ 示例对话 (Mes Example)' }
            ];

            diffFieldResults.value = fieldsToCompare.map(f => {
                const val1 = String(masterData[f.key] || masterItem[f.key] || '');
                const val2 = String(compareData[f.key] || compareItem[f.key] || '');
                const isSame = val1.trim() === val2.trim();
                return {
                    label: f.label,
                    isSame,
                    len1: `${val1.length} 字`,
                    len2: `${val2.length} 字`,
                    diffText: isSame ? null : computeTextDiffLines(val1, val2)
                };
            });

            // 标签对比
            const tags1 = new Set([...(masterItem.customTags || []), ...((masterData && masterData.tags) || [])]);
            const tags2 = new Set([...(compareItem.customTags || []), ...((compareData && compareData.tags) || [])]);

            diffFieldResults.value.push({
                label: '🏷️ 自定义/系统标签 (Tags)',
                isSame: tags1.size === tags2.size && [...tags1].every(t => tags2.has(t)),
                isTags: true,
                commonTags: [...tags1].filter(t => tags2.has(t)),
                onlyMasterTags: [...tags1].filter(t => !tags2.has(t)),
                onlyCompareTags: [...tags2].filter(t => !tags1.has(t))
            });
        }

        showDiffDetailModal.value = true;
    };

    // =========================================================
    // 🧬 内容级跨名称版本查重引擎（MinHash + LSH 预过滤 + Union-Find 聚类）
    //    与「同名查重」互补：即使名字/文件名不同，只要内容高度相似也归为一组。
    //    角色卡/世界书/预设通用，由当前 appMode 决定数据源。
    // =========================================================
    const showContentDedupeModal = ref(false);
    const contentDuplicateGroups = ref([]);

    // 1) 按资产类型提取对比文本（角色卡：描述/人格/场景/开场白；世界书：词条 key+content；预设：提示词+采样参数）
    const extractContentText = (item) => {
        if (appMode.value === 'worldbooks') {
            const entries = (item.data && Array.isArray(item.data.entries)) ? item.data.entries : [];
            return entries.map(e => {
                if (!e || typeof e !== 'object') return '';
                const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
                return `${keys} ${e.content || ''}`;
            }).join('\n');
        }
        if (appMode.value === 'presets') {
            const d = item.data || {};
            const promptTexts = [];
            if (d.prompts && typeof d.prompts === 'object') {
                Object.keys(d.prompts).map(Number).sort((a, b) => a - b)
                    .forEach(k => promptTexts.push(String(d.prompts[k] || '')));
            } else if (Array.isArray(d.prompts)) {
                d.prompts.forEach(p => promptTexts.push(typeof p === 'string' ? p : JSON.stringify(p)));
            }
            const params = PRESET_KEYS.filter(k => d[k] !== undefined)
                .map(k => `${k}=${JSON.stringify(d[k])}`).join('|');
            return promptTexts.join('\n') + '\n' + params;
        }
        // 角色卡
        const d = item.data?.data || item.data || {};
        return [d.description, d.personality, d.scenario, d.first_mes, d.mes_example]
            .filter(Boolean).join('\n');
    };

    // 2) 文本规范化（去空白/标点/大小写）
    const normalizeText = (t) => String(t || '')
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .toLowerCase()
        .trim();

    // 3) 字符 4-gram shingle 集合
    const getShingles = (text) => {
        const set = new Set();
        for (let i = 0; i + 4 <= text.length; i++) set.add(text.slice(i, i + 4));
        return set;
    };

    // 4) 确定性 MinHash 哈希函数族（固定种子，同一文本签名稳定）
    const MINHASH_HASHES = 96;
    const LSH_BANDS = 8;
    const LSH_ROWS = MINHASH_HASHES / LSH_BANDS; // 12
    const minhashSeeds = (() => {
        const seeds = [];
        let s = 0x9e3779b9;
        for (let i = 0; i < MINHASH_HASHES; i++) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            seeds.push(s);
        }
        return seeds;
    })();
    const hashString = (str, seed) => {
        let h = seed >>> 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
        return h;
    };

    // 5) MinHash 签名（每 shingle 求 96 个哈希的最小值）
    const computeMinHash = (shingles) => {
        const sig = new Array(MINHASH_HASHES).fill(0x7fffffff);
        shingles.forEach(sh => {
            for (let i = 0; i < MINHASH_HASHES; i++) {
                const h = hashString(sh, minhashSeeds[i]);
                if (h < sig[i]) sig[i] = h;
            }
        });
        return sig;
    };

    // 6) Jaccard 估计 = 签名中相同分量比例
    const estimateSimilarity = (a, b) => {
        let same = 0;
        for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
        return same / a.length;
    };

    // 7) LSH band 分桶 key（同一 band 内签名段完全一致的项互为候选）
    const bandKey = (sig, band) => {
        let key = '';
        for (let r = 0; r < LSH_ROWS; r++) key += sig[band * LSH_ROWS + r].toString(16).padStart(8, '0');
        return key;
    };

    // 8) Union-Find 并查集
    const unionFind = (n) => {
        const parent = Array.from({ length: n }, (_, i) => i);
        const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
        return { find, union };
    };

    // 9) 内容级版本查重主流程
    const startContentDedupeScan = async () => {
        try {
            const items = appMode.value === 'worldbooks' ? worldbooks.value
                : appMode.value === 'presets' ? presets.value
                : library.value;
            if (!items || items.length === 0) {
                nativeAlert('当前库为空，无法进行版本查重！', 'warning');
                return;
            }
            if (!window.electronAPI || typeof window.electronAPI.getFileStats !== 'function') {
                nativeAlert('❌ 版本查重引擎启动失败：preload.js 中未找到 getFileStats 接口！', 'error');
                return;
            }

            // 提取规范化文本，内容过短（<20 字符）无法可靠判定，跳过
            const valid = [];
            items.forEach((item, idx) => {
                const text = normalizeText(extractContentText(item));
                if (text.length < 20) return;
                valid.push({ item, idx, text });
            });
            const n = valid.length;
            if (n < 2) {
                nativeAlert('🎉 未发现可判定的内容重复项（内容过短的项已跳过）。', 'info');
                return;
            }

            // 计算 MinHash 签名（挂回条目，供相似度展示复用）
            const sigs = valid.map(v => computeMinHash(getShingles(v.text)));
            valid.forEach((v, i) => { v.sig = sigs[i]; });

            // LSH 候选 + 精确相似度确认（阈值 85%，复制改名/微调版本均命中）
            const buckets = new Map();
            valid.forEach((_, i) => {
                for (let b = 0; b < LSH_BANDS; b++) {
                    const k = bandKey(sigs[i], b);
                    if (!buckets.has(k)) buckets.set(k, []);
                    buckets.get(k).push(i);
                }
            });

            const THRESHOLD = 0.85;
            const uf = unionFind(n);
            const seenPairs = new Set();
            buckets.forEach(list => {
                if (list.length < 2) return;
                for (let x = 0; x < list.length; x++) {
                    for (let y = x + 1; y < list.length; y++) {
                        const a = list[x], b = list[y];
                        const pairKey = a < b ? `${a}:${b}` : `${b}:${a}`;
                        if (seenPairs.has(pairKey)) continue;
                        seenPairs.add(pairKey);
                        if (estimateSimilarity(sigs[a], sigs[b]) >= THRESHOLD) uf.union(a, b);
                    }
                }
            });

            // 聚类分组（单例忽略）
            const clusters = new Map();
            valid.forEach((_, i) => {
                const root = uf.find(i);
                if (!clusters.has(root)) clusters.set(root, []);
                clusters.get(root).push(i);
            });

            const rawGroups = [];
            clusters.forEach(members => {
                if (members.length < 2) return;
                rawGroups.push(members.map(i => valid[i]));
            });

            if (rawGroups.length === 0) {
                nativeAlert('🎉 未发现内容高度相似的重复项！', 'info');
                return;
            }

            // 批量获取物理状态（修改时间/大小）用于展示与排序
            const flatPaths = rawGroups.flat().map(v => v.item.path);
            let fileStats = {};
            try {
                const res = await window.electronAPI.getFileStats(flatPaths);
                if (res && res.success) fileStats = res.data || {};
            } catch (e) { /* 降级为无物理状态 */ }

            contentDuplicateGroups.value = rawGroups.map(list => {
                list.forEach(v => {
                    const st = fileStats[v.item.path];
                    v._sizeKb = st ? (st.size / 1024).toFixed(1) : '?';
                    v._mtime = st ? st.mtimeMs : Date.now();
                    v._dateStr = new Date(v._mtime).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                });
                // 内容最长者排最前（更可能是完整版）
                list.sort((a, b) => b.text.length - a.text.length);
                const master = list[0];
                list.forEach(v => {
                    v._simPct = v === master ? 100 : Math.round(estimateSimilarity(v.sig, master.sig) * 100);
                    const d = v.item.data?.data || v.item.data || {};
                    v._name = d.name || v.item.name || v.item.path.split(/[\\/]/).pop();
                });
                return { name: master._name, kind: 'content', list };
            });

            showContentDedupeModal.value = true;
            addLog(`🧬 内容级版本查重完成，发现 ${contentDuplicateGroups.value.length} 组疑似重复`, 'info');
        } catch (err) {
            console.error('内容级版本查重异常:', err);
            nativeAlert(`❌ 版本查重系统发生异常: ${err.message}`, 'error');
        }
    };

    // 一键清理：保留指定项，其余疑似重复版本移入回收站
    const resolveContentDedupeGroup = async (groupIndex, keepPath) => {
        const group = contentDuplicateGroups.value[groupIndex];
        if (!group) return;
        const pathsToTrash = group.list.filter(v => v.item.path !== keepPath).map(v => v.item.path);
        if (pathsToTrash.length === 0) return;

        const ok = await confirmDialog(`确定要将另外 ${pathsToTrash.length} 个疑似重复版本移入回收站吗？`);
        if (!ok) return;

        const res = await window.electronAPI.trashFiles(pathsToTrash);
        if (res && res.success) {
            const failedPaths = new Set((res.failed || []).map(f => f.path));
            const trashedPaths = pathsToTrash.filter(p => !failedPaths.has(p));

            // 同步内存库（按当前视图移除已删项）
            if (appMode.value === 'worldbooks') {
                worldbooks.value = worldbooks.value.filter(w => !trashedPaths.includes(w.path));
                if (activeWorldbook.value && trashedPaths.includes(activeWorldbook.value.path)) {
                    activeWorldbook.value = worldbooks.value[0] || null;
                }
            } else if (appMode.value === 'presets') {
                presets.value = presets.value.filter(p => !trashedPaths.includes(p.path));
                if (activePreset.value && trashedPaths.includes(activePreset.value.path)) {
                    activePreset.value = presets.value[0] || null;
                }
            } else {
                const currentLibItem = library.value.find(item => item.data === cardData.value);
                const currentTrashed = !!(currentLibItem && trashedPaths.includes(currentLibItem.path));
                library.value = library.value.filter(c => !trashedPaths.includes(c.path));
                if (currentTrashed) reset();
                deleteCardOverlays(trashedPaths);
                await cleanupEmptyCategories();
            }

            // 组内全部删净才移除该组；有残留则只剔除已删项
            if (failedPaths.size === 0) {
                contentDuplicateGroups.value.splice(groupIndex, 1);
            } else {
                group.list = group.list.filter(v => !trashedPaths.includes(v.item.path));
            }

            if (failedPaths.size > 0) {
                const names = [...failedPaths].map(p => p.split(/[\\/]/).pop()).join('、');
                nativeAlert(`已清理 ${res.count} 个；${failedPaths.size} 个失败（可能被占用）：\n${names}`, 'warning');
            } else {
                nativeAlert(`清理完成！已将 ${res.count} 个疑似重复版本移入回收站。`, 'info');
            }
        } else {
            nativeAlert(`清理失败: ${(res && res.error) || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 🎯 智能查重统一入口：根据当前视图（角色卡 / 世界书 / 预设）自动分发
    // =========================================================
    const startSmartDedupe = () => {
        if (appMode.value === 'worldbooks') return startWorldbookDedupeScan();
        if (appMode.value === 'presets') return startPresetDedupeScan();
        return startDedupeScan();
    };

    return {
        showDedupeModal, duplicateGroups, startDedupeScan, resolveDedupeGroup,
        showWbDedupeModal, wbDuplicateGroups, startWorldbookDedupeScan, resolveWbDedupeGroup,
        showPresetDedupeModal, presetDuplicateGroups, startPresetDedupeScan, resolvePresetDedupeGroup,
        showContentDedupeModal, contentDuplicateGroups, startContentDedupeScan, resolveContentDedupeGroup,
        startSmartDedupe,
        showDiffDetailModal, diffMasterItem, diffCompareItem, diffFieldResults, openDiffDetailModal
    };
}