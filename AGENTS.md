# AGENTS.md — JSK管理 项目给 AI 助手的入口

> 本文件是**通用 AI 助手入口**（Copilot 另有 `.github/copilot-instructions.md`，内容一致）。
> **开工前请按顺序读这两个文件**：

1. [`START-HERE.md`](START-HERE.md) —— 入口、必读顺序、30 秒速览、铁律
2. [`AI交接指导.md`](AI交接指导.md) —— **主指导文档**：项目架构、模块职责、标准工作流、高频缺陷地图、开工清单

然后按需查：

| 找什么 | 去哪 |
|---|---|
| 历史缺陷与坑（146 条，按领域 + 设计原因） | [`docs/bugs/README.md`](docs/bugs/README.md) |
| 代码片段 / 实测技术数据 / 外部 API / 脚本清单 | [`docs/技术支持/README.md`](docs/技术支持/README.md) |
| 发版一条龙（含内部 vs 对外文档分工） | [`docs/发布/一条龙-发布流程.md`](docs/发布/一条龙-发布流程.md) |
| 实现规格与后续计划 | [`docs/规格与计划/`](docs/规格与计划/README.md) |
| 版本级技术细节（内部） | [`CHANGELOG.md`](CHANGELOG.md) |
| **文档怎么整理 / 加到哪张表 / 哪些数字要同步** | [`docs/文档整理规则.md`](docs/文档整理规则.md) |

## 五条最容易踩的红线

1. **没收到用户明确的推送 / 打包指令，禁止 push、打包、发 Release。**
2. **改动后必须真实启动冒烟**（`npm start` 或 `npx electron . --disable-gpu --enable-logging`）—— `vite build` 只验编译不验运行时。
3. **对外文档（`RELEASE_NOTES.md` / GitHub Release 正文）不写内部细节**（文件名、函数名、脚本名、内存 MB、阶段耗时、崩溃原文），那些只进 `CHANGELOG.md` 与 `docs/**`。
4. 🚫 **测试一律上真实库，禁止「隔离 / 模拟」糊弄** —— **读操作**（扫描 / 搜索 / 索引 / 渲染 / 统计）必须跑真实库；
   **写操作**（改标签 / 删卡 / 保存 / 移动）仍用隔离库，防误删真数据。
   **禁止**用假卡 / 空库 / 小样本替代真实库来「证明功能正常」—— 历史多次教训（DF-18 大库闸门、PK-19 索引规模、DF-17 字段口径）都是**只在真库才暴露**。
   > 📌 真实库：角色卡 `E:\AI\酒馆工具\角色卡`（89 张）/ 压测大库 `I:\03\角色色卡`（11,849 张）/ 世界书 `H:\01\全局世界书`（41 本，含 6 本 ≥6MB）。
   > 📌 **配置仍隔离**（`--user-data-dir=%TEMP%\xxx`）—— 只隔离配置/缓存，**不隔离卡库**。详见 [`AI交接指导.md`](AI交接指导.md) 铁律 9。
5. 🧩 **扩展缺了自己装，不许降级糊弄** —— 需要某扩展能力而**本机没装、装不全、或换了台机器**时，
   **AI 自行下载安装后再用它把任务做完**：查已装 `code --list-extensions --show-versions` →
   安装 `code --install-extension <publisher.id>`（更新须带 `@<版本>`）→ 装完新开终端，
   需界面命令 / 语言服务生效时提示重载窗口。**不得**因「本机没装」就跳过检查 / 手工糊弄 / 声称做不到；
   装不上时走纯 CLI 等价通道（如 `npx --yes <包名>`）兜底并说明原因。

## AI 工具链（本机通用）

> 本机已配置**用户级 AI 指令**（所有工作区自动加载；若未见生效，重载窗口一次）：
> `%APPDATA%\Code\User\prompts\instructions\ai-extension-workflow.instructions.md`
> 通用原则：**装了就要用，没装就自己装** —— 终端 CLI 优先（可闭环验证）→ VS Code 命令（UI 效果）→ 文件工作流。

| 场景 | 工具 |
| --- | --- |
| `docs/**` 和根 md 的检查/修复 | `npx --yes markdownlint-cli2 "docs/**/*.md" "*.md" --fix` |
| 全工作区 md 检查（结果进 Problems 面板） | VS Code 命令 `markdownlint.lintWorkspace` |
| 文档导出 PDF / HTML / EPUB | VS Code 命令 `md.exportPdf` / `md.exportHtml` / `md.exportEpub`（nettrash 扩展，须目标 md 为活动编辑器） |
| 扩展体检 / 更新检查（参考脚本） | `h:\01\api配置文件夹\scripts\_ext_health.py`、`_ext_update_check.py` |

**写 Markdown 时自觉遵守 lint 规则**（标题前后空行、代码块标语言、列表前后空行）—— 本项目 `docs/**` 体量大，别制造新问题。
