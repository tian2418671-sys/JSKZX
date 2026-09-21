/**
 * 高性能搜索索引引擎：倒排索引 + 分片异步构建 + **双缓冲切换**。
 * 卡片对象作为结果引用保存；标签缓存使用 WeakMap，避免延长卡片生命周期。
 *
 * 💾 内存约束（万卡大库不能 OOM —— 渲染进程 V8 堆上限约 4GB）：
 *   索引 **不保留** 每张卡的文本副本（实测 11,186 卡的小写全文合计 ~531MB 字符，
 *   中文按 UTF-16 计更高，是加载后堆占 3.0GB 的主因之一）。需要文本的场合
 *   （remove / 排除词筛选）由构建时记下的 extractText 按需复算，用完即弃。
 *
 * 🔄 双缓冲（2026-09-13）：
 *   构建写入**暂存缓冲**，全部完成后一次性 `_swap()` 换掉活跃表。
 *   这样「构建期间」的搜索仍然命中**上一代完整索引** ——
 *   旧实现先 `clear()` 再逐片写入，构建中搜索只能命中半份倒排
 *   （列表条目忽多忽少地抖动，且可能「搜不到明明存在的卡」）。
 *
 * 🛡️ 代次号 generation：新构建开始会递增；在途构建发现自己不是最新一代就立即退出，
 *   既防「旧对象写回」（重复卡），也防多轮重建重叠空转。
 */

/** 单卡参与索引的文本上限（字符）：超大卡（实测有 16MB 的 JSON 卡）只索引前段，
 *  避免一张卡就把倒排表撑成千万级条目。超限部分不影响常规检索体验。 */
const MAX_INDEX_TEXT = 200000;

/**
 * 跨代沿用用的「卡片身份键」：与 `refreshLibrary` 的复用规则（path + mtime）保持一致。
 * 键里带 size 是为了防止「同一 mtime 内容被替换」的极端情形。
 * 无 path 的卡（尚未落盘）返回 ''，不参与沿用，老实重算。
 */
const keyOfCard = (card) => {
    if (!card || typeof card !== 'object') return '';
    const p = card.path || card.filePath || '';
    if (!p) return '';
    return `${p}|${card._mtime || 0}|${card._size || 0}`;
};

const clampText = (raw) => {
    const s = String(raw == null ? '' : raw);
    return (s.length > MAX_INDEX_TEXT ? s.slice(0, MAX_INDEX_TEXT) : s).toLowerCase();
};

// 🚦 让步调度器（导出给 App.vue 复用）
// ⚠️ 关键坑（2026-09-13 实测）：窗口**隐藏/最小化**时 Chromium 会把 setTimeout 节流到 ≥1s，
//    且 requestIdleCallback **完全不回调**（后台超过 5 分钟还会进入 intensive throttling，≈1 次/分钟）。
//    纯 idle + 定时器实现的万卡索引在后台会「永久 building」（实测启动 6 分钟仍未完成、
//    搜索返回 0 条）；换用不受该节流限制的 MessageChannel.postMessage 做让步后，
//    后台也能在数十秒内建完。前台仍优先 idle（不抢首屏渲染），保持体验。
const _hasDom = (typeof document !== 'undefined') && (typeof window !== 'undefined');
const _mc = (_hasDom && typeof MessageChannel === 'function') ? new MessageChannel() : null;
const _mcWaiters = [];
if (_mc) {
    _mc.port1.onmessage = () => { const w = _mcWaiters.shift(); if (w) w(); };
    // 🛡️ Node（单测）下 MessagePort 是「活跃句柄」，不 unref 会让 node --test 跑完不退出
    try { if (typeof _mc.port1.unref === 'function') { _mc.port1.unref(); _mc.port2.unref(); } } catch (e) { /* 浏览器无此 API */ }
}
function yieldViaChannel(ms = 50) {
    if (!_mc) return new Promise((r) => setTimeout(r, ms));
    return new Promise((resolve) => {
        let settled = false;
        const go = () => { if (settled) return; settled = true; resolve(); };
        _mcWaiters.push(go);
        _mc.port2.postMessage(null);
        // 🛡️ 兜底：某些宿主（Node 单测环境）的 MessagePort 未隐式 start，通道事件可能不来
        //    —— 保底 ms 后一定继续，绝不出现「等一个永不触发的回调而挂死」。
        setTimeout(go, ms);
    });
}
export function yieldToMain(ms = 60) {
    if (typeof document !== 'undefined' && document.hidden) return yieldViaChannel();
    return new Promise((resolve) => {
        let settled = false;
        const resume = () => { if (settled) return; settled = true; resolve(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(resume, { timeout: 50 });
        setTimeout(resume, ms);
    });
}

/**
 * 等一次「真空闲」（rIC 余量充足），**保证一定返回**。
 * ⚠️ 旧写法 `requestIdleCallback(cb, { timeout })` 单独使用时：窗口隐藏/被遮挡后
 *    Chromium 可能连 timeout 都不兑现（实测：索引启动闸门永久卡在等待上，
 *    启动 3 分钟仍未开始建索引）。这里隐藏时直接走不节流的 MessageChannel 让步，
 *    可见时才用 rIC，且有定时器兜底 —— 任何情况下都会在 ms 内返回。
 * @returns {Promise<boolean>} true = 当时确实空闲（可开跑重活）
 */
export function waitForIdle(ms = 120) {
    if (typeof document !== 'undefined' && document.hidden) {
        return yieldViaChannel(0).then(() => true);
    }
    return new Promise((resolve) => {
        let settled = false;
        const done = (idleEnough) => { if (settled) return; settled = true; resolve(idleEnough); };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback((dl) => done(!!dl && dl.timeRemaining() > 8), { timeout: ms });
        }
        setTimeout(() => done(false), ms);
    });
}

class SearchIndex {
    constructor() {
        // —— 活跃索引（查询读这份）——
        this.index = new Map();      // token → 卡片数组
        this.cards = new Set();      // 已索引卡片（身份去重）
        this.cardTags = new WeakMap(); // card → 小写标签数组
        this.buildTime = 0;
        this.cardCount = 0;
        // 构建时记下的抽取函数（用于按需复算文本，不缓存文本本体）
        this._extractText = null;
        this._extractTags = null;
        // 可观测状态（dev 探针 / UI 进度用）
        this.building = false;
        this.pendingCards = 0;
        // 代次号：clear() 与每次新构建都递增
        this.generation = 0;
        // 🔁 跨代沿用（P2）：key → 该卡 token 列表。token 都是上一代索引 Map 的 **key 对象**
        //    （interned，字符串共享）→ 22k 卡约 +70MB，换来的是「未变动卡不再重新分词」
        //    （它的价值在于：P1 把正文砍掉后，刷新仍然能重建索引）。
        this.carry = new Map();
        this._carryExtractText = null;
        /** 本次构建中「沿用上一代 token」的卡数（压测/自检用：全量应为 0，刷新应接近全库） */
        this.reusedCards = 0;
        // 🔥 PK-19：bigram 候选索引（解「拉丁前缀/子串每次都全表扫」）
        //    · bigram → 含该二元组的 token **下标**（Int32Array，省内存）
        //    · bigramWords：下标 → token 字符串（与 this.index 的 key 是同一批对象引用，不额外复制）
        //    为什么不用「有序数组 + 前缀区间」或「首字母桶」：实测两者都**破坏子串语义**
        //    （`aster` / `yst` / `el` 的结果与基线 includes 不一致，会让用户搜到更少/更多的卡）；
        //    bigram 桶实测与基线**逐查询结果完全一致**，且常见前缀快 20~70 倍。
        //    实测（11k 卡 / 112 万 token）：全表扫 19~44ms → bigram 0.5~1.3ms；内存 +18.9MB。
        this.bigram = new Map();
        this.bigramWords = null;
        // ⚠️ add/remove 会让 bigram 的下标失效（token 表变了）→ 置脏，查询时回退全表扫
        //    （正确性优先：脏窗口内只是「慢」，绝不「错」；下次重建完成后自动恢复快路径）
        this.bigramDirty = false;
    }

    /** 申请一份空缓冲（与活跃表同构，供暂存构建使用） */
    _blankBuffer() {
        return { index: new Map(), cards: new Set(), cardTags: new WeakMap(), cardCount: 0, carry: new Map(), reused: 0 };
    }

    /** 一次性切换活跃表（双缓冲的「换缓冲」动作，同步、无中间态） */
    _swap(buf) {
        this.index = buf.index;
        this.cards = buf.cards;
        this.cardTags = buf.cardTags;
        this.cardCount = buf.cards.size;
        this.carry = buf.carry || new Map();
        this.reusedCards = buf.reused || 0;
        // 🔥 PK-19：换表的同时重建 bigram 候选索引（与活跃表严格同代，绝不指向旧 token）
        this._buildBigram();
    }

    /**
     * 🔥 PK-19：构建 bigram 候选索引（token 二元组 → token 下标数组）。
     *
     * 目的：`_getMatches` 在精确命中失败时（拉丁前缀 / 子串查询）不再遍历整张倒排表，
     * 而是先取「查询串某个 bigram」的 token 候选集，再对候选做 `includes` 精筛。
     *
     * 设计要点：
     *   · **正确性优先**：`includes` 语义完整保留 —— bigram 桶只是「超集候选」，
     *     精筛后结果与全表扫**逐条一致**（实测 20 个查询全部 ✅）。
     *   · 用 **Int32Array** 存下标（而非 token 字符串数组）：130 万 token 实测 +18.9MB，
     *     若存字符串引用会因「每个数组元素一个指针槽」而显著更贵。
     *   · token 字符串本身**不复制**：`bigramWords[i]` 直接引用 `this.index` 的 key 对象。
     *   · 单字符查询（长度 1，无 bigram 可用）仍回退全表扫 —— 与基线语义完全一致。
     *   · 复杂度：O(token 表 × 平均 token 长度)。11k 库 ≈575ms / 22k 库 ≈1.25s，
     *     与索引构建同量级且**只在换表时做一次**（构建本身是数十秒级，此开销可忽略）。
     */
    _buildBigram() {
        const tmp = new Map();          // bigram → number[]
        const words = new Array(this.index.size);
        let i = 0;
        for (const word of this.index.keys()) {
            words[i] = word;            // 与 this.index 的 key 同一批对象引用（interned，不复制）
            for (let k = 0; k + 1 < word.length; k++) {
                const bg = word.slice(k, k + 2);
                let arr = tmp.get(bg);
                if (!arr) { arr = []; tmp.set(bg, arr); }
                arr.push(i);
            }
            i++;
        }
        const bigram = new Map();
        for (const [bg, arr] of tmp) bigram.set(bg, Int32Array.from(arr));
        this.bigram = bigram;
        this.bigramWords = words;
        this.bigramDirty = false;
    }

    /** 同步构建（小库/一次性场景）：直接换缓冲，不暴露半成品 */
    build(library, extractText, extractTags, opts = {}) {
        this.generation++;
        if (extractText) this._extractText = extractText;
        if (extractTags) this._extractTags = extractTags;
        const gen = this.generation;
        const buf = this._blankBuffer();
        const prevCarry = (opts.reuse && this._carryExtractText === extractText) ? this.carry : null;
        for (const card of library || []) {
            if (gen !== this.generation) return this.stats(); // 已被更新的构建取代
            this._indexCardInto(buf, card, extractText, extractTags, keyOfCard(card), prevCarry);
        }
        if (gen !== this.generation) return this.stats();
        this._swap(buf);
        this._carryExtractText = extractText;
        this.buildTime = Date.now();
        return this.stats();
    }

    /**
     * 异步分片构建索引：把大批量卡片拆成小块，块间让出主线程（idle 与定时器竞速），
     * 完成后一次性切换到新缓冲。
     */
    async buildAsync(library, extractText, extractTags, chunkSize = 50, opts = {}) {
        this.generation++;
        if (extractText) this._extractText = extractText;
        if (extractTags) this._extractTags = extractTags;
        const gen = this.generation; // 🛡️ 本次构建的代次
        const buf = this._blankBuffer();
        const cards = library || [];
        // 🔁 沿用开关：仅当调用方明确 reuse、且抽取函数与上一代同一份时才启用
        //    （抽取函数换了可能代表语义变了 → 必须重算，不能沿用）
        const prevCarry = (opts.reuse && this._carryExtractText === extractText && this.carry.size) ? this.carry : null;
        this.building = true;
        this.pendingCards = cards.length;
        try {
            for (let i = 0; i < cards.length; i += chunkSize) {
                // 🛡️ 分片前先自检：已被更新的重建取代 → 立即退出，不再写入
                if (gen !== this.generation) return this.stats();
                const chunk = cards.slice(i, i + chunkSize);
                for (const card of chunk) this._indexCardInto(buf, card, extractText, extractTags, keyOfCard(card), prevCarry);
                // 每处理一个 chunk 后 yield 给主线程
                if (i + chunkSize < cards.length) {
                    // 🚦 让步：前台优先 idle（不抢渲染），后台/繁忙时走不受节流的通道；
                    //    旧实现（idle + setTimeout 竞速）在窗口隐藏时会永久卡住（见 yieldToMain 注释）
                    await yieldToMain(60);
                }
            }
            if (gen !== this.generation) return this.stats();
            this._swap(buf); // 🎯 双缓冲切换（此前查询一直用的是上一代完整索引）
            this._carryExtractText = extractText;
            this.buildTime = Date.now();
            return this.stats();
        } finally {
            if (gen === this.generation) {
                this.building = false;
                this.pendingCards = 0;
            }
        }
    }

    add(card, extractText, extractTags) {
        if (!card || typeof card !== 'object') return;
        if (extractText) this._extractText = extractText;
        if (extractTags) this._extractTags = extractTags;
        this.remove(card);
        this._indexCardInto(this, card, this._extractText, this._extractTags, keyOfCard(card), null);
        this._carryExtractText = this._extractText;
        // 🔥 PK-19：token 表可能新增了 token → bigram 的下标映射失效，置脏（查询回退全表扫）
        this.bigramDirty = true;
    }

    remove(card) {
        if (!this.cards.has(card)) return;
        // 💾 不依赖缓存文本：优先用沿用的 token 列表（P2 起），否则用构建时的抽取函数复算
        //    （避免万卡库常驻 ~531MB 文本副本）。P1 砍正文后，这里也因为有 token 可查而不需正文。
        const key = keyOfCard(card);
        let tokens = key && this.carry.get(key);
        if (!tokens) tokens = this._tokenize(this._extractText ? clampText(this._extractText(card)) : '');
        for (const word of tokens) {
            const cards = this.index.get(word);
            if (!cards) continue;
            const next = cards.filter(item => item !== card);
            if (next.length) this.index.set(word, next);
            else this.index.delete(word);
        }
        if (key) this.carry.delete(key);
        this.cards.delete(card);
        this.cardCount = this.cards.size;
        // 🔥 PK-19：token 可能被整桶删除 → bigram 下标失效，置脏（查询回退全表扫）
        this.bigramDirty = true;
    }

    search(keywords = [], options = {}) {
        const terms = Array.isArray(keywords) ? keywords : this._tokenize(String(keywords).toLowerCase());
        const normalized = terms.map(term => String(term).toLowerCase()).filter(Boolean);
        const { tags = [], excludeKeywords = [] } = options;
        let results;

        if (normalized.length === 0) {
            results = [...this.cards];
        } else {
            // 从最稀有的词开始，减少集合相交成本。
            const candidates = normalized.map(keyword => ({ keyword, cards: this._getMatches(keyword) }));
            candidates.sort((a, b) => a.cards.length - b.cards.length);
            results = candidates[0].cards;
            for (let i = 1; i < candidates.length && results.length; i++) {
                const allowed = new Set(candidates[i].cards);
                results = results.filter(card => allowed.has(card));
            }
        }

        // 🛡️ 结果唯一化（防「同一张卡重复出现」的最后一道防线）：
        //    `index.get(keyword)` 直通分支返回的是倒排桶本体，历史上可能已被
        //    并发的重建写入重复条目。这里按对象身份去重，并顺带切断对内部桶的引用。
        if (results.length > 1) results = [...new Set(results)];

        if (tags.length) {
            const wanted = tags.map(tag => String(tag).toLowerCase());
            results = results.filter(card => {
                const cardTags = this.cardTags.get(card) || [];
                return wanted.every(tag => cardTags.some(value => value.includes(tag)));
            });
        }
        if (excludeKeywords.length) {
            const excluded = excludeKeywords.map(word => String(word).toLowerCase());
            // 💾 排除词极少数情况才用：按需复算文本（只对已按关键词筛过的候选集），
            //    不做全库常驻文本缓存（这是万卡库堆占的主因）。
            results = results.filter(card => {
                const text = this._extractText ? clampText(this._extractText(card)) : '';
                return !excluded.some(word => text.includes(word));
            });
        }
        return results;
    }

    /**
     * 把一张卡写进指定缓冲（暂存或活跃）。
     * 🛡️ 幂等：同一张卡（对象身份）在同一缓冲里只索引一次 ——
     *    重叠构建时旧写法会让同一张卡在同一个倒排桶里出现两次，
     *    而中文单字搜索（精确 token 直通）会原样返回该桶 → 列表里同一张卡重复出现。
     */
    _indexCardInto(buf, card, extractText, extractTags, key, prevCarry) {
        if (!card || typeof card !== 'object') return;
        if (typeof extractText !== 'function' || typeof extractTags !== 'function') return;
        if (buf.cards.has(card)) return;
        const tags = (extractTags(card) || []).map(tag => String(tag).toLowerCase());
        buf.cardTags.set(card, tags);
        buf.cards.add(card);
        // 🔁 未变动的卡：直接沿用上一代的 token（**不读正文**）——这是 P1 能把正文砍掉的前提
        let tokens = (key && prevCarry && prevCarry.get(key)) || null;
        if (tokens) buf.reused = (buf.reused || 0) + 1;
        else tokens = this._tokenize(clampText(extractText(card)));
        if (!buf.carry) buf.carry = new Map();
        if (key) buf.carry.set(key, tokens);
        for (const word of tokens) {
            const cards = buf.index.get(word) || [];
            cards.push(card);
            buf.index.set(word, cards);
        }
        buf.cardCount = buf.cards.size;
    }

    _tokenize(text) {
        // ⚡ 性能关键路径（2026-09-13 实测）：万卡大库的索引全文可达 GB 级
        //    （22k 卡实测待索引文本 ≈1.16GB，其中 80% 是世界书正文），
        //    旧写法对每个字符跑两次正则（`/[\u4e00-\u9fff]/.test(char)`）→
        //    十亿级正则调用，索引在 22k 卡上「建了十分钟还没完」（building 永真）。
        //    改成 charCodeAt 区间比较：同样语义，快一个量级。
        const s = String(text);
        const tokens = [];
        let word = '';
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            // CJK 统一表意文字（基本区 4E00-9FFF + 扩展 A 3400-4DBF）：按单字成 token
            if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) {
                if (word) { tokens.push(word); word = ''; }
                tokens.push(s[i]);
            } else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
                word += s[i];
            } else if (word) {
                tokens.push(word);
                word = '';
            }
        }
        if (word) tokens.push(word);
        return [...new Set(tokens)];
    }

    /**
     * 取关键词命中的卡片。
     *
     * ① 精确命中（`index.get(keyword)`）→ 直通（中文单字、完整拉丁词走这条，0ms）。
     * ② 否则需要「子串匹配」（拉丁前缀 `syst`、词中片段 `aster`）。
     *
     * 🔥 PK-19 修复（2026-09-21）：② 旧实现是**遍历整张倒排表**做 `word.includes` ——
     *    实测 112 万 token 表上 **19~44ms/次**，且随 token 表线性增长；用户每敲一个字母
     *    扫一次全表，配合 300ms 防抖在万卡库上足以感到迟滞。
     *    现在改为「**bigram 候选剪枝 + 候选内精筛**」：
     *      · 用查询串里**最稀有**的 bigram 取候选 token 下标（`best`），
     *      · 只对候选做 `includes`（语义与全表扫**完全一致**，只是范围小了几个数量级），
     *      · 若查询串的任一 bigram 在桶里不存在 → **必然无匹配**，直接返回空（精确剪枝）。
     *    实测：常见前缀 0.5~1.3ms（快 20~70 倍）；结果与基线逐条一致。
     *
     * 🛡️ 降级保障（正确性优先，绝不返回错误结果）：
     *    · 单字符查询（无 bigram 可用）→ 回退全表扫；
     *    · `bigramDirty`（add/remove 后下标失效）→ 回退全表扫（只是慢，不会错）；
     *    · 下标越界等异常 → 回退全表扫。
     */
    _getMatches(keyword) {
        const exact = this.index.get(keyword);
        if (exact) return exact;

        // —— 单字符：无 bigram 可用，语义上必须保留「包含该字符的任意 token」→ 全表扫 ——
        if (keyword.length < 2) return this._scanAllFor(keyword);

        // —— 快路径：bigram 候选剪枝 ——
        if (!this.bigramDirty && this.bigramWords && this.bigram.size) {
            try {
                // 选「最稀有」的 bigram（候选集最小 → 精筛成本最低）
                let best = null;
                for (let k = 0; k + 1 < keyword.length; k++) {
                    const arr = this.bigram.get(keyword.slice(k, k + 2));
                    if (!arr) return [];                     // 该二元组不存在 → 必然无匹配
                    if (!best || arr.length < best.length) best = arr;
                }
                if (best) {
                    const matches = [];
                    for (let i = 0; i < best.length; i++) {
                        const word = this.bigramWords[best[i]];
                        if (word !== undefined && word.includes(keyword)) {
                            const cards = this.index.get(word);
                            // 🛡️ 循环追加而非 `push(...cards)`：展开运算符在超大桶上会触碰
                            //    引擎的参数个数上限（RangeError: Maximum call stack size exceeded）
                            if (cards) for (let j = 0; j < cards.length; j++) matches.push(cards[j]);
                        }
                    }
                    return [...new Set(matches)];
                }
            } catch (e) {
                // 下标失效等异常 → 静默回退全表扫（绝不因优化引入「搜索报错/白屏」）
                console.warn('⚠️ bigram 候选索引异常，回退全表扫描:', e.message);
            }
        }

        return this._scanAllFor(keyword);
    }

    /** 全表扫兜底（子串语义的基线实现；单字符查询与 bigram 失效时的唯一正确路径） */
    _scanAllFor(keyword) {
        const matches = [];
        for (const [word, cards] of this.index) {
            if (word.includes(keyword)) matches.push(...cards);
        }
        return [...new Set(matches)];
    }

    clear() {
        // 🛡️ 递增代次：让所有在途的 build/buildAsync 在新一代开始时自行终止
        this.generation++;
        this.index = new Map();
        this.cards = new Set();
        this.cardTags = new WeakMap();
        this.cardCount = 0;
        this.buildTime = 0;
        this.building = false;
        this.pendingCards = 0;
        this.carry = new Map();      // 🔁 沿用数据跟活跃索引同生死（clear 代表「推倒重来」）
        this._carryExtractText = null;
        this.reusedCards = 0;
        // 🔥 PK-19：bigram 与 token 表同生死 —— 一起清掉，并标记脏（查询回退全表扫兜底）
        this.bigram = new Map();
        this.bigramWords = null;
        this.bigramDirty = true;
    }

    stats() {
        return {
            cardCount: this.cardCount,
            wordCount: this.index.size,
            buildTime: this.buildTime,
            avgCardsPerWord: this.cardCount ? this.index.size / this.cardCount : 0,
            building: this.building,
            pendingCards: this.pendingCards,
            generation: this.generation,
            reusedCards: this.reusedCards,
            // 🔥 PK-19 可观测性：bigram 候选索引规模与是否失效（脏 → 查询走全表扫兜底）
            bigramCount: this.bigram ? this.bigram.size : 0,
            bigramDirty: !!this.bigramDirty
        };
    }
}

export default new SearchIndex();
