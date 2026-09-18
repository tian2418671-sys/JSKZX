/* 热测试：记忆 IPC 全链路（CT-17）。生产 app:// + CDP。Node 25 全局 WebSocket。 */
const PORT = process.env.CDP_PORT || 9360;
let sock; let msgId = 0; const pending = new Map();

async function getWs() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到 page target');
  return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    sock = new WebSocket(wsUrl);
    sock.onopen = res;
    sock.onerror = rej;
    sock.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
  });
}
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    sock.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page err: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
  return r.result.value;
}

(async () => {
  const api = 'window.electronAPI';
  await connect(await getWs());
  // 1. 记忆 IPC 往返（CT-17）：add → list(按卡) → stats → remove → 复查
  const add = await evalJs(api + ".memoryAdd({type:'fact',key:'TEST_KEY',content:'HOTTEST_VALUE',cardName:'HOT_CARD',cardPath:'HOTTEST_PATH'}).then(r=>JSON.stringify(r))");
  console.log('add:', add);
  const list = await evalJs(api + ".memoryList({type:'',limit:10,cardName:'HOTTEST_PATH'}).then(r=>JSON.stringify(r.items.map(i=>i.key+':'+i.content)))");
  console.log('list byCard:', list);
  const st = await evalJs(api + '.memoryStats().then(r=>JSON.stringify(r))');
  console.log('stats:', st);
  const item = JSON.parse(add);
  const rm = await evalJs(api + ".memoryRemove('" + item.id + "').then(r=>JSON.stringify(r))");
  console.log('remove:', rm);
  const after = await evalJs(api + ".memoryList({cardName:'HOTTEST_PATH'}).then(r=>r.items.length)");
  console.log('afterRemoveCount:', after);

  // 2. D1 卡隔离：同 key 不同卡互不覆盖
  await evalJs(api + ".memoryAdd({type:'fact',key:'LIKE',content:'coffee',cardPath:'CARD_A',cardName:'A'}).then(r=>JSON.stringify(r))");
  await evalJs(api + ".memoryAdd({type:'fact',key:'LIKE',content:'tea',cardPath:'CARD_B',cardName:'B'}).then(r=>JSON.stringify(r))");
  const aList = await evalJs(api + ".memoryList({cardName:'CARD_A'}).then(r=>JSON.stringify(r.items.map(i=>i.content)))");
  console.log('cardA only coffee:', aList);

  // 3. D4 覆盖（同 key+cardPath → 更新不新增）
  await evalJs(api + ".memoryAdd({type:'fact',key:'LIKE',content:'latte',cardPath:'CARD_A',cardName:'A'}).then(r=>JSON.stringify(r))");
  const aAfter = await evalJs(api + ".memoryList({cardName:'CARD_A'}).then(r=>JSON.stringify(r.items.map(i=>i.content)))");
  console.log('cardA after overwrite:', aAfter);

  // 4. migrateCard 路径跟随
  const mig = await evalJs(api + ".memoryMigrateCard({from:'CARD_A',to:'CARD_C'}).then(r=>JSON.stringify(r))");
  console.log('migrateCard:', mig);
  const cList = await evalJs(api + ".memoryList({cardName:'CARD_C'}).then(r=>JSON.stringify(r.items.map(i=>i.content)))");
  console.log('cardC after migrate:', cList);

  // 5. clearByCard 清理现场
  await evalJs(api + ".memoryClearByCard('CARD_C').then(r=>JSON.stringify(r))");
  await evalJs(api + ".memoryClearByCard('CARD_B').then(r=>JSON.stringify(r))");
  const left = await evalJs(api + '.memoryStats().then(r=>r.total)');
  console.log('total after cleanup:', left);
  console.log('ALL_IPC_PASS');
  process.exit(0);
})().catch((e) => { console.log('HOTTEST_FAIL', e.message); process.exit(1); });
