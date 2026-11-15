/**
 * 宿主「插件语法错误提示」源码门禁（防回归）
 *
 * 背景（真实事故）：
 *   用户点「效果」页预览某插件，页面只有控制台一条
 *   `Uncaught SyntaxError: Unexpected token ':'`，页面本身毫无提示，
 *   于是被判定为「预览功能坏了」，来回排查好几轮。
 *
 *   实际根因是**插件源码自己写错了**（注释换行，后半行变成真代码）：
 *       // { find: /xxx/g
 *       , replace: 'yyy' },      <-- 这一行不再是注释
 *
 *   第一次修复时把提示框写在了 `if (produced === 0)` 分支里，结果更糟：
 *   宿主骨架本身就会产出 23 个节点，`produced` 永远不为 0，
 *   提示被永久隐藏 —— 等于没修。
 *
 * 因此本文件锁定两条不可退化的契约：
 *   1. 语法错误提示必须**无条件**执行，不得被 `produced === 0` 包裹；
 *   2. 提示容器必须独立存在，不得挂在 `#jsk-empty-hint` 内部（会跟着被隐藏）。
 *
 * 被测对象 hostStub.js 依赖 Vite 专有的 `?raw` 导入，Node 无法直接 import，
 * 所以这里做源码级断言 —— 仍能可靠拦住上述两类退化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../js/plugins/hostStub.js'), 'utf8');

test('宿主必须收集插件语法错误（__jskSyntaxErrors）', () => {
    assert.match(src, /window\.__jskSyntaxErrors\s*=\s*\[\]/, '缺少 __jskSyntaxErrors 初始化');
    assert.match(src, /__jskSyntaxErrors\.push/, '缺少语法错误入队逻辑');
    assert.match(src, /SyntaxError/, '未识别 SyntaxError 关键字');
});

test('语法错误提示容器必须独立于 #jsk-empty-hint 之外', () => {
    const hintStart = src.indexOf('id="jsk-empty-hint"');
    const synStart = src.indexOf('id="jsk-syntax-hint"');
    assert.ok(hintStart > 0, '未找到 #jsk-empty-hint');
    assert.ok(synStart > 0, '未找到 #jsk-syntax-hint');

    // 取 #jsk-empty-hint 整个 div 的范围：从它的开标签到 #jsk-empty-probe 之后最近的 </div> 序列
    const probeEnd = src.indexOf('id="jsk-empty-probe"', hintStart);
    assert.ok(probeEnd > 0, '未找到 #jsk-empty-probe');
    // 提示容器必须出现在 probe 之后（即已离开 empty-hint 内部）
    assert.ok(
        synStart > probeEnd,
        '#jsk-syntax-hint 必须写在 #jsk-empty-hint 之外，否则会随“有产出就隐藏”一起消失',
    );
});

test('语法错误提示不得被 produced === 0 分支包裹', () => {
    const guardIdx = src.indexOf('if (produced === 0)');
    assert.ok(guardIdx > 0, '未找到 produced === 0 分支');

    const synIdx = src.indexOf("document.getElementById('jsk-syntax-hint')");
    assert.ok(synIdx > 0, '未找到语法错误提示的驱动代码');
    assert.ok(
        synIdx > guardIdx,
        '语法错误提示代码必须位于 produced === 0 分支之后（即不受其约束）',
    );

    // 反向断言：produced === 0 的 if 块内不得出现语法提示
    // 用「从 guardIdx 到 produced===0 块结束」的粗略切片检查
    const braceStart = src.indexOf('{', guardIdx);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    assert.ok(end > braceStart, '无法定位 produced === 0 分支的结束位置');
    const block = src.slice(braceStart, end + 1);
    assert.doesNotMatch(
        block,
        /jsk-syntax-hint/,
        'produced === 0 分支内再次出现语法提示 ⇒ 会重新把提示锁死在“无产出”场景',
    );
});

test('语法错误提示文案必须明确“不是预览功能的问题”', () => {
    assert.match(src, /不是预览功能的问题/, '缺少责任归属说明，用户会误以为预览坏了');
    assert.match(src, /真实酒馆里同样会报错/, '缺少“插件本身有问题”的佐证说明');
});

test('语法错误提示异常必须被隔离，不得影响主流程', () => {
    const synIdx = src.indexOf("document.getElementById('jsk-syntax-hint')");
    const tail = src.slice(synIdx, synIdx + 2000);
    assert.match(tail, /catch\s*\(/, '语法提示块缺少 try/catch，异常会中断自检');
});
