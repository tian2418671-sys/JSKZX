/**
 * 世界书 500 份大库压力测试（针对 D:\TkDmGzq\_wb500 的构成做精确断言）
 *
 * 用法（先启动 dev/prod 版 Electron 并开 CDP）：
 *   $env:CDP_PORT="9370"; $env:WB_DIR="D:\TkDmGzq\_wb500"; node scripts/probes/_probe-wb-stress-500-lib.mjs
 *
 * 与既有 `_probe-wb-stress-500.mjs` 的区别：那个探针把「入库 = 500」写死了，
 * 而本库的实际构成是 **501 本有效世界书 + 41 个应跳过**（40 诱饵 + 1 坏 JSON），
 * 且**全部 501 本都 >5MB**（走 heavy 低并发档），另有 1 本 52.7MB 走「只回元数据」懒加载档。
 * 故本探针按真实构成断言，并把每个数字都打出来供归档。
 *
 * 测什么：
 *   ① 首扫（冷，无缓存）：能否跑完、耗时、入库/跳过数量是否与磁盘对账一致
 *   ② 三级分级是否正确：heavy 档、>50MB 懒加载档（dataLoaded=false / data=null）
 *   ③ T2 真进度条：事件数 / total 准确性 / 单调性 / 终态 / current
 *   ④ 扫描期间渲染层是否存活（不白屏、不崩）
 *   ⑤ 内存水位（渲染堆 / DOM 节点）—— ≤50MB 的世界书**没有 slim**，全量 data 内联，最易 OOM
 *   ⑥ 二次扫描（走 scan_cache）是否更快、结果一致
 *   ⑦ 世界书列表渲染 / 词条数徽标
 *   ⑧ 搜索 / 筛选在 501 本下的响应
 *   ⑨ 渲染期错误 / OOM 痕迹
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const WB_DIR = process.env.WB_DIR || 'D:\\TkDmGzq\\_wb500';
const EXPECT_LOADED = Number(process.env.EXPECT_LOADED || 501);   // 500 + 1 超巨书
const EXPECT_SKIPPED = Number(process.env.EXPECT_SKIPPED || 41);  // 40 诱饵 + 1 坏 JSON

let sock; let msgId = 0; const pending = new Map();
const consoleErrors = [];

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res; sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
            }
            if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
                consoleErrors.push(m.params.entry.text || '');
            }
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression, timeoutMs = 900000) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => { console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`); };
const readMem = () => evaluate(`(() => {
    const m = performance.memory || {};
    return {
        usedMB: Math.round((m.usedJSHeapSize || 0) / 1048576),
        totalMB: Math.round((m.totalJSHeapSize || 0) / 1048576),
        limitMB: Math.round((m.jsHeapSizeLimit || 0) / 1048576),
        domNodes: document.querySelectorAll('*').length
    };
})()`);

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Log.enable');
    info('已连接 CDP', `port=${PORT}`);

    // ── 基线内存 ──
    const memBefore = await readMem();
    info('扫描前堆', `${memBefore.usedMB}MB / 上限 ${memBefore.limitMB}MB，DOM ${memBefore.domNodes}`);

    // ── 挂进度收集器（走真实 preload 通道，与 UI 同一条） ──
    await evaluate(`(() => {
        window.__progLog = [];
        window.electronAPI.onWbScanProgress((p) => { window.__progLog.push({ ...p, _t: Date.now() }); });
        return true;
    })()`);

    // ── ① 首扫（冷） ──
    console.log('\n───── ① 首扫（冷，无缓存）─────');
    const first = await evaluate(`(async () => {
        const t0 = performance.now();
        const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(WB_DIR)});
        const ms = performance.now() - t0;
        const data = (r && r.data) || [];
        const heavy = data.filter(w => w.heavy).length;
        const noData = data.filter(w => w.dataLoaded === false).length;
        // ⚠️ 判据必须是 entryCount === null（只有未 parse 的超巨书才没词条数），
        //    不能看 data === null —— 预算转懒加载的书**也是** data:null，但 entryCount 有准确值。
        const noDataNull = data.filter(w => w.dataLoaded === false && w.entryCount === null).length;
        const withData = data.filter(w => w.dataLoaded === true).length;
        const entrySum = data.reduce((s, w) => s + (w.entryCount || 0), 0);
        // 逐本估算内联 data 的字符量（世界书没有 slim → 这些字符串全部常驻渲染堆）
        let inlineChars = 0;
        for (const w of data) { if (w.data) { try { inlineChars += JSON.stringify(w.data).length; } catch (e) {} } }
        return {
            ok: !!(r && r.success), ms, error: r && r.error,
            count: data.length,
            skipped: ((r && r.skipped) || []).length,
            skipReasons: (r && r.skipped || []).reduce((acc, s) => { const k = (s.reason || '').slice(0, 28); acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
            heavy, noData, noDataNull, withData, entrySum,
            inlineChars, inlineMB: Math.round(inlineChars * 2 / 1048576)
        };
    })()`);
    info(`首扫耗时 ${(first.ms / 1000).toFixed(1)}s`, `入库 ${first.count} / 跳过 ${first.skipped}`);
    info('分级', `heavy=${first.heavy} 已内联=${first.withData} 懒加载(dataLoaded=false)=${first.noData} 其中 data=null=${first.noDataNull}`);
    info('词条总数', String(first.entrySum));
    info('内联 data 字符量', `${(first.inlineChars / 1048576).toFixed(0)}M 字符 ≈ ${first.inlineMB}MB（仅字符串本体，不含对象开销）`);
    info('跳过原因分布', JSON.stringify(first.skipReasons));
    check('首扫成功', first.ok, first.error || '');
    check(`入库数量 = ${EXPECT_LOADED}（与磁盘对账一致）`, first.count === EXPECT_LOADED, `实际 ${first.count}`);
    check(`跳过数量 = ${EXPECT_SKIPPED}（40 诱饵 + 1 坏 JSON）`, first.skipped === EXPECT_SKIPPED, `实际 ${first.skipped}`);
    check('全部大书走 heavy 档', first.heavy === first.count, `heavy=${first.heavy} / count=${first.count}`);
    // 🧠 PK-20：懒加载现在是**两层**触发的，断言不能只认「超巨书」：
    //   ① 单文件 >50MB（`SCAN_PARSE_MAX_BYTES`）→ entryCount 为 null（未 parse）；
    //   ② **累计内联预算**用尽（`SCAN_INLINE_TOTAL_MAX_BYTES`）→ 已 parse，**entryCount 有准确值**。
    //   ⚠️ v1 断言写死 `noData === 1`（只算超巨书）→ 预算机制上线后必然误报。
    check('懒加载机制生效（有书未内联正文）', first.noData > 0, `dataLoaded=false 共 ${first.noData} 本`);
    check('★ 未内联的书**仍给出准确词条数**（不是 null）', first.noDataNull === 1,
        `dataLoaded=false ${first.noData} 本，其中 entryCount=null 仅 ${first.noDataNull} 本（应为超巨书）`);
    check('扫描期间窗口未白屏（渲染层存活）', await evaluate(`document.body.innerHTML.length > 1000`));

    // ── ② 内存水位（扫描后立即读，不等 GC） ──
    console.log('\n───── ② 内存水位 ─────');
    const memAfter = await readMem();
    info(`渲染堆 ${memAfter.usedMB}MB / 上限 ${memAfter.limitMB}MB`, `较扫描前 +${memAfter.usedMB - memBefore.usedMB}MB，DOM ${memAfter.domNodes}`);
    check('内存未逼近上限（<70%）', memAfter.usedMB < memAfter.limitMB * 0.7,
        `${memAfter.usedMB}MB / ${memAfter.limitMB}MB = ${(memAfter.usedMB / memAfter.limitMB * 100).toFixed(1)}%`);

    // ── ③ 进度条 ──
    console.log('\n───── ③ T2 真进度条 ─────');
    const prog1 = await evaluate('window.__progLog');
    const last1 = prog1[prog1.length - 1] || {};
    const monotonic = prog1.every((e, i) => i === 0 || e.done >= prog1[i - 1].done);
    const phases = [...new Set(prog1.map(e => e.phase))];
    const hasCurrent = prog1.some(e => e.current && e.current.length > 0);
    const maxDone = prog1.reduce((m, e) => Math.max(m, e.done), 0);
    info(`进度事件 ${prog1.length} 条`, `total=${last1.total} done=${last1.done} phase=${last1.phase}`);
    info('phase 序列', phases.join(' → '));
    check('收到多条进度事件', prog1.length >= 3, `${prog1.length} 条`);
    check('total 准确（= 目录内 .json 总数 542）', last1.total === 542, `total=${last1.total}`);
    check('done 单调不减', monotonic);
    check('done 覆盖全部文件（无遗漏路径）', maxDone >= last1.total, `maxDone=${maxDone} total=${last1.total}`);
    check('终态 done === total 且 phase=done', last1.done === last1.total && last1.phase === 'done',
        `done=${last1.done} total=${last1.total} phase=${last1.phase}`);
    check('事件带 current（当前项名）', hasCurrent, prog1.find(e => e.current)?.current || '');

    // ── ④ 二次扫描（走 scan_cache） ──
    console.log('\n───── ④ 二次扫描（走 scanCache）─────');
    await evaluate(`(() => { window.__progLog = []; return true; })()`);
    const second = await evaluate(`(async () => {
        const t0 = performance.now();
        const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(WB_DIR)});
        return { ok: !!(r && r.success), ms: performance.now() - t0,
                 count: ((r && r.data) || []).length, skipped: ((r && r.skipped) || []).length };
    })()`);
    info(`二扫耗时 ${(second.ms / 1000).toFixed(1)}s`, `入库 ${second.count} / 跳过 ${second.skipped}（首扫 ${(first.ms / 1000).toFixed(1)}s）`);
    check('二扫成功且数量一致', second.ok && second.count === first.count, `${second.count} vs ${first.count}`);
    check('二扫跳过数一致', second.skipped === first.skipped, `${second.skipped} vs ${first.skipped}`);

    const mem2 = await readMem();
    info(`二扫后渲染堆 ${mem2.usedMB}MB`, `DOM ${mem2.domNodes}`);

    // ── ⑤ 世界书列表渲染 ──
    console.log('\n───── ⑤ 世界书列表渲染 ─────');
    const ui = await evaluate(`(async () => {
        const btns = [...document.querySelectorAll('button')];
        const wbBtn = btns.find(x => (x.textContent || '').includes('世界书库'));
        if (wbBtn) wbBtn.click();
        await new Promise(r => setTimeout(r, 2500));
        const t = document.body.innerText || '';
        const aside = document.querySelector('aside');
        return {
            clicked: !!wbBtn,
            asideAlive: document.querySelectorAll('aside').length,
            asideHtmlLen: aside ? aside.innerHTML.length : 0,
            // ⚠️ 判据修正：body.innerText **不含 placeholder**（它只反映文本节点），
            //    所以「搜索框是否存在」必须查 DOM 元素，不能查 innerText。
            hasSearch: !!document.querySelector('input[placeholder*="搜索世界书"]'),
            hasEntryBadge: t.includes('词条') || (aside ? (aside.innerText || '').includes('词条') : false),
            bodyLen: t.length
        };
    })()`);
    check('找到并点击「世界书库」模式按钮', ui.clicked);
    check('侧边栏存活（AR-40 未复发）', ui.asideAlive > 0, `aside=${ui.asideAlive}，内容 ${ui.asideHtmlLen} 字符`);
    check('世界书视图渲染出搜索框', ui.hasSearch);
    check('列表渲染出词条数徽标', ui.hasEntryBadge, `bodyLen=${ui.bodyLen}`);

    // ── ⑥ 搜索 / 筛选 ──
    console.log('\n───── ⑥ 搜索 / 筛选 ─────');
    const ops = await evaluate(`(async () => {
        const ctx = (() => {
            const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
            const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
            return (inst && inst.provides && inst.provides.appCtx) || null;
        })();
        const out = {};
        if (ctx) {
            const t0 = performance.now();
            ctx.wbSearchQuery.value = '改写';
            await new Promise(r => setTimeout(r, 1200));
            out.searchMs = Math.round(performance.now() - t0);
            // ⚠️ 判据修正：用**筛选结果的真实条数**，不要用 body.innerText.includes()
            //    （列表分页时，命中项可能根本不在可见 DOM 里 → 误报「无命中」）
            out.searchHit = ctx.filteredWorldbooks.value.length;
            ctx.wbSearchQuery.value = '';
            await new Promise(r => setTimeout(r, 400));
        }
        const fBtns = [...document.querySelectorAll('button')].filter(x => /15\\+|1-15条|空书|全部/.test(x.textContent || ''));
        out.filterBtnCount = fBtns.length;
        if (fBtns.length) {
            const t0 = performance.now();
            fBtns[0].click();
            await new Promise(r => setTimeout(r, 900));
            out.filterMs = Math.round(performance.now() - t0);
        }
        return out;
    })()`);
    info(`搜索响应 ${ops.searchMs}ms`, `命中 ${ops.searchHit} 本，筛选按钮 ${ops.filterBtnCount} 个，筛选响应 ${ops.filterMs}ms`);
    check('搜索在 501 本下可响应（<3s）', (ops.searchMs || 99999) < 3000, `${ops.searchMs}ms`);
    check('搜索有命中结果', (ops.searchHit || 0) > 0, `${ops.searchHit} 本`);
    check('筛选控件存在', (ops.filterBtnCount || 0) > 0, `${ops.filterBtnCount} 个`);

    // ── ⑦ 渲染期错误 ──
    console.log('\n───── ⑦ 渲染期错误 ─────');
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|out of memory|Array buffer allocation|Invalid string length/i.test(t));
    check('无渲染期错误 / OOM 痕迹', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const memFinal = await readMem();
    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 世界书 500 份压测：${pass}/${results.length} 通过 ═════`);
    console.log(`首扫 ${(first.ms / 1000).toFixed(1)}s ｜ 二扫 ${(second.ms / 1000).toFixed(1)}s ｜ 堆 ${memBefore.usedMB}→${memAfter.usedMB}→${memFinal.usedMB}MB ｜ 进度事件 ${prog1.length} 条`);
    console.log(`入库 ${first.count} ｜ 跳过 ${first.skipped} ｜ 词条合计 ${first.entrySum} ｜ 内联 data ≈${first.inlineMB}MB`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('STRESS PROBE FAILED:', e.message); process.exit(1); });
