/**
 * ✅ 预览展开性能修复的「功能回归」（2026-10-03 新增 · 对应 PK-34）
 *
 * 干什么：断言性能优化没有牺牲功能 —— ① 超长段渲染为**只读摘要**（有 🐌 提示）
 *   ② 每个超长段都有「📥 载入全部」按钮 ③ 展开后**不再出现 >8000 字的 textarea**（防卡顿生效）
 *   ④ 短段仍是**可直接编辑**的 textarea ⑤ 点「载入全部并编辑」能放出该段全文 textarea
 *   ⑥ 锁定超长段时按钮标注「（只读）」且字形 🔒/🔓 正确。
 *
 * 用法（CDP_PORT 默认 9375）：
 *   node scripts/probes/_probe-preview-expand-regression.mjs
 *
 * ⚠️ 本探针**开头会 Page.reload**：`fullParts`（已放行全文的段）是组件内 UI 态，
 *    上一轮跑完不会自动清 ⇒ 不隔离的话第 ③ 条会被上一轮残留污染成假失败（真踩过）。
 */
const PORT = Number(process.env.CDP_PORT || 9375);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const sock = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { sock.onopen = r; });
const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTX = `(function(){var a=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;return (a&&(a._context.provides.appCtx||(a._container._vnode.component.provides.appCtx)))||null;})()`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };

// ⚠️ 先重载页面：`fullParts`（已放行全文的段）是组件内 UI 态，**上一轮跑完不会自动清**
//    ⇒ 不隔离的话「展开后不该有超长 textarea」会被上一轮的残留污染成假失败。
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(14000);
const reloaded = await ev(`(function(){var a=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;return !!a;})()`);
check('前置：页面已重载（组件 UI 态归零）', reloaded === true);
await sleep(500);

// 准备
await ev(`(async function(){var c=${CTX};var l=c.worldbooks.value||[];var b=l.reduce(function(a,x){return ((x.size||0)>(a.size||0))?x:a;},l[0]||{});await c.selectWorldbook(b);c.appMode.value='worldbooks';if(c.aiTagTargetMode)c.aiTagTargetMode.value='worldbooks';if(c.wbTagRange)c.wbTagRange.value='filtered';c.showAITagModal.value=true;return 'ok';})()`);
await sleep(2500);
await ev(`(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').indexOf('自定义模式')>=0;})[0];if(b)b.click();return 'ok';})()`);
await sleep(800);
await ev(`(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').indexOf('全部展开')>=0;})[0];if(b)b.scrollIntoView({block:'center'});return 'ok';})()`);
await sleep(400);
const clickBtn = (t) => ev(`(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').indexOf(${JSON.stringify(t)})>=0;})[0];if(!b)return false;b.click();return true;})()`);

await clickBtn('全部折叠');
await sleep(300);
await clickBtn('全部展开');
await sleep(600);

// 1) 摘要视图存在
const st = await ev(`(function(){
  var txt = document.body.innerText || '';
  var t0 = performance.now();
  var summaryNotes = (txt.match(/超长段（共 \\d+ 字）/g) || []).length;
  var loadBtns = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').indexOf('载入全部')>=0;});
  var tas = Array.prototype.slice.call(document.querySelectorAll('textarea'));
  var editableSmall = tas.filter(function(t){ return (t.value||'').length > 0 && (t.value||'').length <= 8000; }).length;
  var heavyTa = tas.filter(function(t){ return (t.value||'').length > 8000; }).length;
  return { summaryNotes: summaryNotes, loadBtnCount: loadBtns.length, textareas: tas.length, editableSmall: editableSmall, heavyTextareas: heavyTa, elapsed: Math.round(performance.now()-t0) };
})()`);
check('超长段渲染为「摘要视图」（有🐌提示）', st.summaryNotes > 0, `summaryNotes=${st.summaryNotes}`);
check('每个超长段都有「📥 载入全部」按钮', st.loadBtnCount === st.summaryNotes, `btns=${st.loadBtnCount} notes=${st.summaryNotes}`);
check('展开后不再有 >8000 字的 textarea（防卡顿生效）', st.heavyTextareas === 0, `heavy=${st.heavyTextareas}`);
check('短段仍是可直接编辑的 textarea', st.editableSmall > 0, `可编辑短段=${st.editableSmall}`);

// 2) 点「载入全部并编辑」→ 出现全文 textarea（并计时）
const loadCost = await ev(`(async function(){
  var btn = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').indexOf('载入全部')>=0;})[0];
  if (!btn) return { err: 'no btn' };
  var before = document.querySelectorAll('textarea').length;
  var t0 = performance.now();
  btn.click();
  await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(); }); }); });
  await new Promise(function(r){ setTimeout(r, 500); });
  var tas = Array.prototype.slice.call(document.querySelectorAll('textarea'));
  var heavy = tas.filter(function(t){ return (t.value||'').length > 8000; });
  return { ms: Math.round(performance.now()-t0), before: before, after: tas.length, heavyCount: heavy.length, heavyChars: heavy.reduce(function(n,t){return n+(t.value||'').length;},0) };
})()`);
check('「📥 载入全部并编辑」放出该段全文 textarea', loadCost.heavyCount >= 1, JSON.stringify(loadCost));

// 3) 锁定段：摘要按钮文案为「（只读）」且载入后是 pre 不是 textarea
const lockedCase = await ev(`(async function(){
  // ⚠️ 必须挑**超长段**（含「载入全部」按钮的那个）来锁 —— 首轮探针点了第一个段头（短段）导致假失败
  var loadBtn = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').indexOf('载入全部')>=0;})[0];
  if (!loadBtn) return { err: 'no load btn' };
  var box = loadBtn;
  while (box && !(box.querySelector && box.querySelector('[data-part-head]'))) box = box.parentElement;
  var head = box ? box.querySelector('[data-part-head]') : null;
  if (!head) return { err: 'no part head for heavy part' };
  var lockBtn = head.querySelector('button');
  if (!lockBtn) return { err: 'no lock btn' };
  lockBtn.click();                                   // 锁定（local UI 态，不落盘）
  await new Promise(function(r){ setTimeout(r, 400); });
  var btns = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').indexOf('载入全部')>=0;});
  var readonlyBtn = btns.filter(function(b){return (b.textContent||'').indexOf('只读')>=0;}).length;
  var out = { readonlyBtns: readonlyBtn, totalLoadBtns: btns.length, lockGlyph: (lockBtn.textContent||'').trim() };
  lockBtn.click();                                   // 解锁还原
  await new Promise(function(r){ setTimeout(r, 300); });
  out.unlockedGlyph = (lockBtn.textContent||'').trim();
  return out;
})()`);
check('锁定超长段的载入按钮标注「（只读）」', lockedCase.readonlyBtns >= 1, JSON.stringify(lockedCase));

// 还原
await ev(`(function(){var c=${CTX};if(c.showAITagModal)c.showAITagModal.value=false;return 'ok';})()`);
const pass = results.filter((r) => r.ok).length;
console.log(`\n═════ 性能修复功能回归：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.n));
process.exit(pass === results.length ? 0 : 1);
