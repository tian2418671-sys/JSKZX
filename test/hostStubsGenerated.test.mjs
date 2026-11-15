/**
 * 自动生成宿主桩的门禁
 *
 * 背景：早期靠「一个插件一个插件地补 API」，插件千变万化，永远补不完。
 * 现在改为从**真实酒馆源码**生成：
 *   E:\AI\SillyTavern\public\scripts\st-context.js  → getContext() 的权威成员表
 *   E:\AI\SillyTavern\public\scripts\events.js      → event_types 常量表
 *
 * 本文件确保：
 *   1. 生成文件存在且成员数量足够（说明确实解析到了，不是空壳）
 *   2. 关键 API 一定包含在内（插件做存在性检查时不会误判「版本太旧」）
 *   3. hostStub 采用「缺失才补」策略，不会覆盖手写的真实实现
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const genPath = join(here, '../js/plugins/hostStubs.generated.js');
const genSrc = readFileSync(genPath, 'utf8');
const stubSrc = readFileSync(join(here, '../js/plugins/hostStub.js'), 'utf8');

test('生成文件必须包含足够多的 getContext 成员', () => {
    const m = genSrc.match(/export const CONTEXT_MEMBERS = (\[[\s\S]*?\]);/);
    assert.ok(m, '未找到 CONTEXT_MEMBERS');
    const list = JSON.parse(m[1]);
    assert.ok(
        list.length >= 120,
        `getContext 成员只有 ${list.length} 个，疑似解析失败（真实酒馆约 155 个）`,
    );
});

test('生成文件必须包含 event_types 常量', () => {
    const m = genSrc.match(/export const EVENT_TYPES = (\[[\s\S]*?\]);/);
    assert.ok(m, '未找到 EVENT_TYPES');
    const list = JSON.parse(m[1]);
    assert.ok(list.length >= 60, `event_types 只有 ${list.length} 个，疑似解析失败`);
});

test('插件做版本检查时常探测的 API 必须都在清单里（或由手写桩提供）', () => {
    const m = genSrc.match(/export const CONTEXT_MEMBERS = (\[[\s\S]*?\]);/);
    const list = JSON.parse(m[1]);
    // 这些必须来自「真实酒馆源码」的自动提取结果
    const fromSource = [
        'generateRaw',            // ST-iPhonie 用它判定 1.13.2+
        'setExtensionPrompt',
        'updateMessageBlock',
        'saveSettingsDebounced',
        'eventSource',
        'eventTypes',
        'extensionSettings',
        'substituteParams',
    ];
    for (const name of fromSource) {
        assert.ok(
            list.includes(name),
            `清单缺少 ${name} —— 插件做存在性检查时会误判「宿主版本太旧」并拒绝启动`,
        );
    }
});

test('源码里没有、但属于约定 API 的成员必须由 hostStub 手写提供', () => {
    // messageFormatter / getExtensionPrompt 是酒馆运行时挂载的约定 API，
    // 在 public/scripts 里搜不到对应 export，因此无法自动提取 ⇒ 必须手写。
    for (const name of ['messageFormatter', 'getExtensionPrompt']) {
        assert.ok(
            new RegExp(`\\b${name}\\s*:`).test(stubSrc),
            `hostStub 必须手写 ${name}（酒馆源码里没有该导出，自动生成覆盖不到）`,
        );
    }
});

test('hostStub 必须采用「缺失才补」策略（不得覆盖手写实现）', () => {
    assert.match(
        stubSrc,
        /if \(ctx\[__k\] === undefined\) ctx\[__k\] = __defaults\[__k\]/,
        '自动补全必须只填 undefined 的成员，否则会覆盖手写的真实实现',
    );
});

test('hostStub 必须内联生成的默认值源码', () => {
    assert.match(stubSrc, /CONTEXT_DEFAULTS_SOURCE/, 'hostStub 未引用生成的默认值源码');
    assert.match(stubSrc, /\$\{CTX_DEFAULTS_SRC\}/, 'hostStub 未把默认值内联进注入脚本');
});
