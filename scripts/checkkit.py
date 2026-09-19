# -*- coding: utf-8 -*-
"""
checkkit —— 一键检查框架的核心类型与工具（供 check.py 与 pychecks/*.py 共用）

设计目标：**加一条检查不需要改运行器**。
  · 检查用 `Check` 描述（名字 / 标签 / 严重级别 / 负责的路径 glob）
  · 检查体收到 `Context`，用它跑子进程、读文件、调 git
  · 结果用 `ok()` / `warned()` / `failed()` / `skipped()` / `info()` 返回

扩展方式见 `scripts/pychecks/README.md`；声明式（不写 Python）见同目录的 *.json。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

# ────────────────────────────── 状态 ──────────────────────────────
PASS = "pass"      # 通过
WARN = "warn"      # 提醒（默认不阻塞，--strict 时算失败）
FAIL = "fail"      # 失败（阻塞）
SKIP = "skip"      # 跳过（未满足前置条件，不算失败）
INFO = "info"      # 纯信息（既不阻塞也不计提醒）

STATUS_ICON = {PASS: "✅", WARN: "⚠️ ", FAIL: "❌", SKIP: "⏭️ ", INFO: "ℹ️ "}
STATUS_LABEL = {PASS: "通过", WARN: "提醒", FAIL: "失败", SKIP: "跳过", INFO: "信息"}


@dataclass
class Result:
    """单条检查的结果。detail 会原样打印，尽量一行、可操作。"""

    status: str = PASS
    detail: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def blocking(self) -> bool:
        return self.status == FAIL


def ok(detail: str = "", **extra) -> Result:
    return Result(PASS, detail, extra)


def warned(detail: str = "", **extra) -> Result:
    return Result(WARN, detail, extra)


def failed(detail: str = "", **extra) -> Result:
    return Result(FAIL, detail, extra)


def skipped(detail: str = "", **extra) -> Result:
    return Result(SKIP, detail, extra)


def info(detail: str = "", **extra) -> Result:
    return Result(INFO, detail, extra)


@dataclass
class Check:
    """
    一条检查。

    name      报告里显示的名字（建议「领域：检查点」写法，如「文档：相对链接」）
    run       检查体：`run(ctx) -> Result`（也接受 (status, detail) 元组或 bool）
    tags      标签，用于 --only/--skip 过滤；约定标签见 pychecks/README.md
    severity  'blocker'（失败即退出码 1）| 'warn'（默认只提醒，--strict 升级为失败）
    timeout   单条检查的默认子进程超时（秒）；None 用命令行 --timeout
    paths     责任路径 glob（--changed 时只跑命中改动文件的检查，如 ('js/**', 'js/**/*.vue')）
    source    来源（由运行器填充：模块名或 json 文件名），便于定位扩展
    """

    name: str
    run: Callable[["Context"], object]
    tags: Sequence[str] = ()
    severity: str = "blocker"
    timeout: float | None = None
    paths: Sequence[str] = ()
    source: str = ""

    def __post_init__(self) -> None:
        self.tags = tuple(dict.fromkeys(str(t) for t in (self.tags or ())))
        self.paths = tuple(self.paths or ())
        if self.severity not in ("blocker", "warn"):
            raise ValueError(f"severity 只能是 blocker / warn，收到 {self.severity!r}")

    def normalize(self, value: object) -> Result:
        """把检查体的返回值统一成 Result（容忍 bool / (status, detail) / str / None）。"""
        if isinstance(value, Result):
            return value
        if value is None:
            return ok()
        if isinstance(value, bool):
            return ok() if value else failed()
        if isinstance(value, tuple):
            status, detail = (list(value) + ["", ""])[:2]
            return Result(str(status), str(detail))
        if isinstance(value, str):
            return ok(value)
        raise TypeError(f"检查 {self.name} 返回了不支持的类型：{type(value).__name__}")


class Context:
    """检查体的运行时环境：工作区根、CLI 参数、以及各种现成工具。"""

    def __init__(self, root: str, argv: dict | None = None, default_timeout: float | None = None):
        self.root = os.path.abspath(root)
        self.argv = argv or {}
        self.default_timeout = default_timeout
        self.notes: list[str] = []          # 检查体可 ctx.note("...") 追加细节，--verbose 时打印

    # ── 路径 ─────────────────────────────────────────────
    def path(self, *parts: str) -> str:
        return os.path.join(self.root, *parts)

    def exists(self, rel: str) -> bool:
        return os.path.exists(self.path(rel))

    def read(self, rel: str, default: str | None = None) -> str:
        p = self.path(rel)
        if not os.path.exists(p):
            if default is not None:
                return default
            raise FileNotFoundError(rel)
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def read_json(self, rel: str):
        return json.loads(self.read(rel))

    def listdir(self, rel: str = ".") -> list[str]:
        p = self.path(rel)
        return sorted(os.listdir(p)) if os.path.isdir(p) else []

    def glob(self, pattern: str, exclude: Sequence[str] = ()) -> list[str]:
        """仓库内的 glob（返回相对路径，正斜杠；自动跳过 .git / node_modules / dist 等）"""
        import fnmatch

        skip_dirs = {".git", "node_modules", "web", "dist", "dist_new", ".venv", "__pycache__"}
        out: list[str] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]
            for name in filenames:
                rel = os.path.relpath(os.path.join(dirpath, name), self.root).replace("\\", "/")
                if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(name, pattern):
                    if any(fnmatch.fnmatch(rel, ex) for ex in exclude):
                        continue
                    out.append(rel)
        return sorted(out)

    def note(self, text: str) -> None:
        """记录一行细节（只在 --verbose 或该检查失败时打印）。"""
        self.notes.append(text)

    # ── 子进程 ───────────────────────────────────────────
    def run(
        self,
        args: str | Sequence[str],
        cwd: str | None = None,
        timeout: float | None = None,
        env: dict | None = None,
        check: Check | None = None,
    ) -> subprocess.CompletedProcess:
        """
        跑一条命令（Windows 下用 shell 以便解析 npm/npx.cmd）。
        返回 CompletedProcess，`stdout`/`stderr` 已是文本（utf-8 + replace，避免中文炸编码）。
        """
        limit = timeout or (check.timeout if check else None) or self.default_timeout
        if isinstance(args, str):
            cmd: str | list[str] = args
            use_shell = True
        else:
            use_shell = os.name == "nt"
            cmd = subprocess.list2cmdline(list(args)) if use_shell else list(args)
        merged_env = {**os.environ, **(env or {})}
        try:
            cp = subprocess.run(
                cmd,
                cwd=cwd or self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=limit,
                shell=use_shell,
                env=merged_env,
            )
            return cp
        except subprocess.TimeoutExpired as exc:
            cp = subprocess.CompletedProcess(cmd, 124, exc.stdout or "", f"命令超时（>{limit}s）")
            return cp

    def out(self, cp: subprocess.CompletedProcess, limit: int = 0) -> str:
        """stdout+stderr 合并文本；limit>0 时截断到末尾 limit 字符（报错时常用）。"""
        text = ((cp.stdout or "") + "\n" + (cp.stderr or "")).strip()
        if limit and len(text) > limit:
            text = "…" + text[-limit:]
        return text

    def node(self, *args: str, **kw) -> subprocess.CompletedProcess:
        return self.run(["node", *args], **kw)

    def npm(self, *args: str, **kw) -> subprocess.CompletedProcess:
        return self.run(["npm", *args], **kw)

    def git(self, *args: str, **kw) -> subprocess.CompletedProcess:
        return self.run(["git", *args], **kw)

    def has(self, prog: str) -> bool:
        return shutil.which(prog) is not None


class Registry:
    """检查注册表：扩展模块通过 `reg.add(Check(...))` 登记。"""

    def __init__(self) -> None:
        self._checks: list[Check] = []

    def add(self, check: Check) -> None:
        if not isinstance(check, Check):
            raise TypeError(f"reg.add() 只接受 Check，收到 {type(check).__name__}")
        self._checks.append(check)

    def add_all(self, checks: Iterable[Check]) -> None:
        for c in checks:
            self.add(c)

    @property
    def checks(self) -> list[Check]:
        return list(self._checks)


def parse_patterns(raw: str | None) -> list[str]:
    """`--only docs,#git` → ['docs', '#git']（小写化，去空）"""
    if not raw:
        return []
    return [p.strip().lower() for p in str(raw).split(",") if p.strip()]


def matches(check: Check, patterns: Sequence[str]) -> bool:
    """名字子串 / #标签 / 来源模块 三种匹配方式。"""
    name = check.name.lower()
    tags = {t.lower() for t in check.tags}
    source = (check.source or "").lower()
    for pat in patterns:
        if pat.startswith("#"):
            if pat[1:] in tags:
                return True
        elif pat in name or pat in source or pat in tags:
            return True
    return False


def python_version() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
