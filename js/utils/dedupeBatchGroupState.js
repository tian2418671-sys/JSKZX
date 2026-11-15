/**
 * 🧹 查重批量清理 · 组级勾选状态（纯函数，四个查重弹窗共用）
 * ═══════════════════════════════════════════════════════════════
 * 规格：`docs/规格与计划/查重引擎/查重-批量清理与规则化勾选-方案.md` §二 / P4
 *
 * 为什么是纯函数而不是 mixin：本项目 `guard:bindings` 要求模板用到的函数**必须在本文件里定义**，
 * mixin 提供的名字查不到（会被判为「点了没反应」）。所以状态机逻辑收敛到这里，
 * 四个弹窗各写 5 行薄包装（挂在 methods 上，守卫可见）。
 *
 * 红线：只算 UI 状态，不碰判定/删除（判定在 `dedupeBatch.js`，执行在 `useDedupe`）。
 */

/** 该组是否被用户取消勾选 */
export const isGroupExcluded = (excluded, index) => !!(excluded && excluded[index]);

/** 切换某组勾选状态（返回**新对象**，便于 Vue 响应式） */
export const toggleGroupExcluded = (excluded, index, checked) => {
    const next = { ...(excluded || {}) };
    if (checked) delete next[index];
    else next[index] = true;
    return next;
};

/**
 * 取消勾选的组 → `excludeIds`（**组 id + 下标双写**）
 * 重扫后下标会漂移，但组 id 稳定；两者都传，`buildBatchPlan` 命中任一即排除。
 */
export const collectExcludeIds = (excluded, groups) => {
    const ids = [];
    const list = Array.isArray(groups) ? groups : [];
    for (const key of Object.keys(excluded || {})) {
        const i = Number(key);
        const g = list[i];
        if (g && g.id) ids.push(g.id);
        ids.push(i);
    }
    return ids;
};
