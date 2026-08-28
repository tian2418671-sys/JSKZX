/**
 * 世界书词条深度编辑（Entry IDE）组合式函数
 * 从 App.vue 拆分而来，收敛：世界书（独立世界书库模式）词条的新增/删除/克隆/排序/筛选/批量/体检，以及词条搜索过滤。
 * activeWorldbook 等共享状态保留在 App.vue 并注入；行为保持不变。
 */
import { ref, computed } from 'vue';

export function useWorldbookEntries({ activeWorldbook, addLog, confirmDialog, nativeAlert }) {

    const REGEN_UID = () => `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // 为词条补稳定 uid（第三方导入的词条可能没有；uid 为前端临时字段，保存时已剔除，安全）
    const ensureUid = (entry) => {
        if (!entry || typeof entry !== 'object') return '';
        if (!entry.uid) entry.uid = REGEN_UID();
        return entry.uid;
    };

    // =========================================================
    // 🌍 世界书词条深度编辑逻辑 (Entry IDE)
    // =========================================================
    const addWorldbookEntry = () => {
        if (!activeWorldbook.value) return;
        if (!Array.isArray(activeWorldbook.value.data.entries)) {
            activeWorldbook.value.data.entries = [];
        }
        activeWorldbook.value.data.entries.unshift({
            uid: REGEN_UID(),
            key: [],
            keysecondary: [],
            content: '',
            constant: false,
            selective: false,
            insertion_order: 50,
            order: 100,
            position: 1,
            enabled: true,
            _collapsed: false
        });
        addLog(`➕ 新增了一条空白世界书词条`, 'info');
    };

    const deleteWorldbookEntry = async (entry) => {
        if (!activeWorldbook.value) return;
        const entries = activeWorldbook.value.data.entries;
        const index = entries.indexOf(entry);
        if (index === -1) return;
        const ok = await confirmDialog('确定要删除这条世界书设定吗？操作不可逆！');
        if (ok) {
            entries.splice(index, 1);
            addLog(`🗑️ 删除了第 ${index + 1} 个词条`, 'warning');
        }
    };

    // 上移 / 下移（调整词条在数组中的实际顺序，排序方式为 default 时即反映在列表）
    const moveEntry = (entry, dir) => {
        if (!activeWorldbook.value) return;
        const entries = activeWorldbook.value.data.entries;
        if (!Array.isArray(entries)) return;
        const from = entries.indexOf(entry);
        if (from === -1) return;
        const to = from + dir;
        if (to < 0 || to >= entries.length) return;
        entries.splice(to, 0, entries.splice(from, 1)[0]);
    };

    const duplicateWorldbookEntry = (entry) => {
        if (!activeWorldbook.value) return;
        const entries = activeWorldbook.value.data.entries;
        const index = entries.indexOf(entry);
        if (index === -1) return;
        const cloned = JSON.parse(JSON.stringify(entry));
        cloned.uid = REGEN_UID();
        cloned.comment = (cloned.comment || '词条') + ' (副本)';
        cloned._collapsed = false;
        entries.splice(index + 1, 0, cloned);
        addLog(`📋 成功复制了第 ${index + 1} 条词条`, 'info');
    };

    // =========================================================
    // 🎛️ 词条筛选 / 排序
    // =========================================================
    const entrySearchQuery = ref('');       // 词条关键字实时搜索
    const entryFilterState = ref('all');    // 状态筛选：all/enabled/disabled/constant/selective
    const entrySortBy = ref('default');     // 排序：default/orderAsc/orderDesc/name/contentLen

    const filteredWorldbookEntries = computed(() => {
        if (!activeWorldbook.value || !Array.isArray(activeWorldbook.value.data.entries)) return [];
        let list = activeWorldbook.value.data.entries.filter(e => e && typeof e === 'object');

        const q = entrySearchQuery.value.trim().toLowerCase();
        if (q) {
            list = list.filter(entry => {
                const keysStr = Array.isArray(entry.key) ? entry.key.join(' ') : String(entry.key || '');
                const secKeysStr = Array.isArray(entry.keysecondary) ? entry.keysecondary.join(' ') : '';
                const contentStr = entry.content || '';
                const commentStr = entry.comment || '';
                return keysStr.toLowerCase().includes(q) ||
                       secKeysStr.toLowerCase().includes(q) ||
                       contentStr.toLowerCase().includes(q) ||
                       commentStr.toLowerCase().includes(q);
            });
        }

        // 状态筛选
        const st = entryFilterState.value;
        if (st === 'enabled')      list = list.filter(e => e.enabled !== false);
        else if (st === 'disabled') list = list.filter(e => e.enabled === false);
        else if (st === 'constant') list = list.filter(e => !!e.constant);
        else if (st === 'selective') list = list.filter(e => !!e.selective);

        // 排序（仅影响展示顺序，不改变底层数组顺序；moveEntry 才是真实调序）
        // 🦾 排序增强：名称排序用与角色卡一致的 Intl.Collator（中文拼音 + 数字自然排序），
        //    再叠加「触发词 → uid → index」稳定链，同名条目顺序也完全确定（不随渲染抖动）
        const sort = entrySortBy.value;
        if (sort === 'orderAsc')       list = [...list].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        else if (sort === 'orderDesc') list = [...list].sort((a, b) => (b.order ?? 100) - (a.order ?? 100));
        else if (sort === 'name')      list = [...list].sort((a, b) => {
            const coll = (() => { try { return new Intl.Collator('zh-Hans-CN', { numeric: true }); } catch (e) { return null; } })();
            const na = String(a.comment || a.key?.[0] || '');
            const nb = String(b.comment || b.key?.[0] || '');
            let r = 0;
            if (coll) r = coll.compare(na, nb);
            else r = na.localeCompare(nb, 'zh');
            return r
                || String(a.key?.[0] ?? a.key ?? '').localeCompare(String(b.key?.[0] ?? b.key ?? ''))
                || String(a.uid ?? a.index ?? 0).localeCompare(String(b.uid ?? b.index ?? 0));
        });
        else if (sort === 'contentLen') list = [...list].sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));

        return list;
    });

    // =========================================================
    // ☑️ 批量操作（批量启用 / 停用 / 删除）
    // =========================================================
    const batchMode = ref(false);
    const batchSelected = ref(new Set()); // 存 entry.uid

    const toggleBatchMode = () => {
        batchMode.value = !batchMode.value;
        if (!batchMode.value) batchSelected.value = new Set();
    };
    const toggleBatchSelect = (entry) => {
        const uid = ensureUid(entry);
        if (!uid) return;
        const s = new Set(batchSelected.value);
        s.has(uid) ? s.delete(uid) : s.add(uid);
        batchSelected.value = s;
    };
    const selectAllEntries = () => {
        batchSelected.value = new Set(filteredWorldbookEntries.value.map(e => ensureUid(e)).filter(Boolean));
    };
    const clearBatchSelection = () => { batchSelected.value = new Set(); };

    const batchToggleEnabled = (enabled) => {
        const entries = activeWorldbook.value?.data?.entries || [];
        let n = 0;
        entries.forEach(e => { if (batchSelected.value.has(ensureUid(e))) { e.enabled = enabled; n++; } });
        batchMode.value = false;
        batchSelected.value = new Set();
        addLog(`已${enabled ? '启用' : '停用'} ${n} 个词条`, 'success');
    };

    const batchDeleteEntries = async () => {
        if (!activeWorldbook.value) return;
        const entries = activeWorldbook.value.data.entries;
        const targets = entries.filter(e => batchSelected.value.has(ensureUid(e)));
        if (targets.length === 0) return;
        const ok = await confirmDialog(`确定删除选中的 ${targets.length} 个词条吗？操作不可逆！`);
        if (!ok) return;
        for (let i = entries.length - 1; i >= 0; i--) {
            if (batchSelected.value.has(ensureUid(entries[i]))) entries.splice(i, 1);
        }
        batchMode.value = false;
        batchSelected.value = new Set();
        addLog(`🗑️ 批量删除了 ${targets.length} 个词条`, 'warning');
    };

    // =========================================================
    // 🩺 数据质量：同书内查重 + 空词条 / 孤儿触发词体检
    // =========================================================
    const entryHealthReport = computed(() => {
        const entries = (activeWorldbook.value?.data?.entries || []).filter(e => e && typeof e === 'object');
        const empty = [];
        const orphan = [];
        const sigMap = new Map();
        const dupGroups = [];

        entries.forEach(e => {
            const keyLen = Array.isArray(e.key) ? e.key.length : (e.key ? 1 : 0);
            const content = String(e.content || '').trim();
            // 空词条：无正文且无触发词
            if (!content && keyLen === 0) { empty.push(e); return; }
            // 孤儿触发词：有正文但无触发词
            if (content && keyLen === 0) { orphan.push(e); return; }
            // 同书内查重：触发词集合 + 正文完全一致视为重复
            const keys = Array.isArray(e.key) ? e.key.map(String).sort().join(',') : String(e.key || '').trim();
            const sig = `${keys}::${content}`;
            if (!sig) return;
            if (sigMap.has(sig)) {
                const first = sigMap.get(sig);
                let group = dupGroups.find(g => g.includes(first));
                if (!group) { group = [first]; dupGroups.push(group); }
                group.push(e);
            } else {
                sigMap.set(sig, e);
            }
        });

        const duplicateCount = dupGroups.reduce((s, g) => s + g.length, 0);
        return { emptyCount: empty.length, orphanCount: orphan.length, duplicateCount, groupCount: dupGroups.length, empty, orphan, dupGroups };
    });

    // 一键体检：输出去重报告（日志 + 弹窗）
    const runEntryHealthCheck = () => {
        const r = entryHealthReport.value;
        const summary = [
            `📚 世界书体检报告：`,
            `空词条（无正文且无触发词）：${r.emptyCount} 条`,
            `孤儿触发词（有正文但无触发词）：${r.orphanCount} 条`,
            `重复词条（触发词+正文一致）：${r.groupCount} 组 / ${r.duplicateCount} 条`
        ].join('\n');
        addLog(summary, 'info');
        nativeAlert(`${summary}\n\n（可在左下角状态筛选「停用/常驻/条件」定位；重复项建议手动比对后删除）`, 'info');
    };

    return {
        ensureUid,
        addWorldbookEntry, deleteWorldbookEntry, duplicateWorldbookEntry, moveEntry,
        entrySearchQuery, entryFilterState, entrySortBy, filteredWorldbookEntries,
        batchMode, batchSelected, toggleBatchMode, toggleBatchSelect, selectAllEntries, clearBatchSelection,
        batchToggleEnabled, batchDeleteEntries,
        entryHealthReport, runEntryHealthCheck
    };
}