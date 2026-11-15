/**
 * 宿主桩「对象引用稳定性」门禁
 *
 * 真实事故（随机指令 skill-ui.js）：
 *   插件用**引用比较**判断要不要重渲染：
 *       if (metadata !== getContext().chatMetadata) { render(); return; }
 *   而桩里 getContext() 每次返回 `chatMetadata: {}`（新对象），
 *   于是判断永远成立 ⇒ render → refresh → render → ... 无限递归
 *   ⇒ RangeError: Maximum call stack size exceeded
 *
 * 真实酒馆里 chatMetadata 是同一个对象（聊天元数据），引用比较是合法且常见的写法。
 * 因此桩必须保证这些「状态容器」返回**稳定引用**：
 *   chatMetadata / extensionSettings / extension_settings / characters
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../js/plugins/hostStub.js'), 'utf8');

test('getContext().chatMetadata 必须是稳定引用（不能每次返回新对象）', () => {
    // 不得出现 `chatMetadata: {}` 这种字面量新对象
    const bad = src.match(/chatMetadata:\s*\{\s*\}/g) || [];
    assert.equal(
        bad.length, 0,
        `发现 ${bad.length} 处 chatMetadata: {} —— 每次调用返回新对象会让引用比较永远成立，`
        + '导致插件 render/refresh 无限递归（真实案例：随机指令 skill-ui.js）',
    );
    // 必须绑定到 window.chat_metadata
    assert.match(
        src,
        /chatMetadata:\s*window\.chat_metadata/,
        'getContext 的 chatMetadata 应绑定 window.chat_metadata（稳定引用）',
    );
});

test('SillyTavern.chatMetadata 必须是 getter 且指向 window.chat_metadata', () => {
    assert.match(
        src,
        /get chatMetadata\(\)\s*\{\s*return window\.chat_metadata/,
        'SillyTavern.chatMetadata 应为 getter 并返回 window.chat_metadata',
    );
});

test('extensionSettings 必须与 window.extension_settings 同一引用', () => {
    assert.match(
        src,
        /extensionSettings:\s*window\.extension_settings/,
        'getContext 应暴露 extensionSettings',
    );
    assert.match(
        src,
        /extension_settings:\s*window\.extension_settings/,
        'getContext 应暴露 extension_settings',
    );
});

test('window.chat_metadata 的初始化必须是幂等的（保留已有引用）', () => {
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        const m = code.match(/window\.chat_metadata\s*=\s*([^;\n]+)/);
        if (!m) return;
        const rhs = m[1];
        // 合法写法（均保留已有引用）：
        //   ① window.chat_metadata = window.chat_metadata || {}
        //   ② if (!window.chat_metadata) window.chat_metadata = {};     ← 本行有 if 保护
        //   ③ return window.chat_metadata || (window.chat_metadata = {}) ← 只有左侧为假才赋值
        if (/\|\|\s*\{?\s*\{?\s*\}\s*\)?/.test(rhs)) return;
        if (/if\s*\(\s*!\s*window\.chat_metadata\s*\)/.test(code)) return;
        if (/window\.chat_metadata\s*\|\|/.test(code)) return;
        // 裸赋值 `window.chat_metadata = {}` 且本行没有任何保护 ⇒ 违规
        if (/^\s*\{\s*\}\s*$/.test(rhs.trim())) {
            offenders.push({ line: i + 1, text: line.trim() });
        }
    });
    assert.deepEqual(
        offenders, [],
        'window.chat_metadata 初始化必须是幂等的，否则会丢失插件已写入的引用：\n'
        + offenders.map((o) => `  第 ${o.line} 行: ${o.text}`).join('\n'),
    );
});
