/**
 * 预设缝合中心（Composable）
 * 把 1~N 本源预设的提示词条目 + 手写自定义条目，缝合进「基座预设」，产出新预设 / 覆盖已有 / 写回当前。
 *
 * 🔴 核心不变量：prompts[] 与 prompt_order[] 必须双写。
 *    SillyTavern 实际按 prompt_order[0].order 里的 { identifier, enabled } 决定条目顺序与启用态；
 *    只搬 prompts 不重建 order → 条目顺序错乱 / 启用态不对（实测真实预设 prompts 118 条而 order 仅 107 条）。
 *
 * 状态（presets / activePreset / lastPresetDirPath / snippets）保留在 App.vue 并注入。
 * snippets = 常用条目库（持久化在 app_config.json 的 ui.presetStitchSnippets）。
 */
import { ref, computed } from 'vue';

// ST 内置条目的标准位次（「按内置序」落位策略用；不在表内的 identifier 视为用户条目 → 追加尾部）
const BUILTIN_ORDER = [
    'main', 'worldInfoBefore', 'worldInfoAfter', 'personaDescription',
    'charDescription', 'charPersonality', 'scenario', 'enhanceDefinitions',
    'nsfw', 'dialogueExamples', 'chatHistory', 'jailbreak', 'summary', 'SPresetSettings'
];

const REGEN_UID = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const NEW_IDENTIFIER = () => {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* 忽略 */ }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
};
const deepCopy = (obj) => JSON.parse(JSON.stringify(obj === undefined ? null : obj));

// 可从条目上"搬运/编辑"的字段（identifier 单独处理）
const ITEM_FIELDS = ['name', 'content', 'enabled', 'role', 'injection_position', 'injection_depth', 'injection_order', 'system_prompt', 'marker', 'forbid_overrides'];

export function usePresetStitch({
    presets, activePreset, lastPresetDirPath, appMode,
    nativeAlert, confirmDialog, addLog, appPrompt,
    snippets,           // ref: 常用条目库（App.vue 顶层持有，接入 app_config.json）
    syncConfigToDisk    // 统一持久化中枢
}) {

    // =========================================================
    // 状态
    // =========================================================
    const showPresetStitchModal = ref(false);
    const stitchTargetMode = ref('new');      // new | overwrite | current
    const stitchBasePath = ref('');           // new：基座预设 path
    const stitchOverwritePath = ref('');      // overwrite：目标预设 path
    const stitchNewName = ref('');
    const stitchSourcePaths = ref([]);        // 源预设 path[]
    const stitchPoolQuery = ref('');
    const stitchItems = ref([]);              // 工作台 staging（只在内存，不落盘）
    const stitchSelectedUid = ref('');        // 当前选中行（用于「设为锚点」）
    const stitchShowConflictOnly = ref(false);
    const stitchShowPlanDetail = ref(false);
    const stitchPlanChangedOnly = ref(false);   // 👁 预览面板：只看被缝合改动的条目
    const stitchBusy = ref(false);
    const stitchVersion = ref(0);             // 写回当前预设后自增，通知 EditorPanel 刷新

    const exitStitch = () => { showPresetStitchModal.value = false; };

    // =========================================================
    // 基座（缝合的底子：新预设继承它、覆盖模式就是目标、写回模式就是当前预设）
    // =========================================================
    const stitchBasePreset = computed(() => {
        if (stitchTargetMode.value === 'current') return activePreset.value || null;
        const p = stitchTargetMode.value === 'overwrite' ? stitchOverwritePath.value : stitchBasePath.value;
        return presets.value.find(x => x.path === p) || null;
    });

    const stitchBasePrompts = computed(() => {
        const b = stitchBasePreset.value;
        const list = b && b.data && Array.isArray(b.data.prompts) ? b.data.prompts : [];
        return list;
    });

    // 基座时间线（右栏：目标 order 序列，供锚点定位 + 冲突对照）
    const stitchBaseTimeline = computed(() => {
        const b = stitchBasePreset.value;
        if (!b) return [];
        const data = b.data || {};
        const prompts = Array.isArray(data.prompts) ? data.prompts : [];
        const byId = new Map(prompts.map(p => [p.identifier, p]));
        const o0 = Array.isArray(data.prompt_order) && data.prompt_order.length ? data.prompt_order[0] : null;
        const order = (o0 && Array.isArray(o0.order))
            ? o0.order
            : prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));
        return order.map((o, i) => {
            const p = byId.get(o.identifier);
            return {
                index: i,
                identifier: o.identifier,
                enabled: o.enabled !== false,
                name: (p && (p.name || p.identifier)) || o.identifier,
                isBuiltin: BUILTIN_ORDER.includes(o.identifier),
                len: p && typeof p.content === 'string' ? p.content.length : 0,
                missing: !p
            };
        });
    });

    const stitchBaseIdentifierSet = computed(() => new Set(stitchBaseTimeline.value.map(t => t.identifier)));

    // =========================================================
    // 源预设池
    // =========================================================
    const stitchSourceCandidates = computed(() => presets.value.filter(p => p.path));

    const toggleStitchSource = (p) => {
        const list = stitchSourcePaths.value;
        const i = list.indexOf(p.path);
        if (i >= 0) list.splice(i, 1);
        else list.push(p.path);
        stitchSourcePaths.value = [...list];
    };

    // 源预设下拉：全选 / 清空
    const selectAllStitchSources = () => {
        stitchSourcePaths.value = stitchSourceCandidates.value.map(p => p.path);
    };

    const clearStitchSources = () => { stitchSourcePaths.value = []; };

    // 源条目池（按来源预设分组 + 搜索过滤）
    const stitchPoolGroups = computed(() => {
        const q = stitchPoolQuery.value.trim().toLowerCase();
        return stitchSourcePaths.value.map(p => {
            const preset = presets.value.find(x => x.path === p);
            if (!preset) return null;
            const prompts = (preset.data && Array.isArray(preset.data.prompts)) ? preset.data.prompts : [];
            const indexed = prompts.map((pt, i) => ({ pt, i }));
            const list = q
                ? indexed.filter(({ pt }) =>
                    String(pt.name || '').toLowerCase().includes(q) ||
                    String(pt.identifier || '').toLowerCase().includes(q) ||
                    String(pt.content || '').toLowerCase().includes(q))
                : indexed;
            return {
                path: p,
                name: (preset.data && preset.data.name) || preset.name,
                total: prompts.length,
                shown: list.map(({ pt, i }) => ({ prompt: pt, srcIndex: i }))
            };
        }).filter(Boolean);
    });

    // =========================================================
    // 工作台（staging）
    // =========================================================
    const buildStageItem = (prompt, source, origin) => {
        const item = {
            uid: REGEN_UID(),
            origin,                                  // 'source' | 'custom'
            sourcePath: source.path || '',
            sourceName: source.name || (origin === 'custom' ? '✏️ 自定义' : ''),
            sourceIndex: source.index === undefined ? -1 : source.index,
            _expanded: origin === 'custom',
            conflict: null,
            decision: '',                            // '' = 未决策（有冲突时）/ 'source' = 新增
            place: 'append',                         // append | builtin | after | before
            anchorUid: '',
            selected: true
        };
        for (const f of ITEM_FIELDS) item[f] = prompt[f] !== undefined ? deepCopy(prompt[f]) : undefined;
        item.identifier = String(prompt.identifier || '');
        if (item.name === undefined) item.name = '';
        if (item.content === undefined) item.content = '';
        if (item.enabled === undefined) item.enabled = true;
        if (item.role === undefined) item.role = 'system';
        if (item.injection_position === undefined) item.injection_position = 0;
        if (item.injection_depth === undefined) item.injection_depth = 4;
        if (item.injection_order === undefined) item.injection_order = 100;
        return item;
    };

    // 从源条目池加入工作台（同源同 identifier 已存在则跳过，防重复）
    const addStitchItem = (prompt, group) => {
        const dup = stitchItems.value.find(it => it.origin === 'source' && it.sourcePath === group.path && it.identifier === prompt.identifier);
        if (dup) { nativeAlert(`该条目已在工作台：「${prompt.name || prompt.identifier}」`, 'info'); return false; }
        stitchItems.value.push(buildStageItem(prompt, { path: group.path, name: group.name, index: group.shown.findIndex(x => x.prompt === prompt) }, 'source'));
        refreshStitchConflicts();
        return true;
    };

    // 整个源预设一键全加
    const addAllFromPreset = (group) => {
        let n = 0;
        group.shown.forEach(({ prompt }) => {
            const dup = stitchItems.value.find(it => it.origin === 'source' && it.sourcePath === group.path && it.identifier === prompt.identifier);
            if (dup) return;
            stitchItems.value.push(buildStageItem(prompt, { path: group.path, name: group.name, index: -1 }, 'source'));
            n++;
        });
        refreshStitchConflicts();
        if (n) addLog(`🧵 已从《${group.name}》加入 ${n} 条到工作台`, 'info');
    };

    // ✏️ 新建自定义条目（identifier 自动 UUID，绝不误覆盖基座）
    const addCustomStitchItem = () => {
        const item = buildStageItem({
            identifier: NEW_IDENTIFIER(),
            name: '新自定义条目',
            content: '',
            enabled: true,
            role: 'system',
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100
        }, { path: '', name: '✏️ 自定义', index: -1 }, 'custom');
        item._expanded = true;
        stitchItems.value.push(item);
        stitchSelectedUid.value = item.uid;
        refreshStitchConflicts();
        return item;
    };

    const removeStitchItem = (uid) => {
        const i = stitchItems.value.findIndex(it => it.uid === uid);
        if (i >= 0) stitchItems.value.splice(i, 1);
        if (stitchSelectedUid.value === uid) stitchSelectedUid.value = '';
        refreshStitchConflicts();
    };

    const clearStitchItems = () => {
        if (!stitchItems.value.length) return;
        stitchItems.value = [];
        stitchSelectedUid.value = '';
    };

    const moveStitchItem = (uid, dir) => {
        const i = stitchItems.value.findIndex(it => it.uid === uid);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= stitchItems.value.length) return;
        const arr = stitchItems.value;
        const [it] = arr.splice(i, 1);
        arr.splice(j, 0, it);
    };

    // =========================================================
    // 冲突检测（基座同名 / 工作台内部同名）
    // =========================================================
    const refreshStitchConflicts = () => {
        const baseIds = new Map(stitchBaseTimeline.value.map(t => [t.identifier, t]));
        const peer = new Map();
        for (const it of stitchItems.value) {
            const key = it.identifier || `name:${it.name}`;
            const base = baseIds.get(it.identifier);
            const prev = peer.get(key);
            if (base) {
                it.conflict = {
                    type: 'base',
                    withName: base.name,
                    baseEnabled: base.enabled,
                    baseLen: base.len,
                    builtin: base.isBuiltin
                };
            } else if (prev) {
                it.conflict = { type: 'peer', withName: prev.name || prev.identifier, baseLen: 0, builtin: false };
            } else {
                it.conflict = null;
            }
            // 决策初值：无冲突 → 直接新增；有冲突 → 留空强制人工决策
            if (it.conflict) { if (!it.decision) it.decision = ''; }
            else it.decision = 'source';
            if (!peer.has(key)) peer.set(key, it);
        }
        stitchVersion.value++;   // 顺带驱动干跑重算
    };

    const stitchConflictCount = computed(() => stitchItems.value.filter(it => it.conflict).length);
    const stitchPendingCount = computed(() => stitchItems.value.filter(it => it.selected && it.conflict && !it.decision).length);

    const visibleStitchItems = computed(() => stitchShowConflictOnly.value
        ? stitchItems.value.filter(it => it.conflict)
        : stitchItems.value);

    // 批量决策 / 批量落位
    const applyStitchDecision = (decision, onlyUid) => {
        const targets = onlyUid ? stitchItems.value.filter(it => it.uid === onlyUid) : stitchItems.value.filter(it => it.conflict);
        targets.forEach(it => { it.decision = decision; });
    };
    const applyStitchPlace = (place, anchorUid) => {
        const targets = stitchSelectedUid.value
            ? stitchItems.value.filter(it => it.uid === stitchSelectedUid.value)
            : stitchItems.value;
        targets.forEach(it => { it.place = place; if (anchorUid !== undefined) it.anchorUid = anchorUid; });
    };
    const setStitchAnchor = (anchorUid) => {
        if (!stitchSelectedUid.value) { nativeAlert('请先在工作台选中一条（点击行左侧圆圈/行体）再设锚点。', 'info'); return; }
        const it = stitchItems.value.find(x => x.uid === stitchSelectedUid.value);
        if (!it) return;
        it.anchorUid = anchorUid;
        if (it.place !== 'after' && it.place !== 'before') it.place = 'after';
        addLog(`📍 已将「${it.name || it.identifier}」锚定到该位置之后`, 'info');
    };
    const anchorLabel = (uid) => {
        if (!uid) return '未设置';
        if (uid.startsWith('b:')) {
            const t = stitchBaseTimeline.value.find(x => 'b:' + x.identifier === uid);
            return t ? `基座 · ${t.name}` : '基座条目';
        }
        const it = stitchItems.value.find(x => x.uid === uid);
        return it ? `工作台 · ${it.name || it.identifier}` : '未知';
    };

    // =========================================================
    // 🎯 干跑：重建 prompts[] + prompt_order[]（不写盘）
    // =========================================================
    const insertByBuiltinRank = (order, ordItem) => {
        const rank = BUILTIN_ORDER.indexOf(ordItem.identifier);
        if (rank === -1) { order.push(ordItem); return; }
        for (let i = 0; i < order.length; i++) {
            const r = BUILTIN_ORDER.indexOf(order[i].identifier);
            if (r !== -1 && r > rank) { order.splice(i, 0, ordItem); return; }
        }
        order.push(ordItem);
    };

    const stitchPlan = computed(() => {
        const base = stitchBasePreset.value;
        const stats = { added: 0, overwritten: 0, skipped: 0, renamed: 0, pending: 0, finalPrompts: 0, finalOrder: 0 };
        if (!base) return { ok: false, reason: '未选择基座预设（新建模式请选基座，覆盖模式请选目标）。', prompts: [], prompt_order: [], stats, orderPreview: [] };

        const baseData = base.data || {};
        const prompts = Array.isArray(baseData.prompts) ? deepCopy(baseData.prompts) : [];
        const o0 = Array.isArray(baseData.prompt_order) && baseData.prompt_order.length ? baseData.prompt_order[0] : null;
        const charId = (o0 && o0.character_id) || 100001;   // 沿用基座 character_id，兼容不同 ST 版本
        let order = (o0 && Array.isArray(o0.order))
            ? deepCopy(o0.order)
            : prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));

        const promptIdx = new Map(prompts.map((p, i) => [p.identifier, i]));
        const orderIdx = new Map(order.map((o, i) => [o.identifier, i]));
        const newOnes = [];        // 待新增：{ item, identifier, place, anchorUid }
        const newIdents = new Set();          // 本次新增的 identifier（预览面板标记用）
        const overwrittenIdents = new Set();  // 本次被覆盖的 identifier

        for (const it of stitchItems.value) {
            if (!it.selected) continue;
            if (it.conflict && !it.decision) { stats.pending++; continue; }
            const dec = it.decision || 'source';

            if (dec === 'skip' || dec === 'target') { stats.skipped++; continue; }

            if (dec === 'source' && it.conflict) {
                // 覆盖基座同 identifier：位置不动，只换内容与启用态（双写）
                const pi = promptIdx.get(it.identifier);
                if (pi === undefined) { newOnes.push({ item: it, identifier: it.identifier, place: it.place, anchorUid: it.anchorUid }); continue; }
                const target = prompts[pi];
                for (const f of ITEM_FIELDS) if (it[f] !== undefined) target[f] = deepCopy(it[f]);
                const oi = orderIdx.get(it.identifier);
                if (oi !== undefined) order[oi].enabled = it.enabled !== false;
                overwrittenIdents.add(it.identifier);
                stats.overwritten++;
                continue;
            }

            // 新增：来源新条目 / 自定义条目 / 重命名保留
            const ident = dec === 'rename' ? NEW_IDENTIFIER() : (it.identifier || NEW_IDENTIFIER());
            if (dec === 'rename') stats.renamed++;
            newOnes.push({ item: it, identifier: ident, place: it.place || 'append', anchorUid: it.anchorUid || '' });
        }

        // 落位：先 append/builtin（锚点可能引用它们的最终 identifier），后 after/before
        const resultIdent = new Map();   // uid → 最终 identifier
        const newIdentToItem = new Map(); // 最终 identifier → item（预览面板反查来源用）
        for (const n of newOnes) { resultIdent.set(n.item.uid, n.identifier); newIdentToItem.set(n.identifier, n.item); }
        const deferred = [];
        for (const n of newOnes) {
            const p = {};
            for (const f of ITEM_FIELDS) if (n.item[f] !== undefined) p[f] = deepCopy(n.item[f]);
            p.identifier = n.identifier;
            prompts.push(p);
            newIdents.add(n.identifier);
            const ordItem = { identifier: n.identifier, enabled: n.item.enabled !== false };
            if (n.place === 'append') order.push(ordItem);
            else if (n.place === 'builtin') insertByBuiltinRank(order, ordItem);
            else deferred.push({ n, ordItem });
            stats.added++;
        }
        // 锚点插入（两轮：先解析锚点 identifier，再插）
        for (const { n, ordItem } of deferred) {
            let anchorIdent = '';
            if (n.anchorUid && n.anchorUid.startsWith('b:')) anchorIdent = n.anchorUid.slice(2);
            else if (n.anchorUid) {
                const refItem = stitchItems.value.find(x => x.uid === n.anchorUid);
                anchorIdent = refItem ? (resultIdent.get(refItem.uid) || refItem.identifier) : '';
            }
            const ai = order.findIndex(o => o.identifier === anchorIdent);
            if (ai === -1) { order.push(ordItem); continue; }   // 锚点不在结果中 → 退化为追加
            order.splice(n.place === 'before' ? ai : ai + 1, 0, ordItem);
        }

        // order 去重 + 剔除已不存在的 identifier（保持 ST 可读性）
        const promptIdSet = new Set(prompts.map(p => p.identifier));
        const seenOrder = new Set();
        order = order.filter(o => {
            if (!o || !o.identifier) return false;
            if (seenOrder.has(o.identifier)) return false;
            seenOrder.add(o.identifier);
            return promptIdSet.has(o.identifier);
        });

        stats.finalPrompts = prompts.length;
        stats.finalOrder = order.length;
        return {
            ok: true,
            baseName: (baseData.name) || base.name,
            prompts,
            prompt_order: [{ character_id: charId, order }],
            stats,
            orderPreview: order.map((o, i) => {
                const p = prompts.find(x => x.identifier === o.identifier);
                // 优先用「本次新增映射」反查来源（rename 后 identifier 已变，直接按 identifier 找会找不到）
                const st = newIdentToItem.get(o.identifier) || stitchItems.value.find(it => it.identifier === o.identifier);
                const isNew = newIdents.has(o.identifier);
                const isOverwritten = overwrittenIdents.has(o.identifier);
                return {
                    i: i + 1,
                    identifier: o.identifier,
                    name: (p && p.name) || o.identifier,
                    enabled: o.enabled !== false,
                    from: st ? (st.origin === 'custom' ? '✏️ 自定义' : st.sourceName) : '基座',
                    isNew,
                    isOverwritten,
                    changed: isNew || isOverwritten,
                    contentLen: p && typeof p.content === 'string' ? p.content.length : 0
                };
            })
        };
    });

    const stitchSummaryText = computed(() => {
        const p = stitchPlan.value;
        if (!p.ok) return p.reason;
        const s = p.stats;
        return `新增 ${s.added} · 覆盖 ${s.overwritten} · 重命名 ${s.renamed} · 跳过 ${s.skipped}${s.pending ? ` · ⚠️ 待决策 ${s.pending}` : ''} → 结果 prompts ${s.finalPrompts} / order ${s.finalOrder}`;
    });

    // 👁 预览面板行（可按「只看缝合改动」过滤）
    const stitchPlanPreviewRows = computed(() => {
        const rows = stitchPlan.value.orderPreview || [];
        return stitchPlanChangedOnly.value ? rows.filter(r => r.changed) : rows;
    });

    // 👁 预览面板统计（来源分布 + 改动数）
    const stitchPreviewStats = computed(() => {
        const rows = stitchPlan.value.orderPreview || [];
        let fromBase = 0, fromSource = 0, fromCustom = 0, changed = 0;
        for (const r of rows) {
            if (r.from === '基座') fromBase++;
            else if (r.from === '✏️ 自定义') fromCustom++;
            else fromSource++;
            if (r.changed) changed++;
        }
        return { total: rows.length, fromBase, fromSource, fromCustom, changed };
    });

    // =========================================================
    // 🚀 执行缝合（三种输出）
    // =========================================================
    const executeStitch = async () => {
        const plan = stitchPlan.value;
        if (!plan.ok) { nativeAlert(plan.reason, 'warning'); return; }
        if (plan.stats.pending > 0) { nativeAlert(`还有 ${plan.stats.pending} 条冲突未决策，请在工作台逐条选择处理方式。`, 'warning'); return; }
        if (plan.stats.added === 0 && plan.stats.overwritten === 0) { nativeAlert('当前没有任何需要写入的条目（全部为跳过）。', 'warning'); return; }

        const base = stitchBasePreset.value;
        stitchBusy.value = true;
        try {
            if (stitchTargetMode.value === 'new') {
                const name = stitchNewName.value.trim();
                if (!name) { nativeAlert('请先输入新预设名称。', 'warning'); return; }
                let dir = lastPresetDirPath.value;
                if (!dir) {
                    dir = await window.electronAPI.selectGenericFolder();
                    if (!dir) { addLog('用户取消选择保存目录', 'warning'); return; }
                    lastPresetDirPath.value = dir;
                }
                const safe = name.replace(/[\\/:*?"<>|]/g, '_');
                const filePath = `${String(dir).replace(/[\\/]+$/, '')}\\${safe}.json`;
                // 以基座为底子（参数 / 文本模板 / extensions 全部继承），只替换 prompts + prompt_order
                const data = deepCopy((base && base.data) || {});
                data.name = name;
                data.prompts = plan.prompts;
                data.prompt_order = plan.prompt_order;
                const res = await window.electronAPI.createPreset({ filePath, data });
                if (res && res.success) {
                    const newP = { path: filePath, name: `${safe}.json`, data };
                    presets.value.push(newP);
                    activePreset.value = newP;
                    if (appMode) appMode.value = 'presets';
                    addLog(`🧵 缝合完成：新建预设《${name}》（基于《${plan.baseName}》）`, 'success');
                    nativeAlert(`✅ 已生成新预设：${name}\n\n基于基座《${plan.baseName}》\n新增 ${plan.stats.added} 条 / 覆盖 ${plan.stats.overwritten} 条\n结果 prompts ${plan.stats.finalPrompts} 条`, 'info');
                    exitStitch();
                } else {
                    nativeAlert(`新建失败: ${(res && res.error) || '未知错误'}`, 'error');
                }
                return;
            }

            if (stitchTargetMode.value === 'overwrite') {
                const target = presets.value.find(p => p.path === stitchOverwritePath.value);
                if (!target) { nativeAlert('未找到要覆盖的目标预设。', 'error'); return; }
                const tName = (target.data && target.data.name) || target.name;
                const ok = await confirmDialog(`🧵 确认覆盖预设《${tName}》？\n\n将先自动备份快照（可在预设快照中回滚）。\n新增 ${plan.stats.added} 条 / 覆盖 ${plan.stats.overwritten} 条 / 跳过 ${plan.stats.skipped} 条`);
                if (!ok) return;
                const data = deepCopy(target.data || {});
                data.prompts = plan.prompts;
                data.prompt_order = plan.prompt_order;
                const res = await window.electronAPI.savePreset({ filePath: target.path, data });
                if (res && res.success) {
                    target.data = data;
                    const idx = presets.value.indexOf(target);
                    if (idx >= 0) presets.value[idx] = target;
                    if (activePreset.value && activePreset.value.path === target.path) activePreset.value = target;
                    stitchVersion.value++;
                    addLog(`🧵 缝合完成：已覆盖《${tName}》（快照已生成）`, 'success');
                    nativeAlert(`✅ 已覆盖《${tName}》\n\n新增 ${plan.stats.added} 条 / 覆盖 ${plan.stats.overwritten} 条\n快照已备份，可回滚`, 'info');
                    exitStitch();
                } else {
                    nativeAlert(`覆盖失败: ${(res && res.error) || '未知错误'}`, 'error');
                }
                return;
            }

            // current：写回当前打开的预设（只改内存，需手动保存）
            const cur = activePreset.value;
            if (!cur) { nativeAlert('当前没有打开任何预设。', 'warning'); return; }
            const data = deepCopy(cur.data || {});
            data.prompts = plan.prompts;
            data.prompt_order = plan.prompt_order;
            const newP = { path: cur.path, name: cur.name, data };
            activePreset.value = newP;
            const idx = presets.value.indexOf(cur);
            if (idx >= 0) presets.value[idx] = newP;
            stitchVersion.value++;   // 通知 EditorPanel 刷新
            addLog(`🧵 缝合完成：已写回当前预设《${newP.data.name || newP.name}》（未落盘，请点「💾 保存」）`, 'warning');
            nativeAlert('✅ 已写回当前预设（内存）\n\n⚠️ 尚未落盘，请在右上角点「💾 保存」写入文件。', 'info');
            exitStitch();
        } catch (err) {
            nativeAlert(`缝合失败: ${err.message}`, 'error');
            addLog(`❌ 缝合失败: ${err.message}`, 'error');
        } finally {
            stitchBusy.value = false;
        }
    };

    // =========================================================
    // ⭐ 常用条目库（持久化到 app_config.json → ui.presetStitchSnippets）
    // =========================================================
    const saveStitchItemAsSnippet = (item) => {
        if (!item) return;
        const snip = {
            id: REGEN_UID(),
            name: item.name || '未命名条目',
            content: item.content || '',
            role: item.role || 'system',
            enabled: item.enabled !== false,
            injection_position: item.injection_position === undefined ? 0 : item.injection_position,
            injection_depth: item.injection_depth === undefined ? 4 : item.injection_depth,
            injection_order: item.injection_order === undefined ? 100 : item.injection_order,
            marker: !!item.marker,
            system_prompt: item.system_prompt || '',
            forbid_overrides: !!item.forbid_overrides,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        snippets.value = [...(snippets.value || []), snip];
        if (typeof syncConfigToDisk === 'function') syncConfigToDisk();
        addLog(`⭐ 已存为常用条目：「${snip.name}」`, 'success');
        nativeAlert(`⭐ 已存为常用条目：${snip.name}`, 'info');
    };

    const insertSnippetToStage = (snip) => {
        if (!snip) return;
        const item = buildStageItem({ ...snip, identifier: NEW_IDENTIFIER() }, { path: '', name: '⭐ 常用库', index: -1 }, 'custom');
        item._expanded = false;
        stitchItems.value.push(item);
        stitchSelectedUid.value = item.uid;
        refreshStitchConflicts();
        addLog(`📥 已从常用库插入：「${snip.name}」`, 'info');
    };

    const renameSnippet = async (snip) => {
        if (!snip) return;
        const name = await appPrompt('✏️ 常用条目新名称：', snip.name || '');
        if (name === null || !String(name).trim()) return;
        snip.name = String(name).trim();
        snip.updatedAt = Date.now();
        snippets.value = [...snippets.value];
        if (typeof syncConfigToDisk === 'function') syncConfigToDisk();
    };

    const deleteSnippet = async (snip) => {
        if (!snip) return;
        const ok = await confirmDialog(`🗑️ 确认删除常用条目「${snip.name}」？`);
        if (!ok) return;
        snippets.value = (snippets.value || []).filter(s => s.id !== snip.id);
        if (typeof syncConfigToDisk === 'function') syncConfigToDisk();
        addLog(`🗑️ 已删除常用条目：「${snip.name}」`, 'warning');
    };

    const resetStitchState = () => {
        stitchSourcePaths.value = [];
        stitchPoolQuery.value = '';
        stitchItems.value = [];
        stitchSelectedUid.value = '';
        stitchShowConflictOnly.value = false;
        stitchShowPlanDetail.value = false;
        stitchPlanChangedOnly.value = false;
    };

    // =========================================================
    // 打开 / 关闭
    // =========================================================
    const openPresetStitch = (opts = {}) => {
        if (!presets.value.length) {
            nativeAlert('尚未加载任何预设，请先打开预设目录。', 'warning');
            return;
        }
        resetStitchState();
        const preset = opts.preset || activePreset.value;
        const mode = opts.mode || (preset && preset.path ? 'current' : 'new');
        stitchTargetMode.value = mode;
        if (preset && preset.path) {
            stitchOverwritePath.value = preset.path;
            stitchBasePath.value = preset.path;
        } else {
            stitchBasePath.value = (presets.value[0] && presets.value[0].path) || '';
        }
        stitchNewName.value = `缝合预设_${new Date().toISOString().slice(5, 10).replace('-', '')}`;
        showPresetStitchModal.value = true;
        addLog('🧵 已打开缝合中心', 'info');
    };

    // 切换目标模式时同步 path（避免 mode 与 path 不一致导致基座为空）
    const setStitchTargetMode = (mode) => {
        stitchTargetMode.value = mode;
        if (mode === 'overwrite') {
            if (!stitchOverwritePath.value || !presets.value.some(p => p.path === stitchOverwritePath.value)) {
                stitchOverwritePath.value = (activePreset.value && activePreset.value.path) || (presets.value[0] && presets.value[0].path) || '';
            }
        } else if (mode === 'new') {
            if (!stitchBasePath.value || !presets.value.some(p => p.path === stitchBasePath.value)) {
                stitchBasePath.value = (activePreset.value && activePreset.value.path) || (presets.value[0] && presets.value[0].path) || '';
            }
        }
        refreshStitchConflicts();
    };

    const setStitchBasePath = (path) => {
        if (stitchTargetMode.value === 'overwrite') stitchOverwritePath.value = path;
        else stitchBasePath.value = path;
        refreshStitchConflicts();
    };

    // 行内编辑 identifier 变化后需重算冲突
    const onStitchIdentifierChange = () => { refreshStitchConflicts(); };

    return {
        // 弹窗与状态
        showPresetStitchModal, openPresetStitch, exitStitch,
        stitchTargetMode, setStitchTargetMode,
        stitchBasePath, stitchOverwritePath, setStitchBasePath,
        stitchNewName, stitchSourcePaths, stitchSourceCandidates, toggleStitchSource, clearStitchSources, selectAllStitchSources,
        stitchPoolQuery, stitchPoolGroups, stitchSourcePresets: stitchSourceCandidates,
        stitchItems, visibleStitchItems, stitchSelectedUid, stitchShowConflictOnly, stitchShowPlanDetail,
        stitchPlanChangedOnly, stitchPlanPreviewRows, stitchPreviewStats,
        stitchBusy, stitchVersion,
        // 工作台操作
        addStitchItem, addAllFromPreset, addCustomStitchItem, removeStitchItem, clearStitchItems, moveStitchItem,
        refreshStitchConflicts, onStitchIdentifierChange,
        stitchConflictCount, stitchPendingCount,
        applyStitchDecision, applyStitchPlace, setStitchAnchor, anchorLabel,
        // 基座与干跑
        stitchBasePreset, stitchBasePrompts, stitchBaseTimeline, stitchBaseIdentifierSet,
        stitchPlan, stitchSummaryText, BUILTIN_ORDER,
        // 执行
        executeStitch,
        // 常用库
        saveStitchItemAsSnippet, insertSnippetToStage, renameSnippet, deleteSnippet
    };
}
