#!/usr/bin/env node
/**
 * 🚨 查重引擎 API 红线守卫（v4 §14）—— 静态扫描，退出码非 0 = 阻断
 *
 * 扫范围：`js/utils/dedupe*.js`、`js/utils/simhash64.mjs`、`js/composables/useDedupe.js`
 * 禁令（均有历史事故背景，见 docs/bugs/README.md）：
 *   · `window.confirm(` —— AR-02：渲染进程静默失败（必须走应用内 confirmDialog）
 *   · `deleteFile`      —— 回收站红线（删卡/删书一律 `trashFiles`，禁物理删除）
 *   · `ensureWorldbookLoaded` —— batch-read 守卫：查重流程不得触发世界书全量载入
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RULES = [
    { pattern: /\bwindow\.confirm\s*\(/, msg: '禁用 window.confirm（AR-02：静默失败）——请走应用内 confirmDialog' },
    { pattern: /\bdeleteFile\b/, msg: '禁用 deleteFile（物理删除）——请走 trashFiles（回收站）' },
    { pattern: /\bensureWorldbookLoaded\b/, msg: '禁用 ensureWorldbookLoaded（batch-read 守卫）——查重不得全量载入世界书' },
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
    for (const rule of RULES) {
        lines.forEach((line, i) => {
            if (rule.pattern.test(line)) {
                console.error(`✖ ${rel}:${i + 1}  ${rule.msg}`);
                console.error(`    ${line.trim().slice(0, 120)}`);
                violations++;
            }
        });
    }
}

if (violations > 0) {
    console.error(`\n❌ check-dedupe-api 未通过：${violations} 处违规`);
    process.exitCode = 1;
} else {
    console.log(`✅ check-dedupe-api 通过（${targets.length} 个文件，零红线命中）`);
}
