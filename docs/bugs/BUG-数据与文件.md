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

### DF-21 ｜ 🔴 独立世界书的 **ST 原生 `uid` 被无条件删掉**（DF-14 的遗留待决项）

> 🛑 **状态：⏳ 修复方案待拍板（A/B/C 三选一）** —— 当前代码是「保留原有 uid」，
> 但**取证发现它引入了新问题**（调序后 uid 与下标脱钩，见文末「⚠️ 未决」）。
> **完整方案对比与建议见 [`../规格与计划/工作记录-20260923.md`](../规格与计划/工作记录-20260923.md) §二。**

- **现象**：保存独立世界书（`wb:save` / `wb:create`）后，文件里 `entries[].uid` **全部消失**。
  SillyTavern 原生格式**本该有**该字段（数字递增 `0/1/2…`）。
- **取证（2026-09-23，真实库）**：扫 `D:\TkDmGzq\_wb5k\s1000` 的 **804 个世界书 / 319,148 条词条**，
  `entries[].uid` **100% 存在且 100% 是 ST 原生数字**（`0/1/2/3…`），
  **本应用生成形态（`<时间戳>_<随机串>`）0 个**。
- **🔬 进一步取证（推翻两个直觉，很关键）**：

  | 取证项 | 结果 |
  |---|---|
  | uid 与**数组下标**的关系 | **完全相等**（6 文件 / 11,430 条 / **0 例外**） |
  | 真实库 uid 是否**恒为 `0..n-1`** | **是**（40 文件 / **0 缺失 / 0 异常 / 0 空洞**） |
  | uid 是否唯一 | 是（0 重复） |

  **⇒ ST 的 `uid` 就是「文件内顺序号」**（等价于数组下标），**可以从数组顺序重建**。
  > ⚠️ **修正一处此前的过度解读**：曾写「旧行为一直在删 ST 的真实数据」——
  > 更准确的说法是「**偏离 ST 原生格式**」，但**不是不可恢复的数据丢失**
  > （与 DF-14 那批第三方扩展的 `_filename` / `chatSheets.uid` 性质不同：那些不可推导）。
- **根因**：`WB_ENTRY_INTERNAL_FIELDS` 把 `uid` 当「纯前端 v-for key」**无条件剔除**。
  这个判断对**本应用自己生成的 uid** 成立，对 **ST 原生 uid 不成立** ——
  但两者被同一份白名单无差别处理。
- **为什么 5 个版本没人发现**（三个具体原因）：
  1. **症状不可见** —— 删掉 uid 后 ST 导入时按顺序重建，**行为一致**，用户看不出问题
     （对比 DF-14：删第三方 `_filename` 会让扩展直接坏掉，用户会报）；
  2. **看的地方不对** —— v1.8.9 的注释「SillyTavern 原生无 uid」只验证了
     **角色卡内嵌 `character_book`**（那里 ST 导出时确实不写 uid），
     而**独立世界书文件**的 `entries[]` 100% 有 uid。**同一字段名，两个位置，两种真相**；
  3. **有「看起来合理」的解释替它辩护** —— 代码注释写着「条目标识走 WeakMap，
     故删除后功能不受影响，只是 uid 不跨保存持久化（**本就无需持久化**）」。
     这句**听起来完全合理**，解释了「为什么删了没事」——
     **一旦有了合理解释，就没人再验证前提（uid 到底是谁的字段）**。
- **当前实现（⏳ 待拍板）**：按**形态**区分 ——
  1. `main/cardFieldSanitizer.js` + `js/utils/cardFields.js` 新增
     `APP_UID_RE = /^\d{13}_[a-z0-9]{4,10}$/`（本应用标准形态）与
     `APP_UID_LEGACY_RE = /^\d{13}(?=[a-z0-9]{5,10}$)(?=.*[a-z])[a-z0-9]+$/`（历史形态）+ `isAppGeneratedUid()`；
  2. `dropInternalFields` 里 **`uid` 单独处理**：**只删本应用生成形态**，
     其余（ST 数字 / UUID / 其他）**原样保留**；
     `_collapsed` / `_srcIndex` / `_srcUid` **仍无条件剔除**（它们只可能由本应用写入）。
- **⚠️ 为什么不选「一律保留 uid」**：`useWorldbookEntries.ensureUid` 会给
  **第三方导入的无 uid 词条**补一个本应用随机串 —— 那是**真正的污染**，必须能删掉。
- **⚠️ 顺带修掉一处格式漂移**：`useWorldbooks.js` 的「克隆世界书」用
  `Date.now() + Math.random().toString(36).substring(2,9)`（**字符串拼接、无下划线**），
  与其余 8 处生成点格式不一致 → 统一为本应用标准形态。
- **验证**：
  - **真实数据**（s1000 的 60 个世界书 / **46,438 条词条**）：清洗前后含 uid 词条数
    **46,438 → 46,438**（**100% 保留**）；
  - `test/cardFieldSanitizer.test.mjs` **14 → 22 例**；`npm test` **550 pass / 0 fail**；
  - **端到端**（真实 IPC `wb:save`，隔离库）：**6/6** —— `0` / `1` / `"12"` 保留、
    本应用随机串剔除、UUID 保留、`_collapsed` 剔除。
- **⚠️ 未决（当前实现引入的新问题，已实测）**：
  既然 uid = 数组下标，那「保留旧 uid」就有反向风险：

  | 操作 | 原始 uid | 保存后 uid | 与下标一致？ |
  |---|---|---|---|
  | **上移一条**（`moveEntry`，真实调序） | `[0,1,2]` | **`[2,0,1]`** | ❌ **不一致** |
  | **删除中间一条** | `[0,1,2]` | **`[0,2]`** | ❌ **有空洞** |

  ⇒ 会写出**偏离 ST 格式**（uid 与位置脱钩）的数据。
  **推荐方案 A**：保存时**按数组下标重写 uid**（`uid = i`）—— 与 ST 完全一致、
  调序/删除/新增后**始终自洽**、本应用临时 uid 自然被覆盖（可删掉形态正则那套复杂度）。
  **备选 B**：恢复原状（删除所有 uid）。**不推荐 C**（维持现状）。
- **⚠️ 教训**：**「前端内部字段」必须带**形态证据**，不能只看字段名** ——
  `uid` 这个名字两边都在用。**但光有形态分布还不够**：本次就止步于「形态取证」，
  没继续验证「**保留后会不会写出不一致的数据**」——犯了与 v1.8.9 同类的错
  （**只验证了一部分就下结论**）。
- **来源**：DF-14「遗留待决」项（2026-09-13 审计发现，2026-09-23 用户拍板处理，**方案待定**）

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
- **来源**：`docs/技术支持/代码片段-世界书条目名修复与导入.md` §一

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
- **来源**：2026-09-21 查重链路专项排查（[`../规格与计划/查重扫描与检索-最终方案.md`](../规格与计划/查重扫描与检索-最终方案.md) §2.3）

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

### DF-20 ｜ 🔴 世界书懒加载**从未成功过**：把 `readText` 的返回体当字符串 parse
- **现象**（2026-09-22 压测中暴露）：世界书大库（501 本 / 5000 本）下**疯狂弹错误框**，
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
