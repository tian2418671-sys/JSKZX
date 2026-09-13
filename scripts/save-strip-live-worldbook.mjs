/**
 * 【真实落盘验证 · 补充】另外 3 条被改动的落盘路径
 *   ① file:saveCard 的 .json 分支
 *   ② wb:create（新建世界书）
 *   ③ wb:save（覆盖世界书）
 * 与 save-strip-live-card.mjs 同款思路：注入污染 → 真实 IPC 落盘 → 读回逐项断言。
 *
 * 前置：Vite dev server(5173) + Electron --remote-debugging-port=9222
 * 用法：node scripts/save-strip-live-worldbook.mjs <userData 下的可写样本目录>
 */
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9222/json/list';
const DIR = process.argv[2];
if (!DIR) { console.error('用法: node scripts/save-strip-live-worldbook.mjs <样本目录>'); process.exit(1); }

let msgId = 0;
const pending = new Map();
let sock;

async function getPageWs() {
  const list = await (await fetch(CDP_HTTP)).json();
  const page = list.find((t) => t.type === 'page' && /localhost:5173|app:\/\//.test(t.url || ''));
  if (!page) throw new Error('未找到页面 target（Electron 未就绪？）');
  return page.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    sock = new WebSocket(wsUrl);
    sock.onopen = () => resolve();
    sock.onerror = () => reject(new Error('WS error'));
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: rs, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rj(new Error(msg.error.message));
        else rs(msg.result);
      }
    };
  });
}

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 120000 });
  if (r.exceptionDetails) {
    throw new Error('EvalException: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result && r.result.value;
}

function buildExpr(dir) {
  // ⚠️ 路径在 Node 侧生成 JSON 字面量，不手工转义
  const paths = {
    jsonCard: join(dir, 'plain-card.json'),
    wbNew: join(dir, 'wb-created.json'),
    wbOverwrite: join(dir, 'wb-overwrite.json'),
  };
  return `(async () => {
  const api = window.electronAPI;
  const P = ${JSON.stringify(paths)};
  const out = { ok: true, cases: [] };
  const INTERNAL = new Set(['_collapsed','_mtime','_ctime','_size','_importTime','_srcIndex','_srcUid']);
  const foreign = (o) => { const a = []; (function w(x,p){ if(x&&typeof x==='object'){ if(Array.isArray(x)) return x.forEach(v=>w(v,p+'[]'));
      for (const k of Object.keys(x)) { if ((k.startsWith('_')&&!INTERNAL.has(k))||k==='uid') a.push(p+'/'+k); w(x[k],p+'/'+k); } } })(o,''); return a; };

  const mkBook = (n) => { const es = []; for (let i=0;i<n;i++) es.push({ content:'entry-'+i, extensions:{ _filename:'e'+i+'.json' } }); return es; };
  const pollute = (es) => es.forEach((e,i)=>{ e.uid = 700000+i; e._collapsed = i%2===0; });

  // ① .json 卡片保存
  {
    const c = { name: 'saveCard(.json)' };
    try {
      const ideal = { name:'测试卡', description:'d', first_mes:'hi',
        extensions:{ tavern_helper:{ variables:{ phone_data:{ _exportMeta:{ v:1 } } } } },
        character_book:{ name:'b', entries: mkBook(5) } };
      const payload = JSON.parse(JSON.stringify(ideal));
      pollute(payload.character_book.entries);
      // 先写一份「已存在」的目标文件（saveCard 要求原文件存在）
      const seed = await api.createWorldbook({ filePath: P.jsonCard, data: payload });
      c.seed = seed;
      const t0 = await api.readText(P.jsonCard);
      const before = JSON.parse(t0.text);
      const save = await api.saveCard(P.jsonCard, payload);
      c.save = save; c.entryCount = before.character_book.entries.length;
      c.foreignBefore = foreign(ideal);
      const t1 = await api.readText(P.jsonCard);
      const after = JSON.parse(t1.text);
      c.leaked = after.character_book.entries.filter(e => 'uid' in e || '_collapsed' in e).length;
      const set = new Set(foreign(after));
      c.lost = c.foreignBefore.filter(f => !set.has(f));
      c.keptExportMeta = !!(after.extensions && after.extensions.tavern_helper
        && after.extensions.tavern_helper.variables.phone_data._exportMeta);
      c.keptFilename = after.character_book.entries.every(e => typeof e.extensions._filename === 'string');
      c.nameOk = after.name === '测试卡' && after.first_mes === 'hi';
      if (c.leaked || c.lost.length || !c.keptExportMeta || !c.keptFilename || !c.nameOk) { c.error = '断言失败'; out.ok = false; }
    } catch (e) { c.error = String(e.message||e); out.ok = false; }
    out.cases.push(c);
  }

  // ② wb:create 新建世界书
  {
    const c = { name: 'createWorldbook(wb:create)' };
    try {
      const entries = mkBook(4); pollute(entries);
      const payload = { name:'新世界书', description:'d', entries };
      const res = await api.createWorldbook({ filePath: P.wbNew, data: payload });
      c.save = res;
      const t = await api.readText(P.wbNew);
      const j = JSON.parse(t.text);
      c.leaked = j.entries.filter(e => 'uid' in e || '_collapsed' in e).length;
      c.keptFilename = j.entries.every(e => typeof e.extensions._filename === 'string');
      c.metaOk = j.name === '新世界书' && j.description === 'd' && j.entries.length === 4;
      if (!res.success || c.leaked || !c.keptFilename || !c.metaOk) { c.error = '断言失败'; out.ok = false; }
    } catch (e) { c.error = String(e.message||e); out.ok = false; }
    out.cases.push(c);
  }

  // ③ wb:save 覆盖世界书
  {
    const c = { name: 'saveWorldbook(wb:save)' };
    try {
      const clean = { name:'覆盖书', description:'d2', entries: mkBook(3) };
      const seed = await api.createWorldbook({ filePath: P.wbOverwrite, data: JSON.parse(JSON.stringify(clean)) });
      const entries = mkBook(3); pollute(entries);
      c.seed = seed;
      const res = await api.saveWorldbook({ filePath: P.wbOverwrite, data: { name:'覆盖书', description:'d2', entries } });
      c.save = res;
      const t = await api.readText(P.wbOverwrite);
      const j = JSON.parse(t.text);
      c.leaked = j.entries.filter(e => 'uid' in e || '_collapsed' in e).length;
      c.keptFilename = j.entries.every(e => typeof e.extensions._filename === 'string');
      c.metaOk = j.name === '覆盖书' && j.entries.length === 3;
      if (!res.success || c.leaked || !c.keptFilename || !c.metaOk) { c.error = '断言失败'; out.ok = false; }
    } catch (e) { c.error = String(e.message||e); out.ok = false; }
    out.cases.push(c);
  }

  // 🧹 清理样本文件（不动用户卡片库）
  try { await api.deleteFile(P.jsonCard); } catch {}
  try { await api.deleteFile(P.wbNew); } catch {}
  try { await api.deleteFile(P.wbOverwrite); } catch {}
  return JSON.stringify(out);
})()`;
}

async function main() {
  const ws = await getPageWs();
  await connect(ws);
  await send('Runtime.enable');
  const rep = JSON.parse(await evaluate(buildExpr(DIR)));
  console.log('总体:', rep.ok ? '✅ 全部通过' : '❌ 存在失败');
  for (const c of rep.cases) {
    console.log(`\n— ${c.name}` + (c.error ? `   ❌ ${c.error}` : '   ✅'));
    console.log(`   保存返回: ${JSON.stringify(c.save)}`);
    console.log(`   残留前端字段: ${c.leaked}   第三方字段丢失: ${(c.lost || []).length}${(c.lost||[]).length ? ' → ' + c.lost.join(', ') : ''}`);
    console.log(`   第三方 _filename 保住: ${c.keptFilename}   业务字段(名称/首条问候/词条数/描述)保住: ${c.nameOk ?? c.metaOk}`);
    if (c.keptExportMeta !== undefined) console.log(`   extensions._exportMeta 保住: ${c.keptExportMeta}`);
  }
  sock.close();
  process.exit(rep.ok ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
