/**
 * PK-19 拉丁前缀检索代价实测（纯 Node，无需 Electron）
 *
 * 用法：node scripts/_probe-latin-prefix.mjs [卡数]
 *
 * 背景（见 docs/规格与计划/查重扫描与检索-最终方案.md §2.6）：
 *   `searchIndex._getMatches(keyword)` 先 `index.get(keyword)` 精确命中，
 *   **miss 时退化为遍历整个倒排表**（`word.includes(keyword)`）。
 *   - 中文按单字建 token → 中文查询必精确命中，**不走全表扫**（实测 0~0.2ms）
 *   - 拉丁词是**整词 token** → 用户输前缀（`syst`）时整词 `system` 命中不了 → **每次全表扫**
 *
 * 本脚本量三件事：
 *   1. 每按键耗时曲线（`s`→`sy`→`sys`→`syst`…）与 token 表规模的关系
 *   2. 命中/候选规模（决定「候选上限」方案是否可行）
 *   3. 不同规模库（5k / 11k / 22k）的耗时增长曲线（验证是否线性）
 */
import searchIndex from '../js/utils/searchIndex.js';

// ── 造真实感语料：中文正文 + 拉丁词（角色卡/世界书的常见混合） ──
const LATIN_WORDS = [
    'system', 'syntax', 'symbol', 'sync', 'syndrome', 'symphony', 'sympathy',
    'character', 'charisma', 'challenge', 'channel', 'chronicle', 'chemistry',
    'magic', 'master', 'material', 'matter', 'meadow', 'measure', 'memory',
    'personality', 'performance', 'perspective', 'phenomenon', 'philosophy',
    'description', 'destiny', 'detail', 'develop', 'device', 'dialogue',
    'appearance', 'application', 'apprentice', 'approach', 'archive', 'armor',
    'world', 'wisdom', 'witness', 'wonder', 'workshop', 'worship',
    'knowledge', 'kingdom', 'knight', 'kitchen', 'knife',
    'network', 'neutral', 'noble', 'nomad', 'notion',
    'element', 'elegant', 'embrace', 'emotion', 'empire', 'energy',
    'tavern', 'technique', 'temple', 'tension', 'territory', 'theory',
    'village', 'vintage', 'virtue', 'vision', 'vitality', 'voice',
    'shadow', 'shelter', 'signal', 'silence', 'silver', 'similar',
    'ocean', 'offering', 'official', 'ominous', 'oracle', 'origin',
    'rhythm', 'ritual', 'rival', 'romance', 'routine', 'rumor',
    'ancient', 'anchor', 'angel', 'animal', 'answer', 'anxiety',
    'barrier', 'bastion', 'beacon', 'beneath', 'benefit', 'betray',
    'crystal', 'culture', 'curious', 'current', 'custom', 'cyber',
    'danger', 'darkness', 'dawn', 'deadly', 'decade', 'decide',
    'fabric', 'facility', 'faction', 'failure', 'familiar', 'fantasy',
    'garden', 'gather', 'genuine', 'gesture', 'glacier', 'glimpse',
    'harbor', 'harmony', 'harvest', 'hazard', 'heritage', 'hidden',
    'island', 'isolate', 'ivory', 'identity', 'illusion', 'impact',
    'journey', 'justice', 'juvenile', 'jewel', 'journal', 'jungle',
    'labyrinth', 'landscape', 'lantern', 'legend', 'leisure', 'liberty',
    'mechanic', 'medieval', 'melody', 'merchant', 'metaphor', 'midnight',
    'narrative', 'native', 'nature', 'navigate', 'nebula', 'necessary',
    'obscure', 'observe', 'obstacle', 'obvious', 'occult', 'officer',
    'paradox', 'parallel', 'passage', 'patience', 'pattern', 'peculiar',
    'quality', 'quantum', 'quarrel', 'quest', 'quiet', 'quotation',
    'radiant', 'random', 'rational', 'realm', 'rebel', 'recover',
    'sacred', 'sacrifice', 'sanctuary', 'sapphire', 'satellite', 'scarlet',
    'tactic', 'talent', 'tangible', 'tapestry', 'temper', 'tendency',
    'ultimate', 'umbrella', 'uncover', 'undergo', 'uniform', 'universe',
    'vacant', 'vacuum', 'valiant', 'valley', 'vanish', 'velocity',
    'wander', 'warfare', 'warrant', 'weapon', 'weather', 'welcome',
    'yearning', 'yesterday', 'yield', 'youth', 'yonder', 'yacht',
    'zeal', 'zealot', 'zenith', 'zephyr', 'zone', 'zoology'
];
const CJK_PHRASES = [
    '神秘的旅人', '古老的书卷', '禁忌的仪式', '荣耀的骑士', '沉默的守望者',
    '自由的风', '永恒的记忆', '破碎的誓言', '遥远的星辰', '深海的回响',
    '烈焰中的重生', '月下的低语', '命运的齿轮', '失落的文明', '暗影中的交易'
];

/**
 * ⚠️ 语料真实性是本实测的**成败关键**：全表扫成本与 **token 表规模** 线性相关，
 *    而真实 11k 库的 token 表约 **150 万**（见最终方案 §2.6 实测）。
 *    若只从固定词表取样，token 表只有几万 → 测出的耗时会**严重低估**真实代价。
 *    因此这里显式构造「长尾唯一 token」，把 token 表规模抬到真实量级：
 *      · 每卡 ~40 个共享词（真实英文词，制造大桶与常见前缀）
 *      · 每卡 ~100 个唯一 token（`{前缀}{base36}` 形式，制造长尾 → 撑起 token 表规模）
 */
const SHARED_PREFIXES = ['s', 'e', 'a', 'c', 'd', 'm', 'p', 't', 'r', 'b', 'f', 'g', 'h', 'i', 'l', 'n', 'o', 'v', 'w', 'k', 'j', 'q', 'u', 'y', 'z'];

function makeCards(n) {
    const cards = [];
    // 确定性伪随机（避免每次跑出不同语料导致数字不可比）
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
        const parts = [`角色${i}`, `name_${i}`];
        // ① 共享真实英文词（40 个）：制造大倒排桶 + 真实前缀分布（s/e/a 开头占比高）
        for (let k = 0; k < 40; k++) parts.push(LATIN_WORDS[Math.floor(rnd() * LATIN_WORDS.length)]);
        // ② 唯一长尾 token（100 个）：撑起 token 表规模（真实库长尾来自各卡专有名词/人名/词条名）
        for (let k = 0; k < 100; k++) {
            const p = SHARED_PREFIXES[Math.floor(rnd() * SHARED_PREFIXES.length)];
            parts.push(p + (i * 131 + k * 7919).toString(36) + k.toString(36));
        }
        // ③ 中文短语（10~20 个）：验证中文路径不受影响
        const cjkCount = 10 + Math.floor(rnd() * 10);
        for (let k = 0; k < cjkCount; k++) parts.push(CJK_PHRASES[Math.floor(rnd() * CJK_PHRASES.length)]);
        // ④ 固定含真实整词，用于「精确命中」对照（system 等）
        parts.push(`这是第${i}张卡的描述文本，包含 system 与 syntax 等英文术语，以及若干中文说明。`);
        cards.push({
            id: `c${i}`,
            path: `E:/lib/card${i}.png`,
            fileName: `card${i}.png`,
            name: `角色${i}`,
            _mtime: 1000 + i,
            _size: 50000 + i,
            text: parts.join(' ')
        });
    }
    return cards;
}

const extractText = (c) => c.text.toLowerCase();
const extractTags = () => [];

function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function fmt(ms) { return ms.toFixed(2) + 'ms'; }

(async () => {
    const N = Number(process.argv[2] || 11000);
    console.log(`\n===== PK-19 拉丁前缀检索代价实测（${N} 卡）=====\n`);

    const cards = makeCards(N);
    const t0 = Date.now();
    searchIndex.clear();
    await searchIndex.buildAsync(cards, extractText, extractTags, 200);
    const buildMs = Date.now() - t0;
    const st = searchIndex.stats();
    console.log(`索引构建：${(buildMs / 1000).toFixed(1)}s ｜ token 表 ${st.wordCount.toLocaleString()} 个 ｜ 卡数 ${st.cardCount.toLocaleString()}`);
    console.log(`平均每 token 挂 ${(st.cardCount ? st.wordCount / st.cardCount : 0).toFixed(1)} ... 每卡 ${(st.wordCount / st.cardCount).toFixed(1)} token\n`);

    // ── 1. 每按键耗时曲线（拉丁前缀逐步加长）──
    console.log('【1】拉丁前缀逐键耗时（模拟用户每敲一个字母）');
    console.log('  前缀            命中卡数    耗时(中位/最差)   路径');
    const PREFIX = 'system';   // 目标是 token 表里真实存在的整词
    for (let len = 1; len <= PREFIX.length; len++) {
        const kw = PREFIX.slice(0, len);
        const times = [];
        let hits = 0;
        for (let r = 0; r < 12; r++) {
            const t = performance.now();
            const res = searchIndex._getMatches(kw);
            times.push(performance.now() - t);
            hits = res.length;
        }
        // 判定路径：精确命中 = 直通；否则全表扫
        const exact = searchIndex.index.has(kw);
        console.log(`  ${kw.padEnd(14)}  ${String(hits).padStart(8)}    ${fmt(pct(times, 0.5)).padStart(8)} / ${fmt(Math.max(...times)).padStart(8)}   ${exact ? '精确命中(直通)' : '⚠️ 全表扫'}`);
    }

    // ── 2. 单字母（最坏情况：几乎必然全表扫 + 候选巨大）──
    console.log('\n【2】单字母最坏情况（用户删到只剩一个字母 / 输入首字母）');
    for (const kw of ['s', 'e', 'a', 'z', 'x']) {
        const times = [];
        let hits = 0;
        for (let r = 0; r < 8; r++) {
            const t = performance.now();
            hits = searchIndex._getMatches(kw).length;
            times.push(performance.now() - t);
        }
        console.log(`  "${kw}"  命中 ${String(hits).padStart(6)} 卡   中位 ${fmt(pct(times, 0.5)).padStart(8)}  最差 ${fmt(Math.max(...times))}`);
    }

    // ── 3. 候选上限方案的可行性：命中规模分布 ──
    console.log('\n【3】候选规模分布（判断「候选上限」方案是否可行）');
    const probes = ['s', 'sy', 'sys', 'syst', 'syste', 'system', 'e', 'el', 'ele'];
    for (const kw of probes) {
        const hits = searchIndex._getMatches(kw).length;
        const ratio = (hits / N * 100).toFixed(1);
        console.log(`  "${kw.padEnd(7)}" 命中 ${String(hits).padStart(6)} 卡（占全库 ${ratio}%）`);
    }

    // ── 4. 中文对照（应恒为精确命中，不触发全表扫）──
    console.log('\n【4】中文对照（单字 token → 精确命中）');
    for (const kw of ['系', '统', '神', '秘']) {
        const times = [];
        for (let r = 0; r < 8; r++) {
            const t = performance.now();
            searchIndex._getMatches(kw);
            times.push(performance.now() - t);
        }
        console.log(`  "${kw}"  中位 ${fmt(pct(times, 0.5))}  最差 ${fmt(Math.max(...times))}`);
    }

    console.log(`\n===== 结论汇总 =====`);
    console.log(`token 表规模：${st.wordCount.toLocaleString()} ｜ 全表扫成本与 token 表线性相关`);
    console.log('');
})();
