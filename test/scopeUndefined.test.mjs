/**
 * 🔎 静态「未定义标识符」门禁单测（2026-09-25，AR-51 事故产物）
 *
 * 事故：展示用的取签名助手写在**第一个 `forEach` 回调里**，却在**第二个（兄弟）回调里**被引用 ——
 * `npm test` 全绿、`vite build` 通过、连文件里两个名字都在（人眼静态扫也容易漏），
 * 只有**真实启动跑一次查重**才炸 `ReferenceError: fullSigOf is not defined` ⇒ 结果 0 组。
 * ⇒ 本文件把「作用域感知」的静态检查固化成门禁：**这类错以后在 `npm test` 就拦住**。
 *
 * 覆盖：
 *   · ★ **正向对照**：复现事故形状（兄弟闭包引用）→ 必须被抓出（否则门禁是假的）
 *   · 常见的**误报陷阱**：全局名 / `import.meta` / 导入属性 / 再导出 / 简写属性 / 成员名 / 对象键
 *   · ★ **真实门禁**：`js/**` + `main.js` + `preload.js` 当前必须 **0 未定义**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, checkPaths } from '../scripts/check-undefined-scope.mjs';

// ══════════════════════════════════════════════════════════════
// ★ 正向对照：能抓住真错
// ══════════════════════════════════════════════════════════════
test('★ 正向对照：兄弟闭包引用（事故原形）必须被抓出', () => {
    const src = `
export function useThing() {
    let target = null;
    return [].map(list => {
        list.forEach(v => {
            target = () => v;
        });
        list.forEach(v => {
            v.tag = fullSigOf(v);   // ❌ 定义在另一个闭包里
            void target;
        });
    });
}
`;
    const p = checkSource(src, 'fixture.js');
    assert.equal(p.length, 1, `必须恰好抓出 1 个未定义（实测 ${JSON.stringify(p)}）`);
    assert.equal(p[0].name, 'fullSigOf');
});

test('★ 正向对照：跨函数引用另一个函数的局部变量也必须被抓出', () => {
    const src = `
function a() { const inner = 1; return inner; }
function b() { return inner; }
export { a, b };
`;
    const p = checkSource(src, 'fixture.js');
    assert.equal(p.length, 1);
    assert.equal(p[0].name, 'inner');
});

// ══════════════════════════════════════════════════════════════
// 误报陷阱（这些**不该**被报）
// ══════════════════════════════════════════════════════════════
test('不误报：全局名 / 成员名 / 对象键 / 简写属性 / 标签', () => {
    const src = `
export function f(obj, arr) {
    const { x, y: renamed } = obj;
    const o = { x, plain: 1, ['dyn' + key]: 2 };
    window.electronAPI.run(o.plain, obj.x, arr.length, Math.max(1, Number('2')), JSON.stringify({}));
    outer: for (let i = 0; i < arr.length; i++) { if (i > 3) break outer; }
    return renamed + o.x + process.pid;
}
const key = 'k';
`;
    assert.deepEqual(checkSource(src, 'fixture.js'), []);
});

test('不误报：import.meta / 导入属性 / 再导出', () => {
    const src = `
import meta2 from './x.json' with { type: 'json' };
export { something } from './y.js';
export function where() { return import.meta.url + meta2.a; }
`;
    assert.deepEqual(checkSource(src, 'fixture.js'), []);
});

test('不误报：参数默认值可引用前面的参数；catch / for-of 绑定可用', () => {
    const src = `
export function f(a, b = a.length) {
    try { throw new Error('x'); } catch (err) { console.log(err.message); }
    for (const item of b) { if (item) console.log(item); }
    for (let i = 0, n = b.length; i < n; i++) console.log(i);
    return b;
}
`;
    assert.deepEqual(checkSource(src, 'fixture.js'), []);
});

test('语法错误 → 作为问题上报（不静默通过）', () => {
    const p = checkSource('export function broken( {', 'fixture.js');
    assert.equal(p.length, 1);
    assert.equal(p[0].name, '<parse-error>');
});

// ══════════════════════════════════════════════════════════════
// ★ 真实门禁
// ══════════════════════════════════════════════════════════════
test('★ 门禁：js/** + main.js + preload.js 必须 0 未定义标识符', () => {
    const { files, problems } = checkPaths(['js', 'main.js', 'preload.js']);
    assert.ok(files.length > 50, `至少要扫到 50 个文件（实测 ${files.length}）`);
    const msg = problems.slice(0, 10).map(p => `${p.file}:${p.line} ${p.name}`).join('\n');
    assert.equal(problems.length, 0,
        `发现 ${problems.length} 处未定义标识符（这类错运行期才会炸、单测抓不到）：\n${msg}`);
});
