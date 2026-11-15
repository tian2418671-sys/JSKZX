import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'js/plugins/hostStub.js',
  'js/plugins/capabilityCard.js',
  'js/plugins/pluginClassify.js',
  'js/plugins/themePreview.js',
  'js/plugins/hostStubDom.js',
  'js/plugins/hostStubProbe.js',
  'js/components/PluginWorkspace.vue',
];

/** 删除孤立代理字符（被截断的 emoji 残片） */
function stripLoneSurrogates(s) {
  let out = '';
  let removed = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xDC00 && n <= 0xDFFF) { out += s[i] + s[i + 1]; i++; continue; }
      removed++; continue; // 高代理但无配对 → 删
    }
    if (c >= 0xDC00 && c <= 0xDFFF) { removed++; continue; } // 孤立低代理 → 删
    out += s[i];
  }
  return { out, removed };
}

let total = 0;
for (const f of files) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch (e) { continue; }
  const { out, removed } = stripLoneSurrogates(src);
  if (removed > 0) {
    writeFileSync(f, out, 'utf8');
    console.log(`${f}: 清除 ${removed} 个孤立代理字符`);
    total += removed;
  }
}
console.log('合计清除:', total);
