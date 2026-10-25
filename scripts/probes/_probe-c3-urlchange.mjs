import { compareOrigins } from '../../js/utils/heavyCardStorage.js';
let pass=0,fail=0;
const ck=(n,ok,info)=>{if(ok){pass++;console.log("PASS "+n+(info?"  "+info:""))}else{fail++;console.log("FAIL "+n+"  "+(info||""))}};
const cases=[
  ['同域名换路径 -> same', 'https://a.com/x/index.html','https://a.com/y/index.html','same'],
  ['跨域名 -> cross', 'https://a.com/x/','https://b.com/x/','cross'],
  ['同域名换端口 -> cross', 'https://a.com:443/x/','https://a.com:8443/x/','cross'],
  ['本地目录变更 -> local', 'heavycard-local://c1/index.html','heavycard-local://c2/index.html','local'],
  ['远程转本地 -> unknown', 'https://a.com/','heavycard-local://c1/index.html','unknown'],
];
for(const [name,o,n,exp] of cases){
  const r=compareOrigins(o,n);
  ck(name, r.verdict===exp, 'got='+r.verdict+' msg='+String(r.message).slice(0,40));
}
console.log(`\n=== ${pass}/${pass+fail} ===`);
process.exit(fail?1:0);
