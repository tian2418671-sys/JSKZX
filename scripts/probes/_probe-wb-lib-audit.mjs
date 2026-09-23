/**
 * 磁盘实测：用与 main.js 完全相同的 `isValidWorldbook` 判据，统计压力库的真实构成。
 * 目的：解决「探针预期 501/41」与「应用实测 537/5」的分歧 —— 以磁盘事实为准。
 *
 * 用法：node scripts/probes/_probe-wb-lib-audit.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb500';

// 与 main.js 的 isValidWorldbook **逐字一致**（含字典归一化的副作用）
function isValidWorldbook(wbData) {
    if (!wbData || typeof wbData !== 'object') return false;
    if (wbData.spec === 'chara_card_v2' || wbData.spec === 'chara_card_v3') return false;
    if (wbData.data && (wbData.data.description !== undefined || wbData.data.first_mes !== undefined)) return false;
    if (!wbData.entries) return false;
    if (typeof wbData.entries === 'object' && !Array.isArray(wbData.entries)) {
        wbData.entries = Object.values(wbData.entries);
    }
    if (!Array.isArray(wbData.entries)) return false;
    if (wbData.entries.length > 0) {
        const sample = wbData.entries[0];
        if (!sample || typeof sample !== 'object') return false;
        const isWbEntry = ('key' in sample) || ('keys' in sample) || ('content' in sample) || ('comment' in sample) || ('uid' in sample);
        if (!isWbEntry) return false;
    }
    return true;
}

const SCAN_INLINE_MAX_BYTES = 5 * 1024 * 1024;
const SCAN_PARSE_MAX_BYTES = 50 * 1024 * 1024;

const files = [];
(function walk(dir, depth = 0) {
    if (depth > 5) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;               // 与 walk 一致：跳过隐藏项
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { walk(fp, depth + 1); continue; }
        if (e.isFile() && path.extname(e.name).toLowerCase() === '.json') files.push(fp);
    }
})(DIR);

let valid = 0, skipped = 0, inlineBytes = 0, inline = 0, lazy = 0;
const reasons = {};
const skippedList = [];
const validByGroup = {};

for (const fp of files) {
    const st = fs.statSync(fp);
    let verdict;
    if (st.size > SCAN_PARSE_MAX_BYTES) {
        verdict = '超巨(>50MB) → 懒加载';
    } else {
        // >512KB 的头 64KB 预检
        if (st.size > 512 * 1024) {
            const fh = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(64 * 1024);
            const n = fs.readSync(fh, buf, 0, buf.length, 0);
            fs.closeSync(fh);
            if (!buf.subarray(0, n).toString('utf-8').includes('"entries"')) {
                verdict = '头64KB无entries → 跳过';
            }
        }
        if (!verdict) {
            try {
                const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                verdict = isValidWorldbook(d) ? '有效' : '结构校验未通过 → 跳过';
            } catch (e) {
                verdict = '解析失败 → 跳过';
            }
        }
    }
    if (verdict === '有效' || verdict === '超巨(>50MB) → 懒加载') {
        valid++;
        const g = path.basename(path.dirname(fp));
        validByGroup[g] = (validByGroup[g] || 0) + 1;
        if (verdict === '有效') {
            if (st.size > SCAN_INLINE_MAX_BYTES) lazy++;
            else { inline++; inlineBytes += st.size; }
        } else lazy++;
    } else {
        skipped++;
        reasons[verdict] = (reasons[verdict] || 0) + 1;
        skippedList.push(path.relative(DIR, fp));
    }
}

console.log(`目录：${DIR}`);
console.log(`.json 总数（跳过隐藏目录）：${files.length}`);
console.log(`有效世界书：${valid}    应跳过：${skipped}`);
console.log(`其中：≤5MB 可内联 ${inline} 本 / >5MB 走 heavy ${lazy} 本`);
console.log(`内联字节合计：${(inlineBytes / 1048576).toFixed(0)}MB（超 256MB 预算的部分会被应用转懒加载）`);
console.log(`跳过原因分布：${JSON.stringify(reasons, null, 1)}`);
console.log(`\n各目录有效书数（前 25）：`);
const entries = Object.entries(validByGroup).sort();
for (const [g, n] of entries.slice(0, 25)) console.log(`  ${g}: ${n}`);
if (entries.length > 25) console.log(`  ... 共 ${entries.length} 个目录`);
if (skippedList.length && skippedList.length <= 50) {
    console.log(`\n被跳过清单（${skippedList.length} 个）：`);
    for (const s of skippedList) console.log('  ' + s);
}
