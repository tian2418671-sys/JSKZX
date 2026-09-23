/** simhash 调试：定位「全 0」原因 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb5k\\s1000';
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(str) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < str.length; i++) {
        h ^= BigInt(str.charCodeAt(i));
        h = (h * 0x100000001b3n) & MASK64;
    }
    return h;
}

const dir = path.join(DIR, 'g001');
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).slice(0, 2);
console.log('文件:', files);

for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const d = JSON.parse(raw);
    const entries = Array.isArray(d.entries) ? d.entries : Object.values(d.entries || {});
    const text = entries.map(e => String((e && e.content) || '')).join('\n');
    console.log(`\n${f}: entries=${entries.length}, textLen=${text.length}`);
    console.log('  前 80 字符:', JSON.stringify(text.slice(0, 80)));
    // 特征
    const n = 3;
    const feats = [];
    for (let i = 0; i + n <= text.length; i++) feats.push(text.slice(i, i + n));
    console.log(`  char3 特征数: ${feats.length}`);
    console.log('  前 5 特征:', feats.slice(0, 5));
    // hash 几个特征看分布
    const hs = feats.slice(0, 5).map(x => fnv1a64(x));
    console.log('  前 5 特征 hash:', hs.map(h => h.toString(16)));
    // 算 simhash 的 bit 分布
    const v = new Array(64).fill(0);
    for (const ft of feats) {
        const h = fnv1a64(ft);
        for (let b = 0; b < 64; b++) {
            if ((h >> BigInt(b)) & 1n) v[b]++; else v[b]--;
        }
    }
    console.log('  v[0..7]:', v.slice(0, 8));
    let out = 0n;
    for (let b = 0; b < 64; b++) if (v[b] > 0) out |= (1n << BigInt(b));
    console.log('  simhash:', out.toString(16));
}
