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

### DF-14 ｜ 🔴 卡片保存路径未清洗（DF-03 覆盖不全）+ 旧清洗规则会**误删第三方真实数据**
- **现象 A（污染）**：`App.vue` 的「从世界书库导入词条到角色卡内嵌世界书」先剔 `_`、
  紧接着又写回前端用的 `uid` 与 `_collapsed` 再 push 进卡内世界书的**活引用**；
  而卡片保存走 `getPlainCardData()`（纯 `JSON.parse(JSON.stringify(...))`，**无 replacer**）
  → 保存后 PNG 的 `chara` JSON / 卡片 `.json` / 整合包的 `worldbook.json` 里混进这两个字段。
  DF-03 只覆盖了世界书 `wb:save` / `wb:create` 两条路径，**漏了卡片侧 4 条**
  （PNG `chara` 块、卡片 `.json`、整合包 `worldbook.json`，以及**换卡图** `card:replaceImage`
  —— 后者会把内存里的 `uid`/`_collapsed` 一起嵌进新 PNG）。
- **现象 B（误删，更严重）**：DF-03 的递归前缀剔除会把第三方扩展的真实数据删掉。
  2026-09-13 用 `scripts/audit-card-underscore-fields.py` 对 11,045 张真实卡片实测：

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
  `scripts/save-strip-real-cards.mjs`（真实卡片批量离线复跑：注入污染 → 清洗 → 第三方字段 0 丢失、其余逐字段一致）；
  `scripts/save-strip-live-card.mjs` + `save-strip-live-worldbook.mjs`（**真实 IPC 落盘链路**）。
  ⚠️ 换卡图路径因需原生「选图」对话框，无法脚本化，只做代码级核对（清洗点唯一）。
- **来源**：v2.2.7 回归审计（2026-09-13）
- **遗留待决（⬜ 本次**未改**，需用户决策）**：同一审计（`scripts/audit-preset-worldbook-underscore.py`，
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
    但**改完必须重跑** `scripts/audit-preset-worldbook-underscore.py` +
    `test/cardFieldSanitizer.test.mjs`。
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
   改清洗规则前**先跑** `python scripts/audit-card-underscore-fields.py <库根>` 看真实数据里有什么。
4. **扫描结果永远先判 `error`**，并且**拒绝用 0 文件结果覆盖非空库**（见 [PK-02](BUG-性能与大库.md)）。
5. **过滤临时文件**时，除自家产生的后缀，还要覆盖外部工具的 `<卡名>.<pid>.<tid>.tmp` 模式。
