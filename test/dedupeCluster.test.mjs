import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStarClusters, buildNameOnlyGroups } from '../js/utils/dedupeCluster.js';

/** v4 §7 —— 分组层单测（星型 / 跨簇不合并 / 升迁全员回归 / minScore 实时） */

const G = (level, simPct) => ({ pass: true, level, simPct, type: level === 0 ? 'duplicate' : 'high', reason: null });
const mk = (name, o = {}) => ({ id: o.id || name, path: o.path || `/p/${name}`, name, textLen: o.textLen || 100 });

/** stub 判定器：按无序对键值放行（机制层测试与具体证据解耦） */
const dec = (passSet) => (x, y) => {
    const k = [x.id, y.id].sort().join('|');
    return passSet.has(k) ? G(1, 90) : { pass: false, level: null, simPct: 0, type: null, reason: 'stub' };
};

test('星型聚类：两条独立边 → 两组；跨簇边绝不合并（PK-29 防御）', () => {
    const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
    const edges = [
        { a: A, b: B, gate: G(1, 90) },
        { a: C, b: D, gate: G(1, 90) },
        { a: B, b: C, gate: G(1, 50) }, // 最低分 → 最后处理 → 此刻两簇已存在
    ];
    const { clusters, notices } = buildStarClusters(edges, { decider: dec(new Set()) });
    assert.equal(clusters.length, 2);
    assert.ok(notices.some((n) => n.includes('跨簇不合并')), `缺跨簇上报：${notices}`);
});

test('中心升迁：通过全员回归才升迁（中心置换成更强成员）', () => {
    const A = mk('A', { textLen: 100 }), B = mk('B'), C = mk('C', { textLen: 999 });
    const edges = [
        { a: A, b: B, gate: G(1, 99) },
        { a: A, b: C, gate: G(1, 99) },
    ];
    const { clusters } = buildStarClusters(edges, { decider: dec(new Set(['A|B', 'A|C', 'B|C'])) });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 3);
    assert.equal(clusters[0].center.id, 'C', '更长的 C 应升迁为中心');
});

test('中心升迁被拒：任一成员回归不通过 → 保持原中心并**上报**', () => {
    const A = mk('A', { textLen: 100 }), B = mk('B'), C = mk('C', { textLen: 999 });
    const edges = [
        { a: A, b: B, gate: G(1, 99) },
        { a: A, b: C, gate: G(1, 99) },
    ];
    // C 与 B 不通过（缺 'B|C'）
    const { clusters, notices } = buildStarClusters(edges, { decider: dec(new Set(['A|B', 'A|C'])) });
    assert.equal(clusters[0].center.id, 'A');
    assert.ok(notices.some((n) => n.includes('升迁未通过全员回归')), `缺上报：${notices}`);
});

test('未并入上报：新成员与中心不通过 → 不放行且上报', () => {
    const A = mk('A'), B = mk('B'), C = mk('C');
    const edges = [
        { a: A, b: B, gate: G(1, 99) },
        { a: A, b: C, gate: G(1, 80) }, // C 需与中心重算，缺 'A|C'
    ];
    const { clusters, notices } = buildStarClusters(edges, { decider: dec(new Set(['A|B'])) });
    assert.equal(clusters[0].members.length, 2);
    assert.ok(notices.some((n) => n.includes('未并入')), `缺上报：${notices}`);
});

test('minScore 实时更新（字段名不撒谎）', () => {
    const A = mk('A'), B = mk('B'), C = mk('C', { textLen: 999 });
    const edges = [
        { a: A, b: B, gate: G(1, 99) },
        { a: A, b: C, gate: G(1, 99) },
    ];
    const { clusters } = buildStarClusters(edges, { decider: dec(new Set(['A|B', 'A|C', 'B|C'])) });
    assert.equal(clusters[0].minScore, 90, 'decider 返回 90 → minScore 应为 90');
    assert.equal(clusters[0].simPct, 99);
});

test('确定性：边序打乱不改变输出（同一输入集合）', () => {
    const A = mk('A'), B = mk('B'), C = mk('C');
    const edges1 = [
        { a: A, b: B, gate: G(1, 90) },
        { a: B, b: C, gate: G(1, 95) },
    ];
    const edges2 = [
        { a: B, b: C, gate: G(1, 95) },
        { a: A, b: B, gate: G(1, 90) },
    ];
    const p = new Set(['A|B', 'B|C']);
    const r1 = buildStarClusters(edges1, { decider: dec(p) });
    const r2 = buildStarClusters(edges2, { decider: dec(p) });
    assert.deepEqual(
        r1.clusters.map((c) => c.members.map((m) => m.id).sort()),
        r2.clusters.map((c) => c.members.map((m) => m.id).sort()),
    );
});

test('同名家族通道：精确同名未入组者 → 家族组（仅展示）', () => {
    const items = [
        mk('双子', { id: 't1', path: '/p/t1' }),
        mk('双子', { id: 't2', path: '/p/t2' }),
        mk('独行', { id: 't3' }),
        mk('', { id: 't4' }),
    ];
    const groups = buildNameOnlyGroups(items);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].nameOnly, true);
    assert.equal(groups[0].members.length, 2);
    assert.equal(groups[0].center.id, groups[0].members[0].id);
});
