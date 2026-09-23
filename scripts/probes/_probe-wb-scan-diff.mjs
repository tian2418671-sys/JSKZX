/**
 * 对照探针：应用扫描结果 vs 磁盘事实（定位「诱饵被误判为有效」）
 *
 * 用法：node scripts/probes/_probe-wb-scan-diff.mjs [目录]
 *
 * 背景：磁盘实测 `_wb500` = **501 有效 / 41 应跳过**，
 *   但应用 `wb:scan` 返回「入库 537 / 跳过 5」→ 36 个诱饵被误判。
 *   本探针把两侧逐路径对齐，直接指出分歧。
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9370);
const DIR = process.argv[2] || 'D:\\TkDmGzq\\_wb500';

// ── 磁盘侧：与 main.js 逐字一致的判据 ──
function isValidWorldbook(wbData) {
    if (!wbData || typeof wbData !== 'object') return false;
    if (wbData.spec === 'chara_card_v2' || wbData.spec === 'chara_card_v3') return false;
    if (wbData.data && (wbData.data.description !== undefined || wbData.data.first_mes !== undefined)) return false;
    if (!wbData.entries) return false;
    if (typeof wbData.entries === 'object' && !Array.isArray(wbData.entries)) wbData.entries = Object.values(wbData.entries);
    if (!Array.isArray(wbData.entries)) return false;
    if (wbData.entries.length > 0) {
        const s = wbData.entries[0];
        if (!s || typeof s !== 'object') return false;
        if (!(('key' in s) || ('keys' in s) || ('content' in s) || ('comment' in s) || ('uid' in s))) return false;
    }
    return true;
}
const SCAN_PARSE_MAX = 50 * 1024 * 1024;
const diskVerdict = new Map();
(function walk(dir, depth = 0) {
    if (depth > 5) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { walk(fp, depth + 1); continue; }
        if (!(e.isFile() && path.extname(e.name).toLowerCase() === '.json')) continue;
        const st = fs.statSync(fp);
        let v;
        if (st.size > SCAN_PARSE_MAX) v = 'lazy';
        else if (st.size > 512 * 1024) {
            const fh = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(64 * 1024);
            const n = fs.readSync(fh, buf, 0, buf.length, 0);
            fs.closeSync(fh);
            v = buf.subarray(0, n).toString('utf-8').includes('"entries"') ? 'check' : 'skip';
        } else v = 'check';
        if (v === 'check') {
            try { v = isValidWorldbook(JSON.parse(fs.readFileSync(fp, 'utf-8'))) ? 'valid' : 'skip'; }
            catch { v = 'skip'; }
        }
        diskVerdict.set(path.resolve(fp).toLowerCase(), v);
    }
})(DIR);

// ── 应用侧 ──
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = list.find(t => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => { ws.onopen = r; });
const ev = async (expr, t = 900000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t });
    if (r.exceptionDetails) throw new Error('EVAL: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
};

const DIR_LIT = JSON.stringify(DIR);
const appRes = await ev(`(async () => {
    // ⚠️ 必须先做一次**普通扫描**建立白名单：\`rescan\` 只跳过「新目录的指纹验证」，
    //    不在白名单的目录传 rescan 依然会被拒（安全设计如此，别绕过它）。
    const first = await window.electronAPI.scanWorldbooks(${DIR_LIT});
    if (!first || !first.success) return { ok: false, error: (first && first.error) || '首次扫描失败' };
    const r = await window.electronAPI.scanWorldbooks(${DIR_LIT}, { rescan: true });
    return {
        ok: !!(r && r.success), error: r && r.error,
        data: (r && r.data || []).map(w => ({ p: w.path, name: w.name, size: w.size, ec: w.entryCount, dl: w.dataLoaded })),
        skipped: (r && r.skipped || []).map(s => ({ p: s.path, reason: s.reason })),
        inlineMB: r && r.inlineMB, inlineSkipped: r && r.inlineSkipped
    };
})()`);
if (!appRes.ok) { console.error('应用扫描失败：', appRes.error); process.exit(1); }

console.log(`磁盘：有效 ${[...diskVerdict.values()].filter(v => v === 'valid' || v === 'lazy').length} / 跳过 ${[...diskVerdict.values()].filter(v => v === 'skip').length} / 合计 ${diskVerdict.size}`);
console.log(`应用：入库 ${appRes.data.length} / 跳过 ${appRes.skipped.length}`);
console.log(`应用内联 ${appRes.inlineMB}MB，转懒加载 ${appRes.inlineSkipped} 本`);

const appValid = new Set(appRes.data.map(d => path.resolve(d.p).toLowerCase()));
const appSkip = new Set(appRes.skipped.map(d => path.resolve(d.p).toLowerCase()));

console.log('\n=== 分歧：磁盘说「跳过」，应用却入库 ===');
let n1 = 0;
for (const [p, v] of diskVerdict) {
    if (v === 'skip' && appValid.has(p)) { n1++; if (n1 <= 45) console.log('  ' + path.relative(DIR, p)); }
}
console.log(`  合计 ${n1} 个`);

console.log('\n=== 分歧：磁盘说「有效」，应用却跳过 ===');
let n2 = 0;
for (const [p, v] of diskVerdict) {
    if ((v === 'valid' || v === 'lazy') && appSkip.has(p)) { n2++; if (n2 <= 20) console.log('  ' + path.relative(DIR, p)); }
}
console.log(`  合计 ${n2} 个`);

console.log('\n=== 分歧：磁盘没有、应用却报了 ===');
let n3 = 0;
for (const p of [...appValid, ...appSkip]) if (!diskVerdict.has(p)) { n3++; if (n3 <= 20) console.log('  ' + p); }
console.log(`  合计 ${n3} 个`);

process.exit(0);
