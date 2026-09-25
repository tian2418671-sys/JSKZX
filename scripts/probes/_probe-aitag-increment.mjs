/**
 * AI 打标「增量模式（Q7）」端到端热测探针（2026-09-25）
 *
 * 环境要求（照抄即可）：
 *   ① 副本库：%TEMP%\jsk-hot-copy-lib（robocopy 真实小库副本；**写操作只落副本**）
 *   ② 副本 profile：%TEMP%\jsk-hot-copy-profile（复制真机配置 + lastFolder=副本库）
 *   ③ mock API：node %TEMP%\aitag-mock-server.mjs（127.0.0.1:8899 → 请求记录 %TEMP%\aitag-mock-requests.jsonl）
 *   ④ 实例：
 *      $env:VITE_DEV_SERVER_URL="http://localhost:5173"; npx electron . --disable-gpu `
 *        --remote-debugging-port=9376 --disable-renderer-backgrounding `
 *        --disable-backgrounding-occluded-windows --disable-background-timer-throttling `
 *        --user-data-dir=$env:TEMP\jsk-hot-copy-profile
 *   ⑤ 跑：$env:CDP_PORT="9376"; node scripts/probes/_probe-aitag-increment.mjs
 *
 * 场景：
 *   A（混合）：2 张已打标 + 1 张未打标 → 开增量 → 点开始 → 断言：
 *     仅 1 个 mock 请求；请求体含未打标卡名、不含已打标卡名；未打标卡获得标签；已打标卡未动
 *   B（全跳过）：2 张已打标 → 点开始 → 断言：无新请求、未进入打标流程、日志零新增、无渲染错误
 *
 * 探针只在**副本库**上跑；点击「开始智能打标」是刻意的（验证真实引擎路径），落盘只落副本。
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9376);
const MOCK_LOG = process.env.MOCK_LOG || path.join(process.env.TEMP || 'C:/Windows/Temp', 'aitag-mock-requests.jsonl');
const TARGETS_OUT = path.join(process.env.TEMP || 'C:/Windows/Temp', 'aitag-increment-targets.json');
const MOCK_URL = 'http://127.0.0.1:8899/v1/chat/completions';

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
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };
const info = (n, d = '') => console.log(`INFO ${n}${d ? '  => ' + d : ''}`);

const mockCount = () => {
    try { return fs.readFileSync(MOCK_LOG, 'utf-8').split('\n').filter(l => l.trim()).length; } catch (e) { return -1; }
};

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `port ${PORT}`);

    // ctx helper + 页面重载（同 chain-v2 纪律）
    const installCtxHelper = () => evaluate(`(function () {
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
    try {
        await send('Page.enable');
        await send('Page.reload', { ignoreCache: true });
        info('已重载页面（获取全新实例）');
        await new Promise(r => setTimeout(r, 2500));
    } catch (e) { /* 忽略 */ }
    await installCtxHelper();

    // 等就绪（ctx + 库非空）
    const ready = await (async () => {
        const t0 = Date.now();
        for (;;) {
            const st = await evaluate(`(function () { try { var c = window.__probeGetCtx(); if (!c || !c.openAITagModal) return { ctx: false }; var lib = (c.library && c.library.value) ? c.library.value : []; return { ctx: true, libLen: lib.length }; } catch (e) { return { ctx: false, err: String(e) }; } })()`);
            if (st && st.ctx && st.libLen > 0) return st;
            if (Date.now() - t0 > 60000) return st || { ctx: false };
            await new Promise(r => setTimeout(r, 400));
        }
    })();
    check('⓪ 实例就绪（ctx + 副本库非空）', !!(ready && ready.ctx && ready.libLen > 0), JSON.stringify(ready));
    if (!(ready && ready.ctx)) { console.error('无法继续'); process.exit(1); }

    // 库扫描：tagged / untagged（口径与 js/utils/tagIncrement.js hasAnyTag 完全一致）
    const libInfo = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        function hasTag(card) {
            if (!card || typeof card !== 'object') return false;
            var custom = Array.isArray(card.customTags) ? card.customTags : [];
            if (custom.some(function (t) { return String(t == null ? '' : t).trim() !== ''; })) return true;
            var dl = card.data && card.data.data ? card.data.data : (card.data || {});
            var native = dl ? dl.tags : undefined;
            if (Array.isArray(native)) return native.some(function (t) { return String(t == null ? '' : t).trim() !== ''; });
            if (typeof native === 'string') return native.trim() !== '';
            return false;
        }
        var lib = c.library.value || [];
        var tagged = [];
        var untagged = [];
        for (var i = 0; i < lib.length; i++) {
            var card = lib[i];
            var name = String(card.name || '');
            var texts = [String(card.description || '')];
            try {
                var d = card.data && card.data.data ? card.data.data : (card.data || {});
                texts.push(String(d.description || ''), String(d.personality || ''), String(d.first_mes || ''));
            } catch (e) { /* ignore */ }
            var rec = { id: card.id, name: name, texts: texts.join(' | ').slice(0, 400), customLen: (card.customTags || []).length };
            (hasTag(card) ? tagged : untagged).push(rec);
        }
        return { libLen: lib.length, taggedCount: tagged.length, untaggedCount: untagged.length, tagged: tagged, untagged: untagged };
    })()`);
    check('① 副本库为混合库（有已打标 + 未打标卡）', libInfo.taggedCount >= 2 && libInfo.untaggedCount >= 1,
        `共 ${libInfo.libLen} 张：已打标 ${libInfo.taggedCount} / 未打标 ${libInfo.untaggedCount}`);

    // 选卡：名字≥4 字符、彼此不互为子串、且不出现在对方的材料里（保证「请求体只含未打标卡」断言可靠）
    let t1 = null; let t2 = null; let u1 = null;
    for (const u of libInfo.untagged) {
        const candT = libInfo.tagged.filter(t => t.id !== u.id && t.name.length >= 4 && !u.name.includes(t.name) && !t.name.includes(u.name) && !u.texts.includes(t.name));
        if (candT.length < 2) continue;
        t1 = candT[0]; t2 = candT[1]; u1 = u; break;
    }
    check('② 找到可用的测试卡组合（1 未打标 + 2 已打标，名字互不干扰）', !!(t1 && t2 && u1),
        t1 && t2 && u1 ? `未打标「${u1.name}」/ 已打标「${t1.name}」「${t2.name}」` : '未找到合适组合');
    if (!(t1 && t2 && u1)) process.exit(1);
    fs.writeFileSync(TARGETS_OUT, JSON.stringify({ untagged: u1, tagged: [t1, t2] }, null, 2));

    // 运行时设置：mock endpoint / packSize=1 / 增量开 / 管线=仅 LLM 组合（分角色链路；也保证开始按钮可用）
    const setup = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        c.apiEndpoint.value = ${JSON.stringify(MOCK_URL)};
        c.tagPackSize.value = 1;
        c.tagSkipTagged.value = true;
        c.tagFunnel.value = { rule: false, vector: false, llm: true };
        return { endpoint: c.apiEndpoint.value, pack: c.tagPackSize.value, skip: c.tagSkipTagged.value,
                 funnel: JSON.parse(JSON.stringify(c.tagFunnel.value)), apiType: c.apiType.value };
    })()`);
    check('③ 运行时指向 mock API + packSize=1 + 增量开', setup.endpoint === MOCK_URL && setup.pack === 1 && setup.skip === true, JSON.stringify(setup));
    check('③b 打标管线 = 仅 LLM（llm:true → 分角色链路 / 开始按钮可用）', !!(setup.funnel && setup.funnel.llm === true), JSON.stringify(setup.funnel));

    // 打开弹窗（先设选中卡：openAITagModal 要求已有选中，否则弹「请先选择角色卡！」）
    const opened = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        if (typeof c.openAITagModal !== 'function') return { ok: false, err: 'no openAITagModal' };
        c.selectedIds.value = [${JSON.stringify(u1.id)}];
        c.openAITagModal();
        return { ok: true, selected: c.selectedIds.value.length };
    })()`);
    await new Promise(r => setTimeout(r, 800));
    const modalShown = await evaluate(`!!document.querySelector('.max-w-5xl')`);
    check('④ 打标弹窗已打开', !!(opened && opened.ok) && modalShown, (opened && opened.err) ? String(opened.err) : `selected=${opened && opened.selected} modal=${modalShown}`);

    const clickStart = () => evaluate(`(function () {
        var m = document.querySelector('.max-w-5xl');
        if (!m) return { ok: false, err: 'no modal' };
        var btn = [].slice.call(m.querySelectorAll('button')).find(function (b) { return (b.textContent || '').indexOf('开始智能打标') >= 0; });
        if (!btn) return { ok: false, err: 'no start btn' };
        if (btn.disabled) return { ok: false, err: 'start btn disabled' };
        btn.click();
        return { ok: true };
    })()`);
    const readState = () => evaluate(`(function () {
        var c = window.__probeGetCtx();
        return { isTag: c.isAITagging.value, cur: c.aiTaggingProgress.value.current, tot: c.aiTaggingProgress.value.total,
                 status: c.aiTaggingProgress.value.status };
    })()`);
    const waitTaggingDone = async (maxMs = 120000) => {
        const t0 = Date.now();
        let started = false;
        for (;;) {
            const st = await readState();
            if (st.isTag) started = true;
            if (started && !st.isTag) return { started: true, st };
            if (!started && st.cur > 0 && st.tot > 0 && st.cur === st.tot) return { started: true, st }; // 极快完成兜底
            if (Date.now() - t0 > maxMs) return { started, st, timeout: true };
            await new Promise(r => setTimeout(r, 600));
        }
    };

    // ═══════════ 场景 A：混合（2 已打标 + 1 未打标）═══════════
    info('── 场景 A：混合打标（预期仅 1 个请求、仅未打标卡被写）');
    const nA0 = mockCount();
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.selectedIds.value = ${JSON.stringify([u1.id, t1.id, t2.id])}; return c.selectedIds.value.length; })()`);
    await new Promise(r => setTimeout(r, 300));
    const clickA = await clickStart();
    check('A1 点击「🚀 开始智能打标」成功（真实 UI 按钮）', !!(clickA && clickA.ok), clickA && clickA.err ? String(clickA.err) : '');
    const doneA = await waitTaggingDone();
    check('A2 打标流程已结束（isAITagging 归位）', !!(doneA && doneA.started) && !(doneA && doneA.timeout), JSON.stringify(doneA && doneA.st));

    const nA1 = mockCount();
    check('A3 仅发出 1 个 API 请求（2 张已打标卡被跳过）', (nA1 - nA0) === 1, `请求数 ${nA0} → ${nA1}`);

    const payloads = (() => {
        try {
            return fs.readFileSync(MOCK_LOG, 'utf-8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        } catch (e) { return []; }
    })();
    // ⚠️ 只取**本轮新增**的请求（nA0 之前的历史请求可能含旧轮次打标的卡名——2026-09-25 踩坑：混检会误报 A5）
    const newPayloads = payloads.slice(nA0);
    const reqText = newPayloads.map(p => JSON.stringify(p.payload || {})).join('\n');
    check('A4 请求体含未打标卡名（「' + u1.name + '」）', reqText.includes(u1.name), `本轮新增请求 ${newPayloads.length} 条`);
    check('A5 请求体不含已打标卡名（「' + t1.name + '」「' + t2.name + '」）', !reqText.includes(t1.name) && !reqText.includes(t2.name));

    const afterA = await evaluate(`(function () {
        var c = window.__probeGetCtx();
        var idx = {};
        for (var i = 0; i < c.library.value.length; i++) idx[c.library.value[i].id] = c.library.value[i];
        function tagsOf(id) { var k = idx[id]; return k ? (Array.isArray(k.customTags) ? k.customTags.slice() : []) : null; }
        var log = (c.aiTagLog && c.aiTagLog.value ? c.aiTagLog.value : []).map(function (x) { return String(x.text || ''); });
        return { u: tagsOf(${JSON.stringify(u1.id)}), t1: tagsOf(${JSON.stringify(t1.id)}), t2: tagsOf(${JSON.stringify(t2.id)}),
                 logTail: log.slice(-8), hasSkipLog: log.some(function (t) { return t.indexOf('增量模式：跳过 2 张') >= 0; }) };
    })()`);
    check('A6 未打标卡获得 mock 标签（热测标签A/B）', Array.isArray(afterA.u) && afterA.u.includes('热测标签A') && afterA.u.includes('热测标签B'), JSON.stringify(afterA.u));
    check('A7 已打标卡未被改动（标签数不变）', Array.isArray(afterA.t1) && Array.isArray(afterA.t2) && afterA.t1.length === t1.customLen && afterA.t2.length === t2.customLen, `t1=${JSON.stringify(afterA.t1)} t2=${JSON.stringify(afterA.t2)}`);
    check('A8 日志出现「⏭️ 增量模式：跳过 2 张已有标签的卡」', afterA.hasSkipLog === true, (afterA.logTail || []).slice(-3).join(' / '));

    // ═══════════ 场景 B：全跳过（2 张已打标）═══════════
    info('── 场景 B：全跳过（预期 0 个新请求 + 0 条新日志）');
    const nB0 = mockCount();
    const logLenB0 = await evaluate(`(function () { var c = window.__probeGetCtx(); return (c.aiTagLog && c.aiTagLog.value ? c.aiTagLog.value.length : -1); })()`);
    const stateB0 = await readState();
    await evaluate(`(function () { var c = window.__probeGetCtx(); c.selectedIds.value = ${JSON.stringify([t1.id, t2.id])}; return c.selectedIds.value.length; })()`);
    await new Promise(r => setTimeout(r, 300));
    const clickB = await clickStart();
    check('B1 点击「🚀 开始智能打标」成功', !!(clickB && clickB.ok), clickB && clickB.err ? String(clickB.err) : '');
    await new Promise(r => setTimeout(r, 2500));
    const nB1 = mockCount();
    const stateB1 = await readState();
    const logLenB1 = await evaluate(`(function () { var c = window.__probeGetCtx(); return (c.aiTagLog && c.aiTagLog.value ? c.aiTagLog.value.length : -1); })()`);
    check('B2 无任何新增 API 请求（全跳过不发起）', (nB1 - nB0) === 0, `请求数 ${nB0} → ${nB1}`);
    check('B3 未进入打标流程（isAITagging=false / 进度保持点击前值）', stateB1.isTag === false && stateB1.cur === stateB0.cur && stateB1.tot === stateB0.tot, `点击前 ${JSON.stringify(stateB0)} / 点击后 ${JSON.stringify(stateB1)}`);
    check('B4 日志零新增（全跳过分支只弹提示、无流程日志）', logLenB0 === logLenB1, `日志长度 ${logLenB0} → ${logLenB1}`);

    // 收尾
    const bad = consoleErrors.filter(t => /TypeError|Cannot read|is not a function|Vue 错误|Unhandled/.test(t));
    check('⑤ 全程无渲染期错误', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 增量模式端到端热测：${pass}/${results.length} 通过 ═════`);
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
