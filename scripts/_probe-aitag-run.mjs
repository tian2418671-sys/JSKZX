/**
 * AI 打标「真实 API」端到端探针（2026-09-22）
 *
 * 用法（dev 模式 + CDP + 隔离 profile + **隔离库**）：
 *   $env:CDP_PORT="9375"; $env:TAG_COUNT="2"; node scripts/_probe-aitag-run.mjs
 *
 * ⚠️ **本探针会真实写入卡片**（打标 = 写操作）→ 必须跑在**隔离库副本**上，
 *    绝不能指向 `E:\AI\酒馆工具\角色卡` 等真实库（见 AI交接指导.md 铁律 9）。
 *
 * 断言要点：
 *   ① 库已加载且非空
 *   ② API 配置就绪（endpoint / model 非空，key 非空——只报长度不打印内容）
 *   ③ 走**真实 UI 按钮**「🚀 开始智能打标」启动（不是直接调函数）
 *   ④ 进度条状态推进（current 递增 / status 变化），且弹窗顶部进度条可见
 *   ⑤ 打标期间「取消/关闭」按钮被禁用（防中断写坏卡）
 *   ⑥ 结束后 isAITagging 归位、逐卡日志有结论（成功/失败都要有明确文本）
 *   ⑦ 无渲染期错误
 */
const PORT = Number(process.env.CDP_PORT || 9375);
const TAG_COUNT = Number(process.env.TAG_COUNT || 1);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 180000);
let sock; let msgId = 0; const pending = new Map();
const consoleErrors = [];

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page').webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl); sock.onopen = res; sock.onerror = rej;
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
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);
const wait = (ms) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `port ${PORT}`);

    // ── ① 库状态（必须是隔离库）
    const lib = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const items = ctx.library.value || [];
        return { n: items.length, first: items[0] ? { id: items[0].id, name: items[0].name, path: items[0].path } : null };
    })()`);
    check('库已加载且非空', lib.n > 0, `${lib.n} 张，首张「${lib.first?.name}」`);
    info('库首张路径', lib.first?.path || '(无)');
    if (String(lib.first?.path || '').includes('酒馆工具\\角色卡') || String(lib.first?.path || '').includes('酒馆工具/角色卡')) {
        console.error('\n🚫 检测到真实库路径 —— 本探针会写卡，拒绝在真实库上执行！');
        process.exit(2);
    }

    // ── ② API 配置（key 只报长度）
    const api = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const g = (k) => { const v = ctx[k]; return v && typeof v === 'object' && 'value' in v ? v.value : v; };
        return { endpoint: g('apiEndpoint'), model: g('apiModel'), keyLen: String(g('apiKey') || '').length, type: g('apiType') };
    })()`);
    check('API Endpoint / Model / Key 均已配置', !!api.endpoint && !!api.model && api.keyLen > 0,
        `endpoint=${api.endpoint} model=${api.model} key=长度${api.keyLen} type=${api.type}`);

    // ── ③ 选卡 → 打开弹窗
    const opened = await evaluate(`(async () => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const items = ctx.library.value || [];
        const want = Math.min(${TAG_COUNT}, items.length);
        ctx.selectedIds.value = items.slice(0, want).map(i => i.id);
        ctx.openAITagModal();
        await new Promise(r => setTimeout(r, 900));
        return { selected: ctx.selectedIds.value.length, names: items.slice(0, want).map(i => i.name) };
    })()`);
    await wait(800);
    check('已选卡并打开打标弹窗', opened.selected === TAG_COUNT, `已选 ${opened.selected} 张：${opened.names.join('、')}`);

    // ── ③b 管线层状态（至少要有一层开）
    const funnel = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        return JSON.parse(JSON.stringify(ctx.tagFunnel.value ?? ctx.tagFunnel));
    })()`);
    info('打标三层开关', JSON.stringify(funnel));

    // ── ④ 走真实 UI 按钮启动
    const started = await evaluate(`(() => {
        const m = document.querySelector('.max-w-5xl');
        const btn = m && [...m.querySelectorAll('button')].find(b => (b.textContent || '').includes('开始智能打标'));
        if (!btn) return { ok: false, err: '未找到开始按钮' };
        if (btn.disabled) return { ok: false, err: '按钮为禁用态：' + btn.textContent.trim() };
        btn.click();
        return { ok: true, text: btn.textContent.trim() };
    })()`);
    check('通过真实 UI 按钮启动打标', started.ok, started.err || `按钮文案「${started.text}」`);
    if (!started.ok) { console.log('\n无法继续'); process.exit(1); }
    await wait(1200);

    // ── ⑤ 打标中：进度推进 + 顶部进度条可见 + 关闭按钮被禁用
    const mid = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const p = ctx.aiTaggingProgress.value;
        const m = document.querySelector('.max-w-5xl');
        const bar = m && m.querySelector('.bg-blue-50');
        const closeBtn = m && [...m.querySelectorAll('button')].find(b => (b.textContent || '').includes('✕ 关闭'));
        const cancelBtn = m && [...m.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '取消');
        return { tagging: ctx.isAITagging.value, cur: p.current, total: p.total, status: p.status,
                 barVisible: !!bar && bar.offsetParent !== null,
                 closeDisabled: closeBtn ? closeBtn.disabled : null, cancelDisabled: cancelBtn ? cancelBtn.disabled : null };
    })()`);
    check('打标已进入运行态（isAITagging=true）', mid.tagging === true, `进度 ${mid.cur}/${mid.total}「${mid.status}」`);
    check('打标中顶部进度条可见', mid.barVisible === true);
    check('打标中「✕ 关闭」与「取消」均被禁用（防写坏卡）', mid.closeDisabled === true && mid.cancelDisabled === true,
        `关闭=${mid.closeDisabled} 取消=${mid.cancelDisabled}`);

    // ── ⑥ 轮询直到结束（打印增量日志）
    const t0 = Date.now();
    let lastLogN = 0; let lastStatus = ''; let stuck = '';
    while (Date.now() - t0 < TIMEOUT_MS) {
        const s = await evaluate(`(() => {
            const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
            const p = ctx.aiTaggingProgress.value;
            const logs = (ctx.aiTagLog.value || []).map(l => ({ lv: l.level, t: l.text }));
            return { tagging: ctx.isAITagging.value, cur: p.current, total: p.total, status: p.status, logsN: logs.length, logs: logs.slice(-6) };
        })()`);
        if (s.status !== lastStatus) { console.log(`   ⏱️  ${s.cur}/${s.total}  ${s.status}`); lastStatus = s.status; }
        if (s.logsN > lastLogN) { const news = s.logs.slice(-(s.logsN - lastLogN)); for (const l of news) console.log(`   [${l.lv}] ${String(l.t).slice(0, 160)}`); lastLogN = s.logsN; }
        if (!s.tagging) break;
        await wait(2000);
    }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const fin = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const p = ctx.aiTaggingProgress.value;
        return { tagging: ctx.isAITagging.value, cur: p.current, total: p.total, status: p.status,
                 logs: (ctx.aiTagLog.value || []).map(l => ({ lv: l.level, t: l.text })),
                 cards: ctx.library.value.map(c => ({ name: c.name, tags: (c.customTags || []), dataTags: (c.data && c.data.tags) || [] })) };
    })()`);
    if (fin.tagging) stuck = `超时 ${TIMEOUT_MS / 1000}s 仍在运行（${fin.cur}/${fin.total}）`;
    check('打标流程结束（isAITagging 归位）', !fin.tagging, stuck || `耗时 ${elapsed}s，状态「${fin.status}」`);
    check('逐卡日志有明确结论（非静默 0 结果）', fin.logs.length > 0, `共 ${fin.logs.length} 条日志`);

    console.log('\n── 末 8 条日志 ──');
    for (const l of fin.logs.slice(-8)) console.log(`   [${l.lv}] ${String(l.t).slice(0, 180)}`);
    console.log('\n── 打标后内存中的卡标签 ──');
    for (const c of fin.cards) console.log(`   ${c.name}: customTags=${JSON.stringify(c.tags)} data.tags=${JSON.stringify(c.dataTags)}`);

    // ── ⑦ 渲染错误
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Unhandled/.test(t));
    check('全程无渲染期错误', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ AI 打标真实 API 端到端：${pass}/${results.length} 通过 ═════`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
