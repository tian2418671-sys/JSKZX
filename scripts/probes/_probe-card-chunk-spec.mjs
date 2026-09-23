// 核实：V3 卡的数据实际存在哪个 PNG chunk 里（方案说「ccv3 优先」）
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'E:\\AI\\酒馆工具\\角色卡';

function chunkKeys(buf) {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return [];
    let off = 8; const keys = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tEXt' || type === 'iTXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const z = data.indexOf(0);
            if (z > 0) keys.push(data.toString('latin1', 0, z));
        }
        if (type === 'IEND') break;
        off += 12 + len;
    }
    return keys;
}
function readText(buf, want) {
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tEXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const z = data.indexOf(0);
            if (z > 0 && data.toString('latin1', 0, z).toLowerCase() === want) return data.toString('latin1', z + 1);
        }
        if (type === 'IEND') break;
        off += 12 + len;
    }
    return null;
}

const rows = [];
for (const f of fs.readdirSync(DIR).filter(x => x.toLowerCase().endsWith('.png'))) {
    const buf = fs.readFileSync(path.join(DIR, f));
    const keys = chunkKeys(buf);
    const raw = readText(buf, 'chara') || readText(buf, 'ccv3');
    let spec = '?';
    if (raw) { try { spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).spec || '(无 spec)'; } catch { spec = '解析失败'; } }
    rows.push({ f, keys: keys.join('+') || '(无)', spec });
}
console.log('═════ PNG chunk 与 spec 的实际对应 ═════\n');
const combo = {};
for (const r of rows) {
    const key = `${r.keys}  →  spec=${r.spec}`;
    combo[key] = (combo[key] || 0) + 1;
}
console.log('  组合                                           数量');
console.log('  ─────────────────────────────────────────────────────');
for (const [k, v] of Object.entries(combo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(46)} ${String(v).padStart(3)}`);
}
console.log('');
const v3InChara = rows.filter(r => r.spec === 'chara_card_v3' && r.keys.includes('chara') && !r.keys.includes('ccv3')).length;
const v3InCcv3 = rows.filter(r => r.spec === 'chara_card_v3' && r.keys.includes('ccv3')).length;
console.log(`V3 数据在 chara chunk：${v3InChara} ｜ 在 ccv3 chunk：${v3InCcv3}`);
console.log('');
console.log('【结论】');
if (v3InChara > v3InCcv3) {
    console.log(`  ⚠️ 方案称「ST 导出同时写 chara(V2) + ccv3(V3) 两个 chunk，读取时 ccv3 优先」`);
    console.log(`     实测：V3 数据**主要存在 chara chunk 里**（${v3InChara} vs ${v3InCcv3}）⇒`);
    console.log(`     **不能靠 chunk 名判版本，也不能「只读 ccv3」** —— 必须解析 spec 字段。`);
} else {
    console.log('  ✅ 方案描述与实测一致（ccv3 为主）。');
}
