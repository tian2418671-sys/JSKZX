/**
 * 🏭 从 SillyTavern 源码生成宿主桩（治本方案）
 *
 * 问题：手工维护桩意味着「一个插件一个插件地补 API」——插件千变万化，
 *       永远补不完，且每次改动都可能破坏已通过的插件。
 *
 * 事实：本机有**完整的酒馆源码**（E:\AI\SillyTavern）。
 *       酒馆自己的 `public/scripts/st-context.js` 就是 getContext() 的**权威定义**，
 *       共 250 个成员；`public/scripts/*.js` 共 75 个核心模块。
 *
 * 做法：解析这些源码，自动生成桩。桩不再靠猜，而是与真实酒馆保持同构。
 *
 * 用法：
 *   node scripts/gen-host-stubs.mjs            # 生成并写入 js/plugins/hostStubs.generated.js
 *   node scripts/gen-host-stubs.mjs --dry      # 只打印统计，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ST_DIR = process.env.ST_DIR || 'E:\\AI\\SillyTavern';
const OUT = path.join(ROOT, 'js', 'plugins', 'hostStubs.generated.js');
const dry = process.argv.includes('--dry');

/**
 * 从 getContext() 的 return 对象字面量里提取成员。
 * 只做「浅层键名提取」，不执行任何代码。
 */
export function extractContextMembers(src) {
    const start = src.indexOf('export function getContext()');
    if (start < 0) return [];
    const braceStart = src.indexOf('{', src.indexOf('return', start));
    // 从 return { 起做括号配对（跳过字符串/注释/模板）
    let i = src.indexOf('return', start);
    while (i < src.length && src[i] !== '{') i++;
    let depth = 0;
    let end = -1;
    let state = 'code';
    let quote = '';
    for (; i < src.length; i++) {
        const c = src[i];
        const c2 = src[i + 1];
        if (state === 'code') {
            if (c === '/' && c2 === '/') { state = 'lineComment'; i++; continue; }
            if (c === '/' && c2 === '*') { state = 'blockComment'; i++; continue; }
            if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; continue; }
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
            continue;
        }
        if (state === 'lineComment') { if (c === '\n') state = 'code'; continue; }
        if (state === 'blockComment') { if (c === '*' && c2 === '/') { state = 'code'; i++; } continue; }
        if (state === 'string') {
            if (c === '\\') { i++; continue; }
            if (c === quote) state = 'code';
            continue;
        }
    }
    if (end < 0) return [];
    const body = src.slice(braceStart, end + 1);
    return parseObjectKeys(body);
}

/** 从一个对象字面量文本里提取顶层键名（含 shorthand 与 a: b 两种写法） */
export function parseObjectKeys(body) {
    const keys = new Set();
    let depth = 0;
    let state = 'code';
    let quote = '';
    let token = '';
    const flush = () => {
        const t = token.trim();
        token = '';
        if (!t) return;
        // a: xxx / a, / a } / async a(...) / a(...) {  / shorthand a
        const m = t.match(/^(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:[:(,}]|$)/);
        if (m) keys.add(m[1]);
    };
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        const c2 = body[i + 1];
        if (state === 'code') {
            if (c === '/' && c2 === '/') { state = 'lineComment'; flush(); i++; continue; }
            if (c === '/' && c2 === '*') { state = 'blockComment'; flush(); i++; continue; }
            if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; flush(); continue; }
            if (c === '{' || c === '(' || c === '[') { flush(); depth++; continue; }
            if (c === '}' || c === ')' || c === ']') { flush(); depth--; continue; }
            if (c === ',' && depth === 1) { flush(); continue; }
            token += c;
            continue;
        }
        if (state === 'lineComment') { if (c === '\n') state = 'code'; continue; }
        if (state === 'blockComment') { if (c === '*' && c2 === '/') { state = 'code'; i++; } continue; }
        if (state === 'string') {
            if (c === '\\') { i++; continue; }
            if (c === quote) state = 'code';
            continue;
        }
    }
    flush();
    return Array.from(keys);
}

/** 生成「值形状」：根据名字猜一个安全的默认值 */
function defaultFor(name) {
    if (/^(is|has|can|should|use)[A-Z_]/.test(name)) return 'false';
    if (/^(get|set|load|save|send|add|del|remove|update|create|open|close|show|hide|init|register|unregister|generate|fetch|request|substitute|format|render|scroll|toggle|check|parse|build|apply|reset|reload|rename|delete|insert|move|copy|paste|export|import|make|emit|trigger|clear|enable|disable|stop|start|activate|deactivate|execute|extract|count|validate|normalize|sanitize|do)/.test(name)) {
        return 'function(){ return Promise.resolve(); }';
    }
    if (/^on[A-Z_]/.test(name)) return 'function(){}';
    if (/(s|List|Array|items?|characters|groups|entries|messages)$/.test(name)) return '[]';
    if (/(Map|Index)$/.test(name)) return 'new Map()';
    if (/(Id|Count|Number|Max|Min|Size|Length)$/.test(name)) return '0';
    return '{}';
}

// ====================== 主流程 ======================
const ctxFile = path.join(ST_DIR, 'public', 'scripts', 'st-context.js');
const eventTypesFile = path.join(ST_DIR, 'public', 'scripts', 'events.js');

if (!fs.existsSync(ctxFile)) {
    console.error('❌ 找不到酒馆源码:', ctxFile);
    console.error('   可通过环境变量 ST_DIR 指定 SillyTavern 根目录');
    process.exit(1);
}

const ctxSrc = fs.readFileSync(ctxFile, 'utf-8');
const members = extractContextMembers(ctxSrc);

// st-context.js 只是 getContext() 的成员表；但插件还会直接 import 酒馆其它模块的导出，
// 例如 messageFormatter（来自 script.js / message-formatting 相关模块）。
// 因此再扫一遍 public/scripts 下的**全部 export**，作为「宿主全局 API」清单。
export function collectModuleExports(dir) {
    const names = new Set();
    const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (/^(node_modules|lib|vendor|test|tests)$/i.test(e.name)) continue;
                walk(full);
                continue;
            }
            if (!/\.js$/i.test(e.name)) continue;
            let src = '';
            try { src = fs.readFileSync(full, 'utf-8'); } catch { continue; }
            // export function foo / export const foo / export { a, b as c } / export let
            let m;
            const reFn = /export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
            while ((m = reFn.exec(src))) names.add(m[1]);
            const reVar = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
            while ((m = reVar.exec(src))) names.add(m[1]);
            const reList = /export\s*\{([^}]*)\}/g;
            while ((m = reList.exec(src))) {
                for (const part of m[1].split(',')) {
                    const p = part.trim();
                    if (!p) continue;
                    const as = p.match(/\bas\s+([A-Za-z_$][\w$]*)/);
                    names.add(as ? as[1] : p.split(/\s+/)[0]);
                }
            }
        }
    };
    walk(dir);
    return Array.from(names).sort();
}

const moduleExports = collectModuleExports(path.join(ST_DIR, 'public', 'scripts'));

console.log('=== st-context.js 解析结果 ===');
console.log('getContext 成员数:', members.length);
console.log('酒馆模块导出总数:', moduleExports.length);

// events.js 的 event_types
let eventTypes = [];
if (fs.existsSync(eventTypesFile)) {
    const evSrc = fs.readFileSync(eventTypesFile, 'utf-8');
    const m = evSrc.match(/export const event_types\s*=\s*\{([\s\S]*?)\}/);
    if (m) {
        eventTypes = (m[1].match(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm) || [])
            .map((x) => x.replace(/[:：\s]/g, ''))
            .filter(Boolean);
    }
}
console.log('event_types 常量数:', eventTypes.length);

if (dry) {
    console.log('\n前 30 个成员:', members.slice(0, 30).join(', '));
    console.log('后 20 个成员:', members.slice(-20).join(', '));
    process.exit(0);
}

// 生成文件
// 注意：moduleExports 有近 3000 个名字，其中大量是酒馆**内部实现细节**
// （表单工具、DOM 小助手等），插件几乎不会 import。全量内联会让注入脚本膨胀到
// 300KB+，拖慢每次预览。这里做一次「有用性」筛选：
//   · st-context 的 155 个成员 —— 全保留（这是官方公开 API）
//   · 其余模块导出 —— 只保留「看起来是公开 API」的（首字母大写类型、成对动词前缀）
const isPublicApiName = (n) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(n)) return false;
    if (n.length < 3) return false;
    // 明显是内部实现/临时变量
    if (/^(__|_)/.test(n)) return false;
    if (/(Element|Node|Listener|Handler|Callback|Ctx|Tmp|Temp|Internal|Impl|Helper)$/i.test(n)) return false;
    // 保留：类/命名空间（首字母大写）
    if (/^[A-Z]/.test(n)) return true;
    // 保留：常见宿主 API 动词前缀
    if (/^(get|set|is|has|can|should|do|make|create|add|remove|delete|update|save|load|open|close|show|hide|send|fetch|request|generate|register|unregister|activate|deactivate|enable|disable|start|stop|toggle|select|init|render|format|parse|validate|normalize|sanitize|substitute|extract|count|reload|rename|move|insert|append|clear|reset|emit|trigger|on|off|once|call|exec|run|wait|sleep|log|toast|notify)[A-Z_]/.test(n)) return true;
    return false;
};
const filteredExports = moduleExports.filter(isPublicApiName);
const allMembers = Array.from(new Set([...members, ...filteredExports])).sort();
const memberLines = allMembers.map((m) => `    ${m}: ${defaultFor(m)},`).join('\n');
const eventLines = eventTypes.map((e) => `    ${e}: ${JSON.stringify(e.toLowerCase())},`).join('\n');
console.log('筛选后并入的模块导出:', filteredExports.length, '/ 总', moduleExports.length);
console.log('最终 getContext 补齐成员数:', allMembers.length);

const out = `/**
 * 🏭 自动生成：宿主 getContext() 桩（请勿手工编辑）
 *
 * 来源：${ctxFile}
 * 生成时间：${new Date().toISOString()}
 * getContext 成员：${members.length} 个
 * event_types 常量：${eventTypes.length} 个
 *
 * 重新生成：node scripts/gen-host-stubs.mjs
 *
 * 为什么要有这个文件：
 *   手工维护桩等于「一个插件一个插件地补 API」，永远补不完。
 *   改为从酒馆源码提取权威成员清单，桩与真实酒馆保持同构。
 *
 * 注意：默认值只是「形状正确、不会抛错」，并非真实行为。
 *       预览的目的是看界面能否渲染，不追求真实网络/存储语义。
 */

/** getContext() 需要补齐的全部成员名（来自酒馆源码） */
export const CONTEXT_MEMBERS = ${JSON.stringify(members, null, 0)};

/** event_types 的全部常量名 */
export const EVENT_TYPES = ${JSON.stringify(eventTypes, null, 0)};

/** 酒馆各模块的导出名（供 importmap / 桩兜底用） */
export const HOST_MODULE_EXPORTS = ${JSON.stringify(moduleExports, null, 0)};

/**
 * 默认值的**源码片段**（含函数），供宿主桩直接内联进注入脚本。
 * 之所以存成源码而非对象：默认值大量是函数，JSON 无法表达。
 */
export const CONTEXT_DEFAULTS_SOURCE = \`
${memberLines}
\`;

/** 生成默认值表（仅供 Node 侧使用 / 单测） */
export function buildContextDefaults() {
  return {
${memberLines}
  };
}

/** 生成 event_types 常量表 */
export function buildEventTypes() {
  return {
${eventLines}
  };
}
`;

fs.writeFileSync(OUT, out, 'utf-8');
console.log('\n✅ 已生成:', OUT);
console.log('   文件大小:', (out.length / 1024).toFixed(1), 'KB');
