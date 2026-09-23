/**
 * 查看指定卡片的原始元数据（2026-09-23）
 * 用法：node scripts/probes/_probe-card-raw-of.mjs <文件路径1> [文件路径2 ...]
 */
import fs from 'node:fs';
function extractCard(p) {
    const buf = fs.readFileSync(p);
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const dataStart = off + 8;
        if (type === 'tEXt' || type === 'iTXt') {
            const chunk = buf.toString('latin1', dataStart, dataStart + len);
            const z = chunk.indexOf('\0');
            const kw = chunk.slice(0, z);
            if (kw === 'chara' || kw === 'ccv3') {
                try {
                    const b64 = type === 'iTXt' ? chunk.slice(z + 1) : chunk.slice(z + 1);
                    const json = Buffer.from(b64, 'base64').toString('utf8');
                    return JSON.parse(json);
                } catch (e) { return { _err: e.message, _kw: kw }; }
            }
        }
        if (type === 'IEND') break;
        off = dataStart + len + 4;
    }
    return null;
}
for (const p of process.argv.slice(2)) {
    try {
        const c = extractCard(p);
        const inner = c ? (c.data || c) : null;
        console.log(JSON.stringify({
            file: p.split(/[\\/]/).pop(),
            spec: c && c.spec,
            spec_version: c && c.spec_version,
            innerName: inner && inner.name,
            innerCreator: inner && inner.creator,
            descHead: inner && typeof inner.description === 'string' ? inner.description.slice(0, 60) : null,
            descLen: inner && typeof inner.description === 'string' ? inner.description.length : 0,
            firstMesLen: inner && typeof inner.first_mes === 'string' ? inner.first_mes.length : 0,
            tags: inner && inner.tags
        }));
    } catch (e) {
        console.log(JSON.stringify({ file: p, err: e.message }));
    }
}
