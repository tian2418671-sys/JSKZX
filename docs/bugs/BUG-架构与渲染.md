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

> 📌 测卡区的两条新缺陷（状态栏空白、翻页控件不可见）归 **CT 领域**：[CT-13 / CT-14](BUG-测卡工作区.md)。

---

## 四、约定

- 新增渲染层逻辑前，先确认**是否需要版本号/`triggerRef`** 打破 computed 缓存（AR-12、AR-18 是同一类病的两种表现）。
- 只要改动涉及「组件注册名 / ctx 暴露 / 弹窗位置 / Options API」四者之一，先对照 AR-09 ~ AR-13 自检。
- 运行时问题优先查 `userData/crash.log`（`render-process-gone` 详情 + 自动 reload 记录）。
