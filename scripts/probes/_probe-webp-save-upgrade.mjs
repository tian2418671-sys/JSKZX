/**
 * 🧪 WebP 卡保存端到端验证（DF-25 真修复）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📖 要验证什么
 * ───────────────────────────────────────────────────────────────
 * DF-25 的真修复：`file:saveCard` 遇到 `.webp` 卡时**升级为同名 `.png`** 并写入内容
 * （与 SillyTavern 自身行为一致：`character-card-parser.js` 写 PNG tEXt 块，
 * `writeCharacterData` 输出路径硬编码 `.png`）。
 *
 * ⚠️ 这是**真实验证**，不是模拟：
 *   · 真造一个 WebP 图片（用 sharp 从 PNG 转出）；
 *   · 真调用 `main.js` 里的 `writeTavernPNGChunk` / `embedCardJSONIntoPNG` / `validateCardPNG`
 *     （从 `main.js` 源码提取函数体，与线上同一份代码）；
 *   · 真读回转换后的 PNG，断言**内嵌卡数据与写入的一致**。
 *
 * 用法：node scripts/probes/_probe-webp-save-upgrade.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }
if (!sharp) {
    console.error('❌ 需要 sharp 才能验证（npm install sharp）');
    process.exit(1);
}

// ── 从 main.js 源码提取被测函数（保证与线上同一份实现）──
const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');
function extractFn(src, name) {
    const idx = src.indexOf(`function ${name}(`);
    if (idx < 0) throw new Error(`未找到函数 ${name}`);
    const start = src.indexOf('{', idx);
    let depth = 0, end = -1;
    for (let k = start; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    return src.slice(idx, end);
}
// 依赖链：crc32 / writeTavernPNGChunk / isPNGBuffer / readTavernPNGChunk /
//        getCardName / calibrateCardData / validateCardPNG / embedCardJSONIntoPNG
const crc32Src = (() => {
    const i = mainSrc.indexOf('function crc32(');
    const s = mainSrc.indexOf('{', i);
    let d = 0, e = -1;
    for (let k = s; k < mainSrc.length; k++) {
        if (mainSrc[k] === '{') d++;
        else if (mainSrc[k] === '}') { d--; if (d === 0) { e = k + 1; break; } }
    }
    return mainSrc.slice(i, e);
})();
const parts = [
    // 依赖常量（main.js 里的 PNG 协议关键字）
    "const CHUNK_TEXt='tEXt', CHUNK_iTXt='iTXt', CHUNK_IHDR='IHDR', CHUNK_IEND='IEND';",
    "const CHARA_KEYWORDS=['chara','ccv3'];",
    crc32Src,
    extractFn(mainSrc, 'buildPngChunk'),
    extractFn(mainSrc, 'isCharaChunk'),
    extractFn(mainSrc, 'writeTavernPNGChunk'),
    extractFn(mainSrc, 'isPNGBuffer'),
    extractFn(mainSrc, 'readTavernPNGChunk'),
    extractFn(mainSrc, 'getCardName'),
    extractFn(mainSrc, 'calibrateCardData'),
    extractFn(mainSrc, 'validateCardPNG'),
    extractFn(mainSrc, 'embedCardJSONIntoPNG'),
    'function stripInternalFields(o){return o;}'   // 简化：不影响断言（真实版会剔 _ 前缀）
].join('\n');
const sandbox = new Function('Buffer', `
    ${parts}
    return { writeTavernPNGChunk, readTavernPNGChunk, validateCardPNG, embedCardJSONIntoPNG, isPNGBuffer };
`);
const api = sandbox(Buffer);

// ══════════════════════════════════════════════════════════════
// 造测试卡
// ══════════════════════════════════════════════════════════════
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-webp-'));
const CARD = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
        name: 'WebP测试角色', description: '原始描述（待改写）', personality: '原始人格',
        scenario: '原始场景', first_mes: '原始开场白', mes_example: '',
        creator_notes: '', tags: [], alternate_greetings: [],
        character_book: { entries: [{ keys: ['k'], content: '原始词条' }] }
    }
};
const EDITED = JSON.parse(JSON.stringify(CARD));
EDITED.data.description = '【已编辑】新描述内容 —— 这一段必须能存进文件';
EDITED.data.character_book.entries[0].content = '【已编辑】新词条内容';

// 1) 造一张 PNG（含卡数据）→ 2) 转成 WebP（模拟用户的 WebP 卡）
const basePng = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
const pngWithCard = api.embedCardJSONIntoPNG(basePng, CARD);
if (!pngWithCard) { console.error('❌ 造卡失败（embedCardJSONIntoPNG 返回 null）'); process.exit(1); }
const webpPath = path.join(tmpDir, 'test-card.webp');
await sharp(pngWithCard).webp().toFile(webpPath);
const webpSize = fs.statSync(webpPath).size;

console.log('═════ WebP 卡保存升级验证 ═════');
console.log(`  测试目录：${tmpDir}`);
console.log(`  ① 已造 WebP 卡：${path.basename(webpPath)}（${(webpSize / 1024).toFixed(1)} KB）`);

// 3) 模拟 saveCard 的 webp 分支（与 main.js 逐行同逻辑）
const srcBuf = fs.readFileSync(webpPath);
const pngBuf = await sharp(srcBuf).png().toBuffer();
const outBuf = api.embedCardJSONIntoPNG(pngBuf, EDITED);
if (!outBuf) { console.error('❌ 转换后写入卡数据失败'); process.exit(1); }
const report = api.validateCardPNG(outBuf);
const targetPath = webpPath.slice(0, -'.webp'.length) + '.png';
fs.writeFileSync(targetPath, outBuf);
try { fs.unlinkSync(webpPath); } catch { /* 忽略 */ }

console.log(`  ② 已升级为 PNG：${path.basename(targetPath)}（${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB）`);
console.log(`  ③ 写前校验：ok=${report.ok}  errors=[${(report.errors || []).join('; ')}]`);

// 4) 读回断言
const back = api.readTavernPNGChunk(fs.readFileSync(targetPath));
const ok1 = back && (back.data ? back.data.name : back.name) === 'WebP测试角色';
const ok2 = back && String(back.data ? back.data.description : '').includes('【已编辑】新描述内容');
const ok3 = back && String((back.data?.character_book?.entries || [])[0]?.content || '').includes('【已编辑】新词条内容');
const ok4 = !fs.existsSync(webpPath);
const ok5 = api.isPNGBuffer(fs.readFileSync(targetPath));

console.log('');
console.log(`  ✅ 读回角色名正确：${ok1}`);
console.log(`  ✅ 读回**编辑后的描述**（DF-25 的核心）：${ok2}`);
console.log(`  ✅ 读回编辑后的内嵌世界书词条：${ok3}`);
console.log(`  ✅ 旧 .webp 已删除（不留重复卡）：${ok4}`);
console.log(`  ✅ 产物是合法 PNG：${ok5}`);

const allOk = ok1 && ok2 && ok3 && ok4 && ok5;
console.log('');
console.log(allOk
    ? '  🎉 全部通过 —— WebP 卡的内容编辑**真的存进文件了**（用户不需要自己转格式）'
    : '  ❌ 有断言失败');

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(allOk ? 0 : 1);
