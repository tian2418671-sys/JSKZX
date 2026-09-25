/**
 * 🔎 静态「未定义标识符」门禁（纯离线，基于 acorn）
 *
 * ─────────────────────────────────────────────────────────────
 * 🐞 为什么需要它（2026-09-25 真实事故）
 * ─────────────────────────────────────────────────────────────
 * AR-51 改动里，一个展示用的取签名助手被写在了**第一个 `forEach` 回调内部**，
 * 却在**第二个 `forEach` 回调（兄弟闭包）里**被引用 ——
 * `npm test` **全绿**（单测不跑整个查重流程）、`vite build` **通过**（只验编译）、
 * 静态检查也没报（两个名字在文件里都存在），**只有真实启动跑一次查重**才炸：
 * `内容级版本查重异常: ReferenceError: fullSigOf is not defined` ⇒ 查重结果 **0 组**。
 * ⇒ 「定义在另一个闭包」这类错**编译期/单测都看不见**，必须用**作用域感知**的静态检查兜住。
 *
 * ─────────────────────────────────────────────────────────────
 * 它做什么 / 不做什么
 * ─────────────────────────────────────────────────────────────
 * ✅ 解析每个 `.js`（ESM/CJS 均可），按「函数 / 块 / catch / for 声明」建作用域，
 *    逐个 `Identifier` 判断是否为**引用**，再查是否在作用域链或全局白名单里 ⇒ 报「未定义」。
 * ❌ **不是**完整 linter：不查类型、不查未使用变量、不管跨文件导出是否存在；
 *    块内 `let` 会被归到外层块（**只会漏报、不会误报**，方向上安全）。
 *
 * 用法：
 *   `node scripts/check-undefined-scope.mjs [目录=js]`  → 有未定义标识符时退出码 1
 *   `node scripts/check-undefined-scope.mjs js main.js preload.js`
 * 门禁：`test/scopeUndefined.test.mjs`（含「能否抓住真错」的正向对照）
 */
import { parse } from 'acorn';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 运行环境自带的全局名（浏览器 + Node + 测试框架）；**新增前先确认真的是全局** */
export const GLOBALS = new Set([
    // 浏览器
    'window', 'document', 'console', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'self', 'globalThis', 'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia', 'btoa', 'atob',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'reportError',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
    'Response', 'Request', 'Headers', 'FormData', 'ReadableStream', 'WritableStream', 'TransformStream',
    'performance', 'fetch', 'crypto', 'AbortController', 'AbortSignal', 'Blob', 'File', 'FileReader',
    'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'WebSocket', 'MessageChannel', 'MessagePort',
    'Worker', 'Image', 'OffscreenCanvas', 'ImageData', 'DOMParser', 'XMLSerializer', 'Event', 'CustomEvent',
    'EventTarget', 'Element', 'HTMLElement', 'Node', 'NodeList', 'MutationObserver', 'ResizeObserver',
    'IntersectionObserver', 'CanvasRenderingContext2D', 'addEventListener', 'removeEventListener',
    // 语言内建
    'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
    'Symbol', 'Proxy', 'Reflect', 'BigInt', 'Intl', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
    'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'Infinity', 'NaN', 'undefined', 'arguments', 'eval', 'Function', 'globalThis',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    // CJS / Node
    'process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer', 'URLSearchParams',
    // 测试框架（万一扫到 test/）
    'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'before', 'after'
]);

function bindPattern(node, out) {
    if (!node) return;
    switch (node.type) {
        case 'Identifier': out.add(node.name); break;
        case 'ObjectPattern':
            for (const p of node.properties) {
                if (p.type === 'RestElement') bindPattern(p.argument, out);
                else bindPattern(p.value || p.argument || p.key, out);
            }
            break;
        case 'ArrayPattern': for (const el of node.elements) bindPattern(el, out); break;
        case 'AssignmentPattern': bindPattern(node.left, out); break;
        case 'RestElement': bindPattern(node.argument, out); break;
        default: break;
    }
}

/**
 * 收集一个作用域内**声明**的名字。
 * ⚠️ 遇到嵌套函数/类**只登记其名字、不进函数体**（它们的内部声明属于它们自己的作用域）
 *    —— 这正是本检查能抓住「定义在另一个闭包里」的关键。
 */
function collectDeclared(node, out) {
    const visit = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) visit(x); return; }
        if (typeof n.type !== 'string') return;
        switch (n.type) {
            case 'VariableDeclaration':
                for (const d of n.declarations) { bindPattern(d.id, out); visit(d.init); }
                return;
            case 'FunctionDeclaration':
            case 'ClassDeclaration':
                if (n.id) out.add(n.id.name);
                return;
            case 'ImportDeclaration':
                for (const s of n.specifiers) out.add(s.local.name);
                return;
            case 'FunctionExpression':
            case 'ArrowFunctionExpression':
                return;
            default: break;
        }
        for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
            const v = n[k];
            if (Array.isArray(v)) { for (const x of v) visit(x); }
            else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
        }
    };
    visit(node);
}

/** 该 `Identifier` 是否处于「引用」位置（成员名 / 属性键 / 标签 / 导入绑定 … 不算引用） */
function isReference(n, p, key) {
    if (!p || n.type !== 'Identifier') return false;
    if (p.type === 'MetaProperty') return false;                                  // import.meta
    if (p.type === 'ImportAttribute') return false;                               // with { type: 'json' }
    if (p.type === 'MemberExpression') return key === 'object' || (key === 'property' && p.computed);
    if (p.type === 'Property' || p.type === 'PropertyDefinition' || p.type === 'MethodDefinition') {
        if (key === 'key' && !p.computed) return p.type === 'Property' ? p.shorthand : false;
        return true;                                                              // value / computed key
    }
    if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return false;
    if (p.type === 'ImportSpecifier' || p.type === 'ImportDefaultSpecifier' || p.type === 'ImportNamespaceSpecifier') return false;
    // `export { x } from '...'` 是**再导出**，不是对本地名字的引用
    if (p.type === 'ExportSpecifier') return key === 'local' && !p.__hasSource;
    if (p.type === 'VariableDeclarator' && key === 'id') return false;
    if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression'
        || p.type === 'ClassDeclaration' || p.type === 'ClassExpression') && (key === 'id' || key === 'params')) return false;
    if (p.type === 'CatchClause' && key === 'param') return false;
    if ((p.type === 'ForOfStatement' || p.type === 'ForInStatement') && key === 'left') return false;
    return true;
}

const SCOPE_NODES = new Set([
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
    'BlockStatement', 'Program', 'ForStatement', 'ForOfStatement', 'ForInStatement',
    'CatchClause', 'ClassBody', 'StaticBlock', 'SwitchStatement'
]);

/**
 * 检查一段源码，返回 `[{ name, line, column }]`（空数组 = 通过）
 * @param {string} src
 * @param {string} [filename] 仅用于报错信息
 */
export function checkSource(src, filename = '<inline>') {
    let ast;
    try {
        ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
    } catch (e) {
        // 语法错也要**如实上报**（当作一个问题），不能静默「通过」
        return [{ name: '<parse-error>', line: e.loc ? e.loc.line : 0, column: e.loc ? e.loc.column + 1 : 0, file: filename, message: e.message }];
    }
    const scopeStack = [new Set()];
    collectDeclared(ast, scopeStack[0]);
    const problems = [];
    const seen = new Set();
    const declared = (name) => { for (const s of scopeStack) if (s.has(name)) return true; return false; };

    (function visit(node, parent, key) {
        if (!node || typeof node !== 'object') return;
        let pushed = false;
        if (SCOPE_NODES.has(node.type)) {
            const sc = new Set();
            if (node.type === 'CatchClause') bindPattern(node.param, sc);
            if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') bindPattern(node.left, sc);
            if (node.type === 'ForStatement' && node.init && node.init.type === 'VariableDeclaration') bindPattern(node.init, sc);
            if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
                for (const p of node.params) bindPattern(p, sc);
            }
            if (node.type !== 'Program') collectDeclared(node, sc);
            scopeStack.push(sc);
            pushed = true;
        }
        // `export { a } from './x.js'` 的 specifier 不是本地引用
        if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
            for (const s of (node.specifiers || [])) s.__hasSource = !!node.source;
        }

        if (node.type === 'Identifier' && isReference(node, parent, key)) {
            const k = node.name + ':' + node.loc.start.line + ':' + node.loc.start.column;
            if (!GLOBALS.has(node.name) && !declared(node.name) && !seen.has(k)) {
                seen.add(k);
                problems.push({ name: node.name, line: node.loc.start.line, column: node.loc.start.column + 1, file: filename });
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) visit(c, node, k); }
            else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, node, k);
        }
        if (pushed) scopeStack.pop();
    })(ast, null, null);
    return problems;
}

/** 检查单个文件（读文件 → `checkSource`；解析失败也会作为问题返回） */
export function checkFile(file) {
    let src;
    try { src = readFileSync(file, 'utf8'); }
    catch (e) { return [{ name: '<read-error>', line: 0, column: 0, file, message: e.message }]; }
    try { return checkSource(src, file); }
    catch (e) { return [{ name: '<parse-error>', line: e.loc ? e.loc.line : 0, column: e.loc ? e.loc.column + 1 : 0, file, message: e.message }]; }
}

/** 递归收集目录下所有 `.js`（跳过 node_modules / dist / web 等产物目录） */
export function collectJsFiles(paths, skipDirs = ['node_modules', 'dist', 'dist_new', 'web', 'vendor', '.git', 'models']) {
    const out = [];
    const walk = (p) => {
        let st;
        try { st = statSync(p); } catch { return; }
        if (st.isDirectory()) {
            const base = p.split(/[\\/]/).pop();
            if (skipDirs.includes(base)) return;
            for (const e of readdirSync(p)) walk(join(p, e));
        } else if (p.endsWith('.js')) out.push(p);
    };
    for (const p of paths) walk(p);
    return out;
}

/** 检查一批文件/目录 → `{ files, problems }` */
export function checkPaths(paths) {
    const files = collectJsFiles(paths);
    const problems = [];
    for (const f of files) problems.push(...checkFile(f));
    return { files, problems };
}

// ── CLI ───────────────────────────────────────────────────────
const isMain = (() => {
    try {
        const url = new URL(import.meta.url).pathname;
        return process.argv[1] && (url.endsWith(process.argv[1].replace(/\\/g, '/')) || url.endsWith('/' + process.argv[1].replace(/\\/g, '/')));
    } catch { return false; }
})();
if (isMain || process.argv[1] && process.argv[1].includes('check-undefined-scope')) {
    const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const targets = args.length ? args : ['js', 'main.js', 'preload.js'].filter(p => existsSync(p));
    const { files, problems } = checkPaths(targets);
    for (const p of problems) {
        console.log(`${relative('.', p.file)}:${p.line}:${p.column}  ${p.name}${p.message ? '  (' + p.message + ')' : ''}`);
    }
    console.log(`\n扫描 ${files.length} 个文件，未定义标识符 ${problems.length} 个`);
    process.exit(problems.length ? 1 : 0);
}
