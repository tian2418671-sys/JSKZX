/** 真实点按：打开 AI 打标弹窗 → 展开「⚡ 预填充」→ 确认新增的「API 兼容」控件 + 截图 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PORT = Number(process.env.CDP_PORT || 9375);
const SHOT_DIR = path.join(os.tmpdir(), 'jsk-manual-test');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa, t = 15000) => new Promise((res, rej) => { const id = ++i; const timer = setTimeout(() => { q.delete(id); rej(new Error('超时')); }, t); q.set(id, (m) => { clearTimeout(timer); res(m); }); s.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async (x) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const r = m.result || {}; return r.exceptionDetails ? { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text } : (r.result ? r.result.value : undefined); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTX = `(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;return (app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx)))||null;})()`;
const clickAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await sleep(500); };
const find = async (text, tag = 'button') => JSON.parse(await ev(`(function(){var els=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(tag)}));for(var i=0;i<els.length;i++){var el=els[i];var t=String(el.textContent||'').replace(/\\s+/g,' ').trim();if(t.indexOf(${JSON.stringify(text)})>=0&&el.getBoundingClientRect().width>2){var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:t.slice(0,28)});}}return JSON.stringify({err:'未找到 '+${JSON.stringify(text)}});})()`));
const clickText = async (t, tag = 'button') => { const b = await find(t, tag); if (b.err) { console.log('   ⚠️ ' + b.err); return false; } await clickAt(b.x, b.y); console.log(`   🖱️ 点击「${b.t}」@(${b.x},${b.y})`); return true; };

const results = [];
const step = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

console.log('当前兼容表:', JSON.stringify(await ev(`(function(){ var c = ${CTX}; return JSON.stringify({ mode: c.prefillCompatMode.value, table: c.prefillCompatTable.value }); })()`)));
await sleep(400);
const opened = await clickText('AI 打标', 'button');
await sleep(1200);
const inModal = await ev(`(function(){ var t=document.body.innerText||''; return t.indexOf('预填充')>=0; })()`);
step('真实点按打开「AI 智能批量打标」弹窗', opened && inModal === true);

const expand = await clickText('预填充');
await sleep(600);
const ui = JSON.parse(await ev(`(function(){
  var t = document.body.innerText || '';
  var sel = Array.prototype.slice.call(document.querySelectorAll('select')).filter(function (s) { return /自动判断|总是先试|从不发/.test(String(s.textContent||'')); })[0];
  return JSON.stringify({ hasCompatLabel: t.indexOf('API 兼容') >= 0, hasSelect: !!sel, options: sel ? sel.options.length : 0,
                          status: (t.match(/当前：[^\\n]{0,40}|已自动判定[^\\n]{0,40}|尚未判定[^\\n]{0,40}/)||[''])[0] });
})()`));
await (async () => { const m = await send('Page.captureScreenshot', { format: 'png' }, 10000); const d = m.result && m.result.data; if (d) { const f = path.join(SHOT_DIR, 'compat-ui.png'); fs.writeFileSync(f, Buffer.from(d, 'base64')); console.log('   📷 ' + f); } })();
step('「API 兼容」控件已渲染（三态下拉 + 状态文案）', ui.hasCompatLabel && ui.hasSelect && ui.options === 3, JSON.stringify(ui));

const pass = results.filter(Boolean).length;
console.log(`\n══ 预填充兼容 UI 验证：${pass}/${results.length} 通过 ══`);
process.exit(pass === results.length ? 0 : 1);
