/**
 * 真实环境验证：通过 CDP 读插件预览 iframe 的实际 DOM
 * 用法：node scripts/probe-preview.mjs
 * 前提：应用带 --remote-debugging-port=9222 启动
 */
const CDP_PORT = Number(process.env.JSK_CDP_PORT || 9222);

function cdpEval(wsUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('CDP 超时')); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.close();
        if (msg.result && msg.result.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.text || 'eval 异常'));
        } else {
          resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        }
      } catch (e) { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
  });
}

async function main() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  } catch (e) {
    console.log('❌ 无法连接 CDP:', e.message);
    return;
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('❌ 未找到页面'); return; }

  const frames = await cdpEval(page.webSocketDebuggerUrl, `
    (() => {
      const out = [];
      for (const f of document.querySelectorAll('iframe')) {
        let doc = null, err = '';
        try { doc = f.contentDocument; } catch (e) { err = e.name; }
        out.push({
          src: (f.getAttribute('src') || '').slice(0, 90),
          sandbox: f.getAttribute('sandbox') || '',
          accessible: !!doc,
          err
        });
      }
      return out;
    })()
  `);
  console.log('=== iframe 列表 ===');
  console.log(JSON.stringify(frames, null, 2));

  const inner = await cdpEval(page.webSocketDebuggerUrl, `
    (() => {
      const f = Array.from(document.querySelectorAll('iframe'))
        .find(x => (x.getAttribute('src') || '').includes('__jsk_preview__'));
      if (!f) return { found: false, reason: '没有预览 iframe，可能当前不在「效果」页' };
      let doc = null;
      try { doc = f.contentDocument; } catch (e) { return { found: true, accessible: false, err: e.name }; }
      if (!doc) return { found: true, accessible: false, err: 'doc=null' };

      const cap = doc.querySelector('.jsk-cap');
      const hint = doc.getElementById('jsk-empty-hint');
      const probe = doc.getElementById('jsk-empty-probe');
      return {
        found: true,
        accessible: true,
        hasCapCard: !!cap,
        capText: cap ? (cap.textContent || '').replace(/\\s+/g, ' ').slice(0, 260) : '',
        hintVisible: hint ? getComputedStyle(hint).display !== 'none' : null,
        probeHTML: probe ? (probe.innerHTML || '').slice(0, 200) : null,
        bodyTextLen: (doc.body.textContent || '').trim().length,
        size: { w: f.clientWidth, h: f.clientHeight },
      };
    })()
  `);
  console.log('=== 预览页内部 ===');
  console.log(JSON.stringify(inner, null, 2));
}

main().catch((e) => console.log('ERR', e.message));
