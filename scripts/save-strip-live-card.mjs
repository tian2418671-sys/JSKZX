/**
 * 【真实落盘验证】stripInternalFields 在**真实 IPC 保存链路**上的效果
 *
 * 为什么需要它：单测只证明纯函数正确；这里证明
 * 「渲染层 → ipcMain file:saveCard → writeTavernPNGChunk → 磁盘 PNG」整条链路
 * 真的把前端污染剔掉了，且一个第三方真实字段都没伤到。
 *
 * 做法：拿 userData/_strip_verify/ 下的**真实卡片副本**（含 entries[].extensions._filename、
 *       phone_data/_exportMeta 等第三方真实数据），在渲染进程里：
 *         ① readBuffer 读出原 PNG，解析 chara JSON
 *         ② 往内嵌世界书词条注入前端污染字段 uid / _collapsed（模拟真实前端行为）
 *         ③ electronAPI.saveCard() 真存
 *         ④ 再 readBuffer 读回，逐项断言
 *       断言：注入字段被剔除 / 第三方真实字段全在 / 其余字段逐项等于注入前 / PNG 结构完好。
 *
 * 前置：Vite dev server(5173) + Electron --remote-debugging-port=9222
 * 用法：node scripts/save-strip-live-card.mjs <userData/_strip_verify 目录>
 */
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9222/json/list';
const SAMPLE_DIR = process.argv[2];
if (!SAMPLE_DIR) { console.error('用法: node scripts/save-strip-live-card.mjs <样本目录>'); process.exit(1); }

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
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout: 120000,
  });
  if (r.exceptionDetails) {
    throw new Error('EvalException: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result && r.result.value;
}

/** 注入渲染进程执行的验证逻辑（自包含，不依赖应用内部状态） */
function buildExpr(sampleDir) {
  // ⚠️ 路径一律在 Node 侧用 JSON.stringify 生成字面量，绝不手工转义反斜杠
  //   （此前手工 `\\\\` 拼接产出双反斜杠路径 → isPathAllowed 判越界，误报为功能故障）
  const cases = ['sample-entryExt_filename.png', 'sample-exportMeta.png']
    .map((name) => ({ name, path: join(sampleDir, name) }));
  const CASES = JSON.stringify(cases);
  return `(async () => {
  const api = window.electronAPI;
  const CASES = ${CASES};
  const report = { ok: true, cases: [], errors: [] };
  if (!api || !api.saveCard || !api.readBuffer) {
    return JSON.stringify({ ok: false, errors: ['electronAPI 缺少 saveCard/readBuffer'] });
  }

  const b64ToText = (u8) => new TextDecoder('utf-8').decode(u8);
  const findChara = (u8) => {
    // 找 tEXt + 'chara' + 0x00
    const needle = [0x74, 0x45, 0x58, 0x74, 0x63, 0x68, 0x61, 0x72, 0x61, 0x00]; // "tEXtchara\\0"
    outer: for (let i = 0; i + needle.length < u8.length; i++) {
      for (let j = 0; j < needle.length; j++) if (u8[i + j] !== needle[j]) continue outer;
      const len = (u8[i - 4] << 24 | u8[i - 3] << 16 | u8[i - 2] << 8 | u8[i - 1]) >>> 0;
      const start = i + 4 + 6;            // 跳过 'tEXt' + 'chara\\0'
      const end = i + 4 + len;            // chunk 数据结束
      return { text: b64ToText(Uint8Array.from(atob(b64ToText(u8.slice(start, end))), c => c.charCodeAt(0))), start, end, len, i };
    }
    return null;
  };
  const isPng = (u8) => u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
  const hasIEND = (u8) => {
    // IEND 是 PNG 最后一个块：length(4)+'IEND'+crc(4) → "IEND" 起始于 len-8。
    // 必须从 len-4 往上扫（此前从 len-12 往下扫，直接跳过 len-8 → 误报结构损坏）
    for (let i = u8.length - 4; i >= 0 && i > u8.length - 4000; i--) {
      if (u8[i] === 0x49 && u8[i+1] === 0x45 && u8[i+2] === 0x4e && u8[i+3] === 0x44) return true;
    }
    return false;
  };

  // 找第三方真实字段路径
  const foreignFields = (o) => {
    const INTERNAL = new Set(['_collapsed','_mtime','_ctime','_size','_importTime','_srcIndex','_srcUid']);
    const out = [];
    (function walk(x, p) {
      if (x && typeof x === 'object') {
        if (Array.isArray(x)) return x.forEach(v => walk(v, p + '[]'));
        for (const k of Object.keys(x)) {
          if ((k.startsWith('_') && !INTERNAL.has(k)) || k === 'uid') out.push(p + '/' + k);
          walk(x[k], p + '/' + k);
        }
      }
    })(o, '');
    return out;
  };
  // 深度比较，回报前若干差异
  const diff = (a, b, p, acc) => {
    if (acc.length > 6) return acc;
    if (a === b) return acc;
    const ta = a === null ? 'null' : typeof a, tb = b === null ? 'null' : typeof b;
    if (ta !== tb || ta !== 'object') { acc.push(p + ': ' + JSON.stringify(a) + ' → ' + JSON.stringify(b)); return acc; }
    for (const k of Object.keys(a)) if (!(k in b)) acc.push(p + '/' + k + ': 被删除');
    for (const k of Object.keys(b)) if (!(k in a)) acc.push(p + '/' + k + ': 凭空新增');
    for (const k of Object.keys(a)) if (k in b) diff(a[k], b[k], p + '/' + k, acc);
    return acc;
  };

  const names = CASES;
  for (const cs of names) {
    const name = cs.name, path = cs.path;
    const c = { name, path, steps: [] };
    try {
      const rd1 = await api.readBuffer(path);
      if (!rd1 || !rd1.success) { c.error = 'readBuffer 失败: ' + JSON.stringify(rd1); report.ok = false; report.cases.push(c); continue; }
      const before = new Uint8Array(rd1.buffer);
      if (!isPng(before)) { c.error = '样本不是 PNG'; report.ok = false; report.cases.push(c); continue; }
      const chunk1 = findChara(before);
      if (!chunk1) { c.error = '未找到 chara 块'; report.ok = false; report.cases.push(c); continue; }

      const card = JSON.parse(chunk1.text);
      const payload = JSON.parse(JSON.stringify(card));       // 送去保存的载荷（将被污染）
      const ideal  = JSON.parse(JSON.stringify(card));        // 理想落盘结果（污染前）

      const book = payload.character_book || (payload.data && payload.data.character_book);
      const entries = Array.isArray(book) ? book : (book && Array.isArray(book.entries) ? book.entries : null);
      if (!entries || !entries.length) { c.error = '样本没有内嵌世界书词条，无法验证'; report.ok = false; report.cases.push(c); continue; }
      entries.forEach((e, i) => { if (e && typeof e === 'object') { e.uid = 800000 + i; e._collapsed = (i % 2 === 0); } });
      c.injected = entries.length;
      c.foreignBefore = foreignFields(ideal);
      c.bytesBefore = before.length;

      // ②③ 真实保存
      const saveRes = await api.saveCard(path, payload);
      c.save = saveRes;
      if (!saveRes || !saveRes.success) { c.error = 'saveCard 失败: ' + JSON.stringify(saveRes); report.ok = false; report.cases.push(c); continue; }

      // ④ 读回
      const rd2 = await api.readBuffer(path);
      if (!rd2 || !rd2.success) { c.error = '读回失败: ' + JSON.stringify(rd2); report.ok = false; report.cases.push(c); continue; }
      const after = new Uint8Array(rd2.buffer);
      c.bytesAfter = after.length;
      c.stillPng = isPng(after);
      c.hasIEND = hasIEND(after);
      if (!c.stillPng || !c.hasIEND) { c.error = 'PNG 结构损坏'; report.ok = false; report.cases.push(c); continue; }

      const chunk2 = findChara(after);
      if (!chunk2) { c.error = '读回后找不到 chara 块'; report.ok = false; report.cases.push(c); continue; }
      const afterCard = JSON.parse(chunk2.text);

      // 断言 A：注入字段被剔除
      const b2 = afterCard.character_book || (afterCard.data && afterCard.data.character_book);
      const e2 = Array.isArray(b2) ? b2 : (b2 && Array.isArray(b2.entries) ? b2.entries : null);
      c.leakedUid = e2 ? e2.filter(e => e && ('uid' in e)).length : -1;
      c.leakedCollapsed = e2 ? e2.filter(e => e && ('_collapsed' in e)).length : -1;
      if (c.leakedUid !== 0 || c.leakedCollapsed !== 0) { c.error = '注入字段未被剔除'; report.ok = false; }
      c.entryCount = e2 ? e2.length : -1;

      // 断言 B：第三方真实字段全在
      const afterSet = new Set(foreignFields(afterCard));
      c.foreignLost = c.foreignBefore.filter(f => !afterSet.has(f));
      if (c.foreignLost.length) { c.error = '第三方真实字段被误删'; report.ok = false; }

      // 断言 C：除注入字段外内容逐项一致
      c.diffs = diff(ideal, afterCard, '', []);
      if (c.diffs.length) { c.error = '落盘内容与理想结果不一致'; report.ok = false; }
    } catch (err) {
      c.error = String(err && err.message || err);
      report.ok = false;
    }
    report.cases.push(c);
  }
  return JSON.stringify(report);
})()`;
}

async function main() {
  const ws = await getPageWs();
  await connect(ws);
  await send('Runtime.enable');
  console.log('已连上渲染进程');

  const raw = await evaluate(buildExpr(SAMPLE_DIR));
  const rep = JSON.parse(raw);
  console.log('总体:', rep.ok ? '✅ 全部通过' : '❌ 存在失败');
  for (const c of rep.cases) {
    console.log(`\n— ${c.name}`);
    if (c.error) console.log('   ❌ ' + c.error);
    console.log(`   注入污染词条: ${c.injected}   PNG: ${c.bytesBefore} → ${c.bytesAfter} 字节  isPng=${c.stillPng} IEND=${c.hasIEND}`);
    console.log(`   保存返回: ${JSON.stringify(c.save)}`);
    console.log(`   回读: 词条数=${c.entryCount}  残留 uid=${c.leakedUid}  残留 _collapsed=${c.leakedCollapsed}`);
    console.log(`   第三方真实字段(污染前)=${(c.foreignBefore || []).length}  丢失=${(c.foreignLost || []).length}`);
    if ((c.foreignBefore || []).length) console.log('      ' + c.foreignBefore.join(', '));
    if ((c.diffs || []).length) console.log('   差异: ' + c.diffs.join(' | '));
  }
  sock.close();
  process.exit(rep.ok ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
