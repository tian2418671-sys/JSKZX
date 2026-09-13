import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyRegexScripts,
    BIG_REPLACEMENT_THRESHOLD,
    REGEX_SCRIPT_BUDGET_MS,
    REGEX_TOTAL_BUDGET_MS,
} from '../js/composables/chat/useChatRegex.js';

/**
 * 📌 回归背景（2026-09-14，用户报「打开某张卡卡死」）：
 *   卡内脚本「状态栏界面」把 `<StatusPlaceHolderImpl/>` 替换成 **134KB 状态栏 HTML**，
 *   随后用户预设里 31 条正则（含 `([\s\S]*)<\/konatan_planning~>` 这类宽松贪婪式）
 *   全部在这 137KB 文本上跑 → 灾难性回溯 → **打开卡片 43~71 秒无响应**。
 *
 * 本文件锁定两条不变式：
 *   ① 「界面注入型」巨型替换串必须**延后物化** —— 后续脚本永远面对小文本（性能）；
 *   ② 物化后文本与旧实现**逐字一致**（语义）；`$1`/`{{match}}`/trimStrings 都不走样；
 *   ③ 任何脚本超时都有预算兜底（宁可少美化，不可冻界面）。
 */

const BIG = 'X'.repeat(30000);

test('巨型替换串延后物化：后续重正则面对的是小文本（不再灾难性回溯）', () => {
    const scripts = [
        { scriptName: '界面注入', findRegex: '<PH>', replaceString: BIG, placement: [2] },
        // 无匹配后缀的贪婪正则：在 30KB 文本上要几百 ms~秒级；在小文本上 <1ms
        { scriptName: '重正则', findRegex: '/([\\s\\S]*)<\\/zzz>/g', replaceString: '', placement: [2] },
    ];
    const t0 = Date.now();
    const out = applyRegexScripts('开场 <PH> 结束', scripts, 'AI', {});
    const ms = Date.now() - t0;
    assert.ok(out.includes(BIG), '巨型替换串最终必须被真实物化');
    assert.ok(ms < 150, `管线耗时 ${ms}ms —— 延后物化失效（预期 <150ms）`);
});

test('延后物化时 $1 / {{match}} 仍被正确代入', () => {
    const filler = 'Y'.repeat(BIG_REPLACEMENT_THRESHOLD + 500);
    const out = applyRegexScripts(
        '前缀 <PH> 后缀',
        [{ scriptName: 'big', findRegex: '/(<PH>)/', replaceString: `${filler}[$1]`, placement: [2] }],
        'AI',
        {}
    );
    assert.ok(out.includes(`${filler}[<PH>]`), '$1 必须在延后物化路径下照样代入');
    assert.ok(out.startsWith('前缀 ') && out.endsWith(' 后缀'), '替换位置必须正确');
});

test('普通（小）替换串行为不变：{{match}} / $1 / trimStrings', () => {
    // 文本取 'a-bbbc'：与 /(a)(-)(b+)c/ 匹配（'a-bbb-c' 中间多一道横线，其实不匹配 —— 写用例时勿想当然）
    const out = applyRegexScripts(
        'a-bbbc',
        [{
            scriptName: 'small',
            findRegex: '/(a)(-)(b+)c/g',
            replaceString: '{{match}}|$1|$3',
            trimStrings: ['b'],
            placement: [2],
        }],
        'AI',
        {}
    );
    // trimStrings 会把捕获组里的 'b' 全部剔掉 → $3 变成 ''，$1 仍是 'a'
    assert.equal(out, 'a-bbbc|a|');
    // 不剔时 $3 = 'bbb'
    const out2 = applyRegexScripts(
        'a-bbbc',
        [{ scriptName: 'small', findRegex: '/(a)(-)(b+)c/g', replaceString: '{{match}}|$1|$3', placement: [2] }],
        'AI', {}
    );
    assert.equal(out2, 'a-bbbc|a|bbb');
});

test('deferBigReplacements:false 可关掉延后物化（行为与旧实现一致）', () => {
    const out = applyRegexScripts(
        '<PH>',
        [{ scriptName: 'big', findRegex: '<PH>', replaceString: BIG, placement: [2] }],
        'AI',
        {},
        { deferBigReplacements: false }
    );
    assert.equal(out, BIG);
});

test('时间预算兜底：累计超预算后剩余脚本被跳过，并回调 onSkip', () => {
    const scripts = [
        { scriptName: 's1', findRegex: 'a', replaceString: 'A', placement: [2] },
        { scriptName: 's2', findRegex: 'b', replaceString: 'B', placement: [2] },
    ];
    let skipped = null;
    const out = applyRegexScripts('ab', scripts, 'AI', {}, {
        totalBudgetMs: -1,               // 强制立刻超预算
        onSkip: (list) => { skipped = list; },
    });
    assert.equal(out, 'Ab', '超预算后的 s2 不应再生效');
    assert.ok(Array.isArray(skipped) && skipped.some((s) => s.reason === 'total'), '必须回调 onSkip 且标记 reason=total');
    assert.equal(skipped.find((s) => s.reason === 'total').remaining, 1, '剩余脚本数应为 1（s2 被跳过）');
});

test('promptOnlyExclusive 语义不变：仅跑 promptOnly 脚本', () => {
    const scripts = [
        { scriptName: 'forAI', findRegex: 'X', replaceString: '', placement: [2], promptOnly: true },
        { scriptName: 'forDisplay', findRegex: 'Y', replaceString: 'Z', placement: [2] },
    ];
    assert.equal(applyRegexScripts('XY', scripts, 'AI', {}, { promptOnlyExclusive: true }), 'Y');
    assert.equal(applyRegexScripts('XY', scripts, 'AI', {}, {}), 'XZ');
});

test('预算常量存在且为合理正值（供 UI/文档引用）', () => {
    assert.ok(REGEX_SCRIPT_BUDGET_MS > 0 && REGEX_SCRIPT_BUDGET_MS <= 1000);
    assert.ok(REGEX_TOTAL_BUDGET_MS >= REGEX_SCRIPT_BUDGET_MS);
    assert.ok(BIG_REPLACEMENT_THRESHOLD >= 1024);
});
