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
    }

    /** 申请一份空缓冲（与活跃表同构，供暂存构建使用） */
    _blankBuffer() {
        return { index: new Map(), cards: new Set(), cardTags: new WeakMap(), cardCount: 0 };
    }

    /** 一次性切换活跃表（双缓冲的「换缓冲」动作，同步、无中间态） */
    _swap(buf) {
        this.index = buf.index;
        this.cards = buf.cards;
        this.cardTags = buf.cardTags;
        this.cardCount = buf.cards.size;
    }

    /** 同步构建（小库/一次性场景）：直接换缓冲，不暴露半成品 */
    build(library, extractText, extractTags) {
        this.generation++;
        if (extractText) this._extractText = extractText;
        if (extractTags) this._extractTags = extractTags;
        const gen = this.generation;
        const buf = this._blankBuffer();
        for (const card of library || []) {
            if (gen !== this.generation) return this.stats(); // 已被更新的构建取代
            this._indexCardInto(buf, card, extractText, extractTags);
        }
        if (gen !== this.generation) return this.stats();
        this._swap(buf);
        this.buildTime = Date.now();
        return this.stats();
    }

    /**
     * 异步分片构建索引：把大批量卡片拆成小块，块间让出主线程（idle 与定时器竞速），
     * 完成后一次性切换到新缓冲。
     */
    async buildAsync(library, extractText, extractTags, chunkSize = 50) {
        this.generation++;
        if (extractText) this._extractText = extractText;
        if (extractTags) this._extractTags = extractTags;
        const gen = this.generation; // 🛡️ 本次构建的代次
        const buf = this._blankBuffer();
        const cards = library || [];
        this.building = true;
        this.pendingCards = cards.length;
        try {
            for (let i = 0; i < cards.length; i += chunkSize) {
                // 🛡️ 分片前先自检：已被更新的重建取代 → 立即退出，不再写入
                if (gen !== this.generation) return this.stats();
                const chunk = cards.slice(i, i + chunkSize);
                for (const card of chunk) this._indexCardInto(buf, card, extractText, extractTags);
                // 每处理一个 chunk 后 yield 给主线程
                if (i + chunkSize < cards.length) {
                    // 🚦 让步：前台优先 idle（不抢渲染），后台/繁忙时走不受节流的通道；
                    //    旧实现（idle + setTimeout 竞速）在窗口隐藏时会永久卡住（见 yieldToMain 注释）
                    await yieldToMain(60);
                }
            }
            if (gen !== this.generation) return this.stats();
            this._swap(buf); // 🎯 双缓冲切换（此前查询一直用的是上一代完整索引）
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
        this._indexCardInto(this, card, this._extractText, this._extractTags);
    }

    remove(card) {
        if (!this.cards.has(card)) return;
        // 💾 不依赖缓存文本：用构建时的抽取函数复算（避免万卡库常驻 ~531MB 文本副本）
        const text = this._extractText ? clampText(this._extractText(card)) : '';
        for (const word of this._tokenize(text)) {
            const cards = this.index.get(word);
            if (!cards) continue;
            const next = cards.filter(item => item !== card);
            if (next.length) this.index.set(word, next);
            else this.index.delete(word);
        }
        this.cards.delete(card);
        this.cardCount = this.cards.size;
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
    _indexCardInto(buf, card, extractText, extractTags) {
        if (!card || typeof card !== 'object') return;
        if (typeof extractText !== 'function' || typeof extractTags !== 'function') return;
        if (buf.cards.has(card)) return;
        const text = clampText(extractText(card));
        const tags = (extractTags(card) || []).map(tag => String(tag).toLowerCase());
        buf.cardTags.set(card, tags);
        buf.cards.add(card);
        for (const word of this._tokenize(text)) {
            const cards = buf.index.get(word) || [];
            cards.push(card);
            buf.index.set(word, cards);
        }
        buf.cardCount = buf.cards.size;
    }

    _tokenize(text) {
        const tokens = [];
        let word = '';
        for (const char of String(text)) {
            if (/[\u4e00-\u9fff]/.test(char)) {
                if (word) tokens.push(word);
                word = '';
                tokens.push(char);
            } else if (/[A-Za-z0-9_]/.test(char)) {
                word += char;
            } else {
                if (word) tokens.push(word);
                word = '';
            }
        }
        if (word) tokens.push(word);
        return [...new Set(tokens)];
    }

    _getMatches(keyword) {
        const exact = this.index.get(keyword);
        if (exact) return exact;
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
    }

    stats() {
        return {
            cardCount: this.cardCount,
            wordCount: this.index.size,
            buildTime: this.buildTime,
            avgCardsPerWord: this.cardCount ? this.index.size / this.cardCount : 0,
            building: this.building,
            pendingCards: this.pendingCards,
            generation: this.generation
        };
    }
}

export default new SearchIndex();
