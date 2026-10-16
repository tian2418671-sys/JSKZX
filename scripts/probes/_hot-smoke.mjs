/** 热测试冒烟：CDP 连通 + 首屏 + 三个修复点复验 */
import { connect, CTX } from './_b56-lib.mjs';
const { ev, shot } = await connect('hot');
const J = async (js) => { const v = await ev(js); try { return JSON.parse(String(v)); } catch (e) { return { __raw: String(v) }; } };

console.log('=== 应用状态 ===');
console.log(await ev(`(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;var c=app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx));
  return JSON.stringify({hasApp:!!app, cards:(c&&c.library&&c.library.value||[]).length, books:(c&&c.worldbooks&&c.worldbooks.value||[]).length, appMode:c&&c.appMode&&c.appMode.value, vueErr:/\\[Vue 错误\\]/.test(String(document.body.innerText||''))},null,0);})()`));

console.log('\n=== 修复① accept ===');
console.log(await ev(`(function(){var e=document.querySelector('#app input[type=file]');return JSON.stringify({accept:e?e.getAttribute('accept'):'no el'});})()`));

console.log('\n=== 修复② API 兼容 (PREFILL_MODES 可解析) ===');
console.log(await ev(`(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;var c=app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx));
  var lib=c&&c.library&&c.library.value||[]; if(lib[0]&&c.selectedIds&&c.selectedIds.value)c.selectedIds.value=[lib[0].id];
  if(c&&c.openAITagModal)c.openAITagModal();
  return 'opened=' + !!(c&&c.showAITagModal&&c.showAITagModal.value);})()`));
await new Promise((r)=>setTimeout(r,1200));
console.log(await ev(`(function(){
  var spans=Array.prototype.slice.call(document.querySelectorAll('span'));
  var lab=spans.find(function(e){return String(e.textContent||'').trim()==='API 兼容';});
  if(!lab)return 'API兼容label未渲染(可能预填充未展开)';
  var s=lab.parentElement.querySelector('select');
  return JSON.stringify({opts:s?Array.prototype.slice.call(s.options).map(function(o){return o.value;}):null});})()`));
await shot('hot-smoke');
process.exit(0);
