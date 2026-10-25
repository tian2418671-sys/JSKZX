const PORT=9380;let seq=0;
const rpc=(ws,m,p={})=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>rej(new Error("t")),90000);const h=e=>{const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)}};ws.addEventListener("message",h);ws.send(JSON.stringify({id,method:m,params:p}))});
const fs=await import('node:fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ck=(n,ok,i)=>{if(ok){pass++;console.log("PASS "+n+(i?"  "+i:""))}else{fail++;console.log("FAIL "+n+"  "+(i||""))}};
(async()=>{
const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const page=list.find(t=>t.type==="page"&&/index\.html/.test(t.url))||list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await rpc(ws,"Runtime.enable");await rpc(ws,"Page.enable");
const ev=async(e)=>{const r=await rpc(ws,"Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return null;return r.result.value};
await sleep(3500);
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button,a')).find(x=>/一键质检/.test(x.textContent||''));if(b)b.click();return 1})()`);
await sleep(1200);
// --- 说明页 ---
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/使用说明/.test(x.textContent||''));if(b)b.click();return 1})()`);
await sleep(1000);
const t1=await ev(`document.body.innerText||''`);
ck("说明页有内容", /一键质检是做什么的/.test(t1));
ck("说明页无画像真实区块(已修)", !/全库 \d+ 标签/.test(t1));
ck("说明页无底部栏(已修)", !/建议先做整库冷备/.test(t1));
// 滚到底截图
await ev(`(()=>{const m=document.querySelector('.fixed.inset-0');const s=m&&m.querySelector('.overflow-y-auto');if(s)s.scrollTop=s.scrollHeight;return 1})()`);
await sleep(500);
const rect=await ev(`(()=>{const m=Array.from(document.querySelectorAll('.fixed.inset-0')).find(x=>/一键质检是做什么/.test(x.textContent||''));const inner=m&&(m.querySelector('.rounded-xl')||m);if(!inner)return null;const r=inner.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()`);
if(rect){const r=await rpc(ws,"Page.captureScreenshot",{format:"png",clip:{x:rect.x,y:rect.y,width:rect.w,height:rect.h,scale:1}});fs.writeFileSync(process.env.TEMP+'\\qc-final-help.png',Buffer.from(r.data,'base64'));console.log('说明页底部截图已存');}
// --- 画像页 ---
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/结构画像/.test(x.textContent||''));if(b)b.click();return 1})()`);
await sleep(1000);
const t2=await ev(`document.body.innerText||''`);
ck("画像页有矩阵区块", /① 标签 × 分组交叉矩阵/.test(t2));
ck("画像页无说明内容", !/一键质检是做什么的/.test(t2));
ck("画像页有底部栏", /复制报告/.test(t2));
// --- 清单页 ---
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/巡检清单/.test(x.textContent||''));if(b)b.click();return 1})()`);
await sleep(1000);
const t3=await ev(`document.body.innerText||''`);
ck("清单页有检查项", /刷新卡库数据/.test(t3));
ck("清单页无 S 编号", !/S[1-5] /.test(t3), (t3.match(/S[1-5]/g)||[]).join(',')||'无');
ck("清单页无画像真实区块", !/全库 \d+ 标签/.test(t3));
console.log(`\n=== ${pass}/${pass+fail} ===`);
ws.close();process.exit(fail?1:0)})().catch(e=>{console.error("ERR",e.message);process.exit(1)});

