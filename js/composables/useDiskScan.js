/**
 * 磁盘卡片扫描组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：全盘/指定目录深度扫描、扫描进度、扫描路径导入、
 * 收编回调、固定目录选择与一键刷新当前库。
 * 共享创库基础设施（parseAndAddCard / processElectronFiles）与共享状态（library / currentFolderPath /
 * cardData / customCategories / appMode）及工具（nativeAlert / showToast / isCategoryKnown / openFromLibrary）
 * 保留在 App.vue 顶层并注入，其余磁盘扫描状态与方法在此定义。
 */
import { ref } from 'vue';

export function useDiskScan({
    library,
    currentFolderPath,
    cardData,
    customCategories,
    appMode,
    nativeAlert,
    showToast,
    isCategoryKnown,
    openFromLibrary,
    parseAndAddCard,
    processElectronFiles,
    withLoadLock
}) {
    const isScanningDisk = ref(false);
    const diskScanProgress = ref({ status: '准备就绪', count: 0 });
    const useSizeFilter = ref(true); // 默认开启体积过滤（跳过 <40KB 的贴图/图标）
    // 🛰️ 全盘深度检索引擎弹窗开关（新的独立 UI，替代旧 runDiskScan 进度蒙版）
    const showDiskScanModal = ref(false);

    // 将扫描结果导入到库中（追加模式，不清空现有库；并发受限批处理）
    // 🔧 V3 兼容两种形态：主进程验证后的真卡对象 [{path,...}] 或收编后的目标路径字符串数组
    const importScanPaths = async (paths) => {
        let added = 0;
        const CONCURRENCY = 8;
        const seenPaths = new Set(); // 🚀 v2.0：收编路径 O(1) 去重（替代 staging 线性扫描 O(N²)）
        for (let i = 0; i < paths.length; i += CONCURRENCY) {
            const batch = paths.slice(i, i + CONCURRENCY);
            const results = await Promise.all(batch.map(async (entry) => {
                const absPath = (typeof entry === 'string') ? entry : (entry && entry.path);
                if (!absPath) return false;
                const name = absPath.split(/[\\/]/).pop() || absPath;
                const isImage = /\.(png|webp)$/i.test(name);
                const file = {
                    name,
                    path: absPath,
                    url: isImage ? 'local-file://img/?path=' + encodeURIComponent(absPath) : null
                };
                return await parseAndAddCard(file, { seenPaths });
            }));
            added += results.filter(Boolean).length;
        }
        return added;
    };

    // 核心扫描执行器
    const runDiskScan = async (mode) => {
        if (!window.electronAPI) {
            return nativeAlert('该功能需要 Electron 桌面环境，请使用 npm start 启动应用。', 'warning');
        }
        isScanningDisk.value = true;
        diskScanProgress.value = { status: '正在初始化扫描引擎...', count: 0 };

        let foundFiles = [];

        // 监听底层发来的扫描进度心跳
        window.electronAPI.onScanProgress((data) => {
            diskScanProgress.value = data;
        });

        try {
            if (mode === 'specific') {
                // 1. 指定盘符/文件夹扫描（主进程弹出原生目录选择器），传递体积过滤开关 + 当前库排除
                const result = await window.electronAPI.scanTargetFolder(null, useSizeFilter.value, currentFolderPath.value || null);
                if (result && result.files) foundFiles = result.files;

            } else if (mode === 'all') {
                // 2. 暴力全盘扫描（同样排除当前库，杜绝"扫出一堆自家卡"）
                const drives = await window.electronAPI.getWindowsDrives();
                diskScanProgress.value.status = `共检测到 ${drives.length} 个本地磁盘，准备遍历...`;

                for (const drive of drives) {
                    diskScanProgress.value.status = `正在深度扫描磁盘: ${drive}`;
                    const result = await window.electronAPI.scanTargetFolder(drive, useSizeFilter.value, currentFolderPath.value || null);
                    if (result && result.files) {
                        foundFiles = foundFiles.concat(result.files);
                    }
                }
            }

            if (foundFiles.length === 0) {
                nativeAlert('扫描结束，未发现库外的新角色卡文件。\n（库内卡片与同名副本已自动跳过）', 'info');
            } else {
                diskScanProgress.value.status = `✅ 扫描完成！共发现 ${foundFiles.length} 张库外新卡，准备导入...`;

                // 🔧 安全收编：扫描结束后主进程已撤销盘符级白名单，
                // 不能再 readBuffer 直读磁盘角落原路径——先复制进当前库
                // （sys:importExternalCards 源路径不校验白名单、同名跳过不覆盖），
                // 再解析库内副本（库根目录在白名单内，稳定可读）
                if (!currentFolderPath.value) {
                    nativeAlert('尚未打开角色库目录，无法导入扫描结果。\n请先通过「打开角色库」选择一个文件夹。', 'warning');
                    return; // finally 会复位 isScanningDisk
                }
                const res = await window.electronAPI.importExternalCards(foundFiles, currentFolderPath.value);
                if (!res || !res.success) {
                    nativeAlert(`收编外部卡片失败: ${(res && res.error) || '未知错误'}`, 'error');
                    return;
                }
                const addedCount = await importScanPaths(res.copied || []);
                const skipped = (res.skipped || []).length;

                diskScanProgress.value.status = `✅ 已成功导入 ${addedCount} 张角色卡！`;
                nativeAlert(
                    `全盘/指定扫描完成！\n共提取 ${foundFiles.length} 个角色卡文件，成功导入 ${addedCount} 张。` +
                    (skipped > 0 ? `\n${skipped} 张与库内卡片同名，已跳过（不覆盖）。` : '') +
                    `\n（无法识别的文件已自动跳过）`,
                    'info'
                );
            }
        } catch (err) {
            console.error("扫描失败:", err);
            nativeAlert('扫描过程中发生异常，详情请查看控制台。', 'error');
        } finally {
            isScanningDisk.value = false;
        }
    };

    // 🛰️ 全盘检索收编回调：把复制到当前库的卡片精准追加入库（不清空现有库），并 Toast 反馈
    const handleScanImported = async (copiedFiles) => {
        if (!copiedFiles || copiedFiles.length === 0) return;
        try {
            const added = await importScanPaths(copiedFiles);
            showToast(`🛰️ 已收编 ${added} 张卡片到当前库！`, 'success', 4000);
        } catch (err) {
            console.error('收编入库失败:', err);
            nativeAlert('收编入库失败: ' + (err && err.message || err), 'error');
        }
    };

    // 按钮绑定的点击事件：通过主进程弹出原生文件夹选择框
    const selectFixedDirectory = async () => {
        if (!window.electronAPI) {
            return nativeAlert("该功能需要 Electron 桌面环境，请使用 npm start 启动应用。", 'warning');
        }
        const result = await window.electronAPI.selectFolder();
        if (result) {
            // 【修复】打开角色库目录后自动切换到角色卡模式，界面立即显示角色卡列表
            appMode.value = 'characters';
            await processElectronFiles(result);
        }
    };

    // 🔄 重新扫描当前库目录（不弹目录选择框），解决"手动放入文件夹里的新卡不读取"问题
    // 🛡️ 并发重入保护（防「重复卡」的根因之一）：整个「清库 + 重建」必须与
    //    processElectronFiles（启动加载 / 切库）串行。此前两者都能并发进入：
    //    「加载未完成就点刷新」或快速连点刷新时，两个循环会交错操作同一个 library
    //    数组（后进入者清空、先进入者的分块 push 又落回），同一 path 进两次 → 重复卡。
    //    withLoadLock 由 useCardCrud 注入，两边共用同一把锁。
    const refreshLibraryInner = async () => {
        if (!window.electronAPI) {
            return nativeAlert("该功能需要 Electron 桌面环境，请使用 npm start 启动应用。", 'warning');
        }
        if (!currentFolderPath.value) {
            return nativeAlert("尚未打开角色库目录，请先点击「📂 打开本地库」。", 'warning');
        }
        if (typeof window.electronAPI.rescanLibrary !== 'function') {
            return nativeAlert("当前版本不支持一键刷新目录，请更新到最新版。", 'warning');
        }
        const prevCardPath = cardData.value ? (library.value.find(i => i.data === cardData.value)?.path || null) : null;
        const result = await window.electronAPI.rescanLibrary(currentFolderPath.value);
        // 🛡️ 先判错：主进程 `scanAndSaveFolder` 的 catch 分支返回的是
        //    `{ folderPath:null, files:[], error }` —— 空数组是「真值」，
        //    旧写法 `if (result && result.files)` 会把它当成「库已清空」，
        //    直接 `library.value = next(=[])`，界面上一整个大库瞬间消失
        //    （磁盘文件没动，但用户看到「卡全没了」）。错误必须先拦下。
        if (result && result.error) {
            nativeAlert(result.error, 'error');
            return;
        }
        // 🛡️ 再防空：库非空时，一次返回 0 文件的扫描结果视为异常，绝不据此清空列表
        if (result && Array.isArray(result.files) && result.files.length === 0 && library.value.length > 0) {
            console.warn('[刷新] 扫描返回 0 文件，已保留当前库（防误清空）');
            nativeAlert('本次扫描未返回任何文件，已保留当前库（未清空）。\n若目录确实已空，请重新打开库目录。', 'warning');
            return;
        }
        if (result && result.files) {
            appMode.value = 'characters';
            // 🚀 增量刷新（方案 B）：按 path+mtime 差分，复用未变化卡片对象（不重新读盘解析），
            // 只对新增/修改的卡片走完整解析——千卡库刷新从全量重载降为增量，保留用户自定义标签/分类
            const oldMap = new Map(library.value.map(c => [c.path, c]));
            const toParse = [];
            const next = [];
            // 🛡️ 去重（防重复卡）：next 只由扫描结果构造，若扫描结果里同一 path 出现两次
            //    （junction/符号链接指到同一文件、或扫描期间目录结构变化），旧写法会把同一张
            //    卡 push 两次 → 列表出现重复卡。这里按 path 强去重（首个胜出，保留原对象）。
            const seenPath = new Set();
            for (const f of result.files) {
                if (!f || !f.path) continue;
                if (seenPath.has(f.path)) continue;
                seenPath.add(f.path);
                const old = oldMap.get(f.path);
                if (old && Number(old._mtime) === Number(f.mtime)) {
                    next.push(old); // 未变化：直接复用内存对象（含用户自定义状态）
                } else {
                    toParse.push(f); // 新增 / mtime 变化：走完整解析
                }
            }
            // 释放被物理删除卡片的 blob URL（不在 result.files 里 → 旧 blob 无人引用）
            const keptPaths = new Set(next.map(c => c.path));
            library.value.forEach(c => {
                if (!keptPaths.has(c.path) && c.avatar && typeof c.avatar === 'string' && c.avatar.startsWith('blob:')) {
                    try { URL.revokeObjectURL(c.avatar); } catch (e) { /* 忽略 */ }
                }
            });
            library.value = next;
            // 📁 物理子文件夹 = 分组：合并新增分组
            if (Array.isArray(result.categories)) {
                result.categories.forEach(cat => {
                    if (cat && cat.trim() !== '' && !customCategories.value.includes(cat) && !isCategoryKnown(cat)) {
                        customCategories.value.push(cat);
                    }
                });
            }
            // 并发受限批处理解析新增/变化文件
            // 🛡️ 必须传 seenPaths：parseAndAddCard 直接 push 到 live library（无 target 时），
            //    没有 seenPaths 就完全不判重 —— 这是重复卡的第二条路径。
            //    同时预填 next 里已存在的 path，避免「复用的旧对象」与「新解析对象」撞同一 path。
            const parseSeen = new Set(keptPaths);
            const CONCURRENCY = 8;
            for (let i = 0; i < toParse.length; i += CONCURRENCY) {
                const batch = toParse.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(file => parseAndAddCard(file, { seenPaths: parseSeen })));
            }
            // 刷新后尽量保持当前打开卡片的编辑状态（按路径重新绑定新解析出的对象）
            if (prevCardPath && cardData.value) {
                const reopen = library.value.find(i => i.path === prevCardPath);
                if (reopen) openFromLibrary(reopen);
            }
            showToast(`目录已刷新，共加载 ${library.value.length} 张卡片。`, 'success');
        } else if (result && result.error) {
            nativeAlert(result.error, 'error');
        }
    };

    /**
     * 对外版本：共享加载锁 + 合并（coalesce）。
     *
     * 🛡️ 为什么需要合并：大库（11k 卡）单次刷新 = 重扫 + 重建，实测 17~19 秒。
     *    用户连点 10 次刷新若真跑 10 次，就是 3 分钟的重复全量重建 —— 界面表现为「卡死」。
     *    这里把「刷新进行中收到的多次请求」折叠成**至多一次**补跑：
     *      连点 N 次 → 实际执行 2 次（首次 + 收尾一次），结果等价，开销不随点击次数膨胀。
     */
    let refreshPending = false;
    let refreshRunning = false;
    const refreshLibraryOnce = () => (typeof withLoadLock === 'function'
        ? withLoadLock(refreshLibraryInner)
        : refreshLibraryInner());
    const refreshLibrary = async () => {
        if (refreshRunning) {
            // 已有刷新在跑：只记一次「待补跑」，多余点击直接丢弃
            refreshPending = true;
            return;
        }
        refreshRunning = true;
        try {
            await refreshLibraryOnce();
            // 跑期间被点过 → 补跑一次（把期间的外部改动一并纳入）
            if (refreshPending) {
                refreshPending = false;
                await refreshLibraryOnce();
            }
        } finally {
            refreshRunning = false;
            refreshPending = false;
        }
    };

    return {
        isScanningDisk, diskScanProgress, useSizeFilter, showDiskScanModal,
        runDiskScan, handleScanImported, selectFixedDirectory, refreshLibrary
    };
}