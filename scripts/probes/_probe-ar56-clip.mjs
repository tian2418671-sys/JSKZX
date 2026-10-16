/**
 * AR-56 补充：验证「复制」按钮实际传给 copy() 的文本非空
 * （CDP 下 navigator.clipboard.readText() 常被拒 → 改为拦截 writeText 参数）
 */
import { connect, sleep } from './_b56-lib.mjs';
process.env.CDP_PORT = '9375';

const { ev, shot } = await connect('ar56b');

// 劫持 clipboard.writeText，记录写入内容
await ev(`(() => {
  window.__copied = [];
  try {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) => { window.__copied.push(String(t)); return orig(t).catch(()=>{}); };
  } catch (e) {}
  return true;
})()`);

// 逐一点击所有「📋 复制」按钮
const clicked = await ev(`(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => /📋 复制|✅ 已复制/.test(b.textContent||''));
  let n = 0;
  for (const b of btns) { b.click(); n++; }
  return n;
})()`);
await sleep(700);
await shot('clip');

const got = await ev(`JSON.stringify(window.__copied || [])`);
const arr = JSON.parse(got || '[]');
console.log(`点击了 ${clicked} 个复制按钮，捕获到 ${arr.length} 次写入`);
arr.forEach((t, i) => console.log(`  [${i + 1}] len=${t.length}  首 40 字: ${JSON.stringify(t.slice(0, 40))}`));
const allNonEmpty = arr.length > 0 && arr.every((t) => t && t.trim().length > 0);
console.log(allNonEmpty ? '\n✅ 全部复制内容非空' : '\n❌ 存在空内容');
setTimeout(() => process.exit(allNonEmpty ? 0 : 1), 200);
