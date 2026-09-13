/**
 * 为「真实保存回写」验证准备样本：把大库里含第三方 `_` 字段的真实卡片复制到
 * userData/_strip_verify/（userData 恒在白名单内，不会污染用户卡片库）。
 * 用法：node scripts/save-strip-prep-samples.mjs [库根] [目标目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'I:\\03\\角色色卡';
const DEST = process.argv[3];
if (!DEST) { console.error('需要目标目录'); process.exit(1); }

function readCardJson(buf) {
  for (const kw of ['chara', 'ccv3']) {
    const i = buf.indexOf(`tEXt${kw}\0`, 0, 'latin1');
    if (i < 0) continue;
    const len = buf.readUInt32BE(i - 4);
    const b64 = buf.toString('latin1', i + 4 + kw.length + 1, i + 4 + len);
    try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')); } catch { /* next */ }
  }
  return null;
}

function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}

/** 找出目标第三方字段所在位置 */
function wants(json) {
  const tags = new Set();
  (function walk(o, p) {
    if (o && typeof o === 'object') {
      if (Array.isArray(o)) return o.forEach((v) => walk(v, `${p}[]`));
      for (const [k, v] of Object.entries(o)) {
        if (k === '_filename' && p.includes('character_book/entries')) tags.add('entryExt_filename');
        if (k === '_exportMeta') tags.add('exportMeta');
        walk(v, `${p}/${k}`);
      }
    }
  })(json, '');
  return tags;
}

fs.mkdirSync(DEST, { recursive: true });
const need = new Map([['entryExt_filename', null], ['exportMeta', null]]);
const files = collect(ROOT);
for (const f of files) {
  if ([...need.values()].every(Boolean)) break;
  let json;
  try { json = readCardJson(fs.readFileSync(f)); } catch { continue; }
  if (!json) continue;
  const tags = wants(json);
  for (const t of tags) {
    if (need.get(t)) continue;
    const dest = path.join(DEST, `sample-${t}.png`);
    fs.copyFileSync(f, dest);
    need.set(t, { src: f, dest, name: json.name || json.data?.name });
  }
}
for (const [k, v] of need) {
  console.log(v ? `✔ ${k}\n    源: ${v.src}\n    名: ${v.name}\n    目标: ${v.dest}` : `✖ ${k} 未找到`);
}
console.log('\nDEST=' + DEST);
