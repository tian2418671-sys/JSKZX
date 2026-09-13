# 文档索引（docs/）

> 桌面版（Electron + Vue3）文档总入口。移动版（`JSK管理APP`）文档不在此仓库。
> 最后整理：2026-09-13

---

## 一、测卡（角色卡对话测试）工作区

| 文档 | 说明 |
|---|---|
| [桌面版测卡工作区-实现规格.md](桌面版测卡工作区-实现规格.md) | **已定稿的实现规格**：7 分区侧栏、编排接线、管线顺序、S1~S4 完成情况、实测发现的三处真实缺陷、二期清单 |
| [移动版测卡引擎-移植前置检查报告.md](移动版测卡引擎-移植前置检查报告.md) | 移植前的可行性/缺口检查（12 个引擎文件、桥接层双端自适应、3 处硬缺口） |
| [后续升级计划.md](后续升级计划.md) | P1 大工程「移动版测卡引擎 → 桌面版」的完整排期与验收方式（含未完成项 #5 长期记忆） |
| [reference/ui-model-TestSidebar.vue.txt](reference/ui-model-TestSidebar.vue.txt) | 移动版测卡侧栏的**旧快照**（仅作布局参考，`.txt` 后缀不参与构建） |
| 代码 | `js/components/ChatTestSidebar.vue`（侧栏 UI）、`js/composables/chat/*`（引擎 16 个模块） |
| 测试 | `test/chatStorage.test.mjs`、`test/chatPresets.test.mjs`；端到端 `scripts/chat-sidebar-test.mjs`、`scripts/chat-engine-test.mjs` |

## 二、性能与压测

| 文档 | 说明 |
|---|---|
| [大库重复卡-压测数据记录.md](大库重复卡-压测数据记录.md) | 真实大库（`I:\03\角色色卡` 11,186 卡 / 9.76GB）的重复卡、OOM、加载提速、正则交互修复全记录（§1~§11，含 P0/P1/P2 与内嵌缓存 A/B） |
| [测试日志-2026-09-13.md](测试日志-2026-09-13.md) | 桌面版当日专项：9 个 Bug 的现象/根因/验证、性能数据、冷启动 I/O 量化、发版清单 |
| 工具 | `scripts/measure-startup.mjs`（启动分项测量）、`scripts/png-head-io-probe.mjs`（读取量探针）、`scripts/library-dup-*.mjs`（重复卡压测） |
| 探针 | `scripts/_cdp-eval.mjs`（CDP 取值）、`scripts/_probe-regex-ui.mjs`（正则增删 UI）、`scripts/_probe-index*.mjs`（索引状态） |

## 三、插件工作区

| 文档 | 说明 |
|---|---|
| [插件工作区-酒馆渲染API调研.md](插件工作区-酒馆渲染API调研.md) | SillyTavern / JS-Slash-Runner 源码与官方文档整理（模板引擎、Markdown、消息块、事件、Slash 命令、脚本 API） |
| [插件功能-格式说明.md](插件功能-格式说明.md) | 插件 JSON 扩展格式说明 |

## 四、发布与更新

| 文档 | 说明 |
|---|---|
| [自动更新说明与常见问题.md](自动更新说明与常见问题.md) | OTA 机制、`latest.yml` 要求、常见问题 |
| `CHANGELOG.md`（仓库根） | 版本变更总表（当前：**v2.2.7**） |
| `RELEASE_NOTES.md`（仓库根） | 面向用户的发行说明 |

## 五、排查与专题

| 文档 | 说明 |
|---|---|
| [同类重复项缺陷-全库排查报告.md](同类重复项缺陷-全库排查报告.md) | 全库范围的「同类重复」缺陷排查结论 |
| [测试日志-2026-09-12.md](测试日志-2026-09-12.md) | **移动版**测试日志（变量树 / 预设条目 / 本地导入 / 并发竞态专项） |

## 六、历史存档 `history/`

| 文档 | 说明 |
|---|---|
| [history/AI-交接指导.md](history/AI-交接指导.md) | 早期交接说明（架构、约定、口径） |
| [history/AI打标代码汇总.md](history/AI打标代码汇总.md) | AI 自动打标相关代码汇总 |
| [history/DM-世界书条目名修复与角色卡导入.md](history/DM-世界书条目名修复与角色卡导入.md) | 世界书条目名修复与导入专题 |
| [history/git-import-archive.md](history/git-import-archive.md) | 早期 git 导入归档 |

## 七、截图 `screenshots/`

见 [screenshots/README.md](screenshots/README.md)。
