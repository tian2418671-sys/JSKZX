/**
 * 🏭 合成预设库生成器（用于**预设查重阈值标定**）
 *
 * ═══════════════════════════════════════════════════════════════
 * 📖 为什么需要它
 * ───────────────────────────────────────────────────────────────
 * 预设查重的阈值（结构 0.95 / 内容 0.90 / 内容低线 0.70）**一直未标定** ——
 * 本机真实预设库**为空**（全机搜索仅 2 个 0KB 测试文件），
 * 而评估报告指出：**用 1 对正样本定阈值 = 必然过拟合**（PK-29 的教训：
 * 合成样本定 T=19 → 真实库 18 对里 10 对误报）。
 *
 * ⇒ 本生成器**显式造出「已知真值」的样本对**，让标定有**可控的真值**可依：
 *   每对样本都带 `_groundTruth`（`dup` 同源 / `diff` 无关），
 *   且**同源对的相似度是可控的**（按「改多少块 / 改多少字」参数化）。
 *
 * ⚠️ **诚实的局限**（必须写进结论，不得宣称「已用真实库标定」）：
 *   合成样本的**文本分布**与真实预设不同（真实预设是 118~261 块、正文可达 MB 级，
 *   且大量中英混排、含 Jinja 模板与正则）。故本生成器只能标定**算法判别力**，
 *   不能替代真实库标定。**结论必须标注「合成样本标定」**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 🎯 样本族设计（覆盖真实预设的**关键差异类型**）
 * ───────────────────────────────────────────────────────────────
 * | 族 | 真值 | 构造方式 | 要验证什么 |
 * |---|---|---|---|
 * | `exact` | dup | 逐字节相同（仅文件名不同） | 能否判「完全重复」 |
 * | `renamed` | dup | 结构与正文全同，**仅名称不同** | **改名同源**（旧实现漏报的核心场景） |
 * | `reskin` | dup | 结构同、正文按比例改写 | 「结构相同换皮」能否与「无关」区分 |
 * | `trimmed` | dup | 结构同、正文删减（截断） | 「删减版」能否召回 |
 * | `extended` | dup | 结构同、正文追加 | 「增补版」能否召回 |
 * | `reorder` | dup | 结构与正文同、**块顺序打乱** | 「内容相同重排」 |
 * | `flipped` | dup | 结构与正文同、**部分块 enabled 取反** | 「启用状态不同」（P1-5） |
 * | `sampler` | dup | 结构与正文同、**仅采样参数不同** | 「参数变体」 |
 * | `unrelated` | diff | 完全不同主题、不同块名 | 无关对**必须判 DIFFERENT**（防误报） |
 * | `sameNameOnly` | diff | **名称相同**但结构/正文都无关 | 「同名但无关」（AR-48 同型，最危险） |
 * | `sharedSkeleton` | diff | 只有 12 个默认骨架块相同，自定义块全不同 | 骨架造成的「基础分」会不会误报 |
 *
 * 用法：
 *   node scripts/tools/make-preset-lib.mjs "D:\TkDmGzq\_preset-calib" [--clean]
 */

import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || 'D:\\TkDmGzq\\_preset-calib';
const CLEAN = process.argv.includes('--clean');

// ══════════════════════════════════════════════════════════════
// 基础素材（**刻意做成「像真实预设」**：中英混排 + 模板语法 + 结构化块）
// ══════════════════════════════════════════════════════════════
/** SillyTavern 的 12 个默认骨架块（真实库实测「出现在全部预设中」的那批） */
const SKELETON = [
    'main', 'nsfw', 'dialogueExamples', 'jailbreak', 'chatHistory',
    'worldInfoAfter', 'worldInfoBefore', 'enhanceDefinitions',
    'charDescription', 'charPersonality', 'scenario', 'personaDescription'
];

/** 造一段「像真提示词」的中英混排正文（长度可控） */
const promptBody = (topic, chars) => {
    const seed = [
        `You are a ${topic} assistant. 你是一个${topic}助手。`,
        `请严格遵循以下规则：\n1. 保持角色一致性\n2. 不脱离世界观`,
        `{% if character %}角色：{{ character }}{% endif %}`,
        `注意：输出必须使用中文，禁止使用 Markdown 标题。`,
        `参考设定：${topic} 的核心机制是「以叙事驱动状态变化」。`,
        `Never break character. 永远不要跳出角色。`,
        `格式要求：以 *动作* 与「对话」交替推进。`,
        `Additional context: the ${topic} setting emphasizes atmosphere.`
    ].join('\n');
    let out = '';
    while (out.length < chars) out += seed + '\n';
    return out.slice(0, chars);
};

/** 造一个 OpenAI 预设的 `prompts` 数组（真实形态：**数组**，元素是块对象） */
const makePrompts = (customBlocks, bodyChars) => {
    const prompts = [];
    // 骨架块（正文固定，保证跨预设「基础分」存在 —— 这正是要验证的干扰项）
    for (const id of SKELETON) {
        prompts.push({ identifier: id, name: id, content: promptBody('通用对话', 400), enabled: true, system_prompt: false });
    }
    // 自定义块（**判别力的来源** —— 真实库实测 5 个预设合计 685 个去重 identifier）
    for (const [id, topic, chars, enabled] of customBlocks) {
        prompts.push({
            identifier: id, name: id,
            content: promptBody(topic, chars),
            enabled: enabled !== false, system_prompt: false
        });
    }
    return prompts;
};

/** 造自定义块：`n` 个，主题由 `tag` 决定（**不同 tag ⇒ 结构完全不同**） */
const customBlocks = (tag, n, chars = 900) => Array.from({ length: n }, (_, i) =>
    [`${tag}_block_${String(i).padStart(3, '0')}`, `${tag}主题${i}`, chars]);

/** 打乱数组（确定性：用固定种子的 LCG，保证可复现） */
const shuffle = (arr, seed = 42) => {
    const a = arr.slice();
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/** 按比例改写正文（保留部分原文 → 相似度可控） */
const rewrite = (text, ratio) => {
    const keep = Math.floor(text.length * ratio);
    const head = text.slice(0, keep);
    // 后半替换为「同长度但不同内容」的文本
    const tail = promptBody('改写后', text.length - keep);
    return head + tail;
};

/** 组装一个完整预设 JSON */
const makePreset = (name, prompts, order = null, sampler = {}) => {
    const list = order || prompts.map(p => p.identifier);
    return {
        name,
        // ⚠️ 真实库预设的 prompts **是数组**（本次修复的正是「按对象处理」这个 bug）
        prompts,
        prompt_order: [
            // 🛑 两个 character_id 都造（真实库 100000 / 100001 **并存**）
            { character_id: 100001, order: list.map(id => ({ identifier: id, enabled: true })) },
            { character_id: 100000, order: list.slice(0, 1).map(id => ({ identifier: id, enabled: true })) }
        ],
        temperature: sampler.temperature ?? 0.8,
        top_p: sampler.top_p ?? 0.95,
        top_k: sampler.top_k ?? 40,
        min_p: sampler.min_p ?? 0.05,
        rep_pen: sampler.rep_pen ?? 1.1,
        max_tokens: 512,
        max_context: 8192,
        openai_model: 'gpt-4',
        wrap_in_quotes: false,
        names_behavior: 0,
        send_if_empty: '',
        ...sampler
    };
};

// ══════════════════════════════════════════════════════════════
// 生成样本族
// ══════════════════════════════════════════════════════════════
const files = [];   // { name, data, truth, family }
const add = (name, data, truth, family) => files.push({ name, data, truth, family });

// ── ① 基线预设 A（主题「魔法学院」）──
const A_BLOCKS = customBlocks('magic', 40);
const A_PROMPTS = makePrompts(A_BLOCKS);
add('魔法学院_v1.json', makePreset('魔法学院 v1.0', A_PROMPTS), null, 'baseline');

// ── ② exact：逐字节相同，仅文件名不同 ──
add('魔法学院_副本.json', makePreset('魔法学院 v1.0', A_PROMPTS), 'dup', 'exact');

// ── ③ renamed：结构与正文全同，**仅名称不同**（★ 旧实现漏报的核心）──
add('AUTO_renamed.json', makePreset('万象枢机 2.5', A_PROMPTS), 'dup', 'renamed');

// ── ④ reskin：结构同、正文按比例改写（相似度可控）──
for (const ratio of [0.95, 0.8, 0.6, 0.4]) {
    const prompts = A_PROMPTS.map(p => ({ ...p, content: rewrite(p.content, ratio) }));
    add(`魔法学院_reskin_${String(ratio).replace('.', '')}.json`,
        makePreset(`魔法学院 改皮${ratio}`, prompts), 'dup', `reskin${ratio}`);
}

// ── ⑤ trimmed：正文删减（截断到 60%）──
{
    const prompts = A_PROMPTS.map(p => ({ ...p, content: p.content.slice(0, Math.floor(p.content.length * 0.6)) }));
    add('魔法学院_精简版.json', makePreset('魔法学院 精简版', prompts), 'dup', 'trimmed');
}

// ── ⑥ extended：正文追加 ──
{
    const prompts = A_PROMPTS.map(p => ({ ...p, content: p.content + promptBody('补充', 500) }));
    add('魔法学院_增补版.json', makePreset('魔法学院 增补版', prompts), 'dup', 'extended');
}

// ── ⑦ reorder：结构与正文同，块顺序打乱 ──
{
    const order = shuffle(A_PROMPTS.map(p => p.identifier), 7);
    add('魔法学院_重排.json', makePreset('魔法学院 重排版', A_PROMPTS, order), 'dup', 'reorder');
}

// ── ⑧ flipped：结构与正文同，部分块 enabled 取反 ──
{
    const prompts = A_PROMPTS.map((p, i) => (i % 3 === 0 ? { ...p, enabled: !p.enabled } : p));
    add('魔法学院_开关改动.json', makePreset('魔法学院 开关版', prompts), 'dup', 'flipped');
}

// ── ⑨ sampler：结构与正文同，仅采样参数不同 ──
add('魔法学院_调参版.json',
    makePreset('魔法学院 调参版', A_PROMPTS, null, { temperature: 0.3, top_p: 0.7, top_k: 20, min_p: 0.01, rep_pen: 1.25 }),
    'dup', 'sampler');

// ── ⑩ unrelated：完全不同主题、不同块名（**必须判 DIFFERENT**）──
const U_BLOCKS = customBlocks('cooking', 40);
add('料理大师_v1.json', makePreset('料理大师 v1.0', makePrompts(U_BLOCKS)), 'diff', 'unrelated');

// ── ⑪ sameNameOnly：**名称相同**但结构/正文都无关（★ 最危险，AR-48 同型）──
add('魔法学院_无关同名.json', makePreset('魔法学院 v1.0', makePrompts(customBlocks('sports', 40))), 'diff', 'sameNameOnly');

// ── ⑫ sharedSkeleton：只有 12 个骨架块相同，自定义块全不同 ──
add('骨架干扰项.json', makePreset('骨架干扰项', makePrompts(customBlocks('skeletonOnly', 40))), 'diff', 'sharedSkeleton');

// ── ⑬ 干扰项：非 OpenAI 预设（验证类型判定不误伤）──
add('regex-settings.json', {
    name: '正则设置', regex_scripts: [{ scriptName: '去除空行', findRegex: '/\\n\\n+/g', replaceString: '\n' }]
}, null, 'noise');
add('credential_x.json', { name: 'API 凭据', apiType: 'openai', openAIKey: 'sk-xxx' }, null, 'noise');

// ══════════════════════════════════════════════════════════════
// 落盘
// ══════════════════════════════════════════════════════════════
if (CLEAN) {
    if (fs.existsSync(OUT)) { fs.rmSync(OUT, { recursive: true, force: true }); console.log(`已删除 ${OUT}`); }
    process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

// 真值清单（供标定脚本读 —— **这是「已知真值」的唯一来源**）
const truth = {
    _note: '合成预设库真值清单（truth=dup 同源 / diff 无关 / null 不参与）',
    _caveat: '合成样本 ≠ 真实预设（真实库 118~261 块、正文可达 MB、中英混排）；结论须标注「合成样本标定」',
    generatedAt: new Date().toISOString(),
    baseline: '魔法学院_v1.json',
    pairs: []
};
const baseline = files.find(f => f.family === 'baseline').name;
for (const f of files) {
    if (f.truth === null) continue;
    truth.pairs.push({ file: f.name, vs: baseline, truth: f.truth, family: f.family });
}

let bytes = 0;
for (const f of files) {
    const p = path.join(OUT, f.name);
    fs.writeFileSync(p, JSON.stringify(f.data, null, 2), 'utf-8');
    bytes += fs.statSync(p).size;
}
fs.writeFileSync(path.join(OUT, '_truth.json'), JSON.stringify(truth, null, 2), 'utf-8');

console.log(`═════ 合成预设库已生成 ═════`);
console.log(`  目录：${OUT}`);
console.log(`  文件：${files.length} 个（含真值清单 _truth.json）｜ 合计 ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  基线：${baseline}`);
console.log(`\n  样本族（vs 基线）：`);
for (const p of truth.pairs) {
    console.log(`    ${p.truth === 'dup' ? '同源' : '无关'}  ${p.family.padEnd(16)} ${p.file}`);
}
const noise = files.filter(f => f.family === 'noise');
console.log(`  噪声（非 OpenAI 预设，${noise.length} 个）：${noise.map(f => f.name).join(', ')}`);
