# CT · BUG 记录 — 测卡工作区（对话测试）

> 领域：角色卡「聊天测试」侧栏与引擎（7 分区、预设装配、世界书注入、EJS/MVU 变量、长期记忆）。
> 桌面版实现在 `js/components/ChatTestSidebar.vue` + `js/composables/chat/*`（17 个模块）；
> 移动版为 `JSK管理APP`（Android/Capacitor）；本文件里 CT-04 ~ CT-08 即来自 **v1.10.21 移动版专项实测**（变量树 / 预设条目 / 本地导入）。
> 规格文档：[`../规格与计划/桌面版测卡工作区-实现规格.md`](../规格与计划/桌面版测卡工作区-实现规格.md)、[`../规格与计划/移动版测卡引擎-移植前置检查报告.md`](../规格与计划/移动版测卡引擎-移植前置检查报告.md)
> 总索引见 [`README.md`](README.md)。

---

## 一、引擎与状态（CT-01 ~ CT-03、CT-09、CT-10）

### CT-01 ｜ 🔴 侧栏渲染中断（整个测卡 Tab 被卸载）
- **现象**：点「插件」分区时整个测卡 Tab 被卸载，主进程刷屏
  `[Vue 错误] ChatTestSidebar | Cannot read properties of undefined (reading 'length')`。
- **根因**：模板对**来源不可信**的列表直接取 `.length`。props 虽有 default，但 `v-for` 源为 `undefined` 不报错、而**插值 / `v-if` 里的 `.length` 会抛错**，渲染期一抛即中断组件。
- **修复**：新增 `arr(v)` / `objKeys(v)` 兜底，模板 20 处列表访问全部改用它；`varRows` 加对象类型兜底。
- **防回归**：侧栏 e2e 增加断言「**每区点击后抽屉必须存活 + 特征词必须命中**」。
- **来源**：`docs/规格与计划/桌面版测卡工作区-实现规格.md` §五 缺陷①

### CT-02 ｜ 🔴 读存储的 `computed` **永久缓存**（选了预设引擎永远读不到）
- **现象**：侧栏选预设后 localStorage 已写入 259KB，但引擎 `activePreset` 恒为 `null`，预设装配分支永不进入 —— **静默失效，无任何报错**。
- **根因**：`computed(() => loadActivePreset())` 的 getter 读的是**同步非响应式**存储，Vue 认为它没有依赖 → **首次求值后永久缓存**。
- **修复**：`chatStorage` 每次写入/hydrate 都 bump 响应式 `chatStorageVersion`；读存储的 computed 先 `void chatStorageVersion.value` 建立依赖（引擎与侧栏各一处）。`plugins` 同病同治。
- **防回归**：`test/chatStorage.test.mjs` 新增 4 例，含**反例断言**（无依赖的 computed 确实读不到变更），把机理钉死在测试里。
- **来源**：`docs/规格与计划/桌面版测卡工作区-实现规格.md` §五 缺陷②

### CT-03 ｜ 🟡 测试自身的模块实例陷阱（记录以免后人再踩）
- **现象**：CDP 里 `import('/js/composables/chat/useChatPresets.js')` 会**另建一份模块实例**，其 `chatStorage` 与应用模块图里的是两个独立 Map →「测试里存上了、引擎读不到」。
- **诊断特征**：同一实例内 `loadActivePreset()` 有值、引擎 `activePreset.value` 为 `null`。
- **正确做法**：端到端测试一律**驱动真实 UI**（如从侧栏下拉选预设），不要自己 import 引擎模块。
- **同类**：探针读搜索索引**必须**走 `window.__jskDiag.idx`（应用真正使用的单例）；`import('/js/utils/searchIndex.js')` 会因 Vite 的 `?t=` 查询参数拿到**另一个模块实例**，读数全错。
- **来源**：`docs/规格与计划/桌面版测卡工作区-实现规格.md` §五 缺陷③；`v2.2.7 大库压测` §七

### CT-09 ｜ 🔴 项目此前**完全不维护 `prompt_order`** → 预设开关不生效
- **现象**：预设条目勾选框点了不生效；带 `enabled: false` 的条目仍被发给 AI；嵌套形态的预设**条目全部丢失**。
- **根因**：真实酒馆预设用**嵌套** `prompt_order: [{ character_id, order: [...] }]`，而旧实现只认扁平结构，导致 `ordered` 为空 → 退化成"使用全部 prompts"；且写回时只改一处，双份状态不同步。
- **修复（v2.2.6）**：
  - 新增 `normalizePromptOrder()` 兼容两种形态；
  - 关闭判定同时看 `prompt_order[].enabled` 与 `prompt.enabled`；
  - 新增 `setPromptEnabled()` **双写**两处；
  - 导出增加 `seen` 去重。
- **验证**：`test/chatPresets.test.mjs` 12 项（归一化 / 双位置同步 / 去重 / 边界）。
- **来源**：`CHANGELOG.md` v2.2.6「关键修复」；`v1.10.21 移动版专项实测` BUG-3

### CT-10 ｜ 🔴 测卡键未随物理路径迁移 → 会话与变量树**消失**
- **现象**：移动分组 / 重命名分组 / 换卡图后，"聊天测试"的会话与变量树**凭空消失**（数据其实还在，只是按新路径读不到）。
- **根因**：会话与变量树按**卡片物理路径**派生的键存储（`jsmobile-chat-<path>:sessions` 等）；卡片路径一变，旧键成孤儿。
- **修复**：新增 `migrateChatKeys(oldPath, newPath)`（`js/composables/chat/chatStorage.js`）—— **整键子串替换**，不依赖具体键格式（也适用于"目录前缀"式的分组重命名）；不覆盖已存在的目标键；迁移后 bump 版本号并 `flushNow()` 立即落盘。
- **接线点**：`useCardGroups.js` 的 `renameCurrentCategory`（目录前缀迁移）与 `moveCardToGroup`（单卡迁移）。
- **验证**：`test/chatKeyMigration.test.mjs` 4 例。
- **同类教训**：**凡「物理路径会变」的操作，都必须同步迁移所有按 path 派生的键** —— 同类缺陷 2026-09-01 已在「覆盖层 `app_config.json`」上踩过一次。
- **来源**：`CHANGELOG.md` v2.2.7（五）；`v2.2.7 大库压测` §13.5

---

## 二、移动版测卡（CT-04 ~ CT-08，版本 v1.10.21）

### CT-04 ｜ 🟡 预设条目不可见、不可操作
- **现象**：用户反馈「导入的预设看不到预设条目，有什么用处呢」—— 侧栏「📋 预设」只显示预设名 + `N 条提示词` 计数，条目内容完全不可见不可改。
- **修复**：新增「📝 预设条目」区域，支持**展开编辑（名称 / 角色 / 正文）+ 开关 + 删除 + 新增 + 克隆**（克隆 = 深拷 + 同步 `prompt_order`）。
- **验证**：8→9 条，克隆项插在原条目下方，**重启后仍保留**（已写回 localStorage）。
- **来源**：`v1.10.21 移动版专项实测` BUG-2

### CT-05 ｜ 🟡 嵌套格式 `prompt_order` 使条目开关形同虚设
- **根因**：
  ```js
  for (const item of order) {
      if (!item || !item.enabled) continue;   // 嵌套格式 item.enabled === undefined → 全部跳过
  ```
  旧 `getOrderedPrompts` 只认扁平结构 → `ordered` 为空 → 退化成"使用全部 prompts"。
- **修复**：同 [CT-09] —— `normalizePromptOrder()` + 双位置同步 `setPromptEnabled()`。
- **来源**：`v1.10.21 移动版专项实测` BUG-3

### CT-06 ｜ 🟢 温度参数显示精度丢失
- **现象**：预设 `temperature: 0.85` 在步进器里显示 `0.8`（而下方"默认: 0.85"），数值与实际不符。
- **根因**：`paramKeys` 里 temperature 配 `decimal: 1`，但预设有 2 位小数。
- **修复**：`decimal: 1 → 2`，`step: 0.1 → 0.05`（top_p 本就 2 位，口径统一）。
- **来源**：`v1.10.21 移动版专项实测` BUG-4

### CT-07 ｜ 🟢 侧边栏标签栏溢出
- **现象**：6 个标签（配置/正则插件/世界书/变量/聊天/设置）总宽超出面板，**"设置"被裁掉**。
- **修复**：标签 `padding: 0 12px → 0 10px`、`font-size: 13px → 12.5px`。
- **来源**：`v1.10.21 移动版专项实测` BUG-5

### CT-08 ｜ 🟢 变量重命名后键位移到对象末尾
- **现象**：把 `stat_data.hp` 重命名为 `hp_max` 后，该键**从首位跳到末尾**。
- **根因**：引擎指令集只有 `init/set/add/delete/insert/patch`，`patch` 的 RFC6902 `move` **明确未实现**（移动端测卡场景不实现）→ 重命名退化为「`set` 新键 + `delete` 旧键」，而 JSON 对象键序 = 插入序。
- **修复**：父级是对象时**整对象保序重建**后一次 `set`：
  ```js
  const rebuilt = {};
  for (const k of Object.keys(parentVal)) rebuilt[k === row.key ? key : k] = parentVal[k];
  emit('apply-vars-ops', [{ type: 'set', path: parent, value: rebuilt }]);
  ```
- **可行性依据**：`setPath` 末段是 `cur[last] = value`（**整体赋值**，非 `mergeDeep` 深合并）→ 整对象覆盖不会残留旧键。
- **顺带**：数组元素（索引无"键名"概念）不再展示「重命名」项（新增 `vtParentIsArray()` 判定）。
- **遗留**：父级为根或数组时仍退回 `set + delete`（键序会变，功能正确）。
- **来源**：`v1.10.21 移动版专项实测` BUG-6

---

## 三、移植缺口与自动化限制（CT-11、CT-12）

### CT-11 ｜ 🧩 移动版测卡引擎移植的 3 处阻塞级缺口（已补）
| # | 缺口 | 详情 | 处理 |
|---|---|---|---|
| 1 | **2 处 import 路径失效**（共 4 个路径） | `useChatApiConfig.js:7` / `useChatMemory.js:7` 写 `from '../bridge/api.js'` → 解析到不存在的位置；`ChatPanelSeg.vue:26` 写 `from '../useChatRender'` → 少一级 `chat/` 且缺 `.js` | 改 `./chatBridge.js` / `./useChatRender.js`。这是**当时唯一让引擎无法加载的原因** |
| 2 | **`useChatPresets.js` 落后于移动版** | 移动版 10291B 有 `normalizePromptOrder` / `setPromptEnabled` / 双位置 `enabled` 判定 / `seen` 去重；桌面暂存区 8123B 全无 | 直接用移动版整文件覆盖（纯函数、零依赖） |
| 3 | **`useStatusbarPreview.js` 两端分叉** | 移动版导出 `parseRegexPattern` / `classifyTemplate` / `sanitizeStatusHtml` / `extractLoaderUrls`，桌面版是模块私有（`sanitizeStatusHtml` 整个函数不存在） | 加 `export` 关键字（不改逻辑）+ 搬入 `sanitizeStatusHtml` |
- **来源**：`docs/规格与计划/移动版测卡引擎-移植前置检查报告.md` §三

### CT-12 ｜ 📌 自动化坑：重复点击已激活的 Tab 不会 remount
- **现象**：侧栏只在聊天 Tab 挂载时创建；若侧栏已被收起，直接再点「💬 聊天测试」**无效**（`currentTab` 值未变），测试脚本会误判为"点不开"。
- **规避**：测试须「**先切走再切回**」。
- **相关**：`vite build` 不清理旧产物（`build:web` 才清 `web/`）。
- **来源**：`docs/规格与计划/桌面版测卡工作区-实现规格.md` §五「踩坑记录」

---

## 三·2、桌面测卡区渲染（CT-13、CT-14，版本 v2.2.7 补丁）

### CT-13 ｜ 🔴 测卡区「状态栏」永远空白（三层原因：CSP → 全局库 → 宿主 API）
- **现象**（用户报告 2026-09-14）：「鬼卡的状态栏无法渲染」——测卡聊天区里卡内 HTML 面板（状态栏）为空白，
  iframe 有框但高度恒在默认 60px。
- **根因**（三层，逐层包住，只看第一层会得出错误结论）：
  1. **生产 CSP 拦死内联脚本**：界面段走 `srcdoc`，而 `srcdoc` iframe **继承父页 CSP**
     （生产为 `script-src 'self' app:`，无 `unsafe-inline`）→ 卡内 webpack SPA 的 `<script type="module">`
     根本不执行（与 AR-28 同类病，只是换了位置）。
  2. **缺 iframe 全局库**：酒馆助手（JSR）是靠 `third_party_message.html` + `predefine.js` 往每个消息 iframe
     注入 `Vue` / `jQuery` / `_`(lodash) / `z`(zod) 这批全局的；卡内状态栏直接引用自由变量
     （webpack externals：`const Go=z`、`o=Vue`）→ 缺一个就 `ReferenceError`，模块顶层就死，面板整块不渲染。
  3. **缺 iframe 宿主 API**：还依赖 `getCurrentMessageId()` / `updateVariablesWith()` / `errorCatched()` /
     `waitGlobalInitialized()`（JSR 的 `@types/iframe/*`）——沙箱里拿不到父页对象，必须由我们提供。
- **修复**：
  1. 界面段改走**主进程内存路由**（与插件预览同机制）：`setChatHtmlSegment` →
     `app://index.html/__jsk_seg__/N-xxxx.html`，该路由跳过 CSP 注入 → 内联脚本可执行；
     两份 store 分开（`segStore` 60 份 / `previewStore` 32 份），避免聊天里的段把正在看的插件预览挤掉。
  2. 新增 `js/chatHost/iframeGlobals.js` + vite 插件 `jsk-chat-host-bundle`：把 **Vue、jQuery、lodash、zod**
     打成**单个 IIFE**（构建期 `web/vendor/chat-host.js`、开发期 `<root>/vendor/chat-host.js`），
     界面段用一行 `<script src="app://index.html/vendor/chat-host.js">` 引用 —— 固定 URL → 跨 iframe 共用缓存，
     不把几百 KB 内联进每份文档。
  3. `buildHtmlSrcdoc` 的桥接脚本补齐 JSR 侧 API：`getCurrentMessageId`（注入消息序号）、`updateVariablesWith`、
     `replaceVariables`、`errorCatched`，以及 `localStorage/sessionStorage` 内存实现
     （沙箱无同源权限时原生访问会抛 `SecurityError`）。
  4. 注入位置改为 `<head>` **开头**：模板 bundle 是模块脚本（默认 defer），但若模板里混有普通内联脚本，
     预置全局必须先到位。
- **实测证据**（生产实例 + CDP）：修复前 iframe 高度恒为 60px，控制台依次报
  `Executing inline script violates … 'script-src 'self' app:'` → `Vue is not defined` → `z is not defined` →
  `getCurrentMessageId is not defined`；修复后同一张卡：iframe 内部 `#app` 已挂载
  （`ghost-root` / `ghost-title` 均在），异常/错误 **0 条**；把面板展开后高度上报到 460px 级。
- **补充坑（高度上报）**：iframe 里的量高依赖 `load` 后几次 `setTimeout`，而后台窗口的定时器会被节流
  （实测 ~1s 一跳）→ 面板可能长时间停在默认 60px。补了「回前台重新量高」：父层监听
  `focus` / `visibilitychange` → 向 iframe `postMessage({type:'jsx-panel-height-request'})` → 桥接脚本补报高度。
  实测：触发后高度 **60 → 76**（该面板默认是折叠态，展开态更高）。
  ⚠️ 另记：CDP 探针在这种场景下**不能信**「卡顿/高度」读数——窗口在后台时定时器被节流，会出现 ~1000ms 的
  「假卡顿」与「高度不更新」，必须先 `Page.bringToFront` 或让窗口可见再测（同 PK-13 的测量方法教训）。
- **参考**：用户本地预览工程 `H:\01\北派盗墓笔记\tavern_helper_gui` —— `preview-frame.html` 就是同款 mock 环境
  （`Vue/jQuery/lodash` 外链 + `getVariables/updateVariablesWith/getCurrentMessageId/errorCatched/
  waitGlobalInitialized` + `z=zod`），`状态栏踩坑记录.md` 记录该状态栏链路已踩过的坑。
  本次实现按它对齐了全局清单，并采其 `waitGlobalInitialized` **立即 resolve** 的语义
  （挂着等会让没有 `Mvu` 的环境卡住初始化链）。
- **未做（已知边界）**：沙箱内 `updateVariablesWith` 只在 iframe 本地快照上生效，**不写回**宿主变量树
  （与预览帧同一取舍：防表单/数据源脱钩）；需要真正写回时再按字段 merge 设计。
- **来源**：用户报告 + 生产实例/CDP 复现（v2.2.7 补丁，2026-09-14）

### CT-14 ｜ 🟡 测卡区「翻页（候选回复）」点了没反应 / 只有 1 个候选
- **现象**（用户报告 2026-09-14，两次）：「测卡聊天区域没有出现翻页功能」→ 首轮修完后仍是
  「翻页功能现在还是摆设，有的卡有开场白翻页只有一个不能来回翻动」。
- **根因**（两条叠加，第一轮只修掉了一半）：
  1. **开场白候选只取了 `first_mes`**：`pushFirstMessage()` 恒 `swipes: [text]`，
     **完全没读 `alternate_greetings`（附加问候语）** → 带备用开场白的卡也只有 1 个候选，
     ◀/▶ 因 `swipes.length < 2` 恒为 disabled（「只有一个，不能来回翻动」）。
     另：工具条曾整体 `v-if="swipes.length > 1"` → 单候选时**连工具条都不渲染**。
  2. **按钮点击直接抛异常**（真因，用户看到的「摆设」）：模板写 `@click="ctx.chatPrevSwipe(idx)"`，
     而 `EditorPanel` 是**纯 setup 组件**，`ctx = inject('appCtx')` 只是 setup 内的局部变量、
     **没有交给模板作用域** → 渲染代理上 `ctx` 为 `undefined` → 点击即
     `Cannot read properties of undefined (reading 'chatPrevSwipe')`，什么都不会发生。
- **修复**：
  1. 新增 `greetingTexts()` = `[first_mes, ...alternate_greetings]`（过滤空串）；
     `pushFirstMessage()` 一次备好全部候选（**首个候选走完整管线含 MVU 初始化，其余仅展示**：
     剥掉变量指令块、不重复初始化）——与移动版 `CardDetailView.pushFirstMessage(withAlt)` 同语义；
  2. 模板不再访问 `ctx.*`，改为组件内本地包装函数转发（`onChatPrevSwipe` / `onChatNextSwipe`），
     与既有 `onChatSend` / `onChatMoreSwipe` 同一手法；工具条改为**常显**、单候选时 ◀/▶ 置灰。
- **实测证据**（生产实例 + CDP，两次修复后）：清空记录 → 工具条 `1/2`（first_mes + 1 条附加问候语）
  → 点 ▶ → `2/2` 且正文换为附加问候语（"刹车声，是我这辈子听到的最后一声响…"）→ 再点 ▶ 循环回 `1/2`，
  ◀ 同样有效；控制台错误 **0 条**（修复前每次点击必抛 ctx 未定义）。
- **防再犯**：本组件模板**禁止写 `ctx.*`**（同类坑已连中 3 处：清空记录、◀、▶）——
  一律在 setup 里包一层本地函数再 return；新增模板方法时先搜 `ctx\.` 自检。
- **来源**：用户报告 + 生产实例/CDP 验证（v2.2.7 补丁，2026-09-14）

### CT-15 ｜ 🟡 「清空记录」按钮一直是死的（模板访问不到 setup 局部的 `ctx`）
- **现象**：聊天区右上角「清空记录」点不动，无任何反馈（用户没专门报过，是 CT-14 排查时顺带发现的同源缺陷）。
- **根因**：同 CT-14 根因 2 —— `@click="ctx.chatClear"`，而 `ctx` 只存在于 setup 作用域；
  Vue 渲染代理取到 `undefined` → 抛 `Cannot read properties of undefined (reading 'chatClear')`。
- **修复**：新增本地包装 `const onChatClear = () => { if (ctx.chatClear) ctx.chatClear(); }`，
  模板改绑 `onChatClear`。
- **实测证据**：点击后开场白重置且工具条回到 `1/2`、控制台零错误（修复前必抛异常）。
- **同类排查**：全仓 `grep -n 'ctx\.' js/components/*.vue` 逐条确认是否为模板使用；
  ChatTestSidebar 等组件同样只应经 props/本地函数访问上下文。
- **来源**：CT-14 排查顺带发现（v2.2.7 补丁，2026-09-14）


---

---

### CT-16 ｜ 🟡 卡内面板顶部/底部各露出一行「```」（裸围栏被当正文带进面板）
- **现象**（用户报告 2026-09-14，附截图）：测卡聊天区里卡内状态栏正常渲染，但**面板上沿（和下沿）各多出一行反引号**，看起来像「三个点」。
- **复现**：`剧情卡\魔法少女是不会败北恶堕的吧！.png` 的 `first_mes`（12,855 字符）形状为：
  ` ``` ` + CRLF + `<!DOCTYPE html>` … `</html>` + ` ``` `（卡作者把**完整文档**整段放进裸围栏）。
- **根因**（两步叠加）：
  1. `fenceLooksLikeHtml()` 的前缀白名单只列了 `<html/<head/<body/<style/<script/<div/<table/<section>`，
     **不认 `<!DOCTYPE html>`** → 这段被判成「普通文本」，并**把围栏原样包回**（`'```\n' + inner + '\n```'`）；
  2. 紧接着 `promoteHtmlSegments()` 又发现该文本段含 `<html` → 升级为 iframe 段，**但围栏已经粘在内容里了**
     → 面板文档内容变成 ` ``` … ``` `，浏览器把顶部/尾部的反引号当正文渲染。
- **修复**：`fenceLooksLikeHtml` 的标签前缀白名单补上 `!doctype\s+html`（同时兼容 LF/CRLF）；
  注释里写明这个真实卡形状，防后人又收窄回去。
- **实测证据**（生产实例 + CDP）：修复前该卡分段结果为 `[0] text len=12853 head="```\n<!DOCTYPE html>…"`，
  面板文档 `tickCount=2`、`tickAtStart/tickAtEnd` 均 true；修复后为 `[0] html len=12845 head="<!DOCTYPE html>"`，
  页面里 `iframe.seg-iframe` 高度 **1643px**、`tickCount=0`、无残留文本段。
- **回归**：`test/chatRender.test.mjs` 新增 2 例（CRLF + `<!DOCTYPE html>`、LF + 小写 `<!doctype html>`），
  断言「判为 html 段且内容不含 ```」；合计 11 例。
- **防再犯**：新增「裸围栏识别」判据时必须同时覆盖 `<!DOCTYPE html>`（卡作者寄进裸围栏时最常见的开头），
  改完用真实卡跑 `segmentMessage` 看首尾字符，而不是只看 `type === 'html'`。
- **来源**：用户截图报告 + 真实卡复现（2026-09-14，v2.2.9）

### CT-17 ｜ 🟡 长期记忆「无法删除」—— 逐条删除入口根本不存在（用户报障 2026-09-19）
- **现象**（用户反馈）：「记忆内容无法删除，记忆表中的记忆无法删除，显示无法删除」。
- **排查结论（先验证再判坏，铁律 #2）**：`memory:remove` IPC 链路（preload → main → memoryStore.remove）
  一直是**通的**且有单测覆盖；坏的是 **UI 层根本没有逐条删除入口** ——
  `removeMemory()` 自 v2.2.7 二期落地以来从未被任何组件调用，侧栏设置分区只有一个
  「清空全部」（两段式确认）。用户看到的「记忆表」只存在于**发给 AI 的提示词文本**里，
  界面上根本没有可操作的表 → 逐条删除无从谈起。
- **同源问题**：聊天记录也没有逐条删除（只有「清空记录」）。
- **修复（与记忆 v4.1 桌面移植同一批落地）**：
  1. 侧栏「设置」分区新增**记忆查看器**：列表（键：值）+ 每行 🗑 删除（`removeMemory`，删后刷新统计+列表）；
  2. 「只看本卡 / 全部」切换（card 模式按 `cardPath` 过滤，v4.1 D1 分桶）；
  3. 遗留桶提示（`stats().orphans` > 0 时显示「N 条未归属任何卡的旧记忆」）。
- **验证**：见本文件末尾 v4.1 专项验证段；`npm test` 全绿（memoryStore 新增 v2 用例）。
- **防再犯**：给存储层补 API 时必须同步评估「用户从哪里操作它」——
  只有统计展示、没有条目级操作的存储域，用户会感知为「功能坏了」。
- **来源**：用户反馈（2026-09-19，记忆 v4.1 移植轮）

### CT-18 ｜ 🟡 测卡聊天记录无法逐条删除（用户报障 2026-09-19，与 CT-17 同批）
- **现象**：聊天层数只能整体「清空记录」，无法删除某一条/重新生成某层。
- **根因**：引擎无 `deleteMessage` 类 API；消息气泡上也没有删除按钮（唯一入口是底部「清空记录」）。
- **修复**：
  1. `useChatEngine.deleteMessage(i)`：`splice(i,1)`；assistant 多候选**整条删**（候选组一体，
     删单候选会破坏 swipe 语义）；删后会话空 → 重载开场白（对齐 clearChat 语义）；立即落盘；
  2. 每条消息气泡下加 🗑 按钮（发送中禁用）—— 模板经本地包装函数 `onChatDeleteMessage` 转发
     （CT-14/15 同源坑：纯 setup 组件模板写 `ctx.*` 必抛 undefined）。
- **「重新生成」说明**：assistant 消息已具备候选级重生成（＋追加候选 / ↻ 整组重写 / ↳续写，
  swipe 工具条）；本次未重复添加。
- **验证**：同 CT-17；启动冒烟无 `[Vue 错误]`。
- **来源**：用户反馈（2026-09-19）

### CT-19 ｜ 🔴 卡内 HTML 面板缺 jQuery/Vue 全局库 → `$ is not defined`（CT-13 修复漏了分支）
- **现象**：测卡区渲染带 jQuery 的卡内面板（实测卡：`1786851144596_MC_liteby_Crooked2_1.png`，
  开场白里是 `<script>$("body").load("https://cdn.jsdelivr.net/gh/CrHouse815/-MC-_lite-@main/dist/index.html")</script>`）时，
  控制台报 3 条 `Uncaught ReferenceError: $ is not defined`，来源是 `app://index.html/__jsk_seg__/N-*.html`，面板空白。
- **根因**（**只验证不猜**）：`buildHtmlSrcdoc()` 把面板内容分 4 种形状分别补壳，但只有前两种把
  `vendorTags`（`<script src="app://index.html/vendor/chat-host.js">`，即 jQuery/Vue/lodash/zod 全局）拼进文档；
  **后两种（「只有 `<body>`」与「只有 `</head>`/纯片段」）用的是 `META_TAGS + prelude`，把 vendor 整个丢了** ——
  桥接（`getVariables` 等）在、全局库不在 → 模板顶层的 `$` 直接 `ReferenceError`，模块顶层就死。
  > 与 CT-13 同根（同一批全局库），但 CT-13 只修了「会不会注入」，没有覆盖全部分支。
- **复现（Node 直调 `buildHtmlSrcdoc`，vendor 传入非空）**：
  `完整文档 <html>` ✅ / `准完整 <head>…` ✅ / `仅 <body>` ❌ VENDOR-LOST / `</head>+<body> 围栏残渣` ❌ / `纯片段 <div>` ❌。
  （既有单测只用了 `<head>…` 形状 + `''` vendor，恰好避开漏掉的那两个分支。）
- **修复**：两个回退分支同样拼上 `vendorTags`（`META_TAGS + vendorTags + prelude`），
  并给单测补上「非空 vendor × 4 种形状」的断言。
- **验证**（全部实测，2026-09-19）：
  1. `test/chatRender.test.mjs` 新增 2 例（4 种形状带 vendor + 空 vendor 不凭空插入）→ 13/13 绿；`npm test` 全绿；
  2. 真实卡（隔离 profile + 调试端口）：打开 `MC_lite` 卡 → 切测卡页签 → 控制台
     **`$ is not defined` 由 3 条降到 0 条**，且卡内面板应用**真的启动**了
     （日志出现 `[GameLayout] MClite布局已加载` / `[App] MC房子应用已挂载` / `[MvuStore] MVU变量框架未加载，使用模拟数据`）；
  3. 合成自检卡（隔离临时库，面板脚本自己上报）：`{ jQuery: true, Vue: true, zod: true }`，
     且生成的段文档里 `vendor/chat-host.js` 位于模板脚本**之前**。
- **防再犯**：**多分支生成同一类文档时，任何「只在一部分分支里加的公共注入」都要用参数化测试锁住全部形状**
  —— 这次就是「修了主路径、漏了回退分支」。
- **来源**：本轮插件页签回归测试时发现（2026-09-19）

### CT-20 ｜ 🟡 测卡区**不识别外链界面（loader）** → `$('body').load('URL')` 的卡面板完全不显示

- **现象**：卡里用外链界面（`<script>$('body').load('https://…')</script>` 或 `<iframe src="https://…">`）
  的模板，在**测卡区完全不显示**（连空白面板都没有）；但**同一张卡**在**卡编辑器预览面板**里
  却能正常显示外链界面。
- **根因（只验证不猜）**：两处**分类器口径不一致** ——
  · 卡编辑器预览：`useStatusbarPreview.classifyTemplate` **早就有** `loader` 分类（5 类之一），
    `EditorPanel.vue` 也有 `<iframe :src="tpl.loaderUrl">` 渲染分支；
  · **测卡区**：`useChatRender.segmentMessage` 只产出 `text` / `html` 两类，
    `htmlNeedsIframe()` 也只看 `<style>/<script>/<html>` —— **完全没有 loader 概念** ⇒
    loader 内容要么被判成 `html`（进 srcdoc，远程 URL 不会被加载）、要么留在文本段（当纯文本渲染）。
  > 与 CT-19 同族（**同一能力在两处实现，只补了一处**），但这次是「能力缺口」而非「分支遗漏」。
- **修复（3 处，口径与 `useStatusbarPreview` 对齐）**：
  1. `useChatRender.js` 新增 `loaderUrlOf(text)` —— 与预览面板**同口径**的宽松匹配
     （`$('body').load('URL')` 单双引号/空格/换行/无 `<body>` 包裹，以及 `<iframe src>` / `<script src>` 直链）；
     ⚠️ **只认 `http(s)://` 绝对地址**（拒绝 `app://` / `file://` / `javascript:` / 相对路径，
     防卡内容诱导加载内部协议）；
  2. `segmentMessage` / `pushTextSegments` / `promoteHtmlSegments` 三处产出 **`loader` 段**
     （`{type:'loader', url, content}`）；优先级：loader > html > text；
  3. `ChatPanelSeg.vue` 新增 `loader` 分支：`<iframe :src="seg.url" sandbox="allow-scripts allow-popups"
     referrerpolicy="no-referrer">`（**直接 src 加载远程 URL**，不带 srcdoc；与预览面板同口径）。
- **验证**：
  - `test/chatRender.test.mjs` 新增 **8 例**（`$().load` / `<iframe src>` / 围栏内 loader /
    宽松匹配 3 种写法 / **非 http(s) 协议全部拒绝** 4 种 / 普通 HTML 不误判 / `promoteHtmlSegments` 升级 /
    纯文本不升级）→ `npm test` **542 pass / 0 fail**；
  - `npm run build:web` ✅；真实启动冒烟无 `[Vue 错误]`。
- **防再犯**：**同一个能力不要在两处各实现一套** —— 这次「卡编辑器有、测卡区没有」正是
  CT-19 教训（「多分支生成同一类文档」）的**升级版**：不只是分支遗漏，而是**整个能力缺失**。
  发现两处都有类似逻辑时，应**先 grep 有没有现成实现可对齐**（本次直接对齐了 `useStatusbarPreview` 的正则）。
- **来源**：2026-09-23 遗留任务盘点（规格 §五「尚未完成（三期）」标 ⬜ 的 CT-04）

---

## 四、本领域改动前的自检清单
1. 侧栏模板里访问任何**可能为 undefined 的列表/对象** → 必须走 `arr()` / `objKeys()` 兜底（[CT-01]）。
2. 读 **localStorage / IPC 存储**的 `computed` → 必须有响应式依赖（`void xxxVersion.value`），否则永久缓存（[CT-02]）。
3. **写回预设**时，`prompt_order` 与 `prompt.enabled` **两处都要写**（[CT-09]）。
4. 新增任何「按卡片 path 派生」的键 → 必须在移动/重命名路径上迁移（[CT-10]）。
5. 引擎改动后跑：`npm test` + `scripts/tools/chat-sidebar-test.mjs`（生产 `app://`）+ `scripts/tools/chat-engine-test.mjs`（dev + 调试句柄）。
6. 端到端测试**驱动真实 UI**，不要自己 import 引擎模块（[CT-03]）。
7. 改动**卡内 HTML 面板（状态栏/界面型段）**或 `buildHtmlSrcdoc` → 对照 [CT-13]：
   ① 文档必须走 `app://` 内存路由（不然生产 CSP 会拦内联脚本）；
   ② 模板依赖的全局（`Vue`/`z`/`_`/`$`）由 `web/vendor/chat-host.js` 提供，新增依赖改 `js/chatHost/iframeGlobals.js`；
   ③ 验证方式：生产实例 + CDP 读 `iframe.seg-iframe` 高度（>60px 才说明脚本跑起来了）+ 控制台异常数应为 0。
8. 改 `segmentMessage` / 围栏识别（`fenceLooksLikeHtml` / `promoteHtmlSegments`）→ 对照 [CT-16]：
   裸围栏里常见「`<!DOCTYPE html>` 开头的完整文档」，白名单漏了它就会把围栏当正文带进面板；
   改完必须用**真实卡**的 `first_mes` 跑一遍，检查首尾字符而不是只看段类型。
