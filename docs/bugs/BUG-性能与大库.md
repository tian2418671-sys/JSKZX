# PK · BUG 记录 — 性能 / 大库 / 内存 / 索引

> 领域：万卡级库的加载、刷新、搜索、内存与磁盘 I/O。
> 测试库基准：`I:\03\角色色卡` = **11,186 张卡 / 9.76GB**（11,667 文件）；2 万卡副本由 `scripts/tools/capacity-check.ps1` 现造（22,372 张 / 19.85GB）。
> 实测数据表见 [`../技术支持/性能与稳定性/技术数据-大库压测与性能.md`](../技术支持/性能与稳定性/技术数据-大库压测与性能.md)；总索引见 [`README.md`](README.md)。

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
  - `scripts/tools/library-dup-search-refresh.mjs` A~F 全阶段 `dup(lib)=0 / dup(list)=0`，库稳定 11,186 ✅
  - 生产模式真实界面复测（搜「龙」/「的」→ 刷新 → 再搜）列表 `dup=0` ✅
  - 重建合并实测计数：`watch: 80 → coalesced: 77 → start: 4 → done: 3`（80 次库变动只真跑 4 次重建）
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-1；`v2.2.7 大库压测` §八

### PK-02 ｜ 🔴 刷新后整个大库从界面消失
- **现象**：刷新后列表空了（磁盘未动），必须重启才回来。也解释了历史上「刷新中途只剩 478 张」的不完整计数。
- **根因**：主进程扫描 catch 分支返回 `{files: [], error}`，渲染层 `if (result && result.files)` 把**空数组当真值** → `library.value = []`。
- **修复**（`js/composables/useDiskScan.js`）：先判 `result.error` 提前返回；库非空时**拒绝接受 0 文件结果**并提示。
- **验证**：连点刷新 ×6 库始终 11,186 张 ✅
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-2

### PK-03 ｜ 🔴 刷新/搜索时渲染进程 OOM 崩溃
- **现象**：`render-process-gone {"reason":"oom","exitCode":-536870904}`，崩溃后 Electron 兜底**自动 reload**。
- **根因**：索引为每张卡**常驻一份小写全文**（11,186 卡 ≈531MB 字符，中文 UTF-16 更高）→ 加载完堆即 3.0GB / 上限 4.19GB，刷新重建再分配一份 + 并发重入。
- **修复（三层）**：
  1. 索引不再保留文本（`_extractText` 按需复算）+ 单卡上限 `MAX_INDEX_TEXT = 200000`；
  2. 重建合并（同 PK-01）；
  3. **P1a 正文懒加载**（`js/utils/cardSlim.js`）：列表态释放世界书词条正文与 `alternate_greetings`，开卡时才读回。
- **验证**：堆基线 3,039MB → 2,013MB；22,372 卡库实测 2,891MB → **2,053MB**，`crash.log` **无新增** ✅
- **⚠️ 因果链（重要）**：崩溃兜底 1.5s 后 `win.reload()` → 新页面又全量加载 → 若此刻还有在途的加载/刷新 → **并发重入** → 同一 path 入两条 → 重复卡。**这解释了为什么用户只在「大库 + 反复刷新/搜索」时看到重复卡**（小库不会 OOM，走不到这条链）。
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-3；`v2.2.7 大库压测` §6.2/§6.3

### PK-09 ｜ 🟡 移动版刷新期间卡片重复出现【移动版】
- **现象**：下拉刷新后加载过程中同一张卡在列表出现 2 次，扫描完成后恢复；搜索/排序在扫描期间返回翻倍结果。
- **根因**：`loadLibrary(refresh=true)` 全量重扫开始时**没有清空** `mobileLibrary.library`，渐进上屏的 `publishProgress()` 把新解析的卡 `push` 到仍含上次结果的数组上。
- **修复**：重扫开始前先 `mobileLibrary.library = []`。
- **来源**：`v1.10.21 移动版专项实测` BUG-10

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
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-4；`v2.2.7 大库压测` §九

### PK-07 ｜ 🟡 PNG 内嵌提取缓存是**负优化** + 遗留缓存无人清理
- **现象**：为了提速加了 PNG 内嵌 JSON 分片缓存，实测**反而慢 2~5 倍**；同时 userData 里堆了 24 个 `0 字节 embed_cache_*.tmp` 与 1.17GB 缓存。
- **根因**：从 PNG 头部提取内嵌 JSON 本身只要 ~3s（自适应窗口 + 128 路并发 + 按需流式，GC 可回收）；而缓存会把约 1.2GB 的**对象**一次性常驻主进程 → 堆压力/GC 抖动 + 额外 IPC 克隆。压缩（gzip）只减磁盘与读取量，**消不掉"对象常驻"这个根因**（v2 比 v1 更慢）。`v8.deserialize` 产出 dictionary-mode 对象，跨 IPC 更慢。
- **修复**：删除整块缓存实现（**-173 行**）+ 新增 `cleanupLegacyEmbedCache()` 启动时一次性回收历史缓存（本机 **44 文件 / 758MB**），用 `.embed_cache_removed` 标记保证只扫一次目录。
- **同因同类**：`atomicWriteJson` 中途失败留下的 0 字节 `.tmp`，`cleanupStaleConfigTmp` 原先没覆盖 `embed_cache*`。
- **经验**：**不要为「本来就便宜」的数据加磁盘缓存** —— 先量"重算成本"再量"缓存加载成本"。
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-10；`v2.2.7 大库压测` §11.4/§6.5

### PK-08 ｜ 🟡 PNG 卡白白多走两趟 structured clone
- **现象**：`worker` 6.9s / `assemble` 31s。
- **根因**：`parseChunkInWorker` 把**所有**卡都送 Worker，而 PNG 卡的 `embeddedData` 本来就是主进程解析好的对象 → 又走两趟 structured clone（万卡库 ≈1.2GB 级搬运）。
- **修复**：只把「需要 `JSON.parse` 的纯文本卡」送 Worker。
- **验证**：`worker 6.9s → 1.4~2.0s`；`assemble 31s → 9.6~11.0s`。
- **来源**：`v2.2.7 桌面版大库专项实测` §3.1；v2.2.7 大库压测

---

## 三、调度与卡顿（PK-05、PK-06）

### PK-05 ｜ 🟡 索引/Token 预热在窗口隐藏时**永久停摆**
- **现象**：最小化窗口后搜索一直搜不到东西；启动后 5 分钟 `cardCount` 仍为 0（手工全库构建只要 35s）。
- **根因**：分片让步只挂 `requestIdleCallback` —— **Chromium 在窗口隐藏/最小化时完全不回调**，`setTimeout` 被节流至 ≥1s（后台 5 分钟后更狠）→ 224 个分片要跑几十分钟；`tokenCache.warmupAsync` 是**纯 idle**（永不回调）；启动闸门单独 `await requestIdleCallback(cb, { timeout })` **连 timeout 都不兑现**（实测 3 分钟仍未开始建索引）。
- **修复**：统一 `yieldToMain()` —— **前台 idle / 后台 `MessageChannel`**（保留定时器兜底）；闸门改 `waitForIdle()`；`MessageChannel` 仅在真实 DOM 创建且 Node 下 `unref()`（否则 `npm test` 不退出，见 [AR-20](BUG-架构与渲染.md)）。
- **验证**：窗口全程隐藏下，11,186 卡索引（349,552 词）+ Token 预热（11,186 次 / 1.45s）均正常完成 ✅
- **经验**：**前台/后台的调度语义不同**，`requestIdleCallback` 在隐藏窗口不可依赖。
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-7；v2.2.7 大库压测

### PK-06 ｜ 🟡 载入期「非角色卡文件」日志刷屏
- **现象**：单次加载 385+ 行 `console.warn`，污染日志并拖慢 console 转发。
- **修复**：同「原因 + 文件名」只打 1 条、总量封顶 40 条、收尾一行汇总：
  ```
  [载入] 跳过 385 个非角色卡/不可解析文件（同类日志已折叠 345 条）
  ```
- **来源**：`v2.2.7 桌面版大库专项实测` BUG-8；v2.2.7 大库压测

---

## 四、容量专项及后续修复（PK-10 ~ PK-16）

> 背景：2 万卡库专项（22,372 张 / 19.85GB 副本）第一轮就抓到 3 个真问题。

### PK-10 ｜ 🔴 渲染进程堆上限抬不上去（连错两次的结论）
- **第 1 次错**：以为 `app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144')` 生效 —— 实际**没有作用到渲染进程**（加载期仍 OOM）。
  **正确判据不是内存数字**：Chromium **固定上报** `performance.memory.jsHeapSizeLimit ≈ 4192MB`，抬不抬上限都报这个值。
  **判据应是 `typeof window.gc === 'function'`**（`--expose-gc` 与 `--max-old-space-size` 是同一个 `js-flags`）。
- **第 2 次错**：改用 `webPreferences.additionalArguments = ['--js-flags=...']` 把参数追加到每个渲染进程 argv —— 后经实测**同样无效**（仍在 ~3.3GB 堆时 `render-process-gone {"reason":"oom"}`）。
- **最终结论（已写进 `main.js` 注释，勿重试）**：**渲染进程堆上限 4,192MB 是真的，抬不上去**。只能靠**真实减少内存占用**（P1a）与**内存守门员**，不能靠抬上限。
- **来源**：`v2.2.7 大库压测` §13.2 / §13.3.1；`CHANGELOG.md` v2.2.7（五）「先否证一条错误结论」

### PK-11 ｜ 🔴 `_tokenize` 逐字符跑正则 → 2 万卡索引「10 分钟建不完」
- **现象**：`building=true` 挂了 10 分钟仍未完成（22k 卡待索引文本 ≈1.16GB，其中 80% 是世界书正文）。
- **根因**：`_tokenize` 对**每个字符**跑两次正则（`/[\u4e00-\u9fff]/.test(char)`）→ 十亿级正则调用。
- **修复**：改成 `charCodeAt` 区间比较（CJK `0x4E00–0x9FFF`、`0x3400–0x4DBF`；词字符 `0-9A-Za-z_`），语义不变，**快一个量级**。
- **验证**：22,372 卡 / **349,648 token**，索引正常建完 ✅
- **来源**：`v2.2.7 大库压测` §13.3.1

### PK-12 ｜ 🟡 内存守门员阈值算在**假上限**上
- **现象**：`memoryGuard` 在真实水位只有 49% 时就触发 warn（误报 1 次）。
- **根因**：按 `performance.memory.jsHeapSizeLimit`（恒 4192MB）算比例，而配置的上限是 6144MB。
- **修复**：`createMemoryGuard({ assumedLimitMB })` 取「配置值 vs 上报值」较大者；最终因为上限抬不上去（PK-10），`App.vue` 改为**不传**该参数，基准确认为上报的 4,192MB。
- **验证**：24k 卡高压下 `warns=1 gcCalls=1 releases=1` —— 守门员**真在上场**，不是摆设。
- **来源**：`v2.2.7 大库压测` §13.3.1 / §13.5

### PK-13 ｜ 🔴 打开某张卡**卡死 43~71 秒**（预设正则 × 界面巨脚本灾难性回溯）
- **现象**（用户报告 2026-09-14）：「读取某张卡卡死软件」。实测 `鬼 1.2版.png`：
  `openFromLibrary` 耗时 **43.9s / 71.9s**（重载后首开），期间渲染进程**完全无响应** ——
  CDP `Runtime.evaluate` 超时、`Debugger.pause` 都插不进去（JS 无法中断已在执行的正则），
  CPU 采样为 0（说明是「主线程被一条正则按住」而不是死循环）。
- **调用链**（追踪器抓到的原话）：
  `openFromLibrary → resetChatEngineForCard → engine.resetForCard → initChat → pushFirstMessage
   → applyRegexScripts（useChatRegex.js 的 String.replace）`
- **根因（两层叠加）**：
  1. **文本被放大**：卡内脚本「状态栏界面」的 `replaceString` 是**整包状态栏 HTML/JS = 136,769 字符**，
     它命中开场白里的 `<StatusPlaceHolderImpl/>`，把 **738 字**的开场白膨胀成 **137,469 字**；
  2. **后续正则全在这个巨文本上跑**：用户预设（`H:\01` 下，如 `Izumi 0707.json`）有 31 条正则，
     其中 `([\s\S]*)<\/konatan_planning~>`（无匹配后缀的贪婪式，O(n²) 回退）在 137KB 上
     单条就要 **11.8s**，另有 `(<disclaimer>.*?</disclaimer>)|…` **5.4s**、
     `([\s\S]*?)(<progress>…<\/progress>)([\s\S]*?$)` **2.3s** —— 合计 **20s+**。
- **为什么不只这一张卡中招**：需要「卡内有巨型替换串的显示型脚本」+「开场白真的含它的目标占位符」。
  全库扫描：**75 张里 15 张**带 >20KB 替换串（最大 `萧谴写卡助手版_V4.5.11.png` = **282KB**）。
- **修复**（`useChatRegex.js`，三件套）：
  1. **界面注入型替换后置物化**：替换串 ≥ `BIG_REPLACEMENT_THRESHOLD`(8KB) 时，
     匹配与 `$1`/`{{match}}`/`trimStrings` 计算照旧，但**本趟管线里先写入占位符**，
     全部脚本跑完再统一回填 → 后续 31 条正则永远面对小文本（**20s+ → 毫秒级**），
     显示结果逐字不变（文本仍是 137,469 字）；
  2. **编译缓存**：同一 `findRegex` 不再逐次 `new RegExp`（引擎一条消息跑几十条脚本、发送还要跑全历史）；
  3. **时间预算安全网**：单条 >120ms 记一笔，累计 >1.5s 就**跳过剩余脚本**并 `console.warn` +
     `opts.onSkip` 回调 —— 宁可少美化，不可冻界面。
- **验证**：
  - 真实卡实测（dev）：`鬼 1.2版` 打开 **43.9s/71.9s → 20ms**（热开）；
  - **生产模式（`app://`）实测**：冷启动后首次点该卡，主线程**最大阻塞 64ms**（普通卡对照 63ms），
    切到「聊天」Tab（含 137KB 界面消息）同样 63ms；
  - **全库 75 张逐个打开复测**：无卡死，最慢 4.6s（首张开）/ 其余 9~324ms；
  - `test/chatRegexBudget.test.mjs` 7 例（延后物化后的性能不变式、`$1`/`{{match}}`/trimStrings 语义不变、
    预算跳过、`promptOnlyExclusive` 语义不变）；`npm test` 247/247。
  - ⚠️ **测量方法教训**：用 `requestAnimationFrame` 计时在 Electron **窗口不在前台时会被节流**，
    会把几十毫秒的活计报成 **28s**（本次先被它骗过一次）。量「卡不卡」请用
    **主线程阻塞指标**：起一个 50ms `setInterval`，操作期间取最大间隔（本次两次复测均 <70ms）。
- **遗留（本次**未做**，建议下一步）**：137KB 界面 HTML 仍会存进消息文本并写进聊天存档
  （生产实测 DOM 因它增加 ~250KB，但**主线程不再阻塞**）。彻底方案：消息文本只存**原始短文本（含占位符）**，
  显示层在渲染时物化 / 或对界面型消息做折叠懒渲染（iframe 沙箱）；同时能量上修掉
  「发送给 AI 的提示词里可能混入界面 HTML」与存档膨胀。
- **来源**：用户实测报告 + dev/CDP 追踪（2026-09-14，v2.2.7 补丁）

### PK-14 ｜ 🔴 瘦身卡（PNG）正文回读**必败** —— 窗口隐藏期间索引建完触发瘦身 → 切回后点卡弹「读取卡片正文失败」
- **现象**：软件切后台再切回后，点击任意 PNG 角色卡弹出「读取卡片正文失败：XX（文件可能已被移动/删除，或不是有效角色卡）」；**切换前点同一张卡正常**。JSON 卡不受影响（走 `readText` 另一条路）。
- **根因**（两层，缺一不可）：
  1. **直接根因（代码缺陷）**：P1a 瘦身回读路径 `App.vue loadFullCardFromDisk` 调 `files:readEmbeddedBatch` 时**写死 `{ path, size: 0, mtime: 0 }`**（cf60b37 引入），而主进程 `readPngEmbeddedFromFile` 首行 `if (!filePath || !size) return null`（40b68f8 引入，早于 P1a）→ 任何 PNG 瘦身卡回读**必返 null** → `ensureCardFull` 失败 → 拒绝打开并弹窗。旁证：`useCardCrud` 的导入路径传的是真实 `f.size`，同一 API 一直正常 —— 只有瘦身回读这条路径坏了。
  2. **触发条件（为什么表现为"切后台后才坏"）**：瘦身只在「索引构建 + token 预热**完成后**」执行（`slimLibraryIfNeeded('index-built')`）。PK-05 修复后（`yieldToMain` 隐藏时改走 MessageChannel），索引能在**窗口隐藏期间建完** → 瘦身在后台完成 → 用户切回时所有卡已 `_slim`，点击即走坏路径。修复前隐藏时构建停摆、切回时卡还未瘦身（走内存直读），所以「切换前能用、切换后不能用」。
- **修复**：
  1. `main.js` `readPngEmbeddedFromFile`：删除 `!size` 硬拒；size 未知（0）时按 1MB→8MB 窗口渐扩试探（文件小于窗口且未解析出卡直接判非卡），仍无则 `stat` 拿真实大小整读兜底；已知 size 路径行为不变；
  2. `js/components/App.vue` `loadFullCardFromDisk`：改签 `(path, item)`，传真实 `item._size / item._mtime`；批量提取拿不到时回退 `file:readBuffer` 整读 + `parsePNGChunk / deepScanForJSON` 前端解析（兑现 `readPngEmbeddedFromFile` 注释里承诺的兜底）；
  3. `js/utils/cardSlim.js` `ensureCardFull`：loader 契约改传 `(item.path, item)` —— 调用方需要 `_size` 才能正确回读。
- **验证**：
  - 单测 `test/cardSlim.test.mjs` 新增「loader 必须收到 (path, item) 两参」契约用例（PK-14 回归），`npm test` 全绿；
  - `npm run build:web` 构建成功；
  - ⬜ 大库端到端待复测：22k 卡库 → 窗口隐藏等索引后台建完 → 切回点任意 PNG 卡正文正常回读（`.json` 卡对照组不受影响）。
- **来源**：用户反馈（2026-09-14，v2.2.7 补丁后）

### PK-15 ｜ 🔴 瘦身卡每次打开都触发**全库索引重建 + Token 预热 + 再瘦身** → 隐藏后连点几张卡明显卡顿
- **现象**（用户反馈 2026-09-14，PK-14 修复后复测）：1 万卡库（加载 30s）隐藏→恢复后卡能正常打开了，但**连点几张角色卡后明显卡顿**。
- **根因**：`openFromLibrary` 对瘦身卡还原成功后执行 `triggerRef(library)`。`library` 是 **shallowRef**（App.vue），而 Vue 注册 watch 时对 shallow 源 `forceTrigger = isShallow(source)`（reactivity 源码 1843 行）——**不比较引用是否变化，trigger 必触发回调**。于是每开一张卡就走完整链条：
  `triggerRef(library) → watch(library)（deep:false 但 forceTrigger）→ rebuildSearchIndex → buildAsync 全库索引重建（10k 卡分词，约数秒 CPU）+ tokenCache.warmupAsync 全量预热 + slimLibraryIfNeeded 再压缩`。
  连点时 `indexBuilding/indexDirty` 合并机制把「每点一次」串成「一次接一次的全量重建」，卡顿持续不断。AI 打标路径曾踩过同一坑（为此加了 `isAITagging` 守卫 + 延迟补建）；开卡路径在 PK-14 修复前因读卡必败提前 return、从未走到 triggerRef，所以此坑一直潜伏到 PK-14 被修好。
- **附带危害**：① 重建后跟跑 `slimLibraryIfNeeded` 会把**刚打开的其它卡重新压缩**——未保存的世界书编辑从内存抹掉；② 重建时全库正处于瘦身态，`extractCardSearchableText` 索引到的世界书正文为空（词条 content 已被清空）→ **全库世界书搜索静默降级**。
- **修复**（`js/components/App.vue`）：
  1. **删除**还原成功后的 `triggerRef(library)` —— 还原不改动任何列表可见字段（名称/标签/分类/token/`_hasBook`/`_descShort` 均在压缩时就地留存），列表/索引/Token 缓存无需重算；编辑器走 `cardData.value` 赋值刷新。契约已写入 `cardSlim.ensureCardFull` 的 JSDoc（PK-15 契约：调用方还原成功后不得 triggerRef(library)）；
  2. 顺带优化：`loadFullCardFromDisk` 三处 `normalizeCardData(..., true)`（noClone）——IPC/JSON.parse 产物本就是渲染进程独占副本，省掉每次开卡一次全卡 `structuredClone`。
- **验证**：
  - `npm test` 全绿；`npm run build:web` 构建成功；
  - ⬜ 待复测：10k 卡库隐藏→恢复后连点多张 PNG/JSON 卡，不应再有持续卡顿；打开的卡内容完整、搜索/排序/世界书搜索正常。
- **来源**：用户反馈（2026-09-14，v2.2.7 补丁后）

### PK-16 ｜ 🔴 瘦身完成后的 `triggerRef(library)` 引发**第二轮全量索引重建** —— 启动双倍负载 + 世界书搜索被「洗掉」
- **现象**（用户启动日志 2026-09-14，11,188 张卡）：启动日志出现**两轮**「⚡ 搜索索引构建完成 / ⚡ Token 缓存预热完成」，第二轮紧跟在「[slim] 已压缩 9557 张卡的正文」之后。
- **根因**：`slimLibraryIfNeeded` 压缩成功后执行 `triggerRef(library)`。`library` 是 shallowRef、watch 为 forceTrigger 语义（PK-15 同源），立刻再走一轮 `rebuildSearchIndex`：全库索引重建 + 全量 Token 预热。而这轮重建发生时全库已是瘦身态 —— `extractCardSearchableText` 的世界书词条正文（`content` 已被清空）索引不到 → **把压缩前刚建好的「含世界书正文」的索引覆盖成降级版**，世界书关键词搜索静默失效；启动还多付一整轮全量重建的 CPU。全局资产库面板的关闭路径同病（关闭 → slim → 重建）。
- **修复**（`js/components/App.vue` `slimLibraryIfNeeded`）：删除 slim 成功分支里的 `triggerRef(library)`。压缩不改任何列表可见字段（SidebarPanel 的 `hasLorebook`/`cardDesc` 在 `_hasBook`/`_descShort` 缺失时都有实时兜底计算），列表/索引/Token 缓存均无需重算。附带收益：资产库面板**关闭后**不再触发重建，索引保持「面板打开时从完整态重建」的版本，无降级。
- **遗留（后续可做）**：全局资产库面板**打开时**的进度回调仍会 `triggerRef(library)`（「边还原边出现」靠它刷新 `globalAllWorldbooks` 计算属性），一次打开仍伴随 1~2 轮全量重建（最终索引为完整态、不降级，纯 CPU 浪费）——把面板数据源换成独立 tick ref 后即可消除。
- **验证**：
  - `npm test` 全绿（257）；`npm run build:web` 构建成功；
  - ⬜ 待复测：启动日志应只剩**一轮**索引构建 + 预热；世界书词条正文关键词在瘦身库上仍可被搜索命中。
- **来源**：用户日志 + 代码走查（2026-09-14，v2.2.7 补丁后）

### PK-17 ｜ 🔴 **PK-14 其实没修好**：未知 `size` 分支把 `fh.read()` 的返回对象当数字比较 → 恒返 null
- **现象**（2026-09-14 复查 2.2.9 改动时发现）：同一张卡走 `files:readEmbeddedBatch` 时
  **`size: 0` 读不到正文，给真实 `size` 就能读到** —— 即 PK-14 声称修好的「瘦身卡回读」路径仍然失效。
- **实测数据**（生产实例 + CDP，随机 5 张库内 PNG）：

  | 文件 | 大小 | `size=0` → data | 真实 `size` → data |
  |---|---|---|---|
  | 写卡工作台.png | 323KB | ❌ | ✅ |
  | World Builder 2.0.png | 1053KB | ❌ | ✅ |
  | 谎言系统.png | 778KB | ❌ | ✅ |
  | ddfb7968d7720a78.png | 126KB | ❌ | ✅ |
  | 全裸登校…png | 540KB | ❌ | ❌（该卡本身无 chara 数据） |

  另测「鬼 1.2版.png」（1,398,105 B）：`size=0` → `{ok:true,hasData:false}`；`size=1398105` → `{ok:true,hasData:true,name:'鬼 1.2版'}`。
- **根因**：`main.js readPngEmbeddedFromFile` 的未知 size 分支写成
  ```js
  const n = await fh.read(head, 0, win, 0);                 // ← promise 版返回 { bytesRead, buffer }
  const data = readTavernPNGChunk(n < win ? head.subarray(0, n) : head);
  if (data) return data;
  if (n < win) return null;
  ```
  `n` 是**对象**，`n < win` 触发 ToPrimitive 转换失败 → 抛 `TypeError: Cannot convert object to primitive value`
  （复刻脚本 `pk14-repro.mjs` 在 Node v25.2.1 上即在第 42 行抛出）→ 被外层 `catch { return null }` 静默吞掉
  → 该分支**永远返回 null**，后面的 `fh.stat()` 整读兜底一行都走不到。
  旁证：已知 size 分支同样调用 `fh.read` 但**不比较返回值**，所以一直正常 —— 坏的只有这一条新加的分支。
- **影响**：`App.vue loadFullCardFromDisk` 在 `item._size` 缺失（传 0）时拿不到数据；目前靠同一提交新增的
  `readBuffer → parsePNGChunk/deepScanForJSON` 兜底救回，所以用户侧症状被掩盖，但该"快路径"是死代码，
  且一旦兜底被移除/失败即复现 PK-14 的「读取卡片正文失败」弹窗。
- **修复**：未知 size 分支改为取字节数 `const n = (await fh.read(head, 0, win, 0)).bytesRead;`（保留越界/截断语义），
  并在补上后复测 `size=0` 必须能返回 `data`。
- **防再犯**：**`fs.promises.FileHandle.read` 返回 `{ bytesRead, buffer }`**，凡要拿「读了多少」必须取 `.bytesRead`；
  代码评审时看到 `await fh.read(...)` 的返回值被直接参与算术/比较，一律视为缺陷。
- **来源**：2.2.9 改动复查（用户要求「检查 2.2.9 源码改动是否有 BUG」）+ CDP 多卡实测（2026-09-14）

### PK-18 ｜ 🔴 索引就绪后**短语校验整条被跳过** → 「系统」命中「体系 传统」的卡，且索引前后结果不一致
- **现象**（2026-09-21 实测）：搜索**准确性**坏掉，而非慢 —— 构造一张正文为「体系 传统 经典文字」（**不含「系统」**）的卡，
  搜「系统」**会被命中**（`false_positive = true`）。用户感知为「搜出来的东西不相关 / 明明搜的不是这个」。
  更隐蔽的是：**同一句查询在索引建好前后结果不一致**（建索引前走内存匹配、建索引后走索引路径，两条路径判据不同）。
- **根因**：`js/composables/useSearch.js` 的 `filteredLibrary` 第 7 步「全文本多词必含校验（AND 逻辑）」条件是
  `if (rules.mustInclude.length > 0 && searchIndex.cardCount === 0)` —— **索引一就绪（`cardCount > 0`），这条短语校验整条被跳过**，
  于是「系统」退化为「含『系』**且**含『统』」的单字 AND，而「体**系** 传**统**」正好两字都含。
  （第 2 步排除词、第 3 步标签校验同样带 `&& searchIndex.cardCount === 0`，属同一写法家族。）
- **实测数据**（5001 卡 / 150 万 token，`node` 直接跑 `searchIndex`）：
  `系统` → 命中 1 张 / **0.2ms**（单字桶精确求交）；`体系`/`经典` → 0~0.1ms；
  `syst`/`sys`/`st` → **23~36ms**（全表 `word.includes` 回退）；`false_positive_by_系统 = **true**`。
- **顺带纠正一处流行误判**：**不是**「中文双字词 `index.get('系统')` miss → 退化为全表扫描」。
  `search()` 对**字符串入参也会调 `this._tokenize()`**，而 `_tokenize` 对 CJK **按单字**切 → `"系统"` → `['系','统']` → `index.get('系')` **精确命中**，
  **中文多字词根本不触发全表扫描**。真正触发全表回退（慢）的是**拉丁子串 / 前缀**（每敲一个字母扫一次全表，且随 token 表线性增长）。
- **修复**（规划中，见 [`../规格与计划/查重引擎/查重扫描与检索-最终方案.md`](../规格与计划/查重引擎/查重扫描与检索-最终方案.md) §四 S2-5）：
  索引返回候选集后，**对候选集**（不是全表）复算文本做短语 `includes` 复核 ——
  去掉第 7 步的 `&& searchIndex.cardCount === 0`，改为**始终复核但只对候选集**。
  代价有界且有先例：同文件 `excludeKeywords` 分支本来就是「只对候选集复算 `this._extractText(card)`」，照抄即可；
  **不需要 bigram、不需要常驻正文**（22k 卡库的堆压力不变）。
- **验证**：搜「系统」不得命中含「体系 传统」的卡；且**索引就绪前后同一查询结果一致**（与 `cardCount === 0` 时逐条比对）。
- **防再犯**：**凡带 `&& searchIndex.cardCount === 0` 的校验分支，都要问一句「索引就绪后这条校验谁来兜」**——
  索引是**加速手段**，不能顺手把**正确性校验**也一起关掉；两条检索路径（索引 / 内存）的判据必须等价，否则用户看到的结果会随"索引好了没"变化。
- **修复结果**（2026-09-21 已实施并通过）：`useSearch.js` 三处改造——
  ① **就绪判定**：`cardCount > 0 && !building && cardCount >= library.length`（替代裸 `cardCount > 0`）；
  ② **查空回落**：索引返回空不再 `|| []` 硬空，回落内存匹配；
  ③ **候选集短语复核**：新增 `needPhraseCheck`，索引路径下**对候选集**复算文本做 `includes` 校验（同卡文本用 Map 缓存，避免多关键词重复复算），
  并去掉第 7 步的 `&& searchIndex.cardCount === 0`（未走索引时仍兜底，不重复复算）。
- **验证**：单测 `test/searchPhrase.test.mjs` **9 条全绿**（含「索引就绪前后结果一致」「构建中/覆盖不足不漏卡」「索引查空回落」）；
  **UI 级端到端**（`scripts/probes/_probe-search-phrase.mjs`，**8/8 通过**）：向真实应用注入「诱饵卡（体系 传统）」+「真卡（本系统用于监控）」，
  操作真实搜索框输入「系统」→ 内存路径与索引路径**都不命中诱饵卡**且结果一致。
  另做**反向验证**：临时把 `needPhraseCheck` 置 false 后，多词 AND 用例从 `['卡A']` 变成 `['卡A','卡C']`（卡C = 「体系 传统 监控」）——
  **证明该用例确实能抓到本缺陷**。
- **来源**：2026-09-21 查重链路专项实测（`searchIndex` 直接构造语料复现）

### PK-26 ｜ 🔴 秒开回归（第二处）：`wb.data` 变 `null`，**所有读它的消费者静默算出 0**
- **现象**（用户 2026-09-22 实测报出，原话）：
  > 「**对比功能崩溃了，进度条崩了，导出乱串，发现 0 组疑似重复，依旧从 0 开始依旧是 0**」
- **实测证据**（`scripts/probes/_probe-instant-regression.mjs`，s1000 / 1001 本）：

  | 指标 | 实测 |
  |---|---|
  | 秒开后 `wb.data === null` | **1001 / 1001（全部）** |
  | `dataLoaded === true` | **0** |
  | `typeof wb.entryCount === 'number'` | 1001（**准确值在 `entryCount` 上**） |
  | `wb.wbName` 可用 | 1001 |
  | 读 `wb.data.name` 可用 | **0 / 1001** |
  | 同名查重 `_entryCount` | 前 3 本 1905，**其余 37 本全 0** |
  | 同名查重 `_diffInfo` | 「触发词重合度: **0% (0条)**」← **完全错误的结论** |

- **根因（一个根因，四处症状）**：PK-23 秒开把**列表态**的 `data` 从「总是有」改成「可能没有」
  （`dataLoaded:false` + `data:null`），**但消费端没跟着改** —— 大量代码仍直接读 `wb.data.entries` / `wb.data.name`：

  | # | 位置 | 症状 |
  |---|---|---|
  | 1 | `useDedupe.js` `startWorldbookDedupeScan` | `_entryCount` 算成 **0**、`getWorldbookKeysSet` 得空集 → **重合度 0%**；聚类读 `wb.data.name` 得 null → 回退文件名 |
  | 2 | `useDedupe.js` `extractContentText` 世界书分支 | 读 `item.data.entries` → 内容级查重拿不到文本 |
  | 3 | `useDedupe.js` `openDiffDetailModal` 的 `isWorldbook` 判定 | 读 `masterItem.data.entries` → `data` 为 null → **判不出是世界书** → 走角色卡分支 → 显示「设定完全一致」的**反向结论**（DF-19 同款病） |
  | 4 | `WbImportModal` / `WbMergeModal` / `EditorPanel` / `useGlobalEntrySearch` / `useWorldbookExtras` | 直接读 `wb.data.entries` / `wb.data.name` → 词条数显示 0、搜索名回退文件名 |

  > 🔴 **静默算出 0 比崩溃更坏** —— 用户看到「触发词重合度 0%」会**误删正确的书**。
- **修复（两轮）**：
  **第一轮 —— 在数据源头补齐**（而不是逐个消费点打补丁）：秒开阶段 1/2 就给出 `entryCount` / `wbName`
  两个**轻量替代字段**，并把消费点改为「**优先轻量字段，缺失时才回退 `data`，必要时显式懒加载**」：
  1. `useDedupe.js` 新增 `wbEntriesOf(wb)` / `wbKeysOf(wb)` —— **先读 `entryCount`，需要正文时 `ensureWorldbookLoaded`**；
  2. 同名查重：`_entryCount` 改 `wbEntryCount(wb)`、`_keysSet` 改 `wbKeysOf(wb)`、聚类名改 `wbDisplayName(wb)`；
  3. `openDiffDetailModal`：`isWorldbook` 判定改为「**有 `data.entries` 或 有 `entryCount`**」（懒加载书也能正确判为世界书）；
  4. `extractContentText`：调用前统一 `ensureWorldbookLoaded`（内容查重分支已有，补到函数契约上）；
  5. UI 显示类（词条数 / 书名）统一走 `wbEntryCount` / `wbDisplayName`。

  **第二轮 —— 清掉第一轮漏掉的消费点**（`grep` 全库 `wb.data` 逐处过筛，共 10 类）：

  | # | 位置 | 漏掉的后果 | 修法 |
  |---|---|---|---|
  | 1 | `App.vue` `useGlobalEntrySearch({...})` 调用点 | 函数签名已加依赖但**调用点没跟上** → 全库词条搜索**恒空** | 补注入 `ensureWorldbookLoaded` / `selectWorldbook` / `wbDisplayName` |
  | 2 | `useWorldbookExtras.js` `wbStats` | 世界书库统计**词条数全为 0** | 词条数走 `wbEntryCount`；**不按需载入**（5000 本全读会 OOM），Token/常驻/覆盖率只统计已载入的书，覆盖率分母改用**已载入词条数**（避免假 0%） |
  | 3 | `useWorldbooks.js` `filteredWorldbooks` | 「1-15条 / 15+条 / 空书」筛选**恒 0 本**（用户原话「依旧从 0 开始依旧是 0」） | 词条数走 `wbEntryCount` |
  | 4 | `useWorldbooks.js` `duplicateWorldbook` | `JSON.stringify(wb.data \|\| {})` → 复制出**空世界书** | 先 `ensureWorldbookLoaded`，失败则明确报错中止（不静默产空书） |
  | 5 | `useWorldbooks.js` `renameWorldbook` | 懒加载书**改名不生效**（旧写法只在 `wb.data` 存在时写） | 同时写轻量字段 `wbName` |
  | 6 | `App.vue` `executeWorldbookMerge` | 合并**词条全丢** | 逐本按需载入 + 汇总提示不可读的书并中止 |
  | 7 | `App.vue` `pickImportSource` / `pickCardWbImportSource` / `confirmImportEntries` | 导入候选**列表空白**；确认导入写 `data.entries` **TypeError** | 选中源书时按需载入；写入前校验目标书正文 |
  | 8 | `useWorldbookEntries.js`（新增/删/克隆/移动/批量删） | 写 `activeWorldbook.value.data.entries` → `data` 为 null 时 **TypeError，整个词条 IDE 崩溃** | 新增 `ensureActiveData()` 统一入口：按需载入 + 失败明确提示 + `entries` 兜底为 `[]` |
  | 9 | `DiffModal.vue` `iconFor` | 世界书图标显示 🎎（判成角色卡） | 补轻量判据 `entryCount` / `wbName` |
  | 10 | `App.vue` `saveActiveWorldbook` / `exportActiveWorldbook` / `exportFilteredWorldbook` / `openWbGraphModal` / `buildWbGraphData` | 保存与导出**产出空书**、图谱提示「没有词条」 | 正文依赖入口统一先按需载入；可选链兜底 |

  另修一处**新引入的体验退化**：全库词条搜索的索引改为异步后，大库索引期间弹窗会显示「共索引 0 条 / 未找到匹配词条」
  → 用户会判定为坏了。故补 `indexing` 状态（显示「⏳ 正在建立全库索引…」）。

  **第三轮 —— 修「第一轮修复本身引入的新风险」**（同名查重逐本载入 1001 本正文）：

  | # | 风险 | 后果 | 修法 |
  |---|---|---|---|
  | 1 | `ensureWorldbookLoaded` 逐本 `addLog` + 逐本 `triggerRef(worldbooks)` | 1001 本 → **1001 条日志 + 1001 次侧栏重渲染**，拖到分钟级 | 新增 `{ batch: true }` 模式：批量场景**不逐本刷日志、不逐本重渲染**，改为调用方读完**统一 `triggerRef` 一次** |
  | 2 | 逐本载入正文后**从不释放** | 1001 本 6.97GB 常驻 → **重演 PK-20 的 OOM** | 新增 `releaseWorldbookBody(wb)`（仅释放扫描期已判 `heavy` 的书，不碰用户正在编辑的书）；同名查重**每本用完立即释放** |
  | 3 | 读正文阶段**无任何进度提示** | 分钟级静默 → 用户看到弹窗「卡住不动」会判定为坏了（**又是 PK-26 的核心教训**） | 同名查重补真实进度：`dedupeScanLabel` 显示「正在逐本读取正文并提取触发词（共 N 本）…」+ 百分比；读完 `resetDedupeScan()` 收起 |

  > ⚠️ **这是本轮最值得记住的一点**：修 PK-26 时「把懒加载的书读进来」这个动作本身，
  > **会重新引入 PK-20 的 OOM**。内容级查重早就写了「用后释放」（`startContentDedupeScan` 的 `finally` 分支），
  > 而同名查重没有 —— **同一份代码库里同一个坑被踩了两次**。
  > ⇒ 凡「按需载入正文」的批量流程，**必须同时有对应的释放动作**，否则等于把懒加载又改回常驻。
  > ⇒ 且**批量流程同样要报进度**：「静默长耗时」与「静默算出 0」是同一类缺陷（用户无法区分「在算」和「坏了」）。
- **⚠️ 关键教训（与 PK-24 是**同一条**）**：
  > **改「列表态数据结构」时，必须把所有「读该结构」的消费者一起改。**
  PK-24 是「**跳过校验**」，PK-26 是「**字段没了**」—— 都是「**改了生产者、没管消费者**」。
  秒开让 `wb.data` 从「总是有」变成「可能没有」，**全项目约 40 处 `wb.data` 读取都成了潜在空结果**。
  ⇒ 凡「按需 / 懒加载」改造，**先 `grep` 出全部消费者**，逐个决定：① 改读轻量字段；② 显式 `ensureWorldbookLoaded`；③ 明确降级提示。
  ⚠️ **第一轮只改了「用户报出的症状对应的那几处」，第二轮 `grep` 才发现还有 10 类漏网** ——
  「按症状修」永远不够，**必须按 `grep` 结果穷举**。
- **验证**：
  · `scripts/probes/_probe-instant-regression.mjs`（s1000 / 1001 本）：修复前 `_entryCount` 大量为 0、重合度 **0%**；
    修复后秒开态 `hasEntryCount` / `hasWbName` = **1001 / 1001**、`wbEntryCount()` 返回真实值（397 / 1905 / 1905）、
    同名查重 `_entryCount` 全为真实值且重合度非 0%。
  · `npm test` **471 全绿**；`npm run build:web` 通过；真实启动冒烟无渲染期错误。
- **来源**：2026-09-22 用户实测反馈（秒开专项回归）

### PK-25 ｜ 🟡 内容级查重的 LSH 桶内**两两比较**是 O(bucket²)：极端同源库下退化为「亿级比对」
- **现象**（2026-09-22 5000 本极端压测暴露）：内容级查重在 **5401 本 / 49.6GB** 库上
  **运行超过 25 分钟仍未完成**（CPU 持续满载，未死锁）。
- **根因**：`useDedupe.js` 的 `startContentDedupeScan` 用 **MinHash(96) + LSH(8 bands × 12 rows)** 做候选预过滤，
  但**桶内**是朴素两两比较：
  ```js
  buckets.forEach(list => {
      for (let x = 0; x < list.length; x++)
          for (let y = x + 1; y < list.length; y++) { /* estimateSimilarity */ }
  });
  ```
  LSH 的设计假设是「**桶小、桶多**」（真实世界里同源副本通常成组少量）。
  而本次压力库是**硬链接多轮放大**的产物 —— 5401 本**几乎全部同源**，
  于是大量项落进**同一批桶**（每桶数百~上千项），桶内对数为 $O(n^2)$：
  $5401^2/2 \approx 1.46\times10^7$ 对，再乘 band 重复（`seenPairs` 去重前更甚），
  单对还要跑 `estimateSimilarity`（96 次整数比较）→ **亿级运算**。
- **定性（重要）**：这是**压力库的构造特性**，**不是真实用户场景** ——
  真实库里「5000 本几乎完全相同」不成立（那本身就是待清理的重复）。
  但**用户确实可能有一条「批量复制后改名」的历史库**，所以仍值得留一条护栏。
- **修复方向（待评估，未实施）**：
  ① 桶内**按签名前缀二次分桶**（对超大同源桶再切一层，把 $O(n^2)$ 降下来）；
  ② 桶内加**上限 + 抽样**（超过 N 项时提示「本桶已抽样比对」）；
  ③ 分片让出主线程（`yield`）保证界面不卡（当前已不卡，仅耗时）；
  ④ 进度条显示「已比对 X / Y 对」而非只显示项数。
- **✅ 已解决（2026-09-22，随 PK-27 的 S3' 一并修）**：
  **彻底弃用 MinHash + LSH，改 simhash**（`[lo,hi]` 64 位位向量）——
  比较只需**整数异或 + popcount**（每对 <1μs，比 96 次 MinHash 比较快约 100×），
  **天然没有「桶」的概念**，从根上消除 O(bucket²)。
  全量两两预筛实测：s1000（1001 本）≈ **0.5s**；s5000（5001 本）≈ **12.5s** —— 均可接受。
  simhash 特征方案/阈值由 `S0.5` 实验定稿（**char 4-gram + 采样 step=4 + 阈值 T=19**，
  实测 **43ms/本**；不采样则 171ms/本）。
  ⚠️ **实现要点**：`simhash` 是**位向量**，**绝不能**与 MinHash 的 `estimateSimilarity`（相同分量比例）混用
  （对 `[lo,hi]` 只会返回 0 或 1 → **假阳性 + 假阴性同时存在**，见 `test/wbSimhash.test.mjs` 的反例断言）。
- **当前状态**：✅ **已修**（S3'，simhash 替代 LSH）。
- **来源**：2026-09-22 世界书 5000 本极端压力测试专项

### PK-27 ｜ 🔴 批量读正文用 `Promise.all` 整组并发 → **s5000 渲染进程被 OOM killer 杀掉**
- **现象（用户报）**：「对比功能崩溃了，进度条崩了，导出乱串，发现 0 组疑似重复，依旧从 0 开始依旧是 0」
  + 后续「**压测已经卡死不动了**」。
- **取证（关键：不是「卡死」，是「进程被内核杀掉」）**：

  | 事实 | 证据 |
  |---|---|
  | **进程消失**（非卡死） | CDP 连不上；**无 `crash.log`**；无 `Crashpad/*.dmp` |
  | **OOM killer 特征** | 渲染进程被内核直接杀死，来不及写任何日志（与内容级查重记录的 `reason:"killed"` 同款） |
  | 崩点 | `useDedupe.js` 同名查重**逐本读正文**时用 `Promise.all` **整组并发** |
  | **库规模是决定性变量** | s1000：每组 40 本 ≈ **528MB**（侥幸存活）；s5000：每组 **200 本** × 13.2MB ≈ **2.6GB**（**被杀**） |

- **真因（架构级，非算法级）**：`main.js:2855` 扫描时 `entriesArr` **已在内存**，
  却只把 `{mtime, size, name, entryCount}` 写缓存 → **触发词被丢掉** →
  下游查重只能**反复重读 34.8GB 正文**。
  **⇒ 三次 OOM 事故（PK-20 / 内容查重 / PK-27）同一病根**。
- **修复（分两批，方案见 [`../规格与计划/世界书大库/世界书大库-加载与查重架构方案.md`](../规格与计划/世界书大库/世界书大库-加载与查重架构方案.md)）**：

  **S0 止血**：新增 **`consumeWorldbookBodies()`**（`useWorldbooks.js`）——
  **唯一**的「批量读正文」入口：顺序消费（`concurrency: 1`，内存峰值 ≈ **单本**、与库大小无关）
  + 每本用完立即释放（`releaseWorldbookBody`）+ 每 10 本让出主线程 + 逐本失败不中断。
  同名查重 / 内容查重**都改走它**（删掉各自的 `Promise.all` 与手写 `for` 循环）。

  **S1'/S2' 根治**：**L0 元数据 / L1 摘要 / L2 正文** 三层分离 ——
  扫描阶段 2 顺带产出 **L1a 摘要**（`keyHashes` + `exactContentHash`，**在主进程算**、渲染层零正文），
  同名查重改**只读 L1**（纯整数双指针，**永不重读正文**）。

- **实测（决定性）**：

  | 项 | 修复前 | **修复后** |
  |---|---|---|
  | 同名查重 s1000（纯查重） | **70.8s**（读 6.97GB 正文） | **9ms**（**约 7900×**） |
  | 同名查重 s5000 | **进程被 OOM 杀掉** | **7/7 通过**，堆 131MB |
  | L1 覆盖率（热缓存） | — | **1001 / 1001** |
  | 热缓存扫描 | — | **333ms**（秒开 + L1 完整 + **零读盘**） |

- **⚠️ 落地时实测踩到的两个真 bug（已修，务必记住）**：
  ① **热缓存下 L1 摘要全丢** —— 阶段 1 缓存命中分支**没带 `keyHashes`** 且 `metaPending: !hit`
     → 命中即 `false` → **阶段 2 被跳过**。表现为「**首次扫描正常、再次扫描全丢**」（极难定位）。
     修：命中时一并返回 + `metaPending: !(hit && Array.isArray(cached.keyHashes))`（老缓存必须回落补算）
     + **`wbMeta` 子结构升版**（只丢 `wbMeta`，**不动** `worldbook` 的 valid 缓存）。
  ② **「bottom-k + 倒排共现」在极端同源库下彻底失效，且重演 PK-25** ——
     所有书 keys 相同 → bottom-k 的 64 hash 全落同样书上 → 每桶顶上限 → C(500,2)×64 ≈ **800 万对** → **卡死**；
     改「高频桶整桶跳过」→ **所有桶都高频** → **候选集为空**。
     ⇒ **最终：组内直接全量精算**（同名分组已把范围缩到组内，实测 **975 对 / 9ms**）。
- **⚠️ 通用教训**：
  · **「按症状修」永远不够** —— 第一轮只改用户报出的症状，第二轮 `grep` 全库才发现还有 **10 类**漏网消费者；
  · **「把懒加载的书读进来」这个动作本身会重演 PK-20 的 OOM** —— 批量读正文**必须配套用后释放**
    （同一份代码库里这个坑被踩了两次：内容查重有释放、同名查重没有）；
  · **连续两次同款事故后就该问「是不是缺一层架构」**，而不是继续在调用点打补丁。
- **来源**：2026-09-22 用户实测反馈（秒开专项回归 + 5000 本压测）

### PK-28 ｜ 🟡 内存守卫只有「事后水位」、缺「**读前预估**」→ 超大书只能「读了才知道爆」

- **现象（不是崩溃报告，是**能力缺口**）**：`memoryGuard.js` 只在**读完之后**才按水位降级
  （30s 定时 + 加载/索引/刷新等重活后 `checkNow`）。遇超大书（如 200MB 合并书）时，
  等发现水位超标**已经分配完**，只剩「崩」或「勉强撑住」两种结局 —— **没有拒绝的机会**。
  PK-27 那次 OOM 是**内核直接杀进程**，应用连提示的机会都没有。
- **规格依据**：架构方案 §5.3「内存预算守卫」明确要求 **「读前按 `size × 2.2` 预估」的预检**
  （且评审 §3.7 指出 `usedJSHeapSize` **不含 ArrayBuffer 外部内存**，`fs.readFile` 的 Buffer 不计入堆
  ⇒ 不能只看 `used + est`）。该项在文档里长期标「⚠️ 待写死」。
- **修复（新增**纯函数** + 接到唯一批量入口）**：
  1. `js/utils/memoryGuard.js` 新增三个导出：
     · `PARSE_SIZE_FACTOR = 2.2`（实测平均 0.57 / P95 0.89，取 2.2 留 emoji 与 JS 对象开销余量）；
     · `estimateParseBytes(files, factor)` —— 纯函数，缺 `size` 的单独计数（`unknown`）；
     · `preflightRead({files, readMemory, budgetRatio, maxSingleBytes, assumedLimitBytes})` ——
       判定顺序：**① 单本超限 → 拒**（给出 `oversized` 清单）→ **② 总量超「可用余量 × 0.7」→ 拒**；
       **③ 拿不到 `readMemory` → 降级**用假定上限（4192MB）做绝对预算，**不抛错、不写死依赖** `performance.memory`。
     并给守门员加 `.preflight()` 方法（**复用同一 `readMemory`**，保证与实际水位判定同源）+ `stats.preflights / preflightRejects`。
  2. `js/composables/useWorldbooks.js` 的 **`consumeWorldbookBodies`**（**唯一**批量读正文入口）
     —— 在 **`concurrency > 1`** 的滑动窗口**之前**做预检，不过就 `throw`
     （消息含「预估峰值 / 可用预算 / 余量」，并标注是否降级）。
     ⚠️ **顺序路径（`concurrency=1`）不预检**：峰值 ≈ 单本，天然安全（预检反而徒增误拒）。
- **验证**：`test/memoryGuard.test.mjs` 新增 **6 例**（系数与缺 size 计数 / 单本超限拒 / 总量超预算拒 /
  正常放行 / 拿不到 `readMemory` 降级 / `.preflight()` 计数）→ `npm test` **542 pass / 0 fail**；
  `npm run build:web` ✅；真实启动冒烟无 `[Vue 错误]`；`npm run guard:batch-read` ✅。
- **⚠️ 教训**：**「事后监测」与「事前预防」是两件事，不能只做前者** ——
  内存守卫做了半年「事后水位」，但真正会致命的那次（PK-27）**根本没机会执行到事后检查**。
  凡是「分配型」操作（批量读文件、构建大索引），都该问一句「**能不能在分配前先算一算**」。
- **来源**：2026-09-23 遗留任务盘点（架构方案 §5.3 标「⚠️ 待写死」的项）

### PK-29 ｜ 🔴 内容级查重**把无关世界书判为重复**：simhash 阈值失准（T=19 过宽）+ Union-Find **传递链误聚**

- **现象（用户实测原话）**：「两完全不相似的世界书进行对比查重」被判为重复 —— 弹窗把
  `超棒全能情感cot`（3192 字）与 `鬼物`（13840 字）显示成「🧬 内容几乎完全一致」的同一组，
  并给出「✅ 保留此版，清理其余」按钮（**一键可误删真书**）。
- **根因（两个独立缺陷叠加）**：
  1. **阈值 T=19 失准**。S0.5 实验定 T=19 的依据是「正样本 max 8 / 负样本 min 31」，
     但那是在**合成样本**上测的。**真实库实测无关对距离低至 17** —— 直接落进阈值内。
  2. **Union-Find 传递链误聚**。即使每对单独看都合法（A~B ≤ 19、B~C ≤ 19），
     **A~C 可以远超阈值**（实测 29）。并查集把它们**并成一簇**，弹窗只显示「与推荐版的距离」
     ⇒ 用户看到「相似度 55%」却仍被标注为同组、按钮仍是「清理其余」。
- **取证（真实库 `H:\01\全局世界书`，32 本参与比对，2026-09-23）**：
  | 项 | 实测 |
  |---|---|
  | simhash 判出的候选对 | 18 对 |
  | 其中**真实内容重叠 < 50%**（纯误判） | **10 对（55.6%）** |
  | 最严重 | `超棒全能情感cot(1)` ↔ `鬼物`：汉明距离 **19**，真实 4-gram Jaccard **0.1%** |
  | 传递链误聚 | `鬼物` ↔ `世界书-性爱世界书` 距离 **29**，却与另外 4 本串成一组（6 本） |
  | 无关对距离最小值 | **17**（S0.5 声称「负 min 31」**在真实库不成立**） |
  | 阈值扫描（以真实 Jaccard 为真值） | `T ≤ 16` 时**零误报零漏报**；`T = 19` 时 **10 对误报** |
- **⚠️ 为什么旧探针没抓到**：`_probe-content-dedupe-fix.mjs` 只断言「**有没有分组**」
  （有分组即 ✅），从不校验「**分组内容是否真的相似**」—— 典型的**假绿**
  （与 AR-46 同型：探针只采「存在性」，不采「正确性」）。
- **修复**（2026-09-23）：
  1. **阈值收紧到实测安全区**：`SIMHASH_THRESHOLD` 19 → **16**（T≤16 实测零误报零漏报）；
  2. **预筛 + 真实内容复核双闸门**：simhash 仅作**候选预筛**，分组前用
     **MinHash 签名 + `estimateSimilarity ≥ 0.85`** 做二次复核（内存安全：96 int/本，
     与「当场算签名即丢弃正文」的内存优化不冲突）；
  3. **并查集改「簇心校验」**：合并前要求与**簇心**的距离也在阈值内，
     从机制上杜绝「A~B~C 链式误聚」；
  4. **弹窗补可验证依据**：显示真实相似度百分比 + 距离值，不再只给「高度相似」这种无法核对的断言。
- **验证**：`scripts/probes/_probe-content-dedupe-offline.mjs`（离线真值复算）+ 
  `_probe-simhash-calib.mjs`（阈值标定）+ `_probe-simhash-vs-jaccard.mjs`（失真取证）+
  `_probe-simhash-verify-choice.mjs`（修法选型：MinHash 复核 TP=8 FP=0 FN=0）。
- **来源**：2026-09-23 用户实测报出（「两完全不相似的世界书进行对比查重」）

### PK-30 ｜ 🔴 MinHash 哈希族**完全退化**（96 个 seed 有 95 个选出同一个 shingle）→ 相似度估计严重失真

- **现象**：MinHash 估计值与真实内容相似度**完全脱节** —— 实测真实 4-gram Jaccard **0.2%** 的两本
  世界书，MinHash 估计 **68.8%**（误差 **68.5%**，而 96 维的理论标准误仅 ≈ 10.2%）。
  该失真会让「复核闸门」形同虚设（PK-29 的修法依赖它）。
- **根因**：`hashString(str, seed)` 实现为 `h = (h * 31 + charCode) >>> 0`。
  对**等长** shingle（本项目的 4-gram **恒为 4 字符**），seed 只贡献一个**线性偏移** `seed * 31^len`：
  ```
  h = seed*31^n + c0*31^(n-1) + ... + c(n-1)
  ```
  ⇒ **不同 seed 不改变 shingle 之间的相对顺序** → 96 个「独立」哈希函数实际只有 **1 个**。
- **取证**（`_tmp-diag-minhash.mjs`，300 个等长 shingle × 96 个 seed）：
  | 指标 | 现有实现 | 独立哈希期望 | 修正版 |
  |---|---|---|---|
  | 「最小值落在哪个 shingle」的不同取值数 | **2 / 300** | ≈ 96 | **79 / 300** |
  | 被选中最多者次数 | **95 次**（95/96 个 seed 选同一个） | ≈ 1 | 3 |
  | 哈希函数两两**排序一致率** | **100.0%** | ≈ 50% | **50.1%** |
- **影响面**：角色卡 / 预设查重（一直用 MinHash + LSH）、`estimateSimilarity` 展示的相似度
  —— 全部基于退化签名，**估计值不可信**（PK-29 的「真实 0.1% 显示 70%」有它一份贡献）。
- **修复**：`hashString` 改 **FNV-1a 异或 + 雪崩混合**（`Math.imul(h ^ c, 0x01000193)` +
  三次 `h ^= h >>> k` 与奇数乘法），使不同 seed 产生真正独立的排列。
  ⚠️ **签名口径变更** → 必须同步升 `WB_META_CACHE_VERSION`（若有落盘 MinHash）+ 补回归单测。
- **验证**：`test/contentDedupeFalsePositive.test.mjs` 增「哈希族独立性」断言
  （不同 argmin 数 ≥ 50、排序一致率 ∈ [0.4, 0.6]）。
- **⚠️ 教训**：**「看起来随机」不等于「真的随机」**。`h*31+c` 是教科书级的字符串哈希，
  但在「**定长输入 + 多 seed**」这一组合下会**结构性退化** —— 而项目用了 5 个版本没被发现，
  因为**从没有人校验过哈希族本身**（只校验了最终结果「看起来对不对」）。
  凡「多哈希函数族」（MinHash / LSH / 布隆过滤器），**必须单独验证函数间独立性**。
- **来源**：2026-09-23 排查 PK-29 时发现（复核闸门标定暴露出 68.5% 的异常误差）

### PK-19 ｜ 🟡 `_getMatches` 的**拉丁前缀**回退是 O(词表) 全表扫描（中文词不受影响）
- **现象**：万卡库输入**拉丁字母**时，每敲一个字母都有可感知迟滞（实测 150 万 token 上 **19~36ms/次**，且随 token 表线性增长）。
- **根因**：`searchIndex._getMatches(keyword)` 先 `index.get(keyword)` 精确命中，**miss 时退化为遍历整个倒排表**
  `for (const [word, cards] of this.index) if (word.includes(keyword)) matches.push(...cards)`。
  中文按单字建 token → 单字查询必精确命中（不走这里）；但**拉丁词是整词 token**，用户输前缀（`syst`）时整词 `system` 命中不了 →
  每次都全表扫。另有 `matches.push(...cards)` 的参数展开（已证否为风险：`_indexCardInto` 的 `buf.cards.has(card)` 幂等保证**单个桶 ≤ 卡数**，22k 库不可能触发上限）。
- **修复**（2026-09-22 **已实施，✅ 落地**）：**bigram 候选索引**（`searchIndex.js`）——
  `bigram → token 下标（Int32Array）`，查询时取**最稀有** bigram 的候选集再 `includes` 精筛（候选只是**超集**，语义完整保留）。
  实测（11k 卡 / 112 万 token）：**全表扫 19~44ms → bigram 0.5~1.3ms（快 20~70 倍）**；内存 **+18.9MB**。
  ⚠️ **为何不用「有序数组前缀区间」或「首字母桶」**：实测两者都**破坏子串语义**（`aster` 这类词中片段会漏命中）——
  已有专测 `test/latinPrefix.test.mjs`（14 例）把「与全表扫基线逐条一致」作为硬判据。
  **降级策略**：单字符查询（无 bigram 可用）/ `add`·`remove` 后（下标失效置脏）→ 回退全表扫（**只变慢、绝不错**）。
- **来源**：2026-09-21 查重链路专项实测（2026-09-22 Phase 3 修复）

### PK-20 ｜ 🔴 世界书大库扫描：**主进程扫完了、渲染层拿不到**（501 本直接退出应用）
- **现象**：世界书目录达数百本大书时，点「打开世界书目录」→ **应用直接退出**（无 `crash.log`）。
  本机实测：**501 本有效世界书（542 个 `.json` / 3.56GB，每本 6.5~10MB）→ 应用退出**；可稳定复现 3 次。
- **根因（三层，已用证据链钉死）**：
  1. `wb:scan` 对 **≤50MB** 的世界书**内联完整 `data`**（`results.push({ path, name, data: wbData })`），
     且是**单次 IPC 一次性返回**；
  2. 世界书**没有角色卡那样的瘦身**（`js/utils/cardSlim.js` 只服务角色卡）→
     ≤50MB 的**完整词条正文全量驻留渲染堆**；
  3. 501 本 ≈ 4GB 对象要跨进程 structured clone + 渲染层接收，而渲染堆上限实测 **4192MB** → OOM。
- **证据链（每个规模独立 profile，`scan_cache.json` 落盘条数 = 主进程扫描进度）**：

  | 规模 | 体积 | 主进程 `scan_cache` | 渲染层结果 | 堆峰值 |
  |---|---|---|---|---|
  | 50 本 | 0.35GB | 50 条 `valid=true` ✅ | ✅ 完成 3.3s | 249MB |
  | 100 本 | 0.69GB | 100 条 ✅ | ✅ 完成 12.3s | 579MB |
  | 200 本 | 1.38GB | 200 条 ✅ | ✅ 完成 **160.9s** | 1154MB |
  | 300 本 | 2.08GB | **300 条 ✅** | ⏰ **超时（>300s）** | — |
  | 501 本 | 3.56GB | **541 条 ✅** | 💥 **应用退出** | — |

  ⇒ **每一档主进程都扫完了**，瓶颈**只在 IPC 回传 + 渲染层接收**。
  100→200 本耗时涨 **13 倍**（12.3s→160.9s），是**非线性膨胀**，不是线性变慢。
- **为什么 `crash.log` 是空的**：`main.js` 的 `render-process-gone` 兜底确实会写 `crash.log`，
  但实测该文件**不存在** —— 说明主进程也一同死亡（或被原生层直接终结），兜底日志没机会落盘。
  这也意味着**用户侧完全没有任何可诊断线索**。
- **修复（2026-09-22 已实施，✅ 24/24 通过）**：**累计内联预算**（`SCAN_INLINE_TOTAL_MAX_BYTES = 256MB`）
  - 扫描过程中累计已内联的**字符量**，超预算的文件**仍做完整判定**（保证正确性），但**不保留正文**：
    `dataLoaded:false` + `data:null`，**`entryCount` 仍给准确值**（已 parse，零额外成本）；
  - 正文由渲染层按需 `readText` 懒加载 —— **复用既有 DF-18 机制，前端逻辑零改动**；
  - 侧栏对未载入的书显示「N 词条 + 按需」徽标（**不谎报 0 词条**），日志里也告知用户。

  | 指标 | 修复前 | 修复后 |
  |---|---|---|
  | 501 本结果 | 💥 **应用退出** | ✅ **完成 21.1s** |
  | 渲染堆 | OOM（上限 4192MB） | **324MB / 4192MB（7.7%）** |
  | 内联 data | ≈4GB | **372MB**（56 本内联 / 445 本按需） |
  | 入库 / 跳过 | 崩溃，无结果 | **501 / 41**（与磁盘事实**零分歧**） |
  | 进度条 | — | 115 事件，`total=542` 准确、终态 `done===total` |
  | 二次扫描 | — | 20.6s，数量与跳过数一致 |

- **📖 向外探索（关键依据）**：对比对标的开源实现 **SillyTavern**（`public/scripts/world-info.js`，6408 行）：
  - 它的**列表态只有 `world_names`（纯文件名数组）**，**压根不含 entries**；
  - 正文靠 `loadWorldInfo(name)` **按需 fetch** + `worldInfoCache`（`StructuredCloneMap`）缓存；
  - 编辑器**分页**（`perPageDefault = 25`，可选 10~1000）；
  - 扫描只覆盖「**被激活的**」书（全局 / 角色绑定 / 聊天 / persona）；
  - 近期 commit：`Optimize World Info entry sorting to avoid O(n^2) lookups`。
  ⇒ 「**列表态不常驻正文**」是成熟实现的共识 —— 本修复与之对齐。
- **⚠️ 实现踩坑（写进代码注释，避免重踩）**：
  1. **不能在「读文件之前」就 `return` 只回元数据** —— 那会**绕过 `isValidWorldbook` 校验**，
     把目录里的诱饵 JSON（角色卡 / 大表格）也当成世界书入库（**实测 36 个诱饵被误判**：501→537）；
  2. **不能用 `st.size`（磁盘字节）当预算口径** —— 字节 ≠ 对象体积，会严重低估内存占用；
     必须用 parse 后的真实字符量（`content.length`，直接反映 JS 字符串内存）；
  3. **断言判据要跟着机制改**：`data === null` 不再等价于「未 parse」（预算转懒加载的书也是 `data:null`），
     正确判据是 `entryCount === null`。
- **验证**：`scripts/probes/_probe-wb-stress-500-lib.mjs`（**24/24**）、`scripts/probes/_probe-wb-scale-sweep.mjs`（规模梯度）、
  `scripts/probes/_probe-wb-lib-audit.mjs`（磁盘实测构成）、`scripts/probes/_probe-wb-scan-diff.mjs`（**应用 vs 磁盘零分歧**）。
- **来源**：2026-09-22 世界书 500 份压力测试专项（用户指定「复制 500 份做压力测试」）

### PK-21 ｜ 🔴 差异比对「**分散改动**」→ 假阳性 99.15%（降级策略按行号对齐）
- **现象**：两本几乎相同的世界书做「词条正文总集比对」时，**几乎整篇被标成「变更」**，
  用户完全无法定位真实改动。
- **根因**：`js/utils/textDiff.js` 的超长文本降级策略 `positionalOps` **按行号逐行比对**（`a[i] === b[i]`）。
  只要文本**中段发生行数变化**（插入/删除行），**后续所有行号全部错位** → 整段被判 `del` + `ins` →
  在 `appendRows` 里按顺序**配成 `changed`**。
  触发条件：全篇行数 > `MAX_LCS_LINES`（1500）**且**改动导致行数变化（分散改动是常态）。
- **实测数据**（真实 397 词条世界书拼接，23745 行，**首尾各改 1 行**）：

  | 指标 | 数值 |
  |---|---|
  | 真实改动 | 2 行 |
  | 算法报出 | `same: 205` / **`changed: 23540`** / `added: 2` |
  | 假阳性率 | **99.15%**（放大 **11771×**） |
  | 耗时 | 0.06s（不慢，是**错**） |

- **不受影响的场景**：单条词条（≤1500 行）走 LCS，正确 —— 实测改写 A（改正文）0.7ms、D（插删行）0.1ms。
- **修复（2026-09-22 已实施，✅ 22/22 通过）**：把降级策略从「按行号」换成「**锚点对齐**」（Patience Diff 风格）：
  ① 找**在两侧都恰好出现一次**的行作为锚点（唯一行 → 高置信度对应）；
  ② 用**最长递增子序列（LIS）**保留顺序一致的锚点（防重排导致错位）；
  ③ 以锚点把区间切成小段、**递归**处理；
  ④ 段小到 `ANCHOR_EXACT_LINES = 500` 以内 → 直接做**精确 LCS**（旧降级正是缺了这一步）；
  ⑤ 找不到锚点时退回「先删后增」——**最保守的表达，绝不制造大面积假 `changed`**。

  | 指标 | 修复前 | 修复后 |
  |---|---|---|
  | `changed`（假阳性） | **23540** | **0** |
  | 假阳性率 | **99.15%** | **0.01%** |
  | 放大倍数 | 11771× | **1×** |
  | 耗时 | 0.06s | **0.02s** |

  另：单条词条（≤500 行走精确 LCS）**本来就对**，修复后仍全对（A=0.5ms / D=0.1ms）；
  `truncated` 语义改为「**走了降级路径**」（不再是「结果不可靠」——锚点法结果可靠）。
- **⚠️ 断言不能写窄（本次踩到 3 次）**：「尾部追加」的正确语义是 **added**（不是 changed）；
  「插行 + 删行」的正确语义是 **added + removed**（不是 changed）。
  若把「没有 changed」判为失败，就会误报。已补一个**真正「修改已有行」**的用例专门验 `changed` + 行内高亮。
- **验证**：`scripts/probes/_probe-textdiff-real.mjs`（**22/22**，纯 Node 直接 import 被测模块，与浏览器同一份源码）。
- **来源**：2026-09-22 世界书 500 份压力测试专项

### PK-22 ｜ 🔴 差异弹窗卡顿：整篇比对 + 397 个词条卡片一次性渲染（34,232 DOM 节点）
- **现象（用户报）**：「关于扫描对比的窗口的流畅性检查一下是否有卡顿点」
- **实测定位（真实 397 词条世界书对比）**：

  | 环节 | 数值 | 判定 |
  |---|---|---|
  | 算法部分（`alignEntryLists` + `diffContentForDisplay`） | **29ms** | ✅ 不是瓶颈 |
  | **弹窗 DOM 节点数** | **34,232** | ❌ **元凶** |
  | 单次长任务（longtask） | **750ms** | ❌ 主线程阻塞 |
  | 事件循环延迟 max（差异弹窗期） | **843ms** | ❌ 明显卡顿 |
  | 事件循环延迟 max（查重扫描期） | **4866ms** | ❌ |

- **根因**：`DiffModal.vue` 把**全部内容一次性渲染**，两个来源：
  1. 「📝 词条正文总集比对」：全篇 397 词条拼接 = **23,745 行**，两侧各渲染一遍 → 约 2.4 万节点；
  2. 「🧩 词条级对齐」：**397 个词条卡片**，每个卡片带触发词 chips + 正文 → 约 1 万节点。
  而这两块**内容高度重复**（用户真正要看的是第 2 块）。
- **修复（三层，均为「按需渲染」而非删功能）**：
  1. **整篇比对默认折叠** —— 显示「▶ 展开整篇比对（共 N 行）」按钮，要看再点开；
  2. **长列表分块渲染** —— 整篇比对每批 400 行、词条内正文每批 400 行，底部「▼ 显示更多」按需追加；
  3. **词条卡片分页** —— 每页 30 个词条卡片 + 「▼ 显示更多词条」。
  另：`watch(show)` 在每次打开时复位折叠/分页状态，避免上一次的展开态与巨大 DOM 残留。
- **验证（`scripts/probes/_probe-diff-perf.mjs`，10/10 通过）**：

  | 指标 | 修复前 | 修复后 |
  |---|---|---|
  | 弹窗 DOM 节点 | **34,232** | **1,044**（**-97.0%**） |
  | 首屏渲染 | ~900ms | **24ms** |
  | 展开整篇比对 | 一次性 2.4 万节点 | **400 行**分块（+3,206 节点 / 13ms） |
  | 词条卡片 | 397 个全渲染 | 30 个/页 |
  | 重开后状态 | — | 回到折叠 + 首页（不累积） |

- **测量陷阱（写进脚本注释，避免下次重踩）**：
  - 用 `requestAnimationFrame` 等「渲染完成」→ **后台窗口下 rAF 根本不触发**，
    探针会卡到窗口被激活（实测读出 **191333ms** 的假耗时）；
  - 把自设的 `setTimeout(900)` 算进「打开耗时」→ 读数虚高；
  - **DOM 节点数是确定性指标**，不受窗口可见性影响 → 作为主判据（longtask/lag 采样不稳定）。
- **来源**：2026-09-22 用户 UX 反馈（问题 3）

### PK-23 ｜ 🔴 世界书大库「打开慢」：列表必须读完全部文件才算完（1001 本 36 秒）
- **现象**（用户要求）：「我要他的加载和角色卡一样进行**秒开**程序秒加载的效果」。
  实测：世界书目录 1001 本（6.97GB）**首次完整列出要 36.0s**，5401 本约 **150s** ——
  用户点开目录后界面长时间空白，与角色卡库的即时反馈**体验割裂**。
- **根因（阶段分解实测，`scripts/probes/_probe-scan-phases.mjs`）**：

  | 阶段 | 1001 本耗时 | 说明 |
  |---|---|---|
  | ① 递归 `readdir`（只取文件名） | **7ms** | 几乎免费 |
  | ② ① + `stat`（size/mtime） | **43ms** | 几乎免费 |
  | ③ 读全部内容 + `JSON.parse` | **36.0s** | **瓶颈 100% 在这里**（6.0MB/本 × 33ms） |

  ⇒ 列表**根本不需要正文**（书名可从文件名推、词条数只在徽标上显示），
  却为了拿书名/词条数**把 6.9GB 全部读进来 parse 一遍**。
- **📖 向外探索（关键依据）**：对标的 **SillyTavern**（`src/endpoints/worldinfo.js` 的 `/list`）——
  - 它遍历目录时**也读文件**，但**只保留 `{ file_id, name, extensions }`、丢弃 entries**；
  - 它之所以够快，是**世界书数量少**（几十本），**不是**它算法更好。
  ⇒ 千本量级必须**比它更进一步**：**列表阶段完全不读文件**。
- **修复（2026-09-22，⚡ 两阶段秒开）**：
  1. **阶段 1 —— 秒开**：`wb:scan` 新增 `opts.fastListOnly`，**只做 `readdir` + `stat`**，
     返回 `{ path, name, size, mtime, entryCount?, wbName?, dataLoaded:false, metaPending }`
     —— **一个字节正文都不读**（命中缓存则直接带上 `wbName` / `entryCount`）。
  2. **阶段 2 —— 后台补元数据**：新增 **`wb:meta` IPC 通道**（`fetchWorldbookMeta(paths)`），
     批量读文件名/词条数，**只返回 `{ path, wbName, entryCount }`，绝不返回正文**；
     命中 `scan_cache.json` 的 `wbMeta`（`path + mtime + size` 一致）则**跳过读盘**。
  3. **持久化元数据缓存**：`scan_cache.json` 新增 `wbMeta`（`{ mtime, size, name, entryCount }`，
     **不存正文**）→ 二次打开**0 次读盘**。
  4. 渲染层：`useWorldbooks.scanWorldbookDir` 改为「秒开 → `adoptScanResult` → 后台补全 → `triggerRef`」；
     新增 `wbDisplayName(wb)`（**书名优先 `wbName`，回退文件名** —— 因为 `data` 不再常驻）；
     `wbMetaFilling` / `wbMetaProgress` 供界面显示补全进度。
- **实测对比**：

  | 指标 | 修复前 | 修复后 |
  |---|---|---|
  | **1001 本列表** | **36.0s** | **83ms**（**提速 434×**） |
  | **5401 本列表** | ≈150s（外推） | **237ms** |
  | 二次打开（缓存命中） | 36.0s | **78ms** / **220ms** |
  | 阶段 1 读盘量 | 6.97GB | **0 字节** |
  | 元数据补全 | 同步阻塞 | 后台异步，5401/5401 全部补齐 |
  | 渲染堆 | — | **15MB（1001 本）/ 19MB（5401 本）**，上限 4192MB |

- **⚠️ 实现踩坑（都是 `vite build` 查不出、**真实启动冒烟**才抓到的）**：
  1. `wbDisplayName` **漏进 `useWorldbooks` 的解构** → `ctx.wbDisplayName` 未定义 → **Vue 挂载失败（白屏）**；
  2. `wbDisplayName` 在 `App.vue` **重复声明**（加了两处）。
  ⇒ 再次印证铁律：**`vite build` 只验编译，不验运行时**（TDZ / 未定义引用照过）。
- **兼容性**：完整扫描（`rescanWorldbooks`，无 `fastListOnly`）保持原样，
  查重 / 版本对比链路**行为不变**；秒开只服务「打开目录列列表」这一条路径。
- **验证**：`scripts/probes/_probe-instant-open.mjs`（**1001 本 10/11、5401 本 10/11** —— 唯一失败项是
  探针**断言写死 5001 而磁盘实为 5401**，非缺陷）、`scripts/probes/_probe-scan-phases.mjs`（阶段分解）、
  `scripts/probes/_probe-wb-stress-5k.mjs`（5000 本完整极端压测）。
- **来源**：2026-09-22 用户要求「世界书加载和角色卡一样秒开」+ 5000 本极端压力测试专项

### PK-24 ｜ 🔴 秒开引入的回归：阶段 1 **不做世界书校验**，诱饵 JSON 混进世界书列表
- **现象**（2026-09-22 5000 本极端压测暴露）：
  同一目录下，**秒开列出的数量 ≠ 完整扫描的有效数量** ——
  实测 `s5000`：阶段 1 列出 **5401** 本，完整扫描只认 **5001** 本有效（**400 个诱饵被混进列表**）。
  用户会看到角色卡 JSON / 酒馆预设 JSON / 大表格 / 损坏 JSON 出现在世界书库里，
  点开时才发现「这本根本不是世界书」。
- **根因**：`wb:scan` 的 `fastListOnly` 分支（PK-23 新增）**只按 `.json` 后缀筛选**：
  ```js
  .filter(e => !e.name.startsWith('.') && e.isFile() && path.extname(e.name).toLowerCase() === '.json')
  ```
  而完整扫描分支会 `readFile` + `JSON.parse` + **`isValidWorldbook`** 严格防伪
  （排除 `spec === 'chara_card_v2/v3'`、必须有 `entries`、词条须含 `key/keys/content/comment/uid`）。
  秒开为了「不读文件」把这个校验**整条跳过**了 —— 这正是 DF-18 踩坑记录里
  「**不能在读文件之前就 return 只回元数据 → 会绕过 `isValidWorldbook` 校验**」的**同款错误**，
  只是这次换了个形式（不 return，而是**根本不做校验**）。
  更隐蔽的是：`wb:meta` 通道**也不校验**，所以诱饵不但进了列表，还**拿到了书名与词条数**，
  看起来和真世界书一模一样（`entryCount` 甚至是 0，显示成「0 词条」）。
- **修复（2026-09-22，复用已有缓存做「零额外读盘」的校验）**：
  关键洞察 —— **`scan_cache.json` 的 `worldbook` 缓存里已经存了每个文件的 `{ mtime, valid }`**
  （完整扫描时写入）。所以秒开**不必读文件就能知道有效性**：
  1. **阶段 1**：查 `worldbook` 缓存
     - `mtime` 一致且 `valid === false` → **直接剔除**（计入 `skipped`，不再进列表）
     - `mtime` 一致且 `valid === true` → 收录，且可安全使用 `wbMeta` 缓存的 `wbName`/`entryCount`（0 次读盘）
     - `valid === null` / **无缓存** → **暂收录**并标 `metaPending`，交给阶段 2 判定
  2. **阶段 2（`wb:meta`）**：读文件时**顺带跑 `isValidWorldbook`**，把 `{ mtime, valid }` 写回
     `worldbook` 缓存；返回体加 `valid` 字段；**无效文件不写 `wbMeta` 缓存**（不产生假书名）
  3. **渲染层**：阶段 2 完成后，把 `valid === false` 的条目**从 `worldbooks` 移除**，
     并在日志里报告剔除数量
- **行为权衡（有意设计）**：

  | 场景 | 行为 | 代价 |
  |---|---|---|
  | **首次打开**（无缓存） | 秒开先列出全部 `.json`（可能含诱饵）→ 阶段 2 后台**剔除** | 列表**短暂**含诱饵（约 1~2s），随后消失 |
  | **二次打开**（有缓存） | 阶段 1 **精准列出**，诱饵**从不出现**，且 **0 次读盘** | 无 |

  ⇒ 严格优于修复前（修复前首次打开要 **151s** 白屏）。**「先快后准」比「先准后慢」体验好得多。**
- **防再犯**：**任何「为了性能跳过某一步」的优化，必须先确认那一步不是「正确性关卡」**。
  本项目里 `isValidWorldbook` 是**入库守门员**，跳过它 = 把非世界书当世界书（DF-18 已记过一次）。
  若确实不能跳过，就**找一个不读文件的替代信号**（本次用的是**缓存里的既有判定**）。
- **验证**：`scripts/probes/_probe-wb-stress-5k.mjs` 的 C 组断言 `渲染层加载全部书 = 完整扫描有效数`
  （修复前 **5401 vs 5001** ❌ → 修复后应相等）；`scripts/probes/_probe-instant-open.mjs` 断言阶段 1 数量。
- **来源**：2026-09-22 世界书 5000 本极端压力测试专项（用户要求「测试其他改动的和未改动的功能来确保没有其他 BUG 诞生」）

---

### PK-31 ｜ 🔴 「正文懒加载」的**读侧**没有入口 —— 差异比对 / 全库词条搜索 / 搜索过滤 把瘦身态当「真的空」，输出**空结论**

- **现象（用户实测，2026-09-25）**：查重结果里 `秋青子` 这一组点「🔍 查看内容差异」，
  两侧全是「**（无正文）**」与「**本端无此词条**」；而**匹配上的词条显示「一致」**——
  真相是"**两边内容都是空字符串**"。用户原话：「我不说对错你觉得有问题么」。
- **根因（一类事，三处同病）**：P1a（`js/utils/cardSlim.js`）把卡内世界书词条 `content` 清空省内存，
  **运行期是瘦身态还是完整态取决于"谁在什么时候读过盘"**；而**读侧没有任何统一入口**，
  于是三处各自直接读 live 内存 ⇒ 拿到空串却当成"真的空"：

  | # | 位置 | 证据 |
  |---|---|---|
  | ① | `useDedupe.js openDiffDetailModal` | 运行时实测该组两张卡均 `_slim: true`（`- juus - (2).png` 同型：**54 条词条 / 非空 0 条**）；该函数只对**独立世界书**有懒加载兜底（`it.dataLoaded === false`），**对卡片没有** |
  | ② | `useGlobalEntrySearch.js refreshGlobalEntryIndex` | **同一函数内不对称**：世界书侧调了 `ensureWorldbookLoaded`，**卡片侧没调** ⇒ 卡片词条正文搜不到 |
  | ③ | `useSearch.js` 的 `wb:` 过滤 + `extractCardSearchableText` 兜底 | 同步路径直接读 live `character_book`（无 await 机会） |

- **⚠️ 这是"既有的 ⬜ 待复测项"被证伪**：PK-16 修复时留下
  「⬜ 待复测：启动日志应只剩一轮索引构建 + 预热；**世界书词条正文关键词在瘦身库上仍可被搜索命中**」——
  该项**从未执行**，本次实测结论是**否**（索引保持完整态≠读侧有正文；③ 的 live 过滤根本不看索引）。
- **同类第 4 处（非懒加载专属）**：`ContentDedupeModal.vue:104` 徽标**内联硬编码**
  `_simPct >= 98 ? '🧬 内容几乎完全一致' : '⚠️ 高度相似，细节有差异'` ⇒ **9% 也显示「高度相似」**，
  与同一张卡上的「⚠️ 仅名称相同」当场矛盾（AR-51 修了 💡，**漏了这里**）。
- **修复（见 [`../技术支持/世界书与卡片/方案-卡片正文口径收口.md`](../技术支持/世界书与卡片/方案-卡片正文口径收口.md)）**：
  ① `cardSlim.js` 升级为**注册式入口**（`setCardBodyLoader` / `ensureFullBody`，缺加载器**告警不静默**）；
  ② 差异比对、全库词条搜索、全局资产库**统一走该入口**；全库词条搜索关闭时**交还**内存；
  ③ 同步路径（`wb:` 过滤）**诚实降级**：索引不可用时显式提示"按触发词筛选"，不假装按正文筛过；
  ④ 徽标改由**百分比分档**产出（与 💡 同源）；
  ⑤ CI 新增 `guard:card-body` 守卫（白名单制，防第四处）。
- **验证**：见方案 §四（接手的 ⬜ 项 + 真实库热测 + 守卫正向对照）。
- **来源**：2026-09-25 用户实测反馈（查重差异比对看不到正文 + 「你觉得有问题么」追问）

---

### PK-32 ｜ 🔴 保存链路可把**空正文写回文件**（数据丢失风险）—— 既有「读失败拒开」只保护了一条路

- **现象**：还没炸（抽样真实库 **163 张可解析卡 0 张中招**），但**路径是通的**：
  只要对瘦身库里的卡改一次标签（单卡/批量/AI 打标后落盘），该卡**整本内嵌世界书的正文会被写空**。
- **实测证据（运行中的真实 11k 库，只读）**：
  `- juus - (2).png` → `_slim: true` / `_bookCount: 54`；
  内存「54 条词条，**非空 0 条**」；复算 `persistCardUpdate` 将送出的 payload：
  **`entries 54 / nonEmpty 0 / altGreetings 0`** ⇒ `danger: true`。
- **根因（两层）**：
  1. **前端**：`useCardCrud.js persistCardUpdate` 直接
     `saveCard(path, JSON.parse(JSON.stringify(cardItem.data)))`，**保存前不还原正文**；
     调用点全是"**库条目**"（可能瘦身）：`useBatch.js:210`（批量贴标签）、`useAITools.js:289`（AI 打标后落盘）、
     `useTags.js:223/274/326/374/418/504`、`App.vue:1382/2698/3371/3491`。
  2. **主进程**：`main.js:2808 file:saveCard` → `writeTavernPNGChunk(buffer, updatedJson)`
     把 payload **原样内嵌**（只 `stripInternalFields`，**不与磁盘旧卡做任何比对/合并**）。
- **⚠️ 既有设计早预言过这个风险，但只覆盖了"打开卡"这条路**：
  `CHANGELOG.md` v2.2.7（五）原文「打开卡片…**读失败即拒绝打开**（**否则编辑器空字段一保存就把卡写空**）」；
  批量/非打开路径（贴标签、AI 打标）**没有等价保护**。
- **修复（两道）**：
  1. **出口闸门（主进程，不依赖前端记得）**：`file:saveCard` 保存前读磁盘现有卡，
     统计「有正文的词条数 / `alternate_greetings` 条数」；若 `oldNonEmpty > 0 && newNonEmpty === 0`
     ⇒ **拒绝写入 + 明确报错**（原文件不动，提示"疑似传入未还原的卡片"）。
  2. **前端补还原**：`persistCardUpdate` 保存前 `ensureFullBody(cardItem)`（双保险）。
- **验证**：隔离库实测——瘦身态 payload ⇒ **被拒且文件 SHA-256 不变**；完整 payload ⇒ 正常写入。
- **来源**：2026-09-25 审计（用户追问「你打算一对一修卡吗」→ 沿"懒加载口径"全链路排查时发现）

---

## 五、本领域的「护栏」（改动性能相关代码前先看）
1. **索引重建必须可重入安全**：代次号 + 幂等 + 结果 `Set` 去重 + 合并重建，四件套缺一不可。
2. **任何"刷新/加载"入口都要有互斥或合并**（`withLoadLock` + coalesce），并把「扫描返回 0 文件」当异常处理。
3. **写盘判据必须基于磁盘现状**（幂等），绝不基于"清洗后的内存状态"。
4. **后台任务不能只依赖 `requestIdleCallback`**。
5. **不为便宜的数据加缓存**；大对象跨进程只走一次（优先传文本让对方自己 `JSON.parse`）。
6. **正文懒加载（>3000 张库自动启用）不是可选项**：`slimCard` 只释放词条正文与 `alternate_greetings`，保留名称/标签/token/`_hasBook`；`ensureCardFull` 负责开卡时读回，读失败**拒绝打开**而不是显示半张卡。
7. **索引跨代沿用（`buildAsync(..., { reuse: true })`）是正文懒加载的前置** —— 否则刷新时复用卡没正文可分词，会一条都进不去索引（刷新即搜索失效）。
8. **读正文必须走统一入口**（`cardSlim.ensureFullBody`）—— 任何直接读 `character_book` / `alternate_greetings` 的消费点，必须在 `npm run guard:card-body` 的**白名单**里登记处理方式（`ensure` / `current-card` / `index-earlier` / `slimmer` / `save-guard`）；缺加载器时**告警不静默**（PK-31）。
9. **写文件不得让正文变空** —— 主进程 `file:saveCard` 已有「正文集体变空 ⇒ 拒写」闸门（PK-32）；任何绕过 `saveCard` 的新落盘通道必须自带等价闸门。
