/**
 * 卡内插件容器形态 / 解析开销探针（**离线**，不需要起应用）
 *
 * 为什么要有它：
 *   角色卡里「酒馆助手脚本」的存放位置与形态并不统一（同一字段还可能有多种导出形态）。
 *   任何要读/写卡内插件的功能，**动工前先用它把真实卡库统计一遍**，否则很容易只兼容一种形态，
 *   用户侧看到的就是「明明有脚本却显示没有」（历史缺陷 CT-19 同类思路：先量数据再写代码）。
 *
 * 用法：
 *   node scripts/probes/_probe-card-plugins.mjs "E:\AI\酒馆工具\角色卡"            # 形态统计（默认）
 *   node scripts/probes/_probe-card-plugins.mjs "E:\AI\酒馆工具\角色卡" --perf     # 另加解析开销（含最重卡）
 *   node scripts/probes/_probe-card-plugins.mjs "<库根>" 500                      # 只扫前 500 张（大库抽样）
 *
 * 形态统计输出：
 *   · 每个「容器路径」命中的卡数（如 extensions.tavern_helper.scripts / TavernHelper_scripts / regex_scripts …）
 *   · 每种形态的样例（首条脚本的字段名），用于确认解析器要兼容哪些写法
 *
 * `--perf` 输出：
 *   · `harvestCardPlugins()` 单次耗时（按卡内脚本正文总量排序的最重 5 张 + 全库均值）
 *   · 该函数在每次 `refreshCardData()`（如描述框逐键输入）都会重跑，所以它必须够快
 *
 * 备注：
 *   · 只读卡库，不写任何文件；PNG 读 `tEXt`/`iTXt` 的 `chara`(=V2) / `ccv3`(=V3)
 *   · Node 会提示 `MODULE_TYPELESS_PACKAGE_JSON` 警告（本项目 package.json 无 "type" 字段，
 *     `js/utils/cardPlugins.js` 是 ESM 语法，靠语法探测加载）—— 属预期，不影响结果
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const PERF = args.includes('--perf');
const positional = args.filter((a) => !a.startsWith('--'));
const ROOT = positional[0] || process.env.CARD_LIB || 'E:\\AI\\酒馆工具\\角色卡';
const LIMIT = Number(positional[1] || 0);   // 0 = 不限

/** PNG 里的 tEXt / iTXt 文本块（SillyTavern：chara=base64 JSON(V2)，ccv3=base64 JSON(V3)） */
function readPngText(buffer) {
    const out = {};
    if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return out;
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const len = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const start = offset + 8;
        const end = start + len;
        if (end > buffer.length) break;
        if (type === 'tEXt') {
            const chunk = buffer.subarray(start, end);
            const sep = chunk.indexOf(0);
            if (sep > 0) out[chunk.toString('latin1', 0, sep)] = chunk.toString('latin1', sep + 1);
        } else if (type === 'iTXt') {
            const chunk = buffer.subarray(start, end);
            const sep = chunk.indexOf(0);
            if (sep > 0) {
                const keyword = chunk.toString('latin1', 0, sep);
                const compFlag = chunk[sep + 1];
                let p = sep + 3;
                p = chunk.indexOf(0, p) + 1;
                p = chunk.indexOf(0, p) + 1;
                let text = chunk.subarray(p);
                if (compFlag === 1) { try { text = zlib.inflateSync(text); } catch { /* 忽略 */ } }
                out[keyword] = text.toString('utf8');
            }
        }
        if (type === 'IEND') break;
        offset = end + 4;
    }
    return out;
}

function loadCard(file) {
    try {
        if (/\.json$/i.test(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
        const texts = readPngText(fs.readFileSync(file));
        const raw = texts.ccv3 || texts.chara;
        if (!raw) return null;
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

/** V1 扁平 / V2 / V3 → 统一取数据层 */
function unwrap(json) {
    return (json && json.data && typeof json.data === 'object') ? json.data : json;
}

const files = [];
(function walk(dir, depth) {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.(png|json)$/i.test(e.name) && !/\.tmp$/i.test(e.name)) files.push(p);
    }
})(ROOT, 0);

const cards = [];
const shapeHits = new Map();
let skipped = 0;

for (const file of files) {
    if (LIMIT && cards.length >= LIMIT) break;
    const json = loadCard(file);
    const data = unwrap(json);
    if (!data || typeof data !== 'object' || (!data.name && !data.description && !data.first_mes)) { skipped++; continue; }
    cards.push({ file: path.basename(file), data });

    const ext = data.extensions;
    if (!ext || typeof ext !== 'object') continue;
    const shapes = [];
    if (ext.tavern_helper !== undefined) {
        const h = ext.tavern_helper;
        shapes.push(Array.isArray(h)
            ? (Array.isArray(h[0]) ? 'extensions.tavern_helper（键值对数组）' : `extensions.tavern_helper（数组 ${h.length}）`)
            : `extensions.tavern_helper.${Object.keys(h).join('+') || '(空对象)'}`);
    }
    for (const k of ['TavernHelper_scripts', 'tavern_helper_scripts', 'tavernHelper_scripts']) {
        if (Array.isArray(ext[k])) shapes.push(`extensions.${k}（旧版数组 ${ext[k].length}）`);
    }
    if (Array.isArray(ext.regex_scripts)) shapes.push(`extensions.regex_scripts（${ext.regex_scripts.length}）`);
    for (const k of ['cfMvuVarGroups', 'mvu_worldbook_name', 'SPreset', 'xiaobaix-tasks', 'xiaobaix-template', 'chub', 'aifuck_metadata']) {
        if (ext[k] !== undefined) shapes.push(`extensions.${k}`);
    }
    for (const s of shapes) {
        const hit = shapeHits.get(s) || { count: 0, samples: [] };
        hit.count++;
        if (hit.samples.length < 3) hit.samples.push(path.basename(file));
        shapeHits.set(s, hit);
    }
}

console.log(`\n📚 卡库：${ROOT}`);
console.log(`解析成功 ${cards.length} 张（跳过非卡文件 ${skipped} 个；共发现文件 ${files.length} 个）\n`);
console.log('=== 插件容器形态命中 ===');
for (const [shape, hit] of [...shapeHits.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${String(hit.count).padStart(5)} 张  ${shape}`);
    console.log(`         样例：${hit.samples.join('、')}`);
}

// 脚本条目的字段名（确认解析器该兼容哪些键）
const fieldHits = new Map();
for (const { data } of cards) {
    const h = data.extensions && data.extensions.tavern_helper;
    let list = null;
    if (Array.isArray(h) && Array.isArray(h[0])) list = (h.find((p) => Array.isArray(p) && p[0] === 'scripts') || [])[1];
    else if (h && Array.isArray(h.scripts)) list = h.scripts;
    if (Array.isArray(list) && list.length && typeof list[0] === 'object') {
        const keys = Object.keys(list[0].value && typeof list[0].value === 'object' ? list[0].value : list[0]).join(',');
        fieldHits.set(keys, (fieldHits.get(keys) || 0) + 1);
    }
}
if (fieldHits.size) {
    console.log('\n=== 脚本条目的字段组合（括号内为出现卡数） ===');
    for (const [keys, n] of [...fieldHits.entries()].sort((a, b) => b[1] - a[1])) console.log(`  (${n})  ${keys}`);
}

if (PERF) {
    const { harvestCardPlugins } = await import('../../js/utils/cardPlugins.js');
    const timed = cards.map(({ file, data }) => {
        const info = harvestCardPlugins(data);
        const chars = info.groups.filter((g) => g.kind === 'script')
            .flatMap((g) => g.items.map((i) => i.chars)).reduce((a, b) => a + b, 0);
        return { file, data, scripts: info.total, chars };
    }).sort((a, b) => b.chars - a.chars);

    console.log('\n=== 最重的 5 张（harvestCardPlugins 单次耗时） ===');
    for (const c of timed.slice(0, 5)) {
        harvestCardPlugins(c.data);   // 预热
        const N = 200;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) harvestCardPlugins(c.data);
        console.log(`${((performance.now() - t0) / N).toFixed(3)} ms/次  脚本 ${c.scripts} 条 / 正文 ${c.chars} 字符  ${c.file.slice(0, 40)}`);
    }
    let sum = 0;
    let worst = { per: 0, file: '' };
    for (const c of timed) {
        const N = 50;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) harvestCardPlugins(c.data);
        const per = (performance.now() - t0) / N;
        sum += per;
        if (per > worst.per) worst = { per, file: c.file };
    }
    if (timed.length) {
        console.log(`\n全库：平均 ${(sum / timed.length).toFixed(3)} ms/次，最慢 ${worst.per.toFixed(3)} ms（${worst.file.slice(0, 40)}）`);
        console.log('（参考：该函数在每次 refreshCardData() 都会重跑，例如描述框逐键输入）');
    }
}
