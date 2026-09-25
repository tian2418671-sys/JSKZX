/**
 * 世界书库 + 世界书分组功能组合式函数（Composable）
 * 从 App.vue 拆分而来，收敛：世界书的加载/扫描/网址导入/重命名/文件夹导入/删除/克隆/右键菜单，以及世界书分组。
 * 世界书「状态」（worldbooks/activeWorldbook/wbCategoryMap 等）被配置持久化、保存、词条编辑等多处共享，保留在 App.vue 并注入。
 */
import { ref, computed, triggerRef } from 'vue';
// 🛡️ 读前预检（§5.3，2026-09-23 补）：**并发**批量读正文前先按「磁盘 size × 2.2」估算，
//    超限就拒绝并说明原因 —— 而不是等内核杀进程（PK-27 那次连提示的机会都没有）。
//    顺序路径（concurrency=1）峰值 ≈ 单本，天然安全，无需预检。
import { preflightRead } from '../utils/memoryGuard.js';
// 🏷️ A2（2026-09-24，RFC-20260921-WB-TAGS-02）：世界书分组/标签的纯函数层
//    ⚠️ 已拍板：元数据**只留配置文件**（不写用户文件、不产快照）+ 保留中文哨兵 + 补碰撞防护。
import {
    WB_CAT_ALL, WB_CAT_DEFAULT, WB_RESERVED_CATEGORY_NAMES,
    normalizeWbCategoryName, validateWbCategoryName, normalizeWbTag, normalizeWbTags,
    toggleWbTag, countWbTags, matchWbFilter
} from '../utils/wbGroupsTags.js';

export function useWorldbooks({
    // 共享状态
    worldbooks, activeWorldbook, lastWorldbookDirPath,
    wbSearchQuery, wbFilterType, currentWbCategory, wbCategoryMap,
    // 🏷️ A2：世界书**标签**映射（key = path||name → string[]），与 wbCategoryMap 同为配置层
    wbTagMap, currentWbTags,
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

    // 📊🔍 世界书扫描进度（2026-09-22 重新定位）
    //    ⚠️ 语义修正（用户 2026-09-22 指出）：进度条**不属于「浏览库」**，
    //       而属于「**查重 / 版本对比**」流程（规格 TC-07：「上百本世界书查重：有进度指示 + 当前项名」，
    //       最终方案 §185：「进度应挂到扫描阶段」）。
    //    ⇒ 现在只有**查重前重扫**（`rescanWorldbooks`）会把它置为 scanning 并显示在**查重弹窗内**；
    //      浏览库（`scanWorldbookDir`）**不再显示进度条**，改用日志反馈（避免语义混淆）。
    //    ⚠️ 与角色卡 `diskScanProgress`（走 'scan-progress'）是**两条独立通道**，互不干扰。
    const wbScanProgress = ref({ phase: 'idle', done: 0, total: 0, current: '' });
    // ⚡ 秒开阶段 2 状态：元数据（书名/词条数）后台补齐中
    const wbMetaFilling = ref(false);
    const wbMetaProgress = ref({ done: 0, total: 0 });
    const isWbScanning = computed(() => wbScanProgress.value.phase === 'scanning' || wbScanProgress.value.phase === 'parsing');
    /** 0~100（total 未知时返回 0，避免出现 NaN 或假进度） */
    const wbScanPercent = computed(() => {
        const { done, total } = wbScanProgress.value;
        if (!total) return 0;
        return Math.min(100, Math.round((done / total) * 100));
    });
    // 订阅只在首次调用时建立（removeAllListeners + on 的既有范式本身也防重复绑定）
    let wbProgressBound = false;
    const bindWbScanProgress = () => {
        if (wbProgressBound) return;
        if (!window.electronAPI || typeof window.electronAPI.onWbScanProgress !== 'function') return;
        window.electronAPI.onWbScanProgress((p) => {
            if (!p || typeof p !== 'object') return;
            wbScanProgress.value = {
                phase: p.phase || 'parsing',
                done: Number(p.done) || 0,
                total: Number(p.total) || 0,
                current: p.current || ''
            };
        });
        wbProgressBound = true;
    };

    // 📢 DF-18：把「被跳过的文件」以可感知方式反馈给用户（计数 + 可展开文件名 + 原因）
    //    静默丢弃 = 用户以为软件坏了；这里至少落一条日志，超限/解析失败都点名。
    const reportSkipped = (kind, skipped) => {
        const list = Array.isArray(skipped) ? skipped : [];
        if (list.length === 0) return;
        // 只把「真正值得用户关心」的（解析失败 / 超限 / 预检未命中）计数报告；
        // 缓存命中的否定判定属正常提速，不刷屏（但仍写入日志便于排查）。
        const notable = list.filter(s => s && s.reason && !/缓存/.test(s.reason));
        if (notable.length > 0) {
            const names = notable.slice(0, 5).map(s => (s.path || '').split(/[\\/]/).pop()).filter(Boolean);
            const more = notable.length > 5 ? ` 等 ${notable.length} 个` : '';
            addLog(`⚠️ ${kind}扫描：${notable.length} 个文件被跳过（${names.join('、')}${more}）`, 'warning');
        } else {
            addLog(`${kind}扫描：${list.length} 个文件按缓存跳过（正常提速，非错误）`);
        }
    };

    // 📊 词条数显示：优先用扫描/元数据缓存给的 `entryCount`（⚡ 秒开后 `data` 不再常驻，
    //    只有用户真正打开某本时才读入正文）；回退到已载入的 `data.entries.length`。
    const wbEntryCount = (wb) => {
        if (!wb) return 0;
        if (typeof wb.entryCount === 'number') return wb.entryCount;
        if (wb.data && Array.isArray(wb.data.entries)) return wb.data.entries.length;
        return 0;
    };

    // 📖 书名显示：优先真实书名（扫描阶段 2 / 元数据缓存），回退文件名
    const wbDisplayName = (wb) => {
        if (!wb) return '';
        return wb.wbName || (wb.data && wb.data.name) || wb.name || '';
    };

    // ═══════════════════════════════════════════════════════════════
    // 🧠 PK-27 / S1'：L1 摘要消费工具（**查重只读索引，永不重读正文**）
    // ───────────────────────────────────────────────────────────────
    // 📖 方案：`docs/规格与计划/世界书大库/世界书大库-加载与查重架构方案.md`（三层模型）
    // 📊 实测：keys 存 hash 4.44KB/本（原字符串 67.1KB/本，**15.1× 差距**）
    // ⚠️ 截断口径（v3 评审 P0-2 / §5 #8）：
    //    `keyHashes` 已**排序**，取前 N 个 = **bottom-k sketch**（MinHash 标准变体）
    //    ⇒ 截断后 Jaccard 仍是**无偏估计**；但跨「截断/未截断」书比较时
    //       **双方都必须截到 `min(k, 自身大小)`**，否则系统性低估。
    // ═══════════════════════════════════════════════════════════════

    /** 世界书是否已有 L1a 摘要（keys hash） */
    const hasKeyIndex = (wb) => !!(wb && Array.isArray(wb.keyHashes) && wb.keyHashes.length > 0);

    /**
     * 两个世界书的 **触发词 Jaccard 相似度**（0~1），**不读正文**。
     *
     * ⚠️ 双方都截到 `min(bottomK, 自身长度)`（v3 评审 §5 #8 的截断口径）。
     * @param {object} a @param {object} b
     * @param {number} [bottomK] 截断长度（默认取两者较短者，即不额外截断）
     * @returns {{jaccard:number, inter:number, union:number}|null} 无摘要时返回 null
     */
    const compareKeyHashes = (a, b, bottomK) => {
        if (!hasKeyIndex(a) || !hasKeyIndex(b)) return null;
        const k = Number.isFinite(bottomK) && bottomK > 0 ? bottomK : Infinity;
        // ★ 双方截到 min(k, 自身大小) —— 避免「截断 vs 未截断」的系统性低估
        const la = Math.min(k, a.keyHashes.length);
        const lb = Math.min(k, b.keyHashes.length);
        const A = a.keyHashes, B = b.keyHashes;
        // 双指针求交（两数组均已升序）
        let i = 0, j = 0, inter = 0;
        while (i < la && j < lb) {
            const x = A[i], y = B[j];
            if (x === y) { inter++; i++; j++; }
            else if (x < y) i++; else j++;
        }
        const union = la + lb - inter;
        return { jaccard: union ? inter / union : 0, inter, union };
    };

    /** 完全相同判定（确定性）：`exactContentHash` 一致 */
    const isExactSame = (a, b) => !!(a && b && a.exactContentHash && a.exactContentHash === b.exactContentHash);

    /**
     * 🦥 DF-18 懒加载：确保世界书正文已读入内存（>50MB 的超大书扫描时只回元数据）
     * 前提：`wb:scan` 通过指纹验证后会把目录加入白名单（本会话内 `readText` 可读）；
     *       重启后白名单为空 → 重新扫一次目录即可恢复授权（见最终方案 §七 #6）。
     *
     * @param {object} wb 世界书条目
     * @param {{silent?: boolean, batch?: boolean}} [opts]
     *   · `silent=true` → 失败时不弹框（仅用于**批量**场景，由调用方汇总提示一次）。
     *     单本操作必须让它弹框 —— 报错是排查线索，不能掩盖。
     *   · `batch=true` → **批量场景**（如查重逐本读）：不逐本写日志、**不逐本 `triggerRef`**
     *     （否则 1000 本会触发 1000 次侧栏重渲染）。
     */
    const ensureWorldbookLoaded = async (wb, opts) => {
        if (!wb || wb.dataLoaded !== false || !wb.path) return wb;
        const silent = !!(opts && opts.silent);
        // ⚡ PK-26 后续：批量读（查重/内容指纹）**绝不能逐本刷日志 + 逐本重渲染** ——
        //    1001 本会产生 1001 条日志与 1001 次侧栏重渲染（实测拖到分钟级）。
        const batch = !!(opts && opts.batch);
        try {
            if (!batch) addLog(`⏳ 正在读取世界书正文：${wb.name || wb.path}`, 'warning');
            // 🛑 真缺陷修复（2026-09-22）：`file:readText` 返回的是 **`{ success, text }` 对象**，
            //    不是字符串！旧写法 `const text = await readText(...)` 直接 `JSON.parse(text)`
            //    → 抛 `"[object Object]" is not valid JSON` → **本函数从未成功过**
            //    （PK-20 之前懒加载只在 >50MB 触发，几乎没人踩到；PK-20 后大量书转懒加载才暴露）。
            const res = await window.electronAPI.readText(wb.path);
            if (!res || !res.success || typeof res.text !== 'string') {
                throw new Error((res && res.error) || '读取返回体异常');
            }
            const parsed = JSON.parse(res.text);
            if (parsed && typeof parsed === 'object') {
                if (parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) {
                    parsed.entries = Object.values(parsed.entries);
                }
                wb.data = parsed;
                wb.dataLoaded = true;
                delete wb._loadError;
                if (!wb.entryCount && Array.isArray(parsed.entries)) wb.entryCount = parsed.entries.length;
                if (!batch) {
                    triggerRef(worldbooks);
                    addLog(`✅ 已读入：${wb.name || wb.path}（${wb.entryCount || 0} 词条）`, 'success');
                }
            }
        } catch (e) {
            wb._loadError = e.message;   // 记下失败原因，供调用方汇总
            addLog(`❌ 读取世界书正文失败：${e.message}`, 'error');
            if (!silent) {
                nativeAlert(`读取世界书正文失败：\n${e.message}\n\n请确认文件仍可访问，或重新选择世界书目录后再试。`, 'error');
            }
        }
        return wb;
    };

    /**
     * 🗑️ 释放已读入的世界书正文（恢复懒加载态），用于**批量**流程（查重 / 内容指纹）用后回收。
     *
     * 为什么必须有：PK-20 的 OOM 根因就是「正文常驻」。批量读 1001 本（6.97GB）若不释放，
     *   会在几十本之后就重演 OOM；内容级查重已有「用后释放」逻辑（见 `startContentDedupeScan`），
     *   同名查重也必须同样释放。
     *
     * ⚠️ 只释放**扫描阶段就判为 `heavy`** 的书（原本就是懒加载态）—— 不碰用户正在编辑的书，
     *   也不碰扫描时已内联的书（那本就不占额外内存）。
     */
    const releaseWorldbookBody = (wb) => {
        if (!wb || !wb.heavy) return;
        wb.data = null;
        wb.dataLoaded = false;
    };

    /**
     * 🧯 **批量正文消费器**（PK-27，2026-09-22）：**唯一**的「批量读世界书正文」入口。
     *
     * 为什么必须有它（三次同款事故换来的）：
     *   ① PK-20：世界书**全量内联** → 501 本 3.56GB 直接退出应用；
     *   ② 内容级查重：**先提取全部文本再算签名** → 5000 本 3GB → 渲染进程被 OOM killer 杀掉
     *      （实测 `reason:"killed"`）；
     *   ③ 同名查重（PK-26 后续，本次）：用 `Promise.all` **整组并发载入** → s5000 每组 200 本
     *      ≈ 2.6GB 峰值 → **进程直接消失**（无 crash.log，典型 OOM 被杀）。
     *   ⇒ 三次事故都是**「一次性把太多正文放进内存」**，只是换了个入口。
     *
     * 本函数的契约（改它之前请先读上面三条）：
     *   · **顺序消费**（默认 concurrency=1）—— 内存峰值 ≈ 单本正文，与库大小**无关**；
     *   · 每本 `consume` 完**立即释放**（`releaseWorldbookBody`），不依赖调用方自觉；
     *   · **每 N 本让出主线程**，保证进度条可绘、界面不假死；
     *   · **逐本失败不中断整批**（记入 `failed`），失败原因汇总后由调用方提示。
     *
     * @param {Array<object>} items 世界书条目数组
     * @param {(wb: object, index: number) => Promise<any>|any} consume 消费回调（读 `wb.data`；返回值被收集）
     * @param {{concurrency?: number, onProgress?: (done: number, total: number) => void, release?: boolean,
     *          readMemory?: () => ({used:number,total:number,limit:number}|null), maxSingleBytes?: number}} [opts]
     *   · `concurrency`：并发数（**默认 1**；调大前请确认 `concurrency × 单本体积` 远小于内存上限）
     *   · `onProgress`：每本完成后回调（用于进度条）
     *   · `release`：是否用后释放（**默认 true**；仅当调用方要长期持有正文时才设 false）
     *   · `readMemory` / `maxSingleBytes`：仅 `concurrency > 1` 时用于**读前预检**（不传则用假定上限）
     * @returns {Promise<{results: any[], failed: Array<{item:object, error:string}>, done:number, total:number}>}
     */
    const consumeWorldbookBodies = async (items, consume, opts) => {
        const list = Array.isArray(items) ? items : [];
        const total = list.length;
        const concurrency = Math.max(1, Number(opts && opts.concurrency) || 1);
        const doRelease = !(opts && opts.release === false);
        const onProgress = opts && opts.onProgress;
        const results = new Array(total);
        const failed = [];
        let done = 0;

        const runOne = async (item, index) => {
            try {
                if (item && item.dataLoaded === false && item.path && typeof ensureWorldbookLoaded === 'function') {
                    // batch：不逐本刷日志、不逐本 triggerRef（千本会触发千次侧栏重渲染）
                    await ensureWorldbookLoaded(item, { silent: true, batch: true });
                }
                results[index] = await consume(item, index);
            } catch (e) {
                results[index] = null;
                failed.push({ item, error: e.message });
            } finally {
                // ★ 无论成败都释放 —— 失败时 `dataLoaded` 仍为 false，`releaseWorldbookBody` 天然幂等
                if (doRelease && typeof releaseWorldbookBody === 'function') releaseWorldbookBody(item);
                done++;
                if (onProgress) { try { onProgress(done, total); } catch (e) { /* 忽略 */ } }
            }
        };

        if (concurrency === 1) {
            // 顺序路径：内存峰值最小，且天然「每本之间」有 await 点（主线程可得让出机会）
            for (let i = 0; i < total; i++) {
                await runOne(list[i], i);
                // 每 10 本显式让出一次主线程（`ensureWorldbookLoaded` 是异步 I/O，但算签名等是同步 CPU）
                if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
            }
        } else {
            // 🛡️ 受控并发路径：**滑动窗口前先做读前预检**（§5.3，2026-09-23 补）
            //    📖 顺序路径（concurrency=1）峰值 ≈ 单本，天然安全，无需预检；
            //       但**并发路径**峰值 ≈ `concurrency × 单本` —— 遇超大书会成倍放大
            //       （`wb:meta` 的 8 并发曾是最坏 1.6GB 的盲区）。
            //    ✅ 预检用「磁盘 size × 2.2」估算，超「可用余量 × 0.7」就**拒绝并说明原因**，
            //       而不是等内核杀进程（PK-27 那次连提示的机会都没有）。
            if (typeof preflightRead === 'function') {
                const pf = preflightRead({ files: list, readMemory: opts && opts.readMemory });
                if (!pf.ok) {
                    const msg = pf.reason === 'single-too-large'
                        ? `有 ${pf.oversized.length} 本世界书单本超过 ${Math.round((opts && opts.maxSingleBytes || 50 * 1048576) / 1048576)}MB，`
                          + `并发读取会撑爆内存（预估峰值 ${pf.est.mb}MB）。已中止以避免崩溃。`
                        : `本批共 ${pf.est.count} 本、预估需 ${pf.est.mb}MB，超过可用预算 ${pf.budgetMB}MB（余量 ${pf.availMB}MB）。`
                          + `已中止以避免崩溃。`;
                    throw new Error('[内存预检] ' + msg + (pf.degraded ? '（未能读到内存水位，按假定上限估算）' : ''));
                }
            }
            // 受控并发路径：**滑动窗口**（不是整批 Promise.all —— 那正是 PK-27 的成因）
            let cursor = 0;
            const worker = async () => {
                while (cursor < total) {
                    const i = cursor++;
                    await runOne(list[i], i);
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
        }

        // 批量读完后统一刷新一次（替代逐本 triggerRef）
        if (doRelease && total > 0) triggerRef(worldbooks);
        return { results, failed, done, total };
    };

    // 🖱️ 选中世界书（侧栏点击入口）：超大书先按需读入正文，再设为当前编辑对象
    const selectWorldbook = async (wb) => {
        if (!wb) return;
        if (wb.dataLoaded === false) await ensureWorldbookLoaded(wb);
        activeWorldbook.value = wb;
    };

    // 扫描世界书文件夹（弹目录选择；复用 selectGenericFolder 返回纯路径字符串，selectFolder 返回扫描结果对象不适用）
    const loadWorldbooks = async () => {
        const dirPath = await window.electronAPI.selectGenericFolder();
        if (!dirPath) return;
        // 📊 T2：**先切模式再扫描** —— 进度条挂在世界书视图里，若等扫描结束才切，
        //    用户在整个扫描期间都看不到进度（点了没反应 = 判定坏了，对照 AR-38）。
        appMode.value = 'worldbooks';
        await scanWorldbookDir(dirPath);
    };

    // 扫描指定世界书目录（供手动选择与启动自动恢复共用；自动持久化记忆路径）
    // 🖱️ 语义：这是「**浏览库**」入口 —— 用户点「打开世界书目录」/ 启动自动恢复。
    //    ⚠️ 按用户 2026-09-22 的定性，浏览库**不再显示进度条**（进度条属于查重流程），
    //       改用日志反馈（`addLog`）。真正需要进度的是查重，见 `rescanWorldbooks`。
    const scanWorldbookDir = async (dirPath) => {
        if (!dirPath) return;
        lastWorldbookDirPath.value = dirPath;
        try { localStorage.setItem('jsTavern_lastWbDir', dirPath); } catch (e) { /* 忽略 */ }

        addLog(`开始扫描世界书目录: ${dirPath}`);
        try {
            // ⚡ 秒开（2026-09-22）：**阶段 1 只 readdir + stat**（实测 1001 本 43ms，读内容要 36s）。
            //    📖 向外探索：SillyTavern 的 `/list` 也读文件，但只留 `{file_id,name}` 丢弃 entries；
            //       它够快是世界书少。要做到 1000+ 本秒开，必须**彻底不读内容**。
            //    书名先回退文件名（`wbName` 为 null），词条数未知；阶段 2 后台补齐。
            addLog(`⚡ 正在快速列出目录（只读文件名，不读内容）…`);
            const t0 = performance.now();
            const fast = await window.electronAPI.scanWorldbooks(dirPath, { fastListOnly: true });
            if (!fast || !fast.success) {
                addLog(`扫描失败: ${(fast && fast.error) || '未知错误'}`, 'error');
                nativeAlert(`世界书扫描失败: ${(fast && fast.error) || '未知错误'}`, 'error');
                return;
            }
            const fastMs = Math.round(performance.now() - t0);
            adoptScanResult(fast.data);
            // 📢 PK-24：阶段 1 已能剔除「上次判定为非世界书」的文件（靠缓存），这里报告一下
            reportSkipped('世界书', fast.skipped);
            addLog(`⚡ 秒开完成：${fast.data.length} 本（${fastMs}ms）—— 正在后台读取书名与词条数…`, 'success');
            wbMetaFilling.value = true;
            wbMetaProgress.value = { done: 0, total: fast.data.length };

            // ⚡ 阶段 2（后台，不阻塞首屏）：补全书名 / 词条数，并**校验有效性**（PK-24）
            try {
                const paths = fast.data.filter(w => w.metaPending).map(w => w.path);
                if (paths.length) {
                    window.electronAPI.onWbMetaProgress?.((p) => {
                        if (p && typeof p.done === 'number') {
                            wbMetaProgress.value = { done: p.done, total: p.total };
                        }
                    });
                    // 📦 P2-1（2026-09-23）：**按需分批**（v3 评审 P2-9）
                    //    📖 要解决什么：阶段 2 一次性补全 5000 本要 ~234s，
                    //       期间用户看到的是**一屏文件名**（书名/词条数还是 null）。
                    //    ✅ 做法：**先补前 N 本**（首批立刻可见真书名），
                    //       剩下的**后台静默续补**（不阻塞、不刷日志）。
                    //    ⚠️ 判据不能是「用户滚到哪补到哪」（那需要监听滚动 + 重排列表，
                    //       会把 `worldbooks` 反复 triggerRef → 侧栏抖动）。
                    //       实测更稳的做法是「**固定首批 + 后台全量**」——
                    //       首批大小按「一屏可见数 × 余量」取（侧栏每页最多 115 项）。
                    const FIRST_BATCH = Math.min(paths.length, 120);
                    const firstPaths = paths.slice(0, FIRST_BATCH);
                    const restPaths = paths.slice(FIRST_BATCH);
                    const applyMeta = (data) => {
                        const byPath = new Map(data.map(m => [m.path, m]));
                        // 🛡️ PK-24：阶段 2 会顺带跑 `isValidWorldbook` —— 非世界书（角色卡 / 预设 /
                        //    大表格 / 损坏 JSON）在这里被剔除，不能让它们留在世界书列表里。
                        const invalidPaths = new Set(
                            data.filter(m => m.valid === false).map(m => m.path)
                        );
                        let filled = 0;
                        let l1Count = 0;
                        let oversizedCount = 0;
                        worldbooks.value.forEach(w => {
                            const m = byPath.get(w.path);
                            if (!m) return;
                            if (m.valid === false) return;   // 交给下面统一移除
                            w.wbName = m.wbName;
                            if (typeof m.entryCount === 'number') w.entryCount = m.entryCount;
                            // 🧠 PK-27 / S1'：接收 **L1a 摘要**（供查重直接用，**无需二次读盘**）
                            if (Array.isArray(m.keyHashes)) {
                                w.keyHashes = m.keyHashes;
                                w.keyCount = m.keyHashes.length;
                                w.exactContentHash = m.exactContentHash || null;
                                l1Count++;
                            }
                            // 🧬 S3'（2026-09-23）：接收 **L1b simhash**（默认关闭；有则内容查重免读正文）
                            if (Array.isArray(m.simhash) && m.simhash.length === 2) {
                                w.simhash = m.simhash;
                            }
                            // 🛡️ S1'：超限书（超过体积守卫）—— 标记以便查重 UI 明示（**不静默漏掉**）
                            if (m.oversized) { w.oversized = true; w.sizeBytes = m.size; oversizedCount++; }
                            w.metaPending = false;
                            filled++;
                        });
                        if (invalidPaths.size > 0) {
                            const before = worldbooks.value.length;
                            const removedNames = worldbooks.value
                                .filter(w => invalidPaths.has(w.path))
                                .slice(0, 5)
                                .map(w => w.name)
                                .filter(Boolean);
                            worldbooks.value = worldbooks.value.filter(w => !invalidPaths.has(w.path));
                            // 当前编辑对象若被剔除 → 清空，避免编辑已失效的旧对象
                            if (activeWorldbook.value && invalidPaths.has(activeWorldbook.value.path)) {
                                activeWorldbook.value = null;
                            }
                            const more = invalidPaths.size > 5 ? ` 等 ${invalidPaths.size} 个` : '';
                            addLog(`🛡️ 已从列表剔除 ${before - worldbooks.value.length} 个非世界书文件`
                                + `（${removedNames.join('、')}${more}）`, 'warning');
                        }
                        triggerRef(worldbooks);
                        addLog(`✅ 元数据补齐：${filled} 本（书名 + 词条数 + L1 摘要 ${l1Count} 本）`, 'success');
                        // 📢 PK-26 教训「静默 = 坏了」：超限书**必须可见**
                        if (oversizedCount > 0) {
                            addLog(`⚠️ 有 ${oversizedCount} 本世界书体积超过 50MB，已跳过摘要（它们不会参与指纹查重）`, 'warning');
                        }
                        return { filled, l1Count, oversizedCount, removed: invalidPaths.size };
                    };

                    // 📦 P2-1：**首批**（让用户尽快看到真书名/词条数）
                    // 🛑 回归修复（2026-09-23 实测）：这里**绝不能 `await`** ——
                    //    冷缓存下首批 120 本的 `fetchWorldbookMeta` 要 **5.30s**（实测 s5000），
                    //    `await` 会把「点开目录 → 首屏可用」从 **782ms 拖到 5.51s**（7× 回归）。
                    //    ⇒ 首批与后续**同样**走「不阻塞」路径：**列表先渲染（文件名占位），
                    //      元数据到了再就地更新**（用户看到的是「书名逐个亮起」而不是「转圈等待」）。
                    //    ⚠️ 两批**串行**发起（首批 → 续补），避免 5401 本一次性打满主进程并发。
                    const runBatch = (paths, isFirst) => {
                        if (!paths.length) return Promise.resolve();
                        return window.electronAPI.fetchWorldbookMeta(paths)
                            .then((m) => {
                                if (m && m.success) {
                                    const r = applyMeta(m.data);
                                    if (isFirst && restPaths.length > 0) {
                                        addLog(`⚡ 已优先补齐前 ${paths.length} 本（书名/词条数可见）；`
                                            + `其余 ${restPaths.length} 本将在后台继续补齐…`, 'success');
                                    }
                                }
                            })
                            .catch((e) => {
                                addLog(`⚠️ 元数据补齐失败：${e.message}（部分书名可能仍显示为文件名）`, 'warning');
                            });
                    };
                    // ⚠️ 不 await：列表已由阶段 1 渲染，这里只负责「就地补上书名」
                    runBatch(firstPaths, true)
                        .then(() => runBatch(restPaths, false))
                        .finally(() => {
                            wbMetaFilling.value = false;
                            addLog('✅ 全部元数据补齐完成', 'success');
                        });
                }
            } catch (e) {
                addLog(`⚠️ 元数据后台补齐失败：${e.message}（书名暂用文件名，不影响使用）`, 'warning');
                wbMetaFilling.value = false;
            }
        } finally {
            // 进度对象始终保持 idle（浏览库不占用进度条）
            wbScanProgress.value = { phase: 'idle', done: 0, total: 0, current: '' };
        }
    };

    /**
     * 把 `wb:scan` 的返回结果清洗并装库（浏览扫描 / 查重重扫共用）。
     * 统一清洗：确保每本世界书的 entries 均为纯数组（兼容旧版/第三方工具的对象字典格式）
     * 🛡️ DF-18：heavy（>50MB 未解析）的书 data 为 null，跳过清洗（按需懒加载）
     */
    const adoptScanResult = (data) => {
        if (!Array.isArray(data)) return;
        data.forEach(wb => {
            if (wb.data && wb.data.entries && typeof wb.data.entries === 'object' && !Array.isArray(wb.data.entries)) {
                wb.data.entries = Object.values(wb.data.entries);
            }
        });
        worldbooks.value = data;
        // 【修复】重扫后按路径重绑当前编辑对象，找不到则清空，避免编辑已失效的旧对象
        if (activeWorldbook.value) {
            const prevPath = activeWorldbook.value.path;
            activeWorldbook.value = data.find(w => w.path === prevPath) || null;
        }
    };

    /**
     * 🧠 PK-20：把「累计内联预算」的结果写进日志。
     *
     * 为什么必须让用户看见：超预算的书**仍会出现在列表里**（有 `entryCount:null` + 「按需」徽标），
     * 点开时会按需读入正文。若不给提示，用户会以为「这本书的词条数怎么空了」——
     * 静默降级正是 DF-18 / AR-38 反复踩过的坑。
     */
    const reportInlineBudget = (res) => {
        if (!res || !res.inlineSkipped) return;
        addLog(`🧠 为避免内存溢出，前 ${res.inlineMB || 0}MB 世界书已直接载入；`
            + `其余 ${res.inlineSkipped} 本改为**按需加载**（点开时才读取正文，列表中的词条数显示为「按需」）`,
            'warning');
    };

    /**
     * 🔁 查重 / 版本对比前的**重扫磁盘**（2026-09-22 新增）
     *
     * 为什么需要它：`startWorldbookDedupeScan` 原本直接读内存里已加载的 `worldbooks.value`，
     *   既不保证数据是最新的、也**没有任何可推进的进度**（规格 §185 要求「进度挂到扫描阶段」）。
     *   现在查重先走这里重扫，天然复用 `wb:scan` 的分批进度 → 进度条有真实数据源。
     *
     * @param {string} dirPath 世界书目录（通常传 lastWorldbookDirPath）
     * @returns {Promise<{ok:boolean, count:number, error?:string, skipped?:number}>}
     */
    const rescanWorldbooks = async (dirPath) => {
        if (!dirPath) return { ok: false, count: 0, error: '未设置世界书目录' };
        if (!window.electronAPI || typeof window.electronAPI.scanWorldbooks !== 'function') {
            return { ok: false, count: 0, error: 'preload 缺少 scanWorldbooks 接口' };
        }
        bindWbScanProgress();
        wbScanProgress.value = { phase: 'scanning', done: 0, total: 0, current: '' };
        try {
            // rescan=true：跳过新目录指纹验证（目录必须已在白名单，主进程会二次校验）
            const res = await window.electronAPI.scanWorldbooks(dirPath, { rescan: true });
            if (!res || !res.success) {
                return { ok: false, count: 0, error: (res && res.error) || '未知错误' };
            }
            adoptScanResult(res.data);
            reportInlineBudget(res);
            reportSkipped('世界书', res.skipped);
            return { ok: true, count: res.data.length, skipped: (res.skipped || []).length };
        } catch (e) {
            return { ok: false, count: 0, error: e.message };
        } finally {
            // 无论成败都收起进度条（失败时弹窗会给出错误，不会永久停在中间）
            wbScanProgress.value = { phase: 'idle', done: 0, total: 0, current: '' };
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
        const oldName = wbDisplayName(wb).replace(/\.json$/i, '');
        const newName = await appPrompt('✏️ 请输入新的世界书名称：', oldName);
        if (newName === null || newName.trim() === '' || newName.trim() === oldName) return;
        const finalName = newName.trim();

        // 更新世界书内部名称（列表与 IDE 标题即时生效）
        // ⚡ PK-26：秒开后 `wb.data` 可能为 null（懒加载）→ **必须同时写轻量字段 `wbName`**，
        //    否则懒加载书的改名在列表/标题里完全不生效（旧写法只在 `wb.data` 存在时写）。
        wb.wbName = finalName;
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
                    migrateWbPathKeys(prevKey, wb.path); // 🏷️ S4：分组 + 标签键随文件路径迁移（铁律 6）
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
            migrateWbPathKeys(prevKey, wb.name); // 🏷️ S4：分组 + 标签键随文件名迁移
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
        // ⚡ PK-26：书名走轻量 `wbDisplayName`（秒开后 `wb.data` 为 null，直读会回退成文件名）
        const displayName = wbDisplayName(wb) || '未命名世界书';
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
        // 🛑 PK-26：秒开后 `wb.data` 为 null → 旧写法 `JSON.stringify(wb.data || {})` 会
        //    **静默产出「空世界书」副本**（词条全丢，用户以为复制坏了）。必须先载入正文。
        await ensureWorldbookLoaded(wb);
        if (!wb.data || typeof wb.data !== 'object') {
            addLog(`❌ 复制失败：无法读取《${wbDisplayName(wb)}》的正文（${wb._loadError || '未知原因'}）`, 'error');
            nativeAlert(`复制失败：无法读取《${wbDisplayName(wb)}》的正文。\n请重新选择世界书目录后再试。`, 'error');
            return;
        }
        const sourceName = wbDisplayName(wb) || '未命名世界书';
        const cloneName = `${sourceName} - 副本`;
        const cloneData = JSON.parse(JSON.stringify(wb.data));
        cloneData.name = cloneName;

        // ✅ [补丁] 深度遍历清洗：重新生成所有词条的唯一 UID，防止与母本冲突
        // 🆔 DF-21（2026-09-23）：统一为本应用标准形态 `<Date.now()>_<base36>` ——
        //    旧写法 `Date.now() + Math.random().toString(36).substring(2,9)` 是**字符串拼接**，
        //    产出无下划线的 20 字符串，与其余 8 处生成点格式不一致（DF-21 形态判定会漏掉它）。
        if (cloneData && Array.isArray(cloneData.entries)) {
            cloneData.entries.forEach(entry => {
                entry.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
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
        // 🏷️ S4：物理分组为唯一标准——副本与源书同目录即**自然继承**分组；
        //    仅当副本落到了其他目录（用户改选保存位置）才需要虚拟映射兜底（迁移期兼容）。
        const srcCat = getWbCategory(wb);
        const srcFolder = wbFolderGroupOf(wb);
        if (srcCat && srcCat.trim() !== '' && srcCat !== WB_CAT_DEFAULT && wbFolderGroupOf(newWb) !== srcFolder) {
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
            addLog(`📁 已在资源管理器中定位: ${wbDisplayName(wb) || wb.name}`, 'info');
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

    // ═══════════════════════════════════════════════════════════════
    // 📁 S4（2026-09-25）：世界书**物理分组**（Q6 甲：物理文件夹为唯一标准）
    // ───────────────────────────────────────────────────────────────
    // 口径（用户拍板 · 方案 §二D）：
    //   · 扫描时由**相对路径**推导分组（一级子文件夹名 = 分组名；库根 = 无分组 → 显示「默认」）
    //   · `wbCategoryMap` 迁移期保留**兼容读取**；迁移助手把存量虚拟分组物理化后清空
    //   · 移动 / 改名 / 解散全部为**物理操作**（wb:rename / fs:renameGroupFolder / fs:deleteEmptyGroupFolder）
    //   · 移动必须迁移按 path 派生的键（wbTagMap / wbCategoryMap）——铁律 6
    // ═══════════════════════════════════════════════════════════════

    /** 路径分隔符归一（比较用） */
    const normWbSep = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

    /** 分组名 → 文件夹名（与主进程 `fs:*` 净化规则逐字一致，防预览/执行不一致） */
    const sanitizeWbFolderName = (name) => String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').trim();

    /**
     * 世界书在库内的物理**一级文件夹名**：
     *   ''    = 在库根（未分组）；null = 无库根 / 不在当前库内（外部路径，分组推导不适用）
     */
    const wbFolderGroupOf = (wb) => {
        const root = normWbSep(lastWorldbookDirPath && lastWorldbookDirPath.value);
        const p = normWbSep(wb && wb.path);
        if (!root || !p) return null;
        if (p === root) return '';
        if (!p.startsWith(root + '/')) return null;
        const rest = p.slice(root.length + 1);
        const segs = rest.split('/');
        return segs.length >= 2 ? segs[0] : '';
    };

    /** 迁移**按路径派生**的全部持久化键（分组 + 标签）—— 移动/改名共用，缺一不可（铁律 6） */
    const migrateWbPathKeys = (oldKey, newKey) => {
        if (!oldKey || !newKey || oldKey === newKey) return;
        // 分组键
        if (wbCategoryMap.value[oldKey] !== undefined) {
            wbCategoryMap.value[newKey] = wbCategoryMap.value[oldKey];
            delete wbCategoryMap.value[oldKey];
        }
        // 🏷️ 标签键（A2 遗留缺口：此前改名只迁分组、标签键会丢——S4 一并修）
        if (wbTagMap && wbTagMap.value && wbTagMap.value[oldKey] !== undefined) {
            wbTagMap.value[newKey] = wbTagMap.value[oldKey];
            delete wbTagMap.value[oldKey];
        }
        saveWbCategoriesMap();
    };

    // 获取世界书分组：**物理一级目录**（甲）→ `wbCategoryMap` 兼容 → '默认'
    // 🏷️ S4 改造说明：与旧版（内存 category → map → '默认'）的顺序不同 ——
    //    物理文件夹为唯一标准；map 仅服务「迁移完成前」的存量虚拟分组（迁移助手会清空它）。
    const getWbCategory = (wb) => {
        if (!wb) return WB_CAT_DEFAULT;
        const folder = wbFolderGroupOf(wb);
        if (folder) return folder; // 物理已分组 → 它说话（即使 map 还有陈旧值）
        const key = wb.path || wb.name || '';
        if (key && wbCategoryMap.value[key] && wbCategoryMap.value[key].trim() !== '') {
            return wbCategoryMap.value[key].trim(); // 过渡期兼容：物理未分组但有虚拟映射
        }
        return WB_CAT_DEFAULT;
    };

    /**
     * 🚚 S4（核心原语）：把世界书物理移动到目标分组文件夹（根 = 移回库根）。
     * 含：目标夹创建（幂等）→ wb:rename → 同名冲突自动后缀 → 键迁移（分组+标签）→ 响应式触发。
     * @param {object} wb 世界书对象
     * @param {string} groupName 目标分组名（'默认'/'全部'/空 = 库根）
     * @returns {Promise<boolean>} 是否成功（已在目标位置也算成功）
     */
    const moveWbToFolder = async (wb, groupName) => {
        if (!wb) return false;
        if (!wb.path) {
            nativeAlert('该世界书尚无本地文件（内存导入），无法物理移动。可先「💾 落盘」再移动。', 'warning');
            return false;
        }
        const root = (lastWorldbookDirPath && lastWorldbookDirPath.value) || '';
        if (!root) { nativeAlert('未设置世界书目录，无法物理移动。', 'warning'); return false; }
        if (!window.electronAPI || typeof window.electronAPI.renameWorldbookFile !== 'function') {
            nativeAlert('当前环境不支持物理移动。', 'warning');
            return false;
        }
        const isRootTarget = !groupName || groupName === WB_CAT_DEFAULT || groupName === WB_CAT_ALL;
        const safe = isRootTarget ? '' : sanitizeWbFolderName(groupName);
        if (!isRootTarget && !safe) { nativeAlert('分组名无效。', 'warning'); return false; }

        // 已在目标位置 → 幂等成功
        const cur = wbFolderGroupOf(wb);
        if (isRootTarget ? !cur : cur === safe) return true;

        try {
            if (!isRootTarget && typeof window.electronAPI.createGroupFolder === 'function') {
                const mk = await window.electronAPI.createGroupFolder({ libraryPath: root, groupName: safe });
                if (!mk || !mk.success) {
                    addLog(`⚠️ 创建分组文件夹失败: ${(mk && mk.error) || '未知错误'}`, 'warning');
                    return false;
                }
            }
            const oldPath = wb.path; // 键迁移的旧键基准
            const sep = oldPath.includes('\\') ? '\\' : '/';
            const fileName = oldPath.split(/[\\/]/).pop();
            const targetDir = isRootTarget ? root : `${root}${sep}${safe}`;
            let newPath = `${targetDir}${sep}${fileName}`;

            let res = await window.electronAPI.renameWorldbookFile({ oldPath, newPath });
            // 同名冲突：目标已存在 → 追加「_移动_时间戳」后缀重试（对齐卡片 moveCardToGroup 行为，绝不覆盖）
            if (!res || !res.success) {
                const errText = String((res && res.error) || '');
                if (/已存在/.test(errText)) {
                    const base = fileName.replace(/\.json$/i, '');
                    newPath = `${targetDir}${sep}${base}_移动_${Date.now()}.json`;
                    res = await window.electronAPI.renameWorldbookFile({ oldPath, newPath });
                }
            }
            if (!res || !res.success) {
                addLog(`⚠️ 移动失败: ${(res && res.error) || '未知错误'}`, 'warning');
                return false;
            }

            // 更新内存对象 + 键迁移（分组 + 标签）
            wb.path = newPath;
            wb.name = newPath.split(/[\\/]/).pop();
            // 物理化后清掉该书的虚拟映射残留（物理已是唯一标准）
            const oldKeyCat = oldPath || wb.name;
            if (wbCategoryMap.value[oldKeyCat] !== undefined) delete wbCategoryMap.value[oldKeyCat];
            migrateWbPathKeys(oldKeyCat, newPath);
            triggerRef(worldbooks); // shallowRef：path 变更手动触发响应式
            return true;
        } catch (e) {
            addLog(`⚠️ 移动异常: ${e.message}`, 'warning');
            return false;
        }
    };

    /**
     * 📦 S4：把存量**虚拟分组**（wbCategoryMap）一次性物理化，随后清空映射表。
     * 入口：🗂️ 世界书自动分组窗口「📋 收纳规则」页底部（迁移助手）。
     * @param {{skipConfirm?:boolean}} [opts] `skipConfirm=true` 仅 dev 端到端验收使用（不弹窗）
     */
    const migrateVirtualGroupsToFolders = async (opts = {}) => {
        const quiet = !!(opts && opts.skipConfirm); // ⚠️ 仅 dev 端到端验收使用；产品路径永远走确认框
        const entries = Object.entries(wbCategoryMap.value || {})
            .filter(([, v]) => v && String(v).trim() && String(v).trim() !== WB_CAT_DEFAULT);
        if (!entries.length) {
            if (!quiet) nativeAlert('没有需要迁移的虚拟分组记录（wbCategoryMap 为空或仅「默认」）。', 'info');
            else console.log('[S4·e2e] 迁移：无记录');
            return { moved: 0, failed: 0 };
        }
        if (!quiet) {
            const ok = await confirmDialog(
                `将把 ${entries.length} 条虚拟分组记录**物理化**：\n`
                + `对应世界书会被移动到同名子文件夹（资源管理器可见），完成后清空虚拟映射表。\n\n`
                + `仅涉及文件位置移动，不改任何世界书内容。是否继续？`
            );
            if (!ok) return { moved: 0, failed: 0 };
        }
        let moved = 0;
        let failed = 0;
        const byKey = new Map();
        for (const wb of worldbooks.value) {
            if (wb && wb.path) byKey.set(wb.path, wb);
            if (wb && wb.name && !byKey.has(wb.name)) byKey.set(wb.name, wb);
        }
        for (const [key, group] of entries) {
            const wb = byKey.get(key);
            if (!wb) continue; // 书已不在（被删/改名）→ 跳过，清映射时一并消失
            const okMove = await moveWbToFolder(wb, String(group).trim());
            if (okMove) moved++; else failed++;
        }
        // 清空映射表（含失败项：物理状态即真相；失败项会自然回落「默认」，不会丢书）
        wbCategoryMap.value = {};
        saveWbCategoriesMap();
        addLog(`📦 虚拟分组迁移：移动 ${moved} 本${failed ? `，失败 ${failed} 本` : ''}（映射表已清空）`, failed ? 'warning' : 'success');
        if (quiet) console.log('[S4·e2e] 虚拟分组迁移完成', JSON.stringify({ moved, failed }));
        else nativeAlert(`📦 虚拟分组已物理化：成功移动 ${moved} 本${failed ? `，${failed} 本失败（保持原位）` : ''}。`, failed ? 'warning' : 'info');
        return { moved, failed };
    };

    // 1. 自动提取所有分组（Set 去重；'默认' 始终保留；无书的分类自动消失）
    const wbCategories = computed(() => {
        const categories = new Set([WB_CAT_DEFAULT]);
        worldbooks.value.forEach(wb => {
            const cat = getWbCategory(wb);
            if (cat && cat.trim() !== '') categories.add(cat.trim());
        });
        // 🚩 A2：**不得**把视图哨兵「全部」列为一个分组（它表示"不过滤"，不是真实分组）
        categories.delete(WB_CAT_ALL);
        return Array.from(categories);
    });

    // ═══════════════════════════════════════════════════════════════
    // 🏷️ A2（2026-09-24）：世界书**标签**（存在配置层，与分组同源）
    // ───────────────────────────────────────────────────────────────
    // 📌 已拍板：**独立世界书标签留在系统配置**（不写进世界书文件）——
    //    理由见 `js/utils/wbGroupsTags.js` 文件头（用户明确选择：角色卡随卡片走，世界书留配置）。
    //    ⇒ 因此**不需要**新 IPC / 不产快照 / 不碰第三方格式（原方案要写 extensions.jskzx，已否决）。
    // ═══════════════════════════════════════════════════════════════

    /** 取某本书的标签（数组，已规范化去重） */
    const getWbTags = (wb) => {
        if (!wb) return [];
        // 内存优先（本轮改动即时生效），否则读配置层
        if (Array.isArray(wb.tags)) return normalizeWbTags(wb.tags);
        const key = wb.path || wb.name || '';
        if (key && wbTagMap && wbTagMap.value && Array.isArray(wbTagMap.value[key])) {
            return normalizeWbTags(wbTagMap.value[key]);
        }
        return [];
    };

    /** 写某本书的标签（内存 + 配置层双写，与分组同款） */
    const setWbTags = (wb, tags) => {
        if (!wb) return [];
        const next = normalizeWbTags(tags);
        wb.tags = next;
        const key = wb.path || wb.name || '';
        if (key && wbTagMap && wbTagMap.value) {
            if (next.length) wbTagMap.value[key] = next;
            else delete wbTagMap.value[key];      // 空数组不留残key（防配置膨胀）
        }
        // 📌 S1（2026-09-25）：`wb.tags` 在 shallowRef 的世界书对象上**不触发响应式**；
        //    而 `getWbTags` 内存优先短跏 `wb.tags` 后不再访问 `wbTagMap.value[key]`
        //    ⇒ 计算属性（列表/筛选/统计）在「删空后再添加」场景会收集不到依赖 → 界面不刷新。
        //    统一在本写入出口手动触发，一处修全（手动编辑 / 批量 / 打标全部覆盖）。
        triggerRef(worldbooks);
        return next;
    };

    /** 切换一个标签（有则删、无则加）—— 供 UI 点击标签使用 */
    const toggleWbTagOn = (wb, tag) => {
        const next = toggleWbTag(getWbTags(wb), tag);
        setWbTags(wb, next);
        saveWbCategoriesMap();     // 与分组共用同一个持久化出口（配置层）
        return next;
    };

    /** 只加不删地添加一个标签（供标签编辑器输入框 / 建议点击使用；已存在则保持原样） */
    const addWbTagOn = (wb, tag) => {
        const n = normalizeWbTag(tag);
        if (!wb || !n) return getWbTags(wb);
        const next = normalizeWbTags([...getWbTags(wb), n]);
        setWbTags(wb, next);
        saveWbCategoriesMap();
        return next;
    };

    /** 移除一个标签（供标签编辑器 ✕ 使用） */
    const removeWbTagOn = (wb, tag) => {
        const n = normalizeWbTag(tag);
        if (!wb || !n) return getWbTags(wb);
        const next = getWbTags(wb).filter(t => t !== n);
        setWbTags(wb, next);
        saveWbCategoriesMap();
        return next;
    };

    /** 给多本书批量加标签（供批量操作） */
    const addWbTagsBatch = (list, tag) => {
        const n = normalizeWbTag(tag);
        if (!n) return 0;
        let count = 0;
        for (const wb of (list || [])) {
            const next = normalizeWbTags([...getWbTags(wb), n]);
            if (next.length !== getWbTags(wb).length) count++;
            setWbTags(wb, next);
        }
        if (count) saveWbCategoriesMap();
        return count;
    };

    /** 全库标签清单（含使用频次，按热度降序）—— 供标签选择器 */
    const wbAllTags = computed(() => countWbTags(worldbooks.value.map(wb => getWbTags(wb))));

    // ═══════════════════════════════════════════════════════════════
    // 📁 A2：分组**生命周期**（显式重命名 / 删除入口 —— 规格 §〇-#6 指出「缺的只有入口」）
    // ───────────────────────────────────────────────────────────────
    // 📌 级联逻辑（改 `wbCategoryMap` 键、清 map、移空回落）**早已存在**（在
    //    `renameWorldbook` / `deleteWorldbook` 里），此处只补「**显式**对整组操作」的入口。
    // ═══════════════════════════════════════════════════════════════

    /**
     * 📁 重命名分组（级联全组）—— 🏷️ S4：**物理版**
     * 物理夹在 → fs:renameGroupFolder 整体改名 + 内存 path 前缀替换 + 键迁移；
     * 纯虚拟成员（迁移期）→ 仅改映射值。
     * @param {string} oldName 现分组名
     * @returns {Promise<number>} 实际改动的书本数（0 = 未改动）
     */
    const renameWbGroup = async (oldName) => {
        const from = normalizeWbCategoryName(oldName);
        if (!from || from === WB_CAT_ALL) {
            nativeAlert('不能重命名「全部」（它是视图筛选，不是真实分组）。', 'warning');
            return 0;
        }
        const physicalMembers = worldbooks.value.filter(w => getWbCategory(w) === from && wbFolderGroupOf(w) === from);
        const virtualMembers = worldbooks.value.filter(w => getWbCategory(w) === from && wbFolderGroupOf(w) !== from);
        const newRaw = await appPrompt(
            `📁 重命名分组「${from}」\n\n请输入新名称（组内共 ${physicalMembers.length + virtualMembers.length} 本书一起迁移）：\n`
            + (physicalMembers.length ? `· ${physicalMembers.length} 本在物理文件夹内（文件夹将整体重命名）\n` : '')
            + (virtualMembers.length ? `· ${virtualMembers.length} 本为虚拟分组记录（仅改映射）` : ''),
            from
        );
        if (newRaw === null) return 0;
        const v = validateWbCategoryName(newRaw, { existing: wbCategories.value, self: from });
        if (!v.ok) { nativeAlert(`❌ ${v.reason}`, 'error'); return 0; }
        const to = v.name;
        if (to === from) return 0;
        const root = (lastWorldbookDirPath && lastWorldbookDirPath.value) || '';
        let n = 0;
        // ① 物理文件夹整体重命名（一次 IPC）→ 内存逐本 path 前缀替换 + 键迁移
        if (physicalMembers.length && root && window.electronAPI && typeof window.electronAPI.renameGroupFolder === 'function') {
            const res = await window.electronAPI.renameGroupFolder({ libraryPath: root, oldName: from, newName: to });
            if (res && res.success) {
                for (const wb of physicalMembers) {
                    const oldPath = wb.path;
                    const sep = oldPath.includes('\\') ? '\\' : '/';
                    const rootS = root.replace(/[\\/]/g, sep);
                    const prefixLen = (rootS + sep + from).length;
                    const newPath = rootS + sep + to + oldPath.slice(prefixLen);
                    wb.path = newPath;
                    migrateWbPathKeys(oldPath, newPath);
                    n++;
                }
                triggerRef(worldbooks);
            } else {
                addLog(`⚠️ 分组文件夹重命名失败: ${(res && res.error) || '未知错误'}`, 'warning');
                nativeAlert(`物理文件夹重命名失败: ${(res && res.error) || '未知错误'}`, 'error');
                return 0;
            }
        }
        // ② 纯虚拟成员（迁移期）：改映射值
        for (const wb of virtualMembers) {
            const key = wb.path || wb.name || '';
            if (key) wbCategoryMap.value[key] = to;
            n++;
        }
        // ③ 同步映射表中的陈旧值（防残留）
        for (const [k, val] of Object.entries(wbCategoryMap.value)) {
            if (val === from) wbCategoryMap.value[k] = to;
        }
        saveWbCategoriesMap();
        if (currentWbCategory.value === from) currentWbCategory.value = to;
        addLog(`📁 分组「${from}」已重命名为「${to}」（${n} 本）`, 'success');
        return n;
    };

    /**
     * 🗑️ 解散分组—— 🏷️ S4：**物理版**（组内全部移回库根 + 删空夹）
     * ⚠️ **只解散分组，不删书** —— 必须让用户明确知道（二次确认文案写清）。
     * @param {string} name 分组名
     * @returns {Promise<number>} 回落的书本数
     */
    const deleteWbGroup = async (name) => {
        const target = normalizeWbCategoryName(name);
        if (!target || target === WB_CAT_ALL || target === WB_CAT_DEFAULT) {
            nativeAlert('「全部」「默认」不能删除。', 'warning');
            return 0;
        }
        const members = worldbooks.value.filter(w => getWbCategory(w) === target);
        const ok = await confirmDialog(
            `确定解散分组「${target}」吗？\n\n组内 ${members.length} 本世界书会移回库根（不再受该分组筛选），`
            + `**不会删除任何世界书**。`
        );
        if (!ok) return 0;

        let n = 0;
        const root = (lastWorldbookDirPath && lastWorldbookDirPath.value) || '';
        for (const wb of members) {
            const folder = wbFolderGroupOf(wb);
            if (folder === target) {
                const okMove = await moveWbToFolder(wb, ''); // 物理移回库根
                if (okMove) n++;
            } else {
                // 纯虚拟成员：删映射即可
                const key = wb.path || wb.name || '';
                if (key && wbCategoryMap.value[key]) delete wbCategoryMap.value[key];
                n++;
            }
        }
        // 清理映射中该组的全部残留
        for (const [k, val] of Object.entries(wbCategoryMap.value)) {
            if (val === target) delete wbCategoryMap.value[k];
        }
        // 删空文件夹（非空会被主进程拒绝，不影响书籍安全）
        if (root && window.electronAPI && typeof window.electronAPI.deleteEmptyGroupFolder === 'function') {
            try { await window.electronAPI.deleteEmptyGroupFolder({ libraryPath: root, groupName: target }); } catch (e) { /* 忽略 */ }
        }
        saveWbCategoriesMap();
        if (currentWbCategory.value === target) currentWbCategory.value = WB_CAT_ALL;
        addLog(`🗑️ 分组「${target}」已解散（${members.length} 本移回库根）`, 'warning');
        return members.length;
    };

    // 3. 修改世界书分组（自建弹窗替代 Electron 不支持的 prompt）—— 🏷️ S4：**物理移动**
    const changeWbCategory = async (wb) => {
        if (!wb) return;
        const displayName = wbDisplayName(wb) || '未命名世界书';
        const currentCat = getWbCategory(wb);
        const newCat = await appPrompt(
            `📁 将《${displayName}》移动到分组（**物理移动文件**）\n\n请输入目标分组名称（当前：${currentCat}）：\n提示：输入全新名字将自动创建同名文件夹；输入「默认」移回库根。`,
            currentCat === WB_CAT_DEFAULT ? '' : currentCat
        );
        if (newCat === null) return;
        // 移动校验：允许移入已存在的分组（与重命名不同——目标已存在正是「移进去」）
        const name0 = normalizeWbCategoryName(newCat);
        if (!name0) { nativeAlert('分组名不能为空。', 'warning'); return; }
        if (name0 === WB_CAT_ALL) { nativeAlert('「全部」是本应用保留的视图名称，不能用作分组名。', 'warning'); return; }
        const okMove = await moveWbToFolder(wb, name0);
        if (okMove) {
            addLog(`📁 已将《${displayName}》移动到分组: ${name0 === WB_CAT_DEFAULT ? '默认（库根）' : name0}`, 'info');
            // 若当前筛选的分组已被移空，自动回落"全部"避免空列表困惑
            if (currentWbCategory.value !== WB_CAT_ALL && currentWbCategory.value !== name0) {
                const stillHas = worldbooks.value.some(w => getWbCategory(w) === currentWbCategory.value);
                if (!stillHas) currentWbCategory.value = WB_CAT_ALL;
            }
        }
    };

    // 计算属性：世界书列表筛选（搜索 + 词条数过滤 + 📁 分组过滤 + 🏷️ 标签过滤）
    // 🏷️ A2：复合过滤判定抽到纯函数 `matchWbFilter`（可单测；语义见规格 TC-WB-05）
    const filteredWorldbooks = computed(() => {
        return worldbooks.value.filter(wb => {
            const name = wbDisplayName(wb).toLowerCase();
            const matchesSearch = !wbSearchQuery.value || name.includes(wbSearchQuery.value.toLowerCase());

            // ⚡ PK-26：秒开后 `wb.data` 为 null（懒加载）→ 词条数**必须走轻量 `wbEntryCount`**，
            //    否则「1-15条 / 15+条 / 空书」三个筛选器恒判定为空（用户报的「依旧从 0 开始依旧是 0」）。
            const entryCount = wbEntryCount(wb);
            let matchesCount = true;
            if (wbFilterType.value === 'empty') matchesCount = entryCount === 0;
            else if (wbFilterType.value === 'small') matchesCount = entryCount > 0 && entryCount <= 15;
            else if (wbFilterType.value === 'large') matchesCount = entryCount > 15;

            return matchWbFilter({
                bookCategory: getWbCategory(wb),
                bookTags: getWbTags(wb),
                filterCategory: currentWbCategory.value,
                filterTags: currentWbTags ? currentWbTags.value : [],
                matchesSearch,
                matchesCount
            });
        });
    });

    return {
        importUrl, isImportingWb, wbContextMenu,
        loadWorldbooks, scanWorldbookDir, importWorldbookFromUrl, renameWorldbook,
        handleWorldbookFolderSelect, deleteWorldbook, duplicateWorldbook,
        openWbContextMenu, closeWbContextMenu, openWbInFolder,
        wbCategories, changeWbCategory, filteredWorldbooks,
        // 🏷️ A2（2026-09-24）：世界书标签 + 分组生命周期（重命名 / 解散）
        getWbTags, setWbTags, toggleWbTagOn, addWbTagOn, removeWbTagOn, addWbTagsBatch, wbAllTags,
        renameWbGroup, deleteWbGroup,
        // 📁 S4（2026-09-25）：物理分组（Q6 甲）——移动原语 + 物理分组推导 + 虚拟分组迁移助手
        getWbCategory, moveWbToFolder, wbFolderGroupOf, sanitizeWbFolderName, migrateVirtualGroupsToFolders,
        // 📊🔍 查重/版本对比的扫描进度（不再用于浏览库）
        wbScanProgress, isWbScanning, wbScanPercent, rescanWorldbooks,
        // ⚡ 秒开阶段 2：元数据后台补齐状态
        wbMetaFilling, wbMetaProgress,
        // 📢 DF-18：跳过可见化 + 超大书懒加载
        reportSkipped, wbEntryCount, wbDisplayName, ensureWorldbookLoaded, selectWorldbook,
        // ⚡ PK-26 后续：批量流程（查重）用后释放正文，防 OOM
        releaseWorldbookBody,
        // 🧯 PK-27：**唯一**的「批量读正文」入口（受控并发 + 用后释放 + 进度回调）
        consumeWorldbookBodies,
        // 🧠 PK-27 / S1'：L1 摘要消费（**查重只读索引，永不重读正文**）
        hasKeyIndex, compareKeyHashes, isExactSame
    };
}