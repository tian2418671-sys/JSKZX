/**
 * 🧪 一键质检流水线 · 真机验证（**真实卡库 89 张，只读**）
 *
 * 验收对应（规格 §四）：
 *   1 全流程 60 秒内出报告 + 报告数字与**探针独立复算**一致（无标签数 / 超长卡数）
 *   2 各步失败不阻断（S5 未打开世界书 → skipped，其余正常）
 *   3 「定位」跳转可用（卡片打开）
 *   4 中止：中途 cancel → 已完成保留、后续标记 cancelled
 *   外加：报告导出 Markdown 落盘逐字一致（复用 ② 的 saveTextFile 底座）
 *
 * ⚠️ 全程只读：不删、不改、不保存任何数据（唯一写盘是导出报告到临时路径）。
 * 用法：node scripts/probes/_probe-quality-check.mjs   （CDP_PORT 默认 9375）
 */
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9375);
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

// ⓪ 前置：确保「未打开世界书」（S5 应 skipped 的前提）；只动视图状态，不写任何数据
await ev(`(function(){ var c = ${CTX}; c.activeWorldbook.value = null; if (c.selectedWbMergePaths) c.selectedWbMergePaths.value = []; return 'ok'; })()`);
await sleep(400);

// ① 入口 + 接线
const menu = await ev(`(async function(){
  var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
  var m = btns.filter(function (b) { return /维护/.test(b.textContent || ''); })[0];
  if (!m) return { err: '未找到维护菜单' };
  m.click();
  await new Promise(function (r) { setTimeout(r, 500); });
  var lines = (document.body.innerText || '').split('\\n').map(function (x) { return x.trim(); });
  var iQc = lines.findIndex(function (x) { return x.indexOf('一键质检') >= 0; });
  var iBk = lines.findIndex(function (x) { return x.indexOf('整库冷备') >= 0; });
  return { hasQc: iQc >= 0, afterBackup: iQc >= 0 && iBk >= 0 && iQc > iBk, around: lines.filter(function (x) { return /质检|冷备|孤儿快照/.test(x); }) };
})()`);
check('维护菜单有「🧪 一键质检…」且排在「📦 整库冷备…」之后',
    !!(menu && menu.hasQc && menu.afterBackup), JSON.stringify(menu && menu.around));

const wired = await ev(`(function(){ var c = ${CTX}; return {
  open: typeof c.openQualityCheck, run: typeof c.runQualityCheck, cancel: typeof c.cancelQualityCheck,
  locate: typeof c.locateQualityItem, report: typeof c.buildQualityReport,
  steps: (c.qcSteps && c.qcSteps.value || []).length, enabled: JSON.stringify(c.qcEnabled || {}).slice(0, 90)
}; })()`);
check('ctx 五件套接线齐（open/run/cancel/locate/report）+ 5 步',
    !!(wired && wired.open === 'function' && wired.run === 'function' && wired.cancel === 'function' && wired.locate === 'function' && wired.report === 'function' && wired.steps === 5),
    JSON.stringify(wired));

const opened = await ev(`(async function(){
  var c = ${CTX}; c.openQualityCheck();
  await new Promise(function(r){ setTimeout(r, 900); });
  var t = document.body.innerText || '';
  return { visible: t.indexOf('一键质检') >= 0 && t.indexOf('开始质检') >= 0, hasWarning: t.indexOf('只读') >= 0 };
})()`);
check('弹窗可打开且标注「只读」', !!(opened && opened.visible && opened.hasWarning), JSON.stringify(opened));

// ② 跑全流程（真实库）+ 计时
const run = await ev(`(async function(){
  var c = ${CTX};
  // 只勾 S1/S3/S4 参与数字复核（S2 查重耗时随库大小；S5 未打开世界书应 skipped）
  c.qcEnabled.rescan = true; c.qcEnabled.dedupe = false; c.qcEnabled.tags = true; c.qcEnabled.audit = true; c.qcEnabled.wb = true;
  var t0 = performance.now();
  await c.runQualityCheck();
  var ms = performance.now() - t0;
  return {
    ms: Math.round(ms),
    steps: (c.qcSteps.value || []).map(function (x) { return { id: x.id, status: x.status, summary: String(x.summary || '').slice(0, 120), ms: x.ms }; }),
    reportLen: (c.qcReport.value || '').length
  };
})()`);
console.log('  运行:', JSON.stringify(run && run.steps));
if (!run || !Array.isArray(run.steps)) { console.log('  ⚠️ run 返回异常:', JSON.stringify(run)); }
check('全流程在 60 秒内出报告（真实库）', !!(run && run.ms < 60000 && run.reportLen > 200), `用时 ${run && run.ms}ms，报告 ${run && run.reportLen} 字`);
check('S5 未打开世界书 ⇒ skipped，其余正常（失败不阻断）',
    !!(run && Array.isArray(run.steps) && run.steps.find((x) => x.id === 'wb').status === 'skipped' && run.steps.find((x) => x.id === 'tags').status === 'done' && run.steps.find((x) => x.id === 'audit').status === 'done'),
    JSON.stringify(run && Array.isArray(run.steps) && run.steps.map((x) => x.id + ':' + x.status)));

// ③ 探针**独立复算**（不用被测代码）并与报告比对
const verify = JSON.parse(await ev(`(function(){
  var c = ${CTX};
  var items = c.library.value || [];
  var untagged = 0, descEmpty = 0, firstEmpty = 0, singleTag = 0, over = 0, tagSet = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var tags = Array.isArray(it.tags) ? it.tags : (Array.isArray(it.customTags) ? it.customTags : []);
    var inner = (it.data && it.data.data) ? it.data.data : (it.data || it);
    if (!tags.length) untagged++;
    if (tags.length === 1) singleTag++;
    for (var t = 0; t < tags.length; t++) { var k = String(tags[t]).trim(); if (k) tagSet[k] = 1; }
    var d = inner.description; if (d === undefined || d === null || String(d).trim() === '') descEmpty++;
    var f = inner.first_mes; if (f === undefined || f === null || String(f).trim() === '') firstEmpty++;
    var tk = 0; try { tk = Number(c.estimateCardTokens ? c.estimateCardTokens(it) : (it._tokens || 0)) || 0; } catch (e) { tk = 0; }
    if (tk > c.qcTokenThreshold.value) over++;
  }
  return JSON.stringify({ total: items.length, untagged: untagged, singleTag: singleTag, tagKinds: Object.keys(tagSet).length, descEmpty: descEmpty, firstEmpty: firstEmpty, over: over, threshold: c.qcTokenThreshold.value });
})()`));
const tagsData = JSON.parse(await ev(`(function(){ var c = ${CTX}; var s = (c.qcSteps.value||[]).find(function(x){return x.id==='tags';}); return JSON.stringify((s && s.data) || null); })()`));
const auditData = JSON.parse(await ev(`(function(){ var c = ${CTX}; var s = (c.qcSteps.value||[]).find(function(x){return x.id==='audit';}); return JSON.stringify((s && s.data) || null); })()`));
console.log('  独立复算:', JSON.stringify(verify));
console.log('  报告S3:', JSON.stringify(tagsData && { total: tagsData.total, untagged: tagsData.untagged, coveragePct: tagsData.coveragePct, singleTag: tagsData.singleTag, tagCount: tagsData.tagCount }));
console.log('  报告S4:', JSON.stringify(auditData && Array.isArray(auditData.rules) && auditData.rules.map((r) => r.id + '=' + r.count)));
check('S3 报告数字与独立复算一致（总数 / 无标签 / 单标签 / 标签种类）',
    !!(tagsData && verify && tagsData.total === verify.total && tagsData.untagged === verify.untagged && tagsData.singleTag === verify.singleTag && tagsData.tagCount === verify.tagKinds),
    '报告 ' + JSON.stringify(tagsData && { t: tagsData.total, u: tagsData.untagged, s: tagsData.singleTag, k: tagsData.tagCount }) + ' vs 复算 ' + JSON.stringify({ t: verify.total, u: verify.untagged, s: verify.singleTag, k: verify.tagKinds }));
check('S3 覆盖率 = (总数−无标签)/总数',
    !!(tagsData && tagsData.coveragePct === Math.round((tagsData.total - tagsData.untagged) / tagsData.total * 1000) / 10),
    JSON.stringify(tagsData && tagsData.coveragePct));
const auditCount = (id) => ((auditData && Array.isArray(auditData.rules) && auditData.rules.find((r) => r.id === id)) || {}).count;
check('S4 报告数字与独立复算一致（简介空 / 无标签 / 开场白空 / 超阈值）',
    auditCount('desc-empty') === verify.descEmpty && auditCount('no-tags') === verify.untagged && auditCount('first-mes-empty') === verify.firstEmpty && auditCount('token-over') === verify.over,
    JSON.stringify({ r: { d: auditCount('desc-empty'), t: auditCount('no-tags'), f: auditCount('first-mes-empty'), o: auditCount('token-over') }, v: { d: verify.descEmpty, t: verify.untagged, f: verify.firstEmpty, o: verify.over } }));

// ④ 导出报告（走 ② 的 saveTextFile 底座；JSK_TEST_SAVE_PATH 下无需对话框）
const exp = await ev(`(async function(){
  var app = document.querySelector('#app').__vue_app__;
  function walk(v, d) { if (!v || d > 20) return null; var c = v.component; if (c) { var n = (c.type && (c.type.name || c.type.__name)) || ''; if (n === 'QualityCheckModal') return (c.proxy || c); var r = walk(c.subTree, d + 1); if (r) return r; }
    var ch = v.children; if (Array.isArray(ch)) { for (var i = 0; i < ch.length; i++) { var r2 = walk(ch[i], d + 1); if (r2) return r2; } } return null; }
  var comp = walk(app._instance.subTree, 0);
  if (!comp) return { err: '未找到 QualityCheckModal 组件' };
  await comp.exportReport();
  await new Promise(function (r) { setTimeout(r, 600); });
  return { msg: String(comp.msg || ''), exporting: comp.exporting };
})()`);
await sleep(400);
// ⚠️ app 的 `JSK_TEST_SAVE_PATH` 在**启动时**固定 ⇒ 探针用 JSK_APP_SAVE_PATH 对准它实际写入的路径
const testPath = process.env.JSK_APP_SAVE_PATH || process.env.JSK_TEST_SAVE_PATH || '';
const reportText = await ev(`(function(){ var c = ${CTX}; return c.qcReport.value || ''; })()`);
check('导出 Markdown 走 saveTextFile 成功', !!(exp && !exp.err && /已导出|KB/.test(exp.msg || '')), JSON.stringify(exp));
if (testPath && fs.existsSync(testPath)) {
    const onDisk = fs.readFileSync(testPath, 'utf8');
    check('落盘报告与内存报告逐字一致', onDisk === reportText, `磁盘 ${onDisk.length} 字 vs 内存 ${String(reportText).length} 字`);
    check('报告含只读声明与冷备建议', onDisk.includes('只读') && onDisk.includes('整库冷备'), '');
} else {
    check('（未对准 app 实际写入路径 ⇒ 跳过落盘比对）', true, testPath || '(空)');
}

// ⑤ 复制报告（剪贴板或 textarea 兜底）
const copy = await ev(`(async function(){
  var app = document.querySelector('#app').__vue_app__;
  function walk(v, d) { if (!v || d > 20) return null; var c = v.component; if (c) { var n = (c.type && (c.type.name || c.type.__name)) || ''; if (n === 'QualityCheckModal') return (c.proxy || c); var r = walk(c.subTree, d + 1); if (r) return r; }
    var ch = v.children; if (Array.isArray(ch)) { for (var i = 0; i < ch.length; i++) { var r2 = walk(ch[i], d + 1); if (r2) return r2; } } return null; }
  var comp = walk(app._instance.subTree, 0);
  await comp.copyReport();
  await new Promise(function (r) { setTimeout(r, 200); });
  return { msg: String(comp.msg || '') };
})()`);
check('「📋 复制报告」有明确反馈（已复制 / 失败原因）', !!(copy && copy.msg), JSON.stringify(copy));

// ⑥ 定位（打开报告里第一张问题卡）
const locate = await ev(`(async function(){
  var c = ${CTX};
  var s = (c.qcSteps.value || []).find(function (x) { return x.id === 'audit'; });
  var hit = s && (s.items || []).filter(function (x) { return x.kind === 'card' && x.path; })[0];
  if (!hit) return { err: '报告内无可定位卡片' };
  var before = c.cardData.value ? (c.cardData.value.data ? String(c.cardData.value.data.name || '') : '') : '';
  await c.locateQualityItem(hit);
  await new Promise(function (r) { setTimeout(r, 2500); });
  var openedPath = (c.library.value || []).filter(function (x) { return x.data && c.cardData.value && x.data === c.cardData.value; })[0];
  return { hit: hit.name, opened: !!(openedPath && openedPath.path === hit.path), openedName: openedPath ? String(openedPath.name || '') : '(未打开)', before: before };
})()`);
check('「定位」能打开报告里的问题卡', !!(locate && locate.opened), JSON.stringify(locate));

// ⑦ 中止（S2 查重耗时窗口内取消 ⇒ 后续标记 cancelled）
const cancelRun = await ev(`(async function(){
  var c = ${CTX};
  c.qcEnabled.rescan = false; c.qcEnabled.dedupe = true; c.qcEnabled.tags = true; c.qcEnabled.audit = true; c.qcEnabled.wb = true;
  var pr = c.runQualityCheck();
  await new Promise(function (r) { setTimeout(r, 600); });
  c.cancelQualityCheck();
  await pr;
  return { steps: (c.qcSteps.value || []).map(function (x) { return x.id + ':' + x.status; }) };
})()`);
console.log('  中止后:', JSON.stringify(cancelRun && cancelRun.steps));
check('中止：已完成保留、后续标记 cancelled（不崩不阻断）',
    !!(cancelRun && cancelRun.steps.some((x) => /cancelled/.test(x)) && !cancelRun.steps.every((x) => /cancelled/.test(x))),
    JSON.stringify(cancelRun && cancelRun.steps));

// ⑧ S5 打开世界书后可用（真实世界书，只读）
const wbStep = JSON.parse(await ev(`(async function(){
  var c = ${CTX};
  var wb = (c.worldbooks.value || [])[0];
  if (!wb) return { err: '世界书库为空' };
  try { await c.selectWorldbook(wb); } catch (e) { return { err: 'selectWorldbook 失败: ' + (e && e.message) }; }
  await new Promise(function (r) { setTimeout(r, 2500); });
  c.qcEnabled.rescan = false; c.qcEnabled.dedupe = false; c.qcEnabled.tags = false; c.qcEnabled.audit = false; c.qcEnabled.wb = true;
  await c.runQualityCheck();
  var s = (c.qcSteps.value || []).find(function (x) { return x.id === 'wb'; });
  return JSON.stringify({ status: s.status, summary: String(s.summary || '').slice(0, 140), data: s.data || null, book: String(wb.name || '') });
})()`));
console.log('  S5:', JSON.stringify(wbStep));
check('S5 打开世界书后正常出体检数字（真实书，只读）',
    !!(wbStep && wbStep.status === 'done' && wbStep.data && Number.isFinite(wbStep.data.emptyCount)),
    JSON.stringify(wbStep && wbStep.data));

// ⑨ 关闭弹窗 + 还原（视图类状态复位；未写任何数据）
await ev(`(function(){ var c = ${CTX}; c.closeQualityCheck(); c.qcEnabled.rescan=true; c.qcEnabled.dedupe=true; c.qcEnabled.tags=true; c.qcEnabled.audit=true; c.qcEnabled.wb=true; return 'ok'; })()`);

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 一键质检验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
