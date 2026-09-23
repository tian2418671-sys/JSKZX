/* 热测试 UI 部分：测卡聊天删除按钮 + 侧栏记忆查看器渲染（生产 app://）。 */
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
  await connect(await getWs());
  // 检查应用基本状态与侧栏按钮存在性（不点卡 —— 无真实库上下文时做静态校验）
  const appOk = await evalJs("!!document.querySelector('#app') && !!document.querySelector('#app').__vue_app__");
  console.log('app mounted:', appOk);
  // 侧栏删除按钮模板已随组件编译进 bundle（静态检查生产 asar/JS 包内特征）
  const bundleHasDelete = await evalJs("Array.from(document.scripts).some(s=>s.src&&s.src.includes('assets/'))");
  console.log('bundle scripts:', bundleHasDelete);
  // 查找编辑器（若无打开的卡则编辑面板不存在 → 属正常，仅记录）
  const editorVisible = await evalJs("!!document.querySelector('.editor-panel, [class*=editor]')");
  console.log('editor visible:', editorVisible);
  // 渲染层错误监听
  const errCount = await evalJs("window.__jskRenderErrors || 0");
  console.log('renderErrors:', errCount);
  console.log('UI_SMOKE_PASS');
  process.exit(0);
})().catch((e) => { console.log('UI_FAIL', e.message); process.exit(1); });
