# AR · BUG 记录 — 架构 / Electron / Vue 运行时 / 测试调试

> 领域：主进程与渲染进程的边界、Vue 响应式与组件规范、构建产物与运行时的差异。
> 总索引见 [`README.md`](README.md)。条目格式：现象 → 根因 → 修复 → 验证 → 来源。

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
- **验证**：`scripts/_probe-regex-ui.mjs` PASS（21→22 立即生效；删除弹原生确认框、取消不误删、确定立即 22→21）。
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
- **修复**：`scripts/dev-run.ps1` 显式设置控制台编码。
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

> 📌 测卡区的两条新缺陷（状态栏空白、翻页控件不可见）归 **CT 领域**：[CT-13 / CT-14](BUG-测卡工作区.md)。

---

## 四、约定

- 新增渲染层逻辑前，先确认**是否需要版本号/`triggerRef`** 打破 computed 缓存（AR-12、AR-18 是同一类病的两种表现）。
- 只要改动涉及「组件注册名 / ctx 暴露 / 弹窗位置 / Options API」四者之一，先对照 AR-09 ~ AR-13 自检。
- 运行时问题优先查 `userData/crash.log`（`render-process-gone` 详情 + 自动 reload 记录）。
