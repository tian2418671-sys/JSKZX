/**
 * 🪣 候选层（v4 §5）—— 三轨候选 + 桶上限 + 超限抽样 + **必上报**
 * ═══════════════════════════════════════════════════════════════
 * 三轨：
 *   ① 内容轨：MinHash-96 → 16×6 band LSH（字符串桶键，零碰撞；桶深 >200 抽样+上报）
 *   ② keys 轨：bottom-k 倒排（每项前 30 个；桶深 >100 跳过+上报——高频泛用词特征）
 *   ③ 名字轨：stemFinal char-2gram 倒排（桶深 >200 抽样+上报；桶内 `nameSim ≥ 0.5` 复核）
 *   + 世界书专用：simhash 高 16 位粗桶 + 相邻桶（**仅生成候选，不判定**）
 *
 * 红线：**任何抽样/跳过都必须进 `report.notice()`**（禁止静默）。
 * 输入约定：条目为 `dedupeContract` 产出；名字轨依赖编排层预先挂好的 `item.stemFinal`。
 */
import { nameSimRaw } from './dedupeNames.js';

export const BUCKET_CAP_CONTENT = 200;
export const BUCKET_CAP_KEYS = 100;
export const BUCKET_CAP_NAME = 200;
export const BUCKET_CAP_SIMHASH = 500;
export const CANDIDATE_CAP = 500000;

const hex8 = (v) => (v >>> 0).toString(16).padStart(8, '0');
const bigramsOf = (s) => {
    const set = new Set();
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
};

/**
 * @param {object[]} items 归一化条目（同库）
 * @param {{report?:{notice:Function}}} [opts]
 * @returns {Array<[object, object]>} 候选对
 */
export const buildCandidatePairs = (items, { report = null } = {}) => {
    const pairs = new Map();
    const notice = (msg) => { if (report && typeof report.notice === 'function') report.notice(msg); };
    const add = (a, b) => {
        if (!a || !b || a.id === b.id) return;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (!pairs.has(key)) pairs.set(key, [a, b]);
    };

    // ── ① 内容轨：MinHash → 16×6 band LSH ──
    const lshBuckets = new Map();
    for (const it of items) {
        const sig = it.fullMinHash;
        if (!sig || sig.length !== 96) continue;
        for (let b = 0; b < 16; b++) {
            const o = b * 6;
            const key = `${b}:${hex8(sig[o])}${hex8(sig[o + 1])}${hex8(sig[o + 2])}${hex8(sig[o + 3])}${hex8(sig[o + 4])}${hex8(sig[o + 5])}`;
            let arr = lshBuckets.get(key);
            if (!arr) { arr = []; lshBuckets.set(key, arr); }
            arr.push(it);
        }
    }
    for (const [key, bucket] of lshBuckets) {
        if (bucket.length < 2) continue;
        let list = bucket;
        if (bucket.length > BUCKET_CAP_CONTENT) {
            list = bucket.slice(0, BUCKET_CAP_CONTENT);
            notice(`内容轨桶超限（${bucket.length} > ${BUCKET_CAP_CONTENT}）已抽样`);
        }
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) add(list[i], list[j]);
        }
    }

    // ── ② keys 轨：bottom-k 倒排 ──
    const keyIndex = new Map();
    for (const it of items) {
        const kh = it.keyHashes;
        if (!kh || kh.length === 0) continue;
        const lim = Math.min(kh.length, 30);
        for (let k = 0; k < lim; k++) {
            const h = kh[k];
            let arr = keyIndex.get(h);
            if (!arr) { arr = []; keyIndex.set(h, arr); }
            arr.push(it);
        }
    }
    for (const [h, bucket] of keyIndex) {
        if (bucket.length < 2) continue;
        if (bucket.length > BUCKET_CAP_KEYS) {
            notice(`keys 轨高频桶跳过（${bucket.length} > ${BUCKET_CAP_KEYS}）：hash ${h}`);
            continue;
        }
        for (let i = 0; i < bucket.length; i++) {
            for (let j = i + 1; j < bucket.length; j++) add(bucket[i], bucket[j]);
        }
    }

    // ── ③ 名字轨：stemFinal 2-gram 倒排 + nameSim 复核 ──
    const nameBuckets = new Map();
    for (const it of items) {
        const stem = it.stemFinal || '';
        if (!stem) continue;
        for (const g of bigramsOf(stem)) {
            let arr = nameBuckets.get(g);
            if (!arr) { arr = []; nameBuckets.set(g, arr); }
            arr.push(it);
        }
    }
    for (const [g, bucket] of nameBuckets) {
        if (bucket.length < 2) continue;
        let list = bucket;
        if (bucket.length > BUCKET_CAP_NAME) {
            list = bucket.slice(0, BUCKET_CAP_NAME);
            notice(`名字轨桶超限（${bucket.length} > ${BUCKET_CAP_NAME}）已抽样：${g}`);
        }
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const s = nameSimRaw(list[i].name, list[j].name);
                if (s !== null && s >= 0.5) add(list[i], list[j]);
            }
        }
    }

    // ── 世界书专用：simhash 粗桶 + 相邻桶 ──
    const sigBuckets = new Map();
    for (const it of items) {
        if (!it.simhash) continue;
        const c = (it.simhash[1] >>> 16) & 0xffff;
        let arr = sigBuckets.get(c);
        if (!arr) { arr = []; sigBuckets.set(c, arr); }
        arr.push(it);
    }
    const expandSig = (list) => {
        if (list.length < 2) return;
        let l = list;
        if (l.length > BUCKET_CAP_SIMHASH) {
            notice(`simhash 轨桶超限（${l.length} > ${BUCKET_CAP_SIMHASH}）已抽样`);
            l = l.slice(0, BUCKET_CAP_SIMHASH);
        }
        for (let i = 0; i < l.length; i++) {
            for (let j = i + 1; j < l.length; j++) add(l[i], l[j]);
        }
    };
    const sigKeys = [...sigBuckets.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sigKeys.length; i++) {
        const list = sigBuckets.get(sigKeys[i]);
        expandSig(list);
        if (i + 1 < sigKeys.length) expandSig(list.concat(sigBuckets.get(sigKeys[i + 1])));
    }

    // ── 合并输出（工程护栏） ──
    let out = [...pairs.values()];
    if (out.length > CANDIDATE_CAP) {
        notice(`候选对超限（${out.length} > ${CANDIDATE_CAP}）—— 已按序抽样`);
        out = out.slice(0, CANDIDATE_CAP);
    }
    return out;
};
