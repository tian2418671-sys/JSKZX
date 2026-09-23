// 精确扫描：使用中但 [data-theme="light"] 未精确覆盖的深色类（含透明度变体）
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith('.vue') || f.endsWith('.js')) out.push(p);
  });
  return out;
}

const files = walk('js');
const used = new Set();

files.forEach(f => {
  const src = fs.readFileSync(f, 'utf8');
  // 提取所有 class="..." 与 :class="..." 字面量里的类
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    m[1].split(/\s+/).forEach(c => {
      if (/(^|:)(bg|text|border)-(zinc|gray|slate|stone|neutral)-[1-9]\d\d(\/\d+)?$/.test(c)) used.add(c);
    });
  }
});

const css = fs.readFileSync('css/style.css', 'utf8');
const lightBlock = css.slice(
  css.indexOf('[data-theme="light"]'),
  css.indexOf('[data-theme="dark"]')
);
const covered = new Set();
const cm = /\[data-theme="light"\]\s+\.([a-zA-Z0-9_\\:\-\/\.]+)/g;
let c;
while ((c = cm.exec(lightBlock))) {
  // CSS 选择器里的 \/50 → 对应类里的 /50
  covered.add(c[1].replace(/\\\//g, '/'));
}

const miss = [];
used.forEach(c2 => {
  // 只关心深色类（zinc/gray 的深色段）
  const isDark = /(^|:)(bg|border)-(zinc|gray)-(7|8|9)\d\d/.test(c2) || /(^|:)text-(zinc|gray)-[12345]\d\d/.test(c2);
  if (!isDark) return;
  if (covered.has(c2)) return;
  // 前缀剥离后检查（hover:bg-zinc-700/50 → bg-zinc-700/50）
  const stripped = c2.replace(/^(hover|disabled|focus|group-hover|active):/, '');
  if (covered.has(stripped)) return;
  miss.push(c2);
});

console.log('使用中深色类:', used.size);
console.log('light 已覆盖:', covered.size);
console.log('=== 精确未覆盖 ===');
console.log(miss.sort().join('\n') || '(无)');
