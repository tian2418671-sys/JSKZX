/**
 * 卡内插件页签 端到端实测（CDP，黑盒 DOM）
 *
 * 用法：
 *   ① 起实例（隔离 profile 更稳）：
 *      npm run build:web
 *      npx electron . --disable-gpu --remote-debugging-port=9351 --user-data-dir="%TEMP%\jsk-cp-profile"
 *   ② 跑脚本：
 *      $env:CDP_PORT="9351"; node scripts/tools/card-plugins-test.mjs
 *
 * 可选环境变量：
 *   PLUGIN_CARD_TERMS  用来搜索「带插件卡」的关键词表（逗号分隔），默认 BeiPai,Crooked,Kora,万象,乡村
 *   TEST_ADD="1"       额外验证「空容器卡 → 一键新建脚本」（只改内存、不点保存；默认跳过）
 *   ADD_CARD_TERMS     空容器卡候选词（默认 双臀,Blind Wife）
 *
 * 断言：
 *   A 卡片编辑器页签栏里存在「🧩 插件」
 *   B 点开后插件面板渲染，且页签徽标数字 == 可见脚本条目数
 *   C 展开一条脚本 → 内嵌代码编辑器挂载（行号槽 .cm-gutters + 工具栏「✨ 格式化」）
 *   D ⛶ 放大 → 全屏弹窗（遮罩铺满视口、编辑器在弹窗内）+ Esc 可关闭
 *   E 只读分组（助手变量 / MVU 变量组 / 第三方扩展数据）能展开查看（该卡有才验）
 *   F（TEST_ADD=1）空容器卡：空态文案正确 + 「➕ 添加脚本」后条目与徽标 +1
 *   G 全程无渲染层报错（`[Vue 错误]` / ReferenceError / TypeError）
 *
 * 设计说明与踩过的坑：
 *   - **黑盒 DOM 驱动**：生产构建里拿不到 Vue 实例，DOM 即用户视角（与 chat-sidebar-test.mjs 同思路）。
 *   - **卡片行选择器**必须加「行内含头像 img」：侧栏里标签面板 / 终端日志也是 `div.cursor-pointer.select-none`。
 *   - **页签按钮选择器**用 `button.border-b-2`：侧栏主导航也有个「插件」按钮，误点会切到插件工作区（不是本页签）。
 *   - **不触发原生确认框**：删除脚本走 `dialog.showMessageBox`（DOM 里点不到、contextBridge 也不能被劫持），
 *     所以本脚本不点删除；`TEST_ADD=1` 只新增（内存态），绝不点「保存卡片」。
 *   - 会切换当前打开的卡片（只影响界面状态，不改任何文件）。
 */
const PORT = Number(process.env.CDP_PORT || 9351);
const CDP_LIST = `http://127.0.0.1:${PORT}/json/list`;
const TERMS = (process.env.PLUGIN_CARD_TERMS || 'BeiPai,Crooked,Kora,万象,乡村').split(',').map((s) => s.trim()).filter(Boolean);
const ADD_TERMS = (process.env.ADD_CARD_TERMS || '双臀,Blind Wife').split(',').map((s) => s.trim()).filter(Boolean);
const TEST_ADD = process.env.TEST_ADD === '1';

let sock;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
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
                const p = pending.get(m.id);
                pending.delete(m.id);
                m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
                return;
            }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
                consoleErrors.push(text.slice(0, 300));
            } else if (m.method === 'Runtime.exceptionThrown') {
                const d = m.params.exceptionDetails;
                consoleErrors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 300));
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

async function run(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result && r.result.value;
}

/** 页内公共工具（每次 evaluate 重新注入，避免依赖上次调用的全局状态） */
const HELPERS = `
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = el => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
const click = el => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const cardRows = () => [...document.querySelectorAll('div')].filter(d =>
    d.className && String(d.className).includes('cursor-pointer') && String(d.className).includes('select-none')
    && d.querySelector('img'));
const tabBar = () => [...document.querySelectorAll('button.border-b-2')];
const tabOf = icon => tabBar().find(b => txt(b).startsWith(icon));
const scriptInputs = () => document.querySelectorAll('input[placeholder="脚本名称"]').length;
const panelShown = () => [...document.querySelectorAll('span')].some(s => txt(s) === '🧩 卡内插件（跟随卡片保存）');
const setSearch = async (q) => {
    const input = [...document.querySelectorAll('input')].find(i => /搜索|search/i.test(i.placeholder || ''));
    if (!input) return false;
    input.value = q; input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1500); return true;
};
`;

const problems = [];

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await wait(500);

    console.log(`\n🧩 卡内插件页签 · 端到端实测（port=${PORT}）`);

    // ── 0. 等库加载 ─────────────────────────────────────────────
    const ready = await run(`(async () => { ${HELPERS}
        for (let i = 0; i < 80; i++) { if (cardRows().length) return cardRows().length; await sleep(500); }
        return cardRows().length;
    })()`);
    if (!ready) { console.log('❌ 侧栏没有卡片行（库为空或未加载）'); process.exit(1); }
    console.log(`0. 库已加载：${ready} 行`);

    // ── 1. 找一张「带脚本」的卡 ─────────────────────────────────
    let picked = '';
    let scriptCount = 0;
    for (const term of TERMS) {
        const r = await run(`(async () => { ${HELPERS}
            if (!(await setSearch(${JSON.stringify(term)}))) return 'NO_SEARCH_INPUT';
            const rows = cardRows();
            if (!rows.length) return 'NO_CARD';
            const name = txt(rows[0]).slice(0, 40);
            click(rows[0]);
            await sleep(2500);
            click(tabOf('🧩'));
            await sleep(1200);
            return JSON.stringify({ name, scripts: scriptInputs(), badge: txt(tabOf('🧩')) });
        })()`);
        if (r === 'NO_SEARCH_INPUT' || r === 'NO_CARD') continue;
        const info = JSON.parse(r);
        console.log(`1. 搜索「${term}」→ ${info.name}（脚本 ${info.scripts} 条，页签「${info.badge}」）`);
        if (info.scripts > 0) { picked = info.name; scriptCount = info.scripts; break; }
    }
    if (!scriptCount) problems.push('没找到任何带脚本的卡（可用 PLUGIN_CARD_TERMS 指定搜索词）');

    // ── A/B：页签存在 + 面板渲染 + 徽标一致 ─────────────────────
    const ab = JSON.parse(await run(`(async () => { ${HELPERS}
        const tab = tabOf('🧩');
        if (!tab) return JSON.stringify({ tabMissing: true, tabs: tabBar().map(txt) });
        click(tab);
        await sleep(1000);
        return JSON.stringify({
            tabLabel: txt(tab), shown: panelShown(), rows: scriptInputs(),
            diag: /本卡 extensions 现有键/.test(document.body.innerText),
            readOnlyGroups: [...document.querySelectorAll('div')].map(txt)
                .filter(t => /助手变量数据|MVU 变量组定义|MVU 绑定世界书|第三方扩展数据/.test(t) && t.length < 60).length
        });
    })()`));
    if (ab.tabMissing) problems.push(`A 页签栏里没有「🧩 插件」（现有：${(ab.tabs || []).join(' / ')}）`);
    else {
        const badgeNum = Number((ab.tabLabel.match(/(\d+)/) || [])[1] || 0);
        console.log(`A/B. 页签「${ab.tabLabel}」｜面板渲染=${ab.shown}｜脚本条目=${ab.rows}｜诊断区=${ab.diag}｜只读分组=${ab.readOnlyGroups}`);
        if (!ab.shown) problems.push('B 插件面板未渲染（找不到锚点文案）');
        if (badgeNum !== ab.rows) problems.push(`B 页签徽标(${badgeNum}) 与脚本条目数(${ab.rows}) 不一致`);
    }

    // ── C：展开 → 内嵌 CodeEditor ───────────────────────────────
    const c = JSON.parse(await run(`(async () => { ${HELPERS}
        const before = document.querySelectorAll('.cm-editor').length;
        const btn = [...document.querySelectorAll('button')].find(b => txt(b) === '▼ 展开编辑');
        if (!btn) return JSON.stringify({ expandMissing: true, before });
        click(btn);
        await sleep(1500);
        const box = [...document.querySelectorAll('.cm-editor')][before] || document.querySelector('.cm-editor');
        return JSON.stringify({
            before,
            after: document.querySelectorAll('.cm-editor').length,
            gutters: document.querySelectorAll('.cm-gutters').length,
            formatBtn: [...document.querySelectorAll('button')].some(b => txt(b) === '✨ 格式化'),
            text: (box && box.innerText || '').slice(0, 60)
        });
    })()`));
    console.log(`C. 展开编辑：编辑器 ${c.before} → ${c.after}｜行号槽=${c.gutters}｜格式化按钮=${c.formatBtn}｜内容预览="${(c.text || '').replace(/\n/g, ' ')}"`);
    if (c.expandMissing) problems.push('C 找不到「▼ 展开编辑」按钮（该卡可能没有脚本）');
    else {
        if (c.after <= c.before) problems.push('C 展开后没有挂载内嵌代码编辑器');
        if (!c.gutters) problems.push('C 内嵌编辑器缺行号槽（.cm-gutters）');
        if (!c.formatBtn) problems.push('C 内嵌编辑器缺「✨ 格式化」按钮');
    }

    // ── D：⛶ 放大 → 全屏弹窗 ───────────────────────────────────
    const d = JSON.parse(await run(`(async () => { ${HELPERS}
        const zoom = [...document.querySelectorAll('button')].find(b => txt(b) === '⛶ 放大');
        if (!zoom) return JSON.stringify({ zoomMissing: true });
        click(zoom);
        await sleep(1500);
        const title = [...document.querySelectorAll('span')].find(s => txt(s) === '卡内插件 · 酒馆助手脚本');
        let overlay = null, el = title;
        while (el && el !== document.body) { if (getComputedStyle(el).position === 'fixed') { overlay = el; break; } el = el.parentElement; }
        const out = { opened: !!title, fixed: !!overlay };
        if (overlay) {
            const r = overlay.getBoundingClientRect();
            out.coversViewport = r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;
            out.editorsInDialog = overlay.querySelectorAll('.cm-editor').length;
            out.escHint = /Esc 关闭/.test(overlay.innerText || '');
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(900);
        out.closedByEsc = ![...document.querySelectorAll('span')].some(s => txt(s) === '卡内插件 · 酒馆助手脚本');
        out.editorsAfterClose = document.querySelectorAll('.cm-editor').length;
        return JSON.stringify(out);
    })()`));
    if (d.zoomMissing) problems.push('D 找不到「⛶ 放大」按钮（该卡可能没有脚本）');
    else {
        console.log(`D. 全屏放大：打开=${d.opened}｜fixed 遮罩=${d.fixed}｜铺满视口=${d.coversViewport}｜弹窗内编辑器=${d.editorsInDialog}｜Esc 关闭=${d.closedByEsc}`);
        if (!d.opened) problems.push('D 点「⛶ 放大」后没有出现全屏弹窗');
        if (!d.fixed) problems.push('D 弹窗遮罩不是 fixed 定位（可能被 transform 祖先影响）');
        else if (!d.coversViewport) problems.push('D 弹窗遮罩没有铺满视口');
        if (!d.editorsInDialog) problems.push('D 弹窗内没有代码编辑器');
        if (!d.closedByEsc) problems.push('D Esc 没能关闭弹窗');
    }

    // ── E：只读分组展开 ─────────────────────────────────────────
    const e = JSON.parse(await run(`(async () => { ${HELPERS}
        const view = [...document.querySelectorAll('button')].find(b => txt(b) === '▼ 查看');
        if (!view) return JSON.stringify({ skipped: true });
        click(view);
        await sleep(1200);
        const box = [...document.querySelectorAll('.cm-editor')].filter(el => el.closest('div'));
        return JSON.stringify({ collapsed: [...document.querySelectorAll('button')].some(b => txt(b) === '▲ 收起'), editors: document.querySelectorAll('.cm-editor').length, ro: document.querySelectorAll('.cm-editor[aria-readonly], .cm-content[contenteditable="false"]').length });
    })()`));
    if (e.skipped) console.log('E. 只读分组：该卡没有（跳过）');
    else {
        console.log(`E. 只读分组：可展开=${e.collapsed}｜页面编辑器数=${e.editors}｜只读编辑器=${e.ro}`);
        if (!e.collapsed) problems.push('E 只读分组的「▼ 查看」点了没收起态变化');
    }

    // ── F（可选）：空容器卡 → 一键新建 ─────────────────────────
    if (TEST_ADD) {
        for (const term of ADD_TERMS) {
            const f = await run(`(async () => { ${HELPERS}
                if (!(await setSearch(${JSON.stringify(term)}))) return null;
                const rows = cardRows();
                if (!rows.length) return null;
                click(rows[0]);
                await sleep(2500);
                click(tabOf('🧩'));
                await sleep(1200);
                const createBtn = [...document.querySelectorAll('button')].find(b => txt(b).includes('新建脚本容器'));
                const emptyHint = /没有发现酒馆助手脚本容器/.test(document.body.innerText);
                if (!createBtn) return JSON.stringify({ name: txt(rows[0]).slice(0, 30), emptyHint, createBtn: false });
                click(createBtn);
                await sleep(1200);
                return JSON.stringify({ name: txt(rows[0]).slice(0, 30), emptyHint, createBtn: true, rows: scriptInputs(), badge: txt(tabOf('🧩')) });
            })()`);
            if (!f) continue;
            const info = JSON.parse(f);
            console.log(`F. 空容器卡「${info.name}」：空态提示=${info.emptyHint}｜有新建按钮=${info.createBtn}${info.createBtn ? `｜新建后条目=${info.rows} 徽标「${info.badge}」` : ''}`);
            if (!info.createBtn) continue;
            if (!info.emptyHint) problems.push('F 无容器卡没有显示空态提示');
            if (info.rows !== 1) problems.push(`F 新建脚本后条目数应为 1，实为 ${info.rows}`);
            break;
        }
        console.log('   ⚠️ 已新增 1 条脚本（仅内存，未点保存，不落盘）');
    } else {
        console.log('F. 空容器新建：默认跳过（要测请设 TEST_ADD=1）');
    }

    // ── G：渲染层报错 ───────────────────────────────────────────
    const bad = consoleErrors.filter((t) => /Vue 错误|ReferenceError|TypeError|is not a function/.test(t));
    console.log(`G. 渲染层报错：${bad.length} 条${bad.length ? '\n   ' + bad.slice(0, 5).join('\n   ') : ''}`);
    if (bad.length) problems.push(`G 出现 ${bad.length} 条渲染层报错`);

    console.log('');
    if (problems.length) {
        console.log('❌ 未通过项：');
        for (const p of problems) console.log('   · ' + p);
        process.exit(1);
    }
    console.log(`✅ 卡内插件页签端到端实测通过（带脚本卡：${picked || '未找到'}，${scriptCount} 条脚本）`);
    process.exit(0);
})().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
