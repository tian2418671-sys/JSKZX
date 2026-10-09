/**
 * 🏷️ AI 打标「材料链路」改造 —— **真实 UI + 真实库手动测试**（2026-10-03）
 *
 * 目的：在**真机真库**上把本批改造逐项走一遍（不是单测）——DOM 断言 + 引擎状态 + 真实请求链路。
 *
 * 覆盖：
 *   M1 真库扫描（H:\01\全局世界书）
 *   M2 材料保真（AI-14）：预览里出现【词条名】/「词条数：」（用**独立读盘**的同一本书交叉验证）
 *   M3 新 UI 存在：🌍 世界书专用 System / 🌍 大幅书最多分段数 / 📎 程序材料自动附加 / 🔗 材料占位符
 *   M4 分段上限滑块联动（Q8）：拖到 120 → ctx.tagWbSegmentMax 变 120；⟲ 默认回 40
 *   M5 世界书 System 三态（AI-15）：点「沿用」→ localStorage 落盘 wb.mode='inherit'；点回内置
 *   M6 三档联动（Q3）：点「全手动」→ ctx.tagAutoMaterial='manual'
 *   M7 占位符：一键插入 → 段内容出现 {{材料}}；段头徽标；预览段状态 auto/taken/dropped 随档位变化
 *   M8 全手动 + 无占位符 → 预览红字警告（Q10 的判据）
 *   M9 ⭐ AI-12 真库对照：**先把正文释放成懒加载态**，规则正则命中「只存在于词条正文」的词 →
 *      跑一次规则层打标 → 断言真的命中（修复前这种情况必然「未命中」）
 *   M10 无渲染错误（console.error 计数）
 *
 * 环境要求：
 *   ① 真实世界书库 H:\01\全局世界书（只读）
 *   ② 应用带远程调试端口启动（隔离 profile）：
 *      Remove-Item Env:ELECTRON_RUN_AS_NODE
 *      node_modules\electron\dist\electron.exe . --disable-gpu --remote-debugging-port=9377 --user-data-dir=%TEMP%\jsk-manual
 *   ③ 跑：node scripts/probes/_probe-aitag-material.mjs
 */
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9377);
const REAL_LIB = process.env.WB_LIB || 'H:\\01\\全局世界书';
const REAL_LIB_MIN = 25;

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

/** 按可见文本点元素 */
const clickByText = (sel, text) => evaluate(`(function(){var els=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(sel)}));var el=els.find(function(e){return (e.textContent||'').indexOf(${JSON.stringify(text)})>=0;});if(!el)return false;el.click();return true;})()`);
const bodyText = () => evaluate(`document.body.innerText || ''`);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CTX = 'window.__probeGetCtx()';

(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    info('已连接 CDP', `port ${PORT}`);

    await evaluate(`(function () {
        window.__probeGetCtx = function () {
            try {
                var a = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
                if (!a) return null;
                return (a._context && a._context.provides && a._context.provides.appCtx)
                    || (a._instance && a._instance.provides && a._instance.provides.appCtx)
                    || (a._container && a._container._vnode && a._container._vnode.component && a._container._vnode.component.provides && a._container._vnode.component.provides.appCtx)
                    || null;
            } catch (e) { return null; }
        };
        return 'ok';
    })()`);

    const t0 = Date.now();
    let ready = false;
    for (;;) {
        ready = await evaluate(`!!(${CTX} && ${CTX}.scanWorldbookDir && ${CTX}.materialPreview)`);
        if (ready || Date.now() - t0 > 30000) break;
        await sleep(400);
    }
    check('⓪ ctx 就绪（含 materialPreview / scanWorldbookDir）', ready);
    if (!ready) { console.error('无法继续'); process.exit(1); }

    // ═════════ M1 真库扫描 ═════════
    const s0 = Date.now();
    await evaluate(`(function(){var c=${CTX};window.__scanDone=false;(async function(){try{await c.scanWorldbookDir(${JSON.stringify(REAL_LIB)});}catch(e){window.__scanErr=String(e);}window.__scanDone=true;})();return 'started';})()`);
    let books = [];
    for (;;) {
        const st = await evaluate(`(function(){var c=${CTX};return {done:!!window.__scanDone,n:(c.worldbooks&&c.worldbooks.value)?c.worldbooks.value.length:0,err:window.__scanErr||''};})()`);
        books = st.n;
        if (st.done && st.n >= REAL_LIB_MIN) break;
        if (Date.now() - s0 > 180000) break;
        await sleep(800);
    }
    info('扫描耗时', `${Math.round((Date.now() - s0) / 1000)}s`);
    check('M1 真库扫描', books >= REAL_LIB_MIN, `books=${books}`);

    // 选目标：**最大**的一本（保证是 heavy 懒加载态，用于 M9 的「先释放正文」对照）
    const target = await evaluate(`(function(){var c=${CTX};var l=c.worldbooks.value||[];var b=l.reduce(function(a,x){return ((x.size||0)>(a.size||0))?x:a;},l[0]||{});return {name:String(c.wbDisplayName(b)||b.name||''),path:String(b.path||''),size:Number(b.size||0),heavy:!!b.heavy,dataLoaded:b.dataLoaded===true};})()`);
    info('目标书（最大）', `${target.name} · ${(target.size / 1048576).toFixed(2)}MB · heavy=${target.heavy} · 已载入=${target.dataLoaded}`);

    // 独立读盘：拿第 1 条词条的 comment + 只存在于正文的探测词
    let fileComment = ''; let bodyToken = '';
    try {
        const raw = JSON.parse(fs.readFileSync(target.path, 'utf8'));
        let entries = raw && raw.entries;
        entries = Array.isArray(entries) ? entries : (entries && typeof entries === 'object' ? Object.values(entries) : []);
        const e0 = entries.find((e) => e && typeof e === 'object') || {};
        fileComment = String(e0.comment || e0.name || '').trim();
        const content = String(e0.content || '');
        // 取正文里一段**不太可能出现在书名/触发词里**的片段（去空白，长度 8~16）
        const m = content.replace(/\s+/g, '').match(/[\u4e00-\u9fff]{8,16}/);
        bodyToken = m ? m[0] : content.replace(/\s+/g, '').slice(0, 10);
    } catch (e) { info('读盘失败（跳过 M9 的正文锚点）', String(e)); }
    info('独立读盘锚点', `comment=「${fileComment}」 · 正文探测词=「${bodyToken}」`);

    // ═════════ M2/M3 打开打标窗（世界书模式）+ 真库材料预览 ═════════
    // ⚠️ 必须先 `selectWorldbook`（预览的「当前书」= activeWorldbook；不选则 targetCount=0 —— 首轮探针就踩了这个）
    const sel = await evaluate(`(async function(){
        var c=${CTX};
        var l=c.worldbooks.value||[];
        var b=l.reduce(function(a,x){return ((x.size||0)>(a.size||0))?x:a;},l[0]||{});
        await c.selectWorldbook(b);
        return {name:String(c.wbDisplayName(b)||b.name||''), active:!!(c.activeWorldbook&&c.activeWorldbook.value)};
    })()`);
    check('M1b 选中「当前书」（activeWorldbook 就绪）', sel.active === true, JSON.stringify(sel));
    await evaluate(`(function(){var c=${CTX};c.appMode.value='worldbooks';if(c.aiTagTargetMode)c.aiTagTargetMode.value='worldbooks';if(c.wbTagRange)c.wbTagRange.value='current';c.showAITagModal.value=true;return 'ok';})()`);

    // 🩹 首帧（正文可能还没读完）：必须是**显式「未载入」**，不能显示成「词条数：0」
    const firstFrame = await evaluate(`(function(){
        var c=${CTX};
        var loaded=!!(c.activeWorldbook&&c.activeWorldbook.value&&c.activeWorldbook.value.dataLoaded===true);
        var mp=c.materialPreview.value; var secs=mp.sections||[];
        var tgt=secs.filter(function(s){return s.kind==='target';})[0];
        var part=(tgt&&tgt.parts&&tgt.parts[0])||{};
        return { loaded:loaded, body:String(part.body||''), note:String(part.note||'') };
    })()`);
    if (!firstFrame.loaded) {
        check('M2a 正文未载入时不假装「0 词条」（显式标注 / 说明）',
            firstFrame.body.includes('未载入') || firstFrame.note.includes('尚未载入'),
            `body=「${firstFrame.body.slice(0, 60)}」 note=「${firstFrame.note.slice(0, 40)}」`);
    } else {
        info('M2a 跳过首帧检查', '目标书在断言前已载入完成（上一轮残留）');
    }

    // 等正文读完（预览预取；大书 10MB 级需要几秒）
    const tw = Date.now();
    let wbLoaded = false;
    for (;;) {
        wbLoaded = await evaluate(`(function(){var c=${CTX};return !!(c.activeWorldbook&&c.activeWorldbook.value&&c.activeWorldbook.value.dataLoaded===true);})()`);
        if (wbLoaded || Date.now() - tw > 45000) break;
        await sleep(700);
    }
    info('预览预取等待', `${Math.round((Date.now() - tw) / 1000)}s · loaded=${wbLoaded}`);
    await sleep(800); // 让 computed 重算

    const previewProbe = await evaluate(`(function(){
        var c=${CTX};
        var mp=c.materialPreview.value;
        var secs=(mp&&mp.sections)||[];
        var tgt=secs.filter(function(s){return s.kind==='target';})[0];
        var body=tgt&&tgt.parts&&tgt.parts[0]?String(tgt.parts[0].body||''):'';
        return {
            targetCount: mp.targetCount,
            hasCountLine: body.indexOf('词条数：')>=0,
            hasCommentTitle: ${JSON.stringify(fileComment)} ? body.indexOf('【'+${JSON.stringify(fileComment)}+'】')>=0 : null,
            hasTriggerLine: body.indexOf('触发词：')>=0,
            status: (tgt&&tgt.parts&&tgt.parts[0])?tgt.parts[0].status:'',
            head: body.slice(0,200)
        };
    })()`);
    info('预览·首个目标材料开头', JSON.stringify(previewProbe.head));
    check('M2b 真库材料保真（词条数行 + 触发词行）', !!(previewProbe.hasCountLine && previewProbe.hasTriggerLine), JSON.stringify({ count: previewProbe.hasCountLine, trig: previewProbe.hasTriggerLine, targetCount: previewProbe.targetCount }));
    if (fileComment) check('M2c 词条名（comment）真的进了材料', previewProbe.hasCommentTitle === true, `【${fileComment}】`);

    // ⚠️ 各页签内容不同：分段上限在「执行管线」，世界书 System 在「系统提示词」，占位符/三档在「自定义模式」
    //    （⚠️ 弹窗会记住上次停留的页签 ⇒ 断言前必须**显式点页签**；首轮探针就栽在"以为默认在执行管线"）
    await clickByText('button', '执行管线');
    await sleep(600);
    const domPipeline = await bodyText();
    const pipelineOk = domPipeline.includes('大幅书最多分段数');
    await clickByText('button', '系统提示词');
    await sleep(700);
    const domPrompt = await bodyText();
    const sysOk = domPrompt.includes('世界书专用 System');
    await clickByText('button', '自定义模式');
    await sleep(700);
    const domCustom = await bodyText();
    const customOk = domCustom.includes('程序材料自动附加') && domCustom.includes('材料占位符');
    check('M3 新 UI 存在（执行管线 / 系统提示词 / 自定义模式 三页各就位）',
        pipelineOk && sysOk && customOk,
        JSON.stringify({ segMax: pipelineOk, wbSystem: sysOk, autoMatAndVars: customOk }));

    // ═════════ M4 分段上限滑块联动（在「执行管线」页） ═════════
    await clickByText('button', '执行管线');
    await sleep(500);
    const sliderOk = await evaluate(`(function(){
        var el=document.querySelector('input[type="range"][max="300"]');
        if(!el) return {found:false};
        var before=el.value;
        el.value='120'; el.dispatchEvent(new Event('input',{bubbles:true}));
        return {found:true, before:String(before), max:String(el.max), min:String(el.min)};
    })()`);
    await sleep(400);
    const segMaxNow = await evaluate(`(function(){var c=${CTX};return Number(c.tagWbSegmentMax.value);})()`);
    check('M4 分段上限滑块（默认 40 / max 300 / 拖到 120 生效）', sliderOk.found && sliderOk.max === '300' && segMaxNow === 120, JSON.stringify({ ...sliderOk, segMaxNow }));
    // ⟲ 默认按钮回 40
    await clickByText('button', '⟲ 默认');
    await sleep(300);
    const segMaxBack = await evaluate(`(function(){var c=${CTX};return Number(c.tagWbSegmentMax.value);})()`);
    check('M4b 「⟲ 默认」回到 40', segMaxBack === 40, `segMax=${segMaxBack}`);

    // ═════════ M5 世界书 System 三态（在「系统提示词」页） ═════════
    await clickByText('button', '系统提示词');
    await sleep(600);
    const wbRadio = await evaluate(`(function(){
        var labels=Array.prototype.slice.call(document.querySelectorAll('label'));
        var el=labels.find(function(l){return (l.textContent||'').indexOf('沿用上面的通用 System')>=0;});
        if(!el) return false;
        var r=el.querySelector('input[type=radio]'); if(!r) return false;
        r.click(); return true;
    })()`);
    await sleep(800);
    const lsMode = await evaluate(`(function(){try{var s=JSON.parse(localStorage.getItem('jsTavernLlmRolePrompts')||'{}');return (s.wb&&s.wb.mode)||'';}catch(e){return 'ERR';}})()`);
    check('M5 世界书 System 三态（点「沿用」→ 落盘 inherit）', wbRadio === true && lsMode === 'inherit', `radio=${wbRadio} mode=${lsMode}`);
    // 点回内置
    await evaluate(`(function(){
        var labels=Array.prototype.slice.call(document.querySelectorAll('label'));
        var el=labels.find(function(l){return (l.textContent||'').indexOf('世界书设定标签分析助手')>=0;});
        if(el){var r=el.querySelector('input[type=radio]'); if(r) r.click();}
        return 'ok';
    })()`);
    await sleep(700);
    const lsMode2 = await evaluate(`(function(){try{var s=JSON.parse(localStorage.getItem('jsTavernLlmRolePrompts')||'{}');return (s.wb&&s.wb.mode)||'';}catch(e){return 'ERR';}})()`);
    check('M5b 点回「内置世界书文案」→ 落盘 default', lsMode2 === 'default', `mode=${lsMode2}`);

    // ═════════ M6/M7/M8 自定义模式：占位符 + 三档 ═════════
    // 建一段 + 切到自定义模式页
    await evaluate(`(function(){var c=${CTX};c.tagPromptMode.value='custom';c.tagAutoMaterial.value='compat';c.tagCustomSegments.value=[{id:'probe-seg-1',role:'user',content:'请根据以下内容打标：'}];return 'ok';})()`);
    await sleep(400);
    await clickByText('button', '自定义模式');
    await sleep(600);
    const customDom = await bodyText();
    check('M6a 「自定义模式」页渲染（含占位符图例与三档）', customDom.includes('材料占位符') && customDom.includes('全手动') && customDom.includes('兼容'), '');

    // 一键插入 {{材料}}
    const insertOk = await clickByText('button', '{{材料}}');
    await sleep(400);
    const segContent = await evaluate(`(function(){var c=${CTX};var s=c.tagCustomSegments.value[0]||{};return String(s.content||'');})()`);
    check('M7a 「一键插入」把 {{材料}} 写进段（末段）', insertOk === true && segContent.includes('{{材料}}'), `seg=「${segContent.slice(0, 40)}」`);

    // 三档 → 全手动
    const manualClicked = await evaluate(`(function(){
        var labels=Array.prototype.slice.call(document.querySelectorAll('label'));
        var el=labels.find(function(l){return (l.textContent||'').indexOf('全手动')>=0;});
        if(!el) return false; var r=el.querySelector('input[type=radio]'); if(!r) return false; r.click(); return true;
    })()`);
    await sleep(500);
    const modeNow = await evaluate(`(function(){var c=${CTX};return String(c.tagAutoMaterial.value);})()`);
    check('M6b 三档联动（点「全手动」→ 引擎收到 manual）', manualClicked === true && modeNow === 'manual', `mode=${modeNow}`);

    // 预览状态：material=taken，其余=dropped
    const statusProbe = await evaluate(`(function(){
        var c=${CTX};var mp=c.materialPreview.value;var secs=mp.sections||[];
        var common=(secs.filter(function(s){return s.kind==='common';})[0]||{}).parts||[];
        var tgt=(secs.filter(function(s){return s.kind==='target';})[0]||{}).parts||[];
        var map={};
        common.concat(tgt).forEach(function(p){map[p.key]=p.status;});
        return {map:map, used:(mp.varInfo&&mp.varInfo.used)||[], manual:mp.autoMaterialMode, lacks:!!mp.lacksMaterial};
    })()`);
    check('M7b 预览状态：材料=taken / 任务说明·候选池·输出要求=dropped',
        statusProbe.map.wb === 'taken' && statusProbe.map.task === 'dropped' && statusProbe.map.output === 'dropped',
        JSON.stringify(statusProbe.map));
    const customDom2 = await bodyText();
    check('M7c DOM 角标（🔗 已由占位符接管 / 🚫 当前档不送）', customDom2.includes('已由占位符接管') && customDom2.includes('当前档不送'), '');

    // M8：全手动 + 段里没占位符 → 红字警告
    await evaluate(`(function(){var c=${CTX};c.tagCustomSegments.value=[{id:'probe-seg-1',role:'user',content:'这里故意不写占位符'}];return 'ok';})()`);
    await sleep(600);
    const lackProbe = await evaluate(`(function(){var c=${CTX};var mp=c.materialPreview.value;return {lacks:!!mp.lacksMaterial, mode:mp.autoMaterialMode};})()`);
    const lackDom = await bodyText();
    check('M8 全手动 + 无材料占位符 → 判据 + 红字警告', lackProbe.lacks === true && lackDom.includes('没有任何段'), JSON.stringify(lackProbe));

    // 收尾还原（回到系统链路 + 兼容档；段清空）
    await evaluate(`(function(){var c=${CTX};c.tagPromptMode.value='system';c.tagAutoMaterial.value='compat';c.tagCustomSegments.value=[];return 'ok';})()`);
    await sleep(300);

    // ═════════ M9 ⭐ AI-12 真库对照：释放正文 → 规则命中正文专属词 ═════════
    if (bodyToken) {
        const before = await evaluate(`(async function(){
            var c=${CTX};
            var l=c.worldbooks.value||[]; var b=l.reduce(function(a,x){return ((x.size||0)>(a.size||0))?x:a;},l[0]||{});
            await c.selectWorldbook(b);
            var ns=String(c.wbDisplayName(b)||b.name||'');
            // 先释放成懒加载态（走**唯一入口**：批量读正文的释放路径会 triggerRef ⇒ 预览能刷新；
            // 直接调 releaseWorldbookBody 不会触发响应式，探针会误判成"预览不刷新"）
            try{ await c.consumeWorldbookBodies([b], function(){}, { release: true }); }catch(e){}
            return {name:ns, heavy:!!b.heavy, dataLoaded:b.dataLoaded===true, entriesInMem:(function(){try{var d=b.data&&b.data.entries;return Array.isArray(d)?d.length:(d?Object.keys(d).length:0);}catch(e){return -1;}})()};
        })()`);
        info('M9 目标书状态（释放后）', JSON.stringify(before));
        check('M9a 目标书已回到懒加载态（正文不在内存）', before.dataLoaded === false, JSON.stringify(before));

        // 🩹 M2d：正文释放后，预览必须**显式标注**（不能显示成「词条数：0」）—— 真实 UI 上复验该修复
        await sleep(900);
        const pendingNow = await evaluate(`(function(){
            var c=${CTX};
            var mp=c.materialPreview.value; var secs=mp.sections||[];
            var tgt=secs.filter(function(s){return s.kind==='target';})[0];
            var part=(tgt&&tgt.parts&&tgt.parts[0])||{};
            return { body:String(part.body||''), note:String(part.note||''), loaded:!!(c.activeWorldbook&&c.activeWorldbook.value&&c.activeWorldbook.value.dataLoaded===true) };
        })()`);
        check('M2d 正文未载入时预览显式标注（绝不显示成「词条数：0」）',
            (pendingNow.body.includes('未载入') || pendingNow.note.includes('尚未载入')) && !pendingNow.body.includes('词条数：0'),
            `body=「${pendingNow.body.slice(0, 70)}」 note=「${pendingNow.note.slice(0, 45)}」`);

        const ruleName = '探针正文规则';
        await evaluate(`(function(){
            var c=${CTX};
            window.__bkFunnel={rule:c.tagFunnel.value.rule,vector:c.tagFunnel.value.vector,llm:c.tagFunnel.value.llm};
            window.__bkRules=JSON.parse(JSON.stringify(c.autoTagRules.value||[]));
            if(c.wbTagRange) c.wbTagRange.value='current';
            c.setFunnelLayer('rule',true); c.setFunnelLayer('vector',false); c.setFunnelLayer('llm',false);
            c.autoTagRules.value=[{name:${JSON.stringify(ruleName)}, regex:${JSON.stringify(esc(bodyToken))}}];
            return 'ok';
        })()`);
        await sleep(400);

        await evaluate(`(function(){var c=${CTX};window.__tagDone=false;(async function(){try{await c.startWbTagging();}catch(e){window.__tagErr=String(e);}window.__tagDone=true;})();return 'started';})()`);
        const t1 = Date.now();
        for (;;) {
            const st = await evaluate(`(function(){var c=${CTX};return {done:!!window.__tagDone, tag:!!c.isAITagging.value, err:window.__tagErr||''};})()`);
            if (st.done || (!st.tag && Date.now() - t1 > 3000)) break;
            if (Date.now() - t1 > 90000) break;
            await sleep(500);
        }
        const after = await evaluate(`(function(){
            var c=${CTX};
            var b=(c.activeWorldbook&&c.activeWorldbook.value)||null;
            var logs=(c.aiTagLog&&c.aiTagLog.value)||[];
            var hit=logs.filter(function(l){return (l.text||'').indexOf('规则命中')>=0;}).map(function(l){return l.text;});
            return {
                err:window.__tagErr||'',
                tags:b?c.getWbTags(b):[],
                hitLines:hit.slice(0,3),
                ruleLine:(logs.filter(function(l){return (l.text||'').indexOf('世界书 System')>=0;})[0]||{}).text||'',
                loaded:b?b.dataLoaded===true:null
            };
        })()`);
        info('M9 日志（规则命中）', JSON.stringify(after.hitLines));
        check('M9b ⭐ 规则层命中「只存在于正文」的词（AI-12 修复）',
            Array.isArray(after.tags) && after.tags.includes(ruleName),
            JSON.stringify({ tags: after.tags.slice(0, 5), err: after.err }));
        check('M9c 规则-only 运行不打印 System 告知行（设计如此：该行只在 LLM 层开启时出现）',
            !String(after.ruleLine).includes('世界书 System'), `line=「${after.ruleLine}」`);

        // 还原：标签清掉、规则与漏斗复原
        await evaluate(`(function(){
            var c=${CTX};
            var b=(c.activeWorldbook&&c.activeWorldbook.value)||null;
            if(b) c.setWbTags(b, (c.getWbTags(b)||[]).filter(function(t){return t!==${JSON.stringify(ruleName)};}));
            c.autoTagRules.value=window.__bkRules||[];
            if(window.__bkFunnel){ c.setFunnelLayer('rule',!!window.__bkFunnel.rule); c.setFunnelLayer('vector',!!window.__bkFunnel.vector); c.setFunnelLayer('llm',!!window.__bkFunnel.llm); }
            if(typeof c.saveAutoTagRules==='function') c.saveAutoTagRules();
            return 'ok';
        })()`);
        await sleep(600);
        const cleaned = await evaluate(`(function(){var c=${CTX};var b=(c.activeWorldbook&&c.activeWorldbook.value)||null;return {tags:b?c.getWbTags(b):[], funnel:{rule:c.tagFunnel.value.rule,vector:c.tagFunnel.value.vector,llm:c.tagFunnel.value.llm}};})()`);
        check('M9d 测试痕迹已还原（探针标签已移除）', Array.isArray(cleaned.tags) && !cleaned.tags.includes(ruleName), JSON.stringify(cleaned));
    } else {
        info('M9 跳过', '未能从磁盘取到正文锚点');
    }

    // ═════════ M11 LLM-only（**不配 API**）：System 告知行 + 优雅跳过（无网络） ═════════
    if (bodyToken) {
        await evaluate(`(function(){
            var c=${CTX};
            window.__bkFunnel2={rule:c.tagFunnel.value.rule,vector:c.tagFunnel.value.vector,llm:c.tagFunnel.value.llm};
            c.setFunnelLayer('rule',false); c.setFunnelLayer('vector',false); c.setFunnelLayer('llm',true);
            return 'ok';
        })()`);
        await sleep(300);
        await evaluate(`(function(){var c=${CTX};window.__tagDone2=false;(async function(){try{await c.startWbTagging();}catch(e){window.__tagErr2=String(e);}window.__tagDone2=true;})();return 'started';})()`);
        const t2 = Date.now();
        for (;;) {
            const st = await evaluate(`(function(){var c=${CTX};return {done:!!window.__tagDone2, tag:!!c.isAITagging.value};})()`);
            if (st.done || (!st.tag && Date.now() - t2 > 3000)) break;
            if (Date.now() - t2 > 60000) break;
            await sleep(500);
        }
        const llmLog = await evaluate(`(function(){var c=${CTX};var logs=(c.aiTagLog&&c.aiTagLog.value)||[];var t=function(re){var h=logs.filter(function(l){return re.test(l.text||'');})[0];return h?h.text:'';};return {sys:t(/世界书 System/), skip:t(/未配置 API/), net:t(/网络\\/超时|fetch failed|无法连接 API/), cap:t(/超上限：均匀采样/), n:logs.length};})()`);
        check('M11 LLM 层开启时打印「🌍 世界书 System：…」告知行', String(llmLog.sys).includes('世界书 System'), `n=${llmLog.n}`);
        // 无可用 API 时的**两条合法路径**：① 未配置 ⇒ 跳过；② 有默认端点但连不上 ⇒ 归类「网络/超时」并走降级阶梯（不崩、不静默）
        check('M11b 无可用 API 时优雅收尾（未配置则跳过 / 连不上则归类失败，均不崩不静默）',
            !!(llmLog.skip || llmLog.net), `skip=「${String(llmLog.skip).slice(0, 40)}」 net=「${String(llmLog.net).slice(0, 40)}」`);
        check('M11c Q8 分段上限在真实链路生效（超限采样日志带「上限 = N」提示）',
            String(llmLog.cap).includes('超上限') && String(llmLog.cap).includes('上限 ='), String(llmLog.cap).slice(0, 90));
        await evaluate(`(function(){
            var c=${CTX};
            if(window.__bkFunnel2){ c.setFunnelLayer('rule',!!window.__bkFunnel2.rule); c.setFunnelLayer('vector',!!window.__bkFunnel2.vector); c.setFunnelLayer('llm',!!window.__bkFunnel2.llm); }
            return 'ok';
        })()`);
        await sleep(300);
    }

    // ═════════ M10 渲染错误 ═════════
    check('M10 无 console.error / Vue 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    const pass = results.filter(r => r.ok).length;
    console.log(`\n═════ 手动测试汇总：${pass}/${results.length} PASS ═════`);
    if (pass !== results.length) { console.log('失败项：'); results.filter(r => !r.ok).forEach(r => console.log('  ✗ ' + r.n)); }
    process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('探针异常：', e && e.message || e); process.exit(1); });
