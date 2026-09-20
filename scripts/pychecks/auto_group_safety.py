# -*- coding: utf-8 -*-
"""
🗂️ 自动分组（S1~S4）静态防线 —— 把方案 §3.10 / §4.2 的两条铁律变成机器检查。

背景（为什么需要机器检查）：
    1. **物理移动唯一原语**：卡片移动必须走 `useCardGroups.moveCardToGroup`，
       它负责迁移三类「按 path 派生」的键（覆盖层 / 测卡会话与变量树 / 长期记忆）。
       绕过它另写 `fs.rename` / `electronAPI.moveCardToGroup` = **静默丢失用户数据**
       —— 历史上 AR 族踩过多次。**自动分组的回滚路径同样是移动，必须一并受限**（方案 §4.2）。
    2. **判定层纯函数性**：`js/utils/autoGroup.js` 只产出「计划」，不许碰 window / electronAPI / fs
       —— 它保证「预览与执行同源」（同一输入同一输出）且可单测（方案 §六 验收 1）。

标签：docs（快，不依赖构建）

维护提示：
    · 合法位置只允许 `js/composables/useCardGroups.js`（原语所在文件）；
      若将来新增**原语级**封装，请把它加入 `ALLOWED_MOVE_FILES` 并说明理由。
    · 本检查只看「活代码」，会剥离块注释 / HTML 注释 / 整行 `//` 注释（防注释里的示例误报）。
"""
import re

from checkkit import Check, failed, ok, skipped

PRIMITIVE = "js/composables/useCardGroups.js"
PURE_LAYERS = ("js/utils/autoGroup.js", "js/utils/autoGroupLLM.js")  # 判定层（含 🤖 LLM 判定层，S-LLM）
PURE_LAYER = PURE_LAYERS[0]  # 兼容旧引用
LLM_CALLER = "js/composables/useAutoGroup.js"  # LLM 调用的唯一合法位置（编排层）

# 只允许出现 electronAPI.moveCardToGroup 的文件（原语文件本身）
ALLOWED_MOVE_FILES = (PRIMITIVE,)

MOVE_CALL_RE = re.compile(r"electronAPI\s*\.\s*moveCardToGroup")
IMPURE_RE = re.compile(r"electronAPI|window\.|require\(['\"]fs|fs\.promises")


def strip_comments(text: str) -> str:
    """剥离块注释（/* */ 与 <!-- -->）与整行 // 注释；保留行内尾部注释（对本检查无影响）。"""
    out = []
    in_block_c = False
    in_block_html = False
    for line in str(text).splitlines():
        s = line
        if in_block_c:
            if "*/" in s:
                s = s.split("*/", 1)[1]
                in_block_c = False
            else:
                out.append("")
                continue
        if in_block_html:
            if "-->" in s:
                s = s.split("-->", 1)[1]
                in_block_html = False
            else:
                out.append("")
                continue
        # 行内可能先开块注释
        while True:
            i_c = s.find("/*")
            i_h = s.find("<!--")
            starts = [i for i in (i_c, i_h) if i >= 0]
            if not starts:
                break
            i = min(starts)
            head = s[:i]
            if i == i_c:
                tail = s[i + 2:]
                if "*/" in tail:
                    s = head + tail.split("*/", 1)[1]
                    continue
                s = head
                in_block_c = True
                break
            else:
                tail = s[i + 4:]
                if "-->" in tail:
                    s = head + tail.split("-->", 1)[1]
                    continue
                s = head
                in_block_html = True
                break
        out.append(s if s.lstrip().startswith("//") is False else "")
    return "\n".join(out)


def _scan(ctx, paths, pattern):
    hits = []
    for path in paths:
        try:
            text = strip_comments(ctx.read(path))
        except Exception:
            continue
        for ln, raw in enumerate(text.splitlines(), 1):
            if pattern.search(raw):
                hits.append((path.replace("\\", "/"), ln, raw.strip()[:160]))
    return hits


def move_primitive_only(ctx):
    if not ctx.exists(PRIMITIVE):
        return skipped(f"未找到 {PRIMITIVE}")
    paths = sorted(set(ctx.glob("js/**/*.js")) | set(ctx.glob("js/**/*.vue")))
    hits = _scan(ctx, paths, MOVE_CALL_RE)
    primitive_hits = [h for h in hits if h[0] in [p.replace("\\", "/") for p in ALLOWED_MOVE_FILES]]
    offenders = [h for h in hits if h not in primitive_hits]

    if not primitive_hits:
        return failed(
            f"`{PRIMITIVE}` 里找不到 electronAPI.moveCardToGroup 调用 —— 唯一移动原语可能被改掉/丢失，"
            "请人工确认（绕过它的移动会静默丢失 覆盖层 / 测卡会话 / 记忆）"
        )
    if offenders:
        ctx.note(
            "疑似绕过唯一移动原语的调用（**自动分组回滚路径也在本检查范围内**；"
            "绕过 = 三类按 path 派生键静默丢失）：\n  "
            + "\n  ".join(f"{p}:{ln}  {code}" for p, ln, code in offenders[:30])
            + f"\n\n处理：在调用方注入并调用 `useCardGroups.moveCardToGroup(item, targetGroup)`；"
              f"确需新原语请加入 `scripts/pychecks/auto_group_safety.py` 的白名单并说明理由。"
        )
        return failed(f"{len(offenders)} 处直接调用 electronAPI.moveCardToGroup（唯一合法位置：{PRIMITIVE}）")
    return ok(
        f"唯一移动原语完好（{PRIMITIVE} 内 {len(primitive_hits)} 处调用；"
        f"全 js/** 无绕过 —— 含自动分组/回滚路径）"
    )


def pure_judgement_layer(ctx):
    existing = [p for p in PURE_LAYERS if ctx.exists(p)]
    if not existing:
        return skipped(f"未找到判定层文件（{' / '.join(PURE_LAYERS)}）")
    hits = _scan(ctx, existing, IMPURE_RE)
    if hits:
        ctx.note(
            "判定层必须保持纯函数（可单测、预览/执行同源）：不得访问 window / electronAPI / fs。\n  "
            + "\n  ".join(f"{p}:{ln}  {code}" for p, ln, code in hits[:20])
        )
        return failed(f"{len(hits)} 处副作用引用出现在判定层（{' / '.join(existing)}）")
    return ok("判定层保持纯函数（含 🤖 LLM 判定层：无 window / electronAPI / fs 引用）")


def llm_via_ipc_channel(ctx):
    """🤖 LLM 调用通道（S-LLM）：必须走 electronAPI.sendChatMessage（主进程转发）；
    渲染层直接 fetch 会被 CORS 拦（与 useAITools 同口径）。"""
    if not ctx.exists(LLM_CALLER):
        return skipped(f"未找到 {LLM_CALLER}")
    text = strip_comments(ctx.read(LLM_CALLER))
    if "sendChatMessage" not in text:
        return failed(
            f"{LLM_CALLER} 未发现 sendChatMessage —— LLM 调用必须走统一 IPC 通道"
            "（渲染层直接 fetch 会被 CORS 拦）"
        )
    hits = []
    for ln, raw in enumerate(text.splitlines(), 1):
        if re.search(r"\bfetch\s*\(", raw):
            hits.append((LLM_CALLER, ln, raw.strip()[:160]))
    if hits:
        ctx.note("编排层出现了直接 fetch（应改用 sendChatMessage）：\n  " + "\n  ".join(f"{p}:{ln}  {code}" for p, ln, code in hits[:10]))
        return failed(f"{len(hits)} 处渲染层直接 fetch（LLM 调用必须走统一通道）")
    return ok("LLM 调用统一走 sendChatMessage IPC 通道（无渲染层直接 fetch）")


def register(reg):
    reg.add(Check(
        name="架构：物理移动唯一原语（含回滚路径，防绕过键迁移）",
        run=move_primitive_only,
        tags=("docs",),
        severity="blocker",
        paths=("js/**",),
    ))
    reg.add(Check(
        name="架构：自动分组判定层纯函数性",
        run=pure_judgement_layer,
        tags=("docs",),
        severity="warn",
        paths=PURE_LAYERS,
    ))
    reg.add(Check(
        name="架构：LLM 判定调用走统一 IPC 通道",
        run=llm_via_ipc_channel,
        tags=("docs",),
        severity="warn",
        paths=(LLM_CALLER,),
    ))
