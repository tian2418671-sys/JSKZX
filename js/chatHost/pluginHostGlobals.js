/**
 * 插件「效果」预览页的全局环境（对齐酒馆插件运行时最小集）
 *
 * 与 `iframeGlobals.js`（测卡区界面段用）的区别：
 *   · **不挂 `Vue`** —— 界面段是 Vue SPA 模板，必须要 Vue；而插件预览是外部插件的沙箱，
 *     塞进 Vue 3 运行时会覆盖插件自己期望的 `window.Vue`（有些插件检测到就按 Vue 2 语义走），
 *     属于「不报错但行为错」的静默故障，故此处坚决不挂。
 *   · **不挂 `z` / `zod`** —— 那是 MVU 变量 schema 专用，插件预览不需要。
 *   · 因此体积从 559 KB 降到 ~110 KB（只含 jQuery + lodash）。
 *
 * 本文件由 vite 插件（见 vite.config.mjs `jsk-chat-host-bundle`）打成单文件 IIFE：
 *   · 构建：`web/vendor/plugin-host.js`（app:// 的 appRoot 即 web/）
 *   · 开发：`<root>/vendor/plugin-host.js`
 * 插件预览 HTML 里以 `<script src="app://index.html/vendor/plugin-host.js">` 引用（经典脚本，
 * 必定先于插件自身脚本执行）。
 *
 * ⚠️ 为什么必须上真 jQuery：`hostStub.js` 里曾手写 109 行迷你 `$` 兜底，缺 `$.extend` /
 *    `$.Deferred` / `$.ajax` / 复杂伪类选择器。插件一旦调到缺失方法就是**静默死**（不抛错、
 *    不产 DOM），最终表现和「插件没内容」完全一样，是历史排查的最大黑洞。
 */
import jQuery from 'jquery';
import lodash from 'lodash';

const g = typeof window !== 'undefined' ? window : globalThis;

g.$ = g.jQuery = jQuery;
g._ = g.lodash = lodash;
