/**
 * 全库词条搜索与反向引用组合式函数（Composable）
 * 把「独立世界书 worldbooks」与「角色卡内嵌世界书 library.character_book」两类词条归一化后
 * 建成统一索引，支持跨库按触发词/正文/备注/来源名检索并定位来源（跳转）。
 * 共享状态（worldbooks / library / appMode / activeWorldbook / openFromLibrary）保留在 App.vue 并注入。
 */
import { ref, computed } from 'vue';
import { extractBookEntries } from '../utils/cardLoader.js';
// 🛡️ PK-31（2026-09-25）：大库的卡片是**瘦身态**（内嵌世界书词条正文被清空省内存）——
//    不读回就建索引 ⇒ **卡片词条正文永远搜不到**（世界书侧过去调了 `ensureWorldbookLoaded`，
//    卡片侧没调 —— 同一函数内不对称）。本处走 `cardSlim` 的**模块级注册表**（无需注入）。
import { ensureFullBody } from '../utils/cardSlim.js';

// 把触发词字段归一化为字符串数组（兼容数组 / 逗号分隔字符串 / 空）
function toArray(v) {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if (v === undefined || v === null) return [];
    return String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

// 把一条词条归一化为统一结构（独立世界书用 key/keysecondary；角色卡内嵌世界书用 keys/secondary_keys）
function normalizeEntry(entry, sourceType, sourceName, sourcePath) {
    if (!entry || typeof entry !== 'object') return null;
    const isWb = sourceType === 'worldbook';
    const keys = toArray(isWb ? entry.key : entry.keys);
    const secondary = toArray(isWb ? entry.keysecondary : entry.secondary_keys);
    return {
        keys,
        secondary,
        content: String(entry.content || ''),
        comment: entry.comment || entry.name || '',
        enabled: entry.enabled !== false,
        constant: !!entry.constant,
        selective: !!entry.selective,
        insertion_order: entry.insertion_order ?? 50,
        order: entry.order ?? 100,
        sourceType, sourceName, sourcePath
    };
}

export function useGlobalEntrySearch({ worldbooks, library, appMode, activeWorldbook, openFromLibrary, ensureWorldbookLoaded, selectWorldbook, wbDisplayName }) {
    // 全库词条索引（惰性计算，仅在打开弹窗/搜索时触发）
    // ⚡ PK-26：世界书正文可能未载入（秒开后 `data` 为 null）→ 必须**按需载入**才能索引到词条。
    //    故改为 async 的 ref（由 `refreshGlobalEntryIndex()` 显式触发，避免 computed 里做副作用）。
    const globalEntryIndex = ref([]);
    const globalEntryIndexing = ref(false);
    const refreshGlobalEntryIndex = async () => {
        if (globalEntryIndexing.value) return;
        globalEntryIndexing.value = true;
        try {
            const list = [];
            // 独立世界书
            for (const wb of (worldbooks.value || [])) {
                const name = (typeof wbDisplayName === 'function' ? wbDisplayName(wb) : null)
                    || (wb.data && wb.data.name) || wb.name || '未命名世界书';
                if (wb.dataLoaded === false && wb.path && typeof ensureWorldbookLoaded === 'function') {
                    // silent：批量场景避免逐本弹框；失败原因已由日志/`_loadError` 汇总
                    await ensureWorldbookLoaded(wb, { silent: true });
                }
                const entries = (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries : [];
                entries.forEach(e => {
                    const n = normalizeEntry(e, 'worldbook', name, wb.path || '');
                    if (n) list.push(n);
                });
            }
            // 角色卡内嵌世界书（🛡️ extractBookEntries 兼容 entries 数组/字典/数组 book 全形态，
            //    旧版漏索引字典形态 entries 的卡片，其内嵌词条在全库搜索中永远搜不到）
            //
            // 🛡️ PK-31（2026-09-25）：**先读回正文再索引**。
            //    🐞 旧实现直接读 live `character_book` —— 大库（≥3000 张自动瘦身）里
            //       `entries[].content` 已被清空，于是「按正文搜卡片词条」**恒定搜不到**
            //       （只能命中触发词/备注）；而同一函数内世界书侧却调了 `ensureWorldbookLoaded`。
            //    ✅ 现在走统一入口（缺加载器会告警）；读回的正文在面板关闭时由 App.vue 回收。
            try {
                const r = await ensureFullBody(library.value, { silent: true });
                if (r.total > 0) {
                    console.log(`[entry-search] 已读回 ${r.restored}/${r.total} 张瘦身卡的正文用于词条索引`
                        + (r.unavailable ? '（⚠️ 加载器未注册，卡片词条正文未参与索引）' : ''));
                }
            } catch (e) {
                console.warn('[entry-search] 读回卡片正文失败，卡片词条正文可能未参与索引:', e && e.message);
            }
            (library.value || []).forEach(item => {
                const d = (item.data && item.data.data) || item.data || {};
                const book = d.character_book || (item.data && item.data.character_book) || {};
                const entries = extractBookEntries(book);
                const name = d.name || item.name || '未知角色';
                entries.forEach(e => {
                    const n = normalizeEntry(e, 'card', name, item.path || '');
                    if (n) list.push(n);
                });
            });
            globalEntryIndex.value = list;
        } finally {
            globalEntryIndexing.value = false;
        }
    };

    const globalEntrySearchQuery = ref('');
    const globalEntrySearchResults = computed(() => {
        const q = globalEntrySearchQuery.value.trim().toLowerCase();
        if (!q) return [];
        return globalEntryIndex.value.filter(en => {
            const hay = [en.keys.join(' '), en.secondary.join(' '), en.content, en.comment, en.sourceName].join(' ').toLowerCase();
            return hay.includes(q);
        });
    });

    const showGlobalEntrySearchModal = ref(false);
    const openGlobalEntrySearch = () => {
        globalEntrySearchQuery.value = '';
        showGlobalEntrySearchModal.value = true;
        // ⚡ PK-26：打开时异步建索引（含按需载入世界书正文）
        refreshGlobalEntryIndex();
    };
    const closeGlobalEntrySearch = () => { showGlobalEntrySearchModal.value = false; };

    // 点击结果项跳转到来源（世界书 / 角色卡）
    const jumpToEntrySource = (result) => {
        if (!result) return;
        if (result.sourceType === 'worldbook') {
            const wb = worldbooks.value.find(w =>
                (result.sourcePath && w.path === result.sourcePath) ||
                (!result.sourcePath && ((w.data && w.data.name) || w.name) === result.sourceName)
            );
            // ⚡ PK-26：走 selectWorldbook（先载入正文），否则编辑器拿到 data:null 会崩
            if (wb) {
                if (typeof selectWorldbook === 'function') selectWorldbook(wb);
                else activeWorldbook.value = wb;
            }
            appMode.value = 'worldbooks';
        } else {
            const item = library.value.find(i =>
                (result.sourcePath && i.path === result.sourcePath) ||
                (!result.sourcePath && (((i.data && i.data.data) || i.data || {}).name || i.name) === result.sourceName)
            );
            if (item) openFromLibrary(item);
            appMode.value = 'characters';
        }
        showGlobalEntrySearchModal.value = false;
    };

    return {
        globalEntryIndex, globalEntryIndexing, refreshGlobalEntryIndex, globalEntrySearchQuery, globalEntrySearchResults,
        showGlobalEntrySearchModal, openGlobalEntrySearch, closeGlobalEntrySearch, jumpToEntrySource
    };
}
