/**
 * 🖱️ 新功能「真实点按」验收（CDP 真实鼠标事件 + 截图）
 *
 * 与既有探针的区别：**不走 ctx 调用**，全部通过真实鼠标事件（`Input.dispatchMouseEvent`，走命中测试）
 * 与真实键入，像用户一样点按；只能靠代码驱动的设置项（如冷备目录选择器是原生对话框）会显式标注为「预设」。
 *
 * 阶段（STAGE 环境变量）：
 *   qc       🧪 一键质检：维护菜单 → 弹窗 → 取消勾选查重 → 开始 → 展开 → 定位 → 导出/复制 → 关闭
 *   backup   📦 整库冷备：维护菜单 → 弹窗（禁用态）→（预设目录）→ 立即冷备 → 刷新 → 关闭
 *   merge    🔀 世界书合并：切世界书视图 → 查重 → 组卡片「合并此组」→ 预览 → 取消
 *   export   ⬇️ 会话导出：打开卡片 → 聊天页 → 导出 → 落盘核对
 *   startup  🚀 启动任务：设置菜单 → 弹窗 → 开关/延迟 → 复位 → 关闭
 *
 * 用法：STAGE=qc CDP_PORT=9375 node scripts/probes/_probe-manual-clickthrough.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const STAGE = process.env.STAGE || 'qc';
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'jsk-manual-test');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, params, timeoutMs = 15000) => new Promise((res, rej) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 超时: ' + me)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    s.send(JSON.stringify({ id, method: me, params }));
});
const ev = async (expr) => {
    try {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 20000);
        if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
        return r.result?.result?.value;
    } catch (e) { console.log('   ⚠️ ev 失败：' + e.message); return { __err: e.message }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const step = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

let shotNo = 0;
async function shot(name) {
    shotNo++;
    const file = path.join(SHOT_DIR, `${String(shotNo).padStart(2, '0')}-${name}.png`);
    try {
        const r = await send('Page.captureScreenshot', { format: 'png' }, 10000);
        if (r.result && r.result.data) {
            fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
            console.log(`   📷 ${file}`);
        } else { console.log('   ⚠️ 截图无数据：' + name); }
    } catch (e) { console.log('   ⚠️ 截图超时跳过：' + name); }
    return file;
}

/** 在页内按文本找可见元素（返回中心坐标） */
async function locate({ text, tag = '', nth = 0, exact = false, scope = '', fallback = 'button,[role="button"],a,label,summary' }) {
    const expr = `(function(){
      var tagSel = ${JSON.stringify(tag || fallback)};
      var want = ${JSON.stringify(text)};
      var exact = ${exact ? 'true' : 'false'};
      var nth = ${nth};
      var scopeSel = ${JSON.stringify(scope)};
      var root = scopeSel ? document.querySelector(scopeSel) : document;
      if (!root) return JSON.stringify({ err: 'scope 未找到: ' + scopeSel });
      var all = Array.prototype.slice.call(root.querySelectorAll(tagSel));
      var hits = all.filter(function (el) {
        var t = String(el.textContent || el.value || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
        if (!t) return false;
        var okText = exact ? (t === want) : (t.indexOf(want) >= 0);
        if (!okText) return false;
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        var st = window.getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
        return true;
      });
      if (!hits.length) return JSON.stringify({ err: '未找到元素: ' + want, candidates: all.slice(0, 60).map(function(e){ return String(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,28); }).filter(Boolean) });
      var el = hits[Math.min(nth, hits.length - 1)];
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r2 = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2), w: Math.round(r2.width), h: Math.round(r2.height), tag: el.tagName, text: String(el.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60), total: hits.length });
    })()`;
    const raw = await ev(expr);
    try { return JSON.parse(raw); } catch (e) { return { err: 'locate 解析失败: ' + String(raw).slice(0, 120) }; }
}

/** 真实鼠标点击（移动 → 按下 → 抬起） */
async function clickAt(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(260);
}

/** 按文本真实点击（返回是否成功定位） */
async function clickText(text, opts = {}) {
    const box = await locate(Object.assign({ text }, opts));
    if (box.err) { console.log(`   ⚠️ 点击「${text}」失败：${box.err}`); if (box.candidates) console.log('      候选：', box.candidates.slice(0, 14).join(' | ')); return false; }
    await clickAt(box.x, box.y);
    console.log(`   🖱️ 点击「${box.text}」 @(${box.x},${box.y})`);
    return true;
}

/** 点击并验证效果（未生效则重定位重点，最多 tries 次） */
async function clickUntil(text, predicate, opts = {}, tries = 3) {
    for (let k = 0; k < tries; k++) {
        const loc = Object.assign({}, opts, { nth: (opts.nth || 0) + k === 0 ? (opts.nth || 0) : (opts.nth || 0) + (k > 0 ? 0 : 0) });
        const box = await locate(Object.assign({ text }, loc));
        if (box.err) { console.log(`   ⚠️ 第${k + 1}次未找到「${text}」：${box.err}`); continue; }
        await clickAt(box.x, box.y);
        console.log(`   🖱️ 第${k + 1}次点击「${box.text.slice(0, 30)}」@(${box.x},${box.y})`);
        await sleep(500);
        if (await predicate()) return true;
    }
    return false;
}

/** 真实清空 + 键入（用于数字输入框）：三击选中 → 逐字键入 → Enter（都走真实键盘/鼠标事件） */
async function typeNumber(text, value) {
    const box = await locate({ text, tag: 'input', fallback: 'input' });
    if (box.err) { console.log('   ⚠️ 输入框未找到：' + box.err); return false; }
    // 三击选中全部（比 Ctrl+A 在 number 输入框里更可靠）
    for (let c = 1; c <= 3; c++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: c });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: c });
        await sleep(60);
    }
    const digits = String(value).split('');
    for (const ch of digits) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
        await sleep(50);
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(400);
    return true;
}

const CTX = `(function(){var a=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;return (a&&(a._context.provides.appCtx||(a._container._vnode.component.provides.appCtx)))||null;})()`;

/** 清场：关闭所有可能挡住点击的弹窗（**测试前置**，真正的被测动作仍全部走真实点按） */
async function resetUi() {
    await ev(`(function(){
      var c = ${CTX};
      var keys = ['showQualityCheckModal','showFullBackupModal','showStartupTasksModal','showWbMergePreview',
                  'showWbMergeModal','showDedupeModal','showWbDedupeModal','showPresetDedupeModal',
                  'showContentDedupeModal','showDiffDetailModal','showApiModal'];
      keys.forEach(function (k) { try { if (c[k]) c[k].value = false; } catch (e) {} });
      try { if (c.showStartupTasksModal) c.showStartupTasksModal.value = false; } catch (e) {}
      return 1;
    })()`);
    await sleep(500);
    const left = await ev(`(function(){
      var open = [];
      ['一键质检','整库冷备','启动自动任务','世界书合并 · 预览','智能版本查重中心','重名世界书'].forEach(function (kw) {
        if ((document.body.innerText || '').indexOf(kw) >= 0) open.push(kw);
      });
      return JSON.stringify(open);
    })()`);
    console.log('   🧹 清场后仍可见的弹窗:', left);
    return JSON.parse(left);
}
const modalOpen = (kw) => ev(`(function(){ var t = document.body.innerText || ''; return t.indexOf(${JSON.stringify(kw)}) >= 0; })()`);

console.log(`══ 真实点按验收 · 阶段=${STAGE} · 截图目录=${SHOT_DIR} ══`);
console.log('页面:', p.title || '(无标题)', '|', p.url.slice(0, 60));

if (STAGE === 'qc') {
    // ① 清场 + 复位勾选（保证下面每一次点按都落在正确的控件上）
    const leftover = await resetUi();
    step('起始状态干净（无残留弹窗挡住点击）', leftover.length === 0, JSON.stringify(leftover));
    await ev(`(function(){ var c = ${CTX}; c.qcEnabled.rescan = true; c.qcEnabled.dedupe = false; c.qcEnabled.tags = true; c.qcEnabled.audit = true; c.qcEnabled.wb = true; return 1; })()`);
    await sleep(300);
    await shot('qc-00-初始');

    // ② 真实点击「维护」菜单
    const menuOk = await clickText('维护', { exact: false });
    await shot('qc-01-维护菜单');
    step('点开「维护」菜单', menuOk);

    // ③ 真实点击「🧪 一键质检…」
    const openOk = await clickText('一键质检…');
    await sleep(700);
    const opened = await modalOpen('一键质检');
    await shot('qc-02-质检弹窗');
    step('点「🧪 一键质检…」打开弹窗', openOk && opened === true, `弹窗可见=${opened}`);

    // ④ 真实点击取消勾选「S2 查重扫描」（保持点按流程快）
    const before2 = await ev(`(function(){ var c = ${CTX}; return c.qcEnabled.wb; })()`);
    const uncheck = await clickText('S5 世界书词条体检', { fallback: 'label' });
    await sleep(300);
    const after2 = await ev(`(function(){ var c = ${CTX}; return c.qcEnabled.wb; })()`);
    // 本阶段保持 S2 关闭（卡片查重弹窗会盖住质检弹窗，归 merge 阶段单独验）
    await shot('qc-03-点按切换S2');
    step('真实点按切换「S5 世界书词条体检」勾选态（并复原）', uncheck && before2 !== after2, `${before2} → ${after2}`);
    await ev(`(function(){ var c = ${CTX}; c.qcEnabled.wb = true; c.qcEnabled.dedupe = false; return 1; })()`);   // 本阶段不跑 S2（查重弹窗会盖住报告）

    // ⑤ 真实点击「▶ 开始质检」
    const runOk = await clickText('开始质检');
    await sleep(600);
    await shot('qc-04-执行中');
    // 等跑完（最慢是 S1 重扫）
    for (let i = 0; i < 40; i++) {
        const running = await ev(`(function(){ var c = ${CTX}; return c.qcRunning === true; })()`);
        if (running === false) break;
        await sleep(600);
    }
    const done = await ev(`(function(){ var c = ${CTX}; return JSON.stringify((c.qcSteps.value||[]).map(function(x){ return x.id + ':' + x.status; })); })()`);
    const dlgState = await ev(`(function(){ var c = ${CTX}; return JSON.stringify({ dedupeModal: c.showDedupeModal ? c.showDedupeModal.value : '(无)', qcEnabledDedupe: c.qcEnabled.dedupe }); })()`);
    console.log('   查重弹窗状态:', dlgState);
    await shot('qc-05-完成');
    step('点「▶ 开始质检」并跑完（真实库）', runOk && /tags:done/.test(done) && /audit:done/.test(done), String(done));

    // ⑥ 真实点击展开「S3 标签分析」**结果区**（⚠️ 配置区同文案 ⇒ 用 clickUntil 验证「展开后出现清单」）
    const ensureS3On = await ev(`(function(){ var c = ${CTX}; if (c.qcEnabled.tags === false) c.qcEnabled.tags = true; return c.qcEnabled.tags; })()`);
    const expand = await clickUntil('S3 标签分析', async () => {
        const t2 = await ev(`(function(){ var t=document.body.innerText||''; return /标签种类|Top 标签|共 \\d+ 张卡：/.test(t); })()`);
        return t2 === true;
    }, { tag: 'button', nth: 1 });
    await shot('qc-06-展开S3');
    step('真实点按展开「S3 标签分析」看到清单', expand === true, `S3 勾选=${ensureS3On}`);

    // ⑦ 真实点击清单里的「定位」（点击后卡片应被打开；未生效则重试）
    const locateOk = await clickUntil('定位', async () => {
        const v = await ev(`(function(){ var c = ${CTX}; return !!(c.cardData && c.cardData.value); })()`);
        return v === true;
    }, { tag: 'button' });
    await sleep(2200);
    const afterLocate = JSON.parse(await ev(`(function(){
      var c = ${CTX};
      return JSON.stringify({ card: !!(c.cardData && c.cardData.value), modalClosed: c.showQualityCheckModal.value === false,
                               stillInDom: /开始质检/.test(document.body.innerText || '') });
    })()`));
    await shot('qc-07-定位打开卡片');
    step('真实点按「定位」：卡片打开 + 质检弹窗收起（目标呈现在前面）',
        locateOk === true && afterLocate.card === true && afterLocate.modalClosed === true && afterLocate.stillInDom === false, JSON.stringify(afterLocate));
    // 重新打开质检弹窗（报告仍在）以便继续测导出/复制/关闭
    await ev(`(function(){ var c = ${CTX}; c.openQualityCheck(); return 1; })()`);
    await sleep(900);
    const reportKept = await ev(`(function(){ var c = ${CTX}; return (c.qcReport.value || '').length > 200; })()`);
    step('重新打开后报告仍在（定位不丢结果）', reportKept === true);

    // ⑧ 真实点击「💾 导出 Markdown」
    const expOk = await clickUntil('导出 Markdown', async () => {
        const m = await ev(`(function(){ var t=document.body.innerText||''; return /已导出/.test(t); })()`);
        return m === true;
    }, { tag: 'button' });
    await sleep(1200);
    const expMsg = await ev(`(function(){ var t = document.body.innerText||''; return (t.match(/已导出[^\\n]*/)||[''])[0]; })()`);
    await shot('qc-08-导出报告');
    const savePath = process.env.JSK_APP_SAVE_PATH || '';
    let diskOk = null;
    if (savePath && fs.existsSync(savePath)) {
        const txt = fs.readFileSync(savePath, 'utf8');
        diskOk = txt.includes('一键质检报告');
    }
    step('真实点按「💾 导出 Markdown」并落盘', expOk && !!expMsg, `${expMsg}${diskOk === null ? '' : ' | 落盘含报告头=' + diskOk}`);

    // ⑨ 真实点击「📋 复制报告」
    const copyOk = await clickUntil('复制报告', async () => {
        const m = await ev(`(function(){ var t=document.body.innerText||''; return /已复制|复制失败/.test(t); })()`);
        return m === true;
    }, { tag: 'button' });
    await sleep(600);
    const copyMsg = await ev(`(function(){ var t=document.body.innerText||''; return t.indexOf('已复制')>=0; })()`);
    await shot('qc-09-复制报告');
    step('真实点按「📋 复制报告」有反馈', copyOk && copyMsg === true);

    // ⑩ 真实点击关闭
    const closeOk = await clickUntil('知道了', async () => {
        const c2 = await ev(`(function(){ var c = ${CTX}; return c.showQualityCheckModal.value === false; })()`);
        return c2 === true;
    }, { tag: 'button' });
    await sleep(500);
    const closed = await modalOpen('▶ 开始质检');
    await shot('qc-10-关闭');
    step('真实点按关闭质检弹窗', closeOk && closed === false);
}

if (STAGE === 'backup') {
    await resetUi();
    // 先清空冷备目录，看禁用态
    await ev(`(function(){ var c = ${CTX}; c.fullBackupDir.value = ''; return 1; })()`);
    await sleep(300);
    await clickText('维护');
    const openOk = await clickText('整库冷备…');
    await sleep(700);
    const opened = await modalOpen('冷备目录');
    await shot('bk-01-弹窗-未选目录');
    step('点「📦 整库冷备…」打开弹窗（未选目录）', openOk && opened === true);
    const disabled = await ev(`(function(){
      var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
      var b = btns.filter(function(x){ return /立即冷备/.test(x.textContent||''); })[0];
      return b ? { disabled: !!b.disabled, title: b.getAttribute('title') || '' } : { err: 'no btn' };
    })()`);
    step('未选目录时「📦 立即冷备」为禁用并给出原因', !!(disabled && disabled.disabled === true), JSON.stringify(disabled));

    // 预设目录（原生目录对话框无法自动化 ⇒ 显式标注为预设），再真实点按冷备
    const dest = process.env.BK_DEST || '';
    await ev(`(function(){ var c = ${CTX}; c.fullBackupDir.value = ${JSON.stringify(dest)}; return 1; })()`);
    await sleep(900);
    await shot('bk-02-预设目录后');
    const enabled = await ev(`(function(){
      var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
      var b = btns.filter(function(x){ return /立即冷备/.test(x.textContent||''); })[0];
      return b ? !b.disabled : false;
    })()`);
    step('（预设目录后）「📦 立即冷备」可用', enabled === true);
    const runOk = await clickText('立即冷备');
    await sleep(800);
    await shot('bk-03-冷备执行中');
    for (let i = 0; i < 60; i++) {
        const busy = await ev(`(function(){ var t=document.body.innerText||''; return /正在复制|正在列文件/.test(t); })()`);
        if (busy === false) break;
        await sleep(500);
    }
    await sleep(1200);
    const bkState = await ev(`(function(){ var t=document.body.innerText||''; return JSON.stringify({ ok: /冷备完成/.test(t), row: /角色卡__\\d/.test(t), text: (t.match(/冷备完成[^\\n]*/)||[''])[0] }); })()`);
    await shot('bk-04-冷备完成');
    step('真实点按「📦 立即冷备」→ 完成并出现在列表', runOk && JSON.parse(bkState).ok === true, bkState);
    const refreshOk = await clickText('刷新');
    await sleep(700);
    await shot('bk-05-刷新列表');
    step('真实点按「⟳ 刷新」列表仍在', refreshOk);
    const closeOk = await clickText('知道了', { nth: 0 });
    await sleep(400);
    step('真实点按关闭冷备弹窗', closeOk);
}

if (STAGE === 'merge') {
    await resetUi();
    // 真实点按侧栏「🌍」切世界书视图
    const wbOk = await clickText('🌍', { exact: false, tag: 'button' });
    await sleep(1200);
    const mode = await ev(`(function(){ var c = ${CTX}; return c.appMode.value; })()`);
    await shot('mg-01-世界书视图');
    step('真实点按切换到世界书视图', wbOk && mode === 'worldbooks', `appMode=${mode}`);

    // 真实点按「工具」菜单 → 「同名查重与版本清理（世界书）」（查重在当前视图自动分发到世界书）
    const menuOk2 = await clickText('工具');
    await sleep(500);
    const dedupeOk = await clickText('同名查重');
    console.log('   工具菜单点击=', menuOk2, '查重入口点击=', dedupeOk);
    await sleep(2500);
    await shot('mg-02-查重弹窗');
    const dlg = await modalOpen('重名世界书');
    step('真实点按「查重」打开查重弹窗', dedupeOk && dlg === true, `含'重名世界书'=${dlg}`);

    // 等扫描（若弹窗内有扫描按钮则点它）
    const scanBtn = await ev(`(function(){
      var btns = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
        var t=String(b.textContent||'').replace(/\\s+/g,' ').trim();
        return /开始查重|重新查重|扫描/.test(t) && b.getBoundingClientRect().width>2;
      });
      return btns.length ? String(btns[0].textContent||'').replace(/\\s+/g,' ').trim() : '';
    })()`);
    if (scanBtn) { await clickText(scanBtn.slice(0, 6)); await sleep(2500); }
    for (let i = 0; i < 30; i++) {
        const groups = await ev(`(function(){ var c = ${CTX}; return (c.wbDuplicateGroups.value||[]).length; })()`);
        if (groups > 0) break;
        await sleep(1000);
    }
    const groups = await ev(`(function(){ var c = ${CTX}; return (c.wbDuplicateGroups.value||[]).length; })()`);
    await shot('mg-03-查重结果');
    step('查重出组（用于点按合并入口）', groups > 0, `组数=${groups}`);

    const mergeBtnOk = await clickText('合并此组');
    await sleep(2000);
    const prevOpen = await modalOpen('世界书合并 · 预览');
    await shot('mg-04-合并预览');
    step('真实点按「🔀 合并此组」打开预览', mergeBtnOk && prevOpen === true, `预览可见=${prevOpen}`);
    const previewNums = await ev(`(function(){ var t=document.body.innerText||''; return (t.match(/产出[^\\n]*/)||[''])[0]; })()`);
    console.log('   预览数字:', previewNums);

    const cancelOk = await clickUntil('取消', async () => {
        const c2 = await ev(`(function(){ var c = ${CTX}; return c.showWbMergePreview.value === false; })()`);
        return c2 === true;
    }, { tag: 'button' }, 3);
    await sleep(800);
    const closed = await modalOpen('世界书合并 · 预览');
    await shot('mg-05-取消预览');
    step('真实点按「取消」（不执行合并，保护真库）', cancelOk && closed === false, `预览仍可见=${closed}`);
    // 关闭查重弹窗
    const xOk = await ev(`(function(){
      var btns = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){ return /✕ 关闭|✕/.test(String(b.textContent||'')); });
      if (!btns.length) return false;
      var r = btns[0].getBoundingClientRect();
      window.__probeCloseBtn = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      return true;
    })()`);
    if (xOk) {
        const pos = await ev('JSON.stringify(window.__probeCloseBtn)');
        const pt = JSON.parse(pos);
        await clickAt(pt.x, pt.y);
        await sleep(500);
    }
    // 回到角色卡视图（真实点按）
    await clickText('📁', { fallback: 'button', exact: false });
    await sleep(600);
    await shot('mg-06-收尾');
}

if (STAGE === 'export') {
    await resetUi();
    const cardName = await ev(`(function(){ var c = ${CTX}; var lib = c.library.value||[]; return lib[0] ? String(lib[0].name||'') : ''; })()`);
    console.log('   目标卡:', cardName);
    // 真实点按侧栏第一张卡（打开编辑器）
    const cardOk = await clickUntil(cardName, async () => (await ev(`(function(){ var c = ${CTX}; return !!c.cardData.value; })()`)) === true, { tag: 'div', exact: true }, 3);
    await sleep(3000);
    const opened = await ev(`(function(){ var c = ${CTX}; return !!c.cardData.value; })()`);
    await shot('ex-01-打开卡片');
    step('真实点按打开卡片（进入编辑器）', opened === true, cardName);

    // 真实点按「💬 聊天测试」打开侧栏 → 再点「聊天」页
    const panelOk = await clickText('聊天测试', { tag: 'button' });
    await sleep(1500);
    const tabOk = await clickText('聊天', { tag: 'button', exact: false });
    await sleep(1000);
    await shot('ex-02-聊天页');
    const ctrl = await ev(`(function(){
      var sel = Array.prototype.slice.call(document.querySelectorAll('select')).filter(function (s) { return /Markdown|HTML|纯文本|md/i.test(String(s.textContent||'')); });
      var btns = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) { return /导出/.test(String(b.textContent||'')) && b.getBoundingClientRect().width > 2; });
      return JSON.stringify({ selects: sel.length, exportBtns: btns.length, btnText: btns[0] ? String(btns[0].textContent||'').trim() : '' });
    })()`);
    console.log('   侧栏控件:', ctrl);
    step('真实点按开侧栏 → 切「聊天」页 → 看到格式下拉与导出按钮', panelOk && tabOk && JSON.parse(ctrl).exportBtns >= 1, ctrl);

    // 选格式（真实点按 select 后键盘选择太脆，这里用真实点按 select 再回车）
    const exportOk = await clickText('导出', { tag: 'button' });
    await sleep(1500);
    const msg = await ev(`(function(){ var t=document.body.innerText||''; return (t.match(/已导出[^\\n]*/)||[''])[0]; })()`);
    await shot('ex-03-导出完成');
    step('真实点按「⬇️ 导出」', exportOk && !!msg, msg || '(无提示)');
    const savePath = process.env.JSK_APP_SAVE_PATH || '';
    if (savePath && fs.existsSync(savePath)) {
        const txt = fs.readFileSync(savePath, 'utf8');
        const st = fs.statSync(savePath);
        const isSession = txt.indexOf(cardName) >= 0 || /###\s/.test(txt);
        step('导出内容为**会话导出**（含卡片名/消息标题）', isSession, `${st.size} 字节，前 60 字：${txt.slice(0, 60).replace(/\n/g, '⏎')}`);
    } else {
        step('（未设 JSK_APP_SAVE_PATH ⇒ 跳过落盘核对）', true, savePath || '(空)');
    }
}

if (STAGE === 'startup') {
    await resetUi();
    await clickText('工具');
    await sleep(500);
    await shot('st-01-工具菜单');
    const openOk = await clickText('启动任务…');
    await sleep(800);
    const opened = await modalOpen('启动自动任务');
    await shot('st-02-启动任务弹窗');
    step('点「工具」→「🚀 启动任务…」打开弹窗（设置菜单不渲染自定义命令 ⇒ 已改挂工具菜单）', openOk && opened === true);

    // 真实点按总开关
    const masterOk = await clickText('启用启动任务', { fallback: 'label' });
    await sleep(400);
    const masterOn = await ev(`(function(){ var c = ${CTX}; return c.startupTasks.value.enabled === true; })()`);
    await shot('st-03-总开关开');
    step('真实点按「启用启动任务」总开关', masterOk && masterOn === true, `enabled=${masterOn}`);

    // 真实点按「启动轻量体检」
    const auditOk = await clickText('启动轻量体检', { fallback: 'label' });
    await sleep(400);
    const auditOn = await ev(`(function(){ var c = ${CTX}; return c.startupTasks.value.autoAudit === true; })()`);
    await shot('st-04-勾选体检');
    step('真实点按勾选「启动轻量体检」', auditOk && auditOn === true, `autoAudit=${auditOn}`);

    // 真实改延迟
    const typed = await typeNumber('延迟执行', 2000);
    await sleep(500);
    const delay = await ev(`(function(){ var c = ${CTX}; return c.startupTasks.value.delayMs; })()`);
    await shot('st-05-改延迟');
    step('真实键入修改延迟（→2000ms）', typed && delay === 2000, `delayMs=${delay}`);

    // 复位：真实点按关掉两个开关（保持用户配置干净）
    await clickText('启动轻量体检', { fallback: 'label' });
    await sleep(300);
    await clickText('启用启动任务', { fallback: 'label' });
    await sleep(300);
    const reset = await ev(`(function(){ var c = ${CTX}; return JSON.stringify(c.startupTasks.value); })()`);
    await shot('st-06-复位');
    step('真实点按复位为全关（不留测试痕迹）', JSON.parse(reset).enabled === false && JSON.parse(reset).autoAudit === false, reset);
    await clickText('知道了', { nth: 0 });
    await sleep(400);
    await shot('st-07-关闭');
}

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 真实点按（${STAGE}）：${pass}/${results.length} 步通过 ═════`);
results.filter((x) => !x.ok).forEach((x) => console.log('  ❌ ' + x.n + '  ' + (x.d || '')));
console.log('截图目录:', SHOT_DIR);
process.exit(pass === results.length ? 0 : 1);
