'use strict';
/**
 * 长期记忆存储（桌面版）
 * ─────────────────────────────────────────────────────────────
 * 移动版长期记忆走 Android 原生 `MemoryPlugin`（内置 SQLite）；桌面版没有对应实现，
 * 这里用「单文件 JSON + 原子写」补齐同一套契约，使 `js/composables/chat/useChatMemory.js`
 * 与 `chatBridge.js` 无需改动即可生效。
 *
 * 契约（与 useChatMemory.js / chatBridge.js 的调用完全一致）：
 *   add({ type, content, key, cardName, cardPath }) → { success, id, merged?/overwritten? }
 *   update(id, patch)                               → { success }
 *   confirm(id, confirmed)                          → { success }（P1 预留：1/0/-1）
 *   remove(id)                                      → { success }
 *   clear(type?)                                    → { success, removed }
 *   list({ type?, cardName?, limit? })              → { success, items }   cardName=cardPath 过滤（D1）
 *   search({ query?, cardName?, limit? })           → { success, items }   同上（D1）
 *   stats()                                         → { total, byType, orphans }
 *   migrateData(mappings)                           → { success, migrated }  显示名→path 一次性迁移（D1）
 *   migrateCard({ from, to })                       → { success, migrated }  路径变更跟随（D1a）
 *   clearByCard(cardPath)                           → { success, removed }   删卡清记忆（D1a）
 *
 * 数据形态 v2：{ v: 2, items: [{ id, type, content, key, cardName, cardPath, confirmed, ts, updatedAt }] }
 *   type: 'message'（L1 原始消息）/ 'summary'（L2 摘要）/ 'fact'（L3 事实，键=值）
 *   cardPath：卡唯一标识（分桶主键，D1「换卡=换记忆」）；'' = 遗留桶（未归属）
 *   cardName：纯展示（v4.1 降级）
 *   confirmed：1 注入 / 0 待确认 / -1 软删（P0 恒写 1；P1 收紧时用）
 *   ts：首次创建（D4 覆盖保留）；updatedAt：覆盖/编辑刷新（D2 降级排序 = updatedAt DESC）
 *   读入 v:1 旧文件自动补默认字段，首次落盘即为 v2（一次性懒迁移）。
 *
 * 策略：
 *   · **去重合并**：message/summary 同 (type, key, content, cardPath) 只更新时间戳；
 *     fact 走 **D4 同 key 覆盖**（同 (fact, key, cardPath) → UPDATE content，保留首次 ts）。
 *   · **按类型修剪**：每个 type 只保留最新 maxPerType 条（默认 500），超出淘汰最旧。
 *   · **单卡 fact 上限**：FACT_KEEP=50，超出按 updatedAt ASC 删最旧（移动版 §7.1 定案：
 *     被频繁覆盖的 fact updatedAt 最新不应删，淘汰 updatedAt 最旧的过时项）。
 *   · **单条长度上限**：content 4KB / key 200B（防超长回复把记忆文件撑爆）。
 *   · **落盘串行化**：多次写操作排队执行，绝不并发覆盖同一文件。
 *   · 检索：中文 2-gram + 英文/数字词切分，按「字段命中权重 × 类型权重 + 时间新鲜度」排序；
 *     空查询退化为「最近 N 条」（带卡过滤时仅本卡）。
 *
 * 模块类型：CommonJS（与 main.js / preload.js / main 下其他模块一致，项目无 "type": "module"）。
 */

const DEFAULT_MAX_PER_TYPE = 500;
const DEFAULT_FACT_KEEP = 50;          // D4 兜底：单卡 fact 上限（与移动版 v4.1 对齐）
const MAX_CONTENT = 4000;
const MAX_KEY = 200;
const MAX_CARD = 200;
const MAX_CARD_PATH = 500;

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
    const factKeep = Number(options.factKeep) > 0 ? Math.floor(Number(options.factKeep)) : DEFAULT_FACT_KEEP;

    let items = [];
    let loaded = false;
    let seq = 0;
    let saveChain = Promise.resolve();

    const makeId = () => `m${now().toString(36)}${(++seq).toString(36)}`;

    /**
     * 条目归一化；v2 字段（cardPath/confirmed/updatedAt）缺省时补默认
     * （v1 旧文件 → 首次读入即完成迁移，首次落盘即为 v2）
     */
    function normalizeItem(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const type = TYPES.has(raw.type) ? raw.type : 'message';
        const content = norm(raw.content, MAX_CONTENT);
        if (!content) return null;
        const ts = Number.isFinite(raw.ts) ? raw.ts : now();
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(),
            type,
            content,
            key: norm(raw.key, MAX_KEY),
            cardName: norm(raw.cardName, MAX_CARD),
            // v2 字段回填：旧数据无 cardPath → 遗留桶；confirmed 恒 1（P0 语义）；updatedAt 缺省 = ts
            cardPath: norm(raw.cardPath, MAX_CARD_PATH),
            confirmed: (raw.confirmed === -1 || raw.confirmed === 0) ? raw.confirmed : 1,
            ts,
            updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : ts
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
        saveChain = saveChain.then(() => save({ v: 2, items: snapshot })).catch(() => {});
        return saveChain;
    }

    /** 同类型修剪：只留最新 maxPerType 条（按 updatedAt 判新旧） */
    function trim(type) {
        const same = items.filter((it) => it.type === type);
        if (same.length <= maxPerType) return 0;
        same.sort((a, b) => (a.updatedAt || a.ts) - (b.updatedAt || b.ts));
        const drop = new Set(same.slice(0, same.length - maxPerType).map((it) => it.id));
        items = items.filter((it) => !drop.has(it.id));
        return drop.size;
    }

    /** D4 兜底：单卡 fact 上限 factKeep 条，超出按 updatedAt ASC 删最旧（移动版 §7.1 定案） */
    function trimFactsByCard(cardPath) {
        const same = items.filter((it) => it.type === 'fact' && (it.cardPath || '') === (cardPath || ''));
        if (same.length <= factKeep) return 0;
        same.sort((a, b) => (a.updatedAt || a.ts) - (b.updatedAt || b.ts));
        const drop = new Set(same.slice(0, same.length - factKeep).map((it) => it.id));
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
            cardPath: payload && payload.cardPath,
            confirmed: 1,                        // P0 语义：新写入恒可注入
            ts: now()
        });
        if (!item) return { success: false, error: 'empty-content' };
        item.updatedAt = item.ts;

        // D4：fact 且 key 非空 → 同 (type, key, cardPath) 覆盖更新（保留首次 ts，刷新 updatedAt）
        if (item.type === 'fact' && item.key) {
            const conflict = items.find((it) => it.type === 'fact' && it.key === item.key
                && (it.cardPath || '') === (item.cardPath || ''));
            if (conflict) {
                conflict.content = item.content;
                conflict.cardName = item.cardName || conflict.cardName;
                conflict.updatedAt = item.ts;
                const droppedF = trimFactsByCard(conflict.cardPath);
                const droppedT = trim('fact');
                await persist();
                return { success: true, id: conflict.id, overwritten: true, trimmed: droppedT + droppedF };
            }
        }

        // message/summary：同 (type, key, content, cardPath) 去重合并，只更新时间戳
        const dup = items.find((it) => it.type === item.type && it.content === item.content
            && it.key === item.key && (it.cardPath || '') === (item.cardPath || ''));
        if (dup) {
            dup.ts = item.ts;
            dup.updatedAt = item.ts;
            const dropped = trim(item.type);
            await persist();
            return { success: true, id: dup.id, merged: true, trimmed: dropped };
        }
        items.push(item);
        const droppedF = item.type === 'fact' ? trimFactsByCard(item.cardPath) : 0;
        const droppedT = trim(item.type);
        await persist();
        return { success: true, id: item.id, trimmed: droppedT + droppedF };
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
        if (patch && patch.cardPath !== undefined) it.cardPath = norm(patch.cardPath, MAX_CARD_PATH);
        if (patch && typeof patch.type === 'string' && TYPES.has(patch.type)) it.type = patch.type;
        it.updatedAt = now();
        await persist();
        return { success: true };
    }

    /** 确认/拒绝（P1 预留）：confirmed=1 注入 / 0 待确认 / -1 软删 */
    async function confirm(id, confirmed) {
        await ensureLoaded();
        const c = Number(confirmed);
        if (![-1, 0, 1].includes(c)) return { success: false, error: 'bad-confirmed' };
        const it = items.find((x) => x.id === id);
        if (!it) return { success: false, error: 'not-found' };
        it.confirmed = c;
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

    /** D1a：删卡清记忆（桌面删卡 = 移入回收站，path 不可逆；保留即成永孤儿） */
    async function clearByCard(cardPath) {
        await ensureLoaded();
        const p = norm(cardPath, MAX_CARD_PATH);
        if (!p) return { success: false, error: 'empty-card-path' };
        const before = items.length;
        items = items.filter((it) => (it.cardPath || '') !== p);
        await persist();
        return { success: true, removed: before - items.length };
    }

    // ⚠️ 返回值一律是**副本**：调用方（渲染层/其他模块）拿到后可能改字段，
    //    若直接返回内部对象会把存储改坏（且 IPC 传输也是克隆语义，保持一致更直观）。
    //    排序依据 updatedAt DESC（D2 定案：覆盖刷新 updatedAt，避免覆盖后旧序）。
    function sortedByRecencyDesc(list) {
        return list.map((it) => ({ ...it }))
            .sort((a, b) => (b.updatedAt || b.ts) - (a.updatedAt || a.ts));
    }

    async function list(payload) {
        await ensureLoaded();
        const t = payload && typeof payload.type === 'string' && payload.type ? payload.type : '';
        const p = norm(payload && payload.cardName, MAX_CARD_PATH);   // D1：cardName 参数携带 cardPath（移动版桥接契约）
        const limit = Math.max(1, Math.min(Number(payload && payload.limit) || 100, 1000));
        let pool = t ? items.filter((it) => it.type === t) : items;
        if (p) pool = pool.filter((it) => (it.cardPath || '') === p);
        return { success: true, items: sortedByRecencyDesc(pool).slice(0, limit) };
    }

    async function search(payload) {
        await ensureLoaded();
        const query = norm(payload && payload.query);
        const p = norm(payload && payload.cardName, MAX_CARD_PATH);   // D1：非空时强制按卡过滤
        const limit = Math.max(1, Math.min(Number(payload && payload.limit) || 20, 200));

        // 空查询：无卡过滤时退化「最近 N 条」（全库）；带卡过滤时取本卡最近 N 条
        const terms = tokenize(query);
        if (!terms.length) {
            const pool = p ? items.filter((it) => (it.cardPath || '') === p) : items;
            return { success: true, items: sortedByRecencyDesc(pool).slice(0, limit) };
        }

        const pool = p ? items.filter((it) => (it.cardPath || '') === p) : items;
        const newest = pool.length ? Math.max(...pool.map((it) => it.updatedAt || it.ts)) : 0;
        const scored = [];
        for (const it of pool) {
            const hay = `${it.key}\u0000${it.content}\u0000${it.cardName}`.toLowerCase();
            let hits = 0;
            for (const t of terms) if (hay.includes(t)) hits++;
            if (!hits) continue;
            // 命中率 × 类型权重 + 新鲜度加成（近 1 小时内最高 +1.5；按 updatedAt 判新鲜）
            const coverage = hits / terms.length;
            const freshness = newest ? Math.max(0, 1 - (newest - (it.updatedAt || it.ts)) / 3600000) : 0;
            scored.push({ it, score: coverage * (TYPE_WEIGHT[it.type] || 1) * 100 + freshness * 1.5 });
        }
        scored.sort((a, b) => b.score - a.score || (b.it.updatedAt || b.it.ts) - (a.it.updatedAt || a.it.ts));
        return { success: true, items: scored.slice(0, limit).map((s) => ({ ...s.it })) };
    }

    /**
     * 一次性迁移（D1）：显示名 → card_path（幂等，可重跑）。
     * @param {Array<[string, string|null]>} mappings [[显示名, path|null]]
     *   - path 非空：cardName === 显示名 且 cardPath 为空的条目 → 绑定 path
     *   - path 为空（同名多卡/无匹配）：保持遗留桶，不丢数据
     */
    async function migrateData(mappings) {
        await ensureLoaded();
        if (!Array.isArray(mappings)) return { success: false, error: 'bad-mappings' };
        let migrated = 0;
        for (const [name, path] of mappings) {
            const n = norm(name, MAX_CARD);
            const p = norm(path, MAX_CARD_PATH);
            if (!n || !p) continue;                       // null/空 → 遗留桶，跳过
            for (const it of items) {
                if (it.cardName === n && !(it.cardPath || '')) {
                    it.cardPath = p;
                    migrated++;
                }
            }
        }
        if (migrated) await persist();
        return { success: true, migrated };
    }

    /**
     * D1a 路径变更跟随（rename/move）：from 的记忆全部改绑 to。
     * 冲突规则（移动版 §7.2 定案）：目标优先删源 —— 目标已有同 key+type 记忆时，源条目直接丢弃。
     * 单文件快照写 = 事务语义（写失败整体回退）。
     */
    async function migrateCard(payload) {
        await ensureLoaded();
        const from = norm(payload && payload.from, MAX_CARD_PATH);
        const to = norm(payload && payload.to, MAX_CARD_PATH);
        if (!from || !to || from === to) return { success: false, error: 'bad-paths' };
        const fromList = items.filter((it) => (it.cardPath || '') === from);
        if (!fromList.length) return { success: true, migrated: 0 };
        let moved = 0;
        for (const it of fromList) {
            // 目标已有同 key+type → 目标优先，删源（不覆盖目标数据）
            const dup = it.key && items.find((x) => x.id !== it.id
                && (x.cardPath || '') === to && x.type === it.type && x.key === it.key);
            if (dup) { items = items.filter((x) => x.id !== it.id); continue; }
            it.cardPath = to;
            moved++;
        }
        await persist();
        return { success: true, migrated: moved };
    }

    /** 供 UI 显示 / 诊断（不落盘）：orphans = 遗留桶条数（未归属任何卡） */
    function stats() {
        const byType = {};
        let orphans = 0;
        for (const it of items) {
            byType[it.type] = (byType[it.type] || 0) + 1;
            if (!(it.cardPath || '')) orphans++;
        }
        return { total: items.length, byType, orphans };
    }

    return {
        add, update, confirm, remove, clear, list, search, stats,
        migrateData, migrateCard, clearByCard,
        _items: () => items
    };
}

module.exports = { createMemoryStore, tokenize, DEFAULT_MAX_PER_TYPE, DEFAULT_FACT_KEEP, MAX_CONTENT };
