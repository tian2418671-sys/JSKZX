import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pickDiffKind, buildFieldResults, buildWbFieldResults, buildCardFieldResults,
    buildPresetFieldResults, CARD_DIFF_FIELDS, PRESET_PARAM_FIELDS,
} from '../js/utils/dedupeDiff.js';

/** v4 §10.3 —— 差异窗口三分支单测（结构契约 + 口径对齐 + 防误述） */

const mkItem = (o) => ({
    path: o.path || `/p/${o.name || 'x'}`,
    name: o.name || '样本',
    data: o.data === undefined ? null : o.data,
    customTags: o.customTags || [],
    ...(o.extra || {}),
});

// ── 类型识别 ─────────────────────────────────────────────────

test('pickDiffKind：世界书三判据（entries / entryCount / wbName）、预设判据、卡片兜底', () => {
    assert.equal(pickDiffKind(mkItem({ data: { entries: [] } }), mkItem({})), 'wb');
    assert.equal(pickDiffKind(mkItem({ extra: { entryCount: 3 } }), mkItem({})), 'wb');
    assert.equal(pickDiffKind(mkItem({}), mkItem({ extra: { wbName: '某某' } })), 'wb');
    // PK-26 反例：懒加载 worldbook，data=null，但带 entryCount → 不得误判成卡片
    assert.equal(pickDiffKind(mkItem({ data: null, extra: { entryCount: 0 } }), mkItem({ data: null, extra: { entryCount: 0 } })), 'wb');
    assert.equal(pickDiffKind(mkItem({ data: { temperature: 0.8 } }), mkItem({})), 'preset');
    assert.equal(pickDiffKind(mkItem({ data: { prompts: [] } }), mkItem({})), 'preset');
    assert.equal(pickDiffKind(mkItem({ data: { description: 'x' } }), mkItem({ data: {} })), 'card');
});

// ── 世界书分支 ───────────────────────────────────────────────

test('世界书：四行结构（词条数 / 词条级对齐 isEntryPairs / 触发词池 isTags / 正文总集）', () => {
    const mk = (entries) => mkItem({ data: { entries } });
    const eA = [
        { comment: '甲条', key: ['甲'], content: 'A 内容' },
        { comment: '乙条', key: ['乙'], content: 'B 内容' },
    ];
    const eB = [
        { comment: '甲条', key: ['甲'], content: 'A 内容' },
        { comment: '乙条', key: ['乙'], content: 'B 内容改' },
        { comment: '丙条', key: ['丙'], content: 'C 内容' },
    ];
    const rows = buildWbFieldResults(mk(eA), mk(eB));
    assert.equal(rows.length, 4);
    assert.equal(rows[0].isSame, false, '词条数不同');
    assert.equal(rows[1].isEntryPairs, true);
    assert.ok(rows[1].pairs.length >= 3, '对齐应含 2 条 both + 1 条 only-b');
    const stat = rows[1].len1;
    assert.ok(stat.includes('新增 1'), `新增计数异常：${stat}`);
    assert.ok(stat.includes('改动 1'), `改动计数异常：${stat}`);
    assert.equal(rows[2].isTags, true);
    assert.equal(rows[3].isSame, false, '正文有改动');
    assert.ok(rows[3].diffText && Array.isArray(rows[3].diffText.rows), '正文行级 diff 结构');
});

test('世界书：字典形态 entries（V2 老格式）不得崩溃', () => {
    const rows = buildWbFieldResults(
        mkItem({ data: { entries: { '0': { comment: '甲', content: 'x' } } } }),
        mkItem({ data: { entries: { '0': { comment: '甲', content: 'y' } } } }),
    );
    assert.equal(rows[0].len1, '1 条');
    assert.equal(rows[3].isSame, false);
});

test('世界书：正文未载入（0 条 + dataLoaded=false）→ 明确提示，不得把「没读到」当「没有」', () => {
    const rows = buildWbFieldResults(
        mkItem({ data: null, extra: { dataLoaded: false } }),
        mkItem({ data: { entries: [{ comment: '甲', content: 'x' }] } }),
    );
    assert.ok(String(rows[0].hint).includes('未载入'), `缺未载入提示：${rows[0].hint}`);
});

// ── 卡片分支 ─────────────────────────────────────────────────

test('卡片：字段行与查重口径对齐（8 文本字段全在）+ 备用开场白 + 内嵌书 + 标签', () => {
    const data1 = { description: 'D', mes_example: 'M', creator_notes: 'N', system_prompt: 'S' };
    const data2 = { description: 'D改', mes_example: 'M', creator_notes: 'N', system_prompt: 'S' };
    const rows = buildCardFieldResults(
        mkItem({ name: '甲', data: data1, customTags: ['t1'] }),
        mkItem({ name: '乙', data: data2, customTags: ['t1', 't2'] }),
    );
    for (const f of CARD_DIFF_FIELDS) {
        assert.ok(rows.some((r) => r.label === f.label), `缺字段行：${f.key}`);
    }
    const descRow = rows.find((r) => r.label.includes('Description'));
    assert.equal(descRow.isSame, false);
    assert.ok(rows.some((r) => r.label.includes('备用开场白')));
    const bookRow = rows.find((r) => r.label.includes('内嵌世界书'));
    assert.equal(bookRow.isEntryPairs, true);
    const tagRow = rows.find((r) => r.label.includes('标签'));
    assert.equal(tagRow.isTags, true);
    assert.deepEqual(tagRow.onlyCompareTags, ['t2']);
});

test('卡片：内嵌书字典形态可对齐（DF-19 —— 不得用 Array.isArray 判形态）', () => {
    const mkBook = (content) => ({
        character_book: { entries: { '0': { comment: '词条甲', key: ['甲'], content } } },
    });
    const rows = buildCardFieldResults(mkItem({ data: mkBook('v1') }), mkItem({ data: mkBook('v2') }));
    const bookRow = rows.find((r) => r.label.includes('内嵌世界书'));
    assert.equal(bookRow.pairs.length, 1);
    assert.equal(bookRow.pairs[0].side, 'both');
    assert.equal(bookRow.isSame, false, '正文改动应检出');
});

// ── 预设分支 ─────────────────────────────────────────────────

test('预设：8 采样参数行 + 提示词行；数组块对象不得出现 [object Object]（DF-24 回归）', () => {
    const mkPreset = (content) => ({
        temperature: 0.8,
        prompts: [
            { identifier: 'main', content },
            { identifier: 'jailbreak', content: '固定块', enabled: false },
        ],
    });
    const rows = buildPresetFieldResults(
        mkItem({ data: mkPreset('提示词正文 A') }),
        mkItem({ data: mkPreset('提示词正文 B') }),
    );
    assert.equal(rows.length, PRESET_PARAM_FIELDS.length + 1);
    const promptRow = rows[rows.length - 1];
    assert.equal(promptRow.isSame, false);
    const serialized = JSON.stringify(promptRow.diffText);
    assert.ok(!serialized.includes('[object Object]'), '提示词行出现 [object Object]（数组块对象被直接拼接）');
    // 未改参数行应判定相同
    const tempRow = rows.find((r) => r.label.includes('Temperature'));
    assert.equal(tempRow.isSame, true);
});

test('预设：prompts 字典形态不崩且能比对', () => {
    const rows = buildPresetFieldResults(
        mkItem({ data: { prompts: { '0': 'x' } } }),
        mkItem({ data: { prompts: { '0': 'y' } } }),
    );
    assert.equal(rows[rows.length - 1].isSame, false);
});

// ── 统一入口与结构契约 ───────────────────────────────────────

test('buildFieldResults：按类型分发；所有行满足 DiffModal 结构契约', () => {
    const cases = [
        [mkItem({ data: { entries: [{ comment: '甲', content: 'x' }] } }), mkItem({ data: { entries: [] } })],
        [mkItem({ data: { description: 'a' } }), mkItem({ data: { description: 'b' } })],
        [mkItem({ data: { prompts: [{ identifier: 'p', content: 'a' }] } }), mkItem({ data: { prompts: [{ identifier: 'p', content: 'b' }] } })],
    ];
    for (const [a, b] of cases) {
        const rows = buildFieldResults(a, b);
        assert.ok(Array.isArray(rows) && rows.length > 0);
        for (const r of rows) {
            assert.equal(typeof r.label, 'string');
            assert.equal(typeof r.isSame, 'boolean');
            if (r.isEntryPairs) assert.ok(Array.isArray(r.pairs));
            else if (r.isTags) assert.ok(Array.isArray(r.onlyMasterTags) && Array.isArray(r.onlyCompareTags));
            else {
                assert.ok('len1' in r && 'len2' in r);
                assert.ok(r.diffText === null || (r.diffText && Array.isArray(r.diffText.rows)), 'diffText 必须为 null 或 {rows}');
            }
        }
    }
});

test('buildFieldResults：空数据不崩（两侧 data 均空）', () => {
    const rows = buildFieldResults(mkItem({ data: null }), mkItem({ data: null }));
    assert.ok(Array.isArray(rows) && rows.length > 0, '卡片兜底分支应仍产出字段行');
});
