/**
 * 5000 本世界书**极端压力测试** + 全面功能回归（含 ⚡ 秒开验证）
 *
 * 用法：node scripts/probes/_probe-wb-stress-5k.mjs <目录>
 *   node scripts/probes/_probe-wb-stress-5k.mjs "D:\TkDmGzq\_wb5k\s5000"
 *
 * ⚠️ 本版相对 v1 的改动：**预期数量自己数磁盘**（不写死），否则库构成一变就误报。
 *
 * 测什么：
 *   A. ⚡ 秒开：阶段 1 耗时 / 元数据补齐 / 内存
 *   B. 完整扫描（查重链路用）：磁盘对账 / 分级 / 进度条
 *   C. 渲染层：列表 / 搜索 / 筛选 / 侧栏存活
 *   D. 其他功能（改动 + 未改动）：同名查重 / 差异比对 / 内容级查重 / 模式切换
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-wb-stress-5k.mjs <目录>'); process.exit(1); }

const fs = await import('node:fs');
const path = await import('node:path');

// ── 磁盘对账（自己数，不写死）──
let diskJson = 0, diskDecoy = 0;
(function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(p, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        if (!e.name.toLowerCase().endsWith('.json')) continue;
        diskJson++;
        if (/非世界书/.test(e.name)) diskDecoy++;
    }
})(DIR);
const diskValid = diskJson - diskDecoy;

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text || '');
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable'); await send('Log.enable');
const ev = async (expr, t = 3600000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const evT = async (expr, ms) => {
    let timer;
    try {
        return await Promise.race([ev(expr, ms), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT_${ms}ms`)), ms + 2000); })]);
    } finally { clearTimeout(timer); }
};
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const DIR_LIT = JSON.stringify(DIR);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);
const head = (n) => console.log(`\n───── ${n} ─────`);

console.log(`═════ 极端压测：${DIR} ═════`);
info('磁盘对账', `${diskJson} 个 .json（有效 ${diskValid} / 诱饵 ${diskDecoy}）`);

const mem0 = await ev(`(() => { const m = performance.memory || {}; return { usedMB: Math.round((m.usedJSHeapSize||0)/1048576), limitMB: Math.round((m.jsHeapSizeLimit||0)/1048576) }; })()`);
info('起始堆', `${mem0.usedMB}MB / 上限 ${mem0.limitMB}MB`);

// ══════════ A. ⚡ 秒开 ══════════
head('A. ⚡ 秒开（阶段 1 + 元数据补齐）');
const instant = await evT(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    const t0 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    const fullMs = Math.round(performance.now() - t0);
    const list = ctx.worldbooks.value;
    const t1 = performance.now();
    const f = await window.electronAPI.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    const phase1Ms = Math.round(performance.now() - t1);
    return {
        fullMs, phase1Ms,
        count: list.length,
        named: list.filter(w => w.wbName).length,
        counted: list.filter(w => typeof w.entryCount === 'number').length,
        fastCount: ((f && f.data) || []).length
    };
})()`, 3600000);
info('首次完整流程', `${(instant.fullMs / 1000).toFixed(1)}s，入库 ${instant.count} 本`);
info('⚡ 阶段 1（只 readdir+stat）', `${instant.phase1Ms}ms，列出 ${instant.fastCount} 本`);
info('元数据补全', `书名 ${instant.named}/${instant.count}，词条数 ${instant.counted}/${instant.count}`);
check('★ ⚡ 阶段 1 达到「秒开」（< 2000ms）', instant.phase1Ms < 2000, `${instant.phase1Ms}ms`);
// ⚠️ 阶段 1 的数量取决于缓存状态：首次（无缓存）会列出全部 .json（含诱饵，等阶段 2 剔除）；
//    二次（有 worldbook 缓存）阶段 1 就能精准剔除诱饵。**两种情况都算正确**。
check('阶段 1 数量合理（= 全部 .json 或 = 有效数）',
    instant.fastCount === diskJson || instant.fastCount === diskValid,
    `${instant.fastCount}（磁盘 .json ${diskJson} / 有效 ${diskValid}）`);
check('元数据全部补全（书名）', instant.named === instant.count, `${instant.named}/${instant.count}`);
check('元数据全部补全（词条数）', instant.counted === instant.count, `${instant.counted}/${instant.count}`);

const mem1 = await ev(`(() => { const m = performance.memory || {}; return { usedMB: Math.round((m.usedJSHeapSize||0)/1048576), limitMB: Math.round((m.jsHeapSizeLimit||0)/1048576) }; })()`);
info('秒开后堆', `${mem1.usedMB}MB = ${(mem1.usedMB / mem1.limitMB * 100).toFixed(1)}%`);
check('内存未逼近上限（<70%）', mem1.usedMB < mem1.limitMB * 0.7, `${mem1.usedMB}MB`);

// ══════════ B. 完整扫描（查重链路）══════════
head('B. 完整扫描（查重/比对链路用）');
await ev(`(() => { window.__progLog = []; window.electronAPI.onWbScanProgress((p) => { window.__progLog.push({ ...p, _t: Date.now() }); }); return true; })()`);
const full = await evT(`(async () => {
    const t0 = performance.now();
    const r = await window.electronAPI.scanWorldbooks(${DIR_LIT});
    const ms = performance.now() - t0;
    const d = (r && r.data) || [];
    return {
        ok: !!(r && r.success), ms,
        count: d.length,
        skipped: ((r && r.skipped) || []).length,
        withData: d.filter(w => w.dataLoaded === true).length,
        noData: d.filter(w => w.dataLoaded === false).length,
        entrySum: d.reduce((s, w) => s + (w.entryCount || 0), 0),
        inlineMB: r && r.inlineMB, inlineSkipped: r && r.inlineSkipped
    };
})()`, 3600000);
info(`完整扫描耗时 ${(full.ms / 1000).toFixed(1)}s`, `入库 ${full.count} / 跳过 ${full.skipped}`);
info('分级', `已内联 ${full.withData} / 懒加载 ${full.noData}，词条合计 ${full.entrySum}`);
info('内联预算', `已用 ${full.inlineMB}MB，转懒加载 ${full.inlineSkipped} 本`);
check('完整扫描成功', full.ok);
check(`入库数 = 磁盘有效数 ${diskValid}`, full.count === diskValid, `实际 ${full.count}`);
check(`跳过数 = 磁盘诱饵数 ${diskDecoy}`, full.skipped === diskDecoy, `实际 ${full.skipped}`);

const prog = await ev('window.__progLog');
const last = prog[prog.length - 1] || {};
const monotonic = prog.every((e, i) => i === 0 || e.done >= prog[i - 1].done);
info('进度条', `${prog.length} 条事件，total=${last.total} done=${last.done} phase=${last.phase}`);
check('进度条 total 准确', last.total === diskJson, `total=${last.total} vs ${diskJson}`);
check('进度条 done 单调不减', monotonic);
check('进度条终态 done===total', last.done === last.total, `${last.done}/${last.total}`);

const mem2 = await ev(`(() => { const m = performance.memory || {}; return { usedMB: Math.round((m.usedJSHeapSize||0)/1048576) }; })()`);
info('完整扫描后堆', `${mem2.usedMB}MB`);

// ══════════ C. 渲染层 ══════════
head('C. 渲染层（列表 / 搜索 / 筛选）');
const ui = await evT(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    await new Promise(r => setTimeout(r, 2000));
    const aside = document.querySelector('aside');
    const out = {
        loaded: ctx.worldbooks.value.length,
        asideAlive: document.querySelectorAll('aside').length,
        asideLen: aside ? aside.innerHTML.length : 0,
        hasSearch: !!document.querySelector('input[placeholder*="搜索世界书"]'),
        hasBadge: aside ? (aside.innerText || '').includes('词条') : false,
        visibleCards: aside ? aside.querySelectorAll('[class*="rounded-lg border"]').length : 0
    };
    const t0 = performance.now();
    ctx.wbSearchQuery.value = '改写';
    await new Promise(r => setTimeout(r, 1500));
    out.searchMs = Math.round(performance.now() - t0);
    out.searchHit = ctx.filteredWorldbooks.value.length;
    ctx.wbSearchQuery.value = '';
    await new Promise(r => setTimeout(r, 500));
    const t1 = performance.now();
    ctx.wbFilterType.value = 'large';
    await new Promise(r => setTimeout(r, 900));
    out.filterMs = Math.round(performance.now() - t1);
    out.filterHit = ctx.filteredWorldbooks.value.length;
    ctx.wbFilterType.value = 'all';
    return out;
})()`, 600000);
info('列表', `${ui.loaded} 本，侧栏 ${ui.asideLen} 字符，可见卡片 ${ui.visibleCards}`);
info('搜索「改写」', `${ui.searchMs}ms，命中 ${ui.searchHit}`);
info('筛选「15+条」', `${ui.filterMs}ms，命中 ${ui.filterHit}`);
check('渲染层加载全部书', ui.loaded === full.count, `${ui.loaded} vs ${full.count}`);
check('侧栏存活（AR-40 未复发）', ui.asideAlive > 0 && ui.asideLen > 500, `aside=${ui.asideAlive}，${ui.asideLen} 字符`);
check('搜索框存在', ui.hasSearch);
check('词条徽标存在', ui.hasBadge);
check('搜索可响应（<5s）', ui.searchMs < 5000, `${ui.searchMs}ms`);
check('搜索有命中', ui.searchHit > 0, `${ui.searchHit}`);
check('筛选可响应（<5s）', ui.filterMs < 5000, `${ui.filterMs}ms`);

// ══════════ D. 其他功能 ══════════
head('D1. 同名查重（改动过：AR-42/43/44 + PK-26 轻量字段 + 用后释放）');
const memBeforeDedupe = await ev(`(() => { const m = performance.memory || {}; return Math.round((m.usedJSHeapSize||0)/1048576); })()`);
const wbDedupe = await evT(`(async () => {
    const ctx = ${CTX};
    // ★ 峰值采样：**S2' 之后判据变了**（2026-09-23 实测修正）。
    //    旧判据（PK-26 时代）：「查重必须逐本载入正文，峰值 > 查重前，终值回落到查重前」——
    //    那是对的，因为当时同名查重**真的读正文**。
    //    S2' 之后同名查重**只读 L1 索引（keyHashes 整数比较）**，**不读正文** →
    //    「峰值 > 查重前」**不再是正确性证据，反而是回归**。
    //    ⚠️ 但 startWorldbookDedupeScan() 内部会**重扫磁盘**（rescanForWorldbookDedupe），
    //    而重扫会按 PK-20 的**内联预算**主动载入少量书 → 终值不为 0 是**正常**的
    //    （实测 s5000：57 本内联 / 5001 本，全部 heavy && dataLoaded）。
    //    ⇒ 正确判据：**查重比对阶段不得新增载入**（峰值 ≈ 终值）+ 总量受控。
    const heavyLoaded = () => ctx.worldbooks.value.filter(w => w.heavy && w.dataLoaded === true).length;
    const beforeHeavy = heavyLoaded();
    let peakHeavy = beforeHeavy;
    const timer = setInterval(() => { const h = heavyLoaded(); if (h > peakHeavy) peakHeavy = h; }, 50);
    try {
        await ctx.startWorldbookDedupeScan();
        await new Promise(r => setTimeout(r, 1500));
    } finally {
        clearInterval(timer);
    }
    const g = ctx.wbDuplicateGroups.value;
    const first = (g[0] && g[0].list) || [];
    return {
        groups: g.length,
        sizes: g.slice(0, 3).map(x => (x.list || []).length),
        // ⚡ PK-26：修复前 _entryCount 大量为 0、_diffInfo 恒「重合度 0%」（反向结论）
        entryCounts: first.slice(0, 20).map(w => w._entryCount),
        diffInfos: first.slice(0, 3).map(w => w._diffInfo),
        // ⚡ S2'：查重只读 L1 索引 → 比对阶段不得新增载入正文
        beforeHeavy, peakHeavy, afterHeavy: heavyLoaded(),
        // 🔬 反证：确认 L1 索引真的可用（否则「不读正文」是因为没索引，而非设计如此）
        withKeyHashes: ctx.worldbooks.value.filter(w => Array.isArray(w.keyHashes) && w.keyHashes.length > 0).length,
        total: ctx.worldbooks.value.length
    };
})()`, 3600000);
info('同名查重', `${wbDedupe.groups} 组，前 3 组 ${JSON.stringify(wbDedupe.sizes)}`);
info('L1 索引覆盖', `${wbDedupe.withKeyHashes}/${wbDedupe.total} 本带 keyHashes`);
info('heavy 已载入本数', `查重前 ${wbDedupe.beforeHeavy} → 峰值 ${wbDedupe.peakHeavy} → 查重后 ${wbDedupe.afterHeavy}`);
check('同名查重完成且出结果', wbDedupe.groups > 0, `${wbDedupe.groups} 组`);
check('★ L1 索引已到达渲染层（查重只读索引的前提）',
    wbDedupe.withKeyHashes >= wbDedupe.total * 0.9,
    `${wbDedupe.withKeyHashes}/${wbDedupe.total}`);
check('★ PK-26 同名查重 _entryCount 全为真实值（修复前大量为 0）',
    wbDedupe.entryCounts.length > 0 && wbDedupe.entryCounts.every(v => typeof v === 'number' && v > 0),
    `唯一值 ${[...new Set(wbDedupe.entryCounts)].join('/')}`);
check('★ PK-26 重合度不是反向的「0%」（修复前恒 0%）',
    !wbDedupe.diffInfos.some(t => /重合度: 0%/.test(t)),
    wbDedupe.diffInfos[1] || '(无)');
check('★ S2\' 查重比对不读正文（峰值 → 终值不增长；终值仅来自重扫内联预算）',
    wbDedupe.peakHeavy - wbDedupe.afterHeavy <= 3 && wbDedupe.afterHeavy < wbDedupe.total * 0.05,
    `查重前 ${wbDedupe.beforeHeavy} → 峰值 ${wbDedupe.peakHeavy} → 终值 ${wbDedupe.afterHeavy}（${wbDedupe.total} 本）`);
const memAfterDedupe = await ev(`(() => { const m = performance.memory || {}; return Math.round((m.usedJSHeapSize||0)/1048576); })()`);
info('同名查重后堆', `${memBeforeDedupe} → ${memAfterDedupe}MB（差 ${memAfterDedupe - memBeforeDedupe}MB）`);

head('D2. 差异比对（改动过：PK-21 锚点 + PK-22 分块）');
const diff = await evT(`(async () => {
    const ctx = ${CTX};
    const all = ctx.worldbooks.value;
    const A = all.find(w => w.name === '炎孕-异世界工口学院物语-威力加强版 世界书.json');
    const B = all.find(w => w.name === '炎孕-改写A.json');
    if (!A || !B) return { err: '未找到对比对象' };
    const t0 = performance.now();
    ctx.openDiffDetailModal(A, B);
    // ⚠️ PK-26 后续：同名查重（D1）读完已**释放正文**（releaseWorldbookBody）→ 这里会走
    //    「先弹窗（加载态）+ 异步读入正文 + 重新计算」分支，只等 2 个 tick 会读到空结果。
    //    故按「弹窗已开 + 等正文就绪」轮询，最多 15s。
    let ready = false;
    for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 100));
        const labels = (ctx.diffFieldResults.value || []).map(f => f.label);
        if (labels.some(x => /世界书词条总数/.test(x))) { ready = true; break; }
    }
    const renderMs = Math.round(performance.now() - t0);
    const modal = document.querySelector('.fixed.inset-0.z-\\\\[110\\\\]') || document.body;
    const txt = modal.innerText || '';
    const out = { renderMs, ready, domNodes: modal.querySelectorAll('*').length,
                  collapsed: /展开整篇比对/.test(txt),
                  pairs: (txt.match(/显示前 (\\d+) \\/ (\\d+) 个词条/) || []).slice(1, 3) };
    ctx.showDiffDetailModal.value = false;
    await new Promise(r => setTimeout(r, 300));
    return out;
})()`, 600000);
if (diff.err) check('差异弹窗可打开', false, diff.err);
else {
    info('差异弹窗', `就绪=${diff.ready}，耗时 ${diff.renderMs}ms，DOM ${diff.domNodes}，折叠=${diff.collapsed}，词条分页=${JSON.stringify(diff.pairs)}`);
    check('差异弹窗可打开且算出结果（含懒加载按需读入）', diff.ready === true);
    check('差异弹窗默认折叠', diff.collapsed === true);
    check('差异弹窗 DOM 受控（<1.5万）', diff.domNodes < 15000, `${diff.domNodes}`);
}

head('D3. 内容级查重（懒加载 + 流式提取）');
// ✅ S3'（2026-09-22）**已从根上解掉 PK-25**：弃用 MinHash+LSH（桶内 O(bucket²)），
//    改 **simhash 位向量 + 汉明距离**（整数异或 + popcount，**无桶概念**）。
//    ⇒ 极端同源库不再是障碍（旧实现在此库上 >25 分钟未完；新实现全量两两 ≈ 12.5s）。
//    ⚠️ 因此**默认不再跳过**。如需只验证其它链路可用 `SKIP_CONTENT=1` 跳过本项。
const skipContent = process.env.SKIP_CONTENT === '1';
if (skipContent) {
    info('内容级查重', '已按 SKIP_CONTENT=1 跳过（S3\' 已解 PK-25，默认应跑）');
} else {
    const cd = await evT(`(async () => {
        const ctx = ${CTX};
        ctx.appMode.value = 'worldbooks';
        const t0 = performance.now();
        await ctx.startContentDedupeScan();
        await new Promise(r => setTimeout(r, 1000));
        return { ms: Math.round(performance.now() - t0), groups: ctx.contentDuplicateGroups.value.length,
                 totalGrouped: ctx.contentDuplicateGroups.value.reduce((s, g) => s + (g.list || []).length, 0) };
    })()`, 3600000).catch(e => ({ err: e.message }));
    if (cd.err) { info('内容级查重', `未完成：${cd.err}`); check('内容级查重能在超时内完成', false, cd.err); }
    else {
        info('内容级查重', `${(cd.ms / 1000).toFixed(1)}s，${cd.groups} 组，参与 ${cd.totalGrouped} 本`);
        check('★ S3\' 内容级查重在极端同源库能完成（旧实现 >25 分钟未完 / 现已解 PK-25）',
            cd.groups > 0, `${(cd.ms / 1000).toFixed(1)}s，${cd.groups} 组`);
        check('★ S3\' 内容级查重耗时受控（< 120s）', cd.ms < 120000, `${(cd.ms / 1000).toFixed(1)}s`);
    }
}

head('D4. 其他库与模式切换（未改动）');
const others = await evT(`(async () => {
    const ctx = ${CTX};
    const btns = [...document.querySelectorAll('button')];
    for (const m of ['角色卡库', '预设库', '插件库', '世界书库']) {
        const b = btns.find(x => (x.textContent || '').includes(m));
        if (b) { b.click(); await new Promise(r => setTimeout(r, 500)); }
    }
    return { mode: ctx.appMode.value, aside: document.querySelectorAll('aside').length,
             wb: ctx.worldbooks.value.length, lib: ctx.library.value.length, preset: ctx.presets.value.length };
})()`, 300000);
info('模式切换后', `模式=${others.mode}，aside=${others.aside}，世界书 ${others.wb} 本`);
check('反复切换模式后侧栏仍在', others.aside > 0, `aside=${others.aside}`);
check('世界书库未丢失', others.wb === full.count, `${others.wb} vs ${full.count}`);

head('E. 渲染期错误 / OOM');
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|out of memory|Invalid string length|Array buffer allocation|before initialization/i.test(t));
check('无渲染期错误 / OOM / TDZ', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

const memF = await ev(`(() => { const m = performance.memory || {}; return { usedMB: Math.round((m.usedJSHeapSize||0)/1048576), limitMB: Math.round((m.jsHeapSizeLimit||0)/1048576) }; })()`);

const pass = results.filter(r => r.ok).length;
console.log(`\n═════ 极端压测结果：${pass}/${results.length} 通过 ═════`);
console.log(`⚡ 秒开阶段 1：${instant.phase1Ms}ms ｜ 完整扫描：${(full.ms / 1000).toFixed(1)}s`);
console.log(`入库 ${full.count} ｜ 跳过 ${full.skipped} ｜ 词条合计 ${full.entrySum}`);
console.log(`堆：${mem0.usedMB} → ${mem1.usedMB} → ${mem2.usedMB} → ${memF.usedMB}MB（上限 ${memF.limitMB}MB）`);
process.exit(pass === results.length ? 0 : 1);
