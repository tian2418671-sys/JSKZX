# 🤖 AI 交接指导 — SillyTavern 角色卡管理器（JSK管理）

> **本文件是「纯指导文档」**：怎么接手、项目长什么样、怎么开发、怎么发版、动工前要守什么规矩。
>
> | 你想找什么 | 去哪里 |
> |---|---|
> | 历史缺陷 / 踩过的坑（现象·根因·修复） | `docs/bugs/`（按领域分 5 份 + 总索引） |
> | 代码片段 / 实测技术数据 / 外部 API 参考 | `docs/技术支持/` |
> | 怎么发布（一条龙）、内部信息 / 用户可看信息怎么写 | `docs/发布/` |
> | 待做功能与排期 | `docs/规格与计划/后续升级计划.md` |
> | 文档总地图 | `docs/README.md` |
>
> 最后更新：2026-09-13 ｜ 当前版本 **v2.2.7**（已发布 + OTA）

---

## 〇、5 分钟上手

| 项 | 值 |
|---|---|
| 项目 | SillyTavern（酒馆）角色卡**本地管理**桌面工具，离线可用、数据不出本机 |
| 技术栈 | Electron 43.4.1 + Vue 3.5（Composition API + SFC）+ Vite 8（rolldown）+ Tailwind 3 + ECharts + electron-builder 26 + electron-updater + sharp（原生，可选）+ onnxruntime-node（本地向量） |
| 仓库 | `https://github.com/tian2418671-sys/JSKZX.git`（远端 `origin`） |
| 分支 | 本地 `master`（与 origin 同步） |
| 构建产物 | `sillytavern-card-manager-<版本>.exe`（NSIS 安装版）+ `latest.yml` + `.exe.blockmap` + zip 绿色版 |
| 测试 | `npm test` = `node --test "test/**/*.test.mjs"` → 当 前 **256 用例全绿**（25 个测试文件） |
| 规模 | `js/components/` 41 个 SFC、`js/composables/` 36 个模块（含 `chat/` 引擎 16 个）、`js/utils/` 解析与索引工具 |
| 用户习惯 | 说「**一条龙服务**」= 升版本号 → 更新文档三件套 → 打包 → 提交推送 → 发 GitHub Release（含 `latest.yml` 保 OTA） |
| 典型库 | 日常小库 `E:\AI\酒馆工具\角色卡`（75 张）；压测大库 `I:\03\角色色卡`（11,186 张 / 9.76GB）；2 万卡副本由脚本现造 |

**开工第一件事**（不要跳过）：

```powershell
git status -sb                                   # 是否干净、是否领先 origin
git log --oneline -5                             # 最近做了什么
npm test                                         # 基线是否全绿
node scripts/release-check.mjs                   # 语法 + 单测 + 构建 + 文档一致性 + git 状态
```

---

## 一、铁律（违反会出事）

1. **没收到用户明确的推送/打包指令，禁止 push / 打包 / 发 Release**。用户要先自己看效果再决定。
2. 用户报「某功能坏了」时，**先验证代码现状**（grep / 读源码 / 真实启动），再判断是否真坏了 —— 历史上有多次是误报或原型变量名张冠李戴。
3. 用户给的代码方案要**适配本项目架构**再落地：Electron IPC（禁传响应式 Proxy）、`app://` 协议、路径白名单、`confirmDialog`/`nativeAlert`、Options API 组件规范。
4. 改动后必须过三关：`get_errors` → `npm run build:web` → **真实启动冒烟**（`npx electron . --disable-gpu --enable-logging`）。`vite build` 只验编译，**不验运行时**（TDZ、渲染崩溃都是编译期看不出来的）。
5. 改文件前先 grep 现状；`replace` 的 oldString 与文件不符会直接失败。大段替换后立即复查。
6. 文档分工不得越界：`RELEASE_NOTES.md` 是**对外**的（只写用户能感知的变化），`CHANGELOG.md` 与 `docs/**` 是**内部**的。详见 `docs/发布/内部信息.md` 与 `docs/发布/用户可看信息.md`。
7. 涉及**物理路径会变的操作**（移动分组 / 重命名 / 换卡图）必须同步迁移**所有**按 path 派生的键（会话、变量树、覆盖层配置），否则用户看到的是「数据凭空消失」。
8. 动工前先扫一眼 `docs/bugs/` 对应领域的历史缺陷 —— 很多坑会**重复踩**（尤其 Vue 响应式、世界书字段口径、打包发布）。

---

## 二、当前状态（接手时点：2026-09-13）

- **版本 v2.2.7 已发布**：master 已推送、tag `v2.2.7` 已推、GitHub Release 已建（Latest）、OTA 链路已验证（`releases/latest/download/latest.yml` 返回 200 且版本号匹配）。
- 工作区干净（`git status --porcelain` 为空）。
- **大库专项已完成一轮**：世界书正文懒加载（P1a）+ 索引跨代沿用（P2）+ 内存守门员 + 压测工具链。22,372 卡库实测堆 2,891MB → **2,053MB**，渲染进程不再 OOM。
- **下一刀（P1b，未做）**：剩余 2,053MB 里 1,877MB 是「词条对象 + 倒排索引」，目标应是**词条对象本身**与索引规模，而不是文本。
- 已知遗留（非阻塞）：
  - `js/components/App.vue` 有十余处 `U+FFFD` 乱码**在注释里**（不影响功能，未修）；
  - 冷启动真机复测（重启电脑后跑 `node scripts/measure-startup.mjs --label 冷启动`）尚未做；
  - 移动版（`JSK管理APP`）**未同步**本轮桌面版修复。

---

## 三、项目架构

### 3.1 分层

```
main.js            Electron 主进程（CJS）：app:// 自定义协议、全部 IPC、路径白名单、
                   快照备份、PNG 读写、世界书扫描、全盘打捞真伪鉴定、OTA、崩溃兜底
preload.js         contextBridge 暴露 window.electronAPI（约 30+ API）
js/entry.js        渲染进程入口（createApp(App) + errorHandler）——注意不是 js/main.js
js/components/     41 个 SFC（App.vue 为唯一根 + 子组件 + 弹窗）
js/composables/    36 个模块：业务逻辑主体，App.vue setup 尾部统一注入
   └ chat/         测卡引擎 16 个模块（useChatEngine / chatStorage / useChatPresets / chatBridge …）
js/utils/          cardLoader.js（卡解析/规范化）、pngParser.js、searchIndex.js、tokenCache.js、
                   memoryGuard.js、cardSlim.js、tokenEstimate.js
main/              vectorManager.js / vectorWorker.js / memoryStore.js（向量与长期记忆存储层）
css/               tailwind.css（源）/ style.css（自定义）
web/               vite build 产物（生产加载，gitignore）
test/              25 个测试文件 / 256 用例（node:test，`npm test`）
scripts/           压测与探针（library-dup-*、capacity-check.ps1、measure-startup.mjs、
                   release-check.mjs、_cdp-*.mjs 等）
```

### 3.2 模块职责速查

**`js/utils/`（纯逻辑，可单测）**

| 文件 | 职责 |
|---|---|
| `cardLoader.js` | 卡片解析 / 规范化 / 血统鉴定（`isCharacterCardData`）/ 自动打标规则表 `defaultAutoTagRules` |
| `pngParser.js` | PNG 块解析（`tEXt` / `iTXt` 的 `chara` 块），大卡兜底 `deepScanForJSON` |
| `searchIndex.js` | 搜索索引（**不保留文本**、中文单字倒排、代次号 + 幂等 + 跨代沿用 `carry`） |
| `tokenCache.js` | Token 估算缓存与预热（`yieldToMain` 让步调度） |
| `memoryGuard.js` | 内存水位守门员（warn / critical → 释放可重算缓存 + GC） |
| `cardSlim.js` | 大库正文懒加载（`slimCard` / `ensureCardFull`，>3000 张自动启用） |
| `tokenEstimate.js` | Token 估算（超长文本防护） |

**`js/composables/`（业务逻辑主体，共 36 个模块，含 `chat/` 16 个）**

| 模块 | 职责 |
|---|---|
| `useCardCrud.js` | 卡片 CRUD 域（导入 / 删除 / 持久化 / 自动分类打标 / 导出重命名） |
| `useConfigPersistence.js` | 配置持久化中枢（`syncConfigToDisk`、API Key 加密、原子落盘、`isRestoringConfig` 闸门） |
| `useDiskScan.js` | 全盘打捞 / 库刷新（含 load 锁与合并刷新） |
| `useAITools.js` | AI 打标三层漏斗（规则 → 本地向量 → LLM）/ 翻译 / 格式升维 |
| `useTags.js` | 标签体系（全局标签池 / 自定义分类 / 外来标签清洗） |
| `useSearch.js` | 搜索与筛选（含快捷筛选分类判定） |
| `useCardGroups.js` | 角色卡分组与分类（物理文件夹移动 + 键迁移） |
| `useWorldbooks.js` / `useWorldbookEntries.js` / `useWorldbookExtras.js` / `useEmbeddedWorldbook.js` | 世界书库 / 词条 IDE / 提取与导入 / 卡内嵌世界书 |
| `usePresets.js` / `usePresetStitch.js` | 预设管理 / 预设缝合工作台 |
| `useGraph.js` | 关系图谱（头像限流 / 连线预算 / 构建缓存） |
| `useDedupe.js` / `useBatch.js` / `useSnapshots.js` | 查重比对 / 批量操作 / 历史快照 |
| `useGlobalEntrySearch.js` / `usePlugins.js` / `useStatusbarPreview.js` | 全库词条搜索 / 插件工作区 / 状态栏模板预览 |
| `chat/*`（16 个） | 测卡引擎：`useChatEngine`（编排）/ `chatStorage`（存储适配 + 响应式版本号）/ `useChatPresets` / `chatBridge` / `useChatMemory` … |

> 其余模块按 `useXxx` 命名即可判断职责；新增模块沿用「App.vue 统一注入 + 四步暴露」的约定。

### 3.3 组件与 ctx 传播（最容易漏的地方）

- `App.vue` 是**唯一根组件**：所有状态/方法集中在 setup → `provide('appCtx', ctx)` → 子组件 `inject('appCtx')` 解构。
- ⚠️ 新增状态/方法必须**四步齐全**：`定义` + `useXxx 解构` + `ctx return 暴露` + `子组件 return 解构`。漏一处即模板访问 `undefined` 静默失效（历史缺陷见 `docs/bugs/BUG-架构与渲染.md` AR-13）。
- 关键共享单例：`library`（卡片数组，**shallowRef**）、`cardData`（当前卡，**shallowRef** → 深层改动必须 `refreshCardData()`/`triggerRef`）。

### 3.4 数据流与存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 卡片 | 物理文件（PNG / JSON / WebP） | `card.path` 是真实路径，`card.id` 是随机串，**文件操作一律用 `.path`** |
| 配置权威 | `userData/app_config.json` | 原子写（tmp + rename），收口 globalTags / customCategories / removedDefaultKeys / tagLangMode / cardOverlays / api / ui |
| 卡片用户配置覆盖层 | `appConfig.cardOverlays[path]` | 记住用户手动分类/标签，重扫重启不冲刷 |
| 快照 | 卡：同目录 `.bak_history/`；书：`userData/jsTavern_Backups/` | 内容哈希去重 + 超量清理 |
| 回收站 | `userData/jsTavern_Trash` | 全局，**绝不物理删除**；卡片另有 `.trash/` |
| 测卡会话 | `userData/chat_store.json` | 适配层 `chat/chatStorage.js`（localStorage 镜像 + `chatStorageVersion` 响应式版本号） |
| 长期记忆 | `userData/memory_store.json` | `main/memoryStore.js` + `memory:*` IPC |

### 3.5 性能相关的重要事实（别重复调研）

- 渲染进程堆上限 **4,192MB 是真的**，`--js-flags=--max-old-space-size=6144` **抬不上去**（已实测否证，不要重试）。`--expose-gc` 有效（`window.gc` 存在）。
- 大库（>3000 张）会自动启用**正文懒加载**：列表态不常驻世界书词条正文与 `alternate_greetings`，打开卡片时才读回。相关文件：`js/utils/cardSlim.js`、`App.vue` 的 `slimLibraryIfNeeded`。
- 搜索索引**不保留文本**，中文按**单字**建倒排；`buildAsync(..., { reuse: true })` 会跨代沿用未变动卡的 token。
- 内存守门员 `js/utils/memoryGuard.js`：24k 卡高压下会自动释放缓存并 GC。

---

## 四、标准工作流

### 4.1 开发循环

```bash
npm install                                    # 新机器：$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" 加速
npm run dev                                    # 仅 vite dev server
npm run start:dev                              # vite dev + Electron（热更新）
npx electron . --disable-gpu --enable-logging   # 生产代码直接启动（验运行时，看 [Vue 错误]）
npm test                                       # 单测
npm run build:web                              # 构建 web/
node --check <file>                            # 语法检查
```

- 大库端到端调试：`npx vite --port 5173` + `$env:VITE_DEV_SERVER_URL='http://localhost:5173'` + `electron . --remote-debugging-port=9338 --user-data-dir=<临时目录>`（**必须用隔离 profile**，绝不碰真实配置）。
- 生产模式 CDP：`electron . --remote-debugging-port=9333`（走 `app://index.html` + `web/` 产物，无 Vite）。
- 探针脚本见 `docs/技术支持/README.md`（`_cdp-eval.mjs` / `_cdp-mem.mjs` / `_heap-audit.mjs` / `measure-startup.mjs` / `capacity-check.ps1`）。

> ⚠️ **两种运行方式别搞混**：`npm start` = `build:web` + `electron .`（**源码版**，改代码后必须用它验证）；
> `dist` / `dist_new` 里的安装包是**构建产物**，跑它看不到新代码 —— 历史上真出现过「用户跑打包版、误以为修复无效」。
>
> 🚨 **崩溃排查第一现场**：`userData/crash.log`（渲染进程崩溃详情 + 自动 reload 记录）与 `userData/Crashpad/*.dmp`（原生崩溃）；
> `userData` 下各文件的用途与处置建议见 [`docs/技术支持/README.md`](docs/技术支持/README.md) §五。

### 4.2 提交前门禁

| 门禁 | 命令 | 通过标准 |
|---|---|---|
| 单测 | `npm test` | 256/256 |
| 构建 | `npm run build:web` | 无错误 |
| 运行时 | `npx electron . --disable-gpu --enable-logging` | 无 `[Vue 错误]`、`crash.log` 无新增 |
| 发版自查 | `node scripts/release-check.mjs` | `✅ 无阻塞项，可进入打包` |

### 4.3 发布

**完整流程、判定标准、回滚口径见 [`docs/发布/一条龙-发布流程.md`](docs/发布/一条龙-发布流程.md)**（前置自查 → 版本号 → 文档三件套 → 打包 → 产物校验 → 装包自测 → 提交打 tag → Release → OTA 验证 → 覆盖发布 → 回滚）。

其中最容易出事的 3 条，先记住：

1. **`latest.yml` 必须随 exe 一起上传**，否则老客户端 OTA 静默 404 失败；
2. **Release 正文只粘 `RELEASE_NOTES.md` 的对应版本段**，不要手抄、不要把内部细节带出去；
3. 打包前必须**杀掉旧打包产物进程**，否则 `electron-builder` 会 EPERM/EBUSY。

---

## 五、高频缺陷地图（动工前先看一眼对应领域）

| 领域 | 文档 | 里面最值得先知道的 |
|---|---|---|
| 架构 / 渲染 / 测试调试 | [`docs/bugs/BUG-架构与渲染.md`](docs/bugs/BUG-架构与渲染.md) | IPC 不能传 Proxy；弹窗必须在 `#app` 内；`shallowRef` 深层改动不触发；Vue 3.4+ computed「值不变不传播」 |
| 数据 / 文件 / 字段口径 | [`docs/bugs/BUG-数据与文件.md`](docs/bugs/BUG-数据与文件.md) | `id` 不是路径；世界书 `entries` 可能是对象字典；内嵌与库世界书**字段口径不同**；导出必须剔除 `_` 前缀字段 |
| 性能 / 大库 / 内存 | [`docs/bugs/BUG-性能与大库.md`](docs/bugs/BUG-性能与大库.md) | 索引并发重叠重建 → 重复卡；写盘判据看错基准 → 无限重写；`requestIdleCallback` 在后台永不回调；大库容量边界 |
| 发布 / 打包 / 更新 | [`docs/bugs/BUG-发布更新与打包.md`](docs/bugs/BUG-发布更新与打包.md) | `latest.yml` 缺失 = OTA 404；`gh release` 无输出=正在上传；本机 git 直连 GitHub 间歇失败需重试 |
| 测卡工作区（对话测试） | [`docs/bugs/BUG-测卡工作区.md`](docs/bugs/BUG-测卡工作区.md) | 读存储的 computed 会永久缓存；预设 `prompt_order` 有两种形态；CDP 里 import 模块会另建实例 |

> 缺陷条目统一编号（`AR-xx` / `DF-xx` / `PK-xx` / `RL-xx` / `CT-xx`），每条含**现象 / 根因 / 修复 / 验证 / 来源**，总表见 [`docs/bugs/README.md`](docs/bugs/README.md)。

---

## 六、给下一任 AI 的开工清单

1. 读本文件（已读完）→ 按需读 `docs/bugs/` 对应领域 → 接口/实测数据细节看 `docs/技术支持/`。
2. `git status -sb` + `git log --oneline -5`，确认基线；跑 `npm test` 确认 256/256。
3. 问清用户这一轮的目标是「修 bug / 加功能 / 发版」中的哪一类；**不要自行打包或推送**。
4. 动手前 grep 现状；改完过 4.2 的门禁；涉及路径的操作同步迁移派生键。
5. 若发现新缺陷：**先在 `docs/bugs/` 对应领域加一条**（带编号、版本、现象/根因/修复/验证），再写代码修复 —— 这样才不会重复踩坑。
6. 若用户说「一条龙」：照 `docs/发布/一条龙-发布流程.md` 走，注意内部/外部文档分工。

---

*本文件由 AI 助手整理自项目历史交接材料；缺陷、技术数据与代码片段已全部并入 `docs/bugs/`、`docs/技术支持/`、`docs/发布/` 与 `docs/规格与计划/`。*
