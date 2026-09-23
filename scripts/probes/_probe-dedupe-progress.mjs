/**
 * 查重进度条「位置修正」端到端验证
 *
 * 用法（先启动带 CDP 的 Electron）：
 *   node scripts/probes/_probe-dedupe-progress.mjs [世界书目录]
 *
 * 背景（用户 2026-09-22 定性）：
 *   进度条**不是「浏览/加载库」的体现**，而是「**查重 / 版本对比**」流程的体现。
 *   规格依据：`docs/规格与计划/查重扫描与检索-最终方案.md`
 *     · TC-07：「上百本世界书查重：有进度指示 + 当前项名，平滑前推至 100%」
 *     · §185：「进度应挂到扫描阶段」
 *   实现跑偏过：进度条被挂在世界书库列表上方（SidebarPanel.vue），触发点是「打开世界书目录」。
 *
 * 断言：
 *   ① 侧栏**不再**出现扫描进度条（浏览库不占进度条）
 *   ② 浏览库改用日志反馈（addLog 里有「正在读取目录内的世界书文件」）
 *   ③ 查重前会**重扫磁盘**（worldbooks 数量与磁盘一致，且过程中弹出查重弹窗）
 *   ④ 查重弹窗**内部**出现进度区（文案「正在扫描世界书库…」）
 *   ⑤ 进度推进过程能抓到 done/total（真实数据源，不是假进度）
 *   ⑥ 扫描结束后进度区收起（phase=idle）
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const WB_DIR = process.argv[2] || process.env.WB_DIR || 'D:\\TkDmGzq\\_wbscale\\s100';

// ⚠️ 不写死「入库 100 本」：库的构成会随生成器调整而变（实测 s100 实为 97 个 .json）。
//    这里自己数磁盘，让断言与真实一致（否则会误报「重扫失败」）。
import fs from 'node:fs';
import path from 'node:path';
const countJson = (dir) => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) n += countJson(fp);
        else if (e.name.toLowerCase().endsWith('.json')) n++;
    }
    return n;
};
const DISK_JSON = fs.existsSync(WB_DIR) ? countJson(WB_DIR) : 0;

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
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
            if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text || '');
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression, timeoutMs = 600000) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}

// Vue 3.5.41：`app._instance` 恒为 null，根实例在 `_container._vnode.component`
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    if (!app) return null;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

// 侧栏里是否有进度条（查「进度」相关的进度条 DOM 特征）
const SIDEBAR_PROGRESS = `(() => {
    const aside = document.querySelector('aside');
    if (!aside) return { aside: 0, hasProgressBar: false };
    const t = aside.innerText || '';
    // 进度条特征：扫描中文案 + 百分比条
    const hasScanText = /正在扫描|扫描世界书目录/.test(t);
    const hasBar = !!aside.querySelector('.bg-gradient-to-r');
    return { aside: 1, hasScanText, hasBar, hasProgressBar: hasScanText || hasBar };
})()`;

// 弹窗内的进度区
//    ⚠️ 文案可能是「正在扫描世界书库…」（进行中）或「扫描完成：共 N 个文件」（刚结束）
const MODAL_PROGRESS = `(() => {
    const t = document.body.innerText || '';
    const bar = document.querySelector('.dedupe-scan-indeterminate') || document.querySelector('.bg-gradient-to-r');
    return {
        modalOpen: t.includes('世界书智能版本对比中心'),
        hasScanLabel: t.includes('正在扫描世界书库'),
        hasPercentText: /\\d+\\s*\\/\\s*\\d+/.test(t),
        hasBar: !!bar,
        hasDoneText: t.includes('扫描完成：共')
    };
})()`;

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Log.enable');
    info('已连接 CDP', `port=${PORT}，目录 ${WB_DIR}（磁盘 ${DISK_JSON} 个 .json）`);

    const ctxOk = await evaluate(`!!${CTX}`);
    check('能拿到 appCtx', !!ctxOk);
    if (!ctxOk) process.exit(1);

    // ── ① 浏览库：不应出现进度条 ──
    console.log('\n───── ① 浏览库（打开世界书目录）─────');
    const browse = await evaluate(`(async () => {
        const ctx = ${CTX};
        ctx.appMode.value = 'worldbooks';
        const before = ctx.worldbooks.value.length;
        // 清空日志以便精确断言「浏览库用的是日志反馈」
        ctx.editorLogs.value = [];
        await ctx.scanWorldbookDir(${JSON.stringify(WB_DIR)});
        await new Promise(r => setTimeout(r, 800));
        const logs = ctx.editorLogs.value.map(l => (l && (l.msg || l.message)) || String(l)).join(' | ');
        return {
            before, after: ctx.worldbooks.value.length,
            phase: ctx.wbScanProgress.value.phase,
            hasScanningLog: /正在读取目录内的世界书文件/.test(logs),
            hasDoneLog: /扫描完成，共加载 \\d+ 本/.test(logs)
        };
    })()`, 600000);
    info('浏览库结果', `${browse.before} → ${browse.after} 本，wbScanProgress.phase=${browse.phase}`);
    const sb1 = await evaluate(SIDEBAR_PROGRESS);
    check('浏览库后侧栏**无**进度条', !sb1.hasProgressBar, `hasScanText=${sb1.hasScanText} hasBar=${sb1.hasBar}`);
    check('浏览库改用日志反馈（「正在读取目录内的世界书文件」）', browse.hasScanningLog);
    check('浏览库结束写日志「扫描完成，共加载 N 本」', browse.hasDoneLog);
    check('浏览库不占用进度对象（phase 保持 idle）', browse.phase === 'idle', `phase=${browse.phase}`);

    // ── ② 查重：弹窗内应有进度区 ──
    console.log('\n───── ② 查重（同名查重与版本清理）─────');
    // 先记录重扫前后的世界书数量，验证「查重前确实重扫了磁盘」
    const dedupe = await evaluate(`(async () => {
        const ctx = ${CTX};
        const before = ctx.worldbooks.value.length;
        // 埋点：记录查重期间抓到的进度快照（每 60ms 采一次）
        const snaps = [];
        const timer = setInterval(() => {
            const p = ctx.wbScanProgress.value;
            snaps.push({ phase: p.phase, done: p.done, total: p.total, current: (p.current || '').slice(0, 24) });
        }, 60);
        let modalSeenDuringScan = false;
        let scanProgressSeenInModal = false;
        const t0 = Date.now();
        const scanPromise = ctx.startWorldbookDedupeScan();
        // 并行轮询弹窗状态（进度区在弹窗内，必须能抓到）
        const poll = setInterval(() => {
            const t = document.body.innerText || '';
            const p = ctx.wbScanProgress.value;
            if (t.includes('正在扫描世界书库')) modalSeenDuringScan = true;
            // 更强断言：扫描中且弹窗内同时有进度文案 + done/total 数字
            if (p.phase !== 'idle' && /正在扫描世界书库/.test(t)) scanProgressSeenInModal = true;
        }, 60);
        await scanPromise;
        clearInterval(timer); clearInterval(poll);
        await new Promise(r => setTimeout(r, 700));
        return {
            before, after: ctx.worldbooks.value.length, ms: Date.now() - t0,
            snaps,
            modalSeenDuringScan, scanProgressSeenInModal,
            groups: ctx.wbDuplicateGroups.value.length,
            finalPhase: ctx.wbScanProgress.value.phase
        };
    })()`, 900000);
    info(`查重耗时 ${(dedupe.ms / 1000).toFixed(1)}s`, `${dedupe.before} → ${dedupe.after} 本，${dedupe.groups} 组`);
    const phases = [...new Set(dedupe.snaps.map(s => s.phase))];
    const maxTotal = Math.max(0, ...dedupe.snaps.map(s => s.total));
    const maxDone = Math.max(0, ...dedupe.snaps.map(s => s.done));
    const withCurrent = dedupe.snaps.filter(s => s.current).length;
    info('进度快照', `${dedupe.snaps.length} 次采样，phase 序列 ${phases.join('→')}，total 峰值 ${maxTotal}，done 峰值 ${maxDone}，带当前文件名 ${withCurrent} 次`);
    check('查重前确实重扫了磁盘（库数量与磁盘一致）', dedupe.after === DISK_JSON, `${dedupe.before} → ${dedupe.after}（磁盘 ${DISK_JSON}）`);
    check('查重期间能抓到真实进度（done>0 且 total>0）', maxDone > 0 && maxTotal > 0, `done=${maxDone} total=${maxTotal}`);
    check('进度带「当前项名」', withCurrent > 0, `${withCurrent} 次采样带文件名`);
    check('★ 扫描期间弹窗内出现进度文案（弹窗先开再扫）', dedupe.scanProgressSeenInModal,
        `modalSeen=${dedupe.modalSeenDuringScan} withProgress=${dedupe.scanProgressSeenInModal}`);
    check('查重完成后进度收起（phase=idle）', dedupe.finalPhase === 'idle', `phase=${dedupe.finalPhase}`);
    check('查重仍能出结果（同名跨目录各成一组）', dedupe.groups > 0, `${dedupe.groups} 组`);

    const mp = await evaluate(MODAL_PROGRESS);
    check('查重弹窗已打开', mp.modalOpen);
    check('弹窗内进度区已收起（无「正在扫描」残留）', !mp.hasScanLabel, `hasScanLabel=${mp.hasScanLabel}`);

    const sb2 = await evaluate(SIDEBAR_PROGRESS);
    check('查重结束后侧栏仍无进度条', !sb2.hasProgressBar, `hasScanText=${sb2.hasScanText} hasBar=${sb2.hasBar}`);

    // ── ③ 渲染期错误 ──
    console.log('\n───── ③ 渲染期错误 ─────');
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|before initialization|out of memory/i.test(t));
    check('无渲染期错误 / TDZ', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 查重进度条位置修正：${pass}/${results.length} 通过 ═════`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROGRESS PROBE FAILED:', e.message); process.exit(1); });
