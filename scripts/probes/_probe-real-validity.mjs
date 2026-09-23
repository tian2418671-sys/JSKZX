/**
 * T5 实测（真实库）：`isValidWorldbook` 只看 `entries[0]` 会不会**静默拒绝**真世界书
 *
 * 用法：node scripts/probes/_probe-real-validity.mjs "H:\01\全局世界书"
 *
 * 判据与 main.js 的 `isValidWorldbook` 逐字一致。
 * 重点看两类「静默拒绝」：
 *   ① `entries[0]` 为 null / 非对象 → 整本被拒（哪怕第 2 条起全是正常词条）
 *   ② 字典形态 `{"0":{...}}` 的转换是否生效
 * 输出：每本的 判定 / 拒绝原因 / 首条形态；并给出「若改为扫描全部条目」的对照结论。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) { console.error('用法：node scripts/probes/_probe-real-validity.mjs <目录>'); process.exit(1); }
const PARSE_MAX = 50 * 1024 * 1024;

// ── 与 main.js 逐字一致 ──
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

/** 候选修法：扫描全部条目，只要有任意一条像世界书词条即接受（治 T5） */
function isValidWorldbookAnyEntry(wbData) {
    if (!wbData || typeof wbData !== 'object') return false;
    if (wbData.spec === 'chara_card_v2' || wbData.spec === 'chara_card_v3') return false;
    if (wbData.data && (wbData.data.description !== undefined || wbData.data.first_mes !== undefined)) return false;
    if (!wbData.entries) return false;
    if (typeof wbData.entries === 'object' && !Array.isArray(wbData.entries)) {
        wbData.entries = Object.values(wbData.entries);
    }
    if (!Array.isArray(wbData.entries)) return false;
    // 只看「前 N 条」而非仅第 0 条（兼顾成本与鲁棒）
    const N = Math.min(wbData.entries.length, 20);
    for (let i = 0; i < N; i++) {
        const s = wbData.entries[i];
        if (!s || typeof s !== 'object') continue;
        if (('key' in s) || ('keys' in s) || ('content' in s) || ('comment' in s) || ('uid' in s)) return true;
    }
    return wbData.entries.length === 0;   // 空书仍视为合法世界书
}

const files = readdirSync(DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
    .map(d => path.join(DIR, d.name));

const rows = [];
for (const f of files) {
    const size = statSync(f).size;
    const name = path.basename(f);
    if (size > PARSE_MAX) { rows.push({ name, size, skip: '>50MB 不 parse' }); continue; }
    let parsed;
    try { parsed = JSON.parse(readFileSync(f, 'utf-8')); }
    catch (e) { rows.push({ name, size, skip: 'JSON 解析失败：' + e.message }); continue; }

    const hasEntriesField = !!parsed.entries;
    // 注意：isValidWorldbook 会**就地改写** entries（字典→数组），故先取一份形态快照
    const rawEntries = parsed.entries;
    const isDict = rawEntries && typeof rawEntries === 'object' && !Array.isArray(rawEntries);
    const entryCount = rawEntries ? (Array.isArray(rawEntries) ? rawEntries.length : Object.keys(rawEntries).length) : 0;
    const firstShape = (() => {
        if (!rawEntries) return '无 entries';
        const arr = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries);
        if (!arr.length) return '空数组';
        const s = arr[0];
        if (s === null) return 'null';
        if (typeof s !== 'object') return typeof s;
        const keys = Object.keys(s).slice(0, 5).join(',');
        return `{${keys}}`;
    })();

    const v0 = isValidWorldbook(JSON.parse(JSON.stringify(parsed)));
    const vAll = isValidWorldbookAnyEntry(JSON.parse(JSON.stringify(parsed)));
    rows.push({ name, size, hasEntriesField, isDict, entryCount, firstShape, v0, vAll, skip: null });
}

const mb = (b) => (b / 1048576).toFixed(2) + 'MB';
console.log(`\n===== T5 真实库实测：${DIR}（${rows.length} 本）=====\n`);
console.log('体积        词条数  首条形态                 现行判定  候选修法  文件');
for (const r of rows.sort((a, b) => b.size - a.size)) {
    if (r.skip) { console.log(`${mb(r.size).padStart(9)}  ${r.skip}`); continue; }
    console.log(
        `${mb(r.size).padStart(9)}  ${String(r.entryCount).padStart(6)}  ${(r.firstShape || '').slice(0, 22).padEnd(24)}  ${(r.v0 ? '✅通过' : '❌拒绝').padEnd(8)}  ${(r.vAll ? '✅' : '❌').padEnd(8)}  ${r.name.slice(0, 30)}`
    );
}

const parsedRows = rows.filter(r => !r.skip);
const rejected = parsedRows.filter(r => !r.v0);
const rescuedByAll = rejected.filter(r => r.vAll);
const dictForm = parsedRows.filter(r => r.isDict);

console.log('\n===== 结论 =====');
console.log(`可解析的：${parsedRows.length} 本；现行判定拒绝：${rejected.length} 本`);
if (rejected.length) {
    console.log('被拒清单：');
    for (const r of rejected) {
        console.log(`  · ${r.name.slice(0, 40)}  →  首条形态：${r.firstShape}${r.vAll ? '（候选修法可救回）' : '（候选修法也拒）'}`);
    }
} else {
    console.log('✅ 真实库中**没有**因 entries[0] 被静默拒绝的世界书（T5 在本库不可复现）');
}
console.log(`字典形态（V2 老格式）的：${dictForm.length} 本${dictForm.length ? ' → ' + dictForm.map(r => r.name.slice(0, 24)).join('、') : ''}`);
console.log(`候选修法（扫前 20 条）多救回：${rescuedByAll.length} 本`);
console.log('');
