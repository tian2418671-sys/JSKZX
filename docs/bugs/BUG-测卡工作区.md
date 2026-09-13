# CT · BUG 记录 — 测卡工作区（对话测试）

> 领域：角色卡「聊天测试」侧栏与引擎（7 分区、预设装配、世界书注入、EJS/MVU 变量、长期记忆）。
> 桌面版实现在 `js/components/ChatTestSidebar.vue` + `js/composables/chat/*`（16 个模块）；
> 移动版为 `JSK管理APP`（Android/Capacitor），本仓库的 `测试日志-2026-09-12` 记录的是移动版。
> 规格文档：[`../桌面版测卡工作区-实现规格.md`](../桌面版测卡工作区-实现规格.md)、[`../移动版测卡引擎-移植前置检查报告.md`](../移动版测卡引擎-移植前置检查报告.md)
> 总索引见 [`README.md`](README.md)。

---

## 一、引擎与状态（CT-01 ~ CT-03、CT-09、CT-10）

### CT-01 ｜ 🔴 侧栏渲染中断（整个测卡 Tab 被卸载）
- **现象**：点「插件」分区时整个测卡 Tab 被卸载，主进程刷屏
  `[Vue 错误] ChatTestSidebar | Cannot read properties of undefined (reading 'length')`。
- **根因**：模板对**来源不可信**的列表直接取 `.length`。props 虽有 default，但 `v-for` 源为 `undefined` 不报错、而**插值 / `v-if` 里的 `.length` 会抛错**，渲染期一抛即中断组件。
- **修复**：新增 `arr(v)` / `objKeys(v)` 兜底，模板 20 处列表访问全部改用它；`varRows` 加对象类型兜底。
- **防回归**：侧栏 e2e 增加断言「**每区点击后抽屉必须存活 + 特征词必须命中**」。
- **来源**：`docs/桌面版测卡工作区-实现规格.md` §五 缺陷①

### CT-02 ｜ 🔴 读存储的 `computed` **永久缓存**（选了预设引擎永远读不到）
- **现象**：侧栏选预设后 localStorage 已写入 259KB，但引擎 `activePreset` 恒为 `null`，预设装配分支永不进入 —— **静默失效，无任何报错**。
- **根因**：`computed(() => loadActivePreset())` 的 getter 读的是**同步非响应式**存储，Vue 认为它没有依赖 → **首次求值后永久缓存**。
- **修复**：`chatStorage` 每次写入/hydrate 都 bump 响应式 `chatStorageVersion`；读存储的 computed 先 `void chatStorageVersion.value` 建立依赖（引擎与侧栏各一处）。`plugins` 同病同治。
- **防回归**：`test/chatStorage.test.mjs` 新增 4 例，含**反例断言**（无依赖的 computed 确实读不到变更），把机理钉死在测试里。
- **来源**：`docs/桌面版测卡工作区-实现规格.md` §五 缺陷②

### CT-03 ｜ 🟡 测试自身的模块实例陷阱（记录以免后人再踩）
- **现象**：CDP 里 `import('/js/composables/chat/useChatPresets.js')` 会**另建一份模块实例**，其 `chatStorage` 与应用模块图里的是两个独立 Map →「测试里存上了、引擎读不到」。
- **诊断特征**：同一实例内 `loadActivePreset()` 有值、引擎 `activePreset.value` 为 `null`。
- **正确做法**：端到端测试一律**驱动真实 UI**（如从侧栏下拉选预设），不要自己 import 引擎模块。
- **同类**：探针读搜索索引**必须**走 `window.__jskDiag.idx`（应用真正使用的单例）；`import('/js/utils/searchIndex.js')` 会因 Vite 的 `?t=` 查询参数拿到**另一个模块实例**，读数全错。
- **来源**：`docs/桌面版测卡工作区-实现规格.md` §五 缺陷③；`docs/history/大库重复卡-压测数据记录.md` §七

### CT-09 ｜ 🔴 项目此前**完全不维护 `prompt_order`** → 预设开关不生效
- **现象**：预设条目勾选框点了不生效；带 `enabled: false` 的条目仍被发给 AI；嵌套形态的预设**条目全部丢失**。
- **根因**：真实酒馆预设用**嵌套** `prompt_order: [{ character_id, order: [...] }]`，而旧实现只认扁平结构，导致 `ordered` 为空 → 退化成"使用全部 prompts"；且写回时只改一处，双份状态不同步。
- **修复（v2.2.6）**：
  - 新增 `normalizePromptOrder()` 兼容两种形态；
  - 关闭判定同时看 `prompt_order[].enabled` 与 `prompt.enabled`；
  - 新增 `setPromptEnabled()` **双写**两处；
  - 导出增加 `seen` 去重。
- **验证**：`test/chatPresets.test.mjs` 12 项（归一化 / 双位置同步 / 去重 / 边界）。
- **来源**：`CHANGELOG.md` v2.2.6「关键修复」；`docs/history/测试日志-2026-09-12.md` BUG-3

### CT-10 ｜ 🔴 测卡键未随物理路径迁移 → 会话与变量树**消失**
- **现象**：移动分组 / 重命名分组 / 换卡图后，"聊天测试"的会话与变量树**凭空消失**（数据其实还在，只是按新路径读不到）。
- **根因**：会话与变量树按**卡片物理路径**派生的键存储（`jsmobile-chat-<path>:sessions` 等）；卡片路径一变，旧键成孤儿。
- **修复**：新增 `migrateChatKeys(oldPath, newPath)`（`js/composables/chat/chatStorage.js`）—— **整键子串替换**，不依赖具体键格式（也适用于"目录前缀"式的分组重命名）；不覆盖已存在的目标键；迁移后 bump 版本号并 `flushNow()` 立即落盘。
- **接线点**：`useCardGroups.js` 的 `renameCurrentCategory`（目录前缀迁移）与 `moveCardToGroup`（单卡迁移）。
- **验证**：`test/chatKeyMigration.test.mjs` 4 例。
- **同类教训**：**凡「物理路径会变」的操作，都必须同步迁移所有按 path 派生的键** —— 同类缺陷 2026-09-01 已在「覆盖层 `app_config.json`」上踩过一次。
- **来源**：`CHANGELOG.md` v2.2.7（五）；`docs/history/大库重复卡-压测数据记录.md` §13.5

---

## 二、移动版测卡（CT-04 ~ CT-08，版本 v1.10.21）

### CT-04 ｜ 🟡 预设条目不可见、不可操作
- **现象**：用户反馈「导入的预设看不到预设条目，有什么用处呢」—— 侧栏「📋 预设」只显示预设名 + `N 条提示词` 计数，条目内容完全不可见不可改。
- **修复**：新增「📝 预设条目」区域，支持**展开编辑（名称 / 角色 / 正文）+ 开关 + 删除 + 新增 + 克隆**（克隆 = 深拷 + 同步 `prompt_order`）。
- **验证**：8→9 条，克隆项插在原条目下方，**重启后仍保留**（已写回 localStorage）。
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-2

### CT-05 ｜ 🟡 嵌套格式 `prompt_order` 使条目开关形同虚设
- **根因**：
  ```js
  for (const item of order) {
      if (!item || !item.enabled) continue;   // 嵌套格式 item.enabled === undefined → 全部跳过
  ```
  旧 `getOrderedPrompts` 只认扁平结构 → `ordered` 为空 → 退化成"使用全部 prompts"。
- **修复**：同 [CT-09] —— `normalizePromptOrder()` + 双位置同步 `setPromptEnabled()`。
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-3

### CT-06 ｜ 🟢 温度参数显示精度丢失
- **现象**：预设 `temperature: 0.85` 在步进器里显示 `0.8`（而下方"默认: 0.85"），数值与实际不符。
- **根因**：`paramKeys` 里 temperature 配 `decimal: 1`，但预设有 2 位小数。
- **修复**：`decimal: 1 → 2`，`step: 0.1 → 0.05`（top_p 本就 2 位，口径统一）。
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-4

### CT-07 ｜ 🟢 侧边栏标签栏溢出
- **现象**：6 个标签（配置/正则插件/世界书/变量/聊天/设置）总宽超出面板，**"设置"被裁掉**。
- **修复**：标签 `padding: 0 12px → 0 10px`、`font-size: 13px → 12.5px`。
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-5

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
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-6

---

## 三、移植缺口与自动化限制（CT-11、CT-12）

### CT-11 ｜ 🧩 移动版测卡引擎移植的 3 处阻塞级缺口（已补）
| # | 缺口 | 详情 | 处理 |
|---|---|---|---|
| 1 | **2 处 import 路径失效**（共 4 个路径） | `useChatApiConfig.js:7` / `useChatMemory.js:7` 写 `from '../bridge/api.js'` → 解析到不存在的位置；`ChatPanelSeg.vue:26` 写 `from '../useChatRender'` → 少一级 `chat/` 且缺 `.js` | 改 `./chatBridge.js` / `./useChatRender.js`。这是**当时唯一让引擎无法加载的原因** |
| 2 | **`useChatPresets.js` 落后于移动版** | 移动版 10291B 有 `normalizePromptOrder` / `setPromptEnabled` / 双位置 `enabled` 判定 / `seen` 去重；桌面暂存区 8123B 全无 | 直接用移动版整文件覆盖（纯函数、零依赖） |
| 3 | **`useStatusbarPreview.js` 两端分叉** | 移动版导出 `parseRegexPattern` / `classifyTemplate` / `sanitizeStatusHtml` / `extractLoaderUrls`，桌面版是模块私有（`sanitizeStatusHtml` 整个函数不存在） | 加 `export` 关键字（不改逻辑）+ 搬入 `sanitizeStatusHtml` |
- **来源**：`docs/移动版测卡引擎-移植前置检查报告.md` §三

### CT-12 ｜ 📌 自动化坑：重复点击已激活的 Tab 不会 remount
- **现象**：侧栏只在聊天 Tab 挂载时创建；若侧栏已被收起，直接再点「💬 聊天测试」**无效**（`currentTab` 值未变），测试脚本会误判为"点不开"。
- **规避**：测试须「**先切走再切回**」。
- **相关**：`vite build` 不清理旧产物（`build:web` 才清 `web/`）。
- **来源**：`docs/桌面版测卡工作区-实现规格.md` §五「踩坑记录」

---

## 四、本领域改动前的自检清单

1. 侧栏模板里访问任何**可能为 undefined 的列表/对象** → 必须走 `arr()` / `objKeys()` 兜底（[CT-01]）。
2. 读 **localStorage / IPC 存储**的 `computed` → 必须有响应式依赖（`void xxxVersion.value`），否则永久缓存（[CT-02]）。
3. **写回预设**时，`prompt_order` 与 `prompt.enabled` **两处都要写**（[CT-09]）。
4. 新增任何「按卡片 path 派生」的键 → 必须在移动/重命名路径上迁移（[CT-10]）。
5. 引擎改动后跑：`npm test` + `scripts/chat-sidebar-test.mjs`（生产 `app://`）+ `scripts/chat-engine-test.mjs`（dev + 调试句柄）。
6. 端到端测试**驱动真实 UI**，不要自己 import 引擎模块（[CT-03]）。
