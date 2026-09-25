/**
 * 🛡️ 保存闸门单测（PK-32，2026-09-25）—— **用真实卡片做样本，不碰真库（只读）**
 *
 * 为什么要有这层闸门（实测事故链，详见 `main/cardBodyGuard.js` 头注）：
 *   P1a 正文懒加载把卡内世界书词条正文清空省内存（真实 11k 库 **9,557/11,186 张**），
 *   而「批量贴标签 / AI 打标落盘」传的正是这份瘦身态 payload（CDP 实测：54 条词条 / 非空 0 条），
 *   主进程过去**原样内嵌** ⇒ 一次贴标签就把整本书正文抹掉。
 *
 * 本测试的样本全部来自**真实卡**（`I:\03\角色色卡\极致手写人设：秋青子.png`）：
 *   · 「完整 payload」= 真卡解析结果原样
 *   · 「瘦身态 payload」= 把真卡的词条正文清空（**与运行期实测到的瘦身形态完全一致**）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parsePNGChunk, deepScanForJSON } from '../js/utils/pngParser.js';
import { normalizeCardData, extractBookEntries } from '../js/utils/cardLoader.js';

const require = createRequire(import.meta.url);
const { countNonEmptyBodies, checkBodyDegrade } = require('../main/cardBodyGuard.js');

const REAL_CARD = 'I:\\03\\角色色卡\\极致手写人设：秋青子.png';

/** 读真实 PNG 卡（与项目同口径的解析链）
 *  ⚠️ `parsePNGChunk` 要 **ArrayBuffer** 且**直接返回卡 JSON**（不是 chunk 列表）——
 *     传 Node 的 Buffer 会报 `First argument to DataView constructor must be an ArrayBuffer`。
 *     深度解析与解析失败时走 `deepScanForJSON` 兜底（与主进程 `readTavernPNGChunk` 同款分层）。
 */
function readRealCard(file) {
    const buf = readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    let card = null;
    try { card = parsePNGChunk(ab); } catch (e) { card = null; }
    if (!card) {
        const raw = deepScanForJSON(buf);
        if (!raw) throw new Error('无法从真实卡解析出 JSON：' + file);
        card = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    return normalizeCardData(card, true);
}

/** 把卡变成「运行期瘦身态」：词条正文清空 + 附加问候语清掉（与 slimCard 的字段口径一致） */
function toSlimShape(card) {
    const copy = JSON.parse(JSON.stringify(card));
    const d = copy.data || copy;
    for (const e of extractBookEntries(d.character_book)) {
        if (e && typeof e.content === 'string') e.content = '';
    }
    if (Array.isArray(d.alternate_greetings)) d.alternate_greetings = [];
    return copy;
}

const hasReal = existsSync(REAL_CARD);

test('样本：真实卡确实有词条正文（否则本测试没有意义）', { skip: !hasReal && '真实库不可用' }, () => {
    const card = readRealCard(REAL_CARD);
    const entries = extractBookEntries((card.data || card).character_book);
    const nonEmpty = entries.filter(e => String(e.content || '').length).length;
    assert.ok(entries.length >= 10, `真实卡应有 ≥10 条词条（实测 ${entries.length}）`);
    assert.ok(nonEmpty >= 10, `真实卡应有 ≥10 条非空正文（实测 ${nonEmpty}）`);
    assert.equal(countNonEmptyBodies(card), nonEmpty, 'countNonEmptyBodies 应与逐条统计一致');
});

test('★ 放行：真卡原样保存（正常通路的 payload）', { skip: !hasReal && '真实库不可用' }, () => {
    const card = readRealCard(REAL_CARD);
    assert.equal(checkBodyDegrade(card, card), null, '原样回存不得被拦');
});

test('★ 拒写：真卡被「瘦身态」覆盖（**本次要防的那一条**）', { skip: !hasReal && '真实库不可用' }, () => {
    const card = readRealCard(REAL_CARD);
    const slim = toSlimShape(card);
    assert.equal(countNonEmptyBodies(slim), 0, '瘦身态应数出 0 处非空正文（与 CDP 实测一致）');
    const reason = checkBodyDegrade(card, slim);
    assert.ok(reason, '必须拒写 —— 否则一次贴标签就抹掉整本书');
    assert.match(reason, /正文/, '拒绝原因必须说清是「正文」问题');
    assert.match(reason, /原文件未被改动/, '必须告知原文件安全');
    assert.match(reason, /瘦身态/, '必须指向最可能的成因（列表瘦身态）');
});

test('放行：部分清空（用户真的在编辑/删除词条）', { skip: !hasReal && '真实库不可用' }, () => {
    const card = readRealCard(REAL_CARD);
    const partial = JSON.parse(JSON.stringify(card));
    const entries = extractBookEntries((partial.data || partial).character_book);
    // 只清掉前 3 条 → 仍有大量正文 ⇒ 不得误拦
    for (let i = 0; i < Math.min(3, entries.length); i++) entries[i].content = '';
    assert.equal(checkBodyDegrade(card, partial), null, '正常编辑（部分清空）不得被拦');
});

test('放行：旧卡本来就没有正文（零成本短路）', () => {
    const empty = { data: { character_book: { entries: [{ comment: 'a', content: '' }] } } };
    assert.equal(countNonEmptyBodies(empty), 0);
    assert.equal(checkBodyDegrade(empty, empty), null, '旧卡无正文时不得拦（否则会挡住正当写入）');
});

test('兼容：脏形态（entries 对象字典 / book 本身是数组）+ 附加问候语也计入', () => {
    const dict = { data: { character_book: { entries: { 0: { content: 'x' }, 1: { content: '' } } } } };
    assert.equal(countNonEmptyBodies(dict), 1, 'entries 为对象字典时要能数出来（SillyTavern 旧形态）');

    const arrBook = { data: { character_book: [{ content: 'y' }] } };
    assert.equal(countNonEmptyBodies(arrBook), 1, 'book 本身是数组时要能数出来（V1 嵌入形态）');

    const withAg = { data: { alternate_greetings: ['g1', '', 'g2'] } };
    assert.equal(countNonEmptyBodies(withAg), 2, '附加问候语也算正文（瘦身会把它置空）');
});

test('兼容：副语言字段（data.data 层）也能数出来', () => {
    const nested = { data: { data: { character_book: { entries: [{ content: 'z' }] } } } };
    assert.equal(countNonEmptyBodies(nested), 1);
});
