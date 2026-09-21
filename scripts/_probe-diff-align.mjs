/**
 * AR-39 / DF-17 UI 级冒烟：真实打开「查看词条差异」弹窗（不是模拟条件）
 *
 * 用法：$env:CDP_PORT="9355"; node scripts/_smoke-ar39-ui.mjs
 *
 * 做法：通过 CDP 注入两本测试世界书到 Vue 应用状态（借道 __VUE_APP__ / 组件实例），
 *       再真实触发 openDiffDetailModal，检查弹窗 DOM 是否渲染出词条级对齐。
 */
const PORT = Number(process.env.CDP_PORT || 9355);
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

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');

    const results = [];
    const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

    // 1. 找到根组件实例（沿 DOM 找 __vueParentComponent，取 setupState 键最多的那个）
    const found = await evaluate(`(() => {
        const all = document.querySelectorAll('#app *');
        let root = null;
        for (const el of all) {
            const c = el.__vueParentComponent;
            if (c && c.setupState && Object.keys(c.setupState).length > 500) { root = c; break; }
        }
        if (!root) return { ok: false, why: 'no root component (需 dev 模式)' };
        const s = root.setupState;
        return {
            ok: true,
            hasOpenDiff: typeof s.openDiffDetailModal === 'function',
            setupKeys: Object.keys(s).length
        };
    })()`);
    check('定位根组件（dev 模式）', found && found.ok, JSON.stringify(found));
    if (!found || !found.ok || !found.hasOpenDiff) {
        console.log('\n无法定位组件，退出。');
        process.exit(1);
    }

    // 2. 注入两本词条数不同的世界书 + 真实调用 openDiffDetailModal
    const injected = await evaluate(`(async () => {
        const all = document.querySelectorAll('#app *');
        let root = null;
        for (const el of all) {
            const c = el.__vueParentComponent;
            if (c && c.setupState && Object.keys(c.setupState).length > 500) { root = c; break; }
        }
        const s = root.setupState;
        const mk = (c, t) => ({ uid: 'u_' + Math.random().toString(36).slice(2,8), comment: c, content: t, key: [c], keysecondary: [] });
        const A = { path: 'C:\\\\t\\\\A.json', name: 'A.json', data: { name: '测试书A', entries: [mk('甲','正文甲'), mk('乙','正文乙'), mk('丙','正文丙')] } };
        const B = { path: 'C:\\\\t\\\\B.json', name: 'B.json', data: { name: '测试书B', entries: [mk('甲','正文甲'), mk('乙','正文乙'), mk('丁','正文丁'), mk('戊','正文戊'), mk('己','正文己')] } };
        try {
            s.openDiffDetailModal(A, B);
        } catch (e) {
            return { ok: false, threw: String((e && e.message) || e) };
        }
        await new Promise(r => setTimeout(r, 700));
        const fields = s.diffFieldResults.value || s.diffFieldResults;
        const labels = (fields || []).map(f => f.label);
        const align = (fields || []).find(f => f.isEntryPairs);
        return {
            ok: true,
            show: s.showDiffDetailModal.value ?? s.showDiffDetailModal,
            labels,
            hasAlign: !!align,
            pairsLen: align ? align.pairs.length : 0,
            onlyA: align ? align.pairs.filter(p => p.side === 'only-a').length : -1,
            onlyB: align ? align.pairs.filter(p => p.side === 'only-b').length : -1,
            both: align ? align.pairs.filter(p => p.side === 'both').length : -1
        };
    })()`);
    check('真实调用 openDiffDetailModal 未抛错', injected && injected.ok, JSON.stringify(injected).slice(0, 300));
    if (injected && injected.ok) {
        check('弹窗已打开', injected.show === true, String(injected.show));
        check('存在「🧩 词条级对齐」字段', injected.hasAlign === true);
        check('only-a = 1（缺失「丙」）', injected.onlyA === 1, String(injected.onlyA));
        check('only-b = 3（新增丁/戊/己）', injected.onlyB === 3, String(injected.onlyB));
        check('both = 2（甲/乙配对）', injected.both === 2, String(injected.both));
        check('词条总数行带 hint（不留白）', injected.labels.includes('📚 世界书词条总数 (Entries Count)'), injected.labels.join(' / '));
    }

    // 3. 弹窗 DOM 真实渲染检查
    await new Promise(r => setTimeout(r, 500));
    const dom = await evaluate(`(() => {
        const modal = document.body.innerText || '';
        return {
            hasTitle: modal.includes('数据版本差异深度比对'),
            hasAlign: modal.includes('词条级对齐'),
            hasAdded: modal.includes('[新增]'),
            hasMissing: modal.includes('[缺失]'),
            hasNoEntry: modal.includes('本端无此词条'),
            hasPlaceholder: modal.includes('逐条增删见') || modal.includes('词条数不同'),
            bodyLen: modal.length
        };
    })()`);
    check('弹窗 DOM 含标题', dom.hasTitle);
    check('DOM 渲染出「词条级对齐」', dom.hasAlign);
    check('DOM 出现绿色 [新增] 占位', dom.hasAdded);
    check('DOM 出现红色 [缺失] 占位', dom.hasMissing);
    check('DOM 出现「本端无此词条」', dom.hasNoEntry);
    check('DOM 词条总数行有占位文案', dom.hasPlaceholder, 'bodyLen=' + dom.bodyLen);

    // 4. 无渲染期错误
    const errs = logs.filter(e => /TypeError|masterLines|Cannot read|Vue warn.*Unhandled/.test(e));
    check('无渲染期 TypeError / [Vue 错误]', errs.length === 0, errs.slice(0, 2).join(' | '));

    const failed = results.filter(r => !r.ok);
    console.log(`\n===== UI 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('UI SMOKE FAILED:', e.message); process.exit(1); });
