const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("TO")),120000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const bugs=[];
const ck=(n,ok,i)=>{if(ok){pass++;console.log("PASS "+n+(i?"  "+i:""))}else{fail++;bugs.push(n+(i?" -- "+i:""));console.log("FAIL "+n+"  "+(i||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");
const errs=[];ws.addEventListener("message",e=>{const d=JSON.parse(e.data);if(d.method==="Runtime.exceptionThrown")errs.push((d.params.exceptionDetails.exception?.description||'').slice(0,150))});
const ev=async(e)=>{try{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return null;return r.result.value}catch(x){return null}};
const waitFor=async(expr,ms=6000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(await ev(expr))return true;await sleep(180)}return false};
const menu=(l)=>ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.offsetParent!==null&&${JSON.stringify(l)}===(x.textContent||'').trim());if(!b)return 0;b.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));b.click();return 1})()`);
const item=(re)=>ev(`(()=>{const b=Array.from(document.querySelectorAll('button.command-item')).find(x=>x.offsetParent!==null&&${re}.test(x.textContent||''));if(!b)return 0;b.click();return 1})()`);
const inModal=(re)=>ev(`(()=>{const m=Array.from(document.querySelectorAll('.fixed.inset-0')).sort((a,b)=>(+getComputedStyle(b).zIndex||0)-(+getComputedStyle(a).zIndex||0))[0];if(!m)return 0;const b=Array.from(m.querySelectorAll('button')).find(x=>${re}.test(x.textContent||''));if(!b)return 0;b.click();return 1})()`);
const bodyText=()=>ev('document.body.innerText||""');
const modalText=()=>ev('(function(){var m=document.querySelector(".fixed.inset-0");return m?m.innerText:""})()');
await sleep(3500);

ck("页面可见(防节流)", (await ev('document.visibilityState'))==='visible');
ck("卡片 81 张", (await ev('(function(){var m=(document.body.innerText||"").match(/总计:\\s*(\\d+)/);return m?+m[1]:-1})()'))===81);
ck("世界书 35 本", await ev('Array.from(document.querySelectorAll("button")).some(function(b){return /世界书库（\\d+ 本）/.test(b.getAttribute("title")||"")})'));
ck("重型卡 7 个", await ev('Array.from(document.querySelectorAll("button")).some(function(b){return /独立前端角色卡（7 个）/.test(b.getAttribute("title")||"")})'));

// 质检
await menu('🔧 维护(W)');
ck("维护菜单含质检", await waitFor('Array.from(document.querySelectorAll("button.command-item")).some(function(x){return /一键质检/.test(x.textContent||"")})',3000));
await item('/一键质检/');
ck("质检弹窗打开", await waitFor('document.querySelectorAll(".fixed.inset-0").length===1',6000));
ck("三页签齐全", await waitFor('(function(){var m=document.querySelector(".fixed.inset-0");var t=m?m.innerText:"";return /巡检清单/.test(t)&&/结构画像/.test(t)&&/使用说明/.test(t)})()',3000));

await inModal('/使用说明/');
await waitFor('(function(){var m=document.querySelector(".fixed.inset-0");return m&&/一键质检是做什么的/.test(m.innerText||"")})()',4000);
var h=await modalText();
ck("说明页有内容", /一键质检是做什么的/.test(h));
ck("说明页无底部栏", !/建议先做整库冷备/.test(h));
ck("说明页无画像区块", !/全库 \d+ 标签/.test(h));
ck("说明页无S编号", !/S[1-5] /.test(h));

await inModal('/巡检清单/');
await waitFor('(function(){var m=document.querySelector(".fixed.inset-0");return m&&/刷新卡库数据/.test(m.innerText||"")})()',4000);
var l=await modalText();
ck("清单页五项齐全", ['刷新卡库数据','查重扫描','标签分析','卡片质量巡检','世界书词条体检'].every(function(x){return l.indexOf(x)>=0}));
ck("清单页无S编号", !/S[1-5] /.test(l));

await inModal('/结构画像/');
await waitFor('(function(){var m=document.querySelector(".fixed.inset-0");return m&&/① 标签/.test(m.innerText||"")})()',4000);
var pp=await modalText();
ck("画像页三区块", ['① 标签','② 标签池','③ Token'].every(function(x){return pp.indexOf(x)>=0}));
ck("画像页有底部栏", /复制报告/.test(pp));
await inModal('/✕ 关闭/');
ck("弹窗可关闭(AR-70)", await waitFor('document.querySelectorAll(".fixed.inset-0").length===0',6000));

// 自动分组
await menu('📁 分组(G)');
await sleep(600);
await item('/自动分组/');
ck("自动分组弹窗", await waitFor('/从高频标签生成草稿/.test(document.body.innerText||"")',7000));
await inModal('/生成草稿/');
ck("生成草稿有候选", await waitFor('/条候选/.test(document.body.innerText||"")',10000));
var n=await ev('(function(){var m=(document.body.innerText||"").match(/共 (\\d+) 条候选/);return m?+m[1]:-1})()');
console.log("   候选数: "+n);
await inModal('/✕ 关闭/');
ck("自动分组可关闭", await waitFor('document.querySelectorAll(".fixed.inset-0").length===0',6000));

// 世界书 / 重型卡
await ev('(function(){var b=Array.from(document.querySelectorAll("button")).find(function(x){return /世界书库（\\d+ 本）/.test(x.getAttribute("title")||"")});if(b)b.click();return 1})()');
ck("世界书模式切换", await waitFor('/世界书库/.test(document.body.innerText||"")',4000));
await ev('(function(){var b=Array.from(document.querySelectorAll("button")).find(function(x){return /独立前端角色卡/.test(x.getAttribute("title")||"")});if(b)b.click();return 1})()');
ck("重型卡工作区", await waitFor('/继续游玩|请选择一张|重新加载/.test(document.body.innerText||"")',4000));

ck("无未捕获异常", errs.length===0, errs[0]||'');
console.log("\n===== "+pass+"/"+(pass+fail)+" =====");
if(bugs.length){console.log("问题:");bugs.forEach(function(b){console.log("  - "+b)})}
ws.close();process.exit(0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
