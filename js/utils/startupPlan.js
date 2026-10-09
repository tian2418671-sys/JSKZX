/**
 * 🚀 启动自动任务 · 计划层（纯函数 · 无依赖 · 可单测）
 *
 * 与 `useStartupTasks.js` 的分工：本文件只管「**读配置 / 解析开关 / 拼摘要文案**」，
 * 不碰定时器、不碰 IPC、不 import vue —— 便于单测（规格 §3.4 要求「调度逻辑纯函数化部分」可测）。
 *
 * 规格：`docs/规格与计划/功能规格/启动自动任务-实现规格.md`
 */

/** 三个可选启动任务（顺序即执行顺序） */
export const STARTUP_TASK_DEFS = [
    {
        id: 'autoAudit', title: '启动轻量体检', defaultOn: false,
        desc: '启动后静默跑一遍标签统计 + 卡片巡检（复用「一键质检」的纯函数），只给一条摘要，不弹窗',
        cost: '开销很小（真实库实测 < 0.5 秒）'
    },
    {
        id: 'autoBackup', title: '启动自动冷备', defaultOn: false,
        desc: '启动后触发一次整库冷备（用「📦 整库冷备」里配置的目录与保留份数）',
        cost: '⚠️ 需要先配置冷备目录；大库会占用磁盘与数十秒，且会写外部盘'
    },
    {
        id: 'autoDedupe', title: '启动自动查重', defaultOn: false,
        desc: '启动后发起一次查重扫描（按当前库分发到对应查重弹窗）',
        cost: '⚠️ 重操作：大库（万张级）耗时可达数十秒'
    }
];

export const DELAY_MIN = 1000;
export const DELAY_MAX = 10000;
export const DELAY_DEFAULT = 3000;
/** 等首屏稳定的上限（超过就放弃本次自动任务，只记日志） */
export const READY_TIMEOUT_MS = 60000;

const asBool = (v) => v === true;

/**
 * 配置归一（**脏值/老配置一律吃默认**：老配置没有 `startupTasks` 键 ⇒ 全关，行为与旧版一致）
 * @param {object|null|undefined} cfg
 * @returns {{enabled:boolean, autoAudit:boolean, autoBackup:boolean, autoDedupe:boolean, delayMs:number}}
 */
export function normalizeStartupTasks(cfg) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const n = Number(c.delayMs);
    const delayMs = Number.isFinite(n) ? Math.min(DELAY_MAX, Math.max(DELAY_MIN, Math.round(n))) : DELAY_DEFAULT;
    return {
        enabled: asBool(c.enabled),
        autoAudit: asBool(c.autoAudit),
        autoBackup: asBool(c.autoBackup),
        autoDedupe: asBool(c.autoDedupe),
        delayMs
    };
}

/**
 * 解析「本次真正要跑哪些任务」：总开关关 ⇒ 空数组（**默认全关即是这个分支**）
 * @param {object} cfg 已归一或未归一的配置
 * @returns {string[]} 任务 id 列表（按 STARTUP_TASK_DEFS 顺序）
 */
export function pickEnabledTasks(cfg) {
    const c = normalizeStartupTasks(cfg);
    if (!c.enabled) return [];
    return STARTUP_TASK_DEFS.map((d) => d.id).filter((id) => c[id] === true);
}

/** 体检摘要文案（**一条**，供 toast 与日志共用同一口径） */
export function buildAuditSummary(tagStats, auditResult) {
    const s = tagStats || {};
    const rules = (auditResult && Array.isArray(auditResult.rules)) ? auditResult.rules : [];
    const countOf = (id) => (rules.find((r) => r.id === id) || {}).count || 0;
    const over = countOf('token-over');
    const emptyDesc = countOf('desc-empty');
    const emptyFirst = countOf('first-mes-empty');
    const parts = [
        `无标签 ${Number(s.untagged) || 0} 张`,
        `覆盖 ${Number(s.coveragePct) || 0}%`,
        `疑似超长 ${over} 张`
    ];
    if (emptyDesc) parts.push(`空简介 ${emptyDesc} 张`);
    if (emptyFirst) parts.push(`空开场白 ${emptyFirst} 张`);
    return `启动体检：${parts.join(' · ')}（点击查看）`;
}

/** 汇总日志行（时间/任务/结果留痕；外部副作用必须可追溯 —— 规格 §五） */
export function buildRunLog(entries, elapsedMs) {
    const list = (entries || []).map((e) => `${e.id}:${e.status}${e.detail ? '(' + e.detail + ')' : ''}`);
    return `🚀 启动任务：${list.join('，') || '无'}（用时 ${(Number(elapsedMs) || 0) / 1000 < 0.1 ? '0.0' : ((Number(elapsedMs) || 0) / 1000).toFixed(1)}s）`;
}
