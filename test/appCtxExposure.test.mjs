/**
 * 防线：App.vue 模板里引用的标识符，必须都在 `ctx` 对象里。
 *
 * 背景（AR-77）：`App.vue` 的 `setup()` 末尾是 `return ctx;` ——
 *   **模板能访问的一切都来自 `ctx`**。定义了但忘记放进 `ctx` 的东西，
 *   在模板里会解析成 `undefined`，而且**完全静默**：
 *
 *     :select-folder="selectGenericFolderForSt"   // ctx 里没有 ⇒ undefined
 *       ⇒ 子组件 pickDir() 首行 if (!props.selectFolder) return;
 *       ⇒ 用户点「选择目录…」毫无反应，控制台连报错都没有
 *
 * 已有防线 `scripts/pychecks/ctx_exposure.py`（AR-13）只扫
 * `const X = ref|computed|shallowRef|reactive(...)`，
 * **扫不到箭头函数**（`const stNotify = (m, l) => {}`），所以 AR-77 没被拦住。
 * 本测试补上「模板 → ctx」这个方向的检查。
 *
 * 做法：
 *   1. 截取 App.vue 的 `<template>` 段；
 *   2. 收集其中所有**单标识符**形式的引用（属性绑定 / 插值 / v-if 等）；
 *   3. 扣掉模板自己的局部作用域变量（v-for / v-slot）；
 *   4. 与 `ctx` 正文里的标识符求差集，差集必须为空。
 *
 * 为什么只测 App.vue：项目里只有它用了 `return ctx` 这种「一个大对象平铺」
 * 的暴露方式；子组件是逐个 return 的，漏了会有 Vue 警告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_VUE = path.resolve(__dirname, '../js/components/App.vue');

/** 读取 App.vue 源码 */
function readAppVue() {
    return fs.readFileSync(APP_VUE, 'utf-8');
}

/** 截取 <template> ... </template>（最外层） */
function extractTemplate(src) {
    const start = src.indexOf('<template>');
    const end = src.lastIndexOf('</template>');
    assert.ok(start >= 0 && end > start, 'App.vue 里找不到 <template> 段');
    return src.slice(start, end);
}

/**
 * 收集模板里以**单个标识符**形式出现的引用。
 * 只收单标识符：`a + b`、`obj.x`、函数调用、字面量等一律跳过
 * （它们要么依赖局部变量，要么无法静态判定，收了会误报）。
 */
function collectTemplateRefs(tpl) {
    const refs = new Set();
    const single = (s) => /^[A-Za-z_$][\w$]*$/.test(s);

    // :attr="Ident" / v-bind:attr="Ident"
    for (const m of tpl.matchAll(/:(?:[\w.-]+)="\s*([^"]+?)\s*"/g)) {
        if (single(m[1])) refs.add(m[1]);
    }
    // v-if / v-else-if / v-show="Ident"
    for (const m of tpl.matchAll(/v-(?:if|else-if|show)="\s*([^"]+?)\s*"/g)) {
        if (single(m[1])) refs.add(m[1]);
    }
    // {{ Ident }}
    for (const m of tpl.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        if (single(m[1])) refs.add(m[1]);
    }
    // @event="Ident"（方法引用形式）
    for (const m of tpl.matchAll(/@(?:[\w.:-]+)="\s*([^"]+?)\s*"/g)) {
        if (single(m[1])) refs.add(m[1]);
    }
    return refs;
}

/**
 * 收集模板自己的局部作用域变量：
 *   v-for="item in list" / v-for="(a, i) in list" / v-for="v in obj"
 *   v-slot="{ item }" / #default="props" / ...
 */
function collectLocalScope(tpl) {
    const local = new Set();
    const addNames = (expr) => {
        for (const n of expr.split(/[,\s()[\]]+/)) {
            const t = n.trim();
            if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
        }
    };
    for (const m of tpl.matchAll(/v-for="\s*\(?([^)"]*?)\)?\s+(?:in|of)\s+/g)) {
        addNames(m[1]);
    }
    for (const m of tpl.matchAll(/(?:v-slot(?::[\w-]+)?|#[\w-]+)="\s*\{([^}]*)\}/g)) {
        addNames(m[1]);
    }
    for (const m of tpl.matchAll(/(?:v-slot(?::[\w-]+)?|#[\w-]+)="\s*([A-Za-z_$][\w$]*)\s*"/g)) {
        local.add(m[1]);
    }
    return local;
}

/** 取 `const ctx = { ... }` 到 `provide('appCtx', ctx)` 之间的正文（AR-31 约定两句紧邻） */
function extractCtxBody(src) {
    const start = src.indexOf('const ctx = {');
    assert.ok(start >= 0, 'App.vue 里找不到 `const ctx = {`');
    const provIdx = src.indexOf("provide('appCtx', ctx)");
    assert.ok(provIdx > start, "找不到 `provide('appCtx', ctx)`（AR-31 要求两句紧邻）");
    return src.slice(start, provIdx);
}

/** ctx 正文里出现过的全部标识符 */
function collectCtxIdentifiers(body) {
    return new Set([...body.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

const JS_KEYWORD_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

test('App.vue 模板引用的标识符必须都在 ctx 里（AR-77 防线）', () => {
    const src = readAppVue();
    const tpl = extractTemplate(src);
    const refs = collectTemplateRefs(tpl);
    const local = collectLocalScope(tpl);
    const inCtx = collectCtxIdentifiers(extractCtxBody(src));

    const missing = [...refs].filter(
        (r) => !inCtx.has(r) && !local.has(r) && !JS_KEYWORD_LITERALS.has(r),
    );

    assert.deepEqual(
        missing,
        [],
        'App.vue 模板引用了 ctx 里没有的标识符（模板会拿到 undefined，静默失效）：\n' +
            missing.map((n) => `  · ${n}`).join('\n') +
            '\n修法：把定义加进 `const ctx = { ... }`（注意 AR-31：ctx 与 provide 两句必须紧邻）。',
    );
});

test('AR-77 回归：StInstallModal 的 selectFolder / notify 已接入 ctx', () => {
    const src = readAppVue();
    const ctxBody = extractCtxBody(src);

    // 这两个回调曾漏在 ctx 外，导致「选择目录…」静默无反应、弹窗内 toast 全失效
    assert.match(ctxBody, /\bselectGenericFolderForSt\b/, 'selectGenericFolderForSt 必须暴露进 ctx');
    assert.match(ctxBody, /\bstNotify\b/, 'stNotify 必须暴露进 ctx');

    // 模板里的绑定也必须仍然是「直连标识符」（改名/包一层会让本文检查失效）
    const tpl = extractTemplate(src);
    assert.match(tpl, /:select-folder="selectGenericFolderForSt"/);
    assert.match(tpl, /:notify="stNotify"/);
});

test('collectTemplateRefs 能识别单标识符、跳过表达式（自检，防检查器本身失效）', () => {
    const tpl = `
        <div :a="one" :b="two.x" :c="fn()" :d="a + b" v-if="flag" v-show="visible">
            {{ plain }} {{ expr + 1 }} {{ obj.prop }}
            <span @click="handler" @input="x = 1"></span>
        </div>`;
    const refs = collectTemplateRefs(tpl);
    assert.ok(refs.has('one'), ':a="one" 应被识别');
    assert.ok(refs.has('flag'), 'v-if 应被识别');
    assert.ok(refs.has('visible'), 'v-show 应被识别');
    assert.ok(refs.has('plain'), '插值应被识别');
    assert.ok(refs.has('handler'), '@click 方法引用应被识别');
    assert.ok(!refs.has('two'), ':b="two.x" 不是单标识符，不应收录');
    assert.ok(!refs.has('fn'), ':c="fn()" 不是单标识符，不应收录');
    assert.ok(!refs.has('expr'), '插值表达式不应收录');
    assert.ok(!refs.has('obj'), 'obj.prop 不应收录');
});

test('collectLocalScope 能识别 v-for / v-slot 局部变量（自检）', () => {
    const tpl = `
        <option v-for="m in list" :value="m"></option>
        <li v-for="(item, i) in rows" :key="i">{{ item }}</li>
        <slot v-slot="{ row }"></slot>
        <template #default="props"></template>`;
    const local = collectLocalScope(tpl);
    for (const n of ['m', 'item', 'i', 'row', 'props']) {
        assert.ok(local.has(n), `${n} 应被识别为局部变量`);
    }
    assert.ok(!local.has('list'), 'v-for 的数据源不是局部变量');
});
