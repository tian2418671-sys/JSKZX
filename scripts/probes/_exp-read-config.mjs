/**
 * 🧪 实验准备：从运行中的真实实例读取「实验所需的真实配置」（不打印 key）
 * 产物：%TEMP%\jsk-exp-cfg.json —— 供 `_exp-material-strategy.mjs` 使用
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const sock = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { sock.onopen = r; });
const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

const cfg = await ev(`(function(){
  var a = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
  var c = (a && (a._context.provides.appCtx || (a._container._vnode.component.provides.appCtx))) || null;
  if (!c) return { err: 'no ctx' };
  var mp = (c.materialPreview && c.materialPreview.value) || { sections: [] };
  var common = (mp.sections || []).filter(function (s) { return s.kind === 'common'; })[0] || { parts: [] };
  var byKey = {};
  (common.parts || []).forEach(function (p) { byKey[p.key] = String(p.body || ''); });
  var segs = (c.tagCustomSegments && c.tagCustomSegments.value) || [];
  return {
    endpoint: String((c.apiEndpoint && c.apiEndpoint.value) || ''),
    key: String((c.apiKey && c.apiKey.value) || ''),
    model: String((c.resolveApiModel && c.resolveApiModel()) || (c.apiModel && c.apiModel.value) || ''),
    apiType: String((c.apiType && c.apiType.value) || 'openai'),
    promptMode: String((c.tagPromptMode && c.tagPromptMode.value) || 'system'),
    task: byKey.task || '',
    pool: byKey.pool || '',
    output: byKey.output || '',
    systemSegs: segs.filter(function (s) { return s.role === 'system'; }).map(function (s) { return String(s.content || ''); }),
    userSegs: segs.filter(function (s) { return s.role === 'user'; }).map(function (s) { return String(s.content || ''); })
  };
})()`);

if (cfg && cfg.err) { console.error('读取失败:', cfg.err); process.exit(1); }
const out = path.join(os.tmpdir(), 'jsk-exp-cfg.json');
fs.writeFileSync(out, JSON.stringify(cfg, null, 1), 'utf8');
console.log('已写出配置:', out);
console.log('  endpoint :', cfg.endpoint);
console.log('  model    :', cfg.model);
console.log('  apiType  :', cfg.apiType);
console.log('  key      :', cfg.key ? `已获取（长度 ${cfg.key.length}，不打印）` : '❌ 空');
console.log('  promptMode:', cfg.promptMode);
console.log('  固定开销  : task', cfg.task.length, '字 / pool', cfg.pool.length, '字 / output', cfg.output.length, '字');
console.log('  SYSTEM 段 :', cfg.systemSegs.length, '段，合计', cfg.systemSegs.join('').length, '字');
console.log('  USER 段   :', cfg.userSegs.length, '段');
process.exit(0);
