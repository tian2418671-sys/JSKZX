# 🧰 技术支持文档索引（docs/技术支持/）

> 本目录存放**可复用的技术资产**：完整代码片段、实测技术数据、外部 API 参考、格式规范、探针工具。
> 与 `docs/bugs/` 的分工：那里写「坏在哪、怎么修」，这里写「**代码长什么样、实测数字是多少、外部接口怎么用**」。
> **📁 目录结构（2026-09-25 起重排）：按主题分 5 组** —— `插件与扩展/` · `世界书与卡片/` · `AI打标/` · `性能与稳定性/` · `调试技术/`；同类资产归一组，新增文档请放入对应组（规则见 [`../文档整理规则.md`](../文档整理规则.md) §一之二）。
> 最后整理：2026-09-25（按主题分组重排）

---

## 一、代码片段（可直接查阅 / 移植 / 审查）

| 文档 | 内容 | 规模 |
|---|---|---|
| [代码片段-AI打标.md](AI打标/代码片段-AI打标.md) | AI 打标 5 处代码完整汇总：自动打标规则表（纯常量）、规则式打标 + 后台落盘、AI 智能打标引擎（组合式）、AI 打标弹窗组件、**提示词分角色 + `<tags>` 结构化输出 + 思维链（`js/utils/llmPromptRoles.js`，2026-09-24 新增，含三层降级截取与思考块剥离的关键设计点）** | 约 1,200 行 |
| [代码片段-世界书条目名修复与导入.md](世界书与卡片/代码片段-世界书条目名修复与导入.md) | 世界书导出条目名缺失的修复代码 + 「从世界书库导入词条到角色卡」7 个修改点（精确锚点 + 可照拄的替换内容） | 约 294 行 |
| [代码片段-Git导入封存.md](世界书与卡片/代码片段-Git导入封存.md) | 已**移除**的「Git 链接导入插件」功能全部代码（主进程 IPC / preload 桥接 / 组合式 / UI），封存备查与将来恢复 | 约 270 行 |
| [方案-界面重整与应用级扩展系统.md](插件与扩展/方案-界面重整与应用级扩展系统.md) | **修改方案 v1.2（已过 2026-09-20 评审 + 含变更风控，未改动任何源码）**：①打标三层漏斗的逐层/逐条开关（`compileAutoTagRules` 第二参 + `autoTagDisabledRules` 关闭清单 + 白名单耦合处理）；②命令注册表与 43 项菜单归位映射；③全局资产库三步走；④关系图谱只注册不外置的评估；⑤应用级扩展系统（manifest / 权限 / iframe 沙箱**源隔离** / 事件 / 存储）；⑥**§八 变更风控**（分级门禁 / 影响半径 / 检出盲区 / 处置流程 / 回退纪律 / 每期「新 BUG 预判」）。含 `E1~E53` 证据锚点表（`文件:行号`）、§十 评审结论与修订状态 | 约 692 行 |
| [方案-卡片自动分组.md](世界书与卡片/方案-卡片自动分组.md) | **新功能方案 v2.0（已按评审意见修订，未改动任何源码）**：在**文件级**按「分组自己声明的收纳条件」自动把卡片移进同名分组文件夹（不存在则自动创建），视角为**分组声明成员资格**——**「标签即分组」已否决**（LLM 层标签自由产出 → 文件夹数量在原理上不可控，四条系统论证）。取证结论：建文件夹 / 物理移动 / 三类 path 派生键迁移（覆盖层·测卡会话·记忆）**底层已具备**；判定层取标签**定死走 `useSearch.js` 的 `extractCardTags`**（输出全小写，slim 卡可读）。含现状证据锚点、**回滚设计**（按卡名定位 + 必须走原语 + 空分组重建）、风险与回退表、S1~S6 分期、12 条专项验收（含"绕过原语"的静态检查，**范围覆盖回滚路径**）与 **Q1~Q9 裁决表** | 约 451 行 |

## 二、实测技术数据

| 文档 | 内容 |
|---|---|
| [技术数据-大库压测与性能.md](性能与稳定性/技术数据-大库压测与性能.md) | 11,186 卡 / 9.76GB 与 22,372 卡 / 19.85GB 两大库的**全部实测数字**：加载分项、堆构成审计、P1a 前后对比、内嵌缓存 A/B、冷启动 I/O 量化、容量边界、移动版 500 卡压测 |

## 三、外部接口参考

| 文档 | 内容 |
|---|---|
| [方案-卡片正文口径收口.md](世界书与卡片/方案-卡片正文口径收口.md) | **收口执行方案（2026-09-25，约 90 行）**：P1a 正文懒加载**既有三条承诺未落到底**所引发的一整类缺陷（读侧空结论 / 写侧可写空 ⇒ 数据丢失）的强制收口 —— **一条入口**（`setCardBodyLoader` + `ensureFullBody`，缺加载器即告警）+ **一道出口闸门**（`file:saveCard` 检测「正文集体变空」⇒ 拒写）+ **一套守卫**（`guard:card-body` 白名单制 + 文案源 + 清理防护）。含迁移清单与可测验收（接手 PK-16 的 ⬜ 待复测项）。⚠️ **不是新设计** —— 设计见 `CHANGELOG.md` v2.2.7（五）与 [`../bugs/BUG-性能与大库.md`](../bugs/BUG-性能与大库.md) §五 护栏 6/7（状态：✅ 方案定稿，实施中） |
| [API参考-酒馆插件渲染.md](插件与扩展/API参考-酒馆插件渲染.md) | SillyTavern / JS-Slash-Runner 源码与官方文档整理：扩展模板渲染（Handlebars）、消息渲染（Showdown）、消息块 DOM 结构、`getContext()` 完整成员、事件系统、Slash 命令、脚本 API |
| [格式说明-插件格式.md](插件与扩展/格式说明-插件格式.md) | 插件 JSON 扩展格式、支持的插件形态、本地目录扫描接入方式、工作区「📄 代码 / ✨ 效果」双卡 |
| [CDP探针-DOM查询三大陷阱.md](调试技术/CDP探针-DOM查询三大陷阱.md) | **写 CDP 端到端探针必读**（2026-09-24 实测踩坑，两个探针初版共致 **18 条假失败**）：① `offsetParent` 对 `position:fixed` 元素**恒为 null** ⇒ 弹窗可见性须用 `getComputedStyle` + `getBoundingClientRect`；② 弹窗根节点**必须要求 `inset-0`** ⇒ 否则先命中 **Toast 容器**（也是 `fixed z-50`）；③ 按钮查询**必须限定弹窗内 + 规范化后完全等于** ⇒ 否则「API 引擎」命中 HeaderBar 菜单、「关闭档」**误关弹窗**；④ `[...divs].find(含文案)` 返回**最外层祖先** ⇒ 会点到**别的行**的按钮（**夹具至少 2 条同类数据**才暴露）；⑤ 侧栏/列表这类**流式元素**不能用弹窗判据，分区 tab 是 `<div>` 不是 `<button>`；⑥ 同页多个 `textarea` 必须用 **placeholder 精确定位**。🛑 附「**禁止用 PowerShell 改源码**」真实事故（PS 5.1 `Set-Content` 默认 ANSI → 写坏 UTF-8，229 个 `U+FFFD`，**构建与单测都不报错**）+ 检测与还原方法。附「探针有效性双向对照」验证法 |

---

## 四、探针与工具脚本速查（`scripts/`）

### 目录结构（2026-09-23 整理）

> **整理前**：`scripts/` 根目录平铺 **133 个文件**（其中探针 85 个，且多为同一问题的重复版本，
> 如 `progress-tail`/`tail2`/`tail3`/`tail4` 四个探针探同一个进度条）。
> **整理后**：根目录只留**门禁脚本**，其余按用途分两个子目录。

| 位置 | 内容 | 数量 |
|---|---|---|
| `scripts/`（根） | **门禁 / 校验**：`check-batch-read-guard.mjs`、`check-doc-links.mjs`、**`check-undefined-scope.mjs`**、`check.py`、`checkkit.py`、`extract-release-notes.mjs`、`release-check.mjs` —— 被 `npm scripts` 或发版流程直接调用，路径不能变 | 7 |
| `scripts/probes/` | **探针**（`_probe-*`）：取证、压测、端到端验证 | 98 |
| `scripts/tools/` | **工具**：调试（`_cdp-*` / `_dbg-*` / `_heap-*` / `_heat-*`）、测试（`*-test` / `*-smoke`）、扫描分析（`scan-*` / `audit-*` / `extract-*`）、一次性清洗 | 47 |

> 🛑 **探针纪律**（2026-09-23 立规，见 [`../../AI交接指导.md`](../../AI交接指导.md)）：
> 探针是**一次性工具**，不是交付物。**一个 bug 最多留 1 个探针**（迭代时改同一个文件，禁止 `xxx2.mjs`）；
> 纯探索用 `node -e` 内联跑完即弃；**落地必须同一次操作内登记进本表**，否则删掉。
> 只有「能定阈值」或「能长期当门禁」的才值得留存。

### 发版与文档卫生

| 脚本 | 用途 |
|---|---|
| `check.py`（Python） | **一键检查**：语法 / 单测 / 构建 / 文档链接 / 版本一致性 / 对外文件禁词 / 仓库卫生。`python scripts/check.py` 全跑、`--fast` 跳过 #slow、`--only docs,#git`、`--changed` 只跑命中改动的、`--strict` 提醒也算失败、`--json out.json` 出报告、`--list` 看清单、`--new NAME` 生成扩展模板。检查项全在 `scripts/pychecks/`（加检查**不用改运行器**，见 `pychecks/README.md`） |
| `checkkit.py`（Python） | 上述框架的类型与工具（`Check` / `Context` / `ok()/warned()/failed()`），扩展模块直接 `from checkkit import ...` |
| `release-check.mjs` | **发版前置自查**（语法 + 单测 + 构建 + 文档一致性 + git 状态），`--e2e dev/prod` 加跑端到端 |
| `check-doc-links.mjs` | 校验全仓库 markdown 的相对链接能否解析（当前 50 文件 / 275 条全有效） |
| `check-batch-read-guard.mjs` | **CI 白名单守卫（PK-27 / S4'）**：批量读世界书正文**必须走唯一入口** —— `ensureWorldbookLoaded` 只允许出现在白名单清单里，其余任何文件出现即 fail。接 `npm run guard:batch-read`（含在 `npm run check` 里） |
| `check-undefined-scope.mjs` | **静态「未定义标识符」门禁**（2026-09-25，AR-51 事故产物）：基于 `acorn` 做**作用域感知**的引用解析，抓「定义在**另一个闭包**里 → 运行期 `ReferenceError`」这类 `npm test` / `vite build` 都看不见的错（事故现场：查重结果 **0 组**，日志 `ReferenceError: fullSigOf is not defined`）。`node scripts/check-undefined-scope.mjs [目录…]`，命中退出码 1；单测 `test/scopeUndefined.test.mjs`（含正向对照 —— 先证明它**真抓得住**） |
| `extract-release-notes.mjs` | 从 `RELEASE_NOTES.md` 抽取指定版本段（默认当前 `package.json` 版本）到临时文件，供 `gh release create --notes-file` 使用——**不要手抄正文** |
| `dev-run.ps1` | dev 启动（含终端编码修正） |

### 压测与容量

> 🚫 **测试数据口径铁律**（见 [`AI交接指导.md`](../../AI交接指导.md) 铁律 9）：
> **读操作**（扫描 / 搜索 / 索引 / 渲染 / 统计）必须跑**真实库**；**写操作**（改标签 / 删卡 / 保存 / 移动）用**隔离库**。
> **禁止**用假卡 / 空库 / 小样本替代真实库「证明功能正常」—— 失败只在真库才暴露（DF-18 / PK-19 / DF-17 都是教训）。
> 真实库：`E:\AI\酒馆工具\角色卡`（89 张）/ `I:\03\角色色卡`（11,849 张）/ `H:\01\全局世界书`（41 本）。

| 脚本 | 用途 |
|---|---|
| `capacity-check.ps1` | **一键压测**：自动挑最大库 → robocopy 造副本 → 写隔离 profile → 启 Vite+Electron → 轮询采样 → 汇总。`-Copies N` 造副本、`-ReplicaDir` 复用已有副本（⚠️ 不能写成 `-Replica`）、`-Keep -Hold` 保留现场。**副本是真实库的逐字节拷贝**（保留真实规模，非缩水样本） |
| `library-dup-search-refresh.mjs` | 搜索→刷新→未等防抖→清空→连点 6 次，逐段查「库层 + 列表层」重复并记录堆占用 |
| `library-dup-refresh10.mjs` | 大库「刷新 ×10」重复卡复现（打用户截图里的 `(478)` 中间态那条路径） |
| `library-dup-timeline.mjs` | 加载**过程中**高频轮询，抓库长度时间线与每步 path 重复情况 |
| `library-dup-race.mjs` / `library-dup-stress.mjs` / `library-dup-probe.mjs` | 并发/连点/互斥验证；刷新 ×N + 搜索 ×N（搜索段偏慢）；早期小库探针 |
| `measure-startup.mjs` | 启动分项测量（临时 profile、生产模式），`--label` 打标签、`--library` 指定库、`--timeout` 调超时 |
| `png-head-io-probe.mjs` | PNG 头**读取量**探针（复刻主进程窗口逻辑，量化冷启动 I/O） |

### CDP 探针

| 脚本 | 用途 |
|---|---|
| `_cdp-eval.mjs` | 通用取值（`EXPR` 传表达式，`GC=1` 先强制 GC） |
| `_cdp-mem.mjs` | 堆 / 索引 / 内存守门员（`--refresh` 顺便跑刷新，`--gc` 仅最终取样时 GC） |
| `_cdp-text.mjs` | 应用自身进度与卡片数 |
| `_heap-audit.mjs` | 堆构成审计（按字段拆「文本 vs 对象开销」） |
| `_probe-index.mjs` / `_probe-index2.mjs` | 索引诊断（包装 `__jskDiag.idx` 的 clear / buildAsync；第二个抓运行期 console 看重建是否被合并） |
| `_probe-regex-ui.mjs` | 正则/状态栏增删 UI 端到端（含原生确认框应答） |
| `_probe-wb-scan-progress.mjs` | **T2 真进度条**端到端：真实目录 + 真实 IPC，断言单次 `wb:scan` 期间收到多条 `wb:scan-progress`（旧实现 0 条）、`total` 准确、`done` 单调不减、终态 `done===total`、带 `current`、窗口不白屏。用法：`$env:CDP_PORT=9360; $env:SCAN_DIR="<目录>"; node scripts/probes/_probe-wb-scan-progress.mjs` |
| `_probe-wb-sidebar-crash.mjs` | **AR-40**端到端：点「🌍 世界书库」/ 反复切模式 → 断言侧栏 `<aside>` **未被卸载**、无 `_ctx.* is not a function` 渲染期错误。用法：`$env:CDP_PORT=9365; node scripts/probes/_probe-wb-sidebar-crash.mjs`（需 dev 模式实例） |
| `_probe-aitag-nav.mjs` | **AI 打标窗口布局重构（静态结构）**：12 条断言 —— 左导航三组七分区齐全、逐分区切换后特征控件可见（判据用 `offsetParent` 而非 `innerText`，后者会误判隐藏分区）、「管理规则表」入口去重、三层开关 / API 字段 / 破限区未丢、无渲染错误。用法：`$env:CDP_PORT=9375; node scripts/probes/_probe-aitag-nav.mjs` |
| `_probe-aitag-hot.mjs` | **AI 打标窗口动态行为热测**：30 条断言 —— 徽标联动、跨分区状态保持、分区互斥、进度条位置、管线全关保护、取消 / ✕ / 开合循环 ×5、窄窗 900×620、规则弹窗、**副作用校验（不得误开无关弹窗）**。⚠️ 实例须加 `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling` 启动，否则窗口被遮挡时 rAF 被节流 → Vue 过渡卡住 → 假失败（详见文件头注） |
| `_probe-aitag-run.mjs` | **AI 打标真实 API 端到端**：真实入口 + 真实 UI 按钮启动，校验打标中「取消 / ✕ 关闭」被禁用、进度推进、逐卡日志有结论、无渲染错误。🚫 **会真实写卡** → 只能跑在隔离库副本上（探针内含真实库路径检测，命中即退出码 2）。用法：`$env:CDP_PORT=9375; $env:TAG_COUNT=2; node scripts/probes/_probe-aitag-run.mjs` |
| `_probe-aitag-cot.mjs` | **AI 打标「分角色 + 思维链 + 连通性测试」端到端**（R1+R2+CoT，**20 条断言**）：5 个小页签齐全 / 逐页签切换后编辑区可见 / 思维链三档（默认只读 · 自定义可写 · 关闭无框且**不误关弹窗**）/ 🔌 测试连通性按钮 / 🟢 徽标按「仅 LLM 层」条件出现与消失 / 引擎侧三档取值一致 / 无渲染错误。⚠️ **必须 dev 模式**（`__jskDiag` 仅 dev 暴露）且隔离 profile 的 `tavern_manager_config.json` 需预置 `lastFolder` 指向真实卡库。🛑 **三个 DOM 陷阱（初版踩了共 10 条假失败，详见 [CDP探针-DOM查询三大陷阱.md](调试技术/CDP探针-DOM查询三大陷阱.md)）**。用法：`npm run dev` 后 `$env:VITE_DEV_SERVER_URL="http://localhost:5173"; $env:CDP_PORT=9376; node scripts/probes/_probe-aitag-cot.mjs` |
| `_probe-mem-dedupe-ui.mjs` | **记忆库逐条编辑 + 查重综合分排序端到端**（2026-09-24，**16 条断言**）：排序纯函数三级回退 / 返回新数组不改入参 / 记忆行有 ✏ / 点 ✏ 进编辑态 / fact 才有 key 框 / **编辑时其他行 ✏ 被禁用** / 空内容禁用保存 / 取消丢弃草稿 / **保存真写入存储** / 清理干净 / 无渲染错误。⚠️ **必须 dev 模式**，且需 `__jskDiag.chat.openCard()` 先开卡（测卡侧栏只在「有卡打开 + 测卡 Tab」时渲染）。🛑 **四个 DOM 陷阱（初版踩了 8 条假失败）**：① 记忆库在**测卡侧栏**不在 AI 打标弹窗（`aiTag.open()` 找不到）；② 分区 tab 是 **`<div>` 不是 `<button>`**，标签带图标前缀（用 `endsWith`）；③ 编辑框必须用 **placeholder 精确定位**（侧栏有多个 textarea）；④ 行必须用 **class 特征（`border-b` + `group`）** 定位 —— `[...divs].find(含文案)` 会返回**最外层祖先**，点到的 ✏ 是**别的行**的（只注入 1 条时碰巧对，2 条立刻暴露）。用法：`$env:CDP_PORT=9376; node scripts/probes/_probe-mem-dedupe-ui.mjs` |
| `_probe-dedupe-progress.mjs` | **AR-42** 查重进度条**位置修正**端到端（15/15）：断言①浏览库后侧栏**无**进度条、改用日志反馈；②查重前**确实重扫磁盘**；③扫描期间**弹窗内**出现进度文案（`withProgress=true`）；④进度带当前文件名、`phase` 序列 `parsing→done→idle`；⑤查重后收起、无 TDZ。用法：`node scripts/probes/_probe-dedupe-progress.mjs "<世界书目录>"` |
| `_probe-wb-regression.mjs` | 世界书**功能回归**（100 本库）：扫描/entries 归一化/进度复位/侧栏存活/分组/搜索/词条数筛选/`wbEntryCount`/同名查重/内容级查重/模式反复切换/渲染期错误。用法：`node scripts/probes/_probe-wb-regression.mjs "<目录>"`（**位置参数**，环境变量跨命令会丢） |
| `_probe-wb-stress-500-lib.mjs` | **PK-20** 501 本大库压测（**会崩**，用于复现）：分级是否正确、进度条、堆水位、二次扫描、列表渲染、搜索筛选。用法：`node scripts/probes/_probe-wb-stress-500-lib.mjs`（`WB_DIR` / `EXPECT_LOADED` / `EXPECT_SKIPPED` 可调） |
| `_probe-wb-scale-sweep.mjs` | **PK-20** 规模梯度全自动扫描：每档**独立 profile** + 硬超时，靠 `scan_cache.json` 条数区分「主进程扫完」与「渲染层超时/崩溃」，直接定位临界点。用法：`node scripts/probes/_probe-wb-scale-sweep.mjs [s050 s100 ...]`（`SCAN_TIMEOUT_MS` 可调） |
| `_probe-scan-phases.mjs` | **PK-23** 扫描阶段分解：分别量 ①递归 `readdir`、②+`stat`、③读全部内容+`parse` 的耗时，**定位耗时归属**（实测 1001 本：7ms / 43ms / **36.0s** → 瓶颈 100% 在③）。用法：`node scripts/probes/_probe-scan-phases.mjs "<目录>"` |
| `_probe-instant-open.mjs` | **PK-23** ⚡ 秒开验证：阶段 1（`fastListOnly`）耗时、元数据补全率、二次缓存命中、渲染堆、侧栏存活。用法：`node scripts/probes/_probe-instant-open.mjs "<目录>"` |
| `_probe-readtext-error.mjs` | **DF-20** 真因验证：真实启动 + 真实大库，断言 `readText` 返回体形状与懒加载结果（修复后 `after: true`、`loadError: null`）。用法：`node scripts/probes/_probe-readtext-error.mjs "<目录>"` |
| `_probe-content-dedupe-fix.mjs` | 内容级查重**流式提取**（读一本 → 提取 → 立即释放）+ 懒加载修复验证 |
| `_probe-wb-stress-5k.mjs` | **5000 本极端压测**（⚡ 秒开 / 完整扫描 / 渲染层 / 同名查重 / 差异比对 / 内容级查重 / 模式切换 / OOM）。⚠️ **预期数量自己数磁盘**（不写死，否则库构成一变就误报）。用法：`node scripts/probes/_probe-wb-stress-5k.mjs "<目录>"` |
| `_probe-wb-valid-gate.mjs` | **PK-24** 校验门禁验证（**9/9**）：秒开阶段 1 **不得跳过 `isValidWorldbook`** —— 断言①最终入库数 = 磁盘有效数（诱饵已剔除）、剔除数 = 磁盘无效数、零漏收；②二次（有缓存）阶段 1 **精准列出**（诱饵从不出现）且秒开。⚠️ **必须用全新 profile** 才能测「首次」路径。用法：`node scripts/probes/_probe-wb-valid-gate.mjs "<目录>"` |
| `_probe-instant-regression.mjs` | **PK-26** 秒开回归门禁（**带断言，退出码即结果**）：秒开态 `entryCount`/`wbName` 覆盖率、`wbEntryCount()` 真实值、同名查重 `_entryCount` **不得为 0**、重合度**不得是反向的「0%」**、差异比对**必须走世界书分支**且不出现「设定完全一致」。⚠️ 修复前此脚本是「大量 0 / 0%」的取证工具，现已加断言。用法：`node scripts/probes/_probe-instant-regression.mjs "<目录>"` |
| `_probe-pk26-release.mjs` | **PK-26 后续**「用后释放」专项门禁（**7/7**）：断言同名查重过程中确实逐本载入正文（**峰值 > 查重前**）、且终值**回落到查重前水平**（未累积）、未把全部书留在内存、词条数为真实值、堆未失控。⚠️ **判据必须看「峰值 → 终值」的回落**，不能写「终值必须为 0」—— 扫描器会按内联预算主动载入少量书（PK-20 既有设计），那样会恒失败。用法：`node scripts/probes/_probe-pk26-release.mjs "<目录>"` |
| `_probe-l1-size.mjs` | **PK-27 架构方案**：**L1 摘要体积实测**（离线，不起应用）—— 去重触发词数/长度分布、**原字符串方案 vs `Uint32Array` hash 方案的真实体积**（含 JS 字符串头部与数组槽开销）、体积系数（parse 后字符/磁盘字节）、非 BMP（emoji）占比、hash 计算耗时、全库外推。**改 L1 设计前必跑**（实测推翻了原估算 16~32 倍）。用法：`node scripts/probes/_probe-l1-size.mjs "<目录>" [采样本数]`（`TOTAL_BOOKS` 可调外推基数） |

### 卡片正文口径专项（PK-31 / PK-32）

| 脚本 | 用途 |
|---|---|
| `_probe-qiuziqi-vs-pair.mjs` | **PK-31** 两卡取证（只读真实库、独立解析不走应用内存）：逐字段长度 + 4-gram Jaccard（5 字段 / 全字段+词条 / 仅词条）、内嵌词条数与其 keys/正文长度。**判“同组是否误报”先用它**，别靠截图推断。用法：`node scripts/probes/_probe-qiuziqi-vs-pair.mjs ["A 路径"] ["B 路径"]`（缺省为秋青子那对） |
| `_probe-disk-wiped-books.mjs` | **PK-32** 磁盘排雷（只读真实库）：抽样扫 PNG，统计「≥10 条词条但正文全空」的卡 —— 即**是否已被「瘦身态 payload 写回」抹掉过**（正常作者不会建 10+ 条空词条）。**写完侧改动后应保持 0**。用法：`node scripts/probes/_probe-disk-wiped-books.mjs "I:\03\角色色卡" 400` |

### PK-27 架构改造专项（L1 摘要 / simhash / 进度条）

| 脚本 | 用途 |
|---|---|
| `_probe-load-speed.mjs` | **世界书库加载速度实测**（分阶段独立计时，**直调 IPC 不含 UI**）：阶段 1 秒开 / 阶段 2 元数据补全 / L1 摘要产出 / 冷启动总计 / 二次热启动。**结论：阶段 1 已到磁盘物理下限（83% 是 `stat`）** —— 3 种优化尝试均已实测无效并回滚。<br>⚠️ **不含 UI 渲染** ⇒ 用户感知耗时请用 `_probe-wb-load-e2e.mjs` / `_probe-wb-firstpaint.mjs` |
| `_probe-wb-load-e2e.mjs` | **世界书库加载速度端到端**（**浏览库**，非查重）：走真实入口 `scanWorldbookDir`，采样「首屏可用」。⚠️ 含 `rAF` 判据对照（证明它会被节流） |
| `_probe-wb-load-breakdown.mjs` | **加载耗时分段定位**：直调 IPC vs 真实入口（含 UI）对照 + 冷/热/清空三种场景 + **`setTimeout(0)` 与 `rAF` 双判据** |
| `_probe-wb-firstpaint.mjs` | **首屏可用复测**（只测首屏，不等后台续补）：冷/热两轮 + DOM 节点数 + 5 条断言。用于验 P2-1 回归修复 |
| `_probe-p1p2-e2e.mjs` | **P1-P2 端到端**：阶段 1 秒开 / P2-1 首批 / P1-1 simhash 默认关闭 / P1-2 oversized 流式（6 条断言） |
| `_probe-oversized-stream.mjs` | **P1-2 流式提取真实效果**：现造 >50MB 超大书，比对「完整 parse vs 流式」的**堆峰值**（实测 **92MB → 12MB，7.7×**）与 keys 逐字节等价 |
| `_probe-l1-render.mjs` | **S2' 验证**（CDP）：L1 摘要是否**真的到达渲染层**、同名查重是否**真的不读正文**。用法：`node scripts/probes/_probe-l1-render.mjs "<目录>"` |
| `_probe-dedupe-pure.mjs` | **S2' 纯查重耗时**（CDP，**跳过「查重前重扫」**）：把「扫描耗时」与「查重算法耗时」分离 —— s1000 **70.8s → 9ms** 的取证工具 |
| `_probe-progress-continuity.mjs` | **AR-45 / AR-46 进度条连续性门禁**（**9/9**）：高频采样断言**不横跳**（不得回退后再前进）、**不倒退**、**不变光条**（全程确定态）、不闪烁、终态到 100%；<br>🛑 **AR-46 新增 4 条（关键）**：数字与条宽**一致**（同源校验）、数字**不出现「0 / ?」**、数字**单调不减**、终态 `done===total`。⚠️ **必须同时采「条宽」与「数字文本」** —— 旧版只采条宽（内部变量）⇒ **5/5 通过是假绿**（盲区） |
| `_probe-progress-jump.mjs` | **AR-46 横跳复现与定位**（10ms 采样）：同时采 `dedupeScanPercent`（条宽）**与 `wbScanPercent`**（阶段 1 数据源）+ 阶段文案，**连跑冷/热两轮**（横跳常在热缓存下才出现）。用于定位「是哪条数据路径在倒退」 |
| `_probe-progress-render.mjs` | **AR-46 渲染结果取证**：采**渲染后的 DOM 文本**（`data-testid` 的条宽 + 数字 + 文案）而非内部变量 —— 因为**用户看到的是渲染结果**。断言「数字百分比 vs 条宽」「不得掉回 0 / ?」「数字单调」 |
| `_probe-dedupe-ux.mjs` | **查重 UX 三问排查 v2**（用户 2026-09-22 反馈）：进度取值多样性、陈旧结果残留次数、扫描期间弹窗文案是否存在 |
| `_probe-card-diff-forensic.mjs` | **AR-47 / AR-48 取证门禁**（角色卡查重）：① **进度条时间线**（`I`=不定态 / `-数字`=确定态）—— 断言「只有重扫阶段是不定态」、不定态期间百分比**必须为 0**（防上一轮残留）；② 首组 `_nameOnly` / `_nameOnlyDist` 是否被正确标注；③ 差异比对两侧绑定的**确实是传入的那两张卡**。用法：`$env:CDP_PORT=9370; node scripts/probes/_probe-card-diff-forensic.mjs`（**需先启动应用并加载真实卡库**） |
| `_probe-card-name-dist.mjs` | **角色卡 `name` 字段分布统计**（AR-48 取证）：唯一名数 / 唯一文件名数 / 重名组数 / 占位名数量 / Top 重名榜。用于判定「同名查重误报」的**数据面规模** |
| `_probe-card-name-raw.mjs` | **直读 PNG 内嵌元数据**（不经应用解析）：对比「卡内真实 `name`」vs「文件名」，找出「同名但文件名不同」的实例。⚠️ 用**独立脚本**读盘是为了排除「应用解析 bug」这一可能性 —— 本次据此证实**两张卡真的都叫 `"1"`**（数据问题，非解析 bug）。用法：`node scripts/probes/_probe-card-name-raw.mjs "<卡库目录>" [最多张数]` |
| `_probe-card-raw-of.mjs` | **查看指定卡片的原始元数据**（spec / `name` / `creator` / 描述长度 / 首句长度）：`node scripts/probes/_probe-card-raw-of.mjs "<文件1>" ["<文件2>" …]` |
| `_probe-card-name-falsepos.mjs` | **同名查重假阳性比例统计**（AR-48 量化）：对真实库跑同名查重，按「组内最大描述相似度」分桶（0-20% / 20-50% / 50-80% / 80-100%）。**实测 1910 组中 350 组（18.3%）< 20%** |
| `_probe-card-simhash-dist.mjs` | **「仅名称相同」阈值实测**（AR-48 定阈值依据）：对比「同名组内两两距离」与「随机不同名两两距离」的分布 + 直方图。**实测：同名同源 p50 = 0 / p75 = 0；无关 p50 = 31 / p25 = 28**（与理论期望 32 吻合）⇒ 定 **T = 24**。用法：`node scripts/probes/_probe-card-simhash-dist.mjs "<卡库目录>" [最多张数]` |
| `_probe-nameonly-cost.mjs` | **「仅名称相同」判定性能实测**（AR-48 可行性依据）：对参与同名的全部卡算 simhash 的耗时（**不截断 vs 截断 1200 字**）。实测 4547 张 / 14.6M 字 → 全量 **2.0s** / 截断 **0.7s**（**成本可接受，故未截断**） |
| `_probe-dedupe-cards.mjs` | **角色卡 / 预设查重热测试**（用户反馈第 2 点）：角色卡同名查重、预设查重、角色卡内容查重（MinHash+LSH 路径）。⚠️ 库为空时对应项标 **SKIP**（环境不满足不计入失败） |
| `_probe-diff-perf.mjs` | **PK-22 差异弹窗卡顿修复验证**（**10/10**）：DOM 节点数、首屏耗时、分块渲染上限、重开后状态复位。⚠️ **不要用 `requestAnimationFrame` 等「渲染完成」**（后台窗口不触发，实测假耗时 191333ms）；DOM 节点数才是确定性指标 |
| `_probe-wb-diff-real.mjs` | **世界书「差异着色」真实数据端到端**：断言三种行底色齐备、行内精确高亮、两侧行号列数量相等、无渲染期错误 |
| `_probe-content-dedupe-lazy.mjs` | 诊断：内容级查重在**懒加载库**上是否失效（PK-20 修复的**副作用排查**） |
| `_probe-content-dedupe-dissimilar.mjs` | **内容查重「不相似的书被聚成一组」排查**（PK-29 用户实测报出）：输出每组每本与主项的汉明距离 + **组内两两距离矩阵** + 落盘 sig 与复算是否一致。⚠️ 用它复现了「`鬼物` 与主项距离 **29**（阈值 16）却被聚成 6 本一组」。用法：`$env:CDP_PORT=9370; node scripts/probes/_probe-content-dedupe-dissimilar.mjs "<世界书目录>"` |
| `_probe-dedupe-simtype.mjs` | **相似类型判定端到端**（2026-09-23 采纳「多维度 + 类型分类」建议）：断言每个非基准条目都产出类型标签（完全重复 / 触发重复 / 内容可合并 / 设定冲突 / 高度相似 / 仅名称相同）+ 触发词重合度 + 长度惩罚 + 综合分，并检查覆盖率与渲染期错误。用法：`$env:CDP_PORT=9370; node scripts/probes/_probe-dedupe-simtype.mjs "<世界书目录>"` |
| `_probe-wb-content-newlines.mjs` | **词条正文换行结构统计**（决定「句级对齐」是否值得做）：单行 / 多行占比、行数分布、单行长度分位。**实测：单行 77%，但长度 >500 字符的仅 1 条 ⇒ 行内 token 级 diff 已覆盖 99.98%，句级对齐收益 ≈ 0**（据此**否决**了 Smith-Waterman 方案） |
| `_probe-wb-stress-500.mjs` | 热测试 · 世界书导入压力测试（500 本 / ≥4MB） |
| `_probe-wb-verify3.mjs` | 核实 501 本压测中 3 个「失败项」**是否为真缺陷**（而非探针假设过期）—— 「用户报故障先验证、别盲改」的落地工具 |
| `_probe-linktest.mjs` | 一次性诊断：`fs.linkSync` 在 D: 同卷内失败的原因（与项目功能无关，保留备查） |

**离线（不需起应用）**：

| 脚本 | 用途 |
|---|---|
| `_probe-simhash-tune.mjs` | **S0.5 特征方案实验**（离线，不碰线上代码）：char n-gram 阶数 / 采样步长 / 位宽 / 阈值网格搜索，输出「准确率 vs 耗时」曲线 —— **simhash 定稿依据** |
| `_probe-simhash-perf.mjs` | **S0.5 性能优化验证**：BigInt 版 **1387ms/本** vs number 版 **43ms/本**（**32×**）的对照实验 |
| `_probe-simhash-verify.mjs` | **S3' 阈值复核（通用版）**：**逐字复刻线上实现**（number 双 32 位 + step=4）在真实库上量「漏报 / 误报」。支持 `--pos` / `--neg` 手动精确标注，或无参时用「同名 = 疑似同源」自动标注。⚠️ **自动标注在「同族不同副本」库上有噪声**（会把跨副本对误标为无关 → 误报率虚高）—— 精确结论请用手动标注或 `verify2` |
| `_probe-simhash-verify2.mjs` | **S3' 阈值复核（精确标注版）** ✅ 实测通过：**MD5 去重**取唯一内容书 + 按**书名前缀**划分家族 → 同家族 = 正样本、跨家族 = 负样本。实测（s1000）正 max **14** / 负 min **33** / 间隙 **19** ⇒ **漏报 0% / 误报 0%**，T=19 落在安全区间 [14, 33) 内 |
| `_probe-simhash-opt.mjs` | **S3' 前置优化**：进一步避免 `substring` 分配（滑窗直接取码点）的收益验证 |
| `_dbg-simhash.mjs` | 一次性调试：定位 simhash **「全 0」**原因 |
| `_dbg-wb-unique.mjs` | 一次性探查：压力库中「唯一内容」书及其关系，为 simhash 实验准备**正负样本** |
| `_probe-wb-lib-audit.mjs` | **磁盘实测**：用与 `main.js` **完全相同**的 `isValidWorldbook` 判据统计压力库真实构成（有效 / 诱饵 / 超大），**以磁盘事实为准** —— 解决「探针预期 501」与「应用实测 537」的口径分歧 |
| `_probe-wb-scan-diff.mjs` | **对照探针**：应用扫描结果 **vs** 磁盘事实（定位「诱饵被误判为有效」） |
| `_probe-make-wb-5k.mjs` | **5000 本压力库生成器**（**硬链接，零拷贝**）：造 `s5000`（5401 个 json / 34.8GB，有效 5001 + 诱饵 400）。用法：`node scripts/probes/_probe-make-wb-5k.mjs`（`--clean` 删除） |

### PK-29 / PK-30 取证探针（内容查重误判，2026-09-23）

| 脚本 | 用途 |
|---|---|
| `_probe-content-dedupe-offline.mjs` | **离线真值复算**（纯 Node，不依赖应用）：逐字复刻 `extractContentText` + `normalizeText` + `computeSimhash`，输出**分组结果 + 组内两两汉明距离矩阵**。用它拿到 PK-29 的关键证据：`鬼物` 与主项距离 **29**（阈值 16）却被并查集串成一组 |
| `_probe-simhash-calib.mjs` | **阈值标定复核**：统计真实库「正样本（文件名同源）vs 负样本（不同源）」的汉明距离分布 + 直方图。**实测负样本 min = 17**（S0.5 声称的「负 min 31」在真实库**不成立**）⇒ 直接证伪 T=19 |
| `_probe-simhash-vs-jaccard.mjs` | **simhash 失真取证**：对每个候选对同时算「汉明距离」与「真实 4-gram Jaccard」。**实测 18 对候选中 10 对真实重叠 < 50%**，最严重者距离 19 但 Jaccard 仅 **0.1%** |
| `_probe-simhash-sweep.mjs` | **阈值扫描**：(T, 最小长度) 网格 × 误报/漏报。**实测 T ≤ 16 零误报零漏报，T=19 误报 10 对** ⇒ 定 T=16 的依据 |
| `_probe-content-dedupe-sim.mjs` | **修法算法仿真**（改生产代码**之前**先验证）：对比「① 现状 T=19+朴素并查集 / ② T=16 / ③ +MinHash复核 / ④ +簇心校验」四方案。**实测 ④ 零误报零漏报** |
| `_probe-simhash-verify-choice.mjs` | **复核手段选型**：对比「真实 Jaccard / MinHash / simhash step=1」三种复核的准确度。**实测 MinHash 复核 TP=8 FP=0 FN=0** ⇒ 选定 MinHash（内存安全：96 int/本） |
| `_probe-simhash-calib2.mjs` | **距离 ↔ 真实相似度标定**：用「改造真实文本」造出**已知相似度**样本（按比例把 A 的块替换为 B 的），测其距离 + 真实 Jaccard。**实测安全区间为空**（相似度 ≥85% 的样本距离可达 **33**，而无关对最小 **0**）⇒ 验证了「单靠 simhash 无法区分，必须加复核」 |
| `_probe-wb-content-newlines.mjs` | **词条换行结构统计**（评估「句级对齐」必要性的依据）：真实库 **7424 条词条中 77% 是单行**，但**长度 > 500 字符的仅 1 条** ⇒ 行内 token 级 diff 已覆盖 **99.98%**，句级切分只能改善 1 条（**否决依据**） |
| `_probe-chain-recall.mjs` | **簇心校验的召回风险验证**（防「修 A 坑引入 B 坑」）：造「A←B←C 同源链（A~C 仅 59%）」与「无关 D」的合成场景，确认簇心校验**不损失召回** |
| `_probe-content-dedupe-simtype.mjs` | **相似类型判定端到端**（见上文 CDP 段） |

### 角色卡 / 预设查重勘查探针（两份外部方案评估，2026-09-23）

> 依据：`../规格与计划/查重引擎/角色卡与预设查重-方案评估.md`。这 4 个探针产出「采纳 / 修正 / 否决」的全部实测依据。

| 脚本 | 用途 |
|---|---|
| `_probe-preset-structure.mjs` | **预设库结构勘查**：类型分布（OpenAI / TextCompletion / Context…）、`prompt_order` 的 **`character_id` 实际取值**、块数分布、`identifier` 频次（识别「默认骨架」块）、采样参数的 null 占比。**实测：真实库仅 5 个 OpenAI 预设；`character_id` 100000 与 100001 **并存**（方案只写 100000、parsecard 常量是 100001，**两者都不完整**）；块数 118~261（方案称「60+」**低估一个数量级**）**。用法：`node scripts/probes/_probe-preset-structure.mjs "H:\01"` |
| `_probe-preset-struct-power.mjs` | **结构指纹判别力量化**（方案核心假设的验证）：对每对预设算「identifier Jaccard（结构）」 vs 「逐块 content Jaccard（内容）」，并做「剔除 12 个默认骨架块」的**对照实验**。**实测：结构 Jaccard 跨度 96.6 个百分点（3.1%~99.3%）⇒ 判别力充足；`A.U.T.O.预设`↔`万象枢机 2.5`（**文件名完全不同**）结构 **99.3%** / 内容 57% ⇒ 坐实「改名同源」是真实漏洞** |
| `_probe-card-versions.mjs` | **角色卡版本与字段分布**：V1/V2/V3 分布、载体分布、各字段填充率、V3 新字段出现率、**「当前查重使用的字段 vs 被忽略的字段」字符量对比**。**实测：V1 2.2% / V2 46.7% / V3 48.9%；`character_book` 36/45（80%）**却完全未参与查重**；当前查重**忽略 71.7% 文本**（30,958 用 vs 130,167 忽略）；V3 的 `assets`/`nickname`/`creator_notes_multilingual` 出现率**均为 0** |
| `_probe-card-chunk-spec.mjs` | **PNG chunk × `spec` 对应关系**（证伪方案的技术前提）：逐 chunk 解析 PNG，输出「chunk 组合 → spec」分布。**实测：V3 数据 21 个在 `chara` chunk、仅 1 个在 `ccv3`** ⇒ 方案「读取时 `ccv3` 优先」与真实库**相反**，若按此实现会**漏掉 21/22 的 V3 卡**；正确判据是解析 `spec`，与 chunk 名无关 |
| `_probe-card-legacy-vs-full.mjs` | **双口径阈值实证门禁**（DF-23 的**必要配套**取证）：对真实卡同时算「5 字段」与「全字段（含 `character_book`）」的 MinHash 相似度 + 真实 4-gram Jaccard + 双口径 OR 闸门判定 vs 真值，**逐对输出「单口径 / 双口径 / 真值」是否一致**。用途：① 实证两个必须配对修的问题（文本量级 ×26 ⇒ **无关对距离 30 → 20~23** 落进 AR-48 的 `T=24`，而真实 Jaccard 仅 **1.6%**；`鬼.png`↔`鬼1.png` 真实同源改版 **5 字段 100% → 全字段 67.7%** < 0.85 闸门 ⇒ 漏报）；② 作为**长期门禁** —— 改角色卡查重字段或阈值后跑它，确认判定仍与真值一致。用法：`node scripts/probes/_probe-card-legacy-vs-full.mjs "<卡1>" "<卡2>" …` |
| `_probe-preset-threshold-calib.mjs` | **预设查重阈值标定**（DF-24 的**定阈值依据**）：对带真值的合成样本库做**阈值网格扫描**，统计 FP（误报）/ FN（漏报），判据「**先要求 FP=0**，再取召回最高」。**实测：结构阈值 0.95 → TP=11 / FN=0 / FP=0 / TN=3（零误报零漏报）**，无关对最高结构相似度 **13.0%** ｜ 同源对最低 **100%** ⇒ **分离间隙 0.87**。⚠️ 合成样本标定（非真实库），结论须带此声明。配套生成器：`scripts/tools/make-preset-lib.mjs`。用法：`node scripts/probes/_probe-preset-threshold-calib.mjs "D:\TkDmGzq\_preset-calib"` |
| `_probe-webp-save-upgrade.mjs` | **WebP 卡保存升级端到端验证**（DF-25 的**真修复证据**）：用 `sharp` **真造** WebP 卡 → 走 `main.js` 的转换逻辑（**从源码提取函数体 ⇒ 与线上同一份实现**）→ 读回断言。**实测 5/5 全过**：角色名 / **编辑后的描述**（核心）/ 编辑后的内嵌世界书词条 / 旧 `.webp` 已删 / 产物是合法 PNG。⚠️ 需 `sharp`。用法：`node scripts/probes/_probe-webp-save-upgrade.mjs` |
| `_probe-wb-uid-dict.mjs` | **独立世界书保存形态验证**（DF-21 的**真修复证据 + 长期门禁**）：输入是**真实库的真实世界书**，走真实的 `wb:save` 清洗链路（直接 require `main/cardFieldSanitizer.js`），断言「往返后 uid / 词条 / 空洞完全保真」。**实测（26 本 / 23,816 条）：① 源文件是 ST 原生字典 26/26 ｜ ② 保存产物是字典 26/26 ｜ ③ 产物自洽（键 === 词条内 uid）26/26 ｜ ④ 自洽源文件的 uid 集合保真 21/21 ｜ ⑤ 词条条数不变 26/26**。⚠️ 探针会**如实报告「源文件本就不自洽」的书**（本项目压测库的合成产物，非 ST 自洽格式）—— 不得把它们计入 uid 保真断言。用法：`node scripts/probes/_probe-wb-uid-dict.mjs "<世界书目录>" [本数]` |

### 离线探针（不需起应用）

| 脚本 | 用途 |
|---|---|
| `_probe-latin-prefix.mjs` / `_probe-latin-prefix-options.mjs` | **PK-19** 拉丁前缀检索：前者量「全表扫 vs 现状」的代价曲线；后者做**三方案对照**（有序数组前缀区间 / 首字母桶 / bigram 桶）的**正确性 + 速度 + 内存**，并把「结果必须与基线逐条一致」作为硬判据 —— 实测 `(a)(b)` 破坏子串语义、`(c)` 全对且快 20~70 倍 |
| `_probe-scan-head-check.mjs` | **T4/T5** 构造实验：造多种「`entries` 位置 / 首条形态」的世界书，逐字复刻主进程的头部预检与 `isValidWorldbook` 判据，算误杀率；并二分出「`entries` 被挤出前 64KB 的体积门槛」 |
| `_probe-real-head-check.mjs` | **T4 真实库**：扫指定目录每本书的 `entries` **字节偏移**（4MB 分块扫描，不整文件载入）vs 64KB 头窗，输出误杀清单与误杀率。用法：`node scripts/probes/_probe-real-head-check.mjs "H:\01\全局世界书"` |
| `_probe-real-validity.mjs` | **T5 真实库**：逐本跑 `isValidWorldbook`（含「扫前 20 条」的候选修法对照），列出被拒清单 + 首条形态 + 字典形态统计。用法：`node scripts/probes/_probe-real-validity.mjs "H:\01\全局世界书"` |
| `_probe-heavy-concurrency.mjs` | **T6** 分级扫描并发：逐字复刻 `handleOne`（**必须 `fs.promises` 真异步**），在多并发档量 耗时 / 堆峰值 / 判定一致性；生产常量**从 `main.js` 动态读取**（改参数无需同步注释）。用法：`node --expose-gc scripts/probes/_probe-heavy-concurrency.mjs "H:\01\全局世界书" 1 2 3 6 12` |
| `_probe-textdiff-real.mjs` | **PK-21** 差异算法真实数据验证：纯 Node 直接 `import` `js/utils/textDiff.js`（与浏览器同一份源码），断言单条词条（≤1500 行走精确 LCS）**全部正确**，并揭出全篇超预算降级后的**假阳性 99.15%**。用法：`node scripts/probes/_probe-textdiff-real.mjs` |
| `_probe-make-wb-lib.mjs` | **压力库生成器**：造 542 个 `.json` / ≈3.5GB 世界书库（20 组 × 27，含 4 个改写变体 + 3 类诱饵 + 52.7MB 超巨书）。用法：`node scripts/probes/_probe-make-wb-lib.mjs`（`--clean` 删除） |
| `_probe-make-wb-scale.mjs` | **规模梯度库**（用**硬链接**零拷贝）：造 `s050/s100/s200/s300/s400`。用法：`node scripts/probes/_probe-make-wb-scale.mjs`（`--clean` 删除） |
| `_probe-ctx-shape.mjs` / `_probe-ctx-shape2.mjs` / `_probe-ctx-shape3.mjs` | **Vue 3.5 `appCtx` 取法排查**（一次性）：实测 `app._instance` **恒为 `null`**，正确路径是 `app._container._vnode.component.provides.appCtx`。**旧探针（如 `_probe-diff-coloring.mjs`）用的 `app._instance.provides` 已失效** |

### 端到端 / 热测试

| 脚本 | 用途 |
|---|---|
| `chat-sidebar-test.mjs` | 测卡侧栏 7 分区（生产 `app://` 构建） |
| `card-plugins-test.mjs` | **卡内插件页签**端到端（黑盒 DOM）：页签存在 / 面板渲染 / 徽标与条目数一致 / 展开内嵌代码编辑器 / ⛶ 全屏放大与 Esc 关闭 / 只读分组可展开 / 无渲染层报错。用法：实例带 `--remote-debugging-port=9351` + `$env:CDP_PORT="9351"; node scripts/tools/card-plugins-test.mjs`；可选 `PLUGIN_CARD_TERMS`（找带插件卡的搜索词）、`TEST_ADD=1`（额外验「空容器卡一键新建」，**仅改内存不保存**） |
| `auto-group-test.mjs` | **自动分组 + 清理空分组（DF-16）**端到端（隔离库真实物理移动 + 回滚）：①环境校验（预置分组已加载）②档案恢复 ③保存落盘（容错重试）④预览只读（计数 / 人外将新建 / 文件未动）⑤非法正则边界 ⑥执行（3 张真实移动 + 自动建文件夹 + 内存同步 + 未命中/已分组卡未动）⑦制造变动（删一张）⑧回滚（逆序还原 + 「已不存在」单列 + 日志清空）⑨清理空分组（配置空组 + 分组空文件夹删除、孤儿空目录保留、有卡分组不动）⑩🤖 LLM 分辨（本地 mock 服务端口 9358：1 批请求 / 请求体含判定标准与卡信息 / 建议入计划 / 重扫缓存并回 0 新请求 / DOM 默认不勾 / 真实移动 + 回滚）⑪无渲染层报错。用法：`node scripts/tools/auto-group-test.mjs --prep` → 起 dev 实例（vite 5177 + `--remote-debugging-port=9359 --user-data-dir=%TEMP%\jsk-ag-profile`）→ `node scripts/tools/auto-group-test.mjs` → `--cleanup`。⚠️ 只跑隔离库（脚本内含防呆）；⚠️ 重跑前先强杀同 profile 残留实例（旧实例关闭时 beforeunload 冲刷会回写旧配置） |
| `chat-engine-test.mjs` | 测卡引擎管线（宏 / 世界书 / EJS / payload / 分段渲染 / swipe） |
| `builtin-cat-test.mjs` | 内置大分类定制：改名 / 隐藏 / 恢复 / 清理还原（**结束时还原，不破坏用户数据**） |
| `ai-category-modal-smoke.mjs` | AI 归类「自动建类」UI 冒烟（🆕 新建徽标与 optgroup 渲染） |
| `sanitize-live.mjs` | `sanitizeImportedTags` 开关的**真实导入**热测试（`probe` / `set` / `import` / `check` 四步） |
| `live-vector-test.cjs` | 在真实 Electron 主进程里验 `vectorManager`（标签展开 + 0.35 阈值）：`npx electron scripts/tools/live-vector-test.cjs` |
| `prod-library-regression.mjs` | **生产模式**（`app://`，无调试句柄）卡库回归：首屏＋刷新×5＋搜索×5＋搜索中刷新，断言「真重复组恒为 0 / 计数不归零」（防 PK-01、PK-02、DF-08、DF-09 复活）。用法：`npx electron . --disable-gpu --remote-debugging-port=9350` + `$env:CDP_PORT="9350"` |
| `prod-ui-regression.mjs` | 生产模式 UI 回归（AR-18 正则·状态栏新增首条 / AR-19 添加要切 Tab）。⚠️ 卡片行选择器**尚未校准，当前未跑通**，仅作待修工具保留 |

### 落盘清洗验证（保存路径回归）

> 针对 `main/cardFieldSanitizer.js`（落盘前剥离前端内部字段）。**这套脚本的价值主要在反向用例**：
> 证明「递归剔除所有 `_` 前缀键」会删掉第三方真实数据（实测 7 类、131 处），因此实现改成了白名单。

| 脚本 | 用途 |
|---|---|
| `audit-card-underscore-fields.py` | 全库审计：列出真实卡片里**非前端内部**的 `_` 前缀字段与所有 `uid` 的位置和数量（`python scripts/tools/audit-card-underscore-fields.py <库根> [张数]`）。改清洗规则前**先跑它**——这是判断「会不会误删用户数据」的唯一依据 |
| `audit-preset-worldbook-underscore.py` | 同上，但扫**预设 / 独立世界书**类 JSON（判据：`prompts`+`prompt_order` 或 `entries`）。结论：预设与独立世界书里无 `_` 前缀字段，但**独立世界书 `entries[i].uid` 大量存在**（DF-14「遗留待决」的依据） |
| `save-strip-live-ui.mjs` | **渲染层 4 处清洗点**的真实运行验证：`downloadJson` / 卡片内嵌世界书导入 / 独立世界书导入；反向断言第三方 `extensions._filename` 与扩展内部 `uid` 不被误删。全程只动内存，结束还原 |
| `save-strip-real-cards.mjs` | **离线**批量验证：抽真实卡片 → 注入 `uid`/`_collapsed` → 过清洗 → 断言注入字段被剔除、第三方字段 0 丢失、其余内容逐字段不变。`node scripts/tools/save-strip-real-cards.mjs "I:\03\角色色卡"`（无需 Electron） |
| `save-strip-prep-samples.mjs` | 从库里挑出含第三方 `_` 字段的真实卡片，复制成样本到指定目录（给下面两个热测试用） |
| `save-strip-live-card.mjs` | **真实 IPC 链路**验证 PNG 卡片保存：渲染层 `readBuffer` → 注入污染 → `saveCard()` 真存 → 读回断言（含 PNG 结构完好、字节数一致）。前置：dev server + `--remote-debugging-port=9222` |
| `save-strip-live-worldbook.mjs` | 同上，覆盖另外 3 条落盘路径：`saveCard(.json)` / `wb:create` / `wb:save`（结束自动删样本，不动用户卡片库） |

⚠️ 跑热测试的两个坑（都实际踩过）：

1. 样本目录必须放 **`%APPDATA%\sillytavern-card-manager\`**（= `productName` 派的 userData），
   放 `%APPDATA%\JSK管理\` 会被 `isPathAllowed` 判「路径越界」——那不是功能 bug。
2. 脚本里的 Windows 路径**一律在 Node 侧用 `JSON.stringify` 生成字面量**，
   手工拼 `\\\\` 会产出双反斜杠路径，同样误报越界。

### 🏭 样本库生成器（造「带真值」的测试数据）

| 脚本 | 用途 |
|---|---|
| `make-preset-lib.mjs` | **合成预设库生成器**（预设查重标定用）：造 **16 个**带真值的样本 —— 11 对同源（exact / renamed / reskin×4 / trimmed / extended / reorder / flipped / sampler）+ 3 对无关（unrelated / sameNameOnly / sharedSkeleton）+ 2 个噪声（非 OpenAI 预设）；**同时输出 `_truth.json` 真值清单**（标定脚本据此算误报/漏报）。刻意还原真实形态：`prompts` 为**数组**、两个 `character_id`（100000/100001）并存、含 12 个默认骨架块。用法：`node scripts/tools/make-preset-lib.mjs "D:\TkDmGzq\_preset-calib"`（`--clean` 删除） |

### 数据分析（多为一次性，保留备查）

| 脚本 | 用途 |
|---|---|
| `extract-all-tags.cjs` | 扫描卡库提取全部标签（PNG `tEXt` chara 块 + JSON），统计大分类覆盖 |
| `analyze-tags.cjs` | 提取 `app_config.json` 全部标签，跑分类，统计覆盖 |
| `vector-model-test.cjs` | 向量模型效果验证（正例命中率 / 负例误报率 / 分数分布，检验 0.65 阈值是否合理） |
| `scan-rejected-cards.cjs` | 在万卡库里找出「像角色卡但被血统鉴定拒绝」的 JSON |
| `scan-theme-accent.cjs` | 扫描浅色主题下可能看不清的强调色文字类（-200/-300/-400）与未覆盖的深色类 |
| `scan-theme-gaps.cjs` | 精确扫描：使用中但 `[data-theme="light"]` 未覆盖的深色类（含透明度变体） |
| `_probe-card-plugins.mjs` | **卡内插件容器形态 / 解析开销**（**离线**，不需起应用）：`node scripts/probes/_probe-card-plugins.mjs "<库根>" [--perf] [张数]`。输出各容器路径（`tavern_helper.scripts` / 键值对数组形态 / 旧版 `TavernHelper_scripts` / `regex_scripts` / MVU / 第三方写卡扩展…）命中的卡数与样例，并列出脚本条目字段组合；`--perf` 另给 `harvestCardPlugins()` 单次耗时（最重 5 张 + 均值）。**改任何「读写卡内插件」的功能前先跑它** —— 这是判断「要兼容哪些形态」的唯一依据（实测 76 张库：主流形态 14 张、键值对数组 11 张、旧版 4 张） |

> ⚠️ **探针铁律**：读应用单例状态**必须**走 `window.__jskDiag.*`（应用真正使用的那份），
> 自己 `import('/js/utils/xxx.js')` 会因 Vite 的 `?t=` 查询参数拿到**另一个模块实例**，读数全错。

---

## 五、userData 与磁盘维护

| 路径（`%APPDATA%\sillytavern-card-manager\`） | 内容 | 处置建议 |
|---|---|---|
| `app_config.json` | **配置权威**（全局标签 / 自定义分类 / 覆盖层 `cardOverlays` / api / ui） | 原子写；历史曾因覆盖层膨胀到 3.48MB，后回落 ~28KB（正常量级） |
| `tavern_manager_config.json` | 上次打开的库路径等 | 压测时用隔离 profile 改写，不碰真实文件 |
| `snapshot_config.json` | 快照策略 | 原子写 |
| `chat_store.json` / `memory_store.json` | 测卡会话与变量树 / 长期记忆 | 用过测卡后才有 |
| `crash.log` | 渲染进程崩溃详情（`render-process-gone` 详情 + 自动 reload 记录） | **排查运行时问题的第一现场**；偶发 EPIPE 记录已容错、无害 |
| `Crashpad/` | 原生崩溃 `.dmp`（`crashReporter` 写，`uploadToServer:false` 不联网） | 出现 native 崩溃（如 `exitCode -36861`）时看这里 |
| `hf_cache/Xenova/…` | 本地向量模型缓存 | 见下一节 |
| `jsTavern_Trash` / `jsTavern_Backups` | 回收站 / 快照备份 | **用户数据，清理前必须问用户** |
| `*.tmp`（`app_config.json.<pid>.<seq>.tmp` 等） | 原子写残留 | 启动时 `cleanupStaleConfigTmp()` 自动清扫（见 [DF-13](../bugs/BUG-数据与文件.md)） |
| `Cache/`、`Code Cache/`、`GPUCache/` | Electron 浏览器缓存（可安全删除，重启自动重建） | 历史实测可释放 ~539MB |

**排查用户报「改了代码还是没变化」时**：先确认跑的是**源码版**（`npm start` = `build:web` + `electron .`），
而不是 `dist` 里的**旧安装包** —— 历史上真出现过「用户跑打包版，误以为修复无效」。

---

## 六、本地向量模型（`Xenova/paraphrase-multilingual-MiniLM-L12-v2`）

| 项 | 值 |
|---|---|
| 下载文件 | `config.json` / `tokenizer.json`(17MB) / `tokenizer_config.json` / `onnx/model_quantized.onnx`(113MB) |
| 缓存位置 | `userData/hf_cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/` |
| 下载源顺序 | ① hf-mirror（国内 ~9MB/s）→ ② huggingface 官方 → ③ GitHub 仓库兜底（onnx 分 8 片，断点续传 + `tmp/rename` 原子写 + 120s 超时） |
| 已知坑 | hf-mirror 会 **RST 掉 transformers.js 的 UA**（需在 require 前包装 `fetch` 注入浏览器 UA）；`raw.githubusercontent.com` 国内极慢（用 gh-proxy / ghfast 加速）；GitHub 单文件 100MB 限制（故分片） |
| 关键参数 | 相似度阈值默认 **0.35**（三处必须对齐：`useAITools.js` / `AITagModal.vue` / `main/vectorManager.js`）；短标签先按 `LABEL_TEMPLATE` 展开成描述句再嵌入，展开文本同时作为缓存 hash 输入 |
| 验证脚本 | `scripts/tools/vector-model-test.cjs`（命中率 / 误报基线）、`scripts/tools/live-vector-test.cjs`（真实主进程环境） |

> 完整的现象 / 根因 / 修复 / 防再犯，见 [`../bugs/BUG-AI打标与标签.md`](../bugs/BUG-AI打标与标签.md)（AI-03、AI-04）。
