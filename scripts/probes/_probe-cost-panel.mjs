/**
 * 💰 真机验证：本次预估面板（世界书 + 卡片两种模式）
 * 纯读界面 + 临时切模式/选卡（结束时恢复原选择），不写配置、不发请求。
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

// 面板文本：含「本次预计」的卡片
const panelText = () => ev(`(function(){
  var els = Array.prototype.slice.call(document.querySelectorAll('div'));
  var el = els.filter(function(e){ return (e.textContent||'').indexOf('本次预计（仅显示') >= 0 && e.className && String(e.className).indexOf('border-indigo-200') >= 0; }).pop();
  return el ? (el.innerText || '').replace(/\\n+/g, ' | ') : '';
})()`);
const barText = () => ev(`(function(){
  var s = Array.prototype.slice.call(document.querySelectorAll('span')).filter(function(e){ return (e.textContent||'').indexOf('请求 · ≈') >= 0; }).pop();
  return s ? (s.innerText||'').trim() : '';
})()`);

// 打开打标窗 + 切到「执行管线」页
await ev(`(function(){var c=${CTX};c.showAITagModal.value=true;return 'ok';})()`);
await sleep(1200);
await ev(`(function(){var bs=Array.prototype.slice.call(document.querySelectorAll('nav button, button'));var b=bs.filter(function(x){return (x.textContent||'').trim().indexOf('执行管线')>=0;})[0];if(b)b.click();return 'ok';})()`);
await sleep(800);

// ───── 世界书模式：筛选结果 = 全部世界书 ─────
const savedSel = await ev(`(function(){var c=${CTX};return JSON.stringify((c.selectedIds&&c.selectedIds.value)||[]);})()`);
const savedMode = await ev(`(function(){var c=${CTX};return String(c.appMode.value);})()`);
await ev(`(function(){var c=${CTX};c.appMode.value='worldbooks';if(c.aiTagTargetMode)c.aiTagTargetMode.value='worldbooks';if(c.wbTagRange)c.wbTagRange.value='filtered';if(c.wbSearchQuery)c.wbSearchQuery.value='';return 'ok';})()`);
await sleep(3500); // 等材料按需载入
let p = await panelText();
console.log('  [世界书面板]', p.slice(0, 210));
check('世界书面板出现且显示目标数/请求数/token/覆盖', /目标\s*\d+\s*本/.test(p) && /请求数/.test(p) && /token/.test(p) && /覆盖/.test(p), '');
const wbNums = p.match(/目标\s*([\d,]+)\s*本[\s\S]*?请求数\s*≈\s*([\d,]+)[\s\S]*?token\s*≈\s*([\d,]+)[\s\S]*?覆盖\s*([\d.]+%)/);
const wbReq = wbNums ? Number(wbNums[2].replace(/,/g, '')) : 0;
const wbCover = wbNums ? parseFloat(wbNums[4]) : 0;
check('世界书请求数与「分段上限 40 × 目标数」同量级', wbReq >= 40 && wbReq <= 2000, `requests=${wbReq}`);
check('世界书覆盖率 < 100%（大库必然采样）', wbCover > 0 && wbCover < 100, `coverage=${wbCover}%`);
check('底部「开始打标」旁有预估一行', /≈[\d,]+ 请求 · ≈[\d,]+ token · 覆盖/.test(await barText()), await barText());

// 调低分段上限 → 请求数与 token 必须下降、覆盖率不变或下降（联动验证）
const before = { req: wbReq };
await ev(`(function(){var c=${CTX};c.tagWbSegmentMax.value=8;return 'ok';})()`);
await sleep(700);
p = await panelText();
const afterReq = Number(((p.match(/请求数\s*≈\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''));
check('分段上限 40→8 后请求数下降（面板与设置联动）', afterReq > 0 && afterReq < before.req, `${before.req} → ${afterReq}`);
await ev(`(function(){var c=${CTX};c.tagWbSegmentMax.value=40;return 'ok';})()`);
await sleep(500);

// ───── 卡片模式：选 6 张短卡 + 打包 3 ─────
await ev(`(function(){var c=${CTX};c.appMode.value='characters';if(c.aiTagTargetMode)c.aiTagTargetMode.value='characters';return 'ok';})()`);
await sleep(900);
await ev(`(function(){
  var c=${CTX}; var lib=(c.library&&c.library.value)||[];
  var pick=lib.slice(0,6).map(function(x){return x.id;});
  if(c.selectedIds) c.selectedIds.value=pick;
  return pick.length;
})()`);
await sleep(1200);
let pc = await panelText();
console.log('  [卡片面板·打包1]', pc.slice(0, 210));
check('卡片面板显示「目标 N 张」与打包信息位', /目标\s*6\s*张/.test(pc), '');
await ev(`(function(){var c=${CTX};if(c.tagPackSize)c.tagPackSize.value=3;return 'ok';})()`);
await sleep(800);
pc = await panelText();
console.log('  [卡片面板·打包3]', pc.slice(0, 210));
const packReq = Number(((pc.match(/请求数\s*≈\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''));
check('打包 3 张/请求后出现「打包成组」且请求数 ≤ 卡片数', /打包成组/.test(pc) && packReq > 0 && packReq <= 6, `requests=${packReq}`);

// ───── 还原 ─────
await ev(`(function(){var c=${CTX};if(c.appMode)c.appMode.value=${JSON.stringify(savedMode)};if(c.tagPackSize)c.tagPackSize.value=1;if(c.selectedIds)c.selectedIds.value=${savedSel};if(c.showAITagModal)c.showAITagModal.value=false;return 'ok';})()`);
console.log('  （已还原：模式 / 打包张数 / 选中卡片 / 关闭弹窗）');

const pass = results.filter((r) => r.ok).length;
console.log(`\n═════ 预估面板真机验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.n));
process.exit(pass === results.length ? 0 : 1);
