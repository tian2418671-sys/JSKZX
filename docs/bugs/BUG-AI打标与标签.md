# AI · BUG 记录 — AI 打标与标签体系

> 领域：AI 打标三层漏斗（**规则 → 本地向量 → LLM**）与标签体系（原生 `data.tags` / 全局标签池 / `customTags` / 大分类）。
> 相关代码：`js/composables/useAITools.js`、`js/composables/useTags.js`、`js/utils/tagCategories.js`、
> `js/components/AITagModal.vue`、`js/components/TagCategoryModal.vue`、`main/vectorManager.js`、`main/vectorWorker.js`
> 总索引见 [`README.md`](README.md)。

---

## 一、打标过程中的崩溃与进度（AI-01）

### AI-01 ｜ 🔴 AI 打标时渲染进程崩溃（每打一张卡就全库重建索引）
- **现象**：批量打标跑到几千张卡时渲染进程 native 崩溃 `{"reason":"crashed","exitCode":-36861}`（= `0xFFFF7003`，Chromium 层崩溃、无 JS 堆栈）；日志里「⚡ Token 缓存预热完成」后立即崩溃。
- **根因（三层定位后的真凶）**：打标每改一张卡 → `persistCardUpdate` → `flushLibraryReactivity`（**100ms 防抖**）→ `triggerRef(library)` → 触发 `watch(library)` → **全量重建搜索索引 + Token 预热**。而打标 LLM 层每卡间隔 **1500ms > 100ms 防抖** → 等于**每打标一张卡就全库重建一次索引**（几千张卡逐字符分词 + Token 估算），渲染进程 CPU/内存持续峰值。
- **修复**：
  - `App.vue`：`watch(library)` 检测到 `isAITagging` **跳过全量索引重建**，置 `pendingRebuild` 标记并取消在途任务；打标结束（`isAITagging → false`）延迟 250ms **补建一次**；
  - `useAITools.js`：三层漏斗里全部 `library.value.find()` 的 O(n²) 改为 `Map` O(1) 索引（`cardIndex`）；
  - 规则匹配层：实时进度（每张 `current+1`）+ 每 64 张 `await` 让出主线程；
  - 向量匹配层：把 `vector:batchProgress` 事件合并进 `aiTaggingProgress`（原来进度条不动）；
  - **LLM 层索引 bug**：`currentId = targetIds[i]` → **`llmTargetIds[i]`**（旧代码给错误的卡重复打标、漏掉真正该兜底的卡）；
  - `tokenEstimate.js`：超长文本（>200KB）先截断再估算，避免 `match/replace` 产生巨型临时数组；
  - `main.js`：加 `crashReporter`（本地 `.dmp`，`uploadToServer:false` 不联网）+ `render-process-gone` 详情落盘 `crash.log` + `crashed/oom/killed` 时 1.5s 后自动 `win.reload()`。
- **来源**：v2.0 向量与打标专项（2026-08-29）

---

## 二、三层漏斗的协同（AI-02）

### AI-02 ｜ 🔴 三层漏斗互斥 —— 规则命中就跳过向量层
- **现象**：用户反馈「实际使用时一直规则命中」，本地向量模型**永远用不上**，规则与向量不协同。
- **根因**：漏斗把两层做成**互斥短路**：`ruleHitIds`（规则命中）不进向量层。
- **修复**（`useAITools.js`）：
  - 规则命中的卡**仍进向量层**做语义补充：`vectorTargetIds = [...rulePassedIds, ...ruleHitIds]`；
  - 规则 + 向量都未命中 → 才交 LLM 兜底；向量层重建 `llmTargetIds` 时用 `rulePassedSet` 精确判定。
- **契约（不能破坏）**：`vectorManager.batchMatch` 对**每张传入卡都返回 result**（未命中返回 `tags: []`），所以前端按 results 重建 `llmTargetIds` 不会丢卡。
- **防再犯**：**多阶段漏斗应是「协同」而非「互斥短路」** —— 前一阶段命中 ≠ 后续阶段跳过，除非业务明确要求短路。排查所有 `if (命中) { … return; }` 是否真的该短路。
- **来源**：v2.1.0 漏斗协同专项（2026-09-01）

---

## 三、本地向量引擎（AI-03、AI-04）

### AI-03 ｜ 🔴 向量模型「无效」—— 阈值与文本形态不匹配
- **现象**：本地向量匹配（第二层）几乎 **0 命中**，等于没启用。
- **根因（实测）**：`paraphrase-multilingual-MiniLM-L12-v2` 下，「**长卡片文本 vs 1-2 词短标签**」的余弦相似度被压到 0.2~0.5，**永远够不到原阈值 0.65**。
- **修复**：
  1. 默认阈值 **0.65 → 0.35**，且**三处必须对齐**：`useAITools.js` / `AITagModal.vue` / `vectorManager.js DEFAULT_THRESHOLD`；
  2. **标签展开**：短标签先展开为描述句再嵌入 —— `LABEL_TEMPLATE = '这是一个关于{label}的故事'`；
     展开文本**同时作为缓存 hash 输入**（模板变化 → hash 变 → 缓存自动重建，不会误用旧向量）。
- **实测**：展开后 0.35 命中率 **80%**（强相关），误报基线最高 **0.307** → 0.35 安全。
- **防再犯**：**语义匹配的阈值必须按"真实文本形态"验证**（长文 vs 短词 的绝对相似度远低于 长文 vs 长文）；改阈值/模板后必须重跑 `scripts/vector-model-test.cjs` 确认命中率与误报基线。
- **来源**：v2.1.0 向量阈值专项（2026-09-01）

### AI-04 ｜ 🟡 向量模型下载链路三坑（首次使用可能"卡住/失败"）
- **模型**：`Xenova/paraphrase-multilingual-MiniLM-L12-v2`（quantized），实际下载 4 个文件（config / tokenizer 17MB / tokenizer_config / `onnx/model_quantized.onnx` 113MB），缓存路径 `userData/hf_cache/Xenova/…`。
- **三个坑（实测得出）**：
  1. **hf-mirror 会 RST 掉 transformers.js 的 UA**（`transformers.js/x.y.z`）→ 必须在 `require` transformers **之前**包装全局 `fetch` 注入浏览器 UA；
  2. **`raw.githubusercontent.com` 国内极慢**（0.1MB/s）→ 必须走加速代理：`https://gh-proxy.com/https://raw.githubusercontent.com/...`（gh-proxy / ghfast 实测 5-10MB/s）；
  3. **GitHub 单文件 100MB 限制** → onnx 拆成 **8 片**（各 ~14MB）`onnx/model_quantized.onnx.part1..part8`。
- **下载源顺序**（`main/vectorWorker.js`）：① hf-mirror（国内 ~9MB/s）→ ② huggingface 官方 → ③ GitHub 仓库兜底（分片 + 断点续传 + `tmp/rename` 原子写 + 120s 超时）；兜底一律用 **Node fetch**（`curl.exe` 访问 GitHub raw 有 000/截断问题）。
- **验证**：强制走兜底通道，**16.9s** 完成 113MB 模型加载 ✅
- **排查提示**：跑「**源码版**」才有效 —— 用户曾报「还是下载失败」，根因是跑的是 `dist` **打包旧版**（无修复）。开发/排查请用 `npm start`（先 `build:web` 再 `electron .`）。
- **来源**：v2.0 向量与打标专项（2026-08-29）

---

## 四、「忽略卡片自带标签」开关的三次修补（AI-05 ~ AI-07）

> 同一个开关（`sanitizeImportedTags`）在不同版本被修了三次，根因各不相同。**这是本领域最容易反复踩的地方**，改动前务必读完三条。

### AI-05 ｜ 🔴 开关「时灵时不灵」—— 4 个消费点被绕过
- **现象**：开启开关后，被忽略的杂乱原生标签仍在**部分界面/搜索**中出现。
- **根因**：开关只在**导入路径**生效，显示/搜索/索引等消费点没接入：
  - `SidebarPanel.vue`（列表标签显示）直接合并原生 `data.tags`；
  - `App.vue` `activeCardTags`（激活卡标签）同样；
  - `useSearch.js` 的 `extractCardTags` 不过滤原生 tags；
  - `searchIndex.js` 的 `indexTagsFn` 不过滤原生 tags。
- **修复**：`extractCardTags(item, { ignoreNative = false })`，**4 处调用点全部传入** `sanitizeImportedTags.value`。
- **防再犯**：**凡是「配置开关」，必须全链路排查所有消费点**（显示 / 搜索 / 索引 / 统计 / 导出），不能只看定义和开关 UI —— grep 开关名 → 逐个验证消费点。
- **来源**：v2.1.0 配置开关全链路排查（2026-09-01）

### AI-06 ｜ 🔴 开关对「自动打标规则标签」无效 + 4 条提前 return 绕过
- **现象**：开关打开后导入**全新**卡片，仍被贴上「Fantasy (奇幻)」「Romance (恋爱)」等标签。
- **根因（两层）**：
  1. **直接原因**：v2.1 引入的 44 条系统预设规则（`cardLoader.js` `defaultAutoTagRules`）**默认全部生效、无整体关闭入口**，导入时对每张新卡跑正则，命中即写入 `customTags` 并物理写回 PNG；而开关**只清空卡片自带的原生 `data.tags`**，从不拦截规则标签。
  2. **次生缺陷**：原生 tags 的清空只在「自动规则兜底分支」执行 —— 以下 4 条**提前 return** 的分支会绕过物理清洗（外来标签残留内存与磁盘，关闭开关后复活、混入全局标签池）：
     `subFolder`（物理子文件夹卡）、覆盖层命中（`app_config.cardOverlays`）、`importedConfig`（库配置导入，还会把历史外来标签**复活进新卡 customTags**）、`localCategoryMap`（localStorage 手动分类，**按卡片名永久累积命中**）。
- **开关的真实契约**（`App.vue` 注释）：「开启后**仅保留自动分类结果**」—— 开关开启时导入只保留**分类**，不附加任何标签（既不含卡片自带，也不含规则生成）。
- **修复**（`useCardCrud.js` `processAutoTagsAndCategory`）：
  1. **物理清洗上移到函数入口**：开关开启时先于所有分支清空原生 `data.tags`（兼容数组与 V1 字符串形态），堵住 4 条提前 return；用户标签仍由覆盖层随后恢复；
  2. **规则循环改为只定分类**：开关开启时规则命中只更新 `assignedCategory`，不再 push 进 `generatedTags/customTags`；开关关闭时逐条件保持原行为；
  3. 删除兜底分支内重复的清空代码。
- **验证**：`test/sanitizeImport.test.mjs`（7 用例，直接调生产函数：开关开+全新卡 / localCategoryMap / 覆盖层 / importedConfig / 子文件夹 / V1 字符串 tags / 开关关闭对照）+ `scripts/sanitize-live.mjs` 真实库 CDP 热测试（customTags 空、nativeTags 空、全局池无污染、自动分类照常；对照关闭时行为无回退）。
- **防再犯**：**开关只清一个字段是不够的** —— 要先写清「开关契约」，再 grep 所有会写入标签的路径（规则 / 覆盖层 / 配置导入 / localStorage 分类缓存）。
- **来源**：v2.2.1 导入清洗专项（2026-09-07）

### AI-07 ｜ 🟡 历史卡的外来标签无法清洗（开关只对新导入生效）
- **现象**：`sanitizeImportedTags` 开关「体感无效」—— 历史卡上的外来标签清不掉。
- **根因**：开关只对新导入生效；**历史卡的外来标签早已被收编进 `customTags` 并经 `persistCardUpdate` 永久写回 PNG**；而 `globalAvailableTags` 无条件聚合 `customTags` → 表现为「开关无效」。
- **修复**：新增 `useTags.cleanForeignTagsFromLibrary` —— **白名单反向清洗**（系统/常用标签库 + 自动打标规则 + 手动归类 + 自定义关键词库；大小写不敏感、兼容 V1 字符串 tags），`customTags` 与原生 `data.tags` **双清**、确认预览、`runWithProgress` 逐张物理落盘；HeaderBar 设置菜单加入口，并把开关文案澄清为「**仅对新导入生效**」。
- **验证**：`test/cleanForeignTags.test.mjs` + Electron CDP A/B 端到端（`scripts/sanitize-live.mjs`）。
- **来源**：v2.2.1 历史污染清洗（2026-09-04）

---

## 五、标签分类体系（AI-08）

### AI-08 ｜ 🔴 自定义分类 key 碰撞 → 标签归属错乱
- **现象**：AI 一次应用里**连续新建多个分类**时，不同名的分类共用同一个 key → 标签归属错乱、UI 出现**重复条目同显一批标签**。
- **根因**：`addCustomTagCategory` 的 key = `Date.now().toString(36)` —— **同一毫秒内连续建多个类就碰撞**。
- **修复**：key **追加随机段**；新增 `normalizeTagName`（零宽 / 全角 / NBSP 折叠）判重；`add` 幂等返回已有 key；`mergeDuplicateTagCategories` 合并同名变体；`ensureUniqueCustomCategoryKeys` 修复历史同 key 数据。
- **相似缺陷全查**：全仓 `toString(36)` / 时间戳 key 生成**均已带随机段或唯一后缀**（含 `uid` 生成），无其它裸时间戳 key ✅
- **防再犯**：**凡用时间/计数生成 ID，必须加随机段**；批量操作（一次建多个）是这类碰撞的高发场景。
- **来源**：v2.2.1 AI 归类转正（2026-09-04）

---

## 六、本领域改动前的自检清单

1. 改**打标流程**后：确认 `isAITagging` 期间不会触发全量索引重建（[AI-01](BUG-AI打标与标签.md#ai-01--ai-打标时渲染进程崩溃每打一张卡就全库重建索引)），并跑 `npm test` + 端到端。
2. 改**漏斗顺序/短路**：先看 [AI-02] 的协同契约，别把「命中即跳过」写回去。
3. 改**向量阈值 / 模板 / TopK**：三处（组件 / composable / 主进程 manager）**必须对齐**，并重跑 `scripts/vector-model-test.cjs`。
4. 改**任何标签开关**：按 [AI-05] 的方法 grep 开关名，逐个验证消费点（显示 / 搜索 / 索引 / 统计 / 导出）。
5. 改**分类/标签写入路径**：记住「用户主动打标的数据必须三保险」—— 内存 + 覆盖层（`app_config.json`）+ PNG 物理写回（配合 [DF-12](BUG-数据与文件.md) 的落盘加固）。
