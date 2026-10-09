/**
 * 🚀 启动自动任务 · 调度与执行（无 vue 依赖 ⇒ 可直接单测）
 *
 * 目标（规格 §一）：让「启动后要做的事」可配置、可关闭、不打扰：
 *   · **轻量体检**（autoAudit）：静默跑统计 → **一条**摘要 toast（点击打开质检弹窗）+ 日志；
 *   · **自动冷备**（autoBackup）：用已配置的冷备目录触发整库冷备（未配置 ⇒ 跳过并日志提示，不报错）；
 *   · **自动查重**（autoDedupe）：触发查重扫描（已在跑 ⇒ 跳过）。
 *
 * 纪律：
 *   · **启动竞态**：必须等「配置恢复完成 + 首个库扫描完成」双条件（规格 §五）——由 `deps.waitReady()` 提供；
 *   · **不在启动早期跑重任务**：调用方在 `onMounted` 尾部（蒙版淡出后）才 `schedule()`；
 *   · **每项 try/catch**：一项失败只记日志，不影响后续；
 *   · **不打扰**：所有结果合并为**一条** toast；noise 只进日志；
 *   · **防重入**：同一进程内只调度一次、运行中不重入。
 *
 * 规格：`docs/规格与计划/功能规格/启动自动任务-实现规格.md`
 */
import {
    normalizeStartupTasks, pickEnabledTasks, buildAuditSummary, buildRunLog,
    READY_TIMEOUT_MS
} from '../utils/startupPlan.js';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个启动任务调度器（**每个应用实例一个**）
 * @param {object} deps
 * @param {() => boolean} deps.waitReady 双条件：配置已恢复 && 首个库扫描已完成
 * @param {() => Promise<{tagStats:object, audit:object}>} [deps.computeAudit]
 * @param {() => Promise<{ok:boolean, fileCount?:number, bytes?:number, canceled?:boolean, error?:string}>} [deps.backupCreate]
 * @param {() => string} [deps.backupDir] 冷备目录（空 ⇒ 跳过 autoBackup）
 * @param {() => number} [deps.backupKeep]
 * @param {() => Promise<any>} [deps.startDedupe]
 * @param {() => boolean} [deps.isDedupeRunning]
 * @param {(msg:string, type?:string) => void} [deps.addLog]
 * @param {(msg:string, type?:string, duration?:number, onClick?:Function) => void} [deps.showToast]
 * @param {Function} [deps.openQualityCheck] toast 点击时打开质检弹窗
 */
export function createStartupScheduler(deps = {}) {
    let scheduled = false;
    let running = false;
    let timer = null;
    let canceled = false;

    const log = (m, t) => { try { if (typeof deps.addLog === 'function') deps.addLog(m, t || 'info'); } catch (e) { /* 忽略 */ } };

    /** 等「配置恢复 + 首扫完成」双条件（轮询，最多 READY_TIMEOUT_MS） */
    const waitReady = async (timeoutMs = READY_TIMEOUT_MS) => {
        if (typeof deps.waitReady !== 'function') return true;
        const t0 = nowMs();
        while (nowMs() - t0 < timeoutMs) {
            if (canceled) return false;
            try { if (deps.waitReady()) return true; } catch (e) { /* 条件函数异常当作未就绪 */ }
            await sleep(250);
        }
        return false;
    };

    /**
     * 静默跑一份体检统计（复用「一键质检」的纯函数 —— **不另写口径**）
     * @returns {Promise<{id:string,status:string,detail?:string}>}
     */
    const runAuditTask = async () => {
        if (typeof deps.computeAudit !== 'function') return { id: 'autoAudit', status: 'skip', detail: '未接线' };
        const r = await deps.computeAudit();
        const msg = buildAuditSummary(r && r.tagStats, r && r.audit);
        log(`🧪 ${msg.replace('（点击查看）', '')}`, 'info');
        if (typeof deps.showToast === 'function') {
            // 合并成**一条** toast；点击打开质检弹窗（不自动弹窗，避免打扰）
            deps.showToast(msg, 'info', 8000, typeof deps.openQualityCheck === 'function' ? () => deps.openQualityCheck() : undefined);
        }
        return { id: 'autoAudit', status: 'done', detail: `无标签 ${(r && r.tagStats && r.tagStats.untagged) || 0} 张` };
    };

    /**
     * 自动冷备（**外部副作用必须留痕**：时间 / 目标目录 / 结果 —— 规格 §五）
     */
    const runBackupTask = async () => {
        const dir = (typeof deps.backupDir === 'function') ? String(deps.backupDir() || '') : '';
        if (!dir) {
            log('🚀 启动自动冷备：跳过（尚未配置冷备目录 —— 维护菜单「📦 整库冷备…」里选一个）', 'warning');
            return { id: 'autoBackup', status: 'skip', detail: '未配置冷备目录' };
        }
        if (typeof deps.backupCreate !== 'function') return { id: 'autoBackup', status: 'skip', detail: '未接线' };
        const t0 = nowMs();
        const r = await deps.backupCreate();
        const sec = ((nowMs() - t0) / 1000).toFixed(1);
        if (r && r.ok) {
            log(`🚀 启动自动冷备完成：${r.fileCount} 个文件 → ${dir}（用时 ${sec}s）`, 'success');
            return { id: 'autoBackup', status: 'done', detail: `${r.fileCount} 文件/${sec}s` };
        }
        if (r && r.canceled) { log('🚀 启动自动冷备：已取消', 'warning'); return { id: 'autoBackup', status: 'skip', detail: '已取消' }; }
        log(`🚀 启动自动冷备失败：${(r && r.error) || '未知错误'}`, 'error');
        return { id: 'autoBackup', status: 'fail', detail: (r && r.error) || '未知错误' };
    };

    /** 自动查重（已在跑 ⇒ 跳过，避免与手动查重互斥打架） */
    const runDedupeTask = async () => {
        if (typeof deps.startDedupe !== 'function') return { id: 'autoDedupe', status: 'skip', detail: '未接线' };
        let busy = false;
        try { busy = !!(typeof deps.isDedupeRunning === 'function' && deps.isDedupeRunning()); } catch (e) { busy = false; }
        if (busy) { log('🚀 启动自动查重：跳过（查重已在运行）', 'warning'); return { id: 'autoDedupe', status: 'skip', detail: '已在运行' }; }
        await deps.startDedupe();
        log('🚀 启动自动查重：已发起', 'info');
        return { id: 'autoDedupe', status: 'done', detail: '已发起' };
    };

    const RUNNERS = { autoAudit: runAuditTask, autoBackup: runBackupTask, autoDedupe: runDedupeTask };

    /**
     * 立即执行所选任务（串行；单项失败不阻断）
     * @param {object} cfg 启动任务配置（未归一也可）
     * @returns {Promise<{ran:string[], statuses:Array, summary:string}>}
     */
    const runNow = async (cfg) => {
        if (running) return { ran: [], statuses: [], summary: '（已在运行）' };
        running = true;
        const t0 = nowMs();
        const ids = pickEnabledTasks(cfg);
        const statuses = [];
        try {
            for (const id of ids) {
                if (canceled) { statuses.push({ id, status: 'cancel', detail: '已取消' }); continue; }
                try {
                    statuses.push(await RUNNERS[id]());
                } catch (e) {
                    const detail = (e && e.message) || String(e);
                    log(`🚀 启动任务失败（${id}）：${detail}`, 'error');
                    statuses.push({ id, status: 'fail', detail });
                }
            }
            const summary = buildRunLog(statuses, nowMs() - t0);
            if (statuses.length) log(summary, statuses.some((s) => s.status === 'fail') ? 'warning' : 'info');
            return { ran: ids, statuses, summary };
        } finally {
            running = false;
        }
    };

    /**
     * 调度：等双条件 → 等 delayMs → 串行执行。**同一实例只调度一次**；总开关关 ⇒ 什么都不做（行为与旧版一致）
     * @param {object} cfg
     * @returns {{scheduled:boolean, reason?:string}}
     */
    const schedule = (cfg) => {
        const c = normalizeStartupTasks(cfg);
        const ids = pickEnabledTasks(c);
        if (!c.enabled || ids.length === 0) return { scheduled: false, reason: '未启用任何启动任务' };
        if (scheduled || running) return { scheduled: false, reason: '已调度过' };
        scheduled = true;
        canceled = false;
        // ⚠️ 全部延迟到「首屏稳定之后」：先等双条件，再等 delayMs（规格 §五「不在启动早期跑重任务」）
        (async () => {
            const ready = await waitReady();
            if (!ready) { log('🚀 启动任务：跳过（等待首屏就绪超时）', 'warning'); return; }
            await sleep(c.delayMs);
            if (canceled) return;
            log(`🚀 启动任务开始（延迟 ${c.delayMs}ms）：${ids.join('、')}`);
            await runNow(c);
        })();
        return { scheduled: true };
    };

    return {
        schedule,
        runNow,
        cancel: () => { canceled = true; if (timer) clearTimeout(timer); },
        isScheduled: () => scheduled,
        isRunning: () => running,
        waitReady
    };
}
