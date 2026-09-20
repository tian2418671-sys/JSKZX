# -*- coding: utf-8 -*-
"""
AR-13 防线：`App.vue` 里「定义了 ref/computed 但没暴露进 `provide('appCtx')`」的状态检查。

背景（为什么需要机器检查）：
    AR-13（`docs/bugs/BUG-架构与渲染.md`）：新增状态必须**四步齐全** ——
    定义 + `useXxx` 解构 + `ctx return` 暴露 + 子组件 `return` 解构；
    漏掉 ctx 暴露时，子组件模板访问到 `undefined` 而**静默失效**（没有任何报错），
    历史上 `exportGraph` / `graphStats` / `graphBuilding` 都踩过。
    靠人记不住，故做成检查项（方案 §八 8.2，F2 批复：三项自动化全做）。

做法：
    1. 抓出 `const X = ref|computed|shallowRef|reactive(...)` 的定义名；
    2. 抓出 `provide('appCtx', { ... })` 对象正文里出现的全部标识符；
    3. 差集 = 定义了但未暴露的状态；
    4. 与基线（`ctx_exposure_baseline.json`，记录引入本检查**之前**的既有缺失）比对，
       **新增**的未暴露项即疑似回归 → 拦下。

设计取舍：
    · severity = warn（不是 blocker）：App.vue 里大量状态本就只在 setup 内部使用、
      无需暴露；一律阻断会让开发者被迫频繁刷基线。这里给提醒 + 明确指引，
      由人判断"是有意不暴露（则加入基线）还是漏了（则补进 ctx）"。
    · 基线用 JSON 而不是内嵌 python 集合：便于 review diff，也便于手工清理陈旧项。

标签：docs（快，不依赖构建）

AR-31 配套：本检查在**自身失配**时返回 failed 并指出「中间被插入了什么」——
    因为“检查看不见目标文件”等于防线宕机，必须显式可见（不能降级为一条容易被当噪音的提醒）。
"""
import json
import re

from checkkit import Check, failed, ok, skipped, warned

APP_VUE = "js/components/App.vue"
BASELINE = "scripts/pychecks/ctx_exposure_baseline.json"

DEF_RE = re.compile(r"const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|computed|shallowRef|reactive)\(")
# ⚠️ 实际结构是「先建对象、再 provide」：
#     const ctx = { ... };
#     provide('appCtx', ctx);
#   故用 provide('appCtx', ctx); 作为结尾锚点反向定位对象正文（该字符串在 App.vue 内唯一）。
CTX_RE = re.compile(r"const ctx = \{(.*?)\n\s*\};\s*\n\s*provide\('appCtx', ctx\);", re.S)
# AR-31 守卫：宽容版（允许两句之间夹内容）—— 只在 CTX_RE 失配时用来**指出中间插了什么**。
CTX_LOOSE_RE = re.compile(r"const ctx = \{(.*)\n\s*\};(.*)provide\('appCtx', ctx\);", re.S)
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")


def ctx_exposure(ctx):
    if not ctx.exists(APP_VUE):
        return skipped(f"未找到 {APP_VUE}")

    src = ctx.read(APP_VUE)
    defs = set(DEF_RE.findall(src))

    m = CTX_RE.search(src)
    if not m:
        # ⚠️ AR-31（`docs/bugs/BUG-架构与渲染.md`）：本检查靠「`const ctx = {...};` 紧接着
        #    `provide('appCtx', ctx);`」的位置关系定位 ctx 正文。一旦中间被插入代码或**注释**，
        #    正则就失配 —— 此时**必须报失败并给出修法**，绝不能静默通过：
        #    失配 = 「AR-13 防线本身失效」（历史上 P2 实施期真的踩到过）。
        hint = ""
        loose = CTX_LOOSE_RE.search(src)
        if loose:
            between = loose.group(2).strip()
            if between:
                snippet = between if len(between) <= 240 else between[:240] + " …"
                hint = (
                    "\n  ⚠️ AR-31：检测到 `const ctx = {...};` 与 `provide('appCtx', ctx);` **之间被插入了内容**：\n    "
                    + snippet.replace("\n", "\n    ")
                    + "\n  → 本检查依赖这两句**相邻**；请把插入的语句 / 注释移到 `provide(...)` 之后"
                      "（“ctx 就绪之后才能做的事”写到 provide 之后，同步流程内无时序差异）。"
                )
        return failed("未解析到「const ctx = {...}; provide('appCtx', ctx);」结构 —— **AR-13 防线已失效**" + hint)
    exposed = set(IDENT_RE.findall(m.group(1)))

    missing = sorted(defs - exposed)

    if not ctx.exists(BASELINE):
        return warned(f"基线缺失（{BASELINE}）：当前 {len(defs)} 个定义中有 {len(missing)} 项未暴露，无法判定新增项")

    try:
        raw = json.loads(ctx.read(BASELINE))
        baseline = set(raw.get("items") or [])
    except Exception as e:
        return failed(f"{BASELINE} 解析失败：{e}")

    new_missing = [n for n in missing if n not in baseline]
    if new_missing:
        ctx.note(
            "疑似漏暴露到 appCtx 的状态（AR-13）：\n  " + "\n  ".join(new_missing[:40])
            + "\n\n处理：需要给子组件用 → 补进 provide('appCtx', {...})；确属内部使用 → 加入 "
            + BASELINE + " 的 items 并说明原因。"
        )
        return failed(f"{len(new_missing)} 个新增状态未暴露到 appCtx（模板会拿到 undefined 且静默失效）")

    stale = sorted(baseline - set(missing))
    if stale:
        ctx.note(f"基线中已有 {len(stale)} 项不再缺失，可从 {BASELINE} 移除：" + "、".join(stale[:12]))

    return ok(f"{len(defs)} 个状态定义 / {len(missing)} 项未暴露（均在基线内，无新增回归）")


def register(reg):
    reg.add(Check(
        name="架构：ctx 暴露完整性（AR-13 防线）",
        run=ctx_exposure,
        tags=("docs",),
        severity="warn",
        paths=("js/components/App.vue",),
    ))
