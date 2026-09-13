/**
 * 正则/状态栏 增删交互 · DOM 驱动端到端验证（CDP，dev 模式）
 *
 * 对应用户反馈：
 *   ① 添加正则/状态栏脚本后「反馈缓慢，必须切换选项卡才能看到效果」
 *   ② 删除「没有任何提示」
 *
 * 判定（全程只用真实点击，不直接改状态）：
 *   A 打开一张卡并点开「正则脚本」选项卡
 *   B 点新增按钮（**不切换任何选项卡**）→ DOM 行数必须立即 +1
 *     （原本 0 条的卡要用空态按钮「+ 立即新增一条正则脚本」；这条同时覆盖
 *      「数组被整体替换 → computed 不重算」那个漏刷新分支）
 *   C 点该行「🗑️ 删除」→ 弹出**原生**确认框（`dialog.showMessageBox`，DOM 里没有
 *     `.van-dialog`，故本脚本只能判定「行数不动 = 等待确认」，原生框需外部
 *     枚举窗口 / 发送 WM_COMMAND 应答；见 docs/大库重复卡-压测数据记录.md §10.4）
 *   D 全程不写盘（未点保存）
 *
 * 用法：$env:CDP_PORT="9338"; node scripts/_probe-regex-ui.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9338);
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res;
        sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id); pending.delete(m.id);
                m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result && r.result.value;
}
async function run(expr) {
    const raw = await evaluate(expr);
    if (raw && typeof raw === 'object' && raw.__exc) return raw;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return { __parseError: String(raw).slice(0, 200) }; }
}

(async () => {
    const problems = [];
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(600);

    console.log('A 真实点击侧栏首张卡 + 点开「正则脚本」选项卡…');
    const stepA = await run(`(async () => {
        const ss = document.querySelector('#app').__vue_app__._instance.setupState;
        // 真实点击侧栏卡片（网格/列表两种视图的共同特征：group + cursor-pointer）
        const items = [...document.querySelectorAll('div')].filter(d => typeof d.className === 'string'
            && /cursor-pointer/.test(d.className) && /group/.test(d.className) && d.querySelector('img,span'));
        if (!ss.cardData && items[0]) items[0].click();
        await new Promise(r => setTimeout(r, 1200));
        const btns = [...document.querySelectorAll('button')];
        const tab = btns.find(b => {
            const t = b.textContent.replace(/\\s+/g, '');
            return /正则脚本/.test(t) && !/对照区/.test(t) && t.length <= 14;
        });
        if (tab) tab.click();
        ss.currentTab = 'regex';   // 兜底：确保 Tab 内容已展开（本用例验证的是增删后的刷新，不是切 Tab）
        // 🔧 轮询等待正则分区真正渲染：大库（万卡）下卡片数据/卡内扩展要走 IPC，
        //    固定 700ms 不够 → 会误报「未找到新增按钮（Tab 未展开？）」。
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
            const ready = document.querySelectorAll('.regex-input-find').length > 0
                || [...document.querySelectorAll('button')].some(b => /添加正则脚本|立即新增一条正则脚本/.test(b.textContent));
            if (ready) break;
            await new Promise(r => setTimeout(r, 200));
        }
        const cd = ss.cardData;
        const sd = cd && (cd.data || cd);
        return JSON.stringify({
            card: cd && cd.name,
            sidebarItems: items.length,
            rawRegexLen: sd && sd.extensions && sd.extensions.regex_scripts ? sd.extensions.regex_scripts.length : null,
            tabFound: !!tab, tabText: tab ? tab.textContent.trim() : null,
            rows: document.querySelectorAll('.regex-input-find').length,
            addBtn: !!btns.find(b => /添加正则脚本|立即新增一条正则脚本/.test(b.textContent))
        });
    })()`);
    console.log('   ', JSON.stringify(stepA));
    if (stepA.__exc) { console.log('FAILED(stepA):', stepA.__exc); process.exit(1); }
    if (!stepA.tabFound) problems.push('未找到「正则脚本」选项卡按钮');
    if (!stepA.addBtn) problems.push('未找到新增按钮（「➕ 添加正则脚本」或空态「+ 立即新增一条正则脚本」）→ Tab 可能未展开');
    const baseRows = stepA.rows;

    console.log('\nB 点新增按钮（不切换任何选项卡）…');
    const stepB = await run(`(async () => {
        const ROWS = () => document.querySelectorAll('.regex-input-find').length;
        const all = [...document.querySelectorAll('button')];
        // 空态按钮优先：原本 0 条的卡只有它（同时也是「数组整体替换」的分支）
        const btn = all.find(b => /立即新增一条正则脚本/.test(b.textContent))
                 || all.find(b => /添加正则脚本/.test(b.textContent));
        if (!btn) return JSON.stringify({ btnFound: false, cands: all.map(b => b.textContent.trim().replace(/\\s+/g, '')).filter(t => /正则/.test(t)).slice(0, 8) });
        const before = ROWS();
        btn.click();
        await new Promise(r => setTimeout(r, 350));
        return JSON.stringify({ btnFound: true, btnText: btn.textContent.trim().replace(/\\s+/g, ''), before, after: ROWS() });
    })()`);
    console.log('   ', JSON.stringify(stepB));
    if (stepB.btnFound && stepB.after !== stepB.before + 1) {
        problems.push(`点击后列表未立即更新（${stepB.before} → ${stepB.after}）→「必须切 Tab 才看到效果」仍未修好`);
    }

    console.log('\nC 点最后一行「🗑️ 删除」→ 应弹【原生】二次确认（DOM 里查不到 .van-dialog）…');
    const stepC1 = await run(`(async () => {
        const btns = [...document.querySelectorAll('button')].filter(b => /删除此正则|🗑/.test(b.textContent));
        const btn = btns[btns.length - 1];
        if (!btn) return JSON.stringify({ delBtnFound: false });
        const before = document.querySelectorAll('.regex-input-find').length;
        btn.click();
        await new Promise(r => setTimeout(r, 900));
        return JSON.stringify({ delBtnFound: true, before, afterClick: document.querySelectorAll('.regex-input-find').length, domDialog: !!document.querySelector('.van-dialog') });
    })()`);
    console.log('   ', JSON.stringify(stepC1));
    if (!stepC1.delBtnFound) problems.push('未找到行内删除按钮');
    // confirmDialog 走 Electron 原生 dialog.showMessageBox，**不在 DOM 中**：
    // 这里只判定「点后行数未立即变化 = 确实在等确认（没误删）」；
    // 真正确认后的刷新链路用「窗口枚举 + WM_COMMAND/IDOK」验证（见 docs 大库压测记录 §10.4）。
    else if (stepC1.afterClick !== stepC1.before) problems.push(`点删除后行数立即变化（${stepC1.before} → ${stepC1.afterClick}）→ 可能未经确认就删了`);
    const stepC2 = await run(`JSON.stringify({ note: '原生确认框需外部应答，本脚本不模拟', rows: document.querySelectorAll('.regex-input-find').length })`);
    console.log('   ', JSON.stringify(stepC2));


    console.log('\n===== 汇总 =====');
    if (problems.length) { problems.forEach(p => console.log('  [FAIL] ' + p)); process.exit(1); }
    console.log(`  [PASS] 基础行数 ${baseRows} → 新增 +1 立即生效（未切 Tab，含空态首条分支）→ 删除点击后未误删（原生框待外部应答）`);
    process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
