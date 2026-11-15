/**
 * 清理插件模块中注释里的 emoji（保留代码字符串里的）
 *
 * 为什么：构建/热更新链路里这些 4 字节 emoji 有被截断成孤立代理字符的风险，
 * 一旦出现在内联 <script> 里就是 `Invalid or unexpected token`，整个脚本块报废。
 * 注释里的 emoji 没有任何功能价值，换成 ASCII 标记零风险。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'js/plugins/hostStub.js',
  'js/plugins/hostStubDom.js',
  'js/plugins/hostStubProbe.js',
  'js/plugins/hostStubPure.js',
  'js/plugins/pluginClassify.js',
  'js/plugins/themePreview.js',
  'js/plugins/capabilityCard.js',
];

// emoji → ASCII 替换表（只处理注释里的）
const MAP = [
  [/🐞/g, '[BUG]'],
  [/🧩/g, '[PLUGIN]'],
  [/🎨/g, '[THEME]'],
  [/🗂️?/g, '[PATH]'],
  [/🚀/g, '[START]'],
  [/🩺/g, '[DIAG]'],
  [/🔍/g, '[PROBE]'],
  [/🧠/g, '[CARD]'],
  [/🧭/g, '[NAV]'],
  [/🚧/g, '[WARN]'],
  [/📌/g, '[NOTE]'],
  [/📝/g, '[NOTE]'],
  [/🗄️?/g, '[DATA]'],
  [/✨/g, '[FX]'],
  [/🛠️?/g, '[FIX]'],
  [/💡/g, '[TIP]'],
  [/🎧/g, '[EVENT]'],
  [/🔧/g, '[API]'],
  [/⌘/g, '[CMD]'],
  [/⚠️?/g, '[!]'],
  [/✅/g, '[OK]'],
  [/❌/g, '[X]'],
  [/🎈/g, '[BALLOON]'],
  [/📄/g, '[FILE]'],
  [/🖥️?/g, '[PC]'],
  [/🐛/g, '[BUG]'],
];

let changed = 0;
for (const f of files) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch (e) { continue; }
  const before = src;
  for (const [re, rep] of MAP) src = src.replace(re, rep);
  if (src !== before) {
    writeFileSync(f, src, 'utf8');
    console.log('已清理:', f);
    changed++;
  }
}
console.log('共处理文件:', changed);
