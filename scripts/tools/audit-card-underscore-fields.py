# -*- coding: utf-8 -*-
"""临时审计脚本：统计角色卡里真实存在的 "_" 前缀字段与 uid 字段。

用途：判定 main.js 的 stripInternalFields()（递归剔除所有 "_" 前缀键 + uid）
      是否会误删第三方扩展的真实数据（例如 酒馆助手 的 phone_data._exportMeta）。
 用法：python scripts/tools/audit-card-underscore-fields.py <库根目录> [最多扫描张数]
"""
import base64, json, glob, os, sys, collections

root = sys.argv[1] if len(sys.argv) > 1 else r"E:\AI\酒馆工具\角色卡"
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 0
# 前端内部字段（可以安全剔除）
INTERNAL = {"_collapsed", "_mtime", "_ctime", "_size", "_importTime", "_srcIndex", "_srcUid"}

files = sorted(glob.glob(os.path.join(root, "**", "*.png"), recursive=True))
if limit:
    files = files[:limit]

hits = collections.Counter()      # 非内部 "_" 键 -> 出现次数
uid_hits = collections.Counter()  # uid 所在的路径 -> 次数
scanned = failed = with_uid = 0

for p in files:
    try:
        raw = open(p, "rb").read()
        i = raw.find(b"tEXtchara\x00")
        if i < 0:
            # V3 卡可能写在 ccv3 关键字里
            i = raw.find(b"tEXtccv3\x00")
            if i < 0:
                continue
            key_len = 5
        else:
            key_len = 6
        ln = int.from_bytes(raw[i - 4:i], "big")
        payload = json.loads(base64.b64decode(raw[i + 4 + key_len:i + 4 + ln]).decode("utf-8"))
        scanned += 1
    except Exception:
        failed += 1
        continue

    def walk(o, pth=""):
        global with_uid
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str) and k.startswith("_") and k not in INTERNAL:
                    hits[pth + "/" + k] += 1
                if k == "uid":
                    uid_hits[pth] += 1
                    with_uid += 1
                walk(v, pth + "/" + str(k))
        elif isinstance(o, list):
            for v in o:
                walk(v, pth + "[]")

    walk(payload, "")

print("库:", root, " 文件:", len(files))
print("解析成功:", scanned, " 失败:", failed)
print("非前端内部的 '_' 前缀字段（会被误删）:")
for k, v in hits.most_common(30):
    print("   %-70s %d" % (k, v))
if not hits:
    print("   （无）")
print("uid 字段出现在以下路径（共 %d 处）:" % with_uid)
for k, v in uid_hits.most_common(15):
    print("   %-70s %d" % (k, v))
if not uid_hits:
    print("   （无）")
