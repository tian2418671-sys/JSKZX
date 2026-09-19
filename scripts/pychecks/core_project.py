# -*- coding: utf-8 -*-
"""
内置检查：本项目的健康体检（语法 / 单测 / 构建 / 文档 / 版本 / 卫生）

标签约定（供 --only / --skip / --fast 使用）：
  syntax  语法与格式可解析性（快）
  test    单元测试（#slow）
  build   前端构建（#slow）
  docs    文档链接、版本一致性、对外文件禁词
  git     工作区状态与远端同步
  hygiene 仓库卫生（临时文件 / 缓存目录）
  slow    耗时项（--fast 跳过）
"""

import os
import re

from checkkit import Check, failed, info, ok, skipped, warned

# ─────────────────────────── git ───────────────────────────
def git_status(ctx):
    cp = ctx.git("status", "--porcelain")
    if cp.returncode != 0:
        return skipped("不在 git 仓库或 git 不可用")
    dirty = [ln for ln in (cp.stdout or "").splitlines() if ln.strip()]
    if not dirty:
        return ok("工作区干净")
    ctx.note("未提交文件：\n" + "\n".join(dirty[:30]))
    return warned(f"{len(dirty)} 个未提交文件（发版前建议先提交）")


def git_sync(ctx):
    cp = ctx.git("rev-list", "--count", "origin/master..master")
    if cp.returncode != 0:
        return skipped("拿不到 origin/master（本地仓库或未配置远端）")
    ahead = (cp.stdout or "0").strip() or "0"
    if ahead == "0":
        return ok("与 origin/master 同步")
    return warned(f"本地领先 origin/master {ahead} 个提交（发版记得 push --tags）")


# ───────────────────── 语法可解析性（快） ─────────────────────
def node_syntax(ctx):
    targets = ["main.js", "preload.js", "vite.config.mjs"]
    targets += [f"main/{f}" for f in ctx.listdir("main") if f.endswith(".js")]
    targets += [f for f in ("postcss.config.js", "tailwind.config.js") if ctx.exists(f)]
    bad, done = [], 0
    for rel in targets:
        if not ctx.exists(rel):
            continue
        cp = ctx.node("--check", rel)
        done += 1
        if cp.returncode != 0:
            bad.append(f"{rel}: {ctx.out(cp, 120)}")
    if bad:
        ctx.note("\n".join(bad))
        return failed(f"{len(bad)}/{done} 个文件语法错误")
    return ok(f"{done} 个文件通过")


def py_syntax(ctx):
    import ast

    files = [f for f in ctx.glob("*.py", exclude=()) if f.startswith("scripts/")]
    bad = []
    for rel in files:
        try:
            ast.parse(ctx.read(rel), filename=rel)
        except SyntaxError as exc:
            bad.append(f"{rel}:{exc.lineno}: {exc.msg}")
    if bad:
        ctx.note("\n".join(bad))
        return failed(f"{len(bad)}/{len(files)} 个脚本语法错误")
    return ok(f"{len(files)} 个 Python 脚本通过")


def json_parse(ctx):
    targets = ["package.json"] + ctx.glob("scripts/pychecks/*.json")
    targets = [t for t in targets if ctx.exists(t)]
    bad = []
    for rel in targets:
        try:
            ctx.read_json(rel)
        except Exception as exc:
            bad.append(f"{rel}: {exc}")
    if bad:
        ctx.note("\n".join(bad))
        return failed(f"{len(bad)} 个 JSON 不可解析")
    return ok(f"{len(targets)} 个 JSON 通过")


# ───────────────────── 单测 / 构建（#slow） ─────────────────────
def unit_tests(ctx, check=None):
    cp = ctx.npm("test")
    text = ctx.out(cp)
    ctx.note(text[-1200:])
    clean = re.sub(r"[^\x20-\x7e]+", " ", text)
    passed = int((re.search(r"\bpass\s+(\d+)", clean) or [0, -1])[1]) if re.search(r"\bpass\s+(\d+)", clean) else -1
    failed_n = int((re.search(r"\bfail\s+(\d+)", clean) or [0, -1])[1]) if re.search(r"\bfail\s+(\d+)", clean) else -1
    if passed > 0 and failed_n == 0 and cp.returncode == 0:
        return ok(f"{passed} 例全绿")
    return failed(f"pass={passed} fail={failed_n}（exit {cp.returncode}）")


def web_build(ctx):
    cp = ctx.npm("run", "build:web")
    text = ctx.out(cp)
    ctx.note(text[-1200:])
    if cp.returncode == 0 and re.search(r"built in [\d.]+s", text):
        return ok("构建成功")
    return failed(f"构建失败：{text[-160:]}")


# ─────────────────────────── 文档 ───────────────────────────
def doc_links(ctx):
    cp = ctx.node("scripts/check-doc-links.mjs")
    text = ctx.out(cp)
    ctx.note(text[-800:])
    if cp.returncode == 0 and "ALL RESOLVE" in text:
        m = re.search(r"markdown files\s*:\s*(\d+)", text)
        n = re.search(r"relative links\s*:\s*(\d+)", text)
        tail = f"{m.group(1)} 文件 / {n.group(1)} 链接" if (m and n) else "全部可解析"
        return ok(tail)
    return failed(f"有断链：{text[-160:]}")


def version_consistency(ctx):
    version = ""
    try:
        version = str(ctx.read_json("package.json").get("version", ""))
    except Exception as exc:
        return failed(f"读不到 package.json：{exc}")
    if not version:
        return failed("package.json 没有 version 字段")

    tag = f"v{version}"
    docs = {
        "CHANGELOG.md": "含当前版本段",
        "RELEASE_NOTES.md": "含当前版本段",
        "START-HERE.md": "入口版本号",
        "AI交接指导.md": "交接文档版本号",
    }
    missing = [f"{name}（{what}）" for name, what in docs.items()
               if ctx.exists(name) and tag not in ctx.read(name)]
    notes = []
    if ctx.exists("CHANGELOG.md"):
        unr = ctx.read("CHANGELOG.md").count("未发布")
        if unr:
            notes.append(f"CHANGELOG 还有 {unr} 处「未发布」（发版时归档成版本号）")
    if ctx.exists("dist_new") and os.path.isdir(ctx.path("dist_new")):
        has_exe = any(f"sillytavern-card-manager-{version}.exe" in f for f in ctx.listdir("dist_new"))
        notes.append(f"dist_new {'已有' if has_exe else '还没有'} v{version} 安装包")

    detail = f"package.json = {tag}"
    if notes:
        detail += "｜" + "；".join(notes)
    if missing:
        ctx.note("下列文件里找不到 " + tag + "：\n" + "\n".join(missing))
        return warned(f"{detail}｜缺登记：{'、'.join(missing)}")
    return ok(detail)


# 对外文件（RELEASE_NOTES.md / Release 正文）禁词：内部细节不许外泄
# 规则出处：docs/发布/内部信息.md §四（'\\.js|\\.vue|\\.mjs|\\.ps1|MB|ms|crash\\.log|heap|堆'）
# 例外：面向用户的体积信息（「约 106 MB 完整包」）不算越界
LEAK_PATTERNS = [
    (r"\.(?:js|mjs|cjs|vue|ts|tsx|ps1|py|json|yml|yaml)\b", "文件名/扩展名"),
    (r"crash\.log|heap|堆内存|堆\b", "崩溃/内存内部信息"),
    (r"\bTDZ\b|渲染进程|主进程|\bIPC\b|vite\.config", "实现机制"),
    (r"\d+(?:\.\d+)?\s*(?:ms|毫秒)\b", "耗时数字"),
    (r"\b\d{3,}\s*MB\b", "内存 MB 数字"),
    (r"\b[a-z][A-Za-z0-9_]{2,}\(\)", "函数/方法名"),
    (r"scripts/|dist[_a-z]*/|\bweb/assets\b", "内部目录"),
]


def release_notes_hygiene(ctx):
    """
    只扫**最新版本段**（文件顶部到第二个 `## ` 之前）——
    这一段就是发 Release 时粘进 GitHub 正文的内容（历史段是已公开的旧文，不再追究）。
    """
    target = "RELEASE_NOTES.md"
    if not ctx.exists(target):
        return skipped(f"{target} 不存在")
    lines = ctx.read(target).splitlines()
    end = len(lines)
    for idx, line in enumerate(lines[1:], 1):
        if re.match(r"^## (?!#)", line):
            end = idx
            break
    section = lines[:end]
    title = next((ln.strip(" #") for ln in section if ln.startswith("#")), "(无标题)")
    hits: list[tuple[int, str, str]] = []
    for idx, line in enumerate(section, 1):
        if re.search(r"约\s*\d+(?:\.\d+)?\s*MB|完整包", line):   # 体积信息属允许例外
            continue
        for pattern, label in LEAK_PATTERNS:
            m = re.search(pattern, line)
            if m:
                hits.append((idx, label, m.group(0)))
                break
    if not hits:
        return ok(f"最新段「{title}」无内部细节外泄痕迹（共 {len(section)} 行）")
    shown = "\n".join(f"L{ln}: [{label}] {snip}" for ln, label, snip in hits[:20])
    ctx.note(f"扫描范围：{target} 第 1–{end} 行（最新段「{title}」）\n" + shown +
             (f"\n…共 {len(hits)} 处" if len(hits) > 20 else ""))
    return warned(f"最新段「{title}」{len(hits)} 处疑似内部细节（详见 --verbose；规则见 docs/发布/内部信息.md）")


def script_registry(ctx):
    """新增脚本要登记进 docs/（否则后人找不到它）。只查非 `_` 前缀的正式脚本。"""
    scripts = [os.path.basename(f) for f in ctx.glob("scripts/*")
               if not os.path.basename(f).startswith("_") and f.count("/") == 1]
    docs_text = "\n".join(
        ctx.read(f) for f in ctx.glob("docs/**/*.md") + ["scripts/README.md"]
        if ctx.exists(f) and os.path.getsize(ctx.path(f)) < 400_000
    )
    missing = [s for s in scripts if s not in docs_text]
    if not missing:
        return ok(f"{len(scripts)} 个脚本全部已登记")
    ctx.note("未登记的脚本：\n" + "\n".join(missing[:20]))
    return warned(f"{len(missing)}/{len(scripts)} 个脚本未在 docs/ 里登记")


# ─────────────────────────── 卫生 ───────────────────────────
def repo_hygiene(ctx):
    # ctx.glob 只返回文件（os.walk 的 filenames），所以缓存目录靠 .pyc 残留识别
    pyc = ctx.glob("**/*.pyc")
    junk_files = [f for f in ctx.glob("*") if re.search(r"\.(tmp|orig|rej|swp)$", f)]
    junk_dirs = sorted({os.path.dirname(f) for f in pyc})
    if junk_dirs or junk_files:
        ctx.note("缓存目录：" + (", ".join(junk_dirs) or "无") + "\n临时文件：" + (", ".join(junk_files) or "无"))
        return warned(f"发现 {len(junk_dirs)} 个缓存目录 / {len(junk_files)} 个临时文件")
    return ok("无缓存目录与临时文件残留")


# ─────────────────────────── 注册 ───────────────────────────
def register(reg):
    reg.add_all([
        Check("git：工作区状态", git_status, tags=("git",), severity="warn"),
        Check("git：与远端同步", git_sync, tags=("git",), severity="warn"),

        Check("语法：Node（主进程/预加载/配置）", node_syntax,
              tags=("syntax",), paths=("main.js", "preload.js", "main/**", "*.config.*")),
        Check("语法：Python（scripts/）", py_syntax,
              tags=("syntax",), paths=("scripts/**.py",)),
        Check("语法：JSON 可解析", json_parse,
              tags=("syntax",), paths=("package.json", "scripts/pychecks/*.json")),

        Check("测试：npm test", unit_tests, tags=("test", "slow"), paths=("js/**", "test/**", "main/**")),
        Check("构建：npm run build:web", web_build,
              tags=("build", "slow"), paths=("js/**", "css/**", "index.html", "vite.config.mjs")),

        Check("文档：相对链接", doc_links, tags=("docs",), paths=("docs/**", "*.md")),
        Check("文档：脚本登记齐全", script_registry, tags=("docs",), severity="warn", paths=("scripts/**", "docs/**")),
        Check("文档：版本号一致性", version_consistency,
              tags=("docs",), severity="warn", paths=("package.json", "*.md", "docs/**")),
        Check("文档：对外文件无内部细节", release_notes_hygiene,
              tags=("docs",), severity="warn", paths=("RELEASE_NOTES.md",)),

        Check("卫生：缓存与临时文件", repo_hygiene, tags=("hygiene",), severity="warn"),
    ])


__all__ = ["register"]
