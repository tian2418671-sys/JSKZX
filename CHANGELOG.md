# SillyTavern 角色卡管理器 · v1.6.2 → v2.2.0 更新汇总

> 更新周期：2026-08-15 ~ 2026-09-04
> 技术栈：Electron + Vue3 + Tailwind + ECharts

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

### � 更新后静默升级（新功能）
- **根因定位**：真正导致「更新 = 重装向导」的不是 oneClick，而是 `sys:installUpdate` 里**无参 `quitAndInstall()`**——`isSilent` / `isForceRunAfter` 默认均 false → 以非静默方式运行安装器（assisted installer 弹界面）、装完不自动重启
- **最小修复 1 行**：`autoUpdater.quitAndInstall(true, true)`（`isSilent=true` 静默升级；`isForceRunAfter=true` 装完自动重启）
- 首次安装自定义目录已支持：`oneClick:false` + `allowToChangeInstallationDirectory:true`（assisted 向导可自选 D/E 盘），无需改动
- ⚠️ 关键前提：保持 per-user（package.json **勿设 `perMachine:true`**）——否则装到 C:\Program Files，静默更新因无 UAC 提权写入失败（EACCES）

### �🐛 Bug 修复（8 项，含根因）

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
