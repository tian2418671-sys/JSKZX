const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("t")),240000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ck=(n,ok,info)=>{if(ok){pass++;console.log("PASS "+n+(info?"  "+info:""))}else{fail++;console.log("FAIL "+n+"  "+(info||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");
const ev=async(e)=>{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return {__exc:JSON.stringify(r.exceptionDetails).slice(0,400)};return r.result.value};
await sleep(7000);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/世界书库（\\d+ 本）/.test(x.getAttribute('title')||''));if(b)b.click();return 1})()`);
await sleep(2500);
const has=await ev(`/已排除 \\d+ 个非世界书文件/.test(document.body.innerText||'')`);
ck("G4 提示条出现", has===true);
if(has){
  const n=await ev(`(()=>{const m=(document.body.innerText||'').match(/已排除 (\\d+) 个非世界书文件/);return m?+m[1]:-1})()`);
  console.log("剔除数量:",n);
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/看原因/.test(x.textContent||''));if(b)b.click();return 1})()`);
  await sleep(700);
  const det=await ev(`(()=>{const t=document.body.innerText||'';const i=t.indexOf('已排除');return i<0?'nf':t.slice(i,i+900).replace(/\\n+/g,' | ')})()`);
  console.log("详情:",String(det).slice(0,750));
  ck("展开显示原因",/结构校验未通过|JSON 解析失败|此前已判定/.test(String(det)));
}
console.log(`\n=== ${pass}/${pass+fail} ===`);
ws.close();process.exit(fail?1:0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
