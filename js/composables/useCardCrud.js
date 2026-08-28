/**
 * 卡片 CRUD 组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：卡片导入入库 / 删除回收 / 持久化保存 / 导出重命名。
 * 共享响应式状态（library / cardData / appConfig 等）与横切服务（nativeAlert / showToast / appPrompt）
 * 保留在 App.vue 顶层并注入；分组域回调（cleanupEmptyCategories）经箭头包装延迟绑定
 * （useCardGroups 在本组合式函数之后调用，箭头函数体运行时才求值，无 TDZ）。
 * 迁移原则：函数体逐字保留（含 v1.8.5 性能修复与影分身修复注释），不做顺手优化。
 */
import { normalizeCardData, isCharacterCardData, autoTagRules } from '../utils/cardLoader.js';
import { parsePNGChunk, deepScanForJSON } from '../utils/pngParser.js';

export function useCardCrud({
    // —— 共享状态：App.vue 顶层持有，ref/computed 原样注入 ——
    library,              // 卡片库集合
    cardData,             // 当前打开的卡片（shallowRef）
    currentFolderPath,    // 当前库目录（拖拽/URL 导入的前提）
    appConfig,            // 统一配置中枢（cardOverlays 覆盖层）
    customCategories,     // 自定义分组列表（物理子文件夹并组）
    allCategories,        // 全量分组 computed（自动分类白名单判定）
    isCategoryKnown,      // 分组名已知性判定
    importedConfig,       // 外部导入的库配置（历史分类/标签恢复）
    localCategoryMap,     // localStorage 分类映射
    sanitizeImportedTags, // 导入时忽略卡片自带标签开关
    isDragging,           // 拖拽遮罩状态
    dragCounter,          // 拖拽深度计数器
    importFileInput,      // 隐藏文件输入 ref（HeaderBar 模板绑定回写）
    // —— 横切服务 ——
    nativeAlert, showToast, appPrompt, safeData,
    // —— 配置中枢（必须先于本组合式函数定义，TDZ 约束） ——
    syncConfigToDisk, syncConfigToDiskDebounced,
    // —— 卡片导入时间映射（首次入库时刻，持久化；「导入时间」排序数据源） ——
    cardImportTimes,
    // —— 跨域回调（UI 域 / 分组域，注入而非搬移，斩断循环依赖） ——
    reset,                // 关闭编辑面板（删除当前打开卡片时）
    openFromLibrary,      // 打开库中卡片（切库后重绑）
    cleanupEmptyCategories // 自动清理空分组（useCardGroups 产出；箭头包装延迟绑定）
}) {
    // =========================================================
    // 💾 持久化域（配置覆盖层 + 物理重写）
    // =========================================================

    // 单卡分类持久化辅助：写 localStorage 映射 + 统一配置覆盖层（双保险，防重扫冲刷）
    const persistCardCategory = (item) => {
        if (item && item.name) {
            localCategoryMap.value[item.name] = item.category || '未分类';
            // 🛡️ 同步写入统一配置覆盖层（key=path，重名卡片不再互相覆盖）
            const key = (item.path || item.name || '').toString();
            if (!appConfig.value.cardOverlays[key]) appConfig.value.cardOverlays[key] = {};
            appConfig.value.cardOverlays[key].category = item.category || '未分类';
            if (Array.isArray(item.customTags)) {
                appConfig.value.cardOverlays[key].tags = [...item.customTags];
            }
            syncConfigToDisk();
        }
    };

    const persistCardUpdate = async (cardItem, updatePayload = {}) => {
        if (!cardItem) return;

        // 1. 更新内存状态
        if (updatePayload.category !== undefined) cardItem.category = updatePayload.category;
        if (updatePayload.tags !== undefined) {
            // 🔧 契约加固：updatePayload.tags 视为该卡自定义标签的【权威完整列表】。
            // 旧实现 union(data.tags, customTags) 只增不减——调用方若传入
            // "比旧 customTags 少"的列表（如未来的标签编辑器），被移除的标签会从
            // 原生 data.tags 复活。现改为：旧 customTags 中被移除的标签同步从
            // data.tags 清除（与 removeSingleTag 双清语义对齐），
            // 卡片原生自带且从未进入 customTags 的标签不受影响。
            const oldCustom = Array.isArray(cardItem.customTags) ? [...cardItem.customTags] : [];
            cardItem.customTags = Array.isArray(updatePayload.tags) ? [...updatePayload.tags] : [];

            const dataLayer = cardItem.data?.data || cardItem.data || {};
            if (!dataLayer.tags || typeof dataLayer.tags === 'string') dataLayer.tags = [];
            const newCustomSet = new Set(cardItem.customTags);
            const removedSet = new Set(oldCustom.filter(t => !newCustomSet.has(t)));
            const kept = (Array.isArray(dataLayer.tags) ? dataLayer.tags : []).filter(t => !removedSet.has(t));
            dataLayer.tags = Array.from(new Set([...kept, ...cardItem.customTags]));
        }

        // 2. 写入 AppData 物理覆盖层（双重保险：即使 PNG 重写失败，配置库也能记住数据）
        const cardKey = cardItem.path || cardItem.name;
        appConfig.value.cardOverlays[cardKey] = {
            category: cardItem.category || '未分类',
            tags: Array.isArray(cardItem.customTags) ? [...cardItem.customTags] : []
        };
        syncConfigToDiskDebounced();

        // 3. 物理重写文件（PNG 的 tEXt 元数据块 / JSON 覆写），剥离 Proxy 后经 IPC
        // 🔧 v1.8.5 配套：保存成功后回写 _mtime（防下次"刷新库"把本卡误判为已变化）
        if (window.electronAPI && typeof window.electronAPI.saveCard === 'function' && cardItem.path && cardItem.data) {
            try {
                const saveRes = await window.electronAPI.saveCard(cardItem.path, JSON.parse(JSON.stringify(cardItem.data)));
                if (saveRes && saveRes.success && saveRes.mtime) cardItem._mtime = saveRes.mtime;
            } catch (err) {
                console.error('卡片文件物理覆盖失败，已用物理配置文件兜底:', err);
            }
        }
    };

    // 🔧 删除卡片后清理覆盖层 key：防止 app_config.json 的 cardOverlays 随删除操作无限膨胀
    // ⚠️ 行为取舍：清理后若从 .trash/jsTavern_Trash 手动找回同名卡，分类会回退为
    // 「未分类」（分类只存覆盖层；标签已随 persistCardUpdate 物理写回 PNG，不受影响）。
    // 若更看重找回后的状态完整性，可不接入本函数（膨胀速度极慢，每条几十字节）
    const deleteCardOverlays = (paths) => {
        if (!Array.isArray(paths) || paths.length === 0) return;
        const overlays = appConfig.value.cardOverlays || {};
        let removed = false;
        for (const p of paths) {
            if (p && overlays[p]) { delete overlays[p]; removed = true; }
        }
        if (removed) syncConfigToDisk();
    };

    // =========================================================
    // 🏷️ 自动分类与打标（导入入库的伴生逻辑）
    // =========================================================

    // 自动分类与贴标签的核心逻辑
    const processAutoTagsAndCategory = (cardInfo) => {
        // 📁 物理文件夹分组优先：卡片位于库目录的子文件夹时，其一级文件夹名即为分组
        // （文件系统位置是事实依据，重扫/重命名/移动后保持一致）
        if (cardInfo.subFolder) {
            cardInfo.category = cardInfo.subFolder.split(/[\\/]/)[0] || '未分类';
            return;
        }
        // ---- 【🛡️ 最高优先级】物理配置库覆盖层恢复（用户手动改过的分类/标签，防重扫冲刷） ----
        // 覆盖层 key = 卡片路径（path），兼容旧数据回退卡片名（name）
        const overlayKey = (cardInfo.path || cardInfo.name || '').toString();
        const overlay = appConfig.value.cardOverlays && appConfig.value.cardOverlays[overlayKey];
        if (overlay) {
            let overlayApplied = false;
            if (overlay.category && overlay.category.trim() !== '') {
                cardInfo.category = overlay.category;
                overlayApplied = true;
            }
            // tags 存在即恢复（含空数组 = 用户清空过标签，同样要记住，禁止回退自动分类）
            if (Array.isArray(overlay.tags)) {
                cardInfo.customTags = [...overlay.tags];
                // 同步回酒馆原生 data.tags（保证后续保存一致）
                const dataLayer = cardInfo.data?.data || cardInfo.data || {};
                if (dataLayer && Array.isArray(dataLayer.tags)) {
                    dataLayer.tags = Array.from(new Set([...dataLayer.tags, ...overlay.tags]));
                }
                overlayApplied = true;
            }
            if (overlayApplied) return; // 覆盖层命中即视为用户配置，跳过自动分类，绝不冲刷
        }
        // ---- 【优先应用导入的历史配置】 ----
        const savedConfig = importedConfig.value[cardInfo.name];
        if (savedConfig) {
            cardInfo.category = savedConfig.category || '未分类';
            cardInfo.customTags = savedConfig.customTags || [];
            return; // 如果有历史配置，就跳过自动分类，直接使用用户的历史数据
        }
        // ---- 【修复】localStorage 持久化的手动分类（优先级高于自动分类，重启/重扫后保留） ----
        if (localCategoryMap.value[cardInfo.name]) {
            cardInfo.category = localCategoryMap.value[cardInfo.name];
            return;
        }
        // ---- 【以下为原有的自动规则代码】 ----
        const data = cardInfo.data?.data || cardInfo.data;
        if (!data) return;

        // 提取所有文本用于分析
        const fullText = [data.description, data.personality, data.scenario, data.first_mes].join('\n');
        // 🧹 导入数据清洗开关：开启时忽略卡片自带的原生 tags（防止他人卡片的杂乱标签混入全局标签池）
        let generatedTags = sanitizeImportedTags.value ? [] : [...(data.tags || [])];
        let assignedCategory = '未分类';

        // 匹配自动标签
        for (const [tag, regex] of Object.entries(autoTagRules)) {
            if (regex.test(fullText) && !generatedTags.includes(tag)) {
                generatedTags.push(tag);
                // 【修复】自动分类仅落到已知预设分组：
                //   tag.split(' ')[0] 可能产生预设外的英文组名（如 'Monster (魔物娘)' → 'Monster'），
                //   导致导入卡片被分到莫名/英文名的分组（用户眼中"没有名字的分组"）。
                //   未知组名不设分类（保持"未分类"），也不自动创建新分组。
                if (assignedCategory === '未分类') {
                    const cand = tag.split(' ')[0];
                    if (allCategories.value.some(c => c.key === cand || c.cn === cand || c.en === cand)) {
                        assignedCategory = cand;
                    }
                }
            }
        }

        // 更新到卡片对象
        cardInfo.customTags = Array.from(new Set(generatedTags));
        cardInfo.category = assignedCategory;

        // 【修复 BUG-3】自动分类不再盲目创建分组：
        //  · 开关开启（导入即净化）：完全不自动创建分组，自动分类仅落到卡片属性；
        //  · 开关关闭：也先过滤「未分类」，仅对真正的新分类才补建分组。
        //  分组在物理文件夹体系下以库目录子文件夹为准（walkLibraryDir 一级文件夹），
        //  此处避免把自动贴标签引入的普通分类词当成分组，产生"幽灵分组"。
        const shouldAutoBuildCategory = !sanitizeImportedTags.value;
        const catTrimmed = String(assignedCategory || '').trim();
        if (shouldAutoBuildCategory
            && catTrimmed && catTrimmed !== '未分类'
            && !allCategories.value.some(c => c.cn === assignedCategory || c.en === assignedCategory || c.key === assignedCategory)) {
            customCategories.value.push(assignedCategory);
        }
    };

    // =========================================================
    // 📥 导入入库域（staging + 低并发后台落盘）
    // =========================================================

    // 🚀 v1.8.5 性能参数（组合式函数内共享）：
    //    - deferredAutoTagSaves：批量加载期收集的"自动打标待落盘"卡片列表
    //    - flushDeferredAutoTagSaves：加载完成后低并发后台写盘（不阻塞 UI 呈现）
    //    - opts.target：staging 暂存数组（批量加载完成后一次性赋给 library）
    //    - opts.deferAutoTagSave：批量加载路径置 true，跳过逐卡立即写盘
    const deferredAutoTagSaves = [];
    const flushDeferredAutoTagSaves = async () => {
        if (deferredAutoTagSaves.length === 0) return;
        const pending = deferredAutoTagSaves.splice(0, deferredAutoTagSaves.length);
        console.log(`⏳ 后台落盘自动打标卡片: ${pending.length} 张（低并发，不阻塞界面）`);
        const CONCURRENCY = 2; // 低并发：避免与用户交互争抢磁盘 IO
        for (let i = 0; i < pending.length; i += CONCURRENCY) {
            const batch = pending.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (cardInfo) => {
                try {
                    const saveRes = await window.electronAPI.saveCard(cardInfo.path, JSON.parse(JSON.stringify(cardInfo.data)));
                    // 🔧 v1.8.5 配套：回写新 mtime，防下次刷新误判变化触发死循环重写
                    if (saveRes && saveRes.success && saveRes.mtime) cardInfo._mtime = saveRes.mtime;
                } catch (e) {
                    console.warn(`自动打标后台保存失败 [${cardInfo.name}]:`, e);
                }
            }));
            await new Promise(r => setTimeout(r, 0)); // 批间让出主线程一拍
        }
        console.log(`✅ 自动打标后台落盘完成`);
    };

    // 读取并解析单张卡片文件，成功则加入库中（供文件夹加载 / 磁盘扫描共用）
    const parseAndAddCard = async (file, opts = {}) => {
        try {
            // 去重拦截：同一路径的卡片已在库中则跳过（防止重复扫描/重复导入产生“影分身”）
            // 标记 _skippedExisting 供上层区分"已在库中"与"无法解析"，给出准确提示
            // 🚀 v1.8.5：批量加载（staging）时需同时查 staging 与 library ——
            //    加载窗口期手工导入与正在扫描的同路径卡若只查一边会双双入库（影分身）
            const dupIn = (arr) => arr.some(c => c.path === file.path);
            if (dupIn(opts.target || library.value) || (opts.target && dupIn(library.value))) {
                file._skippedExisting = true;
                return false;
            }

            let parsedData = null;

            if (file.name.toLowerCase().endsWith('.json')) {
                // 🛡️ 优先使用内存内容（文件菜单导入已用 File API 读取，绕过 IPC 白名单）
                let text = null;
                if (typeof file.rawText === 'string') {
                    text = file.rawText;
                } else if (window.electronAPI && typeof window.electronAPI.readText === 'function') {
                    const res = await window.electronAPI.readText(file.path);
                    if (res && res.success && typeof res.text === 'string') text = res.text;
                    else console.warn(`读取 JSON 失败（可能路径不在白名单）: ${file.name}`, res && res.error);
                }
                if (text === null) return false;
                const parsed = JSON.parse(text);
                // 内容校验：非角色卡的 JSON（如 config.json）直接跳过，不进入解析与入库
                if (!isCharacterCardData(parsed)) {
                    console.warn(`跳过非角色卡 JSON: ${file.name}`);
                    return false;
                }
                parsedData = parsed;
            } else if (file.embeddedData && typeof file.embeddedData === 'object') {
                // 🚀 性能优化：主进程扫描已本地提取内嵌 card JSON，直接复用，
                // 跳过整张 PNG 跨 IPC 读回（千卡库加载从几 GB 搬运降至几百 KB JSON）
                parsedData = file.embeddedData;
            } else {
                // 🛡️ 优先使用内存内容（文件菜单导入已用 File API 读取，绕过 IPC 白名单）
                let buffer = null;
                if (file.rawBuffer instanceof ArrayBuffer) {
                    buffer = file.rawBuffer;
                } else if (file.rawBuffer instanceof Uint8Array) {
                    buffer = file.rawBuffer.buffer;
                } else if (window.electronAPI && typeof window.electronAPI.readBuffer === 'function') {
                    const res = await window.electronAPI.readBuffer(file.path);
                    // readBuffer 返回 forbidden() 对象（{success:false}）时不能取 .buffer 解析
                    if (res && typeof res === 'object' && res.buffer) buffer = res.buffer;
                    else console.warn(`读取图片失败（可能路径不在白名单）: ${file.name}`, res && res.error);
                }
                if (!buffer) return false;
                // 复用解析函数（Buffer 经 IPC 传递后为 Uint8Array，取 .buffer 为 ArrayBuffer）
                parsedData = parsePNGChunk(buffer) || deepScanForJSON(buffer);
            }

            if (parsedData) {
                const normalized = normalizeCardData(parsedData);
                // 前端专用唯一随机 ID（时间戳 + 随机串），保证 Vue key / 多选 / 图谱标识永不冲突
                const cardId = 'card_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
                const cardInfo = {
                    id: cardId,
                    path: file.path, // 保留真实绝对路径，供保存/删除/导出等文件操作使用
                    fileName: file.name, // 📄 物理文件名（含扩展名，供 file: 语法搜索与显示）
                    name: normalized.data?.name || parsedData.name || '未命名',
                    creator: normalized.data?.creator || '未知',
                    avatar: file.url, // 通过 local-file:// 协议展示本地图片
                    data: normalized,
                    category: '未分类',
                    customTags: [],
                    // 【修复 BUG-1】"最新"排序基准：扫描路径带真实物理 mtime/birthtime；
                    // 内存导入路径（拖拽/文件菜单/全盘收编）无物理时间 → 以当前时间为准，
                    // 保证新导入的卡在"最新"排序中正确排到最前（否则回退 create_date 可能排到旧卡后面）
                    _mtime: file.mtime || Date.now(),
                    _ctime: file.birthtime || 0, // 物理文件创建时间（mtime 缺失时排序回退）
                    _size: file.size || 0, // 🦾 物理文件字节数（「大小正/倒序」排序数据源）
                    // 🦾 导入时间：首次遇到该文件路径时记录并持久化（重启后保持），
                    //    回退文件创建时间/当前时刻，保证「导入时间」排序永远有值且不随重启漂移
                    _importTime: (() => {
                        const impKey = String(file.path || '');
                        if (!impKey) return Number(file.birthtime) || 0;
                        let t = Number(cardImportTimes.value[impKey]) || 0;
                        if (!t) {
                            t = Number(file.birthtime) || Date.now();
                            cardImportTimes.value[impKey] = t; // 由 App.vue 集中 watch 自动落盘
                        }
                        return t;
                    })(),
                    subFolder: file.subFolder || '' // 相对库根的文件夹路径（'' = 根目录；物理分组用）
                };

                // 【唯一性洗礼】防御性兜底：确保 id 永不缺失、也永不与 name 相同
                // （正常路径已生成随机 id；此守卫防止未来重构/新导入路径引入 id 复用或丢失的回归）
                if (!cardInfo.id || cardInfo.id === cardInfo.name) {
                    cardInfo.id = cardInfo.path || `${cardInfo.name}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                }

                // 触发自动标签和分类（会优先应用导入的历史配置）
                const oldTagsLen = (cardInfo.customTags || []).length;
                const oldCategory = cardInfo.category;
                processAutoTagsAndCategory(cardInfo);
                // 🚀 v1.8.5 性能修复：批量加载路径推入 staging 暂存数组（加载完成后一次性
                //    赋给 library），避免每 push 一张就触发全库 computed（filteredLibrary/
                //    globalAllWorldbooks 等）失效风暴 —— 千卡库加载期 O(N²) 重算主因之一。
                (opts.target || library.value).push(cardInfo);

                // ✅ [补丁] 如果自动分类/打标签使数据发生了变更，必须覆盖物理文件！
                // （否则新卡导入的自动标签/分类只活在内存，重启后全部丢失）
                // 🚀 v1.8.5 性能修复：批量加载路径（deferAutoTagSave）不再逐卡立即写盘 ——
                //    旧版启动加载 = 千张卡 × (整 PNG 读回 + 重写 + 快照备份) 的 I/O 风暴，
                //    直接把启动拖到分钟级并伴随「未响应」。现在只收集，加载完成后由
                //    flushDeferredAutoTagSaves 低并发后台落盘，UI 秒开。
                // 🔧 v1.8.5 配套：保存成功后回写 _mtime（saveCard 返回新 mtime）——
                //    否则下次"刷新库"按 mtime 差分会把本卡误判为"已变化"重新解析，
                //    再次触发自动打标写盘 → mtime 又变 → 每次刷新全量重写的死循环
                if (oldCategory !== cardInfo.category || oldTagsLen !== (cardInfo.customTags || []).length) {
                    if (window.electronAPI && !/\.json$/i.test(cardInfo.path)) {
                        // 只写入原生 data 的 tags，保证卡片格式不被污染
                        const dataLayer = cardInfo.data?.data || cardInfo.data || {};
                        dataLayer.tags = Array.from(new Set([...(dataLayer.tags || []), ...(cardInfo.customTags || [])]));
                        if (opts.deferAutoTagSave) {
                            deferredAutoTagSaves.push(cardInfo);
                        } else {
                            try {
                                const saveRes = await window.electronAPI.saveCard(cardInfo.path, JSON.parse(JSON.stringify(cardInfo.data)));
                                if (saveRes && saveRes.success && saveRes.mtime) cardInfo._mtime = saveRes.mtime;
                            } catch (e) {
                                console.warn(`自动打标物理保存失败 [${cardInfo.name}]:`, e);
                            }
                        }
                    }
                }
                return true;
            }
        } catch (err) {
            console.warn(`跳过文件 ${file.name}`, err);
        }
        return false;
    };

    // 统一处理主进程传来的文件列表（并发受限批处理：每批最多 8 张并行解析，
    // 大幅加速启动加载，同时避免一次性并发读取几百张 PNG 导致磁盘 I/O 尖峰）
    // 🚀 v1.8.5 性能修复：
    //    ① 解析结果先推入 staging 暂存数组，全部完成后【一次性】赋给 library ——
    //       旧版逐张 library.value.push 会让依赖 library 的全库 computed
    //       （filteredLibrary / globalAllWorldbooks / globalAllRegexScripts）
    //       在加载期间反复失效+重算，千卡库 = 千次 O(N) 重算 ≈ O(N²) 开销，
    //       且每次重算都在主线程排序/拼接大字符串 → 输入卡顿、界面冻结；
    //    ② 自动打标产生的物理写盘延迟到加载完成后低并发后台执行（见
    //       flushDeferredAutoTagSaves），启动路径彻底告别「千卡读写 I/O 风暴」。
    const processElectronFiles = async (folderData) => {
        if (!folderData || !folderData.files) return;

        currentFolderPath.value = folderData.folderPath;
        // 🔧 v1.8.5 修复：记录切换前正在编辑卡片的路径 —— 旧版切库后编辑面板还开着
        //    旧 cardData（其 data 引用已不在新 library 中），Ctrl+S 查找失败只能靠
        //    导出 JSON 救回。加载完成后按路径重绑（同 refreshLibrary 的处理）。
        const prevCardPath = cardData.value
            ? (library.value.find(i => i.data === cardData.value)?.path || null)
            : null;
        // 🧹 释放旧卡片 blob URL（浏览器降级导入的卡片用 blob: 临时地址，重建库后无人引用 → 泄漏；local-file 永久路径无需 revoke）
        library.value.forEach(c => {
            if (c.avatar && typeof c.avatar === 'string' && c.avatar.startsWith('blob:')) {
                try { URL.revokeObjectURL(c.avatar); } catch (e) { /* 忽略 */ }
            }
        });
        library.value = [];

        // 📁 物理子文件夹 = 分组：自动并入自定义分组列表（去重），刷新后立即可见
        if (Array.isArray(folderData.categories)) {
            folderData.categories.forEach(cat => {
                if (cat && cat.trim() !== '' && !customCategories.value.includes(cat) && !isCategoryKnown(cat)) {
                    customCategories.value.push(cat);
                }
            });
        } // 清空当前库
        let addedCount = 0;

        const staging = []; // 🚀 暂存数组：加载完成前不触发任何全库 computed
        const CONCURRENCY = 8;
        const files = folderData.files;
        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            const results = await Promise.all(batch.map(file => parseAndAddCard(file, {
                target: staging,             // 推入暂存数组而非 library
                deferAutoTagSave: true       // 写盘延迟到加载完成后批量执行
            })));
            addedCount += results.filter(Boolean).length;
        }
        // 🚀 一次性并入（分块 push，同一同步批内 computed 只重算一次）。
        //    ⚠️ 不能写 `library.value = staging` 整体换引用：加载窗口（大库数秒~数十秒）
        //    期间拖拽导入 / 文件菜单导入 / URL 下载等不带 opts 的 parseAndAddCard
        //    会直接 push 进 library.value 当前数组 —— 整体换引用会把这些卡连同
        //    旧数组一起丢弃（提示导入成功但卡从界面消失，须手动刷新才找回）。
        //    分块 push 保留这些窗口期卡片，且不损失"一次性失效"的 computed 优化。
        for (let i = 0; i < staging.length; i += 500) {
            library.value.push(...staging.slice(i, i + 500));
        }
        console.log(`成功从 ${folderData.folderPath} 加载了 ${addedCount} 张卡片`);
        // 🔧 v1.8.5 修复：切库后重绑/关闭当前编辑卡片（防"孤儿编辑面板"保存失败）
        if (prevCardPath && cardData.value) {
            const reopen = library.value.find(i => i.path === prevCardPath);
            if (reopen) openFromLibrary(reopen);
            else reset(); // 旧卡不在新库：关闭编辑器，避免编辑已失效对象
        }
        // 🚀 自动打标落盘转后台低并发执行，不阻塞首屏呈现
        flushDeferredAutoTagSaves();
    };

    // 系统级拖拽导入：将拖入的文件复制到卡片库文件夹
    const handleDrop = async (e) => {
        e.preventDefault();
        isDragging.value = false;
        dragCounter.value = 0; // 重置计数器

        // 检查是否已设置固定的卡片库文件夹
        if (!currentFolderPath.value) {
            return nativeAlert('请先在顶部【选择固定文件夹读取】，设定你的卡片库目录，然后再拖入新卡片。', 'warning');
        }

        // 获取拖入文件的真实绝对路径
        // 注意：Electron 33 起 File.path 已移除，须经 webUtils.getPathForFile 获取（由 preload 暴露）
        const files = Array.from(e.dataTransfer.files);
        const filePaths = files
            .map(f => window.electronAPI ? window.electronAPI.getPathForFile(f) : f.path)
            .filter(p => p);

        if (filePaths.length > 0) {
            // 调用主进程，把拖入的文件复制到库文件夹
            const copiedFiles = await window.electronAPI.copyToLibrary(filePaths, currentFolderPath.value);

            if (copiedFiles.length > 0) {
                nativeAlert(`成功将 ${copiedFiles.length} 张新卡片导入到你的卡片库中！`, 'info');

                // 【性能修复】只解析并追加新拖入的文件（O(1) 增量），
                // 避免原实现调 processElectronFiles 清空全库后逐张重读重解析（千卡库拖 1 张也全量重载）
                for (const newFilePath of copiedFiles) {
                    const fName = newFilePath.split(/[\\/]/).pop();
                    const isImg = /\.(png|jpe?g|webp)$/i.test(fName);
                    await parseAndAddCard({
                        name: fName,
                        path: newFilePath,
                        url: isImg ? 'local-file://img/?path=' + encodeURIComponent(newFilePath) : null
                    });
                }
            } else {
                nativeAlert('导入失败：卡片格式不支持，或者库中已存在同名文件。', 'warning');
            }
        }
    };

    // 触发隐藏文件输入（HeaderBar 内 ref 绑定回写父级 importFileInput）
    const importCards = () => { if (importFileInput.value) importFileInput.value.click(); };

    // 🌐 从 URL 直链下载角色卡并导入（PNG/JSON 卡，支持 Discord/GitHub 等 CDN 直链）
    const downloadCardFromUrl = async () => {
        if (!currentFolderPath.value) {
            return nativeAlert('请先在顶部【选择固定文件夹读取】，设定你的卡片库目录，然后再从链接导入。', 'warning');
        }
        const url = await appPrompt('🌐 从链接下载导入角色卡\n请输入角色卡直链（支持 PNG / JSON 卡，Discord/GitHub 等 CDN 均可）：');
        if (!url || !url.trim()) return;
        // ⚠️ 进度提示必须用非阻塞的 showToast：nativeAlert 是模态框（等用户点确定才返回），
        // 会把窗口整个挡住，导致下载完成的"成功/失败"弹窗也无法显示（表现为"下载中"一直卡住）
        showToast('⏳ 正在从链接下载并导入角色卡，请稍候...', 'info', 6000);
        try {
            const res = await window.electronAPI.downloadCardFromUrl({ url: url.trim(), destFolder: currentFolderPath.value });
            if (res && res.success) {
                const isImg = /\.png$/i.test(res.fileName);
                const added = await parseAndAddCard({
                    name: res.fileName,
                    path: res.filePath,
                    url: isImg ? 'local-file://img/?path=' + encodeURIComponent(res.filePath) : null,
                    mtime: Date.now()
                });
                if (added) {
                    nativeAlert(`✅ 已从链接导入「${res.name}」到卡片库！`, 'success');
                } else {
                    nativeAlert('卡片已下载到库中，但未入库（可能已在库中）。', 'warning');
                }
            } else if (res && res.skipped) {
                nativeAlert(res.error, 'warning');
            } else {
                nativeAlert(res?.error || '下载导入失败，请检查链接是否有效。', 'error');
            }
        } catch (err) {
            console.error(err);
            nativeAlert('下载导入失败: ' + (err.message || err), 'error');
        }
    };

    // =========================================================
    // 🗑️ 删除域（安全回收站）
    // =========================================================

    // 右键菜单：删除指定卡片（移入回收站，独立于当前打开的卡片）
    const deleteCardItem = async (item) => {
        if (!item) return;
        const { response } = await window.electronAPI.showMessage({
            type: 'warning', title: '安全删除提示',
            message: `确定要将卡片 [${item.name}] 移入回收站吗？\n(文件将被放入目录下的 .trash 文件夹中，支持手动找回)`,
            buttons: ['移入回收站', '取消'], cancelId: 1
        });
        if (response === 0) {
            const res = await window.electronAPI.deleteFile(item.path);
            if (res.success) {
                library.value = library.value.filter(i => i.id !== item.id);
                // 如果删除的正是当前打开的卡片，关闭编辑面板
                if (cardData.value && item.data === cardData.value) reset();
                await cleanupEmptyCategories(); // 🧹 自动清理空分组
                nativeAlert("卡片已安全移入本地回收站。", "info");
            } else {
                nativeAlert("操作失败: " + res.error, "error");
            }
        }
    };

    // 删除卡片（安全机制：移入本地回收站 .trash，可手动找回）
    const deleteCard = async () => {
        if (!cardData.value) return;
        const libItem = library.value.find(item => item.data === cardData.value);
        if (!libItem) return;

        const { response } = await window.electronAPI.showMessage({
            type: 'warning', title: '安全删除提示',
            message: `确定要将卡片 [${safeData.value.name}] 移入回收站吗？\n(文件将被放入目录下的 .trash 文件夹中，支持手动找回)`,
            buttons: ['移入回收站', '取消'], cancelId: 1
        });

        if (response === 0) {
            const res = await window.electronAPI.deleteFile(libItem.path);
            if (res.success) {
                library.value = library.value.filter(item => item.id !== libItem.id);
                deleteCardOverlays([libItem.path]); // 🔧 同步清理覆盖层，防配置膨胀
                reset();
                nativeAlert("卡片已安全移入本地回收站。", "info");
            } else {
                nativeAlert("操作失败: " + res.error, "error");
            }
        }
    };

    // =========================================================
    // 📤 杂项：导出 / 重命名
    // =========================================================

    // 右键菜单：导出单张卡片（复制到用户选择的目录）
    const exportCard = async (item) => {
        if (!item) return;
        try {
            const res = await window.electronAPI.exportBatchPackage([item.path]);
            if (res.success) {
                nativeAlert(`单卡导出成功！\n已导出至:\n${res.exportDir}`, 'info');
            } else if (res.error !== "用户取消操作") {
                nativeAlert(`导出失败: ${res.error}`, 'error');
            }
        } catch (e) {
            nativeAlert(`发生错误: ${e.message}`, 'error');
        }
    };

    // 重命名卡片
    const renameCard = async () => {
        if (!cardData.value) return;
        const currentName = safeData.value.name || '未命名';
        const newName = await appPrompt('请输入新的角色名称：', currentName);

        if (newName && newName.trim() !== '' && newName !== currentName) {
            const trimmedName = newName.trim();

            // 更新当前打开卡片的数据
            if (cardData.value.data) {
                cardData.value.data.name = trimmedName;
            } else {
                cardData.value.name = trimmedName;
            }

            // 如果该卡片存在于库中，同步更新库中的名称
            const libItem = library.value.find(item => item.data === cardData.value);
            if (libItem) {
                libItem.name = trimmedName;
            }

            nativeAlert(`已成功重命名为: ${trimmedName}\n(提示: 点击顶部"导出 JSON"可将改名后的文件保存到本地)`, 'info');
        }
    };

    return {
        // 持久化域
        persistCardCategory, persistCardUpdate, deleteCardOverlays,
        // 自动分类与打标
        processAutoTagsAndCategory, flushDeferredAutoTagSaves,
        // 导入入库域
        parseAndAddCard, processElectronFiles, handleDrop, importCards, downloadCardFromUrl,
        // 删除域
        deleteCardItem, deleteCard,
        // 杂项
        exportCard, renameCard
    };
}
