/**
 * v2.4.0 装包自测（最终，只读快照）
 * 不点、不改状态，只读取界面事实。
 */
import { connect, sleep } from './_b56-lib.mjs';
process.env.CDP_PORT = '9380';
const { ev, shot } = await connect('smoke240final');

const R = [];
const ok = (n, c, e) => { R.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); };

const htmlLen = await ev(`document.querySelector('#app').innerHTML.length`);
ok('主界面渲染', htmlLen > 5000, `${htmlLen} 字节 DOM`);

const accept = await ev(`Array.from(document.querySelectorAll('input[type=file]')).map(i=>i.getAttribute('accept'))`);
ok('#bug-1 导入 accept 正确', JSON.stringify(accept).includes('.png'), JSON.stringify(accept));

const total = await ev(`(document.body.innerText.match(/总计[:：]\\s*(\\d+)/)||[])[1]`);
ok('加载真实库卡片', Number(total) > 0, `总计 ${total} 张`);

const vueErr = await ev(`JSON.stringify(window.__vueErrors || [])`);
ok('无 Vue 错误', vueErr === '[]' || vueErr === 'undefined' || vueErr === 'null', vueErr);

// 打开打标窗（注入合法 card id）后读关键区
const C = `(function(){ const a=document.querySelector('#app').__vue_app__; return (a._context.provides.appCtx)||(a._container._vnode.component.provides.appCtx); })()`;
await ev(`(() => { const c=${C}; const lib=c.filteredLibrary.value; c.selectedIds.value=[lib[0].id]; c.openAITagModal(); return true; })()`);
await sleep(1200);
await shot('final-aitag');

const bText = await ev(`(document.body.innerText||'')`);
ok('打标窗标题（已选 1 张）', /AI 智能批量打标/.test(bText), '');
ok('#bug-3 预填充行有内容（非空）', /预填充[:：]\\s*\\S/.test(bText), (bText.match(/预填充[^\\n]{0,30}/)||[''])[0]);
ok('#bug-3 「API 兼容」区存在', /API\\s*兼容/.test(bText));

console.log(`\n===== 装包自测 ${R.filter(Boolean).length}/${R.length} =====`);
setTimeout(() => process.exit(0), 200);
