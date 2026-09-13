/**
 * 角色卡内嵌世界书编辑（Composable）
 * 从 App.vue 拆分而来，收敛：内嵌世界书（cardData.character_book）条目列表派生（V1/V2 兼容）、
 * 条目稳定标识（WeakMap uid，防 v-for 节点错位）、折叠展开状态、触发词编辑工具。
 * ⚠️ 与 useWorldbookEntries 是不同数据域：本组合式函数处理「角色卡内嵌世界书」，
 *    useWorldbookEntries 处理「独立世界书库（activeWorldbook）」的 Entry IDE。
 *
 * ⚠️ 调用时序约束（TDZ）：
 *   - 必须晚于 cardTokensCache（App.vue 的 Token 统计 WeakMap）的定义（updateEntryKeys 运行时引用）；
 *   - 必须早于 useGraph（注入 worldbookExpanded）等消费方；
 *   - App.vue 内引用方（tabs badge / openFromLibrary 重置 / filteredCharacterWorldbookEntries /
 *     jumpToEntrySource 滚动锚点 / ctx 注入）均经解构同名 const 绑定，运行时执行，闭包安全。
 */
import { ref, computed, reactive, triggerRef } from 'vue';
import { extractBookEntries } from '../utils/cardLoader.js';

export function useEmbeddedWorldbook({ cardData, safeData, cardTokensCache }) {
    // 世界书条目稳定标识：为每个条目对象分配唯一 uid（v-for :key 使用，避免增删时节点错位）
    // 【修复】改用 WeakMap：键为对象引用，条目对象被 GC 时映射自动释放，防止频繁切卡导致内存泄漏
    const entryUidMap = new WeakMap();
    let entryUidCounter = 0;
    const getEntryUid = (entry) => {
        if (!entry || typeof entry !== 'object') return 'entry-' + (++entryUidCounter);
        if (!entryUidMap.has(entry)) entryUidMap.set(entry, 'entry-' + (++entryUidCounter));
        return entryUidMap.get(entry);
    };

    // 世界书条目（兼容 V1/V2 层级与 comment 字段）
    const worldbookEntries = computed(() => {
        // 🔔🔔 必须**显式读取** cardData（就是下面这行 `const cd = cardData.value`）——
        //    不能依赖下一个“短路回退”：`safeData.value.character_book || cardData.value?.character_book`
        //    在 character_book 存在时**不会求值右半**，于是本 computed **完全不依赖 cardData**。
        //    而增/删/克隆/移动词条后走的是 refreshCardData() → triggerRef(cardData)，
        //    且 safeData 重算后返回**同一个对象**（Vue 3.4+ computed 值未变不再向下传播）
        //    → 本 computed 永远不会被标脏，增删结果不刷新，
        //    必须切卡（换掉 cardData 对象）才更新。
        //    用户实测现象（2026-09-14）：删除词条后列表无变化，“切换别的卡再切回去”才出现。
        //    ⚠️ 后果不止列表：状态栏模板预览的数据源也会跟着变陈旧（它读本 computed）。
        const cd = cardData ? cardData.value : null;
        // 兼容 V1 和 V2 的存放位置
        const book = safeData.value.character_book || (cd && cd.character_book) || {};
        // 🛡️ 全形态安全提取（entries 数组 / entries 字典 / book 本身为数组），
        // 修复字典形态 entries 与数组形态 book 导致 .filter 崩溃（编辑器白屏）
        const entries = extractBookEntries(book);

        // 【关键】直接返回原始条目的响应式代理（不做拷贝展开），
        // 这样 v-model 编辑能写回原数据（保存时落盘），同时保持响应式（cardData 是 shallowRef）
        // 【脏数据防护】脏条目过滤已由 extractBookEntries 完成，防止 EditorPanel v-for 渲染时读 entry.name 空引用崩溃
        return entries
            .map(entry => reactive(entry));
    });

    // ================= 世界书折叠展开控制 =================
    // 存储每个世界书条目是否展开的映射表，key 为条目的稳定唯一标识（getEntryUid），value 为 boolean
    // ✅ [补丁] 改用 uid 而非数组 index：删除/排序条目后 index 会错位继承旧折叠状态（打开的突然闭合）
    const worldbookExpanded = ref({});

    // 切换单个条目的折叠状态（按条目的稳定唯一标识追踪）
    const toggleWorldbookEntry = (entry) => {
        if (!entry) return;
        const key = getEntryUid(entry);
        worldbookExpanded.value[key] = !worldbookExpanded.value[key];
    };

    // 全部展开
    const expandAllWorldbook = () => {
        worldbookEntries.value.forEach((entry) => {
            if (entry) worldbookExpanded.value[getEntryUid(entry)] = true;
        });
    };

    // 全部折叠
    const collapseAllWorldbook = () => {
        worldbookEntries.value.forEach((entry) => {
            if (entry) worldbookExpanded.value[getEntryUid(entry)] = false;
        });
    };

    // 世界书触发词转字符串以便在 input 中编辑
    const getKeysString = (keysArray) => {
        return Array.isArray(keysArray) ? keysArray.join(', ') : (keysArray || '');
    };

    const updateEntryKeys = (entry, fieldOrVal, value) => {
        if (!entry) return;
        // 兼容两种调用形态：
        //   updateEntryKeys(entry, value)          -> 写 entry.keys（角色卡世界书编辑器）
        //   updateEntryKeys(entry, 'key', value)   -> 写 entry.key / entry.keysecondary（独立世界书 IDE）
        let targetField = 'keys';
        let rawValue = fieldOrVal;
        if (value !== undefined) {
            targetField = fieldOrVal;
            rawValue = value;
        }
        // 将逗号分隔的字符串切割为数组，自动去除空格与空项（兼容中英文逗号）
        entry[targetField] = String(rawValue).split(/[,，]/).map(s => s.trim()).filter(s => s.length > 0);
        // 【修复】词条触发词变化会影响世界书 Token 统计，手动触发浅层刷新
        // 🚀 v1.8.5：触发词参与 Token 估算 → 同步失效缓存
        if (cardData.value) { triggerRef(cardData); cardTokensCache.delete(cardData.value); }
    };

    return {
        // 稳定标识
        getEntryUid,
        // 条目列表派生
        worldbookEntries,
        // 折叠展开
        worldbookExpanded, toggleWorldbookEntry, expandAllWorldbook, collapseAllWorldbook,
        // 触发词编辑工具
        getKeysString, updateEntryKeys
    };
}
