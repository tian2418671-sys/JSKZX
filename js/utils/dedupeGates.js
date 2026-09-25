/**
 * ⚖️ 判定层（v4 §6）—— 证据分级 L0~L2 + 否决族（**每条带前提**）
 * ═══════════════════════════════════════════════════════════════
 * 顺序（评审通过的规格）：
 *   L0 完全相同直通 → 否决族（①触发词矛盾 / ②共用世界书不同角色 / ③全字段分歧·含前提）
 *   → L1 keys 精确定夺 → L2 MinHash 定夺。
 *
 * 分数与判定同源（v4 §6.4）：`simPct` = **最强命中证据的百分比**（L0=100 / L1=keys / L2=MinHash）；
 * 长度惩罚不混入百分比（由排序与独立徽标承担）——从机制上消灭「19% 却同组」。
 *
 * ⚠️ 本文件零案例字面量；样本数据只存在于 `test/fixtures/dedupe-labels.json`。
 */
import { keysJaccard, estimateMinHashSimilarity } from './dedupeCommon.js';
import { nameSimRaw } from './dedupeNames.js';
import { hammingDistance64 } from './simhash64.mjs';

/** 阈值表（值 / 来源见 v4 §13 标定表；改这里必须同步更新文档与测试） */
export const THRESHOLDS = Object.freeze({
    KEYS_PASS: 0.90,          // L1：keys 精确定夺
    CONTENT_PASS: 0.85,       // L2：MinHash 定夺（09-23 复核闸门同口径）
    KEYS_CONFLICT: 0.05,      // 否决①：触发词严重矛盾（AR-50 标定）
    SHARED_WB_KEYS: 0.50,     // 否决②：keys 高门槛
    SHARED_WB_NAME_SIM: 0.30, // 否决②：名似低门槛
    SHARED_WB_CORE_DIST: 24,  // 否决②：coreSig 汉明距离（NAME_ONLY 口径）
    RATIO_MIN_CORE: 0.60,     // 否决③：coreSim 下限（防比值失真）
    RATIO_DIVERGE: 0.40,      // 否决③：fullSim/coreSim 分歧比值
});

const reject = (reason) => ({ pass: false, level: null, simPct: 0, type: null, reason });
const accept = (level, simPct, type) => ({ pass: true, level, simPct, type, reason: null });

/**
 * 对一对归一化条目做判定。
 * @param {object} a @param {object} b —— `dedupeContract` 产出（同 type）
 * @returns {{pass:boolean, level:0|1|2|null, simPct:number, type:'duplicate'|'high'|null, reason:string|null}}
 */
export const evaluateGate = (a, b) => {
    if (!a || !b) return reject('MISSING_ITEM');
    if (a.type !== b.type) return reject('TYPE_MISMATCH');

    // ── L0：完全相同（在否决族之前直通 —— 精确正证据不可被近似量否决） ──
    if (a.exactKey && b.exactKey && a.exactKey === b.exactKey) {
        return accept(0, 100, 'duplicate');
    }

    const kj = keysJaccard(a.keyHashes, b.keyHashes);
    const ns = nameSimRaw(a.name, b.name);

    // ── 否决①：触发词严重矛盾（两侧均 ≥2 键才有统计意义） ──
    if (a.keyCount >= 2 && b.keyCount >= 2 && kj !== null && kj < THRESHOLDS.KEYS_CONFLICT) {
        return reject('TRIGGER_KEYS_CONFLICT');
    }

    // ── 否决②：共用世界书但不同角色（keys 高 + 名似低 + 核心指纹远） ──
    if (kj !== null && kj >= THRESHOLDS.SHARED_WB_KEYS && ns !== null && ns < THRESHOLDS.SHARED_WB_NAME_SIM) {
        if (a.coreSig && b.coreSig && hammingDistance64(a.coreSig, b.coreSig) > THRESHOLDS.SHARED_WB_CORE_DIST) {
            return reject('SHARED_WB_DIFF_CHAR');
        }
    }

    // ── 否决③：全字段/5 字段分歧（**前提：任一侧内嵌词条数 = 0** —— 恢复 09-24 标定前提） ──
    if ((a.cbEntryCount === 0 || b.cbEntryCount === 0) && a.fullSig && b.fullSig && a.coreSig && b.coreSig) {
        const fullSim = 1 - hammingDistance64(a.fullSig, b.fullSig) / 64;
        const coreSim = 1 - hammingDistance64(a.coreSig, b.coreSig) / 64;
        if (coreSim > THRESHOLDS.RATIO_MIN_CORE && (fullSim / coreSim) < THRESHOLDS.RATIO_DIVERGE) {
            return reject('FULL_FIELD_DIVERGENCE');
        }
    }

    // ── L1：keys 精确定夺 ──
    if (kj !== null && kj >= THRESHOLDS.KEYS_PASS) {
        return accept(1, Math.round(kj * 100), 'high');
    }

    // ── L2：MinHash 定夺（卡片 / 预设；世界书无此指纹 → null 跳过） ──
    const mh = estimateMinHashSimilarity(a.fullMinHash, b.fullMinHash);
    if (mh !== null && mh >= THRESHOLDS.CONTENT_PASS) {
        return accept(2, Math.round(mh * 100), 'high');
    }

    return reject('THRESHOLD_NOT_MET');
};
