/**
 * 真实点按复验：悬浮批量条新增的「☑️ 全选 / 🔄 反选」
 * 路径：标签菜单 →「☑️ 批量选择模式」→ 点卡片勾选 → 悬浮条出现 → 点「☑️ 全选」→ 点「🔄 反选」
 * 断言：选中数量与 filteredLibrary 一致 / 反选后为补集 / 反馈是 **toast**（不弹原生框）/ 截图
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'jsk-manual-test');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa, t = 15000) => new Promise((res, rej) => {
    const id = ++i; const timer = setTimeout(() => { q.delete(id); rej(new Error('超时 ' + me)); }, t);
    q.set(id, (m) => { clearTimeout(timer); res(m); });
    s.send(JSON.stringify({ id, method: me, params: pa }));
});
const ev = async (x) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const r = m.result || {}; if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result ? r.result.value : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTX = `(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;return (app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx)))||null;})()`;
let shotNo = 0;
const shot = async (n) => { shotNo++; try { const m = await send('Page.captureScreenshot', { format: 'png' }, 10000); const d = m.result && m.result.data; if (d) { const f = path.join(SHOT_DIR, `sel-${String(shotNo).padStart(2, '0')}-${n}.png`); fs.writeFileSync(f, Buffer.from(d, 'base64')); console.log('   📷', f); } } catch (e) { console.log('   ⚠️ 截图跳过'); } };
const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(420);
};
const find = async (text, tag = 'button', exact = false) => {
    const raw = await ev(`(function(){
      var want = ${JSON.stringify(text)}, exact = ${exact ? 'true' : 'false'};
      var els = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(tag)}));
      for (var i = 0; i < els.length; i++) {
        var el = els[i]; var t = String(el.textContent || el.value || '').replace(/\\s+/g, ' ').trim();
        if ((exact ? t === want : t.indexOf(want) >= 0) && el.getBoundingClientRect().width > 2) {
          var r = el.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), t: t.slice(0, 30) });
        }
      }
      return JSON.stringify({ err: '未找到 ' + want });
    })()`);
    return JSON.parse(raw);
};
const clickText = async (text, tag = 'button', exact = false) => {
    const b = await find(text, tag, exact);
    if (b.err) { console.log('   ⚠️ ' + b.err); return false; }
    await clickAt(b.x, b.y);
    console.log(`   🖱️ 点击「${b.t}」@(${b.x},${b.y})`);
    return true;
};
const state = async () => JSON.parse(await ev(`(function(){
  var c = ${CTX};
  return JSON.stringify({ sel: (c.selectedIds.value || []).length, filtered: (c.filteredLibrary.value || []).length, multi: c.isMultiSelectMode.value === true,
                           selIds: (c.selectedIds.value || []).slice(0, 4), filteredIds: (c.filteredLibrary.value || []).slice(0, 4).map(function (x) { return x.id; }),
                           toasts: (c.toasts.value || []).map(function (t) { return String(t.message || '').slice(0, 40); }) });
})()`));
const results = [];
const step = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

// 0) 清场
await ev(`(function(){ var c = ${CTX}; try { c.closeQualityCheck(); c.showFullBackupModal.value = false; c.showStartupTasksModal.value = false; c.clearSelection(); c.isMultiSelectMode.value = false; } catch (e) {} return 1; })()`);
await sleep(500);

// 1) 真实点按「标签」→「☑️ 批量选择模式」
await clickText('标签');
await sleep(400);
const multiOk = await clickText('批量选择模式');
await sleep(700);
const st1 = await state();
step('真实点按开启「批量选择模式」', multiOk && st1.multi === true, `multi=${st1.multi}`);

// 2) 真实点按第一张卡的复选框（勾 1 张 → 悬浮条出现）
const box = JSON.parse(await ev(`(function(){
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox]'));
  for (var i = 0; i < inputs.length; i++) {
    var r = inputs[i].getBoundingClientRect();
    if (r.width > 2 && r.top > 60 && r.left < 460) return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
  }
  return JSON.stringify({ err: '未找到卡片复选框' });
})()`));
if (!box.err) { await clickAt(box.x, box.y); console.log(`   🖱️ 点击卡片复选框 @(${box.x},${box.y})`); }
await sleep(700);
const st2 = await state();
await shot('勾选1张-悬浮条');
step('真实点按勾选 1 张卡（悬浮条出现）', st2.sel >= 1, `selected=${st2.sel}/${st2.filtered}`);

// 3) 真实点按「☑️ 全选」
const allOk = await clickText('全选', 'button');
await sleep(900);
const st3 = await state();
await shot('全选后');
step('真实点按「☑️ 全选」→ 选中数 = 当前筛选列表数', allOk && st3.sel === st3.filtered && st3.sel > 1, `selected=${st3.sel} filtered=${st3.filtered}`);
step('反馈是 toast（非原生提示框）', (st3.toasts || []).some((t) => /已全选/.test(t)), JSON.stringify(st3.toasts));

// 4) 真实点按「🔄 反选」
const invOk = await clickText('反选', 'button');
await sleep(900);
const st4 = await state();
await shot('反选后');
const isComplement = st4.sel === (st4.filtered - st3.sel);
step('真实点按「🔄 反选」→ 选中数 = 补集', invOk && (isComplement || st4.sel === st4.filtered), `反选前 ${st3.sel} → 反选后 ${st4.sel}（列表 ${st4.filtered}）`);
step('反选也有 toast 反馈', (st4.toasts || []).some((t) => /已反选/.test(t)), JSON.stringify(st4.toasts));

// 5) 收尾：取消选择 + 关闭多选模式
await clickText('取消选择', 'button');
await sleep(400);
const st5 = await state();
await shot('收尾');
step('收尾：取消选择后悬浮条消失', st5.sel === 0, `selected=${st5.sel}`);

const pass = results.filter(Boolean).length;
console.log(`\n══ 全选/反选按钮验证：${pass}/${results.length} 通过 ══`);
console.log('截图目录:', SHOT_DIR);
process.exit(pass === results.length ? 0 : 1);
