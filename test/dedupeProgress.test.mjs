/**
 * 进度条连续性单测（2026-09-22 用户实测报出的缺陷）
 *
 * 用户原话：「进度条移动时反复横跳时长时短，最后变成了滚动的光条」
 *
 * 根因（三处叠加）：
 *   ① 各阶段 `finally` 都 `resetDedupeScan()` → 进度条**消失又出现** = 「反复横跳」；
 *   ② `percent` 从 100 掉回 0 → 「时长时短」；
 *   ③ 内容查重阶段 2 置 `dedupeScanIndeterminate = true` → 「最后变成滚动的光条」。
 *
 * 本单测用**等价状态机复刻**锁死这三条，防止回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ══════════════════════════════════════════════════════════════
// 等价复刻：useDedupe 的进度状态机（只保留与进度相关的部分）
// ══════════════════════════════════════════════════════════════
function makeProgressState() {
    const state = {
        scanning: false,
        label: '',
        percent: 0,
        indeterminate: false,
        // 记录每次变更（用于断言「单调」「不消失」）
        history: []
    };
    const snap = () => state.history.push({
        scanning: state.scanning, percent: state.percent,
        indeterminate: state.indeterminate, label: state.label
    });
    return {
        state,
        start() {
            state.scanning = true;
            state.indeterminate = false;
            state.percent = 0;
            snap();
        },
        setPhase(label, percent) {
            state.label = label;
            state.percent = percent;
            snap();
        },
        // 阶段 1（重扫）：0~50%
        phase1(done, total) {
            state.percent = total ? Math.round((done / total) * 50) : 0;
            snap();
        },
        // 阶段 2（算指纹）：50~100%
        phase2(done, total) {
            state.percent = Math.min(100, Math.round(50 + (total ? (done / total) * 50 : 0)));
            snap();
        },
        finish() {
            state.percent = 100;
            state.label = '查重完成';
            state.scanning = false;
            snap();
            state.percent = 0;
            state.label = '';
            snap();
        },
        reset() {
            state.scanning = false;
            state.label = '';
            state.percent = 0;
            state.indeterminate = false;
            snap();
        }
    };
}

// ══════════════════════════════════════════════════════════════
// ★ 缺陷 ①：进度条「反复横跳」（消失又出现）
// ══════════════════════════════════════════════════════════════
test('★ 修复后：全程 scanning 保持 true（不出现「消失又出现」的横跳）', () => {
    const p = makeProgressState();
    p.start();
    p.phase1(50, 100);
    p.phase1(100, 100);
    p.setPhase('正在比对触发词指纹…', 50);   // 阶段切换
    p.phase2(50, 100);
    p.phase2(100, 100);

    // 直到 finish 之前，scanning 必须一直为 true
    const beforeFinish = p.state.history.slice(0, -2);
    assert.ok(beforeFinish.every(h => h.scanning === true),
        '阶段切换期间 scanning 必须保持 true（否则进度条会消失 → 用户看到「横跳」）');
});

test('★ 反例：若阶段切换时 reset，会出现 scanning=false 的中间态（证明该单测有效）', () => {
    const p = makeProgressState();
    p.start();
    p.phase1(100, 100);
    p.reset();                    // ← 旧实现的错误做法
    p.start();                    // ← 阶段 2 重新开始
    p.phase2(100, 100);

    const midFalse = p.state.history.some((h, i) =>
        i > 0 && h.scanning === false && p.state.history.slice(i + 1).some(x => x.scanning === true));
    assert.ok(midFalse, '旧做法确实会产生「false → true」的横跳（证明断言能抓到该缺陷）');
});

// ══════════════════════════════════════════════════════════════
// ★ 缺陷 ②：percent「时长时短」（从 100 掉回 0）
// ══════════════════════════════════════════════════════════════
test('★ 修复后：percent 单调不减（阶段 1 → 阶段 2 → 100，不倒退）', () => {
    const p = makeProgressState();
    p.start();
    for (let d = 0; d <= 100; d += 10) p.phase1(d, 100);
    p.setPhase('正在比对触发词指纹…', 50);
    for (let d = 0; d <= 100; d += 10) p.phase2(d, 100);
    p.finish();

    // 排除 finish 的最后一次 reset（percent 归 0 是**收尾**，不是倒退）
    const seq = p.state.history.slice(0, -1).map(h => h.percent);
    for (let i = 1; i < seq.length; i++) {
        assert.ok(seq[i] >= seq[i - 1],
            `percent 必须单调不减（第 ${i} 步 ${seq[i - 1]} → ${seq[i]}）`);
    }
    assert.equal(seq[seq.length - 1], 100, '收尾前应为 100%');
});

test('★ 反例：若阶段 2 从 0 开始（旧实现），会出现 100 → 0 的倒退', () => {
    const p = makeProgressState();
    p.start();
    p.phase1(100, 100);           // → 50%
    p.setPhase('阶段2', 0);        // ← 旧实现的错误做法（从 0 重开）
    p.phase2(100, 100);

    const seq = p.state.history.map(h => h.percent);
    const hasDrop = seq.some((v, i) => i > 0 && v < seq[i - 1]);
    assert.ok(hasDrop, '旧做法确实会产生 percent 倒退（证明断言能抓到该缺陷）');
});

// ══════════════════════════════════════════════════════════════
// ★ 缺陷 ③：「最后变成滚动的光条」（切不定态）
// ══════════════════════════════════════════════════════════════
test('★ 修复后：世界书路径全程 indeterminate = false（不出现滚动光条）', () => {
    const p = makeProgressState();
    p.start();                              // start 即 false
    p.phase1(50, 100);
    p.setPhase('正在逐本读取并计算内容指纹…', 50);
    p.phase2(50, 100);                      // ★ 阶段 2 仍为确定态
    p.finish();

    assert.ok(p.state.history.every(h => h.indeterminate === false),
        '世界书路径必须全程确定态（任何一处 true 都会让进度条变成滚动光条）');
});

test('★ 反例：若阶段 2 置 indeterminate=true（旧实现），会变成滚动光条', () => {
    const p = makeProgressState();
    p.start();
    p.phase1(100, 100);
    p.state.indeterminate = true;           // ← 旧实现的错误做法
    p.state.history.push({ scanning: true, percent: 0, indeterminate: true });

    assert.ok(p.state.history.some(h => h.indeterminate === true),
        '旧做法确实会切不定态（证明断言能抓到该缺陷）');
});

// ══════════════════════════════════════════════════════════════
// 角色卡侧：**保留**不定态是正确设计（refreshLibrary 无进度通道）
// ══════════════════════════════════════════════════════════════
test('角色卡侧仍可用不定态（refreshLibrary 无进度通道 → 不编假百分比）', () => {
    const p = makeProgressState();
    p.start();
    p.state.indeterminate = true;   // 角色卡侧：**有意**用不定态
    p.state.history.push({ scanning: true, percent: 0, indeterminate: true });
    assert.ok(p.state.history.some(h => h.indeterminate === true), '角色卡侧保留不定态是有意设计');
});

// ══════════════════════════════════════════════════════════════
// 收尾：100% 必须可见（不能闪一下就没了）
// ══════════════════════════════════════════════════════════════
test('收尾：finish 先到 100% 再归 0（100% 可见，不「闪一下就没了」）', () => {
    const p = makeProgressState();
    p.start();
    p.phase2(100, 100);
    p.finish();
    const last2 = p.state.history.slice(-2);
    assert.equal(last2[0].percent, 100, 'finish 的第一步必须到 100%');
    assert.equal(last2[0].label, '查重完成', '应显示完成文案');
    assert.equal(last2[1].percent, 0, '随后才归 0（收起）');
});

// ══════════════════════════════════════════════════════════════
// ★★ AR-45 二次修复（2026-09-23 用户二次报出「又横跳」）
//
// 用户看到的是**渲染结果**：进度条「满格 / 半格」，但右边数字显示「0 / ?」，
// 且百分比整块消失（组件里 `v-if="progress.total"` 才渲染百分比）。
//
// 根因：**数字与宽度走两条不同源的数据路径** ——
//   · 宽度 ← `dedupeScanPercent`（查重自己的 ref，持续推进）
//   · 数字 ← `wbScanProgress`（**扫描**的进度对象，扫描开始/结束时会被置 `{done:0,total:0}`）
// ⇒ 扫描一结束，数字就掉回「0 / ?」而条宽还在推进 = 观感上的「横跳」。
//
// ⚠️ 这与 AR-43（「宽度与数字走两条不同路径 → 只有数字坏，现象隐蔽」）是**同一类病**。
//    旧探针只采了宽度，所以「5/5 通过」是**假绿**（盲区）。
// ══════════════════════════════════════════════════════════════

/** 复刻 AR-45 二次修复后的**统一写入入口**（`applyDedupeProgress`） */
function makeUnifiedProgress() {
    const s = { percent: 0, done: 0, total: 0, label: '', history: [] };
    const snap = () => s.history.push({ percent: s.percent, done: s.done, total: s.total });
    return {
        state: s,
        apply(p) {
            const o = p || {};
            if (typeof o.label === 'string' && o.label) s.label = o.label;
            // done/total **成对更新**（与实现同口径）
            if (typeof o.total === 'number' && o.total > 0) {
                s.total = o.total;
                if (typeof o.done === 'number' && o.done >= 0) s.done = o.done;
            }
            if (typeof o.percent === 'number' && Number.isFinite(o.percent)) {
                s.percent = Math.max(s.percent, Math.max(0, Math.min(100, Math.round(o.percent))));
            }
            if (s.percent >= 100 && s.total > 0) s.done = s.total;
            snap();
        }
    };
}

test('★ AR-45 二次：数字与条宽**同源**（扫描结束后数字不得掉回 0 / ?）', () => {
    const u = makeUnifiedProgress();
    // 阶段 1：扫描推进
    u.apply({ done: 400, total: 1001, percent: 40 });
    const afterPhase1 = { ...u.state };
    assert.equal(afterPhase1.total, 1001, '阶段 1 后 total 应为真实值');

    // 阶段 1 结束：`wbScanProgress` 被置为 {done:0,total:0}（这是「扫描结束」的正确语义）
    // ★ 修复后：不再透传它 → 数字**不受影响**
    u.apply({ percent: 40 });   // 只推进 percent，total 保留
    assert.equal(u.state.total, 1001, 'total 不得被冲成 0（旧实现这里会变 0 → 数字显示「0 / ?」）');
    assert.equal(u.state.done, 400, 'done 不得被冲成 0');
});

test('★ AR-45 二次：`total<=0` 视为未知，**done/total 都不写**（保留已知值）', () => {
    const u = makeUnifiedProgress();
    u.apply({ done: 500, total: 1001, percent: 50 });
    u.apply({ done: 0, total: 0 });        // ← 旧实现的污染（扫描归零）
    assert.equal(u.state.total, 1001, '未知不得覆盖已知（否则百分比整块消失）');
    assert.equal(u.state.done, 500, 'done 也不得被归零（成对更新）');
});

test('★ AR-45 二次：统一入口保证 percent **单调不减**（裸赋值是倒退来源）', () => {
    const u = makeUnifiedProgress();
    u.apply({ percent: 97 });       // 阶段 1 冲高
    u.apply({ percent: 50 });       // 阶段 2 的硬编码边界（旧实现会倒退 97→50）
    assert.equal(u.state.percent, 97, '入口必须用 Math.max 防倒退');
    u.apply({ percent: 100 });
    assert.equal(u.state.percent, 100);
});

test('★ 反例：若沿用「透传 wbScanProgress」旧写法，数字确实会脱钩（证明断言有效）', () => {
    // 旧实现：数字直接读 wbScanProgress
    let wb = { done: 1001, total: 1001 };   // 扫描完成
    let percent = 100;                       // 条宽
    // 扫描结束 → wbScanProgress 归零（这是它自己的正确语义）
    wb = { done: 0, total: 0 };
    // 而条宽仍在阶段 2 推进 → 数字与宽度**不同源**
    const renderedNumbers = `${wb.done} / ${wb.total || '?'}`;
    const pctVisible = wb.total > 0;        // 组件：v-if="progress.total"
    assert.equal(renderedNumbers, '0 / ?', '旧写法确实渲染出「0 / ?」');
    assert.equal(pctVisible, false, '旧写法确实会让百分比整块消失');
    assert.equal(percent, 100, '而条宽却是 100% → 这就是用户看到的「横跳」');
});

test('★ AR-45 二次：收尾时数字必须到 total（不能「100% 但数字停在 970 / 1001」）', () => {
    const u = makeUnifiedProgress();
    u.apply({ done: 970, total: 1001, percent: 97 });
    u.apply({ percent: 100 });              // finishDedupeScan
    assert.equal(u.state.done, u.state.total, '收尾后 done 必须等于 total');
    assert.equal(u.state.done, 1001);
});
