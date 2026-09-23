/**
 * Phase 2 检索准确性端到端验证（真实应用实例 + 真实 UI 输入）
 *
 * 用法：dev 模式启动 + CDP：
 *   $env:CDP_PORT="9360"; node scripts/probes/_probe-search-phrase.mjs
 *
 * 做法：向应用的 library 注入两张卡（一张真含「系统」，一张只含「体系 传统」），
 *       通过真实搜索框输入「系统」，检查结果列表。
 *       分别在「索引未就绪」与「索引就绪」两种状态下断言结果一致。
 */
const PORT = Number(process.env.CDP_PORT || 9360);
let sock; let msgId = 0; const pending = new Map();
const logs = [];

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
            if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
            if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
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

const ROOT_FINDER = `
    const all = document.querySelectorAll('#app *');
    let root = null;
    for (const el of all) {
        const c = el.__vueParentComponent;
        if (c && c.setupState && Object.keys(c.setupState).length > 500) { root = c; break; }
    }
`;

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');

    const results = [];
    const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

    // 注入测试卡 + 在「索引未就绪」状态下搜索
    const beforeState = await evaluate(`(async () => {
        ${ROOT_FINDER}
        if (!root) return { ok: false, why: 'no root' };
        const s = root.setupState;
        const lib = s.library && s.library.value ? s.library.value : s.library;
        if (!Array.isArray(lib)) return { ok: false, why: 'library not array' };

        const mk = (name, text) => ({ id: 'probe_'+name, name, path: 'E:/probe/'+name+'.png', fileName: name+'.png',
            customTags: [], data: { name, description: text } });
        lib.length = 0;
        lib.push(mk('诱饵卡', '体系 传统 经典文字'));
        lib.push(mk('真卡', '本系统用于监控'));
        lib.push(mk('无关卡', '完全无关的内容'));

        // 清空索引 → 走内存匹配路径
        try { const m = await import('/js/utils/searchIndex.js'); m.default.clear(); } catch (e) { /* 忽略 */ }

        // 真实操作搜索框（找到搜索 input）
        const input = document.querySelector('input[placeholder*="搜索"], input[type="search"], input[placeholder*="Search"]');
        if (!input) return { ok: false, why: 'no search input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '系统');
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await new Promise(r => setTimeout(r, 600));   // 等防抖

        // 从 UI 真实渲染的卡片列表读取结果（而非直接读 computed）
        const cards = Array.from(document.querySelectorAll('[data-card-name], .card-item, .grid > div')).map(e => e.textContent || '');
        const bodyText = document.body.innerText || '';
        return {
            ok: true,
            inputFound: true,
            inputValue: input.value,
            // 结果判定：以列表区文本是否含卡名来近似（真实 UI 渲染）
            hasReal: bodyText.includes('真卡'),
            hasDecoy: bodyText.includes('诱饵卡'),
            libLen: lib.length
        };
    })()`);
    check('注入测试卡 + 操作真实搜索框（索引未就绪路径）', beforeState && beforeState.ok, JSON.stringify(beforeState).slice(0, 240));
    if (beforeState && beforeState.ok) {
        check('内存路径：「系统」命中真卡', beforeState.hasReal === true);
        check('内存路径：「系统」不命中诱饵卡', beforeState.hasDecoy === false, 'hasDecoy=' + beforeState.hasDecoy);
    }

    // 建索引后（就绪路径）再搜同一词
    const afterState = await evaluate(`(async () => {
        ${ROOT_FINDER}
        if (!root) return { ok: false, why: 'no root' };
        const s = root.setupState;
        const lib = s.library && s.library.value ? s.library.value : s.library;

        // 建索引（就绪）
        let idxInfo = null;
        try {
            const m = await import('/js/utils/searchIndex.js');
            const si = m.default;
            await si.buildAsync(lib, (c) => JSON.stringify(c).toLowerCase(), () => [], 10);
            idxInfo = { cardCount: si.cardCount, building: si.building };
        } catch (e) { return { ok: false, why: 'index build failed: ' + e.message }; }

        // 换词再换回，触发 computed 重算
        const input = document.querySelector('input[placeholder*="搜索"], input[type="search"], input[placeholder*="Search"]');
        if (!input) return { ok: false, why: 'no search input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '监控'); input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        setter.call(input, '系统'); input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));

        const bodyText = document.body.innerText || '';
        return {
            ok: true,
            idxInfo,
            hasReal: bodyText.includes('真卡'),
            hasDecoy: bodyText.includes('诱饵卡')
        };
    })()`);
    check('建索引（就绪路径）', afterState && afterState.ok, JSON.stringify(afterState).slice(0, 240));
    if (afterState && afterState.ok) {
        check('索引路径：「系统」命中真卡', afterState.hasReal === true);
        check('【PK-18 关键】索引路径：「系统」**不**命中「体系 传统」的诱饵卡', afterState.hasDecoy === false, 'hasDecoy=' + afterState.hasDecoy);
        if (beforeState && beforeState.ok) {
            check('两条路径结果一致', beforeState.hasDecoy === afterState.hasDecoy && beforeState.hasReal === afterState.hasReal,
                `before(real=${beforeState.hasReal},decoy=${beforeState.hasDecoy}) after(real=${afterState.hasReal},decoy=${afterState.hasDecoy})`);
        }
    }

    await new Promise(r => setTimeout(r, 500));
    const errs = logs.filter(e => /TypeError|Cannot read/.test(e));
    check('无渲染期 TypeError', errs.length === 0, errs.slice(0, 2).join(' | '));

    const failed = results.filter(r => !r.ok);
    console.log(`\n===== 检索准确性验证：${results.length - failed.length}/${results.length} 通过 =====`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SEARCH PHRASE PROBE FAILED:', e.message); process.exit(1); });
