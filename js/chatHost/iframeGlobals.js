/**
 * 测卡区「界面段」iframe 全局环境（对齐 JS-Slash-Runner 的消息 iframe 环境）
 *
 * JSR 用 `iframe/third_party_message.html` 给每个消息 iframe 注入 Vue / VueRouter / jQuery /
 * jQuery-UI，再用 `predefine.js` 把 TavernHelper / SillyTavern / z（zod）/ _ 等挂到 iframe 上。
 * 卡内状态栏就是靠这些全局运行的 webpack SPA：
 *   · `const Go = z`（zod 命名空间，MVU 变量 schema）—— 缺了顶层就 ReferenceError，整块面板渲染不出来；
 *   · `$(() => …)`（jQuery 就绪）、`_.has(...)`（lodash）。
 *
 * 本文件由 vite 插件（见 vite.config.mjs `jsk-chat-host-bundle`）打成单文件 IIFE，
 * 产物：构建期 `web/vendor/chat-host.js`、开发期 `<root>/vendor/chat-host.js`，
 * 界面段文档里以 `<script src="app://index.html/vendor/chat-host.js">` 引用（经典脚本，
 * 一定先于模板自己的模块脚本执行）。
 */
import * as Vue from 'vue/dist/vue.esm-bundler.js';
import jQuery from 'jquery';
import lodash from 'lodash';
import * as zod from 'zod';

const g = typeof window !== 'undefined' ? window : globalThis;

g.Vue = Vue;
g.$ = g.jQuery = jQuery;
g._ = g.lodash = lodash;
// z：zod 命名空间（Zod 4 里模板用 `z.z.object(...)`，故给模块命名空间而非 `zod` 本身）
g.z = zod;
g.zod = zod;

/** JS-Slash-Runner 的 errorCatched：包一层错误隔离（mock 环境直接返回原函数即可） */
if (typeof g.errorCatched !== 'function') g.errorCatched = (fn) => fn;

/**
 * JS-Slash-Runner 的 waitGlobalInitialized：等某个全局就绪。
 * 与本地预览（北派盗墓笔记 tavern_helper_gui/preview-frame.html）一致：立即 resolve 当前值
 * （拿不到就是 undefined，由调用方自己判），**不要挂着等** —— 否则没有 Mvu 的环境会卡住初始化链。
 */
if (typeof g.waitGlobalInitialized !== 'function') {
    g.waitGlobalInitialized = function waitGlobalInitialized(name) {
        return Promise.resolve(g[name]);
    };
}
