# 🧪 规格与计划（docs/规格与计划/）

> 本目录存放**实现规格、前置检查报告、待办计划**这类「决策与排期」文档。
> 与其它目录的分工：`docs/bugs/` 记缺陷、`docs/技术支持/` 放代码与数据、`docs/发布/` 管发版流程，**这里记「要做什么、怎么做的约定」**。
> 最后整理：2026-09-13

---

## 一、文档清单

| 文档 | 定位 | 状态 |
|---|---|---|
| [桌面版测卡工作区-实现规格.md](桌面版测卡工作区-实现规格.md) | **已定稿的实现规格**：侧边栏 7 个分区的精确内容、编排接线方案、管线顺序、`renderChatHtml` 落地、S1~S4 构建顺序与验收、实测中发现并修复的 3 个真实缺陷、踩坑记录 | ✅ 已落地（2026-09-13 实测通过） |
| [移动版测卡引擎-移植前置检查报告.md](移动版测卡引擎-移植前置检查报告.md) | 移植前的**可行性 / 缺口检查**：引擎契约实测、3 处阻塞级缺口（import 失效 / `useChatPresets` 落后 / `useStatusbarPreview` 分叉）、3 处需拍板的取舍、修订后的迁移准备清单 | ✅ 缺口已补 |
| [角色卡插件页签-实现规格.md](角色卡插件页签-实现规格.md) | **已落地的实现规格**：角色卡工作区「插件」页签——卡内 `extensions.tavern_helper` 等插件的真实形态（76 张实测）、数据层/交互层设计、防抖与缓存决策、踩坑（弹窗位置 / ctx 四步）、CDP 实测验收 | ✅ 已落地（2026-09-19 实测通过） |
| [打标三层开关-P1实现规格.md](打标三层开关-P1实现规格.md) | **已定稿的实现规格（待实施）**：打标三层漏斗（规则 / 向量 / LLM）的逐层开关 + 规则组级与单条开关、`autoTagDisabledRules` 关闭清单、**清洗白名单解耦**（防误清洗历史标签，数据事故防线）、`useLocalVector` 并入 `tagFunnel` 并持久化、S1~S4 分步提交与 3 条硬验收、按 AI-01/02/05/06 与 AR-13/AR-14 设防 | 📐 待实施（2026-09-20 规格定稿） |
| [后续升级计划.md](后续升级计划.md) | **待办与排期**：第一部分「移动版测卡引擎 → 桌面版（P1）」已实施完成；第二部分「其他悬置项」仍是待办；第三部分是项目协作约定备忘 | ⏳ 部分待办 |

参考稿（不属于本目录，但被上述文档引用）：

| 文件 | 说明 |
|---|---|
| [`docs/reference/ui-model-TestSidebar.vue.txt`](../reference/ui-model-TestSidebar.vue.txt) | 移动版测卡侧栏的**旧快照**（仅作布局参考，`.txt` 后缀不参与构建） |
| [`docs/screenshots/`](../screenshots/) | **产品界面预览截图**（被仓库根 README 引用；移动版测试截图未提交进仓库） |

---

## 二、阅读顺序建议

1. 想了解「测卡工作区现在长什么样、为什么这么设计」→ 读 **实现规格**；
2. 想继续推进「移动版引擎 → 桌面版」的剩余部分 → 先读 **移植前置检查报告**（含缺口与取舍），再看 **后续升级计划** 的待办清单；
3. 动工前扫一眼 [`bugs/BUG-测卡工作区.md`](../bugs/BUG-测卡工作区.md)（12 条历史缺陷，含「读存储的 computed 会永久缓存」这类会重复踩的坑）。

---

## 三、相关代码与测试位置

| 位置 | 内容 |
|---|---|
| `js/components/ChatTestSidebar.vue` | 测卡侧栏（7 分区抽屉） |
| `js/components/EditorPanel.vue` | 角色卡编辑器（`basic/advanced/worldbook/regex/plugins/statusbar/chat/raw` 页签） |
| `js/components/CardPluginModal.vue` + `js/utils/cardPlugins.js` + `js/composables/useCardPlugins.js` | 卡内插件页签（解析 / 编辑 / 全屏 CodeEditor 弹窗） |
| `js/composables/chat/*` | 测卡引擎 16 个模块（`useChatEngine` / `chatStorage` / `useChatPresets` / `chatBridge` …） |
| `main/memoryStore.js` + `memory:*` IPC | 长期记忆通道（`memory_store.json`） |
| `test/chatStorage.test.mjs`、`test/chatPresets.test.mjs`、`test/chatKeyMigration.test.mjs`、`test/memoryStore.test.mjs` | 单测 |
| `scripts/chat-sidebar-test.mjs`、`scripts/chat-engine-test.mjs` | 端到端（生产 `app://` / dev + 调试句柄） |
