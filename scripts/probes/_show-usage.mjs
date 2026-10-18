import fs from 'node:fs';
import path from 'node:path';

const LIB = 'E:\\AI\\酒馆工具\\角色卡';
const TARGET = process.argv[2] || 'eventOn';

function readCard(file) {
    const buf = fs.readFileSync(file);
    let off = 8, data = null;
    while (off < buf.length - 8) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (type === 'tEXt') {
            const chunk = buf.toString('utf8', off + 8, off + 8 + len);
            const z = chunk.indexOf('\0');
            if (chunk.slice(0, z) === 'chara') data = Buffer.from(chunk.slice(z + 1), 'base64').toString('utf8');
        }
        if (type === 'IEND') break;
        off += 12 + len;
        if (len > buf.length) break;
    }
    return data ? JSON.parse(data) : null;
}

for (const f of fs.readdirSync(LIB).filter(x => /\.png$/i.test(x))) {
    let card;
    try { card = readCard(path.join(LIB, f)); } catch { continue; }
    if (!card) continue;
    const d = card.data || card;
    const regexes = (d.extensions && d.extensions.regex_scripts) || d.regex_scripts || [];
    for (let i = 0; i < regexes.length; i++) {
        const rep = String(regexes[i].replaceString || '');
        if (rep.length < 500) continue;
        const re = new RegExp(`(^|[^\\w.$])${TARGET}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(rep))) {
            console.log(`\n=== ${f}  regex[${i}] ${regexes[i].scriptName || ''} ===`);
            console.log(JSON.stringify(rep.slice(Math.max(0, m.index - 200), m.index + 400)));
            break;
        }
    }
}
