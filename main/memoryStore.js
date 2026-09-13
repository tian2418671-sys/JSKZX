'use strict';
/**
 * 长期记忆存储（桌面版）
 * ─────────────────────────────────────────────────────────────
 * 移动版长期记忆走 Android 原生 `MemoryPlugin`（内置 SQLite）；桌面版没有对应实现，
 * 这里用「单文件 JSON + 原子写」补齐同一套契约，使 `js/composables/chat/useChatMemory.js`
 * 与 `chatBridge.js` 无需改动即可生效。
 *
 * 契约（与 useChatMemory.js 中的调用完全一致）：
 *   add({ type, content, key, cardName }) → { success, id }
 *   update(id, patch)                     → { success }
 *   remove(id)                            → { success }
 *   clear(type?)                          → { success, removed }
 *   list({ type?, limit? })               → { success, items }
 *   search({ query?, limit? })            → { success, items }
 *   stats()                               → { total, byType }
 *
 * 数据形态：{ v: 1, items: [{ id, type, content, key, cardName, ts }] }
 *   type: 'message'（L1 原始消息）/ 'summary'（L2 摘要）/ 'fact'（L3 事实，键=值）
 *
 * 策略：
 *   · **去重合并**：同 (type, key, content, cardName) 视为同一条 → 只更新时间戳，
 *     避免把「用户反复说同一句话」写成几十行记忆。
 *   · **按类型修剪**：每个 type 只保留最新 maxPerType 条（默认 500），超出淘汰最旧。
 *   · **单条长度上限**：content 4KB / key 200B（防超长回复把记忆文件撑爆）。
 *   · **落盘串行化**：多次写操作排队执行，绝不并发覆盖同一文件。
 *   · 检索：中文 2-gram + 英文/数字词切分，按「字段命中权重 × 类型权重 + 时间新鲜度」排序；
 *     空查询退化为「最近 N 条」。
 *
 * 模块类型：CommonJS（与 main.js / preload.js / main 下其他模块一致，项目无 "type": "module"）。
 */

const DEFAULT_MAX_PER_TYPE = 500;
const MAX_CONTENT = 4000;
const MAX_KEY = 200;
const MAX_CARD = 200;

const TYPES = new Set(['message', 'summary', 'fact']);
const TYPE_WEIGHT = { fact: 3, summary: 2, message: 1 };

const norm = (v, max) => {
    const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return max ? t.slice(0, max) : t;
};

/** 切词：英文/数字按单词，中日韩按 2-gram（单字查询也保留） */
function tokenize(text) {
    const s = String(text || '').toLowerCase();
    const out = [];
    for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
    const cjk = s.replace(/[^\u3040-\u30ff\u3400-\u9fff]+/g, ' ').trim();
    for (const run of cjk.split(/\s+/)) {
        if (!run) continue;
        if (run.length === 1) { out.push(run); continue; }
        for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    }
    return [...new Set(out)];
}

function createMemoryStore(options = {}) {
    const load = typeof options.load === 'function' ? options.load : async () => null;
    const save = typeof options.save === 'function' ? options.save : async () => {};
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const maxPerType = Number(options.maxPerType) > 0 ? Math.floor(Number(options.maxPerType)) : DEFAULT_MAX_PER_TYPE;

    let items = [];
    let loaded = false;
    let seq = 0;
    let saveChain = Promise.resolve();

    const makeId = () => `m${now().toString(36)}${(++seq).toString(36)}`;

    function normalizeItem(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const type = TYPES.has(raw.type) ? raw.type : 'message';
        const content = norm(raw.content, MAX_CONTENT);
        if (!content) return null;
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(),
            type,
            content,
            key: norm(raw.key, MAX_KEY),
            cardName: norm(raw.cardName, MAX_CARD),
            ts: Number.isFinite(raw.ts) ? raw.ts : now()
        };
    }

    async function ensureLoaded() {
        if (loaded) return;
        loaded = true;
        try {
            const raw = await load();
            const list = raw && Array.isArray(raw.items) ? raw.items : [];
            items = list.map(normalizeItem).filter(Boolean);
            seq = Math.max(seq, items.length);
        } catch (e) {
            items = [];   // 文件损坏 → 从空开始（不阻塞测卡）
        }
    }

    /** 串行落盘（快照式，调用后 items 再变也不影响本次写入内容） */
    function persist() {
        const snapshot = items.map((it) => ({ ...it }));
        saveChain = saveChain.then(() => save({ v: 1, items: snapshot })).catch(() => {});
        return saveChain;
    }

    /** 同类型修剪：只留最新 maxPerType 条 */
    function trim(type) {
        const same = items.filter((it) => it.type === type);
        if (same.length <= maxPerType) return 0;
        same.sort((a, b) => a.ts - b.ts);
        const drop = new Set(same.slice(0, same.length - maxPerType).map((it) => it.id));
        items = items.filter((it) => !drop.has(it.id));
        return drop.size;
    }

    async function add(payload) {
        await ensureLoaded();
        const item = normalizeItem({
            id: makeId(),
            type: (payload && payload.type) || 'message',
            content: payload && payload.content,
            key: payload && payload.key,
            cardName: payload && payload.cardName,
            ts: now()
        });
        if (!item) return { success: false, error: 'empty-content' };
        // 去重合并：同 (type, key, content, cardName) 只更新时间戳
        const dup = items.find((it) => it.type === item.type && it.content === item.content
            && it.key === item.key && it.cardName === item.cardName);
        if (dup) {
            dup.ts = item.ts;
            const dropped = trim(item.type);
            await persist();
            return { success: true, id: dup.id, merged: true, trimmed: dropped };
        }
        items.push(item);
        const dropped = trim(item.type);
        await persist();
        return { success: true, id: item.id, trimmed: dropped };
    }

    async function update(id, patch) {
        await ensureLoaded();
        const it = items.find((x) => x.id === id);
        if (!it) return { success: false, error: 'not-found' };
        if (patch && patch.content !== undefined) {
            const c = norm(patch.content, MAX_CONTENT);
            if (!c) return { success: false, error: 'empty-content' };
            it.content = c;
        }
        if (patch && patch.key !== undefined) it.key = norm(patch.key, MAX_KEY);
        if (patch && patch.cardName !== undefined) it.cardName = norm(patch.cardName, MAX_CARD);
        if (patch && typeof patch.type === 'string' && TYPES.has(patch.type)) it.type = patch.type;
        it.ts = now();
        await persist();
        return { success: true };
    }

    async function remove(id) {
        await ensureLoaded();
        const before = items.length;
        items = items.filter((it) => it.id !== id);
        if (items.length === before) return { success: false, error: 'not-found' };
        await persist();
        return { success: true };
    }

    async function clear(type) {
        await ensureLoaded();
        const t = typeof type === 'string' && type ? type : '';
        const before = items.length;
        items = t ? items.filter((it) => it.type !== t) : [];
        await persist();
        return { success: true, removed: before - items.length };
    }

    // ⚠️ 返回值一律是**副本**：调用方（渲染层/其他模块）拿到后可能改字段，
    //    若直接返回内部对象会把存储改坏（且 IPC 传输也是克隆语义，保持一致更直观）。
    function sortedByTsDesc(list) { return list.map((it) => ({ ...it })).sort((a, b) => b.ts - a.ts); }

    async function list(payload) {
        await ensureLoaded();
        const t = payload && typeof payload.type === 'string' && payload.type ? payload.type : '';
        const limit = Math.max(1, Math.min(Number(payload && payload.limit) || 100, 1000));
        const pool = t ? items.filter((it) => it.type === t) : items;
        return { success: true, items: sortedByTsDesc(pool).slice(0, limit) };
    }

    async function search(payload) {
        await ensureLoaded();
        const query = norm(payload && payload.query);
        const limit = Math.max(1, Math.min(Number(payload && payload.limit) || 20, 200));
        const terms = tokenize(query);
        if (!terms.length) return { success: true, items: sortedByTsDesc(items).slice(0, limit) };

        const newest = items.length ? Math.max(...items.map((it) => it.ts)) : 0;
        const scored = [];
        for (const it of items) {
            const hay = `${it.key}\u0000${it.content}\u0000${it.cardName}`.toLowerCase();
            let hits = 0;
            for (const t of terms) if (hay.includes(t)) hits++;
            if (!hits) continue;
            // 命中率 × 类型权重 + 新鲜度加成（近 1 小时内最高 +1.5）
            const coverage = hits / terms.length;
            const freshness = newest ? Math.max(0, 1 - (newest - it.ts) / 3600000) : 0;
            scored.push({ it, score: coverage * (TYPE_WEIGHT[it.type] || 1) * 100 + freshness * 1.5 });
        }
        scored.sort((a, b) => b.score - a.score || b.it.ts - a.it.ts);
        return { success: true, items: scored.slice(0, limit).map((s) => ({ ...s.it })) };
    }

    /** 供 UI 显示 / 诊断（不落盘） */
    function stats() {
        const byType = {};
        for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
        return { total: items.length, byType };
    }

    return { add, update, remove, clear, list, search, stats, _items: () => items };
}

module.exports = { createMemoryStore, tokenize, DEFAULT_MAX_PER_TYPE, MAX_CONTENT };
