/**
 * 真实数据端到端验证：stripInternalFields 对 11k 真实卡片的清洗效果
 *
 * 做法：从大库中挑出**真的含有** `_` 开头第三方字段的卡片 → 取出 chara JSON →
 *       模拟前端污染（往 character_book 词条注入 uid / _collapsed）→ 过清洗 →
 *       断言 ① 注入的字段被剔除 ② 第三方真实字段一个不少 ③ 其余内容逐字节不变。
 *
 * 用法：node scripts/tools/save-strip-real-cards.mjs [库根目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripInternalFields } = require('../../main/cardFieldSanitizer.js');

const ROOT = process.argv[2] || 'I:\\03\\角色色卡';

/** 从 PNG tEXt/chara 块取出角色卡 JSON 文本 */
function readCardJson(buf) {
  for (const kw of ['chara', 'ccv3']) {
    const i = buf.indexOf(`tEXt${kw}\0`, 0, 'latin1');
    if (i < 0) continue;
    const len = buf.readUInt32BE(i - 4);
    const b64 = buf.toString('latin1', i + 4 + kw.length + 1, i + 4 + len);
    try { return { text: Buffer.from(b64, 'base64').toString('utf-8'), kw }; } catch { /* next */ }
  }
  return null;
}

function collectFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}

/** 找出所有「非内部 _ 字段 / uid」的路径（用审计脚本同款判定） */
function foreignFields(obj) {
  const INTERNAL = new Set(['_collapsed', '_mtime', '_ctime', '_size', '_importTime', '_srcIndex', '_srcUid']);
  const found = [];
  (function walk(o, p) {
    if (o && typeof o === 'object') {
      if (Array.isArray(o)) return o.forEach((v) => walk(v, `${p}[]`));
      for (const [k, v] of Object.entries(o)) {
        if ((k.startsWith('_') && !INTERNAL.has(k)) || k === 'uid') found.push(`${p}/${k}`);
        walk(v, `${p}/${k}`);
      }
    }
  })(obj, '');
  return found;
}

const files = collectFiles(ROOT);
console.log('扫描文件:', files.length);

let checked = 0, withForeign = 0, injected = 0;
const failures = [];
const seenFieldNames = new Set();

for (const file of files) {
  if (checked >= 4000) break;
  let json;
  try {
    const got = readCardJson(fs.readFileSync(file));
    if (!got) continue;
    json = JSON.parse(got.text);
  } catch { continue; }
  checked++;

  const foreignBefore = foreignFields(json);
  if (foreignBefore.length === 0) continue;
  withForeign++;
  foreignBefore.forEach((f) => seenFieldNames.add(f.replace(/\[\]/g, '[]').split('/').slice(-2).join('/')));

  // —— 模拟前端污染：给每个内嵌世界书词条注入 uid / _collapsed ——
  const beforeInject = JSON.parse(JSON.stringify(json)); // 注入前快照 = 理想清洗结果
  const book = json.character_book || (json.data && json.data.character_book);
  const entries = Array.isArray(book) ? book : (book && Array.isArray(book.entries) ? book.entries : null);
  if (entries && entries.length) {
    entries.forEach((e, i) => { if (e && typeof e === 'object') { e.uid = 900000 + i; e._collapsed = i % 2 === 0; } });
    injected++;
  }

  const cleaned = stripInternalFields(json);

  // ① 注入字段必须被剔除
  const book2 = cleaned.character_book || (cleaned.data && cleaned.data.character_book);
  const entries2 = Array.isArray(book2) ? book2 : (book2 && Array.isArray(book2.entries) ? book2.entries : null);
  if (entries2) {
    for (const [i, e] of entries2.entries()) {
      if ('uid' in e || '_collapsed' in e) failures.push(`${path.basename(file)} 词条[${i}] 未剔除注入字段`);
    }
  }

  // ② 第三方真实字段必须一个不少
  const foreignAfter = new Set(foreignFields(cleaned));
  for (const f of foreignBefore) {
    if (!foreignAfter.has(f)) failures.push(`${path.basename(file)} 真实字段被误删: ${f}`);
  }

  // ③ 除「我们注入的那两处」外，清洗结果必须与原卡片**完全一致**（逐字段）
  //    beforeInject 是注入前的原样快照，正是理想输出
  const diffs = [];
  (function cmp(a, b, p) {
    if (diffs.length > 4) return;
    if (a === b) return;
    const ta = a === null ? 'null' : typeof a, tb = b === null ? 'null' : typeof b;
    if (ta !== tb || ta !== 'object') { diffs.push(`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); return; }
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of ka) if (!(k in b)) diffs.push(`${p}/${k}: 被删除`);
    for (const k of kb) if (!(k in a)) diffs.push(`${p}/${k}: 凭空新增`);
    for (const k of ka) if (k in b) cmp(a[k], b[k], `${p}/${k}`);
  })(beforeInject, cleaned, '');
  if (diffs.length) failures.push(`${path.basename(file)} 清洗结果与原卡不一致 → ${diffs.slice(0, 4).join(' | ')}`);

  if (failures.length > 12) break;
}

console.log('解析卡片:', checked, ' 含第三方 _ / uid 字段:', withForeign, ' 实际注入污染的:', injected);
console.log('第三方字段种类（去重后）:');
for (const f of [...seenFieldNames].sort()) console.log('   ', f);
console.log(failures.length ? `\n❌ 失败 ${failures.length} 条:` : '\n✅ 全部通过：注入字段已剔除，第三方真实字段 0 丢失，其余内容逐字节一致');
failures.slice(0, 12).forEach((f) => console.log('   -', f));
process.exit(failures.length ? 1 : 0);
