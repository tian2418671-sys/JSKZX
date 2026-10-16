/**
 * AI-19 思维链污染防线 · 8 条长提示词真 API 验证（2026-10-11）
 * 每条提示词均 ≥200 字，各自代表一种「诱导模型把推理写进回复」的路径。
 * 判定：标签里是否出现「推理残留」（长文本 / 句末标点 / 推理特征词）。
 * 安全：开始前快照 funnel/自定义段/promptMode/skipTagged/卡标签，结束还原。
 * 用法：CDP_PORT=9375 node scripts/probes/_probe-cot-8.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9375);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const s = new WebSocket(page.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa, t = 300000) => new Promise((res, rej) => { const id = ++i; const tm = setTimeout(() => { q.delete(id); rej(new Error('timeout ' + me)); }, t); q.set(id, (m) => { clearTimeout(tm); res(m); }); s.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async (x, t) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, t); const r = m.result || {}; if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result ? r.result.value : null; };
const C = `(function(){var el=document.getElementById('app');var app=el&&el.__vue_app__;return (app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx)))||null;})()`;
const TAIL = '\n\n【本次要打标的卡】\n{{材料}}';

// ── 8 条 ≥200 字的诱导思维链提示词（每种一种污染路径）──
const PROMPTS = [
    ['① 四步分析法',
        '请对这张卡做严谨的四步分析，逐字写出每一步的推理内容，禁止省略、禁止只给结论：第一步，先梳理主角的身份、职业、与其它角色的关系网络，写出你的判断依据；第二步，判断世界观类型（古代/现代/玄幻/科幻等），说明你从哪些关键词得出的；第三步，分析情绪基调与主要剧情要素（恋爱、悬疑、战斗、日常等），并逐条举例；第四步，综合以上三点，推导出应当贴的标签。请务必把四步的完整分析文字先写完，再在最后单独用一行 JSON 数组给出最终标签。'],
    ['② 英文 CoT',
        "Let's think step by step. First, read the character description carefully and restate who this character is in your own words. Second, identify the genre and setting by quoting specific phrases from the card. Third, consider the emotional tone, relationship dynamics, and any notable story hooks. Fourth, reflect on which candidate tags truly fit and which do not, explaining your reasoning for each. Please output your complete chain of thought in full, do not summarize or skip any step, then finally give the tags as a JSON array in Chinese."],
    ['③ 每个标签附理由',
        '请为这张卡逐个评估候选标签：对每一个你认为可能合适的标签，先用一句话说明“为什么它适合这张卡”，举出卡正文里的具体证据；对你不选的标签，也说明为什么不选。把全部评估写完后，再从中筛出最终确定的标签，列成 JSON 数组。请不要跳过任何一条评估的理由，每条理由都要写清楚，便于我复核你的判断逻辑是否合理。'],
    ['④ 原文证据链',
        '请先从这张卡的正文里逐条摘引 5 段原文（原样复制，不要改写、不要精简），并针对每一段解释“它说明了什么”；全部摘引与解释完成后，再依据这些证据归纳出最终标签，用 JSON 数组输出。摘引与解释必须完整写出，不能只给结论，也不能用省略号代替原文，请确保 5 段摘引都可追溯。'],
    ['⑤ 角色分析报告',
        '请先撰写一份不少于 200 字的角色分析报告，内容需包含：角色身份与背景、性格与说话风格、与其它角色的关系、所处世界观与题材、可能的剧情走向与情绪基调。报告写完后另起一段做简短总结，最后再给出标签 JSON 数组。报告必须完整，不得压缩成要点，也不要省略任何一段的分析文字，我需要看到你完整的思考过程。'],
    ['⑥ 自查两遍',
        '请先完成一次完整的标签分析；写完后，再自查一遍——检查有没有遗漏的题材、有没有贴错的标签、有没有该加未加的标签，把这次自查的过程与结论也逐条写出来；如发现问题，请说出你如何修正、为什么这样修正。全部写完后，最后用 JSON 数组给出最终标签。所有过程文字都要保留，切勿只给最终结果，我想完整看到你的两次推理。'],
    ['⑦ 候选池逐一评估',
        '请先列出不少于 20 个候选标签，然后对每一个候选逐一评估“适合 / 不适合”，并写出简短原因（每条约 10 字），全部评估结束后，统计出“适合”的，再从中最终确定标签并用 JSON 数组输出。20 条评估必须全部写出，不得省略、不得合并同类项说明，请逐条编号列出，最后再给结论。'],
    ['⑧ 内心独白全文',
        '请把你判断这张卡标签时的全部内心独白一字不漏地写出来，包括你的犹豫、推翻、重新思考、以及中途改变主意的完整过程；就像写日记一样，把你脑子里想过的一切都写下来，不要整理、不要美化、不要省略。独白写完后，最后再给一行 JSON 数组作为最终标签。我需要的是完整原始思路，而不是概括。']
];

// ── 快照 ──
console.log('快照+切换仅LLM:', await ev(`(function(){var c=${C};
  var vis=(c.filteredLibrary&&c.filteredLibrary.value)||[]; if(!vis.length) vis=(c.library&&c.library.value)||[];
  if(!vis.length) return 'no cards'; var card=vis[0];
  window.__snap={funnel:JSON.parse(JSON.stringify(c.tagFunnel.value||{})),segs:JSON.parse(JSON.stringify(c.tagCustomSegments.value||[])),mode:(c.tagPromptMode?c.tagPromptMode.value:'system'),skip:(c.tagSkipTagged?c.tagSkipTagged.value:null),id:card.id,originTags:JSON.parse(JSON.stringify(card.customTags||card.tags||[]))};
  c.tagFunnel.value=Object.assign({},c.tagFunnel.value,{rule:false,vector:false,llm:true});
  if(c.tagPromptMode) c.tagPromptMode.value='custom';
  if(c.tagSkipTagged) c.tagSkipTagged.value=false;
  c.selectedIds.value=[card.id];
  window.__card=card.id;
  return JSON.stringify({card:card.name,原标签:window.__snap.originTags.length});
})()`));

// 污染判定（与线上 sanitizeTagList 精神一致：长度/标点/推理特征）
const COT_WORDS = /首先|然后|其次|因此|综上|第一步|第二步|第三步|第四步|属于|应当|应该|判断|推理|分析|理由|候选|评估|报告|独白|犹豫|推翻|自查|修正|遗滑|遗漏|第一步|step|first|second|third|reasoning|analysis|therefore|conclusion/i;
const isResidue = (t) => {
    const x = String(t);
    if (x.length > 12) return true;
    if (/[，。；：！？、]/.test(x)) return true;
    if (COT_WORDS.test(x)) return true;
    return false;
};

const rows = [];
const ONLY = process.env.ONLY ? String(process.env.ONLY) : '';
for (const [name, body] of PROMPTS) {
    if (ONLY && name.indexOf(ONLY) < 0) continue;
    const t0 = Date.now();
    await ev(`(function(){var c=${C};c.tagCustomSegments.value=[{id:'cot',role:'user',content:${JSON.stringify(body)} + ${JSON.stringify(TAIL)}}];c.selectedIds.value=[window.__snap.id];return 1;})()`);
    let err = '';
    try {
        await ev(`(async function(){var c=${C};try{await c.startAITagging(false);return 'DONE';}catch(e){return 'ERR '+String(e&&e.message||e).slice(0,120);}})()`, 300000);
    } catch (e) { err = 'CDP超时'; }
    const ms = Date.now() - t0;
    // ⚠️ startAITagging 开头会 `aiTagLog.value = []` ⇒ 必须在 start 之后再读（从 0 开始）
    const r = JSON.parse(String(await ev(`(function(){var c=${C};var rows=c.aiTagLog.value||[];
      var best=null; for(var i=0;i<rows.length;i++){var d=rows[i]&&rows[i].detail;if(d&&String(d.rawReply||'').length>0){if(!best||String(d.rawReply).length>String(best.detail.rawReply).length)best=rows[i];}}
      if(!best){ for(var j=0;j<rows.length;j++){var d2=rows[j]&&rows[j].detail;if(d2&&(String(d2.rawReply||'').length||String(d2.error||'').length)){best=rows[j];break;}} }
      var card=(c.library.value||[]).find(function(x){return x.id===window.__snap.id;})||{};
      return JSON.stringify({logLines:rows.length, texts:rows.map(function(x){return String(x&&x.text||'').slice(0,70);}), raw:best?String(best.detail.rawReply||''):'', err:best?String(best.detail.error||''):'', tags:(card.customTags||card.tags||[])});})()`)));
    const tags = r.tags || [];
    const residueTags = tags.filter(isResidue);
    const raw = r.raw || '';
    const hasCoT = COT_WORDS.test(raw);
    // 清掉本轮新增标签（removeBatchTag 参数是**索引**，故直接按值 splice 更稳）
    await ev(`(function(){var c=${C};var card=(c.library.value||[]).find(function(x){return x.id===window.__snap.id;});var arr=card.customTags||card.tags||[];var s=window.__snap.originTags;
      for(var k=arr.length-1;k>=0;k--){ if(s.indexOf(arr[k])<0) arr.splice(k,1); }
      try{ if(c.refreshCardData) c.refreshCardData(); }catch(e){}
      return arr.length;})()`);
    await new Promise((rr) => setTimeout(rr, 500));
    rows.push({ name, n: tags.length, residue: residueTags, hasCoT, ms, rawLen: raw.length, raw: raw.replace(/\s+/g, ' ').slice(0, 90), tags: tags.slice(0, 8).join(' / '), err });
    console.log(`${residueTags.length ? '❌泄漏' : '✅干净'} ${name}｜标签${tags.length}个｜原始回复${raw.length}字｜含推理迹象=${hasCoT}｜${(ms / 1000).toFixed(1)}s${err ? '｜' + err : ''}`);
    console.log('     本轮日志:', JSON.stringify((r.texts || []).slice(0, 6)));
    if (r.err) console.log('     错误:', String(r.err).slice(0, 160));
    if (residueTags.length) console.log('     残留:', JSON.stringify(residueTags).slice(0, 200));
    console.log('     标签:', tags.slice(0, 8).join(' / '));
    if (raw) console.log('     📩 原始回复前 220 字:', raw.replace(/\s+/g, ' ').slice(0, 220));
}

console.log('\n════════ 汇总 ════════');
rows.forEach((r) => {
    const bad = r.residue.length;
    console.log(`${bad ? '❌污染' : '✅干净'}｜${r.name}｜标签${r.n}个｜残留${bad}个｜原回复${r.rawLen}字`);
    if (bad) console.log('    残留样例:', JSON.stringify(r.residue.slice(0, 3)).slice(0, 240));
});
const leaked = rows.filter((r) => r.residue.length > 0).length;
console.log(`\n结论：8 次真 API 打标，标签被思维链污染 ${leaked} 次 / 共 8 次；原始回复含推理迹象 ${rows.filter((r) => r.hasCoT).length} 次`);

// ── 还原 ──
console.log('\n还原:', await ev(`(function(){var c=${C};var s=window.__snap;
  var card=(c.library.value||[]).find(function(x){return x.id===s.id;})||{};
  var arr=card.customTags||card.tags||[];
  for(var k=arr.length-1;k>=0;k--){ if(s.originTags.indexOf(arr[k])<0) arr.splice(k,1); }
  c.tagFunnel.value=s.funnel; c.tagCustomSegments.value=s.segs; if(c.tagPromptMode)c.tagPromptMode.value=s.mode; if(c.tagSkipTagged&&s.skip!==null)c.tagSkipTagged.value=s.skip; c.selectedIds.value=[];
  try{ if(c.refreshCardData) c.refreshCardData(); }catch(e){}
  var after=(c.library.value||[]).find(function(x){return x.id===s.id;})||{};
  return JSON.stringify({现标签:(after.customTags||after.tags||[]).length, 原标签:s.originTags.length, 一致:JSON.stringify(after.customTags||after.tags||[])===JSON.stringify(s.originTags)});})()`));
process.exit(0);
