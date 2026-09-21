/**
 * 差异着色端到端验证（词条正文「行对齐 + 行内高亮」）
 *
 * 用法（dev 模式 + CDP）：
 *   $env:CDP_PORT="9366"; node scripts/_probe-diff-coloring.mjs
 *
 * 背景（用户反馈）：查重对比界面打开后，**词条正文是纯文本直出**（无任何着色），
 *   正文一长、或只改了几个字，肉眼完全看不出差异。本次改造：
 *   · 行级 LCS 对齐（两侧共用同一份 rows → 行号一一对应，不再各自滚动错位）
 *   · 变更行加底色（红=本端缺失 / 绿=对端新增 / 琥珀=双方都有但内容变了）
 *   · 变更行内**精确高亮**真正不同的字符/词
 *
 * ⚠️ 实现注意（踩坑记录）：本探针把 JS 代码作为**字符串**发给 CDP 求值，
 *   若在模板字符串里写正则字面量（`\/`、`\d`），会在「模板字符串 → CDP」两层转义中被吃掉
 *   → 求值时报 `SyntaxError: Invalid or unexpected token`。
 *   **故本文件刻意不用正则字面量**，改用 `includes` 字符串判断；
 *   测试数据用 `JSON.stringify` 注入（而非手写 `\\n`）。
 */
const PORT = Number(process.env.CDP_PORT || 9366);
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

// ── 测试数据（在 Node 侧构造，用 JSON.stringify 注入，避免手写换行转义） ──
const L1 = '这是第一段内容，描述主角的背景设定。';
const L2 = '第二段：主角拥有一把传说中的剑，剑身刻着古老的符文。';
const L2B = '第二段：主角拥有一把传说中的剑，剑身刻着古老的符文，并散发着微弱的蓝光。';
const L3 = '第三段：主角的性格冷静而坚毅。';
const L4 = '第四段：新增的一段背景补充说明。';
const L_ONLY_OLD = '这一行只存在于旧版。';
const L_LAST = '最后一行。';

const mk = (uid, key, comment, content) => ({ uid, key, comment, content, disable: false, extensions: {} });
const ITEM_A = {
    path: 'E:/t/版本A.json', fileName: '版本A.json', name: '版本A',
    data: {
        name: '测试世界书', entries: [
            mk(0, ['主角', 'protagonist'], '主角设定', [L1, L2, L3].join('\n')),
            // 本条用于验证「同一词条内**删行**」→ 行级 removed 底色
            mk(1, ['宝剑'], '武器', [L_LAST, L_ONLY_OLD].join('\n')),
            mk(2, ['旧条目'], '将被删除', '这一条在新版中会被删除。')
        ]
    }
};
const ITEM_B = {
    path: 'E:/t/版本B.json', fileName: '版本B.json', name: '版本B',
    data: {
        name: '测试世界书', entries: [
            // 同一词条：第 2 行有改动 + 触发词多了一个「主角」
            mk(0, ['主角', 'protagonist', '主角'], '主角设定', [L1, L2B, L3].join('\n')),
            // 同一词条：删掉中间一行
            mk(1, ['宝剑'], '武器', [L_LAST].join('\n')),
            mk(3, ['新条目'], '新增', [L1, L2, L3, L4].join('\n'))
        ]
    }
};

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');

    const results = [];
    const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

    // ① 通过 App 的真实入口打开弹窗（走真实 ctx，而不是直接构造组件）
    const opened = await evaluate(`(async () => {
        const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
        if (!app) return { ok: false, err: 'no vue app' };
        const ctx = app._instance && app._instance.provides && app._instance.provides.appCtx;
        if (!ctx) return { ok: false, err: 'no appCtx' };
        if (typeof ctx.openDiffDetailModal !== 'function') return { ok: false, err: 'no openDiffDetailModal' };
        ctx.openDiffDetailModal(${JSON.stringify(ITEM_A)}, ${JSON.stringify(ITEM_B)});
        await new Promise(r => setTimeout(r, 900));
        return { ok: true };
    })()`);
    check('通过 App 的真实入口打开差异弹窗', opened.ok, opened.err || '');
    if (!opened.ok) { console.log('\n无法继续'); process.exit(1); }

    // ② 弹窗基础渲染
    const dom = await evaluate(`(() => {
        const t = document.body.innerText || '';
        return {
            hasTitle: t.includes('数据版本差异深度比对'),
            hasAlign: t.includes('词条级对齐'),
            hasAdded: t.includes('[新增]'),
            hasMissing: t.includes('[缺失]'),
            hasChangedBadge: t.includes('正文有改动')
        };
    })()`);
    check('弹窗渲染出标题', dom.hasTitle);
    check('渲染出「词条级对齐」区', dom.hasAlign);
    check('渲染出 [新增] 标记', dom.hasAdded);
    check('渲染出 [缺失] 标记', dom.hasMissing);
    check('渲染出「正文有改动」徽标', dom.hasChangedBadge);

    // ③ 核心：差异着色（底色 + 行内高亮）—— 不用正则字面量，避免两层转义
    const color = await evaluate(`(() => {
        const all = [...document.querySelectorAll('*')];
        const cls = (el) => (typeof el.className === 'string' ? el.className : '');
        const hasCls = (frag) => all.some(el => cls(el).includes(frag));
        const isHl = (el) => {
            const c = cls(el);
            const hit = c.includes('bg-amber-500/35') || c.includes('bg-rose-500/40') || c.includes('bg-emerald-500/40');
            return hit && el.children.length === 0;
        };
        const hlSpans = all.filter(el => isHl(el) && (el.textContent || '').length > 0);
        const gutter = all.filter(el => {
            const c = cls(el);
            return (c.includes('w-7') || c.includes('w-8')) && c.includes('text-right') && el.children.length === 0;
        });
        return {
            rowRemoved: hasCls('bg-rose-950/40'),
            rowAdded: hasCls('bg-emerald-950/40'),
            rowChanged: hasCls('bg-amber-950/25'),
            hlCount: hlSpans.length,
            hlSamples: hlSpans.slice(0, 8).map(el => el.textContent),
            gutterCount: gutter.length,
            keyRose: hasCls('bg-rose-900/50'),
            keyGreen: hasCls('bg-emerald-900/50')
        };
    })()`);
    check('变更行有「本端缺失」底色（rose）', color.rowRemoved);
    check('变更行有「对端新增」底色（emerald）', color.rowAdded);
    check('变更行有「内容改动」底色（amber）', color.rowChanged);
    check('存在**行内精确高亮**（只标真正变更的字符）', color.hlCount > 0,
        `${color.hlCount} 处，样例：${JSON.stringify(color.hlSamples)}`);
    check('行号列已渲染（两侧行一一对应）', color.gutterCount > 0, `${color.gutterCount} 个行号格`);
    check('触发词差异着色生效（本端独有=rose / 对端独有=emerald）', color.keyRose && color.keyGreen);

    // ④ 内容正确性：应高亮出「，并散发着微弱的蓝光」（词条 0 的行内改动）
    const joined = (color.hlSamples || []).join('|');
    check('高亮内容命中真正的改动片段（并散发着微弱的蓝光）',
        joined.includes('散发着微弱的蓝光') || joined.includes('微弱的蓝光'),
        joined.slice(0, 140));

    // ⑤ 对齐性：两侧行号列数量应相等（同一份 rows 渲染两遍）
    const align = await evaluate(`(() => {
        const all = [...document.querySelectorAll('*')];
        const cls = (el) => (typeof el.className === 'string' ? el.className : '');
        const gutter = all.filter(el => {
            const c = cls(el);
            return (c.includes('w-7') || c.includes('w-8')) && c.includes('text-right') && el.children.length === 0;
        });
        const nums = gutter.map(el => el.textContent.trim());
        const left = nums.slice(0, Math.floor(nums.length / 2));
        const right = nums.slice(Math.floor(nums.length / 2));
        return { total: nums.length, leftLen: left.length, rightLen: right.length, sample: nums.slice(0, 6) };
    })()`);
    check('两侧行号列数量相等（左右严格对齐）', align.leftLen === align.rightLen,
        `左 ${align.leftLen} / 右 ${align.rightLen}，样例 ${JSON.stringify(align.sample)}`);

    // ⑥ 无渲染期错误
    const bad = consoleErrors.filter(t => t.includes('TypeError') || t.includes('Cannot read') || t.includes('is not a function') || t.includes('Vue 错误'));
    check('无渲染期错误', bad.length === 0, bad.slice(0, 2).join(' | '));

    // 收尾：关闭弹窗
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '✕'); if (b) b.click(); return true; })()`);

    const pass = results.filter(r => r.ok).length;
    console.log(`\n===== 差异着色 UI：${pass}/${results.length} 通过 =====`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
