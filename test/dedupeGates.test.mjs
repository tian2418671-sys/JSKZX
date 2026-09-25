import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, THRESHOLDS } from '../js/utils/dedupeGates.js';
import { keysToHashes, computeMinHash96 } from '../js/utils/dedupeCommon.js';
import { computeSimhash64 } from '../js/utils/simhash64.mjs';

/** v4 §6 —— 判定层单测（证据分级 / 否决族 / 每条带前提） */

// 校准样本（与 p1-calibrate 一致；文本内容为泛化样本，无真实案例名）
const T_A = '她是一位来自昆仑的年轻修士，性格温柔却异常坚定。修炼路上，她始终相信善意会带来回响。面对险境，她从不退缩，总在关键时刻挺身而出。'.repeat(4);
const T_U = '这是一台老式蒸汽机车，锅炉的轰鸣声在旷野中回荡。司机检查了每一个阀门，确保压力表读数正常。'.repeat(4);

const mk = (o = {}) => {
    const kh = (o.keyHashes instanceof Uint32Array) ? o.keyHashes : keysToHashes(o.keys || []);
    return {
        id: o.id || o.name || 'x', path: o.path || `/fake/${o.name || 'x'}.png`,
        name: o.name || '样本', type: o.type || 'card',
        exactKey: o.exactKey || null,
        keyHashes: kh, keyCount: kh.length,
        fullSig: o.fullSig || null, coreSig: o.coreSig || null, fullMinHash: o.fullMinHash || null,
        cbEntryCount: o.cbEntryCount === undefined ? 0 : o.cbEntryCount,
        textLen: o.textLen || 0,
    };
};

test('L0：exactKey 相同 → 直通（在否决族之前）', () => {
    const g = evaluateGate(mk({ exactKey: 'abc123', keys: ['甲'] }), mk({ exactKey: 'abc123', keys: ['乙'] }));
    assert.deepEqual(g, { pass: true, level: 0, simPct: 100, type: 'duplicate', reason: null });
});

test('L0 直通不被否决族拦截：内容相同即使触发词矛盾', () => {
    // 前提说明：完全相同是「精确正证据」，不可能被近似量否决（规格 §6）
    const g = evaluateGate(mk({ exactKey: 'k1', keys: ['甲', '乙'] }), mk({ exactKey: 'k1', keys: ['丙', '丁'] }));
    assert.equal(g.pass, true);
    assert.equal(g.level, 0);
});

test('L1：keys 精确定夺（kj ≥ 0.90）', () => {
    const g = evaluateGate(mk({ name: '甲', keys: ['甲', '乙'], fullSig: computeSimhash64(T_A) }), mk({ name: '乙样本', keys: ['甲', '乙'], fullSig: computeSimhash64(T_A) }));
    assert.equal(g.pass, true);
    assert.equal(g.level, 1);
    assert.equal(g.simPct, 100);
    assert.equal(g.type, 'high');
});

test('L2：MinHash 定夺（无 keys、签名相同）', () => {
    const sig = computeMinHash96(T_A);
    const g = evaluateGate(mk({ exactKey: 'p1', fullMinHash: sig }), mk({ exactKey: 'p2', fullMinHash: sig }));
    assert.equal(g.pass, true);
    assert.equal(g.level, 2);
    assert.equal(g.simPct, 100);
});

test('L2 缺签名：不得静默当 0（fullMinHash null → 拒绝而非误判通过）', () => {
    const g = evaluateGate(mk({ exactKey: 'p1' }), mk({ exactKey: 'p2', fullMinHash: computeMinHash96(T_A) }));
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'THRESHOLD_NOT_MET');
});

test('否决①：触发词严重矛盾（两侧均 ≥2 键、kj < 0.05）', () => {
    const g = evaluateGate(
        mk({ keys: ['甲', '乙', '丙'], fullMinHash: computeMinHash96(T_A), fullSig: computeSimhash64(T_A) }),
        mk({ keys: ['丁', '戊', '己'], fullMinHash: computeMinHash96(T_A), fullSig: computeSimhash64(T_A) }),
    );
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'TRIGGER_KEYS_CONFLICT');
});

test('否决①前提：单键不触发（不得误杀「各只有 1 个触发词」的卡）', () => {
    const g = evaluateGate(mk({ keys: ['甲'] }), mk({ keys: ['乙'] }));
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'THRESHOLD_NOT_MET');
});

test('否决②：共用世界书不同角色（keys 高 + 名不像 + 核心指纹远 > 24）', () => {
    const g = evaluateGate(
        mk({ name: '琥珀', keys: ['共用甲', '共用乙', '共用丙', '共用丁'], coreSig: computeSimhash64(T_A) }),
        mk({ name: '苍岚', keys: ['共用甲', '共用乙', '共用丙', '共用戊'], coreSig: computeSimhash64(T_U) }),
    );
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'SHARED_WB_DIFF_CHAR');
});

test('否决②前提（名似）：名称相似（≥0.30）→ 不触发；核心相似（≤ 24）→ 不触发', () => {
    // 名似反例
    const g1 = evaluateGate(
        mk({ name: '琥珀', keys: ['共用甲', '共用乙', '共用丙', '共用丁'], coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_U) }),
        mk({ name: '琥珀 改', keys: ['共用甲', '共用乙', '共用丙', '共用戊'], coreSig: computeSimhash64(T_U), fullSig: computeSimhash64(T_U) }),
    );
    assert.notEqual(g1.reason, 'SHARED_WB_DIFF_CHAR');
    // 核心相似反例（且内容真同源 → 应到 L2 通过，不得被误杀）
    const sig = computeMinHash96(T_A);
    const g2 = evaluateGate(
        mk({ name: '琥珀', keys: ['共用甲', '共用乙', '共用丙', '共用丁'], coreSig: computeSimhash64(T_A), fullMinHash: sig }),
        mk({ name: '苍岚', keys: ['共用甲', '共用乙', '共用丙', '共用戊'], coreSig: computeSimhash64(T_A), fullMinHash: sig }),
    );
    assert.equal(g2.pass, true);
    assert.equal(g2.level, 2);
});

test('否决③：全字段分歧（前提 cbEntryCount=0 + coreSim>0.60 + ratio<0.40）', () => {
    // core 完全相同（coreSim=1.0）；full 分离（dist(A,U)=41 → fullSim≈0.36 → ratio≈0.36 < 0.40）
    const g = evaluateGate(
        mk({ keys: ['甲', '乙'], cbEntryCount: 0, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_A) }),
        mk({ keys: ['甲', '乙'], cbEntryCount: 0, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_U) }),
    );
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'FULL_FIELD_DIVERGENCE');
});

test('否决③前提：**两侧都有**内嵌词条 → 前提不满足，不触发（不误杀）', () => {
    const g = evaluateGate(
        mk({ keys: ['甲', '乙'], cbEntryCount: 1, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_A) }),
        mk({ keys: ['甲', '乙'], cbEntryCount: 2, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_U) }),
    );
    assert.notEqual(g.reason, 'FULL_FIELD_DIVERGENCE');
    assert.equal(g.level, 1, '未被否决 → 走正常证据级（keys 相同 → L1）');
});

test('否决③前提：**任一侧**cbEntryCount=0 → 前提满足，正常触发', () => {
    const g = evaluateGate(
        mk({ keys: ['甲', '乙'], cbEntryCount: 1, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_A) }),
        mk({ keys: ['甲', '乙'], cbEntryCount: 0, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_U) }),
    );
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'FULL_FIELD_DIVERGENCE');
});

test('否决③前提：coreSim ≤ 0.60 → 不触发（防比值失真）', () => {
    const g = evaluateGate(
        mk({ keys: ['甲', '乙'], cbEntryCount: 0, coreSig: computeSimhash64(T_A), fullSig: computeSimhash64(T_A) }),
        mk({ keys: ['甲', '乙'], cbEntryCount: 0, coreSig: computeSimhash64(T_U), fullSig: computeSimhash64(T_U) }),
    );
    // coreSim = 1-41/64 ≈ 0.36 ≤ 0.60 → 不触发否决③；keys 相同 → L1 通过
    assert.equal(g.reason, null);
    assert.equal(g.level, 1);
});

test('类型不符 / 缺项：显式原因，不静默', () => {
    assert.equal(evaluateGate(mk({ name: 'a' }), mk({ name: 'b', type: 'wb' })).reason, 'TYPE_MISMATCH');
    assert.equal(evaluateGate(null, mk({ name: 'b' })).reason, 'MISSING_ITEM');
});

test('阈值表冻结（防意外漂移）', () => {
    assert.ok(Object.isFrozen(THRESHOLDS));
    assert.deepEqual({ ...THRESHOLDS }, {
        KEYS_PASS: 0.90, CONTENT_PASS: 0.85, KEYS_CONFLICT: 0.05,
        SHARED_WB_KEYS: 0.50, SHARED_WB_NAME_SIM: 0.30, SHARED_WB_CORE_DIST: 24,
        RATIO_MIN_CORE: 0.60, RATIO_DIVERGE: 0.40,
    });
});
