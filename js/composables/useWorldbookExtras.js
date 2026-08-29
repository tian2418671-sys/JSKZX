/**
 * 世界书扩展功能组合式函数（Composable）
 * 收敛：从角色卡提取世界书 / JSONL(Rentry) 导入 / 批量导出 / 快照历史与回滚 / 世界书库统计。
 * 共享状态（worldbooks / activeWorldbook / lastWorldbookDirPath）与工具（nativeAlert / addLog / confirmDialog）保留在 App.vue 并注入。
 */
import { ref, computed, triggerRef } from 'vue';
import { estimateTokens } from '../utils/tokenEstimate.js';
import { extractBookEntries } from '../utils/cardLoader.js';

// 灵活解析世界书文本：整体 JSON（数组 / {entries} / V2 data.entries）或 JSONL（逐行）
function parseEntriesFlexible(text) {
    const trim = String(text || '').replace(/^\uFEFF/, '').trim();
    let name = '';
    let entries = [];
    try {
        const obj = JSON.parse(trim);
        if (Array.isArray(obj)) {
            entries = obj;
        } else if (obj && typeof obj === 'object') {
            name = obj.name || '';
            entries = obj.entries || (Array.isArray(obj.data?.entries) ? obj.data.entries : []);
        }
    } catch (e) {
        // JSONL：逐行解析
        const lines = trim.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        entries = lines.map(l => { try { return JSON.parse(l); } catch (e2) { return null; } }).filter(Boolean);
    }
    // 🛡️ 字典形态 entries（SillyTavern 世界书导出 {"0":{...},"1":{...}}）同样可导入
    const normalized = (Array.isArray(entries) ? entries : Object.values(entries || {}))
        .filter(e => e && typeof e === 'object').map(e => ({
        uid: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        key: Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : (e.key ? [e.key] : (e.keys ? [e.keys] : []))),
        keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : (Array.isArray(e.secondary_keys) ? e.secondary_keys : (e.keysecondary ? [e.keysecondary] : [])),
        content: e.content || '',
        comment: e.comment || e.name || '',
        constant: !!e.constant,
        selective: !!e.selective,
        insertion_order: e.insertion_order ?? 50,
        order: e.order ?? 100,
        position: e.position ?? 1,
        enabled: e.enabled !== false
    }));
    return { name, entries: normalized };
}

export function useWorldbookExtras({ worldbooks, activeWorldbook, lastWorldbookDirPath, nativeAlert, addLog, confirmDialog }) {
    // =========================================================
    // 📤 从角色卡内嵌世界书提取为独立世界书
    // =========================================================
    const extractWorldbookFromCard = async (cardData, cardName) => {
        if (!cardData) return;
        const data = cardData.data || cardData; // 兼容 V2（data.data）与 V1
        const book = data.character_book || cardData.character_book || {};
        // 🛡️ 全形态安全提取（entries 数组/字典/数组 book），字典形态（SillyTavern 导出）同样可提取
        const entries = extractBookEntries(book);
        if (entries.length === 0) {
            nativeAlert('该角色卡没有内嵌世界书词条，无法提取。', 'warning');
            return;
        }
        const name = cardName || data.name || '未命名角色';
        const cleanEntries = entries.filter(e => e && typeof e === 'object').map(e => {
            const c = JSON.parse(JSON.stringify(e));
            // 字段转换：角色卡内嵌（keys/secondary_keys）→ 独立世界书（key/keysecondary）
            c.key = Array.isArray(e.keys) ? [...e.keys] : (e.keys || []);
            c.keysecondary = Array.isArray(e.secondary_keys) ? [...e.secondary_keys] : (e.secondary_keys || []);
            delete c.keys; delete c.secondary_keys; delete c._collapsed;
            // 【BUG 修复】条目名字映射：V1 旧卡/第三方卡词条用 name 存名字，
            // 世界书库 IDE 只读 comment，不映射会导致导出后条目名字缺失
            // （卡内编辑器显示 entry.comment || entry.name，掩盖了该问题）
            c.comment = String(c.comment || c.name || '');
            // 【BUG 修复】权重回退映射：纯 V2 卡词条只有 insertion_order，库 IDE 编辑的是 order 字段
            c.order = c.order ?? c.insertion_order ?? 100;
            c.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            return c;
        });
        const wbName = `${name} - 世界书`;
        const wbData = { name: wbName, description: `从角色卡「${name}」提取的世界书`, entries: cleanEntries };
        const safeFileName = `${wbName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
        let saveDir = lastWorldbookDirPath.value;
        if (!saveDir) {
            addLog('请选择世界书保存目录...', 'warning');
            saveDir = await window.electronAPI.selectGenericFolder();
        }
        if (!saveDir) return;
        const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
        const res = await window.electronAPI.createWorldbook({ filePath, data: wbData });
        if (res?.success) {
            worldbooks.value.push({ path: filePath, name: safeFileName, data: wbData });
            triggerRef(worldbooks); // shallowRef：手动触发响应式
            addLog(`📤 已从角色卡提取世界书: ${wbName}`, 'success');
            nativeAlert(`已提取世界书《${wbName}》（${cleanEntries.length} 个词条）到世界书库。`, 'info');
        } else {
            nativeAlert(`提取失败: ${res?.error || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 📜 导入 JSONL / Rentry 世界书（选文件，逐行解析）
    // =========================================================
    const importWbFromJsonl = async (event) => {
        const files = Array.from(event.target.files || []);
        if (files.length === 0) return;
        for (const file of files) {
            try {
                const text = await file.text();
                const parsed = parseEntriesFlexible(text);
                if (parsed.entries.length === 0) { addLog(`⚠️ ${file.name} 未解析到词条，跳过`, 'warning'); continue; }
                const bookName = (parsed.name || file.name.replace(/\.(jsonl?|txt)$/i, '')).trim();
                const wbData = { name: bookName, description: '通过 JSONL/Rentry 导入的世界书', entries: parsed.entries };
                const safeFileName = `${bookName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
                let saveDir = lastWorldbookDirPath.value;
                if (!saveDir) saveDir = await window.electronAPI.selectGenericFolder();
                if (!saveDir) continue;
                const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
                const res = await window.electronAPI.createWorldbook({ filePath, data: wbData });
                if (res?.success) {
                    worldbooks.value.push({ path: filePath, name: safeFileName, data: wbData });
                    triggerRef(worldbooks); // shallowRef：手动触发响应式
                    addLog(`📜 导入 JSONL 世界书: ${bookName}（${parsed.entries.length} 词条）`, 'success');
                }
            } catch (e) {
                addLog(`❌ 导入 ${file.name} 失败: ${e.message}`, 'error');
            }
        }
        event.target.value = '';
        nativeAlert('JSONL/Rentry 导入处理完成，详见日志。', 'info');
    };

    // =========================================================
    // 📦 批量导出所有已落盘世界书
    // =========================================================
    const exportWorldbooksBatch = async () => {
        const paths = worldbooks.value.filter(w => w.path).map(w => w.path);
        if (paths.length === 0) { nativeAlert('没有可导出的世界书（均为内存态未落盘）。', 'warning'); return; }
        const res = await window.electronAPI.exportWorldbooksBatch(paths);
        if (res?.success) {
            addLog(`📦 批量导出 ${res.count} 本世界书 -> ${res.outDir}`, 'success');
            nativeAlert(`已批量导出 ${res.count} 本世界书到:\n${res.outDir}`, 'info');
        } else if (res?.error !== '用户取消操作') {
            nativeAlert(`批量导出失败: ${res?.error || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 🕒 世界书快照历史与回滚
    // =========================================================
    const showWbSnapshotModal = ref(false);
    const wbSnapshotList = ref([]);
    const wbSnapshotTarget = ref(null);

    const openWbSnapshots = async (wb) => {
        if (!wb) return;
        if (!wb.path) {
            nativeAlert('该世界书尚未落盘（无本地文件），没有快照历史。', 'warning');
            return;
        }
        wbSnapshotTarget.value = wb;
        wbSnapshotList.value = [];
        showWbSnapshotModal.value = true;
        const res = await window.electronAPI.listWorldbookSnapshots(wb.path);
        if (res?.success) {
            wbSnapshotList.value = res.data || [];
        } else {
            nativeAlert('读取快照历史失败: ' + (res?.error || '未知错误'), 'error');
        }
    };
    const closeWbSnapshotModal = () => { showWbSnapshotModal.value = false; };

    // 🗑️ 删除一条世界书历史快照（物理删除，不可恢复）
    const deleteWbSnapshot = async (snap) => {
        if (!snap || !snap.path) return;
        if (!window.electronAPI || typeof window.electronAPI.deleteWorldbookSnapshot !== 'function') {
            return nativeAlert('当前版本不支持删除世界书快照，请更新应用。', 'warning');
        }
        const ok = await confirmDialog(`确定要删除这条世界书快照吗？\n\n${snap.file}\n\n⚠️ 删除后不可恢复。`);
        if (!ok) return;
        const res = await window.electronAPI.deleteWorldbookSnapshot(snap.path);
        if (res?.success) {
            wbSnapshotList.value = wbSnapshotList.value.filter(s => s.path !== snap.path);
            addLog(`🗑️ 已删除世界书快照: ${snap.file}`, 'success');
        } else {
            nativeAlert(`删除快照失败: ${res?.error || '未知错误'}`, 'error');
        }
    };

    const restoreWbSnapshot = async (snap) => {
        const target = wbSnapshotTarget.value;
        if (!target || !snap) return;
        const name = (target.data && target.data.name) || target.name || '未命名';
        const ok = await confirmDialog(`确定将世界书《${name}》回滚到快照「${snap.file}」吗？\n当前版本会先自动备份。`);
        if (!ok) return;
        const res = await window.electronAPI.restoreWorldbookSnapshot({ filePath: target.path, snapshotPath: snap.path });
        if (res?.success) {
            // 回滚后重读文件同步内存
            try {
                const readRes = await window.electronAPI.readText(target.path);
                if (!readRes?.success || typeof readRes.text !== 'string') throw new Error(readRes?.error || 'readText failed');
                const data = JSON.parse(readRes.text);
                data.entries = Array.isArray(data.entries) ? data.entries : (data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : []);
                target.data = data;
            } catch (e) { /* 忽略解析/读取异常 */ }
            addLog(`🕒 已回滚世界书快照: ${snap.file}`, 'success');
            nativeAlert('已成功回滚到所选快照。', 'info');
            showWbSnapshotModal.value = false;
        } else {
            nativeAlert(`回滚失败: ${res?.error || '未知错误'}`, 'error');
        }
    };

    // =========================================================
    // 📊 世界书库统计
    // =========================================================
    const wbStats = computed(() => {
        const books = worldbooks.value || [];
        let entryCount = 0, tokenTotal = 0, constantCount = 0, keyedCount = 0;
        books.forEach(wb => {
            const entries = (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries : [];
            entryCount += entries.length;
            entries.forEach(e => {
                const keyArr = Array.isArray(e.key) ? e.key : (e.key ? [e.key] : []);
                const secArr = Array.isArray(e.keysecondary) ? e.keysecondary : [];
                if (e.constant) constantCount++;
                if (keyArr.length > 0) keyedCount++;
                tokenTotal += estimateTokens(keyArr.concat(secArr).join(' ') + ' ' + (e.content || ''));
            });
        });
        const keyCoverage = entryCount > 0 ? Math.round((keyedCount / entryCount) * 100) : 0;
        return { bookCount: books.length, entryCount, tokenTotal, constantCount, keyedCount, keyCoverage };
    });

    return {
        extractWorldbookFromCard, importWbFromJsonl, exportWorldbooksBatch,
        showWbSnapshotModal, wbSnapshotList, wbSnapshotTarget, openWbSnapshots, closeWbSnapshotModal, restoreWbSnapshot, deleteWbSnapshot,
        wbStats
    };
}
