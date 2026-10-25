import { buildPortrait } from '../../js/utils/libraryPortrait.js';
import { draftProfilesFromTags, defaultMinCards } from '../../js/utils/autoGroup.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// 模拟 11,667 张卡的标签分布（真实口径：每卡 3~6 个标签，长尾分布）
const ROOT='I:\\03\\角色色卡';
let files=[];
const walk=(d,depth)=>{ if(depth>3) return; let es; try{es=readdirSync(d,{withFileTypes:true})}catch(_){return}
  for(const e of es){ const p=join(d,e.name); if(e.isDirectory()) walk(p,depth+1); else if(/\.(png|json|webp)$/i.test(e.name)) files.push(p); } };
walk(ROOT,0);
console.log('大库卡片数:', files.length);

// 构造真实感数据：从文件名派生稳定标签（避免读 11k 个 PNG）
const TAGS=['Female (女性)','Male (男性)','Elf (精灵)','Demon (恶魔)','Fantasy','Sci-Fi','Romance','Anime','NTR','纯爱','病娇','傲娇','校园','奇幻','都市','科幻','NTR向','长尾A','长尾B'];
const tagCounts=new Map();
const library=[];
for(let i=0;i<files.length;i++){
  const f=files[i];
  const n = 3 + (i%4);   // 3~6 个
  const tags=[];
  for(let k=0;k<n;k++){
    // 前 6 个是高频（覆盖大量卡），后面是长尾（覆盖少）
    const idx = k<2 ? (i+k)%6 : (i*7+k)%TAGS.length;
    tags.push(TAGS[idx]);
  }
  for(const t of tags) tagCounts.set(t,(tagCounts.get(t)||0)+1);
  library.push({ id:'c'+i, name:basename(f), tags, category:'G'+(i%8), path:f });
}
const commonTags=TAGS.slice(0,6);   // 池内 = 6 个高频基础标签
const t0=performance.now();
const portrait=buildPortrait(library, { tagStats: { tagCounts }, commonTags });
const t1=performance.now();
const total=library.length;
const t2=performance.now();
const drafts=draftProfilesFromTags(tagCounts, [], { total, commonTags, maxDrafts:20 });
const t3=performance.now();

console.log(`buildPortrait: ${(t1-t0).toFixed(1)}ms`);
console.log(`draftProfilesFromTags: ${(t3-t2).toFixed(1)}ms`);
console.log('画像矩阵行数(tags):', portrait.matrix?.rows?.length ?? 'n/a');
console.log('标签总数:', tagCounts.size, ' 池内:', commonTags.length);
console.log('草稿数:', drafts.drafts.length, ' 门槛:', drafts.effectiveMinCards);
console.log('池内被过滤:', drafts.filtered.inPool.length, ' 卡数不足:', drafts.filtered.belowMinCards);
if((t1-t0)<3000 && (t3-t2)<500) console.log('✅ 性能达标'); else console.log('⚠️ 性能偏高');




