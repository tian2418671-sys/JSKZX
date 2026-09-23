/**
 * AI 归类「自动建类」UI 冒烟（Electron CDP）：打开分类弹窗 → 伪造 isNew 建议 →
 * 验证「🆕 新建」徽标与「🆕 将自动新建」optgroup 渲染 → 关闭弹窗不残留。
 */
const CDP_HTTP = 'http://127.0.0.1:9222/json/list';
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(CDP_HTTP)).json();
    const page = list.find(t => t.type === 'page' && /localhost:5173/.test(t.url || ''));
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) { return new Promise((res, rej) => { sock = new WebSocket(wsUrl); sock.onopen = res; sock.onerror = rej; sock.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }; }); }
function send(method, params = {}) { const id = ++msgId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result && r.result.value; }

const EXPR = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const st = app._instance.setupState;
    const diag = () => ({
        appMode: st.appMode || '(?)',
        hasCard: !!(st.cardData),
        cardName: (st.safeData && st.safeData.name) || (st.cardData && st.cardData.name) || null,
        libLen: (st.library && st.library.length) || 0
    });
    // 1. 强制切到角色卡模式并激活一张卡
    try { st.appMode = 'characters'; } catch (e) {}
    if (st.library && st.library.length && typeof st.openFromLibrary === 'function') {
        st.openFromLibrary(st.library[0]);
        await wait(600);
    }
    // 2. 展开「系统/常用标签」面板
    const sysHeader = [...document.querySelectorAll('div')].find(d => d.innerText && d.innerText.includes('系统/常用标签'));
    if (sysHeader) sysHeader.click();
    await wait(400);
    // 3. 点击 🛠️ 分类 打开 TagCategoryModal
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('分类') && (b.textContent || '').includes('🛠️'));
    if (btn) btn.click();
    await wait(600);
    // 4. 定位弹窗（Teleport 到 body；含 'AI 归类' 文案）
    let el = null;
    for (const d of document.querySelectorAll('body > div')) { if (d.innerText && d.innerText.includes('AI 归类')) { el = d; break; } }
    if (!el) return JSON.stringify(Object.assign({ ok: false, step: 'modal-not-found', hasBtn: !!btn, sysHeader: !!sysHeader }, diag()));
    // 向上找包含 aiSuggestions data 的组件 proxy
    let node = el, proxy = null;
    while (node && !proxy) { const pc = node.__vueParentComponent; if (pc && pc.proxy && ('aiSuggestions' in pc.proxy)) proxy = pc.proxy; node = node.parentElement; }
    if (!proxy) return JSON.stringify({ ok: false, step: 'proxy-not-found' });
    proxy.aiSuggestions = [
        { tag: '哥特风', cat: '哥特', isNew: true },
        { tag: '原神', cat: 'other', isNew: false },
        { tag: '魔法', cat: 'worldview', isNew: false }
    ];
    proxy.viewMode = 'ai';
    await wait(300);
    const text = el.innerText || '';
    const optVals = [...el.querySelectorAll('select option')].map(o => o.value);
    const result = {
        ok: true,
        hasNewBadge: text.includes('🆕 新建'),
        hasNewOptgroup: text.includes('🆕 将自动新建'),
        optHasNewName: optVals.includes('哥特'),
        newCats: proxy.suggestedNewCats || []
    };
    // 清理：恢复手动视图 + 清空建议 + 关闭弹窗
    proxy.viewMode = 'manual';
    proxy.aiSuggestions = [];
    const closeBtn = [...el.querySelectorAll('button')].find(b => /✕|×|关闭|取消/.test(b.textContent || ''));
    if (closeBtn) closeBtn.click();
    return JSON.stringify(result);
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    const r = await evaluate(EXPR);
    console.log(r);
    sock.close();
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1); });
