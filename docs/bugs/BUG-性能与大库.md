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

---

## 五、本领域的「护栏」（改动性能相关代码前先看）
1. **索引重建必须可重入安全**：代次号 + 幂等 + 结果 `Set` 去重 + 合并重建，四件套缺一不可。
2. **任何"刷新/加载"入口都要有互斥或合并**（`withLoadLock` + coalesce），并把「扫描返回 0 文件」当异常处理。
3. **写盘判据必须基于磁盘现状**（幂等），绝不基于"清洗后的内存状态"。
4. **后台任务不能只依赖 `requestIdleCallback`**。
5. **不为便宜的数据加缓存**；大对象跨进程只走一次（优先传文本让对方自己 `JSON.parse`）。
6. **正文懒加载（>3000 张库自动启用）不是可选项**：`slimCard` 只释放词条正文与 `alternate_greetings`，保留名称/标签/token/`_hasBook`；`ensureCardFull` 负责开卡时读回，读失败**拒绝打开**而不是显示半张卡。
7. **索引跨代沿用（`buildAsync(..., { reuse: true })`）是正文懒加载的前置** —— 否则刷新时复用卡没正文可分词，会一条都进不去索引（刷新即搜索失效）。
