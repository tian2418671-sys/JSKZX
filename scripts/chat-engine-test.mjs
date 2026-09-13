/**
 * 测卡编排引擎 端到端实测（CDP，dev 模式）
 *
 * 用法：
 *   1) npx vite                                              （另开终端）
 *   2) $env:VITE_DEV_SERVER_URL="http://localhost:5173"
 *      npx electron . --disable-gpu --remote-debugging-port=9334
 *   3) $env:CDP_PORT="9334"; node scripts/chat-engine-test.mjs
 *
 * 断言编排管线（不依赖真实 LLM：只验证「送到模型前」的装配，以及本地渲染/swipe）：
 *   A 引擎在 dev 模式暴露调试句柄
 *   B 宏上下文：{{char}}/{{user}}/{{persona}} 取自卡片与设置
 *   C 世界书：常驻条目注入 + 触发词命中
 *   D EJS：<% %> 模板在开关开启时被执行
 *   E buildPayload：无预设时的经典兜底结构（system + messages）
 *   F buildPayload：有预设时走预设装配（含 chatHistory 占位符）
 *   G 分段渲染：```html 围栏 → html 段；纯文本 → text 段
 *   H 会话与 swipe：开场白入会话；nextSwipe 切换候选
 *
 * ⚠️ 该脚本只在 dev 模式可用（调试句柄 `window.__jskChatEngine` 由
 *    `import.meta.env.PROD` 守卫，生产构建不挂载）。
 */
const PORT = Number(process.env.CDP_PORT || 9334);
const CDP_LIST = `http://127.0.0.1:${PORT}/json/list`;
let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(CDP_LIST)).json();
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

/** 打开一张卡并进入聊天 Tab，等引擎句柄就绪 */
const BOOT = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const leaf = (t) => [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === t);
    const dl = Date.now() + 30000;
    while (Date.now() < dl && !document.body.innerText.includes('卡片列表')) await sleep(400);
    if (!leaf('💬 聊天测试')) {
        // 优先选「有世界书」的卡（列表项文本带 🌍 徽标）——世界书断言需要它；
        // 本库若一张都没有，则退回「任意带封面的卡」并把 wbCard:false 带回，
        // 让世界书断言**显式标注跳过**，而不是默默选一张没世界书的卡最后报一个令人迷惑的失败。
        const wbCard = [...document.querySelectorAll('div.cursor-pointer')].find(d => (d.textContent || '').includes('🌍'));
        const card = wbCard || [...document.querySelectorAll('div.cursor-pointer')].find(d => d.querySelector('img'));
        if (!card) return JSON.stringify({ ok: false, step: 'no-card' });
        window.__jskEngineHadWbCard = !!wbCard;
        card.click();
        await sleep(3000);
    }
    // 先切走再切回 → 强制聊天 Tab 挂载并触发 initChat
    const away = leaf('📖 基础设定') || leaf('💻 Raw JSON');
    if (away) { away.click(); await sleep(700); }
    const ct = leaf('💬 聊天测试');
    if (ct) { ct.click(); await sleep(1800); }
    const dl2 = Date.now() + 10000;
    while (Date.now() < dl2 && !window.__jskChatEngine) await sleep(300);
    return JSON.stringify({
        ok: !!window.__jskChatEngine,
        hasChatTab: !!ct,
        wbCard: window.__jskEngineHadWbCard !== false,
        cardName: (window.__jskChatEngine && window.__jskChatEngine.macros()['{{char}}']) || ''
    });
})()`;

const T_MEMORY = `(async () => {
    const api = window.electronAPI;
    if (!api || typeof api.memoryAdd !== 'function') return JSON.stringify({ available: false });
    // 用真实模块实例构建记忆上下文（与引擎同一份契约；不 import 引擎本体以免双实例陷阱）
    const mem = await import('/js/composables/chat/useChatMemory.js');
    mem.setMemoryEnabled(true);
    const probe = '记忆注入探针' + Date.now();
    const add = await api.memoryAdd({ type: 'fact', key: '探针键', content: probe });
    const ctx = await mem.buildMemoryContext(probe);
    const injected = typeof ctx === 'string' && ctx.includes('记忆表格') && ctx.includes(probe);
    await api.memoryRemove(add && add.id);
    const after = await mem.buildMemoryContext(probe);
    return JSON.stringify({
        available: true,
        added: !!(add && add.success),
        injected,
        ctxLen: (ctx || '').length,
        removedFromContext: !String(after || '').includes(probe)
    });
})()`;

// 常驻条目重试：首张带世界书的卡可能只有「关键词触发」条目（无常驻）——
// 那是**卡片数据差异**而非缺陷，此时自动换下一张带世界书的卡再试（最多 5 张）。
const WB_RETRY = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fs = window.__jskChatEngine;
    const cards = [...document.querySelectorAll('div.cursor-pointer')].filter(d => (d.textContent || '').includes('🌍'));
    let tried = 0; let found = false; let card = '';
    for (const c of cards.slice(0, 5)) {
        c.click();
        await sleep(2600);
        const txt = fs.collectActivatedWbText('完全不相关的输入文本xyz') || '';
        tried++;
        if (txt.includes('### 世界书设定')) { found = true; card = (c.innerText || '').split('\\n')[0]; break; }
    }
    return JSON.stringify({ tried, found, card, totalWbCards: cards.length });
})()`;

const T_MACROS = `(() => {
    const m = window.__jskChatEngine.macros();
    return JSON.stringify({
        char: m['{{char}}'] || '',
        user: m['{{user}}'] || '',
        hasPersona: '{{persona}}' in m,
        hasDescription: '{{description}}' in m,
        keyCount: Object.keys(m).length
    });
})()`;

const T_WORLDBOOK = `(() => {
    const eng = window.__jskChatEngine.engine;
    const msgs = eng.chatMessages.value;
    // 直接调编排层函数：命中判定不依赖真实发信
    const constantOnly = window.__jskChatEngine.collectActivatedWbText('完全不相关的输入文本xyz');
    const keywordHit = window.__jskChatEngine.collectActivatedWbText('测试');
    // 本卡到底有没有内嵌世界书（dev 下可直达 setupState）——区分「卡里没有」与「有但未注入」
    let hasCharacterBook = null; let bookEntries = null;
    try {
        const ss = document.querySelector('#app').__vue_app__._instance.setupState;
        const cd = ss && ss.cardData;
        const d = cd && (cd.data || cd);
        const book = d && d.character_book;
        hasCharacterBook = !!book;
        if (book) {
            const e = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
            bookEntries = e.length;
        }
    } catch (e) { /* 拿不到就算 null（不做判定） */ }
    return JSON.stringify({
        hasConstantSection: constantOnly.includes('### 世界书设定'),
        constantLen: constantOnly.length,
        keywordLen: keywordHit.length,
        keywordAtLeastAsLong: keywordHit.length >= constantOnly.length,
        hasCharacterBook, bookEntries
    });
})()`;

const T_EJS = `(() => {
    const r = window.__jskChatEngine.renderTpl('值=<%= 1 + 2 %>', '自测');
    const plain = window.__jskChatEngine.renderTpl('没有模板语法', '自测');
    return JSON.stringify({ ejsRendered: r, ejsWorks: r.includes('3'), plainUnchanged: plain === '没有模板语法' });
})()`;

const T_PAYLOAD_NO_PRESET = `(async () => {
    const fs = window.__jskChatEngine;
    const eng = fs.engine;
    // 临时清掉激活预设，走经典兜底分支
    const mod = await import('/js/composables/chat/useChatPresets.js');
    const saved = mod.loadActivePreset();
    mod.clearActivePreset();
    await new Promise(r => setTimeout(r, 60));
    const p = await fs.buildPayload('openai', {});
    // 还原
    if (saved && saved.data) mod.saveActivePreset(saved.data);
    const msgs = p.messages || [];
    return JSON.stringify({
        model: p.model,
        msgCount: msgs.length,
        hasSystem: msgs.some(m => m.role === 'system'),
        streamFalse: p.stream === false,
        firstRole: msgs[0] && msgs[0].role,
        hasMacroLeak: JSON.stringify(msgs).includes('{{char}}')
    });
})()`;

/**
 * 预设装配分支：必须走**真实 UI 路径**（侧栏下拉选预设），不能自己 `import()` 引擎模块。
 * 原因（实测踩过）：CDP 里 `import('/js/...')` 会另建一份模块实例，其 chatStorage 与
 * 应用模块图里的那份是**两个独立 Map**，于是「测试里存上了、引擎读不到」
 * （诊断字段 sameInstanceSees=true / engineSees=false 就是这个现象）。
 * 走 UI → 与引擎同一实例 → 验的是真实行为。
 */
const T_PAYLOAD_WITH_PRESET = `(async () => {
    const fs = window.__jskChatEngine;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const savedName = (fs.engine.activePreset.value && fs.engine.activePreset.value.name) || '';
    // 找侧栏「配置」分区的预设下拉（第一项文案是「（不使用预设）」）
    const sel = [...document.querySelectorAll('select')].find(s =>
        [...s.options].some(o => (o.textContent || '').includes('（不使用预设）')));
    if (!sel) return JSON.stringify({ ok: false, reason: '未找到预设下拉（侧栏未挂载？）' });
    const target = [...sel.options].find(o => o.value && o.value !== '');
    if (!target) return JSON.stringify({ ok: false, reason: '预设下拉里没有可选预设' });
    // 选预设 → 触发侧栏 onPresetSelect → saveActivePreset（与应用同一模块实例）
    // 🔬 先验证「dispatch change 能否触发 Vue 的 @change 处理器」：
    //    置空 → 若 lsRaw 由有变无，说明处理器确实被调用（否则是测试没驱动到）
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const lsAfterClear = (() => { try { return localStorage.getItem(lsKey); } catch (e) { return 'ERR'; } })();
    const clearWorked = lsAfterClear === null || lsAfterClear === '';
    // 再选目标预设
    sel.value = target.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    // 🔬 三方取证：下拉当前值 / localStorage 原值 / 侧栏显示的预设名
    const lsKey = 'jsmobile-active-preset';
    const lsRaw = (() => { try { return localStorage.getItem(lsKey); } catch (e) { return 'ERR'; } })();
    const drawerText = (() => {
        const box = document.querySelector('div.border-l.bg-zinc-950');
        return box ? (box.innerText || '').slice(0, 120) : '';
    })();
    const engineSees = !!(fs.engine.activePreset.value && fs.engine.activePreset.value.data);
    const promptCount = engineSees ? (fs.engine.activePreset.value.data.prompts || []).length : 0;
    const p = await fs.buildPayload('openai', {});
    const pA = await fs.buildPayload('anthropic', {});
    const msgs = p.messages || [];
    const sysText = (msgs.find(m => m.role === 'system') || {}).content || '';
    // 还原为测试前的预设，避免破坏用户选择
    if (savedName) {
        const back = [...sel.options].find(o => (o.textContent || '').includes(savedName));
        if (back) { sel.value = back.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); }
    } else {
        const none = [...sel.options].find(o => !o.value);
        if (none) { sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); }
    }
    return JSON.stringify({
        engineSees, promptCount,
        enginePresetType: fs.engine.activePreset.value === null ? 'null' : typeof fs.engine.activePreset.value,
        enginePresetKeys: fs.engine.activePreset.value ? Object.keys(fs.engine.activePreset.value).join(',') : '',
        enginePresetName: fs.engine.activePreset.value ? String(fs.engine.activePreset.value.name) : '',
        clearWorked, lsAfterClearLen: typeof lsAfterClear === 'string' ? lsAfterClear.length : -1,
        selectedValue: target.value,
        selectedText: (target.textContent || '').trim(),
        lsRawLen: typeof lsRaw === 'string' ? lsRaw.length : -1,
        drawerText,
        presetBranchUsed: engineSees && msgs.length > 1 && typeof p.temperature === 'number',
        macroAppliedInPreset: !sysText.includes('{{char}}'),
        hasHistoryInjected: msgs.length >= 2,
        anthropicHasSystemField: typeof pA.system === 'string' && pA.system.length >= 0,
        anthropicNoSystemRole: !(pA.messages || []).some(m => m.role === 'system')
    });
})()`;

const T_SEGMENTS = `(() => {
    const fs = window.__jskChatEngine;
    const textSeg = fs.segmentsOf({ role: 'assistant', swipes: ['普通 **加粗** 文本'], index: 0 });
    const htmlSeg = fs.segmentsOf({ role: 'assistant', swipes: ['前言\\n\\n\`\`\`html\\n<div>面板</div>\\n\`\`\`'], index: 0 });
    return JSON.stringify({
        textTypes: textSeg.map(s => s.type),
        htmlTypes: htmlSeg.map(s => s.type),
        htmlHasHtmlSeg: htmlSeg.some(s => s.type === 'html'),
        textHasTextSeg: textSeg.some(s => s.type === 'text')
    });
})()`;

const T_SESSION_SWIPE = `(async () => {
    const fs = window.__jskChatEngine;
    const eng = fs.engine;
    await new Promise(r => setTimeout(r, 200));
    const before = JSON.parse(JSON.stringify(eng.chatMessages.value));
    const openingRoles = before.map(m => m.role);
    // 造一条多候选 assistant 消息，验证 swipe 切换
    eng.chatMessages.value.push({ role: 'assistant', swipes: ['候选A', '候选B'], index: 0 });
    const idx = eng.chatMessages.value.length - 1;
    eng.nextSwipe(idx);
    await new Promise(r => setTimeout(r, 50));
    const afterNext = eng.chatMessages.value[idx].index;
    eng.prevSwipe(idx);
    await new Promise(r => setTimeout(r, 50));
    const afterPrev = eng.chatMessages.value[idx].index;
    // 清理这条测试消息，避免污染用户会话
    eng.chatMessages.value.splice(idx, 1);
    return JSON.stringify({
        sessionIdPresent: !!eng.activeSessionId.value,
        openingRoles,
        swipeNext: afterNext,
        swipePrev: afterPrev,
        swipeWorks: afterNext === 1 && afterPrev === 0
    });
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');
    const errors = [];
    sock.addEventListener('message', (ev) => {
        try {
            const m = JSON.parse(ev.data);
            if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 160));
        } catch (e) { /* 忽略 */ }
    });
    await wait(1000);

    const out = {};
    out.boot = await run(BOOT);
    if (!out.boot.ok) { console.log(JSON.stringify(out, null, 2)); console.log('\n❌ 调试句柄不可用（需 dev 模式）'); process.exit(1); }

    out.macros = await run(T_MACROS);
    out.worldbook = await run(T_WORLDBOOK);
    // 首卡无常驻条目（数据差异）→ 自动换下一张带世界书的卡重试，避免把数据问题当缺陷报
    if (out.worldbook && out.worldbook.hasConstantSection === false && out.boot.wbCard !== false) {
        out.wbRetry = await run(WB_RETRY);
        if (out.wbRetry && out.wbRetry.found) out.worldbook.hasConstantSection = true;
    }
    out.ejs = await run(T_EJS);
    out.payloadNoPreset = await run(T_PAYLOAD_NO_PRESET);
    out.payloadWithPreset = await run(T_PAYLOAD_WITH_PRESET);
    out.segments = await run(T_SEGMENTS);
    out.sessionSwipe = await run(T_SESSION_SWIPE);
    out.memory = await run(T_MEMORY);
    out.errors = errors.slice(0, 8);

    const wbSkipped = out.boot.wbCard === false;
    const wbNoBook = !!(out.worldbook && out.worldbook.hasCharacterBook === false);
    const pass =
        out.boot.ok
        && !!out.macros.char && !!out.macros.user && out.macros.hasPersona && out.macros.hasDescription
        // 世界书断言：本卡没有内嵌世界书（hasCharacterBook===false）时**无可验证**，显式跳过不误判；
        && (wbNoBook || out.worldbook.hasConstantSection)
        && out.ejs.ejsWorks && out.ejs.plainUnchanged
        && out.payloadNoPreset.hasSystem && out.payloadNoPreset.streamFalse && !out.payloadNoPreset.hasMacroLeak
        && out.payloadWithPreset.engineSees
        && out.payloadWithPreset.presetBranchUsed && out.payloadWithPreset.macroAppliedInPreset
        && out.payloadWithPreset.hasHistoryInjected && out.payloadWithPreset.anthropicHasSystemField && out.payloadWithPreset.anthropicNoSystemRole
        && out.segments.textHasTextSeg && out.segments.htmlHasHtmlSeg
        && out.sessionSwipe.sessionIdPresent && out.sessionSwipe.swipeWorks
        && out.memory.available && out.memory.added && out.memory.injected && out.memory.removedFromContext
        && out.errors.length === 0;

    console.log(JSON.stringify(out, null, 2));
    if (wbSkipped) console.log('\n⚠️ 本库无「带世界书」的卡 → 世界书注入断言已跳过（换一张带世界书的卡或换库可完整验证）');
    else if (wbNoBook) console.log('\n⚠️ 当前卡无内嵌世界书（character_book 缺失）→ 世界书注入断言无对象，已跳过（换一张带世界书的卡可完整验证）');
    else if (out.wbRetry && out.wbRetry.found) console.log(`\nℹ️ 首卡无常驻世界书条目（数据差异），已自动换卡验证：换到「${out.wbRetry.card}」后命中常驻注入（共试 ${out.wbRetry.tried} 张）`);
    else if (!out.worldbook.hasConstantSection) console.log(`\n⚠️ 试过 ${out.wbRetry ? out.wbRetry.tried : 1} 张带世界书的卡都没找到「常驻」条目 → 世界书常驻注入本次未验证`);
    console.log(pass ? '\n✅ 测卡编排引擎端到端实测通过' + (wbSkipped ? '（世界书断言跳过）' : '') : '\n❌ 存在未通过项');
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
