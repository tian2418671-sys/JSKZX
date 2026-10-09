/**
 * 🧩 预填充兼容性判定（纯函数 · 无依赖 · 可单测）
 *
 * 背景（2026-10-03 用户实测）：部分上游/代理**不允许请求以 model（assistant）轮结尾** ——
 *   `Requests ending with a model turn are not supported`，
 * 而打标分角色链路的「全量」形态恰好会在 messages 末尾追加 assistant 预填充 ⇒ 必然 400、白撞一次再降级。
 *
 * 本模块负责**判断与记忆**（不含网络、不 import vue）：
 *   · `apiCompatKey({endpoint, model, type})`  —— 以「主机 + 模型」为键，换模型/换端点各自记；
 *   · `isPrefillRejected(err)`                 —— 识别「以模型轮结尾不被支持」这一族错误（含内嵌 JSON 的包装消息）；
 *   · `decidePrefill({ mode, key, table })`    —— 三态决策：自动（按记忆）/ 总是发 / 从不发；
 *   · `recordCompat({ table, key, ok })`       —— 纯函数式记忆更新（返回新表，不改原对象）。
 *
 * 规格与调用点：`js/composables/useAITools.js::requestTaggingShared`（阶梯构造 + 失败/成功回写）
 * 持久化：`app_config.json` 的 `ui.prefillCompat = { mode, table }`
 */

/** 兼容模式（三态） */
export const PREFILL_MODES = [
    { id: 'auto', title: '自动判断（推荐）', desc: '首次被拒后记住该 API 不支持，后续自动跳过预填充' },
    { id: 'always', title: '总是先试预填充', desc: '忽略记忆，每次先发「全量」；失败再降级' },
    { id: 'never', title: '从不发预填充', desc: '直接发「无预填充」，一次也不试' }
];

export const DEFAULT_PREFILL_MODE = 'auto';

/** 归一化模式（脏值 → auto） */
export function normalizePrefillMode(m) {
    const s = String(m || '');
    return PREFILL_MODES.some((x) => x.id === s) ? s : DEFAULT_PREFILL_MODE;
}

/** 从 endpoint 里取主机名（拿不到就原样截断，保证同端点同键） */
export function hostOf(endpoint) {
    const s = String(endpoint || '').trim();
    if (!s) return '(未配置)';
    try {
        const u = new URL(s.startsWith('http') ? s : 'https://' + s);
        return u.host || s.slice(0, 60);
    } catch (e) {
        return s.replace(/^https?:\/\//, '').split('/')[0].slice(0, 60) || '(未配置)';
    }
}

/**
 * 兼容性记忆键：**主机 + 模型**（换模型或换端点分别记忆；模型空则只按主机）
 * @param {{endpoint?:string, model?:string, type?:string}} api
 */
export function apiCompatKey(api) {
    const a = api || {};
    const host = hostOf(a.endpoint);
    const model = String(a.model || '').trim().toLowerCase();
    const type = String(a.type || '').trim().toLowerCase();
    return [host, model || '*', type || '*'].join(' | ');
}

/** 已知「以模型轮结尾不被支持」这一族的错误特征（覆盖中英文与常见代理包装） */
const REJECT_PATTERNS = [
    /ending with a model turn/i,
    /end(?:s|ing)? with (?:a )?(?:model|assistant)(?: turn| message| role)?/i,
    /last message must be (?:a )?(?:user|human)/i,
    /must end with (?:a )?(?:user|human)(?: turn| message)?/i,
    /(?:不支持|不允许)[^。\n]{0,24}(?:模型|model|assistant)[^。\n]{0,12}(?:结尾|最后|结尾处)/i,
    /以(?:模型|assistant)轮结尾/
];

/**
 * 该错误是否属于「预填充（模型轮结尾）被上游拒绝」
 * @param {any} err Error 或字符串（含被包装成 `HTTP 错误: 400 - {…json…}` 的消息）
 */
export function isPrefillRejected(err) {
    const msg = String((err && (err.message || err.error)) || err || '');
    if (!msg) return false;
    return REJECT_PATTERNS.some((re) => re.test(msg));
}

/**
 * 三态决策：本次要不要带预填充
 * @param {{mode?:string, key?:string, table?:object, hasPrefill?:boolean}} p
 *        `hasPrefill`：用户是否真的配了预填充文本（没配 ⇒ 一律不带，无需判定）
 * @returns {{usePrefill:boolean, reason:string, label:string}} `label` 用于日志
 */
export function decidePrefill(p) {
    const mode = normalizePrefillMode(p && p.mode);
    const hasPrefill = !!(p && p.hasPrefill);
    if (!hasPrefill) return { usePrefill: false, reason: 'no-prefill-text', label: '无预填充' };
    if (mode === 'never') return { usePrefill: false, reason: 'mode-never', label: '无预填充（设置：从不发）' };
    if (mode === 'always') return { usePrefill: true, reason: 'mode-always', label: '全量（设置：总是先试）' };
    const entry = (p && p.table && p.key) ? p.table[p.key] : null;
    if (entry && entry.support === false) return { usePrefill: false, reason: 'learned-unsupported', label: '无预填充（已记住：该 API 不支持模型轮结尾）' };
    return { usePrefill: true, reason: entry ? 'learned-supported' : 'unknown', label: '全量' };
}

/**
 * 记忆更新（纯函数：返回**新表**，原表不动）
 * @param {{table?:object, key?:string, ok?:boolean, note?:string, at?:string|number}} p
 * @returns {object} 新表
 */
export function recordCompat(p) {
    const table = Object.assign({}, (p && p.table) || {});
    const key = p && p.key;
    if (!key) return table;
    const prev = table[key] || {};
    table[key] = {
        support: !!(p && p.ok),
        at: (p && p.at) || new Date().toISOString(),
        note: String((p && p.note) || prev.note || '').slice(0, 120),
        samples: (Number(prev.samples) || 0) + 1
    };
    return table;
}

/** 表格清洗（恢复配置时用：非法项丢弃，避免脏配置影响判定） */
export function sanitizeCompatTable(t) {
    const out = {};
    if (!t || typeof t !== 'object') return out;
    for (const [k, v] of Object.entries(t)) {
        if (!k || typeof k !== 'string') continue;
        if (!v || typeof v !== 'object') continue;
        out[k] = {
            support: v.support === true,
            at: typeof v.at === 'string' ? v.at : '',
            note: typeof v.note === 'string' ? v.note.slice(0, 120) : '',
            samples: Math.max(0, Number(v.samples) || 0)
        };
    }
    return out;
}

/** 给 UI 用的一句话状态 */
export function describeCompat({ mode, key, table, hasPrefill }) {
    const m = normalizePrefillMode(mode);
    if (!hasPrefill) return { tone: 'off', text: '当前：关闭（预填充为空）' };
    if (m === 'never') return { tone: 'skip', text: '当前：从不发预填充（手动设置）' };
    if (m === 'always') return { tone: 'try', text: '当前：总是先试预填充' };
    const e = table && key ? table[key] : null;
    if (e && e.support === false) return { tone: 'skip', text: '已自动判定：该 API 不支持以模型轮结尾 ⇒ 自动跳过预填充' };
    if (e && e.support === true) return { tone: 'ok', text: '已自动判定：该 API 支持预填充' };
    return { tone: 'unknown', text: '尚未判定（首次请求会先试一次，被拒则自动记住）' };
}
