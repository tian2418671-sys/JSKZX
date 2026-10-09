/**
 * 🔀 世界书合并（纯函数 · 可单测 · 不依赖 DOM/Electron）
 *
 * 来历（2026-10-03 · v2.3.6 五功能之三）：把原本内嵌在 `App.vue::executeWorldbookMerge` 的合并算法
 *   提取为可测单一事实源，并修掉两个隐患：
 *     · 去重键**顺序敏感**（`["A","B"]` 与 `["B","A"]` 被判为不同词条）⇒ 改为 keys 逐项归一 + **排序**后拼接；
 *     · key/content 可能是数字/对象 ⇒ 统一 `String()` 兜底（历史崩溃点）；
 *   同时新增**只统计不取舍**的「键冲突」报告（同 keys 不同 content ⇒ 两个词条都保留，预览里提示）。
 *
 * 口径（与规格 `docs/规格与计划/查重引擎/世界书合并-查重组一键合并-实现规格.md` §2.1 对齐）：
 *   · 签名 = `normKeys :: normContent`；首次出现者胜（added），后续同签名计入 skippedDup；
 *   · uid **全量重生成**（合并产出的是新书，与源书 uid 无关联语义）；
 *   · 内部字段按 `dropInternalFields`（**限定位置**白名单）清理 —— **绝不**递归剔 `_` 前缀（DF-14：会误删 `extensions._filename`）；
 *   · 源书**不被修改**（本模块只读 sources，返回全新数组）。
 */
import { dropInternalFields } from './cardFields.js';

/** keys 归一：数组逐项 String+trim+小写 → **排序** → 拼接（对顺序不敏感） */
export function normKeysOf(entry) {
    const k = (entry && entry.key !== undefined && entry.key !== null) ? entry.key : '';
    const arr = Array.isArray(k) ? k : [k];
    return arr
        .map((x) => String(x === undefined || x === null ? '' : x).trim().toLowerCase())
        .filter((x) => x !== '')
        .sort()
        .join('\u0001');
}

/** content 归一（非字符串一律 String 兜底） */
export function normContentOf(entry) {
    const c = (entry && entry.content !== undefined && entry.content !== null) ? entry.content : '';
    return String(c).trim().toLowerCase();
}

/** 去重签名 */
export function entrySignature(entry) {
    return `${normKeysOf(entry)}::${normContentOf(entry)}`;
}

/** 内容摘要（冲突报告用；不含换行、截断） */
export function contentHead(entry, max = 60) {
    const s = String((entry && entry.content) || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 默认 uid 工厂（时间戳 + 随机；合并产出新书，故全量重生成） */
export const defaultUidFactory = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * 合并多本世界书的词条
 * @param {Array<{name?:string, entries?:Array}>} sources
 * @param {{uidFactory?:()=>string, maxConflicts?:number}} [opts]
 * @returns {{entries:Array, stats:object}}
 */
export function mergeWorldbookEntries(sources, opts = {}) {
    const list = Array.isArray(sources) ? sources : [];
    const uidFactory = typeof opts.uidFactory === 'function' ? opts.uidFactory : defaultUidFactory;
    const maxConflicts = Number.isFinite(Number(opts.maxConflicts)) ? Number(opts.maxConflicts) : 50;

    const seen = new Set();
    const entries = [];
    const bySource = [];
    /** normKeys → [{source, head, nc}]（每个 keys 桶最多记 BUCKET_MAX 条，防内存膨胀） */
    const keyIndex = new Map();
    const keyConflicts = [];
    const BUCKET_MAX = 20;
    let total = 0;
    let skippedDup = 0;

    for (const src of list) {
        const name = String((src && src.name) || '未命名');
        const srcEntries = Array.isArray(src && src.entries) ? src.entries : [];
        let added = 0;
        let skipped = 0;
        for (const e of srcEntries) {
            if (!e || typeof e !== 'object') continue;   // 脏数据条目防护
            total++;
            const sig = entrySignature(e);
            if (seen.has(sig)) { skipped++; skippedDup++; continue; }
            seen.add(sig);

            // 键冲突：同 `normKeys`、不同 content ⇒ **只统计不取舍**（两个词条都保留）
            const nk = normKeysOf(e);
            const nc = normContentOf(e);
            const bucket = keyIndex.get(nk) || [];
            if (!bucket.length) {
                keyIndex.set(nk, [{ source: name, head: contentHead(e), nc }]);
            } else if (!bucket.some((x) => x.nc === nc)) {
                if (bucket.length < BUCKET_MAX) bucket.push({ source: name, head: contentHead(e), nc });
                const items = bucket.map((x) => ({ source: x.source, contentHead: x.head }));
                const exist = keyConflicts.find((c) => c.normKeys === nk);
                if (exist) exist.items = items;
                else if (keyConflicts.length < maxConflicts) keyConflicts.push({ normKeys: nk, keys: keySampleOf(e), items });
            }

            // 🧹 深拷贝 + 只剔**词条自身**的内部字段（不递归剔 `_` 前缀的键 —— DF-14）
            const clean = dropInternalFields(JSON.parse(JSON.stringify(e)));
            clean.uid = uidFactory();
            entries.push(clean);
            added++;
        }
        bySource.push({ name, total: srcEntries.length, added, skipped });
    }

    return {
        entries,
        stats: { total, added: entries.length, skippedDup, bySource, keyConflicts }
    };
}

/** keys 原样样例（预览展示用，保留大小写与顺序） */
export function keySampleOf(entry) {
    const k = (entry && entry.key !== undefined && entry.key !== null) ? entry.key : '';
    const arr = Array.isArray(k) ? k : [k];
    return arr.map((x) => String(x === undefined || x === null ? '' : x).trim()).filter(Boolean);
}

/** 新书展示名 */
export function mergeNameOf(count) {
    return `合并世界书_${Math.max(0, Number(count) || 0)}本`;
}

/** 新书描述（与旧实现同口径） */
export function mergeDescriptionOf(names, entryCount) {
    const list = (names || []).map((x) => String(x || '')).filter(Boolean);
    return `由 [${list.join(', ')}] 合并而成，包含 ${Math.max(0, Number(entryCount) || 0)} 个词条。`;
}
