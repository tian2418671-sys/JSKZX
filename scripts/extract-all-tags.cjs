// 扫描角色卡库，提取全部卡片标签（PNG tEXt chara 块 + JSON），统计大分类覆盖
const fs = require('fs');
const path = require('path');

const ROOT = 'I:/03/角色色卡';

function extractPngTags(p) {
    try {
        const buf = fs.readFileSync(p);
        if (buf.length < 8 || buf.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return [];
        let off = 8;
        while (off + 8 <= buf.length) {
            const len = buf.readUInt32BE(off);
            const type = buf.toString('latin1', off + 4, off + 8);
            if (type === 'IEND') break;
            if (type === 'tEXt' || type === 'iTXt') {
                const dataStart = off + 8;
                const data = buf.subarray(dataStart, dataStart + len);
                let kwEnd = data.indexOf(0);
                if (kwEnd === -1) kwEnd = data.length;
                const kw = data.toString('latin1', 0, kwEnd);
                if (kw === 'chara' || kw === 'ccv3') {
                    let text;
                    if (type === 'tEXt') {
                        text = data.toString('latin1', kwEnd + 1);
                        text = Buffer.from(text, 'base64').toString('utf8');
                    } else {
                        // iTXt: keyword\0 compFlag compMethod lang\0 translatedKw\0 text
                        let idx = kwEnd + 1;
                        idx += 2; // compFlag + compMethod
                        const langEnd = data.indexOf(0, idx);
                        if (langEnd === -1) return [];
                        idx = langEnd + 1;
                        const twEnd = data.indexOf(0, idx);
                        if (twEnd === -1) return [];
                        text = data.toString('utf8', twEnd + 1);
                        text = Buffer.from(text, 'base64').toString('utf8');
                    }
                    try {
                        const card = JSON.parse(text);
                        const d = (card && card.data) || card;
                        const tags = d.tags;
                        return Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map(s => s.trim()).filter(Boolean) : []);
                    } catch (e) { return []; }
                }
            }
            off += 12 + len;
        }
        return [];
    } catch (e) { return []; }
}

(async () => {
    const { groupTagsByCategory } = await import('../js/utils/tagCategories.js');
    const tagSet = new Set();
    let png = 0, json = 0;
    function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.png$/i.test(e.name)) {
                const tags = extractPngTags(p);
                tags.forEach(t => { if (t) tagSet.add(String(t)); });
                png++;
                if (png % 2000 === 0) console.log('  已扫 PNG:', png, '| 标签数:', tagSet.size);
            } else if (/\.json$/i.test(e.name)) {
                try {
                    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                    const d = (j && j.data) || j;
                    if (Array.isArray(d.tags)) d.tags.forEach(t => { if (t) tagSet.add(String(t)); });
                    else if (typeof d.tags === 'string') d.tags.split(',').forEach(t => { t = t.trim(); if (t) tagSet.add(t); });
                } catch (err) { /* 跳过 */ }
                json++;
            }
        }
    }
    console.log('扫描库:', ROOT);
    walk(ROOT);
    const list = Array.from(tagSet).filter(t => t.trim());
    const groups = groupTagsByCategory(list);
    console.log('');
    console.log('== 分类统计 ==');
    let otherCount = 0;
    for (const gr of groups) {
        console.log(gr.icon, gr.name, '(' + gr.tags.length + ')');
        if (gr.key === 'other') {
            otherCount = gr.tags.length;
        }
    }
    console.log('');
    console.log('总标签数:', list.length, '| PNG:', png, '| JSON:', json);
    console.log('「其他」标签数:', otherCount);
    // 输出其他明细（前 300 个 + 频次不用，只输出名称）
    const other = groups.find(g => g.key === 'other');
    if (other) {
        const out = other.tags.map(t => t).sort();
        fs.writeFileSync(path.join(__dirname, 'other-tags-dump.txt'), out.join('\n'), 'utf8');
        console.log('其他明细已写入 scripts/other-tags-dump.txt（' + out.length + ' 条）');
        console.log('--- 前 150 条预览 ---');
        console.log(out.slice(0, 150).join(' | '));
    }
})().catch(e => { console.error(e); process.exit(1); });
