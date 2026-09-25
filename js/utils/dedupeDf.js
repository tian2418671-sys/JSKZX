/**
 * 🧬 DF 模板剥离（v4 §8，G5）：行级片段 + 全字段池 + 统计上报
 * ═══════════════════════════════════════════════════════════════
 * 目的：卡库中**大量卡共用的模板行**（如「请用中文回复」类固定句式）会稀释内容指纹，
 *       让「共享模板但真内容不同」的卡被误判同源。做法：先全库统计模板行，再在**算指纹前**逐行剔除。
 *
 * 口径（规格写死，改前必读 §8）：
 *   · 片段 = **行**（按 `\n` 切；`\r` 归一）；有效行 = `trim().length ≥ DF_MIN_LEN`；
 *   · 字段池 = 卡片全字段（含内嵌书词条 content）；
 *   · 单一规范化：`dfLineKey(line) = fnv1a32(normLine(line))`（NFKC → 去首尾 → 空白折叠）；
 *   · 计数 `Map<key, Set<cardId>>`（**同卡同行只计 1 次**）；`set.size ≥ DF_MIN_CARDS` → 模板行；
 *   · 阈值 `DF_MIN_CARDS=5 / DF_MIN_LEN=60`（09-23 标定，见 §13）。
 *
 * 红线：剥离**必须上报**（`dfReport` 进完成提示/日志）；本文件零案例字面量（守卫扫描）。
 */
import { fnv1a32, CARD_FIELD_KEYS, cardBookEntries } from './dedupeCommon.js';

export const DF_MIN_CARDS = 5;
export const DF_MIN_LEN = 60;

/** 行规范化（NFKC → 去首尾空白 → 空白折叠） */
export const normLine = (line) => String(line == null ? '' : line).normalize('NFKC').trim().replace(/\s+/g, ' ');

/** 行键（单一口径——统计与剔除必须走同一函数） */
export const dfLineKey = (line) => fnv1a32(normLine(line));

/**
 * 抽取一张卡的「有效行」（全字段池，含内嵌书词条 content；备用开场白逐条）。
 * @param {object} data 卡片数据（已过 DF-17 解构）
 * @returns {{lines: string[], fieldsScanned: number}}
 */
export const collectDfLines = (data) => {
    const lines = [];
    let fieldsScanned = 0;
    if (!data || typeof data !== 'object') return { lines, fieldsScanned };
    const pushFrom = (text) => {
        if (typeof text !== 'string' || !text) return;
        fieldsScanned++;
        for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
            const t = raw.trim();
            if (t.length >= DF_MIN_LEN) lines.push(t);
        }
    };
    for (const k of CARD_FIELD_KEYS) pushFrom(data[k]);
    if (Array.isArray(data.alternate_greetings)) {
        for (const g of data.alternate_greetings) pushFrom(g);
    }
    for (const e of cardBookEntries(data)) {
        if (e && typeof e === 'object') pushFrom(e.content);
    }
    return { lines, fieldsScanned };
};

/**
 * 全库统计 → 模板行键集。
 * @param {Array<{id:string, lines:string[]}>} perCard 每卡有效行（来自 `collectDfLines`）
 * @returns {{keys:Set<number>, linesTotal:number, templateLines:number, cardsWithTemplate:number}}
 */
export const buildTemplateKeySet = (perCard) => {
    const vote = new Map(); // key -> Set<cardId>
    let linesTotal = 0;
    for (const item of perCard || []) {
        const id = item && item.id;
        if (id === undefined || id === null) continue;
        const seen = new Set(); // 同卡同行只计 1 次
        for (const line of (item.lines || [])) {
            linesTotal++;
            const key = dfLineKey(line);
            if (seen.has(key)) continue;
            seen.add(key);
            let set = vote.get(key);
            if (!set) { set = new Set(); vote.set(key, set); }
            set.add(id);
        }
    }
    const keys = new Set();
    let cardsWithTemplate = 0;
    for (const [key, set] of vote) {
        if (set.size >= DF_MIN_CARDS) keys.add(key);
    }
    if (keys.size > 0) {
        const hit = new Set();
        for (const item of perCard || []) {
            if (!item || item.id === undefined || item.id === null) continue;
            for (const line of (item.lines || [])) {
                if (keys.has(dfLineKey(line))) { hit.add(item.id); break; }
            }
        }
        cardsWithTemplate = hit.size;
    }
    return { keys, linesTotal, templateLines: keys.size, cardsWithTemplate };
};

/**
 * 逐行剔除模板行（模板行替换为空行，**保留行结构**以免把相邻行粘连）。
 * @param {string} text
 * @param {Set<number>} templateKeys
 * @returns {{text:string, stripped:number, strippedChars:number}} stripped = 被剔除的行数
 */
export const stripTemplateLines = (text, templateKeys) => {
    const s = String(text == null ? '' : text);
    if (!templateKeys || templateKeys.size === 0 || !s) return { text: s, stripped: 0, strippedChars: 0 };
    const out = [];
    let stripped = 0;
    let strippedChars = 0;
    for (const raw of s.replace(/\r\n?/g, '\n').split('\n')) {
        const t = raw.trim();
        if (t.length >= DF_MIN_LEN && templateKeys.has(dfLineKey(t))) {
            out.push('');
            stripped++;
            strippedChars += raw.length;
        } else {
            out.push(raw);
        }
    }
    return { text: out.join('\n'), stripped, strippedChars };
};

/**
 * 对整个卡片 data 逐字段剔除模板行。
 * ⚠️ **绝不修改应用内存中的原对象**：先探测（不克隆），仅当**命中**时才 `structuredClone` 并改克隆体。
 * @returns {{data:object, stripped:number, strippedChars:number}|null} null = 无变化（无需克隆）
 */
export const stripDataTemplateLines = (data, templateKeys) => {
    if (!data || typeof data !== 'object' || !templateKeys || templateKeys.size === 0) return null;
    const probe = (text) => (typeof text === 'string' && text ? stripTemplateLines(text, templateKeys).stripped : 0);
    let hit = 0;
    for (const k of CARD_FIELD_KEYS) hit += probe(data[k]);
    if (Array.isArray(data.alternate_greetings)) for (const g of data.alternate_greetings) hit += probe(g);
    for (const e of cardBookEntries(data)) if (e && typeof e === 'object') hit += probe(e.content);
    if (hit === 0) return null;

    const clone = structuredClone(data);
    let stripped = 0;
    let strippedChars = 0;
    const apply = (v) => {
        if (typeof v !== 'string' || !v) return v;
        const r = stripTemplateLines(v, templateKeys);
        stripped += r.stripped; strippedChars += r.strippedChars;
        return r.text;
    };
    for (const k of CARD_FIELD_KEYS) if (typeof clone[k] === 'string') clone[k] = apply(clone[k]);
    if (Array.isArray(clone.alternate_greetings)) {
        clone.alternate_greetings = clone.alternate_greetings.map((g) => (typeof g === 'string' ? apply(g) : g));
    }
    const cb = clone.character_book || clone.characterBook;
    if (cb && cb.entries) {
        const arr = Array.isArray(cb.entries) ? cb.entries : Object.values(cb.entries);
        for (const e of arr) if (e && typeof e === 'object' && typeof e.content === 'string') e.content = apply(e.content);
    }
    return { data: clone, stripped, strippedChars };
};
