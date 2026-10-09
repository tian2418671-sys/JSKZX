/**
 * 临时：三主题 × 打标弹窗关键块 —— 真实计算样式 + 对比度（**逐层合成**半透明背景）
 * 用法：node scripts/probes/_tmp-theme-measure.mjs   （CDP 端口用 CDP_PORT 或 9375）
 * 会依次把 html[data-theme] 切到 slate / dark / light 各测一遍，最后**恢复原主题**。
 */
const PORT = Number(process.env.CDP_PORT || 9375);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const sock = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { sock.onopen = r; });
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(function(){
  function parse(c){
    var m = String(c).match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    var p = m[1].split(',').map(function(x){return parseFloat(x);});
    return { r:p[0], g:p[1], b:p[2], a: p.length>3 ? p[3] : 1 };
  }
  function lum(rgb){
    var f = [rgb.r, rgb.g, rgb.b].map(function(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2];
  }
  function ratio(a,b){ var hi=Math.max(a,b), lo=Math.min(a,b); return Math.round(((hi+0.05)/(lo+0.05))*100)/100; }
  /** 逐层合成：从 body 起累加到目标元素自己的背景（含 alpha） */
  function composite(el){
    var chain = [], e = el;
    while (e && e !== document.documentElement) { chain.unshift(e); e = e.parentElement; }
    var base = parse(getComputedStyle(document.body).backgroundColor) || { r:15,g:23,b:42,a:1 };
    var acc = { r: base.r, g: base.g, b: base.b };
    for (var i=0;i<chain.length;i++){
      var c = parse(getComputedStyle(chain[i]).backgroundColor);
      if (c && c.a > 0) acc = { r: c.r*c.a + acc.r*(1-c.a), g: c.g*c.a + acc.g*(1-c.a), b: c.b*c.a + acc.b*(1-c.a) };
    }
    return acc;
  }
  function probe(marker){
    var all = Array.prototype.slice.call(document.querySelectorAll('div,p,span,label,button'));
    var el = all.filter(function(e){ return (e.textContent||'').indexOf(marker) >= 0 && e.children.length <= 6; }).pop();
    if (!el) return { marker: marker, found: false };
    var cs = getComputedStyle(el);
    var fg = parse(cs.color) || { r:0,g:0,b:0,a:1 };
    var bg = composite(el);
    return {
      marker: marker, found: true,
      fg: 'rgb(' + Math.round(fg.r) + ',' + Math.round(fg.g) + ',' + Math.round(fg.b) + ')',
      bgEff: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      contrast: ratio(lum(bg), lum(fg))
    };
  }
  return [
    probe('材料占位符'),
    probe('程序材料自动附加'),
    probe('世界书专用 System'),
    probe('没有任何段'),
    probe('每段可独立选择角色与顺序'),
    probe('每段可独立选择角色与顺序'.slice(0,4)),
    probe('已修改'),
    probe('程序自动生成')
  ];
})()`;

const MARKERS = ['材料占位符', '程序材料自动附加', '世界书专用 System', '没有任何段', '每段可独立选择', '已修改', '程序自动生成'];
const orig = await ev('document.documentElement.getAttribute("data-theme")');
console.log(`原主题 = ${orig}\n`);
const rows = {};
for (const theme of ['slate', 'dark', 'light']) {
    await ev(`document.documentElement.setAttribute('data-theme','${theme}')`);
    await sleep(350);
    const res = await ev(`(function(){ var r = ${MEASURE}; return r; })()`);
    rows[theme] = res;
}
await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(orig)})`); // 恢复
await sleep(200);
console.log('marker'.padEnd(22) + ['slate', 'dark', 'light'].map((t) => t.padStart(18)).join(''));
for (const mk of MARKERS) {
    const cells = ['slate', 'dark', 'light'].map((t) => {
        const hit = (rows[t] || []).find((r) => r && r.found && r.marker.indexOf(mk) >= 0);
        return hit ? `${String(hit.contrast).padStart(6)} ${hit.fg}` : '     (未找到)';
    });
    console.log(mk.padEnd(22) + cells.map((c) => c.padStart(18)).join(''));
}
console.log('\n（对比度 = 前景文字 vs **逐层合成后**的实际底色；AA 正文要求 ≥4.5，大字/次要信息 ≥3）');
process.exit(0);
