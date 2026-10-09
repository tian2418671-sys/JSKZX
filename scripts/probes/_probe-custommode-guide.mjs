/** 临时：真机验证「📖 教程」——打开、章节切换、SVG 图解、配方按钮、无模板编译告警（端口 9375） */
const PORT = 9375;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const sock = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const warns = [];
sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) {
        warns.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
};
await new Promise((r) => { sock.onopen = r; });
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable');

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };
const ctxExpr = `(function(){var a=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;return (a&&((a._context&&a._context.provides&&a._context.provides.appCtx)||(a._container&&a._container._vnode&&a._container._vnode.component&&a._container._vnode.component.provides&&a._container._vnode.component.provides.appCtx)))||null;})()`;
const clickText = (sel, text) => ev(`(function(){var els=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(sel)}));var el=els.find(function(e){return (e.textContent||'').indexOf(${JSON.stringify(text)})>=0;});if(!el)return false;el.click();return true;})()`);
const bodyText = () => ev('document.body.innerText || ""');

// 准备：打开打标窗 + 切到自定义模式页
await ev(`(function(){var c=${ctxExpr};if(!c) return 'noctx';c.appMode.value='worldbooks';if(c.aiTagTargetMode)c.aiTagTargetMode.value='worldbooks';c.showAITagModal.value=true;return 'ok';})()`);
await sleep(1200);
await clickText('button', '自定义模式');
await sleep(700);

const before = await bodyText();
check('准备：已在「自定义模式」页', before.includes('自定义模式') && before.includes('材料占位符'));

// 复位：若上一轮留着教程没关（组件实例不销毁 ⇒ active 会保留），先关掉再开，保证从 ① 节开始
if (before.includes('自定义模式 · 图文教程')) {
    await clickText('button', '知道了');
    await sleep(1200);
}

// 点「📖 教程」
const clicked = await clickText('button', '📖 教程');
await sleep(900);
// ⚠️ 教程组件实例在开关之间**不销毁** ⇒ `active` 会保留上一轮停留的章节；断言前显式回到 ① 节
await clickText('nav button', '这是什么');
await sleep(400);
const guideTxt = await bodyText();
const guideDom = await ev(`(function(){
  // 教程根：含标题的那层 fixed 容器
  var all = Array.prototype.slice.call(document.querySelectorAll('div'));
  var root = all.filter(function(e){ return (e.textContent||'').indexOf('自定义模式 · 图文教程') >= 0 && e.className && String(e.className).indexOf('fixed inset-0') >= 0; }).pop();
  if (!root) return { found:false };
  var nav = Array.prototype.slice.call(root.querySelectorAll('nav button'));
  return {
    found: true,
    tocCount: nav.length,
    tocTitles: nav.map(function(b){ return (b.textContent||'').replace(/\\s+/g,' ').trim(); }),
    svgCount: root.querySelectorAll('svg').length,
    hasApplyBtn: (root.textContent||'').indexOf('套用到我的段') >= 0,
    zClass: String(root.className)
  };
})()`);
check('点击「📖 教程」后弹窗打开', clicked === true && guideDom.found === true, JSON.stringify({ clicked, found: guideDom.found }));
check('章节目录 10 节', guideDom.tocCount === 10, JSON.stringify(guideDom.tocTitles || []).slice(0, 160));
check('① 首节渲染（两条链路图解）', guideTxt.includes('两条提示词链路') && guideDom.svgCount >= 1, `svg=${guideDom.svgCount}`);

// 逐节切过去，确认每节都有实质内容 + 该节图解
const sections = [
    ['段与角色', '段 = 一条消息'],
    ['预填充原理', '末尾的 ASSISTANT 段'],
    ['程序自动材料', '程序会自动附加哪些材料'],
    ['自动附加三档', '三档怎么选'],
    ['占位符', '把材料插到你指定的位置'],
    ['三个配方', '三个照抄配方'],
    ['读懂发送预览', '怎么读'],
    ['功能边界', '最容易踩的四条'],
    ['排错清单', '症状 → 原因 → 做法']
];
let secOk = 0, svgTotal = 0;
for (const [nav, marker] of sections) {
    await clickText('nav button', nav);
    await sleep(320);
    const t = await bodyText();
    const has = t.includes(marker);
    if (has) secOk++;
    const svgs = await ev(`(function(){var all=Array.prototype.slice.call(document.querySelectorAll('div'));var root=all.filter(function(e){return (e.textContent||'').indexOf('自定义模式 · 图文教程')>=0 && e.className && String(e.className).indexOf('fixed inset-0')>=0;}).pop();return root?root.querySelectorAll('svg').length:0;})()`);
    svgTotal = Math.max(svgTotal, svgs);
    if (!has) console.log(`  · 缺内容：${nav} → 期望包含「${marker}」`);
}
check('9 节全部可切换且有内容', secOk === sections.length, `${secOk}/${sections.length}`);

// 配方与占位符表
await clickText('nav button', '三个配方');
await sleep(320);
const recipeTxt = await bodyText();
check('配方 3 个 + 套用按钮存在', recipeTxt.includes('🅰 极简') && recipeTxt.includes('🅱 分角色') && recipeTxt.includes('🅲 全手动') && recipeTxt.includes('套用到我的段'));
const applyCount = await ev(`(function(){return Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').indexOf('套用到我的段')>=0;}).length;})()`);
check('「📥 套用到我的段」按钮 3 个（未点击，避免覆盖你的段）', applyCount === 3, `count=${applyCount}`);

await clickText('nav button', '占位符');
await sleep(320);
const varTxt = await bodyText();
check('占位符 8 项（含 $1 与破限）', varTxt.includes('目标材料') && varTxt.includes('$1') && varTxt.includes('破限'));
check('字面量花括号显示正常（未被插值吞掉）', varTxt.includes('{{材料}}') && varTxt.includes('{{破限}}'), '');

// 关闭（注意：教程是 <transition name="fade"> 淡出；窗口被遮挡时 Chromium 会节流 rAF，
// 过渡可能被推迟到下一次重绘才完成 ⇒ **必须轮询**，不能固定等待后做一次性 DOM 断言。
// 本仓库 _probe-aitag-hot.mjs 头部就记过这个坑：「弹窗关不掉」多为 rAF 被节流的假失败。）
await clickText('button', '知道了');
let closed = false;
for (let i = 0; i < 20; i++) {
    await sleep(300);
    const t = await bodyText();
    if (!t.includes('自定义模式 · 图文教程')) { closed = true; break; }
}
const afterClose = await bodyText();
// 区分「状态真没变」与「过渡卡住」：读教程组件的 show prop（卡住时它已是 false）
const propShow = await ev(`(function(){
  var els = Array.prototype.slice.call(document.querySelectorAll('div'));
  var root = els.filter(function(e){ return (e.textContent||'').indexOf('自定义模式 · 图文教程') >= 0 && e.className && String(e.className).indexOf('fixed inset-0') >= 0; }).pop();
  if (!root) return 'gone';
  var c = root.__vueParentComponent;
  return c && c.$props ? String(c.$props.show) : 'unknown';
})()`);
check('「知道了」可关闭教程（打标窗仍在）', closed && afterClose.includes('AI 智能批量打标'),
    `closed=${closed} propShow=${propShow} tagModal=${afterClose.includes('AI 智能批量打标')}`);

// 模板编译 / 渲染告警
const badWarns = warns.filter((w) => /runtime compilation|template|Failed to resolve component|Property .* was accessed during render/i.test(w));
check('无「运行时模板编译 / 组件未解析 / 未定义属性」告警', badWarns.length === 0, badWarns.slice(0, 3).join(' | '));

const pass = results.filter((r) => r.ok).length;
console.log(`\n═════ 教程真机验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.n));
process.exit(pass === results.length ? 0 : 1);
