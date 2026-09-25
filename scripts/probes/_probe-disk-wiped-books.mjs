/**
 * 磁盘排雷（只读真实库）：**有没有卡已经被「保存链路」写坏了**
 *
 * 判据：卡的 `character_book` 有 ≥10 条词条，但**磁盘上**每条 `content` 都是空串
 *   ⇒ 疑似被「瘦身态 payload 覆盖写」抹掉正文（正常作者不会建 10+ 条空词条）。
 * 输出：抽样总数 / 中招数 / 前若干个中招文件（便于人工复核）。
 *
 * 用法：`node scripts/probes/_probe-disk-wiped-books.mjs [根目录] [抽样数]`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePNGChunk, decodeBase64UTF8, deepScanForJSON } from '../../js/utils/pngParser.js';
import { normalizeCardData, extractBookEntries } from '../../js/utils/cardLoader.js';

const ROOT = process.argv[2] || 'I:\\03\\角色色卡';
const LIMIT = Number(process.argv[3] || 400);

const esc = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

const files = [];
(function walk(dir, depth) {
    if (files.length >= LIMIT || depth > 4) return;
    let items;
    try { items = readdirSync(dir); } catch { return; }
    for (const name of items) {
        if (files.length >= LIMIT) return;
        if (name.startsWith('.')) continue;
        const p = join(dir, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (/\.png$/i.test(name)) files.push(p);
    }
})(ROOT, 0);

function cardJSON(file) {
    const buf = readFileSync(file);
    try {
        for (const c of parsePNGChunk(buf)) {
            const txt = c.text || c.data || '';
            if (typeof txt !== 'string') continue;
            if (/^\s*[{[]/.test(txt)) { try { return JSON.parse(txt); } catch { /* next */ } }
            if (/^[A-Za-z0-9+/=]{200,}/.test(txt.trim())) {
                try { return JSON.parse(decodeBase64UTF8(txt.trim())); } catch { /* next */ }
            }
        }
    } catch { /* 落深扫 */ }
    const raw = deepScanForJSON(buf);
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

let ok = 0, failed = 0, suspicious = [];
for (const f of files) {
    let card;
    try { card = cardJSON(f); } catch { card = null; }
    if (!card) { failed++; continue; }
    let d = null;
    try { d = normalizeCardData(card, true); } catch { d = card; }
    const dd = (d && d.data) || d || {};
    const entries = extractBookEntries(dd.character_book) || [];
    if (entries.length < 10) continue;
    const nonEmpty = entries.filter(e => String((e && e.content) || '').length > 0).length;
    ok++;
    if (nonEmpty === 0) suspicious.push({ file: f, entries: entries.length });
}

console.log(`抽样 ${files.length} 个 PNG ｜ 可解析 ${ok} ｜ 解析失败 ${failed}`);
console.log(`「≥10 条词条但正文全空」= ${suspicious.length}`);
for (const s of suspicious.slice(0, 12)) console.log(`  · ${esc(s.file.split(/[\\/]/).pop())} （${s.entries} 条）`);
process.exit(0);
