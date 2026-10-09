/**
 * 📦 整库冷备 · 真机 UI 验证（真 app + 真 IPC；冷备产物落临时目录，**不碰真库**）
 * 覆盖：命令入口 → 弹窗渲染 → 列表刷新 → 真实冷备（进度 + 成功文案）→ 配置项还原
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-fb-ui-'));
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
const FIND_MODAL = `function walk(v,d){ if(!v||d>18) return null; var c=v.component; if(c){ var n=(c.type&&(c.type.name||c.type.__name))||''; if(n==='FullBackupModal') return (c.proxy||c); var r=walk(c.subTree,d+1); if(r) return r; }
  var ch=v.children; if(Array.isArray(ch)){ for(var i=0;i<ch.length;i++){ var r2=walk(ch[i],d+1); if(r2) return r2; } } return null; }`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };

// ① preload 暴露
const apiShape = await ev(`(function(){
  var a = window.electronAPI && window.electronAPI.fullBackup;
  return a ? Object.keys(a).sort() : null;
})()`);
check('preload 暴露 fullBackup（create/list/restore/remove/cancel/onProgress/openDir）',
    Array.isArray(apiShape) && ['cancel', 'create', 'list', 'onProgress', 'openDir', 'remove', 'restore'].every((k) => apiShape.includes(k)),
    JSON.stringify(apiShape));

// ② 命令入口存在（**真实用户路径**：打开「维护」菜单找条目）
const cmd = await ev(`(async function(){
  var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
  var m = btns.filter(function (b) { return /维护/.test(b.textContent || ''); })[0];
  if (!m) return { err: '未找到维护菜单按钮' };
  m.click();
  await new Promise(function (r) { setTimeout(r, 500); });
  var txt = document.body.innerText || '';
  var lines = txt.split('\\n').map(function (x) { return x.trim(); });
  var iFull = lines.findIndex(function (x) { return x.indexOf('整库冷备') >= 0; });
  var iOrphan = lines.findIndex(function (x) { return x.indexOf('清理孤儿快照') >= 0; });
  return { hasFull: iFull >= 0, afterOrphan: iFull >= 0 && iOrphan >= 0 && iFull > iOrphan, lines: lines.filter(function (x) { return /冷备|孤儿快照/.test(x); }) };
})()`);
check('维护菜单有「📦 整库冷备…」且排在「清理孤儿快照」之后',
    !!(cmd && cmd.hasFull && cmd.afterOrphan), JSON.stringify(cmd));

// ③ 打开弹窗（真路径：ctx.openFullBackupModal）
const opened = await ev(`(function(){ var c = ${CTX}; if (!c || typeof c.openFullBackupModal !== 'function') return { err: 'no ctx fn' }; c.openFullBackupModal(); return { ok: true, libPath: c.currentFolderPath ? c.currentFolderPath.value : '' }; })()`);
await sleep(1400);
const modalFound = await ev(`(function(){ var app=document.querySelector('#app').__vue_app__; ${FIND_MODAL} return !!(app._instance && walk(app._instance.subTree,0)); })()`);
const modalVisible = await ev(`(function(){ var t = document.body.innerText || ''; return t.indexOf('整库冷备') >= 0 && t.indexOf('冷备目录') >= 0 && t.indexOf('保留份数') >= 0; })()`);
check('「📦 整库冷备」弹窗可打开（库已打开 ⇒ 应打开）', !!(opened && opened.ok && modalVisible === true && modalFound === true),
    `visible=${modalVisible} comp=${modalFound} libPath=${opened && opened.libPath}`);
check('弹窗内关键元素齐全（目录选择 / 保留份数 / 立即冷备 / 列表）',
    modalVisible === true ? !!(await ev(`(function(){
      var t = document.body.innerText || '';
      return t.indexOf('立即冷备') >= 0 && t.indexOf('已有冷备') >= 0;
    })()`)) : false, '');

if (modalVisible) {
    // ④ 设定临时冷备目录（走 ctx，避免原生目录对话框）→ 列表刷新为空
    const set = await ev(`(async function(){
      var c = ${CTX};
      c.fullBackupDir.value = ${JSON.stringify(DEST)};
      var app=document.querySelector('#app').__vue_app__; ${FIND_MODAL}
      var comp=walk(app._instance.subTree,0);
      if(!comp) return { err:'no modal comp' };
      window.__probeFB = comp;
      await comp.$nextTick();
      await comp.refresh();
      return { items: comp.items.length, dir: comp.backupDir, keep: comp.keep };
    })()`);
    check('冷备目录生效且初始列表为空', !!(set && set.items === 0 && set.dir === DEST), JSON.stringify(set));

    // ⑤ 真实冷备（真 IPC → 写临时目录）
    const run = await ev(`(async function(){
      var comp = window.__probeFB; if(!comp) return { err:'no comp' };
      var phases = [];
      var api = window.electronAPI.fullBackup;
      api.onProgress(function(p){ phases.push(p.phase); });
      await comp.startBackup();
      return { msg: String(comp.msg||''), items: comp.items.length, phases: phases, busy: comp.busy,
               first: comp.items[0] ? { name: comp.items[0].name, fileCount: comp.items[0].fileCount, bytes: comp.items[0].bytes } : null };
    })()`);
    await sleep(400);
    console.log('  [UI 冷备]', JSON.stringify(run));
    check('UI 冷备成功并给出完成文案', !!(run && /冷备完成/.test(run.msg || '')), run && run.msg);
    check('列表自动刷新出现 1 份', !!(run && run.items === 1), `items=${run && run.items}`);
    check('进度事件到达渲染层（scan/copy/done）', !!(run && Array.isArray(run.phases) && run.phases.includes('scan') && run.phases.includes('done')), JSON.stringify(run && run.phases));
    check('manifest 落盘（列表数据来自它）', fs.existsSync(path.join(DEST, 'JSK-FullBackup')) && !!(run && run.first && run.first.fileCount > 0), JSON.stringify(run && run.first));
    // 列表数据与磁盘一致（真实库 85 文件）
    check('冷备文件数与真库一致（85）', !!(run && run.first && run.first.fileCount === 85), `fileCount=${run && run.first && run.first.fileCount}`);

    // ⑥ 还原设置（不留探针痕迹）
    const restored = await ev(`(async function(){
      var c = ${CTX}; var comp = window.__probeFB;
      await window.electronAPI.fullBackup.remove({ backupDir: comp.items[0] ? comp.items[0].dir : '' }).catch(function(){});
      c.fullBackupDir.value = ''; c.fullBackupKeep.value = 3;
      comp.exportMsg = ''; comp.msg = '';
      c.showFullBackupModal.value = false;
      delete window.__probeFB;
      return { dir: c.fullBackupDir.value, keep: c.fullBackupKeep.value };
    })()`);
    check('设置已还原（dir 清空 / keep=3）', !!(restored && restored.dir === '' && restored.keep === 3), JSON.stringify(restored));
} else {
    console.log('  （未打开库 ⇒ 跳过 UI 冷备执行；防呆提示已由 ctx 分支覆盖）');
}

try { fs.rmSync(DEST, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 整库冷备 UI 验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
