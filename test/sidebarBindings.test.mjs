import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 🛡️ AR-40 防再犯：**子组件 setup return 的绑定完整性**（AR-13 四步链的第 4 步）。
//
// 背景（AR-40，2026-09-21 用户报「点世界书库整个侧边栏消失」）：
//   `SidebarPanel.vue` 世界书分支模板调用 `wbEntryCount(wb)`，但该符号**没进 setup return**
//   → 渲染期 `_ctx.wbEntryCount is not a function` → Vue 卸载整个组件 → 侧边栏消失。
//   编译（`vite build`）与单测都查不出（纯渲染期错误）。
//
// 为什么现有防线没拦住：
//   `scripts/pychecks/ctx_exposure.py` 只校验 **App.vue 的 ctx 暴露**（第 3 步）；
//   子组件 return 解构（第 4 步）**没有机器检查** → 本文件补这个盲区。
//
// 检查做法：
//   ① 从 `<template>` 段抓出「被调用的标识符」`name(`；
//   ② 从 `setup()` 的 return 对象抓出全部键名；
//   ③ 差集（排除 JS 内建 / Vue 内建 / setup 内部本地定义）非空 → 断言失败。
//
// ⚠️ 白名单只应放「确实不需要绑定」的项（如 Vue 全局宏、模板编译产物）。
//    绝不要为了让它变绿而把真缺失项塞进白名单 —— 那正是本检查要防的。

const SRC = 'js/components/SidebarPanel.vue';

/** 剥掉 HTML 注释与 JS 行/块注释（避免注释里的 `All(...)` 之类文本造成误报） */
function stripComments(s) {
    return s
        .replace(/<!--[\s\S]*?-->/g, ' ')      // HTML 注释
        .replace(/\/\*[\s\S]*?\*\//g, ' ')      // JS 块注释
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // JS 行注释（避开 http:// 这类）
}

/**
 * 剥掉内联样式（`style="..."` / `:style="..."`）与 `<style>` 段。
 *
 * 为什么必须剥：CSS 里的 `repeat(2, minmax(0, 1fr))` 会被「模板里被调用的标识符」
 * 正则当成 `repeat(` / `minmax(` → **误报为未绑定函数**。
 * ⚠️ 刻意**不**用白名单绕过 —— 白名单会连带掩盖真正的漏绑定（AR-40 的教训就是
 *    「为了让检查变绿而放宽」）。剥掉样式是「消除非 JS 文本」，语义上更正确。
 */
function stripStyles(s) {
    return s
        .replace(/\s:?style="[^"]*"/g, ' ')        // 内联 style / :style（属性值不含引号）
        .replace(/\s:?style='[^']*'/g, ' ')        // 单引号变体
        .replace(/<style[\s\S]*?<\/style>/gi, ' '); // <style> 段
}

/** 解析单个 .vue：返回模板中被调用但未绑定的标识符 */
function findUnboundCalls(src) {
    // ⚠️ 致命坑（2026-09-21 二次踩中）：**必须取最后一个 `</template>`**。
    //    本组件模板里有 7 个 `</template>`（内层 v-if 分支各有一个，157/266/364/564/625/697/709）。
    //    旧写法用 `src.indexOf('</template>')` 只截到第 157 行 → 世界书分支（503 行）**根本不在
    //    待检文本里** → 检查器对世界书分支完全失明 → AR-40 漏检（「假绿」的真正原因）。
    //    取最后一个才等于「根模板结束」。
    const templateEnd = src.lastIndexOf('</template>');
    assert.ok(templateEnd > 0, '未能定位 </template>');
    // 先剥样式（CSS 函数如 repeat/minmax 不是 JS 调用）再剥注释
    const tpl = stripComments(stripStyles(src.slice(0, templateEnd)));
    // ⚠️ 反向验证中发现的另一个坑：**return 块内的注释也会被当成键名**。
    //    曾经 `wbEntryCount` 只出现在 return 块的一条注释里，检查就被骗过（假绿）。
    //    故这里必须先剥注释，再提取键名 —— 否则「注释里提一下」就等于「已绑定」。
    const rest = stripComments(src.slice(templateEnd));

    // setup() 的 return 对象（8 空格缩进的 return { ... };）
    const m = rest.match(/\n\s{8}return \{([\s\S]*?)\n\s{8}\};/);
    assert.ok(m, '未能定位 setup 的 return 对象');
    const retKeys = new Set(m[1].match(/[A-Za-z_$][\w$]*/g) || []);

    // setup 内部本地定义（含本地函数与常量）
    const localDefs = new Set(rest.match(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)
        ?.map(s => s.replace(/^(?:const|let|var|function)\s+/, '')) || []);

    // 模板中被「调用」的标识符：name( （排除成员调用 obj.name(）
    const calls = new Set();
    for (const mm of tpl.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(mm[1]);

    // JS / Vue 内建与模板编译产物（确实无需 setup 绑定）
    // ⚠️ 只放「语言/框架内建」，绝不放应用自己的符号 —— 否则防线就形同虚设。
    const BUILTIN = new Set([
        '$event', '$refs', '$nextTick', '$slots', '$attrs', '$props', '$emit',
        'JSON', 'Object', 'Array', 'Math', 'String', 'Number', 'Boolean', 'Date',
        'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'BigInt',
        'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        // Vue 组合式 API：在 setup 里调用（不在模板里），这里兜底防止注释残留
        'inject', 'provide', 'ref', 'reactive', 'computed', 'watch', 'watchEffect',
        'onMounted', 'onUnmounted', 'nextTick', 'defineProps', 'defineEmits',
    ]);

    const unbound = [...calls].filter(
        name => !retKeys.has(name) && !localDefs.has(name) && !BUILTIN.has(name) && !name.startsWith('_')
    );
    return unbound.sort();
}

test('AR-40：SidebarPanel 模板调用的每个函数都必须出现在 setup return 里', () => {
    const src = readFileSync(SRC, 'utf-8');
    const unbound = findUnboundCalls(src);
    assert.deepEqual(unbound, [],
        `以下标识符在模板里被调用，但没有加入 setup() 的 return —— 渲染期会抛 ` +
        `"_ctx.X is not a function" 并**卸载整个侧边栏**（AR-40）：\n  ${unbound.join('\n  ')}\n` +
        `修法：在 setup return 对象里补 "X: ctx.X,"`);
});

test('AR-40：自检 —— 该断言确实能抓到「模板调用但未绑定」的缺失（防止检查本身失效）', () => {
    // 构造一段最小复现：模板调用 missingFn，但 return 里没有它
    const fake = `<template>
    <div>{{ missingFn(1) }}</div>
</template>
<script>
export default {
    setup() {
        const local = 1;
        return {
            local
        };
    }
};
</script>`;
    const unbound = findUnboundCalls(fake);
    assert.deepEqual(unbound, ['missingFn'],
        '自检失败：检查器没有识别出未绑定的 missingFn —— 说明本防线已失效，需修检查逻辑');
});

test('AR-40：绑定齐全时不得误报（防止白名单/正则过宽导致假失败）', () => {
    const fake = `<template>
    <div>{{ shown(count) }}</div>
</template>
<script>
export default {
    setup() {
        const shown = (n) => String(n);
        return {
            shown,
            count: 3
        };
    }
};
</script>`;
    const unbound = findUnboundCalls(fake);
    assert.deepEqual(unbound, [], `不应误报，实际报出：${unbound.join(',')}`);
});

test('AR-40：注释里提到某符号**不能**算作已绑定（反向验证踩过的坑）', () => {
    // 真实踩坑：修复时在 return 块里写了 `// 🛡️ AR-40：wbEntryCount 被模板调用…` 的说明注释，
    // 结果「反向验证」（临时删掉真绑定）**没能失败** —— 因为注释里的 `wbEntryCount`
    // 被正则当成了键名，检查被骗过（假绿）。本用例把该坑钉死。
    const fake = `<template>
    <div>{{ ghostFn(1) }}</div>
</template>
<script>
export default {
    setup() {
        return {
            // 说明：ghostFn 曾经漏绑定，见 docs/bugs/AR-40（这行注释绝不能算绑定！）
            realThing: 1
        };
    }
};
</script>`;
    const unbound = findUnboundCalls(fake);
    assert.deepEqual(unbound, ['ghostFn'],
        '注释里的符号被误认为已绑定 —— 检查会假绿，必须剥注释后再提取键名');
});

test('AR-40：**内层 v-if 分支模板里的调用也必须被检查**（多 </template> 不能截断）', () => {
    // 🔥 本用例是 AR-40 二次踩坑的根因：本组件模板含 7 个 `</template>`
    //    （每个 v-if 分支一个）。旧检查器用 `indexOf('</template>')` 只取第一个，
    //    于是「世界书分支」（位于第 4 个块之后）完全不在待检文本里 → 漏检。
    //    这里构造「第一个 </template> 之后的块里调用了未绑定函数」来钉死该行为。
    const fake = `<template>
    <div class="wrap">
        <template v-if="mode === 'a'">
            <span>{{ boundFn(1) }}</span>
        </template>
        <template v-if="mode === 'worldbooks'">
            <span>{{ lateUnboundFn(wb) }} 词条</span>
        </template>
    </div>
</template>
<script>
export default {
    setup() {
        const boundFn = (n) => String(n);
        return {
            boundFn,
            mode: 'a'
        };
    }
};
</script>`;
    const unbound = findUnboundCalls(fake);
    assert.deepEqual(unbound, ['lateUnboundFn'],
        '第一个 </template> 之后的模板块里的未绑定调用被漏检 —— 检查器必须用 lastIndexOf');
});
