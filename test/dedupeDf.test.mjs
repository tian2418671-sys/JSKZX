import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DF_MIN_CARDS, DF_MIN_LEN, normLine, dfLineKey, collectDfLines,
    buildTemplateKeySet, stripTemplateLines, stripDataTemplateLines,
} from '../js/utils/dedupeDf.js';

/** v4 §8 —— DF 模板剥离单测（行级片段 / 全字段池 / 阈值 / 剔除与克隆保护 / 统计） */

const LINE = '这是一条足够长的模板行——它需要超过六十个字符才会被纳入模板统计范围，用来验证阈值行为。'; // 51 字 → 不够
const LONG = '这是一条非常长的模板行内容，用于模拟卡库中大量卡片共用的固定句式，长度必须超过六十个字符才算有效片段。'; // 54 字 → 也不够
const X65 = '这是一条刻意凑到六十五个字符以上的模板行,用于模拟卡库中大量卡片共用的固定句式,长度超过阈值才会计入统计。'; // 57 字

test('normLine / dfLineKey：NFKC + 去首尾 + 空白折叠；同义变体同键', () => {
    assert.equal(normLine('  a\tb   c  '), 'a b c');
    // ⚠️ 口径按规格：**不做小写**（行文本的大小写是有意义的差异）
    assert.equal(dfLineKey('ＡＢ Ｃ'), dfLineKey('AB   C'), '全角/半角 + 空白折叠后同键');
    assert.equal(dfLineKey('x  y'), dfLineKey('x y'), '空白折叠后同键');
});

test('collectDfLines：仅计 trim≥60 的行；全字段池（含内嵌书）；fieldsScanned 计数', () => {
    const long = LONG.padEnd(70, '好'); // ≥60
    const data = {
        description: `短行\n${long}\n再短`,
        first_mes: '开场',
        character_book: { entries: [{ key: ['k'], content: `${long}二` }] },
        alternate_greetings: [`${long}三`],
    };
    const r = collectDfLines(data);
    assert.equal(r.lines.length, 3, `有效行数异常：${r.lines.length}（${r.lines.map((l) => l.length)}）`);
    assert.ok(r.lines.every((l) => l.trim().length >= DF_MIN_LEN));
    assert.ok(r.fieldsScanned >= 3, `fieldsScanned=${r.fieldsScanned}`);
});

test('buildTemplateKeySet：跨卡 ≥5 才判模板；同卡同行只计 1 次', () => {
    const t = LONG.padEnd(70, '甲');
    const mk = (n, id) => ({ id, lines: [t, t /* 同卡重复 */, `${t}独有${id}`] });
    const four = [1, 2, 3, 4].map((i) => mk(i, `c${i}`));
    assert.equal(buildTemplateKeySet(four).templateLines, 0, '4 卡不得判模板');
    const five = [1, 2, 3, 4, 5].map((i) => mk(i, `c${i}`));
    const r5 = buildTemplateKeySet(five);
    assert.ok(r5.templateLines >= 1, `5 卡应有模板：${r5.templateLines}`);
    assert.equal(r5.cardsWithTemplate, 5);
    assert.ok(r5.linesTotal > 0);
});

test('stripTemplateLines：剔除模板行、保留行结构、统计 stripped/字符数', () => {
    const t = LONG.padEnd(70, '乙');
    const keys = new Set([dfLineKey(t)]);
    const text = `第一行是普通内容\n${t}\n第三行也是普通内容`;
    const r = stripTemplateLines(text, keys);
    assert.equal(r.stripped, 1);
    assert.ok(r.strippedChars >= t.length - 2);
    const parts = r.text.split('\n');
    assert.equal(parts.length, 3, '行数不变（模板行替换为空行占位）');
    assert.equal(parts[1], '');
    assert.ok(!r.text.includes('乙乙'), '模板内容应被剔除');
    // 未命中集合 → 原样
    assert.equal(stripTemplateLines(text, new Set()).text, text);
});

test('stripDataTemplateLines：无命中返回 null（不克隆）；命中返回克隆且**原对象不被修改**', () => {
    const t = LONG.padEnd(70, '丙');
    const keys = new Set([dfLineKey(t)]);
    const data = { description: `普通\n${t}`, first_mes: '开场', character_book: { entries: [{ content: t }] } };
    const untouched = structuredClone(data);

    assert.equal(stripDataTemplateLines(data, new Set()), null);
    assert.deepEqual(data, untouched, '无命中时不得克隆/修改');

    const r = stripDataTemplateLines(data, keys);
    assert.ok(r && r.stripped >= 2, `命中应剔 2 行：${r && r.stripped}`);
    assert.deepEqual(data, untouched, '⚠️ 原对象绝不能被修改（应用内存数据）');
    assert.ok(!r.data.description.includes('丙丙'));
    assert.ok(!r.data.character_book.entries[0].content.includes('丙丙'));
});

test('DF 常量锁死（改口径必须同步文档 §13 与全部标定）', () => {
    assert.equal(DF_MIN_CARDS, 5);
    assert.equal(DF_MIN_LEN, 60);
});
