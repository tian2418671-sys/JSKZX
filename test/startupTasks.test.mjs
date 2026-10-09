/**
 * 🚀 启动自动任务 单测
 * 覆盖规格 §3.4/§四：配置归一（脏值/老配置）、开关解析、摘要文案、调度（双条件等待、串行、失败不阻断、防重入、全关即无行为）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeStartupTasks, pickEnabledTasks, buildAuditSummary, buildRunLog,
    STARTUP_TASK_DEFS, DELAY_MIN, DELAY_MAX, DELAY_DEFAULT
} from '../js/utils/startupPlan.js';
import { createStartupScheduler } from '../js/composables/useStartupTasks.js';

// ───────── 纯函数：配置归一 ─────────
test('★ normalizeStartupTasks：老配置（无 startupTasks 键）⇒ 全关，行为与旧版一致', () => {
    for (const v of [undefined, null, {}, 'x', 42]) {
        const c = normalizeStartupTasks(v);
        assert.deepEqual(c, { enabled: false, autoAudit: false, autoBackup: false, autoDedupe: false, delayMs: DELAY_DEFAULT });
    }
});

test('normalizeStartupTasks：真值才亮（非 true 一律关）+ 延迟夹取 1000~10000', () => {
    const on = normalizeStartupTasks({ enabled: true, autoAudit: true, autoBackup: 1, autoDedupe: 'yes', delayMs: 5000 });
    assert.equal(on.enabled, true);
    assert.equal(on.autoAudit, true);
    assert.equal(on.autoBackup, false, '非 true 不算开（1 / "yes" 都不算）');
    assert.equal(on.autoDedupe, false);
    assert.equal(on.delayMs, 5000);
    assert.equal(normalizeStartupTasks({ delayMs: 10 }).delayMs, DELAY_MIN);
    assert.equal(normalizeStartupTasks({ delayMs: 999999 }).delayMs, DELAY_MAX);
    assert.equal(normalizeStartupTasks({ delayMs: 'abc' }).delayMs, DELAY_DEFAULT);
    assert.equal(normalizeStartupTasks({ delayMs: 4321.6 }).delayMs, 4322, '取整');
});

test('★ pickEnabledTasks：总开关关 ⇒ 空数组；开 ⇒ 只挑亮的、顺序稳定', () => {
    assert.deepEqual(pickEnabledTasks({ autoAudit: true }), [], '总开关未开 ⇒ 一个都不跑');
    assert.deepEqual(pickEnabledTasks({ enabled: true }), []);
    assert.deepEqual(pickEnabledTasks({ enabled: true, autoDedupe: true, autoAudit: true }), ['autoAudit', 'autoDedupe'], '按定义顺序');
    assert.deepEqual(pickEnabledTasks({ enabled: true, autoAudit: true, autoBackup: true, autoDedupe: true }).length, 3);
    assert.equal(STARTUP_TASK_DEFS.length, 3);
    assert.equal(STARTUP_TASK_DEFS.every((d) => d.defaultOn === false), true, '三项默认全关');
});

// ───────── 纯函数：文案 ─────────
test('buildAuditSummary：一条摘要，含无标签/覆盖率/超长，空简介与空开场白仅在非零时出现', () => {
    const stats = { untagged: 23, coveragePct: 70.1 };
    const audit = { rules: [{ id: 'token-over', count: 60 }, { id: 'desc-empty', count: 0 }, { id: 'first-mes-empty', count: 5 }] };
    const m = buildAuditSummary(stats, audit);
    assert.equal(m, '启动体检：无标签 23 张 · 覆盖 70.1% · 疑似超长 60 张 · 空开场白 5 张（点击查看）');
    assert.equal(buildAuditSummary({}, null), '启动体检：无标签 0 张 · 覆盖 0% · 疑似超长 0 张（点击查看）', '缺数据也不崩');
});

test('buildRunLog：任务/状态/用时一行留痕', () => {
    const s = buildRunLog([{ id: 'autoAudit', status: 'done', detail: '无标签 23 张' }, { id: 'autoBackup', status: 'skip', detail: '未配置冷备目录' }], 1200);
    assert.match(s, /^🚀 启动任务：autoAudit:done\(无标签 23 张\)，autoBackup:skip\(未配置冷备目录\)（用时 1\.2s）$/);
    assert.match(buildRunLog([], 0), /无（用时 0\.0s）/);
});

// ───────── 调度器 ─────────
const mkDeps = (over = {}) => {
    const logs = [];
    const toasts = [];
    const calls = [];
    const deps = Object.assign({
        waitReady: () => true,
        computeAudit: async () => { calls.push('audit'); return { tagStats: { untagged: 3, coveragePct: 50 }, audit: { rules: [{ id: 'token-over', count: 1 }] } }; },
        backupCreate: async () => { calls.push('backup'); return { ok: true, fileCount: 9, bytes: 100 }; },
        backupDir: () => 'E:\\bk',
        backupKeep: () => 3,
        startDedupe: async () => { calls.push('dedupe'); },
        isDedupeRunning: () => false,
        addLog: (m, t) => logs.push({ m, t }),
        showToast: (m, t, d, cb) => toasts.push({ m, t, d, cb }),
        openQualityCheck: () => calls.push('openQC')
    }, over);
    return { deps, logs, toasts, calls };
};

test('★ 全关（默认）⇒ schedule 什么都不做、不产生任何日志/toast（冷启动行为与旧版一致）', async () => {
    const { deps, logs, toasts, calls } = mkDeps();
    const s = createStartupScheduler(deps);
    const r = s.schedule({ enabled: false, autoAudit: true, autoBackup: true, autoDedupe: true });
    assert.equal(r.scheduled, false);
    await new Promise((x) => setTimeout(x, 400));
    assert.equal(logs.length, 0, '不写日志');
    assert.equal(toasts.length, 0, '不弹 toast');
    assert.deepEqual(calls, [], '不调用任何任务');
});

test('★ 开 autoAudit：一条摘要 toast（可点击回调打开质检）+ 日志；不弹窗', async () => {
    const { deps, logs, toasts, calls } = mkDeps();
    const s = createStartupScheduler(deps);
    const r = await s.runNow({ enabled: true, autoAudit: true });
    assert.deepEqual(r.ran, ['autoAudit']);
    assert.equal(toasts.length, 1, '只合并成一条 toast');
    assert.match(toasts[0].m, /^启动体检：无标签 3 张 · 覆盖 50% · 疑似超长 1 张（点击查看）$/);
    assert.equal(typeof toasts[0].cb, 'function');
    toasts[0].cb();
    assert.deepEqual(calls, ['audit', 'openQC'], '点击才打开质检弹窗');
    assert.equal(logs.filter((x) => /启动体检/.test(x.m)).length, 1);
});

test('★ autoBackup：未配置目录 ⇒ 跳过 + 警告日志（不报错、不调用冷备通道）', async () => {
    const { deps, logs, calls } = mkDeps({ backupDir: () => '' });
    const s = createStartupScheduler(deps);
    const r = await s.runNow({ enabled: true, autoBackup: true });
    assert.equal(r.statuses[0].status, 'skip');
    assert.match(r.statuses[0].detail, /未配置冷备目录/);
    assert.equal(calls.includes('backup'), false, '未调用冷备');
    assert.equal(logs.some((x) => x.t === 'warning' && /跳过/.test(x.m)), true);
});

test('★ autoBackup：已配置 ⇒ 执行并留痕（结果含目标目录与文件数）', async () => {
    const { deps, logs, calls } = mkDeps();
    const s = createStartupScheduler(deps);
    const r = await s.runNow({ enabled: true, autoBackup: true });
    assert.equal(r.statuses[0].status, 'done');
    assert.deepEqual(calls, ['backup']);
    const hit = logs.find((x) => /启动自动冷备完成/.test(x.m));
    assert.ok(hit, '有完成日志');
    assert.match(hit.m, /E:\\bk/, '日志写明目标目录');
    assert.match(hit.m, /9 个文件/, '日志写明文件数');
});

test('★ autoDedupe：查重已在运行 ⇒ 跳过；否则发起', async () => {
    const a = mkDeps({ isDedupeRunning: () => true });
    const s1 = createStartupScheduler(a.deps);
    const r1 = await s1.runNow({ enabled: true, autoDedupe: true });
    assert.equal(r1.statuses[0].status, 'skip');
    assert.equal(a.calls.includes('dedupe'), false);

    const b = mkDeps();
    const s2 = createStartupScheduler(b.deps);
    const r2 = await s2.runNow({ enabled: true, autoDedupe: true });
    assert.equal(r2.statuses[0].status, 'done');
    assert.deepEqual(b.calls, ['dedupe']);
});

test('★ 失败不阻断：前一任务抛错 ⇒ 记日志 + fail 状态，后续任务照跑', async () => {
    const { deps, logs, calls } = mkDeps({
        computeAudit: async () => { calls.push('audit'); throw new Error('boom'); }
    });
    const s = createStartupScheduler(deps);
    const r = await s.runNow({ enabled: true, autoAudit: true, autoDedupe: true });
    assert.equal(r.statuses[0].status, 'fail');
    assert.match(r.statuses[0].detail, /boom/);
    assert.equal(r.statuses[1].status, 'done', '后续任务继续');
    assert.equal(calls.includes('dedupe'), true);
    assert.equal(logs.some((x) => x.t === 'error' && /boom/.test(x.m)), true);
});

test('★ 双条件等待：未就绪时会等（轮询），就绪后才跑；超时则放弃并记日志', async () => {
    let ready = false;
    const { deps, calls } = mkDeps({ waitReady: () => ready });
    const s = createStartupScheduler(deps);
    setTimeout(() => { ready = true; }, 300);
    const pr = s.schedule({ enabled: true, autoAudit: true, delayMs: 1000 });
    assert.equal(pr.scheduled, true);
    assert.deepEqual(calls, [], '还没就绪 + 延迟未到 ⇒ 未执行');
    await new Promise((x) => setTimeout(x, 1600));
    assert.deepEqual(calls, ['audit'], '就绪 + 延迟到 ⇒ 执行');

    // 超时分支（直接用 waitReady 的小超时验证轮询上限）
    const s2 = createStartupScheduler(mkDeps({ waitReady: () => false }).deps);
    const t0 = Date.now();
    assert.equal(await s2.waitReady(300), false);
    assert.ok(Date.now() - t0 >= 300, '确实等满超时');
});

test('★ 防重入：同一调度器只调度一次；运行中再调度被拒', async () => {
    const { deps } = mkDeps();
    const s = createStartupScheduler(deps);
    const r1 = s.schedule({ enabled: true, autoAudit: true, delayMs: 1000 });
    assert.equal(r1.scheduled, true);
    const r2 = s.schedule({ enabled: true, autoAudit: true, delayMs: 1000 });
    assert.equal(r2.scheduled, false);
    assert.equal(r2.reason, '已调度过');
    s.cancel();
});
