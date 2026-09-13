/**
 * 测卡区「界面段」iframe 全局环境（对齐 JS-Slash-Runner 的消息 iframe 环境）
 *
 * 卡内状态栏是 webpack SPA，直接引用自由变量 `Vue` / `z`(zod) / `_`(lodash) / `$`(jQuery)，
 * JSR 正是靠往消息 iframe 注入这批全局才能渲染。这些库必须由该 iframe 自己加载
 * （sandbox 无同源权限，拿不到父页对象），故打成单文件 IIFE 后用固定 URL 引用：
 *   · 生产：`web/vendor/chat-host.js`（app:// 的 appRoot 即 web/）
 *   · 开发：`<root>/vendor/chat-host.js`（开发态 appRoot 为项目根）
 * 打包由 vite 插件 `jsk-chat-host-bundle` 完成，源文件 js/chatHost/iframeGlobals.js。
 * 固定 URL → 浏览器可跨 iframe 复用同一份缓存。
 */
const CHAT_HOST_URL = 'app://index.html/vendor/chat-host.js';

/** 供界面段文档注入的 `<script src>` 片段（非 Electron 环境返回空串，退回 srcdoc） */
export function chatVendorScriptTags() {
    if (typeof window === 'undefined' || !window.electronAPI) return '';
    return '<script src="' + CHAT_HOST_URL + '"></' + 'script>';
}

/** 全局环境由 iframe 自己按 URL 加载，调用方无需等待什么，恒为就绪 */
export function ensureChatVendor() {
    return Promise.resolve(CHAT_HOST_URL);
}
