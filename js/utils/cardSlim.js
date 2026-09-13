/**
 * 卡片瘦身（P1a）—— 让大库不再把「世界书词条正文」常驻内存
 * ═════════════════════════════════════════════════════════════════
 * 实测（2026-09-13，22,372 张卡 / 19.85GB 副本，隔离 profile，GC 后）：
 *   堆 2,891MB = 纯文本 1,459MB + 非文本 1,432MB；
 *   其中 **内嵌世界书词条正文 1,163MB（占全部文本 80%）**，共 429,144 条词条。
 *   而列表渲染 / 排序 / 搜索索引**都不需要**这些重字段：
 *     · 列表要：name / category / customTags / 原生 tags / token 数 / 有无世界书 / 截断描述
 *     · 索引要：构建时读一次正文（P2 之后刷新还能沿用 token，不再读）
 *     · 只有「打开某张卡」与少数显式操作（查重 / AI 打标 / 全局资产）才需要完整正文
 *
 * ⚠️ 两条铁律
 *   1. **只能在原对象上原地增删字段**，绝不能替换 `item.data` ——
 *      全项目约 40 处 `library.value.find(item => item.data === cardData.value)`
 *      （高亮当前卡 / 标签 / 分组 / 快照 / 查重）都依赖这个对象身份。
 *   2. **顺序不能反**：必须等「扫描完成 → 搜索索引建完 → token 预热完」之后再压缩，
 *      否则索引没有正文可索引（P2 的跨代沿用就是为了让刷新不再依赖正文）。
 *
 * 调用方（App.vue）负责：跳过当前正在编辑的那张卡（keepDetail），避免用户未保存的编辑被丢。
 */

import { extractBookEntries } from './cardLoader.js'; // 🛡️ 脏形态（对象字典 / V1 数组）安全提取

/** 列表里展示用的描述截断长度 */
export const SLIM_DESC_LIMIT = 120;

/** 库小到没必要压缩（避免给小库引入无谓的复杂度） */
export const SLIM_MIN_LIBRARY = 3000;

/**
 * 压缩范围（★ 刻意只动这两类，不去动 description/first_mes 等）
 *
 * 为何不把整个正文都砍掉：`description` / `first_mes` 等字段被**列表之外**的功能广泛使用
 * （AI 打标拼 prompt、查重差异比对、Token 估算…），砍了会让这些功能“静默变差”。
 * 而实测世界书词条正文 + 附加问候语就占了全部文本的 **88%**（1,163MB + 120MB / 1,459MB），
 * 且只有两个「浏览全库世界书」的功能（全局资产库 / 全库词条搜索）需要它们
 * —— 那两个是用户显式打开的面板，改成打开时按需还原 + 关闭时重新压缩即可。
 */

/** 卡片的数据层：V2/V3 取 card.data，V1 扁平卡就是 card 本身 */
function dataLayerOf(card) {
    if (!card || typeof card !== 'object') return null;
    return (card.data && typeof card.data === 'object') ? card.data : card;
}

/** 该库条目是否已被压缩 */
export function isSlim(item) {
    return !!(item && item._slim);
}

/**
 * 原地压缩一张卡（保留列表/排序/索引所需的小字段）
 * @param {object} item 库条目（含 data / path / _tokens …）
 * @param {{keepDetail?: boolean}} [opts] keepDetail=true 时不做任何事（当前打开的卡）
 * @returns {boolean} 是否发生了压缩
 */
export function slimCard(item, { keepDetail = false } = {}) {
    if (!item || typeof item !== 'object') return false;
    if (keepDetail || isSlim(item)) return false;
    const card = item.data;
    const d = dataLayerOf(card);
    if (!card || !d) return false;

    // ① 列表要用的摘要：截断描述 + 世界书规模（压缩后就地留存）
    item._descShort = String(d.description == null ? '' : d.description).slice(0, SLIM_DESC_LIMIT);
    const book = d.character_book || card.character_book || null;
    const entries = extractBookEntries(book);          // 🛡️ 脏形态安全（对象字典/数组/空）
    item._hasBook = entries.length > 0;
    item._bookCount = entries.length;

    // ② 丢弃重字段：**只动世界书词条正文 + 附加问候语**（占全部文本 88%）
    //    词条对象本身保留（keys/enabled/constant/position 都要给列表和注入用）
    let freed = 0;
    for (const e of entries) {
        if (e && typeof e === 'object' && typeof e.content === 'string' && e.content.length) {
            freed += e.content.length;
            e.content = '';
        }
    }
    if (card !== d && card.character_book && typeof card.character_book === 'object') {
        for (const e of extractBookEntries(card.character_book)) {
            if (e && typeof e === 'object' && typeof e.content === 'string' && e.content.length) {
                freed += e.content.length;
                e.content = '';
            }
        }
    }
    const ag = d.alternate_greetings || (card !== d ? card.alternate_greetings : null);
    if (Array.isArray(ag) && ag.length) {
        for (const g of ag) if (typeof g === 'string') freed += g.length;
        d.alternate_greetings = undefined;
        if (card !== d) card.alternate_greetings = undefined;
    }
    if (!freed) return false;                          // 没东西可放就不标名（避免无意义状态）
    item._slim = true;
    return true;
}

/**
 * 把压缩过的卡还原成完整数据（按 path 重新读文件 → **原地填充** item.data）
 * @param {object} item 库条目
 * @param {(path:string) => Promise<object|null>} loader 由调用方注入（App.vue 用 electronAPI 读 PNG/JSON）
 * @returns {Promise<boolean>} true=已完整（含本来就完整的）
 */
export async function ensureCardFull(item, loader) {
    if (!item || typeof item !== 'object') return false;
    if (!isSlim(item)) return true;                      // 本来就完整，零成本
    if (typeof loader !== 'function' || !item.path) return false;
    let full = null;
    try {
        full = await loader(item.path);
    } catch (e) {
        full = null;
    }
    if (!full || typeof full !== 'object') return false; // 读盘失败：保持压缩态（不破坏已有小字段）

    const target = item.data;
    const td = dataLayerOf(target);
    const sd = dataLayerOf(full);
    // 只补「缺失」字段：不覆盖内存里可能更新的值（例如刚被 AI 工具改写过的字段）
    if (td && sd) {
        for (const k of Object.keys(sd)) {
            if (!(k in td)) td[k] = sd[k];
        }
    }
    if (target && full !== target) {
        for (const k of Object.keys(full)) {
            if (!(k in target)) target[k] = full[k];
        }
    }
    // ⚠️ 世界书词条正文是被「清空」而不是被删除（词条对象要留着给列表/注入用），
    //    所以“补缺失字段”补不回来 —— 必须按层逐个填回。优先按 comment/name 配对，
    //    配不上再回退到同下标（顺序未变时成立）。
    if (td && sd) {
        const tBook = td.character_book || (target && target.character_book);
        const sBook = sd.character_book || full.character_book;
        const tEntries = extractBookEntries(tBook);
        const sEntries = extractBookEntries(sBook);
        if (tEntries.length && sEntries.length) {
            const sig = (e) => String((e && (e.comment || e.name)) || '');
            for (let i = 0; i < tEntries.length; i++) {
                const t = tEntries[i];
                if (!t || typeof t !== 'object' || t.content) continue;
                let s = sEntries[i];
                const sigT = sig(t);
                if (sigT && (!s || sig(s) !== sigT)) {
                    const found = sEntries.find((x) => sig(x) === sigT);
                    if (found) s = found;
                }
                if (s && typeof s.content === 'string' && s.content) t.content = s.content;
            }
        }
    }
    // 附加问候语同理（被置为 undefined 而非删除）
    if (sd && Array.isArray(sd.alternate_greetings) && !(td && td.alternate_greetings)) {
        td.alternate_greetings = sd.alternate_greetings;
    }
    if (full !== target && Array.isArray(full.alternate_greetings) && !target.alternate_greetings) {
        target.alternate_greetings = full.alternate_greetings;
    }
    item._slim = false;
    return true;
}

/**
 * 批量还原（用户显式打开的「浏览全库」面板用：全局资产库 / 全库词条搜索）
 * ⚠️ 会一次性把全库正文拉回内存（22k 卡约 1.3GB）—— 只应在用户主动打开面板时调用，
 *    面板关闭后立即重新压缩（`slimLibraryIfNeeded`）把内存交回去。
 * @param {Array} items 库条目数组
 * @param {(path:string)=>Promise<object|null>} loader
 * @param {number} [concurrency] 并发（默认 8，与扫描期一致）
 * @returns {Promise<number>} 实际还原的卡数
 */
export async function ensureCardsFull(items, loader, concurrency = 8, onProgress = null) {
    const list = Array.isArray(items) ? items : [];
    const todo = list.filter((it) => isSlim(it));
    let done = 0;
    for (let i = 0; i < todo.length; i += concurrency) {
        const batch = todo.slice(i, i + concurrency);
        const results = await Promise.all(batch.map((it) => ensureCardFull(it, loader)));
        done += results.filter(Boolean).length;
        if (typeof onProgress === 'function') { try { onProgress(done, todo.length); } catch (e) { /* 忽略 */ } }
    }
    return done;
}

/**
 * 压缩状态统计（压测前后对比 / dev 探针用）
 * @param {Array} library
 */
export function slimStats(library) {
    const list = Array.isArray(library) ? library : [];
    let slim = 0;
    for (const item of list) if (isSlim(item)) slim++;
    return { total: list.length, slim, full: list.length - slim };
}

export default { slimCard, ensureCardFull, ensureCardsFull, isSlim, slimStats, SLIM_DESC_LIMIT, SLIM_MIN_LIBRARY };
