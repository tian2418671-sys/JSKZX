/**
 * 🖼️ 视图适配层（v4 §9）—— 纯函数，四弹窗字段契约
 * ═══════════════════════════════════════════════════════════════
 * 消费 `dedupeCluster` 的分组，产出弹窗可直接渲染的视图对象。
 *
 * 契约要点（评审必查）：
 *   · 四弹窗 emit `resolve-group(gIdx, path)` / `open-diff(master, compare)`；
 *     推荐版固定在 **index 0**（弹窗以 `cards[0]`/`list[0]` 为推荐版）；
 *   · `_simType` 取值必须落在弹窗 `isRisky` 白名单内（`duplicate`/`high` 不降级；
 *     `different` 等 → 降级「请先人工核对」）——`ContentDedupeModal` 默认非完全一致一律 `different`（保守）；
 *   · `_simPct` = 与推荐版的最强证据百分比（展示与判定同源）。
 *
 * ⚠️ 零案例字面量；字段清单由 `VIEW_FIELDS` 导出（`test/dedupeViewContract.test.mjs` 守卫）。
 */
import { evaluateGate } from './dedupeGates.js';
import { hammingDistance64 } from './simhash64.mjs';
import { presetViewStats, pickPresetSimType, PRESET_TYPE_META } from './dedupePreset.js';

/** 各视图产出字段清单（守卫/测试用；新增字段必须同步此表） */
export const VIEW_FIELDS = Object.freeze({
    card: ['item', 'raw', 'data', 'path', 'name', 'avatar', 'customTags', '_name', '_tokens', '_dateStr', '_sizeKb', '_diffType', '_nameOnly', '_nameOnlyDist', '_desc'],
    wb: ['item', 'raw', 'data', 'path', 'name', '_entryCount', '_dateStr', '_sizeKb', '_nameOnly', '_diffInfo'],
    preset: ['item', 'raw', 'data', 'path', 'name', '_promptCount', '_dateStr', '_sizeKb', '_structPct', '_contentPct', '_enabledPct', '_pctAdvice', '_diffInfo', '_simLabel', '_simTone', '_simAdvice', '_simType', '_settings'],
    // 后 4 个为**可选增强字段**（弹窗 v-if 软引用：存在才显示；视图当前可不产出，P2 填充）
    content: ['_simPct', '_pctBadge', '_simType', '_hamming', '_lenPenalty', '_pctAdvice', '_keysSimPct', '_legacyPct', '_fullPct', '_score'],
});

const diffTypeOf = (g) => {
    if (g.level === 0) return '设定完全一致（内容指纹相同）';
    if (g.level === 1) return `触发词高度重合（${g.simPct}%）`;
    if (g.level === 2) return `内容高度相似（${g.simPct}%）`;
    return '待人工核对';
};

const cardMemberView = (m, cluster, g, opts) => {
    let tokens = typeof m.tokens === 'number' ? m.tokens : 0;
    if (!tokens) {
        try { tokens = typeof opts.estimateCardTokens === 'function' ? (opts.estimateCardTokens(m.raw) || 0) : 0; } catch (e) { tokens = 0; }
    }
    const nameOnly = !!cluster.nameOnly;
    return {
        item: m.raw, raw: m.raw, data: m.raw && m.raw.data,
        path: m.path, name: m.name,
        avatar: m.avatar || '',
        customTags: Array.isArray(m.tags) ? m.tags : [],
        _name: m.name,
        _tokens: tokens,
        _dateStr: m.dateStr || '', _sizeKb: m.sizeKb || 0,
        _diffType: nameOnly ? '⚠️ 仅名称相同（内容未达证据门槛）' : (g.ref ? '⭐ 参照版本（推荐保留）' : diffTypeOf(g)),
        _nameOnly: nameOnly,
        _nameOnlyDist: (nameOnly && m.coreSig && cluster.center.coreSig)
            ? hammingDistance64(m.coreSig, cluster.center.coreSig) : 0,
        _desc: m.desc || '',
    };
};

const wbMemberView = (m, cluster, g, opts) => {
    let entryCount = typeof m.entryCount === 'number' ? m.entryCount : 0;
    if (!entryCount) {
        try { entryCount = typeof opts.wbEntryCount === 'function' ? (opts.wbEntryCount(m.raw) || 0) : 0; } catch (e) { entryCount = 0; }
    }
    let displayName = '';
    try { displayName = typeof opts.wbDisplayName === 'function' ? (opts.wbDisplayName(m.raw) || '') : ''; } catch (e) { displayName = ''; }
    const nameOnly = !!cluster.nameOnly;
    const diffInfo = nameOnly ? '⚠️ 仅书名相同（触发词无交集）'
        : (g.ref ? '⭐ 参照版本（推荐保留）'
            : (g.level === 0 ? '🧬 内容哈希完全相同（SHA-256 一致）' : `🔑 触发词重合 ${g.simPct}%（L${g.level}）`));
    return {
        item: m.raw, raw: m.raw, data: m.raw && m.raw.data,
        path: m.path, name: displayName || m.name,
        _entryCount: entryCount,
        _dateStr: m.dateStr || '', _sizeKb: m.sizeKb || 0,
        _nameOnly: nameOnly,
        _diffInfo: diffInfo,
    };
};

const presetMemberView = (m, cluster, g, opts) => {
    const nameOnly = !!cluster.nameOnly;
    const isRef = !!g.ref;
    const center = cluster.center;
    // 三维统计（与参照版对比；纯函数见 dedupePreset.js）
    const stats = (isRef || nameOnly) ? { structPct: null, contentPct: null, enabledPct: null } : presetViewStats(center, m);
    // _simType 五枚举（§9.3；必须落在 PresetDedupeModal isRisky 白名单内）
    const simType = nameOnly ? 'different'
        : (isRef || g.level === 0) ? 'duplicate' : pickPresetSimType(center, m);
    const meta = PRESET_TYPE_META[simType] || PRESET_TYPE_META.different;
    const label = nameOnly ? '仅名称相同' : (isRef ? '参照版本' : (g.level === 0 ? '完全重复' : meta.label));
    const tone = nameOnly ? 'rose' : ((isRef || g.level === 0) ? 'emerald' : meta.tone);
    const advice = nameOnly ? '请先人工核对（勿直接清理）' : (isRef ? '推荐保留（参照版本）' : (g.level === 0 ? '可安全清理' : meta.advice));
    const statBadge = (isRef || nameOnly || g.level === 0) ? null
        : `结构 ${stats.structPct === null ? '—' : stats.structPct + '%'} / 内容 ${stats.contentPct === null ? '—' : stats.contentPct + '%'} / 启用 ${stats.enabledPct === null ? '—' : stats.enabledPct + '%'}`;
    return {
        item: m.raw, raw: m.raw, data: m.raw && m.raw.data,
        path: m.path, name: m.name,
        _promptCount: m.promptCount || 0,
        _dateStr: m.dateStr || '', _sizeKb: m.sizeKb || 0,
        _structPct: stats.structPct, _contentPct: g.level === 0 ? 100 : stats.contentPct, _enabledPct: stats.enabledPct,
        _pctAdvice: isRef ? '参照版本（推荐保留）' : (nameOnly ? null : (statBadge || `内容相似度 ${g.simPct}%`)),
        _diffInfo: nameOnly ? '⚠️ 仅名称相同' : (isRef ? '⭐ 参照版本（推荐保留）' : (g.level === 0 ? '🧬 预设内容完全相同' : `${meta.label} · ${g.simPct}%（L${g.level}）`)),
        _simLabel: label, _simTone: tone, _simAdvice: advice,
        _simType: simType,
        _settings: (center && center.sampler) ? center.sampler : null,
    };
};

const contentOverrides = (viewObj, cluster, g) => {
    const nameOnly = !!cluster.nameOnly;
    const isRef = !!g.ref;
    return {
        ...viewObj,
        _simPct: nameOnly ? 0 : g.simPct,
        _pctBadge: nameOnly ? '⚠️ 仅名称相同（内容未达证据门槛）'
            : (isRef ? '⭐ 参照版本（推荐保留）'
                : (g.level === 0 ? '✅ 内容完全一致（指纹相同）' : `⚠️ 高度相似（L${g.level} · ${g.simPct}%）`)),
        // ContentDedupeModal 白名单 = conflict/different；非完全一致一律 `different`（降级，保守）
        _simType: nameOnly || g.level > 0 ? 'different' : 'duplicate',
        _hamming: (nameOnly && viewObj._nameOnlyDist) ? viewObj._nameOnlyDist : 0,
        _lenPenalty: 1,
        _pctAdvice: isRef ? '参照版本（推荐保留）'
            : (nameOnly ? null : (g.level === 0 ? '可安全清理其它副本' : '请先对比差异，再决定是否清理')),
    };
};

/**
 * 由聚类结果构建弹窗组。
 * @param {'card'|'wb'|'preset'} kind
 * @param {object} cluster `dedupeCluster` 产出（含 nameOnly 标记）
 * @param {{estimateCardTokens?:Function, wbEntryCount?:Function, wbDisplayName?:Function, asContent?:boolean}} [opts]
 */
export const buildGroup = (kind, cluster, opts = {}) => {
    const isNameOnly = !!cluster.nameOnly;
    const gateOf = (m) => {
        if (m.id === cluster.center.id) return { pass: true, level: 0, simPct: 100, type: 'duplicate', ref: true };
        return evaluateGate(cluster.center, m);
    };
    const members = (cluster.center
        ? [cluster.center, ...cluster.members.filter((m) => m.id !== cluster.center.id)]
        : cluster.members).map((m) => {
        const g = isNameOnly ? { pass: false, level: null, simPct: 0 } : gateOf(m);
        let v;
        if (kind === 'card') v = cardMemberView(m, cluster, g, opts);
        else if (kind === 'wb') v = wbMemberView(m, cluster, g, opts);
        else v = presetMemberView(m, cluster, g, opts);
        if (opts.asContent) v = contentOverrides(v, cluster, g);
        return v;
    });

    const simPct = isNameOnly ? 0 : (cluster.simPct || 0);
    const type = isNameOnly ? 'nameonly' : (cluster.type || 'high');
    const advice = isNameOnly
        ? '仅名称相同（内容未达证据门槛）——建议人工核对，勿直接清理'
        : (type === 'duplicate' ? '内容完全一致，可安全清理其它副本' : `达到证据门槛（L${cluster.level}）——建议对比后清理`);
    return {
        id: cluster.id,
        name: cluster.center.name,
        type, advice,
        score: simPct, simPct,
        cards: members, list: members,
        _nameOnly: isNameOnly,
        minScore: isNameOnly ? 0 : (cluster.minScore != null ? cluster.minScore : simPct),
    };
};
