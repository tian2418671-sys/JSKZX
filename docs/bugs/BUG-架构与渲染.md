# AR · BUG 记录 — 架构 / Electron / Vue 运行时 / 测试调试

> 领域：主进程与渲染进程的边界、Vue 响应式与组件规范、构建产物与运行时的差异。
> 总索引见 [`README.md`](README.md)。条目格式：现象 → 根因 → 修复 → 验证 → 来源。
>
> 🛑 **AR-46 教训（改 UI 进度 / 状态展示前必读）**：
>
> 1. **同一个 UI 元素的两部分，绝不能走两条独立数据源** —— AR-43 / AR-46 是**同一个设计缺陷的两次爆发**：
>    进度条**条宽**走 `dedupeScanPercent`、**数字**走另一条路径，于是要么「数字恒 0 / ?」（AR-43）、
>    要么「扫描结束数字掉回 0 / ?」（AR-46）。**修法：收敛到唯一写入入口。**
> 2. **探针必须采「用户实际看到的东西」（渲染后的 DOM 文本）**，而不是只看自己方便拿到的内部变量 ——
>    AR-45 的探针只采条宽 ⇒ **5/5 通过是假绿**，直到用户第二次报出才算暴露。
> 3. **散落的赋值点是 bug 温床**：8 处进度赋值里 2 处漏了 `Math.max` 单调保护 ⇒ 必须收敛到**唯一入口**。

---

## 一、Electron / 架构级（AR-01 ~ AR-08、AR-17、AR-21、AR-22）

### AR-01 ｜ 🔴 IPC 传 Vue 响应式 Proxy
- **现象**：IPC 调用抛 `An object could not be cloned`（克隆错误）。
- **根因**：Vue 的响应式对象是 Proxy，结构化克隆不支持。
- **修复**：IPC 前先 `JSON.parse(JSON.stringify(x))` 剥离（`getPlainCardData` 模式）。排查时搜 `electronAPI.xxx(this.` / `electronAPI.xxx(foundFiles`。
- **来源**：早期交接手册的坑清单

### AR-02 ｜ 🔴 `window.prompt/confirm/alert` 在 Electron 里静默失败
- **现象**：prompt/confirm 返回 `null`、alert 不显示 —— 无任何报错，功能"点了没反应"。
- **修复**：一律改用 `appPrompt`（自建弹窗）/ `confirmDialog`（原生对话框）/ `nativeAlert`。
- **注意**：`nativeAlert` 的 `type` 只能是 `none/info/error/question/warning`（**没有 `success`**）。
- **验证**：正则脚本删除二次确认走 `dialog.showMessageBox` 后，自动化需用 Win32 消息应答（`WM_COMMAND/IDOK`），DOM 里找不到 `.van-dialog` 属正常。
- **来源**：早期坑清单；v2.2.7 桌面版大库专项实测

### AR-03 ｜ 🟡 未拦截 `window.open` / 新窗口
- **现象**：拖放文件到窗口会触发系统打开图片 / 弹出新窗口。
- **修复**：主进程 `setWindowOpenHandler(() => ({ action: 'deny' }))` + `will-navigate` 拦截非 `app://` 导航 + 元素 `draggable=false`。
- **来源**：早期坑清单（Electron/架构级）

### AR-04 ｜ 🔴 `app://` 协议 handler 缺路径穿越校验
- **修复**：`resolved !== root && !resolved.startsWith(rootPrefix)` 才放行；页面用 `app://` 加载（勿用 `loadFile`，ESM 有 CORS 问题）。
- **来源**：早期坑清单（Electron/架构级）

### AR-05 ｜ 🔴 路径白名单 `removeAllowedRoot` 无条件回收 → 误删库根
- **现象**：库根目录从白名单里消失，导致后续文件操作被拒（数据"看不见"）。
- **修复**：`preAuthorized` 先查再决定是否回收。
- **来源**：早期坑清单（Electron/架构级）；v1.8.2

### AR-06 ｜ 🔴 composables TDZ 回归
- **现象**：拆分组合式函数后 **`vite build` 不报错，但真实启动即崩溃**（ReferenceError）。
- **根因**：composables 里的 ref 被 `App.vue` setup 更早位置引用（TDZ）。
- **修复**：状态提升回 `App.vue` 顶层注入（`snapshotConfig` 即此例）。
- **教训**：拆分后**必须真实启动冒烟**（`npx electron . --enable-logging`），编译期看不出来。
- **来源**：早期坑清单（Electron/架构级）、§四 2026-08-19

### AR-07 ｜ 🟡 preload `on*` 事件多组件绑定互相清监听
- **根因**：带 `removeAllListeners` 的 `on*` 封装只能被一个组件绑定。
- **修复**：多组件场景由 App 收口 + prop 转发。
- **来源**：早期坑清单（Electron/架构级）

### AR-08 ｜ 🟡 无 `electronAPI` 降级时卡在启动蒙版
- **场景**：纯浏览器打开 `localhost:5173` 调试。
- **修复**：`onMounted` 里先置 `isAppLoading=false` 再 `return`。
- **来源**：早期坑清单（Electron/架构级）

### AR-17 ｜ 🔴 启动 TDZ 崩溃（watch 时机早于解构）
- **现象**：v2.0 版本启动即崩。
- **修复**：`watch` 移到 `useAITools` 解构**之后**注册；同时补配置原子写 tmp 清理。
- **来源**：`CHANGELOG.md`（v2.0 段）

### AR-21 ｜ 🔴 Capacitor 插件代理当 Promise 解决值 → 状态栏主题永久失效【移动版】
- **现象**：App 启动即报 `Uncaught (in promise) Error: "SystemBars.then()" is not implemented on android`。
- **根因**：**Promise 解决流程会读取返回值的 `.then` 判断是否 thenable**，而 Capacitor 的插件代理把任意属性访问当插件方法调用 → `SystemBars.then()` → 抛错。异常发生在「then 回调返回值被同化」这一步，**外层 `.catch` 拦不住**。
- **影响不止日志噪音**：`setStyle` 从未真正执行，深浅色主题一直是坏的。
- **修复**：在 `then` 回调**内部**消费插件对象，绝不把它交出去：
  ```js
  const withSystemBars = (fn) => {
      try { import('@capacitor/core').then((m) => { fn(m.SystemBars); }).catch(() => {}); } catch (e) {}
  };
  ```
- **验证**：logcat 出现 `To native (Capacitor plugin): pluginId: SystemBars, methodName: setStyle` 才算真通。
- **来源**：v1.10.21 移动版专项实测

### AR-22 ｜ 🟡 `KeepAliveService` running 时序错乱【移动版】
- **现象**：`onCreate` 中 `startForeground` 失败会置 `running=false` + `stopSelf`，但 `onStartCommand` **无条件** `running=true` 并返回 `START_STICKY` → 状态误报 + 系统反复拉起。
- **修复**：新增 `volatile boolean foregroundStarted` 门控；未成功启动则 `stopSelf()` + 返回 `START_NOT_STICKY`。
- **来源**：v1.10.21 移动版专项实测

---

## 二、Vue / 渲染层（AR-09 ~ AR-16、AR-18、AR-19）

### AR-09 ｜ 🔴 Vue 弹窗放在 `#app` 闭合 `</div>` 之外
- **现象**：弹窗**完全不编译** —— `{{ }}` 原样显示、`v-if` 失效。
- **定位技巧**：用 div 深度配平脚本找错误闭合位置。
- **来源**：早期坑清单（Vue/渲染层）；2026-08-12 教训沉淀

### AR-10 ｜ 🟡 组件注册名首字母连续大写
- **现象**：`AITagModal` 这类以 AI/XML/URL 开头的名字，kebab 标签 `<ai-tag-modal>` 解析不到。
- **修复**：注册名用小写化形式（`AiTagModal`）。props 无此问题。
- **来源**：早期坑清单（Vue/渲染层）

### AR-11 ｜ 🟡 纯 Options API 组件模板直接用模块级 import 的函数
- **现象**：报 `_ctx.xxx is not a function`，表现为弹窗"点不开"。
- **修复**：挂到 `methods` 或加 `setup()` return。
- **来源**：早期坑清单（Vue/渲染层）

### AR-12 ｜ 🔴 `shallowRef` 深层修改不触发响应式
- **场景**：`cardData` / `library` 都是 `shallowRef`；深层数组变更（`extensions.regex_scripts` 的 push/splice）不触发视图。
- **修复**：显式 `refreshCardData()`（= `triggerRef(cardData)` + 失效该卡 Token 缓存）；所有编辑框加 `@input="refreshCardData"`。
- **来源**：早期坑清单（Vue/渲染层）；v2.2.7 桌面版大库专项实测

### AR-13 ｜ 🔴 `ctx` 漏暴露 → 模板访问 undefined 静默失效
- **场景**：`exportGraph` / `graphStats` / `graphBuilding` 都踩过。
- **修复**：新状态/方法必须**四步齐全**：定义 + `useXxx` 解构 + `ctx return` 暴露 + 子组件 `return` 解构。
- **来源**：早期坑清单（Vue/渲染层）、§四 2026-08-20

### AR-14 ｜ 🔴 watch 恢复期竞态：启动时用默认值覆盖用户配置
- **根因**：`onMounted` 装载配置期间，getter → watch 已开始写盘。
- **修复**：`isRestoringConfig` 统一闸门（`syncConfigToDisk` / `saveUiSettingsToDisk` 内部 guard）。
- **来源**：早期坑清单（Vue/渲染层）；v1.8.1

### AR-15 ｜ 🟡 `renderHTML` 未转义
- **现象**：内容含 `<html>` 等会被当 DOM 吞掉。
- **修复**：先转义 `& < >`，再 `\n→<br>`、双空格→`&nbsp;&nbsp;`。
- **来源**：早期坑清单（Vue/渲染层）

### AR-16 ｜ 🟡 `v-for` key 用 index
- **修复**：用 `item.id`（随机 id）或 `getEntryUid(entry)`（WeakMap）；禁用 index（删除/排序后错位）。
- **来源**：早期坑清单（Vue/渲染层）

### AR-18 ｜ 🔴 正则/状态栏「新增首条不刷新」（Vue 3.4+ computed 不传播）
- **现象**：给**原本没有** `extensions.regex_scripts` 的卡新增第一条脚本，面板纹丝不动（徽标恒 0 条），必须切换选项卡才显示；而**已有**脚本数组的卡表现正常。
- **根因**：`regexScripts = computed(...)`，**Vue 3.4+ 的 computed 在新值 `Object.is` 等于旧值时不再向下传播**：
  - 卡上**已有**该字段 → `ensureRegexScriptsArray()` 原地 `push`，computed 缓存的**就是同一个数组对象**，`.length` 天然变化 → 侥幸正常；
  - 卡上**没有**该字段 → 新建数组**整体替换** → 缓存里的旧空数组永不失效 → 恒显示 0 条。
- **修复**：新增 `cardContentVersion`，`refreshCardData()` 时自增；`regexScripts` 取值前先读它，用版本号显式打破缓存。
- **验证**：dev + CDP，卡「斗罗大陆」（原 0 条）：点新增**不切 Tab** → 徽标 0→1、DOM 行 0→1 ✅（修复前 0/0）。
- **来源**：v2.2.7 桌面版大库专项实测（正则增删交互复测）

### AR-19 ｜ 🟡 正则/状态栏「添加要切 Tab、删除无提示」
- **根因**：`addRegexScript` 与 `deleteRegexScript` 漏了 `triggerRef`（同文件的批量克隆/删除都有）；删除还没有确认框与日志。
- **修复**：两处补 `refreshCardData()` + 操作日志；删除改 `confirmDialog`（文案点明脚本名、是否状态栏模板、需保存卡片才写回文件），确认后**按对象身份**重新定位再删，避免弹窗期间索引漂移。
- **验证**：`scripts/probes/_probe-regex-ui.mjs` PASS（21→22 立即生效；删除弹原生确认框、取消不误删、确定立即 22→21）。
- **来源**：v2.2.7 桌面版大库专项实测

---

## 三、测试与调试（AR-20、AR-23 ~ AR-26）

### AR-20 ｜ 🟡 `npm test` 跑完不退出
- **根因**：`yieldToMain` 用的 `MessageChannel` 是活跃句柄，Node 下不会退出。
- **修复**：`MessageChannel` 仅在真实 DOM 环境创建 + Node 下 `unref()`。
- **验证**：178/178，5.2s 正常退出。
- **来源**：v2.2.7 桌面版大库专项实测

### AR-23 ｜ 🟡 `.json` 插件格式化失效
- **来源**：`CHANGELOG.md` v2.2.5（`js/components/CodeEditor.vue`）

### AR-24 ｜ 🟡 dev 启动终端中文乱码
- **修复**：`scripts/tools/dev-run.ps1` 显式设置控制台编码。
- **来源**：`CHANGELOG.md` v2.2.5

### AR-25 ｜ 🟡 导入打标双开关未彻底解耦
- **来源**：`CHANGELOG.md` v2.2.5（`useCardCrud.js` / `App.vue` / `HeaderBar.vue`）

### AR-26 ｜ 📌 自动化做不到 / 必须真机验证的 4 件事（技巧，不是缺陷）
1. **`vite build` 只验编译不验运行时** —— TDZ / 渲染崩溃必须真实启动冒烟（`npx electron . --disable-gpu --enable-logging`，看 `[Vue 错误]`）。
2. **CDP 调试要点** —— `--remote-debugging-port=9222` + Node WebSocket；`Runtime.evaluate` 响应层级是 `msg.result.result.value`；HMR 对 `App.vue` 这种大组件不生效，须先 `Page.reload`；`setupState` 是 proxyRefs（ref 自动解包）。
3. **测试用的电子环境文件必须放在已授权目录** —— 白名单外的 `readText` 返回 `forbidden` 对象，`JSON.parse("[object Object]")` 会报错。
4. **ECharts 节点点击无法自动化**（zrender 分层渲染位置不可靠），只能手动验证。
- **来源**：早期坑清单（测试/调试）

### AR-27 ｜ 🔴 插件「效果」预览空白（缺宿主 DOM 官方挂载点）
- **现象**：插件工作区「✨ 效果」页渲染空白。
- **修复**：补齐宿主 DOM 的**官方挂载点**，并按官方 `chats.js` / `templates.js` 口径落内容净化管线。
- **来源**：`CHANGELOG.md` v2.2.4

### AR-28 ｜ 🟡 CSP 拦截插件预览脚本（改用独立 `app://` 内存路由）
- **现象**：预览页里的脚本被应用 CSP 拦掉。
- **修复**：不再放宽主 CSP，改为用**独立的 `app://` 内存路由**渲染预览（外链图片仍被拦截，属设计：防追踪像素）。
- **来源**：`CHANGELOG.md` v2.2.4 / v2.2.3

### AR-29 ｜ 🟡 字号滑块拖动时整个界面卡顿
- **现象**：「界面 UI 字号 / 工作区编辑字号」两个滑块拖动时整个界面卡顿、不丝滑。
- **根因**：滑块直接 `v-model` 绑定全局 `appSettings` → 每个 `input` 事件：① 触发 `App.vue` 两个 `watch(appSettings, { deep: true })`，**每帧写 `localStorage`**；② 更新 `documentElement` 的 `--ui-fs` / `--workspace-fs` CSS 变量；③ 全局大量 `font-size: var(--ui-fs) !important` → **整个界面每帧 reflow/repaint**。
- **修复**（`HeaderBar.vue`）：**草稿值 + 松手提交** —— 滑块绑本地 `uiFontSizeDraft` / `fontSizeDraft`（拖动只更新滑块与旁边数字，零全局副作用），`@change`（松手）才提交到全局 `appSettings`；`watch` 外部变更（如重置按钮）时同步草稿值。
- **防再犯**：**凡绑定到「全局响应式 + 影响全页面样式/布局」的输入，禁止直接 `v-model` 到全局 ref**，用草稿值 + 松手提交（或防抖）。排查所有高频控件对 `appSettings` / `viewOptions` 的绑定。
  （已确认安全的：`AITagModal.vue` 阈值滑块是受控组件 `:value` + `@input` emit ✅；`snapshotConfig` 是 `<select>` 低频 ✅）
- **来源**：v2.1.0 交互性能专项（2026-09-01）

### AR-30 ｜ 🔴 卡内世界书词条增/删/克隆/排序后列表不刷新（要切卡才出现）
- **现象**（用户报告 2026-09-14）：「删除词条后等一下也没变化，**必须切换别的卡再切回去**才看到结果」；
  实际同一根因影响**所有**卡内世界书条目编辑（新增 / 删除 / 克隆 / 上移下移 / 批量 / 从库导入），
  还连带影响「状态栏模板预览」的数据源（它也读同一 computed）。
- **根因**（两层叠加）：
  1. `useEmbeddedWorldbook.js` 的 `worldbookEntries` computed 写作
     `safeData.value.character_book || cardData.value?.character_book || {}` ——
     当 `character_book` **存在**时右半**短路不求值**，于是该 computed **完全不依赖 `cardData`**；
  2. 而编辑后统一走 `refreshCardData()` → `triggerRef(cardData)`（shallowRef 的标准手法），
     且 `safeData` 重算后**返回同一个对象**——Vue 3.4+ 的 computed 值未变时**不再向下传播**
     （同 AR-18 的记录）→ 这个 computed 永远不会被标脏，**一直返回上一次的缓存数组**。
  3. 切卡时 `cardData.value` 换成新对象 → `safeData` 返回值变了 → 传播恢复 → 列表才更新
     （这正是用户看到的「切卡才出现」）。
- **实测证据**（dev 实例 + CDP，修复前/后同一脚本）：
  raw `entries.length` 88 → 87（`splice` 后）→ `refreshCardData()` 后 computed **仍为 88**；
  把 `cardData` 换成新对象（≈切卡）后 computed 才变 87。修复后：`splice` + `refreshCardData()`
  即时 computed 4→3 且 **DOM 行数 4→3**；点「克隆」「新增词条」「下移」按钮 DOM 均即时变化。
- **修复**：在 `worldbookEntries` 里**显式读取** `const cd = cardData.value`（拿掉短路路径对依赖收集的影响）：
  `const book = safeData.value.character_book || (cd && cd.character_book) || {};`
  并加注释说明「为什么必须显式读」（后人容易“顺手优化”回短路写法而重引 bug）。
- **防再犯**：
  1. **shallowRef 场景下的 computed，必须真依赖到了那个 shallowRef**——
     `safeData` 这类 computed 返回**同一对象**时不会向下传播，不能寄托于它中转；
  2. 写 `a || b` 时要意识到：**短路会让依赖收集漏掉右半**；
  3. 同类排查点：`regexScripts`（已用 `cardContentVersion` 版本号修）、任何只读 `safeData` 而不读
     `cardData` 的 computed；新增此类 computed 时先问「`triggerRef(cardData)` 能叫醒它吗」。
- **来源**：用户实测报告 + dev/CDP 复现（2026-09-14，v2.2.7 补丁）

### AR-31 ｜ 🟡 往 `ctx` 定义与 `provide('appCtx', ctx)` 之间插代码 → AR-13 自动防线失配失效
- **现象**（P2 开发期自捕获 2026-09-20）：新增命令注册后跑 `python scripts/check.py --fast`，
  原本通过（绿）的「ctx 暴露完整性（AR-13 防线）」变成 **⚠️ 提醒：未解析到
  `const ctx = {...}; provide('appCtx', ctx);` 结构（App.vue 结构已变化？请更新本检查的正则）**
  —— 即自动检查**看不见 App.vue 了**，此后任何新增状态漏暴露都不会再被拦下。
  ⚠️ 这比漏暴露本身更危险：**防线静默失效**，而人看到的是“提醒”容易当成噪音忽略。
- **根因**：`scripts/pychecks/ctx_exposure.py` 用正则
  `const ctx = \{(.*?)\n\s*\};\s*\n\s*provide\('appCtx', ctx\);` 定位 ctx 对象正文，
  要求 `};` 与 `provide(` **紧邻**。P2 为了让“注册内置命令”发生在 ctx 就绪之后，把
  `registerAppCommands(commandRegistry, ctx);` + 注册期问题检查**插在两者之间** →
  正则失配 → 检查降级为提醒（这正是它设计好的「失配不静默通过」机制，正因此才被发现）。
- **修复**：把命令注册块**移到 `provide('appCtx', ctx);` 之后**（同一同步流程内，
  子组件渲染发生在 setup 返回之后，**无时序差异**），恢复 `const ctx = {...}; provide('appCtx', ctx);` 的相邻结构。
- **验证**：`python scripts/check.py --fast` 该项恢复 ✅（若仍报“未解析到结构”则修复未生效）。
- **防再犯**：
  1. **不要在 `const ctx = {...}` 与 `provide('appCtx', ctx)` 之间插入任何语句** ——
     保持“定义 + 紧接着 provide”是最稳的形态（自动检查依赖它）；
     需要“ctx 就绪后做事”就写到 `provide` **之后**；
  2. 看到 `ctx_exposure` 报「未解析到结构」**当缺陷处理**，不要当噪音 —— 它等于 AR-13 防线宕机；
  3. 同理，P2 新增的 `command_registry` 检查在“解析到的命令条数过少”时也是 **提醒而非静默通过**，
     同样的道理：**自动检查的失效必须是可见的**。
- **来源**：P2 实施期 `python scripts/check.py --fast` 回归发现（2026-09-20，未发布）

### AR-32 ｜ 🔴 命令搬到注册表后仍引用「只定义在子组件内部」的状态 → `ctx.xxx` 为 undefined
- **现象**（P2 实施期自捕获 2026-09-20，两种表现一强一弱）：
  ① **强**：「🧪 实验与工具」菜单里两个查重命令直接显示成「同名查重与版本清理（**undefined**）」（截图核对时一眼看到）；
  ② **弱（更阴）**：编辑菜单「🏷️ AI 智能批量打标」的管线状态后缀（原本显示「规则✓ 向量✗ AI✓」）**无声消失** ——
     因为注册表用 `safeCall()` 包住 `badge()`，抛错被吞掉，**既无报错也无日志**，只能靠“本来该有后缀卻没有”才能察觉。
- **根因**：这三个派生状态（`dedupeTargetLabel` / `funnelBadge` / `funnelEmpty`）**只定义在 `HeaderBar.vue` 组件内部**，
  从未进 `App.vue` 的 ctx。P2 把菜单命令从“组件模板里直接调用本地 computed”搬到“注册表命令里读 `ctx.xxx`”时，
  作用域链就断了：`ctx.dedupeTargetLabel` 永远是 `undefined`。
  编译通过、单测全绿（命令定义本身不报错），只靠真实界面才能看出来。
- **检出**：①§八 8.5 规定的「**截图对照**」防线（P2 预判「菜单项漏搬 / 显示错乱」）—— 做了就一眼看到；
  ② 新增静态检查 `pychecks/command_registry.py` 的「**命令引用的 ctx 字段存在**」项 → 一次性把三个都抳出来。
- **修复**：在 `App.vue` 定义这三个 computed（`funnelBadge` / `funnelEmpty` / `dedupeTargetLabel`）
  并加入 `provide('appCtx', ctx)`；`HeaderBar.vue` 改为**复用 ctx 上的同一份**（删掉本地重复定义与随之无用的 import），
  避免“同一逻辑两份实现”再次跑偏。
- **验证**：`python scripts/check.py --only ctx` → 「45 个 ctx 字段引用全部存在」✅；
  截图复核菜单文案不再出现 undefined；`ctx_exposure` 仍为 157 个定义 / 15 项未暴露均在基线内。
- **防再犯**：
  1. **把任何东西从“组件内部”搬到注册表 / 全局时，先问“它依赖的状态在 ctx 里吗”** ——
     子组件内部的 `computed` / `ref` 对命令注册表是**不可见**的（这是 AR-13 四步清单的延伸场景）；
  2. 已机器化：`pychecks/command_registry.py` 新增「命令引用的 ctx 字段存在」检查（解析 `useCommands.js` 的 `ctx.<字段>`
     与 `App.vue` 的 ctx 对象比对），**新增命令引用了不存在的字段即拦下**；
  3. 提醒：用 `safeCall()` 包可选函数字段（`badge` / `disabled` / `checked`）能防“一条命令报错搞坏菜单”，
     但代价是**错误会被吞掉** —— 所以这类“被包住的引用”必须靠静态检查兑现，不能只靠运行时。
- **来源**：P2 实施期截图对照 + 新增静态检查（2026-09-20，未发布）

### AR-33 ｜ 🟡 多菜单命令在**非主菜单**里排序错乱
- **现象**（P2 实施期自捕获 2026-09-20）：新建的「🏷️ 标签」菜单里，
  ① 「反选」「批量加标签」被甩到菜单**末尾**（而它们明明属于第 1、2 组）；
  ② 分组小标题「🧹 整理与清理」**重复出现两次**；③ 分组顺序变成“先编辑类、再设置类、再标签类、最后工具类”。
- **根因**：`listByMenu(menu)` 当时是这样写的 —— `list().filter(c => c.menus.includes(menu))`：
  它**复用了 `list()` 的排序结果**，而 `list()` 是按 **`menus[0]`（主菜单）** 排序的。
  于是多菜单命令（镜像入口）在**非主菜单**里就按“主菜单名”落位：
  `edit` < `settings` < `tags` < `tools` 的字典序把标签类命令打散，
  分组也是按这个错顺序切分的 → 同一个 `section: 3` 被切成两截，标题就重复了。
- **检出**：§八 8.5 定的「**截图对照**」防线（一眼看到顺序不对）+ 结构断言（列出菜单子元素）。
  ⚠️ 这是 P2 期第二次靠截图对照拓到真问题（上一次是 AR-32）。
- **修复**：`listByMenu()` 改为**取本菜单的命令后，按本菜单自己的 `section/order` 重新排序**（不再复用 `list()`）；
  分组与 `sectionTitle` 因此在各组内正确取首条。
  同时不再需要“把 `menus[0]` 设成期望菜当”这类绕过手法。
- **验证**：`test/commandRegistry.test.mjs` 新增 2 例——
  ①「按本菜单 section/order 独立排序（不被主菜单名干扰）」；②「sectionTitle 取本菜单内该组首条的声明（不串菜单）」。
  实机截图确认：标签菜单三分组（☑️ 选择 / 🏷️ 打标 / 🧹 整理与清理）顺序正确、无重复标题。
- **防再犯**：
  1. **“按维度 A 筛选、按维度 B 排序”时，绝不要复用“按 B 排序”的结果**——
     本例 `list()` 按主菜单、`listByMenu()` 按 section，复用就错；
  2. 字段是多值时（`menu` 数组），要明确“排序以哪个为准”，并在**渲染侧按当前上下文重排**；
  3. 这类“列表顺序/分组”缺陷编译与单测都拓不到，**必须靠截图或结构断言**（见 AR-32 的同类教训）。
- **来源**：P2 期新增「标签」菜单时截图对照发现（2026-09-20，未发布）

### AR-34 ｜ 🟡 顶部菜单「点击命令后不关闭」（纯 CSS hover 驱动）
- **现象**（用户 2026-09-20 报告：「菜单打开不关闭，现在就存在」）：
  顶部菜单展开后点里面的命令，**命令执行了但菜单仍然开着** —— 必须把鼠标移开才会关。
  更尴尬的是命令会弹窗（如「管理规则表」），**菜单面板与弹窗叠在一起**，看起来像卡死。
- **根因**：菜单面板用纯 CSS 驱动 —— 容器 `class="relative group"` + 面板 `class="hidden group-hover:flex"`。
  `:hover` 由**鼠标位置**决定，**点击不会改变它** → 点完命令鼠标仍在面板上 → 面板继续展开。
  代码里**没有任何「点击后关闭」的通道**（菜单项只调 `registry.execute`，不通知菜单）。
  ⚠️ 自 P2 引入注册表以来一直如此（旧版同样问题，只是旧菜单项少、体感不明显）。
- **检出**：必须用**真实鼠标**操作才能复现 —— CDP 的 `element.click()` / `dispatchEvent` **不会改变 `:hover` 状态**，
  所以脚本断言永远是“关着的”。本项目用**集成浏览器**（打开 Vite dev server 地址）+ `hover_element` + `click_element` 手动复现。
- **修复**：菜单显示改为 **JS 状态控制**（不再单靠 CSS）：
  · `HeaderBar.vue` 新增 `menuOpen` 状态；容器改 `@mouseenter="setMenu(key)"` / `@mouseleave="closeMenus()"`，
    面板改 `:class="menuOpen === key ? 'flex' : 'hidden'"`；
  · 菜单项 `<command-menu-item>` 监听它**已有**的 `@executed` 事件 → `closeMenus()`（**只在实际执行了命令时关**，
    点禁用项不关）；
  · 手写按钮（设置菜单内的二级入口等）走的 `runCommand()` 内部也调 `closeMenus()` —— 一行覆盖全部手写入口。
- **验证**：集成浏览器真实 hover + 点击 → 面板立即关闭；禁用项点击不关（符合预期）；
  鼠标移入展开、移出关闭的原有体感不变；Electron 冒烟无 `[Vue 错误]`。
- **防再犯**：
  1. **交互式弹出层（菜单 / 下拉 / 子菜单）必须有一条「显式关闭」通道**，不能只依赖 `:hover`——
     纯 hover 的东西“点了不关”是必然，不是偶然；
  2. 这类“点了没关 / 点不开”的体验缺陷，**脚本 click 测不出来**（不改 hover、也不走真实事件序列）——
     涉及 hover / 鼠标位置的问题，必须用真实鼠标（集成浏览器或人工）验证；
  3. 新增菜单时：容器 / 面板 / 菜单项三处都要接状态（漏掉哪一处都会退化成“点完不关”）。
- **来源**：用户报告 + 集成浏览器复现（2026-09-20，未发布）

### AR-35 ｜ 🟡 批量操作悬浮条盖住所有弹窗（打标弹窗底部被遮「看不见」）
- **现象**（用户 2026-09-20 截图报告「被挡住了看不见」）：选中卡片后底部出现「批量操作悬浮控制台」，
  打开 **AI 智能批量打标**等弹窗时，悬浮条**压在弹窗之上**（截图里叠在打标弹窗底部，遮挡内容与可点区域）。
- **根因**：悬浮条 `fixed z-50`，且模板中渲染在**全部弹窗之后**（App.vue 悬浮条块位于模板尾部，弹窗区在它前面）。
  弹窗同为 `z-50`——**同 z-index 时由 DOM 顺序决定覆盖：谁后渲染谁在上** → 悬浮条永远盖在弹窗上。
  （与「z 数值高低」直觉相反——两边都是 50，比的是文档顺序。）
- **修复**：把悬浮条块**上移到弹窗区之前**渲染（z-50 不变）→ 任何弹窗天然盖住它；
  · DragOverlay（`z-index:9999` 内联）/ AppLoadingOverlay（z-999）不受影响，仍在最顶层；
  · 悬浮条仍高于 z-40 的通用小弹窗（appPrompt / appSelect）——从悬浮条触发的「移分组 / 删除确认」语义不变；
  · 弹窗关闭后悬浮条自然恢复可见（选中状态不受影响）。
- **验证**：dev 隔离实例 CDP：选 3 张卡 → 打开打标过程窗口（z-50）→ `elementFromPoint`（悬浮条中心）命中**弹窗内元素**；
  用户截图场景（AI 打标弹窗）真机复检不再遮挡；构建后生产实例重启确认。
- **防再犯**：**浮层层级 = z-index + DOM 顺序两个维度**。新增悬浮/浮层时若与弹窗同 z，
  必须让自己**先渲染**（放弹窗区之前）；只盯 z 数值会漏掉「同 z 靠后盖前」的陷阱。
- **来源**：用户报告（2026-09-20 截图，未发布）

### AR-36 ｜ 🟡 打标过程窗口被打标弹窗盖住（同 z-50，先渲染者被压）
- **现象**（用户 2026-09-20 截图）：点「开始智能打标」后弹窗显示「打标处理中…」，但**「🏷️ 打标过程」窗口全程不可见**——
  它被「AI 智能批量打标」弹窗整体盖住（两窗同屏同位置）。直到打标完成、打标弹窗自动关闭后才露出。
- **根因**：AR-35 同款层级陷阱的**新实例**：两窗同为 `z-50`，而 `ai-tag-log-modal` 在模板中挂在 `ai-tag-modal` **之前**
  （先渲染）→ 同层级时后渲染的弹窗在上面 → 过程窗口被完全压住。打标入口弹窗与过程窗口**必定同开**（入口弹窗要等打标完才关），
  所以问题 100% 复现。
- **修复**：`AiTagLogModal` 容器 `z-50` → `z-[60]`——明确语义「过程窗口必须浮在打标弹窗之上」，不再依赖模板挂载顺序；
  仍低于命令面板（z-80）/ 查重（z-100）/ 磁盘扫描（z-200）等重层弹窗（与打标不同开，无冲突）。
- **验证**：dev 隔离实例全链路实测：选中 2 张 → 点悬浮条「AI 打标」→ 点「开始智能打标」→ 打标进行中取过程窗口
  中心 `elementFromPoint` 命中**过程窗口**（非打标弹窗）；`getComputedStyle` 确认 z 60 > 50。真机复检同场景。
- **防再犯**：
  1. **「入口弹窗 + 过程弹窗」这种必然同开的组合，层级必须显式拉开档次**（过程窗口 z 高于入口），不要两个都堆 z-50 靠顺序赌；
  2. 冒烟验证必须**模拟真实入口链**（从按钮点击走到打标），不能只调 `startAITagging`——上轮冒烟正是这样漏掉了本缺陷
     （没有竞争者时窗口当然看得见）。
- **来源**：用户报告（2026-09-20 截图「打标处理中…」无过程窗口，未发布）

### AR-37 ｜ 🟡 新增菜单「三处接线」漏一处 → 下拉渲染成空白（防线正好有缝）
- **现象**（2026-09-20 热测试发现）：新增「📁 分组(G)」菜单后，按钮能点开，但**下拉里一条命令都没有**——
  注册表已注册 6 条、模板块也写了 `commandsByMenu.groups`，唯独 `commandsByMenu` 计算里的
  `for (const key of [...])` 数组没加 `'groups'` → `out.groups` 从未被赋值 → 模板 `|| []` 渲染成空菜单。
- **根因**：菜单渲染依赖**三处同时接线**：① 注册表 `menu` 字段 ② HeaderBar 模板块（`commandsByMenu.xxx` 引用）
  ③ `commandsByMenu` 的 key 数组（真正把命令取出来的一步）。而原 pycheck 两项检查恰好都在缝的两侧：
  「渲染了不存在的菜单键」查模板引用（有 ✓）、「数组里含空菜单」查数组（键都有命令 ✓）——**两道防线都抱不到缺的第三处**。
- **修复**：key 数组补 `'groups'`；并给 `scripts/pychecks/command_registry.py` 增加**渲染接线双向检查**：
  ① 模板引用的 key 必须在 key 数组里（否则 out 未赋值=空渲染，即本缺陷形态）；
  ② 注册表里有命令的菜单必须至少接上渲染（模板引用或数组其一），白名单 settings/toolbar（手写交错结构）。
- **验证**：对抗测试——临时把 `'groups'` 从数组移除 → `python scripts/check.py` **阻塞报错**（防线确实抓得到）；
  恢复后全绿。真实软件热测试（窗口内刷新）：菜单 6 条命令 + 2 个分组标题全部渲染，
  点「🗂️ 自动分组」成功打开弹窗。
- **防再犯**：新增菜单 = **三处同加**（注册表 + 模板块 + key 数组），已写进 HeaderBar 注释与 pycheck 检查文案；
  改菜单接线后跑 `python scripts/check.py`（架构项会拦）。
- **来源**：2026-09-20 分组菜单开发自测（未发布）

### AR-38 ｜ 🟡 无启用规则时点「重新扫描」静默无反应 → 误以为按钮坏了（引导缺失）
- **现象**（2026-09-21 用户报告）：打开「自动分组」弹窗点「🔄 重新扫描」毫无反应（无加载、无提示、无报错）——
  用户判定「按钮坏了」。实际是**尚未保存任何收纳规则**，扫描无规则可依；按钮**可点但零反馈**，用户无从得知原因
  （用户随后自查确认为「引导问题不熟悉导致的乌龙事件」）。
- **根因**：两层叠加——① `useAutoGroup.scanAutoGroup` 对「无启用规则」是**静默 `return null`**
  （设计上避免空跑，但界面无任何解释）；② 弹窗只在**无规则**的空态里有一句静态文案，
  用户点按钮/切页签后看不到与点击相关的任何反馈 → 感知为「点了没反应」。
- **修复**（`js/components/AutoGroupModal.vue`）：
  ① `doScan` 增加前置检查：无「启用且目标分组非空」的已保存规则 → **就地弹琥珀色提示条**
  （「还没有启用中的收纳规则——请到『📋 收纳规则』添加规则（或载入推荐模板），并点『💾 保存规则』后再扫描；
  规则改动需要先保存才会参与扫描」）；有规则则清除提示并照常扫描；
  ② 预览区空态文案改由**已保存规则状态**（`hasEnabledSavedProfiles`）驱动：无可用规则 → 明确指向配置步骤；
  ③ 弹窗重新打开时清除提示条，避免陈旧提示残留。
- **验证**：生产构建 + 隔离 profile 走真实入口链（菜单 → 弹窗 → 切页签 → 点击）全链路断言：
  0 规则时点重扫 → 提示条出现（文本/可见性断言）；临时添加规则并保存 → 点重扫 → 计划正常生成（「将移动 1」）；
  删除并保存复原 0 规则 → 规则页空态回归；重开弹窗复查同链路全绿；控制台零报错。
- **防再犯**：**「可点但无反应」是最伤信任的交互形态**——按钮可点 = 用户预期必然有反馈；
  前置条件不满足时必须**就地给出「为什么 + 怎么做」**，拦截逻辑应成对配提示，不得静默失败。
- **来源**：2026-09-21 用户报告（自动分组「重新扫描」；自查确认为引导缺失引发的乌龙）

### AR-39 ｜ 🔴 世界书「查看词条差异」必崩：`diffText` 为 `null` 时模板直读其属性（渲染期 TypeError）
- **现象**（2026-09-21 排查）：查重结果里点「查看词条差异」，**词条数不同**的世界书**一开就渲染报错**（弹窗打不开 / 白屏）；
  词条数相同的世界书**能正常打开**。用户感知为「有的书能看、有的书一看就崩」。
- **根因**（两处叠加，纯渲染期错误、编译期查不出）：
  ① `js/composables/useDedupe.js` 的「📚 世界书词条总数 (Entries Count)」字段构造为
  `isSame: entries1.length === entries2.length`，**且 `diffText: null`**；
  ② `js/components/DiffModal.vue` 的 `v-else` 分支（`isSame === false` 时进入）**直接读** `f.diffText.masterLines` / `f.diffText.compareLines`
  → `null.masterLines` → **TypeError**。
  词条数相同 → `isSame: true` → 走「已自动折叠」文案分支 → 不碰 `diffText` → 因此**不崩**（这解释了"有的能开有的崩"）。
  次要崩点：同一模板里 `masterItem.path.split(/[\\/]/).pop()` / `compareItem.path...` **未判空**，`path` 缺失时同样抛错。
- **修复**（`js/components/DiffModal.vue`）：
  ① 行级比对分支包 `v-if="f.diffText"`，并在 `isSame === false` 且无 `diffText` 时渲染**占位文案**
  （「词条数不同，详见『🧩 词条级对齐』」）——**只加 `v-if` 不加占位会让该行留白，观感像坏了**；
  ② `masterItem?.path` / `compareItem?.path` 判空后再 `split`。
- **验证**（2026-09-21 已修复并通过）：`npm test` **423 全绿**（新增 `test/dedupeEntryAlign.test.mjs` 20 条）+ `npm run build:web` 无错 +
  **真实 UI 级冒烟**（dev 模式 + CDP，`scripts/probes/_probe-diff-align.mjs`，**15/15 通过**）：
  注入「A 3 条 / B 5 条（2 新增 1 删除）」两本测试书 → 真实调用 `openDiffDetailModal` 未抛错、弹窗可见（1264×761）、
  DOM 含「🧩 词条级对齐」/ 绿色 `[新增]` / 红色 `[缺失]` / 「本端无此词条」、词条总数行有占位文案、**无渲染期 TypeError**。
  另用旧代码条件（`f.diffText.masterLines`）对照，确认 `oldCrashed === true` —— **证明该用例确实能抓到本缺陷**。
- **防再犯**：**模板里读 `x.y.z` 前必须确认 `x.y` 存在**——`diffText` 是"可空字段"（同文件里 `isSame ? null : computeTextDiffLines(...)` 是通用写法），
  凡是这种"差异时才有值"的字段，模板一律 `v-if` 守卫。`vite build` 只验编译，**这类渲染期 TypeError 只有冒烟能抓到**。
- **来源**：2026-09-21 查重链路专项排查（[`../规格与计划/查重引擎/查重扫描与检索-最终方案.md`](../规格与计划/查重引擎/查重扫描与检索-最终方案.md) §2.2）

> 📌 测卡区的两条新缺陷（状态栏空白、翻页控件不可见）归 **CT 领域**：[CT-13 / CT-14](BUG-测卡工作区.md)。

---

### AR-40 ｜ 🔴 点「世界书库」/ 导入世界书 → 整个侧边栏消失（模板调用未绑定的 `wbEntryCount` / `selectWorldbook`）

- **现象**（2026-09-21 用户报告）：点击侧栏顶部「🌍 世界书库」按钮、或**导入世界书**后，
  **整个左侧边栏（含模式切换按钮自身）全部消失**，界面只剩主编辑区；再点别处也回不来（侧栏组件已被 Vue 卸载）。
- **根因**（**渲染期 TypeError，`vite build` / `npm test` 都查不出**）：
  `js/components/SidebarPanel.vue` 世界书分支的模板里有 `{{ wbEntryCount(wb) }} 词条`（词条数徽标）
  与 `@click="selectWorldbook(wb)"`（点书名切换当前编辑对象），
  但 **`wbEntryCount` 与 `selectWorldbook` 都没有出现在该组件 `setup()` 的 return 对象里**。
  → 渲染该分支时 `_ctx.X is not a function` → 渲染函数抛异常 → Vue 卸载整个 `SidebarPanel`
  → 侧边栏消失（连模式切换按钮一起没了，所以"回不来"）。
  运行时日志（`npx electron . --enable-logging`）：
  ```
  [Vue 错误] render function | 组件: SidebarPanel | _ctx.wbEntryCount is not a function
  TypeError: _ctx.wbEntryCount is not a function
  ```
- **为什么只在世界书模式触发**：这两个符号只被世界书列表用到（`v-for="wb in wbPageSlice"` 内），
  角色卡 / 预设 / 插件三个分支不碰它 → 那三个模式一直正常，故长期未被发现。
- **为什么漏了**：`App.vue` 侧（定义 + `useWorldbooks` 解构 + `ctx` 暴露）**三步齐全**（`App.vue:5766` 确有这两个符号），
  漏的是 **AR-13 四步链的第 4 步（子组件 setup return 解构）**。
  既有的 [`scripts/pychecks/ctx_exposure.py`](../../scripts/pychecks/ctx_exposure.py) 只校验 **App.vue 的 ctx 暴露**（第 3 步），
  **不覆盖子组件 return**（第 4 步）→ 机器防线存在盲区。
- **修复**（`js/components/SidebarPanel.vue`）：在 setup return 对象里补
  `wbEntryCount: ctx.wbEntryCount,` 与 `selectWorldbook: ctx.selectWorldbook,`。
- **⚠️ 二次踩坑（本次修复的真正难点，务必记住）**：首次修复**没有生效**，原因是新加的静态检查器
  **自己失明**——两个独立缺陷叠加：
  1. **模板截断**：`src.indexOf('</template>')` 只取**第一个** `</template>`。
     本组件模板有 **7 个**（每个 `v-if` 分支一个，行 157/266/364/564/625/697/709），
     世界书分支在第 4 个块（行 ~496）→ **根本不在待检文本里** → 检查器对世界书分支完全失明。
     正解：`src.lastIndexOf('</template>')`（根模板结束）。
  2. **注释冒充绑定**：return 块里写了 `// 🛡️ AR-40：wbEntryCount 被模板调用…` 的**说明注释**，
     被键名正则当成了键名 → 「注释里提一下」就等于「已绑定」→ 假绿。
     正解：提取键名前先 `stripComments`。
  - 附带第三处：CSS 函数误报 —— 内联 `style="grid-template-columns: repeat(2, minmax(0, 1fr))"`
    里的 `repeat(` / `minmax(` 被当成 JS 调用。正解：解析模板前 `stripStyles`（剥内联 style 与 `<style>` 段），
    **而不是**加白名单（白名单会连带掩盖真缺失）。
- **验证**（2026-09-21）：
  - 修复前：dev 实例 + CDP 实测，日志出现上述 `[Vue 错误]`，`document.querySelector('aside')` 为 `null`；
  - 修复后：`scripts/probes/_probe-wb-sidebar-crash.mjs` 端到端 **8/8 通过**（点世界书库 / 反复切模式 →
    `aside` 存活、内容 5.2 万字符、无 `_ctx.*` 错误）；导入场景（展开高级区 + URL 导入入口）同样侧栏存活、列表渲染出「N 词条」徽标；
  - `npm test` **460 全绿** + `npm run build:web` 无错 + 真实启动冒烟无 `crash.log`。
- **防再犯**（**本条最重要**）：已在 `test/sidebarBindings.test.mjs` 增加**静态断言** +
  **3 条自检用例**把上面每个坑钉死：
  - `AR-40：SidebarPanel 模板调用的每个函数都必须出现在 setup return 里`（主断言）；
  - `自检 —— 该断言确实能抓到缺失`（防止检查逻辑本身失效）；
  - `注释里提到某符号**不能**算作已绑定`（坑 2）；
  - `内层 v-if 分支模板里的调用也必须被检查（多 </template> 不能截断）`（坑 1）。
  - **反向验证**（本轮补做）：临时移除 `selectWorldbook` 真绑定 → 测试**确实失败**并点名该符号；
    恢复后 5/5 全绿 —— 证明防线真实有效，不是"假绿"。
- **来源**：2026-09-21 用户报告「点击世界书库时侧边栏消失」→「导入世界书导致侧边栏崩溃」
  （Phase 3 实施期间发现，**属历史缺陷**：`git show HEAD:js/components/SidebarPanel.vue` 中同样没有这两个绑定，
  引入于 `87183be` Phase 1+2 提交）。

---

### AR-41 ｜ 🟡 查重差异弹窗「看不出差异」（词条正文无着色 + 两侧行不对齐 + 切块不保留位置）

- **现象**（2026-09-21 用户反馈）：查重对比界面打开后，**词条正文是纯文本直出**（`text-zinc-400`，无任何着色）；
  正文一长、或只改了几个字，**肉眼完全看不出差异** —— 用户描述为「字符过多查看对比不明显，变动较小对比出来也不明显」。
- **根因**（三处叠加）：
  1. **词条正文区零着色**：`DiffModal.vue` 的 `isEntryPairs` 分支里，正文是 `<div>{{ contentA }}</div>` 直接输出，
     只有**整条词条**的「[新增]/[缺失]/正文有改动」徽标，**没有行级着色**；
  2. **通用分支两侧各自滚动**：`computeTextDiffLines`（`useDedupe.js`）返回 `{ masterLines, compareLines }` 两份独立数组，
     组件渲染成**两个独立滚动容器** → 左第 5 行与右第 5 行在屏幕上**不在同一水平线**，无法逐行对照；
  3. **切块算法不保留位置**：旧实现是「按标点切块 + `Set` 集合匹配」——
     `set2.has(chunk) ? 'same' : 'removed'`，**同一句话只要出现在对端任意位置就算「相同」**，
     丢失了「在第几行」的位置信息，也无法表达「这一行改了」。
- **修复**（新增 `js/utils/textDiff.js` + 改造 `DiffModal.vue` / `useDedupe.js`）：
  - **行级 LCS 对齐**：先剥**公共前缀行 / 后缀行**（小改动场景下中间段很短，LCS 规模因此可控），再对中间段做 LCS；
  - **变更块内「删+增」配对为 `changed`**：而不是拆成两条独立记录 —— 这才是「这一行改了」的表达；
  - **行内 token 级精确高亮**：对 `changed` 行先剥公共前后缀，再对中间段做 token 级 LCS
    （拉丁/数字按**整词**成 token，CJK 与标点按**单字符**）；这样 `the system` → `the systen` 只高亮 `m`/`n`，
    而不是整行标红；
  - **两侧共用同一份 `rows`**：每行带 `a` / `b` 两侧内容（某侧缺失时为 `null` 占位）→ 组件顺序渲染即**天然对齐**，
    彻底消除「各自滚动对不齐」；
  - **性能保护**：行级 LCS 超 1500 行 → 退化为按位置逐行比对并置 `truncated`；
    单行行内 LCS 规模积超 25 万 → 该行整段标记；全篇行内预算 300 万 → 超出自动降级。**降级后两侧仍严格对齐**。
  - **配色**：行底色 rose(本端缺失) / emerald(对端新增) / amber(双方都有但内容变了)；
    行内高亮用同色系 `/40`、`/35`；触发词 chips 也按「本侧独有」着色（用户报的是正文，但触发词改了同样该一眼看到）。
- **⚠️ 实现中踩到的两个坑**：
  1. **空 `marks` 不等于「整段变更」**：`你好世界` → `你好，世界！`（右版插入标点，左版原样保留）时，
     行内 LCS 会返回**空的 `marksA`**；若此时「回退成整段标记」，就会把左版整行标红 →
     用户误以为「左版也改了」——**误导性最强的一类错**。正解：空 marks 就是「这一侧没有变更」，直接返回空。
     （「LCS 完全失败」的情形已由上层 `coarse()` 分支处理，不会走到这里。）
  2. **探针里不能写正则字面量**：`_probe-diff-coloring.mjs` 把 JS 作为**字符串**发给 CDP 求值，
     正则里的 `\/`、`\d` 会在「模板字符串 → CDP」**两层转义**中被吃掉 → `SyntaxError: Invalid or unexpected token`。
     正解：改用 `includes` 字符串判断；测试数据用 `JSON.stringify` 注入（而非手写 `\\n`）。
- **验证**（2026-09-21）：
  - 单测 `test/textDiff.test.mjs` **11 条全绿** —— 含「只在一侧插标点时**另一侧不得被标成变更**」（坑 1 的反例）、
    「超长文本降级后两侧仍严格一一对应」、「变更块内删多于增 / 增多于删时的占位对齐」、「`\r\n` 归一化」；
  - **端到端 UI**（`scripts/probes/_probe-diff-coloring.mjs`，dev + CDP，走 App 真实入口）**15/15 通过**：
    三种行底色齐备、**11 处行内精确高亮**（样例含 `，并散发着微弱的蓝光`、`行只存在于旧版`）、
    **两侧行号列数量相等（左 13 / 右 13）**、触发词差异着色生效、无渲染期错误；
  - **截图肉眼确认**：右侧 `，并散发着微弱的蓝光` 高亮、左侧删行整行红底、行号左右一一对应；
  - 既有 `scripts/probes/_probe-diff-align.mjs` **15/15 仍通过**（无回归）；`npm test` **471 全绿**；`npm run build:web` 无错。
- **防再犯**：`test/textDiff.test.mjs` 把三条「容易写错且错了会误导用户」的语义钉死：
  ① 两侧行必须一一对应（某侧缺失给 `null` 占位，否则左右错位）；
  ② 只在一侧发生的变更**不得**把另一侧也标成变更；
  ③ 小改动要定位到**具体字符/词**，而不是整行标红。
- **来源**：2026-09-22 用户反馈「对比条目的不同…字符过多查看对比不明显，变动较小对比出来也不明显，
  希望对条目内容增加颜色使对比更明显」。

### AR-42 ｜ 🔴 **进度条挂错了地方（设计跑偏）**：把「查重的进度」做成了「浏览库的进度」
- **现象（用户报）**：「进度条安置错误功能错误，进度是放到**查重中和版本对比中**体现的，
  是用来扫描库中重复或者查重时扫描的进度…不是在世界书库中加载数据的体现，这是个错误的设计」
- **规格原文证实用户判断正确**（`docs/规格与计划/查重引擎/查重扫描与检索-最终方案.md`）：
  - §363 `TC-07`：「**上百本世界书查重**：有进度指示 + 当前项名，平滑前推至 100%，结束有 Toast」
  - §185：「结论：进度应挂到**扫描阶段**」
  ⇒ **设计意图 = 查重流程内的进度**；实现却挂到了**世界书库列表上方**。
- **根因（两层）**：
  1. **位置跑偏**：Phase 3 实现把进度条放在 `SidebarPanel.vue` 模式切换**之外**，
     注释还刻意写明「任何视图下扫描都能看到」——触发点变成 `scanWorldbookDir`（**浏览库**），
     于是「浏览库有进度条、真正耗时的查重/版本对比反而全程无进度」，语义完全反了；
  2. **数据源缺失**：`startWorldbookDedupeScan` **不重扫库**（直接读内存 `worldbooks.value`）
     → 即使想把进度放进查重，也**没有任何可推进的量**。
- **连带发现**：4 个查重弹窗（`WbDedupeModal` / `DedupeModal` / `PresetDedupeModal` / `ContentDedupeModal`）
  **全都只有 `show` / `groups` 两个 props**，没有任何进度 UI。
- **修复（2026-09-22 已完成）**：

  | 步骤 | 改动 |
  |---|---|
  | ① 进度条移入查重弹窗 | 新增 `js/components/DedupeScanProgress.vue`（纯展示、三种配色、支持**不定态**），`WbDedupeModal` / `DedupeModal` / `ContentDedupeModal` 共用（**不复制三遍**，避免再次走样） |
  | ② 查重前先重扫磁盘 | `useWorldbooks.js` 新增 `rescanWorldbooks(dir)`；`useDedupe.js` 新增 `rescanForWorldbookDedupe` / `rescanForCardDedupe`，三个查重入口（同名/世界书/内容级）在判空前先重扫 |
  | ③ **先开弹窗再重扫** | ⚠️ 顺序关键：若先扫完再开弹窗，**扫描期间用户看不到进度条**（实测踩到，进度条等于白做）。同时给三个弹窗的空态加「扫描中」分支，避免误报「已清理完毕」 |
  | ④ 浏览库改日志反馈 | `scanWorldbookDir` 不再占用进度条，改 `addLog('⏳ 正在读取目录内的世界书文件…')` + `addLog('扫描完成，共加载 N 本')`（保留「正在扫描」的可见反馈，对照 AR-38） |
  | ⑤ 侧栏移除进度条 | `SidebarPanel.vue` 删除进度条 DOM 与 `wbScanProgress`/`isWbScanning`/`wbScanPercent` 绑定，并**留注释防止再挂回来** |
  | ⑥ `wb:scan` 加 `rescan` 选项 | 跳过「新目录指纹验证」——该验证只 `readdir` **顶层**，**顶层全是子目录**的世界书库会被误拒；安全边界不变（仍受 `isPathAllowed` 白名单约束） |
- **真实进度 vs 假进度（刻意的取舍）**：
  - 世界书侧有 `wb:scan` 分批心跳 → 用**真实** `done/total/当前文件名`；
  - 角色卡侧 `refreshLibrary` **没有进度通道**（只给末尾 Toast）→ 用**不定态滑动条**，
    **不编假百分比**（宁可诚实地「在进行中」，也不给用户一个假数字）。
- **验证（`scripts/probes/_probe-dedupe-progress.mjs`，真实 100 本库 + 真实 IPC，15/15 通过）**：
  - 浏览库：侧栏**无**进度条、`wbScanProgress.phase` 保持 `idle`、日志出现「正在读取…」与「扫描完成，共加载 100 本」；
  - 查重：**71 次**进度采样、`done` 到 **100/100**、**54 次**带当前文件名、`phase` 序列 `parsing→done→idle`；
  - ★ 关键断言：**扫描期间弹窗内确实出现进度文案**（`withProgress=true`）；
  - 查重结束进度收起、侧栏仍无进度条、无渲染期错误。
- **顺带修掉一个 TDZ 崩溃（AR-06 / AR-17 同款）**：`useDedupe` 需要 `rescanWorldbooks`，
  但它原本在 `useWorldbooks` **之前**调用 → 运行时 `Cannot access 'X' before initialization`。
  **`vite build` 完全查不出来**（只有真实启动才暴露）—— 已把 `useDedupe` 调用移到 `useWorldbooks` 之后，
  并在调用处写死顺序约束注释。
- **来源**：2026-09-22 用户指出设计错误（世界书 500 份压力测试期间）

### AR-43 ｜ 🔴 进度条**数字恒显示「0 / ?」**（而宽度正常推进）
- **现象（用户报）**：「进度条后面是不是有数字显示？/0 是什么意思，不应该在进度条走动的时候，有数字改动么」
  —— 用户看到进度条**宽度在动**，但右侧数字**从头到尾都是 `0 / ?`**。
- **根因**：`App.vue` 里新增的 `dedupeScanProgressForModal`（computed）**只定义在 setup 局部，未加入 setup 的 return**。
  → 模板（走 setup return，不是 ctx）拿到 `undefined` → `DedupeScanProgress` 的 `progress` prop 回落默认值
  `{ phase:'idle', done:0, total:0, current:'' }` → 渲染成 `0 / ?`。
- **为什么现象很隐蔽**：**宽度与数字走的是两条不同路径** ——
  - 宽度：`:percent="dedupeScanPercent"`（这个**已**在 return 里）→ 正常推进；
  - 数字：`progress.done / progress.total`（来自漏掉的 `dedupeScanProgressForModal`）→ 恒为 0。
  所以看起来「进度条是好的」，只有数字不动。若两者都坏，反而一眼能发现。
- **同类病**：AR-13（`ctx` 漏暴露）、CT-14 / CT-15（模板访问不到 setup 局部变量）。
- **修复**：把 `dedupeScanProgressForModal` 补进**两处** setup return（`ctx` 组装处 + 模板 return 处），
  并在原处写死注释说明「它是 computed，模板走 setup return 不是 ctx」。
- **验证（`scripts/probes/_probe-dedupe-ux.mjs`）**：修复前数字序列 `["0 / ?"]`（1 个取值）；
  修复后 `["29 / 97 （0%）","64 / 97 （30%）","97 / 97 （66%）","0 / ?"]`（**4 个取值，确实在走动**）。
  另给进度组件加 `data-testid="dedupe-scan-numbers"` / `dedupe-scan-bar` 便于精确测量。
- **测试教训（重要）**：v1 探针用正则 `/^\s*\d+\s*\/\s*\d+/` 找数字 → **误匹配到分页控件「1 / 4」**
  （100 本 / 每页 25 = 4 页）→ 得出「只有 1 个取值」的错误结论。
  ⇒ **断言必须用稳定选择器（`data-testid`），不要靠文案正则猜元素**。
- **来源**：2026-09-22 用户 UX 反馈（问题 1）

### AR-44 ｜ 🟡 第二次查重「**只看到进度条、结果却早已列出来**」
- **现象（用户报）**：「当第一次查重时会扫描，关闭后第二次打开只看到进度条，扫描的数据早已经列举了出来，这是什么原因，是缓存么」
- **根因**：查重入口为了「让进度条在扫描期间可见」，改成了**先开弹窗再重扫**（AR-42 的修复）。
  但**没有清空上一轮的 `groups`** → 弹窗一打开就渲染着**上一次的查重结果**，
  用户在扫描期间看到的是「结果早就列出来了、只有进度条在动」—— **数据是旧的却看不出旧**。
- **不是缓存问题**：与 `scan_cache.json` 无关（那只是「文件 mtime 未变则跳过 parse」的增量缓存），
  纯粹是**渲染层状态没复位**。
- **修复**：三个查重入口（同名 / 世界书 / 内容级）在扫描前清空各自的结果数组：
  `wbDuplicateGroups.value = []` / `duplicateGroups.value = []` / `contentDuplicateGroups.value = []`。
- **验证**：修复前「弹窗已开 + 扫描中 + 已有结果」的采样 **4~6 次**（命中缺陷）；
  修复后 **0 次**。
- **来源**：2026-09-22 用户 UX 反馈（问题 2）

### AR-45 ｜ 🟡 查重进度条「**反复横跳、时长时短，最后变成滚动的光条**」
- **现象（用户原话）**：「进度条移动时反复横跳时长时短，最后变成了滚动的光条」
- **根因（四处叠加，全是「进度状态机」没设计好）**：

  | # | 现象 | 代码根因 |
  |---|---|---|
  | ① | **反复横跳** | 查重是**多阶段**流程（重扫 → 逐本算指纹 → 比对），但**每个阶段的 `finally` 都 `resetDedupeScan()`** → `scanning` 变 false → 进度条**消失**，下一阶段再变 true → **又出现** |
  | ② | **时长时短** | 阶段 1（重扫）的同步定时器可能已把 `percent` 推到 **97%**，而阶段 2 的起始值**硬编码 `= 50`** → **97 → 50 倒退** |
  | ③ | **最后变成滚动的光条** | 内容查重阶段 2 置 `dedupeScanIndeterminate = true` → 组件切到**滑动动画**（`@keyframes dedupeScanIndeterminate`），而用户此时明明看得到有进度却不再显示百分比 |
  | ④ | （叠加） | 各阶段自己 reset → 进度条在阶段交界处**闪烁**（DOM 卸载再挂载） |

- **修复（4 处，缺一不可）**：
  1. **新增 `finishDedupeScan()`**（`useDedupe.js`）——**统一收尾**：推到 100% → `label='查重完成'` →
     `scanning=false` → 停留 400ms → `resetDedupeScan()`。**只在整条流程结束时调一次**；
  2. **阶段划分单调递增**：阶段 1 映射 **0~50%**、阶段 2 继续 **50~100%**；
     且所有赋值改 `Math.max(当前值, 新值)` —— **保证绝不倒退**（修 ②）；
  3. **全程确定态**：内容查重阶段 2 不再置 `indeterminate = true`（修 ③）；
     ⚠️ **角色卡侧保留不定态**是**有意设计**（`refreshLibrary` 无进度通道，不编假百分比）；
  4. **`rescanForWorldbookDedupe` / `rescanForCardDedupe` 新增 `keepAlive` 选项**：
     阶段切换时**不 reset**（修 ①④）；所有 early return / catch 出口都调 `finishDedupeScan()`。
- **验证**：新增 `scripts/probes/_probe-progress-continuity.mjs`（页面内 20ms 高频采样 + 5 条断言）：

  | 断言 | 修复前 | **修复后** |
  |---|---|---|
  | ① 不横跳（扫描窗口内 `scanning` 无 false 中断） | 有中断 | ✅ **0 次** |
  | ② 不倒退（`percent` 单调不减） | **97→50** 倒退 | ✅ **0 次**（区间 0~99） |
  | ③ 不变光条（`indeterminate` 全程 false） | 阶段 2 为 true | ✅ **0 次** |
  | ④ 不闪烁（组件 `visible` 全程 true） | 有闪烁 | ✅ **0 次** |
  | ⑤ 终态到达 100% | — | ✅ **100%** |

  另加 `test/dedupeProgress.test.mjs`（**8 条单测**，含 4 条**反例**证明断言真能抓到该缺陷）。
- **⚠️ 教训（通用）**：**多阶段流程的进度条必须有一个「统一状态机」**——
  各阶段只负责**推进**（单调），**只有**流程出口负责**收尾**。
  让每个阶段自己 `reset` 是「进度条横跳」的结构性原因，不是偶然 bug。
  > 另注：本缺陷的**探针判据**也踩过坑 —— 最初把 `finishDedupeScan` 的「100% → 归 0 收起」
  > 误判为「倒退」。**收尾归零是正常行为**，判据必须只在 `scanning === true` 的窗口内检查单调性。
- **来源**：2026-09-22 用户实测反馈（进度条 UX）

### AR-46 ｜ 🔴 AR-45 二次报出「**又横跳**」（2026-09-23，首次修复不彻底）
- **现象（用户原话）**：「当前的测试中又出现的反复横跳的进度条，你不是修复了这都修复了个啥，假修复么」
- **真因（首次修复的**结构性遗漏**）**：**进度条有两条不同源的数据路径**，而首次修复与探针**只覆盖了一条**：

  | 元素 | 数据源 | 谁维护 |
  |---|---|---|
  | **条宽** | `dedupeScanPercent`（`useDedupe.js` 的 ref） | 查重自己，持续推进 ✅ |
  | **数字** | `dedupeScanProgressForModal`（`App.vue` computed）→ **透传 `wbScanProgress`** | `useWorldbooks`，**扫描**的进度对象 ❌ |

  `wbScanProgress` 在**扫描开始与结束**时都会被置为 `{done:0,total:0}`（那对「扫描」是正确语义），
  而 `DedupeScanProgress.vue` 渲染逻辑是：

  ```html
  {{ progress.done }} / {{ progress.total || '?' }}
  <span v-if="progress.total">（{{ percent }}%）</span>   <!-- total=0 时百分比整块隐藏 -->
  ```

  ⇒ 扫描一结束，**条宽继续推进到 100%，数字却掉回「0 / ?」且百分比消失** —— 这就是用户看到的「横跳」。
- **⚠️ 与 AR-43 是同一类病**：AR-43 是「`dedupeScanProgressForModal` 漏进 return」导致**数字恒 0 / ?**；
  本次是「数字走了一条会归零的数据源」——**两次都是「宽度与数字两条路径」这个设计缺陷的变体**。
- **为什么首次「5/5 通过」是假绿**：`_probe-progress-continuity.mjs` 只采
  `ctx.dedupeScanPercent`（宽度）+ `indeterminate`，**完全没采数字文本、也没采 `wbScanProgress`**
  ⇒ **探针盲区**。这是「探针覆盖不足 → 假绿」的典型。
- **修复（3 处，核心是「统一数据源」）**：
  1. **新增统一写入入口 `applyDedupeProgress({percent,done,total,label})`**（`useDedupe.js`）——
     `percent` 走 `Math.max` 单调保护；`done/total` **成对更新**（`total<=0` 视为「未知」，
     **不覆盖**已知值）；收尾时自动把 `done` 对齐到 `total`。
     **所有进度赋值点全部改走它**（旧实现有 8 处裸赋值，其中 2 处无 `Math.max`）；
  2. **数字改读查重自己的 ref**：新增 `dedupeScanDone` / `dedupeScanTotal`，
     `App.vue` 的 `dedupeScanProgressForModal` **不再透传 `wbScanProgress`**，改为读这两个 ref
     ⇒ **数字与条宽同源同寿命**，物理上不可能脱钩；
  3. **阶段 2 补上数字推进**（旧实现只更新 `percent`，数字停在阶段 1 的扫描值）；
     阶段 1 的同步定时器改为**跳过 `total<=0`**（不再把进度拽回 0）。
- **验证**：
  - `_probe-progress-continuity.mjs` **扩到 9 条断言**（新增 ④ 数字与条宽一致 / ⑤ 数字不出现「0 / ?」
    / ⑥ 数字单调 / ⑦ 终态 `done===total`）→ **9/9 通过**；末帧 `1081 / 1081（100%）`
    （修复前此处是「条 100%、数字 0 / ?」）；
  - `test/dedupeProgress.test.mjs` **8 → 13 条**（新增 5 条，含 1 条**反例**证明断言有效）；
  - `npm test` **509 pass / 0 fail**；`npm run build:web` ✅；真实启动冒烟无 `[Vue 错误]`。
- **⚠️ 教训（通用，已加入本文件顶部）**：
  1. **「同一个 UI 元素的两部分」绝不能走两条独立数据源** —— 否则必然在某条路径上脱钩；
  2. **修 UX 缺陷时，探针必须采「用户实际看到的东西」**（渲染后的 DOM 文本），
     而不是只看自己方便拿到的内部变量 —— 否则就是**假绿**；
  3. **散落的赋值点是 bug 温床**：8 处赋值里 2 处漏了单调保护 → 必须收敛到**唯一写入入口**。
- **来源**：2026-09-23 用户二次实测反馈（进度条 UX，明确质疑「假修复」）

---

### AR-47 ｜ 🟡 角色卡查重「**全程滚动光条**」（不定态泄漏到有真实进度的阶段）

- **现象（用户原话）**：「角色卡的查重界面出现了进度条滚动光条效果」
- **真因**：`rescanForCardDedupe()` 因「角色卡重扫（`refreshLibrary`）**没有进度通道**」
  而置 `dedupeScanIndeterminate = true`（这条设计本身没错 —— 不编假百分比）。
  但 `startDedupeScan()` **重扫后从不复位它** ⇒ 之后「算 Token / 读文件信息 / 组装分组」
  这些**完全有真实进度**的阶段，全部在**不定态**下进行。

  | 阶段 | 真实进度可得？ | 旧实现显示 | 应有显示 |
  |---|---|---|---|
  | 重扫磁盘（`refreshLibrary`） | ❌ 无通道 | 滚动光条 ✅ 正确 | 滚动光条 |
  | 算 Token / 读文件信息 / 组装分组 | ✅ 有 | **滚动光条 ❌** | 确定态 0~100% |

  📊 真实库（11,188 张）实测：重扫约 **10s**，用户全程只看到一条来回滑动的光条（**零信息量**），
  符合 AR-38「零反馈 = 坏了」的观感。
- **修复**：
  1. `rescanForCardDedupe` **结束时调用方立刻切回确定态**（`dedupeScanIndeterminate = false`）；
  2. 后续阶段补**真实进度**：算 Token/组装分组 **0~90%**、读文件信息 **90%**、仅名称校验 **95~99%**、
     收尾 **100%**（全部走 `applyDedupeProgress` 唯一入口）；
  3. 同步循环改 **`for` + 每 N 项让出主线程**（旧 `map` 纯同步 → 赋值了但**画面不更新**）。
- **⚠️ 顺带修掉一个「反向」瑕疵**：新流程开始时的**重置**若走统一入口，
  会被其 `Math.max` **单调保护**挡住 → **上一轮残留百分比被保留**
  （实测时间线出现 `I61` 而非 `I0`，切确定态时会「闪跳」）。
  ⇒ 约定：**重置用裸赋值，流程内推进走统一入口**（`resetDedupeScan` 同理）。
- **验证**：`_probe-card-diff-forensic.mjs` 采样时间线
  `I0 I0 I0 -95 -96 … -100`（**只有重扫阶段是不定态**，其余全程确定态递增；
  修复前为 **全程 `I0`**，且残留值显示 `I61`）。
- **来源**：2026-09-23 用户实测反馈（角色卡查重 UI）

---

### AR-48 ｜ 🔴 同名查重「**聚错组**」→ 对比弹窗两侧是**完全无关的两张卡**，且可一键误删

- **现象（用户原话）**：「角色卡对比查重功能出现了严重的错误，对比错误，角色卡错误卡片和对比卡片都不对」
- **真因（**分组口径**，不是比对逻辑坏了）**：同名查重**只按「卡内 `name` 字段」聚类**。
  真实库里存在**大量 `name` 撞车但内容毫无关系**的卡。实测真实库（11,188 张 / 1910 组）：

  | 指标 | 实测值 |
  |---|---|
  | 同名分组总数 | **1910** |
  | 组内最大相似度 **< 20%**（即内容无关） | **350 组（18.3%）**，其中**很多直接 = 0%** |
  | 典型实例 | 9 张卡都叫「花宁娜」内容零重合；17 张都叫「菜菜子」；6 张叫「观世音菩萨」 |

  **用户看到的那一组**：`带着异常能干的后宫勇闯异世界的我只要享受就可以了.png`（描述 **2990 字**）
  与 `明日方舟：龙娘四姐妹[V1.0].png`（描述 **256 字**）——
  **两张卡的卡内 `name` 竟然都是 `"1"`**（已用独立脚本直读 PNG 内嵌元数据核实：前者 `chara_card_v3`、
  后者 spec v3 但 name 为 `Nian` 却被读成 `1`）。
  ⇒ 弹窗把两张**毫不相干**的卡渲染成「同一角色的两个历史版本」，
  而按钮是「✅ 保留此版，**清理其余**」⇒ **一键就会误删真卡**（不可接受）。
- **⚠️ 为什么「差异比对」本身没错**：`openDiffDetailModal` 正确展示了
  「描述 2990 vs 254 字 / 开场首句 2062 vs 1296 字」——**它比的是被传进来的两张卡，而这两张卡是被**聚错**的**。
  ⇒ 用户感知的「对比错误」= **上游分组错误**的下游表现（**修比对是治错了病**）。
- **修复（3 处）**：
  1. **加「仅名称相同」判定**：对参与同名的卡算 **simhash**（与世界书内容查重**同算法同阈值**），
     与「推荐版」汉明距离 **> 24** 即标 `_nameOnly`。
     **阈值实测**（`_probe-card-simhash-dist.mjs`，真实库 3907 张）：
     同名**且同源**组内距离 p50 = **0** / p75 = 0；**随机无关**两两 p50 = **31** / p25 = 28
     （与理论期望 32 吻合）⇒ **间隙极大，T = 24 安全**。
     成本实测：4547 张 / 约 **2.0s**（一次性，只对参与同名的卡算）。
  2. **弹窗明确标注**：组标题给「⚠️ N 个仅名称相同（内容无关）」；卡片加红边 + 「仅名称相同·内容无关」角标 +
     可验证依据（「内容指纹相差 31 位（>24 判为不同源）」）；清理按钮降级为**红色警示文案**。
  3. **清理二次确认加警示**：待清理项含 `_nameOnly` 时，`confirmDialog` 文本**列出前 5 个文件名**
     并提示「很可能是完全不同的角色，建议先对比再清理」。
- **🌍 世界书侧同类问题一并修**：世界书同名查重**只按书名分组**，同样会聚出「同名但触发词无交集」的书。
  复用**已在手**的 L1a Jaccard（**零额外成本**），重合度 **< 5%** 即标 `_nameOnly`
  （实测同名同源书普遍 ≥ 50%，无关书 ≈ 0%，间隙极大）→ `WbDedupeModal` 同款标注 + 清理警示。
- **验证**：`_probe-card-diff-forensic.mjs` 中用户实际那一组 → `nameOnly: true, dist: 31`（>24 正确命中）。
- **⚠️ 教训（通用）**：
  1. **「按名称聚类」这类启发式，必须给出「名称之外的第二判据」** ——
     否则在真实脏数据（占位名 / 撞名 / 读取异常）下会大面积误报；
  2. **凡「一键批量删除」入口，判据不充分时必须降级为「警示 + 二次确认」**，绝不能静默执行；
  3. **用户报「对比错误」时，先验证「传进来的数据对不对」** —— 可能上游就已经错了（本次即是）。
- **来源**：2026-09-23 用户实测反馈（角色卡对比查重）

---

### AR-49 ｜ 🔴 AR-47 修复**漏了内容查重**→ 两个查重全程「滚动光条」，确定态 **0 帧**

- **现象（用户原话）****：「角色卡查重的滚动条又出现了光标滚动 BUG，**名字查重和内容查重两个都有**，
  这已经是出现了 N 次的 BUG 了」** —— 用户明确点出「**两个都有**」+「**N 次**」（AR-45/46/47 已修三轮）。
- **真因（AR-47 修复**只打了一半**）**：AR-47 的复位语句 `dedupeScanIndeterminate.value = false`
  只加在了 `startDedupeScan()`（**名字查重**）里，`startContentDedupeScan()`（**内容查重**）**漏了**。

  | 流程 | 重扫前复位 | 重扫（置 true）| 重扫后复位 | 结果 |
  |---|---|---|---|---|
  | `startDedupeScan`（名字） | ✅ | 置 true | ✅ 有 | 正常（仅重扫期光条）|
  | `startContentDedupeScan`（内容） | ✅ | 置 true | ❌ **漏** | **全程光条** |

  ⚠️ 内容查重的复位写在**重扫之前**（`useDedupe.js` 的 `dedupeScanIndeterminate.value = false`
  紧挨 `dedupeScanLabel.value = '正在扫描库文件…'`）→ 重扫一执行就被 `rescanForCardDedupe` **覆盖回 `true`**，
  此后**再不复位** ⇒ 「逐张算指纹」「读文件信息」这些**有真实进度**的阶段全在不定态下跑。
- **🔥 热测试取证（真实压测大库 `I:\03\角色色卡`，11,186 张）**：

  | 流程 | 耗时 | 总帧 | **滚动光条帧** | **确定态帧** | 光条出现的阶段 |
  |---|---|---|---|---|---|
  | 名字查重 | 26.8s | 93 | **33** | **0** | 正在扫描角色卡库 |
  | 内容查重 | **104.2s** | 507 | **505** | **0** | 扫描 + **逐张提取算指纹（11186 张）** + **读取文件信息（4097 本）** |

  内容查重**整整 104 秒全程光条**，用户看不到任何百分比/数字（`⏳ 扫描中…` 贯穿到底）。
  ⚠️ 采样用的是 **DOM 渲染结果**（`getComputedStyle(bar).animationName !== 'none'` + 数字文本），
  不是内部变量 —— 这正是 AR-46「假绿」的教训（当时探针只采内部 ref，5/5 全绿却仍是坏的）。
- **修复**：
  1. **`startContentDedupeScan` 重扫后补复位**（与名字查重同口径）：
     重扫 → 立刻 `dedupeScanIndeterminate = false` + 进度归零 → 后续阶段走确定态；
  2. **根治：把「重扫后必须复位」的约束收进 `rescanForCardDedupe` 自身**（不依赖每个调用方记得写）——
     重扫是**唯一**会把 `indeterminate` 置 true 的地方，那它就该在**结束时自己复位**，
     语义上「不定态只覆盖重扫这一段」；
  3. **探针补齐**：`_probe-card-diff-forensic.mjs` 的采样**同时覆盖两条流程**（原先只跑 `startDedupeScan`）。
- **⚠️ 教训（通用，这是第 4 次同型缺陷）**：
  1. **「同一段修复要应用到所有同构调用点」** —— AR-47 修了名字查重、漏了内容查重，
     而两者**调用同一个 `rescanForCardDedupe`**，症状必然同现（用户「两个都有」正是此意）；
  2. **修「状态泄漏」类缺陷，优先把约束收进「产生该状态的那个函数」**，
     而不是让每个调用方各自记得复位 —— 调用方会漏（本次就漏了），函数自己不会；
  3. **热测试必须覆盖「用户报的全部入口」**：用户说「两个都有」时，只测一个就宣布修好 = 必然返工。
- **来源**：2026-09-24 用户实测反馈（第 4 次报进度条/光条类缺陷）

---

### AR-50 ｜ 🔴 「双口径 OR」闸门**误报**：无关卡被判同源（一键可删）× 展示取 `max` **虚报 100%**

- **现象（用户原话）**：「这两本书的**内容怎么会是完全一致**，**看大小就能看出来不一致**，
  只对比名字么，这是内容级的对比算法显然出现的问题」
  —— 弹窗里 `（淫力）斗罗大陆.png`（**1585.5 KB**）与 `斗罗淫师.png`（**598.5 KB**）被判一组，
  且显示「**内容重合 100%**」（同时又显示「指纹距离 28」，自相矛盾）。
- **🔥 真实文件取证**（`I:\03\角色色卡`，非合成样本）：

  | 口径 | A 长度 | B 长度 | MinHash 估计 | 真实 Jaccard |
  |---|---|---|---|---|
  | 5 字段（legacy） | 1,984 | 1,984 | **100.0%** | 100.00% |
  | **仅内嵌世界书** | 171,714 | 9,745 | **0.0%** | **1.33%** |
  | 全字段 | 175,844 | 11,730 | **2.1%** | 2.72% |

  **5 字段逐个核查**：`description` / `personality` / `scenario` / `mes_example` **全为 0 字**，
  仅 `first_mes` 各 2106 字且**逐字相同**（两卡共享的**通用开场白**）。
  **词条级核查**：A 149 条 / 673 触发词 ｜ B 20 条 / 3 触发词；B 的正文被 A 逐字包含 **0/20 条**，
  触发词覆盖仅 **33.3%** ⇒ **两卡确实无关**。
- **真因（两个独立缺陷叠加）**：
  1. **闸门误报**：AR-48 修复引入的「**双口径 OR**」（`全字段 ≥0.85` **或** `5字段 ≥0.85`）
     本意是「扩大字段覆盖不得降低既有召回」，但 5 字段支**可被共享开场白单独刷满** ——
     `first_mes` 相同的两张**完全无关**的卡，5 字段就是 100% ⇒ 聚成一组，
     而按钮是「保留此版，**清理其余**」⇒ **可一键误删真卡**（AR-48 / PK-29 同型）。
     📌 **同机制第二例**（排查中实测发现）：`梅琳娜 作者Czk (2).png` ↔ `霸道班主任爱上我.png` ——
     两卡 `first_mes` **逐字相同 1730 字**（共用同一 HTML 模板，连背景 GIF 链接都一样），
     其余字段几乎全空 ⇒ 5 字段 **97.9%**，而全字段仅 9.4%。
  2. **展示误导**：`simOf` 对两口径取 **`max()`**（当时理由：与 OR 闸门同口径、避免观感矛盾）
     ⇒ 把 `2.1%` 与 `100%` 取成 **100%**，用户以为「内容完全一样」。
     ⚠️ 这与「用户能一眼看出不对」的观感（大小差 2.6 倍）**直接冲突**。
- **📊 判据的选择（实测踩出来的三个坑）**：

  | 候选判据 | 实测结果 |
  |---|---|
  | **词条正文**相似度（首选设想） | ❌ **不可用**：大库（>3000 张）走 `slimCard` 懒加载，**词条 `content` 被清空**（实测两卡全为空串）⇒ 签名恒 `null`，闸门在大库下**完全失效** |
  | **单侧无词条/无键** → 否决 | ❌ **会误杀真同源**：`某个世界3.0` ↔ `某个世界2.0`、`鹿小鹿小楪可怜remake` 系列一侧键数为 0 ⇒ 必须加「两侧都要有键」前提 |
  | **MinHash 估计触发词相似度** | ❌ **精度不够**：阈值 0.05 与最近真同源 0.125 只差 2.5 倍，96 维在 12.5% 处标准误 ≈3.4% ⇒ 可能跌破阈值误杀 ⇒ 改用**精确 Jaccard**（键集合小，存 Uint32 哈希数组，全库约 3MB） |

- **✅ 最终判据：内嵌世界书「触发词集合」的精确 Jaccard**（懒加载下 `keys` 完整保留）：
  两侧**都有 ≥2 个键**且 `keys-Jaccard < 0.05` → **否决**；任一侧键不足 → 不否决（保持原 OR）。
- **📊 阈值标定（真实 11k 库 2316 个候选对实测）**：

  | keys-Jaccard 区间 | 对数 | 判读 |
  |---|---|---|
  | **0~1%** | **160（18.0%）** | 假同源（斗罗对 **0.15%**、梅琳娜 **0%**、诡秘之主 ↔ 归墟 **0%**） |
  | 1~10% | **1** | ← **自然空档** |
  | 10~50% | 14（1.6%） | **真同源**（`艾莎终极版` ↔ `艾莎状态栏版` **12.5%**） |
  | 50~100% | **714（80.4%）** | 真同源主体 |

  ⇒ 阈值 **0.05** 落在空档内、且远离真同源最近的 12.5%。
  ✅ **标定后否决面 = 9 对，全部人工核对为无关；12.5% 的真同源一对未伤**
  （`某个世界2.0/3.0`、`鹿小鹿…remake` 等因一侧无键而**不被否决**，符合预期）。
- **修复（4 处）**：
  1. **新增 `extractBookKeys` + `keysToHashes` + `keyJaccard`**：内嵌世界书触发词的精确 Jaccard
     （keys 在懒加载下保留；哈希数组去重排序后用双指针归并）；
  2. **闸门改为「OR 通过 → 再做触发词矛盾否决」**：
     否决放在 OR **之后**（较贵，只对少量候选对执行）；
     两侧键数各 ≥ `MIN_BOOK_KEYS = 2` 才启用；
  3. **展示不再取 `max`**：主值改取**全字段**（覆盖最全），
     当 5 字段与全字段**差距 ≥5%** 时另列一行「⚠️ 但仅 5 基础字段重合 X%」——
     **口径分歧本身就是「可疑」信号**；
     🔑 **触发词重合**一栏对角色卡**也生效了**（原先只有世界书有）—— 与世界书侧同语义；
  4. **删除 `advice` 里的 Markdown 星号**：`{{ v._simAdvice }}` 是**纯文本插值**，
     `**请勿清理**` 会**原样显示星号**（用户截图实证）→ 全部改为纯文案 + 规范注释
     （`similarityType.js` / `presetStructure.js` 五处）。
- **⚠️ 顺带修掉一个展示 bug**：**角色卡的「全字段」签名在 `sig` 里**（`_mhSig` 只有世界书分支才有）——
  旧展示读 `_mhSig` ⇒ 角色卡恒 `null`；叠加「`v === master` 恒 100%」，
  会让基准版渲染成「三口径全 100%」。现按类型取签名（`fullSigOf`）。
- **验证**：
  - `_probe-card-legacy-vs-full.mjs`（已同步 keys 判据）：斗罗对 →
    `全字段 2.1% ｜ 5字段 100% ｜ 触发词 0.1%` → **触发词矛盾否决生效（不再同组）** ✅ 1/1 与真值一致；
  - `test/similarityType.test.mjs` 62/62 通过（含「文案不得含星号」断言）；
  - 热测试（真实 11k 库）见下方实测记录。
- **⚠️ 教训（通用）**：
  1. **「OR 闸门」的每一支都必须单独验证「能否被无关样本刷满」** ——
     5 字段 OR 的初衷是「保召回」，但**没有闭合「防误报」那一半**；
  2. **新增判据前先确认「它在真实运行态下有没有数据」** ——
     想当然用「词条正文」，而大库懒加载恰好把正文清空了（**修了等于没修**）；
  3. **判据的判别间隙必须实测**，且要**直接看会不会误杀已知真同源** ——
     本次「单侧无键也否决」与「用 MinHash 估计」两个草稿都在实测中被否决；
  4. **展示值绝不能比判定逻辑更乐观**（取 `max` 会让错误被放大）；
  5. **用户说「看起来就不对」（大小差 2.6 倍）时，先当真** —— 这是最强启发式；
  6. **文案层也要过一遍「渲染方式」**：纯文本插值不解析 Markdown。
- **来源**：2026-09-24 用户实测反馈（内容级查重算法质疑）

#### AR-50 补充（同日第二轮，真实 11k 库热测试暴露的**另两种形态**）

> 用户追问：「查重的机制算法都落地了么，确定没有遗漏了吗」—— 于是把「触发词否决」上线后
> **重跑真实库并逐组人工复核**，确实还有两族误报（**都不是理论推演，是结果里真实存在的组**）。

- **形态②：「一侧完全没有内嵌世界书」时，触发词否决**不适用**（要求两侧都 ≥2 键）**
  - 实测（真实 11k 库，按「恰好一侧 0 词条」筛出 **1614 对**）：

    | 类别 | 全字段 ÷ 5 字段 | 样本 |
    |---|---|---|
    | **假同源** | **0.19** | `黑暗游乐园.png`(14 条词条) × 105 张「无书卡」 |
    | 真同源 | **0.53 ~ 0.99** | `壁窟风俗店3.0↔(2)` 0.53 ｜ `鹿小鹿…remake` 0.75 ｜ `纯爱侧` 0.93 ｜ `某个世界3.0↔2.0` 0.95 ｜ `莱莱丝的竞技场` 0.96 |

  - ✅ 新增**第二条否决**：仅当**恰好一侧无词条**时，`全字段相似度 ÷ 5字段相似度 < 0.4` → 否决。
    ⚠️ **只在「一侧 0 词条」时启用** —— 两侧都有词条时证据更强，且实测反例
    （`作为贵族管家…↔作为管家…`：16/7 词条、比值 0.17 却是**真同源**，作者重写词条致 keys 仅 2%）
    ⇒ 对它们用比值会**误杀**，故刻意不启用。
  - ⚠️ 为何不能「无条件按比值否决」：实测真同源里存在 **keys=100% 但比值 0.16~0.18** 的对
    （`1.9.4e林雨汐↔林雨汐` 34/34 词条、`5088c57c805c9492↔美国教师母亲阿什莉·米勒`）——
    它们靠「两侧都有键 ⇒ 走第一条、`return true`」被保护，**判据顺序就是保护机制**。

- **形态③：全库通用模板（分享页 / 版权声明）把「5 字段」与「全字段」**同时**刷满**
  - 实测（真实 11k 库，`≥60 字 且 被 ≥3 张共享`的字段值共 **489** 条）：
    · `first_mes` = **1730 字**分享页（背景图 + `{{char}}` 标题 + Discord 群号 + ascii 横幅）
      —— **全库 2107 张卡共用同一取值**；
    · `creator_notes` = **185 字**版权声明（`分享于破限组交流群：704819371…` + `CC BY-SA 4.0`）
      —— **全库 1381 张**共用；
    · 另有 `system_prompt`(57 张/3865 字)、`description`(34 张) 等长尾。
  - 后果：一批卡（实测 **109 张**）的 `description/personality/scenario/mes_example` **全为空**，
    唯一内容就是这两段模板 ⇒ 5 字段 84%~100%、全字段 84%~100% ⇒ **两条否决都不适用**
    （没触发词可比、比值 ≈1）⇒ 聚成 **109 张卡的巨型误聚组**
    （`梅琳娜`/`The Stalker`/`霸道班主任`/`13英寸男娘爸爸`/`booru.plus` … **彼此毫无关系**）。
  - ✅ 修法：**文档频率剥离（corpus-level DF）**—— 同一字段值被 **≥ `TEMPLATE_MIN_CARDS(5)` 张卡
    整段照抄**（且长度 ≥ `TEMPLATE_MIN_LEN(60)`）即判为模板，算指纹**前整段剔除**；
    剔除后无可比对文本的卡**退出比对并如实上报**（日志「ℹ️ 另有 N 张卡的内容全部是通用模板…」）。
  - 📊 效果（真实 11k 库同一库、同一流程前后对比）：
    · 误聚组 **113 张 → 2 张**（且那 2 张是 `黑暗游乐园.png / 黑暗游乐园 1.png` **真副本**）；
    · **全库最大组 109 张 → 8 张**；组数 1747 → 1790（巨型组瓦解成多个真版本家族组）；
    · 剔除统计：**104 段模板 / 2382 张卡**剔除模板字段后参与比对 / **104 张**卡因「全是模板」退出比对；
    · 顶级 12 组人工复核**全部是真版本家族**（咬之RPG V4.X↔V4.0↔V2.1、豆之RPG、月寒计划RPG 1.5↔1.4↔1.3、
      淑女学园都市系列、艾莎状态栏版系列、鹿小鹿…系列…）。
  - ⚠️ **已知代价（实测到的、如实记录）**：模板剥离会**动到「闸门 0.85」的既有标定** ——
    对「共享模板 + 真实内容很少」的对，剥离等于**抬高有效门槛**。实测 `艾莎终极版 ↔ 艾莎状态栏版`
    由此**从同组变为不同组**（剥前 全 85.7% / 5字段 88.2% ⇒ 剥后 **77.5% / 81.0%**）；
    两者各自仍与本系列的其他版本同组。**这是本次唯一观察到的召回损失**，若需找回需重标阈值
    （属独立工作，未擅自改）。
  - ⚠️ 局限：若一段**真实内容**恰好被 ≥5 张卡共享，会被误判为模板而整段剔除 ⇒ 这 5 张卡**可能漏报**
    （**仅漏报、不误报**）；日志会如实上报剔除段数。

- **⚠️ 同时暴露的既有口径限制 + 时序竞态（已修，2026-09-25）**：
  大库（≥3000 张）走 `slimCard` 瘦身，**只释放两类重字段**：内嵌世界书**词条正文** + `alternate_greetings`
  （实测本库 11186 张里 **9557 张**）。更糟的是**竞态**：内容查重自身会**重扫磁盘**（拿最新数据），
  而重扫会触发「建索引 → `slimLibraryIfNeeded()`」这条**异步**链 —— 瘦身会在**比对中途**完成
  ⇒ **同一轮里前半段按「含世界书正文」比、后半段按「只有触发词」比**，
  日志实证：`⚠️ 比对期间库被瘦身（0 → 9557 张）` ⇒ 结果不可解释、也不可复现。
  - ✅ **修法（两步，缺一不可）**：
    1. **查重期间延后瘦身**（`js/utils/dedupeBusy.js`，模块级普通变量，刻意不用 ref：
       `slimLibraryIfNeeded` 定义在 App.vue setup **前段**、`useDedupe()` 解构在**后段**，
       跨段引用 ref 会在 setup 期同步调用时踩 **TDZ**，即 AR-06 / AR-17 同款坑）；
       四条查重入口置忙、唯一收尾点 `finishDedupeScan` 清忙；`slimLibraryIfNeeded` 见忙则记
       `slimPendingAfterDedupe` 并跳过，由 `watch(dedupeScanning)`（注册在解构**之后**）补跑。
       ⇒ 解决**轮内**口径漂移（原日志实证 `0 → 9557 张`）。
    2. **按需读回正文**（`ensureCardsFull` + 用完 `slimCard` 交还）——
       **这一步才是关键**：阶段 1 的「重扫」是**增量刷新**（`refreshLibrary` 按 path+mtime
       **复用内存旧对象**），已瘦身的卡**不会**因为重扫而恢复正文；
       ⇒ 若开跑前库已瘦身（大库启动后建过索引就会），整轮都按**降级口径**跑。
       实测**同一库、同一份代码连续两轮**：**1783 组 / 最大组 14** vs **1788 组 / 最大组 8**
       —— 用户视角 = 「同样一次查重，每次结果不一样」。
       💰 成本实测：**2.2ms/张**（`readEmbeddedBatch` 批读）⇒ 真实 11k 库 9557 张 ≈ **21 秒**
       （相比整轮 130~200s 约 +15%），换来**结果可复现**。
       ⚠️ 只把**我们读回的那批**用完重新瘦身，不动其余内存状态；未注入读卡接口时**如实告警**
       （「口径与全量不一致」），不假装一致。
  - 守卫：`test/dedupeBusy.test.mjs`（行为 + 源码接线守卫：四条入口置忙 / 收尾清忙 / watch 位置在解构之后）。

- **形态④（2026-09-25）：不同角色 + **同一本导入世界书** —— 修好口径后**才暴露**的第四种误报**
  - **是怎么冒出来的**：把「查重期间延后瘦身」修好后，整轮都用**含世界书正文**的全量数据比对
    （这才是 `extractContentText` 的文档口径，世界书正文占卡片文本 **88%**）。于是真实库立刻暴露：
    很多卡会**导入同一本外部设定书**（如一整本「原神设定书」），全字段相似度被那本书撑满 ——
    `神里绫华·搬运(原A世界书).png` ↔ `甘雨v2(删除原世界书导入新的).png`
    ↔ `纳西妲(导入世界书,深度1500token).png` ↔ `甘雨.png` 聚成 **8 张一组**：
    世界书 **94~100%**、角色字段 **0%**（**三个完全不同的角色**，只是都导入了同一本设定书）。
    ⚠️ **旧口径（瘦身态）下词条正文被清空，所以这类一直没暴露** —— 属「修好 A 就看见 B」。
  - ✅ **判据：世界书大面积同源 + 角色本体完全不像 + 卡名（角色名）也不像 ⇒ 不是同一张卡** ——
    · `keys-Jaccard ≥ 0.5`（两侧内嵌世界书大面积同源）
    · `5 字段相似度 < 0.15`（描述/人格/场景/开场白 —— 角色本体完全不像）
    · **卡名相似度 < 0.3**（取卡内 `name`；空名时退回文件名；名字缺一即**不否决**）
    语义依据：**「版本」通常会保留角色本体，或至少保留角色名**。
  - 📊 标定（真实 11k 库，把「全字段 ≥85% 且 5 字段 <40%」的 **69 对**去重后逐条判读）：

    | 卡对（真实） | keys | 5 字段 | **卡名相似度** | 判读 |
    |---|---|---|---|---|
    | `神里绫华` ↔ `纳西妲` | 91% | 0% | **0.00** | ❌ 不同角色（曾被聚成 4 张组） |
    | `神里绫华` ↔ `甘雨` | 100% | 0% | **0.00** | ❌ 不同角色 |
    | `优秀素质` ↔ `爱丽速子` | 100% | 0% | **0.00** | ❌ 不同角色（两个赛马娘） |
    | `狩猎游戏` ↔ `嗨奴` | 100% | 1% | 0.00 | ❌ 不同角色 |
    | `深潜漫展：您的专属肉体改造…` ↔ `深潜漫展—无穹badend…` | 100% | 2% | **0.19** | ❌（同系列不同入口，判为不同卡） |
    | `绪月` ↔ `绪翮` | 100% | 27% | **0.50** | ✅ 真同源 |
    | `阿卡迪亚幻想：无限召唤` ↔ `阿卡迪亚回响：无限召唤` | 99% | 18% | **0.40~1.00** | ✅ 真同源（改名版） |
    | `唐清露` 系列（10 张多版本） | 52~86% | 26~34% | **1.00** | ✅ 真同源 |
    | `精神小妹改版` ↔ `精神小妹改版` | 94% | 2% | **1.00** | ✅ 真同源（改名恶搞对） |

    ⇒ 卡名阈值 **0.3** 落在实测空档 **[0.22, 0.50]** 中央。
  - ⚠️ **初版翻车记录（必须留着）**：第一版只用「`keys ≥0.95` + `5 字段 <0.15`」——
    **同时犯了两个错**：漏掉 `keys 91%` 的 `神里绫华↔纳西妲`，却**误杀 `唐清露` 系列**
    （keys 52~86%、5 字段 26% —— 同角色多版本，本不该否决；实测那一版把 10 张的组打散）。
    ⇒ 教训：**一个判据只有在「假样本」和「真样本」两侧都被实测过才算标定完成**；
      本次是靠**加入第三路独立信号（卡名）**才同时修好两侧。
  - ⚠️ 局限（如实记）：若同一角色的两个版本**各自换了一本几乎相同的书**、角色本体被完全重写、
    **连卡名也改了**，会被误判（**仅漏报、不误报**）；实测本库落入该组合的真同源为 0 对。

- **验证（第二轮）**：
  - 热测试（真实 11k 库，`--user-data-dir` 隔离 profile、卡库用真库）**六条断言**：
    ① 斗罗对不再同组 ✅ ｜ ② 梅琳娜↔霸道班主任 不再同组 ✅ ｜ ③ `某个世界2.0↔3.0` 仍同组 ✅
    ｜ ④ `艾莎终极版↔艾莎状态栏版` **不再同组**（⚠️ 已知代价，见上）｜ ⑤ 巨型误聚组 109→2 ✅
    ｜ ⑥ 全库最大组 8 张 ✅；
  - `node --test test/ar50TemplateAndVeto.test.mjs` **10/10**（新增，锁三条判据 + 真同源回归）；
  - `npm test` **767/767**；
  - `_probe-card-legacy-vs-full.mjs`（已同步比值否决/模板提示）：4 张真卡 6 对 **6/6 与真值一致**。

---

### AR-51 ｜ 🟡 「**内容重合 100%**」却提示「**内容基本无关**」——提醒与数字**两个口径**打架

- **现象（用户实测原话）**：「🧬 内容重合: 100% / 🧾 指纹距离 0 / 💡 内容基本无关，很可能是不同的世界书
  —— 这都100百分百了内容还无关」。即**同一张卡片里**，数字说「完全一样」，建议说「基本无关」。
- **根因（口径分叉，不是算法错）**：那行 💡 取的是 `SIM_TYPE_META[type].advice`，即**类型判定**的文案；
  而类型判定需要 `keysSim`（世界书触发词）与 `contentSim`（正文 MinHash）**两路输入** ——
  两边都拿不到时（角色卡这一支：`_mhSig` **只有世界书分支才会生成**，卡也没有独立 `keyHashes`；
  旧代码连展示口径的指纹都**没往下传**）⇒ 落进 `classifySimilarity` 最后一支
  「两边都无数据 → 保守标为**仅名称相同**」⇒ 打出「内容基本无关，很可能是不同的世界书」。
  ⚠️ 而**旁边的百分比**是另一条路算的（全字段 MinHash）—— 于是**两个数字各有各的真话，合起来是假话**。
  📌 这是 AR-50 同一族病的**第三种表现**：**展示口径必须与判据口径同源**（AR-50 修了「取 `max` 虚报」，
  这条修的是「提醒文案与百分比不同源」）。
- **修复（2026-09-25，按用户指定方向）**：
  1. **提醒改由「展示用的百分比」推导** —— `js/utils/similarityType.js` 新增
     `CONTENT_PCT_ADVICE`（**每 10 个百分点一档**：0-10 / 10-20 / … / 90-100，**另加「恰好 100」一档**）
     + `adviceForContentPct(pct)`；`useDedupe.js` 里 `v._pctAdvice = adviceForContentPct(v._simPct)`
     —— **同一个数字既决定显示、也决定提示**，不可能再打架。
     档内文案自带区间（如「内容重合 40%~50% —— …」）**便于人眼反查**；
     低档明确「**不建议清理**」、100% 档才说「**可以安全清理**」。
  2. **无数据 ≠ 不相似**：`adviceForContentPct(null/undefined/NaN/空串)` 返回
     「内容指纹不足，无法判断重合度 —— 建议先对比再决定」，**不得**掉进最低档的「基本无关」
     （这是本次 bug 的同类病：拿缺数据当低相似；`Number('') === 0` 正是陷阱，判定前先挡掉）。
  3. **角色卡的 `contentSim` 补上**（治本那一半）：类型判定的 `contentSim` 在无 `_mhSig` 时
     **退化用展示口径的同一份指纹**（`fullSigOf`）⇒ 徽标不再落进「仅名称相同」，
     与「高度相似 / 内容可合并」等标签自洽。
  4. **类型文案降级为徽标 tooltip**（`_simAdvice` 仍保留，`💡` 行改渲染 `_pctAdvice`）——
     两个口径**各司其职**：tooltip 说「该怎么处理」（触发重复别删 / 设定冲突需人工裁决），
     💡 说「像到什么程度」。
  5. 预设查重（`PresetDedupeModal.vue`）同步改口径：`adviceForContentPct(正文重合 ?? 结构重合)`。
- **验证**：
  - `node --test test/similarityType.test.mjs` **32/32**（新增 7 条：11 档结构 / 边界左闭右开
    （`10` 必须进第二档、`100` 单占一档）/ 单调性 / ★**100% 不得含「无关」** /
    无数据中性文案 / 越界夹紧 / ★**接线守卫**（源码级断言「💡 必须读 `_pctAdvice`」，
    防有人改回去接类型文案））；
  - `npm test` **781/781**；`npm run build:web` 通过；
  - 热测试（真实 11k 库，逐项校验**全部**结果项，不只抽样）：
    **1783 组 / 2219 个非基准项**，全部有提醒（`withAdvice=2219`）；
    **档位与百分比逐项一致（违规 0）**、`_simPct === 100` 的 **1849 项均含「完全一致」且不含「无关」**、
    `≥90%` 的 **2011 项**不含「无关」、无百分比的项 **0**（无需中性文案兜底）；
    档位分布：`100`=1849 ｜ `90-100`=162 ｜ `80-90`=73 ｜ `70-80`=37 ｜ `60-70`=24 ｜ `50-60`=17
    ｜ `40-50`=20 ｜ `30-40`=8 ｜ `20-30`=12 ｜ `10-20`=8 ｜ `0-10`=9（**无空档**，每档都取到真样本）。
    🎉 顺带证实副作用已消：`100%` 的项**再也不会被打上「仅名称相同」徽标**（旧 bug 的可见症状）。
    ⚠️ 本轮扫描耗时 **323s**（同库前几轮 203s）—— 这是**重启后首次扫描**（指纹缓存冷、PNG 全量重读）
    （包含按需读回 9557 张正文 ≈21s），**不代表退回旧性能**；组数 1783 与前几轮一致。
- **⚠️ 修的过程中当场踩坑（必须记）**：第一版把取签名助手 `fullSigOf` 写在**第一个 `forEach` 回调内部**，
  却在**第二个（兄弟）`forEach` 回调里**引用 ⇒ `npm test` **全绿**、`vite build` **通过**、
  人眼静态扫也看不出（两个名字都在文件里），**只有真实启动跑一次查重**才炸：
  `内容级版本查重异常: ReferenceError: fullSigOf is not defined` ⇒ 查重结果 **0 组**
  （热测试当场抓到：`groups 0 / items 0`）。
  ⇒ **新增静态门禁** `scripts/check-undefined-scope.mjs`（`acorn` 解析 + **作用域感知**的引用解析，
  抓「引用位置但作用域链里没有」的名字）+ `test/scopeUndefined.test.mjs`
  （含**正向对照**：先证明它抓得住事故原形，再看真实 `js/**` + `main.js` + `preload.js` 是否 0 命中）；
  接线 `npm run guard:scope`，并入 `npm run check`。**这是「编译期/单测都看不见」那一类错的兜底。**
- **⚠️ 教训**：**一处显示数字 + 一处文字建议，就必须同源**；
  建议文案**不要绑在「另一套需要更多输入才能跑的判定」上** —— 缺一路输入时它会静默降级成
  「最保守」的措辞，而数字却照常显示，用户看到的就是「自相矛盾」。
### AR-52 ｜ 🟡 内容查重「清理」缺 AR-48 同款防护 —— **四条清理路只铺了一条**

- **现象（用户截图同批，2026-09-25）**：内容查重里基准版那个紫色「✅ 保留此版，清理其余」
  在**对家是「⚠️ 仅名称相同」/ 内容重合 9%** 时**照样可直接点**；右侧卡片写着「请先人工核对（勿直接清理）」，
  左侧却是一键删除入口。
- **根因**：AR-48 给**同名查重**（`resolveDedupeGroup`）做了完整防护（风险类型判定 + 确认框**列出文件名警示** +
  风险项按钮降级），但**没有横向铺开**：
  - `resolveContentDedupeGroup`（内容查重）：确认框只有一句「确定要将另外 N 个疑似重复版本移入回收站吗？」，
    **不检查类型、不列文件名**；
  - 而 `ContentDedupeModal.vue` 的 `isRisky(v)` **只作用于非基准项**（`vIdx === 0` 永远走普通紫色按钮）
    ⇒ 风险成员在组里时，**删除入口依旧可用**。
- **实测风险量级**：该组要删的那张卡（`“哥哥……好冷，抱紧我”.png`，805.5 KB）与保留版
  **全字段+词条 4-gram 重合仅 10.5%**，且含 **3 条对方没有的词条**（含 7536 字的「秋青子人设」）
  ⇒ 一键可能丢独占内容。
- **修复**：抽**统一** `confirmCleanupWithRisk({ items, keepPath, kind })`（风险判定 + 文件名列举 + 按钮降级文案
  一处实现），四条 `resolve*Group`（同名/内容/世界书/预设）全部改走它；源码断言锁死（防再漏）。
- **来源**：2026-09-25 用户实测截图（秋青子组）追问「你觉得有问题么」

---

## 四、约定

- 新增渲染层逻辑前，先确认**是否需要版本号/`triggerRef`** 打破 computed 缓存（AR-12、AR-18 是同一类病的两种表现）。
- 只要改动涉及「组件注册名 / ctx 暴露 / 弹窗位置 / Options API」四者之一，先对照 AR-09 ~ AR-13 自检。
- **进度条/加载反馈的归属**：先问一句「**这是哪个流程的进度**」——
  浏览库、查重、版本对比、导入、打包是**不同流程**，进度不能互相借用（AR-42 的教训）。
- 运行时问题优先查 `userData/crash.log`（`render-process-gone` 详情 + 自动 reload 记录）。
  ⚠️ 但**崩溃日志本身可能不存在**（主进程同死时写不进去，见 PK-20）→ 别把「没日志」当成「没崩溃」。
