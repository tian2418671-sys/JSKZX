/**
 * P2-2 单测：**L1 索引快照**（copy-on-write，2026-09-23）
 *
 * 背景（v3 评审 §5 #5）：查重是**多阶段长流程**（s5000 可达分钟级）。
 *   若用户在查重进行中**保存/编辑某本书**（`wb:save` 改写 `wb.keyHashes`），
 *   会出现「前半段用旧索引、后半段用新索引」→ 结果自相矛盾且无法复现。
 *
 * 修法：查重开始时对参与比对的条目做**浅快照**（只冻 `keyHashes` / `exactContentHash` /
 *   `entryCount` / `wbName` / `simhash` —— **绝不碰 `data` 正文**）。
 *
 * ⚠️ 本单测的核心：**快照必须真的隔离**（改活对象不得影响快照），
 *   且**不得**复制正文（那是 PK-20 的病根）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** 从 useDedupe.js 抽出快照三件套（测真代码，不复制粘贴） */
const src = fs.readFileSync(path.join(repoRoot, 'js', 'composables', 'useDedupe.js'), 'utf-8');

function sliceByBraces(s, fromIdx) {
    const start = s.indexOf('{', fromIdx);
    let depth = 0, inLine = false, inBlock = false, inStr = false, quote = '';
    for (let k = start; k < s.length; k++) {
        const c = s[k], n = s[k + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
        if (inStr) { if (c === '\\') { k++; continue; } if (c === quote) inStr = false; continue; }
        if (c === '/' && n === '/') { inLine = true; k++; continue; }
        if (c === '/' && n === '*') { inBlock = true; k++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return s.slice(start, k + 1); }
    }
    throw new Error('花括号不配对');
}
const fnBody = (name) => {
    const i = src.indexOf(`const ${name} = `);
    assert.ok(i > 0, `应能找到 ${name}`);
    // ⚠️ 必须连**参数列表**一起抽（`(items) => {…}`），否则构造出的函数缺参
    const arrow = src.indexOf('=>', i);
    assert.ok(arrow > i, `${name} 应是箭头函数`);
    const sig = src.slice(i + `const ${name} = `.length, arrow).trim();   // 如 `(items)`
    // ⚠️ 箭头函数有**两种体**：块体 `{…}` 与**表达式体**（无花括号，如 `(it) => x ? y : z`）。
    //    表达式体不能走 `sliceByBraces`（会抓到后面无关的 `{}` 块 —— 实测踩到）。
    const after = src.slice(arrow + 2);
    const firstNonWs = after.search(/\S/);
    if (after[firstNonWs] === '{') {
        return { sig, body: sliceByBraces(src, arrow) };
    }
    // 表达式体：扫描到**该语句的**分号（跳过括号/字符串内的分号）
    let depth = 0, inStr = false, quote = '';
    for (let k = firstNonWs; k < after.length; k++) {
        const c = after[k];
        if (inStr) { if (c === '\\') { k++; continue; } if (c === quote) inStr = false; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ';' && depth === 0) {
            return { sig, body: '{ return ' + after.slice(0, k + 1) + ' }' };
        }
    }
    throw new Error(`${name} 表达式体未找到结束分号`);
};

// 构造被测模块（注入 l1Snapshot 作为**共享闭包变量**）
// ⚠️ 必须用 `var`/`let` 声明在**同一层**，且三个函数都**读写同一个变量** ——
//    若各自用 `const` 会得到独立副本（实测踩到：freeze 写了自己的，snapOf 读的还是 null）。
const f1 = fnBody('freezeL1Snapshot'), f2 = fnBody('snapOf'), f3 = fnBody('releaseL1Snapshot');
const factory = new Function(`
    let l1Snapshot = null;
    const freezeL1Snapshot = ${f1.sig} => ${f1.body};
    const snapOf = ${f2.sig} => ${f2.body};
    const releaseL1Snapshot = ${f3.sig} => ${f3.body};
    return { freezeL1Snapshot, snapOf, releaseL1Snapshot, _peek: () => l1Snapshot };
`);
const { freezeL1Snapshot, snapOf, releaseL1Snapshot, _peek } = factory();

// ══════════════════════════════════════════════════════════════
test('★ P2-2：快照冻结 L1 字段，且**不受活对象后续修改影响**', () => {
    const wb = {
        path: 'C:/lib/a.json',
        keyHashes: [1, 2, 3],
        exactContentHash: 'hashA',
        entryCount: 10,
        wbName: '书 A',
        simhash: [111, 222]
    };
    freezeL1Snapshot([wb]);
    const snap = snapOf(wb);
    assert.deepEqual(snap.keyHashes, [1, 2, 3]);
    assert.equal(snap.exactContentHash, 'hashA');

    // 模拟「查重期间用户保存了这本书」→ 活对象被改写
    wb.keyHashes = [9, 9, 9];
    wb.exactContentHash = 'hashB';
    wb.entryCount = 99;
    wb.wbName = '书 A 改';

    // 快照必须**纹丝不动**
    const after = snapOf(wb);
    assert.deepEqual(after.keyHashes, [1, 2, 3], '快照的 keyHashes 不得被活对象改写影响');
    assert.equal(after.exactContentHash, 'hashA', '快照的 exactContentHash 不得被影响');
    assert.equal(after.entryCount, 10, '快照的 entryCount 不得被影响');
    assert.equal(after.wbName, '书 A', '快照的 wbName 不得被影响');
});

test('★ P2-2：快照**不复制正文**（`data` 不进快照 —— 那是 PK-20 的病根）', () => {
    const wb = {
        path: 'C:/lib/big.json',
        keyHashes: [1],
        data: { entries: new Array(100000).fill({ content: 'x'.repeat(100) }) }
    };
    freezeL1Snapshot([wb]);
    const snap = snapOf(wb);
    assert.equal(snap.data, undefined, '快照**不得**包含 data（否则等于复制 34.8GB 正文）');
    assert.deepEqual(Object.keys(snap).sort(), ['entryCount', 'exactContentHash', 'keyHashes', 'simhash', 'wbName'].sort(),
        '快照字段应恰好是这 5 个 L1 字段');
});

test('★ P2-2：未冻结时 `snapOf` 返回 null（回落活对象 → 行为不变）', () => {
    releaseL1Snapshot();
    const wb = { path: 'C:/lib/c.json', keyHashes: [5] };
    assert.equal(snapOf(wb), null, '无快照时应返回 null（调用方回落活对象）');
});

test('★ P2-2：`releaseL1Snapshot` 释放后不再返回快照（防长期占用内存）', () => {
    const wb = { path: 'C:/lib/d.json', keyHashes: [7] };
    freezeL1Snapshot([wb]);
    assert.ok(snapOf(wb), '冻结后应能取到');
    releaseL1Snapshot();
    assert.equal(snapOf(wb), null, '释放后应返回 null');
    assert.equal(_peek(), null, '内部引用也必须置空（否则内存不释放）');
});

test('★ P2-2：缺失字段安全（无 path 的条目跳过；字段缺失不抛错）', () => {
    const items = [
        { path: 'C:/lib/e.json' },                    // 无 keyHashes
        { keyHashes: [1] },                            // 无 path → 跳过
        null,                                          // 空项 → 跳过
        { path: 'C:/lib/f.json', keyHashes: null }     // 显式 null
    ];
    const n = freezeL1Snapshot(items);
    assert.equal(n, 2, '只有带 path 的条目进入快照（2 个）');
    const s1 = snapOf({ path: 'C:/lib/e.json' });
    assert.equal(s1.keyHashes, null, '缺失字段应为 null（不抛错）');
    assert.equal(s1.simhash, null, '缺失 simhash 应为 null');
});

test('★ P2-2：非数组的 keyHashes 被规整为 null（防脏数据）', () => {
    const wb = { path: 'C:/lib/g.json', keyHashes: { '0': 1 }, simhash: 'bad' };
    freezeL1Snapshot([wb]);
    const s = snapOf(wb);
    assert.equal(s.keyHashes, null, '对象形态的 keyHashes 应规整为 null');
    assert.equal(s.simhash, null, '非数组 simhash 应规整为 null');
});

test('★ P2-2：重复冻结覆盖旧快照（新一轮查重必须用新数据）', () => {
    freezeL1Snapshot([{ path: 'C:/lib/h.json', keyHashes: [1], entryCount: 1 }]);
    assert.equal(snapOf({ path: 'C:/lib/h.json' }).entryCount, 1);
    freezeL1Snapshot([{ path: 'C:/lib/h.json', keyHashes: [2], entryCount: 2 }]);
    assert.equal(snapOf({ path: 'C:/lib/h.json' }).entryCount, 2, '新一轮冻结应覆盖旧快照');
    assert.deepEqual(snapOf({ path: 'C:/lib/h.json' }).keyHashes, [2]);
});
