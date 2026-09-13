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
- **来源**：合集 §五 5.3

### DF-04 ｜ 🔴 用 blob URL 做图片持久地址 → 重启后破碎图标
- **修复**：图片地址统一用 `local-file://img/?path=` 永久路径；导入时必须**先把文件物理复制到库目录**再引用。
- **来源**：合集 §五 5.3；v1.6

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
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-7

---

## 二、字段口径（DF-02、DF-03、DF-05、DF-06、DF-07、DF-11）

### DF-02 ｜ 🔴 世界书 `entries` 是对象字典（V2 老格式）
- **现象**：导入含 `{"0": {...}}` 形态的卡 → **空屏崩溃**。
- **修复**：所有读取点 `Object.values` 归一化 + 脏形态兜底（`extractBookEntries` 模式）。
- **来源**：合集 §五 5.3；v1.8.4（`extractBookEntries` 脏形态全链路防御）

### DF-03 ｜ 🟡 保存/导出未剔除 `_` 前缀临时字段与 `uid`
- **现象**：导出的 JSON 里混入 `_collapsed` 等 UI 状态；SillyTavern 原生无 `uid`。
- **修复**：`JSON.stringify` replacer 双层防线，剔除 `_` 前缀字段 + `uid`。
- **来源**：合集 §五 5.3；v1.8.9

### DF-05 ｜ 🔴 分类/标签未同步写原生 `data.tags` → 重启重扫丢失
- **修复**：`persistCardUpdate` 三保险 —— 内存 + 覆盖层（`appConfig.cardOverlays[path]`）+ 写回卡片文件。
- **来源**：合集 §五 5.3

### DF-06 ｜ 🔴 内嵌世界书 vs 库世界书**字段口径不同**
| 位置 | 名字 | 触发词 | 权重 |
|---|---|---|---|
| 角色卡内嵌（V2） | `comment`（旧卡/第三方用 `name`） | `keys` / `secondary_keys` | `insertion_order` |
| 独立世界书库 | **只认 `comment`** | `key` / `keysecondary` | `order` |

- **后果**：转换时漏做映射 → 导出后条目名字/权重"消失"（见 DF-07）。
- **来源**：合集 §五 5.3、§四 2026-08-22

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
- **来源**：`docs/技术支持/代码片段-世界书条目名修复与导入.md` §一（原 `docs/history/DM-世界书条目名修复与角色卡导入.md`）

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
- **来源**：`docs/history/测试日志-2026-09-12.md` BUG-9

---

## 三、扫描与去重（DF-08、DF-09）

> 背景：用户报「搜索/刷新时角色卡库出现多个重复卡」。全库排查后结论是 —— **这类缺陷只有「卡库」一处高危**，其余集合库（世界书、预设、自定义分类、全局标签池、缝合工作台）都由「磁盘层拒绝覆盖已存在文件」或「显式判重」保护，**不需要改**。
> 完整排查表见 `docs/history/同类重复项缺陷-全库排查报告.md` §一。

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
- **来源**：`docs/history/同类重复项缺陷-全库排查报告.md` §二

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
- **来源**：`docs/history/同类重复项缺陷-全库排查报告.md` §三；`docs/history/大库重复卡-压测数据记录.md` §四

---

## 四、约定（本领域新代码必守）

1. **取字段一律带跨来源回退**：`comment || name`、`order ?? insertion_order`、`keys || key`、`Object.values(entries)`。
2. **新增「按 path 派生」的存储键**：路径会变（移动分组 / 重命名 / 换卡图）→ 必须同步迁移（参考 `chat/chatStorage.js` 的 `migrateChatKeys`，见 [CT-10](BUG-测卡工作区.md)）。
3. **导出/落盘前**必须剔除 `_` 前缀字段与 `uid`。
4. **扫描结果永远先判 `error`**，并且**拒绝用 0 文件结果覆盖非空库**（见 [PK-02](BUG-性能与大库.md)）。
5. **过滤临时文件**时，除自家产生的后缀，还要覆盖外部工具的 `<卡名>.<pid>.<tid>.tmp` 模式。
