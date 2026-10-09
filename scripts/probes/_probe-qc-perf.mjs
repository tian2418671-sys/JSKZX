/**
 * 🧪 一键质检 · S3/S4 大库吞吐与分片验证（对应规格 §四.6「11k 只读：S3/S4 不卡 UI」）
 *
 * 口径说明（**如实标注**）：
 *   · 条目形状取自**真实卡库**（app 内 77 张卡的真实字段：tags / customTags / _tokens / data.data.*），
 *     再按比例循环放大到 12,000 条 —— 因为 S3/S4 的成本只与「条目数 × 字段形状」有关，与卡片正文大小无关；
 *   · 11,849 压测库（`I:\03\角色色卡`）**未在 app 内实跑**：主进程路径白名单只由「UI 打开目录」建立
 *     （实测该路径返回「路径越界，操作被拒绝」）——需用户在界面里打开该目录才能跑；本条用放大条目测吞吐代替，
 *     并在报告里如实说明。
 *   · 分片常量由 `useQualityCheck.js` 真实导出（CHUNK=200，每片 `await` 让出）——本探针直接断言它。
 *
 * 用法：node scripts/probes/_probe-qc-perf.mjs
 */
import { computeTagStats } from '../../js/utils/tagStats.js';
import { auditCards } from '../../js/utils/cardAudit.js';
import { CHUNK } from '../../js/composables/useQualityCheck.js';

const PORT = Number(process.env.CDP_PORT || 9375);
const TARGET = Number(process.env.PERF_N || 12000);

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((t) => t.type === 'page');
const s = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m.result); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa) => new Promise((res) => { const id = ++i; q.set(id, res); s.send(JSON.stringify({ id, method: me, params: pa })); });
const CTX = `(function(){var a=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;return (a&&(a._context.provides.appCtx||(a._container._vnode.component.provides.appCtx)))||null;})()`;
const rawText = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
    return r.result.value;
};

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  => ' + d : ''}`); };

// ① 取真实条目形状（页内 stringify，避开代理序列化）
const realJson = await rawText(`(function(){
  var c = ${CTX};
  var items = (c.library.value || []).map(function (it) {
    var d = it.data && it.data.data ? it.data.data : (it.data || {});
    return {
      path: it.path, name: it.name,
      tags: Array.isArray(it.tags) ? it.tags : (Array.isArray(it.customTags) ? it.customTags : []),
      _tokens: typeof it._tokens === 'number' ? it._tokens : 0,
      data: { data: { description: d.description || '', first_mes: d.first_mes || '' } }
    };
  });
  return JSON.stringify(items);
})()`);
const real = JSON.parse(realJson);
check('取到真实卡库条目形状', real.length > 0, `${real.length} 条`);

// ② 放大到目标规模（真实字段循环）
const big = [];
for (let k = 0; k < TARGET; k++) {
    const src = real[k % real.length];
    big.push({ path: src.path + '#' + k, name: src.name, tags: src.tags, _tokens: src._tokens, data: src.data });
}
console.log(`  放大条目：${big.length} 条（真实形状循环）`);

// ③ 整段耗时（等价一次性调用）
const t0 = performance.now();
const stats = computeTagStats(big);
const t1 = performance.now();
const audit = auditCards(big, { tokenThreshold: 8000, estimateCardTokens: (c) => c._tokens || 0 });
const t2 = performance.now();
console.log(`  computeTagStats：${(t1 - t0).toFixed(0)}ms（${big.length} 条）｜auditCards：${(t2 - t1).toFixed(0)}ms`);
check('S3 整段耗时 < 2s', (t1 - t0) < 2000, `${(t1 - t0).toFixed(0)}ms`);
check('S4 整段耗时 < 4s', (t2 - t1) < 4000, `${(t2 - t1).toFixed(0)}ms`);
check('统计自洽（无标签 + 有标签 = 总数）', stats.untagged + stats.tagged === stats.total, JSON.stringify({ u: stats.untagged, t: stats.tagged, n: stats.total }));

// ④ 分片（与 composable 同粒度）每片耗时 —— 这决定「一次阻塞多长」
check('分片常量 CHUNK = 200（每片 await 让出）', CHUNK === 200, String(CHUNK));
let maxChunk = 0;
let sumChunk = 0;
for (let k = 0; k < big.length; k += CHUNK) {
    const part = big.slice(k, k + CHUNK);
    const c0 = performance.now();
    computeTagStats(part, { topN: 1000, capItems: 1 });
    auditCards(part, { tokenThreshold: 8000, estimateCardTokens: (c) => c._tokens || 0 });
    const dt = performance.now() - c0;
    sumChunk += dt;
    if (dt > maxChunk) maxChunk = dt;
}
console.log(`  分片：共 ${Math.ceil(big.length / CHUNK)} 片，单片最大 ${maxChunk.toFixed(1)}ms，累计 ${sumChunk.toFixed(0)}ms`);
check('单片耗时 < 50ms ⇒ 不产生长任务（UI 不卡）', maxChunk < 50, `最大 ${maxChunk.toFixed(1)}ms`);
check('单片平均 < 10ms', (sumChunk / Math.ceil(big.length / CHUNK)) < 10, `平均 ${(sumChunk / Math.ceil(big.length / CHUNK)).toFixed(1)}ms`);

const pass = results.filter((x) => x.ok).length;
console.log(`\n═════ 质检大库吞吐验证：${pass}/${results.length} PASS ═════`);
if (pass !== results.length) results.filter((x) => !x.ok).forEach((x) => console.log('  ✗ ' + x.n + '  ' + (x.d || '')));
process.exit(pass === results.length ? 0 : 1);
