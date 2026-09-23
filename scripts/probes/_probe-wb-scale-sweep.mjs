/**
 * 世界书规模梯度全自动扫描（找 OOM 崩溃临界点）
 *
 * 用法：
 *   node scripts/probes/_probe-wb-scale-sweep.mjs                      # 跑默认梯度
 *   node scripts/probes/_probe-wb-scale-sweep.mjs s050 s100            # 只跑指定规模
 *
 * 为什么需要梯度：一次性 500 本崩溃只能说明「会崩」，无法证明**是体积驱动**。
 *   按规模递增找临界点 + 一组「500 本小书」对照，才能把根因钉死在
 *   「≤50MB 世界书的完整 data 全量内联 IPC → 渲染堆 OOM」。
 *
 * 每个规模用**独立 profile**（避免 scan_cache 串味），跑完即杀进程树。
 * 崩溃判定：渲染进程死后 CDP 求值失败 / WebSocket 断开 / 进程退出。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9381;
const SCALE_ROOT = 'D:/TkDmGzq/_wbscale';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const SCALES = args.length ? args : ['s050', 's100', 's200', 's300', 's400'];

// ⚠️ 单规模扫描硬超时：大库在「主进程→渲染层 IPC 回传完整 data」阶段可能长时间无响应
//    （不是崩溃，而是 3~4GB 对象跨进程 structured clone 极慢）。
//    不设上限会让整个 sweep 永远挂住（实测 s300 会卡）。
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 240000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitCdp(timeoutMs = 40000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (e) { /* 未就绪 */ }
        await sleep(400);
    }
    throw new Error('CDP 未就绪（超时）');
}

function connect(wsUrl) {
    return new Promise((res, rej) => {
        const sock = new WebSocket(wsUrl);
        const pending = new Map(); let id = 0;
        const state = { dead: false, consoleErrors: [] };
        sock.onopen = () => res({ sock, state });
        sock.onerror = (e) => rej(new Error('WS 连接失败'));
        sock.onclose = () => { state.dead = true; };
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id); pending.delete(m.id);
                m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
            }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                state.consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
            }
            if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
                state.consoleErrors.push(m.params.entry.text || '');
            }
        };
        state.send = (method, params = {}) => {
            const i = ++id;
            return new Promise((resolve, reject) => { pending.set(i, { resolve, reject }); sock.send(JSON.stringify({ id: i, method, params })); });
        };
        state.evaluate = async (expression, timeoutMs = 900000) => {
            const r = await state.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
            if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
            return r.result && r.result.value;
        };
        state.close = () => { try { sock.close(); } catch (e) {} };
    });
}

const readMemExpr = `(() => {
    const m = performance.memory || {};
    return {
        usedMB: Math.round((m.usedJSHeapSize || 0) / 1048576),
        limitMB: Math.round((m.jsHeapSizeLimit || 0) / 1048576),
        domNodes: document.querySelectorAll('*').length
    };
})()`;

async function runScale(scale) {
    const dir = path.join(SCALE_ROOT, scale);
    if (!fs.existsSync(dir)) return { scale, error: '目录不存在' };
    const profile = path.join(os.tmpdir(), 'jsk-wbscale-' + scale);
    fs.rmSync(profile, { recursive: true, force: true });

    // 磁盘对账
    let diskJson = 0, diskBytes = 0;
    (function walk(p) {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, e.name);
            if (e.isDirectory()) walk(fp);
            else if (e.name.endsWith('.json')) { diskJson++; diskBytes += fs.statSync(fp).size; }
        }
    })(dir);

    const child = spawn(ELECTRON, ['.', '--disable-gpu', `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`, '--enable-logging'], { cwd: ROOT, stdio: 'pipe' });
    const childLog = [];
    child.stdout.on('data', d => childLog.push(d.toString()));
    child.stderr.on('data', d => childLog.push(d.toString()));

    const out = { scale, diskJson, diskGB: +(diskBytes / 1073741824).toFixed(2), crashed: false };
    let cdp = null;
    try {
        const wsUrl = await waitCdp();
        cdp = await connect(wsUrl);
        await cdp.state.send('Runtime.enable');
        await cdp.state.send('Log.enable');

        const mem0 = await cdp.state.evaluate(readMemExpr);
        out.heapBeforeMB = mem0.usedMB;
        out.limitMB = mem0.limitMB;

        // 挂进度收集器
        await cdp.state.evaluate(`(() => {
            window.__progLog = [];
            window.electronAPI.onWbScanProgress((p) => { window.__progLog.push({ ...p, _t: Date.now() }); });
            return true;
        })()`);

        // 后台采样堆（崩溃前的水位很关键）
        let peakMB = mem0.usedMB;
        const sampler = setInterval(async () => {
            try {
                const m = await cdp.state.evaluate(readMemExpr, 4000);
                if (m && m.usedMB > peakMB) peakMB = m.usedMB;
            } catch (e) { /* 渲染进程忙/已死 */ }
        }, 3000);

        const t0 = Date.now();
        try {
            // 🕒 外层硬超时：与 CDP evaluate 的 timeout 双保险（后者对「渲染进程卡死但未崩」不够可靠）
            const scanPromise = cdp.state.evaluate(`(async () => {
                const t0 = performance.now();
                const r = await window.electronAPI.scanWorldbooks(${JSON.stringify(dir)});
                const ms = performance.now() - t0;
                const data = (r && r.data) || [];
                return {
                    ok: !!(r && r.success), ms, error: r && r.error,
                    count: data.length,
                    skipped: ((r && r.skipped) || []).length,
                    heavy: data.filter(w => w.heavy).length,
                    noData: data.filter(w => w.dataLoaded === false).length,
                    entrySum: data.reduce((s, w) => s + (w.entryCount || 0), 0)
                };
            })()`, SCAN_TIMEOUT_MS);
            let timer;
            const r = await Promise.race([
                scanPromise,
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SCAN_TIMEOUT_' + SCAN_TIMEOUT_MS + 'ms')), SCAN_TIMEOUT_MS + 2000); })
            ]);
            clearTimeout(timer);
            clearInterval(sampler);
            out.ms = Math.round(Date.now() - t0);
            Object.assign(out, {
                ok: r.ok, count: r.count, skipped: r.skipped,
                heavy: r.heavy, noData: r.noData, entrySum: r.entrySum, scanError: r.error
            });
            const mem1 = await cdp.state.evaluate(readMemExpr);
            out.heapAfterMB = mem1.usedMB;
            out.peakMB = peakMB;
            const prog = await cdp.state.evaluate('window.__progLog');
            out.progEvents = prog.length;
            out.progTotal = prog.length ? prog[prog.length - 1].total : null;
            out.progDone = prog.length ? prog[prog.length - 1].done : null;
            out.aliveAfter = await cdp.state.evaluate('document.body.innerHTML.length > 1000');
        } catch (e) {
            clearInterval(sampler);
            if (/SCAN_TIMEOUT/.test(e.message)) {
                out.timedOut = true;
                out.peakMB = peakMB;
                out.error = e.message;
            } else {
                out.crashed = true;
                out.peakMB = peakMB;
                out.error = e.message;
            }
        }
        out.consoleErrors = cdp.state.consoleErrors.filter(t =>
            /TypeError|Cannot read|is not a function|Vue 错误|out of memory|Array buffer allocation|Invalid string length|Maximum call stack/i.test(t)).slice(0, 3);
    } catch (e) {
        out.crashed = true;
        out.error = out.error || e.message;
    } finally {
        if (cdp) cdp.state.close();
        try { child.kill(); } catch (e) {}
        await sleep(600);
        try {
            const { execSync } = await import('node:child_process');
            execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch (e) { /* 已退出 */ }
        await sleep(400);
    }

    // crash.log 取证
    const crashLog = path.join(profile, 'crash.log');
    if (fs.existsSync(crashLog)) {
        out.crashLog = fs.readFileSync(crashLog, 'utf8').trim().split('\n').slice(-2).join(' | ');
    }
    const scanCache = path.join(profile, 'scan_cache.json');
    if (fs.existsSync(scanCache)) {
        try {
            const d = JSON.parse(fs.readFileSync(scanCache, 'utf8'));
            out.cacheEntries = Object.keys(d.worldbook || {}).length;
        } catch (e) {}
    }
    return out;
}

(async () => {
    console.log('世界书规模梯度扫描（每规模独立 profile）\n');
    const rows = [];
    for (const s of SCALES) {
        process.stdout.write(`▶ ${s} ... `);
        const r = await runScale(s);
        rows.push(r);
        if (r.error === '目录不存在') { console.log('跳过（无此目录）'); continue; }
        const verdict = r.crashed ? '💥 崩溃' : r.timedOut ? '⏰ 超时' : (r.ok ? '✅ 完成' : '⚠️ 失败');
        console.log(`${verdict}  ${r.ms ? (r.ms / 1000).toFixed(1) + 's' : ''}  堆峰值 ${r.peakMB || '?'}MB / ${r.limitMB || '?'}MB`);
    }

    console.log('\n═════════════ 规模梯度结果 ═════════════');
    console.log('规模   磁盘.json  体积     结果     耗时      入库  跳过  heavy  懒加载 词条合计  堆峰值/上限        缓存条数');
    for (const r of rows) {
        if (r.error === '目录不存在') { console.log(`${r.scale}   —          —        （无目录）`); continue; }
        console.log(
            `${r.scale.padEnd(6)} ${String(r.diskJson).padEnd(10)} ${String(r.diskGB + 'GB').padEnd(8)} ` +
            `${(r.crashed ? '💥崩溃' : r.timedOut ? '⏰超时' : r.ok ? '✅完成' : '⚠️失败').padEnd(8)} ` +
            `${String(r.ms ? (r.ms / 1000).toFixed(1) + 's' : '-').padEnd(9)} ` +
            `${String(r.count ?? '-').padEnd(5)} ${String(r.skipped ?? '-').padEnd(5)} ` +
            `${String(r.heavy ?? '-').padEnd(6)} ${String(r.noData ?? '-').padEnd(7)} ` +
            `${String(r.entrySum ?? '-').padEnd(9)} ` +
            `${String((r.peakMB ?? '?') + 'MB/' + (r.limitMB ?? '?') + 'MB').padEnd(18)} ` +
            `${r.cacheEntries ?? '-'}`
        );
    }
    console.log('\n明细（JSON）：');
    console.log(JSON.stringify(rows, null, 2));
    fs.writeFileSync(path.join(os.tmpdir(), 'jsk-wb-scale-sweep.json'), JSON.stringify(rows, null, 2), 'utf8');
    console.log('\n结果已写入 ' + path.join(os.tmpdir(), 'jsk-wb-scale-sweep.json'));
})();
