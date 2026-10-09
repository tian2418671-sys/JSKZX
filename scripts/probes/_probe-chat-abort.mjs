/**
 * 🛑 「暂停 = 立即中断」验证（零 API 成本 · 分阶段求值）
 *  ① 本地起「永不响应」服务 → ② 让 app 请求它（挂住，**不 await**，把 promise 挂在 window 上）
 *  ③ 500ms 后调 chat:abort → ④ 再读挂在 window 上的结果 ⇒ 断言「立刻以『已中断』结束」而非等 120s 超时
 */
import http from 'node:http';

const PORT = Number(process.env.CDP_PORT || 9375);
const HANG_PORT = Number(process.env.HANG_PORT || 34567);

const hang = http.createServer(() => { /* 故意不响应 */ });
await new Promise((r) => hang.listen(HANG_PORT, '127.0.0.1', r));
console.log(`🕳 挂死服务器 http://127.0.0.1:${HANG_PORT}`);

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa, t = 15000) => new Promise((res, rej) => { const id = ++i; const timer = setTimeout(() => { q.delete(id); rej(new Error('CDP 超时 ' + me)); }, t); q.set(id, (m) => { clearTimeout(timer); res(m); }); s.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async (x, t) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, t); const r = m.result || {}; if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result ? (r.result.value !== undefined ? r.result.value : (r.result.description || null)) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

// ① 发请求（不 await）
const fired = await ev(`(function(){
  var api = window.electronAPI;
  if (!api || typeof api.sendChatMessage !== 'function') return 'no sendChatMessage';
  window.__abortTest = { state: 'pending', err: '', ms: 0, rejected: false };
  var t0 = performance.now();
  api.sendChatMessage('http://127.0.0.1:${HANG_PORT}/v1/chat/completions', { model: 'hang', messages: [{ role: 'user', content: 'hi' }] }, 'k', 'openai')
    .then(function (r) { window.__abortTest.state = 'resolved'; window.__abortTest.err = 'resolved:' + JSON.stringify(r).slice(0, 60); window.__abortTest.ms = Math.round(performance.now() - t0); })
    .catch(function (e) { window.__abortTest.state = 'rejected'; window.__abortTest.err = String((e && e.message) || e); window.__abortTest.ms = Math.round(performance.now() - t0); });
  return 'fired';
})()`);
step('发起一个必然挂起的 chat 请求（本地黑洞）', fired === 'fired', String(fired));

await sleep(700);
const before = await ev('JSON.stringify(window.__abortTest)');
console.log('   中断前:', before);
step('中断前仍挂起（证明它真的卡住了）', /pending/.test(String(before)), String(before).slice(0, 80));

// ② 调 chat:abort
const ab = await ev(`(async function(){ try { return JSON.stringify(await window.electronAPI.abortChatMessage()); } catch (e) { return 'ERR ' + e.message; } })()`);
step('preload 暴露 abortChatMessage 且调通', /ok/.test(String(ab)) && /aborted/.test(String(ab)), String(ab));

await sleep(800);
const after = await ev('JSON.stringify(window.__abortTest)');
console.log('   中断后:', after);
const a = JSON.parse(String(after));
// ⚠️ 契约：`sendChatMessage` 失败时 **resolve** 成 {success:false,error}（不 reject）⇒ 两种都算「已中断」
const interrupted = (a.state === 'rejected' || (a.state === 'resolved' && /已中断/.test(a.err || '')));
step('挂住的请求被**立即**中断（<5s，而非等 120s 超时）', interrupted && a.ms > 0 && a.ms < 5000, `state=${a.state} ms=${a.ms}`);
step('错误文案为「已中断（用户暂停）」', /已中断/.test(a.err || ''), String(a.err).slice(0, 60));
step('中断计数 ≥1（说明在途请求确实登记上了）', /"aborted":\s*[1-9]/.test(String(ab)), String(ab));

hang.close();
const pass = results.filter(Boolean).length;
console.log(`\n══ 即时中断验证：${pass}/${results.length} 通过 ══`);
process.exit(pass === results.length ? 0 : 1);
