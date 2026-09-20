# -*- coding: utf-8 -*-
"""
命令注册表静态守护（P2-2 配套 · F2 批复「三项全做」）。

背景（为什么需要机器检查）：
    P2 把菜单 / 工具栏 / 快捷键 / 命令面板全部收敛到 `js/composables/useCommands.js` 的注册表。
    注册表在**运行时**会拒绝「id 重复」与「快捷键冲突」（见 `js/utils/commandRegistry.js`），
    但运行时拒绝的表现是 **静默少一条命令**（只有 console.warn），用户看不见、CI 也不会红 ——
    正是 AR-13 那类「静默失效」的体感。故本检查在**静态**层面提前拦住三类问题：

      ① 命令 id 重复            → 后注册者被丢弃，菜单里凭空少一项
      ② 快捷键冲突（归一化后）  → 后注册者被丢弃，按键无反应
      ③ 引用不存在              → `runCommand('xxx')` 指向未注册 id（点了没反应）；
                                  `commandsByMenu.yyy` / `for (const key of [...])` 指向没有任何命令的菜单键

为什么用正则而不是引入 JS 解析器：
    命令定义是**声明式对象字面量**、字段形态由本仓库自己约定，正则足够且零依赖（可在 `--fast` 下跑）。
    代价是「文件结构大改时正则会失配」—— 故解析到的条数过少时直接 `warned` 提示更新正则，
    而不是静默通过（宁可吵，不可漏）。

标签：docs（快，不依赖构建）
"""
import re

from checkkit import Check, failed, ok, skipped, warned

COMMANDS_JS = "js/composables/useCommands.js"

# 命令块：以「8 空格缩进的 `{` + 换行 + `id:`」开头，以「8 空格缩进的 `}`」结尾。
# ⚠️ 结尾用 `(?:,|(?=\n\s*\]))`：最后一条命令的 `}` **后面没有逗号**（直接接 `]);`），
#    只写 `\},` 会漏掉最后一条 → 把它误判成「未注册」（实测踩过）。
CMD_RE = re.compile(r"\n {8}\{\s*\n\s*id:\s*'([^']+)',(.*?)\n {8}\}(?:,|(?=\n\s*\]))", re.S)

SHORTCUT_RE = re.compile(r"shortcut:\s*'([^']+)'")
MENU_STR_RE = re.compile(r"menu:\s*'([^']+)'")
MENU_ARR_RE = re.compile(r"menu:\s*\[([^\]]*)\]")
STR_IN_ARR_RE = re.compile(r"'([^']*)'")

# 引用侧（HeaderBar 等组件）
RUN_CMD_RE = re.compile(r"runCommand\(\s*'([^']+)'\s*\)")
MENU_REF_RE = re.compile(r"commandsByMenu(?:\.([A-Za-z_$][\w$]*)|\[\s*'([^']+)'\s*\])")
MENU_KEYS_RE = re.compile(r"for\s*\(\s*const\s+key\s+of\s*\[([^\]]*)\]")

# ---- 命令里对 ctx 字段的引用（第二个检查项用）----
APP_VUE = "js/components/App.vue"
# ctx 对象正文定位：与 `ctx_exposure.py` 同款正则（依赖 `const ctx = {...};` 与 `provide('appCtx', ctx);` **相邻**，
# 插东西会失配 —— 即 AR-31，故这里解析不到时只给提醒，由 ctx_exposure.py 去报失败）。
CTX_RE = re.compile(r"const ctx = \{(.*?)\n\s*\};\s*\n\s*provide\('appCtx', ctx\);", re.S)
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
CTX_REF_RE = re.compile(r"\bctx\.([A-Za-z_$][\w$]*)")

# 与 js/utils/commandRegistry.js 的 MOD_ORDER 对齐（修饰键归一化顺序）
MOD_ORDER = {"ctrl": 0, "alt": 1, "shift": 2, "meta": 3}

# 目前实际条数（47 上下）；低于阈值说明正则与文件结构脱节
MIN_EXPECTED_COMMANDS = 20


def normalize_shortcut(raw):
    """与 `commandRegistry.js` 的 `normalizeShortcut` 对齐：小写 + 修饰键固定顺序。"""
    parts = [p.strip() for p in str(raw or "").lower().split("+") if p.strip()]
    if not parts:
        return ""
    mods = sorted([p for p in parts if p in MOD_ORDER], key=lambda p: MOD_ORDER[p])
    keys = [p for p in parts if p not in MOD_ORDER]
    return "+".join(mods + keys)


def strip_comment_lines(text):
    """去掉**纯注释行**（`//`、`*`、`/*`）与 **HTML/Vue 注释块**（`<!-- ... -->`，可跨行）。

    为什么需要：
      · 注释里会出现示例代码，如 HeaderBar 里「（按钮的 @click 调用 runCommand('settings.xxx')）」；
      · 更常见的是**注释掉暂时下线的功能**（如 2026-09-20 下线的全局资产库 —— `HeaderBar.vue` 的按钮
        被 `<!-- -->` 包起来）。
      若不剥离，检查会报「引用了未注册的命令 id」假阳性（两种情况实测都踩过）。
    ⚠️ 行内注释（代码后再写 // 或 <!-- -->）也会被剥离 —— 本检查只看“活代码”。
    """
    out = []
    in_html_block = False
    for line in str(text).splitlines():
        s = line.lstrip()
        if in_html_block:
            if "-->" in s:
                in_html_block = False
            continue
        if s.startswith("<!--"):
            if "-->" not in s:      # 多行 HTML 注释开始
                in_html_block = True
            continue
        if s.startswith("//") or s.startswith("*") or s.startswith("/*"):
            continue
        # 行内 HTML 注释片段（一行里可能有多段）
        out.append(re.sub(r"<!--.*?-->", "", line))
    return "\n".join(out)


def command_registry(ctx):
    if not ctx.exists(COMMANDS_JS):
        return skipped(f"未找到 {COMMANDS_JS}")

    src = ctx.read(COMMANDS_JS)
    blocks = CMD_RE.findall(src)
    if len(blocks) < MIN_EXPECTED_COMMANDS:
        return warned(
            f"只从 {COMMANDS_JS} 解析到 {len(blocks)} 条命令定义（预期 ≥ {MIN_EXPECTED_COMMANDS}）—— "
            "文件结构可能已变化，请更新本检查的 CMD_RE"
        )

    ids = []
    shortcuts = {}   # 归一化快捷键 -> (原始文案, 命令 id)
    menus = set()
    problems = []

    for cid, body in blocks:
        ids.append(cid)

        m_sc = SHORTCUT_RE.search(body)
        if m_sc:
            norm = normalize_shortcut(m_sc.group(1))
            if norm and norm in shortcuts and shortcuts[norm][1] != cid:
                problems.append(
                    f"快捷键冲突：{m_sc.group(1)} 被「{shortcuts[norm][1]}」与「{cid}」同时声明"
                    "（运行时后者会被拒绝 → 按键无反应）"
                )
            else:
                shortcuts[norm] = (m_sc.group(1), cid)

        m_arr = MENU_ARR_RE.search(body)
        if m_arr:
            menus.update(m for m in STR_IN_ARR_RE.findall(m_arr.group(1)) if m)
        else:
            m_str = MENU_STR_RE.search(body)
            if m_str:
                menus.add(m_str.group(1))

    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        problems.append("命令 id 重复：" + "、".join(dup) + "（运行时后注册者被丢弃 → 菜单凭空少一项）")

    # ---------- 引用侧检查 ----------
    known = set(ids)
    refs = 0
    rendered_keys = set()      # 模板里真实引用的菜单键（commandsByMenu.xxx）
    key_list_keys = set()      # `for (const key of [...])` 数组里的菜单键
    for path in sorted(set(ctx.glob("js/**/*.vue")) | set(ctx.glob("js/**/*.js"))):
        if path.replace("\\", "/").endswith("useCommands.js"):
            continue
        try:
            text = strip_comment_lines(ctx.read(path))
        except Exception:
            continue

        for rid in RUN_CMD_RE.findall(text):
            refs += 1
            if rid not in known:
                problems.append(f"{path} 调用了未注册的命令 id：{rid}")

        for dotted, bracketed in MENU_REF_RE.findall(text):
            key = dotted or bracketed
            if key:
                rendered_keys.add(key)
                if key not in menus:
                    problems.append(f"{path} 渲染了不存在的菜单键：commandsByMenu.{key}")

        for key_list in MENU_KEYS_RE.findall(text):
            for key in STR_IN_ARR_RE.findall(key_list):
                if key:
                    key_list_keys.add(key)
                    if key not in menus:
                        problems.append(f"{path} 的菜单键列表里含空菜单：{key}（没有任何命令归属于它）")

    # ---------- 渲染接线双向检查 ----------
    # 由来（2026-09-20）：「分组」菜单三处只加了两处 —— 注册表 menu:'groups' 就位、HeaderBar 模板块也写了
    # commandsByMenu.groups，但 commandsByMenu 计算里的 `for (const key of [...])` 数组漏加 'groups'
    # → out.groups 从未被赋值 → 下拉渲染成**空白菜单**（原有两项都查不到：引用存在 ✓、数组内无空键 ✓）。
    # 真实软件冒烟才发现。教训：模板引用 ≠ 渲染，只有 key 数组里的键才会真的把命令算出来。
    RENDER_WHITELIST = {"settings", "toolbar"}  # 手写交错结构（按钮 @click 走 runCommand），非 commandsByMenu 驱动
    # ① 模板引用了、但 key 数组没写 → out[key] 从未赋值 → 空渲染（本次故障形态）
    for key in sorted(rendered_keys):
        if key in key_list_keys or key in RENDER_WHITELIST:
            continue
        problems.append(
            f"HeaderBar 模板引用了 commandsByMenu.{key}，但 commandsByMenu 的 key 数组里没有它"
            f" → out.{key} 从未被赋值，菜单会渲染成空白（新增菜单要「注册表 + 模板块 + key 数组」三处同加）"
        )
    # ② 注册表里分配了命令的菜单，必须至少接上渲染（模板引用或 key 数组两者有其一）
    for key in sorted(menus):
        if key in rendered_keys or key in key_list_keys or key in RENDER_WHITELIST:
            continue
        problems.append(
            f"注册表菜单「{key}」有命令但从未被渲染：HeaderBar 模板无 commandsByMenu.{key} 引用、"
            f"key 数组里也没有 → 该菜单不会出现"
        )

    if problems:
        ctx.note(
            "命令注册表问题：\n  " + "\n  ".join(problems[:24])
            + f"\n\n定义位置：{COMMANDS_JS}；渲染位置：js/components/HeaderBar.vue、js/components/CommandPaletteModal.vue"
        )
        return failed(f"{len(problems)} 项注册表问题（id / 快捷键 / 引用 / 渲染不一致）")

    return ok(f"{len(ids)} 条命令 · {len(menus)} 个菜单键 · {refs} 处引用，id、快捷键与渲染均一致")


def command_ctx_refs(ctx):
    """命令定义里引用的 `ctx.<字段>` 必须真的存在于 `App.vue` 的 ctx 对象里。

    为什么需要（本条检查的由来）：
        P2 把菜单命令搬进注册表后，命令的 `run` / `titleFn` 会读 `ctx.xxx`。而 `ctx` 是**运行时**对象，
        TS/构建都管不住：写错一个字段名（或误把**某个子组件内部**的 computed 当成 ctx 字段），
        编译照样通过、单测也跑得到，只会在界面上表现为 **undefined** 或“点了没反应”——
        典型的 AR-13 类静默失效。
        ⚠️ 实际踩到过：`dedupeTargetLabel`（原在 HeaderBar 内部）被当成 ctx 字段引用，
        菜单上直接显示成「同名查重与版本清理（undefined）」（截图核对时发现）；
        同一时期还有 `funnelBadge` / `funnelEmpty`（后已补进 ctx）。

    做法：把 `useCommands.js` 里所有 `ctx.<ident>` 与 `App.vue` 的 ctx 对象正文比对。
    写法取宽松（正文里出现过的标识符都算“存在”）—— 宁可漏报个别，也要零误报，否则会被当噪音关掉。
    """
    if not ctx.exists(COMMANDS_JS) or not ctx.exists(APP_VUE):
        return skipped(f"未找到 {COMMANDS_JS} 或 {APP_VUE}")

    src = ctx.read(COMMANDS_JS)
    m = CTX_RE.search(ctx.read(APP_VUE))
    if not m:
        return warned("未能解析 App.vue 的 ctx 对象正文（结构或位置已变，见 AR-31）—— 本项本次跳过")

    exposed = set(IDENT_RE.findall(m.group(1)))
    used = {}
    for ref in CTX_REF_RE.findall(src):
        used[ref] = used.get(ref, 0) + 1

    missing = sorted(k for k in used if k not in exposed)
    if missing:
        ctx.note(
            "命令定义引用了 App.vue 的 ctx 里不存在的字段（运行时会是 undefined / 点了没反应）：\n  "
            + "\n  ".join(f"ctx.{k}（{used[k]} 处）" for k in missing)
            + f"\n\n处理：①确实属于全局状态 → 在 App.vue 定义并加入 provide('appCtx', ctx)；"
              "②仅某个子组件内部的 computed → 不要在命令里引用，改为在 ctx 上重建或改用已有全局字段。"
        )
        return failed(f"{len(missing)} 个 ctx 字段不存在：{'、'.join(missing)}")

    return ok(f"{len(used)} 个 ctx 字段引用全部存在")


def register(reg):
    reg.add(Check(
        name="架构：命令注册表一致性（id / 快捷键 / 引用）",
        run=command_registry,
        tags=("docs",),
        severity="blocker",
        paths=("js/composables/useCommands.js", "js/components/HeaderBar.vue"),
    ))
    reg.add(Check(
        name="架构：命令引用的 ctx 字段存在（防静默 undefined）",
        run=command_ctx_refs,
        tags=("docs",),
        severity="blocker",
        paths=("js/composables/useCommands.js", "js/components/App.vue"),
    ))
