// ✨ 自定义模式（2026-10-03）：多段提示词列表 —— 纯函数（增删移改 / 校验），便于单测。
// 段结构：{ id: string, role: 'system' | 'user' | 'assistant', content: string }
//   role = 发送时的角色位（SYSTEM / USER / ASSISTANT）。
// 说明：所有操作返回新数组（不可变更新）——组件把新数组 emit 出去，由 App.vue 持有并持久化。

export const SEGMENT_ROLES = ['system', 'user', 'assistant'];

let seq = 0;
function newId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* 忽略 */ }
    seq += 1;
    return 'seg-' + Date.now().toString(36) + '-' + seq + '-' + Math.random().toString(36).slice(2, 8);
}

export function makeCustomSegment(role = 'system') {
    return { id: newId(), role: SEGMENT_ROLES.includes(role) ? role : 'system', content: '' };
}

// 校验 / 清洗外部数据（配置恢复 / props 传入）：过滤非法项、补全缺省字段、非法枚举回退（旧数据附带的 kind 等冗余字段自动清除）
export function normalizeCustomSegments(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
            id: String(s.id || '') || newId(),
            role: SEGMENT_ROLES.includes(s.role) ? s.role : 'system',
            content: typeof s.content === 'string' ? s.content : ''
        }));
}

// —— 以下操作均返回新数组（不可变更新） ——

// 在最上方插入（无 segment 时自动造一段 SYSTEM 空段）
export function insertSegmentAtTop(list, segment) {
    return [segment || makeCustomSegment(), ...normalizeCustomSegments(list)];
}

// 删除指定下标（越界 = 原样返回）
export function removeSegmentAt(list, index) {
    const l = normalizeCustomSegments(list);
    if (!Number.isInteger(index) || index < 0 || index >= l.length) return l;
    return l.filter((_, i) => i !== index);
}

// 上移 / 下移（direction: -1 | 1；首段上移 / 末段下移 = 原样返回）
export function moveSegment(list, index, direction) {
    const l = normalizeCustomSegments(list);
    const to = index + direction;
    if (!Number.isInteger(index) || index < 0 || index >= l.length) return l;
    if (!Number.isInteger(to) || to < 0 || to >= l.length) return l;
    const next = l.slice();
    const [seg] = next.splice(index, 1);
    next.splice(to, 0, seg);
    return next;
}

// 修改指定段的字段（patch：{ role?, content? }；id 不可改；越界 = 原样返回）
export function patchSegment(list, index, patch) {
    const l = normalizeCustomSegments(list);
    if (!Number.isInteger(index) || index < 0 || index >= l.length) return l;
    return l.map((s, i) => {
        if (i !== index) return s;
        const merged = { ...s, ...(patch || {}) };
        return {
            id: s.id,
            role: SEGMENT_ROLES.includes(merged.role) ? merged.role : 'system',
            content: typeof merged.content === 'string' ? merged.content : s.content
        };
    });
}

// ⟸ 初始映射（2026-10-03）：把当前「系统提示词」链路映射为段 —— 作为自定义模式的默认起点。
//   顺序与现链路一致：系统提示词 → 破限（现链路拼于 system 末尾）→ User → 预填充；
//   空白内容跳过；原文保留（不做内部修改）。
export function buildSegmentsFromPrompts({ system = '', user = '', prefill = '', jailbreak = '', useJailbreak = false } = {}) {
    const segs = [];
    const push = (role, content) => {
        const c = String(content || '');
        if (c.trim()) segs.push({ ...makeCustomSegment(role), content: c });
    };
    push('system', system);
    if (useJailbreak) push('system', jailbreak);
    push('user', user);
    push('assistant', prefill);
    return segs;
}

// 🧩 2026-10-03 接入打标：自定义模式 → 消息数组（请求组装；唯一出口 requestTaggingShared 调用）
//   · 段按顺序转消息（空段跳过；非法角色回退 system）
//   · usePrefill=false → 去掉**末尾（连续）**的 assistant 段（预填充降级 / 打包禁用预填充同此语义）
//   · 材料（候选池+卡数据+输出要求 = defaultUser）：拼进**最后一条 user 段**；无 user 段时作为独立 user 消息
//     插入「末尾连续 assistant 段」之前（保证预填充仍居最末）
export function buildCustomMessages({ segments, defaultUser = '', usePrefill = true } = {}) {
    let msgs = (Array.isArray(segments) ? segments : [])
        .filter((s) => s && typeof s.content === 'string' && s.content.trim())
        .map((s) => ({ role: SEGMENT_ROLES.includes(s.role) ? s.role : 'system', content: s.content }));
    if (!usePrefill) {
        while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    }
    const mat = String(defaultUser || '').trim();
    if (mat) {
        let li = -1;
        for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') { li = i; break; } }
        if (li >= 0) {
            msgs[li] = { role: 'user', content: msgs[li].content + '\n\n' + mat };
        } else {
            let idx = msgs.length;
            while (idx > 0 && msgs[idx - 1].role === 'assistant') idx--;
            msgs.splice(idx, 0, { role: 'user', content: mat });
        }
    }
    return msgs;
}

// 末尾 assistant 段内容（= 自定义模式的「实际预填充」，解析侧拼回用；trim 后；无则空串）
export function customTailPrefill(segments) {
    const valid = (Array.isArray(segments) ? segments : []).filter((s) => s && typeof s.content === 'string' && s.content.trim());
    const last = valid[valid.length - 1];
    return (last && last.role === 'assistant') ? String(last.content).trim() : '';
}
