/**
 * 📦 数据契约层（v4 §3）—— 三库统一归一化
 * ═══════════════════════════════════════════════════════════════
 * 产出 NormalizedItem：全流程（候选 / 判定 / 聚类 / 视图）统一消费的**普通对象**。
 *
 * 硬约束（红线）：
 *   · **禁止静默**：任何缺数据/缺索引一律写 `degraded`（字符串码），由编排层汇总上报；
 *   · 文本字段**算完指纹即释放**（不随对象常驻，内存友好；视图所需 `desc` 单独保留）；
 *   · 字段口径：卡片 = DF-17 `data?.data || data`；世界书 = L1 只读（keyHashes/simhash/exactContentHash）。
 */
import {
    cardDataOf, extractCardFullText, extractCardCoreText, extractCardKeys, cardBookEntries,
    keysToHashes, exactTextKey, computeMinHash96, promptsOf, extractPresetText, countPrompts,
} from './dedupeCommon.js';
import { computeSimhash64 } from './simhash64.mjs';
import { buildPresetStructure } from './dedupePreset.js';

/** 文本最短长度（低于此不产 MinHash/内容指纹 —— 阈值见 v4 §13） */
export const MIN_TEXT_LEN = 20;

const nameOf = (item) => {
    if (!item || typeof item !== 'object') return '未命名';
    return String(item.name || item.wbName || '未命名').trim() || '未命名';
};

/**
 * 角色卡归一化。
 * @returns {{ id, path, name, type:'card', raw, keyHashes, keyCount, fullMinHash, coreSig, fullSig,
 *             exactKey, textLen, cbEntryCount, desc, tokens, dateStr, sizeKb, tags, avatar, degraded }}
 */
export const normalizeCard = (item) => {
    const base = {
        id: (item && item.path) || (item && item.name) || 'unknown',
        path: item && item.path, name: nameOf(item), type: 'card', raw: item,
        keyHashes: new Uint32Array(0), keyCount: 0, fullMinHash: null, coreSig: null, fullSig: null,
        exactKey: null, textLen: 0, cbEntryCount: 0, desc: '',
        tokens: (item && typeof item._tokens === 'number') ? item._tokens : 0,
        dateStr: (item && (item.dateStr || item.mtime)) || '',
        sizeKb: (item && (item.sizeKb || Math.round((item._size || 0) / 1024))) || 0,
        tags: Array.isArray(item && item.tags) ? item.tags : (Array.isArray(item && item.customTags) ? item.customTags : []),
        avatar: (item && item.avatar) || '',
        degraded: null,
    };
    const data = cardDataOf(item);
    if (!data) return { ...base, degraded: 'EMPTY_DATA' };

    const keys = extractCardKeys(data);
    const keyHashes = keysToHashes(keys);
    const entries = cardBookEntries(data);
    const fullText = extractCardFullText(data);
    const coreText = extractCardCoreText(data);
    base.cbEntryCount = entries.length;
    base.desc = typeof data.description === 'string' ? data.description : '';
    if (!fullText.trim()) return { ...base, keyHashes, keyCount: keyHashes.length, degraded: 'NO_TEXT' };

    base.textLen = fullText.length;
    base.keyHashes = keyHashes;
    base.keyCount = keyHashes.length;
    base.exactKey = exactTextKey(fullText);
    base.fullSig = computeSimhash64(fullText);
    base.coreSig = coreText.trim() ? computeSimhash64(coreText) : null;
    base.fullMinHash = fullText.length >= MIN_TEXT_LEN ? computeMinHash96(fullText) : null;
    return base; // ⚠️ fullText/coreText 到此为止（不随对象返回）
};

/**
 * 世界书归一化（**只读 L1，永不重读正文**）。
 * @returns {{ id, path, name, type:'wb', raw, keyHashes, keyCount, exactKey(sha256), simhash,
 *             entryCount, dateStr, sizeKb, degraded }}
 */
export const normalizeWorldbook = (wb) => {
    const base = {
        id: (wb && wb.path) || 'unknown',
        path: wb && wb.path, name: nameOf(wb), type: 'wb', raw: wb,
        keyHashes: null, keyCount: 0, exactKey: null, simhash: null,
        entryCount: (wb && typeof wb.entryCount === 'number') ? wb.entryCount : 0,
        desc: '', textLen: 0, cbEntryCount: undefined,
        dateStr: (wb && (wb.mtime || wb.dateStr)) || '',
        sizeKb: (wb && Math.round((wb.size || 0) / 1024)) || 0,
        tags: [], avatar: '', tokens: 0,
        degraded: null,
    };
    const validKeyHashes = (wb && wb.keyHashes instanceof Uint32Array) ? wb.keyHashes
        : (wb && Array.isArray(wb.keyHashes) ? new Uint32Array(wb.keyHashes) : null);
    const validSimhash = (wb && Array.isArray(wb.simhash) && wb.simhash.length === 2) ? wb.simhash : null;
    const exact = (wb && wb.exactContentHash) || null;

    if (!validKeyHashes && !validSimhash && !exact) {
        return { ...base, degraded: 'L1_INDEX_NOT_READY' }; // 严禁填 [0,0] 兜底 —— 显式降级
    }
    return {
        ...base,
        keyHashes: validKeyHashes,
        keyCount: validKeyHashes ? validKeyHashes.length : 0,
        simhash: validSimhash,
        exactKey: exact,
        degraded: null,
    };
};

/**
 * 预设归一化。
 * @returns {{ id, path, name, type:'preset', raw, keyHashes, keyCount, fullMinHash, exactKey,
 *             promptCount, desc, dateStr, sizeKb, degraded }}
 */
export const normalizePreset = (p) => {
    const base = {
        id: (p && (p.path || p.name)) || 'unknown',
        path: (p && p.path) || (p && p.name), name: nameOf(p), type: 'preset', raw: p,
        keyHashes: null, keyCount: 0, fullMinHash: null, coreSig: null, fullSig: null,
        exactKey: null, textLen: 0, cbEntryCount: undefined,
        promptCount: 0, desc: '',
        // 预设三维（v4 §3.3）：结构 / 启用 / 参数（内容 = fullMinHash）
        identifierSeq: '', identifierSet: null, enabledRatio: null, sampler: {},
        dateStr: (p && (p.dateStr || p.mtime)) || '',
        sizeKb: (p && (p.sizeKb || 0)) || 0,
        tags: [], avatar: '', tokens: 0,
        degraded: null,
    };
    const data = (p && p.data) ? p.data : null;
    if (!data) return { ...base, degraded: 'EMPTY_DATA' };
    const prompts = promptsOf(data);
    if (prompts.length === 0) return { ...base, degraded: 'NO_PROMPTS' };

    const contentText = extractPresetText(data);
    base.promptCount = countPrompts(data);
    base.textLen = contentText.length;
    // 🧩 预设三维（v4 §3.3/§9.2）：结构（identifierSeq/Set）+ 启用比例 + 采样参数
    const struct = buildPresetStructure(data);
    base.identifierSeq = struct.identifierSeq;
    base.identifierSet = struct.identifierSet;
    base.enabledRatio = struct.enabledRatio;
    base.sampler = struct.sampler;
    let key = null;
    try { key = exactTextKey(JSON.stringify(data)); } catch (e) { key = null; }
    base.exactKey = key;
    base.fullMinHash = contentText.length >= MIN_TEXT_LEN ? computeMinHash96(contentText) : null;
    return base;
};

/** 从归一化条目集合收集名字（语料统计用） */
export const collectNames = (items) => (items || []).map((it) => it && it.name).filter(Boolean);
