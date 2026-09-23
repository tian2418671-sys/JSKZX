/**
 * P1-2 单测：**流式 keys 提取**与「完整 parse」等价性（2026-09-23）
 *
 * 背景（v3 评审 P0-3「oversized 书查重死胡同」）：
 *   `wb:meta` 的 50MB 守卫让超大书**永远无法参与查重**。
 *   选项 B 是「流式提取 keys」（O(单条 key) 内存，不物化整个 JSON）。
 *
 * ⚠️ 本单测的核心风险：**两条路径必须产出完全相同的 keys**
 *   （否则同一本书「普通路径」与「流式路径」结果矛盾，查重会自相矛盾）。
 *
 * 做法：**从 main.js 源码里抽出 `buildKeyHashesStreaming` 与 `buildKeyHashes`**
 *   （不复制粘贴 —— 测的必须是真代码），再用**临时文件**做等价性断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');

/** 朴素花括号配对抽函数（⚠️ 必须连 `async` 前缀一起抽，否则 `await` 会落在非 async 函数里） */
function extractFn(src, name) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`未找到 function ${name}`);
    // 向前吞掉 `async ` 前缀（若有）
    let start0 = i;
    if (src.slice(Math.max(0, i - 6), i) === 'async ') start0 = i - 6;
    const start = src.indexOf('{', i);
    // ⚠️ 必须**跳过注释与字符串**再配对 —— 源码注释里出现 `{` / `}`（如 JSDoc 的 `{type:'o'}`）
    //    会让朴素配对提前结束（实测踩到：抽出的函数体不完整 → `await` 落在非 async 里）。
    let depth = 0;
    let inLine = false, inBlock = false, inStr = false, quote = '';
    for (let k = start; k < src.length; k++) {
        const c = src[k], n = src[k + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
        if (inStr) {
            if (c === '\\') { k++; continue; }
            if (c === quote) inStr = false;
            continue;
        }
        if (c === '/' && n === '/') { inLine = true; k++; continue; }
        if (c === '/' && n === '*') { inBlock = true; k++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(start0, k + 1); }
    }
    throw new Error(`${name} 花括号不配对`);
}

// 从源码抽出的依赖常量/函数（保持与 main.js 同源）
// ⚠️ `normalizeWbKey` 是**单行箭头函数常量**（不是 `function` 声明），需单独抽取
const normalizeWbKeySrc = /const normalizeWbKey = \(s\) => ([^;]+);/.exec(mainSrc);
assert.ok(normalizeWbKeySrc, 'main.js 里应能找到 normalizeWbKey（单行箭头函数）');
const normalizeWbKey = new Function(`return (s) => ${normalizeWbKeySrc[1]};`)();
const fnv1a32 = new Function(`${extractFn(mainSrc, 'fnv1a32')}; return fnv1a32;`)();
const buildKeyHashesSrc = extractFn(mainSrc, 'buildKeyHashes');
const streamingSrc = extractFn(mainSrc, 'buildKeyHashesStreaming');
const MAX_KEYS_PER_BOOK = Number(/const MAX_KEYS_PER_BOOK\s*=\s*(\d+)/.exec(mainSrc)[1]);

// 用 new Function 构造两个实现（注入依赖）
const buildKeyHashes = new Function('normalizeWbKey', 'fnv1a32', 'MAX_KEYS_PER_BOOK',
    `${buildKeyHashesSrc}; return buildKeyHashes;`)(normalizeWbKey, fnv1a32, MAX_KEYS_PER_BOOK);
const buildKeyHashesStreaming = new Function('fs', 'StringDecoder', 'normalizeWbKey', 'fnv1a32', 'MAX_KEYS_PER_BOOK',
    `${streamingSrc}; return buildKeyHashesStreaming;`)(fs, StringDecoder, normalizeWbKey, fnv1a32, MAX_KEYS_PER_BOOK);

const tmpFiles = [];
function writeTmp(content) {
    const p = path.join(os.tmpdir(), `jsk-streamkeys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, content, 'utf-8');
    tmpFiles.push(p);
    return p;
}
process.on('exit', () => { for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch { /* 忽略 */ } } });

// ══════════════════════════════════════════════════════════════
// 核心：等价性
// ══════════════════════════════════════════════════════════════
test('★ P1-2 流式提取与完整 parse **逐字节等价**（基础形态）', async () => {
    const wb = {
        name: '测试世界书',
        entries: [
            { key: ['魔法', 'Magic'], content: '内容 A' },
            { key: '战斗', content: '内容 B' },
            { key: ['剑', '剑术', 'sword'], content: '内容 C' }
        ]
    };
    const p = writeTmp(JSON.stringify(wb));
    const expected = buildKeyHashes(wb.entries);
    const got = await buildKeyHashesStreaming(p);
    assert.deepEqual(got.keyHashes, expected, '流式结果必须与完整 parse 完全一致');
    assert.equal(got.name, '测试世界书', '流式应能拿到根级 name');
});

test('★ P1-2 等价性：含嵌套对象 / 数组 / 转义字符 / Unicode 转义', async () => {
    const wb = {
        name: '复杂\\"书\\"名',
        description: { nested: { deep: ['a', 'b'] } },
        entries: [
            { key: ['包含"引号"的键'], content: '含 \\ 反斜杠 与 \n 换行转义' },
            { key: ['换行\n键', 'tab\t键'], content: '多行\n内容' },
            { key: [], content: '空 key 数组' },
            { key: null, content: 'null key' },
            { key: ['  空白前后  ', 'MAGIC', 'magic'], content: '规范化去重' }
        ],
        extensions: { jskzx: { tags: ['x'] } }
    };
    const p = writeTmp(JSON.stringify(wb));
    const expected = buildKeyHashes(wb.entries);
    const got = await buildKeyHashesStreaming(p);
    assert.deepEqual(got.keyHashes, expected, '复杂结构下仍必须逐字节等价');
});

test('★ P1-2 等价性：entries 为**对象字典**形态（V2 老格式）', async () => {
    const wb = {
        name: '字典形态',
        entries: {
            '0': { key: ['甲'], content: 'A' },
            '1': { key: ['乙', '丙'], content: 'B' }
        }
    };
    const p = writeTmp(JSON.stringify(wb));
    // 完整路径会先 Object.values 归一化（模拟 wb:meta 里的做法）
    const expected = buildKeyHashes(Object.values(wb.entries));
    const got = await buildKeyHashesStreaming(p);
    assert.deepEqual(got.keyHashes, expected, '字典形态也必须等价');
});

test('★ P1-2 等价性：中文多字节**跨越 1MB chunk 边界**（StringDecoder 关键回归）', async () => {
    // 造一个 >1MB 的书，让中文必然跨 chunk 边界 —— 若用 buf.toString('utf8') 会产生 U+FFFD
    const entries = [];
    for (let i = 0; i < 400; i++) {
        entries.push({ key: [`触发词${i}中文`, `key${i}`], content: '中'.repeat(3000) });
    }
    const wb = { name: '大书', entries };
    const p = writeTmp(JSON.stringify(wb));
    const size = fs.statSync(p).size;
    assert.ok(size > 1024 * 1024, `样本应 >1MB（实际 ${size}）`);
    const expected = buildKeyHashes(entries);
    const got = await buildKeyHashesStreaming(p);
    assert.deepEqual(got.keyHashes, expected,
        '跨 chunk 边界的中文不得产生 U+FFFD（必须用 StringDecoder）');
});

test('★ P1-2 等价性：超过 MAX_KEYS_PER_BOOK 时**截断口径一致**', async () => {
    const entries = [];
    for (let i = 0; i < MAX_KEYS_PER_BOOK + 500; i++) entries.push({ key: `唯一键-${i}` });
    const wb = { name: '超量', entries };
    const p = writeTmp(JSON.stringify(wb));
    const expected = buildKeyHashes(entries);
    const got = await buildKeyHashesStreaming(p);
    assert.equal(expected.length, MAX_KEYS_PER_BOOK, '完整路径应截断到上限');
    assert.deepEqual(got.keyHashes, expected, '流式截断口径必须一致');
    assert.equal(got.truncated, true, '应报告 truncated');
});

test('★ P1-2：`name` 在 entries **之后**也能拿到（流式不依赖顺序）', async () => {
    const wb = { entries: [{ key: 'a' }], name: '名字在后面' };
    const p = writeTmp(JSON.stringify(wb));
    const got = await buildKeyHashesStreaming(p);
    assert.equal(got.name, '名字在后面', '根级 name 位置无关');
});

test('★ P1-2：只提取 `entries[].key`，**不得**把 content 里的字符串误当 key', async () => {
    const wb = {
        name: '误提取防护',
        entries: [
            { key: ['真键'], content: '["假键1","假键2"]', comment: '假键3' }
        ],
        other: { key: ['不该被提取'] }
    };
    const p = writeTmp(JSON.stringify(wb));
    const expected = buildKeyHashes(wb.entries);
    const got = await buildKeyHashesStreaming(p);
    assert.deepEqual(got.keyHashes, expected, '只有 entries[].key 应被提取');
    assert.equal(got.keyHashes.length, 1, '不得把 content / other 里的字符串当 key');
});

test('★ P1-2：空 entries / 无 entries 时不抛错', async () => {
    const a = writeTmp(JSON.stringify({ name: '空', entries: [] }));
    const b = writeTmp(JSON.stringify({ name: '无 entries', other: 1 }));
    assert.deepEqual((await buildKeyHashesStreaming(a)).keyHashes, [], '空 entries → 空数组');
    assert.deepEqual((await buildKeyHashesStreaming(b)).keyHashes, [], '无 entries → 空数组（不抛错）');
});

test('★ P1-2：损坏 JSON 时**抛错**（由调用方降级，不静默产出错误结果）', async () => {
    const p = writeTmp('{"entries":[{"key":["a"]},');
    await assert.rejects(async () => { await buildKeyHashesStreaming(p); },
        undefined, '损坏 JSON 应抛错（调用方 catch 后降级为「只回元数据」）');
});
