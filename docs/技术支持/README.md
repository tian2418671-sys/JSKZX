# 🧰 技术支持文档索引（docs/技术支持/）

> 本目录存放**可复用的技术资产**：完整代码片段、实测技术数据、外部 API 参考、格式规范、探针工具。
> 与 `docs/bugs/` 的分工：那里写「坏在哪、怎么修」，这里写「**代码长什么样、实测数字是多少、外部接口怎么用**」。
> 最后整理：2026-09-13

---

## 一、代码片段（可直接查阅 / 移植 / 审查）

| 文档 | 内容 | 规模 |
|---|---|---|
| [代码片段-AI打标.md](代码片段-AI打标.md) | AI 打标 4 处代码完整汇总：自动打标规则表（纯常量）、规则式打标 + 后台落盘、AI 智能打标引擎（组合式）、AI 打标弹窗组件 | 约 800 行 |
| [代码片段-世界书条目名修复与导入.md](代码片段-世界书条目名修复与导入.md) | 世界书导出条目名缺失的修复代码 + 「从世界书库导入词条到角色卡」7 个修改点（精确锚点 + 可照抄的替换内容） | 约 230 行 |
| [代码片段-Git导入封存.md](代码片段-Git导入封存.md) | 已**移除**的「Git 链接导入插件」功能全部代码（主进程 IPC / preload 桥接 / 组合式 / UI），封存备查与将来恢复 | 约 230 行 |

## 二、实测技术数据

| 文档 | 内容 |
|---|---|
| [技术数据-大库压测与性能.md](技术数据-大库压测与性能.md) | 11,186 卡 / 9.76GB 与 22,372 卡 / 19.85GB 两大库的**全部实测数字**：加载分项、堆构成审计、P1a 前后对比、内嵌缓存 A/B、冷启动 I/O 量化、容量边界、移动版 500 卡压测 |

## 三、外部接口参考

| 文档 | 内容 |
|---|---|
| [API参考-酒馆插件渲染.md](API参考-酒馆插件渲染.md) | SillyTavern / JS-Slash-Runner 源码与官方文档整理：扩展模板渲染（Handlebars）、消息渲染（Showdown）、消息块 DOM 结构、`getContext()` 完整成员、事件系统、Slash 命令、脚本 API |
| [格式说明-插件格式.md](格式说明-插件格式.md) | 插件 JSON 扩展格式、支持的插件形态、本地目录扫描接入方式、工作区「📄 代码 / ✨ 效果」双卡 |

---

## 四、探针与工具脚本速查（`scripts/`）

### 发版与文档卫生

| 脚本 | 用途 |
|---|---|
| `release-check.mjs` | **发版前置自查**（语法 + 单测 + 构建 + 文档一致性 + git 状态），`--e2e dev/prod` 加跑端到端 |
| `check-doc-links.mjs` | 校验全仓库 markdown 的相对链接能否解析（当前 61 文件 / 106 条全有效） |
| `dev-run.ps1` | dev 启动（含终端编码修正） |

### 压测与容量

| 脚本 | 用途 |
|---|---|
| `capacity-check.ps1` | **一键压测**：自动挑最大库 → robocopy 造副本 → 写隔离 profile → 启 Vite+Electron → 轮询采样 → 汇总。`-Copies N` 造副本、`-ReplicaDir` 复用已有副本（⚠️ 不能写成 `-Replica`）、`-Keep -Hold` 保留现场 |
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

### 端到端 / 热测试

| 脚本 | 用途 |
|---|---|
| `chat-sidebar-test.mjs` | 测卡侧栏 7 分区（生产 `app://` 构建） |
| `chat-engine-test.mjs` | 测卡引擎管线（宏 / 世界书 / EJS / payload / 分段渲染 / swipe） |
| `builtin-cat-test.mjs` | 内置大分类定制：改名 / 隐藏 / 恢复 / 清理还原（**结束时还原，不破坏用户数据**） |
| `ai-category-modal-smoke.mjs` | AI 归类「自动建类」UI 冒烟（🆕 新建徽标与 optgroup 渲染） |
| `sanitize-live.mjs` | `sanitizeImportedTags` 开关的**真实导入**热测试（`probe` / `set` / `import` / `check` 四步） |
| `live-vector-test.cjs` | 在真实 Electron 主进程里验 `vectorManager`（标签展开 + 0.35 阈值）：`npx electron scripts/live-vector-test.cjs` |
| `prod-library-regression.mjs` | **生产模式**（`app://`，无调试句柄）卡库回归：首屏＋刷新×5＋搜索×5＋搜索中刷新，断言「真重复组恒为 0 / 计数不归零」（防 PK-01、PK-02、DF-08、DF-09 复活）。用法：`npx electron . --disable-gpu --remote-debugging-port=9350` + `$env:CDP_PORT="9350"` |
| `prod-ui-regression.mjs` | 生产模式 UI 回归（AR-18 正则·状态栏新增首条 / AR-19 添加要切 Tab）。⚠️ 卡片行选择器**尚未校准，当前未跑通**，仅作待修工具保留 |

### 落盘清洗验证（保存路径回归）

> 针对 `main/cardFieldSanitizer.js`（落盘前剥离前端内部字段）。**这套脚本的价值主要在反向用例**：
> 证明「递归剔除所有 `_` 前缀键」会删掉第三方真实数据（实测 7 类、131 处），因此实现改成了白名单。

| 脚本 | 用途 |
|---|---|
| `audit-card-underscore-fields.py` | 全库审计：列出真实卡片里**非前端内部**的 `_` 前缀字段与所有 `uid` 的位置和数量（`python scripts/audit-card-underscore-fields.py <库根> [张数]`）。改清洗规则前**先跑它**——这是判断「会不会误删用户数据」的唯一依据 |
| `audit-preset-worldbook-underscore.py` | 同上，但扫**预设 / 独立世界书**类 JSON（判据：`prompts`+`prompt_order` 或 `entries`）。结论：预设与独立世界书里无 `_` 前缀字段，但**独立世界书 `entries[i].uid` 大量存在**（DF-14「遗留待决」的依据） |
| `save-strip-live-ui.mjs` | **渲染层 4 处清洗点**的真实运行验证：`downloadJson` / 卡片内嵌世界书导入 / 独立世界书导入；反向断言第三方 `extensions._filename` 与扩展内部 `uid` 不被误删。全程只动内存，结束还原 |
| `save-strip-real-cards.mjs` | **离线**批量验证：抽真实卡片 → 注入 `uid`/`_collapsed` → 过清洗 → 断言注入字段被剔除、第三方字段 0 丢失、其余内容逐字段不变。`node scripts/save-strip-real-cards.mjs "I:\03\角色色卡"`（无需 Electron） |
| `save-strip-prep-samples.mjs` | 从库里挑出含第三方 `_` 字段的真实卡片，复制成样本到指定目录（给下面两个热测试用） |
| `save-strip-live-card.mjs` | **真实 IPC 链路**验证 PNG 卡片保存：渲染层 `readBuffer` → 注入污染 → `saveCard()` 真存 → 读回断言（含 PNG 结构完好、字节数一致）。前置：dev server + `--remote-debugging-port=9222` |
| `save-strip-live-worldbook.mjs` | 同上，覆盖另外 3 条落盘路径：`saveCard(.json)` / `wb:create` / `wb:save`（结束自动删样本，不动用户卡片库） |

⚠️ 跑热测试的两个坑（都实际踩过）：
1. 样本目录必须放 **`%APPDATA%\sillytavern-card-manager\`**（= `productName` 派的 userData），
   放 `%APPDATA%\JSK管理\` 会被 `isPathAllowed` 判「路径越界」——那不是功能 bug。
2. 脚本里的 Windows 路径**一律在 Node 侧用 `JSON.stringify` 生成字面量**，
   手工拼 `\\\\` 会产出双反斜杠路径，同样误报越界。


### 数据分析（多为一次性，保留备查）

| 脚本 | 用途 |
|---|---|
| `extract-all-tags.cjs` | 扫描卡库提取全部标签（PNG `tEXt` chara 块 + JSON），统计大分类覆盖 |
| `analyze-tags.cjs` | 提取 `app_config.json` 全部标签，跑分类，统计覆盖 |
| `vector-model-test.cjs` | 向量模型效果验证（正例命中率 / 负例误报率 / 分数分布，检验 0.65 阈值是否合理） |
| `scan-rejected-cards.cjs` | 在万卡库里找出「像角色卡但被血统鉴定拒绝」的 JSON |
| `scan-theme-accent.cjs` | 扫描浅色主题下可能看不清的强调色文字类（-200/-300/-400）与未覆盖的深色类 |
| `scan-theme-gaps.cjs` | 精确扫描：使用中但 `[data-theme="light"]` 未覆盖的深色类（含透明度变体） |

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
| 验证脚本 | `scripts/vector-model-test.cjs`（命中率 / 误报基线）、`scripts/live-vector-test.cjs`（真实主进程环境） |

> 完整的现象 / 根因 / 修复 / 防再犯，见 [`../bugs/BUG-AI打标与标签.md`](../bugs/BUG-AI打标与标签.md)（AI-03、AI-04）。
