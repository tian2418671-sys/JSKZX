/**
 * 🧹 查重批量清理 · 判定层（纯函数）
 * ═══════════════════════════════════════════════════════════════
 * 规格：`docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md`
 *
 * 职责：给定查重结果分组（`dedupeView.buildGroup` 产出）+ 用户勾选的规则，
 * 产出「删哪些文件 / 每组留谁 / 哪些组跳过及原因」的**计划**。
 *
 * 红线（改这里前先看方案 §三 / §九）：
 *   1. **本文件不碰 FS、不读 window/electronAPI** —— 只算计划，执行在 `useDedupe`；
 *   2. 「推荐版」= `cards[0]`（簇心）—— 与界面「👑 综合最优推荐」同源，**不许另造一套推荐**；
 *   3. `keepOne` 是硬闸门：任何策略、任何入参都不能把一组删空；
 *   4. 跳过的组必须带**可统计的原因码**，禁止静默丢弃。
 */

/** 保留策略（互斥单选；`center` = 簇心 = 界面推荐版） */
export const KEEP_STRATEGIES = Object.freeze(['center', 'tokens', 'newest', 'clean-name', 'size']);

/** 处理范围（多选；决定哪些类型的组进入删除清单） */
export const BATCH_SCOPES = Object.freeze(['exact', 'similar', 'nameonly']);

/** 跳过原因码（固定枚举，便于统计与测试） */
export const SKIP_REASONS = Object.freeze({
    EXCLUDED: '该组未勾选',
    OUT_OF_SCOPE: '范围未勾选',
    NOT_IN_LIBRARY: '不在库目录内',
    OPEN_CARD: '已打开卡片',
    TOO_FEW_MEMBERS: '成员不足（<2）',
    LIMIT_REACHED: '已达单次上限',
    BAD_GROUP: '分组数据异常',
});

export const DEFAULT_BATCH_OPTIONS = Object.freeze({
    keepBy: 'center',
    scopes: Object.freeze({ exact: true, similar: false, nameonly: false }),
    guards: Object.freeze({ skipOpen: true, skipOutside: true }),
    maxGroups: 500,
    maxFiles: 2000,
    excludeIds: Object.freeze([]),
});

/** 组归类：exact（L0 完全一致）/ similar（L1~L2 高度相似）/ nameonly（仅名称相同）/ bad */
export const classifyGroup = (group) => {
    if (!group || typeof group !== 'object') return 'bad';
    const members = group.cards || group.list;
    if (!Array.isArray(members) || members.length === 0) return 'bad';
    if (group._nameOnly || group.type === 'nameonly') return 'nameonly';
    if (group.type === 'duplicate') return 'exact';
    return 'similar';
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** `_dateStr` 兼容数字（ms）/ ISO / `YYYY-MM-DD HH:mm` 三种形态；解不出按 0（永不因此删掉"看不出时间"的那张） */
const timeOf = (member) => {
    const raw = member && member._dateStr;
    if (typeof raw === 'number') return raw;
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 0;
    const asNum = Number(s);
    if (Number.isFinite(asNum) && s.length >= 10) return asNum;
    const t = Date.parse(s.replace(/\//g, '-'));
    return Number.isFinite(t) ? t : 0;
};

const normPath = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 文件名"脏度"：后缀越像手工副本越脏（` (1)` / `_copy_数字` / `_移动_时间戳` / 裸时间戳） */
export const nameDirtScore = (path) => {
    const base = String(path == null ? '' : path).split(/[\\/]/).pop() || '';
    const stem = base.replace(/\.[^.]+$/, '');
    let score = 0;
    if (/\s*\(\d+\)$/.test(stem)) score += 3;          // 名字 (1)
    if (/_copy_\d+$/i.test(stem)) score += 3;           // xxx_copy_1789...
    if (/_移动_\d{10,}$/.test(stem)) score += 3;        // 移动冲突后缀
    if (/[_\-.]\d{10,}$/.test(stem)) score += 2;        // 裸时间戳
    if (/(副本|copy|备份|backup)$/i.test(stem)) score += 2;
    if (/[_\-.]v?\d+(\.\d+){1,}$/i.test(stem)) score += 1; // 版本号（轻）
    return score;
};

/** 越大越该保留（并列时 `center` 优先：严格大于才替换，故下标 0 天然占优） */
const scoreOf = (member, keepBy) => {
    if (!member) return -Infinity;
    switch (keepBy) {
        case 'tokens': return num(member._tokens);
        case 'newest': return timeOf(member);
        case 'size': return num(member._sizeKb);
        case 'clean-name': return 100 - nameDirtScore(member.path); // 脏度越低分越高
        default: return 0;
    }
};

/**
 * 选「每组保留哪一个」的下标。任何异常一律回退 0（= 簇心 = 界面推荐版）。
 * @param {object} group
 * @param {string} keepBy KEEP_STRATEGIES 之一
 * @returns {number} 0-based 成员下标
 */
export const pickKeepIndex = (group, keepBy = 'center') => {
    const members = (group && (group.cards || group.list)) || [];
    if (!Array.isArray(members) || members.length === 0) return 0;
    if (!KEEP_STRATEGIES.includes(keepBy) || keepBy === 'center') return 0;

    let best = 0;
    let bestScore = scoreOf(members[0], keepBy);
    for (let i = 1; i < members.length; i++) {
        const s = scoreOf(members[i], keepBy);
        if (s > bestScore) { best = i; bestScore = s; }
    }
    return best;
};

const pathOf = (member) => (member && member.path) || '';

/** 按上限切片（执行层分批调 IPC 用） */
export const chunkList = (list, size = 200) => {
    const n = Math.max(1, Number(size) || 200);
    const out = [];
    const arr = Array.isArray(list) ? list : [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
};

/**
 * 生成批量清理计划（只读：不改入参、不碰磁盘）
 * @param {Array} groups 查重结果分组（`cards[0]` 必须是推荐版）
 * @param {object} [options] 见 DEFAULT_BATCH_OPTIONS；额外可传
 *   · isOpenPath(path)=>boolean  是否正被编辑器打开（跳过整组）
 *   · libraryPath  库根（`skipOutside` 使用；传空则不做库内校验）
 * @returns {{at:number, options:object, deletions:Array, keepList:Array, skipGroups:Array, stats:object}}
 */
export const buildBatchPlan = (groups, options = {}) => {
    const opts = {
        ...DEFAULT_BATCH_OPTIONS,
        ...(options || {}),
        scopes: { ...DEFAULT_BATCH_OPTIONS.scopes, ...((options && options.scopes) || {}) },
        guards: { ...DEFAULT_BATCH_OPTIONS.guards, ...((options && options.guards) || {}) },
    };
    const list = Array.isArray(groups) ? groups : [];
    const excluded = new Set((Array.isArray(opts.excludeIds) ? opts.excludeIds : []).map((x) => String(x)));
    const libRoot = normPath(opts.libraryPath);
    const isOpenPath = typeof opts.isOpenPath === 'function' ? opts.isOpenPath : null;
    const maxGroups = Math.max(1, Number(opts.maxGroups) || DEFAULT_BATCH_OPTIONS.maxGroups);
    const maxFiles = Math.max(1, Number(opts.maxFiles) || DEFAULT_BATCH_OPTIONS.maxFiles);

    const deletions = [];
    const keepList = [];
    const skipGroups = [];
    const skipByReason = Object.create(null);
    const scopeGroups = { exact: 0, similar: 0, nameonly: 0 };
    const seenPaths = new Set();
    let bytes = 0;

    const skip = (group, index, reason) => {
        skipGroups.push({ groupIndex: index, groupId: (group && group.id) || `g${index}`, groupName: (group && group.name) || '', reason });
        skipByReason[reason] = (skipByReason[reason] || 0) + 1;
    };

    for (let gi = 0; gi < list.length; gi++) {
        const group = list[gi];
        const kind = classifyGroup(group);
        if (kind === 'bad') { skip(group, gi, SKIP_REASONS.BAD_GROUP); continue; }
        scopeGroups[kind]++;

        if (excluded.has(String(group.id)) || excluded.has(String(gi))) { skip(group, gi, SKIP_REASONS.EXCLUDED); continue; }
        if (!opts.scopes[kind]) { skip(group, gi, SKIP_REASONS.OUT_OF_SCOPE); continue; }

        const members = group.cards || group.list;
        if (members.length < 2) { skip(group, gi, SKIP_REASONS.TOO_FEW_MEMBERS); continue; }
        // 任一成员缺 path → 无法保证「删哪些 / 留哪些」准确，整组跳过（宁可不删）
        if (!members.every((m) => m && pathOf(m))) { skip(group, gi, SKIP_REASONS.BAD_GROUP); continue; }

        const keepIdx = pickKeepIndex(group, opts.keepBy);
        const keepMember = members[keepIdx] || members[0];
        const keepPath = pathOf(keepMember);
        if (!keepPath) { skip(group, gi, SKIP_REASONS.BAD_GROUP); continue; }

        const others = members.filter((m, i) => i !== keepIdx && m && pathOf(m));

        if (opts.guards.skipOpen && isOpenPath && others.some((m) => isOpenPath(pathOf(m)))) {
            skip(group, gi, SKIP_REASONS.OPEN_CARD); continue;
        }
        if (opts.guards.skipOutside && libRoot) {
            const outside = members.some((m) => {
                const p = pathOf(m);
                if (!p) return false;
                const np = normPath(p);
                return !(np === libRoot || np.startsWith(libRoot + '/'));
            });
            if (outside) { skip(group, gi, SKIP_REASONS.NOT_IN_LIBRARY); continue; }
        }
        if (keepList.length >= maxGroups || deletions.length + others.length > maxFiles) {
            skip(group, gi, SKIP_REASONS.LIMIT_REACHED); continue;
        }

        keepList.push({
            groupIndex: gi, groupId: group.id || `g${gi}`, groupName: group.name || '',
            keepIndex: keepIdx, keepPath, keepName: (keepMember && keepMember.name) || '',
            kind,
        });
        for (const m of others) {
            const p = pathOf(m);
            if (seenPaths.has(p)) continue; // 极端情况同一路径出现在两组：只算一次
            seenPaths.add(p);
            deletions.push({
                path: p,
                groupIndex: gi, groupId: group.id || `g${gi}`, groupName: group.name || '',
                cardName: m.name || '', keepPath, why: kind,
            });
            bytes += num(m._sizeKb) * 1024;
        }
    }

    return {
        at: Date.now(),
        options: { keepBy: opts.keepBy, scopes: opts.scopes, guards: opts.guards, maxGroups, maxFiles },
        deletions,
        keepList,
        skipGroups,
        stats: {
            groupsTotal: list.length,
            groupsPlanned: keepList.length,
            files: deletions.length,
            bytes,
            scopeGroups,
            skipByReason,
        },
    };
};
