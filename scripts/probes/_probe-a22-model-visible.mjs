/**
 * 🔒 AI-22 真机验证探针 —— 手填模型名在拉取后必须仍然可见
 *
 * 修复前：拉取成功后控件从 input 换成 select（option 只来自服务端），
 *         手填的私有模型名在界面上**消失**（值仍在 ⇒ 用户以为配置被清空）。
 * 修复后：统一 input + 全局 datalist，`apiModel` 永远完整显示。
 *
 * 断言：
 *   1. 拉取前后，控件都是 input（形态不切换）
 *   2. 拉取后输入框 value 仍 === 哨兵值（界面可见）
 *   3. 出现「不在候选」的说明文案
 *   4. 清理，零污染
 *
 * 用法：node scripts/probes/_probe-a22-model-visible.mjs [port]
 */

const PORT = Number(process.argv[2]) || 9377;
const SENTINEL = 'probe-visible-model-abc';

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

    // 0) 打开设置弹窗
    await evalJs(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.offsetParent !== null && /设置\\(S\\)|^设置/.test((x.textContent||'').trim()));
        if (b) b.click();
        return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const opened = await evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('button,[role="menuitem"],li,a,div'))
            .find(x => x.offsetParent !== null && /API\\s*引擎|API\\s*设置|模型设置/i.test((x.textContent||'').trim()) && (x.textContent||'').trim().length < 30);
        if (!el) return false; el.click(); return true;
    })()`);
    check('打开「API 引擎与模型设置」', !!opened);
    await new Promise((r) => setTimeout(r, 900));
    if (!opened) { ws.close(); process.exit(2); }

    // 1) 写入哨兵值，记录控件形态
    const before = await evalJs(`(() => {
        const box = Array.from(document.querySelectorAll('.fixed'))
            .find(x => /API 引擎|模型名称|拉取模型/.test(x.textContent || ''));
        if (!box) return { ok: false, why: '弹窗不存在' };
        const inp = Array.from(box.querySelectorAll('input')).find(i => /模型|model/i.test(i.placeholder || ''));
        if (!inp) return { ok: false, why: '未找到模型输入框（修复后应恒为 input）' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '${SENTINEL}');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, tag: inp.tagName, value: inp.value, list: inp.getAttribute('list') };
    })()`);
    check('模型控件是 input（不是 select）', before.ok && before.tag === 'INPUT', before.why || before.tag);
    check('已写入哨兵值', before.ok && before.value === SENTINEL, `value="${before.value}"`);
    check('input 绑定了 datalist', before.ok && before.list === 'model-suggestions', `list="${before.list}"`);
    if (!before.ok) { ws.close(); process.exit(2); }

    // 2) 真实点击拉取
    const clicked = await evalJs(`(() => {
        const b = Array.from(document.querySelectorAll('button,a'))
            .find(x => x.offsetParent !== null && /拉取.{0,6}模型|获取.{0,6}模型|模型列表/i.test(x.textContent || ''));
        if (!b) return false; b.click(); return true;
    })()`);
    check('点击「拉取模型列表」', !!clicked);
    if (!clicked) { ws.close(); process.exit(2); }
    await new Promise((r) => setTimeout(r, 9000));

    // 3) 核心断言：界面值仍可见
    const after = await evalJs(`(() => {
        const box = Array.from(document.querySelectorAll('.fixed'))
            .find(x => /API 引擎|模型名称|拉取模型/.test(x.textContent || ''));
        if (!box) return { ok: false, why: '弹窗消失' };
        const inp = Array.from(box.querySelectorAll('input')).find(i => /模型|model/i.test(i.placeholder || ''));
        const selCount = Array.from(box.querySelectorAll('select')).filter(s => s.options.length > 5).length;
        const text = (box.innerText || '');
        return {
            ok: !!inp,
            tag: inp ? inp.tagName : null,
            value: inp ? inp.value : null,
            bigSelectCount: selCount,
            hasWarn: /不在.*候选|自定义\\/私有/.test(text),
            dynOptions: document.querySelectorAll('#model-suggestions option').length
        };
    })()`);
    check('拉取后控件仍是 input（形态未切换）', after.ok && after.tag === 'INPUT' && after.bigSelectCount === 0, `tag=${after.tag} 大select=${after.bigSelectCount}`);
    check('★ 界面仍完整显示手填模型名（核心）', after.value === SENTINEL, `value="${after.value}"`);
    check('出现「不在候选」说明文案', !!after.hasWarn);
    check('datalist 已合并动态候选', after.dynOptions > 6, `options=${after.dynOptions}`);

    // 4) 清理
    const cleaned = await evalJs(`(() => {
        const box = Array.from(document.querySelectorAll('.fixed'))
            .find(x => /API 引擎|模型名称|拉取模型/.test(x.textContent || ''));
        if (!box) return false;
        const inp = Array.from(box.querySelectorAll('input')).find(i => /模型|model/i.test(i.placeholder || ''));
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    check('已清理哨兵值（零污染）', !!cleaned);

    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== ${pass}/${results.length} 通过 ===`);
    ws.close();
    process.exit(pass === results.length ? 0 : 1);
};

main().catch((e) => { console.error('探针失败：', e.message); process.exit(1); });
