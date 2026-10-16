/**
 * v2.4.1 打包版自测（隔离库，CDP 9382）：验证本轮 3 处修复在包里生效
 */
import { connect, sleep } from './_b56-lib.mjs';
process.env.CDP_PORT = '9382';
const R = [];
const ok = (n, c, e = '') => { R.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); };
const { ev, shot, clickAt, send } = await connect('smoke241');
const C = `(function(){ const a=document.querySelector('#app').__vue_app__; return (a._context.provides.appCtx)||(a._container._vnode.component.provides.appCtx); })()`;

ok('主界面渲染', (await ev(`document.querySelector('#app').innerHTML.length`)) > 5000);
ok('#bug-1 accept', (await ev(`Array.from(document.querySelectorAll('input[type=file]')).map(i=>i.getAttribute('accept'))`)).some((a) => a && a.includes('.png')));

// 开教程
await ev(`(() => { const c=${C}; const lib=c.filteredLibrary.value; c.selectedIds.value=[lib[0].id]; c.openAITagModal(); return true; })()`);
await sleep(1300);
const t1 = await ev(`(() => { const el=Array.from(document.querySelectorAll('*')).find(e=>/自定义模式/.test(e.textContent||'')&&(e.textContent||'').length<30&&e.getBoundingClientRect().width>40); if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
if (t1) await clickAt(t1.x, t1.y, 900);
const t2 = await ev(`(() => { const el=Array.from(document.querySelectorAll('button,a,div,span')).find(e=>/📖\\s*教程/.test((e.textContent||'').trim())&&(e.textContent||'').length<20); if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
if (t2) await clickAt(t2.x, t2.y, 1200);
await shot('01-guide');

// AR-56 复制框
let all = [];
for (const key of ['跑通', '只要标签', '不能', '规矩', '世界书']) {
    await ev(`(() => { const el=Array.from(document.querySelectorAll('*')).find(e=>{ const t=(e.textContent||'').trim(); return t.includes('${key}') && t.length<26 && e.getBoundingClientRect().width>60 && e.getBoundingClientRect().width<380 && e.children.length<5; }); if(el){ const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+5,clientY:r.top+5})); } return true; })()`);
    await sleep(420);
    const pres = await ev(`Array.from(document.querySelectorAll('pre')).filter(p=>p.className.includes('whitespace-pre-wrap')).map(p=>(p.innerText||'').slice(0,50))`);
    all = all.concat(pres || []);
}
const filled = all.filter((t) => t && t.trim()).length;
ok(`AR-56 复制框非空（${filled}/${all.length}）`, all.length > 0 && filled === all.length);

// AR-57 窄屏
await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 820, deviceScaleFactor: 1, mobile: false });
await sleep(450);
const narrow = await ev(`(() => { const s=Array.from(document.querySelectorAll('svg')).find(x=>/破限文本框|打标窗/.test(x.textContent||'')); if(!s) return {found:false}; const r=s.getBoundingClientRect(); const w=s.parentElement; return { found:true, svgW:Math.round(r.width), canScroll: w.scrollWidth>w.clientWidth }; })()`);
ok('AR-57 窄屏 SVG 锁定 ≥520 且可横滚', narrow.found && narrow.svgW >= 519 && narrow.canScroll, JSON.stringify(narrow));
await shot('02-narrow');
await send('Emulation.clearDeviceMetricsOverride');

console.log(`\n===== v2.4.1 装包自测 ${R.filter(Boolean).length}/${R.length} =====`);
setTimeout(() => process.exit(0), 200);
