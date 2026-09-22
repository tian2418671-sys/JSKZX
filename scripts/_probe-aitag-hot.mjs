/**
 * AI 打标窗口「布局重构」热测探针 · 扩展版（2026-09-22）
 *
 * 用法（dev 模式 + CDP + 隔离 profile + **真实库**）：
 *   $env:CDP_PORT="9375"; node scripts/_probe-aitag-hot.mjs
 *
 * ⚠️ **实例必须以「不节流」参数启动**，否则会出一堆假失败（2026-09-22 实测踩坑）：
 *   .\node_modules\electron\dist\electron.exe . --disable-gpu --disable-renderer-backgrounding `
 *     --disable-backgrounding-occluded-windows --disable-background-timer-throttling \
 *     --remote-debugging-port=9375 --user-data-dir=$env:TEMP\jsk-hot-aitag
 *   原因：窗口被其它窗口遮挡时 `document.visibilityState === 'hidden'`，Chromium **节流 rAF**，
 *   而 Vue 过渡的「加 fade-leave-to 类 + 结束回调」都在 nextFrame(rAF) 里 →
 *   元素永远停在 `fade-leave-from + fade-leave-active`、`display` 不变 →
 *   表现为「弹窗关不掉 / 破限区不隐藏」的假失败（页面重新可见后会自动恢复，非应用缺陷）。
 *   自检：`document.visibilityState` 非 'visible' 时本探针的过渡类断言不可信。
 *
 * 与 _probe-aitag-nav.mjs 的分工：
 *   - nav 探针 = 静态结构（分区在不在、控件丢没丢、入口去没去重）
 *   - 本探针 = **动态行为热测**：徽标联动 / 状态保持 / 分区互斥 / 进度条位置 /
 *              开合循环 / 关闭路径 / 管线全关保护 / 窄窗响应式 / 规则表弹窗 / 副作用
 *
 * ⚠️ 只做**读 + 改配置**（配置落隔离 profile）；绝不点「开始智能打标」（那会写卡）。
 *
 * ── 2026-09-22 首轮热测踩到的 4 个探针自伤（已全部修掉，别退回）──
 *   ① **作用域**：`[...document.querySelectorAll('button')].find(...)` 是**全页面 DOM 顺序**！
 *      HeaderBar 的隐藏菜单项「⚡ API 引擎与模型设置...」排在弹窗内左导航**之前**，
 *      于是 switchTo('API 引擎') 会点开外层 API 配置弹窗 → 干扰后续所有断言。
 *      → 所有查询必须以**弹窗根元素**为作用域（本文件 M_ROOT）。
 *   ② **文案陷阱**：「执行管线」标题 label 的文案含「（① 规则 → ② 本地向量 → ③ LLM 兜底）」，
 *      按文字找 label 会命中**没有 checkbox 的那个** → 必须要求 label 内含 input[type=checkbox]。
 *   ③ **过渡计时**：`.fade-leave-active{transition:opacity .4s}` —— 关闭/隐藏后 DOM 仍留 400ms。
 *      等待 <450ms 会把「正在离场」误判成「没关掉」→ 本文件 WAIT_ANIM = 750ms。
 *   ④ **初始状态假设**：开关初值随用户配置变（useJailbreak 默认可能就是开），
 *      不能假设「点一下就会变开」→ 先读状态，再切到相反值，再断言。
 */
const PORT = Number(process.env.CDP_PORT || 9375);
const WAIT_ANIM = 1200;         // > fade 过渡 400ms（--disable-gpu 下 CPU 合成会拖后 transitionend，留足余量）
const WAIT_TICK = 300;          // 普通状态同步
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
const wait = (ms) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);

/** 轮询等到「某选择器的元素数 == want」（过渡/合成器延迟下比固定等待可靠） */
const waitCount = async (sel, want, timeoutMs = 5000) => {
    const t0 = Date.now();
    for (;;) {
        const n = await evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        if (n === want) return n;
        if (Date.now() - t0 > timeoutMs) return n;
        await wait(200);
    }
};
/** 轮询等到「弹窗内某元素可见性 == want」 */
const waitVisible = async (expr, want, timeoutMs = 5000) => {
    const t0 = Date.now();
    for (;;) {
        const v = await evaluate(expr);
        if (!!v === want) return v;
        if (Date.now() - t0 > timeoutMs) return v;
        await wait(200);
    }
};

/** 弹窗根元素（所有查询的作用域基准；弹窗未开时为 null） */
const M_ROOT = `(document.querySelector('.max-w-5xl') || null)`;

/** 切分区（**只在弹窗内**找左导航按钮） */
const switchTo = async (label) => {
    const ok = await evaluate(`(() => {
        const m = ${M_ROOT}; if (!m) return false;
        const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes(${JSON.stringify(label)}));
        if (b) b.click();
        return !!b;
    })()`);
    await wait(WAIT_TICK);
    return ok;
};
const clickInModal = (label) => evaluate(`(() => {
    const m = ${M_ROOT}; if (!m) return false;
    const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes(${JSON.stringify(label)}));
    if (b) b.click();
    return !!b;
})()`);
const openModal = async () => {
    await evaluate(`(async () => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const lib = ctx.library.value || [];
        ctx.selectedIds.value = ctx.selectedIds.value.length ? ctx.selectedIds.value : [lib[0].id];
        ctx.openAITagModal();
        await new Promise(r => setTimeout(r, 900));
        return true;
    })()`);
    await wait(WAIT_ANIM);
};
/** 关闭弹窗（走状态，最可靠）；返回关闭后残留数 */
const closeModal = async () => {
    await evaluate(`(() => { const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx; ctx.showAITagModal.value = false; return true; })()`);
    await wait(WAIT_ANIM);
    return evaluate(`document.querySelectorAll('.max-w-5xl').length`);
};
/** 右内容区「非 display:none 的直接子块」数量 */
const visibleSections = () => evaluate(`(() => {
    const m = ${M_ROOT}; if (!m) return -1;
    const c = m.querySelector('.flex-1.p-5.overflow-y-auto');
    if (!c) return -1;
    return [...c.children].filter(el => el.style.display !== 'none').length;
})()`);
/** 左导航条目徽标（**只在弹窗内找**；'' = 无徽标） */
const navBadge = (label) => evaluate(`(() => {
    const m = ${M_ROOT}; if (!m) return null;
    const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes(${JSON.stringify(label)}));
    if (!b) return null;
    const badge = b.querySelector('span[class*="ml-auto"]');
    return badge ? (badge.textContent || '').trim() : '';
})()`);

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `port ${PORT}`);

    // ── 0. 打开弹窗（真实入口 + 真实库）
    const opened = await evaluate(`(async () => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const lib = ctx.library.value || [];
        if (!lib.length) return { ok: false, err: '真实库为空（本探针要求真实库）' };
        const ids = ctx.selectedIds.value && ctx.selectedIds.value.length ? ctx.selectedIds.value : [lib[0].id];
        ctx.selectedIds.value = ids;
        ctx.openAITagModal();
        await new Promise(r => setTimeout(r, 900));
        return { ok: true, cards: lib.length, selected: ids.length };
    })()`);
    await wait(WAIT_ANIM);
    check('真实库 + 真实入口打开弹窗', opened.ok, opened.err || `库内 ${opened.cards} 张 / 已选 ${opened.selected} 张`);
    if (!opened.ok) { console.log('\n无法继续'); process.exit(1); }

    // ── 0b. 备份初始状态（收尾还原）
    const backup = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const pick = (k) => { const v = ctx[k]; return v && typeof v === 'object' && 'value' in v ? JSON.parse(JSON.stringify(v.value)) : undefined; };
        return { tagFunnel: pick('tagFunnel'), useJailbreak: pick('useJailbreak'), useLocalVector: pick('useLocalVector'),
                 newAICandidateTag: pick('newAICandidateTag'), selectedIds: pick('selectedIds') };
    })()`);
    info('已备份初始状态', `tagFunnel=${JSON.stringify(backup.tagFunnel)} / useJailbreak=${backup.useJailbreak}`);

    // ── 1. 分区互斥：切到每个分区时右内容区**恰好 1 个**子块可见
    const exclusivity = [];
    for (const [key, label] of [['pipeline', '执行管线'], ['candidates', '候选标签池'], ['extract', 'AI 提取设置'], ['vector', '本地向量'], ['api', 'API 引擎'], ['prompts', '系统提示词库'], ['jailbreak', '强制破限']]) {
        const clicked = await switchTo(label);
        exclusivity.push({ key, clicked, n: await visibleSections() });
    }
    const badEx = exclusivity.filter(r => !r.clicked || r.n !== 1);
    check('七个分区均可切换，且可见块恒为 1（无重叠/无空白）', badEx.length === 0,
        badEx.length ? badEx.map(r => `${r.key}(clicked=${r.clicked},n=${r.n})`).join(' | ') : '7/7 正常');

    // ── 2. 徽标与真实状态一致
    await switchTo('候选标签池');
    const badge = { candidates: await navBadge('候选标签池'), vector: await navBadge('本地向量'), prompts: await navBadge('系统提示词库'), jailbreak: await navBadge('强制破限') };
    const real = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        return { cand: ctx.aiCandidateTags.value.length, presets: ctx.systemPromptPresets.value.length,
                 vec: ctx.useLocalVector.value, jb: ctx.useJailbreak.value };
    })()`);
    check('候选池徽标 == 候选标签真实数量', String(badge.candidates) === String(real.cand || ''), `徽标「${badge.candidates}」/ 实际 ${real.cand}`);
    check('提示词库徽标 == 预设真实数量', String(badge.prompts) === String(real.presets || ''), `徽标「${badge.prompts}」/ 实际 ${real.presets}`);
    check('本地向量徽标 == 开关真实状态', badge.vector === (real.vec ? '开' : ''), `徽标「${badge.vector}」/ 开关 ${real.vec}`);
    check('强制破限徽标 == 开关真实状态', badge.jailbreak === (real.jb ? '开' : ''), `徽标「${badge.jailbreak}」/ 开关 ${real.jb}`);

    // ── 3. 破限开关联动（**先读状态再切到相反值**，最后还原）
    await switchTo('强制破限');
    const jb = await evaluate(`(async () => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const m = ${M_ROOT};
        const cb = m ? [...m.querySelectorAll('input[type=checkbox]')].find(x => {
            const lb = x.closest('label'); return lb && (lb.textContent || '').includes('强制破限');
        }) : null;
        if (!cb) return { ok: false };
        const before = ctx.useJailbreak.value;
        cb.click();
        await new Promise(r => setTimeout(r, 500));
        return { ok: true, before, after: ctx.useJailbreak.value, flipped: ctx.useJailbreak.value !== before };
    })()`);
    await wait(WAIT_ANIM);
    const jbVisible = await waitVisible(`(() => { const m = ${M_ROOT}; const ta = m && m.querySelector('textarea[placeholder*="破限"]'); return !!ta && ta.offsetParent !== null; })()`, jb.after === true);
    const jbBadgeAfter = await navBadge('强制破限');
    check('破限开关点击 → 状态确实翻转（父级收到 emit）', jb.ok && jb.flipped, jb.ok ? `${jb.before} → ${jb.after}` : '未找到开关');
    check('破限开关状态 ↔ 破限文本域可见性一致', jbVisible === jb.after, `开关=${jb.after} 文本域可见=${jbVisible}`);
    check('破限开关状态 ↔ 左导航徽标一致', jbBadgeAfter === (jb.after ? '开' : ''), `徽标「${jbBadgeAfter}」/ 开关 ${jb.after}`);
    await evaluate(`(async () => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const m = ${M_ROOT};
        const cb = [...m.querySelectorAll('input[type=checkbox]')].find(x => { const lb = x.closest('label'); return lb && (lb.textContent||'').includes('强制破限'); });
        if (cb && ctx.useJailbreak.value !== ${JSON.stringify(backup.useJailbreak)}) cb.click();
        await new Promise(r => setTimeout(r, 400));
        return true;
    })()`);
    await wait(WAIT_ANIM);

    // ── 4. 状态保持：改值 → 切走 → 切回 → 值仍在（v-show 保留 DOM）
    await switchTo('候选标签池');
    const typed = '热测占位标签ZZ';
    await evaluate(`(() => {
        const m = ${M_ROOT};
        const inp = m.querySelector('input[placeholder*="手动输入候选标签"]');
        inp.value = ${JSON.stringify(typed)};
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await wait(WAIT_TICK);
    await switchTo('API 引擎');
    await switchTo('执行管线');
    await switchTo('候选标签池');
    const kept = await evaluate(`(() => { const m = ${M_ROOT}; const i = m.querySelector('input[placeholder*="手动输入候选标签"]'); return i ? i.value : null; })()`);
    check('跨分区切换后输入内容保持', kept === typed, `读到「${kept}」`);
    await evaluate(`(() => { const m = ${M_ROOT}; const i = m.querySelector('input[placeholder*="手动输入候选标签"]'); if (i) { i.value=''; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
    await wait(WAIT_TICK);

    // ── 5. 管线全关保护（label 必须**内含 checkbox**，避开标题 label 的文案陷阱）
    await switchTo('执行管线');
    const layers = await evaluate(`(() => {
        const m = ${M_ROOT};
        const find = (t) => [...m.querySelectorAll('label')].find(lb => (lb.textContent || '').includes(t) && lb.querySelector('input[type=checkbox]'));
        const keys = ['① 规则匹配', '② 本地向量', '③ LLM 兜底'];
        const boxes = keys.map(k => { const lb = find(k); return lb ? lb.querySelector('input[type=checkbox]') : null; });
        return { found: boxes.filter(Boolean).length, checked: boxes.map(b => b && b.checked) };
    })()`);
    info('三层开关现状', `${layers.found}/3 个开关，勾选 ${JSON.stringify(layers.checked)}`);
    check('三层开关全部定位到（文案陷阱已避开）', layers.found === 3, `${layers.found}/3`);

    const setLayers = (on) => evaluate(`(() => {
        const m = ${M_ROOT};
        const find = (t) => [...m.querySelectorAll('label')].find(lb => (lb.textContent || '').includes(t) && lb.querySelector('input[type=checkbox]'));
        for (const k of ['① 规则匹配', '② 本地向量', '③ LLM 兜底']) {
            const lb = find(k); const cb = lb && lb.querySelector('input[type=checkbox]');
            if (cb && cb.checked !== ${on}) cb.click();
        }
        return true;
    })()`);

    await setLayers(false);
    await wait(WAIT_ANIM);
    const allOff = await evaluate(`(() => {
        const m = ${M_ROOT};
        const btn = [...m.querySelectorAll('button')].find(b => /开始智能打标|管线已全关/.test(b.textContent || ''));
        const content = m.querySelector('.flex-1.p-5.overflow-y-auto') || m;
        const t = content.textContent || '';
        return { text: btn ? btn.textContent.trim() : null, disabled: btn ? btn.disabled : null,
                 hasWarn: t.includes('三层均已关闭'), hasPreview: t.includes('本次将执行') };
    })()`);
    check('三层全关 → 主按钮禁用', allOff.disabled === true, `disabled=${allOff.disabled}`);
    check('三层全关 → 按钮文案变「🚫 管线已全关」', (allOff.text || '').includes('管线已全关'), `文案「${allOff.text}」`);
    check('三层全关 → 红字警示出现且不再显示「本次将执行」', allOff.hasWarn && !allOff.hasPreview, `warn=${allOff.hasWarn} preview=${allOff.hasPreview}`);

    await setLayers(true);
    await wait(WAIT_ANIM);
    const restored = await evaluate(`(() => {
        const m = ${M_ROOT};
        const btn = [...m.querySelectorAll('button')].find(b => (b.textContent || '').includes('开始智能打标'));
        const t = (m.querySelector('.flex-1.p-5.overflow-y-auto') || m).textContent || '';
        return { enabled: btn ? !btn.disabled : false, text: btn ? btn.textContent.trim() : null, preview: t.includes('本次将执行') };
    })()`);
    check('三层复原 → 主按钮恢复可用且计划预览回归', restored.enabled && restored.preview, `文案「${restored.text}」`);
    await evaluate(`(async () => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const m = ${M_ROOT};
        const find = (t) => [...m.querySelectorAll('label')].find(lb => (lb.textContent || '').includes(t) && lb.querySelector('input[type=checkbox]'));
        const map = { '① 规则匹配': 'rule', '② 本地向量': 'vector', '③ LLM 兜底': 'llm' };
        const want = ${JSON.stringify(backup.tagFunnel)};
        for (const [k, fk] of Object.entries(map)) {
            const lb = find(k); const cb = lb ? lb.querySelector('input[type=checkbox]') : null;
            if (cb && cb.checked !== want[fk]) cb.click();
        }
        await new Promise(r => setTimeout(r, 400));
        return true;
    })()`);
    await wait(WAIT_ANIM);

    // ── 6. 顶部进度条：位于内容区之上（DOM 顺序），且不在底部栏
    const barGeom = await evaluate(`(() => {
        const m = ${M_ROOT};
        const bar = m.querySelector('.bg-blue-50');
        const content = m.querySelector('.flex-1.p-5.overflow-y-auto');
        if (!bar) return { present: false };
        const above = bar.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING;
        return { present: true, visible: bar.offsetParent !== null, aboveContent: !!above,
                 text: (bar.textContent || '').trim().slice(0, 30),
                 inBottomBar: !!bar.closest('.px-5.py-4.bg-gray-50.border-t') };
    })()`);
    if (barGeom.present) {
        check('进度条在内容区之上（非底部栏）', barGeom.aboveContent && !barGeom.inBottomBar, `above=${barGeom.aboveContent} inBottomBar=${barGeom.inBottomBar} 文案「${barGeom.text}」`);
        if (barGeom.text.includes('等待开始')) {
            info('注：未开始打标时进度条也常驻显示', `文案「${barGeom.text}」—— 该 v-if 条件与重构前 HEAD 第 288 行完全一致，非本次引入`);
        }
    } else {
        info('进度条当前未渲染（取决于 v-if 条件）');
    }

    // ── 7. 底部操作栏在各分区都常驻可见
    const badBar = [];
    for (const label of ['执行管线', '候选标签池', 'API 引擎', '系统提示词库', '强制破限']) {
        await switchTo(label);
        const v = await evaluate(`(() => {
            const m = ${M_ROOT};
            const btn = [...m.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '取消');
            const bar = btn && btn.closest('div');
            return { ok: !!bar && bar.offsetParent !== null && !!btn && btn.offsetParent !== null };
        })()`);
        if (!v.ok) badBar.push(label);
    }
    check('底部操作栏（取消/开始）在任意分区都常驻', badBar.length === 0, badBar.join(' | ') || '五分区均可见');

    // ── 8. 关闭路径：取消按钮 / ✕ 关闭 / 开合循环（等待 > 过渡 400ms）
    await switchTo('执行管线');
    await clickInModal('取消');
    let left = await waitCount('.max-w-5xl', 0);
    check('点「取消」→ 弹窗关闭（含过渡结束）', left === 0, `残留 ${left} 个`);

    await openModal();
    await clickInModal('✕ 关闭');
    left = await waitCount('.max-w-5xl', 0);
    check('点「✕ 关闭」→ 弹窗关闭', left === 0, `残留 ${left} 个`);

    let cycleBad = '';
    for (let i = 0; i < 5; i++) {
        await openModal();
        const n = await evaluate(`document.querySelectorAll('.max-w-5xl').length`);
        if (n !== 1) { cycleBad = `第 ${i + 1} 次打开后弹窗数=${n}`; break; }
        await evaluate(`(() => { const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx; ctx.showAITagModal.value = false; return true; })()`);
        const after = await waitCount('.max-w-5xl', 0);
        if (after !== 0) { cycleBad = `第 ${i + 1} 次关闭后残留=${after}`; break; }
    }
    check('开合循环 ×5：无重复堆叠、无残留', !cycleBad, cycleBad || '5 轮全部干净');

    // ── 9. 窄窗响应式（900×620）
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
    await wait(WAIT_TICK);
    await openModal();
    const narrow = await evaluate(`(() => {
        const m = document.querySelector('.max-w-5xl');
        if (!m) return { ok: false };
        const r = m.getBoundingClientRect();
        const nav = m.querySelector('.w-52');
        const content = m.querySelector('.flex-1.p-5.overflow-y-auto');
        const cs = content ? getComputedStyle(content) : null;
        return { ok: true, w: Math.round(r.width), vw: window.innerWidth, h: Math.round(r.height), vh: window.innerHeight,
                 navVisible: !!nav && nav.offsetParent !== null, navW: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
                 overflowY: cs ? cs.overflowY : '',
                 noClip: cs ? (content.scrollHeight <= content.clientHeight || cs.overflowY === 'auto' || cs.overflowY === 'scroll') : false,
                 bottomBarVisible: (() => { const b = [...m.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '取消'); return !!b && b.offsetParent !== null; })(),
                 overflowX: m.scrollWidth > m.clientWidth + 2 };
    })()`);
    check('窄窗(900×620)：弹窗不超视口宽', narrow.ok && narrow.w <= narrow.vw, `${narrow.w} ≤ ${narrow.vw}`);
    check('窄窗：弹窗不超视口高', narrow.ok && narrow.h <= narrow.vh, `${narrow.h} ≤ ${narrow.vh}`);
    check('窄窗：左导航仍可见且未被压扁', narrow.navVisible && narrow.navW >= 200, `宽 ${narrow.navW}px`);
    check('窄窗：内容不会被截断（可滚或未超高）', narrow.noClip === true, `overflowY=${narrow.overflowY}`);
    check('窄窗：底部操作栏仍可见', narrow.bottomBarVisible === true);
    check('窄窗：弹窗无横向溢出', narrow.overflowX === false, `overflowX=${narrow.overflowX}`);
    await send('Emulation.clearDeviceMetricsOverride');
    await wait(WAIT_TICK);
    await closeModal();

    // ── 10.「📝 管理规则表」入口：能打开规则弹窗并关掉
    await openModal();
    await switchTo('执行管线');
    await clickInModal('管理规则表');
    await wait(WAIT_ANIM);
    const rules = await evaluate(`(() => {
        const t = document.body.innerText || '';
        return { opened: t.includes('打标规则') || t.includes('规则表'), layers: document.querySelectorAll('.fixed.inset-0').length };
    })()`);
    check('「管理规则表」能打开规则弹窗', rules.opened === true, `全屏层 ${rules.layers} 个`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await wait(WAIT_ANIM);
    await evaluate(`(() => { const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx; if (ctx.showAutoTagRulesModal) ctx.showAutoTagRulesModal.value = false; return true; })()`);
    await wait(WAIT_TICK);
    await closeModal();
    const leftover = await evaluate(`document.querySelectorAll('.fixed.inset-0.z-50').length`);
    check('规则弹窗与打标弹窗均能关闭（无卡死残留）', leftover === 0, `残留全屏层 ${leftover} 个`);

    // ── 11. 副作用校验：全程不得打开无关弹窗（首轮热测就栽在这里）
    const sideEffect = await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const keys = ['showApiModal', 'showBatchTagModal', 'showAutoGroupModal', 'showDedupeModal', 'showWbImportModal', 'showDiskScanModal'];
        return { opened: keys.filter(k => ctx[k] && ctx[k].value === true) };
    })()`);
    check('全程未误开无关弹窗（作用域校验）', sideEffect.opened.length === 0, sideEffect.opened.join(', ') || '无');

    // ── 12. 还原状态 + 无渲染错误
    await evaluate(`(() => {
        const ctx = document.querySelector('#app').__vue_app__._instance.provides.appCtx;
        const b = ${JSON.stringify(backup)};
        if (b.tagFunnel && ctx.tagFunnel) { for (const k of Object.keys(b.tagFunnel)) if (k in ctx.tagFunnel) ctx.tagFunnel[k] = b.tagFunnel[k]; }
        if (typeof b.useJailbreak === 'boolean' && ctx.useJailbreak) ctx.useJailbreak.value = b.useJailbreak;
        if (typeof b.useLocalVector === 'boolean' && ctx.useLocalVector) ctx.useLocalVector.value = b.useLocalVector;
        if (typeof b.newAICandidateTag === 'string' && ctx.newAICandidateTag) ctx.newAICandidateTag.value = b.newAICandidateTag;
        return true;
    })()`);
    await wait(WAIT_TICK);

    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Unhandled/.test(t));
    check('全程无渲染期错误', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ AI 打标窗口热测：${pass}/${results.length} 通过 ═════`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
