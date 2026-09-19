#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🧪 JSK管理 · 一键项目检查（可扩展）

一条命令跑完「这份代码/文档现在健康吗」：语法、单测、构建、文档、版本、卫生……
检查项全部放在 `scripts/pychecks/` 里，**加检查不用改本文件**：

  · Python 检查：新建 `scripts/pychecks/<名字>.py`，实现 `register(reg)` 或 `CHECKS = [...]`
  · 免代码检查：往 `scripts/pychecks/*.json` 里加一条命令式检查（{name, cmd, tags...}）
  · 摸不着头脑：`python scripts/check.py --new my_check` 直接生成模板

常用用法：
  python scripts/check.py                     # 跑全部检查（含单测与构建）
  python scripts/check.py --fast              # 跳过耗时项（#slow：单测/构建）
  python scripts/check.py --only docs,#git    # 只跑名字含 docs 或标签为 git 的检查
  python scripts/check.py --skip build --strict
  python scripts/check.py --changed           # 只跑「责任路径命中本次改动」的检查
  python scripts/check.py --list              # 列出所有检查（名字/标签/级别/来源）
  python scripts/check.py --json out.json     # 机器可读报告（CI 用）

退出码：0 = 无阻塞项；1 = 有阻塞项（❌）；2 = 运行器自身出错（如检查模块导入失败）。
"""

from __future__ import annotations

import argparse
import fnmatch
import importlib.util
import json
import os
import sys
import time
import traceback

sys.dont_write_bytecode = True  # 跑检查不留下 __pycache__（仓库卫生检查会因此更干净）

# Windows 控制台默认 GBK：管道输出（CI / | Select-Object）时 emoji 会直接 UnicodeEncodeError，
# 所以先把 stdout/stderr 钉死成 UTF-8（失败也不影响运行，errors=replace 兜底）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS_DIR)
PKG_DIR = os.path.join(SCRIPTS_DIR, "pychecks")
sys.path.insert(0, SCRIPTS_DIR)  # 让扩展模块可以直接 `from checkkit import ...`

from checkkit import (  # noqa: E402  （必须在 sys.path 调整之后）
    FAIL,
    INFO,
    PASS,
    SKIP,
    STATUS_ICON,
    STATUS_LABEL,
    WARN,
    Check,
    Context,
    Registry,
    matches,
    parse_patterns,
    python_version,
)

# ────────────────────────────── 输出 ──────────────────────────────
USE_COLOR = True
ASCII_MODE = False          # --ascii：把 emoji / 制表符换成 ASCII（Windows PowerShell 5.1 管道、纯文本 CI 日志用）
COLORS = {
    PASS: "\033[32m", WARN: "\033[33m", FAIL: "\033[31m",
    SKIP: "\033[90m", INFO: "\033[36m", "reset": "\033[0m", "bold": "\033[1m", "dim": "\033[2m",
}
ASCII_ICON = {PASS: "[ OK ]", WARN: "[WARN]", FAIL: "[FAIL]", SKIP: "[SKIP]", INFO: "[INFO]"}


def status_icon(status: str) -> str:
    return ASCII_ICON.get(status, "[???]") if ASCII_MODE else STATUS_ICON.get(status, "?")


def sym(unicode_char: str, ascii_text: str) -> str:
    return ascii_text if ASCII_MODE else unicode_char


def paint(text: str, color: str) -> str:
    if not USE_COLOR:
        return text
    return f"{COLORS.get(color, '')}{text}{COLORS['reset']}"


def hr(width: int = 78) -> str:
    return sym("─", "-") * width


# ────────────────────────────── 发现检查 ──────────────────────────────
def load_python_module(path: str, source_label: str, reg: Registry) -> list[str]:
    """加载一个扩展模块，调用它的 register(reg) 或读取它的 CHECKS 列表。"""
    errors: list[str] = []
    name = os.path.splitext(os.path.basename(path))[0]
    try:
        spec = importlib.util.spec_from_file_location(f"pychecks_{name}", path)
        module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except Exception:
        errors.append(f"{source_label} 导入失败：{traceback.format_exc(limit=1).strip().splitlines()[-1]}")
        return errors

    before = len(reg.checks)
    try:
        if hasattr(module, "register"):
            module.register(reg)
        elif hasattr(module, "CHECKS"):
            reg.add_all(module.CHECKS)
        else:
            errors.append(f"{source_label} 既没有 register(reg) 也没有 CHECKS —— 已跳过")
            return errors
    except Exception:
        errors.append(f"{source_label} 注册检查时出错：{traceback.format_exc(limit=1).strip().splitlines()[-1]}")
        return errors

    for check in reg.checks[before:]:
        if not check.source:
            check.source = source_label
    return errors


def load_command_checks(path: str, source_label: str, reg: Registry) -> list[str]:
    """
    声明式检查（无需写 Python）：pychecks/*.json
    {
      "checks": [
        {
          "name": "xx 检查", "cmd": ["node", "scripts/xx.mjs"],
          "tags": ["docs"], "severity": "blocker", "timeout": 120,
          "expect_exit": 0,              // 默认 0
          "ok_pattern": "ALL RESOLVE",   // 输出含它才算过（可选）
          "fail_pattern": "FAIL",        // 输出含它就判失败（可选）
          "detail_from_last_line": true  // 用最后一行当 detail（默认 true）
        }
      ]
    }
    """
    errors: list[str] = []
    try:
        data = json.loads(open(path, "r", encoding="utf-8").read())
    except Exception as exc:
        errors.append(f"{source_label} 不是合法 JSON：{exc}")
        return errors

    for item in data.get("checks", []):
        name = str(item.get("name") or "").strip()
        cmd = item.get("cmd")
        if not name or not cmd:
            errors.append(f"{source_label} 有一条检查缺 name/cmd，已跳过")
            continue
        expect_exit = int(item.get("expect_exit", 0))
        ok_pattern = item.get("ok_pattern") or ""
        fail_pattern = item.get("fail_pattern") or ""
        last_line = bool(item.get("detail_from_last_line", True))
        pretty = item.get("detail") or ""

        def runner(ctx, _cmd=cmd, _expect=expect_exit, _ok=ok_pattern, _fail=fail_pattern,
                   _last=last_line, _pretty=pretty, _name=name):
            cp = ctx.run(_cmd)
            text = ctx.out(cp)
            ctx.note(text[-2000:] if text else "(无输出)")
            if _fail and _fail in text:
                return FAIL, f"命中失败特征「{_fail}」"
            if cp.returncode != _expect:
                return FAIL, f"退出码 {cp.returncode}（期望 {_expect}）：{text[-160:]}"
            if _ok and _ok not in text:
                return FAIL, f"输出里找不到「{_ok}」：{text[-160:]}"
            detail = _pretty
            if not detail and _last and text:
                detail = text.strip().splitlines()[-1][:160]
            return PASS, detail

        reg.add(Check(
            name=name,
            run=runner,
            tags=tuple(item.get("tags", []) or []),
            severity=str(item.get("severity", "blocker")),
            timeout=float(item["timeout"]) if item.get("timeout") else None,
            paths=tuple(item.get("paths", []) or []),
            source=source_label,
        ))
    return errors


def discover(reg: Registry) -> list[str]:
    errors: list[str] = []
    if not os.path.isdir(PKG_DIR):
        return [f"找不到检查目录：{PKG_DIR}"]
    for entry in sorted(os.listdir(PKG_DIR)):
        full = os.path.join(PKG_DIR, entry)
        if entry.startswith("_") or entry.startswith("."):
            continue
        if entry.endswith(".py"):
            errors += load_python_module(full, f"pychecks/{entry}", reg)
        elif entry.endswith(".json"):
            errors += load_command_checks(full, f"pychecks/{entry}", reg)
    return errors


# ────────────────────────────── 过滤 ──────────────────────────────
def changed_files(ctx: Context) -> list[str]:
    """本次改动文件（已暂存 + 未暂存 + 未跟踪），用于 --changed 过滤。"""
    cp = ctx.git("status", "--porcelain")
    files: list[str] = []
    for line in (cp.stdout or "").splitlines():
        if not line.strip():
            continue
        path = line[3:].strip().strip('"')
        if " -> " in path:  # 重命名：取新路径
            path = path.split(" -> ", 1)[1]
        files.append(path.replace("\\", "/"))
    return files


def filter_checks(checks: list[Check], only: list[str], skip: list[str],
                  fast: bool, strict_tags: list[str], files: list[str]) -> list[Check]:
    picked = []
    for check in checks:
        if only and not matches(check, only):
            continue
        if skip and matches(check, skip):
            continue
        if fast and "slow" in check.tags:
            continue
        if any(t in check.tags for t in strict_tags):
            continue
        if files is not None:  # --changed
            hit = not check.paths  # 没声明路径 = 每次都跑（如 git/版本一致性）
            for pat in check.paths:
                if any(fnmatch.fnmatch(f, pat) for f in files):
                    hit = True
                    break
            if not hit:
                continue
        picked.append(check)
    return picked


# ────────────────────────────── 执行 ──────────────────────────────
def run_checks(checks: list[Check], ctx: Context, verbose: bool) -> list[dict]:
    records: list[dict] = []
    total = len(checks)
    for idx, check in enumerate(checks, 1):
        ctx.notes = []
        started = time.perf_counter()
        try:
            raw = check.run(ctx)
            result = check.normalize(raw)
        except Exception:
            from checkkit import Result

            tb = traceback.format_exc(limit=2).strip().splitlines()[-1]
            result = Result(FAIL, f"检查体抛异常：{tb}")
        cost = time.perf_counter() - started

        status = result.status
        icon = status_icon(status)
        head = f"[{idx}/{total}] {check.name}"
        line = f"{icon} {head.ljust(46)} {cost:6.2f}s  {result.detail}"
        print(line, flush=True)
        if verbose or status == FAIL:
            for note in ctx.notes:
                for sub in str(note).splitlines()[:40]:
                    print(f"      {paint(sym('│ ', '| ') + sub, 'dim')}", flush=True)
        records.append({
            "name": check.name, "status": status, "detail": result.detail,
            "seconds": round(cost, 3), "tags": list(check.tags),
            "severity": check.severity, "source": check.source,
            "notes": [str(n) for n in ctx.notes][-8:],
        })
    return records


def print_list(checks: list[Check]) -> None:
    print(f"\n{sym('🧪', '[*]')} 可用检查（{len(checks)} 条，来源：scripts/pychecks/）\n")
    for check in checks:
        tags = ",".join(check.tags) or "-"
        sev = "阻塞" if check.severity == "blocker" else "提醒"
        print(f"  · {check.name.ljust(34)} [{tags}] {sev}  ← {check.source}")
    print("\n过滤：--only 名字子串,#标签   --skip ...   --fast（跳过 #slow）   --changed（只跑命中改动的）\n")


def scaffold(name: str) -> int:
    """生成一个扩展检查模板（--new）。"""
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in name).strip("_") or "my_check"
    target = os.path.join(PKG_DIR, f"{safe}.py")
    if os.path.exists(target):
        print(f"❌ 已存在：{os.path.relpath(target, ROOT)}")
        return 2
    os.makedirs(PKG_DIR, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        f.write(TEMPLATE.format(name=safe))
    rel = os.path.relpath(target, ROOT).replace("\\", "/")
    print(f"✅ 已生成扩展检查模板：{rel}")
    print("   1) 在 check_impl(ctx) 里写你的判断，返回 ok()/warned()/failed()")
    print("   2) python scripts/check.py --only " + safe)
    return 0


TEMPLATE = '''# -*- coding: utf-8 -*-
"""自定义检查：{name}（由 `python scripts/check.py --new` 生成）"""

from checkkit import Check, ok, warned, failed, skipped


def check_impl(ctx):
    """返回 ok()/warned()/failed()/skipped()；也可返回 bool 或 (status, detail)。"""
    # 常用工具：
    #   ctx.read("package.json") / ctx.read_json("package.json")
    #   ctx.glob("js/**/*.vue") / ctx.exists("web/index.html")
    #   cp = ctx.run(["node", "--check", "main.js"]); text = ctx.out(cp, 400)
    #   ctx.note("细节行，失败或 --verbose 时打印")
    if not ctx.exists("package.json"):
        return skipped("不是本仓库根目录")
    return ok("示例检查通过")


def register(reg):
    reg.add(Check(
        name="示例：{name}",
        run=check_impl,
        tags=("custom",),
        severity="warn",          # warn = 只提醒；blocker = 失败即退出码 1
        # paths=("js/**",),       # 声明责任路径后可用于 --changed
    ))
'''


# ────────────────────────────── 入口 ──────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="check.py",
        description="JSK管理 一键项目检查（可扩展：scripts/pychecks/）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：python scripts/check.py --fast --only docs   /   python scripts/check.py --new my_check",
    )
    p.add_argument("--root", default=ROOT, help="仓库根目录（默认：本脚本的上一级）")
    p.add_argument("--only", default="", help="只跑匹配项：名字子串 或 #标签，逗号分隔")
    p.add_argument("--skip", default="", help="跳过匹配项：名字子串 或 #标签，逗号分隔")
    p.add_argument("--fast", action="store_true", help="跳过 #slow（单测 / 构建等耗时项）")
    p.add_argument("--changed", action="store_true", help="只跑「责任路径命中本次改动」的检查")
    p.add_argument("--strict", action="store_true", help="把 ⚠️ 提醒也算失败（退出码 1）")
    p.add_argument("--json", dest="json_path", default="", help="把报告写到 JSON 文件（CI 用）")
    p.add_argument("--timeout", type=float, default=600.0, help="单条检查的子进程超时秒数（默认 600）")
    p.add_argument("--list", action="store_true", help="列出全部检查后退出")
    p.add_argument("--new", default="", help="生成一个扩展检查模板（scripts/pychecks/<名字>.py）")
    p.add_argument("--verbose", "-v", action="store_true", help="打印每条检查的细节输出")
    p.add_argument("--quiet", "-q", action="store_true", help="只打印失败/提醒与汇总")
    p.add_argument("--no-color", action="store_true", help="关闭 ANSI 颜色")
    p.add_argument("--ascii", action="store_true", help="用 ASCII 图标/分隔线（老控制台、纯文本 CI 日志；也可设 CHECK_ASCII=1）")
    return p


def main(argv: list[str] | None = None) -> int:
    global USE_COLOR, ASCII_MODE
    args = build_parser().parse_args(argv)
    argv_map = vars(args)

    ASCII_MODE = bool(args.ascii) or os.environ.get("CHECK_ASCII") == "1"
    if args.no_color or not sys.stdout.isatty() or ASCII_MODE:
        USE_COLOR = False
    if args.new:
        return scaffold(args.new)

    reg = Registry()
    load_errors = discover(reg)
    checks = sorted(reg.checks, key=lambda c: (c.source, c.name))

    if load_errors:
        print(paint("⚠️ 扩展加载有问题：", "warn"))
        for err in load_errors:
            print("   " + err)

    if args.list:
        print_list(checks)
        return 0

    ctx = Context(ROOT, argv_map, default_timeout=args.timeout)
    files = changed_files(ctx) if args.changed else None
    picked = filter_checks(
        checks,
        only=parse_patterns(args.only),
        skip=parse_patterns(args.skip),
        fast=args.fast,
        strict_tags=["slow"] if args.fast else [],
        files=files,
    )

    print()
    print(paint(sym("🧪 ", "[*] ") + "JSK管理 · 一键检查", "bold"),
          paint(f"  root={os.path.basename(ROOT)}  Python {python_version()}", "dim"))
    scope = []
    if args.only:
        scope.append(f"only={args.only}")
    if args.skip:
        scope.append(f"skip={args.skip}")
    if args.fast:
        scope.append("fast")
    if args.changed:
        scope.append(f"changed={len(files or [])} 个文件")
    if scope:
        print(paint("   过滤：" + "  ".join(scope), "dim"))
    print(hr())

    if not picked:
        print(paint("⚠️ 没有匹配的检查（检查名/标签是否写对？用 --list 查看）", "warn"))
        return 0

    started = time.perf_counter()
    records = [] if args.quiet else None
    if args.quiet:
        # 静默模式：仍然要跑，但只打印非通过项
        import io
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with redirect_stdout(buf):
            records = run_checks(picked, ctx, args.verbose)
        for line in buf.getvalue().splitlines():
            if any(tag in line for tag in ("[FAIL]", "[WARN]", "[SKIP]")) or "❌" in line or "⚠" in line or "⏭" in line:
                print(line)
    else:
        records = run_checks(picked, ctx, args.verbose)
    elapsed = time.perf_counter() - started

    counts = {PASS: 0, WARN: 0, FAIL: 0, SKIP: 0, INFO: 0}
    blocked = 0
    for rec in records:
        counts[rec["status"]] = counts.get(rec["status"], 0) + 1
        if rec["status"] == FAIL and rec["severity"] == "blocker":
            blocked += 1
        elif args.strict and rec["status"] in (FAIL, WARN):
            blocked += 1

    print(hr())
    summary = (f"{status_icon(PASS)} 通过 {counts[PASS]} · {status_icon(WARN)}提醒 {counts[WARN]} · "
               f"{status_icon(FAIL)}失败 {counts[FAIL]} · {status_icon(SKIP)}跳过 {counts[SKIP]}")
    if counts[INFO]:
        summary += f" · {status_icon(INFO)}信息 {counts[INFO]}"
    summary += f" · 用时 {elapsed:.1f}s"
    print(summary)
    if blocked == 0:
        print(paint(sym("✅ ", "[OK] ") + "无阻塞项" + ("（--strict 下提醒也算阻塞）" if args.strict else ""), "pass"))
    else:
        print(paint(sym("❌ ", "[FAIL] ") + f"有 {blocked} 项阻塞，先修再继续", "fail"))
    if args.json_path:
        report = {
            "root": ROOT, "when": time.strftime("%Y-%m-%d %H:%M:%S"),
            "elapsed_s": round(elapsed, 2), "counts": counts, "blocked": blocked,
            "checks": records,
        }
        with open(args.json_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(paint(sym("🧾 ", "[report] ") + f"报告已写入 {args.json_path}", "dim"))

    return 0 if blocked == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已中断")
        raise SystemExit(130)
