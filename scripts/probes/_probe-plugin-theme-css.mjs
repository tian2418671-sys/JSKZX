/**
 * 静态校验 buildTavernThemeCss 的产出（不 import hostStub —— 它用了 Vite 的 ?raw 导入，Node 跑不了）
 * 直接从源码文本里抽出函数体，按模板字符串内容断言。
 * 用法：node scripts/probes/_probe-plugin-theme-css.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../../js/plugins/hostStub.js'), 'utf8');

// 抽出 buildTavernThemeCss 里的模板字符串内容
const m = /function buildTavernThemeCss\(\)\s*\{\s*return\s*`([\s\S]*?)`;/.exec(src);
if (!m) {
    console.error('❌ 没找到 buildTavernThemeCss 的模板字符串');
    process.exit(1);
}
const css = m[1];

let fail = 0;
const check = (name, ok, extra) => {
    console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
    if (!ok) fail++;
};

// 1) 必须定义酒馆核心变量
const REQUIRED_VARS = [
    '--SmartThemeBodyColor', '--SmartThemeEmColor', '--SmartThemeQuoteColor',
    '--SmartThemeBorderColor', '--SmartThemeBlurTintColor', '--SmartThemeChatTintColor',
    '--SmartThemeUserMesBlurTintColor', '--SmartThemeBotMesBlurTintColor',
    '--SmartThemeFontFamily', '--SmartThemeFontScale'
];
const missing = REQUIRED_VARS.filter((v) => !css.includes(v + ':'));
check('核心主题变量已定义', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : `共 ${REQUIRED_VARS.length} 个`);

// 2) 必须带常用组件样式
const REQUIRED_CLASSES = [
    '.menu_button', '.list-group-item', '.text_pole', '.inline-drawer',
    'dialog.popup', 'input[type=range]', '.flex-container', '.mes .mes_text'
];
const missCls = REQUIRED_CLASSES.filter((c) => !css.includes(c));
check('常用组件样式已补齐', missCls.length === 0, missCls.length ? '缺: ' + missCls.join(',') : `共 ${REQUIRED_CLASSES.length} 个`);

// 3) 变量兜底：只有**预览 HTML 内联样式**（:root 之外的位置）才需要 fallback；
//    buildTavernThemeCss 的 :root 里已定义变量，内部互相引用无需兜底。
//    ⚠️ 注释里出现的 `var(--SmartThemeXxx)` 是说明文字，不算实际用法 —— 先剥掉注释。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const themeFnBody = m[1];
const outsideTheme = stripComments(src.replace(themeFnBody, ''));
const outsideCalls = outsideTheme.match(/var\(--SmartTheme[A-Za-z0-9]+[^)]*\)/g) || [];
const noFallback = outsideCalls.filter((v) => !v.includes(','));
check('内联样式 var() 均带兜底值', noFallback.length === 0,
    noFallback.length ? '无兜底: ' + noFallback.join(',') : `共 ${outsideCalls.length} 处`);

// 4) buildPluginPreviewHtml 必须调用 buildTavernThemeCss
check('预览 HTML 已注入主题 CSS', /\$\{buildTavernThemeCss\(\)\}/.test(src));

// 5) quotes 的 Unicode 转义必须正确
const q = /quotes:"([^"]+)"/.exec(css);
check('quotes 引号转义正确', !!q && q[1].includes('\\201C'), q ? JSON.stringify(q[1]) : '未找到');

console.log('\n' + (fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`));
process.exit(fail === 0 ? 0 : 1);
