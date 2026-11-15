# C 盘空间体检报告

> 检测时间：2026-11-05 · 磁盘：C: 291.36 GB
> 结论：**可用空间从 36.65 GB（12.6%）提升到 117.81 GB（40.4%）**，累计释放 81.16 GB（磁盘实测）。

---

## 一、结果总览

| 项目 | 清理前 | 现在 |
| --- | --- | --- |
| 已用 | 254.71 GB | 173.55 GB |
| 可用 | 36.65 GB | **117.81 GB** |
| 可用率 | 12.6% | **40.4%** |
| 驱动库 DriverStore | 38.21 GB（168 包） | **5.83 GB（87 包）** |

---

## 二、已清理明细

| 项目 | 位置 | 名义大小 |
| --- | --- | --- |
| 驱动库重复版本（81 个旧包） | `Windows\System32\DriverStore` | ≈32 GB |
| NVIDIA 着色器缓存（793 个 `.nvph`） | `AppData\Local\NVIDIA\DXCache` | 14.96 GB |
| NVIDIA 驱动安装包残留 | `ProgramData\NVIDIA Corporation\NVIDIA app\UpdateFramework` | 8.70 GB |
| 废弃应用 idoltime 数据（停更于 2024-11） | `AppData\Roaming\idoltime` | 6.72 GB |
| UE 派生数据缓存 | `AppData\Local\UnrealEngine\Common\DerivedDataCache` | 4.76 GB |
| Chrome 本地 AI 模型 | `Chrome\User Data\OptGuideOnDeviceModel` | 3.98 GB |
| OpenSquilla 崩溃转储（8 个 `.dmp`） | `C:\OpenSquillaDumps` | 3.57 GB |
| IObit 驱动下载包 + 备份 | `ProgramData\IObit\Driver Booster` | 2.76 GB |
| Cursor 状态库旧备份 | `Cursor\User\globalStorage\state.vscdb.backup` | 2.49 GB |
| Go 构建缓存 | `AppData\Local\go-build` | 2.38 GB |
| VS Code 死/闲置工作区（13 个） | `Code\User\workspaceStorage` | 2.14 GB |
| Puppeteer / pnpm / pip 缓存 | `~\.cache`、`pnpm\store`、`pip\cache` | 1.35 GB |

> 分项为名义大小（驱动库存在硬链接，重复计量），**以磁盘实测的 81.16 GB 为准**。
> 保留未动：JSK管理 的 VS Code 工作区状态（1.69 GB）、JSK管理APP（0.62 GB）、所有文档/配置/存档。

### 驱动库里删了什么

168 个包中 33 组是同一 INF 的多版本堆叠，最终清理 81 个旧包：

| INF | 原有 | 说明 |
| --- | --- | --- |
| `ibtusb.inf` | 25 个版本 | Intel 蓝牙，每次更新留一份 |
| `nvcvi.inf` | 13 个版本 | NVIDIA 显卡驱动 |
| `nvpcf.inf` | 5 个版本 | NVIDIA 平台控制 |
| `nvhda.inf` / `xvdd.inf` / `netwtw6e.inf` | 各 4 个 | 音频 / 虚拟显示 / 无线网卡 |

唯一保留的重复：`acpibridge1.inf` 的 `oem0.inf`——**正在被设备使用，系统拒绝删除，脚本已安全跳过**（这是预期行为）。

---

## 三、脚本使用说明（可反复用）

目录 `C盘整理\`：

| 文件 | 用途 |
| --- | --- |
| `run-admin.cmd` | 双击 → 预演，只列清单不删 |
| `run-admin-execute.cmd` | 双击 → 执行（自动提权，删除前会显示逐条进度） |
| `admin-clean.ps1` | 脚本本体；默认预演，`-Execute` 才真删 |
| `logs\` | 每次运行的事务日志 |

可选开关（命令行加参数）：

- `-Deep`：额外做 WinSxS 组件清理（DISM，慢，通常再省 1–3 GB）
- `-EmptyRecycleBin`：清空回收站

安全设计：

- 驱动库**每个 INF 只留最新版**，删除不加 `/force`，在用/受保护的会被系统拒绝并跳过；
- 遇到「只有 SYSTEM 权限」的文件（如崩溃转储），会先调用 `icacls` 授予 Administrators 完全控制再删；
- 删除过程逐条打印 `[i/n]` 进度，**不要中途关窗口**（关了进程就被杀，已删的生效、剩余的留到下次）。

---

## 四、还能再挖（都已给你留原地）

| 项目 | 大小 | 建议 |
| --- | --- | --- |
| `C:\Steam`（含创意工坊 9.8 GB） | 9.77 GB | 游戏本体，别删；可在 Steam 卸载不玩的 |
| `C:\Users\Tk\.android`（模拟器镜像+快照） | 6.18 GB | 不做安卓开发可整删；做的话删 `avd\*\snapshots` |
| UE Zen 资源缓存 | 4.76 GB | 不碰 UE 项目可删，重开项目会重建 |
| TRAE SOLO CN 数据 | 3.70 GB | 不用这编辑器就删 |
| Tencent（微信/QQ） | 3.14 GB | 聊天记录，建议在客户端内清理 |
| kingsoft（WPS） | 3.09 GB | 含云文档缓存 |
| `Windows\Installer` | 2.85 GB | **别手删**，删了 Office/大型软件无法修复卸载 |
| Docker 磁盘镜像 | 2.19 GB | 用 `docker system prune` 更安全 |
| `ProgramData\Package Cache` | 1.47 GB | **别删**，VS 等安装器的修复源 |

---

## 五、C 盘根目录的「零字节杂物」

这些文件夹几乎不占空间，但很碍眼，可统一归到 `C:\_待整理\`：
`$360Section`、`360SANDBOX`、`360sr`、`大漠`、`腾讯应用宝文件管理`、`迅雷下载`、`迅雷云盘`、`adobeTemp`、`Aomei`、`ComboKey`、`dumps`、`emu_dbg`、`FLiNGTrainers`、`Gloss Mod Manager`、`KRECYCLE`、`OneDriveTemp`、`OTHComp`、`scm_test`、`StuData`、`testsbt`、`ybz`，以及散落文件 `AiOLog.txt`、`capture_debug.txt`、`AMTAG.BIN`、`END`、`user_fill.png`、`quickly_dc.ini`。

> `C:\jskapp`（5.77 GB）是项目代码 + `node_modules`，正经数据，别动。

---

## 六、别再涨回来的几条

1. **NVIDIA 驱动**：每次更新后 `DXCache` 和 `NVIDIA app\UpdateFramework` 会各涨几 GB——每月跑一次本目录脚本即可；
2. **别用「驱动大师 / Driver Booster」频繁更新驱动**：这台机器 `ibtusb` 攒了 25 个版本、显卡驱动 13 个，正是驱动库涨到 38 GB 的元凶；
3. **Docker 镜像别放 C 盘**，设置里改到 D 盘；
4. **安卓模拟器镜像**放 D 盘（AVD 路径可改）。

---

## 附：本次踩到的两个坑（已在脚本里修掉）

1. **双击闪退**：启动器里用 `\"%PS1%\"` 传路径，反斜杠被 cmd 原样带入，PowerShell 收到 `\"E:\...ps1\"` 报 `Illegal characters in path` 立即退出。改为**脚本自提权**（用 `$PSCommandPath`，零转义）。
2. **中文被 cmd 拆坏**：`.cmd` 里写中文 `echo` / `title`，在 UTF-8 代码页下会截断成非法命令。启动器已改为纯英文，中文只由 PowerShell 输出。
