/**
 * 堆构成审计（P1 前置测量）——回答「3.3GB 到底被什么吃了」
 *
 * 为什么要它：P1「列表元数据 / 正文解耦」必须打在真正的大头上。历史教训（§12.3）里
 * “正文 JSON ≈1.7GB”只是估算，实测前不许动手。
 *
 * 做法：在 dev 模式的页面里遍历 `window.__jskDiag.lib()`，把每张卡的重字段字符数**分类求和**
 * （描述/首句/性格/场景/示例/系统提示/附加问候语/世界书正文与触发词/其它），
 * 再乘以 2 字节（JS 字符串 UTF-16）得到「纯文本占用」；
 * 用 `performance.memory.usedJSHeapSize`（GC 后）减去它，剩下的就是**对象/数组/键名/索引**开销。
 *
 * 用法（app 必须在 dev + --remote-debugging-port 下运行）：
 *   node scripts/tools/_heap-audit.mjs                 # 默认端口 9338
 *   node scripts/tools/_heap-audit.mjs --port 9339
 *   node scripts/tools/_heap-audit.mjs --json          # 只输出 JSON
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const RAW = argv.includes('--json');
const i = argv.indexOf('--port');
const PORT = (i >= 0 && argv[i + 1]) ? argv[i + 1] : (process.env.CDP_PORT || '9338');

const EXPR = `(() => {
    const d = window.__jskDiag || {};
    const lib = (typeof d.lib === 'function' && d.lib()) || [];
    const MB = 1048576;
    const CH = {
        description: 0, first_mes: 0, personality: 0, scenario: 0, mes_example: 0,
        system_prompt: 0, post_history_instructions: 0, alternate_greetings: 0,
        book_entries: 0, book_keys: 0, native_tags: 0, misc: 0
    };
    let cards = 0, entries = 0, books = 0, noData = 0;
    const len = (v) => (typeof v === 'string' ? v.length : 0);
    const keyLen = (e) => {
        let n = 0;
        if (Array.isArray(e.keys)) n += e.keys.join(',').length;
        if (typeof e.key === 'string') n += e.key.length;
        else if (Array.isArray(e.key)) n += e.key.join(',').length;
        if (Array.isArray(e.secondary_keys)) n += e.secondary_keys.join(',').length;
        return n;
    };
    for (const item of lib) {
        const cd = item && item.data;
        if (!cd) { noData++; continue; }
        cards++;
        const dd = (cd.data && typeof cd.data === 'object') ? cd.data : cd;
        CH.description += len(dd.description);
        CH.first_mes += len(dd.first_mes);
        CH.personality += len(dd.personality);
        CH.scenario += len(dd.scenario);
        CH.mes_example += len(dd.mes_example);
        CH.system_prompt += len(dd.system_prompt);
        CH.post_history_instructions += len(dd.post_history_instructions);
        if (Array.isArray(dd.alternate_greetings)) {
            for (const g of dd.alternate_greetings) CH.alternate_greetings += len(g);
        }
        if (Array.isArray(dd.tags)) for (const t of dd.tags) CH.native_tags += len(t);
        CH.misc += len(dd.creator) + len(dd.creator_notes) + len(dd.character_version) + len(dd.name);
        const book = dd.character_book || cd.character_book;
        if (book) {
            books++;
            let list = [];
            if (Array.isArray(book.entries)) list = book.entries;
            else if (book.entries && typeof book.entries === 'object') list = Object.values(book.entries);
            entries += list.length;
            for (const e of list) {
                if (!e) continue;
                CH.book_entries += len(e.content);
                CH.book_keys += keyLen(e);
                CH.book_keys += len(e.comment) + len(e.name);
            }
        }
    }
    const totalChars = Object.values(CH).reduce((a, b) => a + b, 0);
    const m = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
    const idx = d.idx ? d.idx.stats() : null;
    const tokens = (d.idx && d.idx.index) ? d.idx.index.size : null;
    return JSON.stringify({
        cards, noData, entries, books,
        charsByField: CH,
        totalChars,
        textMB: Math.round(totalChars * 2 / MB),
        heapUsedMB: m ? Math.round(m.usedJSHeapSize / MB) : null,
        heapLimitMB: m ? Math.round(m.jsHeapSizeLimit / MB) : null,
        indexTokens: tokens,
        index: idx,
        gcAvailable: (typeof window.gc === 'function')
    });
})()`;

function run(expr, gc) {
    const r = spawnSync('node', ['scripts/tools/_cdp-eval.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, CDP_PORT: PORT, EXPR: expr, GC: gc ? '1' : '0' },
        encoding: 'utf-8'
    });
    return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

function unwrap(stdout) {
    // `_cdp-eval.mjs` 输出的是 JSON.stringify(值)，而 EXPR 本身返回 JSON 字符串
    // → 双重编码。只 parse 一次会得到字符串，字段全是 undefined。
    if (!stdout) return null;
    let v;
    try { v = JSON.parse(stdout); } catch (e) { return null; }
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e) { return null; }
    }
    return (v && typeof v === 'object') ? v : null;
}

function sample(gc) {
    const r = run(EXPR, gc);
    return unwrap(r.out);
}

// 先 GC 一次再取「干净水位」，再取一次不 GC 的做对照（能看出浮动垃圾有多大）
const afterGc = sample(true);
const raw = sample(false);
if (!afterGc && !raw) {
    console.log(JSON.stringify({ ok: false, error: 'cdp-sample-failed', port: PORT }));
    process.exit(0);   // 与 _cdp-mem.mjs 同口径：失败不写 stderr、不非零退出（PS 5.1 会因此中断）
}
const base = afterGc || raw;
const report = { ok: true, ...base };
if (afterGc && raw && afterGc.heapUsedMB && raw.heapUsedMB) {
    report.gcDeltaMB = raw.heapUsedMB - afterGc.heapUsedMB;      // 浮动垃圾
    report.objectOverheadMB = Math.max(0, afterGc.heapUsedMB - afterGc.textMB);
    report.textSharePct = Math.round(100 * afterGc.textMB / afterGc.heapUsedMB);
}

if (RAW) {
    console.log(JSON.stringify(report));
} else {
    const MB = (n) => (n == null ? '?' : `${n} MB`);
    console.log('================ 堆构成审计 ================');
    console.log(`卡片数            : ${report.cards}（无 data：${report.noData}）`);
    console.log(`内嵌世界书 / 词条 : ${report.books} / ${report.entries}`);
    console.log(`文本字符总量      : ${report.totalChars.toLocaleString('en-US')} 字符 ≈ ${MB(report.textMB)}（UTF-16×2）`);
    console.log(`堆占用（GC 后）   : ${MB(report.heapUsedMB)} / 上限 ${report.heapLimitMB} MB`);
    if (report.gcDeltaMB != null) {
        console.log(`浮动垃圾          : ${MB(report.gcDeltaMB)}（未 GC 时的差值）`);
        console.log(`非文本（对象/键/索引/数组）: ${MB(report.objectOverheadMB)}（占 ${100 - report.textSharePct}%）`);
        console.log(`纯文本占比        : ${report.textSharePct}%`);
    }
    console.log(`索引 token 数     : ${report.indexTokens}`);
    if (report.index) console.log(`索引状态          : cards=${report.index.cardCount} build=${report.index.buildTime}ms building=${report.index.indexBuilding}`);
    console.log(`window.gc 可用    : ${report.gcAvailable}`);
    console.log('--- 文本按字段拆分（字符）---');
    const ch = report.charsByField || {};
    for (const k of Object.keys(ch).sort((a, b) => ch[b] - ch[a])) {
        const pct = report.totalChars ? Math.round(100 * ch[k] / report.totalChars) : 0;
        console.log(`  ${k.padEnd(26)} ${String(ch[k]).padStart(12)}  (${pct}%)  ≈${Math.round(ch[k] * 2 / 1048576)} MB`);
    }
    console.log('===========================================');
}
