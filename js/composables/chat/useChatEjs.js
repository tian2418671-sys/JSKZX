/**
 * EJS 模板引擎（对齐 ST-Prompt-Template / 方案「APK 变量系统 + EJS 引擎」第五~七节）
 *
 * 方案按原生 Kotlin + QuickJS 沙箱编写（因 Android 原生无 JS 运行时）。本项目整个 App
 * 就跑在 Capacitor WebView 内 → 天然拥有完整 JS 运行时，故：
 *   - 不需要 QuickJS / NDK so 库 / Rhino 兜底（方案第二、三节整节省去）
 *   - 不需要 WebView 池化（渲染方案第七节）——本就在 WebView 里
 *   - 模板直接用 new Function 执行，语法与 EJS 同源，兼容度 100%
 *
 * 支持标准 EJS 标签：
 *   <% code %>   逻辑语句（含 <%_ 去前置空白、_%> 去后置空白）
 *   <%= expr %>  转义输出（HTML 实体）
 *   <%- expr %>  原样输出（HTML 面板必需）
 *   <%%  %>      字面量转义（输出 "<%"）
 *
 * 宿主 API 白名单（方案第六节 TemplateApiBridge 的 JS 等价）：
 *   getChatMessage(index, role?) / getMessageVar(path, depth?) / getVariables()
 *   insertOrAssignVariables(patch) / getvar(path) / setvar(path, value)
 *
 * 安全与降级（方案第九节工程清单 #2/#3）：
 *   - 步数预算守卫：编译产物每个代码段注入计数，超预算抛错（防失控循环）
 *   - 执行失败 → 返回原文注入（与 ST-Prompt-Template 未安装时行为一致）
 *   - 模板按内容缓存编译产物（变量走 ctx 传入，无需失效）
 */

const MAX_STEPS = 2_000_000;   // 步数预算（单次模板执行的代码段进入上限）
const MAX_OUTPUT = 2_000_000;  // 输出长度上限（防超大输出撑爆内存）

/** 编译缓存：模板文本 → 编译函数（按内容缓存，变量走 ctx 不需失效） */
const compileCache = new Map();
const CACHE_LIMIT = 200;

/** HTML 实体转义（<%= %> 语义） */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ============ 循环守卫注入（编译期，防失控循环） ============
// 浏览器无法抢占同步 JS（无 QuickJS interruptHandler 等价物），
// 唯一可行防线：编译期把 __s() 注入循环条件与块体 → 失控循环必然触预算抛错。

/** 从 openIdx（指向 '('）扫描到配对 ')'，返回下标；失败返回 -1（字符串感知） */
function matchParen(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(src, i);
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** 从引号处跳到字符串结束（处理转义），返回闭引号下标 */
function skipString(src, start) {
    const q = src[start];
    for (let i = start + 1; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) return i;
    }
    return src.length - 1;
}

/** 顶层分隔（忽略括号/字符串内的分隔符） */
function splitTopLevel(s, sep) {
    const out = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === '`') {
            const end = skipString(s, i);
            cur += s.slice(i, end + 1);
            i = end;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    out.push(cur);
    return out;
}

/**
 * 对单个逻辑代码段注入步数守卫：
 *   1. while(cond)   → while((__s(),(cond)))（cond 空 → true）
 *   2. for(a;b;c)    → 条件段 b 注入 __s()（b 空 → __s()||true）
 *   3. 块体 '{' 前是 ')' 或 else/do/try/finally → 注入 __s();（覆盖花括号循环体）
 * 字符串字面量原样跳过，不误伤。
 */
function injectGuards(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    const isIdent = (c) => /[A-Za-z0-9_$]/.test(c || '');
    while (i < n) {
        const c = src[i];
        // 字符串原样拷贝
        if (c === '"' || c === "'" || c === '`') {
            const end = skipString(src, i);
            out += src.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        // for / while 关键字（词边界校验）
        if ((c === 'f' || c === 'w') && !isIdent(out.length ? out[out.length - 1] : '')) {
            const kw = src.startsWith('for', i) ? 'for' : (src.startsWith('while', i) ? 'while' : null);
            if (kw && !isIdent(src[i + kw.length])) {
                let j = i + kw.length;
                while (j < n && /\s/.test(src[j])) j++;
                if (src[j] === '(') {
                    const close = matchParen(src, j);
                    if (close > 0) {
                        const inner = src.slice(j + 1, close);
                        if (kw === 'while') {
                            const cond = inner.trim();
                            out += 'while((__s(),' + (cond ? '(' + cond + ')' : 'true') + '))';
                        } else {
                            const parts = splitTopLevel(inner, ';');
                            if (parts.length >= 2) {
                                const cond = parts[1].trim();
                                parts[1] = cond ? '(__s(),(' + cond + '))' : '__s()||true';
                                out += 'for(' + parts.join(';') + ')';
                            } else out += src.slice(i, close + 1);
                        }
                        i = close + 1;
                        continue;
                    }
                }
            }
        }
        // 块体 '{'：前文为 ')' 或 else/do/try/finally → 体首注入守卫
        if (c === '{') {
            const tail = out.trimEnd();
            const inject = tail.endsWith(')') || /\b(else|do|try|finally)$/.test(tail);
            out += '{';
            if (inject) out += '__s();';
            i++;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * 迷你 EJS 编译器：模板 → JS 函数体（方案第五节 __ejsRender 的移植）
 * 逐 token 扫描，纯文本 JSON.stringify 内联，表达式拼进输出累加。
 */
function compileTemplate(tpl) {
    // token 顺序很关键：<%% 字面量转义最先；<%= 转义输出；<%- 原样输出；<% / <%_ _%> 逻辑语句
    const TOKEN = /<%%|<%=([\s\S]*?)%>|<%-([\s\S]*?)%>|<%_?([\s\S]*?)_?%>/g;
    let code = "let __o='';\nwith(__c){\n";
    let i = 0;
    let m;
    const emitLiteral = (s) => { if (s) code += "__o+=" + JSON.stringify(s) + ";__s();\n"; };

    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(tpl)) !== null) {
        // 空白修剪：<%_ 去标签前空白，_%> 去标签后空白
        let litStart = i;
        let litEnd = m.index;
        const rawBefore = tpl.slice(litStart, litEnd);
        const trimBefore = m[0].startsWith('<%_');
        const trimAfter = m[0].endsWith('_%>');
        let lit = rawBefore;
        if (trimBefore) lit = lit.replace(/\s+$/, '');
        emitLiteral(lit);

        if (m[0] === '<%%') {
            emitLiteral('<%');
        } else if (m[1] !== undefined) {
            // <%= 转义输出
            code += "__o+=__esc(String((" + m[1] + ")??''));__s();\n";
        } else if (m[2] !== undefined) {
            // <%- 原样输出（HTML 面板）
            code += "__o+=String((" + m[2] + ")??'');__s();\n";
        } else {
            // <% 逻辑语句（编译期注入循环守卫，防失控循环挂死 WebView）
            code += injectGuards(m[3] || '') + "\n__s();\n";
        }
        i = TOKEN.lastIndex;
        if (trimAfter) {
            // 吃掉紧随其后的换行/空白：调整下一轮字面量起点
            const after = tpl.slice(i);
            const stripped = after.replace(/^\s+/, '');
            i += after.length - stripped.length;
        }
    }
    emitLiteral(tpl.slice(i));
    code += "}\nreturn __o;";
    return code;
}

/** 取得编译函数（带缓存 + 步数守卫） */
function getCompiled(tpl) {
    const key = String(tpl);
    const hit = compileCache.get(key);
    if (hit) return hit;
    const code = compileTemplate(key);
    // __s = step guard：超预算抛错；__len = 输出长度守卫
    const fn = new Function('__c', '__esc', '__s', code);
    if (compileCache.size >= CACHE_LIMIT) {
        const first = compileCache.keys().next().value;
        compileCache.delete(first);
    }
    compileCache.set(key, fn);
    return fn;
}

/** 是否像 EJS 模板（方案第七节 looksLikeEjs：含 <% 且非纯转义） */
export function looksLikeEjs(text) {
    const s = String(text || '');
    if (!s.includes('<%')) return false;
    // 只有 <%% 字面量转义 → 不算模板
    const stripped = s.replace(/<%%/g, '');
    return stripped.includes('<%');
}

/**
 * 渲染 EJS 模板
 * @param {string} template 模板文本（世界书条目 / 预设提示词 / 状态栏模板）
 * @param {object} ctx 模板上下文（变量树 + 宿主 API 白名单，with 作用域内直接可用）
 * @param {object} [opts] { fallback: 'raw'|'empty'|'throw', label: '调试标识' }
 * @returns {string} 渲染结果；失败按 fallback 降级（默认 raw = 原文注入）
 */
export function renderEjs(template, ctx = {}, opts = {}) {
    const tpl = String(template == null ? '' : template);
    if (!tpl) return '';
    const fallback = opts.fallback || 'raw';
    const label = opts.label || 'EJS';
    let steps = 0;
    const guard = () => {
        if (++steps > MAX_STEPS) throw new Error('模板执行超步数预算（疑似死循环）');
    };
    try {
        const fn = getCompiled(tpl);
        // 上下文：注入宿主 API + 变量树；with(__c) 使 stat_data.xxx 等直接可写
        const scope = Object.assign(Object.create(null), ctx || {});
        let out = fn(scope, esc, guard);
        if (typeof out !== 'string') out = String(out == null ? '' : out);
        if (out.length > MAX_OUTPUT) {
            console.warn(`[${label}] 模板输出超长(${out.length})，已截断`);
            out = out.slice(0, MAX_OUTPUT);
        }
        return out;
    } catch (e) {
        console.warn(`[${label}] 模板执行失败，按「${fallback}」降级:`, e.message);
        if (fallback === 'throw') throw e;
        if (fallback === 'empty') return '';
        return tpl; // raw：原文注入（与 ST-Prompt-Template 未安装时一致）
    }
}

/**
 * 构建模板上下文（方案第六节 TemplateApiBridge + EjsEngine.buildContext 的 JS 等价）
 * @param {object} deps
 *   - engine: createVariableEngine 实例（变量树 + getMessageVar）
 *   - messages: 当前会话消息数组 [{role, content|swipes, index}]
 *   - macros: 宏字典（{{user}} 等，供模板内查值）
 *   - messageTextOf: (msg) => string 取消息文本（处理 swipes 结构）
 *   - cardName / userName: 便捷标量
 * @returns {object} ctx（可直接传 renderEjs）
 */
export function buildTemplateContext(deps = {}) {
    const engine = deps.engine || null;
    const messages = Array.isArray(deps.messages) ? deps.messages : [];
    const textOf = typeof deps.messageTextOf === 'function'
        ? deps.messageTextOf
        : ((m) => (m && (m.content || (Array.isArray(m.swipes) ? m.swipes[m.index || 0] : ''))) || '');

    /**
     * getChatMessage(index, role?)
     * 正数 → 绝对序号；负数 → 从最新往回（-1 = 最新）
     * 带 role 时只在该角色消息中回溯（对齐酒馆 / 方案第六节语义）
     */
    function getChatMessage(index, role) {
        let pool = messages;
        if (role) {
            const r = String(role).toLowerCase();
            const want = (r === 'assistant' || r === 'bot' || r === 'ai' || r === 'char') ? 'assistant' : r;
            pool = messages.filter((m) => m && m.role === want);
        }
        if (!pool.length) return null;
        const n = Number(index) || 0;
        const msg = n < 0 ? pool[pool.length + n] : pool[n];
        if (!msg) return null;
        return { message: textOf(msg), role: msg.role || '' };
    }

    /** 全量变量树（模板内 stat_data.xxx 直接访问） */
    function getVariables() {
        return engine ? engine.root : {};
    }

    /** 历史楼层变量读取（时间旅行） */
    function getMessageVar(path, depth) {
        if (!engine) return undefined;
        return engine.getMessageVar(path, Number(depth) || 0);
    }

    /** 变量写入（RFC6902 patch 或 {path,value} 数组） */
    function insertOrAssignVariables(patch) {
        if (!engine) return false;
        try { engine.applyPatchDirect(patch); return true; } catch (e) { return false; }
    }

    const ctx = {
        // 变量与消息 API（宿主白名单）
        getVariables,
        getMessageVar,
        getChatMessage,
        insertOrAssignVariables,
        // 便捷别名（酒馆/ST-Prompt-Template 常见写法）
        getvar: (path) => (engine ? engine.root && getPathSafe(engine.root, path) : undefined),
        setvar: (path, value) => { if (engine) engine.applyOps([{ type: 'set', path, value }]); },
        // 标量便捷值
        userName: String(deps.userName || ''),
        charName: String(deps.cardName || ''),
        macros: deps.macros || {},
        // 变量树直接展开（stat_data 等顶层键可在模板内裸写）
        ...(engine && engine.root && typeof engine.root === 'object' ? engine.root : {}),
        // 消息便捷视图
        msg: {
            get last() { return getChatMessage(-1); },
            get lastUser() { return getChatMessage(-1, 'user'); },
            get lastAssistant() { return getChatMessage(-1, 'assistant'); },
            get count() { return messages.length; }
        }
    };
    return ctx;
}

/** 安全点分路径读取（避免循环依赖，本文件内联精简版） */
function getPathSafe(root, path) {
    let cur = root;
    for (const seg of String(path || '').split('.').filter(Boolean)) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
    }
    return cur;
}

/**
 * 批量渲染：对一组文本条目执行 EJS（仅对 looksLikeEjs 的条目生效）
 * @param {Array<{content:string}>|string[]} items
 * @param {object} ctx
 * @param {boolean} enabled 总开关（关闭时按普通文本注入 → 兼容降级）
 */
export function renderEjsItems(items, ctx, enabled = true) {
    if (!enabled || !Array.isArray(items)) return items;
    return items.map((it) => {
        const isStr = typeof it === 'string';
        const content = isStr ? it : (it && it.content) || '';
        if (!looksLikeEjs(content)) return it;
        const rendered = renderEjs(content, ctx, { fallback: 'raw', label: 'EJS条目' });
        return isStr ? rendered : { ...it, content: rendered };
    });
}

/** 清空编译缓存（调试用） */
export function clearEjsCache() { compileCache.clear(); }
