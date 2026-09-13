# 项目协作指令 · JSK管理（SillyTavern 角色卡管理器）

> 本文件由 AI 助手**自动加载**。开工前请**先读 [`START-HERE.md`](../START-HERE.md) → [`AI交接指导.md`](../AI交接指导.md)**。
> 当前版本 **v2.2.7**（Electron 43 + Vue 3 + Vite 8；`npm test` = 256 用例）。

## 铁律（违反会出事）

1. **没收到用户明确的推送 / 打包指令，禁止 push / 打包 / 发 Release** —— 用户要先自己看效果。
2. 用户报「某功能坏了」时，**先 grep / 读源码验证现状**，再判断是否真坏了（历史多次为误报）。
3. 改动后必须过三关：`get_errors` → `npm run build:web` → **真实启动冒烟**（`npx electron . --disable-gpu --enable-logging`）。
   `vite build` **只验编译、不验运行时**（TDZ、渲染崩溃都是编译期看不出来的）。
4. **文档分工**：`RELEASE_NOTES.md` 是对外文档（只写用户能感知的变化，禁写文件名 / 函数名 / 脚本名 / 内存 MB / 阶段耗时 / 崩溃原文）；
   `CHANGELOG.md` 与 `docs/**` 是内部文档。细则见 `docs/发布/内部信息.md`、`docs/发布/用户可看信息.md`。
5. **发现新缺陷**：先在 `docs/bugs/README.md` 加一行，再在对应领域文档加「现象 / 根因 / 修复 / 验证」条目，**然后**才写修复代码。
6. 涉及**物理路径变化**的操作（移动分组 / 重命名 / 换卡图）必须同步迁移所有按 path 派生的键（会话 / 变量树 / 覆盖层配置）。

## 文档地图（要什么去哪）

| 找什么 | 去哪 |
|---|---|
| 接手须知、架构、标准工作流、高频缺陷地图 | [`AI交接指导.md`](../AI交接指导.md) |
| 历史缺陷与坑（**94 条**，按领域） | [`docs/bugs/README.md`](docs/bugs/README.md) |
| 代码片段 / 实测技术数据 / 外部 API 参考 / 脚本清单 | [`docs/技术支持/README.md`](docs/技术支持/README.md) |
| 发版流程（产物校验、OTA 验证、回滚、检查单） | [`docs/发布/一条龙-发布流程.md`](docs/发布/一条龙-发布流程.md) |
| 实现规格与后续计划 | [`docs/规格与计划/`](docs/规格与计划/README.md) |
| 版本级技术细节 | `CHANGELOG.md` |
| 文档总地图 | [`docs/README.md`](docs/README.md) |

## 常用命令

```bash
npm test                      # 256 用例
npm run build:web             # 构建渲染层
npm start                     # 源码版运行（= build:web + electron .）—— 运行时验证用它
npx electron . --disable-gpu --enable-logging    # 生产代码直接启动，看 [Vue 错误]
node scripts/release-check.mjs                   # 发版前置自查
node scripts/check-doc-links.mjs                 # 文档相对链接校验
```

## 环境注意

- **开发/排查必须跑源码版**（`npm start`）；`dist/`、`dist_new/` 里是**构建产物**，跑它看不到新代码（历史上出现过「用户跑打包版、误以为修复无效」）。
- 大库调试 / 端到端一律用**隔离 profile**：`--user-data-dir=%TEMP%\xxx`，绝不碰 `%APPDATA%\sillytavern-card-manager`。
- 崩溃排查第一现场：`userData/crash.log`（渲染进程）与 `userData/Crashpad/*.dmp`（原生）。
- 探针读应用单例状态**必须**走 `window.__jskDiag.*`；自己 `import()` 会拿到另一个模块实例，读数全错。
