/**
 * 标签系统组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：批量标签/预设标签、系统常用标签池、标签中英文切换、全局标签库。
 * 共享响应式状态（systemCommonTags / tagLangMode）保留在 App.vue 顶层并注入（被 syncConfigToDisk / 配置加载逻辑引用，
 * 若在本组合式函数内部定义会触发 TDZ），其余状态与操作方法在此定义，依赖通过参数注入，保持原有行为不变。
 */
import { ref, computed, triggerRef } from 'vue';

export function useTags({
    systemCommonTags, // ⚠️ 系统常用标签池 ref，由 App.vue 顶层持有（syncConfigToDisk 引用）
    tagLangMode,      // ⚠️ 标签语言模式 ref，由 App.vue 顶层持有（分类显示/syncConfigToDisk 引用）
    library,
    sanitizeImportedTags,
    confirmDialog,
    nativeAlert,
    persistCardUpdate,
    cardData,
    searchQueryInput,
    selectedIds,
    clearSelection,
    syncConfigToDisk,
    createProgressToast,     // 🔧 批量进度 Toast 工厂（并发安全）
    customTagCategories,     // 🛠️ 自定义大分类数组 ref（App.vue 顶层持有 + 持久化）
    customTagAssignments,    // 🎯 手动标签归属 ref（普通对象，便于 JSON 持久化）
    compiledAutoTagRules,    // 📋 自动打标规则编译结果 computed（{标签名: RegExp}），作清洗白名单
    customKeywords           // ✏️ 自定义关键词库 ref（AI 候选词池），作清洗白名单
}) {
    // ================= 批量标签与预设系统 =================
    const showBatchTagModal = ref(false);
    const batchInputTags = ref('');
    const batchMode = ref('append'); // 'append' 追加 或 'overwrite' 覆盖

    // 切换标签语言模式：'both' -> 'cn' -> 'en' -> 'both' 循环
    const toggleTagLangMode = () => {
        if (tagLangMode.value === 'both') tagLangMode.value = 'cn';
        else if (tagLangMode.value === 'cn') tagLangMode.value = 'en';
        else tagLangMode.value = 'both';
        // 统一中枢物理落盘（watch 也会触发，这里显式调用一次确保立即保存）
        syncConfigToDisk();
    };

    // 系统自带的酒馆标签预设库（结构化中英文）
    const presetTagsLibrary = [
        { cn: '奇幻', en: 'Fantasy' },
        { cn: '科幻', en: 'Sci-Fi' },
        { cn: '现代', en: 'Modern' },
        { cn: '末日', en: 'Post-Apocalyptic' },
        { cn: '限制级', en: 'NSFW' },
        { cn: '恋爱', en: 'Romance' },
        { cn: '病娇', en: 'Yandere' },
        { cn: '傲娇', en: 'Tsundere' },
        { cn: '精灵', en: 'Elf' },
        { cn: '魔物娘', en: 'Monster Girl' },
        { cn: '巨龙', en: 'Dragon' },
        { cn: '吸血鬼', en: 'Vampire' },
        { cn: '恶魔', en: 'Demon' },
        { cn: '天使', en: 'Angel' },
        { cn: '兽耳', en: 'Kemonomimi' },
        { cn: '机甲', en: 'Mecha' },
        { cn: '魔法', en: 'Magic' },
        { cn: '系统流', en: 'System' },
        { cn: '异世界', en: 'Isekai' },
        { cn: '暗黑', en: 'Dark' },
        { cn: '喜剧', en: 'Comedy' },
        { cn: '虐心', en: 'Angst' },
        { cn: '日常', en: 'Slice of Life' },
        { cn: '动作', en: 'Action' },
        { cn: '原创', en: 'Original' },
        { cn: '动漫', en: 'Anime' },
        { cn: '游戏', en: 'Game' },
        { cn: '小说', en: 'Novel' }
    ];

    // 根据当前模式获取预设标签显示的文本
    const getPresetTagText = (preset) => {
        if (tagLangMode.value === 'cn') return preset.cn;
        if (tagLangMode.value === 'en') return preset.en;
        return `${preset.en} (${preset.cn})`;
    };

    // 点击预设标签时，根据当前语言模式注入对应的文本
    const togglePresetTag = (preset) => {
        const tagToAdd = tagLangMode.value === 'cn' ? preset.cn : (tagLangMode.value === 'en' ? preset.en : preset.en);
        let current = batchInputTags.value.split(',').map(t => t.trim()).filter(t => t);
        if (current.includes(tagToAdd)) {
            current = current.filter(t => t !== tagToAdd);
        } else {
            current.push(tagToAdd);
        }
        batchInputTags.value = current.join(', ');
    };

    // 当前批量输入框中的标签（逗号分隔 → 数组，用于芯片展示与点击移除）
    const batchTagChips = computed(() =>
        batchInputTags.value.split(',').map(t => t.trim()).filter(t => t)
    );

    // 从统一系统/常用标签库快速切换添加/移除标签到批量输入框
    const toggleBatchCommonTag = (tag) => {
        const current = batchTagChips.value;
        if (current.includes(tag)) {
            batchInputTags.value = current.filter(t => t !== tag).join(', ');
        } else {
            current.push(tag);
            batchInputTags.value = current.join(', ');
        }
    };

    // 点击芯片 ✕ 移除某个待添加标签
    const removeBatchTag = (idx) => {
        const current = batchTagChips.value;
        current.splice(idx, 1);
        batchInputTags.value = current.join(', ');
    };

    // 根据当前语言模式显示任意已存储标签（未知标签原样返回，兼容中英/双语存储格式）
    const displayTagText = (tag) => {
        if (!tag) return tag;
        const preset = presetTagsLibrary.find(p => p.cn === tag || p.en === tag || tag.startsWith(`${p.en} (`));
        if (!preset) return tag;
        if (tagLangMode.value === 'cn') return preset.cn;
        if (tagLangMode.value === 'en') return preset.en;
        return `${preset.en} (${preset.cn})`;
    };

    // ================= 系统/全局标签库支持 =================
    // ⚠️ 统一数据源：全部增删操作基于 systemCommonTags（已内置 watch deep 持久化到 localStorage `customSystemTags`）
    //    彻底废弃内存级 defaultSystemTags（不持久化，重启丢失且与弹窗数据源分裂）
    const newGlobalTagInput = ref(''); // 用于绑定直接新增标签的输入框

    // 2. 动态计算：从当前所有已导入的卡片中聚合提取出所有的标签（基于 systemCommonTags + 全库标签）
    const globalAvailableTags = computed(() => {
        const tagSet = new Set(systemCommonTags.value);
        library.value.forEach(item => {
            // 提取自定义标签（用户主动打的，始终保留）
            if (item.customTags && Array.isArray(item.customTags)) {
                // 🔧 修复：只聚合「非空字符串」标签，杜绝空白 chip
                item.customTags.forEach(t => {
                    if (typeof t === 'string' && t.trim() !== '') tagSet.add(t);
                });
            }
            // 【修复 BUG-2】卡片原生自带标签：仅在"导入时忽略卡片自带标签"开关关闭时透出
            // （开启 = 忽略他人卡片的杂乱标签，不再混入全局标签池）
            if (!sanitizeImportedTags.value) {
                const d = item.data?.data || item.data || {};
                if (d.tags) {
                    if (Array.isArray(d.tags)) {
                        // 🔧 修复：同上
                        d.tags.forEach(t => {
                            if (typeof t === 'string' && t.trim() !== '') tagSet.add(t);
                        });
                    } else if (typeof d.tags === 'string' && d.tags.trim() !== '') {
                        d.tags.split(',').forEach(t => { if (t.trim() !== '') tagSet.add(t.trim()); });
                    }
                }
            }
        });
        return Array.from(tagSet);
    });

    // 🔧 批量落盘进度执行器：逐张执行 + 节流进度 Toast（每 20 张）+ 完成态。
    // 仅超过 10 张时启用 Toast（小批量瞬时完成，无需打扰）
    const runWithProgress = async (items, label, taskFn) => {
        const total = items.length;
        const prog = total > 10 ? createProgressToast() : null; // 小批量不打扰
        let saved = 0;
        for (let i = 0; i < total; i++) {
            if (await taskFn(items[i])) saved++;
            if (prog && ((i + 1) % 20 === 0 || i + 1 === total)) {
                prog.update(`${label}... ${i + 1}/${total}`);
            }
        }
        if (prog) prog.finish(`✅ ${label}完成（${saved}/${total} 张已落盘）`, saved === total ? 'success' : 'warning');
        // 🔧 批次结束强制冲刷一次落盘（防抖只负责循环中高频写，这里收尾防丢最后一次变更）
        if (total > 0) syncConfigToDisk();
        return saved;
    };

    // 3. 允许在系统/常用标签栏直接添加新标签（写入统一池，watch deep 自动持久化）
    const addTagToGlobalPool = () => {
        const val = newGlobalTagInput.value.trim();
        if (val && !systemCommonTags.value.includes(val)) {
            systemCommonTags.value.push(val);
            newGlobalTagInput.value = '';
        }
    };

    // 4. 彻底清洗：点击 × 删除系统标签，从统一池移除（自动持久化）并清洗所有卡片，将受影响的卡片物理落盘
    const removeTagFromGlobalPool = async (tagToRemove) => {
        // 确认（Electron 中 window.confirm 静默返回 null，必须用 confirmDialog）
        const ok = await confirmDialog(`确定要从系统常用标签库中彻底删除 [${tagToRemove}] 吗？\n（这也会清洗掉所有卡片中残留的该标签！）`);
        if (!ok) return;

        // 从统一预设池移除（watch deep 自动持久化）
        systemCommonTags.value = systemCommonTags.value.filter(t => t !== tagToRemove);

        // 深度清洗库中所有卡片的该标签，并记录被修改的卡片
        const modifiedItems = [];
        library.value.forEach(item => {
            let isModified = false;

            if (Array.isArray(item.customTags)) {
                const filtered = item.customTags.filter(t => t !== tagToRemove);
                if (filtered.length !== item.customTags.length) { item.customTags = filtered; isModified = true; }
            }

            const d = item.data?.data || item.data || {};
            if (Array.isArray(d.tags)) {
                const filtered = d.tags.filter(t => t !== tagToRemove);
                if (filtered.length !== d.tags.length) { d.tags = filtered; isModified = true; }
            } else if (typeof d.tags === 'string') {
                const cleaned = d.tags.split(',').map(t => t.trim()).filter(t => t && t !== tagToRemove).join(', ');
                if (cleaned !== d.tags) { d.tags = cleaned; isModified = true; }
            }

            if (isModified) modifiedItems.push(item);
        });

        // 将受影响的卡片物理保存到本地（防止重启/重新扫描后脏标签复活），并同步覆盖层
        const savedCount = await runWithProgress(modifiedItems, '🧹 清洗标签', async (item) => {
            try {
                await persistCardUpdate(item, { tags: item.customTags || [], category: item.category });
                return true;
            } catch (e) {
                console.error(`清洗标签后物理保存失败 [${item.name}]:`, e);
                return false;
            }
        });

        nativeAlert(`已从系统库彻底清洗标签：[${tagToRemove}]\n${savedCount > 0 ? `并已将 ${savedCount} 张受影响卡片物理保存到本地！` : '（库中未发现残留该标签的卡片）'}`, 'info');
    };

    // 🧹 一键清空：彻底清空系统常用标签库 + 清洗全库所有卡片上的全部标签（物理落盘，不可撤销）
    const clearAllTagsFromPool = async () => {
        const poolCount = systemCommonTags.value.length;
        const cardCount = library.value.length;
        if (poolCount === 0 && cardCount === 0) {
            return nativeAlert('当前没有可清空的标签。', 'info');
        }
        const ok = await confirmDialog(
            `确定要一键清空所有标签吗？\n\n` +
            `· 系统常用标签库：${poolCount} 个\n` +
            `· 全库 ${cardCount} 张卡片上的全部标签（含原生 data.tags）\n\n` +
            `⚠️ 此操作将物理落盘且不可撤销，请谨慎确认！`
        );
        if (!ok) return;

        // 1. 清空系统标签池（watch deep 自动持久化）
        systemCommonTags.value = [];

        // 2. 清洗全库所有卡片的 customTags 与原生 data.tags
        const modifiedItems = [];
        library.value.forEach(item => {
            let isModified = false;
            if (Array.isArray(item.customTags) && item.customTags.length > 0) {
                item.customTags = [];
                isModified = true;
            }
            const d = item.data?.data || item.data || {};
            if (Array.isArray(d.tags) && d.tags.length > 0) {
                d.tags = [];
                isModified = true;
            } else if (typeof d.tags === 'string' && d.tags.trim() !== '') {
                d.tags = '';
                isModified = true;
            }
            if (isModified) modifiedItems.push(item);
        });

        // 3. 物理落盘（覆盖层写空数组 = 记录"用户已清空"，重扫不自动补标签）
        const savedCount = await runWithProgress(modifiedItems, '🧹 清空标签', async (item) => {
            try {
                await persistCardUpdate(item, { tags: item.customTags || [], category: item.category });
                return true;
            } catch (e) {
                console.error(`一键清空标签后物理保存失败 [${item.name}]:`, e);
                return false;
            }
        });

        // 4. 刷新当前卡片展示
        if (cardData.value) triggerRef(cardData);

        nativeAlert(`✅ 已一键清空全部标签！\n系统标签库 ${poolCount} 个已清空，全库 ${modifiedItems.length} 张卡片标签已清除，物理保存 ${savedCount} 张。`, 'info');
    };

    // 🗑️ 批量删除标签：从系统标签库移除多个标签 + 清洗全库卡片残留（一次确认，批量落盘）
    // @returns {number} 成功删除的标签数
    const batchRemoveTags = async (tagList) => {
        const tags = (tagList || []).filter(t => t && t.trim() !== '');
        if (tags.length === 0) return 0;
        const ok = await confirmDialog(
            `确定要批量删除选中的 ${tags.length} 个标签吗？\n\n` +
            `· 从系统常用标签库移除：${tags.slice(0, 6).join('、')}${tags.length > 6 ? ` 等 ${tags.length} 个` : ''}\n` +
            `· 清洗全库卡片中残留的以上标签（物理落盘）`
        );
        if (!ok) return 0;

        const tagSet = new Set(tags);
        // 1. 从系统标签池移除（watch deep 自动持久化）
        systemCommonTags.value = systemCommonTags.value.filter(t => !tagSet.has(t));

        // 2. 清洗全库所有卡片的这些标签
        const modifiedItems = [];
        library.value.forEach(item => {
            let isModified = false;
            if (Array.isArray(item.customTags)) {
                const filtered = item.customTags.filter(t => !tagSet.has(t));
                if (filtered.length !== item.customTags.length) { item.customTags = filtered; isModified = true; }
            }
            const d = item.data?.data || item.data || {};
            if (Array.isArray(d.tags)) {
                const filtered = d.tags.filter(t => !tagSet.has(t));
                if (filtered.length !== d.tags.length) { d.tags = filtered; isModified = true; }
            } else if (typeof d.tags === 'string' && d.tags.trim() !== '') {
                const cleaned = d.tags.split(',').map(t => t.trim()).filter(t => t && !tagSet.has(t)).join(', ');
                if (cleaned !== d.tags) { d.tags = cleaned; isModified = true; }
            }
            if (isModified) modifiedItems.push(item);
        });

        // 3. 物理落盘 + 覆盖层同步
        const savedCount = await runWithProgress(modifiedItems, '🗑️ 批量删除标签', async (item) => {
            try {
                await persistCardUpdate(item, { tags: item.customTags || [], category: item.category });
                return true;
            } catch (e) {
                console.error(`批量删除标签后物理保存失败 [${item.name}]:`, e);
                return false;
            }
        });
        if (cardData.value) triggerRef(cardData);

        nativeAlert(`🗑️ 已批量删除 ${tags.length} 个标签\n并清洗全库 ${modifiedItems.length} 张卡片，物理保存 ${savedCount} 张。`, 'info');
        return tags.length;
    };

    // 5. 搜索快捷追加：点击搜索栏下方的快捷标签，直接填入搜索框并立即过滤
    const appendTagToSearch = (tag) => {
        if (!searchQueryInput.value) {
            searchQueryInput.value = tag;
        } else if (!searchQueryInput.value.includes(tag)) {
            searchQueryInput.value = searchQueryInput.value + ' ' + tag;
        }
    };

    // 标签快捷栏展开状态（点击展开/收起系统标签面板）
    const isEditingSystemTags = ref(false);

    // 点击系统/全局标签快速添加到当前卡片（内存 customTags + 原生 data.tags 双写，并物理落盘）
    const addGlobalTag = async (tag) => {
        const libItem = library.value.find(item => item.data === cardData.value);
        if (!libItem) return;

        let isModified = false;

        // 1. 内存层
        if (!libItem.customTags?.includes(tag)) {
            libItem.customTags = Array.from(new Set([...(libItem.customTags || []), tag]));
            isModified = true;
        }

        // 2. 原生数据层（兼容 V1/V2：data?.data || data）
        const dataLayer = libItem.data?.data || libItem.data || {};
        if (!Array.isArray(dataLayer.tags)) dataLayer.tags = [];
        if (!dataLayer.tags.includes(tag)) {
            dataLayer.tags.push(tag);
            isModified = true;
        }

        // 3. 统一持久化中枢：写覆盖层 + 物理落盘
        if (isModified) {
            await persistCardUpdate(libItem, { tags: libItem.customTags, category: libItem.category });
        }
    };

    // 批量贴标签（多张卡片：内存 customTags + 原生 data.tags 双写，并逐张物理落盘）
    const executeBatchTagSave = async () => {
        if (selectedIds.value.length === 0) return;
        const tagsToAdd = batchInputTags.value.split(',').map(t => t.trim()).filter(t => t);

        // 🔧 先收敛目标集合（原为 library 全量遍历 + selectedIds 过滤）
        const targets = library.value.filter(i => selectedIds.value.includes(i.id));

        const savedCount = await runWithProgress(targets, '🏷️ 批量标签保存', async (item) => {
            let isModified = false;

            // 1. 同步内存 customTags（原逻辑不变）
            if (batchMode.value === 'overwrite') {
                item.customTags = [...tagsToAdd];
                isModified = true;
            } else {
                const newTags = Array.from(new Set([...(item.customTags || []), ...tagsToAdd]));
                if (newTags.length !== item.customTags?.length) {
                    item.customTags = newTags;
                    isModified = true;
                }
            }

            // 2. 同步原生数据 tags（原逻辑不变）
            const dataLayer = item.data?.data || item.data || {};
            if (!Array.isArray(dataLayer.tags)) dataLayer.tags = [];
            if (batchMode.value === 'overwrite') {
                dataLayer.tags = [...tagsToAdd];
                isModified = true;
            } else {
                const newDataTags = Array.from(new Set([...dataLayer.tags, ...tagsToAdd]));
                if (newDataTags.length !== dataLayer.tags.length) {
                    dataLayer.tags = newDataTags;
                    isModified = true;
                }
            }

            // 3. 统一持久化中枢：写覆盖层 + 物理落盘
            if (!isModified) return false;
            try {
                await persistCardUpdate(item, { tags: item.customTags, category: item.category });
                return true;
            } catch (e) {
                console.error(`批量标签保存失败 [${item.name}]:`, e);
                return false;
            }
        });

        nativeAlert(`成功为 ${selectedIds.value.length} 张卡片更新标签，并成功物理保存了 ${savedCount} 张！`, 'info');
        showBatchTagModal.value = false;
        batchInputTags.value = '';
        clearSelection();
    };

    // 🧹 一键清洗历史「外来标签」：清除历史上（sanitize 开关开启前）被收编进卡片的、
    //    不在应用自身标签词表内的标签（customTags + 原生 data.tags 双清），并物理落盘。
    //    —— 开关只影响「新导入」；历史卡的外来标签已被 persistCardUpdate 永久写回 PNG，
    //       且 globalAvailableTags 无条件聚合 customTags → 表现为「开关无效」的体感残留。
    //    customTags 无「用户手动添加 vs 历史收编」元数据，只能按词表白名单反向清洗：
    //    keep 词表 = 系统/常用标签库 + 自动打标规则标签 + 用户手动归类过的标签 + 自定义关键词库。
    //    保留策略说明：如需保留个别词表外的标签，请先将其加入「系统/常用标签库」再执行本清洗。
    const cleanForeignTagsFromLibrary = async () => {
        if (!library.value.length) return nativeAlert('当前没有已加载的卡片，无需清洗。', 'info');

        // 1. 组装 keep 词表（大小写不敏感比较，兼容自定义归属存小写键）
        const keepLower = new Set();
        const addKeep = (v) => { if (typeof v === 'string' && v.trim()) keepLower.add(v.trim().toLowerCase()); };
        (systemCommonTags.value || []).forEach(addKeep);
        const rules = (compiledAutoTagRules && compiledAutoTagRules.value) || {};
        Object.keys(rules).forEach(addKeep);
        const kw = (customKeywords && customKeywords.value) || [];
        (Array.isArray(kw) ? kw : []).forEach(addKeep);
        Object.keys(customTagAssignments.value || {}).forEach(addKeep); // 手动归类键 = 用户显式意图保留
        const isKeep = (t) => typeof t === 'string' && t.trim() !== '' && keepLower.has(t.trim().toLowerCase());

        // 2. 全库扫描：收集词表外的外来标签 + 受影响卡片
        const foreign = new Map(); // 标签 → 出现次数
        const modified = [];
        const scanTags = (tag) => { if (typeof tag === 'string' && tag.trim() && !isKeep(tag)) foreign.set(tag.trim(), (foreign.get(tag.trim()) || 0) + 1); };
        library.value.forEach(item => {
            let hit = false;
            if (Array.isArray(item.customTags)) {
                item.customTags.forEach(t => { if (typeof t === 'string' && t.trim() && !isKeep(t)) { scanTags(t); hit = true; } });
            }
            const d = item.data?.data || item.data || {};
            if (Array.isArray(d.tags)) {
                d.tags.forEach(t => { if (typeof t === 'string' && t.trim() && !isKeep(t)) { scanTags(t); hit = true; } });
            } else if (typeof d.tags === 'string' && d.tags.trim()) {
                d.tags.split(',').forEach(t => { t = t.trim(); if (t && !isKeep(t)) { scanTags(t); hit = true; } });
            }
            if (hit) modified.push(item);
        });

        if (foreign.size === 0) return nativeAlert('🎉 未发现外来标签：全库标签均已在系统常用标签库 / 自动规则 / 手动归类范围内。', 'info');

        const tagList = Array.from(foreign.keys()).sort();
        const preview = tagList.slice(0, 15).join('、') + (tagList.length > 15 ? ` 等共 ${tagList.length} 个` : '');
        const ok = await confirmDialog(
            `确定要清洗历史「外来标签」吗？\n\n` +
            `· 将清除 ${tagList.length} 个不在你系统标签库中的外来标签\n` +
            `· 涉及 ${modified.length} 张卡片（customTags 与原生 data.tags 双清，物理落盘）\n` +
            `· 示例：${preview}\n\n` +
            `✅ 保留：系统/常用标签库 + 自动打标规则标签 + 你手动归类过的标签 + 自定义关键词库\n` +
            `⚠️ 如需保留个别词表外标签，请先将其加入「系统/常用标签库」再执行本操作\n` +
            `⚠️ 此操作不可撤销！`
        );
        if (!ok) return;

        // 3. 逐张清洗（词表外的标签全部剔除）并物理落盘
        const total = tagList.length;
        const savedCount = await runWithProgress(modified, '🧹 清洗外来标签', async (item) => {
            let isModified = false;
            if (Array.isArray(item.customTags)) {
                const f = item.customTags.filter(t => !(typeof t === 'string' && t.trim() !== '' && !isKeep(t)));
                if (f.length !== item.customTags.length) { item.customTags = f; isModified = true; }
            }
            const d = item.data?.data || item.data || {};
            if (Array.isArray(d.tags)) {
                const f = d.tags.filter(t => !(typeof t === 'string' && t.trim() !== '' && !isKeep(t)));
                if (f.length !== d.tags.length) { d.tags = f; isModified = true; }
            } else if (typeof d.tags === 'string' && d.tags.trim()) {
                const cleaned = d.tags.split(',').map(t => t.trim()).filter(t => t && isKeep(t)).join(', ');
                if (cleaned !== d.tags) { d.tags = cleaned; isModified = true; }
            }
            if (!isModified) return false;
            try {
                await persistCardUpdate(item, { tags: item.customTags || [], category: item.category });
                return true;
            } catch (e) {
                console.error(`清洗外来标签后物理保存失败 [${item.name}]:`, e);
                return false;
            }
        });
        if (cardData.value) triggerRef(cardData);
        nativeAlert(`🧹 清洗完成！\n已清除 ${total} 个外来标签，清洗 ${modified.length} 张卡片，物理保存 ${savedCount} 张。`, 'info');
    };

    // ================= 自定义大分类系统 =================
    // 新增自定义分类（key 自动生成 custom_<时间戳>）
    const addCustomTagCategory = (name, icon = '🏷️') => {
        const trimmed = String(name || '').trim();
        if (!trimmed) { nativeAlert('分类名称不能为空', 'warning'); return null; }
        if (customTagCategories.value.some(c => c.name === trimmed)) {
            nativeAlert(`已存在同名分类「${trimmed}」`, 'warning'); return null;
        }
        const key = `custom_${Date.now().toString(36)}`;
        customTagCategories.value.push({ key, name: trimmed, icon: String(icon || '🏷️') });
        syncConfigToDisk();
        return key;
    };

    // 重命名自定义分类
    const renameCustomTagCategory = (key, name) => {
        const cat = customTagCategories.value.find(c => c.key === key);
        if (!cat) return false;
        const trimmed = String(name || '').trim();
        if (!trimmed) { nativeAlert('分类名称不能为空', 'warning'); return false; }
        if (customTagCategories.value.some(c => c.key !== key && c.name === trimmed)) {
            nativeAlert(`已存在同名分类「${trimmed}」`, 'warning'); return false;
        }
        cat.name = trimmed;
        syncConfigToDisk();
        return true;
    };

    // 删除自定义分类（同时清除其下所有手动归属标签）
    const removeCustomTagCategory = (key) => {
        customTagCategories.value = customTagCategories.value.filter(c => c.key !== key);
        for (const [tag, catKey] of Object.entries(customTagAssignments.value)) {
            if (catKey === key) delete customTagAssignments.value[tag];
        }
        syncConfigToDisk();
    };

    // 🎯 手动归属（批量）：将多个标签分配到指定分类（key 为 'other' 时解除归属）。
    //    批量循环内只改内存态、末尾统一 syncConfigToDisk 一次（避免几百次全量写盘）。
    const assignTagsToCategory = (tags, key) => {
        const list = (Array.isArray(tags) ? tags : [tags])
            .map(t => String(t || '').trim())
            .filter(Boolean);
        if (!list.length) return;
        const lower = k => String(k || '').toLowerCase();
        if (!key || key === 'other') {
            for (const t of list) delete customTagAssignments.value[lower(t)];
        } else {
            for (const t of list) customTagAssignments.value[lower(t)] = key;
        }
        syncConfigToDisk();
    };
    // 手动归属单标签（兼容入口：内部走批量实现）
    const assignTagToCategory = (tag, key) => assignTagsToCategory([tag], key);

    return {
        showBatchTagModal, batchInputTags, batchMode, presetTagsLibrary,
        batchTagChips, toggleBatchCommonTag, removeBatchTag,
        toggleTagLangMode, getPresetTagText, displayTagText,
        togglePresetTag, executeBatchTagSave,
        globalAvailableTags, newGlobalTagInput, addTagToGlobalPool,
        removeTagFromGlobalPool, clearAllTagsFromPool, batchRemoveTags,
        cleanForeignTagsFromLibrary,
        appendTagToSearch, isEditingSystemTags, addGlobalTag,
        addCustomTagCategory, renameCustomTagCategory,
        removeCustomTagCategory, assignTagToCategory, assignTagsToCategory
    };
}