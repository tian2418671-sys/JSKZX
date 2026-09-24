/**
 * 角色卡查重文本提取 —— **字段覆盖**单测
 * （2026-09-23 采纳「角色卡跨版本查重方案」评估的 P0-1 / P0-2）
 *
 * 🔴 旧实现只取 5 个字段（description / personality / scenario / first_mes / mes_example），
 *    而真实卡库实测**忽略 71.7% 的文本**（45 张卡；本次用真实卡复核更极端：
 *    `鬼.png` 查用 1,049 字符 vs 忽略 72,253 字符 = **忽略 98.6%**），
 *    其中 `character_book`（内嵌世界书）**80% 的卡都有却 0 参与**。
 *
 * ⚠️ 本单测用**等价实现**锁死「字段覆盖」与「口径」，防止回归 ——
 *    `useDedupe.js` 是组合式函数（依赖 Vue 响应式 + IPC），无法直接 import，
 *    故此处逐字复刻它的角色卡分支（与 `contentDedupeFalsePositive.test.mjs` 同款做法）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBookEntries } from '../js/utils/cardLoader.js';

// ══════════════════════════════════════════════════════════════
// 等价复刻：useDedupe.js 的 extractContentText「角色卡」分支
// ══════════════════════════════════════════════════════════════
function extractCardText(item) {
    const d = item.data?.data || item.data || {};
    const parts = [d.description, d.personality, d.scenario, d.first_mes, d.mes_example];
    if (Array.isArray(d.alternate_greetings)) parts.push(...d.alternate_greetings);
    parts.push(d.creator_notes, d.system_prompt, d.post_history_instructions);
    for (const e of extractBookEntries(d.character_book)) {
        if (!e || typeof e !== 'object') continue;
        const keys = Array.isArray(e.keys) ? e.keys.join(',') : (e.keys || e.key || '');
        parts.push(`${keys} ${e.content || ''}`);
    }
    return parts.filter(Boolean).join('\n');
}

const cardV3 = (fields) => ({ data: { spec: 'chara_card_v3', data: fields } });
const cardV1 = (fields) => ({ data: fields });

// ══════════════════════════════════════════════════════════════
// ★ 核心：character_book 必须参与
// ══════════════════════════════════════════════════════════════
test('★ character_book 词条必须参与查重（旧实现 0 参与 —— 本次修复的核心）', () => {
    const book = {
        entries: [
            { keys: ['北京城'], content: '北京城的世界书设定正文' },
            { keys: ['鬼市', '阴市'], content: '鬼市的设定正文' }
        ]
    };
    const txt = extractCardText(cardV3({ description: '短描述', character_book: book }));
    assert.ok(txt.includes('北京城的世界书设定正文'), '世界书词条正文必须出现在查重文本里');
    assert.ok(txt.includes('鬼市'), '触发词（keys）也必须带上（与世界书侧同口径）');
    assert.ok(txt.includes('阴市'), '多 key 必须用逗号连接后一并纳入');
});

test('character_book 三种形态都要收（数组 / entries 数组 / entries 字典）—— DF-19 同款加固', () => {
    const e1 = { keys: ['a'], content: '词条A正文' };
    const e2 = { keys: ['b'], content: '词条B正文' };
    const forms = [
        { character_book: [e1, e2] },                          // 老 V1 嵌入形态（book 本身是数组）
        { character_book: { entries: [e1, e2] } },             // 酒馆标准 V2/V3
        { character_book: { entries: { 0: e1, 1: e2 } } }      // 旧版前端导出（字典）
    ];
    for (const f of forms) {
        const txt = extractCardText(cardV3({ description: 'x', ...f }));
        assert.ok(txt.includes('词条A正文') && txt.includes('词条B正文'),
            `形态 ${JSON.stringify(Object.keys(f.character_book))} 的词条必须被提取到`);
    }
});

test('character_book 为脏形态（null / 字符串 / 空对象）不崩、不产出垃圾文本', () => {
    for (const bad of [null, undefined, 'not-a-book', 42, {}, { entries: null }, { entries: 'str' }]) {
        const txt = extractCardText(cardV3({ description: '正常描述', character_book: bad }));
        assert.ok(txt.includes('正常描述'));
        assert.ok(!txt.includes('object Object'), `脏形态 ${JSON.stringify(bad)} 不得产出 [object Object]`);
    }
});

// ══════════════════════════════════════════════════════════════
// ★ 其余新增字段
// ══════════════════════════════════════════════════════════════
test('★ alternate_greetings 全部纳入（29% 填充率）', () => {
    const txt = extractCardText(cardV3({
        first_mes: '开场白', alternate_greetings: ['备用问候甲', '备用问候乙']
    }));
    assert.ok(txt.includes('备用问候甲') && txt.includes('备用问候乙'));
});

test('★ creator_notes / system_prompt / post_history_instructions 纳入', () => {
    const txt = extractCardText(cardV3({
        description: 'd',
        creator_notes: '作者备注内容',
        system_prompt: '系统提示词内容',
        post_history_instructions: '历史后指令内容'
    }));
    for (const s of ['作者备注内容', '系统提示词内容', '历史后指令内容']) {
        assert.ok(txt.includes(s), `${s} 必须参与查重`);
    }
});

test('alternate_greetings 非数组（脏数据）不崩', () => {
    const txt = extractCardText(cardV3({ description: 'd', alternate_greetings: 'not-an-array' }));
    assert.ok(txt.includes('d'));
    assert.ok(!txt.includes('object Object'));
});

// ══════════════════════════════════════════════════════════════
// 字段口径：V1 扁平卡 vs V2/V3 包装
// ══════════════════════════════════════════════════════════════
test('★ 字段口径：V1 扁平卡与 V2/V3 包装必须取到同一份数据', () => {
    const fields = {
        description: '同一份描述', first_mes: '同一份开场白',
        character_book: { entries: [{ keys: ['k'], content: '同一份词条正文' }] }
    };
    const a = extractCardText(cardV1(fields));
    const b = extractCardText(cardV3(fields));
    assert.equal(a, b, 'V1 与 V3 包装下提取的文本必须完全一致（防 DF-17 字段口径坑）');
});

test('V2 包装（spec 在 data 层）同样取到内容', () => {
    const txt = extractCardText({
        data: { spec: 'chara_card_v2', data: { description: 'V2 描述', character_book: { entries: [{ keys: ['x'], content: 'V2 词条' }] } } }
    });
    assert.ok(txt.includes('V2 描述') && txt.includes('V2 词条'));
});

test('空卡 / 缺字段不产出 undefined / null 字样', () => {
    const txt = extractCardText(cardV3({}));
    assert.equal(txt, '');
    const txt2 = extractCardText({});
    assert.equal(txt2, '');
});

test('词条缺 keys 时**不得**丢失正文（回退到 key 字段）', () => {
    const txt = extractCardText(cardV3({
        character_book: { entries: [{ key: ['库格式触发词'], content: '库格式词条正文' }] }
    }));
    assert.ok(txt.includes('库格式词条正文'));
    assert.ok(txt.includes('库格式触发词'), '库格式的 `key` 字段必须回退读取');
});

// ══════════════════════════════════════════════════════════════
// ★ 真实场景回归：本次取证用的真实卡数据
// ══════════════════════════════════════════════════════════════
test('★ 真实卡回归：`鬼.png` 那种「正文长在世界书里」的卡必须能查到（忽略率应大幅下降）', () => {
    // 真实数据（`D:\\TkDmGzq\\GUI\\示例\\鬼\\鬼.png` 实测）：
    //   5 字段 = 1,049 字符 ｜ character_book 79 条 = 71,500 字符
    const item = cardV3({
        description: 'x'.repeat(1000),
        first_mes: 'y'.repeat(49),
        character_book: { entries: Array.from({ length: 79 }, (_, i) => ({ keys: [`k${i}`], content: 'z'.repeat(905) })) }
    });
    const txt = extractCardText(item);
    assert.ok(txt.length > 70000, `提取文本应包含世界书正文（实测 ${txt.length} 字符，旧实现仅 ~1,049）`);
});

test('★ 反例：两张卡仅世界书正文不同 → 提取文本必须不同（旧实现会判「完全相同」）', () => {
    const mk = (bookContent) => cardV3({
        description: '完全相同的描述', first_mes: '完全相同的开场白',
        character_book: { entries: [{ keys: ['k'], content: bookContent }] }
    });
    const a = extractCardText(mk('世界书正文版本 A 的内容'));
    const b = extractCardText(mk('世界书正文版本 B 的内容'));
    assert.notEqual(a, b, '仅世界书不同也必须体现差异 —— 否则会误判为「设定完全一致」');
});

// ══════════════════════════════════════════════════════════════
// 🛑 配套：扩大字段覆盖**不得降低既有召回**（2026-09-23 实测踩到）
// ══════════════════════════════════════════════════════════════
/** 5 字段（AR-48 `_nameOnly` 防护专用口径，刻意保留） */
function extractLegacyCardText(item) {
    const d = item.data?.data || item.data || {};
    return [d.description, d.personality, d.scenario, d.first_mes, d.mes_example]
        .filter(Boolean).join('\n');
}

const norm = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
const shingles = (t) => { const s = new Set(); for (let i = 0; i + 4 <= t.length; i++) s.add(t.slice(i, i + 4)); return s; };
/** 真实 4-gram Jaccard（作为「真值」） */
const jaccard = (A, B) => {
    if (A.size + B.size === 0) return null;
    let inter = 0;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    for (const x of small) if (big.has(x)) inter++;
    return inter / (A.size + B.size - inter);
};

test('★ 稀释效应实证：纳入世界书后，「仅正文不同」的同源卡相似度会被稀释到闸门之下', () => {
    // 复刻真实数据（`鬼.png` ↔ `鬼1.png`）：5 字段完全相同、世界书 66.7% 相同
    const sharedDesc = '完全相同的角色描述与设定'.repeat(40);
    const mk = (book) => cardV3({
        description: sharedDesc,
        character_book: { entries: book }
    });
    // 世界书：60 条相同 + 各自 20 条不同 → 世界书侧 Jaccard 约 60/100 = 60% 上下
    const common = Array.from({ length: 60 }, (_, i) => ({ keys: [`c${i}`], content: `共有词条正文${i}`.repeat(20) }));
    const onlyA = Array.from({ length: 20 }, (_, i) => ({ keys: [`a${i}`], content: `A 独有词条${i}`.repeat(20) }));
    const onlyB = Array.from({ length: 20 }, (_, i) => ({ keys: [`b${i}`], content: `B 独有词条${i}`.repeat(20) }));
    const a = mk([...common, ...onlyA]);
    const b = mk([...common, ...onlyB]);

    const full = jaccard(shingles(norm(extractCardText(a))), shingles(norm(extractCardText(b))));
    const legacy = jaccard(shingles(norm(extractLegacyCardText(a))), shingles(norm(extractLegacyCardText(b))));
    assert.equal(legacy, 1, '5 字段口径下必须仍是 100%（这是既有召回的依据）');
    assert.ok(full < 0.85, `全字段口径下会被稀释到闸门(0.85)之下 —— 实测 ${(full * 100).toFixed(1)}%`);
    // ⇒ 故闸门必须取 **双口径 OR**，否则这些真实同源版本会**漏报**
});

test('★ 双口径 OR 闸门：全字段 OR 5 字段 命中即判同源（保住召回且不漏新能力）', () => {
    const THRESHOLD = 0.85;
    const gate = (full, legacy) => full >= THRESHOLD || legacy >= THRESHOLD;
    // 场景①：仅世界书不同 → 5 字段 100%、全字段低 → 应命中（**新能力**）
    assert.equal(gate(0.30, 1.0), true, '仅世界书不同必须能命中（新能力）');
    // 场景②：仅正文版本迭代 → 全字段被稀释、5 字段 100% → 应命中（**保召回**）
    assert.equal(gate(0.67, 1.0), true, '正文版本迭代必须能命中（不回退）');
    // 场景③：两者都低 → **必须不命中**（防误报，PK-29 同型）
    assert.equal(gate(0.02, 0.0), false, '两口径都低时必须判无关（防一键误删）');
    // 场景④：全字段命中 → 命中
    assert.equal(gate(0.95, 0.4), true);
});

test('★ 单口径回归（对照）：只看全字段会漏报「仅正文迭代」的同源卡', () => {
    const THRESHOLD = 0.85;
    const singleGate = (full) => full >= THRESHOLD;
    assert.equal(singleGate(0.67), false,
        '只看全字段会把 67.7% 的真实同源版本判成无关 —— 这正是必须加 5 字段 OR 的原因');
});
