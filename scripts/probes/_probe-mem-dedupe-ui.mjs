/**
 * 🧪 记忆库编辑 + 查重综合分排序 —— 端到端验证（2026-09-24）
 *
 * 用法（**dev 模式** + CDP）：
 *   npm run dev                       # 终端 1
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   node_modules\electron\dist\electron.exe . --remote-debugging-port=9376 --user-data-dir=%TEMP%\jsk-pd3   # 终端 2
 *   $env:CDP_PORT="9376"; node scripts/probes/_probe-mem-dedupe-ui.mjs   # 终端 3
 *
 * 背景：本轮补完两个「算了不用 / 有 API 无 UI」的缺口：
 *   · 记忆库：查看/删除已有，**缺编辑**（`updateMemory` 早已就绪）→ 补逐条编辑
 *   · 查重：`_score` 算出来却**从未被消费**（不排序、不显示）→ 补排序 + 展示
 *
 * 断言：
 *   【记忆编辑】
 *   ① 记忆列表可渲染出条目（无条目时跳过并说明）
 *   ② 每条有 ✏ 编辑按钮
 *   ③ 点 ✏ → 进入编辑态（出现 textarea + 保存/取消）
 *   ④ fact 类型额外有 key 输入框；message/summary 没有
 *   ⑤ 编辑态下 ✏/🗑 被禁用（防并发写）
 *   ⑥ 清空内容 → 保存按钮禁用（内容不能为空）
 *   ⑦ 取消 → 回到查看态且**内容未变**（草稿被丢弃）
 *   ⑧ 保存 → 内容真的写进存储（重新拉列表核对）
 *   【查重排序】
 *   ⑨ 纯函数 `sortByCompositeScore` 三级回退正确（在页面内直接调）
 *   ⑩ 排序不修改入参数组
 *
 * ⚠️ 状态读写一律走 `window.__jskDiag.*`（项目约定，见 AI交接指导.md）。
 * 🛑 **记忆库在「测卡 Tab 的右侧栏」里，不在 AI 打标弹窗里** ——
 *    初版探针用 `aiTag.open()`（打开的是 AI 打标弹窗）→ 找不到记忆库、
 *    而且 `includes('设置')` 命中了弹窗的「API 引擎**设置**」分区 → 6 条假失败。
 *    正解：`__jskDiag.chat.open()` 切到测卡 Tab，再在侧栏里点「设置」。
 */
const PORT = Number(process.env.CDP_PORT || 9376);
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
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);
const sleep = (ms) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);

/** 测卡侧栏根节点（`bg-zinc-950 border-l` 的展开态抽屉）
 *  ⚠️ 不能用弹窗那套 `fixed inset-0` 判据 —— 侧栏是**普通流式布局**（右侧抽屉），不是弹窗。
 *  📌 判据：`border-l` + 内含「⚙ 测卡工作区」标题 + 有尺寸。 */
const SIDEBAR_ROOT = `([...document.querySelectorAll('div')].find(d => {
    const c = typeof d.className === 'string' ? d.className : '';
    if (!/border-l/.test(c) || !/flex-col/.test(c)) return false;
    if (!(d.textContent || '').includes('测卡工作区')) return false;
    const r = d.getBoundingClientRect();
    return r.width > 100 && r.height > 100;
}) || null)`;

/** 记忆**行**选择器（精确定位到行，不是外层容器）
 *  ⚠️ **踩过的坑**：用 `[...divs].find(d => d.textContent.includes('探针原始内容'))`
 *     会返回**最外层祖先**（`find` 按文档顺序，容器先于行）⇒ 在其上调
 *     `querySelector('button')` 拿到的是**第一行**的 ✏，点下去编辑的是**别的条目**
 *     （只注入 1 条时碰巧对，注入 2 条立刻暴露）。
 *  ✅ 正解：用行的真实 class 特征（`border-b` + `group`）定位。
 *  @param {string} text 行内应包含的文案 */
const memRow = (text) => `([...document.querySelectorAll('div')].find(d => {
    const c = typeof d.className === 'string' ? d.className : '';
    if (!/border-b/.test(c) || !/group/.test(c)) return false;
    return (d.textContent || '').includes(${JSON.stringify(text)});
}) || null)`;

/** 记忆**编辑**框（用 placeholder 精确定位）
 *  ⚠️ 不能取「第一个可见 textarea」—— 侧栏里有多个 textarea，取错就会「改了别的框，草稿没变」（踩过）。 */
const MEM_EDIT_TA = `([...document.querySelectorAll('textarea')].find(t =>
    (t.getAttribute('placeholder') || '').includes('记忆内容') && t.getBoundingClientRect().width > 0) || null)`;

/** 在侧栏内点「分区 tab」
 *  ⚠️ 两个坑（初版踩到 → 「设置」找不到）：
 *    1. 分区 tab 是 **`<div>`**（自绘 tab 栏），**不是 `<button>`**；
 *    2. 标签带图标前缀（`⚙ 设置`）⇒ 用 `endsWith` 而不是 `===`。 */
const clickSidebarTab = (label) => `(() => {
    const root = ${SIDEBAR_ROOT};
    if (!root) return 'no-sidebar';
    const t = [...root.querySelectorAll('div')].find(x => {
        const s = (x.textContent || '').trim();
        return s.endsWith(${JSON.stringify(label)}) && s.length <= ${JSON.stringify(label)}.length + 3;
    });
    if (!t) return 'not-found';
    t.click();
    return 'clicked';
})()`;

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP');

    // ═══════════════════════════════════════════════════════════
    // ⑨⑩ 查重排序纯函数（页面内直接调，不需 UI）
    // ═══════════════════════════════════════════════════════════
    const sortTest = await evaluate(`(async () => {
        const m = await import('/js/utils/similarityType.js');
        const f = m.sortByCompositeScore;
        if (typeof f !== 'function') return { err: 'no sortByCompositeScore' };
        const items = [{ n:'c', _score:0.4 }, { n:'a', _score:0.95 }, { n:'b', _score:0.7 }];
        const out = f(items);
        const order = out.map(x => x.n).join(',');
        const unchanged = items.map(x => x.n).join(',') === 'c,a,b';
        const isNew = out !== items;
        // 三级回退
        const fb = f([
            { n:'x', _score:0.8, _simPct:50, textLen:9999 },
            { n:'y', _score:0.8, _simPct:90, textLen:10 },
            { n:'z', _score:0.8, _simPct:90, textLen:500 }
        ]).map(x => x.n).join(',');
        // null 排最后
        const nl = f([{ n:'null', _score:null }, { n:'good', _score:0.3 }])[0].n;
        return { order, unchanged, isNew, fb, nl, empty: JSON.stringify(f(null)) };
    })()`);
    check('排序：_score 降序正确', sortTest.order === 'a,b,c', `order=${sortTest.order}`);
    check('排序：三级回退（_simPct → textLen）', sortTest.fb === 'z,y,x', `fb=${sortTest.fb}`);
    check('排序：_score=null 排最后', sortTest.nl === 'good', `first=${sortTest.nl}`);
    check('★ 契约：返回新数组且不改入参', sortTest.isNew === true && sortTest.unchanged === true,
        `isNew=${sortTest.isNew} unchanged=${sortTest.unchanged}`);
    check('排序：非数组安全返回空数组', sortTest.empty === '[]', sortTest.empty);

    // ═══════════════════════════════════════════════════════════
    // 记忆编辑（需要测卡侧栏 UI）
    // ═══════════════════════════════════════════════════════════
    const hasDiag = await evaluate(`!!(window.__jskDiag && window.__jskDiag.chat)`);
    if (!hasDiag) { console.log('\n⚠️ 无 __jskDiag.chat（需 dev 模式）→ 跳过记忆编辑 UI 断言'); }

    // 先注入**两条**测试记忆（隔离 profile，安全）——
    //  ⚠️ 必须两条：「编辑态下其他行的 ✏ 被禁用」需要一个**别的行**才能验（初版只注入一条 → 该断言空转）
    const seeded = await evaluate(`(async () => {
        const m = await import('/js/composables/chat/useChatMemory.js');
        await m.recordFact('探针键', '探针原始内容', { path: '__probe__', name: '探针卡' });
        await m.recordFact('探针键2', '探针另一条内容', { path: '__probe__', name: '探针卡' });
        await new Promise(r => setTimeout(r, 400));
        const list = await m.listMemory('', 100, '');
        return { total: list.length, probe: list.filter(x => String(x.content || '').includes('探针')).length };
    })()`);
    check('可注入测试记忆（隔离 profile）', seeded.probe >= 2, `库内 ${seeded.total} 条 / 探针 ${seeded.probe} 条`);

    const chatReady = await evaluate(`(async () => {
        const d = window.__jskDiag;
        if (!d || !d.chat || typeof d.chat.openCard !== 'function') return { err: 'no chat.openCard' };
        const lib = d.lib();
        if (!lib.length) return { err: '库为空' };
        d.select(1);
        // ⚠️ 侧栏只在「有卡打开 + 测卡 Tab」时渲染 ⇒ 必须先打开卡
        const ok = await d.chat.openCard(1);
        if (!ok) return { err: 'openCard 失败' };
        await new Promise(r => setTimeout(r, 1200));
        d.chat.open();                       // 切到测卡 Tab
        await new Promise(r => setTimeout(r, 2000));
        return { ok: true, tab: d.chat.tab(), cardName: d.chat.cardName(), sidebar: !!${SIDEBAR_ROOT} };
    })()`);
    if (!chatReady.ok) {
        console.log(`\n⚠️ 无法进入测卡 Tab（${chatReady.err}）→ 跳过记忆编辑 UI 断言`);
    } else {
        info('已切到测卡 Tab', `tab=${chatReady.tab} 卡=${chatReady.cardName} 侧栏可见=${chatReady.sidebar}`);

        // 侧栏若处于折叠态 → 点「⚙ 测卡工作区」拉手展开
        if (!chatReady.sidebar) {
            const expanded = await evaluate(`(async () => {
                const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('测卡工作区') && x.offsetHeight > 0);
                if (b) b.click();
                await new Promise(r => setTimeout(r, 700));
                return !!${SIDEBAR_ROOT};
            })()`);
            info('展开侧栏', String(expanded));
        }

        // 切到「设置」分区（记忆库在那儿）—— ⚠️ 限定在侧栏内，避免命中别处的「设置」
        const toSettings = await evaluate(clickSidebarTab('设置'));
        info('侧栏内切到设置分区', toSettings);
        await sleep(900);

        // 切到「全部」以便看到刚注入的（这一步同时验证 watch(memViewMode) 修复）
        const refreshed = await evaluate(`(async () => {
            const root = ${SIDEBAR_ROOT};
            if (!root) return { err: 'no-sidebar' };
            const b = [...root.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '全部');
            if (b) b.click();
            await new Promise(r => setTimeout(r, 1000));   // watch(memViewMode) → refreshMemItems
            const r2 = ${SIDEBAR_ROOT} || root;
            const editBtns = [...r2.querySelectorAll('button')].filter(x => (x.textContent || '').includes('✏'));
            const hasProbeRow = (r2.textContent || '').includes('探针原始内容');
            const emptyHint = (r2.textContent || '').includes('记忆库为空');
            return { editBtnCount: editBtns.length, hasProbeRow, emptyHint };
        })()`);
        check('① 记忆列表渲染出条目', refreshed.hasProbeRow === true,
            `探针条目可见=${refreshed.hasProbeRow} 显示「记忆库为空」=${refreshed.emptyHint}`);
        check('② 每条有 ✏ 编辑按钮', refreshed.editBtnCount >= 1, `✏ 按钮 ${refreshed.editBtnCount} 个`);

        // 点编辑
        const entered = await evaluate(`(async () => {
            const root = ${SIDEBAR_ROOT};
            if (!root) return { err: 'no-sidebar' };
            const row = ${memRow('探针原始内容')};
            const btn = row ? [...row.querySelectorAll('button')].find(x => (x.textContent || '').includes('✏')) : null;
            if (!btn) return { err: 'no-edit-btn', hasRow: !!row };
            btn.click();
            await new Promise(r => setTimeout(r, 500));
            const r2 = ${SIDEBAR_ROOT} || root;
            const ta = r2 ? [...r2.querySelectorAll('textarea')].filter(t => t.getBoundingClientRect().width > 0) : [];
            const editTa = ${MEM_EDIT_TA};
            const inputs = [...r2.querySelectorAll('input[type=text]')].filter(t => t.getBoundingClientRect().width > 0);
            const saveBtn = [...r2.querySelectorAll('button')].find(x => (x.textContent || '').includes('保存'));
            const cancelBtn = [...r2.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '取消');
            // ⑤ 编辑态下**其他行**的 ✏ 应被禁用（编辑行本身不渲染 ✏ —— v-if/v-else 互斥）
            const otherEditBtns = [...r2.querySelectorAll('button')].filter(x => (x.textContent || '').includes('✏'));
            return {
                textareaCount: ta.length,
                hasEditTa: !!editTa,
                editTaValue: editTa ? editTa.value : '',
                keyInputCount: inputs.length,
                hasSave: !!saveBtn,
                hasCancel: !!cancelBtn,
                otherEditBtnCount: otherEditBtns.length,
                otherEditBtnsDisabled: otherEditBtns.filter(b => b.disabled).length
            };
        })()`);
        check('③ 点 ✏ 进入编辑态（textarea + 保存/取消）',
            entered.hasEditTa === true && entered.hasSave === true && entered.hasCancel === true,
            `编辑框=${entered.hasEditTa} save=${entered.hasSave} cancel=${entered.hasCancel} err=${entered.err || '-'}`);
        check('④ fact 类型额外有 key 输入框', entered.keyInputCount >= 1, `text input ${entered.keyInputCount} 个`);
        check('⑤ 编辑态下**其他行**的 ✏ 被禁用（防并发写）',
            entered.otherEditBtnCount >= 1 && entered.otherEditBtnsDisabled === entered.otherEditBtnCount,
            `其他行 ✏ ${entered.otherEditBtnCount} 个 / 其中禁用 ${entered.otherEditBtnsDisabled} 个`);
        // 清空内容 → 保存应禁用（用 placeholder 精确定位编辑框）
        const cleared = await evaluate(`(async () => {
            const ta = ${MEM_EDIT_TA};
            if (!ta) return { err: 'no-edit-textarea' };
            ta.value = '';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
            const root = ${SIDEBAR_ROOT};
            const saveBtn = root ? [...root.querySelectorAll('button')].find(x => (x.textContent || '').includes('保存')) : null;
            return { saveDisabled: saveBtn ? saveBtn.disabled : null };
        })()`);
        check('⑥ 清空内容 → 保存按钮禁用（内容不能为空）', cleared.saveDisabled === true,
            `disabled=${cleared.saveDisabled} err=${cleared.err || '-'}`);

        // 取消 → 内容未变
        const cancelled = await evaluate(`(async () => {
            const root = ${SIDEBAR_ROOT};
            if (!root) return { err: 'no-sidebar' };
            const btn = [...root.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '取消');
            if (btn) btn.click();
            await new Promise(r => setTimeout(r, 700));
            const m = await import('/js/composables/chat/useChatMemory.js');
            const list = await m.listMemory('', 100, '');
            const probe = list.find(x => x.key === '探针键');
            const stillTa = ${MEM_EDIT_TA};
            return { content: probe ? probe.content : '(缺失)', stillEditing: !!stillTa };
        })()`);
        check('⑦ 取消 → 内容未变（草稿被丢弃）', cancelled.content === '探针原始内容',
            `content=${cancelled.content} 仍在编辑=${cancelled.stillEditing}`);

        // 编辑并保存（用 placeholder 精确定位编辑框）
        const saved = await evaluate(`(async () => {
            const root = ${SIDEBAR_ROOT};
            if (!root) return { err: 'no-sidebar' };
            const row = ${memRow('探针原始内容')};
            const editBtn = row ? [...row.querySelectorAll('button')].find(x => (x.textContent || '').includes('✏')) : null;
            if (!editBtn) return { err: 'no-edit-btn', hasRow: !!row };
            editBtn.click();
            await new Promise(r => setTimeout(r, 500));
            const ta = ${MEM_EDIT_TA};
            if (!ta) return { err: 'no-edit-textarea' };
            // 🛡️ 必须确认打开的是**正确那条**（防止又点到别的行）
            const openedWith = ta.value;
            ta.value = '探针已编辑内容';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
            const r2 = ${SIDEBAR_ROOT} || root;
            const saveBtn = [...r2.querySelectorAll('button')].find(x => (x.textContent || '').includes('保存'));
            if (!saveBtn) return { err: 'no-save' };
            if (saveBtn.disabled) return { err: 'save-disabled' };
            saveBtn.click();
            await new Promise(r => setTimeout(r, 1200));
            const m = await import('/js/composables/chat/useChatMemory.js');
            const list = await m.listMemory('', 100, '');
            const probe = list.find(x => x.key === '探针键');
            return { content: probe ? probe.content : '(缺失)', openedWith };
        })()`);
        check('⑧ 保存 → 内容真的写进存储', saved.content === '探针已编辑内容',
            `content=${saved.content} 打开时内容=${saved.openedWith || '-'} err=${saved.err || '-'}`);

        // 清理探针记忆（不留垃圾）
        const cleaned = await evaluate(`(async () => {
            const m = await import('/js/composables/chat/useChatMemory.js');
            const list = await m.listMemory('', 200, '');
            let n = 0;
            for (const it of list) {
                if (String(it.key || '').includes('探针') || String(it.content || '').includes('探针')) {
                    const r = await m.removeMemory(it.id); if (r && r.success) n++;
                }
            }
            const after = await m.listMemory('', 200, '');
            return { removed: n, left: after.filter(x => String(x.content || '').includes('探针')).length };
        })()`);
        check('⑨ 清理干净（不留探针垃圾）', cleaned.left === 0, `删了 ${cleaned.removed} 条 / 剩余 ${cleaned.left} 条`);
    }

    const realErrors = consoleErrors.filter(e => !/favicon|DevTools|Autofill|net::ERR/i.test(e));
    check('无渲染期 console error', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '干净');

    const failed = results.filter(r => !r.ok);
    console.log(`\n════════ 结果：通过 ${results.length - failed.length} / 失败 ${failed.length} ════════`);
    if (failed.length) console.log('失败项：\n' + failed.map(f => '  - ' + f.n).join('\n'));
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('探针异常：', e.message); process.exit(1); });
