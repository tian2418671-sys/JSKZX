/** 临时：查 app 日志里暂停相关痕迹（判断是点击没到，还是标志被清） */
const PORT = Number(process.env.CDP_PORT || 9375);
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa) => new Promise((res) => { const id = ++i; q.set(id, res); s.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async (x) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const r = m.result || {}; return r.exceptionDetails ? { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text } : (r.result ? r.result.result ? r.result.result.value : r.result.value : undefined); };
const CTX = `(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;return (app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx)))||null;})()`;

console.log('引擎状态:', await ev(`(function(){ var c = ${CTX};
  return JSON.stringify({
    isAITagging: c.isAITagging ? c.isAITagging.value : '(无)',
    tagPauseRequested: c.tagPauseRequested ? c.tagPauseRequested.value : '(无)',
    tagPausedNow: c.tagPausedNow ? c.tagPausedNow.value : '(无)',
    pauseTaggingType: typeof c.pauseTagging,
    showLog: c.showAiTagLog ? c.showAiTagLog.value : '(无)'
  });
})()`));

console.log('\n=== 打标日志里含「暂停」的条目 ===');
console.log(await ev(`(function(){ var c = ${CTX};
  var rows = (c.aiTagLog && c.aiTagLog.value) || [];
  var hit = rows.filter(function (x) { return /暂停|已停|收尾/.test(String(x.text || '')); });
  return JSON.stringify(hit.slice(-8).map(function (x) { return String(x.text || '').slice(0, 90); }), null, 0);
})()`));

console.log('\n=== editorLogs 里含「暂停」的条目 ===');
console.log(await ev(`(function(){ var c = ${CTX};
  var rows = (c.editorLogs && c.editorLogs.value) || [];
  var hit = rows.filter(function (x) { return /暂停/.test(String(x.msg || '')); });
  return JSON.stringify(hit.slice(0, 8).map(function (x) { return x.time + ' ' + String(x.msg || '').slice(0, 80); }), null, 0);
})()`));

console.log('\n=== 打标日志最近 6 条（看暂停前后发生了什么）===');
console.log(await ev(`(function(){ var c = ${CTX};
  var rows = (c.aiTagLog && c.aiTagLog.value) || [];
  return JSON.stringify(rows.slice(-6).map(function (x) { return String(x.text || '').slice(0, 100); }), null, 0);
})()`));

console.log('\n=== 断点账本（续跑用）===');
console.log(await ev(`(function(){ var c = ${CTX};
  var keys = Object.keys(c).filter(function (k) { return /resume|Resume|ledger|pending/i.test(k); });
  var out = {};
  keys.slice(0, 8).forEach(function (k) { try { out[k] = (c[k] && typeof c[k] === 'object' && 'value' in c[k]) ? String(JSON.stringify(c[k].value)).slice(0, 80) : typeof c[k]; } catch (e) { out[k] = 'err'; } });
  return JSON.stringify(out);
})()`));
process.exit(0);
