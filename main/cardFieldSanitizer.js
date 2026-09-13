'use strict';
/**
 * 🧹 卡片 / 世界书 落盘前的「前端内部字段」剥离
 *
 * 前端会给内存对象挂一些**仅供 UI 使用**的字段，落盘前必须剔除，否则写进文件就是数据污染：
 *   · 世界书词条 `uid`        —— 前端 v-for 的稳定 key。条目标识实际走
 *                                useEmbeddedWorldbook 的 WeakMap `getEntryUid`（补充：
 *                                useWorldbookEntries 的 ensureUid 在缺失时会重新生成），
 *                                故删除后功能不受影响，只是 uid 不跨保存持久化（本就无需持久化）
 *   · 世界书词条 `_collapsed` —— IDE 树折叠态
 *   · 导入过程残留 `_srcIndex` / `_srcUid`
 *   · 库列表项元数据 `_mtime` / `_ctime` / `_size` / `_importTime`
 *     （正常只挂在左栏库项上、不随卡片落盘，此处兜底）
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
 *   同一份审计也确认：真实卡片的 character_book 词条上**没有** uid（0 张），删除无数据损失。
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
 * 删除对象**自身的直接键**。刻意不递归 —— 递归会误伤词条 extensions 里的同名真实数据。
 * @param {object} obj
 * @param {string[]} names 字段白名单
 */
function dropInternalFields(obj, names) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of names) {
    if (k in obj) delete obj[k];
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
  ROOT_INTERNAL_FIELDS,
  WB_ENTRY_INTERNAL_FIELDS,
};
