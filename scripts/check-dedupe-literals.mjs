#!/usr/bin/env node
/**
 * 🚫 查重引擎「零案例字面量」守卫（规格 G1~G8 硬约束）—— 静态扫描，退出码非 0 = 阻断
 *
 * 扫范围：`js/utils/dedupe*.js`、`js/utils/simhash64.mjs`、`js/composables/useDedupe.js`
 * 规则：算法层与编排层**不得出现任何具体案例的字面量**（卡名/书名/预设名/版本修饰词表）。
 *   —— 机制必须是「形状规则 + 语料统计」，任何"词汇表"都意味着对特定案例打补丁。
 *   —— 测试样本（test/fixtures/**）不受此限（那是数据，不是实现）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 黑名单：历史案例词（曾作为「补丁式修复」出现过的具体名称）——只增不删 */
const CASE_LITERALS = [
    '状态栏版', '终极版', '重置版',
    '斗罗大陆', '斗罗淫师', '神里绫华', '纳西妲', '贵族管家', '炎孕',
    '艾莎', '唐清露', '莉莉丝',
];

const targets = [];
for (const f of readdirSync(join(ROOT, 'js/utils'))) {
    if (/^dedupe.*\.js$/.test(f) || f === 'simhash64.mjs') targets.push(join('js/utils', f));
}
targets.push(join('js/composables', 'useDedupe.js'));

let violations = 0;
for (const rel of targets) {
    const abs = join(ROOT, rel);
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
        for (const word of CASE_LITERALS) {
            if (line.includes(word)) {
                console.error(`✖ ${rel}:${i + 1}  出现案例字面量「${word}」`);
                console.error(`    ${line.trim().slice(0, 120)}`);
                violations++;
            }
        }
    });
}

if (violations > 0) {
    console.error(`\n❌ check-dedupe-literals 未通过：${violations} 处案例字面量（违反 G1~G8 零案例约束）`);
    process.exitCode = 1;
} else {
    console.log(`✅ check-dedupe-literals 通过（${targets.length} 个文件，零案例字面量）`);
}
