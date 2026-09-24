import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripInternalFields } = require('../main/cardFieldSanitizer.js');
// 渲染层实现（ESM）——主进程是 CJS、渲染层是 ESM，且有 main/ ↔ js/ 分层约定，
// 故字段名单刻意保留两份；**下面第一条测试强制两份一致**，改一边不改另一边会直接失败。
import * as renderer from '../js/utils/cardFields.js';

/**
 * 契约测试：**落盘前剥离前端内部字段，但绝不误删用户/扩展的真实数据**
 *
 * 背景（2026-09-13 回归审计）：
 *   卡片保存路径（PNG chara 块 / 卡片 JSON / 整合包 worldbook.json）不做任何清洗，
 *   而 App.vue 的「从世界书库导入词条到角色卡内嵌世界书」会把前端 v-for 用的 `uid`
 *   与 IDE 折叠态 `_collapsed` 写进卡内世界书的**活引用** → 保存即污染卡片文件。
 *
 * ⚠️ 本文件的**核心价值是反向用例**：证明「递归剔除所有 `_` 前缀键」是错的。
 *   对 11,045 张真实卡片的审计发现 7 类、131 处**真实数据**是 `_` 开头或名为 `uid`，
 *   粗暴前缀剔除会把它们删光。下面的用例全部取自那批真实字段名。
 */

const CARD_WITH_DIRTY_BOOK = () => ({
  name: '测试卡',
  description: 'desc',
  first_mes: 'hi',
  extensions: {
    // ↓ 真实数据：酒馆助手 的电话本导出元信息（13 张真实卡片上有）
    tavern_helper: { variables: { phone_data: { _exportMeta: { v: 3 } } } },
    // ↓ 真实数据：扩展把整块配置的键名本身写成 `_` 开头
    'quick-response-force': { apiSettings: { _legacyEntriesMigrated: true } },
    // ↓ 真实数据：扩展自己的 uid（chatSheets 24 处 / TavernHelper_scripts 11 处）
    chatSheets: { sheet_Inventory: { uid: 'sheet-abc-123', rows: [] } },
  },
  character_book: {
    name: '内嵌书',
    entries: [
      {
        keys: ['a'], content: 'c1',
        uid: 1700000000000,      // ← 🆔 DF-21：ST 原生数字 uid，现**保留**
        _collapsed: true,        // ← 前端折叠态，应被剔除
        extensions: {
          // ↓ 真实数据：28 张真实卡片的词条扩展里有 `_filename`（**在词条内部**）
          _filename: 'entry-1.json',
          // ↓ 真实数据：词条扩展自己的 uid
          someExt: { uid: 'keep-me' },
        },
      },
      { keys: ['b'], content: 'c2', uid: 1700000000001, _collapsed: false, extensions: {} },
    ],
  },
});

test('【防漂移】主进程与渲染层的字段白名单必须完全一致', () => {
  const main = require('../main/cardFieldSanitizer.js');
  assert.deepEqual(renderer.WB_ENTRY_INTERNAL_FIELDS, main.WB_ENTRY_INTERNAL_FIELDS,
    '词条级白名单不一致：两份实现会清洗出不同结果（这正是 DF-03 覆盖不全的成因）');
  assert.deepEqual(renderer.ROOT_INTERNAL_FIELDS, main.ROOT_INTERNAL_FIELDS,
    '顶层白名单不一致');
});

test('【防漂移】渲染层实现与主进程实现对同一输入结果一致', () => {
  const card = CARD_WITH_DIRTY_BOOK();
  card._mtime = 1;
  assert.deepEqual(renderer.stripInternalFields(card), stripInternalFields(card),
    '两份实现对同一张卡片的清洗结果必须逐字段相同');
});

test('【防漂移】渲染层对裸数组（剥离导出/合并路径的入参形态）也要清洗', () => {
  // App.vue 的「拆分导出」与「合并世界书」直接把**词条数组**交给清洗函数
  // 🆔 DF-21：uid 改用**本应用生成形态**（数字 uid 现在会保留）
  const arr = [
    { content: 'a', uid: '1758600000000_ab12cd', _collapsed: true, _srcUid: 's1', extensions: { _filename: 'k.json' } },
    { content: 'b', uid: '1758600000001_xy9z', _srcIndex: 0 },
  ];
  for (const impl of [stripInternalFields, renderer.stripInternalFields]) {
    const out = impl(arr);
    assert.ok(Array.isArray(out), '入参是数组，出参必须还是数组');
    assert.ok(!('uid' in out[0]) && !('_collapsed' in out[0]) && !('_srcUid' in out[0]));
    assert.ok(!('uid' in out[1]) && !('_srcIndex' in out[1]));
    assert.equal(out[0].extensions._filename, 'k.json', '词条扩展里的 _filename 必须保住');
    assert.equal(out[0].content, 'a');
  }
});

test('内嵌世界书：剔除词条自身的**本应用** uid 与 _collapsed', () => {
  const book = {
    name: '书',
    entries: [
      { content: 'c1', keys: ['a'], uid: '1758600000000_ab12cd', _collapsed: true },
      { content: 'c2', keys: ['b'], uid: '1758600000001_xy9z', _collapsed: false },
    ],
  };
  const out = stripInternalFields(book);
  for (const e of out.entries) {
    assert.ok(!('uid' in e), '本应用生成的 uid 应被剔除');
    assert.ok(!('_collapsed' in e), '词条自身 _collapsed 应被剔除');
  }
  assert.equal(out.entries[0].content, 'c1', '业务字段必须原样保留');
  assert.deepEqual(out.entries[0].keys, ['a']);
});

// ═══════════════════════════════════════════════════════════════
// 🆔 DF-21（2026-09-23）：uid **按形态区分**，不能无条件删
// ───────────────────────────────────────────────────────────────
// 📖 病根：旧实现把 `uid` 当「纯前端字段」无条件剔除。但 2026-09-23 对真实库取证
//    （**804 个世界书 / 319,148 条词条**）发现：**100% 是 SillyTavern 原生数字 uid**
//    （`0/1/2/3…`），本应用随机串 **0 个** ⇒ 「ST 原生无 uid」对独立世界书**不成立**，
//    旧行为是在**删 ST 的真实数据**（`wb:save` 从 v1.8.9 起就这么干）。
// ✅ 新规则：**只删本应用生成形态**（`<Date.now()>_<随机串>`），ST 原生 uid 原样保留。
//    ⚠️ 不选「一律保留」：`ensureUid` 会给**第三方导入的无 uid 词条**补本应用随机串，
//       那是真正的污染，必须能删掉。
// ═══════════════════════════════════════════════════════════════

const APP_UID = '1758600000000_ab12cd';   // 本应用形态（13 位时间戳 + 下划线 + base36）
const APP_UID2 = '1758600000001_xy9z';

test('【DF-21】ST 原生数字 uid 必须**保留**（不再被误删）', () => {
  const book = { name: 'wb', entries: [{ content: 'a', uid: 0 }, { content: 'b', uid: 7 }, { content: 'c', uid: '12' }] };
  for (const impl of [stripInternalFields, renderer.stripInternalFields]) {
    const out = impl(book);
    assert.equal(out.entries[0].uid, 0, 'ST 原生数字 uid（0）是真实数据，必须保留');
    assert.equal(out.entries[1].uid, 7);
    assert.equal(out.entries[2].uid, '12', '数字字符串形态也要保留');
  }
});

test('【DF-21】本应用生成的随机串 uid 仍**必须剔除**（防污染）', () => {
  const book = { name: 'wb', entries: [{ content: 'a', uid: APP_UID }, { content: 'b', uid: APP_UID2 }] };
  for (const impl of [stripInternalFields, renderer.stripInternalFields]) {
    const out = impl(book);
    assert.ok(!('uid' in out.entries[0]), '本应用随机串 uid 是临时 key，必须剔除');
    assert.ok(!('uid' in out.entries[1]));
  }
});

test('【DF-21】UUID 形态视为外部真实数据 → 保留（不是本应用形态）', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const out = stripInternalFields({ entries: [{ content: 'a', uid: uuid }] });
  assert.equal(out.entries[0].uid, uuid, 'UUID 不是本应用生成形态，按「外部数据」保留');
});

test('【DF-21】`_collapsed` 仍无条件剔除（它只可能由本应用写入）', () => {
  const out = stripInternalFields({ entries: [{ content: 'a', uid: 5, _collapsed: true }] });
  assert.equal(out.entries[0].uid, 5, 'ST uid 保留');
  assert.ok(!('_collapsed' in out.entries[0]), '_collapsed 必定是本应用写的，一律删');
});

test('【DF-21 防漂移】两份实现的 uid 形态正则必须一致', () => {
  const main = require('../main/cardFieldSanitizer.js');
  assert.equal(String(renderer.APP_UID_RE), String(main.APP_UID_RE),
    'uid 形态正则不一致 → 两份实现清洗出不同结果（正是 DF-03 覆盖不全的成因）');
  assert.equal(String(renderer.APP_UID_LEGACY_RE), String(main.APP_UID_LEGACY_RE),
    '历史形态正则不一致');
  // 形态判定必须逐例一致
  const cases = [APP_UID, APP_UID2, '0', 0, 7, '12', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '', null, 'abc', '1758600000000', '1758600000000_', '1758600000000abc12', '1758600000000123'];
  for (const c of cases) {
    assert.equal(renderer.isAppGeneratedUid(c), main.isAppGeneratedUid(c), '形态判定不一致: ' + JSON.stringify(c));
  }
});

test('【DF-21】历史形态（克隆世界书的字符串拼接串）也要能识别并剔除', () => {
  // `useWorldbooks` 克隆世界书曾用 `Date.now() + Math.random().toString(36).substring(2,9)`
  // → 13 位数字 + 无下划线 alnum（实测样例：'1758600000000abc12'）
  const legacy = '1758600000000abc12';
  const out = stripInternalFields({ entries: [{ content: 'a', uid: legacy }] });
  assert.ok(!('uid' in out.entries[0]), '历史形态的本应用 uid 必须能识别并剔除');
});

test('【DF-21】长纯数字（疑似 ST 其它 id）不得被误判为本应用形态 → 保留', () => {
  // 13 位以上纯数字没有 base36 字母 → 不是本应用产物（我们必定带随机字母）
  for (const v of ['1758600000000', '1758600000000123', '9999999999999']) {
    const out = stripInternalFields({ entries: [{ content: 'a', uid: v }] });
    assert.equal(out.entries[0].uid, v, '长纯数字按外部数据保留: ' + v);
  }
});

test('【DF-21】保留 ST uid 不影响其他内部字段的剔除（组合场景）', () => {
  const book = {
    name: 'wb',
    entries: [
      { content: 'a', uid: 3, _collapsed: true, _srcIndex: 0, _srcUid: 's', extensions: { _filename: 'k.json' } },
      { content: 'b', uid: APP_UID, _collapsed: false },
    ],
  };
  const out = stripInternalFields(book);
  assert.equal(out.entries[0].uid, 3, 'ST uid 保留');
  assert.ok(!('_collapsed' in out.entries[0]) && !('_srcIndex' in out.entries[0]) && !('_srcUid' in out.entries[0]));
  assert.equal(out.entries[0].extensions._filename, 'k.json', '词条扩展里的真实数据不受影响');
  assert.ok(!('uid' in out.entries[1]), '本应用 uid 仍被剔除');
});

test('【反向】不误删词条 extensions 里 `_` 开头的真实数据', () => {
  const out = stripInternalFields(CARD_WITH_DIRTY_BOOK());
  assert.equal(out.character_book.entries[0].extensions._filename, 'entry-1.json',
    '词条扩展里的 _filename 是第三方真实数据（28 张真实卡片），绝不能删');
  assert.equal(out.character_book.entries[0].extensions.someExt.uid, 'keep-me',
    '词条扩展内部的 uid 是第三方真实数据，绝不能删');
});

test('【反向】不误删卡片 extensions 里 `_` 开头与名为 uid 的真实数据', () => {
  const out = stripInternalFields(CARD_WITH_DIRTY_BOOK());
  assert.deepEqual(out.extensions.tavern_helper.variables.phone_data._exportMeta, { v: 3 });
  assert.equal(out.extensions['quick-response-force'].apiSettings._legacyEntriesMigrated, true);
  assert.equal(out.extensions.chatSheets.sheet_Inventory.uid, 'sheet-abc-123',
    '扩展自己的 uid（chatSheets/change_log 共 35 处真实数据）绝不能删');
});

test('卡片顶层：兜底剔除库项元数据，但保留全部业务字段', () => {
  const card = CARD_WITH_DIRTY_BOOK();
  card._mtime = 123; card._size = 456; card._ctime = 789; card._importTime = 1;
  card.tags = ['t'];
  const out = stripInternalFields(card);
  for (const k of ['_mtime', '_size', '_ctime', '_importTime']) {
    assert.ok(!(k in out), `顶层 ${k} 应被剔除`);
  }
  assert.deepEqual(out.tags, ['t']);
  assert.equal(out.name, '测试卡');
});

test('V2 包装形态：character_book 在 data 下同样清洗', () => {
  const wrapped = { spec: 'chara_card_v2', spec_version: '2.0', data: CARD_WITH_DIRTY_BOOK() };
  const out = stripInternalFields(wrapped);
  // 🆔 DF-21：CARD_WITH_DIRTY_BOOK 里的 uid 是数字（1700000000000）→ 按 ST 原生保留
  assert.equal(out.data.character_book.entries[0].uid, 1700000000000, 'ST 原生数字 uid 保留');
  assert.ok(!('_collapsed' in out.data.character_book.entries[1]), '_collapsed 仍剔除');
  assert.equal(out.data.character_book.entries[0].extensions._filename, 'entry-1.json');
});

test('世界书文件载荷：{name, description, entries:[...]}', () => {
  const wb = {
    name: '我的世界书', description: 'd',
    entries: [
      // 🆔 DF-21：uid 改本应用形态（数字 uid 现保留）；`_collapsed` 仍无条件剔除
      { comment: 'e1', content: 'x', uid: '1758600000000_ab12cd', _collapsed: true, extensions: { _filename: 'k.json' } },
      { comment: 'e2', content: 'y', uid: 2 },
    ],
  };
  const out = stripInternalFields(wb);
  assert.equal(out.name, '我的世界书');
  assert.equal(out.entries.length, 2);
  assert.ok(!('uid' in out.entries[0]), '本应用生成的 uid 应剔除');
  assert.equal(out.entries[1].uid, 2, 'ST 原生数字 uid 保留（DF-21）');
  assert.ok(!('_collapsed' in out.entries[0]));
  assert.equal(out.entries[0].content, 'x');
  assert.equal(out.entries[0].extensions._filename, 'k.json',
    '世界书词条扩展里的 _filename 也要保住');
});

test('世界书对象字典形态：{entries:{k:v}} 与裸数组都要清洗', () => {
  // 🆔 DF-21：字典形态的 uid 也用本应用形态（数字 uid 现保留）
  const dict = { entries: { '0': { content: 'a', uid: '1758600000000_ab12cd' }, '1': { content: 'b', _collapsed: true } } };
  const outDict = stripInternalFields(dict);
  assert.ok(!('uid' in outDict.entries['0']), '本应用 uid 剔除');
  assert.ok(!('_collapsed' in outDict.entries['1']));

  const arr = [{ content: 'a', uid: '1758600000001_xy9z', _srcIndex: 3 }, { content: 'b', _srcUid: 'x' }];
  const outArr = stripInternalFields(arr);
  assert.ok(!('uid' in outArr[0]) && !('_srcIndex' in outArr[0]));
  assert.ok(!('_srcUid' in outArr[1]));
  assert.equal(outArr[0].content, 'a');
});

test('不就地修改内存对象（活引用必须保持干净）', () => {
  const card = CARD_WITH_DIRTY_BOOK();
  stripInternalFields(card);
  assert.equal(card.character_book.entries[0].uid, 1700000000000,
    '原对象是前端世界书的活引用，uid 必须还在（v-for key 依赖）');
  assert.equal(card.character_book.entries[0]._collapsed, true);
});

test('退化输入：null / 字符串 / 数字 / 深层嵌套不抛异常', () => {
  assert.equal(stripInternalFields(null), null);
  assert.equal(stripInternalFields('x'), 'x');
  assert.equal(stripInternalFields(42), 42);
  const deep = { a: { b: { c: { _collapsed: true, content: 'keep' } } } };
  const out = stripInternalFields(deep);
  assert.equal(out.a.b.c._collapsed, true,
    '深层陌生对象不在白名单位置内，应原样保留（宁可漏清也不误删）');
  assert.equal(out.a.b.c.content, 'keep');
});

test('循环引用：回退原样返回，绝不因清理失败丢数据', () => {
  const cyc = { name: 'c', character_book: { entries: [] } };
  cyc.self = cyc;
  const out = stripInternalFields(cyc);
  assert.equal(out, cyc, '深拷贝失败时必须原样返回同一个对象');
});

test('卡片没有 character_book 时不报错', () => {
  const out = stripInternalFields({ name: 'n', description: 'd' });
  assert.deepEqual(out, { name: 'n', description: 'd' });
});

// ══════════════════════════════════════════════════════════════
// 🆔 DF-21（2026-09-24 真修复）：独立世界书保存时**还原 ST 原生字典形态**
// ══════════════════════════════════════════════════════════════
// 📖 要防的缺陷：本应用载入时把 ST 的**字典**转成**数组**（`Object.values`），
//    保存时原样写回数组 ⇒ 产出的文件**偏离 ST 原生格式**。
//    实测（真实库 26 本 / 23,816 条）：源文件 **100% 是字典**，经「载入→保存」后 **100% 变数组**。
// 🔬 ST 源码定论（`public/scripts/world-info.js`）：`entries` 是**对象字典、键 = uid**；
//    `getFreeWorldEntryUid` 分配**最小空闲整数**；删除会**腾出 uid 供复用**；
//    复制走 `createWorldInfoEntry` ⇒ **新 uid**；保存**从不按下标重写**。
//    ⇒ **uid 是「词条身份」，不是「数组下标」**（真实库 `炎孕-副本01.json` 的 uid 有空洞：
//      0..1904 之后跳到 5737 / 6239 / 10567 / 13331）。
const { restoreEntriesDict, nextFreeUid } = require('../main/cardFieldSanitizer.js');

test('🆔 restoreEntriesDict：数组 → 字典，**保留原 uid（含空洞）**，不按下标重写', () => {
  const data = {
    name: '书',
    entries: [
      { uid: 0, key: ['a'], content: 'c0' },
      { uid: 1, key: ['b'], content: 'c1' },
      { uid: 5737, key: ['c'], content: 'c5737' },   // ← 真实库的空洞（删除过词条）
      { uid: 13331, key: ['d'], content: 'c13331' },
    ],
  };
  restoreEntriesDict(data);
  assert.ok(!Array.isArray(data.entries), '必须是字典（ST 原生形态）');
  assert.deepEqual(Object.keys(data.entries), ['0', '1', '5737', '13331'],
    '字典键必须等于原 uid（**保留空洞**）—— 按下标重写会毁掉 ST 的 uid 身份语义');
  assert.equal(data.entries['5737'].uid, 5737, '词条对象内的 uid 也要保留（ST 键与对象内都有）');
  assert.equal(data.entries['5737'].content, 'c5737', '内容不能丢');
});

test('🆔 restoreEntriesDict：缺失 / 本应用临时串 uid → 按 ST 语义分配**最小空闲整数**', () => {
  const data = {
    entries: [
      { uid: 0, content: 'c0' },
      { content: '无 uid' },                        // ← 缺失
      { uid: '1758600000000_ab12cd', content: '本应用临时串' },  // ← 前端 v-for key
      { uid: 2, content: 'c2' },
    ],
  };
  restoreEntriesDict(data);
  const keys = Object.keys(data.entries).map(Number).sort((a, b) => a - b);
  assert.deepEqual(keys, [0, 1, 2, 3], '应补齐为 1（最小空闲）与 3');
  assert.equal(data.entries['1'].content, '无 uid', '缺失 uid 的词条内容必须保留');
  assert.equal(data.entries['3'].content, '本应用临时串', '本应用临时串的词条内容必须保留');
  // 分配出的 uid 必须是**数字**（不能把临时串落盘）
  for (const k of Object.keys(data.entries)) {
    assert.equal(typeof data.entries[k].uid, 'number', `键 ${k} 的 uid 必须是数字`);
  }
});

test('🆔 restoreEntriesDict：**数字 uid 优先保真**（临时串不得抢走靠后的真实 uid）', () => {
  // 🔑 两轮处理的意义：若单轮即时分配，「临时串」会先占掉 1，
  //    而后面那条真实 `uid: 1` 就被迫改成 3 —— **真实身份被抢走**。
  const data = {
    entries: [
      { uid: '1758600000000_zzzzzz', content: '临时串（应让路）' },
      { uid: 1, content: '真实身份 uid=1' },
    ],
  };
  restoreEntriesDict(data);
  assert.equal(data.entries['1'].content, '真实身份 uid=1', '真实数字 uid 必须保住自己的键');
  assert.equal(data.entries['0'].content, '临时串（应让路）', '临时串应拿到最小空闲 0');
});

test('🆔 restoreEntriesDict：已是字典 → 原样不动（幂等）', () => {
  const data = { entries: { '0': { uid: 0, content: 'a' }, '5': { uid: 5, content: 'b' } } };
  const before = JSON.stringify(data);
  restoreEntriesDict(data);
  assert.equal(JSON.stringify(data), before, '已是字典时不得改动（幂等）');
});

test('🆔 restoreEntriesDict：无 entries / 非对象 → 不崩、不动', () => {
  for (const bad of [null, undefined, 42, 'str', [], { name: '无 entries' }]) {
    const out = restoreEntriesDict(bad);
    assert.equal(out, bad, '非法输入必须原样返回');
  }
});

test('🆔 nextFreeUid：返回最小可用非负整数（与 ST 的 getFreeWorldEntryUid 同语义）', () => {
  assert.equal(nextFreeUid(new Set()), 0);
  assert.equal(nextFreeUid(new Set([0, 1, 2])), 3);
  assert.equal(nextFreeUid(new Set([0, 2])), 1, '必须填空洞（复用被删的 uid）');
  assert.equal(nextFreeUid(new Set([0, 1, 5737])), 2);
});

test('🆔 restoreEntriesDict：uid 重复时**不覆盖**（后来的重新分配，前一个内容不丢）', () => {
  const data = {
    entries: [
      { uid: 7, content: '先来' },
      { uid: 7, content: '后来（撞键）' },
    ],
  };
  restoreEntriesDict(data);
  const vals = Object.values(data.entries).map(e => e.content).sort();
  assert.deepEqual(vals, ['先来', '后来（撞键）'], '两条内容都必须保留（撞键时重新分配而非覆盖）');
  assert.equal(Object.keys(data.entries).length, 2, '字典必须有 2 个键');
});

test('🆔 契约：`restoreEntriesDict` **只**作用于独立世界书（内嵌 character_book 仍是数组）', () => {
  // 角色卡内嵌 character_book.entries 是**数组**（V2/V3 规范），调用方**不得**对它调用本函数。
  // 本用例锁死「函数本身的行为边界」：它只看顶层 `entries`，不会碰 `character_book`。
  const card = {
    name: '卡',
    character_book: { entries: [{ keys: ['a'], content: 'c' }] },   // 内嵌：数组
    data: { character_book: { entries: [{ keys: ['b'], content: 'd' }] } },
  };
  restoreEntriesDict(card);
  assert.ok(Array.isArray(card.character_book.entries), '内嵌 character_book.entries 必须保持数组');
  assert.ok(Array.isArray(card.data.character_book.entries), 'data 下的内嵌也保持数组');
  assert.ok(!card.entries, '顶层本无 entries → 不得凭空创建');
});

