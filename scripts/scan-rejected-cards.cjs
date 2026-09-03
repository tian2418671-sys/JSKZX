// 临时：扫描万卡库，找出"像角色卡但被血统鉴定拒绝"的 JSON
const fs = require('fs');
const path = require('path');

(async () => {
    const { isCharacterCardData } = await import('../js/utils/cardLoader.js');
    const root = 'I:/03/角色色卡';
    const out = [];
    function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.toLowerCase().endsWith('.json')) {
                try {
                    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                    const looksCard = Boolean(j && typeof j === 'object'
                        && (j.spec || j.name || j.char_name || j.character || j.data));
                    if (looksCard && !isCharacterCardData(j)) {
                        out.push(e.name + ' | 字段:' + Object.keys(j).slice(0, 6).join(','));
                    }
                } catch (err) { /* 解析失败跳过 */ }
            }
        }
    }
    walk(root);
    console.log('疑似角色卡但被拒:', out.length);
    out.forEach(x => console.log(' ', x));
})().catch(e => { console.error(e); process.exit(1); });
