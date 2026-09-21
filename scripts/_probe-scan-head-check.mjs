/**
 * T4 / T5 实测：512KB 头部预检误杀率 + `isValidWorldbook` 只看 `entries[0]` 的静默拒绝
 *
 * 用法：node scripts/_probe-scan-head-check.mjs [工作目录]
 *
 * 为什么必须实测（不能拍脑袋）：
 *   `wb:scan` 对大文件（>512KB）先读**头 64KB** 找 `"entries"` 关键字，找不到就跳过。
 *   若世界书的 `entries` 出现在文件**后段**，整本会被误杀。T4 要量的是**误杀率**。
 *   `isValidWorldbook` 只拿 `entries[0]` 做样本校验，若首条非标（null / 非词条对象）
 *   则整本被拒 —— T5 要确认这是否是**真实可达**的静默拒绝。
 *
 * 本探针做两件事：
 *   ① 构造多种「entries 位置 / 首条形态」的真实世界书文件，直接复用主进程的**同一套判据**
 *      （头部预检逻辑 + isValidWorldbook 逻辑，逐字复刻）算出判定结果；
 *   ② 输出误杀率表格，作为「是否需要放宽」的决策依据。
 */
import { writeFileSync, mkdirSync, openSync, readSync, closeSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const WORK = process.argv[2] || path.join(process.env.TEMP || '.', 'jsk-scan-head-probe');
const HEAD_BYTES = 64 * 1024;          // 与 main.js 一致：预检读头 64KB
const PRE_CHECK_BYTES = 512 * 1024;    // 与 main.js 一致：>512KB 才走预检

// ── 逐字复刻 main.js 的 isValidWorldbook（判据必须与生产一致，否则实测无效） ──
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

// ── 逐字复刻 main.js 的头部预检（读头 64KB 找 "entries"） ──
function headCheckPass(filePath, size) {
    if (size <= PRE_CHECK_BYTES) return true;   // 小文件不走预检
    const fd = openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
        return buf.subarray(0, n).toString('utf-8').includes('"entries"');
    } finally {
        closeSync(fd);
    }
}

// ── 造一个「指定条目数的世界书」，可控 entries 位置与首条形态 ──
function makeEntry(i, big) {
    return {
        uid: i,
        key: [`key${i}`],
        keysecondary: [],
        comment: `词条 ${i}`,
        content: big ? '内容'.repeat(200) + ' ' + 'x'.repeat(800) : `这是第 ${i} 个词条的内容。`,
        disable: false
    };
}

/**
 * 构造世界书 JSON 文本，entries 位置可控：
 *   - 'front'：正常（name + entries 在前）
 *   - 'back' ：把一个大字段（如 大量 metadata）塞在 entries **之前**，把 entries 挤到文件后段
 */
function buildWorldbook({ entryCount, big, layout, firstEntry }) {
    const entries = [];
    for (let i = 0; i < entryCount; i++) entries.push(makeEntry(i, big));
    if (firstEntry === 'null') entries[0] = null;
    else if (firstEntry === 'plain') entries[0] = { note: '没有世界书特征字段的对象' };

    if (layout === 'front') {
        return JSON.stringify({ name: '测试世界书', entries }, null, 2);
    }
    // layout === 'back'：在 entries 前塞一大段无关字段（模拟「元数据/插图在前」的真实文件）
    const filler = 'F'.repeat(2000);
    const padding = {};
    for (let i = 0; i < 400; i++) padding[`pad_${i}`] = filler;   // ≈800KB 填充
    return JSON.stringify({ name: '测试世界书', ...padding, entries }, null, 2);
}

// ── 跑测 ──
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const cases = [
    { id: 'small-front',   entryCount: 10,  big: false, layout: 'front', firstEntry: 'ok',   desc: '小书（<512KB）entries 在前' },
    { id: 'big-front',     entryCount: 400, big: true,  layout: 'front', firstEntry: 'ok',   desc: '大书（>512KB）entries 在前' },
    { id: 'big-back',      entryCount: 400, big: true,  layout: 'back',  firstEntry: 'ok',   desc: '大书（>512KB）entries 在**后段**' },
    { id: 'small-back',    entryCount: 10,  big: false, layout: 'back',  firstEntry: 'ok',   desc: '小书（>512KB）entries 在后段' },
    { id: 'first-null',    entryCount: 10,  big: false, layout: 'front', firstEntry: 'null', desc: '首条为 null' },
    { id: 'first-plain',   entryCount: 10,  big: false, layout: 'front', firstEntry: 'plain', desc: '首条为无特征字段的对象' },
    { id: 'first-null-big', entryCount: 400, big: true, layout: 'front', firstEntry: 'null', desc: '大书 + 首条为 null' },
];

const rows = [];
for (const c of cases) {
    const text = buildWorldbook(c);
    const file = path.join(WORK, `${c.id}.json`);
    writeFileSync(file, text, 'utf-8');
    const size = Buffer.byteLength(text);
    const headOk = headCheckPass(file, size);
    let valid = null;
    let rejectReason = '';
    if (headOk) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf-8'));
            valid = isValidWorldbook(parsed);
            if (!valid) {
                // 定位是哪一步拒的（便于区分「首条问题」还是「其它」）
                const e = parsed.entries;
                if (Array.isArray(e) && e.length && (!e[0] || typeof e[0] !== 'object')) {
                    rejectReason = 'entries[0] 非对象（T5 静默拒绝）';
                } else {
                    rejectReason = '其它校验未通过';
                }
            }
        } catch (err) {
            valid = false;
            rejectReason = 'JSON 解析失败：' + err.message;
        }
    } else {
        rejectReason = '头部 64KB 未命中 "entries"（T4 预检误杀）';
    }

    const accepted = headOk && valid === true;
    rows.push({ c, size, headOk, valid, rejectReason, 入库: accepted });
}

// ── 报告 ──
const mb = (b) => (b / 1048576).toFixed(2) + 'MB';
console.log(`\n===== T4/T5 实测：扫描闸门误杀（工作目录 ${WORK}）=====\n`);
console.log('用例                体积      头部预检  isValid  最终入库  说明');
for (const r of rows) {
    const mark = (v) => (v === true ? '✅' : v === false ? '❌' : '—');
    console.log(
        `${r.c.id.padEnd(18)} ${mb(r.size).padStart(8)}  ${mark(r.headOk).padEnd(8)}  ${mark(r.valid).padEnd(8)}  ${mark(r.入库).padEnd(8)}  ${r.入库 ? r.c.desc : r.rejectReason}`
    );
}

// ── 结论 ──
const shouldBeAccepted = rows.filter(r => r.c.firstEntry === 'ok');
const headKilled = shouldBeAccepted.filter(r => !r.headOk);
const firstKilled = rows.filter(r => r.c.firstEntry !== 'ok' && r.headOk && r.valid === false);

console.log('\n===== 结论 =====');
console.log(`【T4 头部预检误杀】本应入库的 ${shouldBeAccepted.length} 例中，被头部预检误杀 ${headKilled.length} 例` +
    (headKilled.length ? `：${headKilled.map(r => r.c.id).join('、')}` : '（0 例 → 无误杀）'));
console.log(`【T5 entries[0] 静默拒绝】首条非标的 ${rows.filter(r => r.c.firstEntry !== 'ok').length} 例中，` +
    `确认被拒 ${firstKilled.length} 例：${firstKilled.map(r => r.c.id).join('、')}`);

// 关键量化：entries 位于后段时，文件多大才会把 entries 挤出前 64KB
console.log('\n【关键量化】entries 被挤出前 64KB 的体积门槛：');
{
    // 二分找一个「entries 开头偏移 > 64KB」的最小体积
    let lo = 512 * 1024, hi = 4 * 1024 * 1024, ans = null;
    for (let i = 0; i < 24; i++) {
        const mid = Math.floor((lo + hi) / 2);
        const padLen = mid;
        const text = JSON.stringify({ name: 'x', filler: 'F'.repeat(padLen), entries: [makeEntry(0, false)] });
        const idx = text.indexOf('"entries"');
        if (idx > HEAD_BYTES) { ans = { size: Buffer.byteLength(text), idx }; hi = mid; }
        else lo = mid + 1;
    }
    if (ans) {
        console.log(`  ≈ ${mb(ans.size)}（entries 起始偏移 ${(ans.idx / 1024).toFixed(0)}KB > 头 64KB）`);
        console.log(`  ⇒ 世界书若把大段元数据排在 entries 之前，**超过该体积就会被预检误杀**。`);
    }
}
console.log('');
