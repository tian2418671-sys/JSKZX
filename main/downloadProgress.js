/**
 * 📥 下载进度读数（纯函数）
 *
 * 背景（2026-11-16 用户反馈）：下载阶段原本用 `resp.arrayBuffer()` 一次性读完，
 * 全程**零读数** —— 几十 MB 的包在慢网下要等一两分钟，界面只有一个不动的进度条，
 * 用户以为卡死。改为流式写入 + **数值百分比读数**，例如：
 *
 *     `37% · 13.6 MB / 36.7 MB · 1.1 MB/s`
 *
 * 注意：`percent` 到 100 只在**真正收完**时给出，避免「100% 却还在转」的假完成。
 */

const { formatBytes } = require('../js/utils/stInstallCore.js');

/** 默认推送节流间隔：250ms（既能看出在动，又不会把 IPC 打爆） */
const DEFAULT_TICK_MS = 250;

function toPositiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function headerGetter(headers) {
    return (name) => {
        if (!headers) return null;
        try {
            if (typeof headers.get === 'function') return headers.get(name);
            const key = Object.keys(headers).find((k) => String(k).toLowerCase() === name.toLowerCase());
            return key ? headers[key] : null;
        } catch (e) {
            return null;
        }
    };
}

/**
 * 从响应头读「总字节数」。总量未知（chunked / 镜像不透传长度）时返回 0。
 * @param {Headers|object|null} headers
 * @returns {number} 总字节数；0 表示未知
 */
function readTotalBytes(headers) {
    const get = headerGetter(headers);
    const len = toPositiveNumber(get('content-length'));
    if (len) return len;
    // content-range: bytes 0-1023/36700160 → 取斜杠后的总量
    const range = String(get('content-range') || '');
    const m = /\/(\d+)\s*$/.exec(range);
    return m ? toPositiveNumber(m[1]) : 0;
}

/**
 * 已下载字节 → 百分比读数（整数）。
 * @param {number} received
 * @param {number} total 0 表示总量未知
 * @returns {number} 0~100；总量未知返回 -1（UI 应改用「已下载 X MB」表述）
 */
function computePercent(received, total) {
    const r = toPositiveNumber(received);
    const t = toPositiveNumber(total);
    if (!t) return -1;
    if (!r) return 0;
    if (r >= t) return 100;
    return Math.max(0, Math.min(99, Math.floor((r / t) * 100)));
}

/** 实时速度（字节/秒）；时长不足 0.2 秒时返回 0，避免开头抖动出巨大数字 */
function computeSpeed(received, elapsedMs) {
    const ms = Number(elapsedMs);
    if (!Number.isFinite(ms) || ms < 200) return 0;
    return toPositiveNumber(received) / (ms / 1000);
}

/**
 * 生成给界面看的读数行。
 * @param {{received:number,total:number,elapsedMs:number}} p
 * @returns {{percent:number, text:string, detail:string}} percent 为 -1 表示总量未知
 */
function buildDownloadReadout({ received = 0, total = 0, elapsedMs = 0 } = {}) {
    const percent = computePercent(received, total);
    const speed = computeSpeed(received, elapsedMs);
    const speedText = speed > 0 ? ` · ${formatBytes(speed)}/s` : '';
    if (percent < 0) {
        const detail = `已下载 ${formatBytes(received)}${speedText}`;
        return { percent, text: detail, detail };
    }
    const detail = `${formatBytes(received)} / ${formatBytes(total)}${speedText}`;
    return { percent, text: `${percent}% · ${detail}`, detail };
}

/**
 * 节流判定：距上次推送是否已过 minIntervalMs。
 * @param {number} lastAt 上次推送时间戳（0 表示还没推过 → 立即推）
 * @param {number} now 当前时间戳
 * @param {number} [minIntervalMs]
 */
function shouldEmit(lastAt, now, minIntervalMs = DEFAULT_TICK_MS) {
    const gap = Math.max(0, Number(minIntervalMs) || 0);
    return !lastAt || Number(now) - Number(lastAt) >= gap;
}

/**
 * 把「阶段内百分比」映射到「整条进度条」的区间（如 下载 37% → 整体 10~45% 区间里的位置）。
 * @param {number} percent 阶段内百分比（-1 未知 → 返回区间起点）
 * @param {number} from 区间起点（含）
 * @param {number} to 区间终点（含）
 */
function mapToOverall(percent, from, to) {
    const a = Number(from) || 0;
    const b = Number(to) || 0;
    const p = Number(percent);
    if (!Number.isFinite(p) || p < 0) return a;
    const clamped = Math.max(0, Math.min(100, p));
    return Math.max(a, Math.min(b, a + Math.round(((b - a) * clamped) / 100)));
}

module.exports = {
    DEFAULT_TICK_MS,
    readTotalBytes,
    computePercent,
    computeSpeed,
    buildDownloadReadout,
    shouldEmit,
    mapToOverall,
};
