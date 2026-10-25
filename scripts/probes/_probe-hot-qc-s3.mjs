const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("TO")),240000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ck=(n,ok,i)=>{if(ok){pass++;console.log("PASS "+n+(i?"  "+i:""))}else{fail++;console.log("FAIL "+n+"  "+(i||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");
const ev=async(e)=>{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return null;return r.result.value};
const waitFor=async(e,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(await ev(e))return true;await sleep(400)}return false};
await sleep(1200);
// 关掉最上层（查重）弹窗
for(let i=0;i<4;i++){
  const n=await ev('document.querySelectorAll(".fixed.inset-0").length');
  if(n===0)break;
  await ev('(function(){var ms=Array.from(document.querySelectorAll(".fixed.inset-0")).sort(function(a,b){return (+getComputedStyle(b).zIndex||0)-(+getComputedStyle(a).zIndex||0)});var top=ms[0];var b=Array.from(top.querySelectorAll("button")).find(function(x){var t=(x.textContent||"").trim();return t==="✕"||/✕ 关闭/.test(t)});if(b){b.click();return 1}return 0})()');
  await sleep(800);
}
console.log("清理后弹窗数:",await ev('document.querySelectorAll(".fixed.inset-0").length'));
// 重开质检
await ev('(function(){var b=Array.from(document.querySelectorAll("button")).find(function(x){return x.offsetParent!==null&&/维护\\(W\\)/.test(x.textContent||"")});if(b){b.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true}));b.click();return 1}return 0})()');
await sleep(800);
await ev('(function(){var b=Array.from(document.querySelectorAll("button.command-item")).find(function(x){return /一键质检/.test(x.textContent||"")});if(b)b.click();return 1})()');
await sleep(1500);
ck("质检弹窗打开", (await ev('document.querySelectorAll(".fixed.inset-0").length'))===1);
// 只保留「标签分析」，取消其它（含查重，避免弹出查重窗打断）
const un=await ev('(function(){var m=document.querySelector(".fixed.inset-0");if(!m)return "no";var labs=Array.from(m.querySelectorAll("label"));var out=[];labs.forEach(function(l){var t=(l.textContent||"");var cb=l.querySelector("input[type=checkbox]");if(!cb)return;var want=/标签分析/.test(t);if(!want&&/刷新卡库|查重扫描|卡片质量巡检|世界书词条/.test(t)&&cb.checked){cb.click();out.push("off:"+t.slice(0,6))}if(want&&!cb.checked){cb.click();out.push("on:标签分析")}});return out.join(",")||"nochange"})()');
console.log("勾选调整:",un);
await sleep(600);
const start=await ev('(function(){var m=document.querySelector(".fixed.inset-0");var b=Array.from(m.querySelectorAll("button")).find(function(x){return /开始质检/.test(x.textContent||"")});if(!b)return "nf";b.click();return "ok"})()');
console.log("点开始:",start);
const done=await waitFor('(function(){var m=document.querySelector(".fixed.inset-0");if(!m)return false;return /已完成|已结束|耗时/.test(m.innerText||"")})()',90000);
ck("标签分析跑完", done, await ev('(function(){var m=document.querySelector(".fixed.inset-0");var t=m?m.innerText:"";var r=t.match(/已完成[^\\n]{0,30}|耗时[^\\n]{0,20}/);return r?r[0]:""})()'));
await sleep(1500);
await ev('(function(){var m=document.querySelector(".fixed.inset-0");var b=Array.from(m.querySelectorAll("button")).find(function(x){return /结构画像/.test(x.textContent||"")});if(b)b.click();return 1})()');
await sleep(1800);
const por=await ev('(function(){var m=document.querySelector(".fixed.inset-0");return m?m.innerText:""})()');
console.log("画像关键行:",(por.match(/全库 \d+ 标签 \/ \d+ 分组/)||['(无)'])[0]);
ck("矩阵渲染", /全库 \d+ 标签/.test(por));
const cells=await ev('document.querySelectorAll(".fixed.inset-0 table td").length');
console.log("矩阵单元格:",cells);
ck("矩阵有单元格", cells>0);
ck("池健康度", /池内从未使用|已用但不在池内/.test(por), (por.match(/池内从未使用[：:]?\s*\d+\s*\/\s*\d+/)||[''])[0]);
ck("Token 分位", /P50/.test(por));
console.log("\n===== "+pass+"/"+(pass+fail)+" =====");
ws.close();process.exit(0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
