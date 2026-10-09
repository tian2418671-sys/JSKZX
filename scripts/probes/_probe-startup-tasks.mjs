/**
 * 🚀 启动自动任务 · 真机验收（按阶段跑；配置隔离 profile 或真实 profile 复位）
 *
 * 阶段：
 *   MODE=init    fresh 启动后：断言「全关默认行为与旧版一致」+ 写入配置 + 断言落盘
 *   MODE=verify  重启后：断言 体检 toast/日志、冷备产物、查重发起、（可选）点击 toast 打开质检弹窗
 *   MODE=reset   复位为全关（不污染用户配置）
 *
 * 环境：CDP_PORT（默认 9375）｜MODE｜RUN_TASKS（verify 阶段：autoAudit,autoBackup,autoDedupe 子集）
 *       BK_DEST（autoBackup 目标目录）｜BK_SRC（库目录，init 阶段写冷备目录用）｜PROFILE_DIR（配置目录，断言落盘）
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const MODE = process.env.MODE || 'verify';
const RUN_TASKS = (process.env.RUN_TASKS || 'autoAudit').split(',').filter(Boolean);
const BK_DEST = process.env.BK_DEST || '';
const BK_SRC = process.env.BK_SRC || '';
const PROFILE_DIR = process.env.PROFILE_DIR || '';

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

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };

if (MODE === 'init') {
    // ① 默认全关（老配置无键 ⇒ 全关）
    const st = await ev(`(function(){ var c = ${CTX}; return JSON.stringify({ cfg: c.startupTasks.value, scheduled: c.startupScheduler.isScheduled() }); })()`);
    const parsed = JSON.parse(st);
    check('默认配置全关（enabled/三任务均 false）+ 延迟默认 3000',
        parsed.cfg.enabled === false && parsed.cfg.autoAudit === false && parsed.cfg.autoBackup === false && parsed.cfg.autoDedupe === false && parsed.cfg.delayMs === 3000,
        JSON.stringify(parsed.cfg));
    check('全关时未调度任何启动任务', parsed.scheduled === false, String(parsed.scheduled));
    const logs = await ev(`(function(){ var c = ${CTX}; return JSON.stringify((c.editorLogs.value||[]).filter(function(x){ return /启动任务|启动体检|启动自动/.test(String(x.msg||'')); })); })()`);
    check('★ 全关：启动日志里没有任何「启动任务」痕迹（与旧版行为一致）', JSON.parse(logs).length === 0, String(logs).slice(0, 160));

    // ② 写配置（含冷备目标目录 / 库目录）
    const cfg = { enabled: true, autoAudit: RUN_TASKS.includes('autoAudit'), autoBackup: RUN_TASKS.includes('autoBackup'), autoDedupe: RUN_TASKS.includes('autoDedupe'), delayMs: 1200 };
    const setRes = await ev(`(async function(){
      var c = ${CTX};
      c.onStartupTasksChange(${JSON.stringify(cfg)});
      ${BK_DEST ? `c.fullBackupDir.value = ${JSON.stringify(BK_DEST)};` : ''}
      ${BK_SRC ? `c.currentFolderPath.value = ${JSON.stringify(BK_SRC)};` : ''}
      // 落盘（防抖 → 等一会儿；再显式同步一次确保写完）
      await new Promise(function (r) { setTimeout(r, 1500); });
      return JSON.stringify({ cfg: c.startupTasks.value, dir: c.fullBackupDir.value, lib: c.currentFolderPath.value });
    })()`);
    check('配置已写入内存（归一后）', !!(setRes && !setRes.__err), String(setRes).slice(0, 200));
    await sleep(2500);
    if (PROFILE_DIR) {
        const cfgFile = path.join(PROFILE_DIR, 'app_config.json');
        let ok = false; let detail = cfgFile;
        try {
            const raw = fs.readFileSync(cfgFile, 'utf8');
            const j = JSON.parse(raw);
            const s2 = j && j.ui && j.ui.startupTasks;
            ok = !!(s2 && s2.enabled === true && s2.delayMs === 1200 && s2.autoAudit === cfg.autoAudit);
            detail = JSON.stringify(s2);
        } catch (e) { detail = '读不到 ' + cfgFile + '：' + e.message; }
        check('★ 配置已落盘到 app_config.json（ui.startupTasks）', ok, detail);
    }
}

if (MODE === 'verify') {
    // 等启动任务跑完（双条件 + delayMs + 任务耗时）
    await sleep(Number(process.env.WAIT_MS || 12000));
    const state = await ev(`(function(){
      var c = ${CTX};
      var logs = (c.editorLogs.value||[]).map(function(x){ return String(x.msg||''); });
      return JSON.stringify({
        cfg: c.startupTasks.value,
        scheduled: c.startupScheduler.isScheduled(),
        toasts: (c.toasts.value||[]).map(function(t){ return { m: String(t.message||''), clickable: typeof t.onClick === 'function' }; }),
        startupLogs: logs.filter(function(m){ return /启动任务|启动体检|启动自动/.test(m); })
      });
    })()`);
    const st = JSON.parse(state);
    console.log('  状态:', JSON.stringify({ cfg: st.cfg, scheduled: st.scheduled, toasts: st.toasts, logs: st.startupLogs }, null, 0).slice(0, 700));
    check('重启后有「启动任务开始」日志', st.startupLogs.some((m) => /启动任务开始/.test(m)), JSON.stringify(st.startupLogs));
    if (RUN_TASKS.includes('autoAudit')) {
        // ⚠️ 摘要 toast 8 秒自动消失：探针连上（启动 20s+ 后）时早已过期 ⇒ 用「重跑同一任务」验证 toast 契约；
        //    启动路径本身的执行由上面的日志断言证明。
        const rerun = JSON.parse(await ev(`(async function(){
          var c = ${CTX};
          await c.startupScheduler.runNow({ enabled: true, autoAudit: true });
          var ts = (c.toasts.value||[]).map(function(t){ return { m: String(t.message||''), clickable: typeof t.onClick === 'function' }; });
          return JSON.stringify({ toasts: ts });
        })()`));
        check('★ autoAudit：体检日志 + **一条**可点击摘要 toast',
            st.startupLogs.some((m) => /启动体检/.test(m)) && rerun.toasts.length === 1 && /启动体检/.test(rerun.toasts[0].m) && rerun.toasts[0].clickable,
            JSON.stringify(rerun.toasts));
        const click = await ev(`(async function(){
          var c = ${CTX};
          var t = (c.toasts.value||[]).filter(function(x){ return /启动体检/.test(String(x.message||'')); })[0];
          if (!t) return JSON.stringify({ err: '无体检 toast' });
          t.onClick();
          await new Promise(function(r){ setTimeout(r, 800); });
          var txt = document.body.innerText || '';
          return JSON.stringify({ opened: !!c.showQualityCheckModal.value, inDom: txt.indexOf('一键质检') >= 0 });
        })()`);
        const ck = JSON.parse(click);
        check('点击摘要 toast ⇒ 打开「一键质检」弹窗', !!(ck.opened && ck.inDom), click);
        await ev(`(function(){ var c = ${CTX}; c.closeQualityCheck(); return 'ok'; })()`);
    }
    if (RUN_TASKS.includes('autoBackup')) {
        const dirRef = JSON.parse(await ev(`(function(){ var c = ${CTX}; return JSON.stringify({ dir: c.fullBackupDir.value }); })()`));
        check('冷备目录已从配置恢复', !!dirRef.dir, JSON.stringify(dirRef));
        const dirOk = BK_DEST ? fs.existsSync(path.join(BK_DEST, 'JSK-FullBackup')) : false;
        const names = dirOk ? fs.readdirSync(path.join(BK_DEST, 'JSK-FullBackup')) : [];
        check('★ autoBackup：自动生成了一份冷备（落盘目标目录）', dirOk && names.length >= 1, JSON.stringify(names));
        check('冷备日志写明目标目录与结果', st.startupLogs.some((m) => /启动自动冷备(完成|失败|：跳过)/.test(m)), JSON.stringify(st.startupLogs.filter((m) => /冷备/.test(m))));
    }
    if (RUN_TASKS.includes('autoDedupe')) {
        check('★ autoDedupe：自动查重已发起', st.startupLogs.some((m) => /启动自动查重/.test(m)), JSON.stringify(st.startupLogs.filter((m) => /查重/.test(m))));
    }
}

if (MODE === 'reset') {
    const r = await ev(`(async function(){
      var c = ${CTX};
      c.onStartupTasksChange({ enabled: false, autoAudit: false, autoBackup: false, autoDedupe: false, delayMs: 3000 });
      ${process.env.CLEAR_BK === '1' ? "c.fullBackupDir.value = '';" : ''}
      await new Promise(function (r) { setTimeout(r, 1500); });
      return JSON.stringify({ cfg: c.startupTasks.value, dir: c.fullBackupDir.value });
    })()`);
    await sleep(2000);
    check('已复位为全关（下次启动回到默认行为）', !!r && !r.__err, String(r).slice(0, 160));
    if (PROFILE_DIR) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'app_config.json'), 'utf8'));
            const s2 = j && j.ui && j.ui.startupTasks;
            check('落盘文件里 startupTasks 已全关', !!(s2 && s2.enabled === false && s2.autoAudit === false), JSON.stringify(s2));
        } catch (e) { check('落盘复位可读', false, e.message); }
    }
}

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 启动任务验收（${MODE}）：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
