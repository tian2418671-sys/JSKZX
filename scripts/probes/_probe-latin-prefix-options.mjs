/**
 * PK-19 方案选型实测：三个候选方案的正确性 / 速度 / 内存对照（纯 Node）
 *
 * 用法：node scripts/probes/_probe-latin-prefix.mjs [卡数]
 *
 * 方案：
 *   (a) 有序 token 数组 + 二分查找前缀区间
 *   (b) 首字母桶 + 桶内 substring 过滤
 *   (c) 二元组（bigram）桶 + 桶内 substring 过滤（Int32Array 存 token 下标）
 *
 * 对每个方案都断言「结果集合与基线 `includes` 全表扫完全一致」——正确性优先。
 */
import searchIndex from '../../js/utils/searchIndex.js';

// ── 语料（与 _probe-latin-prefix.mjs 同款：撑起真实量级 token 表） ──
const LATIN_WORDS = ['system', 'syntax', 'symbol', 'sync', 'syndrome', 'symphony', 'sympathy',
    'character', 'charisma', 'challenge', 'channel', 'chronicle', 'chemistry', 'magic', 'master',
    'material', 'matter', 'meadow', 'measure', 'memory', 'personality', 'performance', 'perspective',
    'phenomenon', 'philosophy', 'description', 'destiny', 'detail', 'develop', 'device', 'dialogue',
    'appearance', 'application', 'apprentice', 'approach', 'archive', 'armor', 'world', 'wisdom',
    'witness', 'wonder', 'workshop', 'worship', 'knowledge', 'kingdom', 'knight', 'kitchen', 'knife',
    'network', 'neutral', 'noble', 'nomad', 'notion', 'element', 'elegant', 'embrace', 'emotion',
    'empire', 'energy', 'tavern', 'technique', 'temple', 'tension', 'territory', 'theory', 'village',
    'vintage', 'virtue', 'vision', 'vitality', 'voice', 'shadow', 'shelter', 'signal', 'silence',
    'silver', 'similar', 'ocean', 'offering', 'official', 'ominous', 'oracle', 'origin', 'rhythm',
    'ritual', 'rival', 'romance', 'routine', 'rumor', 'ancient', 'anchor', 'angel', 'animal', 'answer',
    'anxiety', 'barrier', 'bastion', 'beacon', 'beneath', 'benefit', 'betray', 'crystal', 'culture',
    'curious', 'current', 'custom', 'cyber', 'danger', 'darkness', 'dawn', 'deadly', 'decade', 'decide',
    'fabric', 'facility', 'faction', 'failure', 'familiar', 'fantasy', 'garden', 'gather', 'genuine',
    'gesture', 'glacier', 'glimpse', 'harbor', 'harmony', 'harvest', 'hazard', 'heritage', 'hidden',
    'island', 'isolate', 'ivory', 'identity', 'illusion', 'impact', 'journey', 'justice', 'juvenile',
    'jewel', 'journal', 'jungle', 'labyrinth', 'landscape', 'lantern', 'legend', 'leisure', 'liberty',
    'mechanic', 'medieval', 'melody', 'merchant', 'metaphor', 'midnight', 'narrative', 'native',
    'nature', 'navigate', 'nebula', 'necessary', 'obscure', 'observe', 'obstacle', 'obvious', 'occult',
    'officer', 'paradox', 'parallel', 'passage', 'patience', 'pattern', 'peculiar', 'quality', 'quantum',
    'quarrel', 'quest', 'quiet', 'quotation', 'radiant', 'random', 'rational', 'realm', 'rebel',
    'recover', 'sacred', 'sacrifice', 'sanctuary', 'sapphire', 'satellite', 'scarlet', 'tactic',
    'talent', 'tangible', 'tapestry', 'temper', 'tendency', 'ultimate', 'umbrella', 'uncover', 'undergo',
    'uniform', 'universe', 'vacant', 'vacuum', 'valiant', 'valley', 'vanish', 'velocity', 'wander',
    'warfare', 'warrant', 'weapon', 'weather', 'welcome', 'yearning', 'yesterday', 'yield', 'youth',
    'yonder', 'yacht', 'zeal', 'zealot', 'zenith', 'zephyr', 'zone', 'zoology'];
const CJK_PHRASES = ['神秘的旅人', '古老的书卷', '禁忌的仪式', '荣耀的骑士', '沉默的守望者',
    '自由的风', '永恒的记忆', '破碎的誓言', '遥远的星辰', '深海的回响', '烈焰中的重生',
    '月下的低语', '命运的齿轮', '失落的文明', '暗影中的交易'];
const SHARED_PREFIXES = ['s', 'e', 'a', 'c', 'd', 'm', 'p', 't', 'r', 'b', 'f', 'g', 'h', 'i', 'l', 'n', 'o', 'v', 'w', 'k', 'j', 'q', 'u', 'y', 'z'];

function makeCards(n) {
    const cards = [];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
        const parts = [`角色${i}`, `name_${i}`];
        for (let k = 0; k < 40; k++) parts.push(LATIN_WORDS[Math.floor(rnd() * LATIN_WORDS.length)]);
        for (let k = 0; k < 100; k++) {
            const p = SHARED_PREFIXES[Math.floor(rnd() * SHARED_PREFIXES.length)];
            parts.push(p + (i * 131 + k * 7919).toString(36) + k.toString(36));
        }
        const cjkCount = 10 + Math.floor(rnd() * 10);
        for (let k = 0; k < cjkCount; k++) parts.push(CJK_PHRASES[Math.floor(rnd() * CJK_PHRASES.length)]);
        parts.push(`这是第${i}张卡的描述文本，包含 system 与 syntax 等英文术语，以及若干中文说明。`);
        cards.push({ id: `c${i}`, path: `E:/lib/card${i}.png`, fileName: `card${i}.png`, name: `角色${i}`, _mtime: 1000 + i, _size: 50000 + i, text: parts.join(' ') });
    }
    return cards;
}
const extractText = (c) => c.text.toLowerCase();
const extractTags = () => [];

const mb = (b) => (b / 1048576).toFixed(1) + 'MB';
function heapUsed() { if (global.gc) global.gc(); return process.memoryUsage().heapUsed; }
function pct(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

/** 基线：现状实现（全表 includes） */
function baselineMatches(index, kw) {
    const exact = index.get(kw);
    if (exact) return exact;
    const matches = [];
    for (const [word, cards] of index) if (word.includes(kw)) matches.push(...cards);
    return [...new Set(matches)];
}

(async () => {
    const N = Number(process.argv[2] || 11000);
    const cards = makeCards(N);
    searchIndex.clear();
    await searchIndex.buildAsync(cards, extractText, extractTags, 200);
    const st = searchIndex.stats();
    console.log(`\n===== PK-19 方案选型实测（${N} 卡 / ${st.wordCount.toLocaleString()} token）=====\n`);

    const tokens = [...searchIndex.index.keys()];
    const base = heapUsed();
    console.log(`基线堆（含索引）：${mb(base)}\n`);

    // ────────── 方案 (a) 有序 token 数组 + 二分前缀区间 ──────────
    let t = performance.now();
    const sorted = [...tokens].sort();
    const buildA = performance.now() - t;
    const memA = heapUsed() - base;
    /** 前缀区间 [lo, hi) */
    const prefixRange = (kw) => {
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < kw) lo = mid + 1; else hi = mid; }
        const start = lo;
        let hi2 = sorted.length, lo2 = start;
        while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (sorted[mid].startsWith(kw)) lo2 = mid + 1; else hi2 = mid; }
        return [start, lo2];
    };

    // ────────── 方案 (b) 首字母桶 ──────────
    t = performance.now();
    const charBuckets = new Map();
    for (const w of tokens) {
        const c = w[0];
        let b = charBuckets.get(c);
        if (!b) { b = []; charBuckets.set(c, b); }
        b.push(w);
    }
    const buildB = performance.now() - t;
    const memB = heapUsed() - base;

    // ────────── 方案 (c) bigram 桶（Int32Array 存 token 下标） ──────────
    t = performance.now();
    const tokenIdx = new Map();          // token → 下标
    for (let i = 0; i < tokens.length; i++) tokenIdx.set(tokens[i], i);
    const bigramTmp = new Map();         // bigram → number[]
    for (let i = 0; i < tokens.length; i++) {
        const w = tokens[i];
        for (let k = 0; k + 1 < w.length; k++) {
            const bg = w.slice(k, k + 2);
            let arr = bigramTmp.get(bg);
            if (!arr) { arr = []; bigramTmp.set(bg, arr); }
            arr.push(i);
        }
    }
    const bigramIndex = new Map();       // bigram → Int32Array（省内存）
    let bigramEntries = 0;
    for (const [bg, arr] of bigramTmp) { bigramEntries += arr.length; bigramIndex.set(bg, Int32Array.from(arr)); }
    bigramTmp.clear();
    const buildC = performance.now() - t;
    const memC = heapUsed() - base;
    console.log(`【构建成本】`);
    console.log(`  (a) 有序数组：${buildA.toFixed(0)}ms，+${mb(memA)}`);
    console.log(`  (b) 首字母桶：${buildB.toFixed(0)}ms，+${mb(memB)}`);
    console.log(`  (c) bigram 桶：${buildC.toFixed(0)}ms，+${mb(memC)} ｜ 桶数 ${bigramIndex.size} ｜ 条目 ${bigramEntries.toLocaleString()}`);

    // ── 各方案的匹配函数 ──
    const matchA = (kw) => {
        const exact = searchIndex.index.get(kw);
        if (exact) return exact;
        const [lo, hi] = prefixRange(kw);
        const out = [];
        for (let i = lo; i < hi; i++) out.push(...(searchIndex.index.get(sorted[i]) || []));
        return [...new Set(out)];
    };
    const matchB = (kw) => {
        const exact = searchIndex.index.get(kw);
        if (exact) return exact;
        const out = [];
        const bucket = charBuckets.get(kw[0]) || [];
        for (const w of bucket) if (w.includes(kw)) out.push(...(searchIndex.index.get(w) || []));
        return [...new Set(out)];
    };
    const matchC = (kw) => {
        const exact = searchIndex.index.get(kw);
        if (exact) return exact;
        // 选最稀有的 bigram 作候选（长度≥2）；长度 1 退回全表（保持子串语义）
        let best = null;
        if (kw.length >= 2) {
            for (let k = 0; k + 1 < kw.length; k++) {
                const bg = kw.slice(k, k + 2);
                const arr = bigramIndex.get(bg);
                if (!arr) return [];                       // 该 bigram 不存在 → 必然无匹配（精确剪枝）
                if (!best || arr.length < best.length) best = arr;
            }
        }
        const out = [];
        if (best) {
            for (let i = 0; i < best.length; i++) {
                const w = tokens[best[i]];
                if (w.includes(kw)) out.push(...(searchIndex.index.get(w) || []));
            }
        } else {
            for (const [w, c] of searchIndex.index) if (w.includes(kw)) out.push(...c);
        }
        return [...new Set(out)];
    };

    // ── 正确性 + 速度对照 ──
    const probes = ['s', 'sy', 'sys', 'syst', 'syste', 'system', 'e', 'el', 'ele', 'element',
        'master', 'aster', 'yst', 'stem', '系', '统', '神', '秘', 'zzz', 'qx'];
    console.log(`\n【正确性 + 速度】（基线 = 现状 includes 全表扫）`);
    console.log('  查询        基线命中   基线耗时   (a)耗时/一致  (b)耗时/一致  (c)耗时/一致');
    let allOk = { a: true, b: true, c: true };
    for (const kw of probes) {
        const bt = [];
        let expect;
        for (let r = 0; r < 6; r++) { const s0 = performance.now(); expect = baselineMatches(searchIndex.index, kw); bt.push(performance.now() - s0); }
        const expectSet = new Set(expect);
        const run = (fn) => {
            const ts = []; let res;
            for (let r = 0; r < 6; r++) { const s0 = performance.now(); res = fn(kw); ts.push(performance.now() - s0); }
            const set = new Set(res);
            const same = set.size === expectSet.size && [...set].every(c => expectSet.has(c));
            return { ms: pct(ts, 0.5), same };
        };
        const ra = run(matchA), rb = run(matchB), rc = run(matchC);
        if (!ra.same) allOk.a = false;
        if (!rb.same) allOk.b = false;
        if (!rc.same) allOk.c = false;
        const mark = (r) => `${r.ms.toFixed(2).padStart(7)}ms/${r.same ? '✅' : '❌'}`;
        console.log(`  ${kw.padEnd(10)} ${String(expect.length).padStart(7)}  ${pct(bt, 0.5).toFixed(2).padStart(8)}ms  ${mark(ra)}  ${mark(rb)}  ${mark(rc)}`);
    }

    console.log(`\n【正确性汇总】（必须全部 ✅ 才可采用）`);
    console.log(`  (a) 有序数组前缀区间：${allOk.a ? '✅ 与基线一致' : '❌ 结果不一致 —— 破坏了子串语义'}`);
    console.log(`  (b) 首字母桶：${allOk.b ? '✅ 与基线一致' : '❌ 结果不一致'}`);
    console.log(`  (c) bigram 桶：${allOk.c ? '✅ 与基线一致' : '❌ 结果不一致'}`);
    console.log('');
})();
