# scripts/pychecks/ —— 一键检查（`python scripts/check.py`）的检查项目录

> 运行器与框架在 `../check.py`（CLI）与 `../checkkit.py`（类型与工具）。
> **这里放检查项**：加一条检查只需要往本目录丢一个文件，不用改运行器。

---

## 一、两种扩展方式

### 方式 A：写 Python（能力最强）

新建 `scripts/pychecks/你的名字.py`：

```python
from checkkit import Check, ok, warned, failed, skipped

def my_check(ctx):
    cp = ctx.run(["node", "--check", "main.js"])      # 子进程（自动 utf-8、可超时）
    if cp.returncode != 0:
        ctx.note(ctx.out(cp, 400))                    # 失败或 -v 时打印
        return failed("main.js 语法错误")
    if not ctx.exists("web/index.html"):
        return warned("web/ 还没构建（build:web）")
    return ok("通过")

def register(reg):
    reg.add(Check(
        name="我的检查：xxx",        # 名字（报告里显示）
        run=my_check,               # 检查体
        tags=("docs",),             # 标签（--only/--skip/#tag 用）
        severity="warn",            # blocker=失败即退出码 1；warn=只提醒
        # timeout=120,              # 子进程超时（秒），默认取 --timeout
        # paths=("js/**",),         # 责任路径：声明后可用于 --changed
    ))
```

> 也可以用 `CHECKS = [...]` 列表代替 `register(reg)`；两种都认。
> 文件名以 `_` 开头会被跳过（临时/草稿放 `_xxx.py` 即可）。

**返回值**（`Check.normalize` 容忍多种写法）：
`ok(detail)` / `warned(detail)` / `failed(detail)` / `skipped(detail)` / `info(detail)`，
或 `True/False`，或 `("pass"|"fail"|"warn"|"skip", "detail")`。

**`Context` 现成工具**（`checkkit.Context`）：

| 用途 | 写法 |
|---|---|
| 路径 | `ctx.path("js/app.js")` / `ctx.exists("web/index.html")` / `ctx.listdir("main")` |
| 读文件 | `ctx.read("package.json")` / `ctx.read_json("package.json")` |
| 找文件 | `ctx.glob("js/**/*.vue")`（自动跳过 `.git` `node_modules` `web` `dist` `__pycache__`） |
| 跑命令 | `ctx.run(["node", "x.mjs"])` / `ctx.node("--check", "main.js")` / `ctx.npm("test")` / `ctx.git("status", "--porcelain")` |
| 取输出 | `ctx.out(cp)`（stdout+stderr）、`ctx.out(cp, 400)`（只看末尾 400 字符） |
| 记录细节 | `ctx.note("...")` —— 该检查失败或 `-v` 时打印 |

### 方式 B：不写代码，声明式（`*.json`）

往本目录任意 `*.json` 里加一项即可（字段含义写在文件顶部 `_说明`）：

```json
{
  "checks": [
    {
      "name": "文档相对链接",
      "cmd": ["node", "scripts/check-doc-links.mjs"],
      "tags": ["docs"], "severity": "blocker", "timeout": 120,
      "expect_exit": 0,
      "ok_pattern": "ALL RESOLVE",
      "fail_pattern": "FAIL",
      "paths": ["docs/**"]
    }
  ]
}
```

### 方式 C：生成模板

```bash
python scripts/check.py --new my_check     # 生成 scripts/pychecks/my_check.py 模板
python scripts/check.py --only my_check
```

---

## 二、标签约定（沿用即可，便于组合过滤）

| 标签 | 含义 |
|---|---|
| `syntax` | 语法/可解析性（应保持很快，随手跑） |
| `test` `build` | 单测 / 前端构建（都带 `slow`，`--fast` 会跳过） |
| `docs` | 文档链接、版本一致性、对外文件禁词、脚本登记 |
| `git` | 工作区状态、与远端同步 |
| `hygiene` | 仓库卫生（缓存目录、临时文件） |
| `custom` | 个人/临时检查（模板默认给这个） |
| `slow` | 耗时项：加了这个标签就会被 `--fast` 跳过 |

---

## 三、常用命令

```bash
python scripts/check.py                    # 跑全部（含单测 + 构建，约 1 分钟）
python scripts/check.py --fast             # 跳过 #slow：语法/文档/git/卫生（几秒）
python scripts/check.py --only docs,#git   # 只跑文档类或 git 类
python scripts/check.py --skip build       # 跳过名字含 build 的
python scripts/check.py --changed           # 只跑「责任路径命中本次改动」的检查（快速自检）
python scripts/check.py --strict            # ⚠️ 提醒也算失败（发版前用）
python scripts/check.py --list              # 看所有检查（名字/标签/级别/来源）
python scripts/check.py --json out.json     # 机器可读报告（CI/存档）
python scripts/check.py -q                  # 只打印失败与提醒
```

退出码：**0** = 无阻塞项，**1** = 有阻塞项（或 `--strict` 下有提醒），**2** = 运行器自身出错（如扩展模块导入失败，报名在最上面）。

---

## 四、写检查的注意事项（踩过的坑）

1. **别用 `import()` 那套捷径去碰应用单例** —— 本项目是 Electron + Vite，检查脚本只在仓库层面工作（跑命令、读文件），需要看运行时请用 `scripts/_cdp-*.mjs` 探针（见 `docs/技术支持/README.md`）。
2. **Windows 上跑 `npm`/`npx` 需要 shell** —— `ctx.run([...])` 已处理（内部走 `list2cmdline` + `shell=True`），别自己再拼字符串。
3. **编码**：子进程输出统一用 `utf-8 + errors="replace"` 解码，中文不会炸；打印中文在 cp936 控制台也安全。
4. **不要留下 `__pycache__`**：运行器已设 `sys.dont_write_bytecode = True`；自己写脚本也建议加。
5. **检查要「快」和「稳」**：语法类必须秒回；耗时或依赖外部状态的（打包、端到端、GUI 冒烟）请加 `slow` 标签或做成 `skipped()`，别让一键检查变成负担。
6. **判据要能解释**：失败时用 `ctx.note()` 打出前因后果（命令输出、命中行号），否则后人只会看到一个 ❌。
7. **Windows 控制台编码**：直接运行时中文与 emoji 正常（Python 走 Win32 控制台 API）；
   若在 **Windows PowerShell 5.1 里管道/重定向**（`| Select-String`）看到乱码，是因为 PS5.1 按 GBK 解码子进程输出 ——
   先 `chcp 65001`（或 `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()`），
   或者直接用 `python scripts/check.py --ascii`（图标与分隔线退化成 ASCII，纯文本日志安全）。
