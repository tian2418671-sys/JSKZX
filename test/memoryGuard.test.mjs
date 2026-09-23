/**
 * 内存守门员单测（纯逻辑：阈值分档 + 阶梯动作 + 冷却防抖）
 * 副作用（读 performance.memory / 调 gc() / 释放缓存）全部注入，保证可重复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryGuard, gradeMemory, DEFAULT_THRESHOLDS, estimateParseBytes, preflightRead, PARSE_SIZE_FACTOR } from '../js/utils/memoryGuard.js';

const mb = (n) => n * 1048576;
const LIMIT = mb(6144);   // 抬高后的上限（main.js --max-old-space-size=6144）

// ═══════════════════════════════════════════════════════════════
// 🛡️ 读前预估（§5.3「预检」，2026-09-23 补）
// ───────────────────────────────────────────────────────────────
// 📖 病根：`checkNow` 是**读了之后**才知道爆 —— 遇超大书（如 200MB 合并书）已分配完，
//    只剩「崩」或「勉强撑住」，**没有拒绝的机会**（PK-27 是内核直接杀进程，连提示都没有）。
// ✅ 预检：分配前按「磁盘 size × 2.2」估算，超限就优雅拒绝并说明原因。
// ═══════════════════════════════════════════════════════════════

test('preflight: estimateParseBytes 按系数放大，缺 size 的单独计数', () => {
    assert.equal(PARSE_SIZE_FACTOR, 2.2);
    const r = estimateParseBytes([{ size: mb(10) }, { size: mb(20) }, { size: 0 }, {}]);
    assert.equal(r.count, 4);
    assert.equal(r.unknown, 2);                       // size=0 与缺 size
    assert.equal(r.bytes, Math.round(mb(30) * 2.2));  // 只算有效两个
    assert.equal(r.mb, Math.round(mb(30) * 2.2 / mb(1)));
    // 也接受纯数字数组
    assert.equal(estimateParseBytes([100, 200]).bytes, Math.round(300 * 2.2));
    assert.equal(estimateParseBytes(null).bytes, 0);
});

test('preflight: 单本超限 → 拒（读了必爆，且给出 oversized 清单）', () => {
    const r = preflightRead({
        files: [{ size: mb(200) }],                    // 200MB 合并书
        readMemory: () => ({ used: mb(1000), limit: LIMIT })
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'single-too-large');
    assert.equal(r.oversized.length, 1);
    assert.equal(r.oversized[0].size, mb(200));
});

test('preflight: 总量超「可用余量 × 0.7」→ 拒', () => {
    // 上限 4096MB、已用 1000MB → 余量 3096MB、预算 2167MB
    // 待读 2000MB × 2.2 = 4400MB > 2167MB → 拒
    const r = preflightRead({
        files: [{ size: mb(2000) }],
        readMemory: () => ({ used: mb(1000), limit: mb(4096) }),
        maxSingleBytes: mb(5000)                        // 放开单本限制，只测总量
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'batch-too-large');
    assert.equal(r.budgetMB, Math.floor(mb(3096) * 0.7 / mb(1)));
});

test('preflight: 正常批量 → 放行（余量充足）', () => {
    const r = preflightRead({
        files: Array.from({ length: 100 }, () => ({ size: mb(1) })),   // 100MB × 2.2 = 220MB
        readMemory: () => ({ used: mb(1000), limit: mb(4096) })
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
    assert.equal(r.degraded, false);
    assert.equal(r.est.mb, 220);
});

test('preflight: 拿不到 readMemory → 降级用假定上限，不抛错（不写死依赖 performance.memory）', () => {
    const r = preflightRead({
        files: [{ size: mb(1) }],
        readMemory: () => null,                          // 非 Chromium / 未开开关
        assumedLimitBytes: mb(4192)
    });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.equal(r.availMB, 4192);
});

test('preflight: 守门员 .preflight() 复用同一 readMemory 并计数', () => {
    const g = createMemoryGuard({
        readMemory: () => ({ used: mb(1000), total: mb(1200), limit: LIMIT }),
        releaseCaches: () => {},
        forceGc: () => {},
        intervalMs: 0
    });
    const ok = g.preflight([{ size: mb(1) }]);
    assert.equal(ok.ok, true);
    const bad = g.preflight([{ size: mb(200) }]);      // 单本超 50MB
    assert.equal(bad.ok, false);
    assert.equal(g.stats.preflights, 2);
    assert.equal(g.stats.preflightRejects, 1);
});

test('memoryGuard: gradeMemory 分档（unknown/ok/warn/critical）', () => {
    assert.equal(gradeMemory(null).level, 'unknown');
    assert.equal(gradeMemory({ used: 0, limit: 0 }).level, 'unknown');
    // 4.19GB 默认上限下的实测水位：3.05GB ≈ 73% → warn
    const old4g = gradeMemory({ used: mb(3050), limit: mb(4192) });
    assert.equal(old4g.level, 'warn');
    assert.equal(old4g.ratio.toFixed(2), '0.73');
    assert.equal(old4g.usedMB, 3050);
    // 同一绝对用量在抬高上限后应回落到 ok —— 这就是 P0 的直接价值
    assert.equal(gradeMemory({ used: mb(3050), limit: LIMIT }).level, 'ok');
    assert.equal(gradeMemory({ used: mb(5500), limit: LIMIT }).level, 'critical');
    assert.deepEqual(DEFAULT_THRESHOLDS, { warn: 0.72, critical: 0.88 });
});

test('memoryGuard: ok 档不做任何动作', () => {
    let releases = 0; let gcs = 0;
    const g = createMemoryGuard({
        readMemory: () => ({ used: mb(1000), total: mb(1200), limit: LIMIT }),
        releaseCaches: () => { releases++; },
        forceGc: () => { gcs++; }
    });
    const r = g.checkNow('test');
    assert.equal(r.level, 'ok');
    assert.equal(releases, 0);
    assert.equal(gcs, 0);
    assert.equal(g.stats.samples, 1);
});

test('memoryGuard: warn 档释放缓存 + 强制 GC，并回调（不打扰用户）', () => {
    let releases = 0; let gcs = 0; let warn = 0; let critical = 0;
    let used = mb(4600);   // 74.9% → warn
    const g = createMemoryGuard({
        readMemory: () => ({ used, total: used + mb(50), limit: LIMIT }),
        releaseCaches: () => { releases++; },
        forceGc: () => { gcs++; used = mb(3600); },   // 模拟 GC 回收 1GB
        onWarn: () => { warn++; },
        onCritical: () => { critical++; }
    });
    const r = g.checkNow('after-load');
    assert.equal(r.level, 'ok');            // 返回的是动作「之后」的水位
    assert.equal(releases, 1);
    assert.equal(gcs, 1);
    assert.equal(warn, 1);
    assert.equal(critical, 0);
    assert.equal(g.stats.last.reason, 'after-load');
});

test('memoryGuard: critical 档回调 onCritical 且带前后对比', () => {
    let payload = null;
    const g = createMemoryGuard({
        readMemory: () => ({ used: mb(5600), total: mb(5700), limit: LIMIT }),   // 91% → critical
        forceGc: () => {},
        releaseCaches: () => {},
        onCritical: (info) => { payload = info; }
    });
    g.checkNow('refresh');
    assert.ok(payload, 'onCritical 应被调用');
    assert.equal(payload.level, 'critical');
    assert.equal(payload.reason, 'refresh');
    assert.equal(payload.usedMB, 5600);
    assert.equal(payload.limitMB, 6144);
    assert.ok(payload.after && typeof payload.after.ratio === 'number');
});

test('memoryGuard: 冷却防抖 —— 同档位短时间内不重复释放/GC/提示', () => {
    let releases = 0; let gcs = 0; let warns = 0;
    const g = createMemoryGuard({
        readMemory: () => ({ used: mb(4600), total: mb(4700), limit: LIMIT }),
        releaseCaches: () => { releases++; },
        forceGc: () => { gcs++; },
        onWarn: () => { warns++; },
        cooldownMs: 60000
    });
    g.checkNow('a'); g.checkNow('b'); g.checkNow('c');
    assert.equal(releases, 1, '冷却期内只释放一次');
    assert.equal(gcs, 1);
    assert.equal(warns, 1);
    assert.equal(g.stats.samples, 3, '采样仍然每次都做');
});

test('memoryGuard: 采样失败（拿不到 performance.memory）不抛错、不动作', () => {
    let releases = 0;
    const g = createMemoryGuard({ readMemory: () => null, releaseCaches: () => { releases++; } });
    const r = g.checkNow('x');
    assert.equal(r.level, 'unknown');
    assert.equal(releases, 0);
});

test('memoryGuard: start/stop 定时采样（intervalMs=0 不启动）', async () => {
    let samples = 0;
    const g = createMemoryGuard({
        readMemory: () => ({ used: mb(100), total: mb(200), limit: LIMIT }),
        intervalMs: 20
    });
    g.start(); g.start();   // 重复 start 不应叠加多个定时器
    await new Promise((r) => setTimeout(r, 70));
    g.stop();
    const n = g.stats.samples;
    assert.ok(n >= 2 && n <= 5, `20ms 间隔 70ms 内应采样 2~5 次，实际 ${n}`);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(g.stats.samples, n, 'stop() 后不再采样');

    const g2 = createMemoryGuard({ readMemory: () => null, intervalMs: 0 });
    g2.start();
    assert.equal(g2.stats.samples, 0);
});

test('memoryGuard: 自定义阈值可覆盖（便于按机型/内存给不同策略）', () => {
    let warns = 0;
    const g = createMemoryGuard({
        readMemory: () => ({ used: mb(3000), total: mb(3100), limit: LIMIT }),   // 48.8%
        thresholds: { warn: 0.4, critical: 0.9 },
        forceGc: () => {}, releaseCaches: () => {},
        onWarn: () => { warns++; }
    });
    const r = g.checkNow('custom');
    assert.equal(r.level, 'warn', '48.8% 在 warn=0.4 阈值下应判定为 warn');
    assert.equal(g.stats.lastLevel, 'warn');
    assert.equal(warns, 1, '应触发一次 warn 动作');
    assert.deepEqual(g.thresholds, { warn: 0.4, critical: 0.9 });
});
