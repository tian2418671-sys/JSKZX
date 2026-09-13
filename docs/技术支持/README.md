# 🧰 技术支持文档索引（docs/技术支持/）

> 本目录存放**可复用的技术资产**：完整代码片段、实测技术数据、外部 API 参考、格式规范、探针工具。
> 与 `docs/bugs/` 的分工：那里写「坏在哪、怎么修」，这里写「**代码长什么样、实测数字是多少、外部接口怎么用**」。
> 最后整理：2026-09-13

---

## 一、代码片段（可直接查阅 / 移植 / 审查）

| 文档 | 内容 | 规模 |
|---|---|---|
| [代码片段-AI打标.md](代码片段-AI打标.md) | AI 打标 4 处代码完整汇总：自动打标规则表（纯常量）、规则式打标 + 后台落盘、AI 智能打标引擎（组合式）、AI 打标弹窗组件 | 约 800 行 |
| [代码片段-世界书条目名修复与导入.md](代码片段-世界书条目名修复与导入.md) | 世界书导出条目名缺失的修复代码 + 「从世界书库导入词条到角色卡」7 个修改点（精确锚点 + 可照抄的替换内容） | 约 230 行 |
| [代码片段-Git导入封存.md](代码片段-Git导入封存.md) | 已**移除**的「Git 链接导入插件」功能全部代码（主进程 IPC / preload 桥接 / 组合式 / UI），封存备查与将来恢复 | 约 230 行 |

## 二、实测技术数据

| 文档 | 内容 |
|---|---|
| [技术数据-大库压测与性能.md](技术数据-大库压测与性能.md) | 11,186 卡 / 9.76GB 与 22,372 卡 / 19.85GB 两大库的**全部实测数字**：加载分项、堆构成审计、P1a 前后对比、内嵌缓存 A/B、冷启动 I/O 量化、容量边界、移动版 500 卡压测 |

## 三、外部接口参考

| 文档 | 内容 |
|---|---|
| [API参考-酒馆插件渲染.md](API参考-酒馆插件渲染.md) | SillyTavern / JS-Slash-Runner 源码与官方文档整理：扩展模板渲染（Handlebars）、消息渲染（Showdown）、消息块 DOM 结构、`getContext()` 完整成员、事件系统、Slash 命令、脚本 API |
| [格式说明-插件格式.md](格式说明-插件格式.md) | 插件 JSON 扩展格式、支持的插件形态、本地目录扫描接入方式、工作区「📄 代码 / ✨ 效果」双卡 |

---

## 四、探针与工具脚本速查（`scripts/`）

### 压测与容量

| 脚本 | 用途 |
|---|---|
| `capacity-check.ps1` | **一键压测**：自动挑最大库 → robocopy 造副本 → 写隔离 profile → 启 Vite+Electron → 轮询采样 → 汇总。`-Copies N` 造副本、`-ReplicaDir` 复用已有副本（⚠️ 不能写成 `-Replica`）、`-Keep -Hold` 保留现场 |
| `library-dup-search-refresh.mjs` | 搜索→刷新→未等防抖→清空→连点 6 次，逐段查「库层 + 列表层」重复并记录堆占用 |
| `library-dup-race.mjs` / `library-dup-stress.mjs` / `library-dup-probe.mjs` | 并发/连点/互斥验证；刷新 ×N + 搜索 ×N（搜索段偏慢）；早期小库探针 |
| `measure-startup.mjs` | 启动分项测量（临时 profile、生产模式），`--label` 打标签、`--library` 指定库、`--timeout` 调超时 |
| `png-head-io-probe.mjs` | PNG 头**读取量**探针（复刻主进程窗口逻辑，量化冷启动 I/O） |

### CDP 探针

| 脚本 | 用途 |
|---|---|
| `_cdp-eval.mjs` | 通用取值（`EXPR` 传表达式，`GC=1` 先强制 GC） |
| `_cdp-mem.mjs` | 堆 / 索引 / 内存守门员（`--refresh` 顺便跑刷新，`--gc` 仅最终取样时 GC） |
| `_cdp-text.mjs` | 应用自身进度与卡片数 |
| `_heap-audit.mjs` | 堆构成审计（按字段拆「文本 vs 对象开销」） |
| `_probe-index.mjs` / `_probe-index2.mjs` | 索引诊断（包装 `__jskDiag.idx` 的 clear / buildAsync，抓 console） |
| `_probe-regex-ui.mjs` | 正则/状态栏增删 UI 端到端（含原生确认框应答） |

### 端到端

| 脚本 | 用途 |
|---|---|
| `release-check.mjs` | **发版前置自查**（语法 + 单测 + 构建 + 文档一致性 + git 状态），`--e2e dev/prod` 加跑端到端 |
| `chat-sidebar-test.mjs` | 测卡侧栏 7 分区（生产 `app://` 构建） |
| `chat-engine-test.mjs` | 测卡引擎管线（宏 / 世界书 / EJS / payload / 分段渲染 / swipe） |
| `dev-run.ps1` | dev 启动（含终端编码修正） |

> ⚠️ **探针铁律**：读应用单例状态**必须**走 `window.__jskDiag.*`（应用真正使用的那份），
> 自己 `import('/js/utils/xxx.js')` 会因 Vite 的 `?t=` 查询参数拿到**另一个模块实例**，读数全错。
