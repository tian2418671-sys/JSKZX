import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCard } from '../js/utils/dedupeContract.js';
import { evaluateGate } from '../js/utils/dedupeGates.js';

/**
 * v4 §12 —— **标注集回归**（外部有效性：负样本零误报是硬门槛）
 *
 * 数据：`test/fixtures/dedupe-labels.json`（12 对；全泛化虚拟样本，零真实案例名）。
 * 流程：真实数据 → `normalizeCard`（真实契约）→ `evaluateGate`（真实判定）→ 期望。
 */

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/dedupe-labels.json', import.meta.url), 'utf8'));

const mkData = (s) => {
    let desc = String(s.desc || '').repeat(s.descRepeat || 1);
    if (s.descPad) desc += s.descPad;
    const data = { description: desc };
    if (s.firstMes) data.first_mes = String(s.firstMes).repeat(s.firstMesRepeat || 1);
    if (Array.isArray(s.keys) && s.keys.length > 0) {
        data.character_book = { entries: [{ key: s.keys.slice(), content: s.entryContent || `词条：${s.keys.join('、')}` }] };
    }
    return data;
};

const mkItem = (s, side) => normalizeCard({
    path: `c:/labels/${s.name.replace(/[^\w\u4e00-\u9fff]/g, '_')}_${side}.png`,
    name: s.name,
    data: mkData(s),
});

test('标注集：12 对样本全部符合期望（同源通过 / 分歧拒绝）', () => {
    const pairs = FIXTURE.pairs;
    assert.ok(pairs.length >= 12, `标注集规模不足：${pairs.length}`);
    const sameCount = pairs.filter((p) => p.label === 'same').length;
    const diffCount = pairs.filter((p) => p.label === 'diff').length;
    assert.ok(sameCount >= 6 && diffCount >= 5, `标签分布异常：same=${sameCount} diff=${diffCount}`);

    const failures = [];
    for (const p of pairs) {
        const a = mkItem(p.a, 'a');
        const b = mkItem(p.b, 'b');
        assert.equal(a.degraded, null, `${p.id} a 侧归一化降级：${a.degraded}`);
        assert.equal(b.degraded, null, `${p.id} b 侧归一化降级：${b.degraded}`);
        const g = evaluateGate(a, b);
        if (p.label === 'same' && !g.pass) failures.push(`${p.id} 期望通过但被拒：${g.reason}（${p.note}）`);
        if (p.label === 'diff' && g.pass) failures.push(`${p.id} 期望拒绝但通过：L${g.level} ${g.simPct}%（${p.note}）`);
    }
    assert.deepEqual(failures, [], `标注集未通过：\n${failures.join('\n')}`);
});

test('标注集：负样本**零误报**（diff 对不得落入任何证据级）', () => {
    const diffs = FIXTURE.pairs.filter((p) => p.label === 'diff');
    const leaks = [];
    for (const p of diffs) {
        const g = evaluateGate(mkItem(p.a, 'a'), mkItem(p.b, 'b'));
        if (g.pass) leaks.push(`${p.id} → L${g.level} ${g.simPct}%`);
    }
    assert.deepEqual(leaks, [], `出现误报：${leaks.join('；')}`);
});

test('标注集：同源样本的证据级分布（记录性断言，防「全靠 L0」退化）', () => {
    const levels = new Map();
    for (const p of FIXTURE.pairs.filter((x) => x.label === 'same')) {
        const g = evaluateGate(mkItem(p.a, 'a'), mkItem(p.b, 'b'));
        const k = g.pass ? `L${g.level}` : 'reject';
        levels.set(k, (levels.get(k) || 0) + 1);
    }
    // L0/L1/L2 三级都要有真实样本覆盖（防止某级证据形同虚设）
    assert.ok((levels.get('L0') || 0) >= 2, `L0 样本不足：${JSON.stringify([...levels])}`);
    assert.ok((levels.get('L1') || 0) >= 2, `L1 样本不足：${JSON.stringify([...levels])}`);
    assert.ok((levels.get('L2') || 0) >= 1, `L2 样本不足：${JSON.stringify([...levels])}`);
    assert.ok(!levels.has('reject'), `同源样本被拒：${JSON.stringify([...levels])}`);
});
