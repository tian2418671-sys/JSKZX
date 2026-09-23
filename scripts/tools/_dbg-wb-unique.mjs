/** 探查压力库中的「唯一内容」书及其关系（为 simhash 实验准备正负样本） */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';

const seen = new Map();
const walk = (d, depth = 0) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.name.toLowerCase().endsWith('.json')) continue;
        const buf = fs.readFileSync(p);
        const h = crypto.createHash('md5').update(buf).digest('hex');
        if (!seen.has(h)) {
            let info = { path: p, name: e.name, size: buf.length, entries: 0, keys: 0 };
            try {
                const d2 = JSON.parse(buf.toString('utf-8'));
                const arr = Array.isArray(d2.entries) ? d2.entries
                    : (d2.entries && typeof d2.entries === 'object' ? Object.values(d2.entries) : []);
                info.entries = arr.length;
                const ks = new Set();
                for (const x of arr) {
                    const k = Array.isArray(x && x.key) ? x.key : (x && x.key ? [x.key] : []);
                    for (const y of k) { const s = String(y).trim().toLowerCase(); if (s) ks.add(s); }
                }
                info.keys = ks.size;
                info.contentLen = arr.map(x => String((x && x.content) || '')).join('\n').length;
            } catch (err) { info.err = err.message; }
            seen.set(h, info);
        }
    }
};
walk(DIR);

console.log(`唯一内容书：${seen.size} 本\n`);
console.log('文件'.padEnd(40) + 'MB'.padStart(8) + '词条'.padStart(7) + 'keys'.padStart(7) + '正文字符'.padStart(11));
for (const [, v] of seen) {
    console.log(String(v.name).slice(0, 38).padEnd(40)
        + (v.size / 1048576).toFixed(2).padStart(8)
        + String(v.entries).padStart(7) + String(v.keys).padStart(7)
        + String(v.contentLen || 0).padStart(11));
}
