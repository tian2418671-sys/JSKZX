/**
 * 生产模式 UI 回归探针（CDP，app:// 生产构建）
 *
 * 目标历史缺陷：
 *   AR-18 🔴 正则/状态栏「新增首条不刷新」（Vue 3.4+ computed 值不变不传播）
 *   AR-19 🟡 正则/状态栏「添加要切 Tab、删除无任何提示」
 *
 * 判定手法（用户可见症状，不依赖调试句柄）：
 *   进入卡片「正则脚本」Tab → 记录当前条目数 → 点「+ 立即新增一条正则脚本」
 *   → **完全不切换 Tab** → 等 1.5s → 再看条目数。
 *   若条目数 +1 且 DOM 里出现新条目 ⇒ AR-18 未复活（新增立即反映）。
 *   若条目数不变 ⇒ AR-18 复活。
 *
 * 用法：
 *   npx electron . --disable-gpu --remote-debugging-port=9350
 *   $env:CDP_PORT="9350"; node scripts/tools/prod-ui-regression.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9350);
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res;
        sock.onerror = rej;
        sock.onmessage = (ev) => {
            try {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) {
                    const p = pending.get(m.id); pending.delete(m.id);
                    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
                }
            } catch (e) { /* 忽略非 JSON 帧 */ }
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('evaluate 超时（页面可能已阻塞）')); }, 15000);
        pending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); }
        });
        sock.send(JSON.stringify({ id, method, params }));
    });
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
    catch (e) { return { __parseError: String(raw).slice(0, 300) }; }
}

/** 通用：找含指定文本的叶子元素并点击 */
const clickByText = (txt) => `(() => {
    const el = [...document.querySelectorAll('*')].find(e => (e.textContent || '').trim() === ${JSON.stringify(txt)});
    if (!el) return JSON.stringify({ ok: false, reason: 'not-found' });
    el.click();
    return JSON.stringify({ ok: true });
})()`;

const clickByIncludes = (txt) => `(() => {
    const el = [...document.querySelectorAll('button, a, div, span')].find(e => (e.textContent || '').includes(${JSON.stringify(txt)}));
    if (!el) return JSON.stringify({ ok: false, reason: 'not-found' });
    el.click();
    return JSON.stringify({ ok: true, tag: el.tagName });
})()`;

/** 正则脚本面板状态：数「正则脚本」区块内的条目行 */
const REGEX_PANEL_STATE = `(() => {
    const txt = document.body.innerText || '';
    const hasPanel = txt.includes('正则脚本');
    // 条目行：数据驱动，通常带 scriptName 输入或名称文本；这里用「新增」按钮计数做交叉验证
    const addBtn = [...document.querySelectorAll('button, a')].find(b => (b.textContent || '').includes('立即新增一条正则脚本'));
    // 统计页面上 input[placeholder] 含「正则名」或「脚本名」的数量作为条目近似计数
    const nameInputs = [...document.querySelectorAll('input')].filter(i => /正则名|脚本名|scriptName/i.test(i.placeholder || ''));
    const findInputs = [...document.querySelectorAll('input, textarea')].filter(i => /匹配|findRegex|查找/i.test(i.placeholder || ''));
    return JSON.stringify({
        hasPanel,
        addBtnPresent: !!addBtn,
        nameInputCount: nameInputs.length,
        findInputCount: findInputs.length,
        bodyLen: txt.length
    });
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(1500);

    const out = { steps: [] };
    const log = (n, v, note) => { out.steps.push({ step: n, verdict: v, note: note || '' }); console.log(`  [${v}] ${n}${note ? '  ' + note : ''}`); };

    console.log('等应用加载…');
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 180000) {
        const s = await run(`JSON.stringify({ hasCardList: (document.body.innerText||'').includes('卡片列表'), len: (document.body.innerText||'').length })`);
        if (s && s.hasCardList) { ready = true; break; }
        await wait(1000);
    }
    if (!ready) { console.log('❌ 应用未就绪'); process.exit(1); }
    log('应用就绪', 'PASS');

    // ---- 打开一张卡（点第一个卡片行）----
    const opened = await run(`(() => {
        const row = [...document.querySelectorAll('div.cursor-pointer')].find(d => (d.textContent || '').includes('🌍'));
        if (!row) return JSON.stringify({ ok: false });
        row.click();
        return JSON.stringify({ ok: true });
    })()`);
    await wait(3000);
    log('打开卡片', opened.ok ? 'PASS' : 'CANNOT-VERIFY', opened.ok ? '' : '未找到卡片行');

    // ---- 切到「正则脚本」Tab ----
    let switched = await run(clickByIncludes('正则脚本'));
    await wait(1500);
    if (!switched.ok) { switched = await run(clickByText('⚙️ 正则脚本')); await wait(1500); }
    log('切到正则脚本 Tab', switched.ok ? 'PASS' : 'CANNOT-VERIFY', JSON.stringify(switched));

    // ---- AR-18 核心：记录 → 新增 → 不切 Tab → 复查 ----
    const before = await run(REGEX_PANEL_STATE);
    console.log('    新增前:', JSON.stringify(before));

    const addClick = await run(clickByIncludes('立即新增一条正则脚本'));
    if (!addClick.ok) {
        log('AR-18 新增首条立即刷新', 'CANNOT-VERIFY', '未找到「立即新增一条正则脚本」按钮');
    } else {
        await wait(1800);   // ⚠️ 全程不切 Tab
        const after = await run(REGEX_PANEL_STATE);
        console.log('    新增后:', JSON.stringify(after));
        const grew = (after.nameInputCount > before.nameInputCount) || (after.findInputCount > before.findInputCount);
        log('AR-18 新增后立即刷新（未切 Tab）', grew ? 'PASS' : 'FAIL',
            grew ? `条目输入框 ${before.nameInputCount + before.findInputCount} → ${after.nameInputCount + after.findInputCount}` : '条目数未增加 → 疑似 AR-18 复活');
    }

    // ---- AR-19：删除是否给提示（看有没有确认框/toast 出现）----
    const delClicked = await run(`(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /删除/.test(b.textContent || '') || /删除/.test(b.title || ''));
        if (!btn) return JSON.stringify({ ok: false });
        btn.click();
        return JSON.stringify({ ok: true });
    })()`);
    await wait(1500);
    if (delClicked.ok) {
        const hasDialog = await run(`JSON.stringify({
            bodyHasConfirm: /确定|确认|不可逆/.test(document.body.innerText || ''),
            modalCount: document.querySelectorAll('body > div').length
        })`);
        log('AR-19 删除有提示', hasDialog.bodyHasConfirm ? 'PASS' : 'CANNOT-VERIFY', JSON.stringify(hasDialog));
        // 关掉可能的弹窗
        await run(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/取消|关闭|✕/.test(x.textContent||'')); if(b) b.click(); return JSON.stringify({ok:true}); })()`);
    } else {
        log('AR-19 删除有提示', 'CANNOT-VERIFY', '未找到删除按钮（该卡可能无正则脚本条目）');
    }

    console.log('\n===== 汇总 =====');
    const fails = out.steps.filter((s) => s.verdict === 'FAIL');
    const cvs = out.steps.filter((s) => s.verdict === 'CANNOT-VERIFY');
    console.log(`  步骤 ${out.steps.length}：PASS ${out.steps.filter((s) => s.verdict === 'PASS').length}，FAIL ${fails.length}，CANNOT-VERIFY ${cvs.length}`);
    fails.forEach((f) => console.log(`    ❌ ${f.step}: ${f.note}`));
    cvs.forEach((f) => console.log(`    ⚠️ ${f.step}: ${f.note}`));
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
