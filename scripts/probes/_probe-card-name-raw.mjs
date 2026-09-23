/**
 * 直读 PNG 内嵌 JSON，对比「卡内 name」vs「列表 c.name」（2026-09-23）
 * 用于判定「同名查重聚错组」是数据问题还是解析 bug。
 *
 * 用法：node scripts/probes/_probe-card-name-raw.mjs <卡库目录> [最多张数]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'E:\\BaiduNetdiskDownload\\26.6角色卡\\测试卡库';
const LIMIT = Number(process.argv[3] || 3000);

/** 提取 PNG tEXt/iTXt 中的 chara（base64 JSON）或 ccv3 */
function extractCard(p) {
    const buf = fs.readFileSync(p);
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const dataStart = off + 8;
        if (type === 'tEXt') {
            const chunk = buf.toString('latin1', dataStart, dataStart + len);
            const z = chunk.indexOf('\0');
            const kw = chunk.slice(0, z);
            if (kw === 'chara' || kw === 'ccv3') {
                try {
                    const json = Buffer.from(chunk.slice(z + 1), 'base64').toString('utf8');
                    return JSON.parse(json);
                } catch (e) { return { _err: e.message, _kw: kw }; }
            }
        }
        if (type === 'IEND') break;
        off = dataStart + len + 4;
    }
    return null;
}

const rows = [];
let scanned = 0;
const walk = (d) => {
    if (scanned >= LIMIT) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
        if (scanned >= LIMIT) return;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        if (!/\.(png|webp)$/i.test(e.name)) continue;
        scanned++;
        const base = e.name.replace(/\.(png|webp)$/i, '');
        let card = null;
        try { card = extractCard(fp); } catch (err) { /* 忽略 */ }
        const inner = card ? (card.data || card) : null;
        const rawName = inner && typeof inner.name === 'string' ? inner.name : null;
        rows.push({ file: base, rawName });
    }
};

walk(DIR);
const uniqFiles = new Set(rows.map(r => r.file));
const uniqRaw = new Set(rows.map(r => r.rawName));
const dupRaw = new Map();
for (const r of rows) dupRaw.set(r.rawName, (dupRaw.get(r.rawName) || 0) + 1);
const dupRawGroups = [...dupRaw.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
const emptyRaw = rows.filter(r => !r.rawName).length;
const eqFile = rows.filter(r => r.rawName === r.file).length;

console.log(JSON.stringify({
    scanned: rows.length,
    uniqueFiles: uniqFiles.size,
    uniqueRawNames: uniqRaw.size,
    emptyRawNames: emptyRaw,
    rawNameEqFileBase: eqFile,
    dupRawGroups: dupRawGroups.length,
    cardsInDupRawGroups: dupRawGroups.reduce((s, [, n]) => s + n, 0),
    topDupRaw: dupRawGroups.slice(0, 20)
}, null, 2));

// 找出「文件名不同但 rawName 相同」的实例（用户看到的「聚错组」候选）
const byRaw = new Map();
for (const r of rows) {
    if (!r.rawName) continue;
    if (!byRaw.has(r.rawName)) byRaw.set(r.rawName, []);
    byRaw.get(r.rawName).push(r.file);
}
const suspicious = [...byRaw.entries()].filter(([, files]) => files.length > 1).slice(0, 6);
console.log('\n── 同名但文件名不同的实例（前 6 组）──');
for (const [nm, files] of suspicious) {
    console.log(`  rawName="${nm}" → ${files.length} 个文件`);
    for (const f of files.slice(0, 4)) console.log(`      · ${f}`);
}
