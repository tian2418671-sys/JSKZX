/**
 * 内置大分类定制 独立 Electron 端到端实测（CDP）
 * 流程：打开 TagCategoryModal → 改名 occupation=职业大组 → 删除(隐藏) personality →
 *       恢复 personality → 清理还原(renames/hidden 置空并落盘) → 最终核验无残留
 * 断言不破坏用户数据：结束时清理还原。
 */
const CDP_HTTP = 'http://127.0.0.1:9222/json/list';
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(CDP_HTTP)).json();
    const page = list.find(t => t.type === 'page' && /localhost:5173/.test(t.url || ''));
    if (!page) throw new Error('未找到 localhost:5173 target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) { return new Promise((res, rej) => { sock = new WebSocket(wsUrl); sock.onopen = res; sock.onerror = rej; sock.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }; }); }
function send(method, params = {}) { const id = ++msgId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result && r.result.value; }

const NAV = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const st = app._instance.setupState;
    // 等应用就绪（库加载 + 新方法可用）
    const dl = Date.now() + 25000;
    while (Date.now() < dl) {
        if (st.library && st.library.length && typeof st.renameBuiltinCategory === 'function') break;
        await wait(500);
    }
    if (!(st.library && st.library.length)) return JSON.stringify({ ok: false, step: 'not-ready', libLen: st.library ? st.library.length : 0 });
    // 激活卡 + 展开常用标签面板 + 打开 🛠️ 分类 弹窗
    try { st.appMode = 'characters'; } catch (e) {}
    if (typeof st.openFromLibrary === 'function') { st.openFromLibrary(st.library[0]); await wait(600); }
    const sysHeader = [...document.querySelectorAll('div')].find(d => d.innerText && d.innerText.includes('系统/常用标签'));
    if (sysHeader) sysHeader.click();
    await wait(400);
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('分类') && (b.textContent || '').includes('🛠️'));
    if (btn) btn.click();
    await wait(600);
    let el = null;
    for (const d of document.querySelectorAll('body > div')) { if (d.innerText && d.innerText.includes('自定义标签大分类')) { el = d; break; } }
    return JSON.stringify({ ok: !!el, modal: !!el, hasBuiltinSection: el ? el.innerText.includes('🧩 内置大分类') : false });
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    const nav = JSON.parse(await evaluate(NAV));
    if (!nav.ok) { console.log(JSON.stringify(nav)); process.exit(1); }
    const out = { nav };

    // 1) 改名 occupation → 职业大组
    out.rename = JSON.parse(await evaluate(`(async () => {
        const st = document.querySelector('#app').__vue_app__._instance.setupState;
        const ok = st.renameBuiltinCategory('occupation', '职业大组');
        await new Promise(r => setTimeout(r, 300));
        const ren = { ...(st.builtinCatRenames || {}) };
        const modal = [...document.querySelectorAll('body > div')].find(d => d.innerText && d.innerText.includes('自定义标签大分类'));
        return JSON.stringify({ ok, renamed: ren.occupation, domShows: modal ? modal.innerText.includes('职业大组') : false, domShowsOld: modal ? modal.innerText.includes('身份职业') : false });
    })()`));

    // 2) 删除(隐藏) personality（monkeypatch confirmDialog 自动确认）
    out.hide = JSON.parse(await evaluate(`(async () => {
        const st = document.querySelector('#app').__vue_app__._instance.setupState;
        const orig = st.confirmDialog;
        st.confirmDialog = async () => true;
        const ok = await st.hideBuiltinCategory('personality');
        await new Promise(r => setTimeout(r, 300));
        const hid = { ...(st.builtinCatHidden || {}) };
        const modal = [...document.querySelectorAll('body > div')].find(d => d.innerText && d.innerText.includes('自定义标签大分类'));
        const t = modal ? modal.innerText : '';
        return JSON.stringify({ ok, hidden: hid.personality === true, domHiddenSection: t.includes('已删除'), domHas性格: t.includes('性格特质') });
    })()`));

    // 3) 恢复 personality
    out.restore = JSON.parse(await evaluate(`(async () => {
        const st = document.querySelector('#app').__vue_app__._instance.setupState;
        const ok = st.restoreBuiltinCategory('personality');
        await new Promise(r => setTimeout(r, 300));
        const hid = { ...(st.builtinCatHidden || {}) };
        const modal = [...document.querySelectorAll('body > div')].find(d => d.innerText && d.innerText.includes('自定义标签大分类'));
        const t = modal ? modal.innerText : '';
        return JSON.stringify({ ok, hiddenEmpty: Object.keys(hid).length === 0, domHas性格: t.includes('性格特质') });
    })()`));

    // 4) 清理还原：清空 renames/hidden 并落盘（不污染用户数据）
    out.cleanup = JSON.parse(await evaluate(`(async () => {
        const st = document.querySelector('#app').__vue_app__._instance.setupState;
        st.builtinCatRenames = {};
        st.builtinCatHidden = {};
        await new Promise(r => setTimeout(r, 200));
        if (typeof st.syncConfigToDisk === 'function') await st.syncConfigToDisk();
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ renames: Object.keys(st.builtinCatRenames || {}).length, hidden: Object.keys(st.builtinCatHidden || {}).length });
    })()`));

    console.log(JSON.stringify(out, null, 2));
    sock.close();
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1); });
