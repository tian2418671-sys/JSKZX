/**
 * 实测：懒加载书 `readText` 到底为什么失败（找出真因，而不是静默掩盖）
 *
 * 用法：node scripts/probes/_probe-readtext-error.mjs [目录]
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
const ev = async (expr, t = 600000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};
const CTX = `(() => {
    const app = document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

const out = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'worldbooks';
    // 普通扫描（建立白名单）
    const scan = await window.electronAPI.scanWorldbooks(${JSON.stringify(DIR)});
    if (!scan || !scan.success) return { err: '扫描失败: ' + ((scan && scan.error) || '') };
    await ctx.scanWorldbookDir(${JSON.stringify(DIR)});
    await new Promise(r => setTimeout(r, 1200));

    const list = ctx.worldbooks.value;
    const lazy = list.filter(w => w.dataLoaded === false);
    const inline = list.filter(w => w.dataLoaded === true);

    // ① 直接 readText 一本懒加载书
    const probe = lazy[0];
    let direct = null;
    if (probe) {
        try {
            const r = await window.electronAPI.readText(probe.path);
            direct = {
                path: probe.path,
                success: !!(r && r.success),
                error: (r && r.error) || null,
                textLen: (r && r.text) ? r.text.length : 0,
                textHead: (r && r.text) ? r.text.slice(0, 60) : null
            };
        } catch (e) { direct = { path: probe.path, thrown: e.message }; }
    }

    // ② 走 ensureWorldbookLoaded 看它报什么错
    let viaEnsure = null;
    if (probe) {
        const before = probe.dataLoaded;
        await ctx.ensureWorldbookLoaded(probe, { silent: true });
        viaEnsure = { before, after: probe.dataLoaded, loadError: probe._loadError || null, entryCount: probe.entryCount };
    }

    // ③ 已内联的书能否 readText（对照）
    let inlineProbe = null;
    if (inline[0]) {
        try {
            const r = await window.electronAPI.readText(inline[0].path);
            inlineProbe = { path: inline[0].path, success: !!(r && r.success), error: (r && r.error) || null, textLen: (r && r.text) ? r.text.length : 0 };
        } catch (e) { inlineProbe = { thrown: e.message }; }
    }

    return {
        total: list.length, lazyCount: lazy.length, inlineCount: inline.length,
        probePath: probe ? probe.path : null,
        probeSize: probe ? probe.size : null,
        direct, viaEnsure, inlineProbe,
        // 关键：_loadError 分布（若有大量失败，看是不是同一个原因）
        errSample: lazy.slice(0, 5).map(w => ({ name: w.name, size: w.size, err: w._loadError || null }))
    };
})()`, 600000);

console.log('=== 库概况 ===');
console.log(`总 ${out.total} 本：懒加载 ${out.lazyCount} / 已内联 ${out.inlineCount}`);
console.log(`\n=== ① 直接 readText 懒加载书 ===`);
console.log(JSON.stringify(out.direct, null, 1));
console.log(`\n=== ② 走 ensureWorldbookLoaded ===`);
console.log(JSON.stringify(out.viaEnsure, null, 1));
console.log(`\n=== ③ 对照：readText 已内联书 ===`);
console.log(JSON.stringify(out.inlineProbe, null, 1));
console.log(`\n=== _loadError 抽样 ===`);
for (const s of out.errSample) console.log(`  ${s.name} (${s.size} bytes): ${s.err || '（无错误记录）'}`);
process.exit(0);
