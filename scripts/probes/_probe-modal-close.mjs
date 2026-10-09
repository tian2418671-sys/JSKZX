/** 真实点按复验：质检弹窗两种关法（✕ 关闭 / 知道了） */
const PORT = Number(process.env.CDP_PORT || 9375);
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa) => new Promise((res) => { const id = ++i; q.set(id, res); s.send(JSON.stringify({ id, method: me, params: pa })); });
const val = async (x) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return m.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(450);
};
const inDom = async () => (await val(`/开始质检/.test(document.body.innerText||'')`)) === true;
const findBtn = async (kw) => JSON.parse((await val(`(function(){
  var out = null;
  Array.prototype.slice.call(document.querySelectorAll('button')).forEach(function (b) {
    var t = String(b.textContent||'').replace(/\\s+/g,' ').trim();
    var r = b.getBoundingClientRect(); if (r.width < 2) return;
    if (!out && t.indexOf(${JSON.stringify(kw)}) >= 0) out = { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
  });
  return JSON.stringify(out);
})()`)) || 'null');

const results = [];
const step = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

// ① 真实点按「维护」→「🧪 一键质检…」打开
const menu = await findBtn('维护');
if (menu) await clickAt(menu.x, menu.y);
const item = await findBtn('一键质检…');
if (item) await clickAt(item.x, item.y);
await sleep(900);
step('真实点按打开质检弹窗', await inDom());

// ② 真实点按右上「✕ 关闭」
const closeBtn = await findBtn('✕ 关闭');
if (closeBtn) await clickAt(closeBtn.x, closeBtn.y);
await sleep(600);
const closedByX = !(await inDom());
step('真实点按「✕ 关闭」能关掉（本次修的 bug）', closedByX, closeBtn ? `按钮(${closeBtn.x},${closeBtn.y})` : '未找到按钮');

// ③ 再打开 → 真实点按「知道了」
const menu2 = await findBtn('维护');
if (menu2) await clickAt(menu2.x, menu2.y);
const item2 = await findBtn('一键质检…');
if (item2) await clickAt(item2.x, item2.y);
await sleep(900);
const reopened = await inDom();
const okBtn = await findBtn('知道了');
if (okBtn) await clickAt(okBtn.x, okBtn.y);
await sleep(600);
step('再打开后真实点按「知道了」也能关掉', reopened && !(await inDom()), okBtn ? `按钮(${okBtn.x},${okBtn.y})` : '未找到按钮');

// ④ 顺带回归：其余弹窗的关闭（启动任务 / 整库冷备）——都走各自 @close
const tools = await findBtn('工具');
if (tools) await clickAt(tools.x, tools.y);
const st = await findBtn('启动任务…');
if (st) await clickAt(st.x, st.y);
await sleep(800);
const stOpen = (await val(`/启用启动任务/.test(document.body.innerText||'')`)) === true;
const stClose = await findBtn('知道了');
if (stClose) await clickAt(stClose.x, stClose.y);
await sleep(600);
const stClosed = (await val(`/启用启动任务/.test(document.body.innerText||'')`)) === false;
step('启动任务弹窗：打开→「知道了」关闭正常', stOpen && stClosed, `打开=${stOpen} 关闭=${stClosed}`);

const pass = results.filter(Boolean).length;
console.log(`\n══ 关闭回归：${pass}/${results.length} 通过 ══`);
process.exit(pass === results.length ? 0 : 1);
