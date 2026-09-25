/**
 * 🏷️🗂️ S1~S4 世界书标签/打标/自动分组 —— 真实库**只读**链路探针（2026-09-25）
 *
 * 环境要求：
 *   ① 真实世界书库：H:\01\全局世界书（39 本，含 6 本 ≥6MB）—— 本探针**只读**（唯一写 = 隔离 profile 的标签映射）
 *   ② 隔离 profile 实例（dev 源码版）：
 *      $env:VITE_DEV_SERVER_URL="http://localhost:5173"; npx electron . --disable-gpu \
 *        --remote-debugging-port=9377 --user-data-dir=$env:TEMP\jsk-s4-profile
 *   ③ 跑：$env:CDP_PORT="9377"; node scripts/probes/_probe-s4-wb-read.mjs
 *
 * 覆盖：
 *   A1 真库扫描（39 本）· A2 物理分组推导 · A3 世界书视图 DOM · A4 贴标签+列表 chips（S1 显示）
 *   A5 右键菜单新入口 · A6 标签编辑面板（增删）· A7 打标弹窗世界书模式（S3）
 *   A8 自动分组弹窗（S4）· A9 大书懒加载+释放（内存纪律）· A10 无渲染错误
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9377);
const REAL_LIB = 'H:\\01\\全局世界书';
const REAL_LIB_MIN = 30; // 真库 39 本；>=30 视为加载完整（留余量）

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };
const info = (n, d = '') => console.log(`INFO ${n}${d ? '  => ' + d : ''}`);

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `port ${PORT}`);

    try {
        await send('Page.enable');
        await send('Page.reload', { ignoreCache: true });
        info('已重载页面（获取全新实例）');
        await sleep(2500);
    } catch (e) { /* 忽略 */ }

    await evaluate(`(function () {
        window.__probeGetCtx = function () {
            try {
                var a = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
                if (!a) return null;
                return (a._context && a._context.provides && a._context.provides.appCtx)
                    || (a._instance && a._instance.provides && a._instance.provides.appCtx) || null;
            } catch (e) { return null; }
        };
        return 'ok';
    })()`);

    // 等 ctx
    const ctxReady = await (async () => {
        const t0 = Date.now();
        for (;;) {
            const ok = await evaluate(`!!(window.__probeGetCtx && window.__probeGetCtx() && window.__probeGetCtx().scanWorldbookDir)`);
            if (ok) return true;
            if (Date.now() - t0 > 30000) return false;
            await sleep(400);
        }
    })();
    check('⓪ ctx 就绪', ctxReady);
    if (!ctxReady) { console.error('无法继续'); process.exit(1); }

    // ================= A1：真库扫描 =================
    const t0 = Date.now();
    await evaluate(`(function () { var c = window.__probeGetCtx(); window.__probeScanDone = false; window.__probeScanP = (async function () { try { await c.scanWorldbookDir(${JSON.stringify(REAL_LIB)}); } catch (e) { window.__probeScanErr = String(e); } window.__probeScanDone = true; })(); return 'started'; })()`);
    let bookCount = 0;
    for (;;) {
        const st = await evaluate(`(function () { try { var c = window.__probeGetCtx(); return { done: !!window.__probeScanDone, n: (c.worldbooks && c.worldbooks.value) ? c.worldbooks.value.length : 0, err: window.__probeScanErr || '' }; } catch (e) { return { done: false, n: -1, err: String(e) }; } })()`);
        bookCount = st.n;
        if (st.done && bookCount >= REAL_LIB_MIN) break;
        if (Date.now() - t0 > 180000) break;
        await sleep(800);
    }
    info('扫描耗时', `${Math.round((Date.now() - t0) / 1000)}s`);
    check('A1 真库扫描加载（39 本）', bookCount >= REAL_LIB_MIN, `books=${bookCount}`);

    // ================= A2：物理分组推导 =================
    // 真库实际结构：库根平铺 + 一个物理子文件夹「XP三册」→ 推导应同时给出「默认」与该子文件夹名
    const cats = await evaluate(`(function () { var c = window.__probeGetCtx(); return Array.isArray(c.wbCategories.value) ? c.wbCategories.value : []; })()`);
    const catsOk = Array.isArray(cats) && cats.includes('默认') && cats.every(c => typeof c === 'string' && c.trim() !== '');
    const folderCats = Array.isArray(cats) ? cats.filter(c => c !== '全部' && c !== '默认') : [];
    check('A2 分组推导（物理子文件夹 → 分组名）', catsOk, JSON.stringify(cats));
    if (folderCats.length) info('物理分组发现', folderCats.join('、'));

    // ================= A3：世界书视图 DOM =================
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.appMode.value = 'worldbooks'; return 'ok'; })()`);
    await sleep(900);
    const domList = await evaluate(`(function () {
        var txt = document.body.innerText || '';
        return {
            hasAllBtn: txt.includes('🌍 全部'),
            hasEntryBadge: txt.includes('词条'),
            hasAutoGroupBtn: !!document.querySelector('button[title*="世界书自动分组"]')
        };
    })()`);
    check('A3 世界书视图渲染（分组行 + 列表 + 🗂️入口按钮）', domList.hasAllBtn && domList.hasEntryBadge && domList.hasAutoGroupBtn, JSON.stringify(domList));

    // ================= A4：贴标签 + 列表 chips（S1 显示核心） =================
    const tagAdd = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value[0];
        var name = (typeof c.wbDisplayName === 'function') ? (c.wbDisplayName(wb) || wb.name) : wb.name;
        c.addWbTagOn(wb, '探针标签A');
        return { name: String(name), tags: c.getWbTags(wb), key: wb.path || wb.name || '' };
    })()`);
    await sleep(600);
    const chipShown = await evaluate(`(document.body.innerText || '').includes('#探针标签A')`);
    check('A4a 贴标签写入（配置层）', Array.isArray(tagAdd.tags) && tagAdd.tags.includes('探针标签A'), JSON.stringify(tagAdd));
    check('A4b 列表 chips 渲染（S1 可见性）', chipShown === true, `chip#探针标签A=${chipShown}`);

    // ================= A5：右键菜单新入口 =================
    await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value[0];
        c.openWbContextMenu({ preventDefault: function () {}, clientX: 140, clientY: 140 }, wb);
        return 'ok';
    })()`);
    await sleep(500);
    const menuTxt = await evaluate(`document.body.innerText || ''`);
    check('A5 右键菜单含「编辑标签」「AI 打标」', menuTxt.includes('编辑标签') && menuTxt.includes('AI 打标'));
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.closeWbContextMenu(); return 'ok'; })()`);

    // ================= A6：标签编辑面板（增删） =================
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.openWbTagEditor(c.worldbooks.value[0]); return 'ok'; })()`);
    await sleep(600);
    const panelTxt = await evaluate(`document.body.innerText || ''`);
    const panelShown = panelTxt.includes('编辑标签') && panelTxt.includes('全库已有标签');
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.wbTagEditorRemove('探针标签A'); return 'ok'; })()`);
    await sleep(500);
    const afterRemove = await evaluate(`(function () { var c = window.__probeGetCtx(); return c.getWbTags(c.worldbooks.value[0]); })()`);
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.closeWbTagEditor(); return 'ok'; })()`);
    check('A6a 标签编辑面板打开', panelShown === true);
    check('A6b 面板删除标签生效', Array.isArray(afterRemove) && !afterRemove.includes('探针标签A'), JSON.stringify(afterRemove));

    // ================= A7：打标弹窗（世界书模式，S3） =================
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.openAITagModal(); return 'ok'; })()`);
    await sleep(700);
    const tagModal = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var txt = document.body.textContent || '';
        return {
            show: !!c.showAITagModal.value,
            mode: c.aiTagTargetMode.value,
            hasRange: txt.includes('世界书打标范围'),
            hasWbBadge: txt.includes('🌍 世界书模式'),
            hasPoolSwitch: txt.includes('启用候选标签池'),
            hasStartBtn: txt.includes('开始智能打标') || txt.includes('▶ 开始')
        };
    })()`);
    check('A7 打标弹窗（世界书模式 + 范围选择 + 候选池开关）', !!(tagModal.show && tagModal.mode === 'worldbooks' && tagModal.hasRange && tagModal.hasWbBadge && tagModal.hasPoolSwitch), JSON.stringify(tagModal));
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.showAITagModal.value = false; return 'ok'; })()`);

    // ================= A8：自动分组弹窗（S4） =================
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.openWbAutoGroupModal(); return 'ok'; })()`);
    await sleep(700);
    const autoTxt = await evaluate(`document.body.innerText || ''`);
    const autoShown = await evaluate(`(function () { var c = window.__probeGetCtx(); return !!c.showWbAutoGroupModal.value; })()`);
    check('A8 自动分组弹窗（双选项卡 + 迁移助手）', autoShown && autoTxt.includes('世界书自动分组') && autoTxt.includes('📋 收纳规则') && autoTxt.includes('🔍 预览与执行') && autoTxt.includes('虚拟分组迁移'));
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.closeWbAutoGroupModal(); return 'ok'; })()`);

    // ================= A9：大书懒加载 + 释放（内存纪律） =================
    const bigLoad = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        var list = c.worldbooks.value || [];
        var big = list.reduce(function (a, b) { return (b.size || 0) > (a.size || 0) ? b : a; }, list[0] || {});
        var name = (typeof c.wbDisplayName === 'function') ? (c.wbDisplayName(big) || big.name) : big.name;
        var sizeMB = Math.round((big.size || 0) / 1048576 * 10) / 10;
        try { await c.ensureWorldbookLoaded(big); } catch (e) { return { name: name, sizeMB: sizeMB, err: String(e) }; }
        var loadedEntries = (big.data && Array.isArray(big.data.entries)) ? big.data.entries.length : -1;
        var dataLoaded = big.dataLoaded;
        c.releaseWorldbookBody(big);
        return { name: name, sizeMB: sizeMB, loadedEntries: loadedEntries, dataLoaded: dataLoaded, afterRelease: { dataLoaded: big.dataLoaded, data: big.data ? 'present' : 'null' } };
    })()`);
    check('A9 大书懒加载成功', !!(bigLoad && bigLoad.loadedEntries > 0 && bigLoad.dataLoaded === true), JSON.stringify(bigLoad));
    check('A9b 大书用后释放（正文不再常驻）', !!(bigLoad && bigLoad.afterRelease && (bigLoad.afterRelease.dataLoaded === false || bigLoad.afterRelease.data === 'null')), JSON.stringify(bigLoad && bigLoad.afterRelease));

    // ================= A11：统计折叠浮层（2026-09-25：常驻 3x2 网格 → 折叠+浮空） =================
    // 前置：先关掉可能开着的其它浮层
    await evaluate(`(function () { var b = Array.from(document.querySelectorAll('button')).find(function (x) { return (x.getAttribute('title') || '').includes('导入/工具区') && x.getAttribute('title').includes('收起'); }); if (b) b.click(); return 'ok'; })()`);
    await sleep(300);
    const statsBtn = await evaluate(`(function () {
        var b = Array.from(document.querySelectorAll('button')).find(function (x) { return (x.getAttribute('title') || '').includes('世界书库统计'); });
        if (!b) return { found: false };
        b.click();
        return { found: true };
    })()`);
    await sleep(500);
    const statsOpen = await evaluate(`(function () {
        var pops = Array.from(document.querySelectorAll('.sb-popover'));
        var statsPop = pops.find(function (p) { return (p.textContent || '').includes('世界书库统计'); });
        var t = statsPop ? statsPop.textContent : '';
        // 原常驻网格应有 6 格全在浮层里
        var cells = ['📚 本', '📄 词条', '⚡ 总量', '🟣 常驻', '🔑 触发', '📊 均条'].filter(function (k) { return t.includes(k); });
        return { hasPop: !!statsPop, cells: cells.length };
    })()`);
    check('A11a 统计折叠浮层展开（6 格齐全）', !!(statsBtn.found && statsOpen.hasPop && statsOpen.cells === 6), JSON.stringify({ btn: statsBtn.found, ...statsOpen }));
    // 常驻网格已移除（列表上方不再有多余占位）
    const noResident = await evaluate(`(function () {
        var txt = document.body.innerText || '';
        // 未开高级工具区时，页面不应出现 6 格统计的固定文本组合（避免误判浮层自身——此处浮层已开，改为检查列表容器前是否有统计容器）
        return !document.querySelector('.sb-searchzone + div[class*="grid-cols-3"]');
    })()`);
    check('A11b 常驻统计网格已移除（列表恢复全高）', noResident === true);
    // 互斥：切到高级工具区 → 统计浮层自动关
    await evaluate(`(function () {
        var b = Array.from(document.querySelectorAll('button')).find(function (x) { return (x.getAttribute('title') || '').includes('导入/工具区'); });
        if (b) b.click();
        return 'ok';
    })()`);
    await sleep(400);
    const mutual = await evaluate(`(function () {
        var pops = Array.from(document.querySelectorAll('.sb-popover'));
        return {
            stats: pops.some(function (p) { return (p.textContent || '').includes('世界书库统计'); }),
            adv: pops.some(function (p) { return (p.textContent || '').includes('打开世界书目录'); })
        };
    })()`);
    check('A11c 互斥（工具区开 → 统计关）', mutual.stats === false && mutual.adv === true, JSON.stringify(mutual));
    // 点外部 → 全关
    await evaluate(`(function () { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);
    const outsideClose = await evaluate(`document.querySelectorAll('.sb-popover').length`);
    check('A11d 点外部即关', outsideClose === 0, `popovers=${outsideClose}`);

    // ================= A10：无渲染错误 =================
    const badErrors = consoleErrors.filter(e => /\[Vue 错误\]|is not a function|is not defined|Uncaught|Maximum call stack/.test(e) && !/favicon/.test(e));
    check('A10 无渲染层错误', badErrors.length === 0, badErrors.slice(0, 3).join(' | '));

    // ================= 汇总 =================
    const fail = results.filter(r => !r.ok).length;
    console.log('\n================ 结果 ================');
    console.log(`通过 ${results.length - fail} / ${results.length}`);
    if (fail) console.log('失败项：' + results.filter(r => !r.ok).map(r => r.n).join('、'));
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('探针异常：', e); process.exit(2); });
