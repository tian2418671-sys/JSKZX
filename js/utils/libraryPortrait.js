/**
 * 📊 结构画像（纯函数 · 可单测）—— 质检弹窗「[📊 结构画像]」页签的数据层
 *
 * 设计原则（上游裁决 Q1/Q2/Q11）：**只做取数与整形，不新增任何统计口径**。
 *   · 标签相关一律复用 `computeTagStats` 的产出（`tagCounts` / `topTags`）；
 *   · Token 一律用**注入的同一个** `estimateCardTokens`（与质检 S4 同源）；
 *   · 只做三件质检**没有**的事（这是本模块存在的唯一理由）：
 *       ① 标签 × 分组交叉矩阵   ② 标签池健康度（对照 `systemCommonTags`）   ③ Token 分位数
 *
 * ⚠️ 上游明确否决「活跃度时间线」（Q8）：本地文件 `mtime` 在批量重命名 / 移动分组 /
 *    备份恢复时会被成批刷新 ⇒ 出现完全虚假的尖峰。**本模块不得实现该区块。**
 *
 * ⚠️ 部分勾选防呆（上游补充 3）：依赖 `tagStats` 的区块在未勾选 S3 时必须 `readiness=false`
 *    由 UI 置灰并把「为什么没有」讲清楚 —— **绝不用 0 冒充真实值**（PK-31 / AI-17 同型坑）。
 *
 * 规格：`docs/规格与计划/功能规格/A-结构画像-实现规格.md`
 */
import { tagsOf, nameOf } from './tagStats.js';
import { AUTO_GROUP_ROOT_GROUP } from './autoGroup.js';

/** 分位数（线性插值；与「整数下标取最近邻」相比更平滑，且空数组返回 null 而非 NaN） */
export function percentile(sortedAsc, p) {
    const arr = Array.isArray(sortedAsc) ? sortedAsc : [];
    const n = arr.length;
    if (!n) return null;
    const pp = Math.min(1, Math.max(0, Number(p) || 0));
    if (n === 1) return arr[0];
    const pos = (n - 1) * pp;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

/** 取卡片的标签数组（唯一入口；口径同 computeTagStats） */
const tagsOfCard = (item) => tagsOf(item);

/** 取卡片所属分组（与 autoGroup 的「未分类」口径一致） */
const groupOfCard = (item) => {
    const g = item && (item.subFolder || item.category);
    return (typeof g === 'string' && g.trim()) ? g.trim() : AUTO_GROUP_ROOT_GROUP;
};

/**
 * ① 标签 × 分组交叉矩阵
 * @param {Array} library
 * @param {object} opts { maxTagRows=30, maxGroupCols=15 }
 */
function buildMatrix(library, opts = {}) {
    const maxTagRows = Math.max(1, Number(opts.maxTagRows) || 30);
    const maxGroupCols = Math.max(1, Number(opts.maxGroupCols) || 15);

    /** tag → Map<group, count> */
    const cellMap = new Map();
    /** group → 该组内出现的标签总次数（用于挑「最活跃的 15 个分组」） */
    const groupTotals = new Map();

    for (const item of library) {
        const tags = tagsOfCard(item);
        if (!tags.length) continue;
        const group = groupOfCard(item);
        const seen = new Set();   // 同一张卡的重复标签只算一次（与 computeTagStats 的「每卡去重后计数」一致）
        for (const t of tags) {
            if (seen.has(t)) continue;
            seen.add(t);
            let row = cellMap.get(t);
            if (!row) { row = new Map(); cellMap.set(t, row); }
            row.set(group, (row.get(group) || 0) + 1);
            groupTotals.set(group, (groupTotals.get(group) || 0) + 1);
        }
    }

    if (!cellMap.size) {
        return { rows: [], cols: [], truncatedTags: 0, truncatedGroups: 0, totalTags: 0, totalGroups: 0 };
    }

    // 行：按卡片数降序（与 computeTagStats 的 topTags 排序口径一致）
    const allTags = [...cellMap.entries()]
        .map(([tag, m]) => ({ tag, total: [...m.values()].reduce((a, b) => a + b, 0), map: m }))
        .sort((a, b) => (b.total - a.total) || a.tag.localeCompare(b.tag));

    // 列：按组内标签命中总数降序；「未分类」始终排最后（它是兜底桶，不是真实分组）
    const allGroups = [...groupTotals.entries()]
        .filter(([g]) => g !== AUTO_GROUP_ROOT_GROUP)
        .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
        .map(([name]) => name);
    if (groupTotals.has(AUTO_GROUP_ROOT_GROUP)) allGroups.push(AUTO_GROUP_ROOT_GROUP);

    const colTruncated = Math.max(0, allGroups.length - maxGroupCols);
    const cols = allGroups.slice(0, maxGroupCols).map((name) => ({ name, total: groupTotals.get(name) || 0 }));

    const rowTruncated = Math.max(0, allTags.length - maxTagRows);
    const rows = allTags.slice(0, maxTagRows).map(({ tag, total, map }) => ({
        tag,
        total,
        cells: cols.map((c) => map.get(c.name) || 0)
    }));

    return {
        rows,
        cols,
        truncatedTags: rowTruncated,
        truncatedGroups: colTruncated,
        totalTags: allTags.length,
        totalGroups: allGroups.length
    };
}

/**
 * ② 标签池健康度
 * @param {Map<string,number>|Array<[string,number]>|null} tagCounts  computeTagStats().tagCounts
 * @param {string[]} commonTags  systemCommonTags（用户可清空 ⇒ 必须区分「池为空」与「池全被用」）
 */
function buildPoolHealth(tagCounts, commonTags, topN = 50) {
    const pool = Array.isArray(commonTags)
        ? commonTags.map((t) => String(t == null ? '' : t).trim()).filter(Boolean)
        : [];
    const poolEmpty = pool.length === 0;

    let counts = new Map();
    if (tagCounts instanceof Map) counts = tagCounts;
    else if (Array.isArray(tagCounts)) counts = new Map(tagCounts);

    const poolSet = new Set(pool);
    const usedTags = [...counts.keys()].map((t) => String(t).trim()).filter(Boolean);

    // 池里有、但一张卡都没用
    const unusedInPool = pool.filter((t) => !counts.has(t));

    // 用了、但不在池里（按使用数降序）
    const usedNotInPool = usedTags
        .filter((t) => !poolSet.has(t))
        .map((tag) => ({ tag, count: Number(counts.get(tag)) || 0 }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
        .slice(0, Math.max(1, Number(topN) || 50));

    return {
        poolEmpty,
        poolSize: pool.length,
        usedTagKinds: usedTags.length,
        unusedInPool,          // 池内未使用（全量，池最多几十项）
        unusedInPoolCount: unusedInPool.length,
        usedNotInPool,         // 已使用但不在池内（截断到 topN，另给全量计数）
        usedNotInPoolCount: usedTags.filter((t) => !poolSet.has(t)).length
    };
}

/**
 * ③ Token 分位数
 * @param {Array} library
 * @param {Function} estimateCardTokens
 * @param {Array<number>|null} tokenSample  S4 已算好的 token 数组（有则复用，避免二次全量遍历）
 * @param {number} topHeavy
 */
function buildTokenStats(library, estimateCardTokens, tokenSample, topHeavy = 20) {
    const hasSample = Array.isArray(tokenSample) && tokenSample.length === library.length;

    /** @type {Array<{name:string,path:string,tokens:number}>} */
    let pairs = [];

    if (hasSample) {
        // 复用 S4 的结果：只需按卡取名字（不重算 token）
        pairs = library.map((item, i) => ({
            name: nameOf(item),
            path: String((item && item.path) || ''),
            tokens: Number(tokenSample[i]) || 0
        }));
    } else if (typeof estimateCardTokens === 'function') {
        pairs = library.map((item) => {
            let tokens = 0;
            try { tokens = Number(estimateCardTokens(item)) || 0; } catch (e) { tokens = 0; }
            return { name: nameOf(item), path: String((item && item.path) || ''), tokens };
        });
    } else {
        // 缺少估算函数 ⇒ 明确「不可用」，不返回 0 冒充
        return null;
    }

    if (!pairs.length) return null;

    const values = pairs.map((p) => p.tokens).sort((a, b) => a - b);
    const heaviest = [...pairs]
        .sort((a, b) => (b.tokens - a.tokens) || a.name.localeCompare(b.name))
        .slice(0, Math.max(1, Number(topHeavy) || 20));

    return {
        count: values.length,
        p50: percentile(values, 0.5),
        p90: percentile(values, 0.9),
        p99: percentile(values, 0.99),
        max: values[values.length - 1],
        min: values[0],
        total: values.reduce((a, b) => a + b, 0),
        heaviest,
        reusedFromS4: hasSample
    };
}

/**
 * 构建结构画像（纯函数 · 只读）
 * @param {Array} library 库条目
 * @param {object} deps
 * @param {object|null} deps.tagStats        S3 的 data（未勾选 S3 时传 null）
 * @param {string[]} deps.commonTags         systemCommonTags
 * @param {Function} [deps.estimateCardTokens]
 * @param {Array<number>|null} [deps.tokenSample]   S4 已算好的 token（有则复用）
 * @param {object} [opts] { maxTagRows, maxGroupCols, topHeavy, poolTopN }
 * @returns {{ matrix, poolHealth, tokenStats, readiness: { matrix, poolHealth, tokenStats } }}
 */
export function buildPortrait(library, deps = {}, opts = {}) {
    const list = Array.isArray(library) ? library : [];
    const tagStats = deps.tagStats || null;
    const commonTags = Array.isArray(deps.commonTags) ? deps.commonTags : [];

    // ①② 依赖 S3 的 tagStats —— 没有就置灰（不显示 0）
    //    ⚠️ `tagCounts` 可能以两种形态传来：`Map`（直接调 computeTagStats）或
    //       `Array<[tag,count]>`（经质检步骤序列化后的形态）。两种都必须接受，
    //       否则会出现「S3 明明跑完、画像却一直说『需要 S3』」的假空态（实测踩到）。
    const rawCounts = tagStats ? tagStats.tagCounts : null;
    const hasTagStats = !!(rawCounts && (rawCounts instanceof Map || Array.isArray(rawCounts)));
    const matrix = hasTagStats ? buildMatrix(list, { maxTagRows: opts.maxTagRows, maxGroupCols: opts.maxGroupCols }) : null;
    const poolHealth = hasTagStats ? buildPoolHealth(rawCounts, commonTags, opts.poolTopN) : null;

    // ③ Token 分位数：不依赖 S3；有 S4 样本就复用
    const tokenStats = buildTokenStats(list, deps.estimateCardTokens, deps.tokenSample, opts.topHeavy);

    return {
        matrix,
        poolHealth,
        tokenStats,
        readiness: {
            matrix: !!(matrix && matrix.rows.length),
            poolHealth: !!poolHealth,
            tokenStats: !!tokenStats
        }
    };
}

/**
 * 生成画像的 Markdown 摘要（供质检 `buildReport()` 末尾追加，上游 Q9）
 * @param {object} portrait buildPortrait 的返回值
 * @returns {string[]} 若干行（不含结尾空行）
 */
export function portraitReportLines(portrait) {
    const p = portrait || {};
    const lines = [];

    if (p.readiness && p.readiness.matrix && p.matrix) {
        lines.push('- 标签×分组矩阵（Top 组合）：');
        const flat = [];
        p.matrix.rows.forEach((r) => {
            r.cells.forEach((n, i) => {
                if (n > 0) flat.push({ tag: r.tag, group: p.matrix.cols[i].name, n });
            });
        });
        flat.sort((a, b) => b.n - a.n);
        for (const x of flat.slice(0, 8)) lines.push(`  - 「${x.tag}」@「${x.group}」：${x.n} 张`);
        if (p.matrix.truncatedTags || p.matrix.truncatedGroups) {
            lines.push(`  - （另有 ${p.matrix.truncatedTags} 个标签、${p.matrix.truncatedGroups} 个分组未展开）`);
        }
    }

    if (p.readiness && p.readiness.poolHealth && p.poolHealth) {
        const h = p.poolHealth;
        if (h.poolEmpty) {
            lines.push('- 标签池：**空**（曾被主动清空，本工具不会自动回填默认）');
        } else {
            lines.push(`- 标签池：共 ${h.poolSize} 个，其中**从未使用** ${h.unusedInPoolCount} 个；` +
                `实际用到但**不在池内** ${h.usedNotInPoolCount} 个`);
            if (h.usedNotInPool.length) {
                lines.push('  - 未入池高频：' + h.usedNotInPool.slice(0, 6).map((x) => `${x.tag}(${x.count})`).join('、'));
            }
        }
    }

    if (p.readiness && p.readiness.tokenStats && p.tokenStats) {
        const t = p.tokenStats;
        const r1 = (v) => (v === null || v === undefined ? '—' : Math.round(v));
        lines.push(`- Token 分位数：P50 ${r1(t.p50)} ／ P90 ${r1(t.p90)} ／ P99 ${r1(t.p99)} ／ 最大 ${r1(t.max)}` +
            (t.reusedFromS4 ? '（复用「卡片质量巡检」的结果）' : ''));
        if (t.heaviest && t.heaviest.length) {
            lines.push('  - 最重：' + t.heaviest.slice(0, 5).map((x) => `${x.name}(${x.tokens})`).join('、'));
        }
    }

    return lines;
}
