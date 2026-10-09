/**
 * ⬇️ 会话导出 · 真机端到端验证（A 段：落盘全链路；B 段：UI 接线 + 三格式真实导出）
 *
 * 前置：
 *   1) 以 `JSK_TEST_SAVE_PATH=<绝对路径>` 启动（跳过原生保存对话框，供无人值守验证写盘）；
 *   2) dev 模式 + `--remote-debugging-port=9375`；真实 profile。
 * 安全：**只读卡库**；B 段临时把 engine 的会话数组换成本次合成会话（同一数组引用 splice），
 *      跑完立刻**还原原数组**；不写任何配置、不落标签。
 *
 * 用法：JSK_TEST_SAVE_PATH=%TEMP%\jsk-export-probe.md node scripts/probes/_probe-chat-export.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const TEST_PATH = process.env.JSK_TEST_SAVE_PATH || path.join(os.tmpdir(), 'jsk-export-probe.md');
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m.result); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa) => new Promise((res) => { const id = ++i; q.set(id, res); s.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '') };
    return r?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTX = `(function(){var a=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;return (a&&(a._context.provides.appCtx||(a._container._vnode.component.provides.appCtx)))||null;})()`;
// ⚠️ `vnode.component` 是 Vue **内部实例**（没有 $nextTick/$data）—— 公共 API 在 `.proxy` 上
const FIND_SIDEBAR = `function walk(v,d){ if(!v||d>18) return null; var c=v.component; if(c){ var n=(c.type&&(c.type.name||c.type.__name))||''; if(n==='ChatTestSidebar') return (c.proxy||c); var r=walk(c.subTree,d+1); if(r) return r; }
  var ch=v.children; if(Array.isArray(ch)){ for(var i=0;i<ch.length;i++){ var r2=walk(ch[i],d+1); if(r2) return r2; } } return null; }`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };
const readDisk = () => { try { return fs.readFileSync(TEST_PATH, 'utf8'); } catch (e) { return ''; } };

// ═════════ A. 落盘全链路（preload → IPC → 主进程 → fs）═════════
const content = '# 你好\n\nTEST-123 会话导出探针\n' + '字'.repeat(200);
const call = await ev(`(async function(){
  var api = window.electronAPI;
  if (!api || typeof api.saveTextFile !== 'function') return { err: 'preload 未暴露 saveTextFile' };
  return await api.saveTextFile({ defaultName: '探针.md', content: ${JSON.stringify(content)}, filters: [{ name: 'Markdown 文件', extensions: ['md'] }] });
})()`);
check('preload 暴露 saveTextFile 且调用成功', !!(call && call.ok === true), JSON.stringify(call));
check('文件真的落盘且内容逐字一致', readDisk() === content, `磁盘 ${readDisk().length} 字 / 期望 ${content.length} 字`);
let stat = null;
try { stat = fs.statSync(TEST_PATH); } catch (e) { stat = null; }
check('返回的 bytes 与磁盘大小一致', !!stat && !!call && call.bytes === Buffer.byteLength(content, 'utf8'), `stat=${stat ? stat.size : 'n/a'} bytes=${call && call.bytes}`);

// ═════════ B. UI 接线：真实导出三格式 → 逐次读盘断言 ═════════
// 侧栏只在「有卡打开 + 测卡 Tab」时渲染 ⇒ 走 App 既有 e2e 入口
const mounted = await ev(`(async function(){
  var h = window.__jskDiag && window.__jskDiag.chat;
  if (!h) return { err: 'window.__jskDiag.chat 入口不存在' };
  var ok = await h.openCard(1);
  h.open();
  return { opened: !!ok, tab: h.tab ? h.tab() : '', card: h.cardName ? h.cardName() : '' };
})()`);
console.log('  [挂载侧栏]', JSON.stringify(mounted));
await sleep(2500);
let hasSidebar = await ev(`(function(){ var app=document.querySelector('#app').__vue_app__; ${FIND_SIDEBAR} return !!(app._instance && walk(app._instance.subTree,0)); })()`);
check('测卡侧栏组件已挂载', hasSidebar === true, JSON.stringify(mounted));

if (hasSidebar) {
    // 合成会话在 Node 侧构造好再 JSON 注入（避免模板串里嵌套引号/换行/反引号的转义地狱）
    const FENCE = String.fromCharCode(96, 96, 96);
    const synth = {
        id: 'probe_cs', name: '探针会话', cardPath: '', createdAt: Date.now() - 3600000, updatedAt: Date.now(),
        messages: [
            { role: 'user', content: '你好 **世界**' },
            { role: 'assistant', swipes: ['候选A（不应导出）', `当前分支：\n${FENCE}html\n<div class="x">HTML段</div>\n${FENCE}\n尾巴`], index: 1 },
            { role: 'system', content: '（系统行）' }
        ]
    };
    const swap = await ev(`(function(){
      var c = ${CTX};
      var arr = c.chatSessions && c.chatSessions.value;
      if (!Array.isArray(arr)) return { err: 'chatSessions 不可用' };
      window.__probeBackup = arr.slice();          // 备份原数组内容（同一引用，splice 还原）
      arr.splice(0, arr.length, ${JSON.stringify(synth)});
      window.__probeEngineArr = arr;
      return { swapped: true, backup: window.__probeBackup.length, now: arr.length, id: arr[0].id };
    })()`);
    check('临时替换 engine 会话数组（含消息的合成会话）', !!(swap && swap.swapped === true), JSON.stringify(swap));
    await sleep(900);

    const setup = await ev(`(async function(){
      var app=document.querySelector('#app').__vue_app__; ${FIND_SIDEBAR}
      var comp=walk(app._instance.subTree,0);
      if(!comp) return { err:'no comp' };
      window.__probeSidebar = comp;
      await comp.$nextTick();
      return { canExport: !!comp.canExportSession, sessions: (comp.sessions||[]).length,
               activeName: comp.activeSession ? comp.activeSession.name : '', msgs: comp.activeSession ? (comp.activeSession.messages||[]).length : 0 };
    })()`);
    check('当前会话有消息、导出按钮可用', !!(setup && setup.canExport === true), JSON.stringify(setup));

    const per = {};
    for (const fmt of ['md', 'html', 'txt']) {
        const msg = await ev(`(async function(){
          var comp = window.__probeSidebar; if(!comp) return '(no comp)';
          comp.exportFormat = ${JSON.stringify(fmt)};
          await comp.exportSession();
          return String(comp.exportMsg || '');
        })()`);
        await sleep(250);
        per[fmt] = { msg, text: readDisk() };
        console.log(`  [${fmt}] 提示="${msg}" · 落盘 ${per[fmt].text.length} 字`);
    }
    const md = per.md.text;
    check('UI 成功提示（用户可见反馈）', /已导出 \d+ KB/.test(per.md.msg), per.md.msg);
    check('Markdown：标题/元信息/当前 swipe 分支/HTML 段提示/变量快照',
        md.includes('# 探针会话') && md.includes('当前分支') && !md.includes('候选A') && md.includes('⛩️ HTML 渲染内容'),
        `len=${md.length}`);
    const html = per.html.text;
    check('HTML：DOCTYPE/charset/srcdoc/sandbox + 消息顺序',
        html.startsWith('<!DOCTYPE html>') && html.includes('<meta charset="utf-8">') && html.includes('srcdoc=') && html.includes('sandbox="allow-scripts"') && html.indexOf('你好') < html.indexOf('当前分支'),
        `len=${html.length}`);
    const txt = per.txt.text;
    // 用户名取应用设置（可能不是「你」）⇒ 断言只验格式与顺序，不锁死具体称呼
    check('纯文本：[角色名] 正文 顺序拼接', /\[[^\]]+\]\s*你好/.test(txt) && txt.includes('当前分支') && txt.indexOf('你好') < txt.indexOf('当前分支'), `len=${txt.length} 前 40 字=${txt.slice(0, 40).replace(/\n/g, ' ⏎ ')}`);
    check('三种格式落盘内容互不相同（格式确实生效）', md !== html && html !== txt && md !== txt, `md=${md.length} html=${html.length} txt=${txt.length}`);

    // 空会话禁用
    const emptyCase = await ev(`(async function(){
      var comp = window.__probeSidebar; if(!comp) return { err:'no comp' };
      var arr = window.__probeEngineArr;
      arr.splice(0, arr.length, { id:'probe_empty', name:'空会话', cardPath:'', messages: [] });
      await comp.$nextTick();
      var can = !!comp.canExportSession;
      // 还原原数组（同一引用 splice）+ 清探针痕迹
      if (arr && window.__probeBackup) arr.splice(0, arr.length, ...window.__probeBackup);
      comp.exportMsg = '';
      delete window.__probeBackup; delete window.__probeEngineArr; delete window.__probeSidebar;
      await comp.$nextTick();
      return { can, restored: (comp.sessions||[]).length };
    })()`);
    check('空会话禁用导出', !!(emptyCase && emptyCase.can === false), JSON.stringify(emptyCase));
    console.log('  （已还原 engine 会话数组）');
}

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 会话导出验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n));
process.exit(pass === results.length ? 0 : 1);
