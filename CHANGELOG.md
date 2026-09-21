# SillyTavern 角色卡管理器 · v1.0 → v2.2.13 更新汇总

> 更新周期：2026-08-09 ~ 2026-09-21
> 技术栈：Electron + Vue3 + Tailwind + ECharts

---

## 🩹 未发布 · 查重 / 扫描 / 检索全链路修复（Phase 1 + Phase 2 + Phase 3，2026-09-21）

> 规格：[`docs/规格与计划/查重扫描与检索-最终方案.md`](docs/规格与计划/查重扫描与检索-最终方案.md)
> ｜ 流水：[`实施工作日志.md`](docs/规格与计划/查重扫描与检索-实施工作日志.md)
> ｜ 待办：[`剩余任务.md`](docs/规格与计划/查重扫描与检索-剩余任务.md)
> ｜ 移动版：[`移动版同步-待办清单.md`](docs/规格与计划/移动版同步-待办清单.md)（独立成文）

### ✨ 用户可感知的变化
- **世界书「查看词条差异」不再崩**：词条数不同的两本书以前一开就渲染报错（词条数相同才不崩）；现在正常打开
- **能看出「哪个词条被新增 / 被删除」**：新增「🧩 词条级对齐」区，绿色 `[新增]` / 红色 `[缺失]` 逐条标注，
  不再只有「一大坨文本里某几句变色」
- **大世界书 / 大预设不再凭空消失**：以前超过 5MB 的文件被**静默丢弃**（无提示、不进统计）；
  现在能识别，且**被跳过的文件会在日志里点名**（数量 + 文件名 + 原因）；超大书按需加载并标「按需」
- **搜索更准**：修掉「搜『系统』却命中只含『体系 传统』的卡」；且**索引建好前后结果不再不一致**
- **搜索不再漏卡**：索引构建中 / 刷新未收尾时不再出现「明明有却搜不到」
- **搜索不卡了**：库很大时输入英文前缀（如 `syst`）以前每敲一个字母都要卡一下（万卡库实测 19~44ms/次），
  现在快 **20~70 倍**（0.5~1.3ms），且**搜到的结果和以前完全一致**（不改变匹配语义）
- **清理完有明确反馈**：查重 / 清理操作完成后弹出成功提示（以前只有失败才提示，成功时静默）
- **扫描有真进度条**：扫描世界书目录时显示进度条 + 当前文件名 + 百分比，平滑推到 100%（以前只有一个「扫描中」状态）
- **修掉「点世界书库 / 导入世界书就整个侧边栏消失」**：以前点「🌍 世界书库」或导入世界书后整个左侧栏消失且回不来，
  现在正常显示（详见缺陷 AR-40）
- **查重对比「一眼看出改了哪里」**：以前打开对比后词条正文是**纯色文本**，正文一长或只改几个字就看不出来；
  现在**变更行有底色**（红=本端缺失 / 绿=对端新增 / 琥珀=双方都有但内容变了），
  且**只把真正不同的那几个字/词标亮**（如只改了「并散发着微弱的蓝光」就只标这半句）；
  两侧还带**行号**且**逐行对齐**（以前左右各自滚动、行与行对不上）

### 🧩 实现要点（内部）
- **Phase 1（P0）**：新增 `js/utils/entryAlign.js`（`keyOf` 三级回退 + 带侧标识 + 一对一配对的外连接对齐）；
  `DiffModal.vue` 行级比对加 `v-if="f.diffText"` 守卫 + 无差异时占位文案 + `fileNameOf()` 防 `path` 裸 `split` +
  新增 `isEntryPairs` 分支（`payloadFor` 用 WeakMap 缓存）；`useDedupe.js` 世界书判定改 `hasEntriesShape`（字典形态归一化）
- **Phase 2（P1）**：
  - `useSearch.js`：就绪判定 `cardCount > 0 && !building && cardCount >= library.length`；查空回落内存匹配；
    **候选集短语复核**（去掉 `&& searchIndex.cardCount === 0`，改对候选集复算，同卡文本 Map 缓存）
  - `main.js`：新增 `SCAN_INLINE_MAX_BYTES=5MB` / `SCAN_PARSE_MAX_BYTES=50MB` / `SCAN_HEAVY_CONCURRENCY` / `SCAN_CACHE_VERSION=2`；
    分级处理（≤5MB 32 并发 / 5~50MB 低并发 / >50MB 只回元数据）；结果补 `size/mtime/entryCount/heavy/dataLoaded`；
    返回体新增 `skipped`；**预检未命中改写 `valid:null`**（不再固化否定）；`scanCache` 加版本号；**世界书 + 预设两侧同改**
  - `useWorldbooks.js` / `usePresets.js`：`reportSkipped`（跳过可见化）；`wbEntryCount` / `selectWorldbook` / `ensureWorldbookLoaded`（懒加载）
  - `SidebarPanel.vue`：词条数改用 `wbEntryCount`；点击走 `selectWorldbook`；「按需」徽标
- **Phase 3（P2 / 速度）**：
  - **T1 Toast**：`useDedupe.js` 注入 `showToast`（**未新建 `useToast.js`**，走 ctx 注入）+ `toastOk()` 统一成功出口
    （`showToast` 缺失时静默降级）；覆盖 4 条链路（角色卡 / 世界书 / 预设 / 内容级）的「清理成功」与「未发现重复」；
    `App.vue` 的 `useDedupe({...})` 调用处补传 `showToast`（原本**没传**）
  - **T2 真进度条**（四步接线）：`main.js` 新增 `sendWbProgress` + 轻量预扫 `countJson`（只 readdir，不 parse）算准 `total`，
    `handleOne` 用 `try/finally` 保证所有路径推进 `done`，节流「每 ≥20 个或 ≥120ms」；`preload.js` 暴露 `onWbScanProgress`；
    `useWorldbooks.js` 新增 `wbScanProgress` / `isWbScanning` / `wbScanPercent`（`finally` 复位）；
    `SidebarPanel.vue` 渲染进度条，**刻意放在模式切换之外**（启动自动恢复扫描时也可见）
  - **T3 拉丁前缀优化（PK-19）**：`searchIndex.js` 新增 `_buildBigram()`（token 二元组 → token **下标** `Int32Array`，
    换表时同步重建）+ 重写 `_getMatches()`（取**最稀有** bigram 候选集做 `includes` 精筛；桶不存在则精确剪枝）；
    **降级保障**（单字符 / `bigramDirty` / 下标异常 → 回退全表扫，只慢不错）；`push(...cards)` 改循环追加（防展开上限）；`stats()` 增 `bigramCount/bigramDirty`
  - **T6 调参**：`SCAN_HEAVY_CONCURRENCY` **3 → 2**（实测并发 2→12 耗时仅改善 3%，但内存增量 59MB → 118~146MB）
- **AR-40 修复**：`SidebarPanel.vue` 的 setup return 补 `wbEntryCount` / `selectWorldbook`（模板调用了但未绑定 → 渲染期 TypeError 卸载组件）
- **AR-41 修复（差异着色）**：新增 `js/utils/textDiff.js` —— 行级 LCS 对齐（先剥公共前缀/后缀行控规模）
  + 变更块内「删+增」**配对为 `changed`**（而非拆两条）+ 行内 token 级精确高亮（拉丁按整词 / CJK 按单字符）
  + 超长降级（>1500 行转位置比对、单行规模积 >25 万整段标记、全篇预算 300 万，**降级后仍严格对齐**）；
  `DiffModal.vue` 两侧共用同一份 `rows`（带行号，某侧缺失给 `null` 占位）→ 天然对齐；
  新增 `rowClass` / `hlClass` / `keyClass`（行底色 + 行内高亮 + 触发词 chips 着色）；
  `useDedupe.js` 的 `computeTextDiffLines` 改为调用新工具（删除已成死代码的 `chunkTextForDiff`）
- **缺陷编号**：AR-39 / AR-40 / AR-41 / DF-17 / DF-18 / DF-19 / PK-18 / PK-19

### 🔬 验证
- `npm test` → **471 pass / 0 fail**（原 403 → Phase 1+2 的 445 → Phase 3 的 460 → AR-41 的 471）
- `npm run build:web` 无错；`get_errors` 全清；`check-doc-links.mjs` 208 链接全解析
- **真实启动冒烟**（dev 模式 + 隔离 profile + CDP）：
  - `scripts/_probe-diff-align.mjs` → **15/15**（差异弹窗 UI 级；含旧代码条件对照 `oldCrashed === true`）
  - `scripts/_probe-scan-gate.mjs` → **12/12**（真实目录 6MB 书 `bigRecognized=true`、`skipped` 可见、二次扫描走缓存仍在）
  - `scripts/_probe-search-phrase.mjs` → **8/8**（真实搜索框输入「系统」，两路径均不命中「体系 传统」诱饵卡）
  - `scripts/_probe-wb-scan-progress.mjs` → **9/9**（T2：单次 IPC 收到 10 条进度事件，旧实现 0 条；`total` 准确、`done` 单调、终态 `done===total`）
  - `scripts/_probe-wb-sidebar-crash.mjs` → **8/8**（AR-40：点世界书库 / 反复切模式 → `aside` 存活、无 `_ctx.*` 错误）
  - `scripts/_probe-diff-coloring.mjs` → **15/15**（AR-41：三种行底色齐备、11 处行内精确高亮、两侧行号列数量相等、无渲染期错误）
- **测试有效性反向验证**：临时回退 `needPhraseCheck` → 用例失败（`['卡A']` → `['卡A','卡C']`）；
  临时移除 `selectWorldbook` 绑定 → `sidebarBindings.test.mjs` 失败并点名该符号
- **真实库实测（T4~T6，`H:\01\全局世界书` 39 本 / 53.6MB）**：
  - T4 头部预检误杀率 **0%**（唯一「未命中」的是酒馆预设，属正确拒绝）→ 无需放宽
  - T5 `entries[0]` 静默拒绝 **0 例**（被拒 4 本全是无 `entries` 的快捷回复配置）→ 无需修改
  - T6 并发调参依据见上（`SCAN_HEAVY_CONCURRENCY` 3 → 2）
- 新单测：`test/dedupeEntryAlign.test.mjs`（20）+ `test/searchPhrase.test.mjs`（9）+ `test/scanGate.test.mjs`（13）
  + `test/latinPrefix.test.mjs`（10，PK-19 结果一致性）+ `test/sidebarBindings.test.mjs`（5，AR-40 绑定完整性 + 3 条自检）
  + `test/textDiff.test.mjs`（11，AR-41 行对齐 + 行内高亮 + 两侧不得错位）
- **未发布**：本轮改动已提交源码与文档，**未打包、未推送 Release**

---

> **v2.2.12 专项（2026-09-19）**：角色卡「插件」页签（卡内酒馆助手脚本可视化编辑）
> + CT-19 卡内面板全局库缺失修复 + Python 一键检查工具。规格：`docs/规格与计划/角色卡插件页签-实现规格.md`。

---

> **🩹 v2.2.13（2026-09-21 发布）**：P1 打标三层漏斗开关 + P2 命令注册表 / 命令面板 / 菜单归位 + 全局资产库下线
> + 卡片自动分组（S1~S4 + 🤖 LLM 分辨）+ 「📁 分组」菜单 + 收纳规则易用性打磨 + 侧栏每页显示数量
> + 自动分组「重新扫描」引导修复（AR-38：未配置/未保存收纳规则时不再静默无反应，就地提示「先添加规则并保存」）。
> 文档：`docs/技术支持/方案-卡片自动分组.md` **v2.1**（规格：`docs/规格与计划/卡片自动分组-实现规格.md`）。
> 规格：`docs/规格与计划/打标三层开关-P1实现规格.md`｜方案：`docs/技术支持/方案-界面重整与应用级扩展系统.md`（v1.2）

---

## 🩹 v2.2.13 · 附录：自动分组「重新扫描」引导修复（AR-38）

### ✨ 用户可感知的变化
- 自动分组弹窗「🔄 重新扫描」：**未配置/未保存收纳规则**时点击不再毫无反馈——就地提示
  「还没有启用中的收纳规则——请到『📋 收纳规则』添加规则（或载入推荐模板），并点『💾 保存规则』后再扫描；
  规则改动需要先保存才会参与扫描」；「预览与执行」空态文案跟随已保存规则状态；重开弹窗清除旧提示

### 🧩 实现要点（内部）
- `js/components/AutoGroupModal.vue`：`doScan` 前置检查 + 新增 computed `hasEnabledSavedProfiles`
  （与 `useAutoGroup.scanAutoGroup` 的 enabledCount 同口径）+ `scanHint` 状态（打开时清空）
- 定性：**引导缺失**而非功能故障（`scanAutoGroup` 无启用规则静默 `return null` 属既有设计）——
  修复落在「拦截必配提示」原则（AR-38，详见 `docs/bugs/BUG-架构与渲染.md`）

### 🔬 验证
- `npm test` → **403 pass / 0 fail**（35 个文件）；`python scripts/check.py` 全绿
- 生产构建 + 隔离 profile 真实入口链全链路断言：0 规则点击 → 提示条出现；临时加规则并保存 → 扫描出计划（「将移动 1」）；
  删除并保存复原 0 规则 → 空态回归；重开弹窗复查全绿；控制台零报错

---

## 🩹 v2.2.13 · 卡片自动分组 + 分组菜单 + 收纳规则易用性 + 侧栏分页（S1~S4 已落地）

### ✨ 用户可感知的变化
- **🗂️ 自动分组**：给分组配一条「收纳条件」（标签 / 名称包含 / 名称正则 / 有世界书 / 有正则脚本），
  一键把**未分类**卡片自动移进同名分组文件夹（不存在的自动创建）——**先预览、后执行、可回滚**
- 入口：侧边栏「📁 分组」行的 🗂️ 按钮；「标签」菜单 → 🧹 整理与清理 → 🗂️ 自动分组
- **一键载入推荐模板**（按真实库分组命名整理的 27 条：NTR / 纯爱 / 催眠 / 人外 / 调教 / 校园…）
- 安全默认：**已手动分组的卡一张不动**；执行前二次确认；卡片已被删/被移/分组被改名时不中断整批、单独列出

### 🧩 实现要点（内部）
- 判定层纯函数 `js/utils/autoGroup.js`（顺序 = 优先级；`extractCardTags` 单入口 + 大小写不敏感；非法正则只跳过该条）
- 执行/回滚编排 `js/composables/useAutoGroup.js`：**唯一移动原语 `moveCardToGroup`**（三类 path 派生键迁移），
  日志跨次合并 + **逆序回滚**、变动检测五状态（ok/already/missing/changed/ambiguous）
- 落盘：`app_config.json` 顶层 `autoGroupProfiles` / `autoGroupLastRun`（落盘与恢复两端归一化）
- 新增静态防线 `scripts/pychecks/auto_group_safety.py`（唯一原语 blocker + 判定层纯函数 warn）
- 新增卫生检查（`core_project.py`）：**js 源码无本机绝对路径**（防开发机路径随构建进入用户可见文案）
- 新增「🧹 清理空分组」（侧栏按钮 + 「标签」菜单命令，DF-16）：清 0 卡片的自定义/预设空组
  （含分组空文件夹，仅空目录；孤儿空目录不处理；预设记入 `removedDefaultKeys` 可恢复；清理后显式冲刷落盘）
- 自动分组新增 🤖 **LLM 判定层**（用户拍板口径）：规则行可填「判定标准」（留空 = 不参与）；
  「🤖 AI 分辨」只对未命中/冲突卡分批请求（会话缓存、默认 20 张/批、批次节流），
  建议带置信度与理由、**默认不勾选**，可一键勾选/取消；调用走既有统一 API 通道（无新通道）
- 打标过程透明化：启动打标自动打开「🏷️ 打标过程」窗口（应用内，不再弹系统框汇报），
  逐张实时展示 ①规则/②向量/③LLM 处理结果与管线开关状态；失败按类聚合
  （401/403 → “API 认证失败：请检查密钥”，429 → 限流，网络/超时 → 连接类）
- 修复：选中卡片后的「批量操作悬浮条」盖住打标/自动分组等弹窗（用户报「被挡住了看不见」，AR-35）——
  悬浮条调整为在弹窗之前渲染，任何弹窗自动盖住它（弹窗关闭后悬浮条恢复）
- 修复：打标进行中「🏷️ 打标过程」窗口被批量打标弹窗盖住（用户报只见「打标处理中」，不见过程窗，AR-36）——
  过程窗口层级提升到所有弹窗之上（z-[60]；原与其同层、且先渲染吃亏），打标全程实时可见，结束后保留可关闭
- **新增「📁 分组」菜单**（用户需求：分组命令集中）：新建 / 重命名 / 删除当前分组、自动分组（收纳规则）、
  批量修改分类分组、清理空分组 —— 全部集中到顶栏独立菜单（原「🏷️ 标签」菜单里的分组类条目已迁入）
- **自动分组易用性打磨**（用户反馈：不该让用户手写正则 / 手写 AI 词）：
  - 「标签（精确匹配）」「名称包含关键词」升级为**多值点选编辑器**：输入回车即生成一个词条，
    也可从「🏷️ 点选」面板一键加入（系统标签库 + 全库卡片标签，已加入的自动标亮，可连点多个）；
    多个词自动「任一命中」——常见多词场景**不再需要写正则**
  - 「🤖 判定标准」新增**「✨ 生成」一键起草**（按分组名与当前条件生成草稿，可再改）
  - 「名称正则」标注为**高级**（保留手写能力；提示只想匹配多个词时改用「名称包含关键词」）
  - 修复：新建收纳规则的默认目标分组不再默认选中「未分类」（无意义目标）
- 修复：新增菜单时 **key 数组漏接线会让下拉渲染成空白**（「分组」菜单踩到，热测试发现；AR-37）——
  命令注册表并行补上**渲染接线双向检查**（模板引用 / 注册表菜单必须与 key 数组接线一致，静态检查拦截）
- **侧栏每页显示数量**（用户需求）：角色卡 / 世界书 / 预设 / 插件 四个库统一分页——每页数量选择器
  共 11 档（15 / 25 / 35 / 45 / 55 / 65 / 75 / 85 / 95 / 105 / 115），**全库共享、改一处四库联动、重启保留**；
  世界书 / 预设 / 插件三个库补齐翻页条（此前仅角色卡库有分页）；切换每页数量时页码自动收回防空白页；
  翻页条统一样式为**单行紧凑、固定侧栏底部**（小箭头按钮，不再浮在卡片上/不再占两行）
- 文案修正：推荐模板「来源」不再显示开发机样本库路径（改中性描述）
- 新增端到端脚本 `scripts/auto-group-test.mjs`（隔离库真实移动/回滚；`--prep` / `--cleanup`）

### 🔬 验证
- `npm test` → **402 pass / 0 fail**（35 个文件；本次新增 5 个文件 / 51 例：自动分组 20 + 模板 5 + 空组收集 6 + LLM 12 + 打标反馈 8）
- `python scripts/check.py` → **22 项：21 通过 / 1 提醒 / 0 失败**
- 隔离库端到端全绿（含「删除一张后回滚 → 已不存在单列」）
- **真实库热测**（生产构建 + 隔离 profile，**只读**）：推荐模板 27/27、预览 15/跳过 61/冲突 2、真实库零改写、无渲染层报错
- **真实软件全链路回归**（生产构建 + 真实卡库，AR-35/AR-36 复核）：
  勾选 → 悬浮条「AI 打标」→ 开始打标 → 过程窗口与打标弹窗同开时**恒在最上层**
  （z 层级 60>50 + elementFromPoint 命中断言）、过程窗关闭键直击可点、打标结束保留、
  打标期间弹窗全部按钮禁用（盖住它零操作损失）、清理后无残留、控制台零报错

---

## 🩹 v2.2.13 · 附录：卡片自动分组 v1.0 → v2.0 方案修订（设计留痕）

### 📄 卡片自动分组方案：v1.0 → v2.0（按评审意见修订）

- **「标签即分组」已被否决**，替代设计为「**声明式分组档案**」（**分组声明成员资格**，而非“规则产出分组”）——
  收纳规则**寄生在分组上**、不能凭空造分组 → **文件夹数量 ≡ 用户显式创建的分组数**，与标签体系解耦。
- 否决理由（**四条系统论证**，已写进文档留痕）：① LLM 层标签自由产出 → 文件夹数量**在原理上不可控**；
  ② 标签（多对多描述性）与分组（一对一互斥容器）**语义错配**；③ v1 的「标签优先级」解法把模式 A 逼进死角
  （用户要维护的有序清单**等价于一张「标签→分组」映射表**，那不如直接做规则表）；
  ④ 标签**可重算** vs 物理移动**不可逆** → 多批次打标后库变成「快照混合物」（数据漂移）。
- **判定语义全新、交互经验借鉴**：分组条件不照拄 `{name, regex, tag}`（两者**表面同构、语义相反**：
  打标可多命中叠加，分组必须唯一归位）；但可复用规则表 UI 形态与 `disabled` 清单式落盘（**零迁移**）。
- **回滚设计加强**（修 v1 两处缺陷）：日志改为**按卡名 + fromGroup 记**（v1 的 `oldPath` 在分组重命名后**全部失效**）；
  回滚**必须复用 `moveCardToGroup`**（同样是移动，涉及三类路径派生键迁移）；空分组被删后回滚需**重建**并提示；
  卡片已变动时**单独标记“无法自动回滚”**，不静默跳过、不中断整批。
- **字段定死**：判定层取标签**只走** `js/composables/useSearch.js:87` 的 `extractCardTags`
  （实测兼容 `item.tags` / `customTags` / `data.tags` 两种层级、数组与逗号串，**输出全小写**）；
  `author` 类型字段**未取证**，本期不放开。
- **实测更正**：内置打标规则 **38 条**（v1 与首轮评审均记为 “37 条”），仍分 4 组。
- 裁决表扩至 **Q1~Q9**（Q1 否决 A / Q3 改为“分组顺序即优先级”）；专项验收补至 **12 条**
  （回滚变动检测 / 空分组重建 / slim 库标签可读 / 大小写口径 / 布尔条件边界）；
  静态检查（“绕过原语”）的**适用范围明确覆盖回滚代码路径**。
- 文件：`docs/技术支持/方案-卡片自动分组.md`（**约 449 行**）

---

## 🩹 v2.2.13 · P1 打标三层漏斗开关（一）

### ✨ 用户可感知的变化
- **三层独立开关**：① 规则匹配 / ② 本地向量 / ③ LLM 兜底 可单独启停
  （入口：设置 → 🏷️ 打标与分类；打标弹窗顶部「执行管线」同步显示**本次执行计划**与**跳过原因**）
- **内置规则逐条开关**：38 条内置规则支持**单条 + 组级**（全开本组 / 全关本组）启停，**重启保留**
- **导入自动打标联动**：① 关闭时「导入时自动打标」自动失效（避免"开着却没反应"被当成 bug）
- 顺带修掉旧问题：**② 向量开关此前不持久化**（只存内存，重启回到默认）

### 🧩 实现要点（内部）
- **新增纯函数层** `js/utils/tagFunnel.js`：`DEFAULT_TAG_FUNNEL` / `normalizeTagFunnel` / `normalizeDisabledRules` /
  `isFunnelEmpty` / `resolveFunnelPlan` / `formatFunnelSummary` / `formatFunnelBadge`
  —— **UI（按钮可用性）与引擎（是否执行）共用同一个 `resolveFunnelPlan`**，避免"按钮说能跑、引擎却不跑"
- `cardLoader.compileAutoTagRules(customRules, disabledNames)` 新增第二参；**省略 = 与旧版逐位一致**
  （`cardLoader.js:236` 兜底导出保持单参数 → 老配置 / 老调用零迁移）；关闭清单**只作用于内置规则**，同名自定义规则仍生效
- `useAITools.startAITagging()` 三层**入口短路**（`plan.rule` / `plan.vector` / `plan.llm`），**层内逻辑一行未改**；
  三层全关 → 入口 `nativeAlert` + 弹窗按钮禁用（**双保险，不出现"静默 0 结果"**）
- `useLocalVector` 改为 `tagFunnel.vector` 的**双向别名**（读=开关、写=回写+落盘），AITagModal 既有绑定与 ctx 暴露零改动
- **清洗白名单解耦（防数据事故）**：`useTags` 的 keep 词表改用**完整规则集**（`App.vue` 的 `autoTagRulesAllForClean`）——
  否则用户关掉某规则后，该规则历史产出的标签会被判为"外来标签"并被**物理清除（不可逆）**；仅改注入源 1 处，`useTags.js` 零改动
- 落盘：`app_config.json` **顶层**新增 `tagFunnel`（默认 `rule:true / vector:false / llm:true`）与 `autoTagDisabledRules`
  （`useConfigPersistence` 收集 + 启动恢复走 `isRestoringConfig` 闸门；`vector` 默认关 = 与改动前行为一致，避免"重启后突然下载 120MB 模型"）
- **新增防线脚本** `scripts/pychecks/ctx_exposure.py` + 基线 `ctx_exposure_baseline.json`
  （AR-13：比对 `App.vue` 的状态定义与 `ctx` 暴露，**新增未暴露即拦下**；已自测：临时插入未暴露状态 → 精确报出并给出处理指引）

### 🔬 验证
- `npm test` → **321 pass / 0 fail**（基线 290 → 新增 31：`tagFunnel.test.mjs` + `autoTagRules.test.mjs` 共 29 例、
  `cleanForeignTags.test.mjs` 新增 2 例 H2 白名单解耦防线用例）
- `npm run build:web` → 通过（1.6~1.7s）；`python scripts/check.py --fast` → 通过 12 / 失败 0
  （含新增 ctx 暴露检查：150 个状态定义 / 15 项未暴露均在基线内，无新增回归）
- 隔离 profile 真实启动（`--user-data-dir=%TEMP%\jsk-p1-s2/s3/s4-smoke`）→ 无 `[Vue 错误]`、无 `crash.log`、Crashpad 无转储
- **CDP 端到端**（生产 `app://` 构建）：设置菜单「🏷️ 打标与分类」渲染 ✓；编辑菜单状态提示 `规则✓ 向量✗ AI✓` ✓；
  点击三层开关 → `规则✗ 向量✗ AI✗` + 全关警告 ✓；`app_config.json` 中 `tagFunnel` 三项 false **已落盘** ✓；
  **重启后仍为全 ✗**（恢复分支生效）✓
- 待人工目视（需先选卡才能打开弹窗）：三层全关时「开始打标」按钮禁用 + `🚫 管线已全关` 文案

### 📄 文档
- 规格：`docs/规格与计划/打标三层开关-P1实现规格.md`（S1~S4 分步实施与 3 条硬验收）
- 方案：`docs/技术支持/方案-界面重整与应用级扩展系统.md`（P1 设计 + 评审结论 + §八 变更风控）

---

## 🔧 v2.2.13 · P2 命令注册表与菜单归位（二）

### ✨ 用户可感知的变化
- **新增「🏷️ 标签(T)」顶级菜单**（2026-09-20 按用户要求）：把标签 / 打标类命令集中起来，分三组
  —— ☑️ 选择（全选所有卡片 / **反选**）、🏷️ 打标（AI 智能批量打标 / **批量加标签…** / 批量修改分类分组）、
  🧹 整理与清理（管理规则表 / 恢复内置规则全开 / 清理无效全局标签 / 清洗历史外来标签）
- **新增「⌘ 命令面板」（`Ctrl+Shift+P`）**：搜索并执行任意命令（全部命令可搜），纯键盘操作（↑↓ 选择 / Enter 执行 / Esc 关闭）
- **菜单按「用户任务」重新归位**（旧位置保留一行「已移动到…」提示，一个版本后移除）：
  - 顶部菜单「窗口(W)」→ **「视图(V)」**（名称与内容相符：只放 8 个视图开关）
  - 新增 **「帮助(H)」** 菜单：检查应用更新（原先藏在「设置」里）
  - **按稳定性把菜单拆开**（2026-09-20 按用户要求：实验菜单不混放稳定工具）：
    · 新增 **🧰 工具**：命令面板 / 清理无效全局标签 / 同名查重 / 版本查重 / 清洗历史外来标签；
    · 新增 **🔧 维护**：历史快照 / 回收站 / 全局回收站 / 清理全部快照 / 清理孤儿快照
      （**菜单项名称改为纯中文**：不再夹 `.bak` / `.trash` / `jsTavern_Trash` 等英文）；
    · 「🧪 实验与工具」→ **🧪 实验**：只留早期 / 不稳定功能（全盘打捞卡片、本地 AI 对话测卡）；
    · **外观只在「设置 → 🎨 外观与字号」**（视图菜单里的重复组已取消；工具栏「主题」快捷按钮保留）。
  - 「文件」菜单新增 **💾 备份配置**（与工具栏「备份配置」同一命令）；新增 **📂 打开预设目录...**
    （该功能早已存在于侧边栏预设视图，只是顶部菜单一直没入口）；
    工具栏去掉与「文件」菜单重复的「📂 打开本地库」「🌐 链接导入」
- **快捷键统一收口**：`Ctrl+O / Ctrl+I / Ctrl+S / Ctrl+Shift+P` 由注册表分发
  （「物理保存修改」在卡内插件页签打开时仍自动路由到插件保存 —— 行为不变，但不再是手写特判）

### 🧩 实现要点（内部）
- **新增** `js/utils/commandRegistry.js`：注册表单一真相源（`register / list / listByMenu / findShortcut / execute / getProblems`）
  - **id 重复 / 快捷键冲突 → 后注册者拒绝并记录**（绑不静默覆盖）；`shortcut` 保留原始大小写（菜单显示 `Ctrl+O`），`shortcutKey` 为归一化匹配键
  - `when` 条件 v1 只支持单值相等比较（`appMode == 'worldbooks'`），**语法不认识时放行**（宁可多显示，不可静默藏命令）
  - `menu` 支持**数组** = 同一命令多菜单镜像入口（评审 2-2 要求）；`sectionTitle` 支持菜单分组小标题
- **新增** `js/composables/useCommands.js`：50 条内置命令声明（菜单 / 工具栏 / 命令面板 / 快捷键同源）
- **新增** `js/components/CommandPaletteModal.vue`（模糊搜索 + ↑↓/Enter/Esc + 分组展示）、
  `js/components/CommandMenuItem.vue`（菜单项 / 工具栏两种形态，含 ✓、badge、禁用态）
- `HeaderBar.vue`：文件 / 编辑 / 标签 / 推送 / 视图 / 工具 / 帮助 **7 个菜单由注册表渲染**；
  设置菜单因「命令 + 开关/滑块/子菜单」交错结构保持手写渲染，但**数据源同样走注册表**（`runCommand('settings.xxx')`）
- `App.vue` keydown：全局快捷键先查注册表（`findShortcut`），**命中即分发并 return**；未注册的按键才走既有分支
  （`saveCurrentAssetSmart()` 统一“卡内插件页签打开时 Ctrl+S 走插件保存”的旧特判）

### 🧭 影响半径清单（§八 8.7-1：每个提交必附）
### 🧭 影响半径清单（§八 8.7-1：每个提交必附）

| 我改了谁 | 谁依赖我 | 怎么验 |
|---|---|---|
| `js/utils/commandRegistry.js`（新增） | `useCommands.js`、`HeaderBar.vue`、`CommandPaletteModal.vue`、`App.vue` keydown | `npm test`（`commandRegistry.test.mjs` 30 例）+ `pychecks/command_registry.py` + CDP 面板计数 50 |
| `js/composables/useCommands.js`（新增，50 条命令 / 8 个菜单键） | HeaderBar 各菜单的 `v-for` 渲染、工具栏手写按钮的 `runCommand`、命令面板 | CDP 菜单项数 `8/4/9/2/14/16/12/1` + 面板 50 条 + pycheck「引用存在」 |
| `js/components/HeaderBar.vue`（菜单 / 设置菜单 / 工具栏三区块） | 用户交互（含旧位置迁移提示） | 隔离 profile 冒烟 + CDP DOM 断言 + **截图对照**（抓到了 AR-32/AR-33） |
| `js/components/CommandPaletteModal.vue`（新增） | 全局快捷键 `Ctrl+Shift+P` | CDP：打开 / 搜索过滤 / Enter 执行并关闭 / Esc 关闭（注：`fade` 过渡期内元素仍在 DOM，断言需轮询等待） |
| `js/components/CommandMenuItem.vue`（新增） | 菜单与命令面板共用 | 两种形态均渲染（菜单项带 ✓ / badge / 禁用态） |
| `js/components/App.vue`：keydown 分发、`saveCurrentAssetSmart`、`selectInvertCards`、新增 ctx 字段 | 全局快捷键；HeaderBar 及其它子组件 | `ctx_exposure.py`（157 个定义无新增未暴露）+ 冒烟无 `[Vue 错误]` |
| **`App.vue` 的 `const ctx = {...}` / `provide` 相邻结构** | **`ctx_exposure.py` 自身（AR-31）** | 该项检查必须 ✅ —— 一旦报「未解析到结构」即防线宕机，按 AR-31 处理 |

### 🔬 验证
- `npm test` → **351 pass / 0 fail**（P2 新增 `commandRegistry.test.mjs` 30 例：含多菜单/分组标题/独立排序）
- `npm run build:web` → 通过；`python scripts/check.py` → 通过 17 / 失败 0（全量）
- **CDP 端到端**（`app://` 真实构建）：`Ctrl+Shift+P` 打开面板并列出 **50 条命令** ✓；搜索过滤（含无匹配 0 条）✓；
  Enter 执行并关闭 ✓；Esc 关闭 ✓；菜单结构 `文件8 / 编辑4 / 标签9 / 推送2 / 视图14 / 设置16 / 工具12 / 帮助1` ✓；
  分组标题多处渲染正确（含「标签」菜单三分组）✓；旧位置迁移提示 ✓；工具栏去重（删 2 按钮）✓；
  **镜像入口同源**：设置菜单里点「界面字号 +1」立即生效 ✓；点「明亮白昼」→ 主题全局切换 ✓（工具栏主题按钮同步）
- 隔离 profile 真实启动 ×3 → 无 `[Vue 错误]`、无 `crash.log`、Crashpad 无转储
- **新增防线脚本** `scripts/pychecks/command_registry.py`：静态校验「命令 id 唯一 / 快捷键不冲突 / `runCommand` 与菜单键引用存在」，
  已自测（临时插入重复 id 与重复快捷键 → 精确报出；「最后一个命令块无尾逗号」「注释里的示例 id」两种假阳性已修）

### 🐟 实施期发现并修掉的一个「防线失效」缺陷（AR-31）
- 把命令注册块插到 `const ctx = {...}` 与 `provide('appCtx', ctx)` **之间**，导致 `ctx_exposure.py`（AR-13 防线）
  正则失配、**降级为提醒**（等于防线静默宕机）。已把注册块移到 `provide` **之后**，
  并在该处留下「这两句必须保持紧邻」的注释。检查恢复：157 个状态定义 / 15 项未暴露均在基线内 ✓
- 且 `ctx_exposure.py` 已强化：结构失配时**由提醒升为失败并直接指出中间插了什么**（防再犯机器化）
- 详见 `docs/bugs/BUG-架构与渲染.md` AR-31（含防再犯条目）

### 🐞 实施期发现的另两个缺陷（AR-32 / AR-33）
- **AR-32（静默 undefined）**：`dedupeTargetLabel` / `funnelBadge` / `funnelEmpty` 只定义在 `HeaderBar` 内部、
  从未进 ctx → 菜单直接显示「同名查重与版本清理（undefined）」，打标状态后缀则被 `safeCall` 吞掉而**无声消失**。
  已在 `App.vue` 定义并暴露这三个 computed，`HeaderBar` 改为复用同一份；
  并把「命令引用的 ctx 字段存在」固化为 `command_registry.py` 的**第二项检查**（现为「48 个引用全部存在」✓）。
- **AR-33（菜单排序错乱）**：`listByMenu()` 当时**复用了 `list()` 的顺序**（按 `menus[0]` 排），
  导致多菜单命令在**非主菜单**里按“主菜单名”落位 —— 新建「标签」菜单时「反选」「批量加标签」被甩到末尾、
  分组标题重复。已改为**按本菜单 section/order 独立排序**（不再需要“调 `menus[0]`”这类绕过手法），
  并补 2 条回归单测。两次都是靠 **§八 8.5 的「截图对照」防线**发现的。
- 三条缺陷均已在 `docs/bugs/` 登记（含防再犯）。

### 🧭 影响半径清单（§八 8.7-1：每个提交必附）

| 我改了谁 | 谁依赖我 | 怎么验 |
|---|---|---|
| `js/utils/commandRegistry.js`（新增） | `useCommands.js`、`HeaderBar.vue`、`CommandPaletteModal.vue`、`App.vue` keydown | `npm test`（`commandRegistry.test.mjs` 30 例）+ `pychecks/command_registry.py` + CDP 面板计数 50 |
| `js/composables/useCommands.js`（新增，50 条命令 / 8 个菜单键） | HeaderBar 各菜单的 `v-for` 渲染、工具栏手写按钮的 `runCommand`、命令面板 | CDP 菜单项数 `8/4/9/2/14/16/12/1` + 面板 50 条 + pycheck「引用存在」 |
| `js/components/HeaderBar.vue`（菜单 / 设置菜单 / 工具栏三区块） | 用户交互（含旧位置迁移提示） | 隔离 profile 冒烟 + CDP DOM 断言 + **截图对照**（抓到了 AR-32/AR-33） |
| `js/components/CommandPaletteModal.vue`（新增） | 全局快捷键 `Ctrl+Shift+P` | CDP：打开 / 搜索过滤 / Enter 执行并关闭 / Esc 关闭（注：`fade` 过渡期内元素仍在 DOM，断言需轮询等待） |
| `js/components/CommandMenuItem.vue`（新增） | 菜单与命令面板共用 | 两种形态均渲染（菜单项带 ✓ / badge / 禁用态） |
| `js/components/App.vue`：keydown 分发、`saveCurrentAssetSmart`、`selectInvertCards`、新增 ctx 字段 | 全局快捷键；HeaderBar 及其它子组件 | `ctx_exposure.py`（157 个定义无新增未暴露）+ 冒烟无 `[Vue 错误]` |
| **`App.vue` 的 `const ctx = {...}` / `provide` 相邻结构** | **`ctx_exposure.py` 自身（AR-31）** | 该项检查必须 ✅ —— 一旦报「未解析到结构」即防线宕机，按 AR-31 处理 |

### 📄 文档
- 方案：`docs/技术支持/方案-界面重整与应用级扩展系统.md`（P2 实施进度 + 偏离清单 + 新缺陷记录见 §十二；P2-2 表末“菜单入口补齐”项已按用户澄清修正口径）
- 缺陷：`docs/bugs/BUG-架构与渲染.md` AR-31 / AR-32 / AR-33
- **对外迁移对照表**：`RELEASE_NOTES.md` 顶部 v2.2.13 段

### 修复：顶部菜单「点击命令后不关闭」（AR-34）

- **现象**：菜单展开后点里面的命令，命令执行了但**菜单仍然开着**，必须手动把鼠标移开；
  命令会弹窗时（如「管理规则表」）菜单与弹窗**叠在一起**，看起来像卡死。
- **根因**：菜单面板原用纯 CSS `hidden group-hover:flex` 驱动 —— `:hover` 由鼠标位置决定，
  **点击不会改变它**，代码里没有任何「点击后关闭」的通道。
- **修复**：菜单显示改为 **JS 状态控制**：
  · `HeaderBar.vue` 新增 `menuOpen` 状态，9 个菜单容器改 `@mouseenter` / `@mouseleave`，
    面板改 `:class="menuOpen === key ? 'flex' : 'hidden'"`；
  · 菜单项（`CommandMenuItem`）**已有**的 `@executed` 事件 → `closeMenus()`，
    **只在实际执行了命令时关**（点禁用项不关，符合预期）；
  · 手写按钮走的 `runCommand()` 内部也调 `closeMenus()` —— 一行覆盖设置菜单里的全部手写入口；
  · 菜单按钮顺带加 `@click`，鼠标未移开时也能重新打开。
- **验证**：集成浏览器**真实鼠标** hover + 点击 → 面板立即关闭 ✓；点菜单按钮可重新打开 ✓；
  弹窗类命令（管理规则表）→ 菜单关闭 + 弹窗正常打开、不再重叠 ✓；
  Electron 干净启动**无 Vue 警告** ✓、9 个面板初始均 `hidden` ✓。
- **检出方式（写下来防再踩）**：CDP 的 `element.click()` **不改变 `:hover`**，
  所以脚本断言永远测不出这个缺陷 —— 涉及 hover / 鼠标位置的交互必须用**真实鼠标**（集成浏览器 / 人工）验证。

### 菜单结构再调整（2026-09-20，按用户决定）

- **「编辑」菜单并入「标签」菜单（编辑菜单整体取消）**：原编辑菜单 4 项中，
  「AI 打标 / 批量改分类 / 全选」与标签菜单**重复**（已从编辑菜单删除），
  「批量选择模式」一并移入标签菜单的「☑️ 选择」组；标签菜单底部留一行「已从编辑菜单并入本菜单」提示（一个版本后移除）。
- **快捷字母补齐**：`🧰 工具(G)` / `🔧 维护(W)` / `🧪 实验(L)` —— 与文件(F) / 标签(T) / 推送(P) / 视图(V) / 设置(S) / 帮助(H) 格式一致。
- **「反选」标题去掉括号说明**（原标题「反选（未选→选 / 已选→取消）」影响美观），说明移入悬停提示。
- **验证**：菜单 10 → **9 个**；标签菜单 10 项；`check.py` 命令项通过（49 条命令 / **10 个菜单键** / 13 处引用）；
  CDP 断言标签菜单分组标题 = ☑️ 选择 / 🏷️ 打标 / 🧹 整理与清理；热模式（Vite HMR）下自动生效，无需重新构建。

### 全局资产库下线（2026-09-20，按用户决定）

- **动机**：该功能处于尴尬位置 —— 与侧边栏「世界书库 / 预设」及卡内世界书编辑重叠，且只做只读浏览；
  用户决定**先关闭**，后续改为以「扩展」形式重新提供（扩展化已暂缓，见上方「后续」段）。
- **处理（注释化，可恢复，未删任何文件）**：
  · 工具栏入口 → `HeaderBar.vue` 注释掉按钮，原位置留一行灰色提示「全局资产库已下线」（一个版本后移除）；
  · 命令 `toolbar.globalAssets` → `useCommands.js` 整块注释；
  · 弹窗渲染 + 组件导入/注册 → `App.vue` 注释掉；
    **保留** `showGlobalAssetModal` / `globalAssetTab` 状态与 ctx 暴露（ref 被 ctx 引用），
    且 `globalAllWorldbooks` / `globalAllRegexScripts` 仍被「全库词条搜索」共用，不能一并注释。
  · `GlobalAssetModal.vue` 文件保留；三处注释均写了恢复步骤（搜 `⛔`）。
- **验证**：命令面板 50 → **49 条**（搜“资产库”无结果）；工具栏按钮消失、仅留提示；
  `check.py --fast` 通过；冒烟无 `[Vue 错误]`、无 `crash.log`。
- **顺手修掉一个检查缺陷**：`pychecks/command_registry.py` 原先只剥离 `//` / `*` / `/*` 注释，
  不认识 `<!-- -->` 注释块 → 把注释掉的按钮当成“引用未注册命令”**误报**。
  已支持 HTML / Vue 注释（含行内片段），以后注释代码不会再假报。

### 后续：应用级扩展系统（P5 / P3 / P4）暂缓

- 用户 2026-09-20 决定：**先专注当前功能与稳定性，扩展化转后续**（设计已评审完毕，不需要重做）；
- 已完成的前置：**P2 命令注册表**正是扩展贡献点的挂载目标（前置 1 已就绪）；
- 存档位置：[`docs/规格与计划/后续升级计划.md`](docs/规格与计划/后续升级计划.md) 第四节（实测难度基线 + 重启前置清单）
  + 方案 §六 P5 设计 / §四 P3 / §五 P4 / §12.4 难度评估；
- 术语：统一叫「**扩展**」，「插件」只指卡内酒馆助手脚本。

---

## 🔧🚀 v2.2.12 卡内插件页签 + CT-19 面板全局库修复

### 🧩 角色卡「插件」页签（卡内酒馆插件可视化编辑）
- **入口**：`EditorPanel.vue` 新增 `currentTab === 'plugins'`（徽标 = 卡内脚本条数；`viewOptions.showPlugins` 可关，顶部视图菜单可切换）
- **数据层** `js/utils/cardPlugins.js`（纯函数，可单测）：`harvestCardPlugins` / `resolveScriptContainer` /
  `resolveVariablesContainer` / `buildScriptItem` / `writeScriptField` / `createScriptEntry`
  - 兼容实测三种真实形态（76 张卡扫描统计）：`extensions.tavern_helper.scripts`（25 张，主流）、
    **键值对数组形态** `[["scripts",[…]]]`（同一字段的另一种导出）、旧版 `TavernHelper_scripts`（`value` 包装）；
  - **容器存在即出分组**（空容器也出，不再「明明有脚本却显示没有」）；形态异常只报 `shapeWarning`、**不改造数据**；
  - 新增条目跟随既有形态（旧版容器继续写 `value` 包装），不破坏卡片结构；编辑落在原对象上（`item.host`）。
- **交互层** `js/composables/useCardPlugins.js` + `js/components/CardPluginModal.vue`
  - 展开 = 内嵌 `CodeEditor.vue`（CodeMirror：高亮 / 行号 / 查找替换 / ✨ 格式化）；⛶ 放大 = 全屏弹窗（同一组件，Esc 关闭）；
  - 正文编辑 **400ms 防抖**，收起 / 关弹窗立即 flush（避免逐键失效该卡 Token 缓存）；
  - 脚本「行数」**惰性计算**：最重卡（脚本正文 ~2MB）单次解析 **0.95ms → 0.012ms**（全库均值 0.023 → 0.003ms）——
    解析函数在每次 `refreshCardData()`（如描述框逐键输入）都会重跑，惰性后不再白花；
  - 只读 JSON 文本 `WeakMap` 凝 stringify + 缓存（变量树可能上万行）；切卡清空展开态。
  - **弹窗必须在 `App.vue` 顶层**：项目全局样式给 `.border*` 加了 `transform: translateZ(0)`，
    带该类的祖先会成为 `fixed` 的包含块，页签内 `fixed inset-0` 会跑偏。
- **测试**：`test/cardPlugins.test.mjs`（11 例，形态兼容）+ `test/cardPluginsPanel.test.mjs`（10 例：编辑/新增/删除/展开，
  删除链路因 Electron 原生确认框无法自动化而固定在这里）。
- **规格**：`docs/规格与计划/角色卡插件页签-实现规格.md`

### 🔴 CT-19 ｜ 卡内 HTML 面板缺 jQuery/Vue 全局库 → `$ is not defined`（CT-13 修复漏分支）
- **现象**：`MC_lite` 卡面板在测卡区空白；控制台 3 条 `Uncaught ReferenceError: $ is not defined`（来源 `__jsk_seg__` 文档）
- **根因**：`buildHtmlSrcdoc()` 按 4 种文档形状分别补壳，只有前两种拼了 `vendorTags`
  （`app://index.html/vendor/chat-host.js`）—— **「仅 `<body>`」与「纯片段」两个回退分支漏了它**，
  桥接在、全局库不在 → 模板顶层 `$` 直接 `ReferenceError`
- **修复**：两个回退分支补 `vendorTags`（各 1 行）；`test/chatRender.test.mjs` 新增 2 例
  （非空 vendor × 4 种形状必须都带上 + vendor 要早于模板脚本；空 vendor 不得凭空插入）
- **验证**：`npm test` 290 例全绿；真实卡冒烟 `$ is not defined` **3 条 → 0 条**，且卡内面板应用**真的启动**
  （日志 `[GameLayout] MClite布局已加载` / `[App] MC房子应用已挂载` / `[MvuStore] …使用模拟数据`）；
  合成自检卡面板自报 `{ jQuery: true, Vue: true, zod: true }`
- **防再犯**：多分支生成同一类文档时，「公共注入」必须每个分支都带（已用参数化测试锁住 4 种形状）

### 🧪 开发工具（不进安装包）
- **Python 一键检查**：`scripts/check.py`（运行器）+ `scripts/checkkit.py`（框架）+ `scripts/pychecks/`（内置 12 条 + 声明式 2 条）
- 覆盖：语法（Node/Python/JSON）、单测、构建、文档相对链接、文档脚本登记、版本号一致性、
  **对外文件禁词（只扫 RELEASE_NOTES 最新段）**、仓库卫生（缓存/临时文件）、探针脚本语法、preload 暴露面
- 用法：`--fast / --only / --skip / --changed / --strict / --json / --list / --new / --ascii`；退出码 0/1/2
- **卡内插件端到端**：`scripts/card-plugins-test.mjs`（黑盒 DOM：页签存在 / 面板渲染 / 徽标与条目数一致 /
  展开内嵌编辑器 / ⛶ 全屏放大与 Esc / 只读分组 / 无渲染层报错；可选 `TEST_ADD=1` 验「空容器卡一键新建」，仅改内存不落盘）
- **卡内插件离线探针**：`scripts/_probe-card-plugins.mjs "<库根>" [--perf]` —— 容器形态统计（路径 × 卡数 × 样例 + 脚本字段组合）
  与解析开销（实测 76 张库：主流形态 14 / 键值对数组 11 / 旧版 4；最重卡 0.010ms、均值 0.003ms）

### 📄 文档
- 新规格：`docs/规格与计划/角色卡插件页签-实现规格.md`（含 76 张卡实测表、踩坑、CDP 验收记录）
- `docs/bugs/`：CT-19 完整条目 + 索引（CT 19 条）；`docs/技术支持/README.md` 登记新工具脚本
- 修正交接文档版本号与测试规模（START-HERE / AI交接指导 / docs/README）

### 🔬 验证
- `npm test` → **290/290**（27 个测试文件，新增 2 个文件 / 23 例）
- `node scripts/release-check.mjs` → 无阻塞项；`python scripts/check.py` → 14 项（通过 11 / 提醒 3 / 失败 0）
- `npm run build:web` 成功；隔离 profile 真实启动逐项验证：
  卡内插件页签（`BeiPaiDaoMu` 2 条脚本 / `Kora` 旧版结构 / 双臀洗浴空容器可新建）、
  测卡面板启动、卡片 8 个页签、全屏放大 + 改名写回 —— 均正常，无 `[Vue 错误]`、`crash.log` 无新增，真实卡库零文件被改写

---

> **v2.2.11 专项（2026-09-19）**：测卡记忆 v4.1 桌面移植（对齐移动版 v1.10.26 两轮评审定案）
> + CT-17/CT-18 逐条删除入口补齐。规格：`docs/规格与计划/桌面版测卡记忆v4.1-实现规格.md`。

---

## 🚀 v2.2.11 测卡记忆 v4.1 + 逐条删除

### 🧠 记忆引擎 v4.1（对齐移动版 v4.1 评审定案，D1/D2/D3/D4/I2/I4/I5/R1/R2）
- **D1 卡级分桶**：`main/memoryStore.js` 数据形态 `v:1 → v:2`，条目新增
  `cardPath / confirmed / updatedAt`；`list/search` 支持 `cardName`（携带 cardPath）强制按卡过滤
  —— **换卡 = 换记忆**，修掉「重名卡串记忆、改名后记忆丢失」的结构性缺陷。读入旧文件自动回填默认字段（遗留桶），首次落盘即 v2
- **D4 同 key 覆盖**：fact 同 `(key, cardPath)` → UPDATE content（保留首次 `ts`、刷新
  `updatedAt`），不再无限累积重复事实；单卡 fact 上限 50，超出按 `updatedAt ASC` 删最旧（移动版 §7.1 定案：保护被频繁覆盖的新值）
- **D2 检索治理**：停用词表 + 有效词 <2 → 降级「本卡最近 N 条（updatedAt DESC）」；排序基准从
  `ts` 改 `updatedAt`（覆盖后不回退旧序）
- **D3 事实规则收紧**：新文件 `js/composables/chat/memoryRules.js`（纯函数单一事实源）——
  排除疑问句/否定假设/引用；空泛键跳过（「我的想法是…/我在思考…」不再产生垃圾 fact）；
  值截断 30/80（显式指示词 80）；位置规则排除认知活动动词
- **I2/I4/I5 注入治理**：条数（默认 20→8）+ token 预算（默认 200 / 硬上限 400）双约束逐步收窄；
  注入格式默认 XML（`<memory><user_profile>…`，含转义，截断先于转义），可切回 markdown 表格；
  `buildMemoryContext` 返回 `{ text, meta }`（meta = 注入条数/卡路径/是否降级/估算 token，灰度关时 null）
- **R1/R2 记录准确度**：user 记**原始输入**（宏/正则改写前的 text，不再被 processedText 污染）；
  assistant 记录返回 id 存 `lastAssistantMemId`，**翻页时 updateMemory 回写实际选中候选**
  （update 而非 remove+add，防重复；仅最后一条 assistant 生效）
- **D1a 路径钩子**：`useCardGroups` 重命名分组（目录前缀）/移动单卡两处接 `migrateMemoryCard`
  （冲突规则：目标优先删源，移动版 §7.2 定案）；`useCardCrud` 删卡两处接 `clearMemoryByCard`
- **一次性迁移**：启动索引建完后跑 `migrateMemoryToV2`（显示名唯一匹配 → 绑定 path；
  同名多卡/无匹配 → 遗留桶不丢数据；幂等可重跑；`memoryV2Migrated` 会话闸门）
- **新 IPC 4 条**：`memory:confirm / memory:migrateData / memory:migrateCard / memory:clearByCard`（preload + chatBridge 桩同步）

### 🗑 CT-17 ｜ 记忆「无法删除」—— 逐条删除入口根本不存在
- **排查结论**：`memory:remove` IPC 链路一直是通的且有单测；坏在 UI —— `removeMemory()`
  自 v2.2.7 落地以来**从未被任何组件调用**，用户看到的「记忆表」只在发给 AI 的提示词文本里
- **修复**：侧栏「设置」分区新增**记忆查看器**：列表（键：值/摘要/消息）+ 每行 🗑 逐条删除
  （删后统计与列表同步刷新）；「只看本卡 / 全部」切换（card 模式按 cardPath 过滤）；
  遗留桶提示（`stats().orphans` > 0 时显示「N 条未归属任何卡的旧记忆」）

### 🗑 CT-18 ｜ 测卡聊天记录无法逐条删除
- **修复**：引擎新增 `deleteMessage(i)`（splice 后立即落盘；assistant 多候选整条删；
  删空重载开场白）；每条消息气泡下加 🗑 按钮（发送中禁用），模板经本地包装函数转发
  （规避 CT-14/15 同源的 `ctx.*` 模板坑）；ctx 两处暴露 `chatDeleteMessage`
- **「重新生成」说明**：assistant 已具备候选级重生成（＋追加 / ↻ 整组重写 / ↳续写），未重复添加

### 🔬 验证
- `npm test` **267/267**（基线 259 + memoryStore 新增 8 例：v2 回填 / D4 覆盖保留 ts / 卡隔离 /
  单卡上限按 updatedAt 删 / migrateData 幂等与遗留桶 / migrateCard 四况 / clearByCard / confirm）
- `npm run build:web` 通过；`get_errors` 12 文件无错
- **生产构建热测试**（隔离 profile + CDP）：记忆 IPC 全链路 8 步全绿
  （add → 按卡 list → stats(orphans) → remove → 复查 → D1 同 key 异卡互不覆盖 → D4 覆盖 →
  migrateCard 跟随 → clearByCard 清理）；应用挂载正常、渲染层错误 0、`crash.log` 无新增
- D3 规则 Node 直测：误吞反例（「我在思考…」「我的想法是…」）返回空；正常提取（我叫/今年）命中；疑问/假设排除
- 测试坑：旧「去重合并」用例用 fact+同 key 造数据，D4 语义下会走覆盖 → 改用 message 类型；
  migrateData 用例同 key 两条也会被 D4 合并 → 用不同 key 造

### 🧾 本次版本动作
- `package.json` / `package-lock.json`：`2.2.10` → `2.2.11`
- 文档三件套 + `docs/bugs/`（CT-17/18）+ 规格（`桌面版测卡记忆v4.1-实现规格.md`）
- 新增热测试脚本 `scripts/_heat-v41.mjs` / `_heat-v41-ui.mjs`

---

> **v2.2.10 专项（2026-09-14）**：把 v2.2.9 修订版的全部内容（PK-17 / CT-16 / 界面瘦身）**换成新版本号重新发布**。
> 原因：v2.2.9 已于同日对外发布且标为 Latest，而 OTA **按版本号比较** —— 已装旧 2.2.9 的客户端
> 对同号重发不会收到更新提示（只能手动重装）。开 2.2.10 可让这批用户走正常 OTA 通道。
> 代码内容与 v2.2.9 修订版（提交 `2140248`）**完全一致**，仅版本号与文档版本段不同。

---

## 🚀 v2.2.10 重发（覆盖已装 2.2.9 的用户）

### 📦 内容（与 v2.2.9 修订版逐字相同，详见下方「v2.2.9（二）」）
- **PK-17**：瘦身卡 PNG 正文回读真正生效（未知 `size` 分支取 `FileHandle.read` 的 `.bytesRead`，不再抛错被吞）
- **CT-16**：卡内面板反引号残留（围栏白名单补 `!doctype`）
- **UI**：设置菜单收拢为 4 行 + 三个二级子菜单；侧边栏四入口改不等宽双列 + 计数徽标（`≥1万` 显示 `x.x万`）+ 容器查询窄宽度降级

### 🧾 本次版本动作
- `package.json` / `package-lock.json`：`2.2.9` → `2.2.10`
- `README.md`：下载链接与产物名同步为 `2.2.10`
- `RELEASE_NOTES.md`：新增 v2.2.10 对外段（内容与 v2.2.9 修订版一致，按「新版本首次发布」措辞重写）
- 标签：新增 `v2.2.10`；`v2.2.9` 标签保留指向修订提交 `2140248`（不动历史）

### ⚠️ 教训（写在这里防重犯）
- **同号重发只能靠手动重装触达已装用户**；要让 OTA 覆盖全部用户，必须升版本号 ——
  这与 [`docs/发布/一条龙-发布流程.md`](docs/发布/一条龙-发布流程.md) §8「发布后回滚/修正要开新版本」一致。
- 同号重发时标签必须 **强推** 到新提交（`git tag -f` + `git push -f <tag>`），否则 tag 与 Release 内容脱节。

---

> **v2.2.9 专项（2026-09-14）**：大库「切后台打不开卡 + 连点卡卡顿」三连修复（PK-14/15/16）。
> 用户在 1 万卡库（11,188 张）实测复现：隐藏窗口再恢复后点击 PNG 角色卡弹「读取卡片正文失败」；
> 修好后又暴露连点角色卡的持续卡顿与启动期双轮索引重建。
> 缺陷与根因清单见 `docs/bugs/BUG-性能与大库.md`（PK-14 ~ PK-16）。
>
> **v2.2.9 二次修订（同日）**：用户复测发现上一轮补丁**未真正生效**（PK-17：`FileHandle.read` 返回对象被当数字比较，抛错被 catch 吞掉 → 仍恒返 null），
> 连同上轮遗留的测卡面板反引号残留（CT-16）与两处界面拥挤（设置菜单过长 / 侧边栏四入口被裁）一并处理，同号重发。
> 缺陷清单追加 PK-17、CT-16。

---

## 🚀 v2.2.9（一）大库瘦身回读与响应式触发链三修

> 背景：PK-14 修复后用户复测（11,188 张卡 / 加载约 20~30s）确认「切后台打不开卡」已消失，
> 但连点几张卡出现明显卡顿；启动日志又暴露瘦身后第二轮全库索引重建。三个缺陷同属一条
> 「shallowRef + triggerRef → 全库重建」响应式触发链，逐一除根。

### 🔴 修复 1（PK-14）：瘦身卡 PNG 正文回读 100% 失败 → 切后台后点卡弹「读取卡片正文失败」
- **根因**：回读路径写死 `size: 0`，主进程 `readPngEmbeddedFromFile` 首行 `!size → return null`。
  触发时机：窗口隐藏期间索引建完（yieldToMain 后台调度修复的受益）→ 瘦身执行 →
  切回后点卡即走坏路径。修复前隐藏时构建停摆、卡未瘦身，所以「切换前能用、切换后不能用」。
- **修复**：主进程支持未知 size（1MB→8MB 窗口渐扩 + `stat` 全读兜底）；渲染层传真实
  `item._size/_mtime` 并以 `readBuffer` + 前端解析兜底；`cardSlim` loader 契约改传 `(path, item)`。
- **验证**：`npm test` 257 全绿（新增 loader 契约回归）；`build:web` 通过；用户 1 万卡实测通过。

### 🔴 修复 2（PK-15）：瘦身卡每次打开触发「全库重建 + 预热 + 再瘦身」→ 连点卡明显卡顿
- **根因**：`openFromLibrary` 还原成功后 `triggerRef(library)`；library 是 shallowRef，
  Vue watch 对其 forceTrigger（`forceTrigger = isShallow(source)`），任何 trigger 都拉动
  `rebuildSearchIndex`（10k 卡全量分词）+ `tokenCache.warmupAsync` + `slimLibraryIfNeeded`。
  连点时 `indexBuilding/indexDirty` 把「每点一次」串成「一次接一次的全量重建」。
- **修复**：删除该触发（还原不改任何列表可见字段）；`normalizeCardData` 改 noClone，
  省每次开卡一次全卡 `structuredClone`。
- **验证**：单测/构建全绿；待用户复测连点无卡顿（已按预期修复）。

### 🔴 修复 3（PK-16）：瘦身完成后的 triggerRef 引发第二轮全量重建 → 启动双倍负载 + 世界书搜索降级
- **根因**：`slimLibraryIfNeeded` 压缩成功后 `triggerRef(library)` → 立刻第二轮全库重建，
  且发生在全库已瘦身之后 → 世界书词条正文（content 已清空）索引不到，把压缩前建好的
  完整索引覆盖成降级版（世界书关键词搜索静默失效）；启动多付一整轮重建+预热。
- **修复**：删除 slim 成功分支的触发；附带修复全局资产库面板关闭路径的同病。
- **遗留**：全局资产库面板**打开**时的进度触发仍会戳 library（边还原边出现依赖它），
  一次打开仍伴随 1~2 轮全量重建（索引终态完整、无降级，纯 CPU 浪费），后续可把面板
  数据源换成独立 tick ref 消除。
- **验证**：单测/构建全绿；待复测启动日志只剩一轮构建+预热、世界书正文关键词可搜中。

---

## 🚀 v2.2.9（二）瘦身回读补丁（PK-17）+ 测卡渲染补丁（CT-16）+ 界面瘦身

> 背景：v2.2.9（一）发出后用户复测，**「切后台点卡打不开」仍能复现**；同时测卡面板出现反引号残留、
> 设置菜单拉得过长、侧边栏四个入口被裁。四项一并处理，同号重发（覆盖安装包与 Release 资产）。

### 🔴 修复 4（PK-17）：PK-14 的「未知 size 分支」其实恒返 null —— 上一轮补丁根本没生效
- **现象**：v2.2.9（一）后仍复现「切后台 → 点 PNG 卡 → 弹读取卡片正文失败」（JSON 卡不受影响）。
- **根因**：`main.js readPngEmbeddedFromFile` 新增的未知-size 分支里，`fs.promises.FileHandle.read`
  返回的是 `{ bytesRead, buffer }` **对象**，代码却直接拿它参与 `n < win` 比较 →
  抛 `TypeError: Cannot convert object to primitive value`，又被外层 `try/catch` 静默吞掉 →
  该分支**恒返 null**，行为与修复前完全一致（PK-14 的判据只看了「有没有加分支」，没看分支是否真的跑通）。
- **证据**：复刻脚本在真实卡上稳定抛同一条 TypeError；探针实测 4/4 张卡 `size=0` 读不到、
  同一批卡给真实 size 全成功；修复后 5/5 张卡 `size=0` 与真实 size **均可读回**。
- **修复**：`const n = (readRes && typeof readRes === 'object') ? Number(readRes.bytesRead) : Number(readRes)`；
  `n < win` 时只解析 `head.subarray(0, n)`，且**短文件直接 `return null`**（不足一个窗口不可能含完整块）。
- **验证**：`npm test` 259 全绿；真实大库 5/5 张卡可正常打开。

### 🔴 修复 5（CT-16）：卡内面板顶部/底部各露出一行「```」
- **现象**：部分卡（如「魔法少女是不会败北恶堕的吧！」）在聊天测试里，面板最上、最下各有一行反引号。
- **根因**：卡片 `first_mes` 把**完整 HTML 文档**用代码围栏包起来（` ``` <!DOCTYPE html> … </html> ``` `），
  而 `fenceLooksLikeHtml()` 的白名单只认 `<html|<head|<body|<style|<script|<div|<table|<section …`，
  **不认 `<!DOCTYPE html>`** → 围栏未被识别成「代码块包裹」，文本段原样保留围栏与文档；
  随后 `promoteHtmlSegments` 又把整段（含围栏）升级为 iframe → 反引号跟着进面板。
- **修复**：白名单补 `!doctype\s+html`（`/^<(!doctype\s+html|html|head|body|style|script|div|table|section)[\s>]/i`）。
- **验证**：`test/chatRender.test.mjs` 新增 2 条（CRLF / LF 两种换行的裸围栏完整文档）；
  真实卡实测 `tickCount: 0`（界面段 14,936 字符、高度 1,590px、页面错误 0）。

### 🎨 界面瘦身（UI）：设置菜单收拢 + 侧边栏四入口防挤压
- **设置菜单**：原扁平长菜单（约 10 段）改为 4 行 + 三个二级飞出子菜单
  （🎨 外观与字号 / 🧹 标签与导入 / 📸 历史快照），主菜单高度降到 192px；
  子菜单 `left-full` 向右展开（实测主菜单 474→674px，子菜单 674px 起、宽 280~300px，1,266px 窗口内不溢出）。
- **侧边栏模式标签页**：四个等宽按钮（220px 侧边栏时每个约 50px，「预设 (0」「插件 (0」被裁）→
  `grid-cols-[1.3fr_1fr]` **不等宽双列** + 右侧计数徽标；计数 ≥ 1 万显示为 `x.x万`（1.1 万卡库不必再塞 5 位数字）；
  再用容器查询按实测阈值逐级降级：容器**内容盒** ≤ 251px 收起 emoji、≤ 214px 再收起计数。
  ⚠ 容器查询量的是**内容盒**（不含本行 `px-3` 的 24px 内边距），阈值换算别按外框宽写。
- **实测抗挤压**：220 / 240 / 260 / 300 / 520px 五档 + 模拟 5 位与「万」级计数，标签均**不截断**；
  `get_errors` 无错、`build:web` 通过、真实启动无 `[Vue 错误]`。

---

> **v2.2.7 专项（2026-09-13）**：大库（万卡 / 10GB 级）稳定性 + 加载性能 —— 修复 9 项缺陷（含用户反馈的
> 重复卡、刷新丢库、添加正则需切选项卡、删除无提示），加载从 36.9~85.3s 降到 16~31s（同机波动）。
> 汇总技术数据（加载分项、堆构成审计、缓存 A/B、容量边界）见 `docs/技术支持/技术数据-大库压测与性能.md`；
> 缺陷与根因清单见 `docs/bugs/BUG-性能与大库.md`。

---

## 🚀 v2.2.7（一）大库「重复卡 / 刷新 OOM」修复

> 背景：用户反馈「刷新或搜索时一个角色卡重复出现，搜索后再刷新更容易出现」。
> 在 11,186 卡 / 9.76GB 真实大库（`I:\03\角色色卡`）上复现、定位并修复 4 个缺陷。

### 🔴 修复 1：搜索时同一张卡出现两次（索引并发重叠重建）
- **根因**：`js/utils/searchIndex.js` 的 `build/buildAsync` 只在自己开头 `clear()`，既无代次保护也无「同对象只索引一次」的保证。刷新期间 `watch(library)` 会被反复触发（数组引用替换 + 每张新解析卡 `triggerRef`），多个 11k 全量重建循环重叠运行：
  - 刷新前的**旧卡对象**在新构建 `clear()` 之后又被写回倒排表 → 同一 path 命中两次；
  - 同一对象被两个循环各 push 一次 → 同一倒排桶出现重复条目。
- **只有「精确 token」分支会原样返回倒排桶** → **中文单字搜索最容易看到重复卡**（英文多词查询走 `_getMatches` 兜底分支，自带身份去重，反而不易复现）。
- **修复**：`generation` 代次号（新构建开始时在途构建自检退出）+ `_indexCard` 幂等（命中 `cards` 直接 return）+ `search()` 结果 `[...new Set(results)]`；`App.vue` 侧用 `indexBuilding/indexDirty` **合并重建**（在途时只记一次补建，绝不重叠）。
- **实测**：80 次库变动只真跑 4 次重建（修复前是 80 次重叠全量重建），3 次完成。

### 🔴 修复 2：扫描异常返回空结果 → 整个大库从界面消失
- **根因**：主进程 `scanAndSaveFolder` 的 catch 分支返回 `{folderPath:null, files:[], error}`，渲染层旧写法 `if (result && result.files)` 把**空数组当真值** → `library.value = next(=[])`，一整个大库瞬间从列表消失（磁盘文件未动，但用户看到「卡全没了」，且要再刷一次才恢复）。这条也解释了历史上「刷新中途侧栏显示 478 张」这类不完整计数。
- **修复**：`useDiskScan.refreshLibraryInner` 先判 `result.error` 提前返回；库非空时**拒绝接受 0 文件扫描结果**并给出提示，不再据此清空列表。

### 🔴 修复 3：刷新/搜索时渲染进程 OOM 崩溃（索引常驻全卡全文）
- **根因**：索引为每张卡常驻一份小写全文（11,186 卡合计 ≈531MB 字符，中文按 UTF-16 计更高）。加载完成后堆就已达 **3.0GB / 上限 4.19GB**；刷新时索引重建再分配一份，再叠加「清库/重扫/崩溃兜底自动 reload」的并发重入 → `crash.log` 记录 `render-process-gone {reason:"oom", exitCode:-536870904}` 与 `{reason:"crashed", exitCode:-36861}`。
- **修复**：索引**不再保留文本**（构建时记下 `extractText`，`remove`/排除词按需复算），单卡索引文本上限 `MAX_INDEX_TEXT = 200000` 字符（防 16MB 巨卡撑爆倒排表）；索引重建合并为「在途只记一次补建」。实测堆峰值 2013MB（修复前加载完即 3039MB），连点 6 次刷新后堆仍 1893MB。

### 🟡 修复 4：索引构建长时间零进展
- **根因**：分片让步只挂 `requestIdleCallback(resume, {timeout:50})`，页面繁忙时几乎不回调 —— 实测启动后 5 分钟 `cardCount` 仍为 0（同参数手工全库构建仅 35s）。
- **修复**：idle 与 `setTimeout(60ms)` **竞速**，最多 60ms 必定推进下一片。

### 🔬 验证
- `npm test` → **177 / 177 通过**（新增 `test/searchIndex.test.mjs` 6 项：重叠重建去重、旧对象残留、内容完整性、重复 add 幂等、结果唯一化、idle 不回调仍能推进；修复前 3 红）。
- `npm run build:web` → 构建成功。
- 大库端到端（`scripts/library-dup-search-refresh.mjs`）：**A~F 全阶段库层与列表层 `dupPaths = 0`**，连点刷新 6 次后库仍稳定 11,186 张（修复前会变 0），全程无崩溃。

---

## 🚀 v2.2.7（二）库加载提速 + 正则/状态栏交互修复

### 🟡 修复 5：库加载变慢（每次启动重写数千张 PNG 的死循环）
- **根因**：写盘判定看的是「**清洗后**的内存状态」而不是「磁盘上原有的标签」。开着「🧹 导入时忽略卡片自带标签」时，每次加载都会把原生 tags 清空 → 永远判定「需要落盘」→ 把 `customTags` 写回 PNG；**下次启动这些 tags 又成了原生标签被清掉** → 无限重写。
- **实测代价**：11,186 卡库**每次启动重写 3,415 张 PNG**（含快照备份），且 mtime 全变 → 下次「刷新」又把这批卡全量重解析，磁盘与主线程双重浪费。
- **修复**（`useCardCrud.parseAndAddCard`）：改为基于**磁盘原有标签**判定 —— 仅当「盘上存在不该保留的标签」或「确有新标签要补」才写盘；忽略开关开启时盘上只保留 `customTags`（幂等，写一次后永不再写）。
- **实测**：首次启动重写 3,415 → **971 张**（真正残留外来标签的卡，一次性清洗）；**第二次启动 0 张**；大库加载 **79.9s → 41~43s**（fetch 9.3→6.9s、worker 18.3→7.2s、assemble 58.3→31s）。

### 🟡 修复 6：正则/状态栏脚本「添加后必须切 Tab 才看到」「删除没有任何提示」
- **根因**：`addRegexScript` / `deleteRegexScript` 原地改 `extensions.regex_scripts` 数组却**没有 `triggerRef(cardData)`**（同文件的 `syncRegexScriptField`、批量克隆/删除都有这个调用）→ `cardData` 是 `shallowRef`，深层变更不触发视图 → 列表不刷新，切 Tab 时子树重挂载才显示；删除既无二次确认、也无操作日志，点了像没反应。
- **修复**：两处补 `refreshCardData()` + 操作日志；删除改为 `confirmDialog`（原生「确认操作」对话框，文案点明脚本名、是否状态栏模板、需保存卡片才写回文件）+ 删除后立即刷新列表。
- **实测**（dev + CDP，`scripts/_probe-regex-ui.mjs`，21 条脚本的卡）：点 ➕ 后**未切任何 Tab** 列表立即 21 → 22；点 🗑️ 弹出原生确认框 → **取消**不删（仍 22）→ **确定**立即删除并刷新（21）。

### 🔬 验证
- `npm test` → 177 / 177 通过；`npm run build:web` → 构建成功。
- 大库（11,186 卡 / 9.76GB）连点刷新 ×6 后库仍稳定 11,186 张、无重复、无崩溃。

---

## 🚀 v2.2.7（三）库加载二轮提速 + PNG 内嵌缓存移除 + 正则「首条新增」漏刷新

> 承接上一节，把「已知但未做」的三项性能优化做完；复测中又发现两个真问题：
> 内嵌缓存其实是**负优化**（已移除），以及上一节的正则刷新修复**只覆盖了「卡上已有脚本数组」**的分支。

### 🚀 优化 1（P0）：去掉 PNG 卡的「无谓文本搬运」
- `parseChunkInWorker` 只送**需要 `JSON.parse` 的纯文本卡**（`.json` 卡）进 Worker；PNG 卡的 `embeddedData` 已是主进程解析好的对象，不再多走两趟 structured clone（万卡库 ≈1.2GB 级搬运）。
- 实测（`I:\03\角色色卡`，11,186 卡 / 9.76GB，dev）：Worker 阶段 6.9s → **1.5~2.0s**，assemble 31s → **9.9~11.0s**。

### 🚀 优化 2（P1）：索引 / Token 预热不再「后台永不完成」
- 让步调度统一为 `yieldToMain()`（`js/utils/searchIndex.js` 导出）：**前台**优先 `requestIdleCallback`（不抢首屏渲染），**后台/窗口隐藏**改走不受 Chromium 后台节流影响的 `MessageChannel.postMessage`（并有定时器兜底，任何宿主都不会等死）。
  - 原 `buildAsync` 是 idle + `setTimeout` 竞速：隐藏时 idle 永不回调、`setTimeout` 被节流到 ≥1s（后台 5 分钟后更慢）→ 224 个分片要跑几十分钟；
  - `tokenCache.warmupAsync` 更极端：**纯** `requestIdleCallback`，隐藏时永不回调。
- 启动闸门改用保证返回的 `waitForIdle()`：旧写法单独 `await requestIdleCallback(cb, {timeout})` 在隐藏时**连 timeout 都不兑现** → 实测渲染进程 3 分钟仍未开始建索引（搜索恒返回 0 条）。
- 实测：11,186 卡索引（349,552 词）+ Token 预热（11,186 次计算 / 1.45s）在隐藏窗口下也能正常建完；搜索索引双缓冲保证构建期间查询走上一代完整索引。

### 🗑️ 优化 3（P2）：**移除** v2.3 PNG 内嵌提取缓存（实测为负优化）
- 同机交替 A/B（每次重启、同一大库、同一链路）：

| 方案 | fetch | worker | assemble | 合计 | 缓存占盘 |
|---|---|---|---|---|---|
| **无缓存** | 2.7~3.1s | 1.5~1.9s | 9.9~10.5s | **16.0~17.0s** ← 最快 | 0 |
| v1 `.json` 分片 | 9.3s | 2.0s | 11.0s | 36.9~43.3s | 1.17GB |
| v2 `.json.gz` 分片 | 29.1s | 1.6s | 52.8s | **85.3s** | 385MB |
| v8 二进制分片（过渡试验） | 62.5s | — | — | **137s** | 385MB |

- **结论**：从 PNG 头部提取内嵌 JSON 本身只要 ~3s（128 路并发、按需流式、边到边组装，GC 可回收）；而缓存把 1.2GB 对象一次性常驻主进程 → 堆压力/GC 抖动 + 额外 IPC 克隆，反而慢 2~5 倍。
  （v8 二进制更慢的机理：`v8.deserialize` 产出 dictionary-mode 对象，跨 IPC structured clone 与后续属性访问都显著变慢 —— JSON.parse 反而是快路径。）
- 已整体移除（**-173 行**）；新增 `cleanupLegacyEmbedCache()`：老用户磁盘上的 `embed_cache_*` 自动回收（本机一次性清掉 **44 个文件 / 758MB**），标记文件保证只扫一次目录。
- 载入期「非角色卡文件」日志降噪：同因同类只打 1 条 + 总量封顶 40 条 + 收尾一行汇总（实测 385 条刷屏 → 1 行汇总 + ≤40 条代表样本）。

### 🔴 修复：给「原本没有正则脚本」的卡新增第一条时列表不刷新（即用户反馈的「必须切选项卡才看到效果」）
- **根因**：`regexScripts` 是 `computed(safeData → cardData)`。**Vue 3.4+ 的 computed 在「新值 === 旧值」时不再向下传播** —— `safeData` 重算后返回同一个对象，依赖它的 `regexScripts` 不会被标脏：
  - 卡上**已有** `extensions.regex_scripts`：`ensureRegexScriptsArray()` 原地 `push`，而 computed 缓存的就是同一个数组对象 → `.length` 天然变化 → 侥幸正常（上一节 21→22 能通过就是这个分支）；
  - 卡上**没有**该字段：新增会**整体替换数组** → computed 缓存的旧空数组永不失效 → 面板停在「0 条脚本」，必须切 Tab（子树重挂载）才看得到。
- **修复**：新增 `cardContentVersion`（`refreshCardData()` 时自增），`regexScripts` 取值前先读它 → 数组被整体替换也能正确重算。
- **验证**（dev + CDP，Win32 消息应答原生弹窗；卡「斗罗大陆」，原本 0 条脚本）：

| 步骤 | 结果 |
|---|---|
| 点「+ 立即新增一条正则脚本」（**不切任何 Tab**） | 徽标 **0→1 条**、DOM 行数 **0→1** ✅（修复前停在 0/0） |
| 点「🗑️ 删除」 | 枚举到原生 `#32770 \| 确认操作` 窗口 ✅ |
| 发送 `WM_COMMAND/IDOK` 确定 | 行数 **1→0**、徽标 0 ✅（无需切 Tab） |

### 🔬 验证
- `npm test` → **178 / 178** 通过（5.2s，进程正常退出）；`npm run build:web` → `built in 2.07s`。
- 大库加载 **16.0s**（修复前 36.9~85.3s 取决于缓存形态），11,186 张全部到位、跳过文件汇总正确。
- `scripts/library-dup-search-refresh.mjs`：全程 `dup(lib)=0 / dup(list)=0`，库稳定 11,186 张，连点刷新 ×6 无崩溃（堆峰值 3.3GB）。

---

## 🚀 v2.2.7（四）测卡工作区补齐长期记忆通道（2026-09-13 晚）

移动版长期记忆走 Android 原生 SQLite，桌面版过去只有失败桩（开关能存、检索恒为空，UI 明确标注「二期补」）。本次按同套契约补齐：

- 新增 `main/memoryStore.js`（可单测的存储层）+ `memory:*` 七个 IPC + `userData/memory_store.json`（原子写 + 写入串行化）
- `preload` 暴露 6 个方法；侧栏「设置」分区新增记忆库面板（总条数与事实/摘要/消息分类、刷新、**两段式二次确认清空**），移除「暂不可用」占位提示
- 语义与移动版对齐：同 `(type/key/content/cardName)` **去重合并**、每类保留最新 500 条、content 4KB 上限；
  检索为中文 2-gram + 英文词切分，按「命中率 × 类型权重（fact > summary > message）+ 时间新鲜度」排序
- `ChatTestSidebar` 三处未定义的 `chatMvuEnabled/chatEjsEnabled/chatSegRenderEnabled` 死 prop 与其绑定已清理
  （每次渲染刷 3 条 Vue 告警 → 实测告警数 0）
- 两个端到端脚本的卡片选择兼容「库里没有带世界书徽标的卡」的场景（不再卡在 `no-card-row`）

**验证**：`npm test` **187/187**（新增 `test/memoryStore.test.mjs` 9 例）；侧栏端到端新增断言 H（记忆往返 +
去重合并 + 清理干净）；引擎端到端新增断言：写入事实后 `buildMemoryContext()` 产出含「记忆表格」的 system 片段，删除后即消失。

> 同时整理了文档：新增 [`docs/README.md`](docs/README.md) 索引，移动版侧栏参考稿归位 `docs/reference/`。

---

## 🚀 v2.2.7（五）大库容量专项（P1a 正文懒加载 + P2 索引跨代沿用 + 内存守门员）

> 本节为**内部文档**（含文件路径/堆数字/踩坑）；用户可见版本请见 `RELEASE_NOTES.md`。

### 🔴 先否证一条错误结论：渲染进程堆上限抬不上去
- 实测（22,372 卡）：`app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144')`
  与 `webPreferences.additionalArguments` **两条路均无效** —— `window.gc` 确实出现（`--expose-gc` 生效），
  但堆到 ~3.3GB 仍 `render-process-gone {reason:"oom"}`，且 `performance.memory.jsHeapSizeLimit` 恒为 4192MB。
- 处理：撤销 `additionalArguments`（注释写明「勿重试」）；`memoryGuard` 回退为按**上报值**判定
  （`assumedLimitMB` 仅保留为逃生口）；⇒ **真降内存只能靠减少常驻数据**。
- 顺手修复：内存守门员过去从未真正上场（现 22k 高压下实测 `warns=1 gcCalls=1 releases=1`）。

### 🪶 P1a：世界书正文懒加载（`js/utils/cardSlim.js`，新增）
- 只丢两类（占全部文本 **88%**）：**世界书词条 `content`（1,163MB）+ `alternate_greetings`（120MB）**；
  **保留** `description`/`first_mes`/`tags`/`extensions` —— 它们被 AI 打标、查重差异比对、Token 估算使用，
  砍了会让这些功能静默变差（故「整块正文都砍」的方案被否）。
- **原地压缩**（不替换 `item.data`）：全项目 ~40 处 `library.find(i => i.data === cardData.value)` 依赖对象身份。
- **顺序不能反**：只在「索引建完 + token 预热完」之后压缩（`slimLibraryIfNeeded('index-built')`）；
  刷新时未变动卡靠 P2 的 token 沿用重建索引，所以压缩不会让搜索失效。
- 打开卡片：`openFromLibrary` 改 async + `ensureCardFull`（按 path 用 `readEmbeddedBatch`/`readText` 读回），
  **读失败即拒绝打开**（否则编辑器空字段一保存就把卡写空），带连点令牌防竞态。
- 词条正文是「清空」而非删除 → 还原时按 `comment/name` 配对填回（回退同下标）。
- 列表脏标/描述改读小字段（`_hasBook`/`_descShort`），排序用固化 `_tokens`。
- 全局资产库（唯一需全库正文的面板）→ 打开时后台逐批还原、**关闭时重新压缩**。
- 阈值 `SLIM_MIN_LIBRARY = 3000`（小库不折腾）。

### 🔁 P2：索引跨代沿用（P1 的前置）
- `searchIndex` 新增 `carry`（`key = path|mtime|size` → 该卡 token 列表，token 复用索引 Map 的 key 对象，
  字符串共享，22k 卡约 +70MB）；`buildAsync(..., { reuse: true })` 时未变动卡**不读正文、不重新分词**。
- 为何必须先做：索引构建依赖全库正文；P1 砍掉正文后，刷新时复用卡就没正文可借，
  全量重建会让这些卡**一条都进不去索引**（刷新即搜索失效）。
- `remove(card)` 也改为优先用 `carry` 里的 token → 不再需要正文。
- `_tokenize` 改 `charCodeAt` 区间比较：旧实现逐字符跑两次正则，22k 卡（待索引文本 ≈1.16GB）
  导致「构建 10 分钟未完」；新实现同语义、快一个量级。

### 💬 修复：测卡键随物理路径迁移
- 测卡会话/变量树的键里嵌了**卡片完整路径** → 移动分组/重命名分组/换卡图后成孤儿，
  用户看到「会话与变量树凭空消失」（同类缺陷 2026-09-01 在覆盖层上踩过）。
- 新增 `migrateChatKeys` 并挂到 3 处路径变化点（`moveCardToGroup` / `renameCurrentCategory` / `replaceCardImage`）。

### 🧰 压测工具链（新增）
- `scripts/capacity-check.ps1`：造副本 → 隔离 profile → 启动 → 采样 → 刷新压测 → 汇总 → 清理；
  支持 `-ReplicaDir`（复用副本，免 20GB 复制）/`-Hold`（保留现场供后续探针）/`-Keep`。
- 探针：`_cdp-mem.mjs`（堆/索引/守门员，`--refresh`/`--gc`）、`_heap-audit.mjs`（堆构成按字段拆）、
  `_cdp-text.mjs`（应用自身进度/压缩状态）。
- 踩坑：轮询期强制 GC 会把 22k 首启拖到 >215s；副本泄露会被当源库复制成 44k 卡；
  PowerShell 里 `$Replica` 与内部 `$replica` 同名被覆盖；CDP 取值是**双重 JSON 编码**（要 parse 两次）。

### 🔬 验证（22,372 卡 / 同副本 / 隔离 profile）

| 指标 | 前 | 后 |
|---|---|---|
| 世界书词条正文 | 1,163 MB | **0 MB** |
| alternate_greetings | 120 MB | **0 MB** |
| 纯文本合计 | 1,459 MB | **176 MB（-88%）** |
| 堆（GC 后） | 2,891 MB | **2,053 MB** |
| 加载 | 232s（含 OOM 重载） | **72s** |
| 索引 | 建 10 分钟未完 | 22,372 卡 / 349,648 token ✅ |
| **渲染进程 OOM** | 同位置崩 2 次 | **crash.log 无记录** |
| 内存守门员 | 从未触发 | `warns=1 gcCalls=1 releases=1` |

- `npm test` **214/214**（新增 `test/cardSlim.test.mjs` 8 例、`test/searchIndexReuse.test.mjs` 7 例、
  `test/chatKeyMigration.test.mjs` 4 例、`test/memoryGuard.test.mjs` 8 例）；`npm run build:web` ✅。
- 日志实证：`[slim] 已压缩 19114 张卡的正文（index-built）`；刷新触发第二次扫描（13.6s）在 3.5GB 堆上完成重建未崩。
- 完整数据：`docs/技术支持/技术数据-大库压测与性能.md`（含 22k 库前后对比、缓存 A/B、内存审计口径）。

---

## 🚀 v2.2.7（六）补丁：测卡区状态栏渲染 + 翻页 + 卡文件字段净化（2026-09-14）

> 版本号不变（补丁），对外文案见 `RELEASE_NOTES.md` v2.2.7 补丁段；本节为内部细节。
> 缺陷条目：[DF-14/DF-15](docs/bugs/BUG-数据与文件.md)、[AR-30](docs/bugs/BUG-架构与渲染.md)、
> [PK-13](docs/bugs/BUG-性能与大库.md)、[CT-13/CT-14/CT-15](docs/bugs/BUG-测卡工作区.md)。

### 🔴 1. 打开某些卡直接卡死（正则灾难性回溯，PK-13）
- **现象**（用户报告）：「读取某张卡卡死软件」→ 打开 `鬼 1.2版.png` 主线程阻塞 **43.9~71.9s**。
- **根因**：卡内状态栏脚本用 `replaceString` 把 738 字符的开场白放大成 **137,469 字符**，再把这份
  137KB 文本丢给预设里的正则；这些正则存在**灾难性回溯** → 单条正则跑几十秒。
- **修复**（`js/composables/chat/useChatRegex.js`）：① 正则**编译缓存**（上限 500，避免每条消息重编译）；
  ② **大替换延迟物化**：`replacement` ≥ 8192 字符时先埋 token，全部脚本跑完后一次性 `split/join` 替换；
  ③ **预算**：单脚本 120ms / 整体 1500ms，超时记录跳过并 `console.warn`（`opts.onSkip`）；④ 缓存实例每次
  `lastIndex = 0` 复位。
- **实测**：dev 首开 43.9s → **热开 20ms**；生产同一张卡主线程最长阻塞 **64ms**；全库 75 张连打开无卡顿。
- ⚠️ **测量方法教训**：`requestAnimationFrame` 在窗口非前台被节流，曾把 64ms 读成 28s —— 主线程阻塞要用
  50ms `setInterval` 的**最大间隔**来量（同 CT-13 补充坑）。

### 🔴 2. 卡内世界书条目增删改「要切卡才出现」（AR-30）
- **根因**：`worldbookEntries` computed 写作 `safeData.value.character_book || cardData.value?.character_book || {}`，
  左半存在时**短路不求值** → 该 computed 完全不依赖 `cardData`；`shallowRef` 深改后走 `triggerRef(cardData)`，
  而 `safeData` 重算返回**同一对象**（Vue 3.4+ computed 值未变不向下传播）→ 缓存永不失效。
- **修复**：显式读取 `const cd = cardData.value` 后再取 `safeData.value.character_book || (cd && cd.character_book) || {}`。
- **实测**：`splice` + `refreshCardData()` 后 computed 88→87、DOM 行数 4→3（修复前恒 88，切卡才变）。

### 🔴 3. 卡文件里的内部字段被写进卡片（DF-14 / DF-15）
- **DF-14**：`uid` / `_collapsed` 等编辑器内部字段混进卡文件。修复：新增 `main/cardFieldSanitizer.js`
  （**白名单**式剥离，绝不递归删 `_` 字段 —— 11,045 卡审计里 `_` 字段有 7 类 131 个是卡作者真数据），
  覆盖全部 **5 条写盘路径**（PNG chara 块、`file:saveCard` JSON 分支、`wb:save`、`wb:create`、导出整合包），
  其中「换卡图」是此前漏掉的第五条（`embedCardJSONIntoPNG` 统一收口）。渲染层另建 `js/utils/cardFields.js`
  （与主进程同一套字段清单，测试里做漂移比对）。
- **DF-15**：从「库」导入词条进卡内嵌世界书时，写的是**库格式字段**（`key` / `keysecondary` / `order` / `disable`），
  酒馆按卡格式读取 → 词条不触发。修复：新增 `js/utils/wbEntryFormat.js` 的 `toEmbeddedEntry()`
  （`keys←key`、`secondary_keys←keysecondary`、`insertion_order←order`、`enabled←!disable`、`use_regex←useRegex`、
  position 归一化 + 数值进 `extensions.position`；未知字段原样保留、深拷贝）。
- **实测**：真实导入条目 38 字段 → 12 字段，与卡内原生条目逐字段比对 **多 0 / 缺 0**；换卡图后再解析 PNG，
  `uid`/`_collapsed` 计数为 0 且正文数据完整。

### 🔴 4. 测卡区「状态栏」永远空白（CT-13，三层原因叠加）
1. **生产 CSP 拦死内联脚本**：界面段走 `srcdoc`，而 srcdoc iframe **继承父页 CSP**（`script-src 'self' app:`）
   → 卡内 webpack SPA 的模块脚本不执行。修法：新增主进程内存路由 `chat:setHtmlSegment` →
   `app://index.html/__jsk_seg__/N-xxxx.html`（该路由跳过 CSP 注入，与插件预览同机制、store 分开）。
2. **缺 iframe 全局库**：酒馆助手（JSR）靠 `third_party_message.html` + `predefine.js` 给每个消息 iframe 注入
   `Vue` / `jQuery` / `_` / `z`(zod)。新增 `js/chatHost/iframeGlobals.js` + vite 插件 `jsk-chat-host-bundle`
   打成单文件 IIFE（构建 `web/vendor/chat-host.js`、开发 `<root>/vendor/chat-host.js`），
   界面段一行 `<script src>` 引用（固定 URL → 跨 iframe 共用缓存，570KB 不进每份文档）。
3. **缺 iframe 宿主 API**：`buildHtmlSrcdoc` 桥接补齐 `getCurrentMessageId`（注入消息序号）、`updateVariablesWith`、
   `replaceVariables`、`errorCatched`，以及 `localStorage/sessionStorage` 内存实现（沙箱无同源权限时原生访问抛
   `SecurityError`）；预置注入位置改为 `<head>` **开头**（模板用普通内联脚本时也必须先拿到全局）。
- **参考实现**：用户本地预览工程 `H:\01\北派盗墓笔记\tavern_helper_gui\preview-frame.html`（同款 mock 环境），
  按其语义 `waitGlobalInitialized` **立即 resolve**（挂着等会让没有 `Mvu` 的环境卡住初始化链）。
- **补充坑（高度上报）**：iframe 量高依赖 `load` 后几次定时器，而后台窗口定时器被节流（~1s 一跳）→ 面板长时间停在
  默认 60px。补「回前台重新量高」：父层 `focus` / `visibilitychange` → `postMessage({type:'jsx-panel-height-request'})`
  → 桥接补报（实测 60 → 76 折叠态；展开 593px）。
- **实测**：修复前恒 60px + 控制台依次报 CSP 违规 / `Vue is not defined` / `z is not defined` /
  `getCurrentMessageId is not defined`；修复后 iframe 内 `#app` 挂载出 `ghost-root`、展开 593px、异常 **0 条**。

### 🟡 5. 测卡区翻页点了没反应 / 只有 1 个候选（CT-14、CT-15）
- **CT-14**：① `pushFirstMessage()` 只取 `first_mes`，**没读 `alternate_greetings`**（库内 41 张卡有 12 张带附加问候语）
  → 恒单候选；② 模板写 `@click="ctx.chatPrevSwipe/chatNextSwipe"`，而 `EditorPanel` 是纯 `setup()` 组件、
  `ctx` 未交给模板作用域 → 点击抛 `Cannot read properties of undefined`（**这才是「摆设」真因**）。
  修法：新增 `greetingTexts()`（`first_mes` + `alternate_greetings`，首个候选跑完整管线含 MVU 初始化、其余仅展示）、
  翻页只切 index（对齐移动版 `CardDetailView`）；模板改走本地包装函数 `onChatPrevSwipe` / `onChatNextSwipe`。
- **CT-15**：同源缺陷 —— 「清空记录」按钮 `ctx.chatClear` 一直是死的；改本地包装 `onChatClear`。
- **实测**：清空 → `1/2` → ▶ → `2/2`（正文换成附加问候语）→ ◀ → `1/2`；控制台错误 0。

### 📚 6. 文档
- 新增「卡内 HTML 渲染形态与已知缺口」总表：`docs/规格与计划/桌面版测卡工作区-实现规格.md` §4.1/§4.2
  （7 类渲染形态覆盖情况 + 云端 loader / 变量写回 / Mvu / 事件 API 四类已知缺口）。
- 缺陷总表 91 → **94 条**（CT-13/14/15），四个入口文件同步；`check-doc-links` ALL RESOLVE。

### 🔬 验证
- `npm test` **256/256**（新增 `test/cardFieldSanitizer.test.mjs` 14 例、`test/wbEntryFormat.test.mjs` 12 例、
  `test/chatRegexBudget.test.mjs` 7 例、`test/chatRender.test.mjs` 9 例）。
- `npx vite build` ✅（含 `web/vendor/chat-host.js`）；生产实例冒烟：状态栏展开 593px、翻页来回切、异常 0 条。

---

## ✨ v2.2.6 —— 预设缝合中心 + 四处条目批量操作

> 背景：预设之间搬运提示词条目此前只能「复制整份预设再手改」。新增 **缝合中心**：把 1~N 本源预设的条目 + 手写自定义条目，缝进任意目标预设，支持 **新建 / 覆盖 / 写回当前** 三种输出。
> 入口：侧边栏预设区「🧵 缝合」按钮（全屏弹窗，四区布局）。

### 🔴 关键修复：`prompt_order` 双写（此前项目完全不维护它）
- 实测真实预设（`TGbreak V1.1.3`）：`prompts` **118 条**，但 `prompt_order[0].order` 只有 **107 条**；`Izumi 0707` 为 **204 / 172**。
- SillyTavern 真正读的是 `order` 里的 `{ identifier, enabled }` → **只搬 prompts 会导致顺序错乱、启用态不对**。
- 缝合中心自带 order 重建器：以基座 order 为骨架 → 按「覆盖（位置不动）/ 新增（落位）」两类处理 → **`character_id` 沿用基座**（不写死 100001）→ 去重 + 剔除游离 identifier → `prompts[]` 与 `prompt_order[]` 一次写全。

### 🧩 融合（缝合）工作台 —— 逐条人工决策
- **3 类来源进同一工作台**：📚 其他预设条目（可整本「＋全部」）／ ✏️ 自定义条目／⭐ 常用库，三条来源完全同权。
- **逐条冲突决策**：与基座或工作台内同 `identifier` 时 → `✏️ 用来源覆盖` / `🔒 保留基座` / `🔀 重命名都保留`（自动生成 UUID）/ `⏭ 跳过`；**未决策项会阻止执行**（不会静默跳过）。支持批量套用。
- **内置 identifier 护栏**（`main`/`jailbreak`/`worldInfo`/`charDescription`… 共 14 项）单列红色徽章，防「别人的 main」悄悄盖掉基座主提示词。
- **逐条落位**（三策略 + 锚点 + 手动排序）：`⬇ 追加尾部` / `🏛 按内置序`（main→…→jailbreak 位次插入）/ `📍 锚点前·后`（右栏「🎯 基座时间线」点选任意条目即锚定；锚点缺失自动退化为追加）/ `↑↓` 调整工作台顺序。
- **干跑预览**：底部实时摘要 `新增 / 覆盖 / 重命名 / 跳过 / ⚠️待决策 → 结果 prompts N / order M`，「👁 预览缝合结果」展开完整 order 序列表（含 identifier / 启用态 / 来源）。**不写盘**。

### ✏️ 自定义条目（凭空造条目直接进目标预设）
- 可编辑：名称、内容（`🔍 放大` 走 TextModal）、角色 `system/user/assistant`、启用、注入位置（相对/绝对）、注入深度、注入顺序、`marker`、`forbid_overrides`、`system_prompt`、`identifier`（默认 UUID，可手改，🔄 一键重生成）。
- `identifier` 手改成内置名会自动触发冲突护栏；改任何字段后冲突实时重算。

### ⭐ 常用条目库（持久化）
- 工作台任意条目（含从别的预设搬来的）点「⭐」即收藏；左栏「⭐ 常用条目库」可 `📥 插入工作台 / ✏️ 改名 / 🗑 删除`。
- 存储：`app_config.json → ui.presetStitchSnippets`，走既有统一持久化中枢（`useConfigPersistence` 收集 + 防抖 500ms + 恢复期禁写保护），**重启不丢**；旧配置无该字段时默认 `[]`，恢复时做白名单字段校验。

### 📁 文件与接入
- 🆕 `js/composables/usePresetStitch.js`：staging 状态 / 冲突检测 / order 重建 / 三种输出 / 常用库 CRUD
- 🆕 `js/components/PresetStitchModal.vue`：三栏工作台（源池 + ⭐库 / 缝合工作台 / 基座时间线）+ 底部干跑（Options API + props/emits）
- `js/components/App.vue`：注入 + 模板挂载 + **ctx 新增 45 个字段** + `presetStitchSnippets` 恢复与自动落盘
- `js/composables/useConfigPersistence.js`：ui 段新增 `presetStitchSnippets`
- `js/components/SidebarPanel.vue`：预设区「🧵 缝合」入口
- `js/components/EditorPanel.vue`：监听 `stitchVersion`，「写回当前预设」后全量刷新预设编辑视图（prompts/脚本/正则/JSON）

### 🎨 UI 迭代（按反馈优化）
- 📚 **源预设改为下拉多选**：原先是一排 chips，预设一多就占好几行、挤压下面的条目池。现改为一行的下拉按钮（`📚 源预设 · 已选 N 本 · N/总数 ▼`），点开是带复选框的列表（含每本条目数 + `全选` / `清空` / 已选计数），**点面板外自动收起**。
  - 实测效果：左栏顶部工具栏高度压到 **79px**（不再随预设数增长），收起态 **条目池可视高度 501px**，展开态 195px（选完即收起）。
  - 条目池分组标题支持点击折叠/展开，列表高度提38vh。
  - 🔴 **浮层穿透 bug 修复**：首版把下拉做成 `absolute + z-40` 浮层，实测在 Electron 里**与条目池文字重叠穿透**（两列文字叠在一起）。已改为**文档流内展开**（`position: static`，展开时把条目池往下推）+ 面板/列表/行统一**内联实心背景色** + 加 `data-stitch-srcpanel` / `data-stitch-pool` 测试锚点。复验：面板 `177~477`、条目池 `520` 起，**几何零重叠**，与面板区域重叠的池行数 **0**，面板内不混入任何条目池内容。
- 👁 **「缝合结果预览」面板大幅加大**：由 `max-h-44`（176px）改为**占窗口 40%**（实测 317px，随窗口自适应）。
  - 新增统计行：`总数 / 🔒基座 / 📚来源 / ✏️自定义 / 🆕新增 / ✏️覆盖`。
  - 新增 **「只看改动」过滤**（实测：110 行 → 3 行，精确命中本次改动）。
  - 表格列重构为 `# | 条目名称 | identifier | 启用 | 大小 | 来源`；**identifier 完整显示不截断**（超宽横向滚动），新增/覆盖行分别用绿/琥珀底色 + `🆕 新增` / `✏️ 覆盖` 徽章标出。
- 🐛 修复：弹窗重开时源预设下拉会沿用上次的展开状态（一开窗就遮住条目池）→ 组件 `watch: show` 在打开时强制收起。

### 📖 引导文案强化（按反馈：功能能跑但上手靠摸索）
- 🧭 **顶部常驻流程条**：`① 左上「📚 源预设」勾选 1~N 本 → ② 点条目名（或分组「＋全部」）加入中间「🧵 工作台」 → ③ 逐条选「冲突决策」与「落位」 → ④ 右下角执行`，**默认展开**详细说明，涵盖五个最容易卡住的点：
  - **基座 / 目标**：结果的底子；三种模式各自含义（新建=不动原件 / 覆盖=写回并自动快照 / 写回当前=只改内存需自己保存）。
  - **冲突**：何时标 ⚠️、四种决策各是什么、**未决策不会执行**。
  - **落位**：三种策略 + 锚点用法（先点工作台某行，再点右侧时间线任一条目）。
  - **为什么 `prompts` 和 `order` 会一起重建**：酒馆实际按 `prompt_order` 执行，所以「工作台条目数」≠「结果 order 条数」是正常的。
  - 凭空造条目 / ⭐ 收藏到常用库的入口。
  - 支持 `▴ 收起 / ▾ 展开`；`✕` 本次隐藏；`不再提示` 永久隐藏（记 `localStorage['stt-stitch-guide-hidden']`，重开窗口仍生效）。
- ❔ **标题栏「说明」按钮**：永久隐藏后可一键恢复引导条并自动展开详细说明。
- 📌 **三栏各自补说明**：左栏「勾选的本子只被读取，不会被修改」；中栏副标题「待写入目标预设的条目清单」+ 工具条改「冲突批量: / 落位批量:」并各自带解释 title；右栏「结果以此预设为底子…原样保留」；底部摘要补统计口径 title。
- 📌 **空态改为 4 步上手引导**（没有条目标题时不再只是「暂无条目」），并提示「不确定就先 👁 预览缝合结果，不写盘」。
- 📌 **行内元素补 title**：⭐ 收藏、↑↓ 排序（注明只对「追加尾部」生效）、▸ 展开编辑、🗑 移除、`⬇ 尾部` 落位、冲突徽章（含「内置 identifier，注意别覆盖基座核心提示词」）、决策/落位下拉逐项解释。
- 📌 **模式说明随选中模式实时变化**（`targetModeHint`），不再需要点进去才知道区别。

### ✅ 验证（Electron GUI + CDP 真实热测试，测试脚本用后已清理）
- 基底数据：10 本真实预设；基座 `Izumi 0707`（prompts 204 / order 172）—— 正好覆盖 prompts≠order 场景。
- 干跑断言：`order` 无重复、`order ⊆ prompts`、新增条目全部入 order、`character_id` 沿用基座、基座条目数不减、自定义条目落在结果与 order 中。
- 三种输出真机跑通：**新建**（`H:\01\__stitch_test_target__.json`，prompts 208 / order 176，基座参数继承 `temperature=1`）→ **覆盖**（208→209、176→177，原条目保留，**快照已生成** `jsTavern_Backups/presets/…`）→ **写回当前**（内存生效、`stitchVersion` 自增驱动编辑器刷新）。
- 常用库：写入 → `reload` → 恢复成功（字段完整）→ 用毕清理为 0。
- UI 真实点击：侧边栏按钮 → 弹窗三栏渲染 → 源 chip 点选 → 池条目入工作台 → ✏️新建自定义条目 → 「＋全部」204→205 → 时间线点选设锚点 → 批量决策 → 预览表格（206 行）→ 取消关闭，全通过。
- 引导文案实测：流程条默认可见且**详细说明默认展开**（5 条说明全渲染）→ `▴ 收起` / `▾ 展开` 往返正常 → `不再提示` 后写入 `localStorage`，关闭重开**仍隐藏** → 点 `❔ 说明` 恢复显示并自动展开 → 三种模式说明文案随切换正确变化 → 空态 4 步引导渲染 → 可见元素带说明的 title 共 **194** 个 → 用毕已清 `localStorage` 测试残留。
- 回归：`npm test` 134/134 ✔、`vite build` ✔、测试产物（测试预设文件 + 快照 + 常用库测试条目）已全部清理。

### ☑️ 条目批量操作扩展（卡内正则 / 卡内世界书 / 世界书库 / 预设正则）

> 背景：四个「条目型」列表此前只能逐条增删改——①角色卡正则栏、②角色卡内嵌世界书条目、③世界书库词条列表、④预设正则区。本次统一补上「批量模式」，交互与既有世界书库批量保持一致（进入批量 → 勾选/全选 → 一键操作 → 自动退出批量）。

### ✅ 角色卡正则栏（`EditorPanel.vue` 模板 + `App.vue` 正则域）
- 新增 `regexBatchMode` / `regexBatchSelected`（选中键 = `getRegexUid`，WeakMap 稳定标识，数组增删不错位）
- 批量操作：全选 / 清空 / 启用 / 停用 / 克隆 / 删除（删除走二次确认）
- 批量模式下卡片转只读（输入框 disabled、编辑区收起），点击卡片任意处即勾选

### ✅ 角色卡内嵌世界书条目（`App.vue` 内嵌世界书域）
- 新增 `characterWbBatchMode` / `characterWbBatchSelected`（选中键 = `getEntryUid`）
- 批量操作：全选（仅当前搜索结果）/ 清空 / 启用 / 停用 / 常驻 / 取消常驻 / 克隆 / 删除
- 🔧 底层条目数组解析抽成 `characterBookEntriesRef()`：兼容 V3 `data.character_book` 与 V2 顶层 `character_book` 两种存放位置（原先只认前者，V2 卡下批量删除/克隆会静默不动）

### ✅ 世界书库词条列表（`useWorldbookEntries.js`）
- 在原有「启用 / 停用 / 删除」基础上新增：**常驻 / 取消常驻 / 条件触发 / 取消条件触发 / 克隆**
- 切换世界书（`activeWorldbook`）自动退出批量模式，避免选中项跨书残留

### ✅ 预设正则区（`EditorPanel.vue` 预设域）
- 新增 `presetRegexBatchMode` / `presetRegexBatchSelected`（选中键 = 脚本对象引用）
- 批量操作：全选 / 清空 / 启用 / 停用 / 克隆 / 删除；批量模式下卡片收成一行摘要（名称 + 状态 + 查找正则）
- 切换预设自动退出批量模式

### 🛡️ 一致性细节
- 切换角色卡时自动退出卡内正则/卡内世界书批量模式（`watch(cardData)`），杜绝「选中残留 → 误删」
- 所有批量删除均带二次确认，并写入编辑器终端日志（success / warning 分级）

### 🔥 Electron 热测试复核（同一批功能的真机验证，发现并修复 2 个真问题）
> 方式：真实 Electron GUI（`VITE_DEV_SERVER_URL` 指向 vite dev）+ CDP 驱动，覆盖「字典 entries / 数组 book / 标准 entries / 顶层 regex_scripts / extensions.regex_scripts」五类历史数据形态，API 直接调用与 UI 真实点击双路径验证。

1. 🔴 **数据丢失级**（`App.vue` `ensureCharacterBookEntries`）：旧实现只认 `character_book.entries` 为**数组**，遇到「`entries` 是对象字典」的旧形态卡会**把整本字典替换成空数组** → 用户点「➕ 新增词条」或「📥 从世界书库导入」时，该卡既有词条**全部消失**（保存后不可恢复）。现改为三形态兼容（数组 book / entries 数组 / entries 字典），字典会被归一化为数组并**保留全部既有词条**。
2. 🔴 **批量操作静默失效**（`App.vue`）：批量删除/克隆只认数组形态，字典形态卡上点「删除/克隆」**毫无反应也无提示**（而「启用/常驻」却正常 → 表现为"偶发、特定卡才出现"）。现统一走 `characterBookEntriesRef()` 三形态解析：数组**倒序 splice**、字典**按键 delete**，**不改变原数据结构**。
3. ✅ 顺带收敛：单条「删除 / 克隆 / 上移 / 下移」也走同一解析，消除"批量能用、单条点不动"的不一致。
4. ✅ 复核通过（真机 UI 点击）：世界书库批量（全选 / 常驻 / 条件 / 克隆 / 删除）、预设正则批量（全选 / 停用 / 克隆 / 删除）、卡内世界书批量、卡内正则批量；切换卡片 / 世界书 / 预设均自动退出批量模式；全程**零 Vue 警告、零未捕获异常**。
5. 🧪 热测试基建（用后已清理）：`EnumWindows` 定位 Electron 原生「确认操作」对话框并投递 ENTER 的自动确认守护（CDP 点不到原生模态框，这是唯一可行通道）。

---

## 🧩 v2.2.5 —— 插件代码 AI 助手 + 代码编辑器体验增强 + JSON 页可编辑

> 背景：围绕「插件工作区」的代码体验收尾——①加 AI 对话式定位/修改插件代码；②Raw JSON 页从只读变为可编辑、可格式化、可应用回写；③修复 `.json` 插件（内部实为压缩 JS）格式化失效；④搜索面板中文化（原为 CodeMirror 硬编码英文）；⑤格式化按钮由 hover 显隐改为常驻可见。

### 🤖 插件代码 AI 助手（`js/components/AiCodeModal.vue` 新增）
- 新增 `AiCodeModal.vue`：对话框 UI（🤖 图标 + 目标文件名 + 对话气泡流 + 输入框 `Ctrl+Enter` 发送）
- 打开时把当前插件源码拼进 system 提示词作上下文；用户描述需求，模型回复 Markdown 代码块，正则解析取**最长** ``` 代码块，一键「应用」回写编辑器
- 定位类问题 system 提示词明确「只给文字 + 行号，不贴整段代码」
- 复用现有 AI 链路：`sendChatMessage`(IPC) + `resolveApiModel()` + `extractReplyContent(result)`；API 配置沿用设置里的 endpoint/key/model/type

### 🧩 接入（`js/components/PluginWorkspace.vue`）
- 顶部控制栏加「🤖 AI 修改」按钮（此前是 📂定位/🗑️删除）；注册 `AiCodeModal` + `showAiModal`
- `applyAiCode(code)` 回写 `selectedSource`（扩展工程）或 `scripts[0].content`（脚本类）+ `pluginDirty = true`
- `watch` 把 `selectedFile`/`selectedSource` 注入 `activePlugin._selectedFile`/`_selectedSource`
- 脚本卡片 `CodeEditor` 显式传 `language="javascript"`（`.json` 插件格式化修复的关键）

### ✨ Raw JSON 可编辑 + 应用回写（`js/components/EditorPanel.vue` / `App.vue`）
- Raw JSON 页去 `readonly`，改 `v-model="rawJsonDraft"`，顶部加状态栏 + 「✅ 应用修改」按钮
- `App.vue`：新增 `rawJsonDraft`(ref) + `applyRawJson`（解析 → 校验对象类型 → 写回 `cardData` → `refreshCardData()` → 重新格式化草稿 + `showToast`）
- 🔴 **数据不显示修复**：原 `watch(cardData)` 用引用比较（`shallowRef` 顶层替换）不可靠 → 改 `watch(formattedJson)` 监听 computed 的 JSON 字符串，用 `lastJsonText` 文本比较；`apply` 后同步 `lastJsonText`
- 两者加入 `ctx` return（子组件 inject 依赖）

### 🐛 `.json` 插件格式化失效修复（`js/components/CodeEditor.vue`）
- 根因：按 `.json` 扩展名推断为 `json` 语言，`formatNow` 走 `JSON.parse`；但酒馆助手插件的 `content` 常是压缩 JS，`JSON.parse` 抛错被吞 → 原文不动，表现为「格式化没效果」
- 修复：`formatNow` 的 `json` 分支加 JS 回退——`JSON.parse` 失败时回退 `js_beautify`；配合脚本卡片显式 `language="javascript"` 双保险

### 🌐 搜索面板中文化（`js/components/CodeEditor.vue`）
- 根因：CodeMirror `@codemirror/search` 的短语原文即 key，无 provider 时直接返回英文原文
- 修复：`EditorState.phrases.of({...})` 提供中文映射覆盖（key 覆盖 Find/Replace/next/previous/all/match case/regexp/by word/replace/replace all/close/Go to line/go 等）

### ✨ 格式化按钮常驻可见（`js/components/CodeEditor.vue`）
- 原为 `opacity-0 group-hover:opacity-100`（hover 才显示，用户找不到）→ 改常驻右上角 + 文字「✨ 格式化」

### 🏷️ 导入打标双开关彻底解耦（`js/composables/useCardCrud.js` / `App.vue` / `HeaderBar.vue`）
- **动机（v2.2.5 最终契约）**：用户要求两开关职责独立、只对导入的新卡生效：
  - `sanitizeImportedTags`（🧹忽略卡片自带标签）：**只管**是否物理清空卡片自带原生 `data.tags`——入口统一执行，4 条提前 return 无法绕过；
  - `autoTagOnImport`（🏷️导入自动打标，默认 `true`）：**只管**是否运行规则引擎（贴规则标签 + 自动分类）。
- 🔴 **解耦修复（核心 bug）**：初版实现残留旧闸门 `if (!sanitizeImportedTags.value && !alreadyHas)` —— 规则循环里「忽略开关」错误压制「规则开关」，导致 **忽略开 + 规则开时规则标签不贴**（规则开关开了等于没开）。修复：删掉规则循环对忽略开关的依赖，能走到规则循环即规则开关已开 → 命中无条件贴标；`shouldAutoBuildCategory` 同步与忽略开关解耦。
- **最终四象限**：忽略开+规则开=清原生+规则贴标分类 / 忽略开+规则关=全空白手动 / 忽略关+规则开=保留原生+规则补充 / 忽略关+规则关=保留原生不打标
- 关闭时不干扰用户历史配置（覆盖层/importedConfig/localCategoryMap/subFolder 用户配置恢复**优先于**该早退判定）
- 持久化：`ui.autoTagOnImport` 入 `useConfigPersistence` + `loadAppConfig` 恢复 + 集中 watch + `ctx` 暴露；`HeaderBar.vue` 两开关 UI 文案对齐新契约
- 🔴 **事故记录**：解耦修复中一次 `replace_string_in_file` 发生错位——`App.vue` ctx 行 `currentCustomPushTarget` 被拆成 `curren autoTagOnImport,tCustomPushTarget` 导致 Vite 编译崩溃（`Unexpected token`）。已修复（该行恢复为 `currentCustomPushTarget, autoTagOnImport,`）。⚠️ 教训：多字段单行 ctx 追加字段时，必须用**行首独立锚点 + 整行替换**，勿用模糊子串。
- ⚠️ 测试教训：`makeMock` 新增 mock 参数后必须同时暴露到 **return 对象**；`cardCrud.test.mjs` 用 V2 结构（`data.data.tags`），断言勿写 `card.data.tags`

### 🐛 dev 启动终端中文乱码（`scripts/dev-run.ps1` 新增）
- **根因**：Windows PowerShell 终端代码页默认 GBK(936)，Electron/Node/Chromium 输出 UTF-8 → 中文日志与系统错误消息乱码（`閫氬父姣忎釜濂楁帴瀛楀湴鍧€` 等）；libpng/WSALookup 无害噪音夹杂
- **修复**：新增 `scripts/dev-run.ps1` 一键启动脚本，启动前 `chcp 65001` + `[Console]::OutputEncoding=UTF8` 双保险切 UTF-8，实测 dev 启动日志中文全部正常显示
- ⚠️ 注意：该乱码仅影响**开发终端显示**，与应用界面/打包版无关（界面 HTML 恒 UTF-8 charset）

### 🧪 测试
- 四象限 + 历史配置回归：`test/sanitizeImport.test.mjs` ×8、`test/cardCrud.test.mjs` 更新 2 条旧契约断言。全量 **134 用例通过**（v2.2.4 的 128 → v2.2.5 的 134）

---

## 🧩 v2.2.4 —— 插件效果预览（实验标注）+ 预览渲染链路修复

> 背景：收尾插件「效果」预览的三类问题——①预览内联脚本被生产 CSP 拦截全部静默不执行；②部分插件空白（宿主 DOM 缺官方挂载点，插件 jQuery 空对象 `.append()` 静默失败）；③预览内 HTML 净化不彻底（消息/模板中的 `<style>`/事件属性等污染）。同时按用户要求把「效果」预览标注为实验性（沙箱仅实现部分酒馆接口，复杂插件可能空白，对外如实说明）。

### ✨ UI：效果预览标注实验性
- 「效果」页签加琥珀色「实验」徽标；顶栏如实提示：沙箱仅模拟部分酒馆接口，依赖完整酒馆 API/DOM 的插件可能空白/不完整
- 对外文案按双版规范：用户可看版（简、如实、不吹）见 `RELEASE_NOTES.md`；本文件为内部详细版

### 🧱 CSP 拦截预览脚本（改用独立 `app://` 内存路由）
- 根因：生产 CSP `script-src 'self' app:` 无 unsafe-inline，`srcdoc`/`data:`/`blob:` iframe 继承父页 CSP → 预览全部内联脚本被拦
- `main.js`：新增 `previewStore`（Map，上限 32 份/5MB）+ `setPluginPreview`；`registerAppProtocol` 增加 `/__jsk_preview__/` 前缀内存路由（命中直接返回 HTML，不落盘）；`onHeadersReceived` 对预览路径跳过 CSP 注入
- `preload.js`：暴露 `setPluginPreview(html)` IPC；`PluginWorkspace.vue`：`previewState` 由 `html`(srcdoc) 改为 `url`(src)，生成 HTML 后经 IPC 换独立 `app://` URL

### 🧩 插件空白（补齐宿主 DOM 官方挂载点）
- 根因：`buildHostDom()` 缺 SillyTavern 官方挂载容器，`$('#token_counter_wand_container')` 等 `append()` 落到空 jQuery 对象 → 静默失败 → 空白
- 对齐官方 `public/index.html` + `templates/wandMenu.html` 补齐：`#extensionsMenu` 内 15 个 `*_wand_container`；`#extensions_settings`(16) + `#extensions_settings2`(16) 个 `*_container`（memory→`#summarize_container`、tts→`#tts_container`、translate→`#translation_container`）；新增 `#leftSendForm`、`#zoomed_avatar_template`（memory doPopout 复用）

### 🔒 内容净化管线（对齐官方 chats.js / templates.js）
- `escapeHtml` 补五字符 `& < > " '`（此前漏 `'`，对齐 utils.js）
- `renderExtensionTemplate`：渲染后默认 `DOMPurify.sanitize`（可显式传 `false` 关闭）
- `messageFormatting`：补全 `makeHtml → encodeStyleTags → DOMPurify.sanitize(MESSAGE_SANITIZE + ADD_TAGS:['custom-style']) → decodeStyleTags`；新增 `encodeStyleTags`/`decodeStyleTags`（`hostStubPure.js` 纯函数，字符串级等价实现：去 `@import`/含 `://` 声明、类名加 `custom-` 前缀、普通选择器加 `.mes_text` 前缀）
- 内联真实 DOMPurify UMD（`purify.min.js?raw`）作为净化引擎

### 🧪 测试
- 新增 6 组纯逻辑单测（escapeHtml 五字符 / encodeStyleTags / decodeStyleTags 还原+前缀+去外部资源），全量 128 用例通过

---

## 🧩 v2.2.3 —— 插件工作区 + 内置大分类定制 + 效果页渲染修复

> 背景：新增「插件」Tab，支持把 SillyTavern 插件（酒馆助手 JSON 脚本 / 用户脚本 / SlashRunner 命令 / 扩展工程）纳入工具统一管理，并在工具内模拟酒馆运行、预览插件效果，无需导入真实酒馆。同时开放内置 18 大分类的自定义（改名/删除/恢复），并修复「效果」页沙箱预览的渲染失败问题。

### 🧩 侧边栏新增「插件」Tab
- 预设 Tab 后新增「🧩 插件」Tab（violet 配色），计数徽标实时显示插件数
- 接入方式：`📂 打开插件目录`（本地扫描）；原「Git 仓库链接导入」已剥离封存（详见 `docs/技术支持/代码片段-Git导入封存.md`）
- 插件列表：类型徽标（酒馆助手/用户脚本/命令/扩展）、来源标注、简介摘要、右键菜单（定位/删除）

### 🧬 插件形态归一（`js/utils/pluginScanner.js` 纯逻辑，可单测）
- 识别四类来源：酒馆助手 JSON 脚本（`{id,name,info,content,buttons[]}`）、带 `==UserScript==` 头的注入脚本、`SlashRunner.registerCommand` 命令脚本、扩展工程（`manifest.json` + `dist/*.bundle.js`）
- 内容形态判别 `detectScriptKind`：A=jQuery 注入 / B=userscript 头 / C=SlashRunner 命令
- `manifest.json` 入口解析 `resolveManifestEntries`：兼容 `entry/main/js/index/css` 与原生 `extensions[]` 多字段命名
- 预览资源挑选 `resolvePreviewAssets`：从文件树去重挑出 js/css
- 新增 9 组单测（detectScriptKind / isPluginJson / isExtensionManifest / normalize* / resolve* 等），全量 90 用例绿

### 📄 / ✨ 工作区双选项卡（`js/components/PluginWorkspace.vue`）
- `📄 代码`：散落脚本/酒馆助手直出源码；扩展工程展示文件树 + 源码只读查看器
- `✨ 效果`：沙箱 iframe（`sandbox="allow-scripts"`，无 `allow-same-origin`）内模拟酒馆运行，渲染插件注入的悬浮球/按钮/面板

### 🧪 酒馆宿主桩（`js/plugins/hostStub.js`）
- 迷你 jQuery 兼容层（`$`/`jQuery` 的 DOM 增删查改、事件、ajax stub）
- `eventSource` / `SlashRunner` / `extension_settings` / `saveSettingsDebounced` 等常用全局 stub
- `GM_*` userscript 空实现 + 内存 localStorage（data: URL 沙箱下原生 localStorage 不可用）
- 宿主 DOM 骨架（`#chat` / `#options` / `#right-nav-panel`），达基线「悬浮球出现 → 点击弹面板」

### 🔒 安全与 IPC（`main.js` / `preload.js`）
- 新增 `plugin:scan` / `plugin:readFile` 两个 IPC
- 路径白名单校验（`isPathAllowed`）、文本类型限制、脚本 2MB 体积上限

### 🔄 启停与记忆
- `localStorage` 记忆上次插件目录，启动自动静默恢复扫描

### 🛠️ 内置 18 大分类自定义（改名 / 删除(隐藏) / 恢复）
- `tagCategories.js` / `TagCategoryModal.vue`：内置大分类开放改名、删除（=隐藏，非物理删）、一键恢复默认
- `useConfigPersistence.js`：内置分类定制持久化（`app_config.json`），重启不丢
- 新增独立 Electron CDP 端到端脚本 `scripts/builtin-cat-test.mjs`（改名/删除/恢复/清理全链路）

### 🔧 效果页沙箱预览渲染修复（`Unexpected token ':'` 根因消除）
- **路径分隔符匹配 bug**（`pluginScanner.js`）：`manifest.js` 声明正斜杠 `dist/index.js`，而 `collectExtensionFiles` 生成反斜杠路径，`endsWith` 失配 → bundle 读不到、回退相对路径。统一 `/` 归一后再比较
- **宿主桩补齐全局 API**（`hostStub.js`）：`getPresetManager` / `reloadMarkdownProcessor` / `characters`（数组） / `#send_form` 节点——消除扩展 bundle 顶层立即执行时的运行时崩溃
- 三种插件形态（真实扩展 bundle / 样例 bundle / SlashRunner 散落脚本）经独立 Electron 复现全部 0 错误、正常渲染

---

## 🧹 v2.2.1 —— 历史外来标签一键清洗（Bug 修复版）

> 背景：`导入时忽略卡片自带标签` 开关只对「新导入」生效。开关开启前导入的历史卡，其外来标签已被旧逻辑收编进 `customTags` 并永久写回 PNG（`persistCardUpdate` union 回写），且全局标签池无条件聚合 `customTags` → 表现为「开关似乎无效」的体感残留。

### 🧹 新增「清洗历史外来标签」一键工具（设置菜单，`useTags.cleanForeignTagsFromLibrary`）
- 全库扫描词表外的外来标签（`customTags` 与原生 `data.tags` 双清，兼容 V1 字符串形 tags）
- 白名单 = 系统/常用标签库 + 自动打标规则标签 + 用户手动归类过的标签 + 自定义关键词库（大小写不敏感，兼容手动归属存小写键）
- 确认前预览将清除标签数与受影响卡片数；确认后逐张物理落盘（复用批量进度 Toast 与 `runWithProgress`）
- 保留策略：如需保留个别词表外标签，先将其加入「系统/常用标签库」再执行本清洗

### 📝 开关文案澄清
- 设置菜单开关副文字改为「仅对新导入的卡片生效；历史残留请用下方清洗工具」，消除「开关无效」误解

### 🤖 AI 归类转正 + 自动建类增强（原「实验」标记移除）
- 背景：AI 归类原只允许输出现有分类 key，模型给出的「不在现有分组」的分类名会被强制回 other 丢弃（`TagCategoryModal` 345 行）
- `resolveTagCategoryTarget`（tagCategories.js）：归一 AI 返回值——命中内置 key/中文名、自定义 key/name → 用现有；其余经合理性过滤（限 12 字内、拒绝纯符号数字）→ 标记为新分类候选
- 判定纪律改「按语义成组自拟」：多个作品/IP/专名可聚成同一自拟简洁中文类名（如多个游戏→「游戏角色」、多部动画→「番剧动画」）统一承接；孤立专名/散杂标签仍 other，绝不单标签自造类
- 建议视图：未命中的行标「🆕 新建」徽标 + 高亮，下拉新增「🆕 将自动新建」分组可改；应用时自动 `addCustomTagCategory` 建类并把标签归入（建失败回退现有或保留 other）
- 移除 `TagCategoryModal` 全部 4 处「实验」标记，AI 归类转正

### 🔧 修复：自定义分类 key 碰撞 + 同名规范化（★ 相似 BUG 全查）
- 根因：`addCustomTagCategory` key = `Date.now().toString(36)`，同一毫秒连续建多个分类（AI 一次应用连建必触发）→ key 碰撞、不同名分类共用 key、标签归属错乱/UI 重复条目
- 修复：key 追加随机段；`normalizeTagName`（零宽/全角空格/NBSP 折叠）判重；`addCustomTagCategory` 幂等（同名返回已有 key）；`mergeDuplicateTagCategories` 合并同名变体并迁移归属；`ensureUniqueCustomCategoryKeys` 修复历史同 key 条目
- 相似 BUG 全仓扫描：其余所有时间戳 key/uid 生成均已带随机段，无同类隐患
- 测试：新增 key 唯一/规范化/幂等/合并用例（全量 78 用例绿）

---

## 🏷️ v2.2.0 —— 标签大分类体系 + 自定义大分类 + 实验·AI 归类（功能版）

### 🗂️ 标签大分类体系（18 大分类 + 折叠 + 向量辅助）
- 标签云按 18 大分类分组（人物关系/身份职业/性格特质/角色设定/外貌身材/情境场所/时代背景/力量体系/题材世界观/种族物种/情感基调/故事剧情/内容分级/性玩法/玩法类型/卡片功能/文风语言/其他），分类可点击折叠
- 四级归类策略：精确特例 → 斜杠复合词首段 → 关键词规则 → 向量语义兜底（阈值 0.35）
- 单字词精确特例防子串误伤（ai→卡片、sm→性、jk→学生、cot→提示链等）
- 🔧 规则层记忆化缓存：大库标签反复分组从「扫上千关键词」降到 O(1)
- 万卡库（11186 张）1520 个真实标签 7 轮深度收编：「其他」1037 → 236（约 78% 覆盖率）

### 🛠️ 自定义大分类 + 手动批量归属（`TagCategoryModal.vue` 新弹窗）
- 分类弹窗：新增/重命名/删除自定义分类；删除自动清其下标签归属；重启持久化（`app_config.json`）
- 目标分类驱动批量勾选：先选目标分类 → 勾选/子串全选 → 一次批量归入，落盘一次不卡
- 手动归属优先级最高，覆盖自动/向量分类；分组展示插在「其他」之前

### 🧪 实验 · AI 大模型归类（规则即提示词）
- 把 18 分类语义 + 自定义分类 + 判定纪律编译成 System Prompt，分批（120/批）调用已配置大模型给「其他」标签归类
- 结果逐条下拉核对后应用（不盲信模型）；作品/IP/人名等专名强制归「其他」
- ⚠️ 实验特性：依赖本地 API 中转可用性；主进程请求加 120s 超时保护（防黑洞挂死）

### ⚡ 性能与修复
- 启动后索引/Token 预热等蒙版淡出后再执行，不再抢首屏（拖动跟手）
- `package.json` build:web 修复：`web` 目录不存在时 `&&` 短路导致 vite 不构建

---

## 🔧 v2.1.3 —— 标签持久化 / 向量模型 / 漏斗协同 / UI 性能修复（Bug 修复版）

### 🐛 标签持久化彻底修复（重启不丢失）
- **子文件夹卡标签重启丢失**（`useCardCrud.js` `processAutoTagsAndCategory`）：`subFolder` 分支直接 `return` 跳过覆盖层恢复 → 位于分组文件夹的卡 customTags 重启后丢失。修复：物理文件夹只管分类，标签仍按覆盖层恢复（与根目录分支同口径）；实测 `app_config.json` 覆盖层有 66 条标签数据，此前只是加载时不恢复
- **分组重命名标签丢失**（`useCardGroups.js` `renameCurrentCategory`）：物理重命名文件夹后子卡 path 前缀变化，覆盖层 key 未随路径迁移（`migrateOverlayKey` 只在单卡移动时调用）。修复：重命名后、`refreshLibrary` 前批量迁移该分组下所有卡的覆盖层 key（旧目录前缀 → 新目录前缀）+ 立即落盘
- **落盘加固**：① `persistCardUpdate` 物理写盘失败时立即强制 `syncConfigToDisk()`（不走 500ms 防抖）；② `useAITools` AI 打标全部完成后强制立即落盘一次（不依赖防抖 + beforeunload）

### 🏷️ sanitizeImportedTags 开关全链路修复（4 处绕过）
- 开关此前只在导入路径生效；显示/搜索/索引层无条件合并原生 `data.tags` → 开关"失效"
- 修复：`SidebarPanel.vue listTags` / `App.vue activeCardTags` / `useSearch.js extractCardTags(ignoreNative)` / `App.vue rebuildSearchIndex` 全部接入开关

### 🧠 向量模型有效化（`main/vectorManager.js` + `useAITools.js` + `AITagModal.vue`）
- 阈值 0.65 → 0.35（三处对齐）；标签展开为描述句「这是一个关于X的故事」再嵌入（展开文本作缓存 hash 输入，模板变自动重建缓存）
- 实测：长文 vs 短标签命中率 0% → 80%，误报基线最高 0.307（0.35 安全）

### 🔄 三层漏斗协同（`useAITools.js` `startAITagging`）
- 规则命中卡 `ruleHitIds` 不再跳过向量层：`vectorTargetIds = [...rulePassedIds, ...ruleHitIds]` 全部进向量语义补充；规则+向量都未命中才交 LLM
- 关键契约：`batchMatch` 对每张传入卡都返回 result（未命中 `tags: []`），前端按 results 重建 `llmTargetIds` 不丢卡

### ⚡ UI 性能（`HeaderBar.vue`）
- 字号滑块改「草稿值 + 松手提交」：拖动只更新滑块+数字，松手才写全局 `appSettings` → 不再每帧触发 `--ui-fs/--workspace-fs` 全页面 reflow + localStorage 写入

### 🧪 测试基建
- `package.json` test 脚本限定 `test/**/*.test.mjs`（`node --test` 默认会把 `scripts/live-vector-test.cjs` Electron 脚本误收集）
- `cardCrud.test.mjs` 优先级链①断言更新：subFolder 卡分类取文件夹名，但标签恢复 overlay（匹配修复后新行为）

---

## 🔧 v2.1.1 —— 换组/标签/列表刷新修复（Bug 修复版）

### 🐛 换组修复
- **右键换组改为已有分组选项选择弹窗**（`OptionSelectModal.vue` 新组件）：从预设 + 自定义分组下拉选择，避免手输名称与物理文件夹不一致导致换组失败；底部保留新建分组；批量移动分组同步升级（`useCardGroups.js` `buildGroupOptions` 组装分组选项，预设用中文名、自定义用原名）
- **编辑器分组下拉回滚修复**（`EditorPanel.vue` + `useCardGroups.js`）：library 为 shallowRef，setter 修改内部 category 不触发 computed 重算，`handleCardCategoryChange` 读 getter 缓存旧值 → 移回旧分组（下拉回滚）。改为 `@change` 直接传目标值，不依赖 getter 缓存；失败回滚保留真实原分类

### 🧬 同类 shallowRef 未 flush bug（3 处，`App.vue`）
- `updateName`（重命名）：修改 `libItem.name` 后未 flush → 列表卡片名不刷新 → 加 `triggerRef(cardData)` + `triggerRef(library)`
- `replaceCardImage`（换卡图）：修改 `path/avatar` 后未 flush → 列表头像/文件名不刷新 → 加 `triggerRef(library)`
- `saveToLocalDisk`（保存）：回写 `_mtime/_size` 后未 flush → 「修改时间/大小」排序不刷新 → 加 `triggerRef(library)`

### 🏷️ 标签一致性修复
- **编辑器标签区合并原生 data.tags**（`App.vue` `activeCardTags`）：此前只读 `customTags`，而部分卡（命中 localStorage 手动分类等分支）加载时 `customTags` 为空但 `data.tags` 有标签 → 编辑器标签区空白而列表正常（实测 34/73 卡受影响）。改为合并 `customTags + data.tags`（与列表 `listTags` 口径一致）
- 排查确认：AI 打标 `applyAutoTags` / 手动 / 批量 / 全局标签全部双写（customTags+data.tags）；`persistCardUpdate` 以 customTags 为权威列表同步删除且不误删原生 data.tags；搜索索引 `extractCardTags` 三源合并；加载覆盖层命中时 `data.tags ∪ overlay.tags` 合并不丢

### 🎨 侧边栏标签展示（增强，`SidebarPanel.vue`）
- 列表头部新增「🏷️ 标签」显示开关（localStorage 持久化，可关掉节省空间）
- 列表项「+N」展开显示全部标签（indigo chips），「▲收起」收起
- 选中态标签高对比配色：选中（`bg-blue-600`）时标签 chips 改深蓝底白字（`bg-blue-900/70 text-white`），解决蓝色选中背景看不清字体

### 🚀 性能
- `updateName` 列表刷新改 150ms 防抖（`flushLibraryAfterNameChange`）：避免万卡下每击键同步重算 `filteredLibrary` 全量排序造成输入卡顿；`rebuildSearchIndex` 本身有 100ms 防抖 + `buildTaskId` 取消合并

---

## ✨ v2.1.0 —— 可配置规则 + 智能查重 + 万卡性能优化（覆盖发布）

> 内部详细版（对外精简版见 RELEASE_NOTES.md v2.1.0）

### 🎛️ 自动打标规则可配置化（全新）
- `cardLoader.js`：`defaultAutoTagRules` 38 条系统预设（世界观/题材、种族/物种、人物类型、性格/关系 4 组）+ `compileAutoTagRules(custom)` 编译 = 系统预设全部 + 用户自定义（同名覆盖）+ `autoTagKeywordCandidates` 关键词候选库
- `AutoTagRulesModal.vue`（新组件）：「系统预设 / 自定义」双 Tab —— 系统预设按组分开展示（默认全部生效）；自定义规则增删改（名称 + 正则实时生效）；自定义关键词库管理（添加/移除/去重）
- 入口：`AITagModal.vue` 向量引擎区底部「📝 管理规则表」（系统预设已内置，可自定义）
- 持久化：`autoTagRules` / `customKeywords` 落盘 `app_config.json`（useConfigPersistence payload 增加）
- 消费：`useAITools`（AI 打标三层漏斗第一层）/ `useCardCrud`（导入自动分类）由 App.vue 注入编译结果
### 🧠 小型本地向量引擎（全新 · 三层漏斗第二层：免费离线语义匹配）
- 模型：`Xenova/paraphrase-multilingual-MiniLM-L12-v2`（多语言语义向量，支持中文，量化版约 113MB，完全本地离线推理）
- 定位：AI 打标三层漏斗 **① 规则 → ② 本地向量语义匹配 → ③ LLM API**，规则未命中但语义相似的卡片由向量层免费打标，**不消耗 Token**
- 推理架构：`main/vectorManager.js` 调度 `main/vectorWorker.js`（worker_threads）执行 ONNX 推理（onnxruntime-node），主进程零阻塞
- **标签向量索引持久化**：`vector_index_cache.json`（模型版本 + 标签池 sha256 双校验），重启不重算；批量匹配 500 卡/块 + 32 条/批推理防序列化瓶颈
- **三源下载自动切换**：hf-mirror 国内镜像 → HuggingFace 官方 → GitHub 仓库分片兜底（onnx 113MB 切 8 片 + gh-proxy/ghfast 代理加速），注入浏览器 UA 绕过 hf-mirror 连接重置，断点续传 + 超时保护
- UI（`AITagModal.vue`）：启用开关、模型状态（就绪/缓存大小）、下载进度（多源标识）、相似度阈值滑条（默认 0.65）、每卡 TopK（默认 3）、一键删除缓存；向量阶段进度合并进打标进度条
### 🧬 智能查重全面升级（同名 + 内容级 + 预设）
- `useDedupe.js` 重构扩展：同名查重按名称聚类 + 批量 `getFileStats`（空安全保护）+ 一键清理移回收站（失败回滚提示）
- `ContentDedupeModal.vue`（新组件）：**内容级版本查重** —— 跨名称识别改名/复制的相似内容（内容指纹，与名称无关）
- `PresetDedupeModal.vue`（新组件）：**预设查重** —— 按预设名聚类 + 采样参数指纹（`prompts` 数字键升序规范化，避免字典序 "10"<"2" 误判）+ 提示词正文比对 + 推荐保留排序（提示词更全/参数更丰富/更新）+ 一键移回收站
- `DiffModal.vue`：差异对比类型图标支持（世界书 📖 / 预设 ⚙️ / 角色卡 🃏）
- `HeaderBar.vue`：智能查重入口「🔍 同名查重与版本清理」/「🧬 版本查重：跨名称识别相似内容」，目标标签随当前视图（角色卡/世界书/预设）动态变化
- `SidebarPanel.vue`：更多工具折叠整理

### 🚀 万卡性能优化（v2.2/v2.3，真实 11.5GB / 11186 张实测）
- 主进程扫描：`walkLibraryDir` 文件元数据 stat 由逐文件串行改为 **128 路批量并发**（STAT_BATCH + flushStatQueue，万卡扫描 1.5s）
- **PNG 内嵌提取缓存**：按 path+mtime+size 缓存提取结果到 `embed_cache_N.json`（LRU 上限 + 单条>512KB 跳过 + 分片原子写防 JSON 超限），二次启动免重读 PNG 头部
- 批量读取 IPC：READ_BATCH 64→128（主进程）/ 256（渲染层），解析并发 8→16
- **拉取-解析流水线预取**：批量拉取（IO）与并发解析（CPU）重叠执行
- **Web Worker 多线程解析**（`cardParseWorker.js` 新）：JSON.parse + 血统鉴定 + 规范化搬到 Worker 线程，与主线程组装双线程并行（Worker 不可用自动回退）
- `normalizeCardData(noClone)`：批量加载路径原地规范化，省 1 万次 structuredClone 深拷贝
- **自动打标写盘降噪**：仅「真正新增的标签」才落盘（已存在标签不重写 PNG，首启后二次启动零写盘）
- 实测：渲染解析 46.7s → 31.4s，蒙版淡出 46.7s → 33.2s

### 🐛 Bug 修复
- **中文搜索完全失效**（searchIndex.js）：`_tokenize` 中文字符判断 `\/\u4e00-\u9fff\/` 缺少方括号 → 中文 token 全部丢弃 → 中文搜索返回全库（v2.0.0 引入）。修复为 `/[/\u4e00-\u9fff/]`，修复后「赛博」检索 10000→371 正确命中
- `test/cardCrud.test.mjs`：补充 `autoTagRules` mock（`compileAutoTagRules(null)` 系统预设），46/46 全绿

---

## ✨ v2.0.0 —— 预设管理 + 九种排序 + 千库扫描提速（覆盖发布）

> 内部详细版（对外精简版见 RELEASE_NOTES.md v2.0.0）

### ⚙️ 预设管理引擎（全新）
- `usePresets.js` + main.js（`preset:scan` 异步扫描 / `preset:save` / 回收站）+ preload 4 API + App.vue / EditorPanel / SidebarPanel 全新「预设」页签
- 预设深度编辑器：脚本 / 正则分区编辑（`presetScripts` / `presetRegexScripts`，启用开关、折叠、说明字段、增删），渲染型脚本沙箱 iframe 渲染预览（`sandbox="allow-scripts"` 隔离）
- 预设管理操作：重命名 / 复制副本 / 移入回收站 / 批量导出

### 🔀 排序功能全面升级（9 种排序方式，`useSearch.js` sortList 重构）
- 排序选项：importTime 导入最新 / time 本地文件最新（mtime+ctime 取较新）/ name A-Z 正序 / nameDesc A-Z 倒序 / mtime 修改时间 / ctime 创建时间 / sizeDesc 大小倒序 / sizeAsc 大小正序 / tokens Token
- 排序键：`_mtime`（物理 mtime）/ `_ctime`（物理 birthtime）/ `_size`（物理字节数）/ `_importTime`（首次入库持久化）/ 全部纯本地文件级
- `Intl.Collator('zh-Hans-CN', {numeric:true, sensitivity:'variant'})` 拼音 + 数字自然排序；稳定链 `路径→文件名→id` 兜底，重扫/重启/升级顺序完全确定
- 导入时间持久化：`cardImportTimes` 映射落盘 `app_config.json`（useConfigPersistence payload 增加）；A-Z 倒序整体取反（含稳定链翻转，互为精确逆序）
- Token 排序：`tokenCache.js`（WeakMap 缓存 + stats）+ Schwartzian transform 预计算

### ⚡ 搜索性能升级（`searchIndex.js`）
- 高性能倒排索引：`buildAsync` 异步分片构建（requestIdleCallback / setTimeout yield），倒排 Map + WeakMap 文本/标签缓存

### 🚀 扫描性能大幅提速（main.js）
- 世界书 / 预设扫描：`scan_cache.json` 增量缓存（mtime 未变且已知无效则跳过）+ 32 路并发 JSON 解析 + >512KB 先读头 64KB 关键字预检 + 深度限制（世界书 5 层 / 预设 2 层）+ `skipFolders` 黑名单目录剪枝
- PNG 内嵌提取：`extractPngEmbedded` 64 路并发批量提取（EMBED_BATCH=64，批间让出事件循环），walkLibraryDir 只标记 `_needsEmbed` 不再串行逐张解析

---

## ✨ v1.8.9 —— 状态栏渲染预览 + 世界书导入导出 + 显示修复（覆盖发布）

> 内部详细版（对外精简版见 RELEASE_NOTES.md v1.8.9）

### 📊 状态栏渲染预览器（新功能，`useStatusbarPreview.js` + App.vue + EditorPanel.vue）
- **背景**：酒馆聊天中「状态栏」是把 AI 输出的 `<status>` 文本块经卡内正则脚本渲染成 HTML 面板的常见玩法，但调样式必须反复"改脚本→保存→进酒馆→发消息"验证
- **能力**：
  1. 自动识别「渲染型脚本」（未禁用 + 替换串含 HTML 标签），列出供勾选参与预览
  2. 正则引擎模拟：`parseRegexPattern` 兼容 `/pattern/flags` 与裸 pattern，强制补 `g` flag（与酒馆全局替换一致），非法正则跳过不炸预览；`$1` 捕获组由 `String.replace` 原生展开
  3. 双视图：✨ 渲染效果 / 📄 替换后源码；渲染结果经 DOMPurify 白名单清洗（`FORBID_ATTR` 全事件属性 + `ALLOWED_URI_REGEXP` 禁外联，与 `renderSafeHTML` 同策略）
  4. 内置模板一键注入：`STATUSBAR_TEMPLATE`（V2/V3 字段双写 `findRegex/find_regex`、`replaceString/replace_string`，`placement:[2]` 作用于 AI 输出，深色渐变面板样式），重复注入按 `<status>` 特征拦截
  5. 脚本勾选状态：`enabledScriptUids` 数组 + `watch(renderableScripts, immediate)` 自动纳入新脚本，`toggleStatusbarScript`/`isScriptEnabled` 配套- **📚 15 套渲染模板库**（`js/utils/statusbarTemplates.js`）：dark-rpg / cyber-hud / 江湖 / cozy / ghostly / mini / pixel / relation / log / card / wave / mind / star / lord / theme，每套内置图标/配色/动画，点击卡片注入正则脚本
- **📜 11 套世界书指令模板（三合一）**（`js/utils/statusbarPromptTemplates.js`）：通用三合一 ⭐ + 10 套主题（奇幻/克苏鲁/赛博/武侠/星际/黑暗/日常/领主/怪物/时间），每套均为「初始值定义 + 显示格式 + 数值更新规则」三合一条目，点击注入为内嵌世界书常驻条目（keys 留空 / constant / 插入深度 0）
- **模板库折叠**：渲染模板库与世界书指令模板库各自可折叠收起- **接线**：App.vue 引入 composable + tabs 新增 `{ id:'statusbar', name:'状态栏', icon:'📊', badge: renderableScripts.length }` + ctx 暴露 9 项；EditorPanel 新增完整 UI 区块（标题栏/脚本勾选/输入区/预览区 + 空状态引导注入按钮）
- **TDZ 安全确认**：`tabs` computed（L1396）引用 `renderableScripts`（L3486 声明）——computed 惰性求值，全文件仅 L1411 引用 `tabs.value`（同为惰性），onMounted/watch 均异步，无同步访问路径，无 TDZ
- ✅ CDP 实测全过：Tab 切换 / 脚本识别 / 勾选切换（true→false→true）/ 模板注入完整链路 / 重复注入防重 / `<status>` 渲染成面板无残留

### 🌍 世界书库显示修复（commit 332c437 / df3b78b）
- **触发词被当名字**：世界书库 IDE 列表原主显示 `formatKeys(entry.key)`（触发词大字加粗），名字 comment 为空时不显示 → 视觉错乱。改为名字主显示（`comment || name || '未命名词条'`）+ 🔑 触发词副显示；`WbImportModal.vue` 导入弹窗同款修复
- **名字输入框标签**：库 IDE 名称输入框原标「📝 备注 (Comment)」误导用户以为名字不可改 → 改为「📝 名称 / 备注 (Comment)」与角色卡内嵌一致
- 根因核实：外部导入世界书源数据 comment 为空/comment==key 属源数据问题，本应用导入/转换逻辑从不把 key 写进 comment（已全量核对 5 处 comment 赋值点）

### 📥 世界书导入导出（上一轮 v1.8.9，trae/agent-Fxvvsf 分支合入）
- 从世界书库导入词条到角色卡（复用 WbImportModal，与「📤 提取为世界书」双向闭环）
- 导出条目名缺失修复：`name → comment` 映射 + `insertion_order → order` 回退（useWorldbookExtras.js）

---

## ✨ v1.8.5 —— 千卡库性能大修 + 安全加固 + 全面 BUG 修复

> 内部详细版（对外精简版见 RELEASE_NOTES.md v1.8.5）

### 🚀 性能优化（针对「上千卡片启动缓慢、崩溃、白屏、未响应」）
- **主进程扫描异步化**：库目录递归扫描改为异步分片（每 25 项让出事件循环），千卡库扫描不再阻塞主进程
- **自动打标 I/O 风暴治理**：启动加载期只收集变更、加载完成后低并发后台落盘——旧版启动 = 千张卡 × (整 PNG 读回 + 重写 + 快照备份) 的 I/O 风暴拖到分钟级，现 UI 秒开
- **卡片分块加载**：批量导入/加载用暂存数组解析，每 500 张分块合并库列表
- **Token 估算缓存**：WeakMap 按卡缓存估算结果
- **tokens 排序预计算**：Schwartzian transform 预计算后排序

### 🛡️ 安全加固
- **wb:scan 白名单自扩权后门修复**：必须通过「世界书指纹验证」（目录内存在有效世界书）或本会话真实选择才授权
- **wb:restoreSnapshot 路径越界封堵**：快照路径必须位于 userData 备份目录内（堵死「任意本地文件读取」）
- **符号链接/junction 环路防护**：4 处递归扫描 realpath 去重

### 🐛 BUG 修复
- 盘符根目录库全库 403（`isPathUnder` 统一判定）
- 配置损坏误迁移（损坏时保留原文件、以默认值运行）
- 保存后 mtime 回写防「刷新库」全量重写死循环
- 切库后孤儿编辑面板重绑（Ctrl+S 不再保存失败）
- 回收站同名互覆（`时间戳_序号_文件名` 命名）
- PNG 多 chara 块救援（首块损坏继续扫后续块）
- 原子写入全覆盖（tmp 唯一命名 + rename，中断不产生半截文件）
- file:readBuffer/readText 异常兜底
- 下载体积前置校验（Content-Length 拒绝超大文件）
- 多条 system 提示词拼接保留
- 世界书字典形态 entries 补齐（JSONL/JSON 导入 + 全库词条搜索）

### 📸 世界书快照增强（本次未提交增量，随下次打包生效）
- **修复「回滚快照无限增长」**：旧版每次回滚都无条件备份当前版本且从不清理，反复回滚时列表只增不减——统一 `backupWorldbookSnapshot` 三防：①内容哈希去重（已留档跳过）②超量自动清理（`snapshotConfig.maxSnapshots`）③备份失败向上抛出（防止未留档版本被覆盖丢失）
- **新增 `wb:deleteSnapshot` IPC**：双保险校验（必须位于 userData 世界书快照目录内 + 文件名符合快照格式），防任意文件删除原语
- **快照弹窗单条删除**：WbSnapshotModal 每行新增 🗑️ 按钮（confirmDialog 确认 → IPC 删除 → 本地列表移除）

---

## ✨ v1.8.4 —— 修复「导入 JSON 角色卡导致角色栏消失/空屏崩溃」（character_book 脏形态全链路防御）

> 内部详细版（对外精简版见 RELEASE_NOTES.md v1.8.4）

### 🐛 核心修复
- **根因**：部分 JSON 角色卡的 `character_book`（内嵌世界书）为特殊形态——①`entries` 为字典对象（`{ "0": {...} }`）；②`character_book` 本身是数组（老 V1 嵌入格式，此时 `.entries` 命中数组原型方法）。旧写法 `book.entries || (Array.isArray(book) ? book : [])` 分别拿到「字典对象」和「函数」，后续 `.forEach`/`JSON.stringify().toLowerCase()` 直接 TypeError
- **症状链**：侧栏每张卡的 Token 徽章渲染调用该函数 → 渲染抛错中断 → 角色栏整体消失/空屏；卡已复制入库 → 每次重启复现
- **修复**：新增 `extractBookEntries()` 统一安全提取（数组优先识别避开原型方法陷阱 → entries 数组 → 字典 `Object.values`；脏条目过滤；任何形态永不抛错），**全链路接入 9 处消费点**
- **浏览模式加卡片级 try/catch 兜底**：任何未来脏卡只跳过该卡并告警，列表永不整体崩溃
- 新增 5 个回归单测锁定此陷阱（含数组原型方法陷阱用例）

---

## 🕰️ 早期版本纪要（v1.0 ~ v1.6.1）

> 本节保留 2026-08-09 ~ 08-14 的开发纪要（**会话 → 版本 → 做了什么**），供追溯「某个功能/修复是什么时候进来的」。
> 缺陷与坑的完整条目见 `docs/bugs/`（含「历史修复速览」一节）；v1.6.2 起的版本细节见本文档上方各段。

| 日期 | 版本 | 落地内容 |
|---|---|---|
| 08-09 | v1.0 | 初版功能测试与打包流程建立；卡片导入/解析/编辑/标签/分组/关系图谱雏形 |
| 08-10 ~ 08-11 | — | 部分功能暂缓、打包产物归置 |
| 08-12 | v1.2 ~ v1.3 | 三主题（dark/slate/light）、路径记忆、侧边栏瘦身、词条 IDE 折叠、右键菜单增强（打开文件夹/复制/打标/回收站）、世界书查重引擎、版本更新检测、启动防闪烁、分类持久化、标签中英切换、批量标签弹窗、全局深度搜索、快照与回收站、一键导出整合包、多语言分组、关系图谱多轮升级、Token 估算器、全局资产中心、系统/全局标签库、系统快捷过滤（`has_lorebook`/`has_regex`）、P0 加固（CDN 本地化 `vendor/`、崩溃兜底）、P2 API 鉴权可配置 |
| 08-13 | v1.3 ~ v1.4 | **世界书双引擎**（`appMode` characters\|worldbooks）、词条级 Entry IDE、智能查重与版本清洗、高分屏 DPI 适配、世界书库文件夹导入/删除/克隆/右键菜单、世界书分组（`wbCategoryMap`）持久化、统一 IPC 落盘拦截器、世界书严格防伪 `isValidWorldbook`、Shift 连选错位修复、卡片高亮改对象引用比较、360 锁 `app.asar` 的 `dist_new` 绕法；「三连 BUG」审查（确认多为误报） |
| 08-14 | v1.5 | **工程化大升级**：Vite + Vue3(SFC) + Tailwind CLI（`index.html` 模板迁入 `App.vue`，2047 行模板 + 4676 行 setup；vue 需完整版 alias；**勿加 `type:module`**；ECharts npm 化）；SFC 化十步走（拆出 21 个子组件 + 根，全程 `provide/inject` ctx 共享）；列表/网格双视图；全屏拖拽导入遮罩（深度计数器）；防系统打开图片加固（`will-navigate` + `setWindowOpenHandler` + `draggable=false`）；AI 一键汉化/格式升维；全局 Toast；搜索防抖 + 快捷键；图片懒加载 + 拖拽把手；可拖拽分栏 |

**这一时期沉淀下来的关键教训**（已归档为缺陷条目）：
- Vue 弹窗必须在 `#app` 闭合 `</div>` 之内 → [AR-09](docs/bugs/BUG-架构与渲染.md)
- `window.prompt/confirm/alert` 在 Electron 静默失败 → [AR-02](docs/bugs/BUG-架构与渲染.md)
- IPC 不能传响应式 Proxy → [AR-01](docs/bugs/BUG-架构与渲染.md)
- 组件注册名首字母连续大写无法被 kebab 标签解析 → [AR-10](docs/bugs/BUG-架构与渲染.md)
- 纯 Options API 组件模板不能用模块级 import 的函数 → [AR-11](docs/bugs/BUG-架构与渲染.md)
- Win10 21H2 导入不了任何卡片（IPC 白名单 → 改用 File API） → [DF-01~DF-05](docs/bugs/BUG-数据与文件.md)


## ✨ v1.8.3 —— 全库词条搜索 + 世界书库重设计 + 世界书扩展 + 快照管理增强 + 图谱卡顿修复 + 白名单安全加固

> 内部详细版（对外精简版见 RELEASE_NOTES.md v1.8.3）

### 🔍 全库词条搜索
- 顶栏「🔍 全库词条搜索」：一次性检索**全部独立世界书 + 全部角色卡内嵌词条**，命中结果标注来源，点击直达并高亮

### 🌍 世界书库 UI 重设计 + 扩展
- 侧边栏 4 层布局：搜索独立行 → 操作按钮等宽（合并/查重/全库/折叠）→ 分组导航常驻 → 3×2 统计网格
- 世界书快照（保存前自动备份 + 弹窗查看/一键恢复）
- JSONL 批量导入、批量导出、内嵌世界书提取为独立书
- 词条 IDE 增强：筛选/排序/批量操作/词条体检/上移下移/Token 用量

### 🗑️ 历史快照管理增强
- 删除单个快照（弹窗每行 🗑️，双重安全校验：仅限 `.bak_history` 内 + 快照文件名格式）
- 快照前缀匹配精确化（卡 A 不再误配卡 A_1）+ 9 个自动化单测

### 🚀 关系图谱卡顿修复（v3 + v4）
- 连线预算（300 上限群体 / 3000 条连线裁剪）+ 构建缓存 + loading 遮罩
- v4：头像节点限流（120/60）、过绘制治理（30/18/11px + 标签预算）、位置种子（切换不洗牌）、bigram 预过滤（世界书提速 10-100 倍）
- 修复 `exportGraph`/`graphStats`/`graphBuilding` 漏 ctx 暴露（导出按钮失效/徽标空白/遮罩不显示）

### 🔒 白名单安全加固
- 换卡图/盘符扫描不再误删库根白名单（preAuthorized 守卫，防全库「路径越界」瘫痪）

### 🛰️ 全盘打捞 V3 真伪鉴定
- 黄金标准鉴定（PNG 块级解析 + JSON 可解码 + 有角色名）、IO 优化（头/尾 64KB 预筛）、库内排除（V3.1）、无库收编引导、三路明细
- 修复收编「An object could not be cloned」（Vue reactive 数组传 IPC 未剥离）

---

## ✨ v1.8.2 —— 换卡图 + 链接下载导入 + 下拉菜单 + 静默升级 + 安全加固 + 8 项 BUG 修复 + 代码审查整改

> 内部详细版（对外精简版见 RELEASE_NOTES.md v1.8.2）

### 🖼️ 换卡图（新功能）
- 工具栏 ⚙ 菜单 / 右键菜单「🖼️ 换卡图」：选择新立绘一键替换
- PNG 卡**原地替换**（内嵌 chara/ccv3 数据完整保留）；WebP / JSON 卡自动转标准 PNG 卡
- 主进程新增 `card:replaceImage` IPC + 7 个 PNG 工具函数（buildPngChunk / isCharaChunk / isPNGBuffer / embedCardJSONIntoPNG / calibrateCardData / getCardName / validateCardPNG）
- sharp 可选依赖（N-API 走 ABI 兼容，Electron 下验证通过）

### 🌐 从链接下载导入角色卡（新功能）
- 顶部「🌐 链接导入」+ 文件菜单入口
- 主进程 `card:downloadFromUrl` IPC：`net.fetch` 走系统代理下载 → PNG/JSON 校验 → 落盘卡片库（同名跳过不覆盖）
- 支持 PNG 卡（内嵌 chara/ccv3 块）与 JSON 卡；20MB 上限；非角色卡文件明确报错
- 进度提示用非阻塞 toast（避免模态框阻塞导致「下载中」卡死）

### ⚙️ 编辑器工具栏下拉菜单
- 7 个操作按钮（汉化/升维/快照/换卡图/保存/导出/删除）收进 ⚙
- `<Teleport to="body">` + fixed 定位 + 全屏透明遮罩：彻底解决遮挡 / 裁剪 / 层级问题

### 🔧 更新后静默升级（新功能）
- **根因定位**：真正导致「更新 = 重装向导」的不是 oneClick，而是 `sys:installUpdate` 里**无参 `quitAndInstall()`**——`isSilent` / `isForceRunAfter` 默认均 false → 以非静默方式运行安装器（assisted installer 弹界面）、装完不自动重启
- **最小修复 1 行**：`autoUpdater.quitAndInstall(true, true)`（`isSilent=true` 静默升级；`isForceRunAfter=true` 装完自动重启）
- 首次安装自定义目录已支持：`oneClick:false` + `allowToChangeInstallationDirectory:true`（assisted 向导可自选 D/E 盘），无需改动
- ⚠️ 关键前提：保持 per-user（package.json **勿设 `perMachine:true`**）——否则装到 C:\Program Files，静默更新因无 UAC 提权写入失败（EACCES）

### 🔧🐛 Bug 修复（8 项，含根因）

1. **卡片导入空分组**：清理历史遗留的幽灵分组数据（`123`/`555`）并把卡片回退「未分类」
2. **编辑器内容区右侧大面积空白**：移除 basic / advanced / worldbook / regex 4 处 `max-w-5xl` 宽度限制，内容随窗口铺满
3. **历史快照配置重启丢失**：快照开关 / 冷却 / 保留数持久化到 app_config + snapshot_config.json 双源
4. **「最新」排序错乱**：根因=全库 mtime 被批量 touch 统一成同一时刻导致排序退化；改以物理**创建时间 birthtime** 为第一基准（稳定反映入库时刻）
5. **关闭自动快照仍生成快照**：根因=`saveSnapshotSettings` 把 Vue reactive Proxy 直接传 IPC 报 `An object could not be cloned`，主进程始终默认 `enabled=true`；改为 `JSON.parse(JSON.stringify())` 剥离后同步
6. **保存成功弹窗报错**：`showMessage` 收到非标准 type `success` 抛 `Invalid message box type`；主进程做类型归一（→ info）
7. **导入卡片出现无名/陌生分组**：根因=自动分类 `tag.split(' ')[0]` 把 `Monster (魔物娘)`→`Monster` 等英文规则名当分组创建；改为分类只落预设分组，未知组名保持「未分类」且不自动建组
8. **空物理文件夹显示为空分组**：`walkLibraryDir` 无条件把一级文件夹当分组；改为扫描后仅保留**确实包含卡片文件**的文件夹作为物理分组

### 🔐 安全与稳定性加固（代码审查 37 项整改）

- **依赖 CVE**：`npm audit` 检出 15 项漏洞（全在构建工具链）→ 升级 electron-builder 26.15.3 + electron 43.4.1，**0 漏洞**
- **API Key 明文落盘 → safeStorage 加密**：内存明文、磁盘密文，兼容旧明文自动回退；main.js `secret:encrypt/decrypt` IPC + preload + App.vue / useChat.js 读写改造
- **JSON 卡原子写入**：file:saveCard 改 tmp + rename 替换，中途崩溃不再损坏原卡
- **文件句柄防泄漏**：walkLibraryDir `openSync` 套 try/finally
- **关键落盘补日志**：saveSnapshotConfig 写盘失败不再静默吞掉（console.error）
- **渲染层统一错误兜底**：entry.js `errorHandler` 加用户提示 + 全局 `error` / `unhandledrejection` 监听
- **废弃 escape() 移除**：pngParser 改 TextDecoder 标准 UTF-8 解码（无非 ASCII 越界隐患）
- **网络请求重试**：`fetchWithRetry`（5xx / 网络错误退避重试）接入 chat:send / models:fetch / tavern:push
- **魔法数字常量化**：`MAX_URL_DOWNLOAD_BYTES` / `MAX_WB_FETCH_BYTES` / `SCAN_FILE_BATCH` / `SCAN_PROGRESS_STEP` / `CHAT_DEFAULT_MAX_TOKENS`
- **运行时依赖精确版本**：dompurify / electron-updater / sharp 去掉 caret（^）

### 🧪 单元测试（node:test，19 用例全过）

- `test/tokenEstimate.test.mjs`：Token 估算边界（空 / 非字符串 / 中英混合）
- `test/cardLoader.test.mjs`：normalizeCardData V1 / V2 / V3 结构兜底
- `test/pngParser.test.mjs`：PNG tEXt / ccv3 / 截断 / 损坏解析
- `test/businessData.test.mjs`：典型业务数据回归（V2/V3 卡、Token 业务口径）
- `npm test` 一键运行

### ⬆️ 依赖升级

- Electron 33 → **43.4.1**（主进程 API 全部兼容验证通过，国内镜像安装）
- electron-builder 25 → **26.15.3**
- `npm audit` **0 已知漏洞**

---

## ✨ v1.6.2 —— 深度修复 8 项 + UI 全面瘦身 + 安全加固

### 🔧 底层修复（8 项）

- 📋 **克隆世界书 UID 冲突修复**：复制副本时重新生成全部词条唯一标识，杜绝 Vue 渲染错乱（Duplicate keys）
- 🔀 **世界书折叠状态错位修复**：从数组索引改为稳定唯一标识，删除/排序词条后折叠状态不再错乱
- 🔌 **API 引擎切换模型回退**：切 Claude 时自动清空 `local-model`/`gpt-*` 不兼容模型名，杜绝 HTTP 400
- 🧮 **正则作用域 0 值误判修复**：`placement: 0` 不再被误判为"默认"，补全"全局/未定义"映射
- 🖼️ **PNG 重组 IEND 兜底**：保存时确保 IEND 块收尾，杜绝残缺 PNG
- 🎴 **卡片规范化 3 项**：V2 字段缺失不再白屏（tags/alternate_greetings/extensions 兜底）；缺 spec 半残卡不再双重嵌套；Blob URL 改用本地路径协议防内存泄漏
- 🏷️ **自动打标落盘**：新卡导入时自动标签/分类立即物理保存，重启不丢失
- 🧹 **V1 判定排他**：酒馆 config.json 等标准配置文件不再被误当角色卡入库

### 🎨 UI/UX 全面瘦身

- 🗜️ **列表双模式**：常规（大头像+描述+Token/标签三行信息）/ 紧凑（极致单行，一屏翻倍卡片）
- 📁 **排序下拉**：名称 / 最新 / Token 三种排序，偏好持久化
- 🎛️ **高级筛选折叠**：分类/快捷标签/过滤 chips 收进漏斗面板，侧边栏顶部只留搜索+漏斗
- 📌 **批量操作底部悬浮台**：多选时页面正下方弹出毛玻璃控制台，不再挤占侧边栏
- 🌍 **世界书侧边栏折叠式**：URL 导入/打开目录/分组/筛选收进 ▼ 面板，与角色卡模式同款交互
- 📖 **世界书词条紧凑化**：启用圆点可点击切换、字数/位置徽章、hover 操作、列表可整体收起
- ✅ 修复重复分类下拉（"All (全部)" 只保留一个）

### 🖥️ 世界书编辑器重构（IDE 化布局）

- 📚 **左列表 + 右详情**：从卡片内联展开改为「左侧可收起词条列表 + 右侧详情编辑」双栏 IDE 布局
- 🎯 **竖直长条折叠按钮**：浮在栏边缘垂直居中，一键收起为窄条（📖 + 竖排词条数），点击 📖 可快速展开
- 🔍 **侧栏内搜索 + 新建**：搜索框与 ➕ 新建移入左侧栏，触发词/备注/正文全字段匹配
- 🗜️ **极致压缩列表**：`formatKeys` 展示触发词（空 key 显示「无触发词」）+ 启用圆点 + hover 复制/删除（毛玻璃背景）
- ✍️ **详情区全字段编辑**：主触发词/备注 → 次要触发词/权重 → 插入位置（0-4 五档）→ 内容 textarea 撑满 + 实时字数
- 🔗 **原生字段映射**：`key` / `keysecondary` 逗号分隔双向绑定（computed），严格遵循酒馆官方字段，绝不污染 JSON
- 🛡️ **修复底部遮挡**：底部终端控制台不再遮挡词条列表最后一个条目（动态底部留白联动）

### 🔐 安全加固（纵深防御）

- 🛡️ **渲染模式 XSS 清洗**：引入 DOMPurify（本地依赖、离线可用），聊天渲染模式剥离脚本/事件/iframe/`javascript:` 等危险内容，禁止外联图片（防追踪像素/内网探测）
- 🧱 **主进程路径白名单**：全部文件类 IPC 统一校验「卡片库/世界书目录/酒馆根/扫描根/userData」白名单，越界读写/删除/导出一律拒绝；`local-file://` 协议越界返回 403
- 🔒 **CSP 响应头**：生产模式注入完整 Content-Security-Policy（限制内联脚本与外部连接），纵深防御兜底
- 🛑 **`openExternal` 协议白名单**：仅放行 http/https，防恶意 URL scheme 触发
- ⚡ **单文件 IO 异步化**：读图/读卡/保存全链路改 `fs.promises`，几十 MB 大图不再卡主进程
- 🐛 **修复配置覆盖 bug**：选择/扫描文件夹时改为合并写入配置，不再冲掉已保存的全局标签库
- 🔓 **堵死白名单自扩权后门**：`scan-target-folder` 直接传路径严格限定为纯盘符；`tavern:pushDir` 不再无条件扩权（需已在白名单或通过酒馆指纹验证）；`FORBID_ATTR` 改为真正生效的字符串列表

---

## ✨ v1.6.3 —— 安装版持久化修复（过渡版本）

> ⚠️ 说明：v1.6.2.1 → v1.6.3（electron-builder 不支持四段版本号 1.6.2.1）

- 🔧 **修复安装版分组/语言/分类重启丢失**（根因：`app://` 协议 localStorage 不落盘）
- 📁 **预设分组删除/重命名持久化**：重启不再重新生成或「改名新分组 + 原预设」重复并存
- 🏷️ **分组操作卡片分类物理持久化**：分组重命名/删除/移动后分类跨重启保留
- 🌐 **语言设置持久化**：标签语言模式（纯中文/纯英文/中英双语）重启保持上次选择
- 🚫 **特殊分组按钮隐藏**：「全部」「未分类」等系统视图不显示改名/删除按钮

---

## ✨ v1.6.4 —— OTA 自动更新 + 全盘检索 + 血统鉴定

- 🔧 **持久化真正落盘修复（关键）**：`saveUiSettingsToDisk` 此前把 Vue 响应式 Proxy 直接传给 IPC，触发 Electron `An object could not be cloned` → 分组/语言/卡片分类**从未真正写入磁盘**（静默失败）；已统一用 JSON 序列化剥离 Proxy，实测语言切换 + 卡片分类修改均能物理落盘、重启恢复
- 🚀 **OTA 自动更新**：升级为 electron-updater 自动下载安装——检测到新版本后应用内一键下载（实时进度条/速度），下载完成自动重启安装，无需跳转浏览器手动下载
- 🛰️ **全盘深度检索引擎 (Beta)**：实验菜单「全盘打捞卡片」极客雷达风弹窗——自动枚举全部本地磁盘、体积过滤引擎（拦截 <40KB 废图/贴图）、穿透隐藏文件夹的 V2 并发递归扫描、实时进度心跳，扫描完成后一键「全部强行收编入库」精准追加入库（同名跳过，不清空现有库）
- 🕵️ **角色卡血统严格鉴定**：入库前指纹级校验——新增拦截伪装成卡片的**聊天记录**（messages/chat_metadata）、**独立世界书**（孤立 entries）、**UI 主题配置**（colors/user_settings），连同原有的 config.json 排他与 V1/V2/V3 规范校验，杜绝脏数据污染卡片库（实测 4 类伪装文件全拦截、含无 description 的 V1 真卡不误杀）
- 📁 分组删除/重命名持久化、卡片分类持久化、语言设置持久化（延续 v1.6.3 成果，配置以文件为权威载体）

---

## ✨ v1.6.5 —— 统一持久化中枢 + 导入修复 + 全盘强行收编

- 🛡️ **统一持久化中枢（app_config.json 最高权威）**：全软件全局状态（分组/语言/全局标签池/API Key）统一收口到 `app_config.json` 物理文件（原子写入：临时文件 + rename，绝不丢数据）——生产模式下即便 localStorage 不持久也不丢配置
- 🎴 **卡片覆盖层防冲刷（核心）**：手动改过的卡片分组/标签写入物理覆盖层（key=卡片路径），重新扫描/重启后**绝不**被自动分类覆盖（实测重扫后"恋活"分组完整保留）
- 💾 **卡片变更三保险落盘**：新增 `persistCardUpdate` 统一入口（内存 + 覆盖层 + 物理重写 PNG），8 个标签/分类操作全部接入——即使 PNG 重写失败，配置库也能记住数据
- 🔑 **API 配置物理持久化**：Endpoint / Key / Model 此前只存 localStorage（生产模式重启丢失），现已写入 app_config.json，重启自动恢复
- 📥 **导入功能修复（Win10 等导入不了卡片）**：文件菜单导入改用浏览器 File API 直接读取内存内容，彻底绕过 IPC 路径白名单——从桌面/下载等任意位置导入卡片不再被拒（修复"未识别到有效的角色卡文件"）
- 🚀 **全盘扫描强行收编通道**：新增 `sys:importExternalCards` 专属接口——全盘检索出的卡片可绕过源路径白名单强行复制入库（只校验目标库；同名跳过绝不覆盖；兼容字符串/对象两种格式）
- 🔄 **旧配置自动迁移**：首次启动自动把旧 `tavern_manager_config.json` 的 globalTags/uiSettings 合并迁移到 app_config.json，历史数据零丢失
- 🖼️ **修复破碎图标**：文件菜单导入复制到库目录 + 用 `local-file://` 永久路径替代 blob URL
- 🖼️ **导入格式增强**：jpg/jpeg 卡片格式支持 + 去重/未识别区分提示 + 诊断日志

---

## ✨ v1.6.6 —— 修复：世界书与角色卡目录彻底分离

- 🔀 **打开世界书目录后自动切换到世界书模式**：此前从文件夹打开世界书目录，界面仍停留在角色卡列表页，误认为"没分开"
- 🔀 **打开角色库目录后自动切回角色卡模式**：两个入口现在在上完全独立
- 🛡️ **带 name 字段的世界书 JSON 不再混入角色卡**：此前部分世界书文件（含 name 字段）会被误判为 v1 角色卡导入，现已严格拦截所有顶层 `entries` 数组（角色卡内嵌世界书在 `data.character_book`，不受影响）
- 📦 版本号升级 1.6.6 + 忽略 dist2 构建目录

---

## 📊 版本迭代脉络

| 版本 | 主题 | 核心价值 |
|------|------|---------|
| **v1.6.2** | 修复 + 瘦身 + 安全 | 8 项深度修复、UI 精简、世界书 IDE 化、XSS/白名单防护 |
| **v1.6.3** | 持久化修复 | 安装版设置重启丢失根因修复（过渡版） |
| **v1.6.4** | OTA + 检索 + 鉴定 | 自动更新、全盘打捞、血统鉴定、落盘 bug 修复 |
| **v1.6.5** | 持久化中枢 | `app_config.json` 统一收口、覆盖层防冲刷、导入修复 |
| **v1.6.6** | 目录分离 | 世界书与角色卡目录彻底分离、模式自动切换、世界书 JSON 不再混入 |
| **v1.7.0** | 物理分组 + 快照配置 | 分组 = 物理文件夹、可配置历史快照、标签批量管理 |
| **v1.8.0** | 快照恢复 + IDE 增强 | 快照一键恢复、世界书选项卡增强、扫描性能大幅提升 |
| **v1.8.1** | 快照治理 + 配置彻底修复 | 快照去重/清理、配置整体替换防复活、AI 破限打标 |
| **v1.8.2** | 换卡图 + OTA 静默升级 | 换卡图、链接导入、下拉菜单、静默升级、37 项安全整改 |
| **v1.8.3** | 词条搜索 + 图谱提速 | 全库词条搜索、世界书扩展、图谱卡顿修复 v3/v4、全盘打捞 V3 |
| **v1.8.4** | 脏形态防御 | JSON 卡 character_book 脏形态全链路防御（角色栏消失根治） |
| **v1.8.5** | 千卡库性能大修 | 异步分片/IO 治理/Token 缓存、白名单后门封堵、全面 BUG 修复 |

**整体主线**：v1.6.2 打牢基础（修复 + 安全）→ v1.6.3 / 1.6.4 攻克持久化（重启丢配置）→ v1.6.5 统一持久化架构 → v1.6.6 资产分离收尾 → v1.7.0 物理分组与快照体系 → v1.8.x 功能爆发（OTA/换卡图/词条搜索/图谱提速）→ v1.8.4/1.8.5 稳定性与性能收官（脏数据防御 + 千卡库优化）。
