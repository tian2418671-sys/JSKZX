/**
 * 🕸️ 分组层（v4 §7）—— 星型 + 簇心（确定性、无传递）
 * ═══════════════════════════════════════════════════════════════
 * 与 PK-29 教训对齐：
 *   · **禁止连通分量/传递合并**——两侧已在不同组时绝不合并（记录 notice）；
 *   · 新成员必须**与中心重算判定**通过才加入（不信任传递）；
 *   · 中心升迁必须**全员回归校验**通过；
 *   · `minScore` 随成员加入**实时更新**（字段名不撒谎）。
 *
 * 确定性：边先按 (level ↑ 强优先, simPct ↓, path ↑) 排序；中心比较用 (边分, textLen, path)。
 */
import { evaluateGate } from './dedupeGates.js';
import { normName } from './dedupeNames.js';

const edgeScore = (g) => 3200 - (g.level || 0) * 1000 + (g.simPct || 0);

const compareEdges = (e1, e2) => (
    (e1.gate.level - e2.gate.level)
    || (e2.gate.simPct - e1.gate.simPct)
    || String((e1.a && e1.a.path) || '').localeCompare(String((e2.a && e2.a.path) || ''))
);

/**
 * 星型聚类。
 * @param {Array<{a:object,b:object,gate:object}>} edges —— 已通过 `evaluateGate` 的边
 * @param {{decider?:Function}} [opts]
 * @returns {{clusters:Array, notices:string[]}}
 *   cluster = { id, center, members, level, simPct, minScore, type }
 */
export const buildStarClusters = (edges, { decider = evaluateGate } = {}) => {
    const sorted = (edges || []).slice().sort(compareEdges);
    const clusters = [];
    const byId = new Map();
    const bestScore = new Map(); // item.id -> max edgeScore（中心比较键）
    const notices = [];
    const bump = (item, s) => { if (s > (bestScore.get(item.id) || 0)) bestScore.set(item.id, s); };
    const better = (cand, curr) => {
        const rc = bestScore.get(cand.id) || 0;
        const rr = bestScore.get(curr.id) || 0;
        if (rc !== rr) return rc > rr;
        if ((cand.textLen || 0) !== (curr.textLen || 0)) return (cand.textLen || 0) > (curr.textLen || 0);
        return String(cand.path || '') < String(curr.path || '');
    };

    const tryJoin = (cluster, item) => {
        const g = decider(cluster.center, item);
        if (!g.pass) {
            notices.push(`未并入（与中心不符）：${item.name}`);
            return;
        }
        cluster.members.push(item);
        byId.set(item.id, cluster);
        cluster.minScore = Math.min(cluster.minScore, g.simPct);
        if (g.level < cluster.level) cluster.level = g.level;
        if (better(item, cluster.center)) {
            const allPass = cluster.members.every((m) => m.id === item.id || decider(item, m).pass);
            if (allPass) cluster.center = item;
            else notices.push(`中心升迁未通过全员回归：${item.name}`);
        }
    };

    for (const e of sorted) {
        const s = edgeScore(e.gate);
        bump(e.a, s); bump(e.b, s);
        const ca = byId.get(e.a.id);
        const cb = byId.get(e.b.id);
        if (!ca && !cb) {
            const center = better(e.a, e.b) ? e.a : e.b;
            const c = {
                id: `g_${e.a.id}|${e.b.id}`, center,
                members: [e.a, e.b], level: e.gate.level, simPct: e.gate.simPct,
                minScore: e.gate.simPct, type: e.gate.type,
            };
            clusters.push(c);
            byId.set(e.a.id, c); byId.set(e.b.id, c);
        } else if (ca && !cb) {
            tryJoin(ca, e.b);
        } else if (!ca && cb) {
            tryJoin(cb, e.a);
        } else if (ca !== cb) {
            // 🛡️ PK-29 防御：跨簇绝不连通合并
            notices.push(`跨簇不合并：${e.a.name} ↮ ${e.b.name}`);
        }
    }
    return { clusters, notices };
};

/**
 * 同名家族通道（G7 / AR-48）：**精确同名**但未进入任何正常组的条目 → 家族组（只展示、降级清理）。
 * @param {object[]} items 未入组条目
 */
export const buildNameOnlyGroups = (items) => {
    const buckets = new Map();
    for (const it of items || []) {
        const key = normName(it.name);
        if (!key) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(it);
    }
    const groups = [];
    for (const [key, members] of buckets) {
        if (members.length < 2) continue;
        members.sort((a, b) => (b.textLen || 0) - (a.textLen || 0) || String(a.path || '').localeCompare(String(b.path || '')));
        groups.push({ id: `n_${key}`, center: members[0], members, nameOnly: true });
    }
    return groups;
};
