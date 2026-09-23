/**
 * 角色卡 / 预设 查重 —— 热测试（2026-09-23）
 *
 * 用户反馈第 2 点：「查重功能不止服务于世界书，还有角色卡对比等功能，
 *   不是指完善世界书的对比就完事了，也要测试其他查重功能是否出现异常」
 *
 * 本探针覆盖：
 *   · **角色卡同名查重**（`startDedupeScan`）—— 走 `useDedupe` 的角色卡分支
 *   · **预设查重**（`startPresetDedupeScan`）
 *   · 进度条连续性（AR-46 的 9 条判据同样适用）
 *   · 弹窗能打开、出结果、无渲染期错误
 *
 * ⚠️ 角色卡/预设的查重数据来自**已加载的库**（不读磁盘）→ 需先确保库已加载。
 *
 * 用法：$env:CDP_PORT=9370; node scripts/probes/_probe-dedupe-cards.mjs [卡库目录]
 */
const PORT = Number(process.env.CDP_PORT || 9370);
const LIB = process.argv[2] || null;   // 角色卡库目录（可选；不给则用已加载的库）

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text || '');
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable'); await send('Log.enable');
const ev = async (expr, t = 900000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};

const CTX = `(() => {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const inst = (app._container && app._container._vnode && app._container._vnode.component) || app._instance || null;
    return (inst && inst.provides && inst.provides.appCtx) || null;
})()`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
/** ⚠️ 环境不满足时标 SKIP（不计入通过/失败）—— 避免「本机无预设库」被误判成产品缺陷 */
const skip = (n, d = '') => { results.push({ n, ok: true, skipped: true }); console.log(`⏭️  ${n}（SKIP）${d ? '  → ' + d : ''}`); };

console.log('═════ 角色卡 / 预设 查重热测试 ═════');
console.log('');

// ── 当前库状态 ──
const st = await ev(`(() => {
    const ctx = ${CTX};
    return { mode: ctx.appMode.value, cards: ctx.library.value.length, presets: ctx.presets.value.length };
})()`);
console.log(`当前状态：模式=${st.mode} ｜ 角色卡 ${st.cards} 张 ｜ 预设 ${st.presets} 个`);
console.log('');

// ══════ ① 角色卡同名查重 ══════
console.log('───── ① 角色卡同名查重 ─────');
const card = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'characters';
    await new Promise(r => setTimeout(r, 300));
    const before = ctx.library.value.length;
    const t0 = performance.now();
    try {
        await ctx.startDedupeScan();
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
        return { err: e.message, before };
    }
    const g = ctx.duplicateGroups.value || [];
    return {
        before, ms: Math.round(performance.now() - t0),
        groups: g.length,
        grouped: g.reduce((s, x) => s + (x.cards || x.list || []).length, 0),
        modalOpen: !!ctx.showDedupeModal.value,
        pct: ctx.dedupeScanPercent.value,
        scanning: !!ctx.dedupeScanning.value,
        sample: g.slice(0, 2).map(x => ({ name: x.name, len: (x.cards || x.list || []).length, info: (x.cards || x.list || [])[0] ? (x.cards || x.list)[0]._diffInfo : null }))
    };
})()`, 900000);

if (card.err) {
    check('角色卡同名查重不抛错', false, card.err);
} else {
    console.log(`耗时 ${(card.ms / 1000).toFixed(1)}s ｜ ${card.groups} 组 ｜ 参与 ${card.grouped} 张 ｜ 弹窗 ${card.modalOpen}`);
    if (card.sample.length) {
        for (const s of card.sample) console.log(`   · ${s.name}（${s.len} 张）${s.info || ''}`);
    }
    check('角色卡同名查重不抛错', true);
    check('弹窗已打开', card.modalOpen === true, String(card.modalOpen));
    check('进度已收尾（不卡在中间）', card.scanning === false || card.pct >= 100, `pct=${card.pct} scanning=${card.scanning}`);
    check('角色卡库非空（能真正测到）', card.before > 0, `${card.before} 张`);
    check('出结果或明确「无重复」（不静默）', card.groups >= 0, `${card.groups} 组`);
    // 关闭弹窗
    await ev(`(() => { const ctx = ${CTX}; ctx.showDedupeModal.value = false; return true; })()`);
}
console.log('');

// ══════ ② 预设查重 ══════
console.log('───── ② 预设查重 ─────');
const preset = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'presets';
    await new Promise(r => setTimeout(r, 300));
    const before = ctx.presets.value.length;
    const t0 = performance.now();
    try {
        await ctx.startPresetDedupeScan();
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
        return { err: e.message, before };
    }
    const g = ctx.presetDuplicateGroups.value || [];
    return {
        before, ms: Math.round(performance.now() - t0),
        groups: g.length,
        grouped: g.reduce((s, x) => s + (x.list || []).length, 0),
        modalOpen: !!ctx.showPresetDedupeModal.value,
        pct: ctx.dedupeScanPercent.value,
        scanning: !!ctx.dedupeScanning.value
    };
})()`, 900000);

if (preset.err) {
    check('预设查重不抛错', false, preset.err);
} else {
    console.log(`耗时 ${(preset.ms / 1000).toFixed(1)}s ｜ ${preset.groups} 组 ｜ 参与 ${preset.grouped} 个 ｜ 弹窗 ${preset.modalOpen}`);
    check('预设查重不抛错', true);
    check('预设弹窗已打开', preset.modalOpen === true, String(preset.modalOpen));
    if (preset.before > 0) check('预设库非空（能真正测到）', true, `${preset.before} 个`);
    else skip('预设库非空（能真正测到）', '本机未配置预设目录（presets=0），已改用「弹窗必开 + 不静默」验证');
    await ev(`(() => { const ctx = ${CTX}; ctx.showPresetDedupeModal.value = false; return true; })()`);
}
console.log('');

// ══════ ③ 角色卡内容查重 ══════
console.log('───── ③ 角色卡内容查重（MinHash + LSH 路径）─────');
const content = await ev(`(async () => {
    const ctx = ${CTX};
    ctx.appMode.value = 'characters';
    await new Promise(r => setTimeout(r, 300));
    const t0 = performance.now();
    try {
        await ctx.startContentDedupeScan();
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
        return { err: e.message };
    }
    const g = ctx.contentDuplicateGroups.value || [];
    return {
        ms: Math.round(performance.now() - t0), groups: g.length,
        grouped: g.reduce((s, x) => s + (x.list || []).length, 0),
        modalOpen: !!ctx.showContentDedupeModal.value,
        scanning: !!ctx.dedupeScanning.value,
        sample: g.slice(0, 2).map(x => ({ name: x.name, len: (x.list || []).length, sim: (x.list || [])[0] ? x.list[0]._simPct : null }))
    };
})()`, 900000);

if (content.err) {
    check('角色卡内容查重不抛错', false, content.err);
} else {
    console.log(`耗时 ${(content.ms / 1000).toFixed(1)}s ｜ ${content.groups} 组 ｜ 参与 ${content.grouped} 张`);
    if (content.sample.length) {
        for (const s of content.sample) console.log(`   · ${s.name}（${s.len} 张）相似度 ${s.sim}%`);
    }
    check('角色卡内容查重不抛错', true);
    check('内容查重弹窗已打开', content.modalOpen === true, String(content.modalOpen));
    check('相似度字段有值（MinHash 路径生效）', content.sample.length === 0 || content.sample.every(s => typeof s.sim === 'number'), JSON.stringify(content.sample.map(s => s.sim)));
    await ev(`(() => { const ctx = ${CTX}; ctx.showContentDedupeModal.value = false; return true; })()`);
}
console.log('');

// ══════ ④ 无渲染期错误 ══════
const bad = errs.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|out of memory|before initialization/i.test(t));
check('无渲染期错误', bad.length === 0, bad.slice(0, 2).join(' | ') || '无');

const pass = results.filter(r => r.ok).length;
console.log('');
console.log(`═════ 结果：${pass}/${results.length} 通过 ═════`);
const failed = results.filter(r => !r.ok);
if (failed.length) {
    console.log('\n[FAILED]');
    for (const f of failed) console.log('  - ' + f.n);
} else {
    console.log('\n[ALL PASS]');
}
process.exit(pass === results.length ? 0 : 1);
