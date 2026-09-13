/**
 * 测卡工作区侧边栏 独立 Electron 端到端实测（CDP）
 *
 * 用法：
 *   npx electron . --disable-gpu --remote-debugging-port=9333
 *   $env:CDP_PORT="9333"; node scripts/chat-sidebar-test.mjs
 *
 * 断言：
 *   A 侧边栏在「聊天测试」Tab 内挂载
 *   B 7 个分区 tab 全部渲染
 *   C 每个分区点击后内容真的渲染（分区特征词命中）且侧边栏不被卸载
 *   D 预设下拉读取桌面预设库
 *   E chatStore IPC 往返可用（真实 preload 通道）
 *   H 长期记忆 memory:* 通道往返可用（add / stats / list / search / remove，探针用完即删）
 *   F 底部状态条显示「已恢复」（证明 hydrate 成功）
 *   G 全程无渲染层报错
 *
 * 设计说明：
 *   - 黑盒 DOM 驱动。该生产构建下 `app._instance` 为 null、元素无 `__vueParentComponent`，
 *     Vue 内部实例不可达，只能以 DOM 为准（这对 UI 验收反而更贴近用户视角）。
 *   - 分区 tab 行用「7 个直接子元素依次等于 7 个分区标签」严格匹配。
 *     不能用松匹配：主界面左侧资源管理器也有一个多 Tab 行，误点它会把测卡 Tab 整个卸载。
 *   - 不破坏用户数据：chatStore 探针键用完即删。
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const CDP_LIST = `http://127.0.0.1:${PORT}/json/list`;
const SECTIONS = ['⚙ 配置', '🧩 正则', '🌍 世界书', '📊 变量', '💬 聊天', '🎛 设置', '🔌 插件'];
const SECTION_FEATURES = {
    '⚙ 配置': ['参数覆盖'],
    '🧩 正则': ['生效正则'],
    '🌍 世界书': ['世界书条目'],
    '📊 变量': ['MVU 变量树'],
    '💬 聊天': ['新建聊天'],
    '🎛 设置': ['Endpoint'],
    '🔌 插件': ['JSON 扩展插件']
};

let sock; let msgId = 0; const pending = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
    const list = await (await fetch(CDP_LIST)).json();
    const page = list.find((t) => t.type === 'page' && /^(app:\/\/|http:\/\/localhost:5173)/.test(t.url || ''));
    if (!page) throw new Error('未找到 app:// 或 localhost:5173 target；可见: ' + list.map((t) => t.url).join(' | '));
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
/** 执行表达式并返回原始值（异常返回 {__exc}） */
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result && r.result.value;
}
/** 执行返回 JSON 字符串的表达式并解析 */
async function run(expr) {
    const raw = await evaluate(expr);
    if (raw && typeof raw === 'object' && raw.__exc) return raw;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return { __parseError: String(raw).slice(0, 200) }; }
}

/** 分区 tab 行定位（严格匹配，见文件头说明） */
const TAB_ROW = `(() => {
    const L = ${JSON.stringify(SECTIONS)};
    return [...document.querySelectorAll('div')].find(d =>
        d.children.length === L.length &&
        L.every((s, i) => (d.children[i].textContent || '').trim() === s)) || null;
})()`;

const DRAWER = `document.querySelector('div.border-l.bg-zinc-950')`;

const ENTER_CHAT = `(async () => {
    const leaf = (t) => [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === t);
    const has = () => !!(${DRAWER});
    if (has()) return JSON.stringify({ ok: true, already: true });
    if (!leaf('💬 聊天测试')) {
        // 优先「有世界书」的卡（列表项带 🌍 徽标）；本库一张都没有时兜底为任意带封面的卡
        // （2026-09-13 实测：E:\AI\酒馆工具\角色卡 75 张小库无 🌍 徽标 → 旧写法卡在 no-card-row）
        const card = [...document.querySelectorAll('div.cursor-pointer')].find(d => (d.textContent || '').includes('🌍'))
            || [...document.querySelectorAll('div.cursor-pointer')].find(d => d.querySelector('img'));
        if (!card) return JSON.stringify({ ok: false, step: 'no-card-row' });
        card.click();
        await new Promise(r => setTimeout(r, 3000));
    }
    // 先切走再切回，强制聊天 Tab remount（重复点已是当前值的 Tab 不会 remount）
    const away = leaf('📖 基础设定') || leaf('💻 Raw JSON');
    if (away) { away.click(); await new Promise(r => setTimeout(r, 800)); }
    const ct = leaf('💬 聊天测试');
    if (!ct) return JSON.stringify({ ok: false, step: 'no-chat-tab' });
    ct.click();
    await new Promise(r => setTimeout(r, 2000));
    return JSON.stringify({ ok: has(), step: 'remounted' });
})()`;

const READ_SECTIONS = `(() => {
    const row = ${TAB_ROW};
    return JSON.stringify({ count: row ? row.children.length : 0, labels: row ? [...row.children].map(c => (c.textContent || '').trim()) : [] });
})()`;

function clickSection(label) {
    return `(async () => {
        const row = ${TAB_ROW};
        if (!row) return JSON.stringify({ clicked: false, reason: 'no-tab-row' });
        const tab = [...row.children].find(c => (c.textContent || '').trim() === ${JSON.stringify(label)});
        if (!tab) return JSON.stringify({ clicked: false, reason: 'no-such-tab' });
        tab.click();
        await new Promise(r => setTimeout(r, 430));
        const box = ${DRAWER};
        const text = box ? (box.innerText || '') : '';
        const feats = ${JSON.stringify(SECTION_FEATURES[label] || [])};
        return JSON.stringify({
            clicked: true,
            drawerAlive: !!box,
            textLen: text.length,
            featureHits: feats.filter(f => text.includes(f)).length,
            featureTotal: feats.length
        });
    })()`;
}

const READ_PRESET_SELECT = `(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => (o.textContent || '').includes('（不使用预设）')));
    if (!sel) return JSON.stringify({ found: false });
    return JSON.stringify({ found: true, optionCount: sel.options.length });
})()`;

/**
 * 聊天头部：旧 API 栏（API: / Key: / Model: / 拉取模型）必须已移除。
 * ⚠️ 「功能是否搬到侧栏」的检查必须**先切到侧栏「设置」分区** ——
 *    抽屉各分区是 v-show/v-if 切换的，停在别的分区时设置项根本不在 DOM 里。
 */
const READ_CHAT_HEADER = `(() => {
    const inputs = [...document.querySelectorAll('input')];
    const endpointInputs = inputs.filter(i => (i.placeholder || '').includes('127.0.0.1:1234'));
    const passwordInputs = inputs.filter(i => i.type === 'password');
    const pullButtons = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('拉取模型'));
    const oldLabels = [...document.querySelectorAll('span')]
        .map(s => (s.textContent || '').trim())
        .filter(t => t === 'API:' || t === 'Key:' || t === 'Model:');
    return JSON.stringify({
        oldEndpointInputs: endpointInputs.length,
        oldPasswordInputs: passwordInputs.length,
        oldPullButtons: pullButtons.length,
        oldLabels
    });
})()`;

/** 切到侧栏「设置」分区后，确认 API 配置项确实搬过去了（不是被删没了） */
const READ_DRAWER_SETTINGS = `(() => {
    const drawer = document.querySelector('div.border-l.bg-zinc-950');
    if (!drawer) return JSON.stringify({ drawerAlive: false, hasEndpointInput: false, hasModelInput: false, hasTypeSelect: false });
    const inputs = [...drawer.querySelectorAll('input')];
    const selects = [...drawer.querySelectorAll('select')];
    const text = drawer.innerText || '';
    return JSON.stringify({
        drawerAlive: true,
        hasEndpointInput: inputs.some(i => (i.value || '').startsWith('http') || (i.placeholder || '').includes('http')),
        hasModelInput: inputs.some(i => /model/i.test(i.className) || (i.value || '') === '') && text.includes('模型'),
        hasTypeSelect: selects.some(s => [...s.options].some(o => (o.textContent || '').includes('Anthropic'))),
        hasMemNotice: text.includes('记忆') || text.includes('长期记忆')
    });
})()`;

const READ_FOOTER = `(() => {
    const box = ${DRAWER};
    const text = box ? (box.innerText || '') : '';
    return JSON.stringify({
        drawerAlive: !!box,
        hasRecovered: text.includes('已恢复'),
        hasRecovering: text.includes('恢复中'),
        tail: text.slice(-90)
    });
})()`;

const STORAGE_ROUNDTRIP = `(async () => {
    const api = window.electronAPI;
    if (!api || typeof api.loadChatStore !== 'function' || typeof api.saveChatStore !== 'function')
        return JSON.stringify({ ok: false, reason: 'chatStore 通道未暴露' });
    const before = await api.loadChatStore();
    const probeKey = '__jsk_probe__' + Date.now();
    const payload = Object.assign({}, (before && before.data) || {});
    payload[probeKey] = 'probe-value';
    const saved = await api.saveChatStore(payload);
    await new Promise(r => setTimeout(r, 450));
    const after = await api.loadChatStore();
    const roundtrip = !!(after && after.data && after.data[probeKey] === 'probe-value');
    delete payload[probeKey];
    await api.saveChatStore(payload);
    await new Promise(r => setTimeout(r, 350));
    const cleaned = await api.loadChatStore();
    return JSON.stringify({
        ok: !!(saved && saved.success) && roundtrip,
        saveSuccess: !!(saved && saved.success),
        roundtrip,
        cleanedUp: !(cleaned && cleaned.data && probeKey in cleaned.data)
    });
})()`;

const MEMORY_ROUNDTRIP = `(async () => {
    const api = window.electronAPI;
    if (!api || typeof api.memoryAdd !== 'function')
        return JSON.stringify({ ok: false, reason: 'memory:* 通道未暴露' });
    const probe = '探针记忆' + Date.now();
    const before = await api.memoryStats();
    const add = await api.memoryAdd({ type: 'fact', key: '探针键', content: probe });
    const afterAdd = await api.memoryStats();
    const list = await api.memoryList({ type: 'fact', limit: 50 });
    const listed = ((list && list.items) || []).some((it) => it.content === probe);
    const search = await api.memorySearch({ query: probe, limit: 5 });
    const found = ((search && search.items) || []).some((it) => it.content === probe);
    // 去重：同内容再写一次不应增加条数（合并更新时间戳）
    const dup = await api.memoryAdd({ type: 'fact', key: '探针键', content: probe });
    const afterDup = await api.memoryStats();
    const merged = !!(dup && dup.merged) && afterDup.total === afterAdd.total;
    await api.memoryRemove(add.id);
    const cleaned = await api.memoryStats();
    return JSON.stringify({
        ok: !!(add && add.success) && listed && found && merged,
        addSuccess: !!(add && add.success),
        listed, found, merged,
        totalBefore: before && before.total,
        totalAfterAdd: afterAdd && afterAdd.total,
        cleanedUp: (cleaned && cleaned.total) === (before && before.total),
        byType: afterAdd && afterAdd.byType
    });
})()`;

async function main() {
    await connect(await getWs());
    await send('Runtime.enable');

    const errors = [];
    sock.addEventListener('message', (ev) => {
        try {
            const m = JSON.parse(ev.data);
            if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 150));
            if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(String(m.params.entry.text).slice(0, 150));
        } catch (e) { /* 忽略 */ }
    });
    await send('Log.enable').catch(() => {});
    await wait(800);

    const out = { steps: {} };

    out.steps.enter = await run(ENTER_CHAT);
    if (!out.steps.enter.ok) { console.log(JSON.stringify(out, null, 2)); console.log('\n❌ 未能进入测卡工作区'); process.exit(1); }

    out.steps.sections = await run(READ_SECTIONS);
    // 头部断言（旧 API 栏在任何分区都不该存在）
    out.steps.chatHeader = await run(READ_CHAT_HEADER);
    // ⚠️ 顺序有讲究：预设下拉在「配置」分区，API 配置项在「设置」分区 ——
    //    抽屉用 v-show 切换，停在别的分区就读不到对应元素。先配置、再设置。
    await run(clickSection('⚙ 配置'));
    out.steps.presetSelect = await run(READ_PRESET_SELECT);
    await run(clickSection('🎛 设置'));
    out.steps.drawerSettings = await run(READ_DRAWER_SETTINGS);
    out.steps.storage = await run(STORAGE_ROUNDTRIP);
    out.steps.memory = await run(MEMORY_ROUNDTRIP);

    out.tabs = [];
    for (const label of SECTIONS) {
        const r = await run(clickSection(label));
        out.tabs.push(Object.assign({ label }, r));
    }

    out.steps.footer = await run(READ_FOOTER);
    out.errors = errors.slice(0, 8);

    const tabsOk = out.tabs.length === 7
        && out.tabs.every((t) => t.clicked && t.drawerAlive === true && (t.featureHits || 0) >= 1 && !t.__exc);
    // 头部：旧 API 栏必须已移除；且功能已搬到侧栏「设置」分区（不是丢了）
    const h = out.steps.chatHeader;
    const ds = out.steps.drawerSettings;
    const headerOk = h.oldEndpointInputs === 0 && h.oldPasswordInputs === 0
        && h.oldPullButtons === 0 && h.oldLabels.length === 0
        && ds.drawerAlive && ds.hasEndpointInput && ds.hasTypeSelect;
    const pass = out.steps.enter.ok
        && out.steps.sections.count === 7
        && out.steps.presetSelect.found && out.steps.presetSelect.optionCount > 1
        && headerOk
        && out.steps.storage.ok && out.steps.storage.cleanedUp
        && out.steps.memory.ok && out.steps.memory.cleanedUp
        && tabsOk
        && out.steps.footer.drawerAlive && out.steps.footer.hasRecovered
        && out.errors.length === 0;

    console.log(JSON.stringify(out, null, 2));
    console.log(pass ? '\n✅ 测卡工作区侧边栏端到端实测通过（7/7 分区）' : '\n❌ 存在未通过项');
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
