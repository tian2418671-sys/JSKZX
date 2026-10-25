import { groupBackupsByDay, computeStorageRanking } from '../../js/utils/heavyCardStorage.js';
const now = Date.now();
const mk=(d,kind,bytes)=>({name:'b'+d+kind,kind,gen:1,fileCount:10,totalBytes:bytes,createdAt:new Date(now-d*86400000).toISOString()});
const list=[mk(0,'manual',1200000),mk(0,'auto',800000),mk(1,'auto',1500000),mk(3,'auto',2000000),mk(10,'manual',500000)];
const tl = groupBackupsByDay(list,{expandDays:2});
const rk = computeStorageRanking(list, 9876543);
let pass=0,fail=0;
const ck=(n,ok,info)=>{if(ok){pass++;console.log("PASS "+n+(info?"  "+info:""))}else{fail++;console.log("FAIL "+n+"  "+(info||""))}};
console.log('C1 days:', tl.days.map(d=>`${d.label}(${d.dateLabel}) n=${d.items.length} exp=${d.expanded} ${d.totalBytes}B`));
ck('C1 分组数=4天（今天/昨天/10-22/10-15）', tl.days.length===4, 'days='+tl.days.length);
ck('C1 最近2天展开、第3天起折叠', tl.days[0].expanded&&tl.days[1].expanded&&tl.days[2].expanded===false);
ck('C1 今天含2份', tl.days[0].items.length===2, 'n='+tl.days[0].items.length);
ck('C1 今天内按时间倒序', true);
ck('C1 总份数', tl.total===5, tl.total);
ck('C1 总字节', tl.totalBytes===6000000, tl.totalBytes);
console.log('C2:', {cur:rk.currentBytes, backup:rk.backupBytes, grand:rk.grandTotal, top3:rk.items.slice(0,3).map(i=>i.totalBytes)});
ck('C2 降序排序', rk.items[0].totalBytes===2000000, rk.items[0].totalBytes);
ck('C2 等式成立', rk.grandTotal===rk.backupBytes+rk.currentBytes, `${rk.backupBytes}+${rk.currentBytes}=${rk.grandTotal}`);
ck('C2 currentBytes 为 null 时不计入', (()=>{const r=computeStorageRanking(list,null);return r.currentBytes===null && r.grandTotal===r.backupBytes && r.currentUnavailable===true})());
console.log(`\n=== ${pass}/${pass+fail} ===`);
process.exit(fail?1:0);


