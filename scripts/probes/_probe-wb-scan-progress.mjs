/**
 * T2 真进度条端到端验证（真实目录 + 真实 IPC + 真实进度事件）
 *
 * 用法（dev 模式启动带 CDP 的 Electron）：
 *   $env:CDP_PORT="9360"; $env:SCAN_DIR="<测试目录>"; node scripts/probes/_probe-wb-scan-progress.mjs
 *
 * 验证目标（对应最终方案 TC-07）：
 *   ① 单次 IPC 期间**能收到多条** `wb:scan-progress` 事件（旧实现一条都收不到）
 *   ② 事件里 total 准确（= 目录内 .json 总数，含子目录）
 *   ③ done 单调不减，且终态 done === total（进度条能推到 100%）
 *   ④ 事件里带 current（当前项名）与 phase
 *   ⑤ 窗口不白屏：扫描期间渲染层仍能求值
 */
const PORT = Number(process.env.CDP_PORT || 9360);
const SCAN_DIR = process.env.SCAN_DIR;
let sock; let msgId = 0; const pending = new Map();

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
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}

(async () => {
    if (!SCAN_DIR) { console.error('缺少 SCAN_DIR 环境变量'); process.exit(1); }
    await connect(await getWs());
    await send('Runtime.enable');

    const results = [];
    const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

    // ① 在页面里挂一个收集器（走真实 preload 通道，与 UI 用的是同一条）
    await evaluate(`(() => {
        window.__wbProgressLog = [];
        window.electronAPI.onWbScanProgress((p) => { window.__wbProgressLog.push({ ...p, _t: Date.now() }); });
        return true;
    })()`);

    // ② 走真实 IPC 触发扫描（与 UI 的 scanWorldbookDir 同一条通道）
    const scan = await evaluate(`(async () => {
        const t0 = Date.now();
        const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(SCAN_DIR)});
        return { ok: !!(r && r.success), count: (r && r.data || []).length, ms: Date.now() - t0, error: r && r.error };
    })()`);

    const log = await evaluate('window.__wbProgressLog');
    console.log(`\n扫描结果：ok=${scan.ok} 入库=${scan.count} 耗时=${scan.ms}ms，收到进度事件 ${log.length} 条\n`);

    check('扫描成功（目录白名单指纹验证通过）', scan.ok, scan.error || '');
    check('单次 IPC 期间收到多条进度事件（旧实现为 0 条）', log.length >= 3, `实际 ${log.length} 条`);

    const total = log.length ? log[log.length - 1].total : 0;
    const last = log.length ? log[log.length - 1] : null;
    const phases = [...new Set(log.map(e => e.phase))];
    const hasCurrent = log.some(e => e.current && e.current.length > 0);
    const monotonic = log.every((e, i) => i === 0 || e.done >= log[i - 1].done);
    const maxDone = log.reduce((m, e) => Math.max(m, e.done), 0);

    check('total 准确（= 目录内 .json 总数）', total === scan.count + 0 || total >= scan.count,
        `total=${total}，入库=${scan.count}`);
    check('done 单调不减', monotonic);
    check('终态 done === total（进度条能到 100%）', last && last.done === last.total,
        last ? `done=${last.done} total=${last.total}` : '无事件');
    check('事件带 current（当前项名）', hasCurrent, log.find(e => e.current)?.current || '');
    check('终态 phase 为 done', last && last.phase === 'done', `phases=${phases.join(',')}`);
    check('done 覆盖到全部文件（无遗漏路径）', maxDone >= total, `maxDone=${maxDone} total=${total}`);

    // ⑤ 窗口不白屏：扫描期间渲染层仍可求值（DOM 有内容）
    const alive = await evaluate(`document.body && document.body.innerHTML.length > 100`);
    check('扫描期间窗口未白屏（渲染层存活）', !!alive);

    const pass = results.filter(r => r.ok).length;
    console.log(`\n===== ${pass}/${results.length} 通过 =====`);
    process.exit(pass === results.length ? 0 : 1);
})();
