# 🤖 AI 交接指导手册 — SillyTavern 角色卡管理器（JSK管理）

> 本文件是**给下一个 AI 接手时阅读的总纲**：把所有历史会话、当前状态、架构、关键坑、工作流浓缩在此。
> 下一任 AI 只需读完本文件 + 必要时查阅 `README.md` / `RELEASE_NOTES.md` / `CHANGELOG.md` / 仓库记忆 `electron-notes.md`，即可无缝续写。
> 最后更新：2026-08-23

---

## 一、30 秒速览（必须知道）

| 项 | 值 |
|---|---|
| 项目 | SillyTavern（酒馆）角色卡本地管理桌面工具 |
| 技术栈 | Electron 43.x + Vue 3.5 (Composition API + SFC) + Vite 8 + Tailwind 3 + ECharts 6 + electron-builder 26 + electron-updater + sharp |
| 仓库 | `https://github.com/tian2418671-sys/JSKZX.git`（远端 `origin`） |
| 当前版本 | **v2.0.0**（已发布）；本地开发分支领先 origin 若干 commit（含向量下载+打标崩溃修复），**待用户指令推送** |
| 当前分支 | 本地 `master`；远端还有 `trae/agent-Fxvvsf`（已合入 master，可删） |
| 构建产物 | `dist/sillytavern-card-manager-<版本>.exe`（NSIS 安装版）+ `latest.yml` + `.blockmap` + zip 绿色版 |
| 用户习惯 | 「一条龙服务」= 升版本号 → 更新文档 → 打包 → 推送 → 发 GitHub Release（含 latest.yml 保 OTA） |
| 关键用户要求 | **没收到推送/打包指令禁止推送/打包**；用户会先自己看效果再决定；08-29 明确「只构建开发版，不打包 exe/zip、不上传发布、保持本地」 |
| 文档体系 | `README.md`（完整开发文档）+ `RELEASE_NOTES.md`（对外更新日志）+ `CHANGELOG.md`（内部详细）+ 本文件 |

---

## 二、当前状态（接手时点）

### 2.1 Git 状态
```
本地 master:  df3b78b (HEAD)  领先 origin 2 个提交
  ├─ 332c437  fix: 世界书库条目显示触发词被当作名字——列表与导入弹窗改为名字主显示、触发词副显示
  └─ df3b78b  fix: 世界书库IDE名字输入框标签改为「名称 / 备注 (Comment)」，与角色卡内嵌一致
origin/master: 573176d = v1.8.9 发布提交
远端分支:      origin/trae/agent-Fxvvsf（内容已合入 master，可删除）
工作区:        干净（无未提交改动）
```

### 2.2 待办（用户最后指令是「不打包等待命令」）
- ⏸️ **未推送** 2 个 commit（`332c437` / `df3b78b`）——用户确认后可 `git push`
- ⏸️ **未打包 / 未发 Release** —— 用户说「需要时告诉我」，下一版升 **1.8.10**
- ⏸️ 远端多余分支 `trae/agent-Fxvvsf` 待用户确认后删除
- 🟡 已知遗留：`switchToSecondGreeting is not defined`（index.html 有引用但未定义，附加问候语功能，低优先级）

### 2.3 最近一次「一条龙」流程回顾（v1.8.9，供复制）
拉取合入远端新分支 → bump 1.8.8→1.8.9 → RELEASE_NOTES/README 同步 → `npm run build`（⚠️ 需先杀进程防 EBUSY，且 `build:web` 的 rmSync 曾未真正清空 web/ 需强删）→ asar 校验 → 冒烟 → commit+push → `gh release create v1.8.9` 上传 exe+latest.yml+blockmap+zip → 验证 OTA 链路 HTTP 200。

---

## 三、项目架构

### 3.1 分层
```
main.js            Electron 主进程（CJS）：app:// 自定义协议、全部 IPC、路径白名单、
                   快照备份、PNG 读写(writeTavernPNGChunk/readTavernPNGChunk)、
                   世界书扫描、全盘打捞真伪鉴定、OTA(electron-updater)
preload.js         contextBridge 暴露 window.electronAPI（~30+ API）
js/entry.js        渲染进程入口（createApp(App) + errorHandler）——注意不是 js/main.js（已改名避免混淆）
js/components/     30 个 SFC 组件（App.vue 根 + 21 子组件 + 弹窗）
js/composables/    17 个组合式函数（业务逻辑主体，App.vue setup 尾部调用注入）
js/utils/          cardLoader.js（卡解析/规范化）、pngParser.js（PNG 块解析）、tokenEstimate.js
css/               tailwind.css（源）/ style.css（自定义）
web/               vite build 产物（生产加载，gitignore）
test/              46 个单测（node:test，`npm test`）
```

### 3.2 Composables 职责速查（17 个）
| 文件 | 职责 |
|---|---|
| `useCardCrud.js` | 卡片 CRUD 域（导入/删除/持久化/自动分类打标/导出重命名），v1.8.8 迁出（-460 行） |
| `useConfigPersistence.js` | 统一配置持久化中枢（syncConfigToDisk 21 个 ref + API Key 加密 + 原子落盘 + isRestoringConfig 闸门） |
| `useEmbeddedWorldbook.js` | 角色卡内嵌世界书（词条派生/WeakMap uid/折叠/触发词编辑） |
| `useWorldbooks.js` | 世界书库与分组 |
| `useWorldbookEntries.js` | 世界书词条 IDE 编辑 |
| `useWorldbookExtras.js` | 世界书扩展（提取为世界书/JSONL 导入等） |
| `useAITools.js` | AI 打标/翻译/格式升维 |
| `useChat.js` | 聊天测卡 |
| `useGraph.js` | 关系图谱（v4：头像限流/连线预算/位置种子/构建缓存） |
| `useDedupe.js` | 查重与差异比对 |
| `useSnapshots.js` | 历史快照 |
| `useCardGroups.js` | 角色卡分组/分类 |
| `useBatch.js` | 批量操作 |
| `useDiskScan.js` | 全盘打捞 |
| `useGlobalEntrySearch.js` | 全库词条搜索 |
| `useSearch.js` | 搜索过滤 |
| `useTags.js` | 标签系统 |

### 3.3 组件依赖关系
- `App.vue` 是唯一根组件，setup 里集中所有状态/方法 → `provide('appCtx', ctx)` → 子组件 `inject('appCtx')` 解构使用
- 子组件：`HeaderBar` / `SidebarPanel` / `EditorPanel` / 弹窗类（AITagModal/GraphModal/SnapshotModal/WbImportModal/DiffModal 等）/ 纯展示类（DragOverlay/ToastContainer 等）
- ⚠️ **任何新状态/方法加入 ctx 必须同时：定义 + useXxx 解构 + ctx return 暴露 + 子组件 return 解构**，漏一处即「proxy undefined」

### 3.4 数据流与存储
- **卡片**：物理文件（PNG/JSON/WebP），`parseAndAddCard` 生成随机 id（`card_时间戳36_随机`）；真实路径存 `card.path`；文件操作全用 `.path`
- **配置权威**：`userData/app_config.json`（原子写入 tmp+rename），统一收口 globalTags/customCategories/removedDefaultKeys/tagLangMode/cardOverlays/api/ui 等
- **卡片用户配置覆盖层**：`appConfig.cardOverlays[path]` 记忆用户手动分类/标签，重扫/重启不冲刷
- **快照**：同目录 `.bak_history/`（卡）+ `userData/jsTavern_Backups/worldbooks`（书），内容哈希去重 + 超量清理
- **回收站**：`userData/jsTavern_Trash`（全局，绝不物理删除）；卡片另有 `.trash/`

---

## 四、会话历史总结（时间线）

> 全部会话发生在 2026-08-09 ~ 08-23。以下按时间顺序总结每个会话的核心工作，便于追溯「某个功能/修复是哪个会话做的」。

### 📅 2026-08-09（早期版本 v1.0~1.2）
- **会话 a88e309d**「进行功能测试后在打包」：初版功能测试与打包流程建立（v1.0 发布）
- 早期功能基础：卡片导入/解析/编辑/标签/分组/关系图谱雏形

### 📅 2026-08-10
- **会话 19151ecc**「暂时不用，放到别的文件夹备用」：部分功能暂缓，打包产物归置

### 📅 2026-08-11
- **会话 5445a144**「无了歇着了」：当日收尾

### 📅 2026-08-12（v1.2~1.3 大量功能）
- **会话 cdec13d1**「这里也更新」：三主题（dark/slate/light）、路径记忆、侧边栏瘦身、词条 IDE 折叠、右键菜单增强（打开文件夹/复制/打标/回收站）、世界书查重引擎、版本更新检测系统（GitHub API 探测+浏览器跳转）、启动防闪烁、分类持久化、标签中英切换、批量标签弹窗、全局深度搜索、快照与回收站、一键导出整合包、多语言分组系统、关系图谱多轮升级（布局/搜索/权重/隔离/三色连线/枢纽高亮）、Token 估算器、全局资产中心、多选与右键菜单、系统/全局标签库、系统快捷过滤（has_lorebook/has_regex）、P0 加固（CDN 本地化 vendor/、崩溃兜底）、P2 API 鉴权可配置
- **关键教训沉淀**：Vue 弹窗必须在 `#app` 闭合 `</div>` 之内；`window.prompt/confirm/alert` 在 Electron 静默失败必须用自建弹窗/confirmDialog/nativeAlert；IPC 传响应式 Proxy 报「An object could not be cloned」

### 📅 2026-08-13（v1.3~1.4 世界书双引擎）
- **会话 34c55ad1**「推送打包上传」：世界书双引擎模式（appMode characters|worldbooks）、词条级 IDE（Entry IDE）、智能查重与版本清洗、高分屏 DPI 适配、世界书库文件夹导入/删除/克隆/右键菜单、世界书分组功能（持久化 wbCategoryMap）、统一 IPC 落盘拦截器、世界书严格防伪（isValidWorldbook）、Shift 连选错位回归修复、卡片高亮对象引用比较、360 锁 app.asar 绕法（dist_new）、三连「BUG」审查（确认多数为误报，补 openWbInFolder）
- **会话 c1534f36**「编译成安卓版有难度么」：纯咨询，未实施（Electron 转安卓不可行，未改动代码）

### 📅 2026-08-14（v1.5 SFC 化 + Vite 工程化）
- **会话 6b37f45c**「打开前端」：**Vite + Vue3(SFC) + Tailwind CLI 工程化大升级**（commit 49bcd10）——index.html 模板迁入 App.vue（2047 行模板+4676 行 setup）、vue 必须完整版 alias、勿加 type:module、ECharts npm 化；随后 SFC 化十步走（拆出 21 个子组件 + 根，全程 provide/inject ctx 共享）；列表/网格双视图（固定 2 列 padding 技巧）、全屏拖拽导入遮罩（深度计数器）、防系统打开图片加固（will-navigate+setWindowOpenHandler+draggable=false）、AI 一键汉化/格式升维、全局 Toast、搜索防抖+扩展快捷键、图片懒加载+拖拽把手、可拖拽分栏
- **关键坑**：组件注册名大小写（AI→AiTagModal 才能被 kebab 标签解析）；纯 Options API 组件模板不能用模块级 import 函数（挂 methods 或 setup 返回）；Toast 容器必须在 #app 内

### 📅 2026-08-16（v1.6.x 修复 + 安全加固）
- **会话 574f8410**「世界书/角色库目录 BUG 反馈」：验证双引擎目录分离架构本身正确（用户方案基于原型变量名，多数为误报）；**统一持久化中枢 app_config.json**（原子写+防冲刷覆盖层+API 三件套物理落盘）；全盘深度检索引擎（DiskScanModal 完整功能版）；角色卡血统严格鉴定（isCharacterCardData 拦截聊天记录/孤立世界书/主题）；**win10 21H2 导入不了任何卡片**根因修复（IPC 白名单→改用浏览器 File API rawBuffer/rawText 绕过）；jpg 卡片支持修复；破碎图标修复（blob URL→local-file:// 永久路径+先落盘到库目录）
- **会话 710c2139**「覆盖更新」：v1.6.x 覆盖发布
- **会话 d8d34bb6**「只对我这台机器修改」：**360 沙箱拦截系列**——GPU 沙箱（disable-gpu-sandbox，已入源码）与渲染进程沙箱（--no-sandbox 只在用户桌面快捷方式加参，**不改源码**，用户明确要求）；OT：`--disable-gpu` 无效、LoadLibrary 验证 DLL、事件日志异常码 0x80000003

### 📅 2026-08-17（v1.7 物理分组 + 快照）
- **会话 231953d6**「我是在问你问题不是在修改代码」：**物理文件夹分组系统**（分组=库目录下一级子文件夹，移动=物理移动文件，fs:createGroupFolder/renameGroupFolder/moveCardToGroup）；**历史快照可配置系统**（snapshotConfig enabled/interval/maxSnapshots + processCardSnapshot + cleanupOldSnapshots）；标签批量删除；删除卡片自动清理空分组；v1.7.0 发布

### 📅 2026-08-18（v1.8 性能 + 组合式重构）
- **会话 9a9e8a38**「一条龙服务 1.8.1」：批量 BUG 修复（排序物理时间 mtime/birthtime、全局标签池受 sanitize 开关控制、自动分类不建幽灵分组、pngParser iTXt 偏移、异步竞态守卫、双协议 max_tokens、js/main.js→js/entry.js 改名）；**千卡库性能大修**（主进程扫描异步化/自动打标 I/O 风暴治理/分块加载/Token 缓存/Schwartzian 排序）；安全加固（wb:scan 白名单后门修复/restoreSnapshot 越界封堵/符号链接环路防护）；快照一键恢复+一键清理；AI 打标破限+429 退避；配置防竞态终极修复（isRestoringConfig 统一闸门）；v1.8.1 发布

### 📅 2026-08-19（v1.8.2 组合式拆分 + 静默升级）
- **会话 737a0174**「更新记录准备一条龙」：**composables 拆分**（App.vue 拆 6 个 composables：useAITools/useCardGroups/useDedupe/useSnapshots/useWorldbookEntries/useWorldbooks）；**🔴 TDZ 回归修复**（snapshotConfig 状态提升回 App.vue 顶层注入——composables 拆分的经典坑，vite build 不报错但运行时崩溃，必须真实启动验证）；换卡图功能（sharp + card:replaceImage IPC + 结构校验）；快照前缀互串修复（escapeRegExp+snapshotRe+isSnapshotOf 精确匹配）；白名单 removeAllowedRoot 无条件回收缺陷修复（preAuthorized 守卫）；**静默升级**（installUpdate 用 quitAndInstall 参数实现静默覆盖，免重装向导）；下拉菜单改造（用户强烈要求层级修复）；Vue DevTools 可视化开发环境（vite-plugin-vue-devtools）；AI 自检清单流程引入
- **会话 08b8472a**「Windows自带的杀毒或360」：杀软相关排查/说明

### 📅 2026-08-20（v1.8.3 图谱卡顿 + 全盘打捞）
- **会话 d324d31e**「一条龙服务吧」：**关系图谱卡顿修复 v3/v4**（连线预算 MAX_LINKS、超大群体跳过、构建缓存、移除 layoutAnimation:false、头像限流 IMAGE_NODE_LIMIT/HUB、标签预算、位置种子 capturePositions、bigram 预过滤）；**全盘打捞 V3 真伪鉴定**（validateCardFile 三级流水线）+ V3.1 库内排除+无库引导；收编 IPC 克隆错误修复（reactive 数组 JSON 剥离）；关系图谱 ctx 漏暴露修复（exportGraph/graphStats/graphBuilding）；按钮合并（关系图谱唯一入口）；v1.8.3 发布

### 📅 2026-08-21（v1.8.4/1.8.5 稳定性 + 文档）
- **会话 912d5217**「覆盖更新发布上传」：**v1.8.4** 导入 JSON 卡空屏崩溃修复（extractBookEntries 脏形态全链路防御）；**v1.8.5** 千卡库性能大修落地 + README 全面重写（16 章节全量同步）+ 新版本角落提醒浮标（右下角 z-[90]，静默检测不打断）；覆盖发布流程踩坑（**latest.yml 必须上传**否则 OTA 404 静默失败；electron-builder 假死=网络下载 Electron 二进制勿误杀；离线打包 electronDist 复用本地 node_modules）；删除远端多余分支

### 📅 2026-08-22（v1.8.9 世界书导入导出 + 条目名修复）
- **会话 da9ed8ba**「不打包等待命令」：拉取合并远端 `trae/agent-Fxvvsf` 分支（**世界书导入导出功能**：📥 从世界书库导入词条到角色卡，复用 WbImportModal，与「📤 提取为世界书」双向闭环）；修复世界书导出条目名缺失（name→comment 映射 + insertion_order→order 回退，见 `DM-世界书条目名修复与角色卡导入.md`）；**世界书库条目名字/触发词显示混乱修复**（UI 显示层：名字主显示+🔑 触发词副显示，commit 332c437；名字输入框标签改「📝 名称 / 备注 (Comment)」，commit df3b78b）；v1.8.9 发布
- ⚠️ **最后状态**：2 个修复 commit 已提交但**未推送未打包**，用户说「不打包等待命令」

### 📅 2026-08-23（本工作区之外的会话）
- 会话 ded86a3f / 1443a95f / 29bf9088（cwd=h:\01\北派盗墓笔记，仓库 gui.git）：另一个项目（小说→世界书/UI 前端），与本 JSK管理 项目无关，**不要混淆**

### 📅 2026-08-29（向量模型下载 + AI 打标崩溃修复 + v2.0 性能优化）
- **向量模型下载链路修复**（commit 40b68f8）：本地向量引擎 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 三源下载（hf-mirror → huggingface → GitHub 仓库兜底）+ onnx 8 片断点续传 + 注入浏览器 UA 绕过 hf-mirror RST。详见 `memory/2026-08-29.md`
- **AI 打标渲染进程崩溃修复**（exitCode -36861）：根因是打标每改一张卡 → `triggerRef(library)` → `watch(library)` 全量重建搜索索引 + Token 预热，几千张卡 × 正则/分词 → 渲染进程 native 崩溃。修复：打标期间跳过索引重建（`pendingRebuild` 标记），打标结束补建一次
- **AI 打标进度条修复**：规则匹配层实时进度（原卡「0」不动）；向量匹配层把 `vector:batchProgress` 合并进 `aiTaggingProgress`；三层 O(n²) find → O(1) Map；修复 LLM 层 `targetIds[i]`→`llmTargetIds[i]` 索引 bug
- **v2.0 性能优化**：useCardCrud `seenPaths` O(1) 去重 + 流式批量拉取（readTextBatch/readEmbeddedBatch 分块 IPC）；useWorldbooks/Extras `triggerRef`；pngParser 大卡兜底；tokenEstimate 超长文本防护
- **崩溃兜底**：main.js 加 crashReporter（本地 .dmp）+ render-process-gone 落盘 crash.log + 自动 reload 恢复
- ⚠️ **当前状态**：全部改动已提交但按用户要求**未打包未发 Release**；用户要求「不打包绿色版/exe、不上传发布、保持本地」

---

## 五、🔴 关键坑清单（接手的 AI 必读，全部来自实战踩坑）

> 完整版（含全部 606 行细节）在仓库记忆 `electron-notes.md`。以下是最高频、最致命的前 20 条。

### 5.1 Electron / 架构级
1. **IPC 不能传 Vue 响应式 Proxy**：报 `An object could not be cloned`。IPC 前必须 `JSON.parse(JSON.stringify(x))` 剥离（getPlainCardData 模式）。排查搜索 `electronAPI.xxx(this.` / `electronAPI.xxx(foundFiles`。
2. **Electron 中 `window.prompt/confirm/alert` 静默失败**（prompt 返回 null、confirm 返回 null、alert 不显示）。一律用 `appPrompt`（自建弹窗）/ `confirmDialog` / `nativeAlert`。`nativeAlert` type 只能用 `none/info/error/question/warning`（无 success）。
3. **`window.open`/新窗口**：主进程 `setWindowOpenHandler(() => ({action:'deny'}))` + `will-navigate` 拦截非 app:// 导航，防拖放文件触发系统打开图片。
4. **`app://` 协议加载页面**（勿用 loadFile，ESM 有 CORS 问题）；协议 handler 必须做路径穿越校验（`resolved !== root && !resolved.startsWith(rootPrefix)` 才放行）。
5. **主进程路径白名单 isPathAllowed**：所有文件 IPC 必须过白名单。⚠️ removeAllowedRoot 无条件回收会误删库根（修复模式：`preAuthorized` 先查再决定是否回收）。
6. **组合式函数 TDZ 回归**：composables 里的 ref 若被 App.vue setup 更早位置引用 → 运行时 ReferenceError（vite build 不报错！）。拆分后必须 `npx electron . --enable-logging` 真实启动冒烟；解法=状态提升回 App.vue 顶层注入。
7. **preload `on*` 事件带 removeAllListeners 的只能一个组件绑定**（多组件需 App 收口 + prop 转发，否则监听互相清掉）。
8. **无 electronAPI 降级**（纯浏览器开 localhost:5173）：onMounted 先置 isAppLoading=false 再 return，否则卡启动蒙版。

### 5.2 Vue / 渲染层
9. **Vue 弹窗必须放在 `#app` 闭合 `</div>` 之内**，否则完全不编译（`{{ }}` 原样显示、v-if 失效）。定位用 div 深度配平脚本。
10. **组件注册名大小写**：首字母连续大写的组件名（AI/XML/URL 开头）kebab 标签解析不了——注册名必须用小写化形式（`AiTagModal` 而非 `AITagModal`）。props 无此问题。
11. **纯 Options API 组件（无 setup）模板不能直接用模块级 import 的函数**（报 `_ctx.xxx is not a function`，弹窗"点不开"）。挂 methods 或加 setup return。
12. **shallowRef 深层修改不触发响应式**：`cardData` 是 shallowRef，深层编辑后必须 `refreshCardData()`（triggerRef）。所有编辑框加 `@input="refreshCardData"`。
13. **ctx 漏暴露**：新状态/方法必须 定义+解构+ctx return+子组件 return 四步齐全，漏一个模板访问 undefined 静默失效（exportGraph/graphStats/graphBuilding 都踩过）。
14. **watch 恢复期竞态**：onMounted 装载配置时用 `isRestoringConfig` 闸门拦截所有 getter→watch 的写盘，防启动期用默认值覆盖用户配置（syncConfigToDisk/saveUiSettingsToDisk 内部 guard）。
15. **renderHTML 必须安全转义**：内容含 `<html>` 等会当 DOM 吞掉，先转义 `& < >` 再 `\n→<br>`、双空格→`&nbsp;&nbsp;`。
16. **v-for 的 key 必须稳定唯一**：用 `item.id`（随机 id）或 `getEntryUid(entry)`（WeakMap），禁用 index（删除/排序后错位）。

### 5.3 数据 / 文件
17. **卡片 id 不是路径**：`id` 是随机串，真实路径在 `card.path`。文件操作/导出必须 `.path`；批量导出 `library.filter(...).map(i=>i.path)`。
18. **世界书 entries 可能是对象字典**（V2 老格式 `{"0":{...}}`）：所有读取点必须 `Object.values` 归一化 + 脏形态兜底（`extractBookEntries` 模式），否则空屏崩溃。
19. **保存/导出必须剔除 `_` 前缀临时字段 + `uid`**（SillyTavern 原生无 uid；`_collapsed` 等 UI 状态会污染 JSON）。JSON.stringify replacer 双层防线。
20. **卡片图片地址必须用 `local-file://img/?path=` 永久路径**，绝不用 blob URL 做持久地址（重启即失效=破碎图标）。导入必须先把文件物理复制到库目录。
21. **卡片分类/标签必须同步写原生 `data.tags` + 落盘**，否则重启重扫丢失（persistCardUpdate 三保险：内存+覆盖层+saveCard）。
22. **世界书/内嵌世界书字段口径不同**：内嵌（keys/secondary_keys/insertion_order）+ 库（key/keysecondary/order）。转换时注意 `comment||name` 名字映射（v1.8.9 刚修复）。

### 5.4 打包 / 发布
23. **`latest.yml` 必须上传**，否则 OTA 静默失败（404）。exe+latest.yml+blockmap 必须同传。
24. **electron-builder 卡住=正在下载 Electron 二进制**（勿误杀）。离线打包：`$env:ELECTRON_BUILDER_OFFLINE='true'; npx electron-builder --win nsis --config.electronDist="<项目>\node_modules\electron\dist"`。
25. **打包前杀进程**：按 `Path -like '*JSK管理*' -or '*win-unpacked*' -or ProcessName -eq 'electron'` 匹配杀（EBUSY 根因是旧实例锁文件，杀 electron.exe 不够）。
26. **`build:web` 的 rmSync 可能未真正清空 web/**（历史 JS 累积进 asar 撑大体积）——必要时 PowerShell 强删后重建。
27. **发布新版本必须同步 GitHub Release**（releases/latest），否则 OTA 显示 downgrade/误导。
28. **gh release 无输出即在上传**（大文件后台跑，等完成通知勿中断）；`gh release list` 看 Latest（view --json 无 isLatest）。

### 5.5 测试 / 调试
29. **vite build 只验编译不验运行时**——TDZ/渲染崩溃必须真实启动冒烟（`npx electron . --disable-gpu --enable-logging`，看 `[Vue 错误]`）。
30. **CDP 调试**：`--remote-debugging-port=9222` + Node WebSocket；`Runtime.evaluate` 响应层级 `msg.result.result.value`；HMR 对 App.vue 大组件不生效须先 `Page.reload`；setupState 是 proxyRefs（ref 自动解包）。
31. **测试电子环境文件**必须放已授权目录（白名单外 readText 返回 forbidden 对象 → JSON.parse("[object Object]") 报错）。
32. **ECharts 节点点击自动化不可行**（zrender 分层渲染位置不可靠），只能手动验证。

---

## 六、标准工作流（照抄可用）

### 6.1 开发
```bash
npm install            # 依赖（新机器：$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" 加速）
npm run dev            # 仅 vite dev server
npm run start:dev      # vite dev + Electron（热更新）
npx electron . --disable-gpu --enable-logging   # 生产代码直接启动（验证运行时）
npm test               # 46 个单测
npx vite build         # 构建 web/
node --check <file>    # 语法检查
```

### 6.2 一条龙发布（用户常用指令）
```powershell
# 1. 杀残留进程（EBUSY 防护）
Get-Process | Where-Object { $_.Path -like '*JSK管理*' -or $_.Path -like '*win-unpacked*' -or $_.ProcessName -eq 'electron' } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. 升版本号（package.json + package-lock.json）
# 3. 更新 RELEASE_NOTES.md（顶部加新节）+ README.md（版本号 3 处 + 产物名对齐实际 electron-builder 输出）+ CHANGELOG.md

# 4. 打包（离线，复用本地 Electron）
npm run build:web
$env:ELECTRON_BUILDER_OFFLINE='true'
npx electron-builder --win nsis --config.electronDist="e:\AI\酒馆工具\JSK管理\node_modules\electron\dist"
# 产物：dist/sillytavern-card-manager-<ver>.exe + latest.yml + <ver>.exe.blockmap

# 5. 绿色版 zip
Compress-Archive -Path dist\win-unpacked\* -DestinationPath dist\SillyTavern.zip -Force   # (或按 README 产物名)

# 6. 冒烟 + asar 校验（用 UTF-8 解码验证中文关键字）
# 7. commit + push
git add -A; git commit -m "vX.Y.Z: ..."; git push origin master

# 8. 发 Release（Latest = OTA 可检测）
gh release create vX.Y.Z "dist\sillytavern-card-manager-X.Y.Z.exe" "dist\latest.yml" "dist\sillytavern-card-manager-X.Y.Z.exe.blockmap" "dist\SillyTavern.zip" --repo tian2418671-sys/JSKZX --title "vX.Y.Z" --notes-file notes.md
# 覆盖发布：gh release delete-asset 删旧 → gh release upload --clobber

# 9. 验证 OTA
Invoke-WebRequest https://github.com/tian2418671-sys/JSKZX/releases/download/vX.Y.Z/latest.yml | Select-Object StatusCode
```

---

## 七、给下一任 AI 的开工建议

1. **先读**：本文件 → `README.md`（架构/关键坑/开发指南）→ `RELEASE_NOTES.md` 顶部几节（最新功能）→ 仓库记忆 `electron-notes.md`（若配置了）。
2. **确认 git 状态**：`git status` / `git log --oneline -5`——当前本地领先 origin 2 commit，等用户指令推送/打包。
3. **未完成的下一件事**：世界书条目名修复（332c437/df3b78b）的推送与 v1.8.10 打包发布（仅当用户下令）。
4. **遗留低优先级**：`switchToSecondGreeting is not defined`；`trae/agent-Fxvvsf` 分支清理。
5. **用户协作风格**：用户常报「某功能坏了」——先**验证代码现状**（grep/读源码）再判断，勿盲改；用户提供的代码方案要**适配本项目架构**（Electron IPC、app://、白名单、confirmDialog/nativeAlert、Options API 组件规范）再落地；重要功能改动后必须 `get_errors` + `vite build` + 真实启动冒烟。
6. **改文件前先 grep 现状**（replace 的 oldString 与文件不符会失败）；大段替换后立即 get_errors 复查。

---

*本文件由 AI 助手根据 2026-08-09 至 2026-08-23 全部会话 + 仓库记忆自动生成，供后续开发无缝交接。*
