/**
 * Phase 2 扫描闸门端到端验证（真实目录 + 真实 IPC）
 *
 * 用法：dev 模式启动 + CDP：
 *   $env:CDP_PORT="9360"; $env:SCAN_DIR="<测试目录>"; node scripts/probes/_probe-scan-gate.mjs
 *
 * 测试目录应含：
 *   - small.json   小世界书（应入库）
 *   - big6mb.json  6MB 世界书（旧代码被 5MB 闸门**静默丢弃**；新代码应识别）
 *   - notawb.json  非世界书（应进 skipped，且**界面可见**）
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

    // 走真实 IPC：scanWorldbooks（含白名单指纹验证 —— 我们的测试目录含有效世界书，应通过）
    const res = await evaluate(`(async () => {
        try {
            const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(SCAN_DIR)});
            if (!r || !r.success) return { ok: false, error: r && r.error };
            return {
                ok: true,
                count: (r.data || []).length,
                hasSkippedKey: 'skipped' in r,
                skippedCount: (r.skipped || []).length,
                names: (r.data || []).map(w => w.name),
                // 元数据字段
                withSize: (r.data || []).filter(w => typeof w.size === 'number').length,
                withEntryCount: (r.data || []).filter(w => typeof w.entryCount === 'number').length,
                withMtime: (r.data || []).filter(w => typeof w.mtime === 'number').length,
                // 6MB 大书是否被识别（旧代码会被 5MB 闸门丢弃）
                bigRecognized: (r.data || []).some(w => w.name === 'big6mb.json'),
                bigEntryCount: ((r.data || []).find(w => w.name === 'big6mb.json') || {}).entryCount,
                bigHeavy: ((r.data || []).find(w => w.name === 'big6mb.json') || {}).heavy,
                // 非世界书是否进了 skipped（可见化）
                skippedNames: (r.skipped || []).map(s => (s.path || '').split(/[\\\\/]/).pop()),
                skippedReasons: (r.skipped || []).map(s => s.reason)
            };
        } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);

    check('wb:scan 调用成功（白名单指纹验证通过）', res && res.ok, JSON.stringify(res).slice(0, 300));
    if (res && res.ok) {
        check('返回结构含 skipped 字段', res.hasSkippedKey === true);
        check('小世界书被识别', res.names.includes('small.json'), 'names=' + JSON.stringify(res.names));
        check('【DF-18 关键】6MB 世界书**不再被 5MB 闸门丢弃**', res.bigRecognized === true, 'bigRecognized=' + res.bigRecognized);
        check('6MB 书带 entryCount 元数据', typeof res.bigEntryCount === 'number' && res.bigEntryCount >= 1, 'entryCount=' + res.bigEntryCount);
        check('6MB 书标记 heavy（>5MB）', res.bigHeavy === true, 'heavy=' + res.bigHeavy);
        check('结果带 size 元数据', res.withSize >= 1, 'withSize=' + res.withSize);
        check('结果带 mtime 元数据', res.withMtime >= 1, 'withMtime=' + res.withMtime);
        check('结果带 entryCount 元数据', res.withEntryCount >= 1, 'withEntryCount=' + res.withEntryCount);
        check('【DF-18 可见化】非世界书进 skipped 而非静默丢弃', res.skippedNames.includes('notawb.json'), 'skipped=' + JSON.stringify(res.skippedNames));
        check('skipped 项带原因说明', (res.skippedReasons || []).some(r => r && r.length > 0), JSON.stringify(res.skippedReasons).slice(0, 160));
    }

    // 缓存自愈：再扫一次，skipped 中不应出现「valid:false 固化」导致大书消失
    const res2 = await evaluate(`(async () => {
        try {
            const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(SCAN_DIR)});
            return { ok: r && r.success, bigStillThere: (r.data || []).some(w => w.name === 'big6mb.json'), count: (r.data || []).length };
        } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    check('二次扫描（走缓存）6MB 书仍在结果里', res2 && res2.bigStillThere === true, JSON.stringify(res2).slice(0, 160));

    const failed = results.filter(r => !r.ok);
    console.log(`\n===== 扫描闸门验证：${results.length - failed.length}/${results.length} 通过 =====`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCAN GATE PROBE FAILED:', e.message); process.exit(1); });
