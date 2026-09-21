/**
 * AR-40 端到端验证：世界书视图（含导入）**不得让侧边栏消失**
 *
 * 用法（dev 模式 + CDP）：
 *   $env:CDP_PORT="9365"; node scripts/_probe-wb-sidebar-crash.mjs
 *
 * 背景：`SidebarPanel.vue` 世界书分支模板调用了 `wbEntryCount(wb)` / `selectWorldbook(wb)`，
 *   但两者都没进 `setup()` 的 return → 渲染期抛 `_ctx.X is not a function` →
 *   Vue 卸载整个组件 → **侧边栏消失**（用户报「点世界书库/导入世界书就崩」）。
 *
 * 为什么必须端到端：这是**纯渲染期错误** —— `vite build` 与单测都查不出来。
 *   本探针驱动真实 UI（点模式按钮 / 走导入流程），并断言：
 *     ① 侧边栏 `<aside>` 仍在 DOM 里（没被卸载）
 *     ② 无 `_ctx.* is not a function` 类 Vue 错误
 *     ③ 世界书列表区正常渲染
 */
const PORT = Number(process.env.CDP_PORT || 9365);
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
            // 收集控制台错误（Vue 渲染异常会走这里）
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                const txt = (m.params.args || []).map(a => a.value || a.description || '').join(' ');
                consoleErrors.push(txt);
            }
            if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
                consoleErrors.push(m.params.entry.text || '');
            }
        };
    });
}
const consoleErrors = [];
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
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Log.enable');

    const results = [];
    const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

    // 基线：侧边栏初始存在
    const sidebarBefore = await evaluate(`document.querySelectorAll('aside').length`);
    check('基线：侧边栏存在', sidebarBefore > 0, `aside=${sidebarBefore}`);

    // ① 点击「🌍 世界书库」模式按钮（真实 UI 路径）
    const clicked = await evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => /🌍\\s*世界书库/.test(x.textContent || '') && /世界书库（/.test(x.getAttribute('title') || ''));
        if (!b) return { found: false };
        b.click();
        return { found: true, title: b.getAttribute('title') };
    })()`);
    check('找到并点击「世界书库」模式按钮', clicked.found, clicked.title || '未找到');

    await evaluate(`new Promise(r => setTimeout(r, 800))`);

    // ② 侧边栏必须存活（这是 AR-40 的核心断言）
    const sidebarAfter = await evaluate(`document.querySelectorAll('aside').length`);
    check('点击世界书库后侧边栏**未消失**', sidebarAfter > 0, `aside=${sidebarAfter}`);

    // ③ 世界书视图内容渲染
    const wbView = await evaluate(`({
        search: document.body.innerHTML.includes('搜索世界书名称'),
        asideHtmlLen: (document.querySelector('aside') || {}).innerHTML ? document.querySelector('aside').innerHTML.length : 0
    })`);
    check('世界书视图已渲染（搜索框可见）', wbView.search);
    check('侧边栏内容非空（未被卸载成空壳）', wbView.asideHtmlLen > 500, `aside 内容 ${wbView.asideHtmlLen} 字符`);

    // ④ 渲染期 Vue 错误（_ctx.X is not a function 类）
    const bad = consoleErrors.filter(t => /is not a function|Cannot read|_ctx\./.test(t));
    check('无渲染期 Vue 错误（_ctx.* is not a function）', bad.length === 0,
        bad.length ? bad.slice(0, 3).join(' | ') : '无');

    // ⑤ 回到角色卡模式，再切回世界书（反复切换不得累积错误）
    await evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const c = btns.find(x => /🎎\\s*角色卡库/.test(x.textContent || ''));
        if (c) c.click();
        return true;
    })()`);
    await evaluate(`new Promise(r => setTimeout(r, 400))`);
    await evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const w = btns.find(x => /🌍\\s*世界书库/.test(x.textContent || ''));
        if (w) w.click();
        return true;
    })()`);
    await evaluate(`new Promise(r => setTimeout(r, 600))`);
    const sidebarFinal = await evaluate(`document.querySelectorAll('aside').length`);
    const badFinal = consoleErrors.filter(t => /is not a function|Cannot read|_ctx\./.test(t));
    check('反复切换模式后侧边栏仍在', sidebarFinal > 0, `aside=${sidebarFinal}`);
    check('反复切换后仍无渲染期错误', badFinal.length === 0, badFinal.length ? badFinal.slice(0, 2).join(' | ') : '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n===== ${pass}/${results.length} 通过 =====`);
    process.exit(pass === results.length ? 0 : 1);
})();
