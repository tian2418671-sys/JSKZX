# -*- coding: utf-8 -*-
"""审计「预设 / 独立世界书」类 JSON 里的 `_` 前缀字段与 uid 字段。

用途：判定 `preset:save` / `preset:create` / `wb:save` / `wb:create` 上的
      「递归剔除 `_` 前缀」规则会不会删掉真实数据（DF-03 旧实现的波及面）。

⚠️ 关键结论（2026-09-13 实测 330 个世界书 / 19 个预设）：
    - 独立世界书 `entries[i].uid` **大量存在**（最长条目上 285 次）→
      与 DF-03 注释里「酒馆原生无 uid」的说法**不符**（内嵌 character_book 词条才没有 uid）。
      该规则目前**保留未改**（属 v1.8.9 起的既有行为，影响仅限展示排序的三级 tie-breaker），
      见 docs/bugs/BUG-数据与文件.md DF-14「遗留待决」。
    - 预设与独立世界书里**未发现任何 `_` 前缀字段** → 当前无观察到的受害者。

用法：python scripts/tools/audit-preset-worldbook-underscore.py
"""
import json
import glob
import os
import collections

ROOTS = [
    r"E:\AI\酒馆工具",
    r"I:\03",
    os.path.join(os.environ["APPDATA"], "sillytavern-card-manager"),
]
MAX_MB = 8  # 跳过超大文件（本审计只关心结构，不关心大卡正文）


def walk(o, pth, und, uidc):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(k, str) and k.startswith("_"):
                und[pth + "/" + k] += 1
            if k == "uid":
                uidc[pth + "/" + k] += 1
            walk(v, pth + "/" + str(k), und, uidc)
    elif isinstance(o, list):
        for v in o:
            walk(v, pth + "[]", und, uidc)


def main():
    cands = []
    for r in ROOTS:
        if os.path.isdir(r):
            cands.extend(glob.glob(os.path.join(r, "**", "*.json"), recursive=True))
    print("候选 JSON 总数:", len(cands))

    und = collections.Counter()
    uidc = collections.Counter()
    n_preset = n_wb = 0
    victims = []

    for p in cands:
        try:
            if os.path.getsize(p) > MAX_MB * 1024 * 1024:
                continue
            with open(p, encoding="utf-8") as f:
                j = json.load(f)
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        # 判据：像酒馆预设（prompts + prompt_order）或像世界书（entries）
        is_preset = "prompts" in j and "prompt_order" in j
        is_wb = "entries" in j
        if not (is_preset or is_wb):
            continue
        n_preset += 1 if is_preset else 0
        n_wb += 1 if is_wb else 0

        b_und, b_uid = sum(und.values()), sum(uidc.values())
        walk(j, "", und, uidc)
        d_und, d_uid = sum(und.values()) - b_und, sum(uidc.values()) - b_uid
        if d_und or d_uid:
            victims.append((p, d_und, d_uid))

    print("预设类:", n_preset, " 世界书类:", n_wb)
    print("\n'_' 前缀字段（会被 preset:save / wb:save 的递归规则删掉）:")
    for k, v in und.most_common(40):
        print("   %-74s %d" % (k, v))
    if not und:
        print("   （无）")
    print("\nuid 字段（wb:save 的递归规则会删掉它们）:")
    for k, v in uidc.most_common(20):
        print("   %-74s %d" % (k, v))
    if not uidc:
        print("   （无）")
    if victims:
        print("\n含被删数据的文件示例:")
        for p, a, b in victims[:10]:
            print("   %s  (_ ×%d, uid ×%d)" % (p, a, b))


if __name__ == "__main__":
    main()
