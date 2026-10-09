/**
 * 🐌 「📨 程序自动材料（发送预览）」展开性能实测（2026-10-03 新增 · 对应 PK-34）
 *
 * 干什么：真库 + 真界面点「全部展开」，量四个指标 —— 点击→首帧/次帧耗时、期间 longtask、
 *   展开后 textarea 数量与文本总量、DOM 节点数。两个场景：
 *     A 筛选结果 = 全部世界书（多目标、总文本量最大）
 *     B 当前书 = 最大那本（单目标、单段超长）
 *
 * 用法（需 dev 模式 + CDP + 真实库；CDP_PORT 默认 9375）：
 *   node scripts/probes/_probe-preview-expand-perf.mjs
 *
 * 📌 修复前基线（2026-10-03 实测，全部世界书 = 37 段 / 491 万字）：
 *   全部展开 5,345ms / 16,651ms，**单次 longtask 16,408ms**，43 个 textarea 共 4,909,291 字。
 *   ⇒ 病根 = 把整份材料塞进 textarea，代价≈3.3μs/字符（与字符量线性，非 Vue 渲染慢）。
 * 📌 修复后：97ms / 267ms，longtask 257ms，textarea 总字符 44,419。
 *
 * ⚠️ 改这个探针前先看 regression 探针：它负责断言「摘要视图 / 载入全部 / 短段仍可编辑」没被改坏。
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

// 装一个长期有效的 longtask 观察器（只在本页生命周期内有效）
await ev(`(function(){
  if (window.__perfLongTasks) return 'installed';
  window.__perfLongTasks = [];
  try {
    new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ window.__perfLongTasks.push(Math.round(e.duration)); }); }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__perfLongTasks = null; }
  return 'installed';
})()`);

/** 点某个按钮并测「点击 → 首帧 / 次帧」耗时 + 期间 longtask */
const clickAndMeasure = (btnText) => ev(`(async function(){
  var btn = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').indexOf(${JSON.stringify(btnText)}) >= 0;})[0];
  if (!btn) return { err: '按钮未找到' };
  if (window.__perfLongTasks) window.__perfLongTasks.length = 0;
  var t0 = performance.now();
  btn.click();
  var t1 = await new Promise(function(r){ requestAnimationFrame(function(){ r(performance.now()); }); });
  var t2 = await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(performance.now()); }); }); });
  await new Promise(function(r){ setTimeout(r, 300); });   // 给渲染/布局收尾
  var tas = Array.prototype.slice.call(document.querySelectorAll('textarea'));
  var taLen = tas.reduce(function(n,t){ return n + (t.value||'').length; }, 0);
  var pres = Array.prototype.slice.call(document.querySelectorAll('pre'));
  var preLen = pres.reduce(function(n,p){ return n + (p.textContent||'').length; }, 0);
  return {
    clickToFirstFrame: Math.round(t1 - t0),
    clickToSecondFrame: Math.round(t2 - t0),
    longTasks: (window.__perfLongTasks || []).slice(),
    textareas: tas.length, textareaChars: taLen,
    pres: pres.length, preChars: preLen,
    domNodes: document.querySelectorAll('*').length
  };
})()`);

const prep = async (range) => {
    await ev(`(async function(){
      var c=${CTX};
      var l=c.worldbooks.value||[];
      var b=l.reduce(function(a,x){return ((x.size||0)>(a.size||0))?x:a;},l[0]||{});
      await c.selectWorldbook(b);
      c.appMode.value='worldbooks';
      if(c.aiTagTargetMode) c.aiTagTargetMode.value='worldbooks';
      if(c.wbTagRange) c.wbTagRange.value=${JSON.stringify(range)};
      if(c.wbSearchQuery) c.wbSearchQuery.value='';
      c.showAITagModal.value=true;
      return 'ok';
    })()`);
    await sleep(2500); // 等材料生成（含正文按需载入）
    await ev(`(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').indexOf('自定义模式')>=0;})[0];if(b)b.click();return 'ok';})()`);
    await sleep(900);
    // 滚到预览区
    await ev(`(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').indexOf('全部展开')>=0;})[0];if(b)b.scrollIntoView({block:'center'});return 'ok';})()`);
    await sleep(600);
};

const summary = () => ev(`(function(){
  var c=${CTX}; var mp=c.materialPreview.value; var secs=mp.sections||[];
  var parts=secs.reduce(function(n,s){return n+((s.parts||[]).length);},0);
  var chars=secs.reduce(function(n,s){return n+(s.parts||[]).reduce(function(m,p){return m+String(p.body||'').length;},0);},0);
  return { sections: secs.length, parts: parts, materialChars: chars, targetCount: mp.targetCount };
})()`);

for (const [label, range] of [['A：筛选结果（全部世界书）', 'filtered'], ['B：当前书（最大一本）', 'current']]) {
    console.log(`\n═════ 场景 ${label} ═════`);
    await prep(range);
    console.log('材料规模：', JSON.stringify(await summary()));
    console.log('先全部折叠：', JSON.stringify(await clickAndMeasure('全部折叠')));
    console.log('→ 全部展开：', JSON.stringify(await clickAndMeasure('全部展开'), null, 0));
    console.log('→ 再全部折叠：', JSON.stringify(await clickAndMeasure('全部折叠'), null, 0));
}

// 还原
await ev(`(function(){var c=${CTX};if(c.showAITagModal)c.showAITagModal.value=false;if(c.wbSearchQuery)c.wbSearchQuery.value='';return 'restored';})()`);
console.log('\n（已关窗恢复）');
process.exit(0);
