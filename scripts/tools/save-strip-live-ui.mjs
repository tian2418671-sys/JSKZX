/**
 * 【真实运行验证】App.vue 侧 4 处「清洗前端内部字段」改动
 *
 * 覆盖（都是可直接从 setupState 调用的函数）：
 *   ① downloadJson()                        —— 导出卡片 JSON（原为递归剔 uid/_collapsed）
 *   ② pickCardWbImportSource + confirmCardWbImport  —— 世界书库 → 卡内世界书（原递归剔所有 `_`）
 *   ③ pickImportSource + confirmImportEntries       —— 世界书库 → 当前世界书（原递归剔所有 `_`）
 *   ④ 合并世界书（同一 dropInternalFields）
 *
 * 断言核心（反向用例）：源词条 extensions 里的 `_filename` **必须活下来**
 *   —— 它正是旧规则会删掉的第三方真实数据（实测 28 张真实卡片）。
 * 同时断言 `_srcIndex` / `_srcUid` 这两个**真正的前端临时字段**被剔干净。
 *
 * 全程只动内存状态，不改磁盘；结束恢复原状态。
 * 前置：Vite dev server(5173) + Electron --remote-debugging-port=9222
 * 用法：node scripts/tools/save-strip-live-ui.mjs
 */
const CDP_HTTP = 'http://127.0.0.1:9222/json/list';

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

const EXPR = `(async () => {
  const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
  const st = app && app._instance && app._instance.setupState;
  if (!st) return JSON.stringify({ ok: false, error: 'setupState 不可达' });
  const out = { ok: true, cases: [] };

  // ① 屏蔽原生弹窗（nativeAlert 会走 dialog.showMessageBox，模态会卡住脚本）
  const origShowMessage = window.electronAPI && window.electronAPI.showMessage;
  if (window.electronAPI) window.electronAPI.showMessage = async () => ({ response: 0 });
  // ② 记录被改动的状态，结束时还原
  const snap = {
    cardData: st.cardData, activeWorldbook: st.activeWorldbook,
    showCardWbImportModal: st.showCardWbImportModal, showWbImportModal: st.showWbImportModal,
    cardWbImportSource: st.cardWbImportSource, cardWbImportCandidates: st.cardWbImportCandidates,
    cardWbSelectedEntries: st.cardWbSelectedEntries,
    importSourceBook: st.importSourceBook, importCandidates: st.importCandidates,
    selectedImportEntries: st.selectedImportEntries,
  };

  const SRC_ENTRY = { comment: '源词条', content: '内容', key: ['k1'], uid: 'SRC-UID',
                      extensions: { _filename: 'f1.json', keepMe: { uid: 'inner-uid' } } };
  const mkSrc = () => ({ name: '源书', path: 'X:/src.json',
                         data: { name: '源书', description: 'd', entries: [JSON.parse(JSON.stringify(SRC_ENTRY))] } });

  try {
    // ===== ① downloadJson：导出卡片 JSON =====
    {
      const c = { name: 'downloadJson（导出卡片 JSON）' };
      try {
        st.cardData = { name: '测试卡', description: 'd', first_mes: 'hi',
          extensions: { chatSheets: { sheet_Inventory: { uid: 'SHEET-UID-KEEP' } } },
          character_book: { name: 'b', entries: [
            { comment: 'a', content: 'x', uid: 123, _collapsed: true,
              extensions: { _filename: 'keep-a.json', ext: { uid: 'KEEP-INNER' } } } ] } };
        let captured = null;
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = (b) => { captured = b; return 'blob:stub'; };
        const origCreateEl = document.createElement.bind(document);
        document.createElement = (tag) => (String(tag).toLowerCase() === 'a')
          ? { href: '', download: '', click() { /* 不真的触发下载，避免系统保存框 */ } }
          : origCreateEl(tag);
        try { st.downloadJson(); } finally { URL.createObjectURL = origCreate; document.createElement = origCreateEl; }

        c.gotBlob = !!captured;
        const txt = captured ? await captured.text() : '';
        const j = txt ? JSON.parse(txt) : {};
        const e = (j.character_book && j.character_book.entries && j.character_book.entries[0]) || {};
        c.entryUidRemoved = !('uid' in e);
        c.collapsedRemoved = !('_collapsed' in e);
        c.filenameKept = e.extensions && e.extensions._filename === 'keep-a.json';
        c.innerUidKept = !!(e.extensions && e.extensions.ext && e.extensions.ext.uid === 'KEEP-INNER');
        c.sheetUidKept = !!(j.extensions && j.extensions.chatSheets
          && j.extensions.chatSheets.sheet_Inventory.uid === 'SHEET-UID-KEEP');
        c.cardFieldsKept = j.name === '测试卡' && j.first_mes === 'hi';
        if (!c.gotBlob || !c.entryUidRemoved || !c.collapsedRemoved || !c.filenameKept
            || !c.innerUidKept || !c.sheetUidKept || !c.cardFieldsKept) { c.error = '断言失败'; out.ok = false; }
      } catch (err) { c.error = String(err && err.message || err); out.ok = false; }
      out.cases.push(c);
    }

    // ===== ② 世界书库 → 卡内世界书 =====
    {
      const c = { name: 'confirmCardWbImport（导入词条到卡内世界书）' };
      try {
        st.cardData = { name: '测试卡', description: 'd', character_book: { name: 'b', entries: [] } };
        st.pickCardWbImportSource(mkSrc());
        const cands = st.cardWbImportCandidates || [];
        c.candidateCount = cands.length;
        c.candidateHasSrcFields = cands.length > 0 && ('_srcUid' in cands[0]) && ('_srcIndex' in cands[0]);
        st.cardWbSelectedEntries = cands.map(x => x._srcUid);
        st.confirmCardWbImport();
        const es = st.cardData.character_book.entries || [];
        const e = es[0] || {};
        c.pushedCount = es.length;
        c.srcFieldsRemoved = !('_srcUid' in e) && !('_srcIndex' in e);
        c.filenameKept = e.extensions && e.extensions._filename === 'f1.json';
        c.innerUidKept = !!(e.extensions && e.extensions.keepMe && e.extensions.keepMe.uid === 'inner-uid');
        c.contentKept = e.content === '内容';
        c.frontendUidAdded = typeof e.uid === 'string' && e.uid.length > 0; // 前端 v-for 需要，落盘时主进程再剥
        if (!c.srcFieldsRemoved || !c.filenameKept || !c.innerUidKept || !c.contentKept || !c.frontendUidAdded) {
          c.error = '断言失败'; out.ok = false;
        }
      } catch (err) { c.error = String(err && err.message || err); out.ok = false; }
      out.cases.push(c);
    }

    // ===== ③ 世界书库 → 当前世界书 =====
    {
      const c = { name: 'confirmImportEntries（导入词条到当前世界书）' };
      try {
        st.activeWorldbook = { name: '目标书', path: 'X:/t.json', data: { name: '目标书', description: 'd', entries: [] } };
        st.pickImportSource(mkSrc());
        const cands = st.importCandidates || [];
        c.candidateCount = cands.length;
        st.selectedImportEntries = cands.map(x => x._srcUid);
        st.confirmImportEntries();
        const es = st.activeWorldbook.data.entries || [];
        const e = es[0] || {};
        c.pushedCount = es.length;
        c.srcFieldsRemoved = !('_srcUid' in e) && !('_srcIndex' in e);
        c.filenameKept = e.extensions && e.extensions._filename === 'f1.json';
        c.innerUidKept = !!(e.extensions && e.extensions.keepMe && e.extensions.keepMe.uid === 'inner-uid');
        c.contentKept = e.content === '内容';
        if (!c.srcFieldsRemoved || !c.filenameKept || !c.innerUidKept || !c.contentKept) {
          c.error = '断言失败'; out.ok = false;
        }
      } catch (err) { c.error = String(err && err.message || err); out.ok = false; }
      out.cases.push(c);
    }
  } finally {
    // 还原现场
    for (const k of Object.keys(snap)) { try { st[k] = snap[k]; } catch (e) {} }
    if (window.electronAPI && origShowMessage) window.electronAPI.showMessage = origShowMessage;
  }
  return JSON.stringify(out);
})()`;

async function main() {
  const ws = await getPageWs();
  await connect(ws);
  await send('Runtime.enable');
  const rep = JSON.parse(await evaluate(EXPR));
  console.log('总体:', rep.ok ? '✅ 全部通过' : '❌ 存在失败');
  if (rep.error) console.log('  ' + rep.error);
  for (const c of rep.cases) {
    console.log(`\n— ${c.name}` + (c.error ? `   ❌ ${c.error}` : '   ✅'));
    const show = (k, label) => { if (c[k] !== undefined) console.log(`   ${label}: ${c[k]}`); };
    show('candidateCount', '候选词条数');
    show('candidateHasSrcFields', '候选项带 _srcUid/_srcIndex');
    show('pushedCount', '实际推入词条数');
    show('entryUidRemoved', '词条自身 uid 已剔除');
    show('collapsedRemoved', '词条自身 _collapsed 已剔除');
    show('srcFieldsRemoved', '_srcIndex/_srcUid 已剔除');
    show('filenameKept', '★ extensions._filename 保住');
    show('innerUidKept', '★ extensions 内部 uid 保住');
    show('sheetUidKept', '★ 卡片 extensions 里第三方 uid 保住');
    show('contentKept', '业务字段 content 保住');
    show('cardFieldsKept', '卡片业务字段保住');
    show('frontendUidAdded', '前端 uid 已重新生成（落盘前由主进程剥）');
  }
  sock.close();
  process.exit(rep.ok ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
