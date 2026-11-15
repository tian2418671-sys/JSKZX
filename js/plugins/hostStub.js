/**
 * [PLUGIN] 插件效果宿主桩（host stub）
 * 在沙箱 iframe（data: URL + sandbox="allow-scripts"）内模拟 SillyTavern 酒馆的运行环境，
 * 让插件脚本（酒馆助手 / userscript / SlashRunner 命令 / 原生扩展 bundle）能渲染出
 * 悬浮球 / 按钮 / 面板等 UI，达到「所见即所得」的效果预览基线。
 *
 * [!] 安全边界：本模块只返回 HTML 字符串，由工作区组件以 data: URL 注入 iframe；
 *    iframe 无 allow-same-origin，脚本运行于隔离 origin，无法触碰应用本身。
 * [!] 本文件是纯 .js 模块（非 Vue SFC），HTML 字符串可直接使用尖括号，无需 \x3C 转义。
 */

// 真实 jQuery 源码（jquery/dist/jquery.min.js，生产构建内联为字符串）。
// 相比手写 mini-jQuery，真实 jQuery 覆盖 $("<a>",{props}) 带属性创建、.last() 链式、
// 事件委托、CSS 解析等全部能力，从根上避免「逐个脚本补 DOM 方法」的问题。
import jquerySource from 'jquery/dist/jquery.min.js?raw';
// 真实 lodash（lodash.min.js）。酒馆 iframe 脚本环境中 window._ 即 lodash（见 predefine.js），
// 用真实库替代手写 _.escape，覆盖 _.get/_.set/_.merge/_.pick 等全部工具方法。
import lodashSource from 'lodash/lodash.min.js?raw';
// 真实 Handlebars（handlebars.min.js）——酒馆扩展模板引擎（renderExtensionTemplateAsync 底层），
// 渲染扩展设置面板等 {{var}}/{{#each}}/{{{html}}} 模板。
import handlebarsSource from 'handlebars/dist/handlebars.min.js?raw';
// 真实 Showdown（showdown.min.js）——酒馆消息正文 Markdown 引擎（messageFormatting 第 6 步 converter.makeHtml）。
import showdownSource from 'showdown/dist/showdown.min.js?raw';
// 真实 DOMPurify（purify.min.js）——酒馆消息 / 扩展模板的 HTML 净化器（对齐官方 chats.js / templates.js 的
// DOMPurify.sanitize 管线，防 `<script>` / `<style>` / 事件属性等污染穿透沙箱 iframe）。
import dompurifySource from 'dompurify/dist/purify.min.js?raw';
// [PATH] 插件预览资源路径改写（相对路径 → 插件资源代理 URL）。
//    实现放在 `utils/pluginResPath.js` 纯函数模块里，便于 Node 直接单测（本文件依赖 ?raw，Node 跑不了）。
//    这里 re-export，保持既有 `from '../plugins/hostStub.js'` 的调用方零改动。
import { rewritePluginResourcePaths } from '../utils/pluginResPath.js';
export { rewritePluginResourcePaths };
// 纯逻辑函数（rewriteEsmModule / stripEsmSyntax / parseSlashCommand / escapeHtml）——
// 抽离到 hostStubPure.js 供 node --test 单测 import，此处复用避免重复维护。
import { rewriteEsmModule as rewriteEsmModulePure, stripEsmSyntax as stripEsmSyntaxPure, parseSlashCommand as parseSlashCommandPure, escapeHtml as escapeHtmlPure, encodeStyleTags as encodeStyleTagsPure, decodeStyleTags as decodeStyleTagsPure } from './hostStubPure.js';
// [PROBE] 插件静态透视（跑完没内容时解释原因用；**绝不阻止渲染** —— 见 hostStubProbe.js 顶部说明）
import { probePluginSource, renderProbeHtml } from './hostStubProbe.js';
// 🏭 自动生成的宿主 API 清单（来自真实酒馆源码 st-context.js 的 155 个成员 +
//    events.js 的 104 个事件常量）。由 `node scripts/gen-host-stubs.mjs` 生成。
//    这是「不再手工补 API」的基础：任何 getContext() 成员都会自动被补齐。
import { CONTEXT_MEMBERS, EVENT_TYPES, CONTEXT_DEFAULTS_SOURCE } from './hostStubs.generated.js';
export { CONTEXT_MEMBERS, EVENT_TYPES };
// 🧩 扩展工程改用**真实 ESM**（浏览器原生解析依赖树），不再需要任何源码改写器。
//    历史：曾用 esmModules.js 正则改写 import/export，但插件千变万化
//    （顶层 await、test/dev 目录、TS 构建产物…）导致补丁无穷无尽，已整体废弃。
// 🏗️ 宿主 DOM 骨架 + 主题 CSS（纯字符串，不依赖 ?raw，供 Node 单测直接断言输出）
import { buildHostDom, buildTavernThemeCss } from './hostStubDom.js';
export { buildHostDom, buildTavernThemeCss };
/**
 * 内存版 localStorage 的**内联源码**（注入到预览页 <script> 里执行）。
 *
 * [!] 历史上这里用 `buildMemoryStorage.toString()` 把函数转成字符串再拼接。
 *    那种写法有两个隐患：① 函数内一旦引用外部变量，转字符串后就变成未定义（改一行就炸）；
 *    ② 压缩/混淆后 toString() 结果不稳定。
 *    现在改为**显式字符串常量**，谁改了函数体都不会影响注入结果。
 *    注意：这里必须保持纯 ES5 语法，因为它会被原样塞进旧环境的脚本里。
 */
/**
 * 🏭 自动生成的 getContext 默认值源码（内联进注入脚本用）。
 *
 * 源数据是真实酒馆的 st-context.js / events.js，由 `node scripts/gen-host-stubs.mjs` 生成。
 * 换成源码字符串而非 JSON：默认值里大量是函数，JSON 无法表达。
 * **不需要手工维护**：换酒馆版本后重新跑一次生成器即可。
 */
const CTX_DEFAULTS_SRC = CONTEXT_DEFAULTS_SOURCE;

const MEMORY_STORAGE_SRC = `(function(){
  var store = {};
  function norm(k){ return String(k); }
  return {
    getItem: function(k){ k = norm(k); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function(k, v){ store[norm(k)] = String(v); },
    removeItem: function(k){ delete store[norm(k)]; },
    clear: function(){ store = {}; },
    key: function(i){ var keys = Object.keys(store); return i >= 0 && i < keys.length ? keys[i] : null; },
    get length(){ return Object.keys(store).length; }
  };
})()`;

/**
 * 迷你事件发射器（模拟酒馆 eventSource）。
 * 对齐 SillyTavern 的 EventEmitter 接口：on / once / makeLast / makeFirst / removeListener / emit / emitAndWait。
 */
function buildEventSourceStub() {
    return `
window.eventSource = (function(){
  const handlers = {};
  function list(type){ return handlers[type] || (handlers[type] = []); }
  return {
    on(type, fn){ list(type).push(fn); return () => this.removeListener(type, fn); },
    once(type, fn){ const w = (...a)=>{ this.removeListener(type, w); try { fn(...a); } catch(e){ console.error(e); } }; this.on(type, w); return () => this.removeListener(type, w); },
    makeLast(type, fn){ const l = list(type); const i = l.indexOf(fn); if (i >= 0) { l.splice(i, 1); l.push(fn); } else { l.push(fn); } return () => this.removeListener(type, fn); },
    makeFirst(type, fn){ const l = list(type); const i = l.indexOf(fn); if (i >= 0) { l.splice(i, 1); l.unshift(fn); } else { l.unshift(fn); } return () => this.removeListener(type, fn); },
    removeListener(type, fn){ const l = handlers[type]; if (l) handlers[type] = l.filter(f=>f!==fn); },
    removeListenerFromAll(fn){ for (const t in handlers) handlers[t] = handlers[t].filter(f=>f!==fn); },
    off(type, fn){ this.removeListener(type, fn); },
    emit(type, ...a){ list(type).slice().forEach(f=>{ try{ f(...a); }catch(e){ console.error(e); } }); },
    emitAndWait(type, ...a){ list(type).slice().forEach(f=>{ try{ f(...a); }catch(e){ console.error(e); } }); },
    clearType(type){ delete handlers[type]; },
    clearAll(){ for (const k in handlers) delete handlers[k]; }
  };
})();`;
}

/**
 * 注入真实 jQuery（替代手写 mini-jQuery）。
 * 手写 shim 会不断遗漏脚本用到的 API（如 $("<a>",{props}) 带属性创建、.last() 链式边缘情况、
 * 事件委托、CSS 数值推断等），导致「逐个脚本补方法」。真实 jQuery 一次性覆盖完整 API 面。
 */
function buildMiniJquery() {
    return jquerySource;
    /* ============ 以下旧的手写 mini-jQuery 已弃用（unreachable，仅留作历史参考） ============ */
    return `
(function(){
  function isHtml(s){ return typeof s === 'string' && s.trim()[0] === '<'; }
  function isNode(el){ return el && (el.nodeType === 1 || el.nodeType === 9 || el.nodeType === 11); }
  function toNode(el){ if (isNode(el)) return el; if (el && isNode(el[0])) return el[0]; return null; }
  function matches(el, sel){ try { return el && el.matches && el.matches(sel); } catch(e) { return false; } }
  function $(sel, ctx){
    if (typeof sel === 'function') { // $(fn) ready
      if (document.readyState !== 'loading') { try{ sel(); }catch(e){ console.error(e); } }
      else document.addEventListener('DOMContentLoaded', ()=>{ try{ sel(); }catch(e){ console.error(e); } });
      return makeObj([document]);
    }
    if (sel && isNode(sel)) return makeObj([sel]);          // $(domNode)
    if (sel && sel.length !== undefined && isNode(sel[0])) return makeObj(Array.from(sel)); // $(jqObj)
    if (isHtml(sel)) { // $(html) 创建元素
      const tpl = document.createElement('template');
      tpl.innerHTML = sel.trim();
      return makeObj(Array.from(tpl.content.children));
    }
    const root = ctx ? (toNode(ctx) || document) : document;
    const els = Array.from((root.querySelectorAll ? root.querySelectorAll(sel) : []) || []);
    return makeObj(els);
  }
  function makeObj(els){
    els = els || [];
    const obj = {
      0: els[0], length: els.length,
      ready(cb){ if (document.readyState !== 'loading') { try{cb&&cb();}catch(e){} } else document.addEventListener('DOMContentLoaded', ()=>{ try{cb&&cb();}catch(e){} }); return obj; },
      on(ev, sel, cb){ if (typeof sel === 'function'){ cb = sel; sel = null; }
        const base = String(ev).split('.')[0]; // jQuery 事件命名空间：click.xxx -> click
        els.forEach(el=>{ el.addEventListener(base, function(e){ if (!sel || matches(e.target, sel)) { try{ cb && cb.call(el, e); }catch(err){ console.error(err); } } }); }); return obj; },
      off(ev, cb){ const base = String(ev).split('.')[0]; els.forEach(el=>{ el.removeEventListener(base, cb); }); return obj; },
      one(ev, cb){ els.forEach(el=>{ const w = (e)=>{ el.removeEventListener(ev, w); cb.call(el, e); }; el.addEventListener(ev, w); }); return obj; },
      click(cb){ return cb === undefined ? obj.trigger('click') : obj.on('click', cb); },
      load(cb){ els.forEach(el=>{ if (el.tagName==='IMG'||el.tagName==='SCRIPT'||el.tagName==='IFRAME') { el.addEventListener('load', cb); } else { try{cb&&cb();}catch(e){} } }); return obj; },
      append(){ const args = Array.from(arguments); els.forEach(el=>{ args.forEach(a=>{ const n = toNode(a); if (n) el.appendChild(n); else if (a!==undefined&&a!==null) el.insertAdjacentHTML('beforeend', String(a)); }); }); return obj; },
      prepend(){ const args = Array.from(arguments); els.forEach(el=>{ args.forEach(a=>{ const n = toNode(a); if (n) el.prepend(n); else if (a!==undefined&&a!==null) el.insertAdjacentHTML('afterbegin', String(a)); }); }); return obj; },
      appendTo(target){ $(target).append(els); return obj; },
      prependTo(target){ $(target).prepend(els); return obj; },
      before(){ const args = Array.from(arguments); els.forEach(el=>{ args.forEach(a=>{ const n = toNode(a); if (n) el.parentNode && el.parentNode.insertBefore(n, el); else if (a!==undefined&&a!==null) el.insertAdjacentHTML('beforebegin', String(a)); }); }); return obj; },
      after(){ const args = Array.from(arguments); els.forEach(el=>{ args.forEach(a=>{ const n = toNode(a); if (n) el.parentNode && el.parentNode.insertBefore(n, el.nextSibling); else if (a!==undefined&&a!==null) el.insertAdjacentHTML('afterend', String(a)); }); }); return obj; },
      insertBefore(target){ $(target).before(els); return obj; },
      insertAfter(target){ $(target).after(els); return obj; },
      remove(){ els.forEach(el=>{ try{ el.remove(); }catch(e){} }); return obj; },
      empty(){ els.forEach(el=>{ el.innerHTML = ''; }); return obj; },
      detach(){ const out = Array.from(els); els.forEach(el=>{ try{ el.remove(); }catch(e){} }); return makeObj(out); },
      css(prop, val){ if (val === undefined && typeof prop === 'string') return els[0] ? getComputedStyle(els[0])[prop] : undefined; els.forEach(el=>{ if (typeof prop === 'object'){ for (const k in prop){ const v = prop[k]; if (typeof v === 'number' && !(/zIndex|opacity|lineHeight|fontWeight|zoom|flex|order|scale|count|weight/i.test(k))) el.style[k] = v + 'px'; else el.style[k] = v; } } else if (val !== undefined){ el.style[prop] = val; } }); return obj; },
      html(v){ if (v === undefined) return els[0] ? els[0].innerHTML : ''; els.forEach(el=>{ el.innerHTML = v; }); return obj; },
      text(v){ if (v === undefined) return els[0] ? els[0].textContent : ''; els.forEach(el=>{ el.textContent = v; }); return obj; },
      attr(k, v){ if (v === undefined && typeof k === 'string') return els[0] ? els[0].getAttribute(k) : null; els.forEach(el=>{ if (typeof k === 'object'){ for (const x in k) el.setAttribute(x, k[x]); } else { el.setAttribute(k, v); } }); return obj; },
      removeAttr(k){ els.forEach(el=>{ el.removeAttribute(k); }); return obj; },
      prop(k, v){ if (v === undefined && typeof k === 'string') return els[0] ? els[0][k] : null; els.forEach(el=>{ if (typeof k === 'object'){ Object.assign(el, k); } else { el[k] = v; } }); return obj; },
      data(k, v){ if (v === undefined && typeof k === 'string'){ const el = els[0]; if (!el) return undefined; const raw = el.getAttribute('data-' + k); return raw === null ? undefined : raw; } els.forEach(el=>{ if (typeof k === 'object'){ for (const x in k) el.setAttribute('data-' + x, String(k[x])); } else { el.setAttribute('data-' + k, String(v)); } }); return obj; },
      addClass(c){ els.forEach(el=>{ String(c).split(/\\s+/).forEach(x=>{ if(x) el.classList.add(x); }); }); return obj; },
      removeClass(c){ els.forEach(el=>{ String(c).split(/\\s+/).forEach(x=>{ if(x) el.classList.remove(x); }); }); return obj; },
      toggleClass(c, force){ els.forEach(el=>{ String(c).split(/\\s+/).forEach(x=>{ if(x) el.classList.toggle(x, force); }); }); return obj; },
      hasClass(c){ return els.some(el=> el.classList.contains(c)); },
      show(){ els.forEach(el=>{ el.style.display = ''; }); return obj; },
      hide(){ els.forEach(el=>{ el.style.display = 'none'; }); return obj; },
      toggle(){ els.forEach(el=>{ el.style.display = (getComputedStyle(el).display === 'none') ? '' : 'none'; }); return obj; },
      val(v){ if (v === undefined) return els[0] ? (els[0].value !== undefined ? els[0].value : '') : ''; els.forEach(el=>{ el.value = v; }); return obj; },
      focus(){ if (els[0] && els[0].focus) els[0].focus(); return obj; },
      blur(){ if (els[0] && els[0].blur) els[0].blur(); return obj; },
      find(sel){ let out=[]; els.forEach(el=>{ try { out = out.concat(Array.from(el.querySelectorAll(sel))); } catch(e) { // jQuery 支持 '> p, > div' 直接子元素前缀，原生 querySelectorAll 不支持，转成 :scope 形式\n          try { const scoped = String(sel).split(',').map(function(s){ s = s.trim(); return s.charAt(0) === '>' ? ':scope ' + s : s; }).join(','); out = out.concat(Array.from(el.querySelectorAll(scoped))); } catch(e2) {} } }); return makeObj(out); },
      children(sel){ let out=[]; els.forEach(el=>{ out = out.concat(Array.from(el.children)); }); if (sel) out = out.filter(el=>matches(el, sel)); return makeObj(out); },
      filter(sel){ let out; if (typeof sel === 'function'){ out = els.filter((el,i)=> sel.call(el, i, el)); } else { out = els.filter(el=> matches(el, sel)); } return makeObj(out); },
      not(sel){ let out; if (typeof sel === 'function'){ out = els.filter((el,i)=> !sel.call(el, i, el)); } else if (isNode(sel) || (sel && sel.length !== undefined)){ const excl = toNode(sel); out = els.filter(el=> el !== excl); } else { out = els.filter(el=> !matches(el, sel)); } return makeObj(out); },
      is(sel){ if (typeof sel === 'function') return els.some((el,i)=> sel.call(el, i, el)); return els.some(el=> matches(el, sel)); },
      has(sel){ return makeObj(els.filter(el=> (sel && sel.length !== undefined) ? el.contains(toNode(sel)) : el.querySelector(sel) !== null)); },
      each(cb){ els.forEach((el,i)=>{ try{ cb.call(el, i, el); }catch(e){} }); return obj; },
      map(cb){ return makeObj(els.map((el,i)=> { const r = cb.call(el, i, el); return r; })); },
      get(i){ if (i === undefined) return Array.from(els); return els[i]; },
      first(){ return makeObj(els[0] ? [els[0]] : []); },
      last(){ return makeObj(els.length ? [els[els.length-1]] : []); },
      eq(i){ return makeObj(els[i] ? [els[i]] : []); },
      slice(a,b){ return makeObj(Array.prototype.slice.call(els, a, b)); },
      index(el){ if (el === undefined) return els[0] ? Array.from(els[0].parentElement.children).indexOf(els[0]) : -1; const n = toNode(el); return els.indexOf(n); },
      parent(sel){ let out = els.map(el=> el.parentElement).filter(Boolean); if (sel) out = out.filter(el=> matches(el, sel)); return makeObj(out); },
      parents(sel){ let out=[]; els.forEach(el=>{ let p = el.parentElement; while (p){ out.push(p); p = p.parentElement; } }); if (sel) out = out.filter(el=> matches(el, sel)); return makeObj(out); },
      closest(sel){ let out=[]; els.forEach(el=>{ let p = el; while (p){ if (matches(p, sel)){ out.push(p); break; } p = p.parentElement; } }); return makeObj(out); },
      next(){ return makeObj(els.map(el=> el.nextElementSibling).filter(Boolean)); },
      prev(){ return makeObj(els.map(el=> el.previousElementSibling).filter(Boolean)); },
      siblings(sel){ let out=[]; els.forEach(el=>{ if (el.parentElement) out = out.concat(Array.from(el.parentElement.children).filter(x=> x !== el)); }); if (sel) out = out.filter(el=> matches(el, sel)); return makeObj(out); },
      wrap(html){ els.forEach(el=>{ const w = $(html)[0]; if (!w || !el.parentNode) return; el.parentNode.insertBefore(w, el); w.appendChild(el); }); return obj; },
      width(v){ if (v === undefined) return els[0] ? els[0].getBoundingClientRect().width : 0; els.forEach(el=>{ el.style.width = (typeof v === 'number' ? v + 'px' : v); }); return obj; },
      height(v){ if (v === undefined) return els[0] ? els[0].getBoundingClientRect().height : 0; els.forEach(el=>{ el.style.height = (typeof v === 'number' ? v + 'px' : v); }); return obj; },
      offset(){ const el = els[0]; if (!el) return {top:0,left:0}; const r = el.getBoundingClientRect(); return { top: r.top + (window.scrollY||0), left: r.left + (window.scrollX||0) }; },
      position(){ const el = els[0]; if (!el) return {top:0,left:0}; return { top: el.offsetTop, left: el.offsetLeft }; },
      fadeIn(ms){ els.forEach(el=>{ el.style.opacity = 0; el.style.display = ''; requestAnimationFrame(()=>{ el.style.transition = 'opacity ' + (ms||200) + 'ms'; el.style.opacity = 1; }); }); return obj; },
      fadeOut(ms){ els.forEach(el=>{ el.style.transition = 'opacity ' + (ms||200) + 'ms'; el.style.opacity = 0; setTimeout(()=>{ el.style.display = 'none'; }, ms||200); }); return obj; },
      trigger(ev){ els.forEach(el=>{ try { el.dispatchEvent(new Event(ev, { bubbles: true })); } catch(e) {} }); return obj; },
      scrollTop(){ return els[0] ? els[0].scrollTop : 0; }
    };
    // ⚠️ 不要再动 obj.__proto__：
    //    历史上这里写过 obj.__proto__ = Object.getPrototypeOf($.fn || {})，
    //    而 $.fn 本身正是由 makeObj([]) 创建 ⇒ 循环依赖，首次执行时 $.fn 为
    //    undefined，getPrototypeOf({}) 把原型设成普通对象，导致整条原型链被污染。
    //    后果：插件调用 $('x').addEventListener(...) 这类**原生 DOM 方法**时，
    //    属性查找落到被污染的原型上，报
    //    Cannot read properties of undefined (reading 'function(){ return undefined; }')
    //    （函数被字符串化后当成属性名去取）。真实案例：AutoRandomInput 随机指令。
    //    现在统一镜像**原生节点**的方法：jQuery 对象也支持 addEventListener 等原生 API。
    // 让 jQuery 对象**直接支持原生 DOM API**（不少现代插件混用两种写法，
    // 典型：AutoRandomInput 用 $('#ari-copy-rule').addEventListener(...)）。
    // ⚠️ for...in 只能拿到自有属性，addEventListener 在原型链上，必须显式列举。
    const NATIVE_EL_METHODS = [
      'addEventListener', 'removeEventListener', 'dispatchEvent',
      'setAttribute', 'getAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute',
      'appendChild', 'removeChild', 'insertBefore', 'replaceChild', 'cloneNode',
      'querySelector', 'querySelectorAll', 'getElementsByClassName', 'getElementsByTagName',
      'contains', 'matches', 'closest', 'scrollIntoView', 'focus', 'blur', 'click',
      'insertAdjacentHTML', 'insertAdjacentElement', 'getBoundingClientRect',
      'animate', 'setPointerCapture', 'releasePointerCapture', 'showModal', 'close'
    ];
    for (const k of NATIVE_EL_METHODS) {
      if (typeof obj[k] !== 'undefined') continue;
      obj[k] = function () {
        const args = Array.prototype.slice.call(arguments);
        // 多元素集合：逐个调用，链式返回自身
        if (els.length > 1) {
          els.forEach(function (el) { if (el && typeof el[k] === 'function') el[k].apply(el, args); });
          return obj;
        }
        const el = els[0];
        if (!el || typeof el[k] !== 'function') {
          // 空集合时静默返回 undefined / 自身，避免插件因节点不存在直接崩
          return k === 'addEventListener' || k === 'removeEventListener' ? obj : undefined;
        }
        const r = el[k].apply(el, args);
        return r === el ? obj : r;   // 链式：返回节点时改成 jQuery 对象
      };
    }
    return obj;
  }
  $.fn = makeObj([]);
  $.fn.init = function(){};
  $.trim = function(s){ return String(s||'').trim(); };
  $.each = function(obj, cb){ if (Array.isArray(obj) || obj.length !== undefined) { Array.from(obj).forEach((v,i)=>cb.call(v, i, v)); } else { for (const k in obj) cb.call(obj[k], k, obj[k]); } return obj; };
  $.extend = function(target){ const args = Array.from(arguments); if (typeof target === 'boolean') args.shift(); const t = args.shift() || {}; args.forEach(src=>{ for (const k in src) t[k] = src[k]; }); return t; };
  $.isFunction = function(v){ return typeof v === 'function'; };
  $.ajax = function(opts){ opts = opts || {}; const fake = { status: 200, statusText: 'OK', responseText: '', responseJSON: undefined, readyState: 4 }; try { if (opts.success) opts.success(fake.responseText || {}, 'success', fake); } catch(e){} const chain = { done(cb){ try{cb&&cb({});}catch(e){} return chain; }, fail(cb){ try{cb&&cb();}catch(e){} return chain; }, always(cb){ try{cb&&cb();}catch(e){} return chain; }, then(cb){ try{cb&&cb({});}catch(e){} return chain; } }; return chain; };
  $.getJSON = $.get = $.post = function(){ return $.ajax({}); };
  window.$ = window.jQuery = $;
})();`;
}

/** SillyTavern 扩展 / userscript 常用全局 stub（避免脚本一加载就 ReferenceError） */
function buildGlobalStubs(plugin = {}, opts = {}) {
    // 插件声明的脚本按钮（酒馆助手 JSON 的 buttons 字段）作为初始脚本按钮列表
    const initialButtons = JSON.stringify((plugin.meta && Array.isArray(plugin.meta.buttons)) ? plugin.meta.buttons : []);
    const scriptName = JSON.stringify((plugin.name && String(plugin.name)) || 'jsk-plugin');
    return `
// —— [BUG] errorCatched：酒馆助手 / JS-Slash-Runner 的**通用脚本包装器**。
//
//    几乎所有酒馆助手脚本的第一行都是：
//        $(errorCatched(() => { ...脚本主体... }));
//    其中 errorCatched 负责包一层错误隔离。它**不存在**时，这一行直接
//    ReferenceError，浏览器连带报「Unexpected token ':'」并整段不执行
//    —— 表现为「插件完全没效果」，且错误信息完全指不到真正原因。
//
//    语义按 JS-Slash-Runner 实现：收到函数就返回同函数（可选包 try/catch），
//    收到别的东西原样返回。
try {
  if (typeof window.errorCatched !== 'function') {
    window.errorCatched = function (fn) {
      if (typeof fn !== 'function') return fn;
      return function () {
        try { return fn.apply(this, arguments); }
        catch (e) { try { console.error('[errorCatched]', e); } catch (_) {} }
      };
    };
  }
} catch (e) {}

// —— 受控的 window.parent / window.top 访问：沙箱 iframe 无 allow-same-origin，
//    访问 window.parent 会抛 SecurityError，这里用 getter 兜底返回本地 window，
//    使插件里的 parentWin.SillyTavern 等回落到本地 stub，不再报跨源错误。
try {
  Object.defineProperty(window, 'parent', { get: function(){ return window; } });
  Object.defineProperty(window, 'top', { get: function(){ return window; } });
  Object.defineProperty(window, 'self', { get: function(){ return window; } });
} catch(e) {}

// —— 通用聊天消息 API（酒馆助手脚本最常调用）
//
// [BUG] 字段名踩坑（2026-11-08）：原来只给 { is_user, name, mes }（原生酒馆 ChatMessage 风格），
//    结果「更好的聊天记录管理」直接报「加载消息失败」—— 它读的是**酒馆助手 getChatMessages 的格式**：
//      { message_id, name, role: 'user'|'assistant', message, is_hidden, ... }
//    两套字段完全不同。现在**两套都给**，谁读谁都不炸（实测口径见
//    js/composables/chat/useChatSandbox.js L113 的标准结构）。
var __jskChat = [
  __jskMakeMsg(0, 'user', 'User', '（这是预览用的模拟会话，不会连接真实酒馆，也不会消耗模型额度）'),
  __jskMakeMsg(1, 'assistant', '角色', '你好！这是一条模拟的角色回复，用来让依赖聊天内容渲染界面的插件有东西可读。')
];

/** 单条消息：同时满足「酒馆助手 getChatMessages」与「原生 ChatMessage」两套字段 */
function __jskMakeMsg(id, role, name, text) {
  var t = String(text == null ? '' : text);
  var isUser = role === 'user';
  return {
    // —— 酒馆助手 getChatMessages 格式 ——
    message_id: id,
    name: name,
    role: role,
    message: t,
    is_hidden: false,
    swipe_id: 0,
    swipes: [t],
    extra: {},
    data: {},
    // —— 原生酒馆 ChatMessage 格式（部分脚本直接用） ——
    is_user: isUser,
    is_system: false,
    mes: t,
    send_date: Date.now(),
    // —— 兼容个别脚本读 send_date 字符串 ——
    send_dateStr: new Date().toLocaleString()
  };
}
window.__jskMakeMsg = __jskMakeMsg;

window.getLastMessageId = function(){ return __jskChat.length - 1; };
window.getChatMessages = function(range){
  try {
    if (range == null || range === '' || range === true) return __jskChat.slice();
    var parts = String(range).split('-');
    var a = parseInt(parts[0], 10), b = parseInt(parts[1], 10);
    if (isNaN(a)) return __jskChat.slice();
    if (isNaN(b)) return __jskChat.slice(a);
    return __jskChat.slice(a, b + 1);
  } catch(e) { return __jskChat.slice(); }
};

// 把 __jskChat 渲染成真实酒馆结构的 .mes 气泡，塞进 #chat。
//
// 这一步是「导航有内容、点下去却空白」的根因修复：
//   #chat 之前一直是空的（只有隐藏的 #message_template 模板）。插件若按
//   document.querySelector('.mes') 或 jQuery 的 '#chat .mes' 计数判断「有没有消息」，
//   拿到的是 0 或那个隐藏模板 → 直接 return → 用户看到空白。
//   而 getChatMessages() 却返回 2 条数据 —— 数据和 DOM 不一致，属于最隐蔽的一类假象。
function __jskRenderChat(bump) {
  try {
    var host = document.getElementById('chat-history') || document.getElementById('chat');
    if (!host) return 0;
    if (bump) {
      // 用统一构造器，保证新消息也同时具备两套字段
      __jskChat.push(__jskMakeMsg(
        __jskChat.length,
        'assistant',
        '角色',
        '（模拟新回复 ' + new Date().toLocaleTimeString() + '）这是一条手动触发的新消息。'
      ));
    }
    host.innerHTML = '';
    __jskChat.forEach(function(m, i){
      var wrap = document.createElement('div');
      wrap.className = 'mes';
      wrap.setAttribute('is_user', m.is_user ? 'true' : 'false');
      wrap.setAttribute('is_system', m.is_system ? 'true' : 'false');
      wrap.setAttribute('mesid', String(i));
      wrap.style.cssText = 'display:flex;gap:12px;margin:0 0 16px;padding:10px 12px;border-radius:12px;'
        + 'border:1px solid var(--SmartThemeBorderColor,#3f3f46);'
        + 'background:' + (m.is_user ? 'var(--SmartThemeUserMesBlurTintColor,#26262c)' : 'var(--SmartThemeBotMesBlurTintColor,#202024)') + ';';      var avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.cssText = 'flex-shrink:0;width:40px;height:40px;border-radius:50%;background:'
        + (m.is_user ? '#3f3f46' : 'var(--SmartThemeEmColor,#8b5cf6)') + ';';
      var body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0;';
      var header = document.createElement('div');
      header.className = 'mes_header';
      header.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:4px;';
      var nameEl = document.createElement('span');
      nameEl.className = 'ch_name';
      nameEl.innerHTML = '<span class="name_text" style="font-weight:700;color:var(--SmartThemeBodyColor,#e4e4e7);"></span>';
      nameEl.querySelector('.name_text').textContent = m.name || '';
      var idEl = document.createElement('span');
      idEl.className = 'mesIDDisplay';
      idEl.style.cssText = 'font-size:10px;color:#52525b;';
      idEl.textContent = '#' + i;
      header.appendChild(nameEl);
      header.appendChild(idEl);
      var textEl = document.createElement('div');
      textEl.className = 'mes_text';
      textEl.style.cssText = 'color:var(--SmartThemeBodyColor,#d4d4d8);font-size:14px;line-height:1.6;overflow-wrap:break-word;';
      textEl.textContent = m.mes || '';
      body.appendChild(header);
      body.appendChild(textEl);
      wrap.appendChild(avatar);
      wrap.appendChild(body);
      host.appendChild(wrap);
    });
    return __jskChat.length;
  } catch(e) { console.error('[效果诊断] 渲染聊天气泡失败', e); return 0; }
}
window.__jskRenderChat = __jskRenderChat;

// —— variables 用迷你作用域（对齐酒馆 getContext().variables.local/global 的 get/set/del）——
function __jskVarScope(){
  var m = {};
  return {
    get: function(k){ return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined; },
    set: function(k, v){ m[k] = v; return v; },
    del: function(k){ delete m[k]; },
    list: function(){ return Object.keys(m); }
  };
}
// —— 扩展模板渲染：读 __jskTemplates（主进程预注入的扩展 html 模板映射），Handlebars 编译渲染 ——
//    真实酒馆路径约定 scripts/extensions/<扩展名>/<模板id>.html；宿主键兼容多种写法，找不到回退空串不崩。
window.renderExtensionTemplate = function(extensionName, templateId, data, sanitize){
  var map = window.__jskTemplates || {};
  var keys = [
    extensionName + '/' + templateId + '.html',
    'scripts/extensions/' + extensionName + '/' + templateId + '.html',
    templateId + '.html',
    templateId
  ];
  var content = null;
  for (var i = 0; i < keys.length; i++) { if (typeof map[keys[i]] === 'string') { content = map[keys[i]]; break; } }
  if (content == null) return '';
  try {
    var result = (window.Handlebars) ? window.Handlebars.compile(content)(data || {}) : content;
    // —— 对齐官方 templates.js：渲染后 DOMPurify.sanitize（防模板内 <script>/事件属性污染）——
    //    默认 sanitize=true；调用方可显式传 false 关闭。localize 本地无 i18n 层，原样返回。
    if (sanitize !== false && window.DOMPurify) { try { result = window.DOMPurify.sanitize(result); } catch(e2) {} }
    return result;
  } catch(e) { console.error('[renderExtensionTemplate]', extensionName, templateId, e); }
  return content;
};
window.renderExtensionTemplateAsync = function(extensionName, templateId, data, sanitize){ return Promise.resolve(window.renderExtensionTemplate(extensionName, templateId, data, sanitize)); };
// —— 完整 getContext（对齐 st-context.js 高频成员；函数体惰性求值，window 级 API 后续定义即可）——
window.getContext = function(){
  var v = __jskVarScope;
  // ⚠️ extensionSettings / extension_settings 必须与 window.extension_settings 同一个对象
  //    （酒馆里两者就是同一个引用）。缺了它，插件读 ctx.extensionSettings['xxx'] 会抛
  //    Cannot read properties of undefined。真实案例：RedBird 工具箱 st.ts:178。
  if (!window.extension_settings) window.extension_settings = {};
  // ⚠️ chatMetadata 必须是**稳定引用**（同一对象），不能每次返回新 {}：
  //    插件常用「引用是否变化」判断是否需要重渲染，例如随机指令 skill-ui.js：
  //        if (metadata !== getContext().chatMetadata) { render(); return; }
  //    若每次都返回新对象，这个判断永远成立 ⇒ render ↔ refresh 无限递归
  //    ⇒ RangeError: Maximum call stack size exceeded。
  if (!window.chat_metadata) window.chat_metadata = {};
  var ctx = {
    chat: __jskChat, chatMetadata: window.chat_metadata, characters: window.characters, groups: window.groups,
    extensionSettings: window.extension_settings,
    extension_settings: window.extension_settings,
    name1: 'User', name2: '角色', characterId: '0', groupId: null, chatId: 'demo', members: [],
    getCurrentChatId: function(){ return 'demo'; },
    getRequestHeaders: function(){ return { 'Content-Type': 'application/json' }; },
    reloadCurrentChat: function(){ return Promise.resolve(); }, renameChat: function(){ return Promise.resolve(); },
    saveSettingsDebounced: function(){ return Promise.resolve(); }, saveMetadataDebounced: function(){},
    saveChat: function(){ return Promise.resolve(); }, saveMetadata: function(){ return Promise.resolve(); },
    deleteMessage: function(){ return Promise.resolve(); }, deleteLastMessage: function(){ return Promise.resolve(); },
    addOneMessage: function(m){ return (typeof window.addOneMessage === 'function') ? window.addOneMessage(m) : (window.jQuery ? window.jQuery('<div>') : document.createElement('div')); },
    updateMessageBlock: function(){}, sendSystemMessage: function(){ return Promise.resolve(); },
    generate: function(){ return Promise.resolve(); }, sendStreamingRequest: function(){ return Promise.resolve(); },
    sendGenerationRequest: function(){ return Promise.resolve(); }, stopGeneration: function(){ return false; },
    messageFormatting: function(m){ return (typeof window.messageFormatting === 'function') ? window.messageFormatting(m) : m; },
    substituteParams: function(m){ return (typeof window.__jskSubstituteParams === 'function') ? window.__jskSubstituteParams(m) : String(m); },
    getTokenCountAsync: function(){ return Promise.resolve(0); }, getTokenCount: function(){ return 0; },
    extensionPrompts: {}, setExtensionPrompt: function(){ return Promise.resolve(); },
    eventSource: window.eventSource, eventTypes: window.tavern_events,
    registerMacro: function(n, cb){ if (window.MacrosParser) window.MacrosParser.register(n, cb); },
    unregisterMacro: function(n){ if (window.MacrosParser) window.MacrosParser.unregisterMacro(n); },
    macros: (window.MacrosParser && window.MacrosParser.macros) || {},
    swipe: {
      left: function(){ return Promise.resolve(); }, right: function(){ return Promise.resolve(); },
      to: function(){ return Promise.resolve(); }, show: function(){}, hide: function(){},
      refresh: function(){}, isAllowed: function(){ return false; }, state: {}
    },
    variables: { local: v(), global: v() },
    loader: { show: function(){}, hide: function(){} },
    SlashCommandParser: window.SlashCommandParser, SlashCommand: window.SlashCommand,
    ARGUMENT_TYPE: window.ARGUMENT_TYPE,
    onlineStatus: 'auto', mainApi: {},
    uuidv4: function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){ var r = Math.random()*16|0; return ((c === 'x') ? r : (r & 0x3 | 0x8)).toString(16); }); },
    t: function(s){ return Array.isArray(s) ? s.join('') : String(s == null ? '' : s); },
    translate: function(t){ return t; },
    getCharacters: function(){ return Promise.resolve([]); }, getThumbnailUrl: function(){ return ''; },
    writeExtensionField: function(){ return Promise.resolve(); }, writeExtensionFieldBulk: function(){ return Promise.resolve(); },
    // ── 以下为扩展常用、但此前缺失的成员（插件的「版本检查」逐个探测它们）──
    //    generateRaw: 1.13.2 起加入 context；插件常用它判断宿主版本是否够新。
    //    真实案例：ST-iPhonie 用 !ctx.generateRaw 判定「需要 1.13.2+」直接拒绝启动。
    generateRaw: function(){ return Promise.resolve(''); },
    generateQuietPrompt: function(){ return Promise.resolve(''); },
    //    messageFormatter：addHook / stage 是 1.13+ 的显示钩子体系。
    messageFormatter: (function(){
      var hooks = [];
      return {
        addHook: function(fn){ if (typeof fn === 'function') hooks.push(fn); return fn; },
        removeHook: function(fn){ var i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1); },
        // 部分插件读 stage 常量
        stage: { BEFORE_REGEX: 0, AFTER_REGEX: 1, BEFORE_MARKDOWN: 2, AFTER_MARKDOWN: 3, DISPLAY: 4 },
        // 让宿主自带的渲染链也能走一遍钩子（可选，不影响探测）
        apply: function(text, meta){ var t = String(text == null ? '' : text);
          for (var i = 0; i < hooks.length; i++) { try { var r = hooks[i](t, meta || {}); if (typeof r === 'string') t = r; } catch (e) { /* 单个钩子失败不影响其余 */ } }
          return t; },
      };
    })(),
    //    getExtensionPrompt / setExtensionPrompt 成对（部分扩展会读写）
    getExtensionPrompt: function(){ return ''; },
    //    eventSource 上的 removeListener 别名（EventEmitter 常被混用）
    get eventSourceFull(){
      var es = window.eventSource || {};
      if (es && typeof es.removeListener !== 'function' && typeof es.off === 'function') es.removeListener = es.off;
      if (es && typeof es.off !== 'function' && typeof es.removeListener === 'function') es.off = es.removeListener;
      return es;
    },
  };
  // 🏭 自动补全：把酒馆源码里 getContext() 的**全部 155 个成员**都补上，
  //    只在缺失时才填默认值（上面手写的实现优先级更高）。
  //    清单由 node scripts/gen-host-stubs.mjs 从真实酒馆源码生成，无需手工维护。
  try {
    var __defaults = {
${CTX_DEFAULTS_SRC}
    };
    for (var __k in __defaults) {
      if (ctx[__k] === undefined) ctx[__k] = __defaults[__k];
    }
  } catch (e) { console.error('[hostStub] 自动补全 getContext 失败', e); }
  return ctx;
};
window.saveChat = function(){ return Promise.resolve(); };
window.getCurrentChatId = function(){ return 'demo'; };
window.getCurrentChatName = function(){ return '沙箱演示会话'; };
window.getThumbnailUrl = function(){ return ''; };
window.deleteChatMessages = function(){ return Promise.resolve(); };
window.createChatMessages = function(){ return Promise.resolve(); };
window.rotateChatMessages = function(){ return Promise.resolve(); };
window.triggerSlash = function(cmd){ console.log('[slash]', cmd); return Promise.resolve(); };

// —— 事件常量（对齐 JS-Slash-Runner @types/iframe/event.d.ts 全清单）——
window.iframe_events = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended'
};
window.tavern_events = {
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  IMPERSONATE_READY: 'impersonate_ready',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SD_PROMPT_PROCESSING: 'sd_prompt_processing',
  EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  MOVABLE_PANELS_RESET: 'movable_panels_reset',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
  OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
  OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  FORCE_SET_BACKGROUND: 'force_set_background',
  CHAT_DELETED: 'chat_deleted',
  CHAT_CREATED: 'chat_created',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_DELETED: 'characterDeleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
  SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  OPEN_CHARACTER_LIBRARY: 'open_character_library',
  ONLINE_STATUS_CHANGED: 'online_status_changed',
  IMAGE_SWIPED: 'image_swiped',
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
  SECRET_WRITTEN: 'secret_written',
  SECRET_DELETED: 'secret_deleted',
  SECRET_ROTATED: 'secret_rotated',
  SECRET_EDITED: 'secret_edited',
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_RENAMED_BEFORE: 'preset_renamed_before',
  MAIN_API_CHANGED: 'main_api_changed',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
  // —— 宿主桩曾缺失、被真实扩展监听的事件（按 events.js 补齐；宿主内部自洽即可）——
  APP_INITIALIZED: 'app_initialized',
  CHAT_LOADED: 'chatLoaded',
  GROUP_UPDATED: 'group_updated',
  CHAT_RENAMED: 'chat_renamed',
  GROUP_CHAT_DELETED: 'group_chat_deleted',
  GROUP_CHAT_CREATED: 'group_chat_created',
  GROUP_MEMBER_DRAFTED: 'group_member_drafted',
  GROUP_WRAPPER_STARTED: 'group_wrapper_started',
  GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
  CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE: 'character_group_overlay_state_change_before',
  CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER: 'character_group_overlay_state_change_after'
};
// 把酒馆事件常量合并到 eventSource（使其同时是「常量表 + 发射器」，兼容
// 脚本里 SillyTavern.tavern_events.CHAT_CHANGED 与 .on() 两种访问方式）
for (var __k in window.tavern_events) { window.eventSource[__k] = window.tavern_events[__k]; }

// —— 事件 API（对齐 event.d.ts 签名，eventOn/eventOnce/... 均返回 { stop() }）——
window.eventOn = function(type, cb){ return { stop: window.eventSource.on(type, cb) }; };
window.eventOnce = function(type, cb){ return { stop: window.eventSource.once(type, cb) }; };
window.eventMakeLast = function(type, cb){ return { stop: window.eventSource.makeLast(type, cb) }; };
window.eventMakeFirst = function(type, cb){ return { stop: window.eventSource.makeFirst(type, cb) }; };
window.eventEmit = function(type){ var a = Array.prototype.slice.call(arguments, 1); window.eventSource.emit.apply(window.eventSource, [type].concat(a)); return Promise.resolve(); };
window.eventEmitAndWait = function(type){ var a = Array.prototype.slice.call(arguments, 1); window.eventSource.emitAndWait.apply(window.eventSource, [type].concat(a)); };
window.eventRemoveListener = function(type, cb){ window.eventSource.removeListener(type, cb); };
window.eventClearEvent = function(type){ window.eventSource.clearType(type); };
window.eventClearListener = function(cb){ window.eventSource.removeListenerFromAll(cb); };
window.eventClearAll = function(){ window.eventSource.clearAll(); };

// —— 脚本按钮系统（对齐 script.d.ts：getButtonEvent/getScriptButtons/replaceScriptButtons/
//    updateScriptButtonsWith/appendInexistentScriptButtons/eventOnButton），
//    真实把 visible 按钮渲染到 #extensionsMenu，点击触发 'button_<name>' 事件 ——
window.__jskScriptButtons = ${initialButtons};
window.getButtonEvent = function(name){ return 'button_' + name; };
window.getScriptButtons = function(){ return window.__jskScriptButtons; };
window.__jskRenderScriptButtons = function(){
  var menu = document.getElementById('extensionsMenu');
  var holder = document.getElementById('jsk-script-buttons');
  if (holder) { holder.innerHTML = ''; } else {
    holder = document.createElement('div');
    holder.id = 'jsk-script-buttons';
    holder.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    if (menu) menu.appendChild(holder);
  }
  (window.__jskScriptButtons || []).forEach(function(b){
    if (!b || !b.visible) return;
    var item = document.createElement('div');
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.title = String(b.name || '');
    item.innerHTML = '<div class="fa-fw fa-solid fa-square-plus extensionsMenuExtensionButton"></div><span>' + String(b.name || '') + '</span>';
    item.addEventListener('click', function(){ window.eventSource.emit('button_' + b.name); });
    holder.appendChild(item);
  });
};
window.replaceScriptButtons = function(buttons){ window.__jskScriptButtons = buttons || []; window.__jskRenderScriptButtons(); };
window.updateScriptButtonsWith = function(updater){
  var r = updater(window.__jskScriptButtons);
  if (r && typeof r.then === 'function') { r.then(function(v){ window.__jskScriptButtons = v || []; window.__jskRenderScriptButtons(); }); return r; }
  window.__jskScriptButtons = r || [];
  window.__jskRenderScriptButtons();
  return window.__jskScriptButtons;
};
window.appendInexistentScriptButtons = function(buttons){
  var names = (window.__jskScriptButtons || []).map(function(b){ return b.name; });
  (buttons || []).forEach(function(b){ if (names.indexOf(b.name) < 0) window.__jskScriptButtons.push(b); });
  window.__jskRenderScriptButtons();
};
// eventOnButton（deprecated，等价 eventOn(getButtonEvent(name), cb)）
window.eventOnButton = function(name, cb){ window.eventOn(window.getButtonEvent(name), cb); };
window.getScriptName = function(){ return ${scriptName}; };
window.getScriptInfo = function(){ return ''; };
window.replaceScriptInfo = function(info){};
window.getScriptId = function(){ return 'jsk-plugin'; };
// 渲染初始脚本按钮（插件声明 buttons 时，让「自动总结」等按钮首屏即可见可点）
window.__jskRenderScriptButtons();

// —— 酒馆主对象 SillyTavern（对齐 exported.sillytavern.d.ts 成员清单）——
window.SillyTavern = (window.SillyTavern || (function(){
  function noop(){}
  function resolve(v){ return Promise.resolve(v); }
  return {
    accountStorage: {},
    chat: __jskChat,
    // ⚠️ 以下用 getter：对象字面量在定义时求值，window.characters / eventSource 等
    //    可能此刻尚未初始化，直接赋值会永久捕获 undefined。
    get characters(){ return window.characters || []; },
    name1: 'User',
    name2: '角色',
    characterId: '0',
    groupId: null,
    chatId: 'demo',
    getCurrentChatId: function(){ return 'demo'; },
    getRequestHeaders: function(){ return { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': '' }; },
    reloadCurrentChat: function(){ return resolve(); },
    renameChat: function(){ return resolve(); },
    saveSettingsDebounced: function(){ return resolve(); },
    onlineStatus: 'auto',
    maxContext: 8192,
    // ⚠️ 稳定引用（同 getContext 的理由）：插件用引用比较判断是否需要重渲染
    get chatMetadata(){ return window.chat_metadata || (window.chat_metadata = {}); },
    streamingProcessor: {},
    get eventSource(){ return window.eventSource; },
    get eventTypes(){ return window.tavern_events || window.event_types; },
    // 兼容脚本用 SillyTavern.tavern_events（EventEmitter + 常量）
    get tavern_events(){ return window.eventSource; },
    addOneMessage: function(m, opts){ return (typeof window.addOneMessage === 'function') ? window.addOneMessage(m, opts) : (window.jQuery ? window.jQuery('<div>') : document.createElement('div')); },
    deleteLastMessage: function(){ return resolve(); },
    generate: function(){ console.log('[SillyTavern.generate]'); return resolve(); },
    sendStreamingRequest: function(){ return resolve(); },
    sendGenerationRequest: function(){ return resolve(); },
    stopGeneration: function(){ return false; },
    tokenizers: [],
    getTextTokens: function(){ return resolve(0); },
    getTokenCountAsync: function(){ return resolve(0); },
    extensionPrompts: {},
    setExtensionPrompt: function(){ return resolve(); },
    updateChatMetadata: noop,
    saveChat: function(){ return resolve(); },
    openCharacterChat: function(){ return resolve(); },
    openGroupChat: function(){ return resolve(); },
    saveMetadata: function(){ return resolve(); },
    sendSystemMessage: function(){ return resolve(); },
    activateSendButtons: noop,
    deactivateSendButtons: noop,
    saveReply: function(){ return resolve(); },
    substituteParams: function(c){ return resolve(c); },
    substituteParamsExtended: function(c){ return resolve(c); },
    SlashCommandParser: {},
    SlashCommand: {},
    SlashCommandArgument: {},
    SlashCommandNamedArgument: {},
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', RANGE: 'range', BOOLEAN: 'boolean', VARIABLE_NAME: 'variable_name', CLOSURE: 'closure', SUBCOMMAND: 'subcommand', LIST: 'list', DICTIONARY: 'dictionary' },
    executeSlashCommandsWithOptions: function(){ return resolve({ interrupt: false, pipe: '', isBreak: false, isAborted: false, isQuietlyAborted: false, abortReason: '', isError: false, errorMessage: '' }); },
    timestampToMoment: function(t){ return new Date(t); },
    registerMacro: noop,
    unregisterMacro: noop,
    registerFunctionTool: noop,
    unregisterFunctionTool: noop,
    isToolCallingSupported: function(){ return false; },
    canPerformToolCalls: function(){ return false; },
    ToolManager: {},
    registerDebugFunction: noop,
    renderExtensionTemplate: function(){ return (typeof window.renderExtensionTemplate === 'function') ? window.renderExtensionTemplate.apply(window, arguments) : ''; },
    renderExtensionTemplateAsync: function(){ return Promise.resolve((typeof window.renderExtensionTemplate === 'function') ? window.renderExtensionTemplate.apply(window, arguments) : ''); },
    registerDataBankScraper: function(){ return resolve(); },
    showLoader: noop,
    hideLoader: function(){ return resolve(); },
    mainApi: {},
    // ⚠️ 必须是 getter，不能写成「extensionSettings: window.extension_settings」：
    //    对象字面量在**定义时**就求值，而 window.extension_settings 此刻可能还没初始化，
    //    于是永久捕获 undefined ⇒ 插件读 ctx.extensionSettings['xxx'] 直接抛
    //    Cannot read properties of undefined。真实案例：RedBird 工具箱 st.ts。
    get extensionSettings(){
      if (!window.extension_settings) window.extension_settings = {};
      return window.extension_settings;
    },
    get extension_settings(){
      if (!window.extension_settings) window.extension_settings = {};
      return window.extension_settings;
    },
    ModuleWorkerWrapper: {},
    getTokenizerModel: function(){ return ''; },
    generateQuietPrompt: function(){ return function(){ return resolve(''); }; },
    writeExtensionField: function(){ return resolve(); },
    getThumbnailUrl: function(){ return ''; },
    selectCharacterById: function(){ return resolve(); },
    messageFormatting: function(m, n){ return (typeof window.messageFormatting === 'function') ? window.messageFormatting(m, n) : m; },
    shouldSendOnEnter: function(){ return false; },
    isMobile: function(){ return false; },
    t: function(s){ return Array.isArray(s) ? s.join('') : String(s); },
    translate: function(t){ return t; },
    getCurrentLocale: function(){ return 'zh-cn'; },
    addLocaleData: noop,
    tags: [],
    tagMap: {},
    menuType: {},
    createCharacterData: {},
    Popup: function(){},
    POPUP_TYPE: { TEXT: 0, CONFIRM: 1, INPUT: 2, DISPLAY: 3, CROP: 4 },
    POPUP_RESULT: { AFFIRMATIVE: 0, NEGATIVE: 1, CANCELLED: 2, CUSTOM1: 3, CUSTOM2: 4, CUSTOM3: 5, CUSTOM4: 6, CUSTOM5: 7, CUSTOM6: 8, CUSTOM7: 9, CUSTOM8: 10, CUSTOM9: 11 },
    // 通用弹窗：兼容标准 popup.js（type 数字 + customButtons[]）与酒馆助手
    // （{label,value,isAffirmative} 自定义按钮 + callback(action, jqObj)）两套风格。
    callGenericPopup: function(text, type, inputValue, opts){
      opts = opts || {};
      var dlg = document.createElement('dialog');
      dlg.setAttribute('open', 'open');
      var wide = !!(opts.wide || opts.large || opts.wider);
      var css = 'display:block;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;margin:0;padding:0;border:1px solid #ccc;border-radius:12px;background:#ffffff;color:#222;box-shadow:0 8px 40px rgba(0,0,0,.35);max-height:92vh;max-width:94vw;overflow:auto;';
      if (opts.large) css += 'width:92vw;height:90vh;';
      else if (opts.wide || opts.wider) css += 'width:92vw;';
      else css += 'width:640px;';
      if (opts.allowVerticalScrolling) css += 'overflow-y:auto;';
      if (opts.transparent) css += 'background:transparent;border:0;box-shadow:none;';
      dlg.style.cssText = css;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'padding:18px;box-sizing:border-box;min-height:100px;';
      if (typeof text === 'string') { wrap.innerHTML = text; }
      else if (text && text.nodeType) { wrap.appendChild(text); }
      else if (text && typeof text.appendTo === 'function') { wrap.appendChild(text[0]); }
      else if (text) { wrap.innerHTML = String(text); }
      dlg.appendChild(wrap);
      // 收集自定义按钮（兼容两套格式）
      var custom = [];
      if (Array.isArray(opts.buttons) && opts.buttons.length) custom = opts.buttons.slice();
      else if (Array.isArray(opts.customButtons) && opts.customButtons.length) custom = opts.customButtons.slice();
      var btnBar = document.createElement('div');
      btnBar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:10px 18px 16px;flex-wrap:wrap;';
      function closeWith(action){
        try { dlg.remove(); } catch(e){}
        try { if (opts.callback) opts.callback(action, window.jQuery ? window.jQuery(dlg) : null); } catch(e){}
        return action;
      }
      if (custom.length) {
        custom.forEach(function(b){
          if (typeof b === 'string') b = { text: b };
          var btn = document.createElement('button');
          btn.textContent = b.label || b.text || b.name || '按钮';
          btn.style.cssText = 'padding:8px 20px;border:1px solid #ccc;border-radius:6px;background:#f7f7f7;color:#222;font-size:14px;cursor:pointer;';
          if (b.isAffirmative) btn.style.cssText += 'background:#4f46e5;color:#fff;border-color:#4f46e5;';
          if (b.isNegative) btn.style.cssText += 'background:#e5e7eb;color:#333;';
          btn.onclick = function(){
            if (typeof b.action === 'function') { try { b.action(); } catch(e){} }
            closeWith(b.value !== undefined ? b.value : (b.result !== undefined ? b.result : (b.label || b.text || b.name)));
          };
          btnBar.appendChild(btn);
        });
        dlg.appendChild(btnBar);
      } else if (type === 1 || type === 'confirm') {
        // 默认确认/取消
        var ok = document.createElement('button');
        ok.textContent = '确定'; ok.style.cssText = 'padding:8px 20px;border-radius:6px;background:#4f46e5;color:#fff;border:1px solid #4f46e5;font-size:14px;cursor:pointer;';
        ok.onclick = function(){ closeWith(true); };
        var cancel = document.createElement('button');
        cancel.textContent = '取消'; cancel.style.cssText = 'padding:8px 20px;border-radius:6px;background:#e5e7eb;color:#333;border:1px solid #ccc;font-size:14px;cursor:pointer;';
        cancel.onclick = function(){ closeWith(false); };
        btnBar.appendChild(cancel); btnBar.appendChild(ok);
        dlg.appendChild(btnBar);
      } else {
        // 展示型：默认一个关闭按钮（脚本可自行管理关闭）
        var cls = document.createElement('button');
        cls.textContent = '关闭'; cls.style.cssText = 'display:block;margin:6px auto 4px;padding:8px 26px;border:1px solid #ccc;border-radius:6px;background:#f0f0f0;color:#222;font-size:14px;cursor:pointer;';
        cls.onclick = function(){ closeWith('OK'); };
        dlg.appendChild(cls);
      }
      document.body.appendChild(dlg);
      return resolve(true);
    },
    chatCompletionSettings: {},
    textCompletionSettings: {},
    powerUserSettings: {},
    getCharacters: function(){ return resolve(); },
    getCharacterCardFields: function(){ return {}; },
    uuidv4: function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){ var r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16); }); },
    humanizedDateTime: function(){ return new Date().toLocaleString(); },
    updateMessageBlock: noop,
    appendMediaToMessage: noop,
    loadWorldInfo: function(){ return resolve(null); },
    saveWorldInfo: function(){ return resolve(); },
    reloadWorldInfoEditor: noop,
    updateWorldInfoList: function(){ return resolve(); },
    convertCharacterBook: function(b){ return { entries: {}, originalData: b || {} }; },
    getWorldInfoPrompt: function(){ return resolve({ worldInfoString: '', worldInfoBefore: '', worldInfoAfter: '', worldInfoExamples: [], worldInfoDepth: [], anBefore: [], anAfter: [] }); },
    CONNECT_API_MAP: {},
    getTextGenServer: function(){ return ''; },
    extractMessageFromData: function(d){ return ''; },
    getPresetManager: function(){ return window.__jskPresetManager; },
    getChatCompletionModel: function(){ return ''; },
    printMessages: function(){ return resolve(); },
    clearChat: function(){ return resolve(); },
    ChatCompletionService: {},
    TextCompletionService: {},
    ConnectionManagerRequestService: {},
    updateReasoningUI: noop,
    parseReasoningFromString: function(){ return null; },
    unshallowCharacter: function(){ return resolve(); },
    unshallowGroupMembers: function(){ return resolve(); },
    symbols: { ignore: null },
    // 兼容旧脚本常用简写
    getContext: function(){ return window.getContext(); },
    refreshChat: function(){ console.log('[SillyTavern.refreshChat]'); },
    renderMessages: function(){ console.log('[SillyTavern.renderMessages]'); },
    getLastMessageId: function(){ return window.getLastMessageId(); },
    getChatMessages: function(r){ return window.getChatMessages(r); },
    ui: {},
    Chat: { document: document }
  };
})());

// 酒馆助手核心 API（全自动总结等依赖 TavernHelper_API）
window.TavernHelper_API = (window.TavernHelper_API || {
  getChatMessages: function(r){ return window.getChatMessages(r); },
  getLastMessageId: function(){ return window.getLastMessageId(); },
  getCurrentCharPrimaryLorebook: function(){ return Promise.resolve(null); },
  createLorebookEntries: function(){ return Promise.resolve(); },
  getLorebookEntries: function(){ return Promise.resolve([]); },
  setLorebookEntries: function(){ return Promise.resolve(); },
  triggerSlash: function(c){ return window.triggerSlash(c); }
});
// 部分脚本以全局 TavernHelper（无 _API 后缀）访问，这里提供同源别名
window.TavernHelper = (window.TavernHelper || window.TavernHelper_API);

// —— [PATH] 消息停靠区（toastr / SlashRunner.showMessage 共用）——
//     历史教训：showMessage 原来 4 秒后自动 remove()，导致 statusSystem.js 的
//     状态面板「一闪就没」，用户完全看不到 —— 这是「预览没效果」的直接原因之一。
//     现在改为**常驻**，右上角 × 手动关闭；最多保留 3 条，超出自动折叠最旧。
window.__jskDockPush = function(title, msg){
  try {
    var dock = document.getElementById('jsk-toast-dock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'jsk-toast-dock';
      dock.style.cssText = 'position:fixed;top:44px;right:12px;z-index:999999;display:flex;flex-direction:column;gap:8px;max-width:360px;';
      document.body.appendChild(dock);
    }
    // 超出 3 条：移除最旧
    while (dock.children.length >= 3) {
      try { dock.removeChild(dock.firstChild); } catch(e) { break; }
    }
    var el = document.createElement('div');
    el.style.cssText = 'padding:12px 14px;border-radius:8px;background:#27272a;color:#e4e4e7;'
      + 'font-size:13px;border:1px solid #3f3f46;box-shadow:0 4px 16px rgba(0,0,0,.4);'
      + 'white-space:pre-line;position:relative;padding-right:32px;';
    var head = '';
    if (title) {
      head = '<div style="font-weight:600;color:#a78bfa;margin-bottom:6px;"></div>';
    }
    el.innerHTML = head + '<div class="jsk-dock-body"></div>';
    if (title) el.querySelector('div').textContent = '【' + String(title) + '】';
    el.querySelector('.jsk-dock-body').textContent = String(msg == null ? '' : msg);
    var btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = '关闭';
    btn.style.cssText = 'position:absolute;top:6px;right:8px;background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;';
    btn.addEventListener('click', function(){ try { el.remove(); } catch(e) {} });
    el.appendChild(btn);
    dock.appendChild(el);
    console.log('[dock]', title || '', msg);
  } catch(e) {}
};

// —— toastr（更好的聊天记录管理 / 全自动总结的提示组件）——
window.toastr = (window.toastr || (function(){
  function show(type, msg){ try { console.log('[toastr.' + type + ']', msg); __jskDockPush(null, '[' + type + '] ' + String(msg)); } catch(e){} }
  return { success:function(m){show('success',m);}, error:function(m){show('error',m);}, warning:function(m){show('warning',m);}, info:function(m){show('info',m);}, remove:function(){} };
})());

// —— hljs（扩展 bundle 顶层 y0=hljs.highlightElement 依赖的代码高亮库）——
window.hljs = (window.hljs || (function(){
  function highlightElement(el){ try { if (el && el.classList) el.classList.add('hljs'); } catch(e) {} }
  function highlight(code){ return { value: String(code||'') }; }
  return { highlightElement: highlightElement, highlight: highlight, highlightAll: function(){}, registerLanguage: function(){}, getLanguage: function(){ return undefined; }, listLanguages: function(){ return []; } };
})());

// —— Popper（扩展 bundle 挂载时 Popper.createPopper 依赖的定位库）——
window.Popper = (window.Popper || (function(){
  function createPopper(){ return { state: { placement: 'right-end' }, update: function(){ return Promise.resolve(); }, destroy: function(){} }; }
  return { createPopper: createPopper };
})());

// —— StateManager（statusSystem.js 的状态存储）——
window.StateManager = (window.StateManager || (function(){
  let state = {};
  return {
    getState: function(){ return state; },
    initState: function(s){ state = (s && typeof s === 'object') ? Object.assign({}, s) : {}; return state; },
    saveState: function(){ console.log('[StateManager.saveState]', state); },
    setState: function(k, v){ state[k] = v; }
  };
})());

// —— SlashRunner：兼容 (name, cb, opts) 与对象参数 ({name, description, handler}) 两种签名，
//    并补齐 registerModule / registerHook / showMessage / loadModule / registerMacro，
//    注册命令后渲染可点击的命令面板（让 C 类脚本的状态命令以 UI 呈现）——
window.SlashRunner = (window.SlashRunner || (function(){
  const api = { commands: {}, modules: {}, hooks: {} };
  function normalize(name, cb, opts, desc){
    if (name && typeof name === 'object') { const o = name; return { name: o.name || o.id || 'cmd', desc: o.description || '', cb: o.handler || o.callback || o.action || o.run || function(){}, opts: o.options || o.opts || {} }; }
    if (typeof name === 'string' && typeof cb === 'function') return { name: name, desc: (opts && opts.description) || desc || '', cb: cb, opts: opts || {} };
    return { name: String(name||'cmd'), desc: desc || '', cb: (typeof cb === 'function' ? cb : function(){}), opts: opts || {} };
  }
  function renderPanel(){
    var panel = document.getElementById('jsk-slash-panel');
    var names = Object.keys(api.commands);
    if (!names.length) { if (panel) panel.style.display = 'none'; return; }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'jsk-slash-panel';
      panel.style.cssText = 'margin:12px 16px;padding:10px;border:1px solid #3f3f46;border-radius:10px;background:#27272a;';
      document.body.appendChild(panel);
    }
    panel.style.display = 'block';
    panel.innerHTML = '<div style="font-size:12px;color:#a1a1aa;margin-bottom:8px;">⚡ SlashRunner 命令（点击执行）</div>';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    names.forEach(function(n){
      var c = api.commands[n];
      var b = document.createElement('button');
      b.textContent = n;
      b.title = c.description || '';
      b.style.cssText = 'padding:6px 14px;border-radius:8px;background:#3f3f46;color:#e4e4e7;border:1px solid #52525b;font-size:13px;cursor:pointer;';
      b.addEventListener('click', function(){
        try {
          var r = c.cb();
          if (r !== undefined && r !== null) console.log('[SlashRunner]', n, '=>', r);
        } catch(e) { console.error('[SlashRunner]', n, e); }
      });
      row.appendChild(b);
    });
    panel.appendChild(row);
  }
  api.registerCommand = function(name, cb, opts){
    const n = normalize(name, cb, opts);
    api.commands[n.name] = { cb: n.cb, opts: n.opts, description: n.desc };
    try { console.log('[SlashRunner] 注册命令:', n.name); } catch(e) {}
    renderPanel();
    return api;
  };
  api.registerModule = function(name, cb, opts){
    let n = { name: String(name||'module'), init: cb, opts: opts||{} };
    if (name && typeof name === 'object') n = { name: name.name || 'module', init: name.init || name.handler || function(){}, opts: name.options || name.opts || {} };
    api.modules[n.name] = n;
    try { console.log('[SlashRunner] 注册模块:', n.name); } catch(e) {}
    try { n.init && n.init(); } catch(e) { console.error(e); }
    return api;
  };
  api.registerHook = function(name, cb){ api.hooks[name] = cb; try { console.log('[SlashRunner] 注册钩子:', name); } catch(e) {} return api; };
  api.registerMacro = api.registerHook;
  api.loadModule = function(name){ const m = api.modules[name]; if (m) { try { m.init && m.init(); } catch(e) { console.error(e); } } return api; };
  api.showMessage = function(msg, title){ __jskDockPush(title, msg); return msg; };
  return api;
})());

window.extension_settings = (window.extension_settings || {});
window.saveSettingsDebounced = function(){};
window.getRequestHeaders = function(){ return {}; };

window.power_user = (window.power_user || { forcelocal_mobile: false });
window.chat_metadata = (window.chat_metadata || {});
window.characters = (Array.isArray(window.characters) ? window.characters : [{ name: '角色', avatar: '', mes: '' }]);
window.groups = (window.groups || []);
window.this_chid = (window.this_chid === undefined ? 0 : window.this_chid);
window.online_status = (window.online_status || 'auto');
window.showToast = (window.showToast || function(msg){ try{ console.log('[Toast]', msg); }catch(e){} });
window.CSS = (window.CSS || {});
// userscript GM_* 空实现
['GM_getValue','GM_setValue','GM_deleteValue','GM_addStyle','GM_registerMenuCommand','GM_notification','GM_xmlhttpRequest','GM_listValues'].forEach(function(k){ if (!window[k]) window[k] = function(){ return undefined; }; });
window.GM_info = (window.GM_info || { script: { name: 'userscript' } });
// 内存 localStorage（data: URL 沙箱下原生 localStorage 不可用）
try { localStorage.getItem('__jsk_probe__'); } catch(e) {
  const _s = ${MEMORY_STORAGE_SRC};
  Object.defineProperty(window, 'localStorage', { get: function(){ return _s; } });
}

// —— 原生 SlashCommand / SlashCommandParser / MacrosParser / i18n / 通用 utils ——
// 这些是酒馆核心内建 API（脚本 import 自 scripts/slash-commands/*.js、scripts/macros.js、
// scripts/i18n.js、scripts/utils.js），扩展 bundle 与原生扩展普遍依赖。用真实语义实现，
// 避免逐脚本补丁。命令注册后渲染可点击面板，让扩展的命令 UI 在「效果」页可见。
${buildNativeSlashStubs()}

// —— ESM 模块解析器：bundle 重写后的 import 绑定据此从全局取酒馆 API ——
${buildModuleResolver(opts)}
// —— 渲染演示会话消息（此时全部 window 级 API 均已定义；为插件提供 .mes 挂载点，已渲染则不重复）——
try { if (window.__jskRenderDemoMessages) window.__jskRenderDemoMessages(); } catch(e) { console.error('[demo messages]', e); }
`;
}

/**
 * 生成酒馆核心内建 API stub（原生 SlashCommand 系统 / MacrosParser / i18n / utils / world-info）。
 * 这些是酒馆核心脚本（scripts/slash-commands/*.js、scripts/macros.js、scripts/i18n.js、
 * scripts/utils.js、scripts/world-info.js）对外导出的函数与类，被原生扩展 bundle 通过 ESM import 引用。
 * 这里用「真实语义 + 面板渲染」实现，覆盖任意扩展的依赖，避免逐脚本补丁。
 */
function buildNativeSlashStubs() {
    return `
// —— 枚举与常量 ——
window.ARGUMENT_TYPE = { STRING: 'string', NUMBER: 'number', RANGE: 'range', BOOLEAN: 'boolean', VARIABLE_NAME: 'variable_name', CLOSURE: 'closure', SUBCOMMAND: 'subcommand', LIST: 'list', DICTIONARY: 'dictionary' };
window.POPUP_TYPE = { TEXT: 0, CONFIRM: 1, INPUT: 2, DISPLAY: 3, CROP: 4 };
window.regex_placement = [1, 2];
window.extensionTypes = { SlashCommand: 'slash_command' };
window.NOTE_MODULE_NAME = '1_memnote';
window.metadata_keys = { note: 'note' };
window.persona_description_positions = { IN_PROMPT: 0, IN_CHARACTER_DESCRIPTION: 1 };
window.DEFAULT_DEPTH = 4;
window.DEFAULT_WEIGHT = 1;
window.METADATA_KEY = 'world_info';

// —— world-info ——
window.world_info = {};
window.world_names = '';
window.world_info_position = 'after';
window.world_info_logic = 'AND_ANY';
window.wi_anchor_position = 'before_char';
window.world_info_include_names = true;
window.world_info_include_names_entries = {};
window.selected_world_info = [];
window.convertCharacterBook = function(b){ return { entries: {}, originalData: b || {} }; };
window.createNewWorldInfo = function(){ return {}; };
window.deleteWorldInfo = function(){ return Promise.resolve(); };
window.getWorldInfoPrompt = function(){ return Promise.resolve({ worldInfoString: '', worldInfoBefore: '', worldInfoAfter: '', worldInfoExamples: [], worldInfoDepth: [], anBefore: [], anAfter: [] }); };
window.getWorldInfoSettings = function(){ return {}; };
window.loadWorldInfo = function(){ return Promise.resolve(null); };
window.newWorldInfoEntryTemplate = function(){ return { key: [], keysecondary: [], comment: '', content: '', constant: false, selective: false, order: 100, position: 'before_char', depth: 4, probability: 100, useProbability: false }; };
window.parseRegexFromString = function(s){ return s ? new RegExp(String(s).replace(/^\\//,'').replace(/\\/[a-z]*$/i,'')) : null; };
window.saveWorldInfo = function(){ return Promise.resolve(); };
window.setWorldInfoButtonClass = function(){};
window.shouldWIAddPrompt = function(){ return false; };

// —— utils ——
window.Stopwatch = function(){ this.start = Date.now(); this.stop = function(){ return Date.now() - this.start; }; };
window.delay = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
window.download = function(){};
window.ensureImageFormatSupported = function(){ return Promise.resolve(); };
window.getBase64Async = function(){ return Promise.resolve(''); };
window.getCharaFilename = function(){ return ''; };
window.getImageSizeFromDataURL = function(){ return Promise.resolve({ width: 0, height: 0 }); };
window.getSanitizedFilename = function(s){ return String(s||'').replace(/[\\\\/:*?"<>|]/g, '_'); };
window.getStringHash = function(s){ let h = 0; s = String(s||''); for (let i=0;i<s.length;i++){ h = ((h<<5)-h+s.charCodeAt(i))|0; } return String(h>>>0); };
window.isDataURL = function(s){ return /^data:/i.test(String(s||'')); };
window.showFontAwesomePicker = function(){ return Promise.resolve(''); };
window.uuidv4 = function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){ var r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16); }); };
window.downloadJson = window.download;

// —— i18n ——
window.getCurrentLocale = function(){ return 'zh-cn'; };
window.i18n_data = {};
window.t = function(s){ return Array.isArray(s) ? s.join('') : String(s); };
window.translate = function(t){ return t; };

// —— 原生 SlashCommand 系统（真实语义 + 可点击命令面板）——
// SlashCommand / SlashCommandArgument / SlashCommandNamedArgument / SlashCommandEnumValue 均支持
// 静态 fromProps(...) 工厂（真实酒馆签名），解析器 SlashCommandParser 提供 .parse()。
window.SlashCommand = (function(){
  function C(props){ props = props || {}; this.name = props.name || ''; this.description = props.description || ''; this.callback = props.callback || props.handler || function(){}; this.helpString = props.helpString || ''; this.unnamedArgumentList = props.unnamedArgumentList || []; this.namedArgumentList = props.namedArgumentList || []; this.returns = props.returns; this.category = props.category;
    // 补齐真实酒馆 SlashCommand 全字段（SlashCommand.js）：
    this.splitUnnamedArgument = !!props.splitUnnamedArgument;                 // 是否把剩余未命名参数整串交给回调
    this.splitUnnamedArgumentCount = props.splitUnnamedArgumentCount || 0;     // 前 N 个 token 单独解析，其余整串
    this.rawQuotes = !!props.rawQuotes;                                        // 保留参数原始引号
    this.aliases = (props.aliases && props.aliases.slice) ? props.aliases.slice() : (props.aliases || []); // 命令别名
    this.helpCache = null;
    this.helpDetailsCache = null;
  }
  C.fromProps = function(p){ return Object.assign(new C(p), p || {}); };
  return C;
})();
window.SlashCommandArgument = (function(){
  function A(name, description, typeList, isRequired, defaultValue, enumList, unnamedArgumentList){ this.name = name || ''; this.description = description || ''; this.typeList = typeList || []; this.isRequired = !!isRequired; this.defaultValue = defaultValue; this.enumList = enumList || []; this.unnamedArgumentList = unnamedArgumentList || []; }
  A.fromProps = function(p){ return new A(p.name, p.description, p.typeList, p.isRequired, p.defaultValue, p.enumList); };
  return A;
})();
window.SlashCommandNamedArgument = (function(){
  function N(name, description, typeList, isRequired, defaultValue, enumList){ this.name = name || ''; this.description = description || ''; this.typeList = typeList || []; this.isRequired = !!isRequired; this.defaultValue = defaultValue; this.enumList = enumList || []; }
  N.fromProps = function(p){ return new N(p.name, p.description, p.typeList, p.isRequired, p.defaultValue, p.enumList); };
  return N;
})();
window.enumTypes = { enum: 'enum', list: 'list' };
window.enumIcons = { file: 'fa-file', string: 'fa-font' };
window.SlashCommandEnumValue = (function(){
  function E(value, description, type, icon){ this.value = value; this.description = description || ''; this.type = type || 'enum'; this.icon = icon; }
  E.fromProps = function(p){ return new E(p.value, p.description, p.type, p.icon); };
  return E;
})();
// commonEnumProviders.<provider>(optionId) 返回一个「枚举 provider 函数」，该函数被调用后
// 返回枚举值数组（真实酒馆 SlashCommandCommonEnumsProvider.js 语义，bundle 常写
// commonEnumProviders.boolean('trueFalse')() 这种链式调用）。这里统一返回返回 [] 的函数。
window.commonEnumProviders = (function(){
  function provider(){ return []; }
  function makeProvider(){ return provider; }
  return new Proxy({}, {
    get: function(_t, key){
      if (typeof key === 'symbol') return undefined;
      // 未声明过的 provider 名也返回 makeProvider，覆盖 bundle 可能引用的任意枚举 provider
      return makeProvider;
    }
  });
})();
window.SlashCommandParser = {
  commands: {},
  register: function(cmd){ if (cmd && cmd.name) this.commands[cmd.name] = cmd; },
  get commandHelp(){ return ''; },
  // 最小真实解析器（对齐真实酒馆 SlashCommandParser.parse 的消费约定）：
  // 首 token 为命令名（容忍前导 /），剩余按「空格分词 + 双/单引号包裹的带空值保留 + name=value 命名参数」解析。
  parse: function(text){
    return parseSlashCommandPure(text, this.commands);
  },
  addCommandObject: function(cmd){
    if (cmd && cmd.name) { this.commands[cmd.name] = cmd; this.render(); }
    return cmd;
  },
  render: function(){
    try {
      const names = Object.keys(this.commands);
      let panel = document.getElementById('jsk-native-slash-panel');
      if (!names.length) { if (panel) panel.style.display = 'none'; return; }
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'jsk-native-slash-panel';
        panel.style.cssText = 'margin:12px 16px;padding:10px;border:1px solid #3f3f46;border-radius:10px;background:#27272a;';
        document.body.appendChild(panel);
      }
      panel.style.display = 'block';
      panel.innerHTML = '<div style="font-size:12px;color:#a1a1aa;margin-bottom:8px;">⚡ Slash 命令（点击执行）</div>';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      names.forEach(function(n){
        const c = window.SlashCommandParser.commands[n];
        const b = document.createElement('button');
        b.textContent = '/' + n;
        b.title = c.description || '';
        b.style.cssText = 'padding:6px 14px;border-radius:8px;background:#3f3f46;color:#e4e4e7;border:1px solid #52525b;font-size:13px;cursor:pointer;';
        b.addEventListener('click', function(){ try { const r = c.callback({}); console.log('[slash]', n, r); } catch(e){ console.error(e); } });
        row.appendChild(b);
      });
      panel.appendChild(row);
    } catch(e) { console.error('[SlashCommandParser.render]', e); }
  }
};
window.executeSlashCommandsWithOptions = function(){ return Promise.resolve({ interrupt: false, pipe: '', isBreak: false, isAborted: false, isQuietlyAborted: false, abortReason: '', isError: false, errorMessage: '' }); };

// —— MacrosParser（真实宏注册语义，无实际替换）——
window.MacrosParser = {
  macros: {},
  register: function(name, cb){ this.macros[name] = cb; },
  registerMacro: function(name, cb){ this.macros[name] = cb; },
  unregisterMacro: function(name){ delete this.macros[name]; },
  parse: function(text){ return text; }
};
window.registerMacro = function(name, cb){ window.MacrosParser.register(name, cb); };
window.unregisterMacro = function(name){ delete window.MacrosParser.macros[name]; };
window.getLastMessageId = function(){ return window.__jskChat ? window.__jskChat.length - 1 : -1; };

// —— 通用工具（其他脚本常见 import）——
window.delay = window.delay || function(ms){ return new Promise(r=>setTimeout(r,ms)); };
window.getRequestHeaders = function(){ return { 'Content-Type': 'application/json' }; };
window.saveMetadataDebounced = function(){};
window.saveSettingsDebounced = function(){};
window.getPresetManager = function(){ return window.__jskPresetManager; };
window.getEventSourceStream = function(){ return null; };
window.isImageInliningSupported = function(){ return false; };
window.getUserAvatar = function(){ return ''; };
window.getUserAvatars = function(){ return []; };
window.setUserAvatar = function(){ return Promise.resolve(); };
window.user_avatar = '';
window.isAdmin = function(){ return true; };
window.favsToHotswap = function(){};
window.isMobile = function(){ return false; };
window.flushEphemeralStoppingStrings = function(){};
window.getRegexedString = function(s){ return s; };
window.countOccurrences = function(){ return 0; };
window.isOdd = function(n){ return n % 2 !== 0; };
window.getTokenCountAsync = function(){ return Promise.resolve(0); };
window.getTextTokens = function(){ return Promise.resolve(0); };
window.cleanUpMessage = function(){ return Promise.resolve(); };
window.getBiasStrings = function(){ return []; };
window.getExtensionPromptByName = function(){ return null; };
window.getExtensionPromptRoleByName = function(){ return null; };
window.extension_prompts = {};
window.extension_prompt_types = {};
window.extension_prompt_roles = {};
// preset-manager 实例：bundle 调用 getPresetManager().getPresetList()/getSelectedPreset()/
// getSelectedPresetName()/setSelectedPreset()。这里返回空预设列表，selectedPreset 指向空对象。
window.__jskPresetManager = {
  getPresetList: function(){ return { presets: [] }; },
  getSelectedPreset: function(){ return {}; },
  getSelectedPresetName: function(){ return ''; },
  setSelectedPreset: function(){ return Promise.resolve(); },
  saveSole: function(){ return Promise.resolve(); },
  getAllPresets: function(){ return []; }
};
window.reloadMarkdownProcessor = function(){ return window.__jskMarkdown; };
window.__jskMarkdown = (function(){
  // 真实 Showdown 转换器（showdown.min.js 已在宿主注入，window.showdown 可用）
  var converter = null;
  function getConverter(){
    if (!converter && window.showdown && window.showdown.Converter) {
      try {
        converter = new window.showdown.Converter({
          tables: true, strikethrough: true, tasklists: true, emoji: true,
          openLinksInNewWindow: true, simplifiedAutoLink: true
        });
      } catch(e) { console.error('[showdown init]', e); }
    }
    return converter;
  }
  function makeHtml(md){
    var c = getConverter();
    var s = String(md == null ? '' : md);
    if (!c) return s;
    try { return c.makeHtml(s); } catch(e) { return s; }
  }
  function render(md){ return makeHtml(md); }
  return { makeHtml: makeHtml, render: render, inline: function(md){ return makeHtml(md); }, use: function(){ return window.__jskMarkdown; } };
})();
window.saveCharacterDebounced = function(){};
window.saveChatConditional = function(){ return Promise.resolve(); };
window.setGenerationProgress = function(){};
window.setUserName = function(){};
window.showSwipeButtons = function(){};
window.stopGeneration = function(){ return false; };
window.unshallowCharacter = function(){ return Promise.resolve(); };
window.system_avatar = '';
window.system_message_types = {};
window.default_avatar = '';
window.default_user_avatar = '';
window.online_status = 'auto';
window.main_api = {};
window.getMaxContextSize = function(){ return 8192; };
window.getOneCharacter = function(){ return {}; };
window.getPastCharacterChats = function(){ return []; };
window.printCharacters = function(){};
window.printMessages = function(){};
window.reloadCurrentChat = function(){ return Promise.resolve(); };
window.baseChatReplace = function(){};
window.activateSendButtons = function(){};
window.deactivateSendButtons = function(){};
window.deleteCharacter = function(){ return Promise.resolve(); };
window.extension_settings = window.extension_settings || {};
// —— 宏替换（同步 string→string，对齐真实酒馆 substituteParams 的同步语义；未知宏原样保留）——
window.__jskSubstituteParams = function(mes, chName){
  var s = String(mes == null ? '' : mes);
  var n = String(chName || '角色');
  try {
    s = s.split('{{user}}').join('User').split('{{char}}').join(n)
      .split('{{name1}}').join('User').split('{{name2}}').join(n)
      .split('{{original}}').join('')
      .split('{{newline}}').join(String.fromCharCode(10)).split('{{lf}}').join(String.fromCharCode(10))
      .split('{{time}}').join(new Date().toLocaleTimeString());
  } catch(e) {}
  return s;
};
// —— encodeStyleTags / decodeStyleTags：对齐官方 chats.js 的 <style> 块保护管线 ——
//    官方实现依赖 cssom（css.parse / css.stringify）解析 AST 后再净化；
//    本地未引入 cssom，用最小字符串级实现（见 hostStubPure.js，此处以函数源码注入复用，避免两处漂移）。
window.__jskEncodeStyleTags = ${encodeStyleTagsPure.toString()};
window.__jskDecodeStyleTags = ${decodeStyleTagsPure.toString()};
// —— messageFormatting：对齐官方 chats.js formatCreatorNotes 的完整净化管线 ——
//    substituteParams → converter.makeHtml → encodeStyleTags → DOMPurify.sanitize
//    (MESSAGE_SANITIZE + ADD_TAGS:['custom-style']) → decodeStyleTags
//    关键作用：Showdown 会把原始文本里的 HTML 标签（<script>/<style>/on* 事件等）原样透传，
//    必须经 DOMPurify 净化后再写入 .mes_text，否则脚本输出的 HTML 会污染预览 iframe。
window.messageFormatting = function(mes, chName){
  var s = (typeof window.__jskSubstituteParams === 'function')
    ? window.__jskSubstituteParams(mes, chName)
    : String(mes == null ? '' : mes);
  // 引号样式化：中文双引号/书名号内容包 <q>（跳过已含 HTML 标签的行，避免破坏结构）
  try {
    s = s.replace(/“([^”]{1,80})”/g, '<q>$1</q>');
    s = s.replace(/《([^》]{1,40})》/g, '<q>$1</q>');
  } catch(e) {}
  var html = (window.__jskMarkdown && window.__jskMarkdown.makeHtml) ? window.__jskMarkdown.makeHtml(s) : s;
  try {
    // 1) 用 <custom-style> 编码保护 <style> 块，避免被 DOMPurify 当作可执行样式直接移除/污染
    if (typeof window.__jskEncodeStyleTags === 'function') { html = window.__jskEncodeStyleTags(html); }
    // 2) DOMPurify 净化（对齐官方 MESSAGE_SANITIZE + ADD_TAGS:['custom-style']）
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
      html = window.DOMPurify.sanitize(html, {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
      });
    }
    // 3) 还原 <custom-style> 为安全 <style>（选择器加 .mes_text 前缀、类名加 custom- 前缀、过滤 import/外部资源）
    if (typeof window.__jskDecodeStyleTags === 'function') { html = window.__jskDecodeStyleTags(html); }
  } catch(e) {}
  return html;
};
window.scrollChatToBottom = function(){};
window.SelectCharacterById = window.selectCharacterById = function(){ return Promise.resolve(); };
window.saveSettings = function(){ return Promise.resolve(); };
window.saveMetadata = function(){ return Promise.resolve(); };
window.addOneMessage = function(mes, opts){
  var template = document.getElementById('message_template');
  var chat = document.getElementById('chat');
  if (!template || !chat) return window.jQuery ? window.jQuery('<div>') : document.createElement('div');
  var node = template.querySelector('.mes').cloneNode(true);
  var isUser = !!(mes && mes.is_user);
  var isSys = !!(mes && mes.is_system);
  var name = (mes && mes.name) || (isUser ? 'User' : '角色');
  var text = (mes && (mes.mes || mes.text)) || '';
  var img = node.querySelector('.avatar img');
  if (img) { img.alt = name; img.src = (isUser ? 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="%234f46e5" rx="22"/><text x="22" y="29" font-size="18" fill="white" text-anchor="middle">U</text></svg>' : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="%238b5cf6" rx="22"/><text x="22" y="29" font-size="18" fill="white" text-anchor="middle">C</text></svg>'); }
  var nameEl = node.querySelector('.name_text'); if (nameEl) nameEl.textContent = name;
  var ts = node.querySelector('.timestamp'); if (ts) ts.textContent = (mes && mes.send_date) ? new Date(mes.send_date).toLocaleString() : '';
  var mid = node.querySelector('.mesIDDisplay'); if (mid && mes && mes.id != null) mid.textContent = '#' + mes.id;
  var body = node.querySelector('.mes_text');
  if (body) body.innerHTML = (typeof window.messageFormatting === 'function') ? window.messageFormatting(text, name) : text;
  node.setAttribute('mesid', (mes && mes.id != null) ? String(mes.id) : String((window.__jskChat ? window.__jskChat.length : 0)));
  node.setAttribute('is_user', isUser ? 'true' : 'false');
  node.setAttribute('is_system', isSys ? 'true' : 'false');
  if (isSys) node.style.borderStyle = 'dashed';
  else if (isUser) node.style.background = '#27272a';
  if (opts && opts.insertAfter && opts.insertAfter.parentNode) opts.insertAfter.parentNode.insertBefore(node, opts.insertAfter.nextSibling);
  else if (opts && opts.insertBefore && chat) chat.insertBefore(node, opts.insertBefore);
  else if (chat) chat.appendChild(node);
  return window.jQuery ? window.jQuery(node) : node;
};
// —— 渲染演示会话到 .mes 消息块（已渲染则不重复；为插件提供真实挂载点）——
window.__jskRenderDemoMessages = function(){
  try {
    var chat = document.getElementById('chat');
    if (!chat || chat.querySelector('.mes')) return;
    (window.__jskChat || []).forEach(function(m, i){ m.id = i; window.addOneMessage(m, {}); });
    chat.setAttribute('data-demo-rendered', '1');
  } catch(e) { console.error('[__jskRenderDemoMessages]', e); }
};
window.clearChat = function(){ return Promise.resolve(); };
window.characters = (Array.isArray(window.characters) ? window.characters : [{ name: '角色', avatar: '', mes: '' }]);
window.chat = window.__jskChat || [];
window.chat_metadata = window.chat_metadata || {};
window.this_chid = window.this_chid === undefined ? 0 : window.this_chid;
window.is_send_press = false;
window.name1 = 'User';
window.name2 = '角色';
window.getCurrentChatId = function(){ return 'demo'; };
window.getCharacters = function(){ return []; };
window.getCharacterCardFields = function(){ return {}; };
window.power_user = window.power_user || { forcelocal_mobile: false };

// —— jsoneditor（bundle import ../lib/jsoneditor.js，提供 Mode / ValidationSeverity / createJSONEditor）——
window.Mode = { code: 'code', tree: 'tree', text: 'text', view: 'view', form: 'form' };
window.ValidationSeverity = { error: 'error', warning: 'warning', info: 'info' };
window.createJSONEditor = function(){ return { destroy: function(){}, get: function(){ return {}; }, set: function(){} }; };

// —— PromptManager / openai（Prompt / PromptCollection / Message / ChatCompletion 等类）——
window.Prompt = function(){};
window.PromptCollection = function(){};
window.Message = function(){};
window.MessageCollection = function(){};
window.ChatCompletion = function(){};
window.getChatCompletionModel = function(){ return ''; };
window.getStreamingReply = function(){ return Promise.resolve(''); };
window.oai_settings = {};
window.prepareOpenAIMessages = function(){ return []; };
window.promptManager = {};
window.proxies = {};
window.sendOpenAIRequest = function(){ return Promise.resolve({}); };
window.setOpenAIMessageExamples = function(){};
window.setOpenAIMessages = function(){};
window.setupChatCompletionPromptManager = function(){};
window.tryParseStreamingError = function(){ return null; };
window.generate = function(){ return Promise.resolve(); };
window.MAX_INJECTION_DEPTH = 4;
window.Generate = { parse: function(){ return {}; } };

// —— 顶层别名：确保 bundle import 的每个名字都能在 window 上解析 ——
window.event_types = window.tavern_events || window.event_types;
window.eventTypes = window.event_types;
window.substituteParams = function(c){ return Promise.resolve(c); };
window.substituteParamsExtended = function(c){ return Promise.resolve(c); };
window.setExtensionPrompt = function(){ return Promise.resolve(); };
window.getThumbnailUrl = function(){ return ''; };
window.callGenericPopup = function(text, type, inputValue, opts){
  return (window.SillyTavern && window.SillyTavern.callGenericPopup) ? window.SillyTavern.callGenericPopup(text, type, inputValue, opts) : Promise.resolve(true);
};
window.getLastMessageId = function(){ return window.__jskChat ? window.__jskChat.length - 1 : -1; };
`;
}

/**
 * 生成 ESM 模块解析器（module resolver）。
 * 扩展 bundle 被 rewriteEsmModule 重写为 <script type="module"> 后，其 import 语句会变成
 * import 绑定名 from 一个统一的「万能模块」标识符，由 import map（JSON 脚本）映射到 data: 模块。
 * 该模块的动态导出让任意绑定名都能从全局取到对应 API，从而覆盖所有酒馆内建模块的命名导出。
 * 配合 buildNativeSlashStubs / buildGlobalStubs 已在 window 上铺好的 API 层，实现「任意扩展可加载」。
 */
function buildModuleResolver(opts = {}) {
    const metaPreviewId = String((opts && opts.previewId) || '');
    // ⚠️ import.meta.url 必须是**能真正取到文件**的 URL：
    //    扩展插件普遍写 `new URL('./index.html', import.meta.url)` 去读同目录的界面模板，
    //    或者用 `await fetch(new URL('./data.json', import.meta.url))`。
    //    历史上这里给的是硬编码假地址 `file:///plugin/dist/bundle.js`，
    //    于是 new URL('./index.html', ...) → file:///plugin/dist/index.html ⇒ fetch 直接
    //    `TypeError: Failed to fetch`，插件界面模板拿不到，后续所有 getElementById 全返回 null，
    //    最终报一句完全无法定位的
    //    `Cannot read properties of undefined (reading 'function(){ return undefined; }')`。
    //    真实案例：AutoRandomInput 随机指令（`fetch(new URL('./index.html', window.__jskMeta.url))`）。
    //    现在指向主进程的插件资源代理路由，`app://` 协议会按 previewId 登记的 rootDir 真实读盘。
    const metaUrl = metaPreviewId
        ? 'app://index.html/__jsk_plugin_res__/' + metaPreviewId + '/index.js'
        : 'file:///plugin/dist/bundle.js';
    return `
// —— ESM 模块解析器（万能命名空间）——
// 扩展 bundle 的静态 import 已被 rewriteEsmModule 内联为 var 声明（从 window 取酒馆 API），
// 这里为 import.meta 与动态 import() 提供沙箱内可运行的等价实现。
// default / star import 的兜底值也在此提供。
// [!] import.meta.url 必须是合法 URL：bundle 常写 new URL("../", import.meta.url) 或
//    String(import.meta.url).includes("/dist/")，空串会让 new URL("../", "") 抛 TypeError。
//    这里给一个含 /dist/ 的 file: 基址，保证 new URL 解析始终合法（对任意 bundle 通用）。
window.__jskMeta = { url: '${metaUrl}', resolve: function(s){ return s; } };
window.__jskModuleExports = (function(){
  const NOOP = function(){ return undefined; };
  function resolve(name){
    if (name in window) return window[name];
    if (window.SillyTavern && name in window.SillyTavern) return window.SillyTavern[name];
    if (window.SlashRunner && name in window.SlashRunner) return window.SlashRunner[name];
    return NOOP;
  }
  const ns = new Proxy({}, {
    get: function(_, prop){
      if (prop === Symbol.toStringTag) return 'Module';
      if (prop === 'default') return ns;
      return resolve(prop);
    }
  });
  return ns;
})();
window.__jskResolveModule = function(specifier){
  // 动态 import() 语义：必须返回 Promise（bundle 常写 await import('x').catch(...)），
  // 返回解析为「万能命名空间」的 Promise，兼容 await x / await x.catch() 两种用法。
  return Promise.resolve(window.__jskModuleExports);
};`;
}

/**
 * 把扩展 bundle 的 ESM 源码重写为可在沙箱 <script type="module"> 内运行的形式。
 * 通用策略（不针对具体脚本）：
 *   1. 静态 named import `import{a as b, c}from"x"` → 内联解构 `var{a:b,c}=window.__jskModuleExports;`。
 *      ESM 的 named import 必须静态导出，Proxy 命名空间无法被静态 import 消费，故改为解构取值：
 *      从全局命名空间 Proxy（buildModuleResolver 提供）按导出名取 API，赋给本地别名（语义等价）。
 *   2. 静态 default import / star import → `var X=window.__jskModuleExports;`。
 *   3. 动态 import('...') → `__jskResolveModule('...')`，同步返回命名空间。
 *   4. import.meta → `window.__jskMeta`（无 url 的假对象）。
 *   5. export{...} → 移除；export default → 落到 window.__jskPluginDefault 供宿主观察。
 * 该重写对 minified 单行 import 同样有效（正则以 `[\\s\\S]` 非贪婪匹配，无需换行锚定）。
 * @param {string} src bundle 源码
 * @returns {string} 重写后的 ESM 源码
 */
function rewriteEsmModule(src) {
    return rewriteEsmModulePure(src);
}

/**
 * 🧩 生成「扩展工程」的模块加载块 —— **真实 ESM，不做任何源码改写**。
 *
 * 为什么推倒重来（血泪教训）：
 *   一开始走的是「猜工程形状 → 正则改写 import/export」的路子，结果：
 *     · 随机指令（多文件源码工程）：test/preview.js 被当运行时模块 ⇒ 顶层 await 报错
 *     · RedBird 工具箱（vite+TS 构建工程）：dev/ui-lint.js 被当运行时模块 ⇒ 同样报错
 *     · 每次都是「再加一条排除规则」，插件千变万化，规则永远追不上
 *   而且改写器要处理 named/default/star/副作用/动态 import、export 各种写法、
 *   顶层 await、循环依赖……**这些都是浏览器原生就会的事**，我们根本没理由重写。
 *
 * 现在的做法：
 *   · 主进程的 `app://.../__jsk_plugin_res__/<id>/<相对路径>` 已能按 previewId
 *     登记的 rootDir **真实读盘**，且 .js/.mjs 返回 `text/javascript`（MIME 正确）。
 *   · 于是只需让浏览器自己去加载 manifest 声明的入口：
 *         <script type="module" src="app://…/__jsk_plugin_res__/<id>/dist/index.js">
 *     浏览器会自己解析 `./core.js`、处理循环依赖、支持顶层 await、处理动态 import()。
 *   · **入口由 manifest 决定**，所以 dev/、test/、src/（TS 源码）根本不会被加载 ——
 *     不需要任何「排除目录」的正则。
 *
 * 唯一需要干预的是「非相对路径」的宿主 API import（'jquery'、'/script.js'），
 * 由 importmap 把它们映射到桩模块（见 buildHostImportMap）。
 *
 * @param {object|null} bundleModules 保留形参以兼容旧调用；现在不再需要内容
 * @param {boolean} isExtension
 * @param {object} opts { previewId, entry }
 * @returns {string} 注入用的 <script> 块；缺少 previewId 或入口时返回空串（退回旧路径）
 */
function buildModuleRuntimeBlock(bundleModules, isExtension, opts = {}) {
    const previewId = String((opts && opts.previewId) || '');
    const entry = String((opts && opts.entry) || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!previewId || !entry) return '';

    const base = `app://index.html/__jsk_plugin_res__/${encodeURIComponent(previewId)}/`;
    const entryUrl = base + entry.split('/').map(encodeURIComponent).join('/');

    // 兼容层：插件可能写 import { getContext } from '../../../script.js'
    // 这类「向上跨出插件目录」的路径，浏览器会解析成 app://index.html/script.js ⇒ 404。
    // 用一个 window.__jskModuleExports 兜底：在入口模块之前注册一个 importmap，
    // 把常见的宿主模块名映射到桩。
    const importMap = buildHostImportMap(base);

    return `${importMap}<script type="module">
// 真实 ESM 入口：浏览器自行解析依赖树（相对 import / 顶层 await / 动态 import 全部原生支持）
try {
  window.__jskEntryModule = import(${JSON.stringify(entryUrl)});
  window.__jskEntryModule.catch(function(e){
    console.error('[module] 入口加载失败: ' + ${JSON.stringify(entry)}, e);
  });
} catch (e) {
  console.error('[module] 入口注入异常', e);
}
</script>`;
}

/**
 * 宿主 API 的 importmap：把插件常 import 的模块名指向桩。
 *
 * 浏览器对「裸说明符」（'jquery'）必须有 importmap 才能解析；
 * 对 '/script.js' 这种绝对路径会解析成 app://index.html/script.js ——
 * 由 app:// 协议在 appRoot 下找不到 ⇒ 404 ⇒ 整个模块树加载失败。
 * 因此这里统一映射到一个「万能桩模块」（由预览页内联注册）。
 *
 * @param {string} base 插件资源代理基址
 * @returns {string}
 */
function buildHostImportMap(base) {
    const stubUrl = base + '__jsk_host_stub__.js';
    // 常见宿主模块名（酒馆核心 + 第三方常用）
    const bare = [
        'jquery', 'lodash', 'moment', 'handlebars', 'showdown', 'dompurify',
        'toastr', 'dayjs', 'localforage', 'yaml', 'zod',
    ];
    const imports = {};
    for (const name of bare) imports[name] = stubUrl;
    // 酒馆源码里的绝对路径 import（'/script.js'、'/scripts/xxx.js'）
    imports['/script.js'] = stubUrl;
    imports['/scripts/extensions.js'] = stubUrl;
    imports['/scripts/events.js'] = stubUrl;
    imports['/scripts/world-info.js'] = stubUrl;
    imports['/scripts/power-user.js'] = stubUrl;
    imports['/scripts/st-context.js'] = stubUrl;
    imports['/scripts/utils.js'] = stubUrl;
    // ⚠️ 插件常写相对路径「向上跨出插件目录」去 import 酒馆核心模块，例如
    //      import(new URL('../../../personas.js', import.meta.url))
    //    相对插件资源 URL 会被解析成 app://index.html/personas.js ⇒ 404
    //    （真实案例：ST-iPhonie，控制台报 personas.js 404）。
    //    importmap 无法用通配符覆盖所有相对深度，因此这里把「酒馆根目录下的常见核心文件」
    //    全部映射到桩：浏览器解析出 app://index.html/personas.js 时会先查 importmap
    //    的 imports 表（键为完整 URL），命中即用桩替代。
    const CORE_AT_ROOT = [
      'personas.js', 'script.js', 'scripts.js', 'secrets.js', 'group-chats.js',
      'chats.js', 'characters.js', 'world-info.js', 'preset-manager.js',
      'sysprompt.js', 'reasoning.js', 'user.js', 'openai.js',
      'scripts/personas.js', 'scripts/group-chats.js', 'scripts/characters.js',
      'scripts/chats.js', 'scripts/world-info.js', 'scripts/preset-manager.js',
      'scripts/sysprompt.js', 'scripts/reasoning.js', 'scripts/extensions.js',
      'scripts/events.js', 'scripts/utils.js', 'scripts/power-user.js',
      'scripts/st-context.js', 'scripts/secrets.js', 'scripts/user.js',
    ];
    for (const rel of CORE_AT_ROOT) {
      imports['app://index.html/' + rel] = stubUrl;
    }

    const json = JSON.stringify({ imports }, null, 0);
    return `<script type="importmap">${json.replace(/</g, '\\u003c')}</script>`;
}

export function buildPluginPreviewHtml(plugin, opts = {}) {
    const bundleJs = opts.bundleJs || [];
    // 🧩 扩展工程「多文件模块表」：{ 相对路径: 源码 }。
    //    现代插件是多文件 + 相对 import（index.js → './core.js'），
    //    必须按真实文件解析依赖，否则所有 import 都落到「万能 Proxy」返回 NOOP 函数，
    //    插件随后对函数取属性 ⇒ `Cannot read properties of undefined`
    //    （reading 'function(){ return undefined; }'）。真实案例：AutoRandomInput 随机指令。
    const bundleModules = (opts.bundleModules && typeof opts.bundleModules === 'object')
        ? opts.bundleModules : null;
    const bundleCss = opts.bundleCss || [];
    const templates = opts.templates || {}; // 扩展工程 html 模板映射 { 相对路径: 内容 }
    // [PATH] 预览 id：用于把插件里的相对资源路径改写成代理 URL（解决「资源加载不出来」）
    const previewId = opts.previewId || '';
    // JSON 序列化时转义 '<'，防模板内容里的 </script> 提前终止注入块
    const templatesJson = JSON.stringify(templates).replace(/</g, '\\u003c');

    const inlineScripts = []; // 需要注入的 JS 源码块
    const styles = [];        // 需要注入的 CSS 文本
    const isExtension = plugin.kind === 'extension';

    if (isExtension) {
        // 扩展工程：内联 manifest 入口 bundle + css
        for (const css of bundleCss) styles.push(css);
        for (const js of bundleJs) inlineScripts.push(js);
    } else {
        // 酒馆助手 / userscript / SlashRunner：内联 scripts[].content
        for (const s of (plugin.scripts || [])) {
            if (s.content) inlineScripts.push(s.content);
        }
    }

    // [PATH] 插件自身 CSS 里的相对资源（url(./img/a.png)、@import './theme.css'）改写成代理 URL
    const cssBlock = styles
        .map(c => `<style>${previewId ? rewritePluginResourcePaths(c, previewId) : c}</style>`)
        .join('\n');

    // [PROBE] 静态透视（只用于「跑完没内容」时解释原因，**不影响渲染决策**）
    //    注意：此处扫描的是原始源码（inlineScripts），不是剥离 ESM 后的版本。
    const probeData = probePluginSource({
        source: inlineScripts.join('\n'),
        hasTemplates: Object.keys(templates || {}).length > 0,
        hasCss: styles.length > 0,
        pluginKind: plugin.kind
    });
    // 转义为可安全嵌入 <script> 的字符串字面量
    const probeHtmlLiteral = JSON.stringify(renderProbeHtml(probeData)).replace(/</g, '\\u003c');

    // [CARD] 能力说明书（纯逻辑插件专用）：由渲染层预先算好传入（opts.capability）。
    //    优先用它替换默认透视卡 —— 它对「后台逻辑插件」的解释更具体
    //    （在什么时机跑、注册了哪些命令、读写什么数据）。
    //    [!] 仍然只在「2 秒空白自检判定无可见内容」时显示，绝不阻止沙箱渲染。
    const capInfo = (opts && opts.capability && opts.capability.capHtml) ? opts.capability : null;
    const capCssBlock = capInfo && capInfo.capCss ? `<style>${String(capInfo.capCss).replace(/<\/style>/gi, '')}</style>` : '';
    const capHtmlLiteral = capInfo
        ? JSON.stringify(String(capInfo.capHtml)).replace(/</g, '\\u003c')
        : probeHtmlLiteral;
    // 🧩 扩展工程：真实 ESM 入口（由 manifest 决定，浏览器自行解析整棵依赖树）
    //    entry 来自渲染层（manifest.js 的相对路径，已由 pluginScanner 解析）
    //    ⚠️ 模块块存在时，**不再内联 bundleJs** —— 否则同一份代码会执行两次
    //    （一次由浏览器 ESM 加载、一次被我们内联），产生重复注册/重复监听。
    const moduleRuntimeBlock = buildModuleRuntimeBlock(bundleModules, isExtension, {
        previewId: previewId,
        entry: opts.entry || '',
    });
    const scriptBlocks = moduleRuntimeBlock || inlineScripts.map(src => {
        // 剥离 userscript 头（// ==UserScript== ... // ==/UserScript==）避免注释干扰（实际无害，但保持干净）
        let cleaned = src.replace(/^[\s\S]*?==\/UserScript==\s*/i, '');
        // 脚本内 </script> 提前终止风险：替换为转义形式
        cleaned = cleaned.replace(/<\/script>/gi, '<\\/script>');
        if (isExtension) {
            // 仅当无法走真实 ESM（缺 previewId/entry）时才兜底：重写 import/export 后内联。
            cleaned = rewriteEsmModule(cleaned);
            return `<script type="module">\n${cleaned}\n</script>`;
        }
        // 其他脚本：剥离 ESM 语法（import / export）后用普通 <script> 注入，
        // 避免内联 <script> 报 Unexpected token 'export'
        cleaned = stripEsmSyntax(cleaned);
        return `<script>\n${cleaned}\n</script>`;
    }).join('\n');

    // ESM 插件（如 statusSystem.js 的 export default {...}）剥离后落在 window.__jskPluginDefault，
    // 这里自动触发其 install()，让命令 / 模块得以注册。
    // 扩展 bundle 用 <script type="module">（deferred），故 bootstrap 也须用 module 以保证在其后执行；
    // 普通脚本为同步执行，bootstrap 保持普通 <script> 紧随其后即可。
    const bootstrapTag = isExtension ? 'script type="module"' : 'script';
    const bootstrapBlock = `<${bootstrapTag}>
try {
  if (window.__jskPluginDefault && typeof window.__jskPluginDefault.install === 'function') {
    window.__jskPluginDefault.install();
  }
} catch(e) { console.error('[plugin bootstrap]', e); }
// 若插件只注册了 SlashRunner 命令（无 UI），自动演示第一条命令，保证「效果」页有反馈
try {
  const names = Object.keys((window.SlashRunner && window.SlashRunner.commands) || {});
  if (names.length && !document.querySelector('#chat *')) {
    const first = window.SlashRunner.commands[names[0]];
    const r = first && first.cb ? first.cb() : undefined;
    if (r !== undefined && r !== null) console.log('[SlashRunner 演示]', names[0], r);
  }
} catch(e) { console.error(e); }
// 自动演示扩展菜单项：轮询查找脚本注入的菜单项并触发点击，让弹窗/面板自动展开，
// 使「效果」页第一眼就能看到真实 UI（如圆形颜色按钮 + 白底弹窗），而非仅一行文字菜单。
try {
  var __jskDemoTries = 0;
  var __jskDemoTimer = setInterval(function(){
    __jskDemoTries++;
    var item = document.querySelector('#extensionsMenu [id$="-menu-item"], #extensionsMenu .list-group-item, #extensionsMenu [class*="menu-item"]');
    if (item) {
      clearInterval(__jskDemoTimer);
      try { item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      catch(e2) { try { item.click(); } catch(e3) {} }
      // 桌面应用内诊断：点击菜单项后延迟检测弹窗/圆形按钮，把结果打到 renderer 日志
      setTimeout(function(){
        try {
          var dlg = document.querySelector('dialog[open]');
          var circular = dlg ? Array.prototype.filter.call(dlg.querySelectorAll('*'), function(el){ try { return getComputedStyle(el).borderRadius === '50%'; } catch(e){ return false; } }).length : 0;
          console.log('[效果诊断] 弹窗打开=' + !!dlg + ' | 圆形按钮=' + circular + ' | 弹窗背景=' + (dlg ? getComputedStyle(dlg).backgroundColor : '无'));
        } catch(e) { console.error('[效果诊断]', e); }
      }, 900);
    } else if (__jskDemoTries > 25) {
      clearInterval(__jskDemoTimer);
      console.log('[效果诊断] 未找到可点击的扩展菜单项');
    }
  }, 200);
} catch(e) { console.error(e); }
</script>`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${buildTavernThemeCss()}
html,body{width:100%;height:100%;margin:0;background:var(--SmartThemeBlurTintColor,#18181b);color:var(--SmartThemeBodyColor,#e4e4e7);font-family:var(--SmartThemeFontFamily,system-ui,-apple-system,sans-serif);font-size:var(--SmartThemeFontScale,15px);overflow:auto;}
#host-banner{position:sticky;top:0;z-index:99999;padding:4px 12px;font-size:11px;background:#27272a;border-bottom:1px solid #3f3f46;color:#a1a1aa;}
/* [NAV] 挂载点导航条：插件把 UI 塞进了用户看不见的区域（折叠面板/侧栏）时，
   用胶囊导航指路 + 点击平滑滚动，绝不移动 DOM 顺序（会破坏插件的父子选择器）。 */
#jsk-mount-nav{position:sticky;top:22px;z-index:99998;display:none;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 12px;background:#1f1f23;border-bottom:1px solid #3f3f46;font-size:11px;color:#a1a1aa;}
#jsk-mount-nav .jsk-nav-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:#2b2b31;border:1px solid #3f3f46;color:#e4e4e7;cursor:pointer;transition:background .15s,border-color .15s;}
#jsk-mount-nav .jsk-nav-pill:hover{background:#3f3f46;border-color:#8b5cf6;}
#jsk-mount-nav .jsk-nav-hint{color:#71717a;}
@keyframes jsk-breathe{0%,100%{outline-color:rgba(139,92,246,0);}50%{outline-color:rgba(139,92,246,.95);}}
.jsk-nav-highlight{outline:2px solid #8b5cf6;outline-offset:2px;animation:jsk-breathe 1.5s ease-in-out;}
/* [PLUGIN] 酒馆风格扩展菜单项 */
/* [!] 不要在这里写 #extensionsMenu 的 display/flex-direction —— 骨架 hostStubDom.js
   已经定义了横向 flex-wrap 布局，这里再写纵向 column 会冲突覆盖。 */
#extensionsMenu .extension_container,
#extensionsMenu .list-group-item,
#extensionsMenu [class*="menu-item"]{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:var(--SmartThemeBotMesBlurTintColor,#2b2b31);color:var(--SmartThemeBodyColor,#e4e4e7);font-size:12px;cursor:pointer;border:1px solid var(--SmartThemeBorderColor,#3f3f46);transition:background .15s,border-color .15s;white-space:nowrap;}
#extensionsMenu .list-group-item:hover,
#extensionsMenu [class*="menu-item"]:hover{background:var(--SmartThemeQuoteColor,#3f3f46);border-color:var(--SmartThemeEmColor,#8b5cf6);}
#extensionsMenu .extensionsMenuExtensionButton{width:14px;text-align:center;color:var(--SmartThemeEmColor,#a78bfa);}
</style>
${cssBlock}
${capCssBlock}
</head>
<body>
<!-- [WARN] 横幅与导航条已移入 buildHostDom() 的 #jsk-topbar 内（避免弹窗遮挡，见 hostStubDom.js 注释） -->
<!-- [DIAG] 空白兜底：插件跑完但没产出任何可见 UI 时，显示自检信息而不是一片纯白
     （用户实测「效果页一片空白」—— 之前连"为什么空"都看不出来）。 -->
<div id="jsk-empty-hint" style="display:none;padding:24px;color:#a1a1aa;font-size:13px;line-height:1.8;">
  <div style="font-size:15px;color:#e4e4e7;font-weight:600;margin-bottom:8px;">[PLUGIN] 插件已载入，但没有产出可见界面</div>
  <div>这通常意味着以下几种情况之一：</div>
  <ul style="margin:8px 0 8px 20px;padding:0;">
    <li>插件只在聊天/消息楼层里生效（如正则改写、状态栏），不在独立页面显示</li>
    <li>插件需要先点击扩展菜单按钮才展开面板（下方菜单区若是空的，说明它没注册菜单项）</li>
    <li>插件运行时报错 —— 按 <strong>F12</strong>（或 Ctrl+Shift+I）打开开发者工具查看 Console</li>
  </ul>
  <div id="jsk-empty-stats" style="margin-top:10px;color:#71717a;font-size:12px;"></div>
  <!-- [PROBE] 插件能力透视卡：仅在「跑完没产出可见 UI」时填充（绝不阻止渲染） -->
  <div id="jsk-empty-probe" style="display:none;"></div>
</div>
<!-- [SYNTAX] 插件源码语法错误提示：无条件检测，一旦命中即强制显示。
     必须在 jsk-empty-hint 之外，否则会被「有产出就不显示」的逻辑连带隐藏。 -->
<div id="jsk-syntax-hint" style="display:none;margin:16px 24px;padding:14px 16px;border-radius:10px;
     background:rgba(220,38,38,.14);border-left:3px solid #dc2626;font-size:13px;line-height:1.7;"></div>
${buildHostDom(plugin)}
<script>
window.__jskHost = true;
// [DIAG] 错误收集：供「空白兜底」自检显示（插件脚本报错是"空白"的常见原因）
//       特别区分「插件源码语法错误」——这类错误是插件自身的问题，
//       不是预览功能坏了，必须明确告知用户，否则只会得到「这软件不行」的结论。
try {
  window.__jskErrCount = 0;
  window.__jskSyntaxErrors = [];
  window.addEventListener('error', function(ev){
    window.__jskErrCount++;
    try {
      var msg = String((ev && (ev.message || (ev.error && ev.error.message))) || '');
      if (/SyntaxError|Invalid or unexpected token|Unexpected token|Unexpected end/.test(msg)) {
        var line = ev && ev.lineno ? (' 第 ' + ev.lineno + ' 行') : '';
        window.__jskSyntaxErrors.push(msg + line);
      }
    } catch (e) {}
  });
  window.addEventListener('unhandledrejection', function(){ window.__jskErrCount++; });
} catch(e) {}
</script>
<script>${buildMiniJquery()}</script>
<script>${lodashSource}</script>
<script>${handlebarsSource}</script>
<script>${showdownSource}</script>
<script>${dompurifySource}</script>
<script>window.__jskTemplates = ${templatesJson};</script>
<script>${buildEventSourceStub()}</script>
<script>${buildGlobalStubs(plugin, { previewId: previewId })}</script>
${scriptBlocks}
${bootstrapBlock}
<script>
/* ────────────────────────────────────────────────────────────────────────────
 * [START] 初始化事件脉冲（2026-10-25 上游 Q2 拍板）
 *
 * 为什么需要：大量插件不是「载入即渲染」，而是等 CHAT_CHANGED / APP_READY 才动手。
 * 空环境里它们永远不动 → 用户看到空白 → 以为软件坏了。
 *
 * 为什么只发这三件套：APP_READY / SETTINGS_LOADED / CHAT_CHANGED 都是「初始化」语义，
 * 插件收到后只会读数据、建 UI，**不会**去请求 LLM。
 * 而 CHARACTER_MESSAGE_RENDERED / MESSAGE_RECEIVED 是「消息」语义 —— 插件收到后可能
 * 真的调 generateQuietPrompt() 发网络请求、或把假消息写进变量树。故**绝不自动触发**，
 * 交由预览栏顶部「💬 模拟收到 AI 消息」按钮手动派发（见下）。
 * ──────────────────────────────────────────────────────────────────────────── */
try {
  setTimeout(function(){
    // ① 先把模拟会话渲染成真实 .mes 气泡 —— 必须早于事件派发：
    //    插件收到 chat_id_changed 后常立刻 querySelector('.mes') 取消息，此时 DOM 必须已有内容。
    try { if (window.__jskRenderChat) window.__jskRenderChat(); } catch(e) {}
    try { window.eventSource && window.eventSource.emit && window.eventSource.emit('app_ready'); } catch(e) {}
    try { window.eventSource && window.eventSource.emit && window.eventSource.emit('settings_loaded'); } catch(e) {}
    try { window.eventSource && window.eventSource.emit && window.eventSource.emit('extension_settings_loaded'); } catch(e) {}
    try { window.eventSource && window.eventSource.emit && window.eventSource.emit('chat_id_changed', 'jsk-preview-chat'); } catch(e) {}
    console.log('[效果诊断] 已派发初始化事件：app_ready / settings_loaded / extension_settings_loaded / chat_id_changed');
  }, 100);

  /* [NAV] 挂载点导航条：把「插件真的往里塞了东西」的区域指出来。
     绝不移动 DOM —— 移动会破坏插件依赖的父子层级 CSS 选择器。

     [!] 判定必须严格（历史教训）：早期用「childElementCount > 0」就算命中，
        结果 #chat 里只要有我们预置的聊天气泡、或空容器 —— 导航胶囊就出现，
        但点下去完全空白。这是假信号，比没有导航更误导。
        现在改为：只认「有实际尺寸 + 有可见文字/图片」的节点，且排除占位容器。 */
  var __jskMounts = [
    { id: 'chat',                   icon: '💬', label: '聊天区' },
    { id: 'extensions_settings',    icon: '⚙️', label: '扩展设置' },
    { id: 'extensions_settings2',   icon: '⚙️', label: '扩展设置 2' },
    { id: 'extensionsMenu',         icon: '🪄', label: '魔法棒菜单' },
    { id: 'leftSendForm',           icon: '🔘', label: '发送区按钮' }
  ];

  /** 统计某挂载点里「真正可见的插件内容」数量（排除气泡自身与空壳容器） */
  function __jskCountVisible(root) {
    if (!root) return 0;
    var n = 0;
    var kids = root.querySelectorAll('*');
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.classList && el.classList.contains('mes')) continue; // 模拟气泡不算插件产出
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'template') continue;
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) continue;
      var text = (el.textContent || '').trim();
      var hasImg = el.querySelector && el.querySelector('img,canvas,svg,video,input,button,select,textarea');
      if (text.length > 1 || hasImg || tag === 'img' || tag === 'canvas' || tag === 'svg' || tag === 'button' || tag === 'input') n++;
    }
    return n;
  }

  function __jskBuildNav() {
    var nav = document.getElementById('jsk-mount-nav');
    if (!nav) return;
    var hits = [];
    __jskMounts.forEach(function(it){
      var el = document.getElementById(it.id);
      if (!el) return;
      var n = __jskCountVisible(el);
      if (n > 0) hits.push({ it: it, n: n });
    });
    if (!hits.length) { nav.style.display = 'none'; return; }
    nav.innerHTML = '<span class="jsk-nav-hint">📍 检测到插件界面已注入：</span>';
    hits.forEach(function(h){
      var pill = document.createElement('span');
      pill.className = 'jsk-nav-pill';
      pill.textContent = h.it.icon + ' ' + h.it.label + ' (' + h.n + ')';
      pill.addEventListener('click', function(){
        var el = document.getElementById(h.it.id);
        if (!el) return;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) { el.scrollIntoView(); }
        el.classList.add('jsk-nav-highlight');
        setTimeout(function(){ el.classList.remove('jsk-nav-highlight'); }, 1600);
      });
      nav.appendChild(pill);
    });
    nav.style.display = 'flex';
    console.log('[效果诊断] 挂载点导航：' + hits.map(function(h){ return h.it.label + '=' + h.n; }).join(' / '));
  }

  // 多轮检测：插件常有二次渲染（异步请求 / setTimeout 后才塞 DOM）
  setTimeout(__jskBuildNav, 500);
  setTimeout(__jskBuildNav, 1500);
  setTimeout(__jskBuildNav, 3000);
  window.__jskRebuildNav = __jskBuildNav;
} catch(e) { console.error('[效果诊断] 初始化脉冲失败', e); }
</script>
<script>
// 效果就绪信号：宿主桩加载完脚本后，把 #chat 内是否产生内容回传到 banner
try {
  setTimeout(function(){
    const chat = document.getElementById('chat');
    const kids = chat ? chat.querySelectorAll('*').length : 0;
    const banner = document.getElementById('host-banner');
    if (banner) banner.textContent += ' · 已注入 ' + ${inlineScripts.length} + ' 个脚本 · #chat 节点 ' + kids + ' 个';
  }, 300);
} catch(e){}

// [DIAG] 空白兜底：2 秒后若页面仍没有任何「插件真正产出」的内容，就展示能力卡 / 自检提示。
//
// [BUG] 2026-11-08 修正：旧逻辑遍历 body > * 看「有尺寸 + 有文字」，
//    但 #jsk-host-workbench 本身有尺寸、且 textContent 含顶部横幅文字，
//    于是 visible 恒 >= 1 -> 自检永远不触发 -> 纯逻辑插件的空白永远没人解释。
//    现在改为**只统计插件注入节点**（与挂载嗅探同一口径）。
try {
  setTimeout(function(){
    try {
      var hint = document.getElementById('jsk-empty-hint');
      if (!hint) return;

      var HOST_IDS = {
        'host-banner': 1, 'jsk-empty-hint': 1, 'jsk-mount-nav': 1,
        'jsk-topbar': 1, 'jsk-host-workbench': 1, 'jsk-host-content': 1,
        'jsk-toast-dock': 1, 'jsk-empty-probe': 1
      };
      var SHELL_IDS = {
        chat: 1, 'chat-history': 1, options: 1, extensionsMenu: 1, extensionsMenuButton: 1,
        send_form: 1, leftSendForm: 1, rightSendForm: 1, send_textarea: 1,
        extensions_settings: 1, extensions_settings2: 1,
        message_template: 1, zoomed_avatar_template: 1, sheld: 1,
        'right-nav-panel': 1, movingDivs: 1
      };

      function isShell(el) {
        if (!el || !el.id) return false;
        if (SHELL_IDS[el.id]) return true;
        return /_container$/.test(el.id) || /_wand_container$/.test(el.id);
      }

      var produced = 0;
      var all = document.body.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el.tagName) continue;
        var tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'template') continue;
        if (el.id && HOST_IDS[el.id]) continue;
        if (el.classList && el.classList.contains('mes')) continue;
        if (isShell(el)) continue;

        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || r.width <= 0 || r.height <= 0) continue;

        var ownText = '';
        for (var c = 0; c < el.childNodes.length; c++) {
          var nd = el.childNodes[c];
          if (nd.nodeType === 3) ownText += nd.nodeValue;
        }
        ownText = ownText.trim();
        var isControl = /^(img|canvas|svg|video|input|button|select|textarea|iframe)$/.test(tag);
        if (ownText.length > 1 || isControl) produced++;
      }

      if (produced === 0) {
        var stats = document.getElementById('jsk-empty-stats');
        if (stats) {
          stats.textContent = '诊断：注入脚本 ' + ${inlineScripts.length} + ' 个'
            + ' · 插件产出节点 ' + produced + ' 个'
            + ' · 控制台错误 ' + (window.__jskErrCount || 0) + ' 条';
        }
        // [PLUGIN] 静态能力透视卡（上游 Q5 拍板：只作附加信息，绝不阻止渲染 —— 此时渲染已经跑完了）
        var probe = document.getElementById('jsk-empty-probe');
        if (probe) {
          probe.innerHTML = ${capHtmlLiteral};
          probe.style.display = 'block';
        }
        hint.style.display = 'block';
        console.log('[效果诊断] 未产出可见 UI，已显示自检提示 + 透视卡');
      }

      // 🩺 插件源码语法错误提示 —— 必须「无条件」检查并强制显示。
      //    历史教训：原先只在 produced===0 时才显示，而插件即使语法报错，
      //    宿主骨架本身也会产出几十个节点（produced=23），于是提示被永久隐藏，
      //    用户只能看到控制台里一条没人看得懂的 SyntaxError。
      try {
        var synErrs = (window.__jskSyntaxErrors || []).slice(0, 3);
        if (synErrs.length) {
          var sBox = document.getElementById('jsk-syntax-hint');
          if (sBox) {
            sBox.innerHTML = '';
            var head = document.createElement('div');
            head.style.cssText = 'font-weight:600;color:#fca5a5;margin-bottom:6px;';
            head.textContent = '插件脚本存在语法错误 —— 这是插件源码的问题，不是预览功能的问题';
            sBox.appendChild(head);
            var list = document.createElement('div');
            list.style.cssText = 'color:#e4e4e7;opacity:.88;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;';
            list.textContent = synErrs.join('\\n');
            sBox.appendChild(list);
            var foot = document.createElement('div');
            foot.style.cssText = 'margin-top:8px;opacity:.7;line-height:1.6;';
            foot.textContent = '这个插件在真实酒馆里同样会报错，需要修改插件源码（常见原因：注释换行导致后半行变成真代码）。';
            sBox.appendChild(foot);
            sBox.style.display = 'block';
          }
        }
      } catch (eSyn) { console.error('[效果诊断] 语法错误提示异常', eSyn); }
    } catch(e) {
      console.error('[效果诊断] 自检脚本异常', e);
      // [BUG] 把自检自身的异常显示到页面上 —— 历史上正是这里被静默吞掉，
      //    导致「produced===0 但提示不显示」查了很久。
      try {
        var h2 = document.getElementById('jsk-empty-hint');
        var st2 = document.getElementById('jsk-empty-stats');
        if (h2) h2.style.display = 'block';
        if (st2) st2.textContent = '[!] 自检脚本异常：' + (e && e.message ? e.message : String(e));
      } catch (e2) { /* ignore */ }
    }
  }, 2000);
} catch(e){}
</script>
</body>
</html>`;
}

/** 剥离 ESM 语法（import / export），供内联 <script> 注入使用 */
function stripEsmSyntax(src) {
    return stripEsmSyntaxPure(src);
}

/** HTML 转义（插件名等注入到标签间时防破坏结构） */
function escapeHtml(s) {
    return escapeHtmlPure(s);
}
