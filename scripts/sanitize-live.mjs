/**
 * sanitizeImportedTags 开关「真实导入」热测试驱动（CDP 连 Electron 渲染进程）
 * 用法（顺序）：
 *   node scripts/sanitize-live.mjs probe                 # 探测状态 / __vue_app__ 可达性
 *   node scripts/sanitize-live.mjs set <true|false>      # 置开关（场景切换）
 *   node scripts/sanitize-live.mjs import <json...>      # 注入文件 input 触发真实导入并轮询出现
 *   node scripts/sanitize-live.mjs check <name> [name...] # 读回卡片状态 + 全局池是否含外来标签
 * 依赖：Node ≥22（内置 WebSocket）、Electron --remote-debugging-port=9222 已启动。
 */
const CDP_HTTP = 'http://127.0.0.1:9222/json/list';
const DEBUG = process.env.DBG === '1';

async function getPageWs() {
    const res = await fetch(CDP_HTTP);
    const list = await res.json();
    const page = list.find(t => t.type === 'page' && /localhost:5173/.test(t.url || ''));
    if (!page) throw new Error('未找到 localhost:5173 页面 target（Electron 未就绪？）');
    return page.webSocketDebuggerUrl;
}

let msgId = 0;
const pending = new Map();
let sock;

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = () => resolve();
        sock.onerror = (e) => reject(new Error('WS error'));
        sock.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        };
    });
}

function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sock.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EvalException: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
}

// 构建读取卡片状态/全局池的表达式（传回 JSON 字符串）
// ⚠️ setupState 是 proxyRefs：ref/computed 属性访问时已自动解包为 .value，直接读属性即可
function stateExpr(names, foreignTags) {
    return `(() => {
        const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
        const st = app && app._instance && app._instance.setupState;
        const sv = st && st.sanitizeImportedTags;
        const sVal = (sv && typeof sv === 'object' && 'value' in sv) ? sv.value : sv;
        const L = (st && st.library) || [];
        const pool = (st && st.globalAvailableTags) || [];
        const out = { sanitize: typeof sVal === 'undefined' ? 'UNREACH' : !!sVal, libLen: (L && L.length) || 0 };
        out.cards = {};
        for (const n of ${JSON.stringify(names)}) {
            const it = L.find(x => x.name === n);
            if (!it) { out.cards[n] = null; continue; }
            const d = (it.data && it.data.data) || it.data || {};
            const nt = Array.isArray(d.tags) ? d.tags : (typeof d.tags === 'string' ? d.tags.split(',').map(s => s.trim()).filter(Boolean) : d.tags);
            out.cards[n] = { category: it.category, customTags: it.customTags || [], nativeTags: nt };
        }
        out.poolHasForeign = {};
        for (const t of ${JSON.stringify(foreignTags)}) out.poolHasForeign[t] = pool.includes(t);
        return JSON.stringify(out);
    })()`;
}

async function importFiles(absPaths, expectNames) {
    const { root } = await send('DOM.getDocument');
    const q = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"][accept*=".png"]' });
    if (!q.nodeId) throw new Error('未找到 import 文件 input（accept 含 .png）');
    await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: absPaths });
    // 轮询等待目标卡出现在 library
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const s = await evaluate(stateExpr(expectNames, []));
        const o = JSON.parse(s);
        const allThere = expectNames.every(n => o.cards[n] && o.cards[n].customTags !== undefined);
        if (allThere) return JSON.parse(await evaluate(stateExpr(expectNames, [])));
        await new Promise(r => setTimeout(r, 500));
    }
    return JSON.parse(await evaluate(stateExpr(expectNames, [])));
}

const A_FOREIGN = ['外部标签Alpha', 'ForeignJunkA', '外来垃圾TagA', '外部标签Beta', 'ForeignJunkB'];
const B_FOREIGN = ['外来杂质TagX', 'ForeignPolluteX', '他人乱标签P', '外来杂质TagY', 'ForeignPolluteY'];

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    const wsUrl = await getPageWs();
    await connect(wsUrl);
    await send('Runtime.enable');
    await send('DOM.enable');

    if (cmd === 'probe') {
        const r = await evaluate(`(() => {
            const el = document.querySelector('#app');
            const app = el && el.__vue_app__;
            const inst = app && app._instance;
            const st = inst && inst.setupState;
            const stKeys = st ? Object.keys(st) : [];
            return JSON.stringify({
                hasEl: !!el, elKeys: el ? Object.keys(el) : [],
                hasApp: !!app, hasInst: !!inst,
                stKeys: stKeys.slice(0, 60),
                hasSanitize: st ? ('sanitizeImportedTags' in st) : false,
                hasLibrary: st ? ('library' in st) : false,
                hasGlobal: st ? ('globalAvailableTags' in st) : false,
                sanitizeVal: (st && st.sanitizeImportedTags) ? st.sanitizeImportedTags.value : null,
                libLen: (st && st.library && st.library.value) ? st.library.value.length : null
            });
        })()`);
        console.log(r);
    } else if (cmd === 'set') {
        const val = args[0] === 'true';
        const r = await evaluate(`(() => { const st = document.querySelector('#app').__vue_app__._instance.setupState; st.sanitizeImportedTags = ${val}; return JSON.stringify({ now: st.sanitizeImportedTags }); })()`);
        console.log('set →', r);
    } else if (cmd === 'import') {
        const expectNames = args.filter(a => !a.endsWith('.json'));
        const files = args.filter(a => a.endsWith('.json'));
        if (!files.length) throw new Error('需传入 .json 绝对路径');
        const st = await importFiles(files, expectNames);
        console.log(st);
    } else if (cmd === 'check') {
        const names = args;
        const foreign = names.some(n => n.includes('-A')) ? A_FOREIGN : B_FOREIGN;
        const r = await evaluate(stateExpr(names, foreign));
        console.log(r);
    } else if (cmd === 'remove-tests') {
        // 🧹 清理测试残留：从内存 library 移除 SanitizeTest-* 测试卡（磁盘文件已单独删除）
        const r = await evaluate(`(() => {
            const st = document.querySelector('#app').__vue_app__._instance.setupState;
            const L = st.library || [];
            const keep = L.filter(x => !String((x && x.name) || '').startsWith('SanitizeTest-'));
            const removed = L.length - keep.length;
            if (removed > 0) st.library = keep;
            return JSON.stringify({ removed, remaining: keep.length });
        })()`);
        console.log('remove-tests →', r);
    } else {
        console.log('未知命令');
    }
    sock.close();
}

main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1); });
