/**
 * PK-24 专项验证：秒开阶段 1 **不能跳过世界书校验**（诱饵 JSON 不得混进世界书列表）
 *
 * 用法：node scripts/probes/_probe-wb-valid-gate.mjs "<世界书目录>"
 *   node scripts/probes/_probe-wb-valid-gate.mjs "D:\TkDmGzq\_wb5k\s1000"
 *
 * ⚠️ **必须用全新 profile 启动应用**（否则 `scan_cache.json` 已存在，测不到「首次」路径）：
 *   npx electron . --disable-gpu --remote-debugging-port=9371 --user-data-dir="%TEMP%\jsk-pk24" --enable-logging
 *
 * 测什么（对照 PK-24 的修复）：
 *   ① 首次（无缓存）：阶段 1 可能列出全部 `.json`（含诱饵）→ **阶段 2 必须把它们剔除**，
 *      最终 `worldbooks` 数量 === 磁盘有效数
 *   ② 二次（有 `worldbook` 缓存）：阶段 1 **精准剔除**诱饵（数量 === 有效数），且**不读盘**
 *   ③ 剔除行为**不得误杀真世界书**（有效数必须一个不少）
 *   ④ 无渲染期错误
 *
 * ⚠️ 断言**自己数磁盘**（不写死），否则库构成一变就误报。
 */
const PORT = Number(process.env.CDP_PORT || 9371);
const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-wb-valid-gate.mjs <目录>'); process.exit(1); }

const fs = await import('node:fs');
const path = await import('node:path');

// ── 磁盘对账（自己数，不写死）──
// 用与 `main.js` **逐字一致**的 `isValidWorldbook` 判据，独立算「磁盘有效数」
function isValidWorldbook(wbData) {
    if (!wbData || typeof wbData !== 'object') return false;
    if (wbData.spec === 'chara_card_v2' || wbData.spec === 'chara_card_v3') return false;
    if (wbData.data && (wbData.data.description !== undefined || wbData.data.first_mes !== undefined)) return false;
    if (!wbData.entries) return false;
    if (typeof wbData.entries === 'object' && !Array.isArray(wbData.entries)) {
        wbData.entries = Object.values(wbData.entries);
    }
    if (!Array.isArray(wbData.entries)) return false;
    if (wbData.entries.length > 0) {
        const sample = wbData.entries[0];
        if (!sample || typeof sample !== 'object') return false;
        const isWbEntry = ('key' in sample) || ('keys' in sample) || ('content' in sample) || ('comment' in sample) || ('uid' in sample);
        if (!isWbEntry) return false;
    }
    return true;
}
const diskFiles = [];
(function walk(p, depth = 0) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(p, e.name);
        if (e.isDirectory()) { if (depth < 5) walk(fp, depth + 1); continue; }
        if (e.name.toLowerCase().endsWith('.json')) diskFiles.push(fp);
    }
})(DIR);
let diskValid = 0, diskInvalid = 0, diskUnreadable = 0;
for (const fp of diskFiles) {
    try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (isValidWorldbook(j)) diskValid++; else diskInvalid++;
    } catch (e) { diskUnreadable++; diskInvalid++; }
}
const diskJson = diskFiles.length;

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
const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;
const DIR_LIT = JSON.stringify(DIR);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

console.log(`═════ PK-24 校验门禁验证：${DIR} ═════`);
info('磁盘对账', `${diskJson} 个 .json（有效 ${diskValid} / 无效 ${diskInvalid}${diskUnreadable ? `，含 ${diskUnreadable} 个坏 JSON` : ''}）`);
if (diskInvalid === 0) {
    console.log('\n⚠️ 该目录**没有无效文件**，测不出「诱饵是否被误收」——请换一个含诱饵的库。');
    process.exit(1);
}

// ── ① 首次（无缓存）──
console.log('\n───── ① 首次扫描（无缓存）─────');
const first = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    const t0 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    // 阶段 1 刚结束时立即取一次数量（阶段 2 是 await 的，这里拿到的已是终态）
    const list = ctx.worldbooks.value;
    const fast = await window.electronAPI.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    return {
        ms: Math.round(performance.now() - t0),
        count: list.length,
        fastCount: ((fast && fast.data) || []).length,
        fastSkipped: ((fast && fast.skipped) || []).length,
        withName: list.filter(w => w.wbName).length,
        named: list.map(w => w.wbName).filter(Boolean).slice(0, 3)
    };
})()`, 3600000);
info('完整流程', `${(first.ms / 1000).toFixed(1)}s，最终入库 ${first.count} 本`);
info('再次秒开', `阶段 1 列出 ${first.fastCount} 本，剔除 ${first.fastSkipped} 本`);
check('① 最终入库数 = 磁盘有效数（诱饵已剔除）', first.count === diskValid, `${first.count} vs ${diskValid}`);
check('① 剔除数 = 磁盘无效数', first.fastSkipped === diskInvalid, `${first.fastSkipped} vs ${diskInvalid}`);
check('① 未误杀真世界书（有效数一个不少）', first.count >= diskValid, `${first.count} vs ${diskValid}`);

// ── ② 二次（有缓存）──
console.log('\n───── ② 二次秒开（有 worldbook 缓存）─────');
const second = await ev(`(async () => {
    const ctx = ${CTX};
    const t1 = performance.now();
    const f = await window.electronAPI.scanWorldbooks(${DIR_LIT}, { fastListOnly: true });
    const phase1Ms = Math.round(performance.now() - t1);
    const t2 = performance.now();
    await ctx.scanWorldbookDir(${DIR_LIT});
    return {
        phase1Ms,
        fastCount: ((f && f.data) || []).length,
        fastSkipped: ((f && f.skipped) || []).length,
        fullMs: Math.round(performance.now() - t2),
        finalCount: ctx.worldbooks.value.length,
        allNamed: ctx.worldbooks.value.every(w => !!w.wbName),
        allCounted: ctx.worldbooks.value.every(w => typeof w.entryCount === 'number')
    };
})()`, 3600000);
info('⚡ 阶段 1（缓存精准过滤）', `${second.phase1Ms}ms，列出 ${second.fastCount} 本，剔除 ${second.fastSkipped} 本`);
info('二次完整流程', `${second.fullMs}ms，入库 ${second.finalCount} 本`);
check('★ ② 阶段 1 精准列出（= 有效数，诱饵从不出现）', second.fastCount === diskValid, `${second.fastCount} vs ${diskValid}`);
check('② 阶段 1 达到秒开（< 2000ms）', second.phase1Ms < 2000, `${second.phase1Ms}ms`);
check('② 最终入库数仍 = 有效数', second.finalCount === diskValid, `${second.finalCount} vs ${diskValid}`);
check('② 元数据全部补齐（书名 / 词条数）', second.allNamed && second.allCounted,
    `书名 ${second.allNamed} / 词条数 ${second.allCounted}`);

// ── ③ 剔除不误杀（逐路径对账）──
console.log('\n───── ③ 逐路径对账（应用 vs 磁盘）─────');
const names = await ev(`(() => { const ctx = ${CTX}; return ctx.worldbooks.value.map(w => w.name).sort(); })()`);
const appSet = new Set(names);
const diskValidNames = [];
for (const fp of diskFiles) {
    try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (isValidWorldbook(j)) diskValidNames.push(path.basename(fp));
    } catch (e) { /* 坏 JSON 不算有效 */ }
}
const missing = diskValidNames.filter(n => !appSet.has(n));
check('③ 磁盘有效文件**全部**在应用列表中（零漏收）', missing.length === 0,
    missing.length ? `漏 ${missing.length}：${missing.slice(0, 5).join('、')}` : '零漏收');

// ── ④ 渲染期错误 ──
console.log('\n───── ④ 渲染期错误 ─────');
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Maximum call stack|out of memory|Invalid string length|before initialization/i.test(t));
check('无渲染期错误 / OOM / TDZ', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

const pass = results.filter(r => r.ok).length;
console.log(`\n═════ 结果：${pass}/${results.length} 通过 ═════`);
process.exit(pass === results.length ? 0 : 1);
