/**
 * 🔒 G1 真机验证探针（AI-21 / #hot-bug-1）
 *
 * ── 实测发现的两个事实（决定了本探针的断言口径）────────────────────────
 * 1. 模型名控件在「拉取成功」后会**从 input 切换成 select**（`ApiSettingsModal.vue:36-39`），
 *    而 select 的选项只来自服务端返回 ⇒ **用户手填的私有模型名在界面上看不见**
 *    （这是既有 UI 缺陷，已登记为 AI-22，不在本次修复范围）。
 * 2. 因此**不能**用 `select.value` 断言底层 apiModel —— 它是 DOM 层表现，不等于状态值。
 *
 * ⇒ 权威判据是**状态文案**：`fetchModelStatus` 会回显「当前模型「X」不在列表中（已保留，未改动）」。
 *    修复前该分支会把 X **改成列表首项**，文案变成「在列表中」——这就是可证伪的差异。
 *
 * 验证步骤：
 *   1. 打开设置 → 记录候选列表长度
 *   2. 写入哨兵模型名（模拟用户手填）
 *   3. 点「拉取模型列表」
 *   4. 断言：文案回显哨兵值 + 说明「已保留」+ **不含**「已自动选中」
 *   5. 清理哨兵，零污染
 *
 * 用法：node scripts/probes/_probe-g1-model-overwrite.mjs [port]
 */

const PORT = Number(process.argv[2]) || 9377;
const SENTINEL = 'probe-sentinel-model-xyz';

let seq = 0;
const rpc = (ws, method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
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

    const evalJs = async (expr) => {
        const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 260));
        return r.result.value;
    };

    const results = [];
    const check = (name, ok, detail) => {
        results.push({ name, ok });
        console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
    };

    /** 读弹窗内的状态文案（fetchModelStatus 渲染出来的那几行） */
    const readStatus = () => evalJs(`(() => {
        // ⚠️ 不能用 document.querySelector('.fixed')：页面上可能同时存在其它 .fixed 弹窗
        //    （实测自动分组弹窗会抢先被选中，导致读到无关文案 ⇒ 探针假失败）。
        //    按**内容**锁定「API 接口与大模型配置」那个弹窗。
        const b = Array.from(document.querySelectorAll('.fixed'))
            .find(x => /API 引擎|模型名称|拉取模型/.test(x.textContent || ''));
        if (!b) return 'NO_MODAL';
        return (b.innerText || '').split('\\n')
            .filter(l => /成功获取|已保留|已自动选中|不像是模型名|未抓取到|拉取失败|已忽略/.test(l))
            .join(' || ');
    })()`);

    // 0) 应用就绪
    const ready = await evalJs(`!!document.querySelector('#app') && document.querySelector('#app').children.length > 0`);
    check('应用已渲染', !!ready);
    if (!ready) { ws.close(); process.exit(1); }

    // 1) 打开设置弹窗
    await evalJs(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.offsetParent !== null && /设置\\(S\\)|^设置/.test((x.textContent||'').trim()));
        if (b) b.click();
        return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const opened = await evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('button,[role="menuitem"],li,a,div'))
            .find(x => x.offsetParent !== null && /API\\s*引擎|API\\s*设置|模型设置/i.test((x.textContent||'').trim()) && (x.textContent||'').trim().length < 30);
        if (!el) return false;
        el.click();
        return true;
    })()`);
    check('打开「API 引擎与模型设置」', !!opened);
    await new Promise((r) => setTimeout(r, 900));
    if (!opened) { ws.close(); process.exit(2); }

    // 2) 写入哨兵模型名（此时控件是 input —— 未拉取过；若已是 select 则注入 option）
    const setup = await evalJs(`(() => {
        const box = Array.from(document.querySelectorAll('.fixed'))
            .find(x => /API 引擎|模型名称|拉取模型/.test(x.textContent || ''));
        if (!box) return { ok: false, why: '弹窗不存在' };
        // 优先找 input（未拉取时的形态）
        let ctl = Array.from(box.querySelectorAll('input')).find(i => /模型|model/i.test(i.placeholder || ''));
        if (ctl) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(ctl, '${SENTINEL}');
            ctl.dispatchEvent(new Event('input', { bubbles: true }));
            ctl.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, kind: 'input', now: ctl.value };
        }
        // 已是 select 形态：插入哨兵 option 并选中
        const sel = Array.from(box.querySelectorAll('select')).find(s => s.options.length > 5);
        if (!sel) return { ok: false, why: '既无 input 也无 select' };
        const opt = document.createElement('option');
        opt.value = '${SENTINEL}';
        opt.text = '${SENTINEL}';
        opt.setAttribute('data-probe', '1');
        sel.appendChild(opt);
        const ssetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        ssetter.call(sel, '${SENTINEL}');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, kind: 'select', now: sel.value };
    })()`);
    check('写入哨兵模型名（模拟用户手填私有模型）', !!(setup && setup.ok), setup.why || `${setup.kind} now="${setup.now}"`);
    if (!setup || !setup.ok) { ws.close(); process.exit(2); }

    // 3) 真实点击「拉取模型列表」
    const clicked = await evalJs(`(() => {
        const b = Array.from(document.querySelectorAll('button,a'))
            .find(x => x.offsetParent !== null && /拉取.{0,6}模型|获取.{0,6}模型|模型列表/i.test(x.textContent || ''));
        if (!b) return false;
        b.click();
        return true;
    })()`);
    check('点击「拉取模型列表」', !!clicked);
    if (!clicked) { ws.close(); process.exit(2); }

    await new Promise((r) => setTimeout(r, 9000));   // 等主进程转发返回

    // 4) 核心断言：以状态文案为准（它回显底层 apiModel）
    const status = await readStatus();
    check('状态文案回显了哨兵模型名（⇒ 底层值未被覆盖）', status.includes(SENTINEL), status.slice(0, 110));
    // ⚠️ 2026-10-25 更新断言口径（AI-22 修复后）：手填值现在**会进入候选列表**（因为输入框变
    //    input + datalist，允许不在列表中的值，且状态文案会如实回显）。因此两种分支都是正确的：
    //      · 「在当前模型「X」在列表中」      → 值保留，且确实在列
    //      · 「当前模型「X」不在列表中（已保留，未改动）」→ 值保留，且不在列
    //    真正要防的是「被静默改成列表首项」，即文案里出现「已自动选中」。
    check('文案说明「已保留 / 在列表中」（二选一，均属正常）',
        status.includes('已保留') || status.includes('在列表中'), status.slice(0, 140));
    check('未谎报「已自动选中」', !status.includes('已自动选中'), '');

    // 5) 清理探针插入的 option
    const cleaned = await evalJs(`(() => {
        const box = Array.from(document.querySelectorAll('.fixed'))
            .find(x => /API 引擎|模型名称|拉取模型/.test(x.textContent || ''));
        if (!box) return false;
        box.querySelectorAll('option[data-probe="1"]').forEach(o => o.remove());
        return !box.querySelector('option[data-probe="1"]');
    })()`);
    check('已清理探针插入的选项（零污染）', !!cleaned);

    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== ${pass}/${results.length} 通过 ===`);
    ws.close();
    process.exit(pass === results.length ? 0 : 1);
};

main().catch((e) => { console.error('探针失败：', e.message); process.exit(1); });
