# DF · BUG 记录 — 数据 / 文件 / 字段口径 / 扫描

> 领域：卡片与世界书的**字段口径**、物理文件与路径、扫描与去重、落盘与导出。
> 本领域的特点：**同一个概念在不同来源（卡内嵌 / 独立世界书库 / 移动版轻量列表）字段名不同**，转换点漏一处就"数据消失"。
> 总索引见 [`README.md`](README.md)。

---

## 一、路径与文件（DF-01、DF-04、DF-10）

### DF-01 ｜ 🔴 把 `card.id` 当路径用
- **现象**：文件操作 / 导出报错或写到错误位置。
- **根因**：`card.id` 是随机串（`card_时间戳36_随机`），**真实路径在 `card.path`**。
- **修复**：文件操作与导出一律用 `.path`；批量导出 `library.filter(...).map(i => i.path)`。
- **来源**：早期坑清单（数据/文件）

### DF-04 ｜ 🔴 用 blob URL 做图片持久地址 → 重启后破碎图标
- **修复**：图片地址统一用 `local-file://img/?path=` 永久路径；导入时必须**先把文件物理复制到库目录**再引用。
- **来源**：早期坑清单（数据/文件）；v1.6

### DF-10 ｜ 🟡 `*.png.<pid>.<tid>.tmp` 外部残留被当**假卡入库**【移动版】
- **现象**：真卡目录里的 `Blind Wife.png.26912.76.tmp`（1.6MB 完整 PNG，含 `tEXt`+`chara`）被扫描后**当成正常卡入库**（JS 侧把所有非 `.json` 文件当图片，按二进制提 `chara`）。
- **根因**：`isTransientFile` 只覆盖 App 自己产生的两种模式 —— ① `.jszkx-tmp` 后缀 ② `.tmp_<时间戳>` 后缀；**不覆盖外部工具/中断写入的 `<卡名>.<pid>.<tid>.tmp`**。
- **修复**：新增模式③（卡扩展名 + 数字.数字 + `.tmp`）并抽 `allDigits()` 工具：
  ```java
  if (lc.endsWith(".tmp")) {
      String core = lc.substring(0, lc.length() - 4);
      int lastDot = core.lastIndexOf('.');
      if (lastDot > 0) {
          String tidTail = core.substring(lastDot + 1);
          String pre = core.substring(0, lastDot);
          int preDot = pre.lastIndexOf('.');
          if (preDot > 0 && allDigits(tidTail) && allDigits(pre.substring(preDot + 1))) {
              String head = pre.substring(0, preDot);
              if (head.endsWith(".png") || head.endsWith(".webp") || head.endsWith(".json")) return true;
          }
      }
  }
  ```
- **判定用例（15 项）**：真实残留 / 中文件名 / webp / json → **过滤**；`v1.2.3.tmp`（版本号）、`config.tmp`、`abc.png.tmp`（缺 pid）、`abc.png.1.tmp`（缺 tid）、`abc.png.aa.2.tmp`（pid 非数字）、正常卡 / 正常世界书 → **保留**。
- **验证**：模拟器实测 5 个变体全部正确过滤，设置页显示「全部卡片 9 张」无 tmp 假卡。
- **来源**：`v1.10.21 移动版专项实测` BUG-7

### DF-16 ｜ 🟡 分组列表累积大量「空组」，且无批量清理入口（含预设空组）
- **现象**：侧边栏出现几十个 0 卡片的空分组（跨库历史分组名 + 8 月遗留的空文件夹）；用户报「怎么这么多空组」，
  且没有任何一键清理入口（预设空组连手动删都无处下手）。
- **取证**（2026-09-20）：`customCategories = 55`（两个库的历史分组都在），当前库仅 76 张卡；
  磁盘 6 个空文件夹（`4-5月/分住1/开大车/科幻/世界卡/NTR`）**创建于 08-17~08-31**，
  与本日自动分组无关（自动分组只创建「有卡片落入」的目标文件夹，当日新建的 英文卡/校园/RPG跑团 均非空）。
- **根因**：分组列表 = `customCategories`（**跨库累积**，切库 / 改名 / 迁移都会留名）+ 预设分组；
  既有 `cleanupEmptyCategories` 只处理「刚被删空」的自定义组，**历史遗留没有任何入口** —— 配置文件项与磁盘空文件夹都长期残留。
- **修复**（2026-09-20）：新增「🧹 清理空分组」（侧栏分组行按钮 + 「标签」菜单命令 `edit.cleanupEmptyGroups`）：
  - 收集口径（纯函数 `js/utils/groupCleanup.js`）：0 卡片的 `customCategories` / 预设组
    （预设按 `cn/en/key` 三种存储形态计数；排除 全部 / 未分类 / 过滤视图）；
  - 两步原生确认：① 自定义空组 → 删配置 + 空文件夹（仅空目录，`deleteEmptyGroupFolder`）；
    ② 预设空组 → 隐藏（记入 `removedDefaultKeys`，可恢复）+ 空文件夹；
  - 当前选中组被清理时自动切回「全部」；清理末尾**显式 `syncConfigToDisk()` 冲刷落盘**（不等 watch 防抖）。
  - 范围口径：仅处理**属于分组**（自定义/预设）的空文件夹；**不属于任何分组的孤儿空目录不处理**
    （例如库内手工建的空目录，不在分组体系内，留待用户自行处置）。
- **验证**：`test/groupCleanup.test.mjs`（收集口径）；隔离库端到端（分组空文件夹 + 配置空组 → 清理后双双消失；
  配置落盘带容错重试核对；孤儿空目录保留；有卡分组不动）；真机按钮可见。
- **来源**：2026-09-20 热测人工监察（用户报「怎么这么多空组」）

---

## 二、字段口径（DF-02、DF-03、DF-05、DF-06、DF-07、DF-11）

### DF-02 ｜ 🔴 世界书 `entries` 是对象字典（V2 老格式）
- **现象**：导入含 `{"0": {...}}` 形态的卡 → **空屏崩溃**。
- **修复**：所有读取点 `Object.values` 归一化 + 脏形态兜底（`extractBookEntries` 模式）。
- **来源**：早期坑清单（数据/文件）；v1.8.4（`extractBookEntries` 脏形态全链路防御）

### DF-03 ｜ 🟡 保存/导出未剔除 `_` 前缀临时字段与 `uid`
- **现象**：导出的 JSON 里混入 `_collapsed` 等 UI 状态；SillyTavern 原生无 `uid`。
- **修复**：`JSON.stringify` replacer 双层防线，剔除 `_` 前缀字段 + `uid`。
- **来源**：早期坑清单（数据/文件）；v1.8.9
- **⚠️ 2026-09-13 追补（重要）**：本条当时的实现「**递归**剔除所有 `_` 前缀键 + 所有 `uid`」
  本身是**危险的**——第三方扩展把 `_` 开头字段当真实数据用。实测 11,045 张真实卡片里
  有 **7 类、131 处**会被它删掉（详见本文件下一节 **DF-14**）。
  现已改为**白名单字段名 + 限定位置**（`main/cardFieldSanitizer.js`）。
  **不要**再按本条旧描述回退成前缀递归实现。

### DF-21 ｜ 🔴 独立世界书保存后**丢失 ST 原生「字典形态」**（`entries` 被写成数组）
> ✅ **状态：已修复（2026-09-24，真修复 = 保存时还原 ST 原生字典形态）**
> 🛑 **本节含一次重要的「错误结论修正」**：此前（2026-09-23）曾判定「**uid = 数组下标**」
> 并推荐「按下标重写 uid」（方案 A）—— **该结论是错的**，详见下方「🔬 结论修正」。

- **现象**：保存独立世界书（`wb:save` / `wb:create`）后，文件的 `entries` 从
  SillyTavern 原生的**对象字典**（键 = uid）变成**数组**，偏离 ST 原生格式。
- **取证（2026-09-24 实测，真实库）**：

  | 阶段 | `entries` 形态 |
  |---|---|
  | ST 原生文件 | **字典**（键 = uid，如 1905 个键） |
  | 本应用载入内存 | **数组**（`Object.values`） |
  | **本应用保存产物** | **数组** ← ⚠️ **丢失字典容器形态** |

  实测（真实库 26 本 / 23,816 条）：源文件 **100% 是字典**，
  经「载入 → 保存」链路后 **100% 变数组**。
- **🔬 结论修正（2026-09-24，推翻前一天的判断）**：

  | 前一天的结论 | 实测修正 |
  |---|---|
  | 「uid **完全等于**数组下标（6 文件 / 11,430 条 / 0 例外）」 | ❌ **不成立**。`炎孕-副本01.json` 有 397 条但 uid 范围 **0~13331**（唯一 397，**有空洞**：`0..1904` 后直接跳到 `5737 / 6239 / 10567 / 13331`）—— 前一天的样本**恰好**都是未删过词条的书 |
  | 「uid = 文件内顺序号，可从数组顺序重建」 | ❌ **不成立**。uid 是**「词条身份」**，删除会**腾出号码供复用** |
  | 推荐「方案 A：按下标重写 uid」 | ❌ **会破坏真实数据**（把 ST 的 uid 身份语义改成位置语义） |

  **🔑 定论依据（SillyTavern 源码，`public/scripts/world-info.js`）**：
  · `entries` 是**对象字典，键 = uid**（`data.entries[uid].content = ...`）；
  · `getFreeWorldEntryUid(data)` —— **从 0 起扫，返回第一个「不在 entries 里」的整数**（上限 1,000,000）；
  · `createWorldInfoEntry` —— 新词条 = `{ uid: newUid, ...模板 }`，写入 `data.entries[newUid]`；
  · `deleteWorldInfoEntry` —— `delete data.entries[uid]` ⇒ **uid 被腾出、可被后续新建复用**；
  · `duplicateWorldInfoEntry` —— `delete originalData.uid` 后走 `createWorldInfoEntry` ⇒ **新 uid**；
  · 保存（`/api/worldinfo/edit`）**直接写整个 data** ⇒ **从不按下标重写 uid**。
- **✅ 修复（2026-09-24）**：新增 `main/cardFieldSanitizer.js` 的 **`restoreEntriesDict()`**，
  在 `wb:save` / `wb:create` 的清洗链路里调用（`restoreEntriesDict(stripInternalFields(data))`）：
  1. **保留数字 uid**（含空洞）—— 两轮处理：**先登记所有数字 uid**（它们是 ST 的真实身份），
     再给「缺失 / 本应用临时串」分配**最小空闲整数**（与 `getFreeWorldEntryUid` 同语义）；
  2. 字典键与词条内的 `uid` **双写**（ST 两处都存，只写一处会让 ST 读回后 `entry.uid` 为 undefined）；
  3. 本应用生成的临时串（`<Date.now()>_<base36>`）**不落盘**，但**词条内容完整保留**；
  4. ⚠️ **只对独立世界书调用** —— 角色卡**内嵌** `character_book.entries` 是**数组**
     （V2/V3 规范如此，实测真实卡 **100% 无 uid**），**绝不能**转成字典。
- **验证**：
  - **端到端探针** `scripts/probes/_probe-wb-uid-dict.mjs`（真实库 26 本 / 23,816 条）：
    ```text
    ① 源文件是 ST 原生字典：26/26
    ② 保存产物是字典（修复生效）：26/26
    ③ 产物自洽（键 === 词条内 uid）：26/26
    ④ 自洽源文件的 uid 集合保真：21/21
    ⑤ 词条条数不变（内容不丢）：26/26
    ```
    > 📌 另有 5 本「源文件**键 ≠ 词条内 uid**」—— 那是本项目**压测库的合成产物**
    > （`炎孕-改写A~D` / `超巨世界书`），非 ST 自洽格式，故不计入 uid 保真断言（探针已如实标注）。
  - 单测 `test/cardFieldSanitizer.test.mjs` **22 → 30 例**（新增 `restoreEntriesDict` / `nextFreeUid`
    的空洞保留、空闲分配、幂等、撞键不覆盖、内嵌不受影响等）；`npm test` **666 pass / 0 fail**。
- **⚠️ 两次教训（同型，必须记住）**：
  1. **「前端内部字段」必须带形态证据，不能只看字段名** —— `uid` 这个名字两边都在用；
  2. **光有形态分布还不够，样本必须有代表性** —— 前一天止步于「6 文件 / 11,430 条」就下结论，
     而那个样本**恰好全是未删过词条的书** ⇒ 得出「uid = 下标」的错误结论。
     **正确做法：先读上游源码定语义（ST 的 `getFreeWorldEntryUid` 一看就懂），再用数据验证。**
- **来源**：DF-14「遗留待决」项（2026-09-13 审计发现；2026-09-23 形态取证；
  **2026-09-24 结论修正 + 真修复**）

---

### DF-14 ｜ 🔴 卡片保存路径未清洗（DF-03 覆盖不全）+ 旧清洗规则会**误删第三方真实数据**
- **现象 A（污染）**：`App.vue` 的「从世界书库导入词条到角色卡内嵌世界书」先剔 `_`、
  紧接着又写回前端用的 `uid` 与 `_collapsed` 再 push 进卡内世界书的**活引用**；
  而卡片保存走 `getPlainCardData()`（纯 `JSON.parse(JSON.stringify(...))`，**无 replacer**）
  → 保存后 PNG 的 `chara` JSON / 卡片 `.json` / 整合包的 `worldbook.json` 里混进这两个字段。
  DF-03 只覆盖了世界书 `wb:save` / `wb:create` 两条路径，**漏了卡片侧 4 条**
  （PNG `chara` 块、卡片 `.json`、整合包 `worldbook.json`，以及**换卡图** `card:replaceImage`
  —— 后者会把内存里的 `uid`/`_collapsed` 一起嵌进新 PNG）。
- **现象 B（误删，更严重）**：DF-03 的递归前缀剔除会把第三方扩展的真实数据删掉。
  2026-09-13 用 `scripts/tools/audit-card-underscore-fields.py` 对 11,045 张真实卡片实测：

  | 被误删的真实字段 | 命中卡片数 |
  |---|---|
  | `character_book/entries[].extensions._filename` | 28 |
  | `extensions/juqingtuijin/apiSettings/_legacyEntriesMigrated` | 26 |
  | `extensions/tavern_helper/variables/phone_data/_exportMeta` | 13 |
  | `extensions/quick-response-force/apiSettings/_legacyEntriesMigrated` | 4 |
  | `extensions/tavern_helper/variables/phone_character_images/__common__`（**键名本身就是 `_` 开头**） | 3 |
  | `extensions/TavernHelper_scripts[].value.data.change_log[].uid` | 11 处 |
  | `extensions/chatSheets/sheet_<表名>/uid` | 24 处 |

  同一份审计确认：真实卡片的 `character_book` 词条上**没有** `uid`（0 张），故删词条级 uid 无损失。
- **根因**：把「前端内部字段」这一**语义问题**当成了「`_` 前缀」这一**命名巧合**问题。
  前缀不是契约 —— 第三方扩展同样会用 `_` 开头。
- **修复**：抽出 `main/cardFieldSanitizer.js`，规则改为
  **白名单字段名（`uid` / `_collapsed` / `_srcIndex` / `_srcUid`，顶层再加 `_mtime` 等库项元数据）
  + 限定位置（只删世界书**词条对象自身的直接键**，绝不递归进词条内部）**，
  5 条落盘路径共用：卡片 PNG `chara` 块、卡片 `.json`、`wb:save` / `wb:create`、整合包 `worldbook.json`、
  换卡图 `card:replaceImage`（清洗放在 `embedCardJSONIntoPNG()` 内部，单点覆盖全部调用方）。
  返回深拷贝，**不就地改内存活对象**（内存里的 `uid` 仍供 v-for 做 key；`_mtime` 仍供增量刷新比对）。
- **验证**：`test/cardFieldSanitizer.test.mjs`（14 例，含反向用例：第三方 `_` / `uid` 不误删、内存活对象不被就地修改）；
  `scripts/tools/save-strip-real-cards.mjs`（真实卡片批量离线复跑：注入污染 → 清洗 → 第三方字段 0 丢失、其余逐字段一致）；
  `scripts/tools/save-strip-live-card.mjs` + `save-strip-live-worldbook.mjs`（**真实 IPC 落盘链路**）。
  ⚠️ 换卡图路径因需原生「选图」对话框，无法脚本化，只做代码级核对（清洗点唯一）。
- **来源**：v2.2.7 回归审计（2026-09-13）
- **遗留待决（⬜ 本次**未改**，需用户决策）**：同一审计（`scripts/tools/audit-preset-worldbook-underscore.py`，
  扫 5,894 个 JSON）发现 **独立世界书的 `entries[i].uid` 是普遍存在的真实字段**
  （330 个世界书文件里，最长条目上出现 285 次）—— 这说明 DF-03 注释里
  「SillyTavern 原生无 uid」**对独立世界书并不成立**（只有角色卡**内嵌** `character_book` 的词条才没有 uid）。
  而 `wb:save` / `wb:create` 从 v1.8.9 起就会在保存时**删掉这些 uid**。
  - **为什么本次不动它**：这是 v1.8.9 起的**既有既定行为**，且实测影响很轻 ——
    uid 在本项目里只作世界书条目排序的**三级 tie-breaker**
    （`useWorldbookEntries.js:127`，注释明确「仅影响展示顺序，不改变底层数组顺序」），
    条目标识走 `WeakMap`；SillyTavern 导入时也会自行分配 uid。
    在**已发布版本**上改「保存时保留 uid」属于未经验证的行为变更（可能影响 ST 互操作），
    不宜混在本次修复里。
  - **若要改**：把 `main/cardFieldSanitizer.js` 的 `WB_ENTRY_INTERNAL_FIELDS` 里 `uid` 去掉即可
    （渲染层 `js/utils/cardFields.js` 的同名常量要一起改 —— 有「两份实现白名单必须一致」的防漂移测试盯着；
    `App.vue` 的 `saveActiveWorldbook` / `exportActiveWorldbook` 已改为调用同一助手，**无需单独改**），
    但**改完必须重跑** `scripts/tools/audit-preset-worldbook-underscore.py` +
    `test/cardFieldSanitizer.test.mjs`。
  - ✅ **已解决（2026-09-23，用户拍板）** → 见 **DF-21**。
    实际落地**不是**「把 `uid` 从白名单去掉」（那会让本应用自己的临时 uid 永久污染文件），
    而是**按形态区分**：只删本应用生成形态（`<时间戳>_<随机串>`），ST 原生数字 uid 原样保留。
    真实库取证（804 个世界书 / 319,148 条词条）证实 uid **100% 是 ST 原生数字**，
    本应用随机串 0 个 —— 旧行为确实在删 ST 的真实数据。
  - 同批审计的另一面：**预设（19 个）与独立世界书里未发现任何 `_` 前缀字段** → 无观察到的受害者。
    故 `preset:save` / `preset:create` 上的同款递归规则（`main.js:2979` / `main.js:3012`）
    **本次一并未动** —— 没有证据、也不清楚预设编辑器注入了哪些 `_` 字段，盲改可能反而把 UI 垃圾留在盘上。

### DF-15 ｜ 🔴 「库 → 卡内嵌」导入不做字段口径转换 → 酒馆侧触发词失效
- **现象**：在角色卡内经「📥 导入词条」把世界书库的词条导进卡内嵌世界书后，
  该词条在**本应用里看着完全正常**（卡内编辑器 `keys || key` 双向回退），
  但存进卡片文件的是**库/旧世界书格式**，与卡里原有词条（V2 内嵌格式）**两种口径并存**。
- **实测证据**（2026-09-14，`星月私立高等学院 MVU 3.9.9_copy_*.png`）：
  导入的那条词条字段 = `key, keysecondary, comment, content, constant, selective, order,
  disable, position(数字), vectorized, displayIndex, excludeRecursion, …`；
  而同一张卡原有的 46 条 = `id, keys, secondary_keys, comment, content, constant, selective,
  insertion_order, enabled, position(字符串 before_char/after_char), use_regex, extensions`。
- **根因**：`App.vue` 的 `confirmCardWbImport` 注释写着「字段转换：库（`key/keysecondary/order`）
  → 内嵌（`keys/secondary_keys/insertion_order`）」，但实现只有
  「深拷贝 → 剔前端内部字段 → 写 `uid`/`_collapsed` → push」——**零字段映射**（注释与实现不符）。
  反方向的 `extractWorldbookFromCard`（`useWorldbookExtras.js:63-72`）是**做了**映射的，
  说明项目本就要求双向映射，只是回去的方向漏了。
- **危害**：酒馆读卡内嵌世界书按 V2 规范取 `keys`/`secondary_keys`/`insertion_order`/`enabled`
  ⇒ 该词条的**触发词很可能不生效**（`disable` 与 `enabled` 语义相反，开关状态也会与 ST 不一致）；
  数值型 `position` 也丢了与 `extensions.position` 的对应关系。属「用了就中」而非存量普遍
  （本库实测：63 张带内嵌世界书的卡 / 3808 条词条里，**1 张 1 条**）。
- **修复**：新增 `js/utils/wbEntryFormat.js` 的 `toEmbeddedEntry()`，在 push 之前做互逆映射 ——
  `keys ← key`、`secondary_keys ← keysecondary`、`insertion_order ← order`、`enabled ← !disable`，
  顶层 `position` 由数字（或字符串）归一为 V2 的 `before_char` / `after_char` 并把**数值真相**放进
  `extensions.position`（与真实卡一致）；ST 选项字段（`excludeRecursion`/`displayIndex`/`groupOverride`/
  `match*` 等）搬进 `extensions` 并按真实卡的命名（`exclude_recursion`/`display_index`/…，
  `selectiveLogic` 与 `useProbability` 保持驼峰）；消费掉的库字段（`key`/`keysecondary`/`order`/
  `disable`/`useRegex`）删除；**未知字段保守保留**（不白名单式丢弃第三方数据）。
- **验证**：`test/wbEntryFormat.test.mjs`（含「已是内嵌格式再转一次幂等」「不就地改入参」
  「真实卡条目字段结构断言」「未知第三方字段保留」）；并对**真实卡里那条导入词条**离线复跑转换确认字段到位。
- **来源**：v2.2.7 换卡图端到端验证时的连带发现（DF-14 修复后的对照扫描）

### DF-05 ｜ 🔴 分类/标签未同步写原生 `data.tags` → 重启重扫丢失
- **修复**：`persistCardUpdate` 三保险 —— 内存 + 覆盖层（`appConfig.cardOverlays[path]`）+ 写回卡片文件。
- **来源**：早期坑清单（数据/文件）

### DF-06 ｜ 🔴 内嵌世界书 vs 库世界书**字段口径不同**
| 位置 | 名字 | 触发词 | 权重 |
|---|---|---|---|
| 角色卡内嵌（V2） | `comment`（旧卡/第三方用 `name`） | `keys` / `secondary_keys` | `insertion_order` |
| 独立世界书库 | **只认 `comment`** | `key` / `keysecondary` | `order` |

- **后果**：转换时漏做映射 → 导出后条目名字/权重"消失"（见 DF-07）。
- **来源**：早期坑清单（数据/文件）；2026-08-22 会话（世界书条目名/触发词显示修复）

### DF-07 ｜ 🔴 世界书导出后**条目名字全部缺失**
- **现象**：角色卡编辑页点「📤 提取为世界书」，库里的新世界书打开后**词条没有名字**（列表副标题空、备注栏空），而在卡片内嵌编辑器里名字显示正常。
- **根因**：`extractWorldbookFromCard` 的 `cleanEntries` 只转换了触发词字段，**没做名字映射**；卡内编辑器有 `entry.comment || entry.name` 兜底所以掩盖了问题，而库 IDE 只读 `comment`。
- **交叉证据**：同仓库其他入口都做对了 —— `useWorldbookExtras.js:35`（JSONL 导入）与 `useGlobalEntrySearch.js:27` 都是 `comment: e.comment || e.name || ''`，**唯独导出函数漏了**。
- **顺带同源问题**：也未做 `insertion_order → order` 回退（纯 V2 卡词条权重显示为空）。
- **修复**（`js/composables/useWorldbookExtras.js`，`cleanEntries` 映射）：
  ```js
  c.comment = String(c.comment || c.name || '');
  c.order = c.order ?? c.insertion_order ?? 100;
  ```
  保留 `name` 字段不删除（`wb:create` 落盘只剔 `_` 前缀与 `uid`，`name` 保留无害）；`comment` 已存在时不覆盖（`||` 短路）。
- **来源**：`docs/技术支持/世界书与卡片/代码片段-世界书条目名修复与导入.md` §一

### DF-11 ｜ 🟡 快捷筛选「有世界书 / 有正则」恒显示 0 张【移动版】
- **现象**：点「📚 有世界书」「🔧 有正则」始终 0 张，但缓存里 `b=1` 有 250 条、`x=1` 有 48 条。
- **根因**：移动端轻量列表的 `card.data` 为 `null`（缓存只存紧凑字段 `n/c/t/d/s/k/b/x`），原代码 `card.data?.data || card.data || {}` 恒返回空对象 → `character_book` / `regex_scripts` 永远取不到。
- **修复**：`passCategory` 增加轻量标记快速路径：
  ```js
  if (typeof card._lb === 'boolean') return card._lb;  // has_lorebook
  if (typeof card._rx === 'boolean') return card._rx;  // has_regex
  ```
  （桌面版 `SidebarPanel.vue` 的 `hasLorebook` 后来也沿用同一约定：`item._hasBook`）
- **验证**：250 张 / 48 张与缓存统计完全一致。
- **来源**：`v1.10.21 移动版专项实测` BUG-9

---

## 三、扫描与去重（DF-08、DF-09）

> 背景：用户报「搜索/刷新时角色卡库出现多个重复卡」。全库排查后结论是 —— **这类缺陷只有「卡库」一处高危**，其余集合库（世界书、预设、自定义分类、全局标签池、缝合工作台）都由「磁盘层拒绝覆盖已存在文件」或「显式判重」保护，**不需要改**。
> 完整排查表见 `v2.2.7 全库同类缺陷排查` §一。

### DF-08 ｜ 🔴 `refreshLibrary` 增量刷新**缺 path 去重**
- **文件**：`js/composables/useDiskScan.js`
- **旧写法**两条路径都没去重：
  ```js
  const next = [];
  for (const f of result.files) {
      const old = oldMap.get(f.path);
      if (old && Number(old._mtime) === Number(f.mtime)) {
          next.push(old);        // ① 既没查重，也没登记 seen
      } else { toParse.push(f); }
  }
  library.value = next;
  await Promise.all(batch.map(file => parseAndAddCard(file)));   // ② 没传 seenPaths
  ```
- **触发条件**（任一即可让同一 path 进两条）：
  - 扫描结果里同一 path 出现两次 —— 目录内有 **junction / 符号链接**指向同一文件（`walkLibraryDir` 的 `realpath` 守卫只防目录环路）；
  - 目录里同时存在 `A.png` 与 `A.PNG`（Windows 不区分大小写，但 `realpath` 字符串不同）；
  - **并发刷新**：连点刷新，或刷新与启动期 `processElectronFiles` 重叠。
- **修复**：① `next` 构造时按 `path` 强去重（`seenPath` Set，首个胜出、保留原对象）；② `parseAndAddCard` 补传 `seenPaths`，并把 `next` 里已有的 path 预填进去（`parseSeen`）。
- **来源**：`v2.2.7 全库同类缺陷排查` §二

### DF-09 ｜ 🔴 `parseAndAddCard` 判重条件过窄（根因）
- **文件**：`js/composables/useCardCrud.js`
- **旧写法**：
  ```js
  const inStaging = (opts.seenPaths instanceof Set) ? opts.seenPaths.has(file.path) : dupIn(opts.target || library.value);
  if (inStaging || (opts.target && dupIn(library.value))) { ...跳过... }
  ```
- **问题在 `opts.target &&` 这个短路**：增量刷新既没传 `target` 也没传 `seenPaths` 时 → `inStaging` 查的 `library.value` 已被赋成 next 副本；`opts.target && ...` 因 `target` 为空**直接 false** → **「live library 是否已有同 path」这一条实际上永远不会被检查**。
- **修复**（两个维度无条件都查）：
  ```js
  const seenHit = (opts.seenPaths instanceof Set) && opts.seenPaths.has(file.path);
  if (seenHit || dupIn(opts.target) || dupIn(library.value)) { file._skippedExisting = true; return false; }
  ```
- **外加最终防线**（push 处）：`liveList.findIndex(c => c.path === cardInfo.path)` 命中即**替换**（顶层 mtime 变化本就走这条），绝不再新增一条 —— 将来再有调用方漏传 `seenPaths` 也不会产生重复卡。
- **来源**：`v2.2.7 全库同类缺陷排查` §三；`v2.2.7 大库压测` §四

---

## 四、落盘与标签恢复（DF-12、DF-13）

### DF-12 ｜ 🔴 子文件夹分支提前 `return` 跳过覆盖层恢复（标签重启后消失）★
- **现象**：AI 打标 / 手动打标完成后**重启应用，标签消失**。
- **根因**：库目录下大量卡片在**子文件夹**里（分组 = 物理子文件夹，如 剧情卡/科幻/恋爱/修仙…）。加载时 `useCardCrud.js` `processAutoTagsAndCategory`：
  ```js
  if (cardInfo.subFolder) {
      cardInfo.category = ...;   // 只设分类
      return;                     // ⚠️ 直接 return，跳过覆盖层恢复
  }
  ```
  `subFolder` 分支只处理分类就返回 → **`customTags` 永不恢复**。标签其实已写入覆盖层（`app_config.json` 实测 66 条有标签数据），但重启后按新 path 找不到 → 丢失。若同时开着「导入时忽略卡片自带标签」，连原生 tags 显示都被滤掉 → **完全看不见**。
- **修复**：`subFolder` 分支不再裸 `return` —— **物理文件夹只管分类，标签仍按覆盖层恢复**（与根目录分支同口径）。
- **加固（防「防抖没落盘」类丢失）**：
  1. `persistCardUpdate`：`saveCard` 物理写盘失败（快照失败 / PNG 异常 / 文件缺失）时，**立即强制 `syncConfigToDisk()`**（不走 500ms 防抖）落盘覆盖层；
  2. `useAITools.js`：AI 打标全部完成（扫尾）时**强制立即 `syncConfigToDisk()`** 一次 —— 不依赖 500ms 防抖 + `beforeunload`（注释自认「尽力而为，极端可能来不及」）。
- **防再犯**：**加载/恢复函数里的每一个早期 `return` 都要问：它是否跳过了本应执行的恢复逻辑？**
  `processAutoTagsAndCategory` 的优先级链是 subFolder → 覆盖层 → importedConfig → localCategoryMap → 自动规则，
  **每一层都要完整恢复「分类 + 标签」两个维度**（除非该层确实只管一个维度）。
  凡是用户主动打标的数据，必须**三保险**：内存 + 覆盖层（`app_config.json`）+ PNG 物理写回。
- **来源**：v2.1.0 覆盖层恢复专项（2026-09-01）

### DF-13 ｜ 🟡 `atomicWriteJson` 失败不清理 tmp → userData 积攒 95 个残留
- **现象**：userData 里积攒 **95 个** `app_config.json.*.tmp` / `snapshot_config.json.*.tmp`（写盘中途崩溃/被杀遗留）。
- **根因**：`main.js` 的 `atomicWriteJson` 只 `writeFile + rename`，**失败时不清理本次 tmp**（其他 3 处卡片/文件写盘早已加清理，**唯独配置原子写漏了**）。
- **修复**：① `atomicWriteJson` 的 catch 精确 `unlink` 本次 tmp；② 启动时 `cleanupStaleConfigTmp()` 清扫历史残留（正则匹配 `app_config|snapshot_config|tavern_manager_config` 的 `.json.<pid>.<seq>.tmp`，仅删未被占用的）。
- **同因同类**：`embed_cache_*.tmp` 也属于「原子写残留无人清」（见 [PK-07](BUG-性能与大库.md)）。
- **来源**：v2.1.0 配置原子写专项（2026-08-29）

### DF-17 ｜ 🔴 世界书差异比对用「拼接大字符串」+ 词条无稳定主键 → 看不出「哪个词条被增删」
- **现象**（2026-09-21 排查）：查重面板的世界书比对**只能看到「一大坨文本里某几句变红变绿」**，
  无法回答用户最关心的问题——**到底删了哪个词条、加了哪个词条**。词条增删是最常见的版本差异，却恰恰是最看不出来的。
- **根因**（两层）：
  ① 「📝 词条正文总集比对」把两侧**全部词条的 `content` 拼成一条大字符串**再走句级 diff
  （`computeTextDiffLines` 用 `Set` 判 same/added/removed）→ **不保留归属与顺序**，A 侧第 3 条的句子和 B 侧第 7 条的句子混在同一个文本流里；
  ② 词条**没有可用于跨源匹配的主键**：世界书词条字段是
  **库形态 `uid`/`key`/`keysecondary`/`comment`/`content`** vs **卡内嵌形态 `uid`/`keys`/`secondary_keys`/`comment`/`content`**（见 [DF-06](#df-06--内嵌世界书-vs-库世界书字段口径不同)），
  **没有 `name` 字段**；而 `uid` 是逐条随机生成的——同源复制会保留，但经「导入词条到角色卡」这类字段转换会**重新生成**（见 [DF-15](#df-15--从世界书库导入词条到角色卡不做字段口径转换)）
  → **拿 `uid` 当主键会把同一条词条判成「两侧各缺一条」**。
- **修复**：新增 `alignEntryLists` 外连接对齐（Full Outer Join），把不对称增删表达成 `only-a` / `only-b` / `both` 三类；
  主键用**三级回退**（`comment` → `key` 指纹 → `uid`），并满足三项约束：
  ① **带侧标识**（脏数据 key 用 `anon:a:3` / `anon:b:3`，两侧共用下标会让 A 侧脏数据与 B 侧**无关**脏数据配成 `both`）；
  ② **一对一配对**（`mapB` 用「key → 数组 + 已消费标记」；同书内重复 `comment` / 重复 `key` 集合现实存在，
  若用 `Map` + `Set` 会出现「两条 A 配同一条 B，且 B 侧那一条永远不渲染」→ 两侧条数对不上）；
  ③ **不认 `uid` 当主键**（理由见根因 ②）。
- **已知取舍（非缺陷）**：两侧都填了 `comment` 但同一词条**改了名**，会显示成「一条缺失 + 一条新增」——
  这在语义上确实是删 + 增，**可接受且可解释**，不为此加模糊匹配。
- **验证**（2026-09-21 已修复并通过）：单测 `test/dedupeEntryAlign.test.mjs` **20 条全绿**，覆盖 TC-02 / TC-09 ——
  「A 3 条 / B 5 条 → 恰好 1 条 `only-a` + 2 条 `only-b`」（实测 1 / 3 / 2，含 `both`）、
  **同一输入两次调用 key 一致**、**脏数据不跨侧配对**、**重复 `comment` 一对一**、
  **`uid` 跨源重生成仍能配上**、1000 对 1000（50 增 50 删）不退化。
  UI 级：真实弹窗渲染出 `[缺失] 丙` / `[新增] 丁` / 甲·乙「一致」，词条级对齐字段摘要「新增 3 / 缺失 1 / 改动 0 / 共 6 条」。
- **来源**：2026-09-21 查重链路专项排查（[`../规格与计划/查重引擎/查重扫描与检索-最终方案.md`](../规格与计划/查重引擎/查重扫描与检索-最终方案.md) §2.3）

### DF-18 ｜ 🔴 大世界书/预设被**静默丢弃**（5MB 闸门 + 512KB 头部预检 + 误杀被缓存固化）
- **现象**（2026-09-21 排查）：10~50MB 的完整世界书放进库目录后**扫不到**——无报错、无日志、不进任何统计，
  用户只能看到「这本大书不见了」，判定为软件坏了。
- **根因**（`main.js`，共 **4 道闸门 + 1 道会固化的缓存闸门**）：

  | # | 闸门 | 现状行为 | 后果 |
  |---|---|---|---|
  | 1 | 角色卡 `< 40KB`（`MIN_CARD_FILE_SIZE`） | 丢弃，由 `useSizeFilter` 开关控制（默认开） | 有开关可关，**非静默** |
  | 2 | 世界书 `> 5MB` | **静默 `return`**：无日志、无 UI、不进统计 | **本次报的现象** |
  | 3 | 预设 `> 5MB` | 同款写法 | **同类问题，必须一并修** |
  | 4 | `> 512KB` 头部预检（读头 64KB 找 `"entries"`） | **不命中即判无效** | `entries` 不在前 64KB 的大书**被误杀** |
  | 5 | `isValidWorldbook` 只看 `entries[0]` | 首条词条字段不标准 → 整本被拒 | 同上，静默 |
  | 6 🔴 | **`scanCache` 把误杀持久化** | 缓存写 `{ valid: false }`，下次同 mtime **直接跳过** | **修了预检逻辑，用户机器上已有的误杀记录也不会自愈** |

- **修复**（规划中，见最终方案 §四 S2-1~S2-3）：
  ① 闸门**分级**而非一刀切抬到 50MB（`≤5MB` 维持内联 / `5~50MB` 降并发 / `>50MB` 只回元数据）——
  因为 `wb:scan` 是 **32 路并发 `Promise.all`**，一刀切 50MB 会把 OOM 从渲染进程**搬到主进程**（主进程崩 = 整体消失）；
  ② 超限**不再静默**：记 `console.warn` + 汇总 `skipped: [{ path, size, reason }]`，界面显示「N 个文件被跳过」+ 可展开文件名；
  ③ **`scanCache` 自愈**必须与 ② 同批（加结构版本号失效，或把「预检未命中但不大于上限」标为 `valid: null` 下次仍重试）。
  > 🔴 **预设侧 `preset:scan` 是同一段写法、同一个 cache** —— 两侧一起改、一起测。
- **防再犯**：**静默丢弃 = 用户以为软件坏了**（同 [AR-38](BUG-架构与渲染.md)：可点但无反馈的按钮会被当成坏按钮）。
  凡是"跳过/忽略某个文件"的逻辑，必须**留下可被用户看到的痕迹**；凡是"缓存判定结果"的逻辑，
  缓存**不能固化"否定判定"**——逻辑升级后旧判定必须能失效，否则修复对老用户无效。
- **修复结果**（2026-09-21 已实施并通过）：`main.js` 新增 `SCAN_INLINE_MAX_BYTES = 5MB` / `SCAN_PARSE_MAX_BYTES = 50MB` /
  `SCAN_HEAVY_CONCURRENCY = 3` / `SCAN_CACHE_VERSION = 2`；世界书与预设**两侧同改**；
  结果补 `size / mtime / entryCount / heavy / dataLoaded`，返回体新增 `skipped: [{path, size, reason}]`；
  渲染层 `useWorldbooks` / `usePresets` 新增 `reportSkipped`（计数 + 文件名入日志），
  侧栏新增 `wbEntryCount`（未解析时用 `entryCount`）与 `selectWorldbook`（超大书点击时 `readText` 懒加载 + 「按需」徽标）。
- **验证**：单测 `test/scanGate.test.mjs` **13 条全绿**（分级阈值 / 旧 5MB 硬丢弃已废除 / `valid:null` 不跳过 / 缓存版本失效）；
  **真实目录 + 真实 IPC 端到端**（`scripts/probes/_probe-scan-gate.mjs`，**12/12 通过**）：
  造 small.json（0MB）+ big6mb.json（**6MB**）+ notawb.json → 实测 `count=2`、`bigRecognized=true`（**旧代码会被 5MB 闸门丢弃**）、
  `bigHeavy=true`、`withSize/withMtime/withEntryCount = 2/2/2`、`skipped=[notawb.json]` 且带原因、**二次扫描（走缓存）6MB 书仍在**。
- **来源**：2026-09-21 查重链路专项排查（最终方案 §2.5）

#### DF-18 补充 · T4/T5/T6 待复核项的真实库实测结论（2026-09-21 已完成）

> 这三个是 DF-18 修复时**自认的保守估值/未验证项**（`SCAN_HEAVY_CONCURRENCY = 3` 是估值、
> 头部预检与 `entries[0]` 校验的误杀率未量）。已用**真实世界书库**（`H:\01\全局世界书`，
> 39 本 / 53.6MB，含 6 本 ≥6MB 大书）逐项实测，结论如下。

**T4 · 512KB 头部预检误杀率 → 实测 0%（无需放宽）**

- 实测（`scripts/probes/_probe-real-head-check.mjs`）：走头部预检的 **7 本**中，**6 本命中**；
  唯一「未命中」的 `双人成行v11.0—PrismFox 正式版（数据库变量版）.json`（1.28MB）
  **顶层是 `extensions.SPreset`（酒馆预设），全文不含 `"entries"` 字段** → 属**正确拒绝**，不是误杀。
- 36 本中全部文件的 `entries` 起始偏移均为 **0KB**（即 `entries` 都在文件最前），
  远小于 64KB 头窗。**结论：真实库误杀率 0%，头部预检维持现状**。
- ⚠️ 但边界条件仍然存在（构造实验证实）：若某书把 ≥0.5MB 的大段元数据排在 `entries` **之前**，
  就会被挤出 64KB 头窗而被跳过。属**已知边界**，不再放宽（放宽会把「非世界书大 JSON」重新放进来 parse）。

**T5 · `isValidWorldbook` 只看 `entries[0]` → 实测 0 例静默拒绝（无需修改）**

- 实测（`scripts/probes/_probe-real-validity.mjs`）：36 本中现行判定拒绝 **4 本**，逐一取证后
  **全部是「无 `entries` 字段」的非世界书**（4 本顶层为 `color/disableSend/idIndex/injectInput/qrList`
  —— **快捷回复 QR 配置**）→ 属**正确拒绝**。
- **没有一本**因 `entries[0]` 是 `null` / 非词条对象而被拒。字典形态（V2 老格式）**31 本全部正确转换通过**。
- 对照实验：候选修法「扫前 20 条任一命中即接受」**多救回 0 本** → 改它无收益。
  **结论：维持只看 `entries[0]`**（成本最低，真实库未复现该缺陷）。

**T6 · 分级扫描并发参数 → 常规档 32 维持；大文件档 3 → 下调为 2**

- 实测（`scripts/probes/_probe-heavy-concurrency.mjs`，真实库 6 本大书 / 49.2MB）：

  | 并发 | 耗时 | 堆峰值增量 |
  |---|---|---|
  | 1 | 219ms | 74.4MB |
  | **2** | 191ms | **58.7MB** ← 内存最低 |
  | 3（原生产值） | 190ms | 118.1MB |
  | 6 | 189ms | 146.1MB |
  | 12 | 184ms | 117.7MB |

  并发 2→12 耗时仅改善 **3%**，但内存增量从 59MB 涨到 **118~146MB**。
  **瓶颈在磁盘 I/O 与 `JSON.parse`，不在并发度** —— 提高并发只是白吃内存。
  → **`SCAN_HEAVY_CONCURRENCY` 由 3 下调为 2**（内存减半，速度无损）。
- 常规档（放大到 240 本 / 25.2MB 才有统计意义）：

  | 批次并发 | 耗时 | 堆峰值增量 |
  |---|---|---|
  | 4 | 185ms | 22.3MB |
  | 8 | 160ms | 26.4MB |
  | 16 | 157ms | 25.9MB |
  | **32（生产值）** | 154ms | 26.8MB |
  | 64 | 152ms | **44.3MB** |

  拐点在 16~32，32 仍在合理区间；64 时内存近翻倍却只快 2ms。
  → **`SCAN_JSON_BATCH = 32` 维持不动**（已在拐点内，无需调整）。
- ⚠️ **探针本身踩过的坑（记录下来避免复现）**：首版用 `readFileSync` + `Promise.all`
  包同步函数 → async 函数体内无 `await`，body 同步跑完 → **实际是串行执行**，
  于是所有并发档位耗时几乎相同（244~262ms），数据「看起来很稳」但**完全没测到并发**。
  改用 `fs.promises.*` 后并发才真正生效（耗时开始有区分、内存随并发上升）。
  **教训：测并发必须确认被测函数真异步，否则测的是假象。**

### DF-19 ｜ 🟡 差异弹窗用 `Array.isArray(entries)` 判世界书 → 字典形态（V2 老格式）会被判成**角色卡**
- **现象**（2026-09-21 排查）：若世界书的 `entries` 是对象字典形态（`{"0":{...},"1":{...}}`，见 [DF-02](#df-02--世界书-entries-是对象字典v2-老格式)）走到差异比对，
  会被判成**角色卡** → 走角色卡字段比对（`description` / `personality` 等全为空）→ **显示「✅ 设定完全一致」**。
  这是**比崩溃更隐蔽的错**：不报错，但**结论是反的**（两本书明明不同却说一致），可能让人误删正确版本。
- **根因**：`js/composables/useDedupe.js` 的 `openDiffDetailModal` 判定世界书用
  `!!(masterItem.data && Array.isArray(masterItem.data.entries))`，而 `isValidWorldbook`（`main.js`）**明确兼容**字典形态。
- **现状定性（重要，避免过度投入）**：**当前不是活路径** —— `isValidWorldbook` 在**第 3 步原地** `Object.values()` 归一化，
  返回的 `data.entries` **已是数组**；启动入口、网址导入、文件夹导入也都洗过；内容级查重的世界书源就是 `worldbooks.value`（已洗净）。
  所以**无法自然构造复现**，只能人工注入对象。
- **修复**：`isWorldbook` 判定前先做一次归一化（`entries` 非数组则 `Object.values()`），定位为**顺手加固**——
  防未来新增入口绕过上游清洗，**不投入验收资源**。
  > ✅ 2026-09-21 已实施：判定改为 `hasEntriesShape`（`entries` 为任意对象即认世界书，含字典形态），
  > 取词条时统一走 `normalizeEntries()`；已在 `useDedupe.js` 的 `openDiffDetailModal` 落地，单测覆盖字典形态（`{'0':..., '1':...}`）。
- **防再犯**：**判定"是不是某类数据"时，用与校验函数同口径的判据**——`main.js` 的 `isValidWorldbook` 认字典形态，
  消费端却用 `Array.isArray` 判，两处口径不一致就是隐患；共用 `extractBookEntries` 一类的全形态提取器可根治。
- **来源**：2026-09-21 查重链路专项排查（最终方案 §2.4）

### DF-20 ｜ 🔴 世界书懒加载**从未成功过**：把 `readText` 的返回体当字符串 parse- **现象**（2026-09-22 压测中暴露）：世界书大库（501 本 / 5000 本）下**疯狂弹错误框**，
  文案为「读取世界书正文失败：`"[object Object]" is not valid JSON`」。
- **根因**：`preload.js` 暴露的 `file:readText` 返回的是**对象** `{ success: true, text }`，
  而 `js/composables/useWorldbooks.js` 的 `ensureWorldbookLoaded` 写成
  `const text = await window.electronAPI.readText(wb.path); const parsed = JSON.parse(text);`
  → 把**整个返回对象**喂给 `JSON.parse` → 抛 `"[object Object]" is not valid JSON`。
  **该函数自 DF-18 引入以来就一直是坏的**（`JSON.parse(对象)` 必抛），
  只是因为 PK-20 之前「懒加载」仅在 >50MB 的超大书上触发，**几乎没人踩到**；
  PK-20 引入累计内联预算后**大量书转为懒加载**（501 本里 445 本），缺陷才集中爆发。
- **⚠️ 一度走错的路（必须记录）**：我最初把它当成「批量场景噪音」，给 `ensureWorldbookLoaded`
  加 `silent` 开关把弹框**盖掉**（连同 dedupe 批量扫描一起静默）。用户当场批评：
  > 「静默模式，批量操作时不弹框，这是错误操作，不应该找出错误解决么，这是典型头疼捂嘴、脚疼捂嘴的行为」

  **教训**：**报错是排查线索，掩盖它等于把可诊断的故障变成不可诊断的故障。**
  `silent` 唯一合法的用途是「批量场景下**避免逐本弹框淹没界面**」，
  且必须**汇总提示真因**（一次弹框 + 日志列出失败文件），不能变成「假装没发生」。
  事实上真因被找出来后，这个缺陷**根本不需要 silent 掩盖** —— 修好就没有失败。
- **修复**（2026-09-22）：严格校验返回体形状后再 parse，并把失败原因挂到条目上供调用方汇总：
  ```js
  const res = await window.electronAPI.readText(wb.path);
  if (!res || !res.success || typeof res.text !== 'string') {
      throw new Error((res && res.error) || '读取返回体异常');
  }
  const parsed = JSON.parse(res.text);
  ```
  失败时 `wb._loadError = e.message`（调用方可据此汇总），单本操作**照常弹框**。
- **防再犯**：**凡是「预加载/封装过」的 API，必须核对它的真实返回形状**——
  `readText` / `readJSON` / `saveJSON` 这类封装过的通道，返回值**不再是裸数据**，
  但直觉上很容易当裸数据用（本项目里 `readText` 返回 `{success,text}`、`saveJSON` 返回 `{success,path}`）。
  同时：**同类 IPC 的返回形状要统一**，避免有的返回裸值、有的返回包装对象。
- **验证**：`scripts/probes/_probe-readtext-error.mjs`（真实启动 + 真实大库，修复后 `after: true`、`loadError: null`）；
  5000 本压测中 `_loadError` 计数为 0。
- **来源**：2026-09-22 世界书 5000 本极端压力测试专项

### DF-22 ｜ 🟡 JPEG 角色卡「导入能进、扫描不进」的不一致- **现象**：用户把 `.jpg` / `.jpeg` 角色卡放进库目录 → **「打开目录」看不到它们**（库不加载），
  但用**导入对话框**选同一个文件却能**成功导入** ⇒ 同一份数据两条路径行为相反，用户以为「丢卡了」。
- **根因**：**两处白名单不一致**（与 [DF-17](#df-17--世界书差异比对用拼接大字符串--词条无稳定主键--看不出哪个词条被增删) / [DF-19](#df-19--差异弹窗用-arrayisarrayentries-判世界书--字典形态v2-老格式会被判成角色卡) 同型的**口径不一致**）：

  | 位置 | 声明/行为 |
  |---|---|
  | `js/components/HeaderBar.vue`（导入对话框） | `accept=".png,.webp,.jpg,.jpeg,.json"` ← **声明支持 JPEG** |
  | `js/utils/cardLoader.js`（`processFile` 注释） | 「用户选择的文件（.json / .png / .webp / .jpeg / .jpg）」 |
  | `main.js`（磁盘扫描，**两处**） | `if (ext !== '.png' && ext !== '.webp' && ext !== '.json') continue` ← **跳过 JPEG** |

  ⇒ 导入走的是「用户已选定文件 → 深度扫描内嵌 JSON」，与扩展名无关（JPEG 卡确实能导入成功）；
  而磁盘扫描**先按扩展名过滤**，JPEG 在第一步就被丢掉。
- **修复（二选一，⏳ 待拍板）**：
  ① 扫描白名单补 `.jpg` / `.jpeg` —— 需一并评估「目录里的普通照片会被深度扫描」的代价与假阳性风险（可能要接 `useSizeFilter`）；
  ② 从导入对话框移除 `.jpg` / `.jpeg`（明确不支持）。
- **⚠️ 影响面实测**：真实卡库 43 张 PNG + 2 张 JSON，**0 张 JPEG** ⇒ 实际影响面小，
  但「**声明支持却静默跳过**」本身是缺陷（用户无法察觉）。
- **✅ 修复（2026-09-24，选方案 ②，理由见下）**：新增 **`main/cardFormats.json`（唯一权威格式表）**
  + `main/cardFormats.js`（CJS 封装，供 `main.js`）；`main.js` 两处扫描白名单改走 `isScannable(ext)`，
  `HeaderBar.vue` 的 `accept` 改为绑定 `:accept="importAccept"`（**由格式表派生**），
  渲染层经 **JSON** 导入（非 CJS，避免 Vite 转换风险）。守卫：`test/cardFormats.test.mjs`（**10 条**，含**源码级**断言三处入口同源）。
- **🔑 为什么选 ② 而不是 ①（本次排查的关键发现）**：
  `main.js` 的 `file:saveCard` **只支持 `.json` / `.png`**（源码原话：「仅支持 .json / .png 卡片，**webp 无法回写数据**」）⇒
  **JPEG / WebP 卡无法把「标签 / 分类 / 编辑」写回文件**。
  若把 JPEG 加进扫描白名单，只是**把「静默不落盘」的陷阱扩大到更多文件类型** ——
  正确方向是**收敛到「可读且可写」的格式**，而不是扩大「只能读」的格式。
  > 📌 三个能力维度必须区分：**可扫描**（进库）/ **可读内嵌**（解析）/ **可写回**（持久化）。
  > 本项目历史上把它们混为一谈（`accept` 只按「能解析」写）—— 这正是 DF-22 的土壤。
- **防再犯**：**「能不能处理某类文件」只能有一个权威定义** ——
  已收敛为 `main/cardFormats.json`，**任何新增/修改格式能力都只改这一个文件**
  （单测会校验 `main.js` 无写死白名单、`HeaderBar.vue` 无手写 accept、渲染层读 JSON 而非 CJS）。
- **来源**：2026-09-23 排查「角色卡与预设查重方案」时发现的**独立缺陷**（与该方案无关）

### DF-25 ｜ 🟡 WebP / JPEG 卡**内容编辑不落盘**被**静默吞掉**（DF-22 的连带发现）
- **⚠️ 现象核实修正（2026-09-24 二次核查，避免过度描述）**：
  初判时写「改标签/分类后重启就没了」—— **这是错的**。逐行核实 `useCardCrud.js` 后确认：
  | 改动类型 | 是否丢失 | 依据 |
  |---|---|---|
  | **标签 / 分类** | ❌ **不丢** | 覆盖层兜底：`persistCardCategory` / `persistCardUpdate` 写 `appConfig.cardOverlays[path]`，由 `useConfigPersistence` **持久化到 `app_config.json`**；重扫时 `processAutoTagsAndCategory` 按 path 恢复 |
  | **卡片内容编辑**（描述 / 人格 / 场景 / 开场白 / 内嵌世界书 / 正则…） | ✅ **确实丢** | 覆盖层**只管 category + tags**，内容不在其中 |
  | 静默性 | ✅ **真的静默** | 保存失败时用户看不到任何提示 |
- **根因**（两层，与 DF-20「头疼捂嘴」同型）：
  ① `main.js` 的 `file:saveCard` 对非 `.json`/`.png` 返回
  `{ success:false, error: '…webp 无法回写数据' }` —— **主进程如实报错了**；
  ② 但**调用方不判 `success`**（`try/catch` 只能接住抛错，接不住 `success:false`）：
  ```js
  // useCardCrud.js：自动打标后台落盘（flushDeferredAutoTagSaves）
  const saveRes = await window.electronAPI.saveCard(...);
  if (saveRes && saveRes.success && saveRes.mtime) cardInfo._mtime = saveRes.mtime;
  //                    ↑ success:false 时**什么都不做**（既不提示也不记录）
  ```
  ⇒ 用户视角是「**改了内容、看起来生效了、重启就还原**」，且**全程无提示**。
- **影响面**：真实卡库 **0 张 JPEG**；WebP 数量未统计（历史遗留格式，真实库可能有）。
- **✅ 修复（2026-09-24，**真修复：保存时自动升级为 PNG**）**：
  | # | 改动 | 文件 |
  |---|---|---|
  | 1 | 🔑 **`file:saveCard` 新增 `.webp` 分支：转 PNG 后写入内容**（原图无损转码 + 内嵌卡数据 + 写前校验 + 快照备份 + 原子写 + 删旧文件），返回 `{ newPath, converted:true }` | `main.js` |
  | 2 | 渲染层**同步 `path` 及所有按 path 派生的键**（覆盖层 / 导入时间 / 聊天键）—— 磁盘文件换名了，不同步就会「下次保存指向已删文件」+「标签看起来丢了」 | `App.vue` |
  | 3 | 统一写盘结果处理 `applySaveResult()`（回写 mtime/size + 转换提示） | `useCardCrud.js` |
  | 4 | 保存失败**按原因分桶汇总提示**（每会话每桶一次，不刷屏）+ 编辑器横幅（仅对**真不可保存**的格式） | `useCardCrud.js` / `EditorPanel.vue` |

  ### 🔑 为什么「转 PNG」是正确的，而不是权宜之计
  **SillyTavern 自己就是这么做的**（本次核查 ST 源码坐实）：
  · `src/character-card-parser.js` 的 `write()` —— 把卡数据写进 **PNG tEXt 块**；
  · `src/endpoints/characters.js` 的 `writeCharacterData()` —— 输出路径**硬编码 `` `${outputFile}.png` ``**
  ⇒ **酒馆保存任何卡都会产出 PNG**。本项目与之对齐，用户**不需要自己转格式**。
  > 📌 反面教训（本次走错的弯路，记下来）：初版方案是「**拒绝保存 + 提示用户自己用换卡图转格式**」——
  > 用户当场指出「**我们无法强迫用户，只能适应适配**」。核查 ST 源码后发现，
  > **转格式本来就是酒馆的原生行为**，方案 ③ 其实是**把项目的能力缺陷转嫁给用户**。

- **验证**：`scripts/probes/_probe-webp-save-upgrade.mjs`（**端到端真实**，非模拟）——
  用 `sharp` 真造 WebP 卡 → 走 `main.js` 的转换逻辑（**从源码提取函数体，与线上同一份实现**）
  → 读回断言。实测 **5/5 全过**：
  ```text
  ✅ 读回角色名正确
  ✅ 读回编辑后的描述        ← DF-25 的核心（旧实现这一项必然失败）
  ✅ 读回编辑后的内嵌世界书词条
  ✅ 旧 .webp 已删除（不留重复卡）
  ✅ 产物是合法 PNG
  ```
  单测：`test/cardFormats.test.mjs`（**16 条**，含「WebP 必须可保存」的契约断言）。
  ⚠️ 转换依赖 `sharp`（可选依赖，实测 0.35.3 可用）；缺失时给出**可操作的**提示（提示执行 `npm install sharp`），**不静默**。
- **防再犯**：**「写入型 IPC」的返回值必须判 `success`** —— `saveCard` / `saveJSON` 都返回包装对象
  `{success, error}`，`try/catch` 包住**不够**（它不抛错，只是 `success:false`）。
  ⚠️ **转换类操作返回 `newPath` 时，调用方必须同步所有按 path 派生的键**（本项目铁律 6）。
- **来源**：2026-09-24 排查 DF-22（JPEG 支持不一致）时发现，同日二次核查修正现象描述，同日真修复

### DF-23 ｜ 🔴 角色卡查重**忽略 71.7% 文本**（`character_book` 80% 的卡都有却 0 参与）
- **现象**（2026-09-23 采纳「角色卡跨版本查重方案」评估时坐实）：**两版设定几乎相同、只是正文长在内嵌世界书里**的卡
  **完全查不出来**；而 `alternate_greetings` / `creator_notes` 里的差异也一律看不见。
- **根因**：`useDedupe.js` 的 `extractContentText`「角色卡」分支**只取 5 个字段**
  （`description` / `personality` / `scenario` / `first_mes` / `mes_example`）。
  真实库字段填充率实测（`_probe-card-versions.mjs`，45 张卡）：

  | 字段 | 填充率 | 是否参与（修复前） |
  |---|---|---|
  | `description` / `first_mes` / `scenario` / `mes_example` / `personality` | 21~38 / 45 | ✅ |
  | **`character_book`** | **36/45（80%）** | ❌ **完全忽略** |
  | `creator_notes` | 15/45（33%） | ❌ |
  | `alternate_greetings` | 13/45（29%） | ❌ |
  | `system_prompt` / `post_history_instructions` | 各 2/45（4.4%） | ❌ |

  ```text
  当前查重用（5 字段）： 30,958 字符  (28.3%)
  被忽略（5 字段）：    130,167 字符  (71.7%)
  ```
  > 本次用真实卡复核更极端（`鬼.png`）：5 字段 **1,049** 字符 vs `character_book` 79 条 **71,500** 字符 ⇒ **忽略 98.6%**。
- **修复**（2026-09-23）：
  ① 纳入 `character_book` 词条（`keys` + `content`，**与独立世界书分支同口径**）；
  ② 纳入 `alternate_greetings` / `creator_notes` / `system_prompt` / `post_history_instructions`；
  ③ 内嵌世界书走 **`extractBookEntries`** 全形态提取器（数组 / `entries` 数组 / `entries` 字典）——**不得**用 `Array.isArray(entries)`（DF-19 的教训）。
- **🛑 必要配套（不加会引入两个新缺陷，实测踩到）**：
  | 风险 | 实测证据 | 配套修法 |
  |---|---|---|
  | **AR-48 阈值作废 → 误报** | 文本量级 ×26 ⇒ simhash 距离整体压缩：无关对 **30 → 20~23**，落进 `NAME_ONLY_MAX_DIST=24` 内（真实 Jaccard 仅 1.6%） | 「同名假阳性防护」**刻意保留 5 字段口径**（新增 `extractLegacyCardText`），保住 AR-48 用真实库 3907 张标定的 T=24 |
  | **稀释 → 漏报** | `鬼.png` ↔ `鬼1.png`（真实同源改版）：5 字段 100% → 全字段 **67.7%**，低于 0.85 闸门 | 闸门改**双口径 OR**：`全字段 ≥0.85 或 5 字段 ≥0.85`（同时覆盖「仅世界书不同」与「正文版本迭代」） |
  | **🛑 比对器口径落后 → 「无差异却判重复」**（2026-09-24 补，P1-6） | 查重纳入了世界书，但**差异比对器仍只看 5 个字段** ⇒ 用户点「查看差异」看到「✅ 设定完全一致」，而查重却说重复 ⇒ **一键误删** | 比对字段与查重字段**一一对齐**：新增 `creator_notes` / `system_prompt` / `post_history_instructions` 三行 + 「🎁 备用开场白」行 + 「📚 内嵌世界书」**按词条逐条比对**（复用 `alignEntryLists`，与世界书侧同一套「新增/缺失/改动」语义） |
- **验证**：`test/cardDedupeFields.test.mjs`（**15 条**）+ `test/dedupeDiffConsistency.test.mjs`（**7 条**，锁死「**比对字段 ⊇ 查重字段**」不变式）覆盖字段覆盖 / 三种世界书形态 / V1 与 V3 口径一致 / 真实卡回归 / 稀释效应实证 / 双口径 OR 闸门 / 比对口径一致性。
  真实卡实测（4 张，双口径 OR 闸门 vs 真值 **6/6 一致**）：
  ```text
  角色卡示例 ↔ 鬼      全字段 1.0%（真 1.6%）  5字段 0.0%  → 无关 ✅
  角色卡示例 ↔ 头像    全字段 97.9%（真 99.2%）5字段 100%  → 同源 ✅
  鬼        ↔ 鬼1     全字段 64.6%（真 67.7%）5字段 100%  → 同源 ✅（单口径会漏报）
  ```
- **防再犯**：**「扩大数据覆盖」与「阈值标定」是一对** —— 口径一变，阈值必须重标（PK-29 同型病：
  用合成样本定 T=19，真实库误报 10/18）。本次因真实库未挂载（仅 4 张卡）**无法重标**，
  故采用「**保留旧口径做 OR 兜底**」而非「直接改阈值」——旧口径的标定证据不失效。
- **来源**：2026-09-23「角色卡与预设查重方案」评估（[`../规格与计划/查重引擎/角色卡与预设查重-方案评估.md`](../规格与计划/查重引擎/角色卡与预设查重-方案评估.md) §三 P0-1 / P0-2）

### DF-24 ｜ 🔴 预设查重**只按名称聚类** → 「改名同源」完全漏报 + 三处形态/口径缺陷
- **现象**：两个**结构 99.3% 相同**（同一预设的改版）的预设，只因**文件名/名称不同**，
  查重结果里**完全不出现**（用户以为库里没有重复预设）。
- **根因**（`useDedupe.js` 的 `startPresetDedupeScan`，共 **4 处**）：

  | # | 缺陷 | 证据 | 后果 |
  |---|---|---|---|
  | 1 | 🔴 **只按 `data.name`（兜底文件名）聚类** | `A.U.T.O.预设 v1.0.json` ↔ `万象枢机 2.5.json` **文件名完全不同**，但 identifier 结构 Jaccard = **99.3%**（正文 840KB vs 2.66MB） | **改名同源完全漏报**（本缺陷的核心） |
  | 2 | 🟡 `extractContentText` 预设分支 **数组/对象判断写反** | 真实库预设 `prompts` **是数组**，但代码先判 `typeof === 'object'`（数组也是 object）→ 走对象分支 → `String(块对象)` = **`"[object Object]"`** | 预设内容文本**全是垃圾**，内容相似度恒虚高 |
  | 3 | 🟡 `getPresetFingerprint` **只处理对象形态** | 同上：数组形态下每个块都退化成 `"[object Object]"` | 「参数内容完全一致」判定**恒真** |
  | 4 | 🟡 `prompt_order` 的 `character_id` 假设单一值 | 真实库 **`100000` 与 `100001` 并存**（2 组 / 5 组）；方案写 `100000`、`parsecard` 常量是 `100001` | 按任一常量写死都会漏掉另一部分 |

- **修复**（2026-09-23）：
  ① 新增 `js/utils/presetStructure.js`（纯函数）：**结构指纹**（`identifier` 集合 Jaccard）
  + 内容（按块长度加权的逐块 4-gram Jaccard）+ 顺序（`prompt_order` 上的 Kendall tau）
  + **启用状态一致性**（`enabledAgreement`，★ P1-5）+ 采样参数一致性；
  ② 聚类改为**结构指纹 + 簇心校验**（`unionFindGated`，**不得**用连通分量 —— PK-29 刚修掉的病根），
  同名的、结构不相似的**仍保留列出**但标成「同名但无关」（避免功能回退）；
  ③ 数组/对象两种 `prompts` 形态**都兼容**（`buildPresetStructure`）；
  ④ `pickOrderGroup` 取「**覆盖度最高**的 order 组」，**不写死 `character_id`**。
- **★ P1-5 补充（2026-09-24）**：新增第 5 个维度 **`enabledAgreement`**（块开关一致性）+
  第 7 种类型 **`FLIPPED`（🎛️ 启用状态不同）**。
  为什么必须单独一维：两份预设可能**块集合完全相同、正文完全相同**，但同一个「破限块」
  A 里开、B 里关 ⇒ **注入到提示词里的内容不同 ⇒ 实际行为不同**，不能当「完全重复」清理。
  ⇒ 判定顺序改为「危险度从低到高」：**只有五维全一致才算「完全重复」**，任一维不同即降级。
- **★ 第 5 处缺陷（2026-09-24 顺带发现）**：**差异比对器**的 `formatPrompts` 也踩了同一个数组坑 ——
  `prompts` 是**块对象数组**时 `join('\n')` 会对每块调 `toString()` ⇒ 显示 **`[object Object]`**。
  修：逐块输出「`块标识 + （已禁用标记）+ 正文`」的形式（真实库预设一直是数组 ⇒ 该分支**一直在显示垃圾**）。
- **⚠️ 阈值状态**：`PRESET_STRUCT_THRESHOLD` 等**均为方案经验值、未标定**（真实库仅 **5 个 OpenAI 预设 / 1 对同源**，
  样本量不足以标定 3 权重 + 4 阈值 —— 必然过拟合，同 PK-29 的教训）。
  🎚️ **2026-09-24 已拍板取「保守档」**（**宁可漏报，绝不误报**）—— 理由：本弹窗按钮是「保留此版，清理其余」，
  **误报 = 一键误删真数据**；漏报只是「没查出来」，用户没有损失。
  故在**没有真实标定数据**的前提下，只能选「错也错在安全一侧」的档位：

  | 常量 | 方案经验值 | **保守档（当前）** |
  |---|---|---|
  | `STRUCT_HIGH` / `PRESET_CLUSTER_THRESHOLD` | 0.90 | **0.95** |
  | `CONTENT_HIGH` | 0.85 | **0.90** |
  | `CONTENT_LOW` | 0.60 | **0.70** |

  🧲 **聚类阈值已收敛为单一来源**（`PRESET_CLUSTER_THRESHOLD`，`useDedupe.js` 从这里 import）——
  旧实现把它**写死在 `useDedupe.js`**，与 `STRUCT_HIGH` 各存一份 ⇒ 两处阈值会各自漂移。
- **📊 标定结果（2026-09-24，`_probe-preset-threshold-calib.mjs`）**：
  本机真实预设库**为空**（全机搜索仅 2 个 0KB 测试文件）⇒ 用
  `scripts/tools/make-preset-lib.mjs` 造**带真值的合成样本库**（11 对同源 + 3 对无关，
  覆盖 exact / renamed / reskin×4 / trimmed / extended / reorder / flipped / sampler /
  unrelated / sameNameOnly / sharedSkeleton）做阈值网格扫描。实测：

  ```text
  结构阈值 0.95 → TP=11 / FN=0 / FP=0 / TN=3   （零误报零漏报）
  无关对最高结构相似度 13.0%  ｜  同源对最低 100%  ⇒  分离间隙 0.87
  类型判定端到端 14/14 与真值一致
  ```

  > ⚠️ **诚实声明（不得省略）**：以上是**合成样本**标定，文本分布 ≠ 真实预设
  > （真实库 118~261 块、正文可达 MB、中英混排）。只证明「**算法判别力**在已知差异类型上成立」，
  > **不能**替代真实库标定（PK-29 的教训：合成样本定的 T=19 在真实库误报 10/18）。
  > 待真实预设库积累到 **20+ OpenAI 预设 / 10+ 对同源**后重跑标定脚本（无需改代码，只改常量）。
- **🛑 标定过程暴露的**新缺陷**（同类，已修）**：**内容相似度被「骨架块」虚高到 100%**。
  `contentSimilarity` 旧实现**只累加共有块** ⇒ **缺失的块完全不拉低相似度**；
  而真实预设里 **12 个「骨架块」**（`main`/`jailbreak`/`charDescription`…，实测「出现在全部 5 个预设中」）
  **正文天然完全相同** ⇒ **两个毫不相干的预设也会算出内容相似度 = 100%**！
  后果：`classifyPresetSimilarity` 的 `sLow && cLow` 分支要求 c 低 —— 而 c 虚高到 1.0
  ⇒ 无关对**落进 `else` 被误判为「🔍 高度相似」**（而不是「⚠️ 名称相同但无关」）
  ⇒ **最危险的一类误判**（弹窗按钮是「保留此版，清理其余」）。
  ✅ 修：改为 **Jaccard 语义**（分母含单侧独有块）：
  `num = Σ_{共有} min(|a|,|b|) × jaccard` ｜ `den = Σ_{共有} min(|a|,|b|) + Σ_{仅A} |a| + Σ_{仅B} |b|`。
  📊 实测：无关对内容相似度 **100.0% → 6.1%**（同源对不受影响，仍 ≥89%）。
  > 📌 **这是「合成样本标定」的真正价值** —— 它不是在验证已知结论，而是**逼出了真缺陷**：
  > 骨架块这个干扰项在「只累加共有块」的实现下**必然**把无关对推到 100%，
  > 而真实库的 5 个预设样本量太小、又恰好都有大量自定义块 ⇒ **掩盖了这个 bug**。
- **验证**：`test/presetStructure.test.mjs`（**37 条**）覆盖两种形态、**五维**相似度、**7 种**类型判定边界、
  保守档阈值契约、**骨架块虚高的回归断言**（含「无关对必须判 DIFFERENT」的后果级验证）、
  「改名同源」标注、`character_id` 不写死、保守档阈值契约、**「只产出标签不决定分组」的契约断言**。
- **防再犯**：**聚类键要选「语义稳定的量」，不要选「用户可随意改的标签」** ——
  名称/文件名是用户可随意改的，用它聚类必然漏报；而 `identifier` 集合是预设的**功能结构**，改名的改版仍保留它。
- **来源**：2026-09-23「角色卡与预设查重方案」评估（[`../规格与计划/查重引擎/角色卡与预设查重-方案评估.md`](../规格与计划/查重引擎/角色卡与预设查重-方案评估.md) §三 P0-3）

### DF-26 ｜ 🟡 世界书分组**缺用户输入碰撞防护** → 建同名分组会让筛选**静默失效**
- **现象**：用户在世界书库建一个名叫 **「全部」** 的分组，把书移进去后 ——
  点「🌍 全部」按钮**看不出任何区别**（列表不变），而点那个自定义的「全部」分组也**筛不出东西**。
  全程**无任何提示**，用户以为「分组功能坏了」。
- **根因**：`'全部'` 是**视图哨兵**（表示"不按分组过滤"），而筛选代码是
  `if (currentWbCategory.value !== '全部') { 按分组过滤 }` ⇒
  用户建的同名分组**永远进不了过滤分支** ⇒ 该组筛选**完全失效且无法察觉**。
  > 📌 这是**哨兵值与用户输入命名空间冲突**的典型缺陷（规格 §三-2 决策点正是问这个）。
  > ⚠️ 规格原方案用 `__` 前缀做保留名 —— **拦不住存量中文名**（用户已经建了「全部」也不会被清理）。
- **✅ 修复（2026-09-24，A2 落地，`RFC-20260921-WB-TAGS-02`）**：
  新增 `js/utils/wbGroupsTags.js` 纯函数层，`validateWbCategoryName()` 做**碰撞防护**：
  · **「全部」→ 拦下**（并给出可理解的原因：「这是本应用保留的**视图名称**，不能用作分组名」）；
  · **「默认」→ 放行**（语义 = 移出分组，是合法目标）；
  · **与已存在分组重名 → 拦下**（除「改成自己」的幂等场景）；
  · 空名 / 纯空白 → 拦下。
  接线点：`useWorldbooks.changeWbCategory`（单本移组）与新增的 `renameWbGroup`（整组改名）。
  同时 `wbCategories` 计算属性**剔除「全部」**（它不该出现在分组列表里）。
- **同批落地的其他能力**（同一规格，决策见下）：
  | 能力 | 说明 |
  |---|---|
  | **世界书标签**（新增） | 存**配置层** `wbTagMap`（与 `wbCategoryMap` 同源），支持切换/批量加/频次统计 |
  | **复合过滤**（新增） | 分组 + 标签（**AND**）+ 搜索 + 词条数档 → 抽为纯函数 `matchWbFilter`（可单测） |
  | **分组生命周期**（补入口） | `renameWbGroup`（整组改名）/ `deleteWbGroup`（解散回「默认」，**不删书**）—— 级联逻辑早已存在，缺的只是显式入口 |
- **📌 三个已拍板的决策（2026-09-24，用户明确选择）**：
  | 决策 | 选择 | 后果 |
  |---|---|---|
  | **元数据存哪（SSOT）** | **只留在配置文件**（`wbCategoryMap` + 新增 `wbTagMap`） | 零风险：**不动用户文件、不产快照、不碰第三方格式**；⚠️ 代价 = 换机 / 库外复制**不随书走** |
  | **哨兵值** | **保持中文「全部」「默认」** + 补碰撞防护 | 存量用户分组名不受影响 |
  | **标签口径** | **角色卡随卡片走**（现状）；**独立世界书留系统配置** | 两套口径**刻意并存**（见 `wbGroupsTags.js` 文件头） |
- **⚠️ 与原方案的偏差（避免日后按原方案「修复」回去）**：原方案要
  ① 新建 `saveWorldbooksMeta` IPC；② 把标签写进 `extensions.jskzx`；
  ③ 用英文哨兵 `__all__` / `__ungrouped__`；④ 改 `useSearch.js` 强化世界书检索。
  ⇒ 决策后**① ② ③ 全部不需要**（不写文件 ⇒ 无 IPC、无快照、无第三方格式风险）；
  ④ 原方案**改错了模块**（世界书检索在 `useWorldbooks.filteredWorldbooks`，
  `useSearch.js` + `searchIndex` 只服务角色卡库）—— 本次未做检索索引化（规格列为待实测项）。
- **验证**：`test/wbGroupsTags.test.mjs`（**15 条**）覆盖哨兵常量、规范化、**碰撞防护**（「全部」拦下 /
  「默认」放行 / 重名拦下 / 幂等）、标签去重（规格 TC-WB-02）、频次统计、
  **复合过滤 AND 语义**（规格 TC-WB-05）、脏输入不崩。`npm test` **681 pass / 0 fail**。
- **防再犯**：**哨兵值必须与用户输入命名空间隔离，或至少做输入校验** ——
  用「魔法字符串」当状态标记时，一定要问「用户能不能输入同样的字符串」。
- **来源**：`RFC-20260921-WB-TAGS-02`（规格落档 `docs/规格与计划/世界书大库/世界书库分组与标签-实现规格.md`，
  含 11 处取证修正），2026-09-24 用户拍板三决策后实施

---

### DF-27 ｜ 🔴 查重清理：白名单外路径被回收站接口**静默跳过** → **幽灵移除**（内存删了、磁盘还在）

- **现象**：查重清理时对**未授权目录**（例：应用重启后授权失效、或目录本就不在白名单）执行
  「移入回收站」——UI 显示「✅ 清理成功」，卡片**从列表消失**；**但磁盘文件原封不动**。
  重启应用后卡片「复活」，用户无法理解「为什么没删掉却显示成功」。
- **根因**：两层错误叠加——
  ① `main.js` 的 `sys:trashFiles` 对 `isPathAllowed()` 不通过的路径 **`continue` 跳过**，
     且跳过**不计入 `failed`**（返回 `count:0, failed:[]`）⇒ 汇总为 `{success:true}`；
  ② `useDedupe.resolveGeneric` 以「不在 `failed` 列表」推导成功集合 ⇒
     把「从未被处理的路径」**当成已删除**，从 `library/worldbooks/presets` 中移除 → **内存/磁盘不一致**。
- **✅ 修复（2026-09-25，v4-P1 隔离库清理冒烟抓获）**：
  `sys:trashFiles` 对白名单外路径改为**显式失败上报**：
  `results.failed.push({ path, error: '路径不在授权范围（需在应用中先绑定该目录）' })` —— 绝不静默。
  调用方原有的「失败项保留在内存 + 汇总提示」逻辑随即可靠生效（无需改动调用方）。
- **验证**：CDP 探针 `scripts/probes/_probe-dedupe-p1.mjs` 双用例——
  ① **白名单内**（userData 隔离库）：文件移入 `jsTavern_Trash`、内存同步移除、保留版完好 ✅；
  ② **白名单外**：文件保留、内存保留、显式失败 ✅（幽灵移除回归哨兵）。
- **防再犯**：**「跳过」不是「成功」** —— 批量接口里任何 `continue`/静默过滤都必须进 `failed`（或显式
  `skipped`）报告；调用方用「成功集 = 输入 − failed」推导时，才能不把跳过当成功。
- **来源**：v4-P1 隔离库清理冒烟（2026-09-25）

---

## 五、同类缺陷全库排查结论（哪些集合安全）

> 背景：用户报「刷新/搜索时出现重复卡」，排查后确认**这类缺陷只有「卡库」一处高危**，其余集合库都由「磁盘层防覆盖」或「显式判重」保护，**不需要改**。此表用于避免**重复排查**。

| 集合 | 追加点 | 是否安全 | 依据 |
|---|---|---|---|
| **`library`（角色卡库）** | `useDiskScan.refreshLibrary` | ❌ **有真实缺口 → 已修** | [DF-08](#df-08--refreshlibrary-增量刷新缺-path-去重) |
| `library` | `parseAndAddCard` 判重 | ❌ **条件过窄 → 已修** | [DF-09](#df-09--parseandaddcard-判重条件过窄根因) |
| `worldbooks` | `useWorldbookExtras.js:88/117`、`useWorldbooks.js:146/357` | ✅ 安全 | 磁盘层 `wb:create` **文件已存在即失败**，不会 push |
| `worldbooks` | `useWorldbooks.js:255` | ✅ 安全 | 显式 `worldbooks.some(w => w.path === realPath)` 判重 |
| `worldbooks` | `useWorldbooks.js:48` + `App.vue:4290` | ✅ 安全 | 全量替换 / 用户显式点「合并」 |
| `presets` | `usePresets.js:183/260`、`usePresetStitch.js:488` | ✅ 安全 | 磁盘层 `preset:create` **文件已存在即失败** |
| `customCategories` | `useCardCrud` / `useDiskScan` / `useCardGroups` 共 9 处 | ✅ 安全 | `isCategoryKnown()` 查的是**合并后**的 `allCategories` |
| `systemCommonTags`（全局标签池） | `useTags.js:184` | ✅ 安全 | `if (val && !systemCommonTags.value.includes(val))` |
| `stitchItems`（预设缝合工作台） | `usePresetStitch.js:189/209/577` | ✅ 安全（有意为之） | 允许同 `identifier` 多次加入，靠 `refreshStitchConflicts()` 做冲突裁决 |
| `chatMessages` / `messages` / `toasts` / `diffFieldResults` | 多处 push | ✅ 不适用 | 追加型语义（消息/提示/比对结果），本就该追加 |

**设计层面的原因**：本项目有一层隐性保护 —— **「新建文件」类 IPC 都拒绝覆盖已存在文件**。
新增集合库时，只要追加点满足「磁盘层拒绝覆盖」或「入列前显式判重」任一条件，就不会出现重复项。

---

## 六、约定（本领域新代码必守）

1. **取字段一律带跨来源回退**：`comment || name`、`order ?? insertion_order`、`keys || key`、`Object.values(entries)`。
2. **新增「按 path 派生」的存储键**：路径会变（移动分组 / 重命名 / 换卡图）→ 必须同步迁移（参考 `chat/chatStorage.js` 的 `migrateChatKeys`，见 [CT-10](BUG-测卡工作区.md)）。
3. **导出/落盘前**必须清洗前端内部字段 —— 但**只能用 `main/cardFieldSanitizer.js`**，
   ⚠️ **禁止**自己写「递归剔除所有 `_` 前缀键」或「递归剔所有 `uid`」：
   第三方扩展把这两类名字当真实数据用，会**删用户数据**（见本文件 **DF-14**，实测 7 类 131 处）。
   改清洗规则前**先跑** `python scripts/tools/audit-card-underscore-fields.py <库根>` 看真实数据里有什么。
4. **扫描结果永远先判 `error`**，并且**拒绝用 0 文件结果覆盖非空库**（见 [PK-02](BUG-性能与大库.md)）。
5. **过滤临时文件**时，除自家产生的后缀，还要覆盖外部工具的 `<卡名>.<pid>.<tid>.tmp` 模式。
