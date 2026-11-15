/**
 * 宿主桩 jQuery 兼容层门禁（防回归）
 *
 * 真实事故（AutoRandomInput 随机指令）：
 *   插件写的是 `$('#ari-copy-rule').addEventListener('click', ...)`
 *   —— 用 jQuery 取元素、却调用**原生 DOM 方法**。
 *
 *   而桩里曾有一行：
 *       obj.__proto__ = $ ? Object.getPrototypeOf($.fn || {}) : Object.prototype;
 *   `$.fn` 本身由 makeObj([]) 创建 ⇒ 循环依赖。首次执行时 `$.fn` 还是
 *   undefined，`getPrototypeOf({})` 返回普通对象原型，整个对象被"降级"成
 *   plain object，原生方法全部丢失。报错信息极其难猜：
 *       TypeError: Cannot read properties of undefined
 *                  (reading 'function(){ return undefined; }')
 *   （函数被字符串化后当成了属性名）
 *
 * 本文件锁死两条契约：
 *   1. makeObj 里**不得**再出现 obj.__proto__ 赋值（会污染原型链）；
 *   2. 必须显式提供原生 DOM 方法镜像（for...in 拿不到原型方法）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../js/plugins/hostStub.js'), 'utf8');

test('jQuery 桩不得给 obj.__proto__ 赋值（循环依赖会污染原型链）', () => {
    // 允许出现在注释里，但不得是实际赋值语句
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;  // 整行注释跳过
        const code = line.replace(/\/\/.*$/, '');   // 去掉行尾注释
        if (/obj\.__proto__\s*=/.test(code)) offenders.push(i + 1);
    });
    assert.deepEqual(
        offenders, [],
        `第 ${offenders.join(', ')} 行给 obj.__proto__ 赋值了 —— 会导致原生 DOM 方法丢失`,
    );
});

test('必须显式镜像原生 DOM 方法（for...in 遍历不到原型方法）', () => {
    assert.match(src, /NATIVE_EL_METHODS/, '缺少原生方法白名单');
    for (const m of ['addEventListener', 'removeEventListener', 'querySelectorAll', 'setAttribute']) {
        assert.ok(
            src.includes(`'${m}'`),
            `原生方法镜像缺少 ${m} —— 插件用 $() 后调原生 API 会报错`,
        );
    }
});

test('原生方法镜像必须在 makeObj 内部（每个 jQuery 对象都可用）', () => {
    const makeObjIdx = src.indexOf('function makeObj(');
    const mirrorIdx = src.indexOf('NATIVE_EL_METHODS');
    assert.ok(makeObjIdx > 0, '未找到 makeObj');
    assert.ok(mirrorIdx > makeObjIdx, '原生方法镜像必须在 makeObj 内');
});

test('空集合调用 addEventListener 不得抛异常（返回自身以保持链式）', () => {
    // 空集合（选择器没命中）也要能不炸：插件常在 DOM 尚未就绪时绑定事件
    assert.match(
        src,
        /return k === 'addEventListener' \|\| k === 'removeEventListener' \? obj : undefined/,
        '空集合调用 addEventListener 应返回 obj（链式），不得抛错',
    );
});

test('桩模板字符串内不得有裸反引号（会截断整个桩块）', () => {
    // hostStub.js 用模板字符串拼 HTML；注释里出现裸反引号会直接截断代码，
    // 表现为「整个桩块语法错误」。历史上踩过两次（\n 转义 / 反引号）。
    // 粗粒度但有效的检查：文件里反引号总数应为偶数。
    const count = (src.match(/`/g) || []).length;
    assert.equal(count % 2, 0, `反引号总数 ${count} 为奇数 ⇒ 有未闭合/多余的模板字符串`);
});
