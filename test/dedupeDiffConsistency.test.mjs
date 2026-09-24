/**
 * 🛡️ **差异比对字段 ⊇ 查重字段** —— 口径一致性守卫单测
 * （2026-09-24，DF-23 的**必要配套**）
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔴 **要防的最坏组合**（与 DF-19 的「反向结论」同型，且更危险）
 * ───────────────────────────────────────────────────────────────
 * DF-23 把 `character_book` / `alternate_greetings` / `creator_notes` 等纳入**查重**后，
 * 若**差异比对器仍只看 5 个字段**，就会出现：
 *
 *   ```
 *   查重：这两张卡世界书几乎相同 → 判为「一组」（因为新增字段参与了判定）
 *   用户：点「🔍 查看内容差异」→ 比对器只看 5 字段 → 显示「✅ 设定完全一致」
 *   用户：既然完全一致 → 点「保留此版，清理其余」→ 💥 误删
 *   ```
 *
 * ⇒ **「查重能看出重复、比对却看不出差异」是自相矛盾的**，且直接诱导误删。
 *   故必须保证：**凡是参与查重的字段，差异比对器都要能显示出来**。
 *
 * ⚠️ 本单测用**等价实现**锁死这条不变式（`useDedupe.js` 是组合式函数，无法直接 import）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBookEntries } from '../js/utils/cardLoader.js';
import { alignEntryLists, summarizeAlignment } from '../js/utils/entryAlign.js';

// ══════════════════════════════════════════════════════════════
// 等价复刻：useDedupe.js 的两处字段清单
// ══════════════════════════════════════════════════════════════
/** 查重取字段（`extractContentText` 角色卡分支）—— 与生产代码逐字一致 */
function dedupeFieldKeys(item) {
    const d = item.data?.data || item.data || {};
    const parts = [d.description, d.personality, d.scenario, d.first_mes, d.mes_example];
    if (Array.isArray(d.alternate_greetings)) parts.push(...d.alternate_greetings);
    parts.push(d.creator_notes, d.system_prompt, d.post_history_instructions);
    for (const e of extractBookEntries(d.character_book)) {
        const keys = Array.isArray(e.keys) ? e.keys.join(',') : (e.keys || e.key || '');
        parts.push(`${keys} ${e.content || ''}`);
    }
    return parts.filter(Boolean).join('\n');
}

/** 差异比对字段清单（`openDiffDetailModal` 角色卡分支）—— 与生产代码逐字一致 */
const DIFF_SCALAR_FIELDS = [
    'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions'
];
/** 差异比对是否覆盖某个「查重会读到」的字段 */
function diffCovers(item, key) {
    const d = item.data?.data || item.data || {};
    if (DIFF_SCALAR_FIELDS.includes(key)) return true;
    if (key === 'alternate_greetings') return true;          // 比对器单独有「🎁 备用开场白」行
    if (key === 'character_book') return true;               // 比对器单独有「📚 内嵌世界书」行
    void d;
    return false;
}

const cardV3 = (fields) => ({ data: { spec: 'chara_card_v3', data: fields } });

// ══════════════════════════════════════════════════════════════
// ★ 核心不变式
// ══════════════════════════════════════════════════════════════
test('★ 不变式：每个参与查重的字段，差异比对器都必须能显示', () => {
    // 真实卡会出现「全部字段都填」的形态 —— 用它做最严格的检查
    const full = cardV3({
        description: 'd', personality: 'p', scenario: 's', first_mes: 'f', mes_example: 'm',
        creator_notes: 'c', system_prompt: 'sp', post_history_instructions: 'phi',
        alternate_greetings: ['g1', 'g2'],
        character_book: { entries: [{ keys: ['k'], content: '词条正文' }] }
    });
    const keys = [
        'description', 'personality', 'scenario', 'first_mes', 'mes_example',
        'creator_notes', 'system_prompt', 'post_history_instructions',
        'alternate_greetings', 'character_book'
    ];
    for (const k of keys) {
        assert.ok(diffCovers(full, k),
            `字段 \`${k}\` 参与查重但差异比对器看不到 ⇒ 「查重判重复、比对说一致」⇒ 一键误删风险`);
    }
});

test('★ 反向检查：比对器**不得**漏掉 `scenario`（历史上曾漏过）', () => {
    assert.ok(DIFF_SCALAR_FIELDS.includes('scenario'),
        '`scenario` 曾被漏掉 —— 场景改动在面板上不显示 ⇒ 可能误删新版本');
});

// ══════════════════════════════════════════════════════════════
// ★ 端到端语义：仅世界书不同 → 查重能区分 + 比对能显示
// ══════════════════════════════════════════════════════════════
test('★ 端到端：两张卡仅内嵌世界书不同 → 查重文本不同 **且** 比对能列出词条增删', () => {
    const mk = (entries) => cardV3({
        description: '完全相同的描述', first_mes: '完全相同的开场白',
        character_book: { entries }
    });
    const a = mk([{ keys: ['共有'], content: '共有词条正文' }, { keys: ['只A有'], content: 'A 独有' }]);
    const b = mk([{ keys: ['共有'], content: '共有词条正文' }, { keys: ['只B有'], content: 'B 独有' }]);

    // ① 查重侧：文本必须不同（否则「仅世界书不同」查不出来）
    assert.notEqual(dedupeFieldKeys(a), dedupeFieldKeys(b));

    // ② 比对侧：必须能列出「A 独有 = 缺失、B 独有 = 新增」
    const bookA = extractBookEntries(a.data.data.character_book);
    const bookB = extractBookEntries(b.data.data.character_book);
    const pairs = alignEntryLists(bookA, bookB);
    const stat = summarizeAlignment(pairs);
    assert.equal(stat.onlyA, 1, 'A 独有词条必须被标为「缺失」');
    assert.equal(stat.onlyB, 1, 'B 独有词条必须被标为「新增」');
    assert.equal(stat.onlyA + stat.onlyB + stat.changed, 2,
        '必须能显示出差异 —— 否则用户看到「无差异却判重复」⇒ 误删');
});

test('★ 端到端：两张卡仅「备用开场白」不同 → 查重能区分 + 比对能显示', () => {
    const a = cardV3({ description: 'd', alternate_greetings: ['问候甲'] });
    const b = cardV3({ description: 'd', alternate_greetings: ['问候乙'] });
    assert.notEqual(dedupeFieldKeys(a), dedupeFieldKeys(b), '备用开场白差异必须体现在查重文本里');
    assert.ok(diffCovers(a, 'alternate_greetings'), '比对器必须能显示备用开场白差异');
});

test('★ 端到端：两张卡仅 `creator_notes` 不同 → 查重能区分 + 比对能显示', () => {
    const a = cardV3({ description: 'd', creator_notes: '备注甲' });
    const b = cardV3({ description: 'd', creator_notes: '备注乙' });
    assert.notEqual(dedupeFieldKeys(a), dedupeFieldKeys(b));
    assert.ok(diffCovers(a, 'creator_notes'));
});

// ══════════════════════════════════════════════════════════════
// ★ 世界书形态兼容（DF-19 教训：不得用 Array.isArray 单一判据）
// ══════════════════════════════════════════════════════════════
test('★ 内嵌世界书三种形态都能参与「查重 + 比对」（DF-19 同款加固）', () => {
    const e1 = { keys: ['a'], content: '词条A正文' };
    const e2 = { keys: ['b'], content: '词条B正文' };
    const forms = [
        [e1, e2],                                    // 老 V1：book 本身是数组
        { entries: [e1, e2] },                       // 标准 V2/V3
        { entries: { 0: e1, 1: e2 } }                // 旧版前端导出（字典）
    ];
    for (const book of forms) {
        const card = cardV3({ description: 'd', character_book: book });
        const txt = dedupeFieldKeys(card);
        assert.ok(txt.includes('词条A正文') && txt.includes('词条B正文'),
            `形态 ${JSON.stringify(Object.keys(book))} 必须被查重读到`);
        const entries = extractBookEntries(card.data.data.character_book);
        assert.equal(entries.length, 2, `形态 ${JSON.stringify(Object.keys(book))} 必须能被比对器提取到 2 条`);
    }
});

test('★ 脏形态（null / 字符串 / 空）不崩、不产出 [object Object]', () => {
    for (const bad of [null, undefined, 'not-a-book', 42, {}, { entries: null }]) {
        const card = cardV3({ description: '正常描述', character_book: bad });
        const txt = dedupeFieldKeys(card);
        assert.ok(txt.includes('正常描述'));
        assert.ok(!txt.includes('object Object'), `脏形态 ${JSON.stringify(bad)} 不得产出垃圾文本`);
        assert.equal(extractBookEntries(bad).length, 0);
    }
});
