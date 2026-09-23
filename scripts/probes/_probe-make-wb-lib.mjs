/**
 * 世界书压力库生成器（500 个 .json / ≈3.5GB）
 *
 * 用法：
 *   node scripts/probes/_probe-make-wb-lib.mjs            # 生成
 *   node scripts/probes/_probe-make-wb-lib.mjs --clean    # 删除整个压力库
 *
 * 为什么要"改写"而不是全量复制：
 *   ① 全量复制只能测「扫描 / 渲染 / 内存」这类规模问题；
 *   ② 差异对比（差异着色 textDiff.js）必须有**同源但内容不同**的文件对才测得到；
 *   ③ 同名查重需要**不同目录下的同名文件**（渲染层按 data.name || 文件名 聚类）；
 *   ④ 内容级查重（MinHash）需要**不同文件名但内容相同/近似**的文件。
 *
 * 目录结构（D:\TkDmGzq\_wb500）：
 *   .templates/                        ← 改写变体模板（点开头 → 应用的 walk 会跳过，不会污染 total）
 *   *.json                             ← **第 1 组直接放根目录**（关键！）
 *   g02/ .. g20/                       ← 其余 19 组，每组 25 个文件
 *
 * ⚠️ 为什么第 1 组必须放根目录：`wb:scan` 的白名单指纹验证**只 readdir 顶层**
 *   （`fs.readdirSync(dirPath).filter(endsWith('.json')).slice(0,20)`），
 *   若顶层只有目录没有 .json → `hasWbFingerprint=false` → 直接返回
 *   「该目录不含有效世界书文件…已拒绝授权」。放一份在根目录即可通过。
 *
 * 合计 542 个 .json：
 *   20 组 × 27 个（**每组 25 本有效世界书** + 2 个诱饵） = 540
 *   根目录另加：`非世界书-损坏.json`（坏 JSON）、`超巨世界书-55MB.json`（>50MB 懒加载档） = 2
 *   ⇒ 有效世界书 = 25 × 20 + 1（超巨） = **501**；应被跳过 = 40 诱饵 + 1 坏 JSON = 41
 *
 * ⚠️ 点开头的 `.templates/` 不计入（walk 与 countJson 都跳过）。
 *     ├ 炎孕-异世界工口学院物语-威力加强版 世界书.json   基准（6.47MB，同名跨目录 ×20）
 *     ├ 女神攻略调教手册.json                            基准（9.93MB，同名跨目录 ×20）
 *     ├ 炎孕-副本01..13.json                             完全一致副本（异名同内容 ×13）
 *     ├ 女神-副本01..04.json                             完全一致副本 ×4
 *     ├ 炎孕-改写A..D.json                               ★ 改写变体（差异对比用）
 *     └ 非世界书-角色卡.json / 非世界书-大表格.json        诱饵（应被 isValidWorldbook 拦下）
 *   g01/ 额外：非世界书-损坏.json（坏 JSON）、超巨世界书-55MB.json（>50MB 懒加载档）
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = 'D:/TkDmGzq/世界书';
const OUT = 'D:/TkDmGzq/_wb500';
const PACKS = 20;

const SRC_A = path.join(SRC_DIR, '炎孕-异世界工口学院物语-威力加强版 世界书.json');
const SRC_B = path.join(SRC_DIR, '女神攻略调教手册.json');

const A_NAME = '炎孕-异世界工口学院物语-威力加强版 世界书.json';
const B_NAME = '女神攻略调教手册.json';

const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

// ── --clean ─────────────────────────────────────────────────────────────
if (process.argv.includes('--clean')) {
    if (fs.existsSync(OUT)) {
        fs.rmSync(OUT, { recursive: true, force: true });
        console.log('已删除 ' + OUT);
    } else {
        console.log('无需删除（不存在）：' + OUT);
    }
    process.exit(0);
}

// ── 前置校验 ────────────────────────────────────────────────────────────
for (const p of [SRC_A, SRC_B]) {
    if (!fs.existsSync(p)) { console.error('源文件不存在: ' + p); process.exit(1); }
}
const sizeA = fs.statSync(SRC_A).size;
const sizeB = fs.statSync(SRC_B).size;
console.log('源 A: ' + mb(sizeA) + '   源 B: ' + mb(sizeB));

const rawA = fs.readFileSync(SRC_A, 'utf8');

// ── 改写变体（★ 差异对比用）────────────────────────────────────────────
// 统一把 entries 字典 → 数组 → 再回字典，保证 JSON 合法且仍是标准世界书
const buildVariant = (mutate) => {
    const d = JSON.parse(rawA);                       // 每次重新解析，避免共享引用
    const arr = Object.values(d.entries);
    mutate(arr, d);
    const dict = {};
    arr.forEach((e, i) => { dict[String(i)] = e; });
    d.entries = dict;
    return JSON.stringify(d);
};

const VARIANTS = {
    // A：改一个词条的正文（尾部追加）+ 改 comment → 测「同词条内容变更」
    '炎孕-改写A.json': buildVariant((arr) => {
        arr[0].content += '\n\n【改写A追加】这一段是压力测试新增的说明文字，用于验证差异着色能标出变更行。';
        arr[0].comment = arr[0].comment + '（改写A）';
    }),
    // B：新增 2 个词条 → 测 [新增] 标记
    '炎孕-改写B.json': buildVariant((arr) => {
        arr.push({
            uid: 900001, key: ['压力测试新增词条'], keysecondary: [], comment: '压力测试新增1',
            content: '这是压力测试新增的第一个词条正文。\n第二行内容。', disable: false,
            constant: false, selective: true, order: 100, position: 0, extensions: {}
        });
        arr.push({
            uid: 900002, key: ['压力测试新增词条2'], keysecondary: [], comment: '压力测试新增2',
            content: '这是压力测试新增的第二个词条正文。', disable: false,
            constant: false, selective: true, order: 101, position: 0, extensions: {}
        });
    }),
    // C：删掉 3 个词条 → 测 [缺失] 标记
    '炎孕-改写C.json': buildVariant((arr) => {
        arr.splice(3, 3);
    }),
    // D：改 key + 在长正文中间插入/删除行 → 测「行级对齐 + 行内精确高亮」
    '炎孕-改写D.json': buildVariant((arr) => {
        const e = arr[5];
        if (Array.isArray(e.key)) e.key = e.key.concat(['压力测试触发词']);
        const lines = String(e.content || '').split('\n');
        lines.splice(Math.floor(lines.length / 2), 0, '【改写D插入行】插在正文中段的一行。');
        if (lines.length > 3) lines.splice(2, 1);   // 同时删一行，制造"错位"场景
        e.content = lines.join('\n');
    })
};

// ── 诱饵（应被 isValidWorldbook 拦下）──────────────────────────────────
const DECOYS = {
    // 规则①：spec=chara_card_v2 → 直接判定不是世界书
    '非世界书-角色卡.json': JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name: '压力测试角色卡', description: '这不是世界书。', first_mes: '你好。' }
    }, null, 2),
    // >512KB 且头部 64KB 无 "entries" → 走「大文件头部预检」跳过路径（valid:null）
    '非世界书-大表格.json': '{\n  "table_data": [' +
        Array.from({ length: 12000 }, (_, i) => `{"row":${i},"name":"数据行${i}","value":"${'x'.repeat(40)}"}`).join(',\n  ') +
        ']\n}'
};

// ── 生成模板 ────────────────────────────────────────────────────────────
// ⚠️ 目录名以 `.` 开头：应用的 wb:scan walk 与 countJson 都会跳过点开头目录，
//    否则模板会被当成正式世界书重复入库、进度条 total 也会多算 6 个。
const TPL = path.join(OUT, '.templates');
fs.mkdirSync(TPL, { recursive: true });

const tplFiles = [];
for (const [name, text] of Object.entries({ ...VARIANTS, ...DECOYS })) {
    const p = path.join(TPL, name);
    fs.writeFileSync(p, text, 'utf8');
    tplFiles.push({ name, size: Buffer.byteLength(text) });
}
console.log('模板已生成 ' + tplFiles.length + ' 个：');
tplFiles.forEach(t => console.log('  ' + t.name + '  ' + mb(t.size)));

// ── 组装 542 个文件 ────────────────────────────────────────────────────
// 每组 27 个（文件名组内唯一）：
//   1 基准A + 1 基准B + 15 副本A + 4 副本B + 4 改写 + 2 诱饵 = 27
//   ⇒ 每组有效世界书 = 1+1+15+4+4 = 25 本，20 组 = 500 本（+1 超巨）
const plan = [];
plan.push({ src: SRC_A, dst: A_NAME });
plan.push({ src: SRC_B, dst: B_NAME });
for (let i = 1; i <= 15; i++) plan.push({ src: SRC_A, dst: `炎孕-副本${String(i).padStart(2, '0')}.json` });
for (let i = 1; i <= 4; i++) plan.push({ src: SRC_B, dst: `女神-副本${String(i).padStart(2, '0')}.json` });
for (const n of Object.keys(VARIANTS)) plan.push({ src: path.join(TPL, n), dst: n });
for (const n of Object.keys(DECOYS)) plan.push({ src: path.join(TPL, n), dst: n });
if (plan.length !== 27) { console.error('每组计划数 ≠ 27：' + plan.length); process.exit(1); }

const t0 = Date.now();
let written = 0; let bytes = 0;
for (let g = 1; g <= PACKS; g++) {
    // ⚠️ 第 1 组写根目录（为了让 wb:scan 的顶层指纹验证通过），其余组写 gNN/
    const dir = (g === 1) ? OUT : path.join(OUT, 'g' + String(g).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    for (const it of plan) {
        const target = path.join(dir, it.dst);
        if (!fs.existsSync(target)) {
            fs.copyFileSync(it.src, target);
            written++;
            bytes += fs.statSync(target).size;
        }
    }
    process.stdout.write(`\r已生成 ${g}/${PACKS} 组 ...`);
}

// ── 第 1 组专属：坏 JSON + >50MB 超巨世界书（懒加载档）──────────────────
const g01 = OUT;   // 第 1 组 = 根目录
fs.writeFileSync(path.join(g01, '非世界书-损坏.json'), '{ 这不是合法 JSON,,,', 'utf8');
const HUGE = path.join(g01, '超巨世界书-55MB.json');
if (!fs.existsSync(HUGE)) {
    // 把 397 个词条按轮次复制，撑到 >50MB（测 SCAN_PARSE_MAX_BYTES 的「只回元数据」路径）。
    // 实测单条 ≈ 8.7KB，故按目标字节数反推轮数，避免一次性 stringify 巨型对象。
    const TARGET = 55 * 1024 * 1024;
    const d = JSON.parse(rawA);
    const base = Object.values(d.entries);
    const oneEntryBytes = Buffer.byteLength(JSON.stringify(base[0]), 'utf8') + 20;
    // +1 轮兜底：字节估算必然有偏差，必须**确实**越过 50MB，否则会落回「仍解析」档，测不到懒加载路径
    const rounds = Math.ceil(TARGET / (oneEntryBytes * base.length)) + 1;
    const dict = {}; let n = 0;
    for (let r = 0; r < rounds; r++) {
        for (const e of base) {
            const c = JSON.parse(JSON.stringify(e));
            c.uid = 500000 + n;
            dict[String(n)] = c;
            n++;
        }
    }
    d.entries = dict;
    fs.writeFileSync(HUGE, JSON.stringify(d), 'utf8');
    console.log('超巨世界书：' + n + ' 词条 / ' + mb(fs.statSync(HUGE).size));
}
const hugeSize = fs.statSync(HUGE).size;

const total = written;
console.log('\n\n═════ 世界书压力库生成完成 ═════');
console.log('输出目录 : ' + OUT);
console.log('文件总数 : ' + total + ' 个 .json（20 组 × 27）');
console.log('有效世界书: ' + (PACKS * 25 + 1) + ' 本（应入库）');
console.log('应被跳过 : ' + (PACKS * 2 + 1) + ' 个（40 诱饵 + 1 坏 JSON）');
console.log('占用体积 : ' + (bytes / 1073741824).toFixed(2) + ' GB');
console.log('超巨书   : 超巨世界书-55MB.json = ' + mb(hugeSize) + '（根目录，测懒加载档）');
console.log('耗时     : ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('\n文件构成（每组 27 个）：');
console.log('  同名跨目录 ×20 : ' + A_NAME + ' / ' + B_NAME);
console.log('  异名同内容     : 炎孕-副本01..15、女神-副本01..04');
console.log('  ★ 改写变体     : 炎孕-改写A(改正文) / B(增词条) / C(删词条) / D(改key+插入删除行)');
console.log('  诱饵（应跳过） : 非世界书-角色卡 / 非世界书-大表格');
