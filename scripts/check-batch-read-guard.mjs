/**
 * CI 守卫（PK-27 / S4'）：**批量读世界书正文**必须走唯一入口。
 *
 * 为什么用**白名单制**而不是黑名单 grep（v3 评审 §5 #10）：
 *   · 黑名单（`Promise.all` + `ensureWorldbookLoaded`）**有假阴性**：
 *     `for...of` 里嵌 `Promise.all` 抓不住；
 *   · 黑名单**有假阳性**：`Promise.all(paths.map(invoke('wb:meta')))` 是合法的主进程侧并发。
 *   ⇒ 白名单更稳：`ensureWorldbookLoaded` **只允许出现在清单文件里**，其余文件出现即 fail。
 *
 * 背景（三次同款 OOM 事故）：
 *   · PK-20：全量内联 3.56GB → 应用退出
 *   · 内容级查重：全文本 3GB → 渲染进程被 OOM killer 杀
 *   · PK-27：`Promise.all` 整组并发 2.6GB → **s5000 进程直接消失**
 *
 * 用法：node scripts/check-batch-read-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ── 白名单：`ensureWorldbookLoaded` 允许出现的文件（**每条都要有理由**）──
const ALLOWED = new Map([
    ['js/composables/useWorldbooks.js',
        '定义处：唯一入口 consumeWorldbookBodies 内部 + selectWorldbook（单本点击）+ ensureActiveData（编辑器单本）'],
    ['js/composables/useDedupe.js',
        '差异比对（只读 2 本，有 diffLoadAttempted 防重入）+ 内容查重（走 consumeWorldbookBodies）'],
    ['js/composables/useWorldbookEntries.js',
        '编辑器写入口 ensureActiveData（单本，用户主动操作）'],
    ['js/components/App.vue',
        '保存/导出/图谱/合并/导入（均为**用户主动触发的单本或少量本**操作）'],
    ['js/composables/useGlobalEntrySearch.js',
        '全库词条搜索：按需逐本载入（**顺序**，非批量并发）']
]);

// ── 扫描范围 ──
const SCAN_DIRS = ['js', 'main.js', 'preload.js'];

const violations = [];
const stats = { files: 0, hits: 0 };

const scanFile = (rel) => {
    // ⚠️ Windows 下 path.join 产出 `\`，而白名单用 `/` → 必须归一化，否则**全部误报**
    const norm = rel.split(path.sep).join('/');
    const abs = path.join(ROOT, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf-8'); } catch { return; }
    stats.files++;
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
        if (!line.includes('ensureWorldbookLoaded')) return;
        // 注释行不算（说明性引用）
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        stats.hits++;
        if (!ALLOWED.has(norm)) {
            violations.push({ file: norm, line: i + 1, text: trimmed.slice(0, 120) });
        }
    });
};

const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isFile()) { scanFile(rel); return; }
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const child = path.join(rel, e.name);
        if (e.isDirectory()) walk(child);
        else if (/\.(js|mjs|vue)$/.test(e.name)) scanFile(child);
    }
};
SCAN_DIRS.forEach(walk);

console.log('═════ 批量读正文守卫（PK-27 / S4\'） ═════');
console.log(`扫描 ${stats.files} 个文件，命中 ensureWorldbookLoaded ${stats.hits} 处`);
console.log(`白名单 ${ALLOWED.size} 个文件：`);
for (const [f, why] of ALLOWED) console.log(`  · ${f}\n    ↳ ${why}`);

if (violations.length === 0) {
    console.log('\n✅ 通过：无白名单外的 ensureWorldbookLoaded 调用');
    process.exit(0);
} else {
    console.log(`\n❌ 违规 ${violations.length} 处（白名单外的批量读正文）：`);
    for (const v of violations) console.log(`  ${v.file}:${v.line}\n    ${v.text}`);
    console.log('\n⇒ 请改用唯一入口 consumeWorldbookBodies()（顺序消费 + 用后释放 + 进度回调），');
    console.log('   或在 scripts/check-batch-read-guard.mjs 的 ALLOWED 中登记**并写明理由**。');
    process.exit(1);
}
