/**
 * 差异行类型分布 —— **纯逻辑验证**（不起应用）（2026-09-23）
 *
 * 目的：判定 `_probe-diff-coloring.mjs` 的「emerald 未渲染」是
 *   「产品缺陷」还是「探针数据假设错」。
 *
 * 做法：直接调 `js/utils/textDiff.js`（与浏览器同一份源码）算出行类型分布。
 *   若数据里**本来就没有** `added` 行 → 探针数据假设错（不是缺陷）。
 *
 * 用法：node scripts/probes/_probe-diff-rowkinds.mjs
 */
import { diffContentForDisplay } from '../../js/utils/textDiff.js';

const L1 = '这是第一段内容，描述主角的背景设定。';
const L2 = '第二段：主角拥有一把传说中的剑，剑身刻着古老的符文。';
const L2B = '第二段：主角拥有一把传说中的剑，剑身刻着古老的符文，并散发着微弱的蓝光。';
const L3 = '第三段：主角的性格冷静而坚毅。';
const L_ONLY_OLD = '这一行只存在于旧版。';
const L_LAST = '最后一行。';

console.log('═════ 差异行类型分布（纯逻辑）═════');
console.log('');

/** 统计 diffContentForDisplay 的行类型 */
function kinds(a, b, label) {
    const r = diffContentForDisplay(a, b);
    console.log(`${label}：${JSON.stringify(r.stats)}`);
    return r.stats;
}

console.log('【探针数据】mk(1)：A = [L_LAST, L_ONLY_OLD]  vs  B = [L_LAST]');
console.log('  预期：A 多一行 → 该行是 removed（A 有 B 无）');
kinds([L_LAST, L_ONLY_OLD].join('\n'), [L_LAST].join('\n'), '  A→B');
console.log('');

console.log('【探针数据】mk(0)：A = [L1,L2,L3]  vs  B = [L1,L2B,L3]');
console.log('  预期：第 2 行 changed');
kinds([L1, L2, L3].join('\n'), [L1, L2B, L3].join('\n'), '  A→B');
console.log('');

console.log('🔍 **关键**：要出现 emerald（added），必须 **B 比 A 多行**：');
const s = kinds([L_LAST].join('\n'), [L_LAST, L_ONLY_OLD].join('\n'), '  A→B（B 多一行）');
console.log('');

console.log('───── 结论 ─────');
if (s && s.added > 0) {
    console.log('✅ 产品逻辑**正常**：B 多行时能正确产出 `added`（emerald）。');
    console.log('   ⇒ `_probe-diff-coloring.mjs` 的「emerald 未渲染」是**探针数据假设错**（它的 A/B 数据里 B 从不比 A 多行）—— **假失败**。');
} else {
    console.log('🔴 产品逻辑可能有问题：B 多行时未产出 `added`，需进一步排查。');
}
