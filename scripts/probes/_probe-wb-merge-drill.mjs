/**
 * 🔀 世界书合并 · 隔离环境**落盘演练**（绝不碰真实库）
 *
 * 做法：隔离 profile 起 app → 用 CDP `DOM.setFileInputFiles` 把临时世界书库喂给
 *       「打开世界书文件夹」的隐藏 input（等价用户点选目录）→ 查重 → 合并此组 → 预览 → 执行 → 断言落盘。
 *
 * 用法：DRILL_DIR=<临时世界书目录> CDP_PORT=9377 node scripts/probes/_probe-wb-merge-drill.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { mergeWorldbookEntries } from '../../js/utils/wbMerge.js';

const PORT = Number(process.env.CDP_PORT || 9377);
const DIR = process.env.DRILL_DIR || '';
if (!DIR) { console.error('缺少 DRILL_DIR'); process.exit(1); }
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
const libFiles = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(DIR, f));

// 期望值：用**同一纯函数**对同一批文件算一遍（避免把数字写死在探针里）
const groupFiles = libFiles.filter((f) => !/^合并世界书/.test(path.basename(f)));
const expect = (() => {
    try {
        const srcs = groupFiles.map((f) => {
            const raw = JSON.parse(fs.readFileSync(f, 'utf8')).entries;
            const list = Array.isArray(raw) ? raw : Object.values(raw || {});
            return { name: path.basename(f), entries: list };
        });
        const m = mergeWorldbookEntries(srcs);
        const contents = Array.from(new Set(srcs.flatMap((s) => s.entries.map((e) => String(e.content || '').trim())))).sort();
        return { total: m.stats.total, added: m.stats.added, skipped: m.stats.skippedDup, conflicts: m.stats.keyConflicts.length, sources: srcs.length, contents };
    } catch (e) { return null; }
})();

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };

console.log('══ 隔离环境合并演练 ══');
console.log('临时世界书库:', DIR);
console.log('喂给应用的库文件:', libFiles.map((f) => path.basename(f)).join(' / '));

// ① 真实世界书**副本**已在临时库中 → 走真实扫描链路绑定（隔离 profile 只写临时目录）
const bound = await ev(`(async function(){
  var c = ${CTX};
  if (typeof c.scanWorldbookDir !== "function") return { err: "no scanWorldbookDir" };
  await c.scanWorldbookDir(${JSON.stringify(DIR)});
  await new Promise(function(r){ setTimeout(r, 7000); });   // 等阶段 2（词条数 / 指纹）补齐
  return { count: (c.worldbooks.value || []).length,
           names: (c.worldbooks.value || []).map(function(w){ return String(w.name||""); }),
           dir: c.lastWorldbookDirPath ? String(c.lastWorldbookDirPath.value || "") : "(无字段)" };
})()`);
console.log("  扫描结果:", JSON.stringify(bound));
check("临时库被真实扫描链路载入（≥2 本）", !!(bound && bound.count >= 2), JSON.stringify(bound && bound.names));
check("世界书目录已指向临时目录（新书落盘目标）", !!(bound && bound.dir === DIR), String(bound && bound.dir));
// ② 查重扫描
const scan = await ev(`(async function(){
  var c = ${CTX};
  await c.startWorldbookDedupeScan();
  await new Promise(function(r){ setTimeout(r, 2500); });
  var gs = (c.wbDuplicateGroups.value || []);
  return { groups: gs.length, detail: gs.map(function(g){ return { name: String(g.name||'').slice(0,20), n: (g.list||[]).length, nameOnly: g.nameOnlyCount||0 }; }) };
})()`);
console.log('  查重:', JSON.stringify(scan));
check('查重形成可合并组（同源 2 本）', !!(scan && scan.groups >= 1), JSON.stringify(scan));

// ③ 预览
const prev = await ev(`(async function(){
  var c = ${CTX};
  var gs = (c.wbDuplicateGroups.value || []);
  var idx = -1;
  for (var i=0;i<gs.length;i++){ var u=(gs[i].list||[]).filter(function(w){return !w._nameOnly;}); if(u.length>=2){idx=i;break;} }
  if (idx < 0) return { noGroup: true };
  await c.mergeWbDedupeGroup(idx);
  await new Promise(function(r){ setTimeout(r, 3000); });
  var pv = c.wbMergePreview.value || {};
  return { opened: !!c.showWbMergePreview.value, mergeName: pv.mergeName,
           sources: (pv.sources||[]).map(function(x){ return { total: x.total, added: x.added, skipped: x.skipped }; }),
           stats: pv.stats ? { total: pv.stats.total, added: pv.stats.added, skippedDup: pv.stats.skippedDup, conflicts: (pv.stats.keyConflicts||[]).length } : null };
})()`);
console.log('  预览:', JSON.stringify(prev));
check('预览打开且来源 2 本', !!(prev && prev.opened && prev.sources.length === 2), JSON.stringify(prev && prev.sources));
check(`预览统计正确（${expect.total} → ${expect.added}，跳过 ${expect.skipped}，冲突 ${expect.conflicts}）`,
    !!(prev && prev.stats && expect && prev.stats.total === expect.total && prev.stats.added === expect.added && prev.stats.skippedDup === expect.skipped && prev.stats.conflicts === expect.conflicts),
    JSON.stringify(prev && prev.stats));

// ④ 执行（不清理源书）
const exec = await ev(`(async function(){
  var c = ${CTX};
  if (typeof c.confirmWbMerge !== 'function') return { err: 'ctx 未暴露 confirmWbMerge' };
  await c.confirmWbMerge({ trashSources: false });
  await new Promise(function(r){ setTimeout(r, 3000); });
  var wbs = c.worldbooks.value || [];
  var fresh = wbs.filter(function(w){ return /^合并世界书_/.test(String(w.name||'')); })[0];
  var ents = (fresh && fresh.data && fresh.data.entries) || [];
  return { closed: !c.showWbMergePreview.value, count: wbs.length,
           fresh: fresh ? { name: String(fresh.name||''), path: String(fresh.path||''), entries: ents.length, uidsUnique: new Set(ents.map(function(e){return e.uid;})).size === ents.length,
                            contents: ents.map(function(e){ return String(e.content||'').trim(); }).sort() } : null };
})()`);
console.log('  执行:', JSON.stringify(exec));
if (exec && exec.err) {
    check('ctx 暴露 confirmWbMerge（合并执行入口）', false, exec.err);
} else {
    check('合并后新书进入列表且预览关闭', !!(exec && exec.closed && exec.fresh), JSON.stringify(exec && exec.fresh && exec.fresh.name));
    check(`新书 = 并集 ${expect.added} 条（内容并集逐条一致）`,
        !!(exec && exec.fresh && expect && exec.fresh.entries === expect.added &&
           JSON.stringify(exec.fresh.contents) === JSON.stringify(expect.contents)),
        JSON.stringify(exec && exec.fresh && exec.fresh.contents));
    check('新书 uid 唯一', !!(exec && exec.fresh && exec.fresh.uidsUnique), '');
    await sleep(1500);
    const files = fs.readdirSync(DIR);
    console.log('  库内文件（合并后）:', files.join(' / '));
    check('新书已落盘到临时库目录', files.some((f) => /^合并世界书_/.test(f)), files.join(' / '));
    const srcNames = libFiles.map((f) => path.basename(f));
    check('源书保留（未勾选清理）', srcNames.every((n) => files.includes(n)), files.join(' / '));
    if (exec && exec.fresh && exec.fresh.path) {
        try {
            const raw = JSON.parse(fs.readFileSync(exec.fresh.path, 'utf8'));
            const ents = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {});
            check(`落盘词条数 = 内存（${expect.added}）`, ents.length === expect.added, `disk=${ents.length}`);
            // ⚠️ 保存链路会**重新编号 uid**（ST 数字口径 0/1/2）—— 只断言「齐备 + 唯一 + 无内部字段残留」
                        const diskUids = ents.map((e) => e.uid);
                        check('落盘词条 uid 齐备且唯一、无内部字段残留',
                            ents.every((e) => e && e.uid !== undefined && e.uid !== null && !e._srcUid && !e._collapsed) && new Set(diskUids).size === diskUids.length,
                            'uids=' + JSON.stringify(diskUids));
        } catch (e) { check('落盘文件可解析', false, String(e.message)); }
    }
}

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 隔离合并演练：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
