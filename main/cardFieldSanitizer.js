'use strict';
/**
 * 🧹 卡片 / 世界书 落盘前的「前端内部字段」剥离
 *
 * 前端会给内存对象挂一些**仅供 UI 使用**的字段，落盘前必须剔除，否则写进文件就是数据污染：
 *   · 世界书词条 `uid`        —— ⚠️ **分两种，见下方 DF-21**：
 *      · **本应用生成**（`<Date.now()>_<随机串>`）→ **删**（纯前端 v-for key，无持久化价值）；
 *      · **SillyTavern 原生**（纯数字 `0/1/2…`）→ **保留**（这是 ST 的真实数据，不是我们的字段）。
 *   · 世界书词条 `_collapsed` —— IDE 树折叠态（**必定**是本应用写的，一律删）
 *   · 导入过程残留 `_srcIndex` / `_srcUid`
 *   · 库列表项元数据 `_mtime` / `_ctime` / `_size` / `_importTime`
 *     （正常只挂在左栏库项上、不随卡片落盘，此处兜底）
 *
 * ⚠️⚠️ **DF-21（2026-09-23）：`uid` 必须按形态区分，不能无条件删** ⚠️⚠️
 *   旧实现把 `uid` 当「纯前端字段」无条件剔除 —— 但 2026-09-23 对真实库取证（**804 个世界书 /
 *   319,148 条词条**）发现：**100% 是 SillyTavern 原生的数字 uid**（`0/1/2/3…`），
 *   本应用随机串 **0 个** ⇒ 「ST 原生无 uid」的说法**对独立世界书不成立**（只有角色卡**内嵌**
 *   `character_book` 的词条才没有），旧行为是**删了别人的真实数据**。
 *   ⇒ 新规则：**只删「本应用生成形态」的 uid**（正则 `^\d{13}_[a-z0-9]{4,10}$`），
 *      ST 原生数字 uid **原样保留**。这样两边都对：本应用自己的临时 key 不污染文件，
 *      ST 的真实数据不被误删。
 *   ⚠️ 不选「一律保留」的原因：`useWorldbookEntries.ensureUid` 会给**第三方导入的无 uid 词条**
 *      补一个本应用随机串 —— 那是真正的污染，必须能删掉。
 *
 * 🛑🛑 **当前实现已知问题（DF-21 未决，方案待拍板 —— 见
 *   `docs/规格与计划/工作记录-20260923.md` §二）** 🛑🛑
 *   🔬 进一步取证：ST 的 `uid` **完全等于数组下标**（6 文件 / 11,430 条 / 0 例外），
 *      真实库**恒为 `0..n-1`**（40 文件 / 0 缺失 / 0 空洞）⇒ **uid = 文件内顺序号**。
 *   ⚠️ 因此「**保留原有 uid**」在**调序 / 删除**后会写出与下标不一致的数据：
 *      · `moveEntry` 上移一条：`[0,1,2]` → 保存后 **`[2,0,1]`**
 *      · 删除中间一条：`[0,1,2]` → 保存后 **`[0,2]`**（有空洞）
 *   ✅ **推荐方案 A**：保存时**按数组下标重写**（`uid = i`）—— 与 ST 完全一致、
 *      调序/删除/新增后**始终自洽**、本应用临时 uid 自然被覆盖
 *      （**可删掉下面 `APP_UID_RE` 那套形态判定，实现更简单**）。
 *      备选 B：恢复「删除所有 uid」。**不推荐 C**（维持现状）。
 *   ⇒ **在拍板前，不要以为这块已经完成。**
 *
 * ⚠️⚠️ 绝不能用「递归剔除所有 `_` 前缀键 + 所有 uid」的粗暴实现 ⚠️⚠️
 *   2026-09-13 对 11,045 张真实卡片的审计证明那样会**删掉用户真实数据**（7 类、131 处）：
 *     · character_book/entries[]/extensions/_filename                      28 张
 *     · extensions/juqingtuijin/apiSettings/_legacyEntriesMigrated         26 张
 *     · extensions/tavern_helper/variables/phone_data/_exportMeta          13 张
 *     · extensions/quick-response-force/apiSettings/_legacyEntriesMigrated  4 张
 *     · extensions/tavern_helper/variables/phone_character_images/__common__ 3 张
 *       （连**数据键名本身**都是 `_` 开头；`start_presets/__type` 同理 1 张）
 *     · extensions/TavernHelper_scripts[].value.data.change_log[].uid      11 处
 *     · extensions/chatSheets/sheet_<表名>/uid                             24 处
 *   故本模块采用 **白名单字段名 + 限定位置**：只删「世界书词条对象自身的直接键」，
 *   绝不递归进词条内部 —— 词条自己的 `extensions` 里同样有 `_filename` 这类真实数据。
 *
 * ⚠️ 只影响**落盘内容**（返回新对象，深拷贝），绝不就地修改内存里的活对象
 *    —— 内存里 `_mtime` 等仍供增量刷新比对使用，卡片世界书仍需 uid 做 v-for key。
 */

/** 载荷顶层自身的内部字段（卡片对象 / 世界书对象通用） */
const ROOT_INTERNAL_FIELDS = [
  'uid', '_collapsed', '_srcIndex', '_srcUid',
  '_mtime', '_ctime', '_size', '_importTime',
];

/** 世界书词条对象自身的内部字段 */
const WB_ENTRY_INTERNAL_FIELDS = ['uid', '_collapsed', '_srcIndex', '_srcUid'];

/**
 * 🆔 本应用生成的 uid 形态（DF-21）：`<Date.now()>_<base36 随机串>`
 *   · 产出点：`useWorldbookEntries.REGEN_UID` / `useWorldbooks` / `useWorldbookExtras` / `App.vue`
 *   · **只有这种形态才删**；ST 原生数字 uid（`0/1/2…`）必须保留。
 */
const APP_UID_RE = /^\d{13}_[a-z0-9]{4,10}$/;
/**
 * 🆔 历史形态（DF-21 兼容）：`useWorldbooks` 克隆世界书曾用字符串拼接
 *   `Date.now() + Math.random().toString(36).substring(2,9)` → 13 位数字 + 5~10 位无下划线 alnum。
 *   ⚠️ **要求至少含一个小写字母**，避免把「长纯数字」（可能是 ST 的其它数字 id）误判成我们的。
 */
const APP_UID_LEGACY_RE = /^\d{13}(?=[a-z0-9]{5,10}$)(?=.*[a-z])[a-z0-9]+$/;

/** 该 uid 是否为本应用生成的临时 key（是 → 可删；否 → 视为外部真实数据，保留） */
function isAppGeneratedUid(v) {
  if (typeof v !== 'string') return false;
  return APP_UID_RE.test(v) || APP_UID_LEGACY_RE.test(v);
}

/**
 * 删除对象**自身的直接键**。刻意不递归 —— 递归会误伤词条 extensions 里的同名真实数据。
 *
 * 🆔 DF-21：`uid` **单独处理** —— 只删本应用生成形态的（见 `isAppGeneratedUid`）。
 * @param {object} obj
 * @param {string[]} names 字段白名单
 * @param {{keepForeignUid?: boolean}} [opts] `keepForeignUid` 默认 true（DF-21 新行为）
 */
function dropInternalFields(obj, names, opts) {
  if (!obj || typeof obj !== 'object') return;
  const keepForeignUid = !(opts && opts.keepForeignUid === false);
  for (const k of names) {
    if (!(k in obj)) continue;
    // 🆔 uid 特例：保留非本应用形态的（ST 原生数字 uid 是别人的真实数据）
    if (k === 'uid' && keepForeignUid && !isAppGeneratedUid(obj[k])) continue;
    delete obj[k];
  }
}

/**
 * 取世界书词条列表：兼容 `{entries:[...]}` / `{entries:{k:v}}` / 裸数组。
 * 非世界书形态（例如角色卡对象）返回 null。
 * @returns {object[]|null}
 */
function worldbookEntryList(book) {
  if (Array.isArray(book)) return book;
  if (!book || typeof book !== 'object') return null;
  const e = book.entries;
  if (Array.isArray(e)) return e;
  if (e && typeof e === 'object') return Object.values(e); // 第三方工具的对象字典格式
  return null;
}

/**
 * 🆔 **SillyTavern 语义的「空闲 uid」分配**（DF-21 修复，2026-09-24）
 *
 * 🔬 **ST 源码取证**（`public/scripts/world-info.js`，这是定论依据）：
 *   · `entries` 是**对象字典，键 = uid**（`data.entries[uid].content = ...`）；
 *   · `getFreeWorldEntryUid(data)`：**从 0 起扫，返回第一个「不在 entries 里」的整数**（上限 1,000,000）；
 *   · `createWorldInfoEntry`：新词条 = `{ uid: newUid, ...模板 }`，写入 `data.entries[newUid]`；
 *   · `deleteWorldInfoEntry`：`delete data.entries[uid]` ⇒ **uid 会被腾出、可被后续新建复用**；
 *   · `duplicateWorldInfoEntry`：`delete originalData.uid` 后走 `createWorldInfoEntry` ⇒ **新 uid**；
 *   · 保存（`/api/worldinfo/edit`）**直接写整个 data** ⇒ **从不按下标重写 uid**。
 *
 * ⇒ **uid 是「词条身份」，不是「数组下标」**。真实库实测坐实：
 *   `炎孕-副本01.json` 的 uid 为 `0..1904` 之后直接跳到 **5737 / 6239 / 10567 / 13331**
 *   （397 条，有空洞，**单调递增但 ≠ 下标**）—— 正是「删除过词条、uid 被复用」的痕迹。
 *
 * @param {object} used 已占用集合（Set<number>）
 * @returns {number} 最小可用非负整数
 */
function nextFreeUid(used) {
  for (let uid = 0; uid < 1_000_000; uid++) {
    if (!used.has(uid)) return uid;
  }
  return 0; // 理论上不可达（与 ST 的 MAX_UID 一致）
}

/**
 * 📦 **把世界书 `entries` 数组还原为 SillyTavern 原生的「字典」形态**（DF-21 真修复）
 *
 * 🔴 **要修的真实缺陷**（2026-09-24 实测确证）：
 *   本应用载入世界书时把 ST 的**字典**转成**数组**（`Object.values`），保存时**原样写回数组**
 *   ⇒ 产出的文件**偏离 ST 原生格式**（ST 读到数组时虽能容错，但 uid 作为「词条身份」的
 *     语义丢失，且 ST 再次保存会重新分配 uid）。
 *   📊 实测（真实库 26 本 / 23,816 条）：**源文件 100% 是字典**；
 *      经「载入→保存」链路后**100% 变成数组**。
 *
 * ✅ 修法：保存**独立世界书**时按 `uid` 还原为字典（键 = uid 的字符串形式）。
 *   · uid 是**数字** → 直接用（保真，含空洞：`{0:…, 1:…, 5737:…}`）；
 *   · uid 是**本应用生成的临时串**（`<Date.now()>_<base36>`）→ 按 ST 语义分配**最小空闲整数**
 *     （本应用自己的 v-for key 不该落盘，但词条本身要保留）；
 *   · uid 缺失 → 同上（与 `getFreeWorldEntryUid` 行为一致）。
 *   ⚠️ **不按数组下标重写**（那是错的：会毁掉 ST 的 uid 身份语义，见 `nextFreeUid` 的取证）。
 *
 * ⚠️ **只对「独立世界书」调用** —— 角色卡**内嵌** `character_book.entries` 是**数组**
 *   （V2/V3 规范如此，实测真实卡 100% 无 uid），**绝不能**转成字典。
 *
 * @param {object} data 世界书载荷（会被就地修改）
 * @returns {object} 同一个对象，便于链式调用
 */
function restoreEntriesDict(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const entries = data.entries;
  if (!Array.isArray(entries)) return data; // 已是字典 / 无 entries → 不动

  // 🔑 **两轮处理**（保真优先）：先登记**所有数字 uid**（它们是 ST 的真实身份，
  //    含空洞如 5737 / 13331），再给「缺失 / 本应用临时串」分配**最小空闲整数**。
  //    若按单轮即时分配，靠后的数字 uid 可能被前面的临时串抢走 —— 那就丢了真实身份。
  const used = new Set();
  for (const e of entries) {
    if (e && typeof e === 'object' && Number.isInteger(e.uid) && e.uid >= 0) used.add(e.uid);
  }

  const assigned = new Set();   // 已写出的键（数字 uid 可能重复，需要重新分配）
  const out = {};
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    let uid = (Number.isInteger(e.uid) && e.uid >= 0 && !assigned.has(e.uid)) ? e.uid : null;
    if (uid === null) {
      // 缺失 / 本应用临时串 / 与已写出条目撞键 → 按 ST 语义分配最小空闲整数
      uid = nextFreeUid(new Set([...used, ...assigned]));
      used.add(uid);
    }
    assigned.add(uid);
    // ⚠️ ST 把 uid **同时**放在「字典键」与「词条对象内」（`{uid: newUid, ...模板}`），
    //    两者都要保留，否则 ST 读回后 `entry.uid` 为 undefined。
    out[String(uid)] = { ...e, uid };
  }
  data.entries = out;
  return data;
}

/**
 * 返回剥离了内部字段的**深拷贝**。
 * 兼容四种调用形态：
 *   1. 角色卡对象（character_book 在根或 data 下）
 *   2. 内嵌世界书对象 / 裸词条数组
 *   3. 世界书文件载荷 `{name, description, entries:[...]}`
 *   4. `entries` 为对象字典（第三方格式）
 *
 * @param {*} data
 * @returns {*} 清理后的新对象；深拷贝失败（循环引用等）时**原样返回**，绝不因清理失败丢数据
 */
function stripInternalFields(data) {
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(data)); // 必须深拷贝：不能就地改内存里的活对象
  } catch (e) {
    console.warn('[strip] 内部字段剥离失败，已回退原样:', e && e.message);
    return data;
  }

  // 1) 载荷顶层自身的内部字段
  dropInternalFields(clone, ROOT_INTERNAL_FIELDS);

  if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
    // 2) 角色卡内嵌世界书（character_book 可能在卡片根，也可能在 data 下）
    dropInternalFields(clone.character_book, WB_ENTRY_INTERNAL_FIELDS); // 书对象自身兜底
    for (const e of worldbookEntryList(clone.character_book) || []) {
      dropInternalFields(e, WB_ENTRY_INTERNAL_FIELDS);
    }
    const inner = clone.data;
    if (inner && typeof inner === 'object') {
      dropInternalFields(inner.character_book, WB_ENTRY_INTERNAL_FIELDS);
      for (const e of worldbookEntryList(inner.character_book) || []) {
        dropInternalFields(e, WB_ENTRY_INTERNAL_FIELDS);
      }
    }
  }

  // 3) 世界书载荷本身（{name, description, entries:[...]} 或裸数组）
  //    对卡片对象而言 `entries` 不存在 → worldbookEntryList 返回 null，天然 no-op
  for (const e of worldbookEntryList(clone) || []) {
    dropInternalFields(e, WB_ENTRY_INTERNAL_FIELDS);
  }

  return clone;
}

module.exports = {
  stripInternalFields,
  worldbookEntryList,
  dropInternalFields,
  isAppGeneratedUid,
  // 🆔 DF-21：把独立世界书的 entries 数组还原为 ST 原生字典（键 = uid）
  restoreEntriesDict,
  nextFreeUid,
  APP_UID_RE,
  APP_UID_LEGACY_RE,
  ROOT_INTERNAL_FIELDS,
  WB_ENTRY_INTERNAL_FIELDS,
};
