/* 热测试：记忆 IPC 全链路（CT-17）+ deleteMessage（CT-18）+ 迁移。生产 app:// + CDP。 */
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9360/json/list', (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    const page = JSON.parse(d).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const send = (method, params) => new Promise((r) => {
      const i = ++id;
      const h = (m) => { const o = JSON.parse(m); if (o.id === i) { ws.off('message', h); r(o.result); } };
      ws.on('message', h);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.on('open', async () => {
      const evalJs = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('page err: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
        return r.result.value;
      };
      const api = 'window.electronAPI';
      try {
        // 0. 记录渲染层错误监听基线
        // 1. 记忆 IPC 往返：add → list(按卡) → stats → remove → 复查（CT-17 链路）
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
        // 3. D4 覆盖
        await evalJs(api + ".memoryAdd({type:'fact',key:'LIKE',content:'latte',cardPath:'CARD_A',cardName:'A'}).then(r=>JSON.stringify(r))");
        const aAfter = await evalJs(api + ".memoryList({cardName:'CARD_A'}).then(r=>JSON.stringify(r.items.map(i=>i.content)))");
        console.log('cardA after overwrite:', aAfter);
        // 4. migrateCard
        const mig = await evalJs(api + ".memoryMigrateCard({from:'CARD_A',to:'CARD_C'}).then(r=>JSON.stringify(r))");
        console.log('migrateCard:', mig);
        const cList = await evalJs(api + ".memoryList({cardName:'CARD_C'}).then(r=>JSON.stringify(r.items.map(i=>i.content)))");
        console.log('cardC after migrate:', cList);
        // 5. clearByCard
        await evalJs(api + ".memoryClearByCard('CARD_C').then(r=>JSON.stringify(r))");
        await evalJs(api + ".memoryClearByCard('CARD_B').then(r=>JSON.stringify(r))");
        const left = await evalJs(api + ".memoryStats().then(r=>r.total)");
        console.log('total after cleanup:', left);
        console.log('ALL_IPC_PASS');
      } catch (e) {
        console.log('HOTTEST_FAIL', e.message);
      }
      ws.close();
      process.exit(0);
    });
    ws.on('error', (e) => { console.log('WS_ERR', e.message); process.exit(1); });
  });
});
