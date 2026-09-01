'use strict';
/**
 * 向量模型效果验证脚本
 *
 * 目的：判断本地向量引擎（paraphrase-multilingual-MiniLM-L12-v2）是否真的有效。
 * 方法：复用生产环境的同一模型、同一缓存目录、同一嵌入参数（pooling=mean, normalize）
 *       与同一余弦相似度算法，模拟真实打标场景（卡片文本 × 候选标签），
 *       统计「正例命中率 / 负例误报率 / 分数分布」，检验 0.65 阈值是否合理。
 *
 * 运行：node scripts/vector-model-test.cjs
 */
const path = require('path');
const fs = require('fs');

// ========== 定位模型缓存（复用生产缓存，避免重新下载）==========
const APPDATA = process.env.APPDATA || '';
const CANDIDATES = [
    path.join(APPDATA, 'sillytavern-card-manager', 'hf_cache'),
    path.join(APPDATA, 'SillyTavern 角色卡管理器', 'hf_cache'),
];
let cacheDir = CANDIDATES.find((d) => fs.existsSync(d));
if (!cacheDir) {
    console.error('[缓存] 未找到模型缓存目录，将尝试在线下载（需网络）。');
    cacheDir = path.join(process.cwd(), '.hf_cache_test');
}

// 注入浏览器 UA（生产代码同款修复，防止 hf-mirror / huggingface 拒绝连接）
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (!headers.has('User-Agent')) {
        headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    }
    return _origFetch(url, { ...options, headers });
};

const { pipeline, env } = require('@xenova/transformers');

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const THRESHOLD = 0.65; // 生产默认阈值

// ========== 与生产代码（vectorWorker.js / vectorManager.js）完全一致的逻辑 ==========
async function embedTexts(extractor, texts) {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const dim = output.dims[output.dims.length - 1];
    const flat = output.data; // Float32Array
    const vecs = [];
    for (let j = 0; j < texts.length; j++) {
        vecs.push(flat.slice(j * dim, (j + 1) * dim));
    }
    return vecs;
}

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ========== 测试用例 ==========
// 正例：[卡片文本片段（模拟 description/personality/first_mes 拼接）, 应命中的标签]
const POSITIVE = [
    ['她是一名吸血鬼伯爵夫人，数百年来统治着黑暗的古老城堡，以鲜血为食，拥有优雅而危险的气质。', '吸血鬼'],
    ['出身于赛博朋克都市的雇佣黑客，擅长入侵义体网络，在霓虹闪烁的街头接取高额委托。', '赛博朋克'],
    ['在魔法学院就读的天才少女，精通火系魔法，梦想成为大魔导师。', '魔法'],
    ['都市职场背景下的恋爱故事，男主是冷酷的集团总裁，女主是普通的小职员，两人从误会到相爱。', '恋爱'],
    ['一名古代剑客行走江湖，行侠仗义，惩恶扬善，快意恩仇。', '武侠'],
    ['高中生侦探与伙伴们一起破解各种离奇案件，找出真相。', '推理'],
    ['被召唤到异世界的普通高中生，觉醒了超强的勇者能力，踏上冒险之旅。', '异世界'],
    ['末日废土世界，幸存者在荒芜的大地上为生存而挣扎求生。', '末世'],
    ['校园里的青春恋爱故事，青梅竹马之间的甜蜜日常。', '校园'],
    ['A noble vampire lord ruling an ancient castle, elegant and dangerous.', 'vampire'],
];

// 负例：[卡片文本片段, 不应匹配的标签]
const NEGATIVE = [
    ['她是一名吸血鬼伯爵夫人，统治着古老的城堡，以鲜血为食。', '田园'],
    ['出身于赛博朋克都市的雇佣黑客，在霓虹街头接取委托。', '魔法'],
    ['在魔法学院就读的天才少女，精通火系魔法。', '机甲'],
    ['都市职场背景下的恋爱故事。', '海盗'],
    ['高中生侦探与伙伴们破解离奇案件。', '吸血鬼'],
    ['末日废土世界，幸存者在荒芜大地上挣扎求生。', '恋爱'],
    ['一名古代剑客行走江湖，行侠仗义。', '航天'],
    ['A noble vampire lord ruling an ancient castle.', 'farming'],
];

// 真实场景模拟：一张卡片文本 → 候选标签池，验证 top1 / 命中标签是否合理
const SCENARIOS = [
    {
        card: '赛博朋克都市的雇佣黑客，深夜潜入巨型企业的义体网络窃取机密数据，与改造人杀手周旋。',
        pool: ['科幻', '赛博朋克', '都市', '恋爱', '魔法', '悬疑'],
        expectTop: '赛博朋克',
    },
    {
        card: '她是一名在魔法学院就读的天才少女，擅长火系魔法，与好友组队参加学院大比。',
        pool: ['魔法', '校园', '战斗', '恋爱', '科幻'],
        expectTop: '魔法',
    },
    {
        card: '现代都市的温柔女医生，在繁忙的医院里救死扶伤，下班后却陷入一段纠葛的感情。',
        pool: ['都市', '恋爱', '医疗', '奇幻', '战争'],
        expectTop: '都市',
    },
];

// ========== 诊断配对 ==========
const selfPairs = [
    ['吸血鬼', '吸血鬼'],
    ['赛博朋克', '赛博朋克'],
    ['vampire', 'vampire'],
    ['她是一名吸血鬼伯爵夫人，统治着古老的城堡。', '她是一名吸血鬼伯爵夫人，统治着古老的城堡。'],
];
const synPairs = [
    ['吸血鬼', '血族'],
    ['魔法', '法术'],
    ['恋爱', '爱情'],
    ['vampire', 'bloodsucker'],
    ['吸血鬼', '僵尸'],
    ['魔法', '枪械'],
];
const tplPairs = [
    ['吸血鬼', '这是一个关于吸血鬼的故事'],
    ['赛博朋克', '这个故事发生在赛博朋克的世界'],
    ['恋爱', '这是一个恋爱故事'],
    ['魔法', '她是一名会使用魔法的女孩'],
    ['吸血鬼', '这是一个关于田园生活的故事'],
];
const longPairs = [
    ['她是一名吸血鬼伯爵夫人，数百年来统治着黑暗的古老城堡，以鲜血为食，拥有优雅而危险的气质。',
     '在月色下，血族的贵族从沉睡中苏醒，她优雅地举起酒杯，鲜红的液体映着她的面容，古老的城堡是她的领地。'],
    ['出身于赛博朋克都市的雇佣黑客，擅长入侵义体网络，在霓虹闪烁的街头接取高额委托。',
     '霓虹灯下的未来都市，义体改造人穿梭在高楼之间，黑客们通过网络窃取巨型企业的机密。'],
    ['她是一名吸血鬼伯爵夫人，统治着古老的城堡。',
     '农民在田野里收割稻谷，夕阳下炊烟袅袅，一片祥和的田园景象。'],
];

// 标签展开方案的误报基线（无关卡片文本 vs 无关展开标签）
const NEG_TEMPLATE = [
    ['她是一名吸血鬼伯爵夫人，统治着古老的城堡，以鲜血为食。', '这是一个关于田园生活的故事'],
    ['出身于赛博朋克都市的雇佣黑客，在霓虹街头接取委托。', '这是一个关于魔法的故事'],
    ['在魔法学院就读的天才少女，精通火系魔法。', '这是一个关于机甲的故事'],
    ['都市职场背景下的恋爱故事。', '这是一个关于海盗的故事'],
    ['高中生侦探与伙伴们破解离奇案件。', '这是一个关于吸血鬼的故事'],
    ['末日废土世界，幸存者在荒芜大地上挣扎求生。', '这是一个关于恋爱的故事'],
    ['一名古代剑客行走江湖，行侠仗义。', '这是一个关于航天旅行的故事'],
    ['A noble vampire lord ruling an ancient castle.', 'This is a story about farming'],
];

// 卡片文本聚焦效果（长文本 vs 前40字）
const FOCUS_PAIRS = [
    ['她是一名吸血鬼伯爵夫人，数百年来统治着黑暗的古老城堡，以鲜血为食，拥有优雅而危险的气质。她喜欢在深夜的庭院里徘徊，与月下的蝙蝠为伴。城堡的地下室藏着无数秘密，只有最忠诚的仆人知晓。',
     '这是一个关于吸血鬼的故事'],
    ['出身于赛博朋克都市的雇佣黑客，擅长入侵义体网络，在霓虹闪烁的街头接取高额委托。他驾驶着改装过的飞行摩托，穿梭于高楼之间，躲避警方的追捕。',
     '这是一个关于赛博朋克的故事'],
];

// ========== 工具 ==========
const pad = (s, n) => String(s).padEnd(n, '　');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function main() {
    console.log('════════════════════════════════════════════════════════');
    console.log('  向量模型效果验证：paraphrase-multilingual-MiniLM-L12-v2');
    console.log('  生产阈值 = 0.65 · 嵌入 = mean pooling + L2 归一化');
    console.log('════════════════════════════════════════════════════════');
    console.log(`[缓存目录] ${cacheDir}`);
    const t0 = Date.now();
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    let extractor;
    try {
        extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
    } catch (e) {
        console.error('[模型加载失败]', e.message || e);
        process.exit(1);
    }
    // 获取向量维度（用占位文本跑一次）
    const probeOut = await extractor('测试', { pooling: 'mean', normalize: true });
    const dim = probeOut.dims[probeOut.dims.length - 1];
    console.log(`[模型加载] 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（向量维度 ${dim}）\n`);

    // 预计算所有涉及的独立文本向量（批量推理，减少请求数）
    const focusTexts = FOCUS_PAIRS.flatMap(([full]) => [full, full.slice(0, 40)]);
    const diagTexts = [
        ...selfPairs.flat(), ...synPairs.flat(), ...tplPairs.flat(), ...longPairs.flat(),
        ...NEG_TEMPLATE.flat(), ...focusTexts,
    ].filter(Boolean);
    const allTexts = [...new Set([
        ...POSITIVE.map(([t]) => t), ...POSITIVE.map(([, t]) => t),
        ...NEGATIVE.map(([t]) => t), ...NEGATIVE.map(([, t]) => t),
        ...SCENARIOS.flatMap((s) => [s.card, ...s.pool]),
        ...diagTexts,
    ])];
    const vecMap = new Map();
    for (let i = 0; i < allTexts.length; i += 32) {
        const chunk = allTexts.slice(i, i + 32);
        const vecs = await embedTexts(extractor, chunk);
        chunk.forEach((t, j) => vecMap.set(t, vecs[j]));
    }

    // ========== 1. 正例 ==========
    console.log('【1】正例：语义相关，应命中（≥0.65）');
    let posHit = 0;
    const posScores = [];
    for (const [text, label] of POSITIVE) {
        const s = cosineSimilarity(vecMap.get(text), vecMap.get(label));
        posScores.push(s);
        const hit = s >= THRESHOLD;
        if (hit) posHit++;
        console.log(`  ${hit ? '✅' : '❌'} ${pad(label, 10)} ← ${trunc(text, 34)}  分=${s.toFixed(3)}`);
    }
    const posAvg = posScores.reduce((a, b) => a + b, 0) / posScores.length;

    // ========== 2. 负例 ==========
    console.log('\n【2】负例：语义无关，应不命中（<0.65）');
    let negHit = 0; // 误报
    const negScores = [];
    for (const [text, label] of NEGATIVE) {
        const s = cosineSimilarity(vecMap.get(text), vecMap.get(label));
        negScores.push(s);
        const wrong = s >= THRESHOLD;
        if (wrong) negHit++;
        console.log(`  ${wrong ? '❌误报' : '✅'} ${pad(label, 10)} ← ${trunc(text, 34)}  分=${s.toFixed(3)}`);
    }
    const negAvg = negScores.reduce((a, b) => a + b, 0) / negScores.length;

    // ========== 3. 真实场景（标签池 top 选择）==========
    console.log('\n【3】真实场景：卡片文本 → 候选标签池（topK=3, 阈值 0.65）');
    for (const sc of SCENARIOS) {
        const cardVec = vecMap.get(sc.card);
        const scored = sc.pool
            .map((l) => ({ label: l, score: cosineSimilarity(cardVec, vecMap.get(l)) }))
            .sort((a, b) => b.score - a.score);
        const hits = scored.filter((x) => x.score >= THRESHOLD);
        const top = scored.slice(0, 3);
        const topOk = scored[0].label === sc.expectTop;
        console.log(`\n  卡片: ${trunc(sc.card, 46)}`);
        console.log(`  期望 top1: ${sc.expectTop}  →  ${topOk ? '✅ 命中' : `❌ 实际 top1 是「${scored[0].label}」`}`);
        console.log(`  得分排序: ${scored.map((x) => `${x.label}(${x.score.toFixed(3)})`).join('  ')}`);
        console.log(`  过阈值: ${hits.length ? hits.map((x) => x.label).join(', ') : '（无）'}`);
    }

    // ========== 4. 诊断：模型本身是否工作正常 ==========
    console.log('\n【4】诊断：模型本身 vs 使用方式（找出分数低的根源）');
    // 4.1 自相似度（模型工作正常的底线检查）
    console.log('  4.1 自相似度（同文本应 ≈1.0，验证模型加载/嵌入正常）');
    for (const [a, b] of selfPairs) {
        const s = cosineSimilarity(vecMap.get(a), vecMap.get(b));
        console.log(`      「${a}」 vs 「${b}」 = ${s.toFixed(3)}`);
    }

    // 4.2 短标签同义/近义（标签 vs 标签）
    console.log('  4.2 短标签 vs 近义/无关短词');
    for (const [a, b] of synPairs) {
        const s = cosineSimilarity(vecMap.get(a), vecMap.get(b));
        console.log(`      「${a}」 vs 「${b}」 = ${s.toFixed(3)}`);
    }

    // 4.3 短标签 vs 短句/展开模板（验证「标签展开成句子」是否能拉高分数）
    console.log('  4.3 短标签 vs 模板句（标签展开策略的效果验证）');
    for (const [a, b] of tplPairs) {
        const s = cosineSimilarity(vecMap.get(a), vecMap.get(b));
        console.log(`      「${a}」 vs 「${b}」 = ${s.toFixed(3)}`);
    }

    // 4.4 长文 vs 长文（同主题段落，MiniLM 的典型强项场景）
    console.log('  4.4 长文 vs 长文（同主题 / 无关）');
    for (const [a, b] of longPairs) {
        const s = cosineSimilarity(vecMap.get(a), vecMap.get(b));
        console.log(`      ${s.toFixed(3)}  「${trunc(a, 26)}」 vs 「${trunc(b, 26)}」`);
    }

    // ========== 5. 修复方案验证：标签展开成模板句 + 阈值扫描 ==========
    console.log('\n【5】修复方案验证：标签 → 模板句「这是一个关于X的故事」+ 阈值扫描');
    // 预生成模板句向量
    const templateTexts = [
        ...new Set(SCENARIOS.flatMap((s) => s.pool.map((l) => `这是一个关于${l}的故事`))),
    ];
    for (let i = 0; i < templateTexts.length; i += 32) {
        const chunk = templateTexts.slice(i, i + 32);
        const vecs = await embedTexts(extractor, chunk);
        chunk.forEach((t, j) => vecMap.set(t, vecs[j]));
    }
    // 每个场景的「卡片 vs 模板句标签」得分（真实 topK 匹配分数）
    const tplScores = [];
    for (const sc of SCENARIOS) {
        const cardVec = vecMap.get(sc.card);
        const scored = sc.pool
            .map((l) => ({ label: l, score: cosineSimilarity(cardVec, vecMap.get(`这是一个关于${l}的故事`)) }))
            .sort((a, b) => b.score - a.score);
        tplScores.push({ expect: sc.expectTop, scored });
        console.log(`  卡片: ${trunc(sc.card, 34)}`);
        console.log(`    得分: ${scored.map((x) => `${x.label}(${x.score.toFixed(3)})`).join('  ')}`);
        console.log(`    期望 top1: ${sc.expectTop} → ${scored[0].label === sc.expectTop ? '✅' : `❌ 实际「${scored[0].label}」`}`);
    }
    // 阈值扫描：不同阈值下 top1 正确率 与 有命中场景数
    console.log('  阈值扫描（模板句方案）:');
    for (const thr of [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65]) {
        let topOk = 0, anyHit = 0;
        for (const { expect, scored } of tplScores) {
            if (scored[0].label === expect && scored[0].score >= thr) topOk++;
            if (scored.some((x) => x.label === expect && x.score >= thr)) anyHit++;
        }
        console.log(`    阈值 ${thr.toFixed(2)} → top1正确 ${topOk}/${SCENARIOS.length} | 期望标签命中 ${anyHit}/${SCENARIOS.length}`);
    }

    // ========== 5.5 标签展开方案的误报基线（用于确定安全阈值下限） ==========
    console.log('\n【5.5】展开模板方案误报基线：无关卡片文本 vs 展开标签');
    const negTplTexts = [...new Set(NEG_TEMPLATE.flat())];
    for (let i = 0; i < negTplTexts.length; i += 32) {
        const chunk = negTplTexts.slice(i, i + 32);
        const vecs = await embedTexts(extractor, chunk);
        chunk.forEach((t, j) => vecMap.set(t, vecs[j]));
    }
    const negTplScores = [];
    for (const [text, tpl] of NEG_TEMPLATE) {
        const s = cosineSimilarity(vecMap.get(text), vecMap.get(tpl));
        negTplScores.push(s);
        console.log(`    ${s.toFixed(3)}  「${trunc(text, 26)}」 vs 「${trunc(tpl, 26)}」`);
    }
    const negTplAvg = negTplScores.reduce((a, b) => a + b, 0) / negTplScores.length;
    const negTplMax = Math.max(...negTplScores);
    console.log(`  → 无关对平均分 ${negTplAvg.toFixed(3)}，最高分 ${negTplMax.toFixed(3)}（阈值应显著高于此值防误报）`);

    // ========== 5.6 卡片文本聚焦效果（前 40 字 vs 全量） ==========
    console.log('\n【5.6】卡片文本聚焦（前40字）对匹配分数的提升效果');
    // 短版本 = 前 40 字（聚焦主题），长版本 = 全量
    for (const [full, tpl] of FOCUS_PAIRS) {
        const short = full.slice(0, 40);
        const sShort = cosineSimilarity(vecMap.get(short), vecMap.get(tpl));
        const sFull = cosineSimilarity(vecMap.get(full), vecMap.get(tpl));
        console.log(`    短(${short.length}字)=${sShort.toFixed(3)} | 长(${full.length}字)=${sFull.toFixed(3)}  「${trunc(tpl, 24)}」`);
    }

    // ========== 5.7 修复后模拟：标签展开 + 0.35 阈值 + topK=3（模拟修复后的 batchMatch） ==========
    console.log('\n【5.7】修复后模拟（标签展开 + 阈值0.35 + topK=3）在正例上的命中率');
    const THRESHOLD_NEW = 0.35;
    const TOPK_NEW = 3;
    const expand = (l) => `这是一个关于${l}的故事`;
    const POS_TEMPLATE = [
        ['她是一名吸血鬼伯爵夫人，数百年来统治着黑暗的古老城堡，以鲜血为食，拥有优雅而危险的气质。', '吸血鬼'],
        ['出身于赛博朋克都市的雇佣黑客，擅长入侵义体网络，在霓虹闪烁的街头接取高额委托。', '赛博朋克'],
        ['在魔法学院就读的天才少女，精通火系魔法，梦想成为大魔导师。', '魔法'],
        ['都市职场背景下的恋爱故事，男主是冷酷的集团总裁，女主是普通的小职员，两人从误会到相爱。', '恋爱'],
        ['一名古代剑客行走江湖，行侠仗义，惩恶扬善，快意恩仇。', '武侠'],
        ['高中生侦探与伙伴们一起破解各种离奇案件，找出真相。', '推理'],
        ['被召唤到异世界的普通高中生，觉醒了超强的勇者能力，踏上冒险之旅。', '异世界'],
        ['末日废土世界，幸存者在荒芜的大地上为生存而挣扎求生。', '末世'],
        ['校园里的青春恋爱故事，青梅竹马之间的甜蜜日常。', '校园'],
        ['A noble vampire lord ruling an ancient castle, elegant and dangerous.', 'vampire'],
    ];
    const posTplTexts = [...new Set(POS_TEMPLATE.flatMap(([t, l]) => [t, expand(l)]))];
    for (let i = 0; i < posTplTexts.length; i += 32) {
        const chunk = posTplTexts.slice(i, i + 32);
        const vecs = await embedTexts(extractor, chunk);
        chunk.forEach((t, j) => vecMap.set(t, vecs[j]));
    }
    let newHit = 0;
    const newScores = [];
    for (const [text, label] of POS_TEMPLATE) {
        const s = cosineSimilarity(vecMap.get(text), vecMap.get(expand(label)));
        newScores.push(s);
        const hit = s >= THRESHOLD_NEW;
        if (hit) newHit++;
        console.log(`  ${hit ? '✅' : '❌'} ${pad(label, 10)} ← ${trunc(text, 30)}  分=${s.toFixed(3)} (阈值${THRESHOLD_NEW})`);
    }
    const newAvg = newScores.reduce((a, b) => a + b, 0) / newScores.length;
    console.log(`  → 修复后正例命中率: ${newHit}/${POS_TEMPLATE.length} = ${((newHit / POS_TEMPLATE.length) * 100).toFixed(0)}%（修复前 0.65 阈值下为 0/10 = 0%）`);

    // ========== 6. 结论 ==========
    console.log('\n════════════════════════════════════════════════════════');
    console.log('【结论汇总】');
    console.log(`  正例平均分:      ${posAvg.toFixed(3)}  (${POSITIVE.length} 例)`);
    console.log(`  负例平均分:      ${negAvg.toFixed(3)}  (${NEGATIVE.length} 例)`);
    console.log(`  区分度(正−负):   ${(posAvg - negAvg).toFixed(3)}`);
    console.log(`  正例命中率:      ${posHit}/${POSITIVE.length} = ${((posHit / POSITIVE.length) * 100).toFixed(0)}%`);
    console.log(`  负例误报率:      ${negHit}/${NEGATIVE.length} = ${((negHit / NEGATIVE.length) * 100).toFixed(0)}%`);
    const scoreRange = [...posScores, ...negScores];
    console.log(`  分数范围:        ${Math.min(...scoreRange).toFixed(3)} ~ ${Math.max(...scoreRange).toFixed(3)}`);
    console.log('════════════════════════════════════════════════════════');
    console.log('判定标准：区分度 > 0.15 且正例命中率 ≥ 70% 且负例误报率 ≤ 30% → 模型有效');
}

main().catch((e) => {
    console.error('运行出错:', e);
    process.exit(1);
});
