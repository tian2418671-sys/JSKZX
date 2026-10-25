const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("t")),120000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ck=(n,ok,info)=>{if(ok){pass++;console.log("PASS "+n+(info?"  "+info:""))}else{fail++;console.log("FAIL "+n+"  "+(info||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");
const ev=async(e)=>{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return {__exc:JSON.stringify(r.exceptionDetails).slice(0,400)};return r.result.value};
await sleep(2000);
const base='H:\\01\\全局世界书\\_g4test\\';
const res=await ev(`window.electronAPI.fetchWorldbookMeta(${JSON.stringify([base+'fake1.json',base+'fake2.json',base+'fake3.json'])}).then(r=>JSON.stringify(r))`);
let arr=[]; try{arr=JSON.parse(res).data||[]}catch(_){}
console.log("返回条数:",arr.length);
ck("返回 3 条",arr.length===3,"len="+arr.length);
for(const it of arr){
  const nm=(it.path||'').split(/[\\/]/).pop();
  console.log(`  ${nm}: valid=${it.valid} reason=${it.reason||'(无)'}`);
  if(it.valid===false) ck(`${nm} 带 reason`,!!it.reason, it.reason||'');
}
ck("合法世界书 fake3 通过", arr.some(x=>x.valid===true));
console.log(`\n=== ${pass}/${pass+fail} ===`);
ws.close();process.exit(fail?1:0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
