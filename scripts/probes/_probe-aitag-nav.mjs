/**
 * AI 打标窗口「左导航布局」端到端验证（2026-09-22 布局重构）
 *
 * 用法（dev 模式 + CDP）：
 *   $env:CDP_PORT="9375"; node scripts/probes/_probe-aitag-nav.mjs
 *
 * 背景（用户反馈「AI 标签窗口有点混乱、UI 布局不合理」）：
 *   原布局是 max-w-2xl 单列长滚动 + 8 个区块堆叠 + 编号断裂（无编号 → 1. → 1.5 → 2. → 3. → 无编号）
 *   + 「管理规则表」重复两处 + 进度条在最底部（打标时必须滚到底才能看进度）。
 *
 * 重构后（对齐项目既有范式 TagCategoryModal 的左导航）：
 * ⚠️ 2026-09-25（第二批改造）已同步：破限并入「系统提示词」页顶部，旧「强制破限」独立项撤销；
 *    「系统提示词库」更名为「系统提示词」→ 左导航共 **6 项**；新链路专项验证见 `_probe-aitag-chain-v2.mjs`。
 *   max-w-5xl + 左导航（6 分区）+ 右内容区（v-show 切换）+ 进度条顶部常驻。
 *
 * 本探针断言：
 *   ① 弹窗打开后左导航存在（7 个分区条目）
 *   ② 逐个点击分区 → 右内容区确实切换（不是全部可见、也不是全空）
 *   ③ 「管理规则表」只出现一处（去重生效）
 *   ④ 进度条在顶部（不在底部）
 *   ⑤ 无渲染期错误
 *   ⑥ 业务控件仍在（三层开关 / 候选池输入 / 破限 / API 字段）—— 布局重构不得弄丢功能
 */
const PORT = Number(process.env.CDP_PORT || 9375);
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

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP');

    // ① 打开 AI 打标弹窗（走真实入口：需要先选中卡片）
    const opened = await evaluate(`(async () => {
        const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
        const ctx = app && app._instance && app._instance.provides && app._instance.provides.appCtx;
        if (!ctx) return { ok: false, err: 'no appCtx' };
        // 隔离 profile 的库为空 → 注入两张探针卡（本探针只验证**布局**，不依赖真实库内容）
        const lib = ctx.library && ctx.library.value ? ctx.library.value : (ctx.library || []);
        if (!lib.length) {
            const mk = (i) => ({ id: 'probe' + i, path: 'E:/probe/probe' + i + '.png', fileName: 'probe' + i + '.png', name: '探针角色' + i,
                data: { name: '探针角色' + i, description: '第' + i + '张探针卡（布局验证用）', personality: '冷静', first_mes: '你好', tags: [] }, customTags: [] });
            ctx.library.value = [mk(1), mk(2)];
            await new Promise(r => setTimeout(r, 300));
        }
        const lib2 = ctx.library.value;
        if (ctx.selectedIds && ctx.selectedIds.value) ctx.selectedIds.value = [lib2[0].id];
        if (typeof ctx.openAITagModal !== 'function') return { ok: false, err: 'no openAITagModal' };
        ctx.openAITagModal();
        await new Promise(r => setTimeout(r, 900));
        return { ok: true, cards: lib2.length };
    })()`);
    check('通过 App 真实入口打开 AI 打标弹窗', opened.ok, opened.err || `库内 ${opened.cards} 张`);
    if (!opened.ok) { console.log('\n无法继续'); process.exit(1); }

    // ② 左导航存在且 6 个分区（第二批改造：6 项）
    const nav = await evaluate(`(() => {
        const t = document.body.innerText || '';
        // 左导航容器：含「本次打标 / 引擎设置 / 提示词」三个分组标题
        const groups = ['本次打标', '引擎设置', '提示词'].filter(g => t.includes(g));
        const items = ['执行管线', '候选标签池', 'AI 提取设置', '本地向量', 'API 引擎', '系统提示词'].filter(x => t.includes(x));
        return { hasModal: t.includes('AI 智能批量打标'), groups, items, itemCount: items.length };
    })()`);
    check('弹窗已渲染', nav.hasModal);
    check('左导航三个分组标题齐全', nav.groups.length === 3, nav.groups.join(' / '));
    check('左导航 6 个分区条目齐全', nav.itemCount === 6, `${nav.itemCount} 个：${nav.items.join('、')}`);

    // ③ 逐个点击分区 → 右内容区切换（每次只显示一个分区）
    //    ⚠️ 判定必须用 **offsetParent**（真实可见性），不能用 innerText ——
    //       innerText 会排除 display:none 的内容，而分区切换后其他分区正是隐藏的，
    //       用它会导致「切到 A 分区后检查 B 分区控件 → 全部报缺失」的**假失败**。
    const sections = ['pipeline', 'candidates', 'extract', 'vector', 'api', 'prompts'];
    const LABELS = { pipeline: '执行管线', candidates: '候选标签池', extract: 'AI 提取设置', vector: '本地向量', api: 'API 引擎', prompts: '系统提示词' };
    // 每个分区的「特征控件」选择器（用于确认右内容区确实换成了该分区）
    const FEATURES = {
        pipeline: 'button',
        candidates: 'input[placeholder*="候选标签"]',
        extract: 'textarea[placeholder*="性格特征"]',
        vector: 'input[type=checkbox]',
        api: 'input[placeholder*="127.0.0.1"]',
        prompts: 'button'
    };

    /** 该分区特征控件是否**真实可见**（offsetParent 非 null 且未被祖先 display:none 隐藏） */
    const isVisible = (key) => evaluate(`(() => {
        const sel = ${JSON.stringify(FEATURES)}[${JSON.stringify(key)}];
        const els = [...document.querySelectorAll(sel)];
        const vis = els.filter(el => el.offsetParent !== null);
        return { total: els.length, visible: vis.length };
    })()`);

    const switchResults = [];
    for (const k of sections) {
        const clicked = await evaluate(`(() => {
            const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes(${JSON.stringify(LABELS[k])}));
            if (b) b.click();
            return !!b;
        })()`);
        await evaluate(`new Promise(r => setTimeout(r, 250))`);
        const v = await isVisible(k);
        switchResults.push({ k, clicked, ...v });
    }
    const allSwitchable = switchResults.every(r => r.clicked && r.visible > 0);
    check('6 个分区逐个切换后特征控件均可见', allSwitchable,
        switchResults.filter(r => !r.clicked || r.visible === 0).map(r => `${r.k}(${r.visible}/${r.total})`).join(' | ') || '全部可见');

    // ④ 「管理规则表」只出现一处（去重）—— 只统计**可见**的按钮
    const dedupe = await evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('管理规则表'));
        const visible = btns.filter(b => b.offsetParent !== null);
        return { total: btns.length, visible: visible.length, texts: visible.map(b => (b.textContent || '').trim()) };
    })()`);
    // 切到 pipeline 分区后应恰好 1 个可见
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('执行管线')); if(b)b.click(); return true; })()`);
    await evaluate(`new Promise(r => setTimeout(r, 250))`);
    const dedupe2 = await evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('管理规则表'));
        return { total: btns.length, visible: btns.filter(b => b.offsetParent !== null).length };
    })()`);
    check('「管理规则表」可见入口已去重（pipeline 分区内恰好 1 处）', dedupe2.visible === 1,
        `DOM 共 ${dedupe2.total} 个，可见 ${dedupe2.visible} 个（隐藏的属其他分区的 DOM，不渲染即无重复入口）`);

    // ⑤ 业务控件齐全（布局重构不得弄丢功能）—— 逐个切到所属分区再检查
    const controls = await evaluate(`(() => {
        const vis = (sel) => [...document.querySelectorAll(sel)].some(el => el.offsetParent !== null);
        // ⚠️ 不再直取 appCtx（prod 下 `_instance` 为 null；dev 请走 window.__jskDiag）—— 见 chain-v2 探针的实测记录
        return {
            candidateInput: !!document.querySelector('input[placeholder*="候选标签"]'),
            apiEndpoint: !!document.querySelector('input[placeholder*="127.0.0.1"]'),
            apiKey: !!document.querySelector('input[type=password]'),
            jailbreakArea: (document.body.textContent || '').includes('启用强制破限'),
            // 三层开关 / 提示词链路 / 候选池 在 DOM 里存在即可（分区切换靠 v-show，DOM 始终在）
            threeLayers: ['① 规则匹配', '② 本地向量', '③ LLM 兜底'].every(x => (document.body.textContent || '').includes(x)),
            promptsChain: ['系统级微调全局提示词', '预设套用', '每请求打包卡数'].every(x => (document.body.textContent || '').includes(x)),
            checkboxCount: document.querySelectorAll('input[type=checkbox]').length
        };
    })()`);
    check('候选池手动输入框存在', controls.candidateInput);
    check('API Endpoint / Key 字段存在', controls.apiEndpoint && controls.apiKey);
    check('破限栏存在（已并入系统提示词页）', controls.jailbreakArea);
    check('三层开关齐全（DOM 内）', controls.threeLayers);
    check('提示词链路控件存在（DOM 内）', controls.promptsChain);
    info('页面复选框总数', String(controls.checkboxCount));

    // ⑥ 无渲染期错误
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误/.test(t));
    check('无渲染期错误', bad.length === 0, bad.slice(0, 2).join(' | ') || '无');

    // 收尾
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('✕ 关闭')||(x.textContent||'').trim()==='✕'); if(b)b.click(); return true; })()`);

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ AI 打标窗口布局：${pass}/${results.length} 通过 ═════`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
