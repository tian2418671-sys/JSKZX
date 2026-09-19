/**
 * 🧩 角色卡内嵌插件（酒馆插件）识别与归一化 —— 纯逻辑，无 Vue / 无 Electron 依赖，可直接单测
 * ════════════════════════════════════════════════════════════════════
 * 真实数据形态（2026-09-19 实测 76 张卡：E:\AI\酒馆工具\角色卡，PNG tEXt/iTXt 解出 chara/ccv3）：
 *   ① `extensions.tavern_helper = { scripts: [...], variables: {...} }` ← 25 张卡，主流形态
 *   ② `extensions.tavern_helper = [["scripts", [...]], ["variables", {...}]]`
 *      ← **同一个字段的「键值对数组」导出形态**（老版助手 / 第三方工具导出），必须兼容，否则读不出脚本
 *   ③ `extensions.TavernHelper_scripts = [{ type:'script', value:{ id, name, content } }]`
 *      ← 旧版（脚本字段外层多包一层 `value`）
 *   ④ `extensions.regex_scripts` ← 内嵌正则，已由「正则脚本」页签负责，此处只做统计，不重复编辑
 *   ⑤ 其它写卡扩展：`cfMvuVarGroups` / `mvu_worldbook_name`（MVU）、`xiaobaix-tasks` / `xiaobaix-template`
 *      （小白X 工作台）、`chub` / `aifuck_metadata`（第三方站点元数据）……
 *
 * 脚本条目真实字段：`{ type:'script', enabled, name, id, content, info, button, data }`
 *
 * ⚠️ 三条铁律
 *   1. **只认容器、不猜死键**：容器存在就出组（哪怕 0 条），避免「明明有脚本却显示没有」；
 *   2. **编辑必须落在原对象上**（`item.host`），否则改完写不回卡（shallowRef 也感知不到）；
 *   3. **新增条目要跟随容器既有形态**（旧版容器继续写 `value` 包装、键值对数组继续 push 键值对），
 *      否则会把卡片结构改坏。
 */

/** SillyTavern 原生扩展字段（不是插件，不进「其它扩展」诊断列表） */
export const ST_NATIVE_EXTENSION_KEYS = [
    'talkativeness', 'fav', 'world', 'depth_prompt', 'group_only_greetings',
    'expressions', 'alt_expressions', 'position', 'display_index'
];

/** 已知插件字段（识别后归入对应分组，不再当「未识别」列出） */
export const KNOWN_PLUGIN_EXTENSION_KEYS = [
    'tavern_helper', 'TavernHelper_scripts', 'tavern_helper_scripts', 'tavernHelper_scripts',
    'tavernHelper', 'regex_scripts', 'regexScripts',
    'cfMvuVarGroups', 'mvu_worldbook_name', 'SPreset',
    'xiaobaix-tasks', 'xiaobaix-template', 'chub', 'aifuck_metadata'
];

/** 旧版（非 tavern_helper 嵌套）脚本字段候选 */
const LEGACY_SCRIPT_KEYS = ['TavernHelper_scripts', 'tavern_helper_scripts', 'tavernHelper_scripts', 'tavernHelper'];

/** 脚本对象里「正文」可能的键（按优先级） */
const CONTENT_KEY_CANDIDATES = ['content', 'code', 'script', 'source'];
/** 脚本对象里「名称」可能的键 */
const NAME_KEY_CANDIDATES = ['name', 'scriptName', 'title'];
/** 脚本对象里「启用」可能的键 */
const ENABLED_KEY_CANDIDATES = ['enabled', 'active'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const pickKey = (obj, candidates) => {
    if (!isObj(obj)) return '';
    return candidates.find(k => obj[k] !== undefined) || '';
};

/** 键值对数组形态（[["scripts", [...]], ["variables", {...}]]）的取键 */
function findPair(node, key) {
    if (!Array.isArray(node)) return null;
    for (const pair of node) {
        if (Array.isArray(pair) && pair.length === 2 && pair[0] === key) return pair;
    }
    return null;
}

/** 数组本身是不是「脚本数组」（而不是键值对数组） */
function looksLikeScriptArray(arr) {
    if (!Array.isArray(arr) || !arr.length) return false;
    return arr.every(it => isObj(it) && (
        it.value !== undefined || it.content !== undefined || it.type !== undefined || it.name !== undefined
    ));
}

function ensureExtensions(data, { create = false } = {}) {
    if (!isObj(data)) return null;
    if (!isObj(data.extensions)) {
        if (!create) return null;
        data.extensions = {};
    }
    return data.extensions;
}

/** 把「可能是数组 / 对象字典 / 非集合」的容器值收敛成数组（对象字典取 values） */
function toList(value) {
    if (Array.isArray(value)) return value;
    if (isObj(value)) return Object.values(value);
    return [];
}

/**
 * 定位「当前卡」的酒馆助手脚本容器
 * @param {object} data 卡片数据层（App.vue 的 safeData）
 * @param {{create?: boolean}} [opts] create=true 时会把缺失的容器补出来（新增脚本用）
 * @returns {{list: Array|null, sourcePath: string, legacy: boolean, pendingShape: string}}
 *          list=null 表示「容器键存在但形态不是脚本数组」（sourcePath 仍会给出，供 UI 诊断）
 */
export function resolveScriptContainer(data, { create = false } = {}) {
    const ext = ensureExtensions(data, { create });
    if (!ext) return { list: null, sourcePath: '', legacy: false, pendingShape: '' };

    const helper = ext.tavern_helper;

    // 形态：键值对数组
    if (Array.isArray(helper)) {
        const pair = findPair(helper, 'scripts');
        if (pair) {
            if (Array.isArray(pair[1])) {
                return { list: pair[1], sourcePath: 'extensions.tavern_helper（键值对数组）→ scripts', legacy: false, pendingShape: '' };
            }
            return { list: null, sourcePath: 'extensions.tavern_helper（键值对数组）→ scripts', legacy: false, pendingShape: 'pair' };
        }
        if (looksLikeScriptArray(helper)) {
            return { list: helper, sourcePath: 'extensions.tavern_helper', legacy: false, pendingShape: '' };
        }
        if (create) {
            const list = [];
            helper.push(['scripts', list]);
            return { list, sourcePath: 'extensions.tavern_helper（键值对数组）→ scripts', legacy: false, pendingShape: '' };
        }
        return { list: null, sourcePath: 'extensions.tavern_helper（键值对数组）', legacy: false, pendingShape: 'pair' };
    }

    // 形态：对象 { scripts: [...] }
    if (isObj(helper)) {
        if (Array.isArray(helper.scripts)) {
            return { list: helper.scripts, sourcePath: 'extensions.tavern_helper.scripts', legacy: false, pendingShape: '' };
        }
        if (Array.isArray(helper.script)) {
            return { list: helper.script, sourcePath: 'extensions.tavern_helper.script', legacy: false, pendingShape: '' };
        }
        if (create) {
            helper.scripts = [];
            return { list: helper.scripts, sourcePath: 'extensions.tavern_helper.scripts', legacy: false, pendingShape: '' };
        }
        return { list: null, sourcePath: 'extensions.tavern_helper（无 scripts 键）', legacy: false, pendingShape: 'object' };
    }

    // 形态：旧版顶层字段
    for (const key of LEGACY_SCRIPT_KEYS) {
        if (Array.isArray(ext[key])) {
            return { list: ext[key], sourcePath: `extensions.${key}`, legacy: true, pendingShape: '' };
        }
    }

    if (create) {
        ext.tavern_helper = { scripts: [] };
        return { list: ext.tavern_helper.scripts, sourcePath: 'extensions.tavern_helper.scripts', legacy: false, pendingShape: '' };
    }
    return { list: null, sourcePath: '', legacy: false, pendingShape: '' };
}

/**
 * 定位 MVU / 助手变量容器（`extensions.tavern_helper.variables`，兼容键值对数组形态）
 * @returns {{value: object|null, sourcePath: string, keys: string[]}}
 */
export function resolveVariablesContainer(data) {
    const ext = ensureExtensions(data);
    if (!ext) return { value: null, sourcePath: '', keys: [] };
    const helper = ext.tavern_helper;
    if (Array.isArray(helper)) {
        const pair = findPair(helper, 'variables');
        if (pair && isObj(pair[1])) {
            return { value: pair[1], sourcePath: 'extensions.tavern_helper（键值对数组）→ variables', keys: Object.keys(pair[1]) };
        }
        return { value: null, sourcePath: '', keys: [] };
    }
    if (isObj(helper) && isObj(helper.variables)) {
        return { value: helper.variables, sourcePath: 'extensions.tavern_helper.variables', keys: Object.keys(helper.variables) };
    }
    return { value: null, sourcePath: '', keys: [] };
}

/** 单条脚本 / 正则条目 → 统一可编辑模型（host 是「真实落点」，编辑直接改它才能写回卡片） */
export function buildScriptItem(entry, index, sourcePath = '') {
    if (!isObj(entry) && typeof entry !== 'object') return null;
    const host = isObj(entry.value) ? entry.value : entry;
    const contentKey = pickKey(host, CONTENT_KEY_CANDIDATES) || 'content';
    const nameKey = pickKey(host, NAME_KEY_CANDIDATES) || 'name';
    const enabledKey = pickKey(host, ENABLED_KEY_CANDIDATES) || 'enabled';
    const content = host[contentKey] === undefined || host[contentKey] === null ? '' : String(host[contentKey]);
    const rawEnabled = host[enabledKey] !== undefined ? host[enabledKey] : entry.enabled;
    const item = {
        uid: String(host.id || entry.id || `${sourcePath}#${index}`),
        index,
        name: String(host[nameKey] === undefined || host[nameKey] === null ? (entry[nameKey] ?? `脚本 ${index + 1}`) : host[nameKey]),
        type: String(entry.type || host.type || 'script'),
        enabled: rawEnabled !== false,
        content,
        contentKey,
        nameKey,
        enabledKey,
        host,                       // ⚠️ 真实落点（旧版形态是外层的 value 对象）
        entry,                      // 外层条目（旧版形态下用于镜像 type/enabled）
        legacy: host !== entry,
        chars: content.length
    };
    // 🔋 行数 **惰性** 计算：
    //    本函数在每次 refreshCardData()（如描述框逐键输入）都会重跑，而实测最重的卡脚本正文有 ~2MB，
    //    逐键 split('\n') 会白花 ~1ms；而列表默认只显示信息头行数、弹窗才必然读它 → 读到时才算。
    let linesCache = null;
    Object.defineProperty(item, 'lines', {
        enumerable: true,
        configurable: true,
        get() {
            if (linesCache === null) {
                const text = this.content;
                linesCache = text ? text.split('\n').length : 0;
            }
            return linesCache;
        },
        // 写入 null → 失效重算（writeScriptField 改正文后调用）
        set(v) { linesCache = (v === null || v === undefined) ? null : (Number(v) || 0); }
    });
    return item;
}

/** 读两条字段（旧版形态 name 可能内层外层都有 → 编辑时同步镜像，避免酒馆两处读数不一致） */
export function writeScriptField(item, field, value) {
    if (!item || !item.host) return false;
    if (field === 'content') {
        item.host[item.contentKey || 'content'] = value;
        item.content = value;
        item.chars = String(value || '').length;
        item.lines = null;          // 🔋 惰性行数：置空 → 下次读取时重算（避免逐键拆全文）
        return true;
    }
    if (field === 'name') {
        item.host[item.nameKey || 'name'] = value;
        if (item.entry && item.entry !== item.host && item.entry[item.nameKey] !== undefined) item.entry[item.nameKey] = value;
        item.name = value;
        return true;
    }
    if (field === 'enabled') {
        item.host[item.enabledKey || 'enabled'] = !!value;
        if (item.entry && item.entry !== item.host && item.entry.enabled !== undefined) item.entry.enabled = !!value;
        item.enabled = !!value;
        return true;
    }
    return false;
}

/** 新建脚本条目：跟随容器既有形态（旧版 → value 包装），避免改坏结构 */
export function createScriptEntry({ legacy = false, name = '' } = {}) {
    const id = `script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const base = { type: 'script', enabled: true, name, id, content: '', info: '' };
    if (!legacy) return { ...base, button: {}, data: {} };
    return { type: 'script', enabled: true, value: { ...base, button: {}, data: {} } };
}

/**
 * 采集当前卡的全部插件数据（供「插件」页签渲染）
 * @param {object} data 卡片数据层
 * @returns {{groups: Array, foreignKeys: Array<{key:string,type:string,sizeHint:string}>, total:number, enabled:number, chars:number, containerPath:string, diagnostics:Array}}
 */
export function harvestCardPlugins(data) {
    const result = {
        groups: [],
        foreignKeys: [],
        total: 0,
        enabled: 0,
        chars: 0,
        containerPath: '',
        diagnostics: []
    };
    if (!isObj(data)) return result;

    const ext = isObj(data.extensions) ? data.extensions : null;

    // ① 酒馆助手脚本（可编辑）
    const container = resolveScriptContainer(data);
    result.containerPath = container.sourcePath || '';
    const hasContainer = !!container.sourcePath;
    if (hasContainer) {
        const items = toList(container.list)
            .map((entry, i) => buildScriptItem(entry, i, container.sourcePath))
            .filter(Boolean);
        const writable = !!container.list;
        result.groups.push({
            key: 'tavern-helper',
            kind: 'script',
            label: '酒馆助手脚本',
            icon: '📜',
            sourcePath: container.sourcePath,
            legacy: container.legacy,
            writable,
            items,
            // 容器在但读不出条目 → UI 要显式提示形态异常，而不是静默显示 0 条
            shapeWarning: writable ? '' : '识别到脚本容器，但内部形态不是脚本数组（未做改动，避免破坏结构）',
            sizeHint: `${items.length} 条`,
            empty: items.length === 0
        });
        result.total += items.length;
        result.enabled += items.filter(i => i.enabled).length;
        result.chars += items.reduce((n, i) => n + i.chars, 0);
    }

    // ② MVU / 助手变量（只读展示，编辑风险高）
    const vars = resolveVariablesContainer(data);
    if (vars.value) {
        result.groups.push({
            key: 'tavern-variables',
            kind: 'json',
            label: '助手变量数据（MVU 初始变量）',
            icon: '📦',
            sourcePath: vars.sourcePath,
            writable: false,
            host: vars.value,
            keys: vars.keys,
            sizeHint: `${vars.keys.length} 个顶层键`,
            empty: false
        });
    }

    // ③ MVU 变量组定义 / 绑定世界书
    if (ext) {
        if (Array.isArray(ext.cfMvuVarGroups)) {
            result.groups.push({
                key: 'mvu-var-groups',
                kind: 'json',
                label: 'MVU 变量组定义',
                icon: '🧮',
                sourcePath: 'extensions.cfMvuVarGroups',
                writable: false,
                host: ext.cfMvuVarGroups,
                sizeHint: `${ext.cfMvuVarGroups.length} 组`,
                empty: ext.cfMvuVarGroups.length === 0
            });
        }
        if (ext.mvu_worldbook_name !== undefined) {
            result.groups.push({
                key: 'mvu-worldbook-name',
                kind: 'value',
                label: 'MVU 绑定世界书',
                icon: '🌍',
                sourcePath: 'extensions.mvu_worldbook_name',
                writable: false,
                text: String(ext.mvu_worldbook_name || ''),
                sizeHint: String(ext.mvu_worldbook_name || '（空）'),
                empty: false
            });
        }
        // ④ 第三方写卡扩展
        const thirdParty = ['xiaobaix-tasks', 'xiaobaix-template', 'SPreset', 'chub', 'aifuck_metadata']
            .filter(k => ext[k] !== undefined);
        for (const k of thirdParty) {
            const v = ext[k];
            result.groups.push({
                key: `ext-${k}`,
                kind: 'json',
                label: `第三方扩展数据 · ${k}`,
                icon: '🧷',
                sourcePath: `extensions.${k}`,
                writable: false,
                host: v,
                sizeHint: Array.isArray(v) ? `${v.length} 项` : (isObj(v) ? `${Object.keys(v).length} 键` : typeof v),
                empty: Array.isArray(v) ? v.length === 0 : false
            });
        }
    }

    // ⑤ 诊断：该卡 extensions 里都有什么（空态时给用户看「到底有没有」）
    if (ext) {
        for (const [k, v] of Object.entries(ext)) {
            const type = Array.isArray(v) ? `数组(${v.length})` : v === null ? 'null' : isObj(v) ? `对象(${Object.keys(v).length} 键)` : typeof v;
            result.diagnostics.push({ key: k, type });
            const known = KNOWN_PLUGIN_EXTENSION_KEYS.includes(k);
            if (!known && !ST_NATIVE_EXTENSION_KEYS.includes(k)) {
                result.foreignKeys.push({ key: k, type });
            }
        }
    }
    return result;
}
