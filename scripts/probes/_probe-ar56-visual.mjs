/**
 * AR-56 视觉取证：打开教程 → ③ 破限卡 → 截图「照抄 · 轻量版 / 强硬版」区域
 */
import { connect, sleep } from './_b56-lib.mjs';
process.env.CDP_PORT = '9375';
const { ev, shot, clickAt } = await connect('ar56v');

const C = `(function(){ const a=document.querySelector('#app').__vue_app__; return (a._context.provides.appCtx)||(a._container._vnode.component.provides.appCtx); })()`;

// 打开打标弹窗（选一张卡）
await ev(`(() => { const c=${C}; const lib=c.filteredLibrary.value; c.selectedIds.value=[lib[0].id]; c.openAITagModal(); return true; })()`);
await sleep(1300);

// 切「自定义模式（实验）」
const t1 = await ev(`(() => { const el=Array.from(document.querySelectorAll('*')).find(e=>/自定义模式/.test(e.textContent||'')&&(e.textContent||'').length<30&&e.getBoundingClientRect().width>40); if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
if (t1) await clickAt(t1.x, t1.y, 900);

// 点「📖 教程」
const t2 = await ev(`(() => { const el=Array.from(document.querySelectorAll('button,a,div,span')).find(e=>/📖\\s*教程|^教程/.test((e.textContent||'').trim())&&(e.textContent||'').length<20&&e.getBoundingClientRect().width>30); if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
if (t2) await clickAt(t2.x, t2.y, 1200);

// 点「③ 它老说「我不能」」
const t3 = await ev(`(() => { const el=Array.from(document.querySelectorAll('*')).find(e=>{ const t=(e.textContent||'').trim(); return /③/.test(t)&&/不能/.test(t)&&t.length<26&&e.getBoundingClientRect().width>60&&e.getBoundingClientRect().width<360&&e.children.length<5; }); if(!el)return null; const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+5,clientY:r.top+5})); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:(el.textContent||'').trim()}; })()`);
console.log('③ 卡片:', JSON.stringify(await t3));
await sleep(700);
await shot('jailbreak-card');

// 读那个区域的实际文本
const txt = await ev(`(() => {
  const el = Array.from(document.querySelectorAll('div')).find(e => /照抄 · 轻量版/.test(e.textContent||'') && (e.textContent||'').length < 900);
  return el ? (el.innerText||'') : '(未找到)';
})()`);
console.log('\n=== 「照抄 · 轻量版」区域实际文本 ===');
console.log(txt);
setTimeout(() => process.exit(0), 200);
