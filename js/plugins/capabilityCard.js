/**
 * 纯逻辑插件「能力说明书」渲染（纯函数，供 node --test 直接单测）
 *
 * ── 为什么需要 ───────────────────────────────────────────────────────────
 * 真实插件库里相当一部分是**纯后台逻辑**（发送前正则、一键写卡器、变量初始化）。
 * 它们本来就没有界面，丢进沙箱必然空白。用户看到空白只会以为「软件坏了」。
 *
 * 正确做法：直接告诉他「这是什么、在什么时候跑、会动什么数据」，
 * 而不是让他对着一片空白猜。这不阻止渲染（沙箱仍会先跑），只是给一个明确解释。
 */
import { probePluginSource } from './hostStubProbe.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 事件名 → 中文时机说明（没收录的显示原名） */
const EVENT_TIMING = {
  APP_READY: '应用就绪时',
  SETTINGS_LOADED: '设置载入后',
  CHAT_CHANGED: '切换聊天时',
  MESSAGE_SENT: '用户发送消息后',
  MESSAGE_RECEIVED: '收到角色消息时',
  MESSAGE_UPDATED: '消息被编辑后',
  MESSAGE_DELETED: '消息被删除后',
  MESSAGE_SWIPED: '切换消息分支时',
  CHARACTER_MESSAGE_RENDERED: '角色消息渲染完成时',
  USER_MESSAGE_RENDERED: '用户消息渲染完成时',
  GENERATION_STARTED: '开始生成时',
  GENERATION_ENDED: '生成结束时',
  GENERATION_STOPPED: '生成被中止时',
  GENERATION_AFTER_COMMANDS: '生成命令执行后',
  STREAM_TOKEN_RECEIVED: '流式输出每收到一段时',
  WORLDINFO_UPDATED: '世界书更新时',
  CHARACTER_EDITED: '角色卡被编辑时',
  CHAT_CREATED: '新建聊天时',
  GROUP_UPDATED: '群组更新时',
};

/** API 名 → 中文作用说明 */
const API_PURPOSE = {
  getVariables: '读取 MVU 变量',
  setVariables: '写入变量',
  getvar: '读取变量',
  setvar: '写入变量',
  insertOrAssignVariables: '插入或覆盖变量',
  updateVariablesWith: '批量更新变量',
  getChatMessages: '读取聊天消息',
  setChatMessages: '改写聊天消息',
  deleteChatMessages: '删除聊天消息',
  getCurrentMessageId: '取当前楼层号',
  getLastMessageId: '取最后楼层号',
  triggerSlash: '执行斜杠命令',
  generateQuietPrompt: '静默调用模型',
  generateRaw: '调用模型（原始）',
  generate: '调用模型',
  substitudeMacros: '替换宏（{{char}} 等）',
  getWorldbook: '读取世界书',
  getLorebookEntries: '读取世界书条目',
  registerSlashCommand: '注册斜杠命令',
  registerButton: '注册按钮',
  eventOn: '订阅事件',
  getCharacterCard: '读取角色卡',
};

/**
 * 渲染能力说明书
 * @param {object} plugin 插件模型
 * @param {object} [probeInit] 已算好的 probe 结果（缺省时现算）
 * @returns {string} HTML
 */
export function renderCapabilityCard(plugin, probeInit) {
  const p = plugin || {};
  const code = String((p.scripts && p.scripts[0] && p.scripts[0].content) || p.content || '');
  const probe = probeInit || probePluginSource({ source: code });

  const evs = probe.listenedEvents || probe.events || [];
  const apis = probe.apis || [];
  const cmds = probe.slashCommands || [];

  const evRows = evs.length
    ? evs.map((e) => `<li><code>${esc(e)}</code>${EVENT_TIMING[e] ? ` <span class="jsk-hint">— ${esc(EVENT_TIMING[e])}</span>` : ''}</li>`).join('')
    : '';

  const apiRows = apis.length
    ? apis.map((a) => `<li><code>${esc(a)}</code>${API_PURPOSE[a] ? ` <span class="jsk-hint">— ${esc(API_PURPOSE[a])}</span>` : ''}</li>`).join('')
    : '';

  const cmdChips = cmds.length
    ? cmds.map((c) => `<span class="jsk-cmd">/${esc(c)}</span>`).join('')
    : '';

  return `<div class="jsk-cap">
  <div class="jsk-cap-head">
    <span class="jsk-cap-icon">[CARD]</span>
    <div>
      <div class="jsk-cap-title">${esc(p.name || '未命名插件')}</div>
      <div class="jsk-cap-sub">后台逻辑插件 · 本身不生成可见界面</div>
    </div>
  </div>

  <div class="jsk-cap-note">
    它不会在页面上画出任何东西，而是<strong>在特定时机自动运行</strong>，
    处理消息、变量或文件。看不到界面是正常的。
  </div>

  ${probe.needsLlm ? `<div class="jsk-cap-warn">
    [!] 这个插件会调用模型（如 <code>generateQuietPrompt</code>）。
    预览环境不联网、不消耗额度，因此无法展示它的实际输出。
  </div>` : ''}

  <div class="jsk-cap-sec">
    <h3>[EVENT] 运行时机会在这些时候生效</h3>
    ${evs.length ? `<ul class="jsk-list">${evRows}</ul>` : '<div class="jsk-empty">未检测到事件监听（可能由用户手动触发命令）。</div>'}
  </div>

  ${cmds.length ? `<div class="jsk-cap-sec">
    <h3>[CMD] 它注册了这些命令</h3>
    <div class="jsk-cmds">${cmdChips}</div>
    <div class="jsk-hint">在酒馆聊天框输入这些命令即可触发。</div>
  </div>` : ''}

  <div class="jsk-cap-sec">
    <h3>[API] 它会读写这些能力</h3>
    ${apis.length ? `<ul class="jsk-list">${apiRows}</ul>` : '<div class="jsk-empty">未检测到明确的 API 调用。</div>'}
  </div>

  <div class="jsk-cap-foot">
    <span class="jsk-hint">这是根据源码静态分析得出的结论，仅供参考。</span>
  </div>
</div>`;
}

/** 能力卡专用样式（可内联到任何容器） */
export function capabilityCardCss() {
  return `
.jsk-cap{padding:16px 18px;color:var(--SmartThemeBodyColor,#dcdcdc);font-size:13px;line-height:1.7;
  background:var(--SmartThemeBlurTintColor,#18181b);}
.jsk-cap-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:10px;
  border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.15));}
.jsk-cap-icon{font-size:22px;}
.jsk-cap-title{font-size:15px;font-weight:700;}
.jsk-cap-sub{font-size:11px;opacity:.65;}
.jsk-cap-note{padding:10px 12px;border-radius:8px;margin-bottom:12px;
  background:var(--SmartThemeBotMesBlurTintColor,#202026);border-left:3px solid var(--SmartThemeEmColor,#8ab4f8);}
.jsk-cap-warn{padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:12px;
  background:rgba(217,119,6,.12);border-left:3px solid #d97706;}
.jsk-cap-sec{margin:14px 0;}
.jsk-cap-sec h3{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.03em;
  color:var(--SmartThemeEmColor,#8ab4f8);}
.jsk-list{margin:0;padding-left:18px;}
.jsk-list li{margin:2px 0;}
.jsk-list code{font-size:12px;padding:1px 5px;border-radius:4px;
  background:rgba(255,255,255,.08);color:var(--SmartThemeQuoteColor,#7ac0ff);}
.jsk-hint{font-size:11px;opacity:.6;}
.jsk-cmds{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;}
.jsk-cmd{padding:2px 10px;border-radius:999px;font-size:11px;
  background:var(--SmartThemeBotMesBlurTintColor,#202026);
  border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.15));}
.jsk-empty{font-size:12px;opacity:.55;padding:4px 0;}
.jsk-cap-foot{margin-top:14px;padding-top:10px;
  border-top:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.15));}
`;
}
