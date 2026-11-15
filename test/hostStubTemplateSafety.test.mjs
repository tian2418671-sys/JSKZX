/**
 * hostStub.js 模板字符串安全门禁
 *
 * 背景（同一个坑踩了三次，必须机械化防住）：
 *   hostStub.js 用 `return \`...\`;` 的形式拼出整个注入到沙箱的 HTML/JS。
 *   在这个外层模板字符串里出现**裸反引号**（哪怕是在注释里），会直接截断字符串，
 *   表现为整个桩块语法错误、插件全部失效，而且报错位置（例如 432:10）
 *   指向一段看起来完全正常的代码。
 *
 * 已发生的三次事故：
 *   1. 注释里写 \`\\n\` 说明转义
 *   2. 注释里写 \`obj.__proto__ = ...\`
 *   3. 注释里写 \`Cannot read properties of undefined\`
 *
 * 本测试用**词法方式**逐字符扫描，找出模板字符串内部未转义的反引号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../js/plugins/hostStub.js'), 'utf8');

/** 极简 JS 词法器：返回所有模板字符串片段（含内部 ${} 嵌套）的起始行号 */
function findTemplateStrings(text) {
    const out = [];
    let i = 0;
    let line = 1;
    const n = text.length;
    let state = 'code';           // code | lineComment | blockComment | string | template
    let stringQuote = '';
    let tplDepthStack = [];       // 模板 ${ } 嵌套深度
    let braceDepth = 0;
    let tplStartLine = 0;

    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];

        if (c === '\n') { line++; i++; continue; }

        if (state === 'code') {
            if (c === '/' && c2 === '/') { state = 'lineComment'; i += 2; continue; }
            if (c === '/' && c2 === '*') { state = 'blockComment'; i += 2; continue; }
            if (c === '"' || c === "'") { state = 'string'; stringQuote = c; i++; continue; }
            if (c === '`') { state = 'template'; tplStartLine = line; braceDepth = 0; i++; continue; }
            i++; continue;
        }
        if (state === 'lineComment') {
            if (c === '\n') state = 'code';
            i++; continue;
        }
        if (state === 'blockComment') {
            if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
            i++; continue;
        }
        if (state === 'string') {
            if (c === '\\') { i += 2; continue; }
            if (c === stringQuote) state = 'code';
            i++; continue;
        }
        if (state === 'template') {
            if (c === '\\') { i += 2; continue; }
            if (c === '$' && c2 === '{') {
                // 进入插值表达式：里面可以嵌套模板
                tplDepthStack.push(tplStartLine);
                const res = scanExpression(text, i + 2, line);
                i = res.end;
                line = res.line;
                tplDepthStack.pop();
                continue;
            }
            if (c === '`') { out.push(tplStartLine); state = 'code'; i++; continue; }
            i++; continue;
        }
    }
    return out;
}

/** 扫描 ${ } 内部表达式，直到匹配的 }，顺带处理其中的嵌套模板 */
function scanExpression(text, start, startLine) {
    let i = start;
    let line = startLine;
    let depth = 1;
    const n = text.length;
    let state = 'code';
    let quote = '';
    while (i < n && depth > 0) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '\n') { line++; i++; continue; }
        if (state === 'code') {
            if (c === '/' && c2 === '/') { state = 'lineComment'; i += 2; continue; }
            if (c === '/' && c2 === '*') { state = 'blockComment'; i += 2; continue; }
            if (c === '"' || c === "'") { state = 'string'; quote = c; i++; continue; }
            if (c === '`') {
                // 嵌套模板：递归处理
                const r = scanTemplate(text, i + 1, line);
                i = r.end; line = r.line; continue;
            }
            if (c === '{') { depth++; i++; continue; }
            if (c === '}') { depth--; i++; continue; }
            i++; continue;
        }
        if (state === 'lineComment') { if (c === '\n') state = 'code'; i++; continue; }
        if (state === 'blockComment') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; } i++; continue; }
        if (state === 'string') {
            if (c === '\\') { i += 2; continue; }
            if (c === quote) state = 'code';
            i++; continue;
        }
    }
    return { end: i, line };
}

function scanTemplate(text, start, startLine) {
    let i = start;
    let line = startLine;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '\n') { line++; i++; continue; }
        if (c === '\\') { i += 2; continue; }
        if (c === '$' && c2 === '{') {
            const r = scanExpression(text, i + 2, line);
            i = r.end; line = r.line; continue;
        }
        if (c === '`') return { end: i + 1, line };
        i++;
    }
    return { end: i, line };
}

test('hostStub.js 反引号必须成对（裸反引号会截断整个桩块）', () => {
    const count = (src.match(/`/g) || []).length;
    assert.equal(count % 2, 0, `反引号总数 ${count} 为奇数 ⇒ 存在未闭合/多余的模板字符串`);
});

test('模板字符串内部不得出现注释里的裸反引号（三次事故的根源）', () => {
    // 找出所有外层桩模板的范围（return ` ... `;）
    const ranges = [];
    let searchFrom = 0;
    for (;;) {
        const s = src.indexOf('return `', searchFrom);
        if (s === -1) break;
        const tplStart = s + 7;
        const r = scanTemplate(src, tplStart, 1);
        ranges.push([tplStart, r.end - 1]);
        searchFrom = r.end;
    }
    assert.ok(ranges.length > 0, '未找到任何 return ` 桩模板');

    // 逐行检查：若该行的起止位置落在某个桩模板内，且是注释行、且含反引号 ⇒ 违规
    const lines = src.split('\n');
    const lineStarts = [];
    let acc = 0;
    for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; }

    const offenders = [];
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
        if (!isComment || !trimmed.includes('`')) return;
        const pos = lineStarts[i];
        const inside = ranges.some(([a, b]) => pos > a && pos < b);
        if (inside) offenders.push({ line: i + 1, text: trimmed.slice(0, 70) });
    });

    assert.deepEqual(
        offenders, [],
        `以下【桩模板内部】的注释含裸反引号，会截断 hostStub.js 的外层模板字符串：\n`
        + offenders.map((o) => `  第 ${o.line} 行: ${o.text}`).join('\n'),
    );
});

test('模板字符串必须能被完整扫描（不能提前截断）', () => {
    const tplStart = src.indexOf('return `');
    assert.ok(tplStart > 0, '未找到 return ` 模板');
    const r = scanTemplate(src, tplStart + 7, 1);
    // 闭合后应当是 `;` 或换行 + 正常代码
    const after = src.slice(r.end, r.end + 30);
    assert.match(
        after,
        /^\s*[;,)\n}]/,
        `模板被提前截断，截断后内容: ${JSON.stringify(after.slice(0, 40))}`,
    );
});

test('getContext 必须同时暴露 extensionSettings 与 extension_settings（同一对象）', () => {
    assert.match(src, /extensionSettings:\s*window\.extension_settings/, 'getContext 缺 extensionSettings');
    assert.match(src, /extension_settings:\s*window\.extension_settings/, 'getContext 缺 extension_settings');
});

test('SillyTavern 上的 characters / eventSource 必须是 getter（防定义时捕获 undefined）', () => {
    assert.match(src, /get characters\(\)/, 'characters 应为 getter');
    assert.match(src, /get eventSource\(\)/, 'eventSource 应为 getter');
    assert.match(src, /get extensionSettings\(\)/, '扩展对象上的 extensionSettings 应为 getter');
});
