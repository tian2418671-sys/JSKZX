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
        uid: 1700000000000,      // ← 前端 v-for key，应被剔除
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
  const arr = [
    { content: 'a', uid: 1, _collapsed: true, _srcUid: 's1', extensions: { _filename: 'k.json' } },
    { content: 'b', uid: 2, _srcIndex: 0 },
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

test('内嵌世界书：剔除词条自身的 uid 与 _collapsed', () => {
  const out = stripInternalFields(CARD_WITH_DIRTY_BOOK());
  for (const e of out.character_book.entries) {
    assert.ok(!('uid' in e), '词条自身 uid 应被剔除');
    assert.ok(!('_collapsed' in e), '词条自身 _collapsed 应被剔除');
  }
  assert.equal(out.character_book.entries[0].content, 'c1', '业务字段必须原样保留');
  assert.deepEqual(out.character_book.entries[0].keys, ['a']);
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
  assert.ok(!('uid' in out.data.character_book.entries[0]));
  assert.ok(!('_collapsed' in out.data.character_book.entries[1]));
  assert.equal(out.data.character_book.entries[0].extensions._filename, 'entry-1.json');
});

test('世界书文件载荷：{name, description, entries:[...]}', () => {
  const wb = {
    name: '我的世界书', description: 'd',
    entries: [
      { comment: 'e1', content: 'x', uid: 1, _collapsed: true, extensions: { _filename: 'k.json' } },
      { comment: 'e2', content: 'y', uid: 2 },
    ],
  };
  const out = stripInternalFields(wb);
  assert.equal(out.name, '我的世界书');
  assert.equal(out.entries.length, 2);
  assert.ok(!('uid' in out.entries[0]) && !('uid' in out.entries[1]));
  assert.ok(!('_collapsed' in out.entries[0]));
  assert.equal(out.entries[0].content, 'x');
  assert.equal(out.entries[0].extensions._filename, 'k.json',
    '世界书词条扩展里的 _filename 也要保住');
});

test('世界书对象字典形态：{entries:{k:v}} 与裸数组都要清洗', () => {
  const dict = { entries: { '0': { content: 'a', uid: 9 }, '1': { content: 'b', _collapsed: true } } };
  const outDict = stripInternalFields(dict);
  assert.ok(!('uid' in outDict.entries['0']));
  assert.ok(!('_collapsed' in outDict.entries['1']));

  const arr = [{ content: 'a', uid: 9, _srcIndex: 3 }, { content: 'b', _srcUid: 'x' }];
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
