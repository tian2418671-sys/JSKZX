/**
 * 🔍 前端按钮/事件绑定审计：防止「点了没反应」的无效按钮
 * ─────────────────────────────────────────────────────────────
 * 背景：本项目反复踩「定义了 ≠ 能用」的坑（AR-13 / AR-62 / AR-77 / AR-79）：
 *   · `App.vue` 用 `return ctx` 暴露能力，模板里写到但 ctx 漏项 ⇒ 静默 undefined；
 *   · 子组件用 `inject('appCtx')` 取函数，App.vue 没 expose ⇒ 同样静默 undefined；
 *   · 组件模板写了 `@click="foo"` 但 script 里根本没定义 foo ⇒ 点了毫无反应。
 *
 * 现有防线覆盖不到的部分：
 *   · `test/appCtxExposure.test.mjs` 只查 **App.vue 自己的模板 → ctx**；
 *   · `scripts/pychecks/ctx_exposure.py` 只扫 `const X = ref(...)`，扫不到箭头函数；
 *   · `npm run guard:scope` 只查「已定义标识符是否在作用域内」，查不到「模板引用了不存在的名字」。
 *
 * 本脚本补两块：
 *   检查 A：每个 .vue 的模板事件绑定（@click / @contextmenu / @change …）里用到的函数，
 *           必须在该文件的 <script> 里有定义（const / function / 对象方法 / async 方法）。
 *   检查 B：组件里出现的 `ctx.NAME` / `props.ctx.NAME` 引用，
 *           必须存在于 App.vue 的 `const ctx = { … }` 中。
 *
 * 用法：
 *   node scripts/check-vue-bindings.mjs          # 报告
 *   node scripts/check-vue-bindings.mjs --strict # 有问题则退出码 1（可挂 CI / predeploy）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const STRICT = process.argv.includes('--strict');

/** 递归收集 .vue 文件 */
function collectVue(dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectVue(full, out);
        else if (e.name.endsWith('.vue')) out.push(full);
    }
    return out;
}

/** 取 <template> 段（最外层） */
function templateOf(src) {
    const i = src.indexOf('<template>');
    if (i < 0) return '';
    const j = src.lastIndexOf('</template>');
    return j > i ? src.slice(i + 10, j) : '';
}

/** 取 <script> 段（可能多段，全拼起来） */
function scriptOf(src) {
    const parts = [];
    const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(src))) parts.push(m[1]);
    return parts.join('\n');
}

/** JS 关键字 / 内置，不算「需要定义」 */
const BUILTIN = new Set([
    'if', 'else', 'for', 'while', 'return', 'function', 'new', 'typeof', 'void', 'delete',
    'true', 'false', 'null', 'undefined', 'this', 'in', 'of', 'await', 'async', 'try', 'catch',
    'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'parseInt', 'parseFloat',
    'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'console', 'alert', 'confirm', 'prompt',
    'Map', 'Set', 'Promise', 'Error', 'RegExp', 'Intl', 'structuredClone',
]);

/** 以 $ 开头的都是 Vue 模板内置（$emit / $event / $refs / $attrs…），不需要定义 */
const isVueBuiltin = (name) => name.startsWith('$');

/**
 * 从模板里提取「事件绑定回调名」。
 * 覆盖：@click="fn" / @click="fn(...)" / @click.stop="a(); b()" / @change="(e) => fn(e)"
 */
function extractHandlers(tpl) {
    const out = new Map(); // name -> 原始表达式（便于报告）
    const attrRe = /@[\w.-]+(?:\.[\w-]+)*\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(tpl))) {
        const expr = m[1];
        // 跳过内联箭头函数的参数名（简单处理：取调用形式的标识符）
        // ⚠️ 必须排除成员调用（如 Math.max(…) / toast.onClick(…)）—— 前面有点号的不是模板作用域的顶层函数
        for (const c of expr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
            const name = c[1];
            if (BUILTIN.has(name) || isVueBuiltin(name)) continue;
            if (!out.has(name)) out.set(name, expr.trim());
        }
        // 裸引用：整个表达式就是一个标识符
        const bare = expr.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(bare) && !BUILTIN.has(bare) && !isVueBuiltin(bare) && !out.has(bare)) {
            out.set(bare, bare);
        }
    }
    return out;
}

/** 该名字在 script 段里是否有定义（const/let/var/function/方法/属性/async 方法） */
function isDefined(script, name) {
    const e = name.replace(/\$/g, '\\$');
    const pats = [
        new RegExp(`(?:const|let|var)\\s+${e}\\b`),
        // 数组解构：const [total, slice, changePage] = makePager(…)
        new RegExp(`(?:const|let|var)\\s*\\[[^\\]]*\\b${e}\\b[^\\]]*\\]\\s*=`),
        // 对象解构：const { a, NAME } = …
        new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${e}\\b[^}]*\\}\\s*=`),
        new RegExp(`\\bfunction\\s+${e}\\s*\\(`),
        new RegExp(`\\basync\\s+${e}\\s*\\(`),
        new RegExp(`(?:^|[\\s,{])${e}\\s*:\\s`, 'm'),          // 对象属性 key:
        new RegExp(`(?:^|[\\s,{])${e}\\s*\\([^)]*\\)\\s*\\{`, 'm'), // 对象方法 name() {
        new RegExp(`\\b${e}\\s*=\\s*(?:async\\s*)?\\(`, 'm'),   // name = (…) =>
    ];
    return pats.some((re) => re.test(script));
}

/** 从 App.vue 的 `const ctx = { … }` 中提取键名 */
function extractCtxKeys(appSrc) {
    const start = appSrc.indexOf('const ctx = {');
    if (start < 0) return new Set();
    const end = appSrc.indexOf('return ctx;', start);
    const body = appSrc.slice(start, end > 0 ? end : undefined);
    // 去掉注释，避免注释里的词被当成键
    const cleaned = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const keys = new Set();
    // ⚠️ ctx 是**多列排布**（一行好几个键），不能只认行首第一个标识符。
    //    这里宽松收集所有标识符 —— 宁可「多认」（漏报）也不要「少认」（成片误报）。
    for (const m of cleaned.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?=[,:}\n])/g)) keys.add(m[1]);
    return keys;
}

function main() {
    const files = collectVue(JS_DIR);
    const appVue = path.join(JS_DIR, 'components', 'App.vue');
    const ctxKeys = extractCtxKeys(fs.readFileSync(appVue, 'utf-8'));

    console.log(`🔍 审计 ${files.length} 个 .vue 文件（App.vue ctx 键 ${ctxKeys.size} 个）\n`);

    const problems = [];

    for (const f of files) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        const src = fs.readFileSync(f, 'utf-8');
        const tpl = templateOf(src);
        const script = scriptOf(src);
        if (!tpl) continue;

        // ── 检查 A：模板事件回调必须有定义 ──
        //    App.vue 例外：它的模板靠 `return ctx` 供能力，已在 test/appCtxExposure.test.mjs
        //    里用更严格的口径检查（模板引用 ⊆ ctx 键），这里跳过避免重复与误报。
        if (rel !== 'js/components/App.vue') {
            for (const [name, expr] of extractHandlers(tpl)) {
                if (!isDefined(script, name)) {
                    problems.push({ file: rel, type: 'A', name, detail: expr.slice(0, 70) });
                }
            }
        }

        // ── 检查 B：按钮/事件绑定里用到的 ctx.NAME 必须存在于 App.vue 的 ctx ──
        //    ⚠️ 只查**模板事件绑定表达式**里的引用（用户点下去真正会执行的那些），
        //    script 里的 ctx.xxx 可能是注释/条件调用（如 ctx.addLog?.()），噪声大且不直接对应按钮。
        //    ⚠️ 只对**真正注入了 appCtx** 的组件检查：很多组件内部另有自己的 `const ctx = {…}`。
        if (rel !== 'js/components/App.vue' && /inject\(\s*['"]appCtx['"]\s*\)/.test(script)) {
            const tplCtxRefs = new Set();
            for (const m of tpl.matchAll(/@[\w.-]+(?:\.[\w-]+)*\s*=\s*"([^"]*)"/g)) {
                for (const c of m[1].matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) tplCtxRefs.add(c[1]);
            }
            for (const name of tplCtxRefs) {
                if (!ctxKeys.has(name)) {
                    problems.push({ file: rel, type: 'B', name, detail: '模板事件绑定里用了，但 App.vue 的 ctx 中没有该键' });
                }
            }
        }
    }

    if (!problems.length) {
        console.log('✅ 未发现无效绑定');
        return 0;
    }

    const a = problems.filter((p) => p.type === 'A');
    const b = problems.filter((p) => p.type === 'B');

    if (a.length) {
        console.log(`\n❌ A 类：模板事件回调在 script 中没有定义（${a.length} 处）—— 点了不会有任何反应`);
        for (const p of a) console.log(`   ${p.file}\n       → ${p.name}   (绑定表达式: ${p.detail})`);
    }
    if (b.length) {
        console.log(`\n❌ B 类：ctx.NAME 在 App.vue 的 ctx 中不存在（${b.length} 处）—— 运行时是 undefined`);
        for (const p of b) console.log(`   ${p.file}\n       → ctx.${p.name}`);
    }

    console.log(`\n合计 ${problems.length} 处可疑绑定`);
    return STRICT ? 1 : 0;
}

process.exit(main());
