import { ref, computed, watch } from 'vue';
import { extractBookEntries } from '../utils/cardLoader.js';
import searchIndex from '../utils/searchIndex.js';
import tokenCache from '../utils/tokenCache.js';

/**
 * 超级搜索引擎组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：搜索输入防抖、全字段穿透检索/高级语法过滤/排序（filteredLibrary）、
 * 分页计算（totalPages/paginatedLibrary）与换页逻辑（changePage）。
 * 共享响应式状态（library / currentCategoryKey / allCategories / sortBy / currentPage / itemsPerPage / lastSelectedIndex）
 * 与工具 estimateCardTokens 保留在 App.vue 顶层并注入，其余状态与计算方法在此定义。
 */

/**
 * 安全提取卡片对象内所有递归可检索字符串（防 null/undefined 报错，兼容 V1/V2/V3/SillyTavern 扩展）
 * 覆盖：物理文件名/路径/分组、角色名/作者/描述/性格/场景/首条开场白/对话示例/作者备注、
 * 备选开场白列表、深度提示词/系统提示词、正则脚本、内嵌世界书全部词条（名称/注释/触发词/正文）
 */
export function extractCardSearchableText(item) {
    const data = (item && item.data && item.data.data) || (item && item.data) || {};
    const textSegments = [];
    const push = (v) => { if (v !== undefined && v !== null && v !== '') textSegments.push(String(v)); };

    // 1. 基础物理与系统信息
    if (item && item.fileName) push(item.fileName); // 物理文件名（含扩展名）
    if (item && item.path) push(item.path); // 绝对路径
    if (item && item.subFolder) push(item.subFolder); // 物理分组
    if (item && item.category) push(item.category);
    if (item && item.name) push(item.name);
    if (item && item.creator) push(item.creator);

    // 2. 核心人设文本
    push(data.name);
    push(data.creator || data.author);
    push(data.description);
    push(data.personality);
    push(data.scenario);
    push(data.first_mes);
    push(data.mes_example);
    push(data.creator_notes);

    // 3. 备选开场白 (Alternate Greetings)
    if (Array.isArray(data.alternate_greetings)) {
        push(data.alternate_greetings.map(g => String(g)).join(' '));
    }

    // 4. 扩展配置 (Extensions: depth_prompt / system_prompt / regex_scripts)
    const ext = data.extensions;
    if (ext && typeof ext === 'object') {
        if (ext.depth_prompt && ext.depth_prompt.prompt) push(ext.depth_prompt.prompt);
        if (ext.system_prompt !== undefined && ext.system_prompt !== null) {
            push(typeof ext.system_prompt === 'string' ? ext.system_prompt : JSON.stringify(ext.system_prompt));
        }
        if (Array.isArray(ext.regex_scripts)) {
            ext.regex_scripts.forEach(script => {
                if (!script || typeof script !== 'object') return;
                if (script.scriptName) push(script.scriptName);
                if (script.findRegex) push(script.findRegex);
                if (script.replaceString) push(script.replaceString);
            });
        }
    }

    // 5. 关联世界书 (Character Book / Lorebook)
    // 🛡️ extractBookEntries 全形态安全提取（entries 数组/字典/数组 book）：
    //    修复字典形态世界书内容无法被搜索 + 数组形态 book 的 .entries 原型方法陷阱
    const book = data.character_book || (item && item.data && item.data.character_book) || (item && item.character_book);
    if (book) {
        extractBookEntries(book).forEach(entry => {
            if (entry.comment || entry.name) push(entry.comment || entry.name);
            if (entry.content) push(entry.content);
            if (Array.isArray(entry.keys)) push(entry.keys.map(k => String(k)).join(' '));
            if (Array.isArray(entry.secondary_keys)) push(entry.secondary_keys.map(k => String(k)).join(' '));
        });
    }

    // 拼合成单一的全量小写字符串流
    return textSegments.join(' ').toLowerCase();
}

/**
 * 提取卡片的所有标签数组（兼容数组/逗号分隔字符串/customTags/原生 tags）
 * @param {object} item 卡片对象
 * @param {{ ignoreNative?: boolean }} [opts] 选项：ignoreNative=true 时忽略卡片自带的原生 data.tags
 *   （配合「导入时忽略卡片自带标签」开关，防止被忽略的杂乱标签仍参与标签搜索）
 */
export function extractCardTags(item, opts = {}) {
    const { ignoreNative = false } = opts;
    const data = (item && item.data && item.data.data) || (item && item.data) || {};
    const tags = new Set();
    const collect = (t) => {
        if (Array.isArray(t)) {
            t.forEach(x => { if (x !== undefined && x !== null && x !== '') tags.add(String(x).toLowerCase()); });
        } else if (typeof t === 'string' && t.trim() !== '') {
            t.split(',').map(x => x.trim()).filter(Boolean).forEach(x => tags.add(x.toLowerCase()));
        }
    };
    if (item) {
        collect(item.tags);
        collect(item.customTags);
    }
    if (!ignoreNative) collect(data.tags);
    return Array.from(tags);
}

export function useSearch({
    library,
    currentCategoryKey,
    allCategories,
    sortBy,
    currentPage,
    itemsPerPage,
    lastSelectedIndex,
    estimateCardTokens,
    sanitizeImportedTags   // 导入时忽略卡片自带标签开关（开启时标签搜索不再匹配原生 data.tags）
}) {
    // ================= [ 性能优化：搜索防抖 ] =================
    const searchQueryInput = ref(''); // 绑定给搜索框的输入值（实时更新）
    const searchQuery = ref('');      // 用于实际过滤的内部值（300ms 防抖延迟更新）
    let searchTimeout = null;

    // 监听输入，300ms 后才更新实际的过滤词
    watch(searchQueryInput, (newVal) => {
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchQuery.value = newVal;
        }, 300);
    });

    // ================= 🚀 超级搜索引擎：全字段穿透 + 高级语法检索 + 全规范兼容 =================
    // 支持：多词 AND（傲娇 女仆）/ -排除词 / tag:/t: / author:/a: / file:/f: / wb:/w:
    const filteredLibrary = computed(() => {
        // —— 分类/快捷筛选（含特殊快捷过滤：带世界书 / 带正则脚本）——
        const passCategory = (card) => {
            if (currentCategoryKey.value === 'all') return true;
            if (currentCategoryKey.value === 'has_lorebook') {
                // 📖 带世界书：卡片内嵌世界书且有条目
                // 🛡️ extractBookEntries 全形态安全判定（字典形态 entries / 数组形态 book 均正确识别）
                const d = card.data?.data || card.data || {};
                const book = d.character_book || card.data?.character_book || {};
                return extractBookEntries(book).length > 0;
            }
            if (currentCategoryKey.value === 'has_regex') {
                // ⚡ 带正则脚本：卡片内嵌正则脚本
                const d = card.data?.data || card.data || {};
                const regex = d.extensions?.regex_scripts || d.regex_scripts || [];
                return (regex || []).length > 0;
            }
            const targetCat = allCategories.value.find(c => c.key === currentCategoryKey.value);
            if (!targetCat) return true;
            // 【加固】分组匹配兼容多种存储形态：预设 cn/en/key + 物理文件夹一级名（subFolder）
            const subName = card.subFolder ? card.subFolder.split(/[\\/]/)[0] : '';
            return card.category === targetCat.cn || card.category === targetCat.en || card.category === targetCat.key
                || (!!subName && (subName === targetCat.cn || subName === targetCat.en || subName === targetCat.key));
        };

        // —— 排序键提取（time 模式）——
        // 🦾 v1.9.x「本地文件最新」= 角色卡文件首次出现在电脑上的时间（birthtime）与
        //    修改时间（mtime）取较新者综合——最近放进电脑或最近被修改的文件排前，
        //    与 Windows 资源管理器「最近变动」直觉一致；纯文件级。
        const pickTimeLocal = (card) => Math.max(Number(card._mtime) || 0, Number(card._ctime) || 0);
        // 🦾 独立日期维度（用户需求：按创建时间 / 按修改时间 / 按导入时间 分别排序）
        //   创建时间 = 物理文件 birthtime（_ctime，文件系统真实创建时刻），缺失按 0 排最后
        const pickCtime = (card) => Number(card._ctime) || 0;
        //   修改时间 = 物理文件 mtime（_mtime，文件最后修改时刻），缺失按 0 排最后
        const pickMtime = (card) => Number(card._mtime) || 0;
        // 🦾 导入时间 = 卡片首次进入本库的时刻（parseAndAddCard 首次遇到该路径时记录并持久化），
        //   缺失回退文件创建时间，再回退当前时刻（内存导入场景）
        const pickImportTime = (card) => Number(card._importTime) || Number(card._ctime) || 0;
        // 🦾 文件大小 = 物理文件字节数（_size，主进程扫描时采集），缺失按 0 排最后
        const pickSize = (card) => Number(card._size) || 0;

        // —— 列表排序（在过滤结果上排序；filter() 返回新数组，原地 sort 安全）——
        // 🚀 v1.8.5 性能修复：tokens 排序改为预计算（Schwartzian transform）。
        //    旧版比较器内嵌 estimateCardTokens(b) - estimateCardTokens(a)：千卡库一次
        //    排序调用估算 ~2·N·logN 次（每卡全字段拼接 + 正则 + 世界书全条目遍历），
        //    每次输入/切分组都重跑 → 秒级冻结。现改为每卡只算一次（叠加 App.vue 的
        //    WeakMap 缓存，未变更卡直接命中缓存），成本从 O(N log N) 降为 O(N)。
        // 🛡️ 卡片级 try/catch 兜底保留：脏卡估算失败按 0 计，排序永不抛错（防白屏）。
        // 🔧 v1.8.6 稳定性修复：所有排序都带「稳定次级键」（名称/路径），
        //    消除同名/同时刻/同 Token 卡片顺序依赖扫描顺序（readdir 不保证稳定）的问题——
        //    否则每次启动/刷新后这类卡片的相对顺序可能变化，观感为「排序被打乱」。
        // 🦾 v1.9.x 排序增强（加固）：统一比较器三件套——
        //    ① Intl.Collator('zh-Hans-CN', { numeric:true })：中文按拼音、数字段按数值
        //       自然排序（"V2.5" < "V10"、"第2章" < "第10章"，不再出现 V10 排到 V2 前）；
        //    ② 名称 trim 归一（去前导/尾随空格，避免空格差异导致位置漂移）；
        //    ③ 终极稳定键链「路径 → 文件名 → id」兜底：任何情况（readdir 乱序、重扫描、
        //       同名同路径）下相对顺序都完全确定，绝不「肆意乱窜」。
        const collator = (() => {
            try { return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'variant' }); }
            catch (e) { return new Intl.Collator('zh-Hans-CN', { numeric: true }); }
        })();
        const nameKey = (card) => String(card?.name ?? '').trim();
        const pathKey = (card) => String(card?.path ?? '');
        const fileKey = (card) => String(card?.fileName ?? '');
        const idKey = (card) => String(card?.id ?? '');
        // 文本比较：拼音 + 数字自然排序；异常环境回退普通 localeCompare / 逐字符比较
        const cmpText = (a, b) => {
            try { const r = collator.compare(a, b); if (r) return r; } catch (e) { /* fallthrough */ }
            try { return a.localeCompare(b, 'zh-Hans-CN'); } catch (e) { /* fallthrough */ }
            return a < b ? -1 : a > b ? 1 : 0;
        };
        // 终极稳定键链：路径 → 文件名 → id，保证顺序完全确定（不依赖 readdir 顺序）
        const stableChain = (a, b) =>
            cmpText(pathKey(a), pathKey(b))
            || cmpText(fileKey(a), fileKey(b))
            || cmpText(idKey(a), idKey(b));
        const sortList = (arr) => {
            if (sortBy.value === 'name') {
                // 🔤 A-Z 正序：主键 = 物理文件名（与资源管理器一致，天然唯一），次级 = 显示名，三级 = 稳定链
                return arr.sort((a, b) => {
                    try {
                        return cmpText(fileKey(a), fileKey(b))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'nameDesc') {
                // 🔤 A-Z 倒序：正序比较结果整体取负（连稳定链一起翻转，顺序完全确定）
                return arr.sort((a, b) => {
                    try {
                        const r = cmpText(fileKey(a), fileKey(b))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                        return -r;
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'time') {
                // � 本地文件最新：纯本地文件时间（创建→修改）降序
                return arr.sort((a, b) => {
                    try {
                        return (pickTimeLocal(b) - pickTimeLocal(a))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'mtime') {
                // ✏️ 修改时间：文件最后修改时刻（新→旧）；并列时次级用创建时间（与创建时间排序互异）
                return arr.sort((a, b) => {
                    try {
                        return (pickMtime(b) - pickMtime(a))
                            || (pickCtime(b) - pickCtime(a))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'ctime') {
                // 📅 创建时间：文件系统真实创建时刻（新→旧）；并列时次级用修改时间（与修改时间排序互异）
                return arr.sort((a, b) => {
                    try {
                        return (pickCtime(b) - pickCtime(a))
                            || (pickMtime(b) - pickMtime(a))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'importTime') {
                // 📥 导入最新：卡片首次进入本库的时刻（新→旧）
                return arr.sort((a, b) => {
                    try {
                        return (pickImportTime(b) - pickImportTime(a))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'sizeDesc') {
                // 📦 大小倒序：文件字节数大→小
                return arr.sort((a, b) => {
                    try {
                        return (pickSize(b) - pickSize(a))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'sizeAsc') {
                // 📦 大小正序：文件字节数小→大
                return arr.sort((a, b) => {
                    try {
                        return (pickSize(a) - pickSize(b))
                            || cmpText(nameKey(a), nameKey(b))
                            || stableChain(a, b);
                    } catch (e) { return 0; }
                });
            }
            if (sortBy.value === 'tokens') {
                // ⚡ Token 排序：估算 Token 多→少（Schwartzian transform 每卡只算一次 + tokenCache 缓存，千卡库不卡顿）
                return arr
                    .map(card => {
                        try { return [card, tokenCache.get(card)]; }
                        catch (e) { console.warn('⚠️ Token 估算异常按 0 计:', card?.fileName || card?.name, e); return [card, 0]; }
                    })
                    .sort((x, y) => (y[1] - x[1]) // Token 多优先
                        || cmpText(nameKey(x[0]), nameKey(y[0])) // 次级：名称
                        || stableChain(x[0], y[0])) // 三级：稳定唯一链
                    .map(pair => pair[0]);
            }
            // 🛡️ 升级/配置加固：未知或非法的排序值（旧版本残留、配置损坏、白名单未覆盖的新值）
            //    一律回退「文件级 A-Z 排序」，绝不返回未排序原数组——否则列表退化为 readdir 磁盘顺序，
            //    每次扫描/重启顺序可能变化，观感为「更新升级后排序乱飘」。
            return arr.sort((a, b) => {
                try {
                    return cmpText(fileKey(a), fileKey(b))
                        || cmpText(nameKey(a), nameKey(b))
                        || stableChain(a, b);
                } catch (e) { return 0; }
            });
        };

        // 无关键词：仅按当前分类过滤 + 排序（浏览模式）
        // 🛡️ 卡片级 try/catch 兜底：与下方搜索分支防御对齐。历史教训（bdced8a + 本次
        //    character_book .entries 陷阱）：浏览模式一旦有脏卡让 passCategory/sortCards 抛错，
        //    computed 崩溃 → 侧边栏（角色栏）整体消失/白屏，且该卡在库内每次重启复发。
        const query = (searchQuery.value || '').toLowerCase().trim();
        if (!query) {
            return sortList(library.value
                .filter(card => {
                    try { return passCategory(card); }
                    catch (e) { console.warn('⚠️ 分组筛选异常跳过卡片:', card?.fileName || card?.name, e); return false; }
                }));
        }

        // —— 解析搜索表达式（拆分为多个 token，识别高级语法）——
        const rules = { mustInclude: [], mustExclude: [], tagOnly: [], authorOnly: [], fileOnly: [], wbOnly: [] };
        query.split(/\s+/).forEach(token => {
            if (token.startsWith('-') && token.length > 1) rules.mustExclude.push(token.slice(1));
            else if (token.startsWith('tag:') || token.startsWith('t:')) rules.tagOnly.push(token.replace(/^(tag:|t:)/, ''));
            else if (token.startsWith('author:') || token.startsWith('a:')) rules.authorOnly.push(token.replace(/^(author:|a:)/, ''));
            else if (token.startsWith('file:') || token.startsWith('f:')) rules.fileOnly.push(token.replace(/^(file:|f:)/, ''));
            else if (token.startsWith('wb:') || token.startsWith('w:')) rules.wbOnly.push(token.replace(/^(wb:|w:)/, ''));
            else rules.mustInclude.push(token);
        });

        // 🚀 性能优化：使用搜索索引快速获取候选集（O(log N) 而非 O(N·M)）
        // 索引查询词 = mustInclude（普通关键词）+ tagOnly（标签关键词）
        const indexQuery = [...rules.mustInclude, ...rules.tagOnly].join(' ');
        let candidates = library.value;
        
        if (indexQuery && searchIndex.cardCount > 0) {
            // 使用索引查询，传入排除词和标签
            candidates = searchIndex.search(indexQuery, {
                tags: rules.tagOnly,
                excludeKeywords: rules.mustExclude
            }) || [];
        }

        const filtered = candidates.filter(card => {
            try {
                // 1. 分类过滤（搜索也遵守当前分组/快捷筛选；选"全部"= 全局检索）
                if (!passCategory(card)) return false;

                const data = card.data?.data || card.data || {};

                // 2. 排除词校验（- 语法）—— 索引已处理，但需二次校验确保准确
                if (rules.mustExclude.length > 0 && searchIndex.cardCount === 0) {
                    const fullText = extractCardSearchableText(card);
                    if (rules.mustExclude.some(ex => fullText.includes(ex))) return false;
                }

                // 3. 标签特定筛选（tag:/t: 语法）—— 索引已处理
                // 🧹 兼容「导入时忽略卡片自带标签」开关：开启时原生 data.tags 不参与标签搜索
                if (rules.tagOnly.length > 0 && searchIndex.cardCount === 0) {
                    const cardTags = extractCardTags(card, { ignoreNative: sanitizeImportedTags?.value });
                    if (!rules.tagOnly.every(target => cardTags.some(t => t.includes(target)))) return false;
                }

                // 4. 作者特定筛选（author:/a: 语法）
                if (rules.authorOnly.length > 0) {
                    const author = String(data.creator || data.author || card.creator || '').toLowerCase();
                    if (!rules.authorOnly.every(a => author.includes(a))) return false;
                }

                // 5. 物理文件名/路径筛选（file:/f: 语法）
                if (rules.fileOnly.length > 0) {
                    const fileName = card.fileName || String(card.path || '').split(/[\\/]/).pop() || '';
                    const filePath = `${fileName} ${card.subFolder || ''} ${card.path || ''}`.toLowerCase();
                    if (!rules.fileOnly.every(f => filePath.includes(f))) return false;
                }

                // 6. 世界书专用筛选（wb:/w: 语法）
                // 🛡️ extractBookEntries 全形态安全提取：旧写法在数组形态 book 时拿到
                //    Array.prototype.entries 原型函数，JSON.stringify(函数)=undefined
                //    → 链式 .toLowerCase() 直接 TypeError（搜索即崩）
                if (rules.wbOnly.length > 0) {
                    const book = data.character_book || card.data?.character_book || card.character_book;
                    const wbText = JSON.stringify(extractBookEntries(book)).toLowerCase();
                    if (!rules.wbOnly.every(w => wbText.includes(w))) return false;
                }

                // 7. 全文本多词必含校验（AND 逻辑）—— 索引已处理
                if (rules.mustInclude.length > 0 && searchIndex.cardCount === 0) {
                    const fullText = extractCardSearchableText(card);
                    if (!rules.mustInclude.every(kw => fullText.includes(kw))) return false;
                }

                return true;
            } catch (e) {
                // 🛡️ 异常卡片自动跳过，保证列表稳定渲染不白屏
                console.warn('⚠️ 检索卡片异常跳过:', card.fileName || card.name, e);
                return false;
            }
        });
        return sortList(filtered);
    });

    // 2. 计算总页数
    const totalPages = computed(() => {
        return Math.ceil(filteredLibrary.value.length / itemsPerPage.value) || 1;
    });

    // 3. 当前页展示的数据
    const paginatedLibrary = computed(() => {
        const start = (currentPage.value - 1) * itemsPerPage.value;
        const end = start + itemsPerPage.value;
        return filteredLibrary.value.slice(start, end);
    });

    // 过滤条件（搜索/分组）变化时重置回第一页，避免停留在超出范围的页面上
    watch([searchQuery, currentCategoryKey], () => {
        currentPage.value = 1;
    });

    // 换页逻辑
    const changePage = (page) => {
        if (page >= 1 && page <= totalPages.value) {
            currentPage.value = page;
            // ✅ [补丁] 翻页时清理上一次点击索引，防止跨页 Shift 连选基于页内索引超界误选当页卡片
            lastSelectedIndex.value = -1;
        }
    };

    return {
        searchQueryInput, searchQuery,
        filteredLibrary, totalPages, paginatedLibrary,
        changePage
    };
}