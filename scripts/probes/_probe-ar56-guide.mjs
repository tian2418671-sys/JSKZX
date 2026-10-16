/**
 * AR-56 复验：打标教程「照抄这一整行」复制框内容
 * 只读 + 剪贴板验证；不写任何库文件。
 */
import { connect, sleep } from './_b56-lib.mjs';
process.env.CDP_PORT = '9375';

const R = [];
const ok = (n, c, e = '') => { R.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); };
const { ev, shot, clickAt } = await connect('ar56');

const C = `(function(){ const a=document.querySelector('#app').__vue_app__; return (a._context.provides.appCtx)||(a._container._vnode.component.provides.appCtx); })()`;

// 1) 打开 AI 打标弹窗（需先选卡）
const opened = await ev(`(() => {
  const c = ${C};
  const lib = c.filteredLibrary && c.filteredLibrary.value;
  if (lib && lib.length) c.selectedIds.value = [lib[0].id];
  c.openAITagModal();
  return { show: c.showAITagModal && c.showAITagModal.value };
})()`);
ok('打标弹窗已打开', opened && opened.show === true, JSON.stringify(opened));
await sleep(1200);

// 2) 切到「自定义模式（实验）」→ 打开图文教程
const toCustom = await ev(`(() => {
  const el = Array.from(document.querySelectorAll('*')).find(e => /自定义模式/.test(e.textContent||'') && (e.textContent||'').length < 30 && e.getBoundingClientRect().width > 40);
  if (!el) return null; const r = el.getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), t: (el.textContent||'').trim() };
})()`);
console.log('   自定义模式入口:', JSON.stringify(await toCustom));
if (toCustom && toCustom.x) { await clickAt(toCustom.x, toCustom.y, 900); }

// 3) 找「教程」按钮
const guide = await ev(`(() => {
  const el = Array.from(document.querySelectorAll('button, a, div, span')).find(e => /教程/.test(e.textContent||'') && (e.textContent||'').length < 20 && e.getBoundingClientRect().width > 30);
  if (!el) return null; const r = el.getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), t: (el.textContent||'').trim() };
})()`);
console.log('   教程入口:', JSON.stringify(await guide));
if (guide && guide.x) { await clickAt(guide.x, guide.y, 1200); }
await shot('01-guide');

// 4) 教程已在 DOM？遍历 6 个导航卡，读每个复制框
const sections = ['run', 'clean', 'refuse', 'style', 'wb', 'fix'];
const readPre = async () => ev(`(() => {
  const pres = Array.from(document.querySelectorAll('pre')).filter(p => p.className.includes('whitespace-pre-wrap'));
  return pres.map(p => (p.innerText||'').slice(0, 60));
})()`);

// 先读当前页
let all = [];
for (const s of sections) {
    // 点左侧导航
    const nav = await ev(`(() => {
      const el = Array.from(document.querySelectorAll('*')).find(e => {
        const t = (e.textContent||'').trim();
        return t.length < 24 && /[①-⑥]/.test(t) && e.getBoundingClientRect().width > 60 && e.getBoundingClientRect().width < 320 && e.children.length < 6;
      });
      return !!el;
    })()`);
    break;
}

console.log('\n--- 逐张卡片读复制框 ---');
const navLabels = ['① 跑通', '② 干净输出', '③ 它老说「我不能」', '④ 标签按我的规矩来', '⑤ 读卡里的世界书', '⑥ 出问题看这里'];
for (const label of navLabels) {
    const clicked = await ev(`(() => {
      const key = ${JSON.stringify(label.replace(/^[①-⑥]\s*/, ''))};
      const el = Array.from(document.querySelectorAll('*')).find(e => {
        const t = (e.textContent||'').trim();
        return t.includes(key) && t.length < 30 && e.getBoundingClientRect().width > 60 && e.getBoundingClientRect().width < 360 && e.children.length < 5;
      });
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left+5, clientY: r.top+5 }));
      return true;
    })()`);
    await sleep(450);
    const pres = await readPre();
    const nonEmpty = (pres || []).filter((t) => t && t.trim().length > 0);
    console.log(`   [${label}] 复制框 ${(pres||[]).length} 个，非空 ${nonEmpty.length} 个:`, JSON.stringify(nonEmpty).slice(0, 160));
    all = all.concat(pres || []);
}

const total = all.length;
const filled = all.filter((t) => t && t.trim().length > 0).length;
ok(`6 张卡片的复制框全部非空（共 ${total} 个）`, total > 0 && filled === total, `非空 ${filled}/${total}`);

// 5) 剪贴板实测
const copied = await ev(`(async () => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => /📋 复制/.test(b.textContent||''));
  if (!btn) return { err: '找不到复制按钮' };
  btn.click();
  await new Promise(r => setTimeout(r, 350));
  try { return { text: await navigator.clipboard.readText() }; } catch(e) { return { err: String(e) }; }
})()`);
const okClip = copied && copied.text && copied.text.trim().length > 0;
ok('点「复制」后剪贴板非空', okClip, JSON.stringify((copied && copied.text || '').slice(0, 70)));

await shot('02-after');
console.log(`\n===== AR-56 复验 ${R.filter(Boolean).length}/${R.length} =====`);
setTimeout(() => process.exit(0), 200);
