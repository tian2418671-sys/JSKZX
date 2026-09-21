import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffContentForDisplay, splitDiffLines } from '../js/utils/textDiff.js';

// 词条正文「行对齐 + 行内高亮」差异的防再犯用例。
//
// 背景（用户反馈）：查重对比界面打开后，词条正文是**纯文本直出**（无任何着色），
//   正文一长、或只改了几个字，肉眼完全看不出差异。本模块提供「行对齐的双列 diff」：
//   两侧行号一一对应（天然对齐），变更行再做**行内 token 级高亮**。
//
// 本文件把几条**容易写错、且错了会误导用户**的语义钉死：
//   ① 两侧行必须**一一对应**（某侧缺失时给 null 占位），否则左右会错位；
//   ② 只在一侧发生的变更**不得**把另一侧也标成变更（`你好世界` vs `你好，世界！` 是经典反例）；
//   ③ 小改动要能定位到**具体字符/词**，而不是整行标红；
//   ④ 超长文本要能降级（不能卡死），且降级后两侧仍严格对齐。

/** 把一侧渲染片段还原成「带高亮标记」的字符串，便于断言 */
function render(side) {
    if (!side) return null;
    return side.segs.map(s => (s.hl ? `[[${s.text}]]` : s.text)).join('');
}

/** 取某一行（按 kind） */
const rowOf = (r, kind) => r.rows.filter(x => x.kind === kind);

test('textDiff：行级增删改分类正确，且两侧行号一一对应', () => {
    const r = diffContentForDisplay('A\nB\nC', 'A\nC');
    assert.deepEqual(r.rows.map(x => x.kind), ['same', 'removed', 'same']);
    // 关键：删除行在右侧必须是 null 占位，否则右侧内容会整体上移 → 左右错位
    assert.equal(r.rows[1].a.text, 'B');
    assert.equal(r.rows[1].b, null);
    // 行号：左 #3 与右 #2 对应（各自独立计数）
    assert.equal(r.rows[2].a.no, 3);
    assert.equal(r.rows[2].b.no, 2);

    const r2 = diffContentForDisplay('A\nC', 'A\nB\nC');
    assert.deepEqual(r2.rows.map(x => x.kind), ['same', 'added', 'same']);
    assert.equal(r2.rows[1].a, null);
    assert.equal(r2.rows[1].b.text, 'B');
});

test('textDiff：同一位置的小改动归为 changed（而非拆成 removed+added 两行）', () => {
    const r = diffContentForDisplay('第一行\n第二行\n第三行', '第一行\n第二行改了\n第三行');
    assert.deepEqual(r.rows.map(x => x.kind), ['same', 'changed', 'same']);
    const c = rowOf(r, 'changed')[0];
    assert.ok(c.a && c.b, 'changed 行两侧都必须有内容（否则左右会错位）');
});

test('textDiff：行内高亮只标**真正变更的字符/词**（小改动可精确定位）', () => {
    const r = diffContentForDisplay('第二行', '第二行改了');
    assert.equal(render(r.rows[0].a), '第二行');
    assert.equal(render(r.rows[0].b), '第二行[[改了]]');
});

test('textDiff：只在一侧插入标点时，**另一侧不得被标成变更**（经典误报反例）', () => {
    // `你好世界` → `你好，世界！`：左版原样保留，只有右版插入了两个标点。
    // 若实现把左版整段标红，用户会以为「左版改了」→ 误导性最强的一类错。
    const r = diffContentForDisplay('你好世界', '你好，世界！');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].kind, 'changed');
    assert.equal(render(r.rows[0].a), '你好世界', '左版没有变更，不得出现高亮');
    assert.ok(render(r.rows[0].b).includes('[['), '右版应高亮插入的标点');
});

test('textDiff：拉丁词的变更精确定位到**具体字符**，不把整行标红', () => {
    const r = diffContentForDisplay('the system is ok', 'the systen is ok');
    const a = render(r.rows[0].a);
    const b = render(r.rows[0].b);
    // 剥公共前后缀后只剩 `m` vs `n` → 只标这一个字符（比「整词高亮」更精确）
    assert.equal(a, 'the syste[[m]] is ok', '左版只应高亮真正不同的字符');
    assert.equal(b, 'the syste[[n]] is ok', '右版只应高亮真正不同的字符');
    // 两侧未变更部分必须原样（不得被整段标红）
    assert.ok(a.startsWith('the syste') && a.endsWith(' is ok'));
});

test('textDiff：完全相同 → 全部 same、无高亮；空 ↔ 有内容 → 单侧 added', () => {
    const same = diffContentForDisplay('same\ntext', 'same\ntext');
    assert.deepEqual(same.rows.map(x => x.kind), ['same', 'same']);
    assert.equal(same.stats.changed + same.stats.added + same.stats.removed, 0);
    for (const row of same.rows) {
        assert.equal(render(row.a), render(row.b));
        assert.ok(!render(row.a).includes('[['));
    }

    const added = diffContentForDisplay('', '新内容');
    assert.deepEqual(added.rows.map(x => x.kind), ['added']);
    assert.equal(added.rows[0].a, null);
    assert.equal(added.rows[0].b.text, '新内容');

    const empty = diffContentForDisplay('', '');
    assert.equal(empty.rows.length, 0);
});

test('textDiff：公共前缀/后缀行不参与 LCS（小改动不被判成整段重写）', () => {
    // 100 行相同 + 中间 1 行改动 + 100 行相同 → 应当只有 1 行 changed
    const a = [...Array(100).fill('head'), 'OLD', ...Array(100).fill('tail')].join('\n');
    const b = [...Array(100).fill('head'), 'NEW', ...Array(100).fill('tail')].join('\n');
    const r = diffContentForDisplay(a, b);
    assert.equal(r.stats.changed, 1, '只应有 1 行变更');
    assert.equal(r.stats.same, 200, '前后公共行应全部判为 same');
    assert.equal(r.rows.length, 201);
});

test('textDiff：超长文本降级后两侧仍严格一一对应（不得错位）', () => {
    // 构造超过 MAX_LCS_LINES（1500）的文本，触发位置比对降级
    const n = 2000;
    const A = [];
    const B = [];
    for (let i = 0; i < n; i++) {
        A.push(`line${i}`);
        B.push(i % 500 === 0 ? `line${i}-changed` : `line${i}`);
    }
    const r = diffContentForDisplay(A.join('\n'), B.join('\n'));
    assert.equal(r.stats.truncated, true, '超长文本应标记为降级处理');
    // 降级后仍必须对齐：每行的左/右行号之差恒定（同位置比对）
    for (const row of r.rows) {
        if (row.a && row.b) {
            assert.equal(row.b.no - row.a.no, 0, '降级后同位置行的行号应一致');
        }
    }
    // 且变更行数应与实际改动数一致（每 500 行改 1 处）
    assert.equal(r.stats.changed, n / 500);
});

test('textDiff：\\r\\n 与 \\r 统一按换行处理（Windows 文本不会整篇判为差异）', () => {
    const r = diffContentForDisplay('a\r\nb\r\nc', 'a\nb\nc');
    assert.deepEqual(r.rows.map(x => x.kind), ['same', 'same', 'same']);
    assert.equal(splitDiffLines('a\r\nb').length, 2);
    assert.equal(splitDiffLines('a\rb').length, 2);
    assert.equal(splitDiffLines('').length, 0);
});

test('textDiff：变更块内「删多于增」时，多出的部分为 removed 且占位对齐', () => {
    const r = diffContentForDisplay('A\nX1\nX2\nX3\nB', 'A\nY1\nB');
    // X1→Y1 配对为 changed；X2/X3 为 removed
    assert.equal(r.stats.changed, 1);
    assert.equal(r.stats.removed, 2);
    assert.equal(r.stats.added, 0);
    for (const row of r.rows) {
        if (row.kind === 'removed') assert.equal(row.b, null, 'removed 行右侧必须是 null 占位');
    }
});

test('textDiff：变更块内「增多于删」时，多出的部分为 added 且占位对齐', () => {
    const r = diffContentForDisplay('A\nX1\nB', 'A\nY1\nY2\nY3\nB');
    assert.equal(r.stats.changed, 1);
    assert.equal(r.stats.added, 2);
    assert.equal(r.stats.removed, 0);
    for (const row of r.rows) {
        if (row.kind === 'added') assert.equal(row.a, null, 'added 行左侧必须是 null 占位');
    }
});
