# RL · BUG 记录 — 发布 / 打包 / 更新 / OTA

> 领域：从「代码就绪」到「用户收到 OTA」这条链上踩过的坑。
> 完整流程见 [`../发布/规范与流程/一条龙-发布流程.md`](../发布/规范与流程/一条龙-发布流程.md)；总索引见 [`README.md`](README.md)。
> 一句话记忆：**发布链上的错误几乎都是"静默失败"** —— 不报错、但用户收不到更新。

---

## 一、OTA / 更新链路（RL-01、RL-05）

### RL-01 ｜ 🔴 `latest.yml` 未上传 → OTA 静默失败（404）
- **现象**：Release 建了、exe 也在，但老客户端点「检查更新」永远说"已是最新"。
- **根因**：`electron-updater` 读的是 `releases/latest/download/latest.yml`，缺这个文件就是 404 —— **没有任何用户可见的报错**。
- **修复/规矩**：`exe` + **`latest.yml`** + `*.exe.blockmap` 必须**同一次一起上传**。
- **验证**：`Invoke-WebRequest https://github.com/tian2418671-sys/JSKZX/releases/latest/download/latest.yml` 返回 200，且里面的 `version:` 是新版本号。
- **来源**：早期坑清单（打包/发布）；v1.8.5；`v2.2.7 发布执行清单` §4

### RL-05 ｜ 🟡 发布未同步 GitHub Release → OTA 误报 downgrade
- **根因**：OTA 以 `releases/latest` 为基准，只推 tag 不建 Release（或建成 draft/prerelease）会让更新检测出错。
- **规矩**：发布后必须 `gh release list` 确认该版本 **Latest**（`gh release view --json` **没有 `isLatest`** 字段，只能用 list）。
- **来源**：早期坑清单（打包/发布）；v1.8.5

---

## 二、打包（RL-02 ~ RL-04、RL-07、RL-12、RL-13）

### RL-02 ｜ 🟡 `electron-builder` 卡住 = 正在下载 Electron 二进制（勿误杀）
- **现象**：打包"假死"很久没输出，容易被误判断掉重来。
- **修复/离线打包**：
  ```powershell
  $env:ELECTRON_BUILDER_OFFLINE='true'
  npx electron-builder --win nsis --config.electronDist="<项目>\node_modules\electron\dist"
  ```
- **来源**：早期坑清单（打包/发布）；v1.8.5

### RL-03 ｜ 🟡 打包前未杀旧实例 → EBUSY 锁文件
- **修复**：按 **Path** 匹配杀，不能只杀 `electron.exe`：
  ```powershell
  Get-Process | Where-Object { $_.Path -like '*JSK管理*' -or $_.Path -like '*win-unpacked*' -or $_.ProcessName -eq 'electron' } | Stop-Process -Force -EA SilentlyContinue
  ```
- **来源**：早期坑清单（打包/发布）

### RL-04 ｜ 🟡 `build:web` 的 `rmSync` 可能没真正清空 `web/`
- **后果**：历史 JS 累积进 asar，包体虚增。
- **修复**：必要时 PowerShell 强删 `web/` 后重建。
- **来源**：早期坑清单（打包/发布）

### RL-07 ｜ 🔴 `electron-builder` 报 EPERM rmdir `onnxruntime-node\lib`
- **现象**：
  ```
  EPERM: operation not permitted, rmdir '...\dist\win-unpacked\resources\app.asar.unpacked\node_modules\onnxruntime-node\lib'
  ```
- **根因**：旧的 `win-unpacked` 进程（或用它启动过的实例）仍占用该目录。
- **修复**：杀掉 `Path` 含 `win-unpacked` / `dist_new` 的进程；并把输出目录换成**未被占用的新目录**：
  ```
  npx electron-builder -w --config.directories.output=dist_new
  ```
- **来源**：`v2.2.7 大库压测`；v2.2.7 实战

### RL-12 ｜ 🟡 PowerShell 脚本的两个编码/调用陷阱
- **① BOM-less `.ps1` 含中文字面量 → 乱码**（路径匹配失败、`Tee-Object` 写出乱码）。
  **规矩**：临时打包/校验脚本**一律纯 ASCII**，用**通配符**定位中文文件名（如 `Get-ChildItem '*\win-unpacked' -Filter '*.exe' | Where-Object { $_.Name -notlike '*uninstaller*' }`）。
- **② `Start-Process -RedirectStandardOutput` 与 `-RedirectStandardError` 不能指向同一文件**（报「无法运行此命令」），必须给两个文件。
- **来源**：v2.2.7 实战

### RL-13 ｜ 🟡 终端里带中文的长单行命令会被随机 `^C`
- **现象**：同步执行的命令偶发直接返回 `^C`（无任何输出），必须重试或改写为**脚本文件**执行。
- **规避**：把逻辑写进 `%TEMP%\*.ps1` 再 `-File` 调用；命令越短越稳；脚本自身把结果落盘到文件再读，避免依赖终端回显。
- **来源**：v2.2.7 实战

---

## 三、提交 / 推送（RL-06、RL-08）

### RL-06 ｜ 📌 `gh release` 无输出 = 正在后台上传
- **规矩**：大文件上传时**不要中断**，等完成通知；`gh release list` 看 Latest（`view --json` 没有 `isLatest`）。
- **来源**：早期坑清单（打包/发布）

### RL-08 ｜ 🟡 本机 git 直连 GitHub **间歇性**失败
- **现象**：`fatal: unable to access ...: Empty reply from server` 或 `Could not connect to github.com:443 after 21148 ms`；**有时 tag 推成功、master 推失败**（两次是独立的网络事务）。
- **修复**：
  ```powershell
  git -c http.proxy= -c https.proxy= push origin master   # 清空代理（本机全局代理配置不可靠）
  ```
  并**加重试循环**（6 次、间隔 8s），推完用 `git status -sb` 确认不再 ahead。
- **来源**：v2.2.7 实战

---

## 四、验证与自测（RL-09 ~ RL-11）

### RL-09 ｜ 🟡 PS 5.1 的 `Invoke-WebRequest` 两个坑
- **① 不加 `-UseBasicParsing` 会弹安全确认** → 非交互脚本直接失败（exit 1）。
- **② `Content` 可能是 `byte[]`**（非预期 content-type 时），要 `[System.Text.Encoding]::UTF8.GetString($resp.Content)` 再解析。
- **来源**：v2.2.7 实战

### RL-10 ｜ 🟢 `gh release view --jq` 只接受**一个**输出表达式
- **现象**：`--jq '"a", (.assets[] | ...)'` 报 `accepts at most 1 arg(s), received N`。
- **修复**：拆成多次调用，或用一条 `\(...)` 拼接表达式。
- **来源**：v2.2.7 实战

### RL-11 ｜ 📌 从终端启动打包后的 GUI 应用会**继承控制台**
- **现象**：`Start-Process` 启动 Electron 应用后，该应用会往 VS Code 终端写日志；**一旦该终端收到 `^C`，应用被连坐杀死**（表现为"莫名 `^C`" + 随后的存活性检查 `alive=0`）。
- **规避**：要验证存活状态就**另起一条命令**；冒烟测试用隔离 profile：
  ```
  <exe> --user-data-dir=%TEMP%\jsk-smoke-profile
  ```
  并查看该 profile 下的 `crash.log`（`userData/crash.log`）。
- **来源**：v2.2.7 实战

---

## 五、产物校验清单（发版必跑，缺一项就可能静默失败）

| 校验 | 判据 |
|---|---|
| `latest.yml` 版本号 | `version:` == 本次版本 |
| `latest.yml` 的 `size` / `sha512` | 与 exe 实际值**完全一致**（sha512 为 base64） |
| blockmap | 与 exe 同名同版本，存在 |
| asar 内容 | 含**本次构建的哈希文件名**（如 `web/assets/index-<hash>.js`）；校验串要用**压缩后仍保留的字符串字面量 / 动态属性名**，**不要用函数名**（会被混淆掉） |
| 冒烟 | 隔离 profile 启动，`crash.log` 无新增 |
| OTA | `releases/latest/download/latest.yml` → 200 且版本正确 |

> 参考实现：本次发版用的 `%TEMP%\jsk-verify.ps1` / `jsk-asar-check2.mjs` / `jsk-smoke2.ps1`（一次性脚本，逻辑已沉淀到本节与 `docs/发布/规范与流程/一条龙-发布流程.md`）。
