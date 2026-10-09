/**
 * 🔀 世界书合并 · 真机验证（真库**只读**预览 + 编排正确性）
 *   A 段：真实世界书库跑查重扫描 → 找真实重复组 → 打开「合并此组」预览 → 断言数字合理 → **取消**（不执行）
 *   B 段：内存编排演练（合成 3 本：重复/独有/键冲突）→ 直接调编排的纯函数部分 → 断言并集与 uid 唯一
 *         ⚠️ **不执行落盘**（不调 confirmWbMerge，避免向真实库写新书）
 */
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
const FIND = (name) => `function walk(v,d){ if(!v||d>20) return null; var c=v.component; if(c){ var n=(c.type&&(c.type.name||c.type.__name))||''; if(n==='${name}') return (c.proxy||c); var r=walk(c.subTree,d+1); if(r) return r; }
  var ch=v.children; if(Array.isArray(ch)){ for(var i=0;i<ch.length;i++){ var r2=walk(ch[i],d+1); if(r2) return r2; } } return null; }`;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };

// ═══════ A. 真实库只读：查重组 → 预览 ═══════
console.log('── A. 真实世界书库（只读）──');
const libInfo = await ev(`(function(){
  var c = ${CTX};
  return { wb: c.worldbooks ? c.worldbooks.value.length : -1, mode: c.appMode ? c.appMode.value : '', hasCtxMerge: typeof c.mergeWbDedupeGroup };
})()`);
console.log('  世界书库:', JSON.stringify(libInfo));
check('ctx 暴露 mergeWbDedupeGroup（查重入口可用）', libInfo && libInfo.hasCtxMerge === 'function', String(libInfo && libInfo.hasCtxMerge));

// 跑世界书查重扫描（真实库，只读）
const scan = await ev(`(async function(){
  var c = ${CTX};
  if (typeof c.startWorldbookDedupeScan !== 'function') return { err: 'no scan fn' };
  try { await c.startWorldbookDedupeScan(); } catch (e) { return { err: String(e && e.message || e) }; }
  await new Promise(function(r){ setTimeout(r, 2500); });
  var gs = (c.wbDuplicateGroups && c.wbDuplicateGroups.value) || [];
  return { groups: gs.length, sample: gs.slice(0,3).map(function(g){ return { name: g.name, n: (g.list||[]).length, nameOnly: g.nameOnlyCount||0 }; }) };
})()`);
console.log('  查重扫描:', JSON.stringify(scan));
check('世界书查重扫描可跑（真实库）', !!(scan && Array.isArray(scan.sample)), JSON.stringify(scan));

const openPreview = await ev(`(async function(){
  var c = ${CTX};
  var gs = (c.wbDuplicateGroups && c.wbDuplicateGroups.value) || [];
  // 找第一个「非全仅同名、成员≥2」的组（= 可合并组）
  var idx = -1;
  for (var i = 0; i < gs.length; i++) {
    var usable = (gs[i].list || []).filter(function(w){ return !w._nameOnly; });
    if (usable.length >= 2) { idx = i; break; }
  }
  if (idx < 0) return { noGroup: true, groups: gs.length };
  await c.mergeWbDedupeGroup(idx);
  await new Promise(function(r){ setTimeout(r, 3000); });
  var pv = c.wbMergePreview.value || {};
  return { opened: !!c.showWbMergePreview.value, groupIdx: idx, groupName: gs[idx].name,
           sources: (pv.sources||[]).map(function(x){ return { name: String(x.name||'').slice(0,24), total: x.total, added: x.added, skipped: x.skipped }; }),
           stats: pv.stats ? { total: pv.stats.total, added: pv.stats.added, skippedDup: pv.stats.skippedDup, conflicts: (pv.stats.keyConflicts||[]).length } : null,
           mergeName: pv.mergeName };
})()`);
console.log('  预览数据:', JSON.stringify(openPreview));
if (openPreview && openPreview.noGroup) {
    check('（该库无「可合并」重复组 —— 预览分支以内存演练覆盖）', true, `groups=${openPreview.groups}`);
} else {
    check('「🔀 合并此组」能打开预览且来源 ≥2 本', !!(openPreview && openPreview.opened && openPreview.sources.length >= 2), JSON.stringify(openPreview && openPreview.sources));
    const st = (openPreview && openPreview.stats) || {};
    check('预览数字自洽（产出 ≤ 原词条；跳过重复 = 原 − 产出）',
        !!openPreview && st.added <= st.total && st.skippedDup === st.total - st.added,
        JSON.stringify(st));
    check('预览弹窗 DOM 渲染（含汇总与逐本表）', !!(await ev(`(function(){
      var t = document.body.innerText || '';
      return t.indexOf('世界书合并 · 预览') >= 0 && t.indexOf('跳过重复') >= 0 && t.indexOf('执行合并') >= 0;
    })()`)), '');
    // 取消（不执行）—— 保证真实库不被写入
    await ev(`(function(){ var c = ${CTX}; c.cancelWbMergePreview(); return 'ok'; })()`);
    await sleep(500);
    check('取消后预览关闭且库未被写入（新书未产生）',
        !(await ev(`(function(){ var c = ${CTX}; return !!c.showWbMergePreview.value; })()`)) &&
        !(await ev(`(function(){ var c = ${CTX}; return (c.worldbooks.value||[]).some(function(w){ return !w.path && /^合并世界书_/.test(String(w.name||'')); }); })()`)), '');
}

// ═══════ B. 内存编排演练（合成数据，不落盘） ═══════
console.log('── B. 合成数据演练（纯函数，不落盘）──');
const drill = await ev(`(async function(){
  var c = ${CTX};
  // 直接复用页面里同一份纯函数模块（dev 下可动态 import）
  var mod = await import('/js/utils/wbMerge.js');
  var mk = function (name, entries) { return { path: 'mem://' + name, name: name + '.json', data: { name: name, entries: entries }, dataLoaded: true }; };
  var A = mk('甲', [ { key: ['A','B'], content: '共同内容', uid: 1 }, { key: 'onlyA', content: '甲独有' } ]);
  var B = mk('乙', [ { key: ['B','A'], content: '共同内容', uid: 2 }, { key: 'conflict', content: '乙的版本' } ]);
  var C = mk('丙', [ { key: 'conflict', content: '丙的版本' }, { key: 'onlyC', content: '丙独有' } ]);
  var merged = mod.mergeWorldbookEntries([A,B,C].map(function(w){ return { name: w.data.name, entries: w.data.entries }; }));
  var uids = merged.entries.map(function(e){ return e.uid; });
  // 编排层只到「预览数据结构」为止（不调 confirmWbMerge ⇒ 不落盘）
  c.wbMergePreview.value = { sources: merged.stats.bySource, stats: merged.stats, mergeName: mod.mergeNameOf(3), wbs: [A,B,C], fromDedupe: true };
  return {
    added: merged.stats.added, total: merged.stats.total, skipped: merged.stats.skippedDup,
    conflicts: merged.stats.keyConflicts.length,
    keys: merged.entries.map(function(e){ return Array.isArray(e.key) ? e.key.join('+') : String(e.key); }).sort(),
    uidsUnique: new Set(uids).size === uids.length,
    previewSources: c.wbMergePreview.value.sources.length
  };
})()`);
console.log('  演练结果:', JSON.stringify(drill));
check('顺序不同但内容相同的词条被去重（total 6 → added 5、跳过 1）', !!(drill && drill.total === 6 && drill.added === 5 && drill.skipped === 1), JSON.stringify(drill));
check('键冲突被统计（conflict 组：乙 / 丙 两个版本）', !!(drill && drill.conflicts === 1), `conflicts=${drill && drill.conflicts}`);
check('产出 uid 唯一', !!(drill && drill.uidsUnique === true), '');
check('预览数据结构可被编排层消费（sources=3）', !!(drill && drill.previewSources === 3), '');
await ev(`(function(){ var c = ${CTX}; c.wbMergePreview.value = { sources: [], stats: null, mergeName: '', wbs: [], fromDedupe: false }; c.showWbMergePreview.value = false; return 'ok'; })()`);

// ═══════ C. 手动入口（「🔗 多本世界书智能合并」）也改为「先预览」（真库只读） ═══════
console.log('── C. 手动入口预览（只读）──');
const manual = await ev(`(async function(){
  var c = ${CTX};
  var wbs = (c.worldbooks.value || []).filter(function (w) { return w && w.path; }).slice(0, 2);
  if (wbs.length < 2) return { err: '库内不足 2 本可读世界书', n: wbs.length };
  if (!c.selectedWbMergePaths) return { err: 'ctx 无 selectedWbMergePaths' };
  c.selectedWbMergePaths.value = wbs.map(function (w) { return w.path; });
  await c.executeWorldbookMerge();                    // 手动入口：应**只打开预览**，不执行合并
  await new Promise(function (r) { setTimeout(r, 4500); });
  var pv = c.wbMergePreview.value || {};
  return { opened: !!c.showWbMergePreview.value, mergeModalClosed: !c.showWbMergeModal.value,
           sources: (pv.sources || []).length, fromDedupe: !!pv.fromDedupe,
           stats: pv.stats ? { total: pv.stats.total, added: pv.stats.added, skipped: pv.stats.skippedDup } : null,
           newBooks: (c.worldbooks.value || []).filter(function (w) { return !w.path; }).length };
})()`);
console.log('  手动入口:', JSON.stringify(manual));
check('手动入口改为「先预览」（预览打开、合并弹窗关闭、未执行合并）',
    !!(manual && manual.opened && manual.mergeModalClosed && manual.newBooks === 0), JSON.stringify(manual));
check('手动入口预览有来源与统计（懒加载书已按需载入）',
    !!(manual && manual.sources === 2 && manual.stats && manual.stats.total > 0 && manual.fromDedupe === false), JSON.stringify(manual && manual.stats));
await ev(`(function(){ var c = ${CTX}; c.cancelWbMergePreview(); c.selectedWbMergePaths.value = []; return 'ok'; })()`);
await sleep(500);
check('取消后无新书、库未被写入',
    !(await ev(`(function(){ var c = ${CTX}; return (c.worldbooks.value||[]).some(function(w){ return !w.path; }); })()`)), '');

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 世界书合并验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
