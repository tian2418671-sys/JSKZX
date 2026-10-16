/** Esc 修复复测（纯 state 判定，不依赖不可靠的 DOM z-[100] 检测） */
import { connect, CTX, sleep } from './_b56-lib.mjs';
const { ev, shot, send } = await connect('hot1g');
const st = async () => JSON.parse(String(await ev(`(function(){var c=${CTX};
  var cm=(c.contextMenu&&c.contextMenu.value)||{}; var wb=(c.wbContextMenu&&c.wbContextMenu.value)||{};
  return JSON.stringify({card:!!cm.visible, wb:!!wb.show});})()`)));
const esc1 = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(500); };
const rc = async (idx) => {
    const p = JSON.parse(String(await ev(`(function(){var cards=Array.prototype.slice.call(document.querySelectorAll('[class*="cursor-pointer"][class*="group"]'));if(!cards[${idx}])return '{}';var el=cards[${idx}];var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`)));
    if (!p.x) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await sleep(600); return true;
};
await ev(`(function(){var c=${CTX};c.appMode.value='characters';c.closeContextMenu&&c.closeContextMenu();c.closeWbContextMenu&&c.closeWbContextMenu();return 1;})()`); await sleep(400);
console.log('起始 state:', JSON.stringify(await st()));

// ① 右键开
await rc(0);
const s1 = await st();
console.log(`① 右键 → ${JSON.stringify(s1)}  ${s1.card ? '✅ 菜单打开' : '❌'}`);
await shot('hot1g-1');

// ② Esc（单次）关
await esc1();
const s2 = await st();
console.log(`② 按 1 次 Esc → ${JSON.stringify(s2)}  ${!s2.card ? '✅ 已关（修复生效）' : '❌ 仍开'}`);

// ③ 再开 → 点外部关
await rc(1);
const s3 = await st();
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1150, y: 380, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1150, y: 380, button: 'left', clickCount: 1 });
await sleep(600);
const s4 = await st();
console.log(`③ 右键 → 点外部 → 开时=${s3.card} 关后=${s4.card}  ${s3.card && !s4.card ? '✅ 点外部可关' : '❌'}`);

// ④ 互斥：连续右键两张
await rc(0); const a = await st();
await rc(1); const b = await st();
console.log(`④ 连续右键两张 → ${a.card} / ${b.card}  ${a.card && b.card ? '✅ 始终单菜单（互斥）' : '⚠️'}`);

console.log('\n=== 判定 ===');
console.log(`右键能开: ${s1.card ? '✅' : '❌'}｜Esc 可关: ${!s2.card ? '✅' : '❌'}｜点外部可关: ${!s4.card ? '✅' : '❌'}｜互斥: ${a.card && b.card ? '✅' : '⚠️'}`);
await esc1();
process.exit(0);
