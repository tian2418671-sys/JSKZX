/**
 * 🗂️ S4 世界书**物理分组 + 自动分组 + 打标落盘** —— 副本库写链路探针（2026-09-25）
 *
 * 环境要求：
 *   ① 副本库：%TEMP%\jsk-s4-wb-lib（真实库摘 4 本：八奇技 / 灵异 / 双人成行 / 周记环境描写）
 *   ② 实例：同上（9377，隔离 profile）——写操作**只落副本库**
 *   ③ 跑：$env:CDP_PORT="9377"; node scripts/probes/_probe-s4-wb-write.mjs
 *
 * 覆盖（★ = 铁律 6「按 path 派生的键必须同步迁移」）：
 *   W1 贴标签 · W2 物理移动+★标签键迁移 · W3 移回库根 · W4 分组重命名（全链路含 prompt 弹窗）
 *   W5 自动分组（扫描→执行→回滚）· W6 虚拟分组迁移助手 · W7 打标全流程（哈希校验不碰文件）· W8 无渲染错误
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.CDP_PORT || 9377);
const LIB = path.join(process.env.TEMP || 'C:/Windows/Temp', 'jsk-s4-wb-lib');

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

const fileExists = (rel) => fs.existsSync(path.join(LIB, rel));
const hashOf = (rel) => {
    try { return crypto.createHash('md5').update(fs.readFileSync(path.join(LIB, rel))).digest('hex'); }
    catch (e) { return 'N/A'; }
};

/** 幂等重置：把所有子文件夹里的文件移回库根、删空夹（重跑不受上次残留影响） */
const resetLib = () => {
    const subs = ['分组甲', '分组乙', '分组丙', '诡异', '虚拟组X'];
    for (const s of subs) {
        const dir = path.join(LIB, s);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            const src = path.join(dir, f);
            const dst = path.join(LIB, f);
            try { if (fs.existsSync(dst)) fs.unlinkSync(dst); fs.renameSync(src, dst); } catch (e) { /* 忽略 */ }
        }
        try { fs.rmdirSync(dir); } catch (e) { /* 忽略 */ }
    }
};

(async () => {
    resetLib();
    info('副本库已重置（子文件夹清空）');
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `port ${PORT} · lib=${LIB}`);

    try {
        await send('Page.enable');
        await send('Page.reload', { ignoreCache: true });
        info('已重载页面');
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
    const ctxReady = await (async () => {
        const t0 = Date.now();
        for (;;) {
            const ok = await evaluate(`!!(window.__probeGetCtx && window.__probeGetCtx() && window.__probeGetCtx().scanWorldbookDir && window.__probeGetCtx().moveWbToFolder)`);
            if (ok) return true;
            if (Date.now() - t0 > 30000) return false;
            await sleep(400);
        }
    })();
    check('⓪ ctx 就绪（含 S4 物理原语）', ctxReady);
    if (!ctxReady) { console.error('无法继续'); process.exit(1); }

    // ================= 扫描副本库 =================
    const t0 = Date.now();
    await evaluate(`(function () { var c = window.__probeGetCtx(); window.__probeScanDone = false; window.__probeScanP = (async function () { try { await c.scanWorldbookDir(${JSON.stringify(LIB)}); } catch (e) { window.__probeScanErr = String(e); } window.__probeScanDone = true; })(); return 'started'; })()`);
    let bookCount = 0;
    for (;;) {
        const st = await evaluate(`(function () { try { var c = window.__probeGetCtx(); return { done: !!window.__probeScanDone, n: (c.worldbooks && c.worldbooks.value) ? c.worldbooks.value.length : 0, err: window.__probeScanErr || '' }; } catch (e) { return { done: false, n: -1, err: String(e) }; } })()`);
        bookCount = st.n;
        if (st.done && bookCount >= 3) break;
        if (Date.now() - t0 > 120000) break;
        await sleep(600);
    }
    check('W0 副本库扫描（≥3 本）', bookCount >= 3, `books=${bookCount}`);

    // ================= W1：贴标签 =================
    const w1 = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('灵异'); });
        if (!wb) return { err: '未找到灵异.json' };
        c.addWbTagOn(wb, '探针写标签');
        return { path: wb.path, tags: c.getWbTags(wb), cat: c.getWbCategory(wb) };
    })()`);
    check('W1 贴标签（副本）', !!(w1 && w1.tags && w1.tags.includes('探针写标签')), JSON.stringify(w1));

    // ================= W2：物理移动 + 键迁移（★ 铁律 6） =================
    const w2 = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('灵异'); });
        var oldKey = wb.path;
        var ok = await c.moveWbToFolder(wb, '分组甲');
        var newKey = wb.path;
        return {
            ok: ok, oldKey: oldKey, newKey: newKey,
            cat: c.getWbCategory(wb),
            oldTagEntry: c.wbTagMap.value[oldKey] || null,
            // ⚠️ CDP returnByValue 会把 Vue 响应式 Proxy 数组序列化成对象形态 -> 显式转纯数组
            newTagEntry: (function (v) { try { return v ? JSON.parse(JSON.stringify(v)) : null; } catch (e) { return String(v); } })(c.wbTagMap.value[newKey]),
            cats: c.wbCategories.value
        };
    })()`);
    check('W2a moveWbToFolder 返回成功', w2 && w2.ok === true, JSON.stringify({ ok: w2 && w2.ok, newKey: w2 && w2.newKey }));
    check('W2b 文件真实移动到子文件夹', fileExists('分组甲\\灵异.json') && !fileExists('灵异.json'));
    check('W2c getWbCategory 即时反映物理分组', w2 && w2.cat === '分组甲', w2 && w2.cat);
    check('W2d ★标签键迁移（旧键无、新键有）', w2 && !w2.oldTagEntry && Array.isArray(w2.newTagEntry) && w2.newTagEntry.includes('探针写标签'), JSON.stringify({ old: w2 && w2.oldTagEntry, neu: w2 && w2.newTagEntry }));
    check('W2e 分组清单出现「分组甲」', w2 && Array.isArray(w2.cats) && w2.cats.includes('分组甲'), w2 && JSON.stringify(w2.cats));

    // ================= W3：移回库根 =================
    const w3 = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('灵异'); });
        var ok = await c.moveWbToFolder(wb, '默认');
        return { ok: ok, cat: c.getWbCategory(wb), path: wb.path, tags: c.getWbTags(wb) };
    })()`);
    check('W3 移回库根（含标签保留）', !!(w3 && w3.ok && w3.cat === '默认' && w3.tags.includes('探针写标签')) && fileExists('灵异.json') && !fileExists('分组甲\\灵异.json'), JSON.stringify(w3));

    // ================= W4：分组重命名（全链路含 prompt 弹窗） =================
    await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('八奇技'); });
        window.__probeW4 = (async function () {
            var ok1 = await c.moveWbToFolder(wb, '分组乙');
            window.__probeW4moved = ok1;
        })();
        return 'ok';
    })()`);
    await sleep(1200); // 等移动完成
    await evaluate(`(function () { var c = window.__probeGetCtx(); window.__probeRenP = c.renameWbGroup('分组乙'); return 'started'; })()`);
    await sleep(800);
    const promptShown = await evaluate(`!!(window.__probeGetCtx().promptModalVisible && window.__probeGetCtx().promptModalVisible.value)`);
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.promptInput.value = '分组丙'; c.confirmPrompt(); return 'ok'; })()`);
    await sleep(1800);
    const w4 = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('八奇技'); });
        return { path: wb.path, cat: c.getWbCategory(wb), cats: c.wbCategories.value };
    })()`);
    check('W4a 重命名分组弹出输入框', promptShown === true);
    check('W4b 物理文件夹整体改名 + 内存路径同步', fileExists('分组丙\\八奇技.json') && !fileExists('分组乙\\八奇技.json'), JSON.stringify(w4));
    check('W4c 分组清单更新（分组乙 → 分组丙）', w4 && w4.cats.includes('分组丙') && !w4.cats.includes('分组乙'), JSON.stringify(w4 && w4.cats));

    // ================= W5：自动分组（扫描 → 执行 → 回滚） =================
    const w5scan = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        c.wbAutoGroupProfiles.value = [{ id: 'probe_p1', group: '诡异', enabled: true, match: { type: 'name-keyword', pattern: '灵异' }, note: '', llmCriteria: '' }];
        var plan = await c.scanWbAutoGroup({ includeGrouped: true });
        return plan ? { moves: plan.moves.map(function (m) { return { key: m.bookKey, name: m.bookName, to: m.toGroup, from: m.fromGroup }; }), counters: plan.counters } : null;
    })()`);
    check('W5a 扫描生成移动计划', !!(w5scan && w5scan.moves && w5scan.moves.some(m => m.name.includes('灵异'))), JSON.stringify(w5scan && w5scan.counters));

    const w5exec = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        var keys = c.wbAutoGroupScan.value.plan.moves.map(function (m) { return m.bookKey; });
        await c.executeWbAutoGroup(keys, { skipConfirm: true });
        return {
            moved: c.wbAutoGroupExec.value.moved, failed: c.wbAutoGroupExec.value.failed,
            lastRun: c.wbAutoGroupLastRun.value ? c.wbAutoGroupLastRun.value.entries.length : 0
        };
    })()`);
    check('W5b 执行移动（物理落盘）', !!(w5exec && w5exec.moved >= 1 && w5exec.failed === 0) && fileExists('诡异\\灵异.json'), JSON.stringify(w5exec));
    check('W5c 移动日志写入（回滚依据）', w5exec && w5exec.lastRun >= 1, `entries=${w5exec && w5exec.lastRun}`);

    const w5rb = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        await c.rollbackWbAutoGroup({ skipConfirm: true });
        return { rolled: c.wbAutoGroupRollback.value.rolled, lastRun: c.wbAutoGroupLastRun.value };
    })()`);
    check('W5d 回滚还原（文件回原分组）', !!(w5rb && w5rb.rolled >= 1) && fileExists('灵异.json') && !fileExists('诡异\\灵异.json'), JSON.stringify({ rolled: w5rb && w5rb.rolled }));
    check('W5e 全部解决 → 日志清空', w5rb && w5rb.lastRun === null, JSON.stringify(w5rb && w5rb.lastRun));

    // ================= W6：虚拟分组迁移助手 =================
    const w6 = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('周记环境描写'); });
        if (!wb) return { err: '未找到周记环境描写.json' };
        var key = wb.path || wb.name;
        c.wbCategoryMap.value[key] = '虚拟组X';
        var r = await c.migrateVirtualGroupsToFolders({ skipConfirm: true });
        return { r: r, mapSize: Object.keys(c.wbCategoryMap.value).length, path: wb.path, cat: c.getWbCategory(wb), tags: c.getWbTags(wb) };
    })()`);
    check('W6a 迁移完成（移动计数）', !!(w6 && w6.r && w6.r.moved >= 1), JSON.stringify(w6 && w6.r));
    check('W6b 文件进入虚拟组同名文件夹 + 映射表清空', !!(w6 && fileExists('虚拟组X\\周记环境描写.json') && w6.mapSize === 0 && w6.cat === '虚拟组X'), JSON.stringify({ mapSize: w6 && w6.mapSize, cat: w6 && w6.cat }));

    // ================= W7：世界书打标全流程（哈希校验：不碰文件） =================
    const hashBefore = {
        lingyi: hashOf('灵异.json'),
        baqi: hashOf('分组丙\\八奇技.json'),
        zhouji: hashOf('虚拟组X\\周记环境描写.json')
    };
    const w7 = await evaluate(`(async function () {
        var c = window.__probeGetCtx();
        c.useCandidatePool.value = false; // 池关：收尾不弹「产出回池」确认框（同时也验证池关分支）
        c.wbTagRange.value = 'current';
        var wb = c.worldbooks.value.find(function (x) { return (x.path || '').includes('灵异'); });
        await c.selectWorldbook(wb);
        await c.startWbTagging();
        var log = (c.aiTagLog.value || []).map(function (l) { return l.text; });
        return {
            tagging: c.isAITagging.value,
            status: c.aiTaggingProgress.value.status,
            hasHeader: log.some(function (t) { return t.includes('开始世界书打标'); }),
            hasNoFileNote: log.some(function (t) { return t.includes('不改写世界书文件'); }),
            hasDone: log.some(function (t) { return t.includes('世界书打标完成'); }),
            tags: c.getWbTags(wb)
        };
    })()`);
    const hashAfter = {
        lingyi: hashOf('灵异.json'),
        baqi: hashOf('分组丙\\八奇技.json'),
        zhouji: hashOf('虚拟组X\\周记环境描写.json')
    };
    check('W7a 打标流程完整跑完', !!(w7 && w7.tagging === false && w7.hasHeader && w7.hasDone), JSON.stringify({ status: w7 && w7.status, header: w7 && w7.hasHeader, done: w7 && w7.hasDone }));
    check('W7b 落盘说明日志存在（不写文件的口径告知）', !!(w7 && w7.hasNoFileNote));
    check('W7c ★哈希校验：打标全程 0 字节改动', JSON.stringify(hashBefore) === JSON.stringify(hashAfter), JSON.stringify(hashAfter));
    info('打标后标签', JSON.stringify(w7 && w7.tags));

    // ================= W8：无渲染错误 =================
    const badErrors = consoleErrors.filter(e => /\[Vue 错误\]|is not a function|is not defined|Uncaught|Maximum call stack/.test(e) && !/favicon/.test(e));
    check('W8 无渲染层错误', badErrors.length === 0, badErrors.slice(0, 3).join(' | '));

    // ================= 汇总 =================
    const fail = results.filter(r => !r.ok).length;
    console.log('\n================ 结果 ================');
    console.log(`通过 ${results.length - fail} / ${results.length}`);
    if (fail) console.log('失败项：' + results.filter(r => !r.ok).map(r => r.n).join('、'));
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('探针异常：', e); process.exit(2); });
