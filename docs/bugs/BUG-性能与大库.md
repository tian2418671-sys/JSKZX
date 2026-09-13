# PK · BUG 记录 — 性能 / 大库 / 内存 / 索引

> 领域：万卡级库的加载、刷新、搜索、内存与磁盘 I/O。
> 测试库基准：`I:\03\角色色卡` = **11,186 张卡 / 9.76GB**（11,667 文件）；2 万卡副本由 `scripts/capacity-check.ps1` 现造（22,372 张 / 19.85GB）。
> 实测数据表见 [`../技术支持/技术数据-大库压测与性能.md`](../技术支持/技术数据-大库压测与性能.md)；总索引见 [`README.md`](README.md)。

---

## 一、重复卡 / 库消失 / 崩溃（PK-01 ~ PK-03、PK-09）

### PK-01 ｜ 🔴 搜索后刷新，同一张卡重复出现
- **现象**：中文单字搜索 → 刷新 → 列表里同一张卡出现两次。
- **根因**：`searchIndex` 的 `build/buildAsync` **多轮全量重建重叠** —— 只在自己开头 `clear()`，**既无代次保护，也无「同对象只索引一次」保证**。刷新期间 `watch(library)` 被反复触发（数组引用替换 + 每张新解析卡 `triggerRef`）→ 旧对象在新构建 `clear()` 之后又被写回；同一对象被两个循环各 push 一次。**只有「精确 token」分支会原样返回倒排桶** → 所以中文单字搜索最容易看到（英文多词走兜底分支自带身份去重）。
- **修复**（`js/utils/searchIndex.js`、`js/components/App.vue`）：
  1. `generation` 代次号（在途构建自检退出）；
  2. 索引幂等（`cards.has(card)` 直接 return）；
  3. `search()` 结果 `[...new Set(results)]`；
  4. App 侧 `indexBuilding / indexDirty` **合并重建**（在途只记一次补建，绝不重叠）。
- **验证**：
  - 单测 `test/searchIndex.test.mjs` **7 项**（含「构建期间搜索返回上一代完整索引」双缓冲用例）✅
  - `scripts/library-dup-search-refresh.mjs` A~F 全阶段 `dup(lib)=0 / dup(list)=0`，库稳定 11,186 ✅
  - 生产模式真实界面复测（搜「龙」/「的」→ 刷新 → 再搜）列表 `dup=0` ✅
  - 重建合并实测计数：`watch: 80 → coalesced: 77 → start: 4 → done: 3`（80 次库变动只真跑 4 次重建）
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-1；`docs/history/大库重复卡-压测数据记录.md` §八

### PK-02 ｜ 🔴 刷新后整个大库从界面消失
- **现象**：刷新后列表空了（磁盘未动），必须重启才回来。也解释了历史上「刷新中途只剩 478 张」的不完整计数。
- **根因**：主进程扫描 catch 分支返回 `{files: [], error}`，渲染层 `if (result && result.files)` 把**空数组当真值** → `library.value = []`。
- **修复**（`js/composables/useDiskScan.js`）：先判 `result.error` 提前返回；库非空时**拒绝接受 0 文件结果**并提示。
- **验证**：连点刷新 ×6 库始终 11,186 张 ✅
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-2

### PK-03 ｜ 🔴 刷新/搜索时渲染进程 OOM 崩溃
- **现象**：`render-process-gone {"reason":"oom","exitCode":-536870904}`，崩溃后 Electron 兜底**自动 reload**。
- **根因**：索引为每张卡**常驻一份小写全文**（11,186 卡 ≈531MB 字符，中文 UTF-16 更高）→ 加载完堆即 3.0GB / 上限 4.19GB，刷新重建再分配一份 + 并发重入。
- **修复（三层）**：
  1. 索引不再保留文本（`_extractText` 按需复算）+ 单卡上限 `MAX_INDEX_TEXT = 200000`；
  2. 重建合并（同 PK-01）；
  3. **P1a 正文懒加载**（`js/utils/cardSlim.js`）：列表态释放世界书词条正文与 `alternate_greetings`，开卡时才读回。
- **验证**：堆基线 3,039MB → 2,013MB；22,372 卡库实测 2,891MB → **2,053MB**，`crash.log` **无新增** ✅
- **⚠️ 因果链（重要）**：崩溃兜底 1.5s 后 `win.reload()` → 新页面又全量加载 → 若此刻还有在途的加载/刷新 → **并发重入** → 同一 path 入两条 → 重复卡。**这解释了为什么用户只在「大库 + 反复刷新/搜索」时看到重复卡**（小库不会 OOM，走不到这条链）。
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-3；`docs/history/大库重复卡-压测数据记录.md` §6.2/§6.3

### PK-09 ｜ 🟡 移动版刷新期间卡片重复出现【移动版】
- **现象**：下拉刷新后加载过程中同一张卡在列表出现 2 次，扫描完成后恢复；搜索/排序在扫描期间返回翻倍结果。
- **根因**：`loadLibrary(refresh=true)` 全量重扫开始时**没有清空** `mobileLibrary.library`，渐进上屏的 `publishProgress()` 把新解析的卡 `push` 到仍含上次结果的数组上。
- **修复**：重扫开始前先 `mobileLibrary.library = []`。
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-10

---

## 二、加载慢与写盘风暴（PK-04、PK-07、PK-08）

### PK-04 ｜ 🔴 库加载 79.9s —— 每次启动重写数千张 PNG（无限循环）
- **现象**：同库此前 22.5s，后来变成 79.9s；每次启动日志都有 `⏳ 后台落盘自动打标卡片: 3,415 张`。
- **根因**：写盘判据看「**清洗后**的内存状态」：
  ```
  加载 → 盘上有作者标签 → 「🧹 导入时忽略卡片自带标签」开关把它清空 → 判定"需要物理清洗" → 写回 PNG（把 customTags 写回）
       → 下次启动：这些 customTags 又成了"原生标签" → 又被清空 → 又判定需要写盘 → …… 无限循环
  ```
  代价：每次启动重写 3,415 张 PNG（含整图读回 + 重写 + 快照备份），mtime 全变 → 下次刷新按 mtime 差分又全量重解析。
- **修复**（`js/composables/useCardCrud.js`）：改为按「**磁盘原有标签**」（`diskTagsBefore`）判定 —— 只有「盘上真存在不该保留的标签」或「确有新标签要补」才写盘；写盘内容也改成幂等。
- **验证**：`3,415 张` → `971 张`（一次性残留清洗）→ **第 2 次启动 0 张**；加载 **79.9s → 41~43s**（≈1.85×）。
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-4；`docs/history/大库重复卡-压测数据记录.md` §九

### PK-07 ｜ 🟡 PNG 内嵌提取缓存是**负优化** + 遗留缓存无人清理
- **现象**：为了提速加了 PNG 内嵌 JSON 分片缓存，实测**反而慢 2~5 倍**；同时 userData 里堆了 24 个 `0 字节 embed_cache_*.tmp` 与 1.17GB 缓存。
- **根因**：从 PNG 头部提取内嵌 JSON 本身只要 ~3s（自适应窗口 + 128 路并发 + 按需流式，GC 可回收）；而缓存会把约 1.2GB 的**对象**一次性常驻主进程 → 堆压力/GC 抖动 + 额外 IPC 克隆。压缩（gzip）只减磁盘与读取量，**消不掉"对象常驻"这个根因**（v2 比 v1 更慢）。`v8.deserialize` 产出 dictionary-mode 对象，跨 IPC 更慢。
- **修复**：删除整块缓存实现（**-173 行**）+ 新增 `cleanupLegacyEmbedCache()` 启动时一次性回收历史缓存（本机 **44 文件 / 758MB**），用 `.embed_cache_removed` 标记保证只扫一次目录。
- **同因同类**：`atomicWriteJson` 中途失败留下的 0 字节 `.tmp`，`cleanupStaleConfigTmp` 原先没覆盖 `embed_cache*`。
- **经验**：**不要为「本来就便宜」的数据加磁盘缓存** —— 先量"重算成本"再量"缓存加载成本"。
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-10；`docs/history/大库重复卡-压测数据记录.md` §11.4/§6.5

### PK-08 ｜ 🟡 PNG 卡白白多走两趟 structured clone
- **现象**：`worker` 6.9s / `assemble` 31s。
- **根因**：`parseChunkInWorker` 把**所有**卡都送 Worker，而 PNG 卡的 `embeddedData` 本来就是主进程解析好的对象 → 又走两趟 structured clone（万卡库 ≈1.2GB 级搬运）。
- **修复**：只把「需要 `JSON.parse` 的纯文本卡」送 Worker。
- **验证**：`worker 6.9s → 1.4~2.0s`；`assemble 31s → 9.6~11.0s`。
- **来源**：`docs/history/测试日志-2026-09-13.md` §3.1；大库压测记录 §11.2

---

## 三、调度与卡顿（PK-05、PK-06）

### PK-05 ｜ 🟡 索引/Token 预热在窗口隐藏时**永久停摆**
- **现象**：最小化窗口后搜索一直搜不到东西；启动后 5 分钟 `cardCount` 仍为 0（手工全库构建只要 35s）。
- **根因**：分片让步只挂 `requestIdleCallback` —— **Chromium 在窗口隐藏/最小化时完全不回调**，`setTimeout` 被节流至 ≥1s（后台 5 分钟后更狠）→ 224 个分片要跑几十分钟；`tokenCache.warmupAsync` 是**纯 idle**（永不回调）；启动闸门单独 `await requestIdleCallback(cb, { timeout })` **连 timeout 都不兑现**（实测 3 分钟仍未开始建索引）。
- **修复**：统一 `yieldToMain()` —— **前台 idle / 后台 `MessageChannel`**（保留定时器兜底）；闸门改 `waitForIdle()`；`MessageChannel` 仅在真实 DOM 创建且 Node 下 `unref()`（否则 `npm test` 不退出，见 [AR-20](BUG-架构与渲染.md)）。
- **验证**：窗口全程隐藏下，11,186 卡索引（349,552 词）+ Token 预热（11,186 次 / 1.45s）均正常完成 ✅
- **经验**：**前台/后台的调度语义不同**，`requestIdleCallback` 在隐藏窗口不可依赖。
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-7；大库压测记录 §11.3

### PK-06 ｜ 🟡 载入期「非角色卡文件」日志刷屏
- **现象**：单次加载 385+ 行 `console.warn`，污染日志并拖慢 console 转发。
- **修复**：同「原因 + 文件名」只打 1 条、总量封顶 40 条、收尾一行汇总：
  ```
  [载入] 跳过 385 个非角色卡/不可解析文件（同类日志已折叠 345 条）
  ```
- **来源**：`docs/history/测试日志-2026-09-13.md` BUG-8；大库压测记录 §11.5

---

## 四、容量专项：三个真问题（PK-10 ~ PK-12）

> 背景：2 万卡库专项（22,372 张 / 19.85GB 副本）第一轮就抓到 3 个真问题。

### PK-10 ｜ 🔴 渲染进程堆上限抬不上去（连错两次的结论）
- **第 1 次错**：以为 `app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144')` 生效 —— 实际**没有作用到渲染进程**（加载期仍 OOM）。
  **正确判据不是内存数字**：Chromium **固定上报** `performance.memory.jsHeapSizeLimit ≈ 4192MB`，抬不抬上限都报这个值。
  **判据应是 `typeof window.gc === 'function'`**（`--expose-gc` 与 `--max-old-space-size` 是同一个 `js-flags`）。
- **第 2 次错**：改用 `webPreferences.additionalArguments = ['--js-flags=...']` 把参数追加到每个渲染进程 argv —— 后经实测**同样无效**（仍在 ~3.3GB 堆时 `render-process-gone {"reason":"oom"}`）。
- **最终结论（已写进 `main.js` 注释，勿重试）**：**渲染进程堆上限 4,192MB 是真的，抬不上去**。只能靠**真实减少内存占用**（P1a）与**内存守门员**，不能靠抬上限。
- **来源**：`docs/history/大库重复卡-压测数据记录.md` §13.2 / §13.3.1；`CHANGELOG.md` v2.2.7（五）「先否证一条错误结论」

### PK-11 ｜ 🔴 `_tokenize` 逐字符跑正则 → 2 万卡索引「10 分钟建不完」
- **现象**：`building=true` 挂了 10 分钟仍未完成（22k 卡待索引文本 ≈1.16GB，其中 80% 是世界书正文）。
- **根因**：`_tokenize` 对**每个字符**跑两次正则（`/[\u4e00-\u9fff]/.test(char)`）→ 十亿级正则调用。
- **修复**：改成 `charCodeAt` 区间比较（CJK `0x4E00–0x9FFF`、`0x3400–0x4DBF`；词字符 `0-9A-Za-z_`），语义不变，**快一个量级**。
- **验证**：22,372 卡 / **349,648 token**，索引正常建完 ✅
- **来源**：`docs/history/大库重复卡-压测数据记录.md` §13.3.1

### PK-12 ｜ 🟡 内存守门员阈值算在**假上限**上
- **现象**：`memoryGuard` 在真实水位只有 49% 时就触发 warn（误报 1 次）。
- **根因**：按 `performance.memory.jsHeapSizeLimit`（恒 4192MB）算比例，而配置的上限是 6144MB。
- **修复**：`createMemoryGuard({ assumedLimitMB })` 取「配置值 vs 上报值」较大者；最终因为上限抬不上去（PK-10），`App.vue` 改为**不传**该参数，基准确认为上报的 4,192MB。
- **验证**：24k 卡高压下 `warns=1 gcCalls=1 releases=1` —— 守门员**真在上场**，不是摆设。
- **来源**：`docs/history/大库重复卡-压测数据记录.md` §13.3.1 / §13.5

### PK-13 ｜ 🔴 AI 打标时渲染进程崩溃（打标 → 触发索引全量重建）
- **现象**：批量 AI 打标跑到几千张卡时渲染进程 native 崩溃（`exitCode -36861`）。
- **根因**：打标每改一张卡 → `triggerRef(library)` → `watch(library)` 触发**全量重建搜索索引 + Token 预热**（几千张卡 × 正则/分词），叠加后超出渲染进程内存上限。
- **修复**：打标期间**跳过索引重建**（`pendingRebuild` 标记），打标结束**补建一次**；同时新增崩溃兜底（`crashReporter` 本地 `.dmp` + `render-process-gone` 落盘 `crash.log` + 自动 reload 恢复）。
- **同轮修的相关缺陷**：规则匹配层进度条不动（改为实时进度）；向量层 `vector:batchProgress` 未合并进 `aiTaggingProgress`；三层 O(n²) `find` 改 O(1) Map；LLM 层 `targetIds[i]` → `llmTargetIds[i]` **索引 bug**。
- **来源**：`docs/history/AI交接指导-合集.md` §四 2026-08-29

---

## 五、本领域的「护栏」（改动性能相关代码前先看）
1. **索引重建必须可重入安全**：代次号 + 幂等 + 结果 `Set` 去重 + 合并重建，四件套缺一不可。
2. **任何"刷新/加载"入口都要有互斥或合并**（`withLoadLock` + coalesce），并把「扫描返回 0 文件」当异常处理。
3. **写盘判据必须基于磁盘现状**（幂等），绝不基于"清洗后的内存状态"。
4. **后台任务不能只依赖 `requestIdleCallback`**。
5. **不为便宜的数据加缓存**；大对象跨进程只走一次（优先传文本让对方自己 `JSON.parse`）。
6. **正文懒加载（>3000 张库自动启用）不是可选项**：`slimCard` 只释放词条正文与 `alternate_greetings`，保留名称/标签/token/`_hasBook`；`ensureCardFull` 负责开卡时读回，读失败**拒绝打开**而不是显示半张卡。
7. **索引跨代沿用（`buildAsync(..., { reuse: true })`）是正文懒加载的前置** —— 否则刷新时复用卡没正文可分词，会一条都进不去索引（刷新即搜索失效）。
