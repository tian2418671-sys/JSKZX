import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import VueDevTools from 'vite-plugin-vue-devtools';
import { rolldown } from 'rolldown';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 🧩 测卡区界面段（状态栏等）用的 iframe 全局环境打包插件
 *
 * 卡内状态栏模板要在 iframe 里拿到 Vue / jQuery / lodash / z(zod) 等全局（见 js/chatHost/iframeGlobals.js
 * 顶部说明），这些库必须由**该 iframe 自己**加载（sandbox 无同源权限，拿不到父页对象）。
 * 这里在 serve/build 时打成一个固定名字的 IIFE 文件，界面段就能用固定 URL 引用：
 *   · 构建：`web/vendor/chat-host.js`（app:// 的 appRoot 即 web/）
 *   · 开发：`<root>/vendor/chat-host.js`（开发态 appRoot 为项目根）
 * 固定文件名是有意的：URL 稳定 → 浏览器可跨 iframe 复用缓存，文档里也只需一行 <script src>。
 */
function chatHostBundle() {
  let root = process.cwd();
  let outDir = 'web';
  let isServe = false;

  async function bundle(outFile) {
    const entry = path.resolve(root, 'js/chatHost/iframeGlobals.js');
    try {
      const b = await rolldown({
        input: entry,
        platform: 'browser',
        // ⚠️ Vue 的 esm-bundler 构建依赖这几个编译期开关（浏览器里没有 process）：
        //    必须写在 `transform.define` 下 —— 顶层 `define` 会被 rolldown 判为无效键直接忽略，
        //    结果是 NODE_ENV 落到 "development"（打进 dev 版 Vue、体积大、还带告警）。
        transform: {
          define: {
            'process.env.NODE_ENV': '"production"',
            __VUE_OPTIONS_API__: 'true',
            __VUE_PROD_DEVTOOLS__: 'false',
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
          }
        }
      });
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await b.write({ format: 'iife', file: outFile, minify: true });
      await b.close();
      const kb = Math.round(fs.statSync(outFile).size / 1024);
      console.log(`[chat-host] 界面段全局环境已生成: ${path.relative(root, outFile)} (${kb} KB)`);
    } catch (e) {
      // 失败不阻断整个构建：界面段会退化为「没有这些全局」（模板自己会在控制台报缺哪个）
      console.warn('[chat-host] 打包失败（界面段将缺少 Vue/zod 等全局）:', e && e.message);
    }
  }

  return {
    name: 'jsk-chat-host-bundle',
    configResolved(cfg) {
      root = cfg.root;
      outDir = cfg.build.outDir;
      isServe = cfg.command === 'serve';
    },
    async buildStart() {
      if (!isServe) return; // 构建走 closeBundle（此时 outDir 刚被清空，稍后写入才留得住）
      await bundle(path.resolve(root, 'vendor/chat-host.js'));
    },
    async closeBundle() {
      if (isServe) return;
      await bundle(path.resolve(root, outDir, 'vendor/chat-host.js'));
    }
  };
}

// SillyTavern 角色卡管理器 - Vite 构建配置
// 使用函数形式按 command 区分：serve = 开发(可视化调试)，build = 生产(不带 devtools)
export default defineConfig(({ command }) => ({
  // 相对路径基准：兼容 Electron app:// 自定义协议加载构建产物（无需服务器）
  base: './',
  // 🖥️ 可视化开发：仅 dev server 启用 Vue DevTools（组件树/状态/事件面板），生产构建自动排除
  plugins: [vue(), chatHostBundle(), ...(command === 'serve' ? [VueDevTools()] : [])],
  resolve: {
    alias: {
      // ⚠️ 关键：项目模板写在 index.html 的 DOM 内（非 SFC 字符串模板），
      // 必须使用 Vue 完整版（含运行时编译器），否则 createApp 挂载 DOM 模板会报错
      vue: 'vue/dist/vue.esm-bundler.js'
    }
  },
  build: {
    outDir: 'web', // 构建产物目录（供 Electron app:// 协议加载）
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome120',
    chunkSizeWarningLimit: 2000
  },
  server: {
    port: 5173,
    strictPort: true,
    open: false
  }
}));
