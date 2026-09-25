/**
 * AI 打标「单套提示词链路 + 打包滑块 + 续跑入口」端到端验证（第二批改造 · 2026-09-25）
 *
 * 用法（先启动带 CDP 的实例，再跑本探针）：
 *   npx electron . --disable-gpu --enable-logging --remote-debugging-port=9375 `
 *     --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling `
 *     --user-data-dir=$env:TEMP\jsk-v2-probe-profile
 *   $env:CDP_PORT="9375"; node scripts/probes/_probe-aitag-chain-v2.mjs
 *
 * 断言（新增链路）：
 *   ① 弹窗可打开（真实库场景需等库加载完成；隔离空库可注入探针卡；本探针不写盘）
 *   ② 左导航 = 6 项；不再有「强制破限」「系统提示词库」独立项
 *   ③ 「系统提示词」页存在：System 框 / 破限栏（内置顶部）/ User 框 / 打包滑块 / 预填充折叠
 *   ④ System 默认文案非空（新装/空配置 → 内置默认含「角色卡标签分析助手」）
 *   ⑤ System 预设套用下拉 ≥ 4 项（3 变体 + 自定义）
 *   ⑥ 打包滑块可调（1~10），改完「执行管线」页同值（两处同步）
 *   ⑦ 预填充折叠可展开；「执行管线」页无续跑块（无账本时）
 *   ⑧ 无渲染期错误（console error / [Vue 错误]）
 *   ⑨ __jskDiag.aiTag.rolePrompts() 读数与 UI 一致（packSize / systemLen）
 */
const PORT = Number(process.env.CDP_PORT || 9375);
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
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}
// 轮询等待（探针纪律：不用固定 sleep 赌时序）
async function waitFor(expr, timeoutMs = 5000, interval = 120) {
    const t0 = Date.now();
    for (;;) {
        const v = await evaluate(expr);
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) return null;
        await new Promise(r => setTimeout(r, interval));
    }
}

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };
const info = (n, d = '') => console.log(`INFO ${n}${d ? '  => ' + d : ''}`);

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP');
    try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        info('targets', targets.map(t => `${t.type}|${String(t.title).slice(0, 30)}|${String(t.url).slice(0, 60)}`).join('  ;;  '));
    } catch (e) { /* 忽略 */ }

    // 🔄 先重载页面：dev 模式下 HMR 会留下「旧实例 ctx / 半更新状态」，
    //    缓存旧 ctx 去开弹窗会点不亮新界面（实测 2026-09-25）。重载后一切从新。
    try {
        await send('Page.enable');
        await send('Page.reload', { ignoreCache: true });
        info('已重载页面（获取全新实例）');
        await new Promise(r => setTimeout(r, 2500));
    } catch (e) { /* 忽略 */ }

    // ⏳ 等应用就绪（大库扫描/配置恢复需要时间；不等会误报 no ctx）
    //    ⚠️ appCtx 挂在 `app._context.provides.appCtx`（root provide 写入 appContext），
    //       而不是 `_instance.provides`（后者在本应用为 null——实测 2026-09-25）。
    const ctxReady = await waitFor(`(function () {
        try {
            var a = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
            if (!a) return false;
            var c = (a._context && a._context.provides && a._context.provides.appCtx)
                 || (a._instance && a._instance.provides && a._instance.provides.appCtx);
            if (c) { window.__probeCtx = c; return true; }
            return false;
        } catch (e) { return false; }
    })()`, 30000, 300);
    check('⓪ appCtx 就绪', !!ctxReady);
    if (!ctxReady) {
        const dbg = await evaluate(`(() => {
            const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
            const inst = app && app._instance;
            return {
                href: location.href, title: document.title, readyState: document.readyState,
                hasApp: !!document.querySelector('#app'), hasVueApp: !!app, hasInstance: !!inst,
                appCtxPathA: !!(app && app._context && app._context.provides && app._context.provides.appCtx),
                appContextKeys: (app && app._context) ? Object.keys(app._context).slice(0, 20) : [],
                providesKeys: (app && app._context && app._context.provides) ? Object.keys(app._context.provides).slice(0, 20) : []
            };
        })()`);
        info('debug', JSON.stringify(dbg));
    }

    // ① 打开弹窗：先等库加载完成（真实库场景 reload 后重新拉库需要数秒；
    //    2026-09-25 踩坑：不等就冲 → lib2[0].id 崩（库还在加载中）。超时后才走「注入探针卡」备选）
    const libN = await (async () => {
        const t0 = Date.now();
        for (;;) {
            const n = await evaluate(`(function () { try { var c = window.__probeCtx; if (!c || !c.library || !c.library.value) return -1; return c.library.value.length; } catch (e) { return -1; } })()`);
            if (n > 0) return n;
            if (Date.now() - t0 > 20000) return 0;
            await new Promise(r => setTimeout(r, 400));
        }
    })();
    info('库加载等待结束', `libLen=${libN}`);
    const opened = await evaluate(`(async () => {
        const ctx = window.__probeCtx;
        if (!ctx) return { ok: false, err: 'no ctx' };
        const lib = ctx.library && ctx.library.value ? ctx.library.value : [];
        if (!lib.length) {
            const mk = (i) => ({ id: 'probe' + i, path: 'E:/probe/probe' + i + '.png', fileName: 'probe' + i + '.png', name: '探针角色' + i,
                data: { name: '探针角色' + i, description: '第' + i + '张探针卡（链路验证用）', personality: '冷静', first_mes: '你好', tags: [] }, customTags: [] });
            ctx.library.value = [mk(1), mk(2)];
            await new Promise(r => setTimeout(r, 300));
        }
        const lib2 = ctx.library.value;
        if (!lib2.length) return { ok: false, err: '库仍为空（可能还在加载）—— 稍后重跑本探针' };
        if (ctx.selectedIds && ctx.selectedIds.value) ctx.selectedIds.value = [lib2[0].id];
        if (typeof ctx.openAITagModal !== 'function') return { ok: false, err: 'no openAITagModal' };
        ctx.openAITagModal();
        return { ok: true, cards: lib2.length };
    })()`);
    check('① 弹窗可打开', !!(opened && opened.ok), opened && opened.err ? String(opened.err) : `库 ${opened && opened.cards} 张`);

    const modalShown = await waitFor(`!!document.querySelector('.max-w-5xl')`, 5000);
    check('①b 弹窗根节点已渲染', !!modalShown);

    // ② 左导航 = 6 项；不含旧「强制破限 / 系统提示词库」项
    const navInfo = await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return { count: -1, items: [], err: 'no modal' };
        const nav = modal.querySelector('.w-52');
        const items = nav ? [...nav.querySelectorAll('button')].map(b => b.textContent.trim()) : [];
        return { count: items.length, items };
    })()`).catch(e => ({ count: -1, items: [], err: String(e) }));
    check('② 左导航 6 项', navInfo.count === 6, `实际 ${navInfo.count}：${JSON.stringify(navInfo.items)}`);
    {
        const joined = (navInfo.items || []).join('|');
        check('②b 无「强制破限」独立项', !joined.includes('强制破限'));
        check('②c 无「系统提示词库」旧名', !joined.includes('系统提示词库'));
    }

    // ③ 切到「系统提示词」页 → 检查链路四件套
    await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return false;
        const nav = modal.querySelector('.w-52');
        const btn = [...nav.querySelectorAll('button')].find(b => b.textContent.includes('系统提示词'));
        if (btn) btn.click();
        return !!btn;
    })()`);
    await new Promise(r => setTimeout(r, 250));
    const chain = await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return { err: 'no modal' };
        const visible = (el) => !!(el && el.offsetParent !== null);
        const texts = modal.innerText;
        const checkboxes = [...modal.querySelectorAll('input[type=checkbox]')].filter(visible);
        const ranges = [...modal.querySelectorAll('input[type=range]')].filter(visible);
        const selects = [...modal.querySelectorAll('select')].filter(visible);
        const textareas = [...modal.querySelectorAll('textarea')].filter(visible);
        const variantSel = selects.find(s => s.textContent.includes('标准打标'));
        const packRange = ranges.find(r => r.max === '10');
        const sysTa = textareas.find(t => String(t.value).includes('角色卡标签分析助手')) || textareas[0];
        return {
            hasSystemLabel: texts.includes('角色设定 / 任务规则 / 打标原则'),
            hasJailbreak: checkboxsToBool(checkboxes) ,
            checkboxCount: checkboxes.length,
            rangeCount: ranges.length,
            packOk: !!packRange,
            variantOptions: variantSel ? variantSel.options.length : -1,
            sysLen: sysTa ? String(sysTa.value).length : 0,
            hasUserBox: texts.includes('本次任务指令'),
            hasPackRow: texts.includes('每请求打包卡数'),
            hasPrefill: texts.includes('预填充')
        };
        function checkboxsToBool(arr) { return arr.some(c => { const lab = c.closest('label'); return lab && lab.textContent.includes('启用强制破限'); }); }
    })()`);
    check('③ System 框存在', chain.hasSystemLabel);
    check('③b 破限栏（内置顶部）存在', chain.hasJailbreak, `checkbox ${chain.checkboxCount} 个`);
    check('③c User 框存在', chain.hasUserBox);
    check('③d 打包滑块存在', chain.hasPackRow && chain.packOk, `range ${chain.rangeCount} 个`);
    check('④ System 默认文案非空（含「角色卡标签分析助手」）', chain.sysLen > 50, `len=${chain.sysLen}`);
    check('⑤ System 预设套用 ≥ 4 项', chain.variantOptions >= 4, `options=${chain.variantOptions}`);

    // ⑥ 打包滑块：3 张/请求 → 「执行管线」页同值
    await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return false;
        const r = [...modal.querySelectorAll('input[type=range]')].find(r => r.offsetParent !== null && r.max === '10');
        if (!r) return false;
        r.value = '3';
        r.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await new Promise(r => setTimeout(r, 200));
    const packPrompts = await evaluate(`(document.querySelector('.max-w-5xl') || {}).innerText ? document.querySelector('.max-w-5xl').innerText.includes('3 张/请求') : false`);
    check('⑥ 滑块改 3 生效（提示词页）', !!packPrompts);

    // 切「执行管线」页：滑块同值 + 无续跑块（无账本）
    await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return false;
        const btn = [...modal.querySelector('.w-52').querySelectorAll('button')].find(b => b.textContent.includes('执行管线'));
        if (btn) btn.click();
        return !!btn;
    })()`);
    await new Promise(r => setTimeout(r, 250));
    const pipe = await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return { packVal: null, sameText: false, hasResumeBlock: false };
        const r = [...modal.querySelectorAll('input[type=range]')].find(r => r.offsetParent !== null && r.max === '10');
        return {
            packVal: r ? r.value : null,
            sameText: modal.innerText.includes('3 张/请求'),
            hasResumeBlock: modal.innerText.includes('继续未完成')
        };
    })()`);
    check('⑥b 滑块两处同步（管线页 = 3）', pipe.packVal === '3' && pipe.sameText, `val=${pipe.packVal}`);
    check('⑦ 无账本时不显示续跑入口', pipe.hasResumeBlock === false);

    // ⑦c 增量开关（Q7）：存在 + 可勾选 + 诊断同步
    const inc = await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return { found: false };
        const cb = [...modal.querySelectorAll('input[type=checkbox]')].find(c => {
            const lab = c.closest('label');
            return lab && lab.textContent.includes('跳过已打标卡');
        });
        if (cb && !cb.checked) cb.click();
        return { found: !!cb, checked: cb ? cb.checked : null };
    })()`);
    check('⑦c 增量开关存在且可勾选', !!(inc && inc.found && inc.checked === true), JSON.stringify(inc));
    const diagInc = await evaluate(`(() => {
        const d = window.__jskDiag && window.__jskDiag.aiTag;
        return (d && typeof d.rolePrompts === 'function') ? d.rolePrompts().skipTagged : null;
    })()`);
    check('⑦d 诊断读数 skipTagged = true', diagInc === true);

    // ⑦b 预填充折叠：切回提示词页，点折叠按钮 → 输入框可见
    await evaluate(`(() => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return false;
        const btn = [...modal.querySelector('.w-52').querySelectorAll('button')].find(b => b.textContent.includes('系统提示词'));
        if (btn) btn.click();
        return !!btn;
    })()`);
    await new Promise(r => setTimeout(r, 200));
    const prefillOpen = await evaluate(`(async () => {
        const modal = document.querySelector('.max-w-5xl');
        if (!modal) return { ok: false, err: 'no modal' };
        const foldBtn = [...modal.querySelectorAll('button')].find(b => b.offsetParent !== null && b.textContent.includes('预填充'));
        if (!foldBtn) return { ok: false, err: 'no fold button' };
        foldBtn.click();
        await new Promise(r => setTimeout(r, 200));
        const inp = [...modal.querySelectorAll('input[type=text]')].find(i => i.offsetParent !== null && String(i.placeholder || '').includes('默认：<tags>['));
        return { ok: !!inp };
    })()`);
    check('⑦b 预填充折叠可展开且输入框出现', !!(prefillOpen && prefillOpen.ok), prefillOpen && prefillOpen.err ? String(prefillOpen.err) : '');

    // ⑨ 诊断读数
    const diag = await evaluate(`(() => {
        const d = window.__jskDiag && window.__jskDiag.aiTag;
        if (!d || typeof d.rolePrompts !== 'function') return { ok: false, err: 'no diag' };
        return { ok: true, rp: d.rolePrompts() };
    })()`);
    check('⑨ __jskDiag.aiTag.rolePrompts() 可用', !!(diag && diag.ok), diag && diag.err ? String(diag.err) : '');
    if (diag && diag.ok) {
        info('diag 读数', JSON.stringify(diag.rp));
        check('⑨b diag.packSize = 3', Number(diag.rp && diag.rp.packSize) === 3);
        check('⑨c diag.systemLen > 50', Number(diag.rp && diag.rp.systemLen) > 50);
    }

    // ⑧ 渲染期错误
    const vueErrs = consoleErrors.filter(e => /Vue|Uncaught|Cannot read|is not a function|undefined/.test(e));
    check('⑧ 无渲染期错误', vueErrs.length === 0, vueErrs.slice(0, 3).join(' | '));

    const fail = results.filter(r => !r.ok).length;
    console.log(`\n== 共 ${results.length} 项：PASS ${results.length - fail} / FAIL ${fail} ==`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('探针异常：', e); process.exit(2); });
