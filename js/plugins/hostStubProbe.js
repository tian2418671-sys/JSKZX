/**
 * 插件源码静态透视（纯函数，供 node --test 直接单测）
 *
 * [!] 定位（上游 Q5 拍板）：**只作附加信息，绝不阻止沙盒渲染尝试**。
 *    正则判「有没有 UI」必然有误判（插件可能用 document.createElement / 模板字符串 /
 *    innerHTML 拼接等无数写法），一旦误判成「后台脚本」而不去渲染，用户就看不到
 *    本来能跑出来的界面 —— 比空白更糟。所以这里的结论只用于「跑完没内容时」解释原因。
 */

/** 酒馆事件名清单（用于判断插件监听哪些生命周期事件） */
const KNOWN_EVENT_NAMES = [
  'APP_READY', 'SETTINGS_LOADED', 'CHAT_CHANGED', 'MESSAGE_RECEIVED',
  'MESSAGE_SENT', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
  'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
  'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
  'GENERATION_AFTER_COMMANDS', 'STREAM_TOKEN_RECEIVED',
  'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'CHAT_CREATED', 'GROUP_UPDATED'
];

/** 酒馆助手 / ST 常见 API（用于判断插件调用了哪些能力） */
const KNOWN_API_NAMES = [
  'getVariables', 'setVariables', 'getvar', 'setvar', 'insertOrAssignVariables',
  'updateVariablesWith', 'replaceVariables', 'getAllVariables',
  'getChatMessages', 'setChatMessages', 'createChatMessages', 'deleteChatMessages',
  'getCurrentMessageId', 'getLastMessageId',
  'triggerSlash', 'generate', 'generateRaw', 'generateQuietPrompt',
  'substitudeMacros', 'substituteParams',
  'getWorldbook', 'getWorldbookNames', 'getLorebookEntries', 'setLorebookEntries',
  'registerSlashCommand', 'registerButton', 'eventOn', 'eventOnce', 'eventEmit',
  'getTavernHelperVersion', 'waitGlobalInitialized',
  'getCharacterCard', 'getCharacter', 'isCharacterCard'
];

/** 常见全局对象（判断运行环境依赖） */
const KNOWN_GLOBALS = [
  'TavernHelper', 'SillyTavern', 'eventSource', 'event_types', 'tavern_events',
  'toastr', 'Handlebars', 'Mvu', 'getContext'
];

/**
 * 提取插件注册的 Slash 命令名（供能力卡逐条展示 / 试跑）
 * 覆盖两种写法：
 *   · SlashRunner.registerCommand({ name: "状态栏", ... })
 *   · registerSlashCommand({ name: "xxx", ... })
 * @param {string} src
 * @returns {string[]}
 */
export function extractSlashCommandNames(src) {
  const s = String(src || '');
  const names = new Set();
  const patterns = [
    /registerCommand\s*\(\s*\{[^}]*?name\s*:\s*['"`]([^'"`]{1,40})['"`]/g,
    /registerSlashCommand\s*\(\s*\{[^}]*?name\s*:\s*['"`]([^'"`]{1,40})['"`]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s)) !== null) names.add(m[1]);
  }
  return [...names];
}

/**
 * 提取 eventSource.on(...) 实际监听的事件名
 * @param {string} src
 * @returns {string[]}
 */
export function extractListenedEvents(src) {
  const s = String(src || '');
  const out = new Set();
  const re = /(?:eventSource|tavern_events)\s*\.\s*(?:on|once|makeLast|makeFirst|eventOn)\s*\(\s*(?:event_types\.|tavern_events\.)?['"`]?([A-Za-z_][A-Za-z0-9_]{2,40})['"`]?/g;
  let m;
  while ((m = re.exec(s)) !== null) out.add(m[1]);
  return [...out];
}

/** 判断插件是否会调用模型（这类插件在沙箱里永远不会有「效果」） */
export function usesLlm(src) {
  const s = String(src || '');
  return /\b(generateQuietPrompt|generateRaw|generate\s*\(|triggerSlash\s*\(\s*['"`]\/gen)/.test(s);
}

/**
 * 扫描源码里的标识符出现情况
 * @param {string} src 插件源码（可多段拼接）
 * @param {string[]} names 待查名称
 * @returns {string[]} 命中的名称（保持 names 原顺序）
 */
function pick(src, names) {
  const out = [];
  for (const n of names) {
    // 词边界匹配：前导允许 `.`（`event_types.CHAT_CHANGED` 必须命中），
    // 但字母/数字/下划线/$ 紧邻时视为更长的标识符，不算命中（避免子串误判）。
    const escaped = n.replace(/[$]/g, '\\$');
    const re = new RegExp('(^|[^A-Za-z0-9_$])' + escaped + '($|[^A-Za-z0-9_$])');
    if (re.test(src)) out.push(n);
  }
  return out;
}

/**
 * 判断源码里是否有「明显会产出可见 DOM」的迹象
 * 仅用于解释「为什么没看到界面」，不用于决策是否渲染。
 * @param {string} src
 * @param {boolean} [hasTemplates] 是否有 .html 模板文件
 * @param {boolean} [hasCss] 是否有 .css 文件
 */
function looksLikeItHasUI(src, hasTemplates, hasCss) {
  if (hasTemplates || hasCss) return true;
  const domHints = [
    /\.append\s*\(/, /\.appendTo\s*\(/, /\.html\s*\(/, /\.innerHTML\s*=/,
    /document\.createElement/, /document\.body\.append/, /\.insertAdjacentHTML/,
    /document\.querySelector/, /\.prepend\s*\(/, /\.before\s*\(/, /\.after\s*\(/
  ];
  return domHints.some((re) => re.test(src));
}

/**
 * 生成「插件能力透视」数据
 * @param {object} input
 * @param {string} input.source 全部插件源码拼接
 * @param {boolean} [input.hasTemplates] 是否含 .html 模板
 * @param {boolean} [input.hasCss] 是否含 .css
 * @param {string} [input.pluginKind] 'extension' | 其它
 * @returns {{kindLabel:string, events:string[], apis:string[], globals:string[], hasUiSigns:boolean}}
 */
export function probePluginSource(input) {
  const src = String((input && input.source) || '');
  const hasTemplates = !!(input && input.hasTemplates);
  const hasCss = !!(input && input.hasCss);
  const hasUiSigns = looksLikeItHasUI(src, hasTemplates, hasCss);

  let kindLabel;
  if (input && input.pluginKind === 'extension') {
    kindLabel = '扩展工程（bundle + 模板）';
  } else if (!hasUiSigns) {
    kindLabel = '后台逻辑脚本（本身不生成可见界面）';
  } else {
    kindLabel = '界面类脚本（应能产出可见界面，若没有请查看控制台错误）';
  }

  return {
    kindLabel,
    events: pick(src, KNOWN_EVENT_NAMES),
    apis: pick(src, KNOWN_API_NAMES),
    globals: pick(src, KNOWN_GLOBALS),
    hasUiSigns,
    // 🧾 能力说明书用的补充字段（2026-11-08）
    listenedEvents: extractListenedEvents(src),   // 实际 on(...) 监听的事件
    slashCommands: extractSlashCommandNames(src), // 注册的命令名（可逐条展示）
    needsLlm: usesLlm(src),                       // 是否调用模型（沙箱里必然无效果）
  };
}

/** 把探测结果转成可插入 innerHTML 的 HTML 片段（已转义） */
export function renderProbeHtml(probe) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const p = probe || {};
  const list = (arr) => (arr && arr.length
    ? arr.map((x) => '<code style="background:#27272a;padding:0 4px;border-radius:3px;">' + esc(x) + '</code>').join(' ')
    : '<span style="color:#52525b;">（未检测到）</span>');

  return ''
    + '<div style="margin-top:14px;padding:12px 14px;background:#1f1f23;border:1px solid #3f3f46;border-radius:8px;">'
    + '<div style="font-size:13px;color:#e4e4e7;font-weight:600;margin-bottom:8px;">[PROBE] 插件能力透视</div>'
    + '<div style="margin-bottom:6px;"><span style="color:#a1a1aa;">[NOTE] 类型：</span>' + esc(p.kindLabel || '未知') + '</div>'
    + '<div style="margin-bottom:6px;"><span style="color:#a1a1aa;">[EVENT] 监听事件：</span>' + list(p.events) + '</div>'
    + '<div style="margin-bottom:6px;"><span style="color:#a1a1aa;">[API] 调用 API：</span>' + list(p.apis) + '</div>'
    + '<div><span style="color:#a1a1aa;">🌐 依赖全局：</span>' + list(p.globals) + '</div>'
    + '</div>';
}
