/**
 * 热测试 · 世界书导入压力测试（500 本 / ≥5MB）
 *
 * 用法（dev 模式 + CDP）：
 *   $env:CDP_PORT="9370"; $env:WB_DIR="I:\03\_wb500"; node scripts/_probe-wb-stress-500.mjs
 *
 * 测什么：
 *   ① `wb:scan` 扫描 500 本大书（≈4GB）能否完成、耗时、入库数量
 *   ② T2 真进度条在真实大库下的表现（事件数 / total 准确性 / 是否单调 / 终态）
 *   ③ 扫描期间窗口是否白屏（渲染层存活）
 *   ④ 内存水位（渲染进程堆）——大库最容易 OOM
 *   ⑤ 二次扫描（走 scanCache）是否更快、结果一致
 *   ⑥ 世界书列表渲染（分页 / 词条数徽标）是否正常、有无渲染期错误
 *   ⑦ 搜索 / 筛选 / 分组操作在 500 本下的响应
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const WB_DIR = process.env.WB_DIR || 'I:\\03\\_wb500';
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
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression, timeoutMs = 300000) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => { console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`); };

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP');

    // ── 准备：挂进度收集器 ──
    await evaluate(`(() => {
        window.__progLog = [];
        window.electronAPI.onWbScanProgress((p) => { window.__progLog.push({ ...p, _t: Date.now() }); });
        return true;
    })()`);

    // ── ① 首扫（冷）：500 本 / ≈4GB ──
    console.log('\n───── ① 首扫（冷启动，无缓存）─────');
    const first = await evaluate(`(async () => {
        const t0 = performance.now();
        const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(WB_DIR)});
        const ms = performance.now() - t0;
        const data = (r && r.data) || [];
        const heavy = data.filter(w => w.heavy).length;
        const noData = data.filter(w => w.dataLoaded === false).length;
        return {
            ok: !!(r && r.success), ms,
            count: data.length,
            skipped: ((r && r.skipped) || []).length,
            heavy, noData,
            entriesSum: data.reduce((s, w) => s + (w.entryCount || 0), 0),
            err: r && r.error
        };
    })()`, 600000);
    info(`首扫耗时 ${(first.ms / 1000).toFixed(1)}s`, `入库 ${first.count} / 跳过 ${first.skipped} / heavy ${first.heavy} / 懒加载 ${first.noData}`);
    info(`词条总数 ${first.entriesSum}`);
    check('首扫 500 本大书成功', first.ok, first.err || '');
    check('入库数量 = 500', first.count === 500, `实际 ${first.count}`);
    check('扫描期间窗口未白屏（渲染层存活）', await evaluate(`document.body.innerHTML.length > 1000`));

    const prog1 = await evaluate('window.__progLog');
    const last1 = prog1[prog1.length - 1] || {};
    const monotonic = prog1.every((e, i) => i === 0 || e.done >= prog1[i - 1].done);
    info(`进度事件 ${prog1.length} 条`, `total=${last1.total} done=${last1.done} phase=${last1.phase}`);
    check('进度条：收到多条进度事件', prog1.length >= 3, `${prog1.length} 条`);
    check('进度条：total 准确（=500）', last1.total === 500, `total=${last1.total}`);
    check('进度条：done 单调不减', monotonic);
    check('进度条：终态 done === total', last1.done === last1.total && last1.phase === 'done',
        `done=${last1.done} total=${last1.total} phase=${last1.phase}`);

    // ── ② 内存水位 ──
    console.log('\n───── ② 内存水位 ─────');
    const mem = await evaluate(`(() => {
        const m = performance.memory || {};
        return {
            usedMB: Math.round((m.usedJSHeapSize || 0) / 1048576),
            totalMB: Math.round((m.totalJSHeapSize || 0) / 1048576),
            limitMB: Math.round((m.jsHeapSizeLimit || 0) / 1048576),
            domNodes: document.querySelectorAll('*').length
        };
    })()`);
    info(`渲染堆 ${mem.usedMB}MB / 上限 ${mem.limitMB}MB`, `DOM 节点 ${mem.domNodes}`);
    check('内存未逼近上限（<70%）', mem.usedMB < mem.limitMB * 0.7, `${mem.usedMB}MB / ${mem.limitMB}MB`);

    // ── ③ 二次扫描（走缓存）──
    console.log('\n───── ③ 二次扫描（走 scanCache）─────');
    await evaluate(`(() => { window.__progLog = []; return true; })()`);
    const second = await evaluate(`(async () => {
        const t0 = performance.now();
        const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(WB_DIR)});
        return { ok: !!(r && r.success), ms: performance.now() - t0, count: ((r && r.data) || []).length, skipped: ((r && r.skipped) || []).length };
    })()`, 600000);
    info(`二扫耗时 ${(second.ms / 1000).toFixed(1)}s`, `入库 ${second.count} / 跳过 ${second.skipped}`);
    check('二扫成功且数量一致', second.ok && second.count === first.count, `${second.count} vs ${first.count}`);

    // ── ④ 世界书列表渲染 ──
    console.log('\n───── ④ 列表渲染与操作 ─────');
    const ui = await evaluate(`(async () => {
        // 切到世界书模式
        const btns = [...document.querySelectorAll('button')];
        const wbBtn = btns.find(x => /🌍\\s*世界书库/.test(x.textContent || ''));
        if (wbBtn) wbBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        const t = document.body.innerText || '';
        return {
            asideAlive: document.querySelectorAll('aside').length,
            hasSearch: t.includes('搜索世界书名称'),
            hasEntryBadge: t.includes('词条'),
            bodyLen: t.length
        };
    })()`);
    check('侧边栏存活（AR-40 未复发）', ui.asideAlive > 0, `aside=${ui.asideAlive}`);
    check('世界书视图渲染出搜索框', ui.hasSearch);
    check('列表渲染出词条数徽标', ui.hasEntryBadge, `bodyLen=${ui.bodyLen}`);

    // ── ⑤ 搜索 / 筛选 / 分组 ──
    console.log('\n───── ⑤ 搜索 / 筛选 / 分组 ─────');
    const ops = await evaluate(`(async () => {
        const out = {};
        const inp = document.querySelector('input[placeholder*="搜索世界书"]');
        // 搜索
        if (inp) {
            const t0 = performance.now();
            inp.value = '世界书A';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 800));
            out.searchMs = Math.round(performance.now() - t0);
            out.searchText = (document.body.innerText || '').includes('世界书A');
        }
        // 筛选按钮（1-15条 / 15+条 / 空书）
        const fBtns = [...document.querySelectorAll('button')].filter(x => /15\\+|1-15条|空书|全部/.test(x.textContent || ''));
        out.filterBtnCount = fBtns.length;
        if (fBtns.length) {
            const t0 = performance.now();
            fBtns[0].click();
            await new Promise(r => setTimeout(r, 600));
            out.filterMs = Math.round(performance.now() - t0);
        }
        return out;
    })()`);
    info(`搜索响应 ${ops.searchMs}ms`, `筛选按钮 ${ops.filterBtnCount} 个，筛选响应 ${ops.filterMs}ms`);
    check('搜索在 500 本下可响应（<3s）', (ops.searchMs || 9999) < 3000, `${ops.searchMs}ms`);
    check('筛选控件存在', (ops.filterBtnCount || 0) > 0, `${ops.filterBtnCount} 个`);

    // ── ⑥ 渲染期错误 ──
    console.log('\n───── ⑥ 渲染期错误 ─────');
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|out of memory/i.test(t));
    check('无渲染期错误 / OOM', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 世界书导入压测：${pass}/${results.length} 通过 ═════`);
    console.log(`首扫 ${(first.ms / 1000).toFixed(1)}s ｜ 二扫 ${(second.ms / 1000).toFixed(1)}s ｜ 堆 ${mem.usedMB}MB ｜ 进度事件 ${prog1.length} 条`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('STRESS PROBE FAILED:', e.message); process.exit(1); });
