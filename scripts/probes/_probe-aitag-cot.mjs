/**
 * 🧠 AI 打标「分角色 + 思维链 + 连通性测试」端到端验证（2026-09-24 落地）
 *
 * 用法（**dev 模式** + CDP）：
 *   # 终端 1
 *   npm run dev
 *   # 终端 2（另开一个；VITE_DEV_SERVER_URL 必须指向 Vite Dev Server 才能拿到 __jskDiag）
 *   $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *   node_modules\electron\dist\electron.exe . --remote-debugging-port=9376 --user-data-dir=%TEMP%\jsk-probe
 *   # 终端 3
 *   $env:CDP_PORT="9376"; node scripts/probes/_probe-aitag-cot.mjs
 *
 * 背景：R1+R2+CoT 落地（`js/utils/llmPromptRoles.js` + `useAITools.js` + `AITagModal.vue`），
 *       仅当「①规则关 且 ②向量关 且 ③LLM 开」时启用。纯函数层已有 70 条单测守着，
 *       本探针专测**单测覆盖不到的渲染层**（Vue 模板 / props 透传 / ctx 解构 / 徽标联动）。
 *
 * ⚠️ 为什么必须探针：AR-13 同型缺陷（新 API 只加进 ctx 却没从组合式函数解构）**编译期看不出来**，
 *    只有真实启动 + 真实点击才能抓到。
 *
 * ⚠️ 两条硬约束（否则读数全错 / 假失败）：
 *   1. **状态读写一律走 `window.__jskDiag.aiTag.*`** —— 探针自己 `import()` 会拿到另一个模块实例；
 *   2. **DOM 查询必须限定在弹窗内** —— `document.querySelectorAll('button')` 会先命中应用主体
 *      （HeaderBar 的「⚡ API 引擎与模型设置」菜单项）和弹窗自己的「✕ 关闭」按钮，
 *      导致「点 API 引擎分区」实际点到别的按钮、点「关闭档」直接把弹窗关掉
 *      （本探针初版踩了这两个坑 → 5 条假失败）。
 *
 * 断言（共 20 条）：
 *   ① 弹窗可打开、无渲染期 console error
 *   ② 提示词分区展开后 **5 个小页签齐全**（System / Assistant / User / 预填充 / 思维链）
 *   ③ 逐个点击页签 → 对应编辑区确实切换（offsetParent 真实可见性判定）
 *   ④ 思维链页签 **三档按钮齐全**（默认版 / 自定义 / 关闭）
 *   ⑤ 默认档 → 只读展示（readonly=true）
 *   ⑥ 切「自定义」→ 可编辑（readonly=false）且自动预填内置默认版
 *   ⑦ 切「关闭」→ 显示「已关闭」文案、无编辑框、**弹窗仍开着**（防误点关闭按钮）
 *   ⑧ API 分区 **「测试连通性」按钮存在且可见**
 *   ⑨ 「仅 LLM 层」时执行管线区出现 🟢 徽标 + 思维链档位
 *   ⑩ 非「仅 LLM」时徽标消失（条件正确性 —— 不能恒显）
 *   ⑪ 引擎侧（`__jskDiag.aiTag.cot()`）三档取值与 UI 一致
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

// ═══════════════════════════════════════════════════════════════
// 🎯 DOM 作用域助手（**必须**用：否则会点到弹窗外的同名按钮）
// ═══════════════════════════════════════════════════════════════
/** 弹窗根节点（`fixed inset-0 z-50` 全屏遮罩）；未打开返回 null
 *  ⚠️ 两个坑（初版都踩了，各造成一批假失败）：
 *    1. 不能用 `offsetParent !== null` 判可见 —— **fixed 定位元素的 offsetParent 恒为 null**
 *       （本项目弹窗就是 `fixed inset-0`）；
 *    2. **必须要求 `inset-0`** —— Toast 容器也是 `fixed z-50 bg-gray-800/95`（420×72），
 *       且在 DOM 里**排在弹窗之前**，只用 `/fixed/ && /z-50/` 会先命中它。 */
const MODAL_ROOT = `([...document.querySelectorAll('div')].find(d => {
    const c = typeof d.className === 'string' ? d.className : '';
    if (!/fixed/.test(c) || !/inset-0/.test(c) || !/z-50/.test(c)) return false;
    if (getComputedStyle(d).display === 'none') return false;
    const r = d.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}) || null)`;
/** 文案规范化（去空格/符号，只留中英文字母）—— 用于**精确等于**匹配，避免 includes 误命中 */
const NORM = `((s) => (s || '').replace(/[^A-Za-z\\u4e00-\\u9fa5]/g, ''))`;

/** 在弹窗内点击「文案规范化后**完全等于** label」的按钮 */
const clickExact = (label) => `(() => {
    const root = ${MODAL_ROOT};
    if (!root) return 'no-modal';
    const norm = ${NORM};
    const b = [...root.querySelectorAll('button')].find(x => norm(x.textContent) === ${JSON.stringify(label)});
    if (!b) return 'not-found';
    b.click();
    return 'clicked';
})()`;
/** 在弹窗内点击「文案包含 label」的按钮（分区导航等长文案用） */
const clickContains = (label) => `(() => {
    const root = ${MODAL_ROOT};
    if (!root) return 'no-modal';
    const b = [...root.querySelectorAll('button')].find(x => (x.textContent || '').includes(${JSON.stringify(label)}));
    if (!b) return 'not-found';
    b.click();
    return 'clicked';
})()`;
/** 思维链面板（含「当前将注入 N 字」那行的容器）—— 把「关闭档」限定在面板内 */
const COT_PANEL = `(() => {
    const s = [...document.querySelectorAll('span')].find(x => (x.textContent || '').includes('当前将注入'));
    return s ? s.parentElement.parentElement : null;
})()`;
/** 在思维链面板内点某档 */
const clickCotMode = (label) => `(() => {
    const panel = ${COT_PANEL};
    if (!panel) return 'no-cot-panel';
    const norm = ${NORM};
    const b = [...panel.querySelectorAll('button')].find(x => norm(x.textContent) === ${JSON.stringify(label)});
    if (!b) return 'not-found';
    b.click();
    return 'clicked';
})()`;

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP');

    // ═══ ① 打开弹窗（走 __jskDiag，不自己 import）═══
    const opened = await evaluate(`(async () => {
        const d = window.__jskDiag;
        if (!d || !d.aiTag) return { ok: false, err: 'no __jskDiag.aiTag（需 dev 模式：VITE_DEV_SERVER_URL 指向 Vite）' };
        const lib = d.lib();
        if (!lib.length) return { ok: false, err: '库为空（隔离 profile 的 config 需预置 lastFolder 指向真实卡库）' };
        d.select(1);
        await new Promise(r => setTimeout(r, 300));
        d.aiTag.open();
        await new Promise(r => setTimeout(r, 900));
        return { ok: true, cards: lib.length };
    })()`);
    check('通过 App 真实入口打开 AI 打标弹窗', opened.ok, opened.err || `库内 ${opened.cards} 张`);
    if (!opened.ok) { console.log('\n无法继续'); process.exit(1); }

    // ═══ ⑧ API 分区「测试连通性」按钮（限定弹窗内）═══
    const apiClick = await evaluate(clickContains('API 引擎'));
    await sleep(350);
    const connBtn = await evaluate(`(() => {
        const root = ${MODAL_ROOT};
        if (!root) return { err: 'no-modal' };
        const btns = [...root.querySelectorAll('button')].filter(b => (b.textContent || '').includes('测试连通性'));
        return {
            total: btns.length,
            visible: btns.filter(b => b.getBoundingClientRect().width > 0).length,
            hasHint: [...root.querySelectorAll('span')].some(s => (s.textContent || '').includes('打标前建议先测一下'))
        };
    })()`);
    check('弹窗内找到「API 引擎」分区入口', apiClick === 'clicked', apiClick);
    check('「🔌 测试连通性」按钮存在且可见', connBtn.visible === 1, `DOM ${connBtn.total} 个 / 可见 ${connBtn.visible} 个`);
    check('连通性测试用途说明已渲染', connBtn.hasHint === true);

    // ═══ ② 提示词分区 → 展开预设 → 5 个小页签 ═══
    const promptsClick = await evaluate(clickContains('系统提示词库'));
    await sleep(350);
    const ensured = await evaluate(`(async () => {
        const d = window.__jskDiag;
        const list = d.aiTag.presets();
        if (!list.length) return { count: 0 };
        d.aiTag.expandPreset(0);
        await new Promise(r => setTimeout(r, 350));
        return { count: list.length, first: d.aiTag.presets()[0] };
    })()`);
    check('弹窗内找到「系统提示词库」分区入口', promptsClick === 'clicked', promptsClick);
    info('提示词预设数', String(ensured.count) + (ensured.first ? `，首条 cotMode=${ensured.first.cotMode}` : ''));

    const TABS = { System: 'system', Assistant: 'assistant', User: 'user', 预填充: 'prefill', 思维链: 'cot' };
    const tabsFound = await evaluate(`(() => {
        const root = ${MODAL_ROOT};
        if (!root) return { err: 'no-modal' };
        const norm = ${NORM};
        const texts = [...root.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0).map(b => norm(b.textContent));
        const want = ${JSON.stringify(Object.keys(TABS))};
        return { found: want.filter(w => texts.includes(w)), missing: want.filter(w => !texts.includes(w)) };
    })()`);
    check('5 个小页签齐全（System / Assistant / User / 预填充 / 思维链）',
        tabsFound.missing.length === 0, tabsFound.missing.length ? '缺：' + tabsFound.missing.join('、') : tabsFound.found.join(' / '));

    // ═══ ③ 逐个点击页签 → 对应编辑区切换 ═══
    //   用「该页签独有说明文案」判定真实可见性（offsetParent），避免 v-show 隐藏造成假失败
    const FEATURE_TEXT = {
        system: '角色 + 任务规则',
        assistant: 'few-shot 示范',
        user: '本次任务指令',
        prefill: '强制模型从这个开头往下写',
        cot: '当前将注入'
    };
    const switchResults = [];
    for (const [label, key] of Object.entries(TABS)) {
        const r = await evaluate(clickExact(label));
        await sleep(280);
        const vis = await evaluate(`(() => {
            const root = ${MODAL_ROOT};
            if (!root) return { total: 0, visible: 0 };
            const needle = ${JSON.stringify(FEATURE_TEXT[key])};
            const ps = [...root.querySelectorAll('p, span')].filter(p => (p.textContent || '').includes(needle));
            return { total: ps.length, visible: ps.filter(p => p.getBoundingClientRect().width > 0).length };
        })()`);
        switchResults.push({ label, r, ...vis });
    }
    const allSwitchable = switchResults.every(r => r.r === 'clicked' && r.visible > 0);
    check('5 个页签逐个切换后对应编辑区均可见', allSwitchable,
        switchResults.filter(r => r.r !== 'clicked' || r.visible === 0).map(r => `${r.label}(${r.r}/${r.visible})`).join(' | ') || '全部可见');

    // ═══ ④⑤⑥⑦ 思维链三档（**全部限定在思维链面板内**，避免误点弹窗「✕ 关闭」）═══
    await evaluate(clickExact('思维链'));
    await sleep(300);

    const modesFound = await evaluate(`(() => {
        const panel = ${COT_PANEL};
        if (!panel) return { err: 'no-cot-panel' };
        const norm = ${NORM};
        const t = [...panel.querySelectorAll('button')].map(b => norm(b.textContent));
        return { all: t, hasDefault: t.includes('默认版'), hasCustom: t.includes('自定义'), hasOff: t.includes('关闭') };
    })()`);
    check('思维链三档按钮齐全（默认版 / 自定义 / 关闭）',
        modesFound.hasDefault === true && modesFound.hasCustom === true && modesFound.hasOff === true,
        modesFound.err || (modesFound.all || []).join(' / '));

    /** 读思维链面板内 textarea 状态（只读？长度？） */
    const cotArea = () => evaluate(`(() => {
        const panel = ${COT_PANEL};
        if (!panel) return { err: 'no-cot-panel' };
        const tas = [...panel.querySelectorAll('textarea')].filter(t => t.getBoundingClientRect().width > 0);
        const ro = tas.find(t => t.hasAttribute('readonly'));
        const editable = tas.find(t => !t.hasAttribute('readonly'));
        return {
            visibleCount: tas.length,
            readonlyCount: tas.filter(t => t.hasAttribute('readonly')).length,
            readonlyLen: ro ? ro.value.length : -1,
            editableLen: editable ? editable.value.length : -1,
            hasOffText: (panel.textContent || '').includes('已关闭'),
            hasCustomHint: (panel.textContent || '').includes('留空则自动回退到内置默认版')
        };
    })()`);

    const st1 = await cotArea();
    check('默认档 → 只读展示（readonly）且内容非空', st1.readonlyCount >= 1 && st1.readonlyLen > 100,
        st1.err || `只读框 ${st1.readonlyCount} 个 / 长度 ${st1.readonlyLen}`);
    const cot1 = await evaluate(`window.__jskDiag.aiTag.cot()`);
    check('引擎侧确认「默认档」注入的是内置默认版', cot1.mode === 'default' && cot1.len > 100,
        `mode=${cot1.mode} len=${cot1.len}`);

    // 切「自定义」（限定面板内）
    const customClick = await evaluate(clickCotMode('自定义'));
    await sleep(350);
    const st2 = await cotArea();
    check('切「自定义」→ 编辑区可写（无 readonly）且已预填默认版',
        customClick === 'clicked' && st2.readonlyCount === 0 && st2.editableLen > 100,
        `${customClick} / 只读 ${st2.readonlyCount} 个 / 可写长度 ${st2.editableLen}`);
    check('自定义档有「留空回退默认版」说明', st2.hasCustomHint === true);
    const cot2 = await evaluate(`window.__jskDiag.aiTag.cot()`);
    check('引擎侧确认「自定义档」已生效（非默认档）', cot2.mode === 'custom', `mode=${cot2.mode} len=${cot2.len}`);

    // 切「关闭」（限定面板内 —— ⚠️ 绝不能命中弹窗右上角「✕ 关闭」）
    const offClick = await evaluate(clickCotMode('关闭'));
    await sleep(350);
    const st3 = await cotArea();
    const modalStillOpen = await evaluate(`!!${MODAL_ROOT}`);
    check('切「关闭」→ 显示「已关闭」文案且无编辑框', offClick === 'clicked' && st3.hasOffText === true && st3.visibleCount === 0,
        `${offClick} / 可见 textarea ${st3.visibleCount} 个`);
    check('点「关闭档」未误关弹窗（弹窗仍打开）', modalStillOpen === true);
    const cot3 = await evaluate(`window.__jskDiag.aiTag.cot()`);
    check('引擎侧确认「关闭档」注入为空', cot3.mode === 'off' && cot3.len === 0, `mode=${cot3.mode} len=${cot3.len}`);

    // 恢复默认档（避免污染后续断言）
    await evaluate(clickCotMode('默认版'));
    await sleep(300);

    // ═══ ⑨⑩ 徽标联动（仅 LLM 层 → 出现；非仅 LLM → 消失）═══
    await evaluate(clickContains('执行管线'));
    await sleep(350);

    const badgeOn = await evaluate(`(async () => {
        const d = window.__jskDiag;
        const layers = d.aiTag.setLayers(false, false, true);   // ①关 ②关 ③开
        await new Promise(r => setTimeout(r, 450));
        const root = ${MODAL_ROOT};
        const t = root ? (root.textContent || '') : '';
        return { hasBadge: t.includes('仅 LLM 层启动'), hasCotTag: t.includes('思维链'), layers, llmOnly: d.aiTag.llmOnly() };
    })()`);
    check('「仅 LLM 层」→ 出现分角色徽标', badgeOn.hasBadge === true,
        `layers=${JSON.stringify(badgeOn.layers)} llmOnly=${badgeOn.llmOnly}`);
    check('徽标内显示思维链档位', badgeOn.hasCotTag === true);

    const badgeOff = await evaluate(`(async () => {
        const d = window.__jskDiag;
        d.aiTag.setLayers(true, false, true);   // 打开规则层 → 不再是「仅 LLM」
        await new Promise(r => setTimeout(r, 450));
        const root = ${MODAL_ROOT};
        const t = root ? (root.textContent || '') : '';
        return { hasBadge: t.includes('仅 LLM 层启动'), llmOnly: d.aiTag.llmOnly() };
    })()`);
    check('「规则+LLM」→ 徽标消失（条件正确，非恒显）', badgeOff.hasBadge === false, `llmOnly=${badgeOff.llmOnly}`);

    // ═══ ① 渲染期错误 ═══
    const realErrors = consoleErrors.filter(e => !/favicon|DevTools|Autofill|net::ERR/i.test(e));
    check('无渲染期 console error', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '干净');

    const failed = results.filter(r => !r.ok);
    console.log(`\n════════ 结果：通过 ${results.length - failed.length} / 失败 ${failed.length} ════════`);
    if (failed.length) { console.log('失败项：\n' + failed.map(f => '  - ' + f.n).join('\n')); }
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('探针异常：', e.message); process.exit(1); });
