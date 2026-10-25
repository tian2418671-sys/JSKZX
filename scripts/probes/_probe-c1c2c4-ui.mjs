const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("t")),90000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ck=(n,ok,info)=>{if(ok){pass++;console.log("PASS "+n+(info?"  "+info:""))}else{fail++;console.log("FAIL "+n+"  "+(info||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");
const errs=[]; ws.addEventListener("message",e=>{const d=JSON.parse(e.data);if(d.method==="Runtime.exceptionThrown")errs.push(JSON.stringify(d.params.exceptionDetails).slice(0,240))});
const ev=async(e)=>{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return {__exc:JSON.stringify(r.exceptionDetails).slice(0,300)};return r.result.value};
await sleep(4500);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/独立前端角色卡/.test(x.getAttribute('title')||''));if(b)b.click();return 1})()`);
await sleep(1500);
ck("C4 继续游玩", await ev(`/🎮 继续游玩/.test(document.body.innerText||'')`)===true);
// 点卡打开
const opened=await ev(`(()=>{const btns=Array.from(document.querySelectorAll('button')).filter(b=>/天前玩过|今天玩过|昨天玩过/.test(b.textContent||''));if(!btns.length)return 'nf';btns[0].click();return 'ok'})()`);
console.log("打开卡:",opened);
await sleep(7000);
ck("卡已打开（工具栏出现）", await ev(`/重新加载/.test(document.body.innerText||'')`)===true);
console.log("已打开后异常:",errs.length?errs.slice(0,1):"无");
if(await ev(`/重新加载/.test(document.body.innerText||'')`)){
  console.log("开备份面板:",await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/🕘/.test(x.textContent||''));if(!b)return 'nf';b.click();return 'ok'})()`));
  await sleep(2500);
  const t=await ev(`document.body.innerText||''`);
  ck("C1 时间线视图", /🕘 时间线/.test(t));
  ck("C2 占用视图按钮", /📊 占用/.test(t));
  console.log("面板:", await ev(`(()=>{const s=document.body.innerText||'';const i=s.indexOf('历史备份');return i<0?'nf':s.slice(i,i+380).replace(/\\n+/g,' | ')})()`));
  console.log("切占用:",await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/📊 占用/.test(x.textContent||''));if(!b)return 'nf';b.click();return 'ok'})()`));
  await sleep(900);
  const t2=await ev(`document.body.innerText||''`);
  ck("C2 总占用", /总占用/.test(t2));
  ck("C2 当前分区", /当前存档分区/.test(t2));
  console.log("占用:", await ev(`(()=>{const s=document.body.innerText||'';const i=s.indexOf('当前存档分区');return i<0?'nf':s.slice(i,i+260).replace(/\\n+/g,' | ')})()`));
}
console.log("最终异常:",errs.length?errs.slice(0,2):"无");
ck("无 JS 异常", errs.length===0);
console.log(`\n=== ${pass}/${pass+fail} ===`);
ws.close();process.exit(fail?1:0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
