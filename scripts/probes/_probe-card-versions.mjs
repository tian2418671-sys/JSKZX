/**
 * 角色卡版本与字段分布勘查（为评估「跨版本查重方案」提供事实依据）
 *
 * 回答：
 *   · V1 / V2 / V3 在真实卡库的分布
 *   · **当前查重忽略了多少信息**（现有 extractContentText 只取 5 个字段）
 *   · V3 新字段（nickname / assets / group_only_greetings）的实际出现率
 *   · character_book 内嵌世界书的出现率（方案主张「单独走世界书管线」）
 *
 * 用法：node scripts/probes/_probe-card-versions.mjs "E:\AI\酒馆工具\角色卡"
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = process.argv[2] || 'E:\\AI\\酒馆工具\\角色卡';

/** 最小 PNG tEXt/iTXt 提取（够用：只取 chara / ccv3） */
function readPngMeta(buf) {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8;
    const out = {};
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tEXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const z = data.indexOf(0);
            if (z > 0) {
                const key = data.toString('latin1', 0, z).toLowerCase();
                if (key === 'chara' || key === 'ccv3') out[key] = data.toString('latin1', z + 1);
            }
        } else if (type === 'iTXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const z = data.indexOf(0);
            if (z > 0) {
                const key = data.toString('latin1', 0, z).toLowerCase();
                if (key === 'chara' || key === 'ccv3') {
                    // iTXt: keyword\0 compFlag\0 compMethod\0 langTag\0 translated\0 text
                    let p = z + 1;
                    const compFlag = data[p]; p += 1;
                    p += 1; // compMethod
                    const e1 = data.indexOf(0, p); p = e1 + 1;
                    const e2 = data.indexOf(0, p); p = e2 + 1;
                    let text = data.subarray(p);
                    if (compFlag) { try { text = zlib.inflateSync(text); } catch { /* 忽略 */ } }
                    out[key] = text.toString('utf8');
                }
            }
        }
        if (type === 'IEND') break;
        off += 12 + len;
    }
    return out;
}

function loadCard(file) {
    const full = path.join(DIR, file);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') {
        try { return { json: JSON.parse(fs.readFileSync(full, 'utf8')), carrier: 'json' }; } catch { return null; }
    }
    if (ext === '.png') {
        const meta = readPngMeta(fs.readFileSync(full));
        if (!meta) return null;
        const raw = meta.ccv3 || meta.chara;
        if (!raw) return null;
        try {
            const s = Buffer.from(raw, 'base64').toString('utf8');
            return { json: JSON.parse(s), carrier: meta.ccv3 ? 'png/ccv3' : 'png/chara' };
        } catch { return null; }
    }
    return null;
}

const files = fs.readdirSync(DIR).filter(f => /\.(png|json)$/i.test(f));
console.log(`═════ 角色卡版本与字段分布 ═════`);
console.log(`目录：${DIR}`);
console.log(`文件：${files.length} 个（.png/.json）\n`);

const ver = { V1: 0, V2: 0, V3: 0, 未知: 0 };
const carrier = {};
let total = 0, failed = 0;
const fieldPop = {};           // 字段 → 非空计数
const v3Only = { nickname: 0, assets: 0, creator_notes_multilingual: 0, group_only_greetings: 0, source: 0, creation_date: 0, modification_date: 0 };
let bookCount = 0;
let ignoredChars = 0, usedChars = 0;   // 当前查重用 5 字段 vs 被忽略字段的字符量
const samples = { V1: [], V2: [], V3: [] };

const CORE5 = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const IGNORED = ['system_prompt', 'post_history_instructions', 'alternate_greetings', 'creator_notes', 'character_book'];

for (const f of files) {
    const c = loadCard(f);
    if (!c || !c.json) { failed++; continue; }
    const j = c.json;
    total++;
    carrier[c.carrier] = (carrier[c.carrier] || 0) + 1;

    let v;
    if (j.spec === 'chara_card_v3') v = 'V3';
    else if (j.spec === 'chara_card_v2') v = 'V2';
    else if (typeof j.name === 'string' || j.description !== undefined || j.data) v = j.data ? 'V2' : 'V1';
    else v = '未知';
    ver[v]++;
    if (samples[v] && samples[v].length < 3) samples[v].push(f);

    const d = j.data && typeof j.data === 'object' ? j.data : j;
    if (!d || typeof d !== 'object') continue;

    for (const k of [...CORE5, ...IGNORED]) {
        const val = d[k];
        const has = val !== undefined && val !== null && (typeof val !== 'string' || val.trim() !== '')
            && (!Array.isArray(val) || val.length > 0);
        if (has) fieldPop[k] = (fieldPop[k] || 0) + 1;
    }
    // 字符量对比
    for (const k of CORE5) if (typeof d[k] === 'string') usedChars += d[k].length;
    for (const k of IGNORED) {
        const val = d[k];
        if (typeof val === 'string') ignoredChars += val.length;
        else if (Array.isArray(val)) ignoredChars += val.reduce((a, x) => a + (typeof x === 'string' ? x.length : 0), 0);
    }
    if (d.character_book && typeof d.character_book === 'object') bookCount++;

    for (const k of Object.keys(v3Only)) if (d[k] !== undefined && d[k] !== null) v3Only[k]++;
}

console.log('【版本分布】');
for (const [k, v] of Object.entries(ver)) console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)}  (${(v / Math.max(1, total) * 100).toFixed(1)}%)`);
console.log(`  （解析失败 ${failed}）`);
console.log('\n【载体分布】');
for (const [k, v] of Object.entries(carrier)) console.log(`  ${k.padEnd(12)} ${v}`);

console.log('\n【字段填充率】（非空计）');
for (const k of CORE5) console.log(`  ✅ ${k.padEnd(28)} ${String(fieldPop[k] || 0).padStart(4)} / ${total}`);
console.log('  ── 以下字段**当前查重完全忽略** ──');
for (const k of IGNORED) console.log(`  ❌ ${k.padEnd(28)} ${String(fieldPop[k] || 0).padStart(4)} / ${total}`);

console.log('\n【V3 新增字段出现率】');
for (const [k, v] of Object.entries(v3Only)) console.log(`  ${k.padEnd(28)} ${String(v).padStart(4)} / ${total}`);

console.log('\n【内嵌世界书】');
console.log(`  character_book 存在：${bookCount} / ${total}  (${(bookCount / Math.max(1, total) * 100).toFixed(1)}%)`);

console.log('\n【信息量对比：当前查重的字段 vs 被忽略的字段】');
const tot = usedChars + ignoredChars;
console.log(`  当前查重用（${CORE5.length} 个字段）：${usedChars.toLocaleString()} 字符  (${(usedChars / Math.max(1, tot) * 100).toFixed(1)}%)`);
console.log(`  被忽略（${IGNORED.length} 个字段）：${ignoredChars.toLocaleString()} 字符  (${(ignoredChars / Math.max(1, tot) * 100).toFixed(1)}%)`);
console.log(`  ⇒ 当前查重**遗漏了 ${(ignoredChars / Math.max(1, tot) * 100).toFixed(1)}% 的文本信息**`);

if (samples.V1.length || samples.V2.length || samples.V3.length) {
    console.log('\n【样本】');
    for (const k of ['V1', 'V2', 'V3']) if (samples[k].length) console.log(`  ${k}: ${samples[k].join(' | ')}`);
}
