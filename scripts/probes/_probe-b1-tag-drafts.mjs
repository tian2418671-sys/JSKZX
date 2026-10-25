const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("t")),30000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ck=(n,ok,info)=>{if(ok){pass++;console.log("PASS "+n+(info?"  "+info:""))}else{fail++;console.log("FAIL "+n+"  "+(info||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");
const ev=async(e)=>{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return {__exc:JSON.stringify(r.exceptionDetails).slice(0,400)};return r.result.value};
await sleep(3000);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/自动分组/.test(x.textContent||''));b&&b.click();return 1})()`);
await sleep(1300);
ck("B1 区块", await ev(`/从高频标签生成草稿/.test(document.body.innerText||'')`)===true);
ck("门槛滑杆存在", await ev(`!!document.querySelector('input[type=range]')`)===true);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/生成草稿/.test(x.textContent||''));b&&b.click();return 1})()`);
await sleep(1300);
const t1=await ev(`(()=>{const t=document.body.innerText||'';const m=t.match(/共 (\\d+) 条候选/);return m?+m[1]:-1})()`);
console.log("默认门槛下候选数:",t1);
// 调低门槛到 2 再生成
await ev(`(()=>{const r=document.querySelector('input[type=range]');if(!r)return 0;r.value=2;r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
await sleep(500);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/生成草稿/.test(x.textContent||''));b&&b.click();return 1})()`);
await sleep(1300);
const t2=await ev(`(()=>{const t=document.body.innerText||'';const m=t.match(/共 (\\d+) 条候选/);return m?+m[1]:-1})()`);
console.log("门槛=2 时候选数:",t2);
ck("调低门槛后能出草稿", t2>0, "count="+t2);
ck("出现勾选列表", await ev(`document.querySelectorAll('input[type=checkbox][class*="accent-emerald"]').length`) > 0);
ck("出现并入按钮", await ev(`/并入规则/.test(document.body.innerText||'')`)===true);
// 并入
const before=await ev(`document.querySelectorAll('select').length`);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/并入规则/.test(x.textContent||''));b&&b.click();return 1})()`);
await sleep(800);
const after=await ev(`document.querySelectorAll('select').length`);
ck("并入后规则行增加", after>before, before+" -> "+after);
console.log(`\n=== ${pass}/${pass+fail} ===`);
ws.close();process.exit(fail?1:0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
