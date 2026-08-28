// 扫描：浅色下可能看不清的强调色文字类（-200/-300/-400 级别）与未覆盖的深色类
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
  const re = /["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(src))) {
    m[1].split(/\s+/).forEach(c => {
      // 浅色强调文字：amber/emerald/sky/blue/cyan/orange/rose/pink/purple/indigo/green/red/yellow 的 -200/-300/-400（不含 hover: 前缀的原始类）
      if (/(^|:)text-(amber|emerald|sky|cyan|orange|rose|pink|purple|indigo|green|red|yellow|blue|lime|teal)-(200|300|400)(\/\d+)?$/.test(c)) used.add(c);
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
while ((c = cm.exec(lightBlock))) covered.add(c[1]);

const miss = [...used].filter(c2 => !covered.has(c2) && !covered.has(c2.split('/')[0]));

console.log('=== light 未覆盖的浅色强调文字类 ===');
console.log(miss.sort().join('\n') || '(无)');
