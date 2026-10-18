/**
 * 真实库全量扫描：卡内脚本（regex replaceString / 内嵌世界书 / 首句）里引用了哪些酒馆助手 API。
 * 目的：找出「同类 bug」的完整清单 —— 沙箱桥接缺哪些全局函数，就会在哪些卡上翻成空白/报错。
 */
import fs from 'node:fs';
import path from 'node:path';

const LIB = process.argv[2] || 'E:\\AI\\酒馆工具\\角色卡';

// 酒馆助手 / ST 常见全局 API 清单（面板脚本可能调用）
const API = [
    'getChatMessages', 'setChatMessages', 'createChatMessages', 'deleteChatMessages',
    'getCurrentMessageId', 'getLastMessageId', 'formatAsDisplayedMessage',
    'getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables',
    'getMessageVar', 'getAllVariables', 'updateVariables',
    'getCharacter', 'getCharacterCard', 'getLorebookEntries', 'getLorebookSettings',
    'getWorldbookNames', 'getWorldbook', 'replaceWorldbook',
    'eventOn', 'eventOnce', 'eventEmit', 'eventRemoveListener', 'eventClearAll',
    'tavern_events', 'getTavernHelperVersion', 'getTavernHelper',
    'toastr', 'getRequestHeaders', 'triggerSlash', 'generate', 'generateRaw',
    'getLastMessage', 'setChatMessage', 'deleteChatMessage', 'stopGeneration',
    'SillyTavern', 'getContext', 'substitudeMacros', 'getLastUserMessage',
    'getPreset', 'setPreset', 'getPresetNames', 'getCharData', 'getChatHistory',
    'audioEnable', 'audioPlay', 'audioMode', 'playAudio', 'stopAudio',
    'getIframeName', 'getButtonEvent', 'getScriptId', 'getCharacterId',
    'registerSlashCommand', 'unregisterSlashCommand', 'builtin',
    'getTavernRegexes', 'formatAsTavernRegexedString', 'isCharacterCard',
    'getWorldbookNames', 'createWorldbook', 'deleteWorldbook',
    'getLorebookEntry', 'createLorebookEntries', 'setLorebookEntries'
];

/** 从 PNG 提取 chara */
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

const files = fs.readdirSync(LIB).filter(f => /\.png$/i.test(f));
const hits = new Map();   // api → [{card, where}]
let scanned = 0, parsed = 0;

for (const f of files) {
    scanned++;
    let card;
    try { card = readCard(path.join(LIB, f)); } catch { continue; }
    if (!card) continue;
    parsed++;

    const chunks = [];
    const d = card.data || card;
    // 正则替换串（面板 HTML 主要来源）
    const regexes = (d.extensions && d.extensions.regex_scripts) || d.regex_scripts || [];
    if (Array.isArray(regexes)) {
        regexes.forEach((r, i) => {
            const rep = String(r.replaceString || '');
            if (rep.length > 500) chunks.push([`regex[${i}]${r.scriptName || ''}`, rep]);
        });
    }
    // 内嵌世界书里也可能有脚本
    const book = d.character_book || (d.data && d.data.character_book);
    if (book && Array.isArray(book.entries)) {
        for (const e of book.entries) {
            const c = String(e.content || '');
            if (c.length > 500 && /<script|function\s*\(/.test(c)) chunks.push([`wb:${e.comment || e.name || ''}`, c]);
        }
    }
    for (const [where, text] of chunks) {
        for (const api of API) {
            // 只认「作为函数调用」或「作为全局变量裸引用」
            const callRe = new RegExp(`(^|[^\\w.$])${api}\\s*\\(`);
            if (callRe.test(text)) {
                if (!hits.has(api)) hits.set(api, []);
                const arr = hits.get(api);
                if (!arr.some(x => x.card === f)) arr.push({ card: f, where });
            }
        }
    }
}

console.log(`扫描 ${scanned} 个 PNG，解析成功 ${parsed} 个\n`);
const sorted = [...hits.entries()].sort((a, b) => b[1].length - a[1].length);
console.log('=== 卡内面板实际调用的 API（按出现卡数排序）===');
for (const [api, arr] of sorted) {
    console.log(`${String(arr.length).padStart(3)} 张  ${api}`);
    arr.slice(0, 3).forEach(x => console.log(`         └ ${x.card}  @ ${x.where}`));
}
fs.writeFileSync(process.env.TEMP + '\\api-usage.json', JSON.stringify(Object.fromEntries(sorted), null, 1), 'utf8');
console.log('\n明细已写入 %TEMP%\\api-usage.json');
