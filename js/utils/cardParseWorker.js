/**
 * 🚀 v2.3 Web Worker：角色卡批量解析（CPU 多线程）
 * 把「JSON.parse + 血统鉴定 + 数据规范化」从渲染主线程搬到 Worker 线程，
 * 与主线程的「自动分类/打标/组装」流水线并行，真实万卡大库解析 CPU 分核提速。
 *
 * 只做纯函数解析（无 Vue/无 IPC/无外部状态）：
 *   输入  { items: [{ path, rawText?, embeddedData? }] }
 *   输出  { results: [{ path, ok, data?(规范化后 V2), reason? }] }
 *   - rawText（JSON 卡）：Worker 内 JSON.parse
 *   - embeddedData（PNG 卡）：已由主进程提取，直接复用
 *   - WebP / 需 readBuffer 兜底的卡不进 Worker（回退主线程原路径）
 *
 * 主线程拿到 results 后仍执行 processAutoTagsAndCategory（依赖外部状态，
 * 留在主线程）→ 组装 cardInfo → 流式入库。
 */
import { isCharacterCardData, normalizeCardData } from './cardLoader.js';

self.onmessage = (e) => {
    const { items = [] } = e.data || {};
    const results = [];
    for (const item of items) {
        try {
            let parsed = null;
            if (item.rawText != null) {
                parsed = JSON.parse(item.rawText);
            } else if (item.embeddedData && typeof item.embeddedData === 'object') {
                parsed = item.embeddedData;
            }
            if (!parsed || !isCharacterCardData(parsed)) {
                results.push({ path: item.path, ok: false, reason: 'not-card' });
                continue;
            }
            // noClone=true：parsed 是 Worker 私有对象，用完即弃，原地规范化省深拷贝
            const normalized = normalizeCardData(parsed, true);
            results.push({ path: item.path, ok: true, data: normalized });
        } catch (err) {
            results.push({ path: item.path, ok: false, reason: err && err.message || String(err) });
        }
    }
    self.postMessage({ results });
};
