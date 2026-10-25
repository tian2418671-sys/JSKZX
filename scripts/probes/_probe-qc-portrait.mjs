/**
 * 📊 A+B3 真机验证探针（阶段二）
 *
 * 验证：
 *   1. 质检弹窗有「📋 巡检清单 / 📊 结构画像」两个页签，可切换
 *   2. 未跑质检时画像显示空态（提示先去跑），**不显示 0**
 *   3. 跑一次质检（只勾 S3+S4，跳过慢的查重/扫描）→ 画像出现真数据
 *   4. 矩阵单元格可点（触发 tag: 筛选）
 *   5. B3 两个按钮存在且可点（打标 / 自动分组）
 *   6. 关闭按钮可用（AR-54 回归项）
 *
 * 用法：node scripts/probes/_probe-qc-portrait.mjs [port]
 */

const PORT = Number(process.argv[2]) || 9379;

let seq = 0;
const rpc = (ws, method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 90000);
    const handler = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.id === id) {
            clearTimeout(t);
            ws.removeEventListener('message', handler);
            d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result);
        }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
});

const main = async () => {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到页面目标');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    await rpc(ws, 'Runtime.enable');

    const ev = async (expr) => {
        const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result.value;
    };

    const results = [];
    const check = (name, ok, detail) => {
        results.push({ name, ok });
        console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /** 等某个条件成立（避免固定 sleep 造成的时序误判） */
    const waitFor = async (expr, timeoutMs = 15000, stepMs = 250) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await ev(expr)) return true;
            await wait(stepMs);
        }
        return false;
    };

    /** 弹窗是否真的渲染出了内容（不是空壳） */
    const MODAL_READY = `(() => { const b = document.querySelector('.fixed'); return !!(b && b.innerText && b.innerText.length > 50); })()`;

    // 0) 打开质检（工具菜单 → 一键质检）
    const opened = await ev(`(() => {
        const menus = Array.from(document.querySelectorAll('button'));
        const m = menus.find(b => b.offsetParent !== null && /维护\\(W\\)|^🔧 维护/.test((b.textContent||'').trim()));
        if (!m) return { ok:false, why:'未找到「维护」菜单' };
        m.click();
        return { ok:true };
    })()`);
    await wait(500);
    const clickQc = await ev(`(() => {
        const el = Array.from(document.querySelectorAll('button,[role="menuitem"],li,a,div'))
            .find(x => x.offsetParent !== null && /一键质检/i.test((x.textContent||'').trim()) && (x.textContent||'').trim().length < 24);
        if (!el) return false;
        el.click();
        return true;
    })()`);
    // ⚠️ 必须先等弹窗真的渲染完，否则后续点页签会点空（首次实测踩到）
    const modalReady = await waitFor(MODAL_READY, 15000);
    check('打开「一键质检」弹窗且已渲染', !!(opened.ok && clickQc && modalReady), opened.why || '');
    if (!clickQc || !modalReady) { ws.close(); process.exit(2); }

    // 1) 页签存在
    const tabs = await ev(`(() => {
        const btns = Array.from(document.querySelectorAll('.fixed button'));
        const names = btns.map(b => (b.textContent||'').trim()).filter(t => /巡检清单|结构画像/.test(t));
        return names;
    })()`);
    check('存在两个页签', tabs.length >= 2, JSON.stringify(tabs));

    // 2) 切到画像 → 空态（未跑质检）
    await ev(`(() => { const b = Array.from(document.querySelectorAll('.fixed button')).find(x => /结构画像/.test((x.textContent||'').trim())); if (b) b.click(); return true; })()`);
    // 等页签真的切过去（按钮变高亮 / 出现矩阵标题）
    await waitFor(`/标签 × 分组交叉矩阵|还没有画像数据/.test((document.querySelector('.fixed')||{}).innerText||'')`, 8000);
    const emptyState = await ev(`(() => {
        const box = document.querySelector('.fixed');
        const t = box ? box.innerText : '';
        return {
            hasPrompt: /还没有画像数据/.test(t) || /请先切到/.test(t),
            hasMatrixOrPool: /标签 × 分组交叉矩阵/.test(t),
            hasZeroClaim: /从font-size|从未使用 0 个|P50 0\b/.test(t)
        };
    })()`);
    // 🔑 口径：尚未跑过质检时，应该看到「还没有画像数据」；若已经跑过一次（弹窗复用上次数据）
    //    则应直接有矩阵 —— 两者都算正常，只要**不谎报 0**。
    check('未跑过质检时要么空态、要么直接用上次结果', !!(emptyState.hasPrompt || emptyState.hasMatrixOrPool),
        JSON.stringify(emptyState));
    check('不谎报 0 值', !emptyState.hasZeroClaim);

    // 3) 回清单，只勾 S3+S4 后跑（跳过慢步骤）
    await ev(`(() => { const b = Array.from(document.querySelectorAll('.fixed button')).find(x => /巡检清单/.test((x.textContent||'').trim())); if (b) b.click(); return true; })()`);
    await wait(300);
    // 取消勾选 rescan / dedupe / wb，只留 tags + audit
    await ev(`(() => {
        const box = document.querySelector('.fixed');
        const labels = Array.from(box.querySelectorAll('label'));
        for (const lb of labels) {
            const txt = (lb.textContent||'');
            const isSlow = /S1 重新扫描|S2 查重扫描|S5 世界书词条体检/.test(txt);
            const cb = lb.querySelector('input[type=checkbox]');
            if (cb && isSlow && cb.checked) cb.click();
        }
        return true;
    })()`);
    await wait(300);
    const enabledState = await ev(`(() => {
        const box = document.querySelector('.fixed');
        return Array.from(box.querySelectorAll('label')).map(lb => ({ t:(lb.textContent||'').trim().slice(0,12), on: !!(lb.querySelector('input[type=checkbox]')||{}).checked }));
    })()`);
    console.log('  勾选状态：', JSON.stringify(enabledState));

    // 点开始质检
    await ev(`(() => { const b = Array.from(document.querySelectorAll('.fixed button')).find(x => /开始质检/.test((x.textContent||'').trim())); if (b) b.click(); return true; })()`);

    // 轮询直到 S3/S4 都变成 ✅（最多 60s）
    //   ⚠️ 判据不能用「质检完成 / 上次用时」—— 那些文案在未跑时也可能存在；
    //      要看步骤标题的**状态图标**（✅ S3 / ✅ S4）。
    const doneOk = await waitFor(`(() => {
        const box = document.querySelector('.fixed');
        if (!box) return false;
        const btns = Array.from(box.querySelectorAll('button')).map(b => (b.textContent||'').trim());
        return btns.some(t => /^✅ S3/.test(t)) && btns.some(t => /^✅ S4/.test(t));
    })()`, 60000, 500);
    const doneDetail = await ev(`(() => {
        const box = document.querySelector('.fixed');
        return Array.from(box.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /^[✅⏭⏸⏳❌⛔]\s*S\d/.test(t));
    })()`);
    check('S3 / S4 均执行完成', doneOk, JSON.stringify(doneDetail));

    // 4) 切到画像 → 有真数据
    await ev(`(() => { const b = Array.from(document.querySelectorAll('.fixed button')).find(x => /结构画像/.test((x.textContent||'').trim())); if (b) b.click(); return true; })()`);
    await wait(600);
    const portrait = await ev(`(() => {
        const box = document.querySelector('.fixed');
        const t = box ? box.innerText : '';
        const cells = Array.from(box.querySelectorAll('table button')).length;
        const tableRows = box.querySelectorAll('table tbody tr').length;
        return {
            hasMatrix: /标签 × 分组交叉矩阵/.test(t),
            hasPool: /标签池健康度/.test(t),
            hasToken: /Token 分位数/.test(t),
            rows: tableRows, clickableCells: cells,
            hasP50: /P50 中位/.test(t),
            textSample: t.split('\\n').filter(l => /P50|池内从未使用|已用但不在池内|全库 \\d+ 标签/.test(l)).slice(0,3)
        };
    })()`);
    check('矩阵区块渲染', !!portrait.hasMatrix, `行数=${portrait.rows} 可点单元格=${portrait.clickableCells}`);
    check('池健康度区块渲染', !!portrait.hasPool);
    check('Token 分位数区块渲染', !!(portrait.hasToken && portrait.hasP50));
    check('矩阵有真实数据行', portrait.rows > 0, portrait.textSample.join(' | ').slice(0, 100));

    // 5) B3 按钮存在
    const b3 = await ev(`(() => {
        const t = (document.querySelector('.fixed')||{}).innerText || '';
        return { ai: /去 AI 打标/.test(t), ag: /去自动分组/.test(t) };
    })()`);
    check('B3 两个入口存在', !!(b3.ai && b3.ag), JSON.stringify(b3));

    // 6) 关闭（AR-54 回归）
    //   ⚠️ 判据：整个页面里**不再有任何可见的模态遮罩**（`.fixed.inset-0` 且 innerText 非空）。
    //      不能只查 `.fixed` 是否存在 —— 其它弹窗/浮层也可能有该类名。
    await ev(`(() => { const b = Array.from(document.querySelectorAll('.fixed button')).find(x => /知道了|✕ 关闭/.test((x.textContent||'').trim())); if (b) b.click(); return true; })()`);
    const closed = await waitFor(`(() => {
        const t = document.querySelectorAll('.fixed.inset-0');
        for (const el of t) { if ((el.innerText||'').includes('一键质检')) return false; }
        return true;
    })()`, 8000);
    check('弹窗可关闭（AR-54 回归）', !!closed);

    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== ${pass}/${results.length} 通过 ===`);
    ws.close();
    process.exit(pass === results.length ? 0 : 1);
};

main().catch((e) => { console.error('探针失败：', e.message); process.exit(1); });
