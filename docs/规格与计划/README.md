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
| `js/composables/chat/*` | 测卡引擎 16 个模块（`useChatEngine` / `chatStorage` / `useChatPresets` / `chatBridge` …） |
| `main/memoryStore.js` + `memory:*` IPC | 长期记忆通道（`memory_store.json`） |
| `test/chatStorage.test.mjs`、`test/chatPresets.test.mjs`、`test/chatKeyMigration.test.mjs`、`test/memoryStore.test.mjs` | 单测 |
| `scripts/chat-sidebar-test.mjs`、`scripts/chat-engine-test.mjs` | 端到端（生产 `app://` / dev + 调试句柄） |
