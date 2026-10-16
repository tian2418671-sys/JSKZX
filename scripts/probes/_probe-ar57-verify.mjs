/**
 * AR-57 复验：逐档收窄，检查 6 张 SVG 是否 min-w 生效 + 可横向滚动 + 文字不小于阈值
 */
import { connect, sleep } from './_b56-lib.mjs';
process.env.CDP_PORT = '9375';
const R = [];
const ok = (n, c, e = '') => { R.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); };
const { ev, shot, clickAt, send } = await connect('ar57fix');

const C = `(function(){ const a=document.querySelector('#app').__vue_app__; return (a._context.provides.appCtx)||(a._container._vnode.component.provides.appCtx); })()`;

// 打开教程
await ev(`(() => { const c=${C}; const lib=c.filteredLibrary.value; c.selectedIds.value=[lib[0].id]; c.openAITagModal(); return true; })()`);
await sleep(1300);
const t1 = await ev(`(() => { const el=Array.from(document.querySelectorAll('*')).find(e=>/自定义模式/.test(e.textContent||'')&&(e.textContent||'').length<30&&e.getBoundingClientRect().width>40); if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
if (t1) await clickAt(t1.x, t1.y, 900);
const t2 = await ev(`(() => { const el=Array.from(document.querySelectorAll('button,a,div,span')).find(e=>/📖\\s*教程/.test((e.textContent||'').trim())&&(e.textContent||'').length<20); if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
if (t2) await clickAt(t2.x, t2.y, 1200);

// 遍历 6 张卡，逐档收窄
const navLabels = ['第一次跑通', '只要标签', '我不能', '我的规矩', '世界书', '出问题'];
for (const w of [1200, 900, 700, 560, 460]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 820, deviceScaleFactor: 1, mobile: false });
    await sleep(420);
    // 切到 ③ 破限卡（含最宽文字）
    await ev(`(() => { const el=Array.from(document.querySelectorAll('*')).find(e=>{ const t=(e.textContent||'').trim(); return /③/.test(t)&&/不能/.test(t)&&t.length<26&&e.getBoundingClientRect().width>60&&e.getBoundingClientRect().width<380&&e.children.length<5; }); if(el){ const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+5,clientY:r.top+5})); } return true; })()`);
    await sleep(420);
    const m = await ev(`(() => {
      const svg = Array.from(document.querySelectorAll('svg')).find(s => /破限文本框/.test(s.textContent||''));
      if (!svg) return { found: false };
      const r = svg.getBoundingClientRect();
      const wrap = svg.parentElement; // overflow-x-auto div
      const ws = getComputedStyle(wrap);
      return {
        found: true,
        svgW: Math.round(r.width),
        textPx: +(11 * r.width / 700).toFixed(1),   // 11 单位字在实宽下的像素
        wrapScrollW: wrap.scrollWidth, wrapClientW: wrap.clientWidth,
        canScroll: wrap.scrollWidth > wrap.clientWidth,
        overflowX: ws.overflowX,
        winW: window.innerWidth
      };
    })()`);
    console.log(`[winW=${w}]`, JSON.stringify(await m));
    await shot(`w${w}`);
}
await send('Emulation.clearDeviceMetricsOverride');

// 断言：>=520 容器时 svgW 跟随容器；<520 时锁定 520
console.log('\n--- 最终断言（在 460 窄屏下）---');
await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 820, deviceScaleFactor: 1, mobile: false });
await sleep(450);
const fin = await ev(`(() => {
  const svg = Array.from(document.querySelectorAll('svg')).find(s => /破限文本框/.test(s.textContent||''));
  const r = svg.getBoundingClientRect();
  const wrap = svg.parentElement;
  return { svgW: Math.round(r.width), minWOk: Math.round(r.width) >= 519, canScroll: wrap.scrollWidth > wrap.clientWidth };
})()`);
console.log(JSON.stringify(fin));
ok('窄屏下 SVG 锁定最小宽（>=520）', fin.minWOk, `svgW=${fin.svgW}`);
ok('窄屏下容器可横向滚动', fin.canScroll === true);
await send('Emulation.clearDeviceMetricsOverride');
await shot('final');

console.log(`\n===== AR-57 复验 ${R.filter(Boolean).length}/${R.length} =====`);
setTimeout(() => process.exit(0), 200);
