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
  APP_UID_RE,
  APP_UID_LEGACY_RE,
  ROOT_INTERNAL_FIELDS,
  WB_ENTRY_INTERNAL_FIELDS,
};
