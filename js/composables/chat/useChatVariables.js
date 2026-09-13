/**
 * MVU 变量系统（对齐 ST-MagVarUpdate / 方案「APK 变量系统 + EJS 引擎」第二~四节）
 *
 * 方案按原生 Kotlin 编写（VariableStore + MvuParser + OpLog），本文件为其 JS 等价实现：
 *   - 变量树：普通 JS 对象（点分路径寻址，数组用数字索引）
 *   - MVU 解析：<UpdateVariable> 块 → 指令序列，三种格式全支持：
 *       A. JSON 数组/对象（[{"type":"set","path":"a.b","value":1}, …]）
 *       B. 简写行语法（_.$set stat_data.世界.地点 = 风崖城）
 *       C. RFC 6902 JSON Patch（[{"op":"replace","path":"/a/b","value":…}]）
 *   - 指令集：init / set / add(数值累加) / insert(数组push) / delete / patch
 *   - 同楼合并（方案第五节 OpCoalescer）：同路径 Set 覆盖、Add+Add 折叠
 *   - OpLog + 深度重放：getMessageVar(path, depth) 回看历史楼层变量（时间旅行正确性）
 *   - 持久化：storage 适配器注入（默认走 chatStorage 适配层，按 卡path+会话id 隔离；
 *     桌面 app:// 下 localStorage 不落盘，故默认适配器已切到主进程 chat_store.json）
 *
 * 规模说明：方案的 Checkpoint+gzip 针对千楼/15MB 级；移动端测卡会话为百楼级、
 * 全量 log < 100KB，直接存 {root, log}，读取零重放开销（方案第八节决策表第一行）。
 */

import { chatStorage } from './chatStorage.js';

// ============ 路径寻址 ============

function segments(path) {
    return String(path || '').split('.').filter((s) => s !== '');
}

/** 点分路径读取：a.b.0.c（数组用数字索引）；miss 返回 undefined */
export function getPath(root, path) {
    let cur = root;
    for (const seg of segments(path)) {
        if (cur == null || typeof cur !== 'object') return undefined;
        if (Array.isArray(cur)) {
            const i = Number(seg);
            if (!Number.isInteger(i)) return undefined;
            cur = cur[i];
        } else {
            if (!(seg in cur)) return undefined;
            cur = cur[seg];
        }
    }
    return cur;
}

/** 点分路径写入：中间层缺失自动创建（下一段是数字 → 数组，否则对象） */
export function setPath(root, path, value) {
    const segs = segments(path);
    if (!segs.length) return false;
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        const nextIsIndex = /^\d+$/.test(segs[i + 1]);
        if (Array.isArray(cur)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx)) return false;
            if (cur[idx] == null || typeof cur[idx] !== 'object') cur[idx] = nextIsIndex ? [] : {};
            cur = cur[idx];
        } else if (cur && typeof cur === 'object') {
            if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = nextIsIndex ? [] : {};
            cur = cur[seg];
        } else return false;
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
        const idx = Number(last);
        if (!Number.isInteger(idx)) return false;
        cur[idx] = value;
    } else if (cur && typeof cur === 'object') {
        cur[last] = value;
    } else return false;
    return true;
}

/** 深合并（init 指令语义：递归并入，不整树替换） */
export function mergeDeep(target, src) {
    if (!src || typeof src !== 'object') return target;
    if (!target || typeof target !== 'object') return Array.isArray(src) ? [...src] : { ...src };
    if (Array.isArray(src)) {
        // 数组合并：按索引递归（与 MVU init 常见语义一致）
        for (let i = 0; i < src.length; i++) {
            target[i] = (target[i] && typeof target[i] === 'object') ? mergeDeep(target[i], src[i]) : src[i];
        }
        return target;
    }
    for (const k of Object.keys(src)) {
        const v = src[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
            mergeDeep(target[k], v);
        } else {
            target[k] = (v && typeof v === 'object') ? (Array.isArray(v) ? [...v] : { ...v }) : v;
        }
    }
    return target;
}

// ============ MVU 指令解析 ============

// MVU 块标签:标准 <UpdateVariable>;兼容 JS-Slash-Runner/Prompt-Template 卡的小写变体
// <update variable> / <update>(大小写不敏感,闭合标签与开标签同名)
const MVU_BLOCK_RE = /<(UpdateVariable|update\s*variable|update)>([\s\S]*?)<\/\1>/gi;

/** 简写行：_.$set path = value / $add / $insert / $del */
const SHORTHAND_RE = /^_?\.\$(set|add|insert|del|delete)\s+([^\s=]+)\s*=\s*(.*)$/;

/** 字符串值 → 类型化（null/bool/int/float/JSON/字符串，对齐方案 toTypedValue） */
function toTypedValue(s) {
    const t = String(s == null ? '' : s).trim();
    if (t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return JSON.parse(t); } catch (e) { return t; }
    }
    return t;
}

/** JSON 对象 → 指令（宽容：未知 type 按 set 处理，对齐方案） */
function jsonToOp(j) {
    if (!j || typeof j !== 'object') return null;
    const type = String(j.type || '').toLowerCase();
    switch (type) {
        case 'init': return { type: 'init', data: (j.data && typeof j.data === 'object') ? j.data : {} };
        case 'add': return { type: 'add', path: String(j.path || ''), value: Number(j.value) || 0 };
        case 'delete': case 'del': case 'remove': return { type: 'delete', path: String(j.path || '') };
        case 'insert': return { type: 'insert', path: String(j.path || ''), value: j.value };
        case 'patch': return { type: 'patch', ops: Array.isArray(j.ops) ? j.ops : [] };
        case 'set': return { type: 'set', path: String(j.path || ''), value: j.value };
        default:
            if (j.path) return { type: 'set', path: String(j.path), value: j.value };
            return null;
    }
}

/** 解析单个 <UpdateVariable> 块内容 → 指令数组（三种格式按序探测） */
export function parseMvuBlock(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
        if (s.startsWith('[')) {
            const arr = JSON.parse(s);
            if (!Array.isArray(arr)) return null;
            // 数组内可能是 MVU 指令({type,…}) 或 RFC6902({op,…})
            const hasRfc = arr.some((x) => x && typeof x === 'object' && typeof x.op === 'string' && !x.type);
            if (hasRfc && arr.every((x) => x && typeof x === 'object' && typeof x.op === 'string' && !x.type)) {
                return [{ type: 'patch', ops: arr }];
            }
            const ops = arr.map(jsonToOp).filter(Boolean);
            return ops.length ? ops : null;
        }
        if (s.startsWith('{')) {
            const op = jsonToOp(JSON.parse(s));
            return op ? [op] : null;
        }
    } catch (e) { /* JSON 失败 → 尝试简写行 */ }
    // 格式B：简写行语法（逐行解析，容忍杂质行）
    const ops = [];
    for (const line of s.split(/\r?\n/)) {
        const m = SHORTHAND_RE.exec(line.trim());
        if (!m) continue;
        const [, kind, path, valRaw] = m;
        if (kind === 'add') ops.push({ type: 'add', path, value: Number(String(valRaw).trim()) || 0 });
        else if (kind === 'insert') ops.push({ type: 'insert', path, value: toTypedValue(valRaw) });
        else if (kind === 'del' || kind === 'delete') ops.push({ type: 'delete', path });
        else ops.push({ type: 'set', path, value: toTypedValue(valRaw) });
    }
    return ops.length ? ops : null;
}

/**
 * 从 AI 消息提取全部 MVU 块 → { ops, display }
 * display = 剔除块后的显示文本（对齐方案 MvuParser.extract）
 */
export function extractMvu(text) {
    const src = String(text || '');
    const ops = [];
    MVU_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = MVU_BLOCK_RE.exec(src)) !== null) {
        const parsed = parseMvuBlock(m[2]);
        if (parsed) ops.push(...parsed);
    }
    const display = src.replace(MVU_BLOCK_RE, '').trim();
    return { ops, display };
}

// ============ 同楼指令合并（方案第五节 OpCoalescer） ============

/** 同一楼内指令合并：同路径 Set 后写覆盖先写、Add+Add 折叠；init 重置一切 */
export function coalesceOps(ops) {
    const setOps = new Map(); // path → op（保持插入序）
    const others = [];
    for (const op of ops || []) {
        if (!op || typeof op !== 'object') continue;
        switch (op.type) {
            case 'set': setOps.set(op.path, op); break;
            case 'add': {
                const prev = setOps.get(op.path);
                if (prev && prev.type === 'add') setOps.set(op.path, { type: 'add', path: op.path, value: prev.value + op.value });
                else setOps.set(op.path, op);
                break;
            }
            case 'delete': setOps.set(op.path, op); break;
            case 'init': others.length = 0; setOps.clear(); others.push(op); break;
            default: others.push(op);
        }
    }
    return [...others, ...setOps.values()];
}

// ============ RFC 6902 精简实现 ============

/** JSON Pointer → 路径段（/a/b/0 → [a,b,0]，~1→/ ~0→~ 反转义） */
function pointerSegs(pointer) {
    return String(pointer || '').replace(/^\/+/, '').split('/').filter((s) => s !== '')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pointerGet(root, segs) {
    let cur = root;
    for (const seg of segs) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
    }
    return cur;
}

/** 对 root 就地应用 RFC6902 指令组；test 失败抛错（对齐方案 applyRfc6902） */
export function applyRfc6902(root, ops) {
    for (const o of ops || []) {
        if (!o || typeof o !== 'object' || typeof o.op !== 'string') continue;
        const segs = pointerSegs(o.path);
        if (!segs.length) continue;
        const dotPath = segs.join('.');
        switch (o.op.toLowerCase()) {
            case 'add': case 'replace': setPath(root, dotPath, o.value); break;
            case 'remove': setPath(root, dotPath, undefined); break;
            case 'test': {
                const cur = pointerGet(root, segs);
                if (JSON.stringify(cur) !== JSON.stringify(o.value)) {
                    throw new Error('patch test failed: ' + o.path);
                }
                break;
            }
            default: break; // move/copy 移动端测卡场景不实现
        }
    }
}

// ============ 纯指令执行（对任意 root 就地应用，供引擎与重放共用） ============

export function applyOpTo(root, op) {
    if (!op || typeof op !== 'object') return;
    switch (op.type) {
        case 'init': mergeDeep(root, op.data || {}); break;
        case 'set': setPath(root, op.path, op.value); break;
        case 'add': {
            const old = Number(getPath(root, op.path)) || 0;
            setPath(root, op.path, old + (Number(op.value) || 0));
            break;
        }
        case 'delete': setPath(root, op.path, undefined); break;
        case 'insert': {
            const cur = getPath(root, op.path);
            const arr = Array.isArray(cur) ? [...cur] : [];
            arr.push(op.value);
            setPath(root, op.path, arr);
            break;
        }
        case 'patch': applyRfc6902(root, op.ops || []); break;
        default: break;
    }
}

// ============ 变量引擎（Store + OpLog + 持久化） ============

/**
 * 默认 storage 适配器：统一走 chatStorage 适配层
 * ⚠️ 桌面生产环境（app://）下 localStorage 不落盘，直接用它会「重启丢变量树」；
 *    chatStorage 保持同步语义（内存权威），并把数据镜像到主进程 chat_store.json。
 *    测试/特殊场景仍可通过 createVariableEngine({ storage }) 注入自有适配器覆盖本默认值。
 */
const defaultStorage = {
    get: (key) => chatStorage.get(key),
    set: (key, val) => chatStorage.set(key, val),
    remove: (key) => chatStorage.remove(key)
};

/**
 * 创建变量引擎实例（每张卡×每个会话一个）
 * @param {object} opts
 *   - storageKey: 持久化键（建议 jsmobile-chat-vars:{cardPath}:{sessionId}）
 *   - storage: {get,set,remove} 适配器（测试注入内存版）
 *   - onChange: () => void 变量变更回调（视图层 bump 响应式版本号）
 */
export function createVariableEngine(opts = {}) {
    const storage = opts.storage || defaultStorage;
    const storageKey = String(opts.storageKey || 'jsmobile-chat-vars:default');
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    const engine = {
        root: {},          // 变量树（stat_data 挂在根下）
        log: [],           // OpLog：[{ai: AI消息序号, ops: [...], ts}]
        aiCount: 0,        // 已应用的 AI 消息数（下一条的 ai 序号）
        listeners: []
    };

    function fire(path, oldVal, newVal) {
        for (const l of engine.listeners) { try { l(path, oldVal, newVal); } catch (e) { /* 监听器失败不影响主流程 */ } }
    }
    engine.addListener = (fn) => { if (typeof fn === 'function') engine.listeners.push(fn); };

    /** 执行单条指令（唯一变更入口；纯计算委托 applyOpTo，事件在本地发） */
    function executeOp(op) {
        const path = op && op.path;
        const old = path ? getPath(engine.root, path) : undefined;
        applyOpTo(engine.root, op);
        fire(path || '*', old, path ? getPath(engine.root, path) : undefined);
    }

    /**
     * AI 消息到达：应用指令组 → 记 OpLog（方案 VariableEngine.onAiMessage）
     * @param {Array} ops 指令（内部会做同楼合并）
     * @returns {number} 实际执行条数
     */
    engine.applyOps = (ops) => {
        const coalesced = coalesceOps(ops);
        if (!coalesced.length) return 0;
        let n = 0;
        for (const op of coalesced) {
            try { executeOp(op); n++; } catch (e) {
                console.warn('[MVU] 指令执行失败(跳过):', op.type, op.path || '', e.message);
            }
        }
        if (n) {
            engine.log.push({ ai: engine.aiCount, ops: coalesced, ts: Date.now() });
            engine.aiCount++;
            onChange();
            engine.persist();
        }
        return n;
    };

    /**
     * AI 原始回复 → 提取并应用 MVU → 返回剔除块后的显示文本
     */
    engine.onAiMessage = (rawText) => {
        const { ops, display } = extractMvu(rawText);
        if (ops.length) engine.applyOps(ops);
        else engine.aiCount++; // 无指令也占一个楼层号（深度回看对齐消息序）
        return display;
    };

    /** 重放至第 aiIndex 条 AI 消息后的全量状态（时间旅行；aiIndex<0 → 空树） */
    engine.getStateAt = (aiIndex) => {
        if (aiIndex >= engine.aiCount - 1 && engine.log.length) {
            // 请求的就是最新状态 → 直接返回当前树（避免重放）
            return JSON.parse(JSON.stringify(engine.root));
        }
        const state = {};
        for (const entry of engine.log) {
            if (entry.ai > aiIndex) break;
            for (const op of entry.ops) {
                try { applyOpTo(state, op); } catch (e) { /* 重放容错 */ }
            }
        }
        return state;
    };

    /** 历史楼层变量读取（对齐方案 getMessageVar(path, depth)：depth=往回数几条AI消息） */
    engine.getMessageVar = (path, depth = 0) => {
        if (!depth || depth <= 0) return getPath(engine.root, path);
        const target = engine.aiCount - 1 - depth;
        return getPath(engine.getStateAt(target), path);
    };

    /** EJS 宿主 API：insertOrAssignVariables（RFC6902 patch 字符串/数组） */
    engine.applyPatchDirect = (patch) => {
        let ops = patch;
        if (typeof patch === 'string') ops = JSON.parse(patch);
        if (!Array.isArray(ops)) ops = [ops];
        engine.applyOps([{ type: 'patch', ops }]);
    };

    // ---- 持久化 ----
    engine.persist = () => {
        try {
            storage.set(storageKey, JSON.stringify({ v: 1, root: engine.root, log: engine.log, aiCount: engine.aiCount }));
        } catch (e) { console.warn('[MVU] 持久化失败:', e.message); }
    };
    engine.restore = () => {
        try {
            const raw = storage.get(storageKey);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data || typeof data !== 'object') return false;
            engine.root = (data.root && typeof data.root === 'object') ? data.root : {};
            engine.log = Array.isArray(data.log) ? data.log : [];
            engine.aiCount = Number(data.aiCount) || engine.log.length;
            return true;
        } catch (e) { return false; }
    };
    engine.reset = () => {
        engine.root = {};
        engine.log = [];
        engine.aiCount = 0;
        onChange();
        storage.remove(storageKey);
    };
    /** 撤销最近一条 OpLog 记录：弹出后从剩余日志全量重建树（测卡调试用） */
    engine.undoLast = () => {
        if (!engine.log.length) return false;
        engine.log.pop();
        const state = {};
        for (const entry of engine.log) {
            for (const op of entry.ops) {
                try { applyOpTo(state, op); } catch (e) { /* 重放容错 */ }
            }
        }
        engine.root = state;
        onChange();
        engine.persist();
        return true;
    };
    // 换会话：宿主直接以新 storageKey 调 createVariableEngine 重建实例（storageKey 是闭包常量，不做原地重绑）

    engine.restore();
    return engine;
}

/** 变量统计（侧边栏展示用）：空对象/空数组计 0（空树应显示「0 值」而非 1） */
export function countVars(root) {
    if (!root || typeof root !== 'object') return 0;
    let leaves = 0;
    const walk = (o) => {
        const keys = Array.isArray(o) ? o.map((_, i) => i) : Object.keys(o);
        for (const k of keys) {
            const v = o[k];
            if (v && typeof v === 'object') walk(v);
            else leaves++;
        }
    };
    walk(root);
    return leaves;
}
