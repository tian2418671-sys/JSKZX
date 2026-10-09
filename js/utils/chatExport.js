/**
 * ⬇️ 测卡会话导出（纯函数 · 可单测 · **不依赖 DOM/Electron**）
 *
 * 来历（2026-10-03 · 五功能升级之一）：把「聊天测试」里跑出来的会话导出为 Markdown / HTML / 纯文本，
 *   用于留档 / 分享 / 复盘；顺带与「一键质检流水线」的报告导出共用主进程 `file:saveTextFile` 通道。
 *
 * 口径（与规格 `docs/规格与计划/测卡工作区/测试会话导出-实现规格.md` 对齐）：
 *   · **导出当前激活的 swipe 分支**（与界面所见一致）—— 文本取值统一走 `messageText(m)`；
 *   · 三种格式**元信息头一致**：卡名 / 会话标题 / 导出时间 / 模型 / 预设（有则记）；
 *   · Markdown：每条 `### 角色名 · 时间`；HTML 段附提示 + 纯文本摘要；末尾可选变量快照（```yaml）；
 *   · HTML：单文件、`<meta charset>`、**内联导出模板样式**（不求与面板像素一致，避免 UI 演进就改导出）；
 *     HTML 段包进 `<section class="seg-html">`，用 **sandbox iframe + srcdoc** 承载（与面板同口径：可渲染、脚本隔离）；
 *   · 纯文本：`[角色名] 正文` 顺序拼接；
 *   · 文件名：`会话_<卡名>_<yyyyMMdd-HHmm>.<ext>`（清洗 Windows 非法字符、整名截断 80）。
 *
 * ⚠️ 本模块**只产生字符串**：不写文件、不读配置、不碰 DOM。
 */
import { messageText } from '../composables/chat/useChatSwipe.js';
import { segmentMessage, promoteHtmlSegments } from '../composables/chat/useChatRender.js';

/** 导出格式表（UI 下拉 / 保存对话框过滤器共用同一份定义，避免两处不一致） */
export const EXPORT_FORMATS = [
    { id: 'md', label: 'Markdown', ext: 'md', filterName: 'Markdown 文件', mime: 'text/markdown' },
    { id: 'html', label: 'HTML 单文件', ext: 'html', filterName: 'HTML 文件', mime: 'text/html' },
    { id: 'txt', label: '纯文本', ext: 'txt', filterName: '文本文件', mime: 'text/plain' }
];

/** 超长会话提醒阈值（规格 §3.4：>10MB 文本先确认） */
export const LARGE_EXPORT_BYTES = 10 * 1024 * 1024;

/** 是否需要先确认（超长会话） */
export function isLargeExport(text) {
    return String(text == null ? '' : text).length > LARGE_EXPORT_BYTES;
}

/** 清洗文件名（Windows 非法字符 → `_`；去首尾空白与末尾点；整名截断） */
export function sanitizeFileName(name, max = 80) {
    const cleaned = String(name == null ? '' : name)
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');
    const out = cleaned || '未命名';
    return out.length > max ? out.slice(0, max) : out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 时间输入 → Date（缺省=现在；毫秒数=按毫秒；其他可解析字符串按 Date 解析）
 * 不可解析时返回 null，由调用方决定兜底文案（避免"脏值静默变成现在"）。
 */
function toDate(ts) {
    if (ts === undefined || ts === null || ts === '') return new Date();
    const n = Number(ts);
    if (Number.isFinite(n) && n > 0) return new Date(n);
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 时间戳 → `yyyyMMdd-HHmm`（本地时区；不可解析 → `00000000-0000`） */
export function formatStamp(ts) {
    const d = toDate(ts);
    if (!d) return '00000000-0000';
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** 时间戳 → `yyyy-MM-dd HH:mm:ss`（元信息头用；不可解析 → `—`） */
export function formatDateTime(ts) {
    const d = toDate(ts);
    if (!d) return '—';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 导出文件名：`会话_<卡名>_<stamp>.<ext>`（卡名为空时退回会话名） */
export function buildExportFileName({ cardName = '', sessionName = '', format = 'md', now = Date.now() } = {}) {
    const fmt = EXPORT_FORMATS.find((f) => f.id === format) || EXPORT_FORMATS[0];
    const who = String(cardName || '').trim() || String(sessionName || '').trim() || '会话';
    return sanitizeFileName(`会话_${who}_${formatStamp(now)}.${fmt.ext}`);
}

/** 角色显示名（assistant = 卡名 / user = 用户名 / system = 系统） */
export function roleLabel(role, opts = {}) {
    const r = String(role || '').toLowerCase();
    if (r === 'assistant') return String(opts.charName || '').trim() || 'AI';
    if (r === 'user') return String(opts.userName || '').trim() || '你';
    if (r === 'system') return '系统';
    return r || '未知';
}

/** 消息的单条模型：{ index, role, label, time, text, segments } */
export function toMessageView(m, index, opts = {}) {
    const text = String(messageText(m) || '');
    let segments = [];
    try { segments = promoteHtmlSegments(segmentMessage(text)) || []; } catch (e) { segments = [{ type: 'text', content: text }]; }
    const ts = (m && (m.time || m.timestamp || m.createdAt)) || opts.sessionTime || 0;
    return {
        index,
        role: String((m && m.role) || '').toLowerCase(),
        label: roleLabel(m && m.role, opts),
        time: ts ? formatDateTime(ts) : '',
        text,
        segments
    };
}

/** 会话 → 视图模型（元信息 + 逐条消息） */
export function toSessionView(session, opts = {}) {
    const s = session || {};
    const messages = Array.isArray(s.messages) ? s.messages : [];
    const view = messages.map((m, i) => toMessageView(m, i, { ...opts, sessionTime: s.updatedAt || s.createdAt }));
    return {
        title: String(s.name || '未命名会话'),
        cardPath: String(s.cardPath || ''),
        cardName: String(opts.charName || '').trim() || '',
        userName: String(opts.userName || '').trim() || '你',
        model: String(opts.model || '').trim(),
        preset: String(opts.preset || '').trim(),
        exportedAt: formatDateTime(opts.now || Date.now()),
        messages: view,
        varsSnapshot: String(opts.varsSnapshot || '').trim()
    };
}

/** HTML 属性转义（用于 srcdoc / src） */
export function escapeAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** HTML 文本转义 */
export function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 去 HTML 标签取纯文本摘要（导出给 Markdown 用的「HTML 段内容摘要」） */
export function htmlToPlain(html, max = 400) {
    const t = String(html == null ? '' : html)
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 内置 Markdown 子集渲染（**导出模板用**，不求与面板像素一致）。
 * 宿主可注入更精确的渲染器（`opts.renderText`，如面板同款 renderChatHtml）覆盖本实现。
 */
export function miniMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let inCode = false;
    let buf = [];
    const flushBuf = () => {
        if (!buf.length) return;
        const para = buf.join('\n');
        out.push('<p>' + inlineMd(escapeHtml(para)).replace(/\n/g, '<br>') + '</p>');
        buf = [];
    };
    for (const raw of lines) {
        const line = raw;
        if (/^\s*```/.test(line)) {
            if (inCode) { out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>'); buf = []; inCode = false; }
            else { flushBuf(); inCode = true; }
            continue;
        }
        if (inCode) { buf.push(line); continue; }
        const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
        if (h) { flushBuf(); const lv = h[1].length; out.push(`<h${lv}>` + inlineMd(escapeHtml(h[2])) + `</h${lv}>`); continue; }
        if (!line.trim()) { flushBuf(); continue; }
        buf.push(line);
    }
    if (inCode && buf.length) out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
    flushBuf();
    return out.join('\n');
}

/** 行内 Markdown：**粗** / *斜* / `代码`（输入已转义） */
function inlineMd(s) {
    return String(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

// ───────────────────────── 三种格式 ─────────────────────────

/** 纯文本：元信息头 + `[角色名] 正文` */
export function buildSessionPlainText(session, opts = {}) {
    const v = toSessionView(session, opts);
    const head = [
        `会话：${v.title}`,
        v.cardName ? `卡片：${v.cardName}` : '',
        `导出时间：${v.exportedAt}`,
        v.model ? `模型：${v.model}` : '',
        v.preset ? `预设：${v.preset}` : '',
        `消息数：${v.messages.length}`
    ].filter(Boolean).join('\n');
    const body = v.messages.map((m) => `[${m.label}] ${m.text}`).join('\n\n');
    const vars = (opts.includeVars !== false && v.varsSnapshot) ? `\n\n── 变量快照 ──\n${v.varsSnapshot}` : '';
    return `${head}\n\n${'─'.repeat(24)}\n\n${body}${vars}\n`;
}

/** Markdown：`### 角色名 · 时间` + HTML 段提示/摘要 + 末尾可选 yaml 变量快照 */
export function buildSessionMarkdown(session, opts = {}) {
    const v = toSessionView(session, opts);
    const lines = [];
    lines.push(`# ${v.title}`, '');
    lines.push('| 项 | 值 |', '| --- | --- |');
    lines.push(`| 卡片 | ${v.cardName || '—'} |`);
    lines.push(`| 导出时间 | ${v.exportedAt} |`);
    if (v.model) lines.push(`| 模型 | ${v.model} |`);
    if (v.preset) lines.push(`| 预设 | ${v.preset} |`);
    lines.push(`| 消息数 | ${v.messages.length} |`, '');
    for (const m of v.messages) {
        lines.push(`### ${m.label}${m.time ? ' · ' + m.time : ''}`, '');
        for (const seg of m.segments) {
            if (seg.type === 'text') {
                lines.push(String(seg.content || '').trim() || '（空）', '');
            } else if (seg.type === 'loader') {
                lines.push(`> 🌐 外链界面（导出文件不联网时无法加载）：\`${seg.url || ''}\``, '');
            } else {
                lines.push('> ⛩️ HTML 渲染内容（请用 HTML 版查看完整效果）', '');
                const sum = htmlToPlain(seg.content);
                if (sum) lines.push('> ' + sum, '');
            }
        }
    }
    if (opts.includeVars !== false && v.varsSnapshot) {
        lines.push('## 变量快照', '', '```yaml', v.varsSnapshot, '```', '');
    }
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

/** HTML 单文件（内联导出模板样式；HTML 段用 sandbox iframe 承载，脚本隔离） */
export function buildSessionHtml(session, opts = {}) {
    const v = toSessionView(session, opts);
    const renderText = (typeof opts.renderText === 'function') ? opts.renderText : miniMarkdown;
    const parts = [];
    parts.push('<!DOCTYPE html>');
    parts.push('<html lang="zh-CN">');
    parts.push('<head>');
    parts.push('<meta charset="utf-8">');
    parts.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
    parts.push(`<title>${escapeHtml(v.title)}${v.cardName ? ' · ' + escapeHtml(v.cardName) : ''}</title>`);
    parts.push('<style>' + EXPORT_CSS + '</style>');
    parts.push('</head>');
    parts.push('<body>');
    parts.push(`<header class="doc-head"><h1>${escapeHtml(v.title)}</h1><ul class="meta">`);
    parts.push(`<li>卡片：${escapeHtml(v.cardName || '—')}</li>`);
    parts.push(`<li>导出时间：${escapeHtml(v.exportedAt)}</li>`);
    if (v.model) parts.push(`<li>模型：${escapeHtml(v.model)}</li>`);
    if (v.preset) parts.push(`<li>预设：${escapeHtml(v.preset)}</li>`);
    parts.push(`<li>消息数：${v.messages.length}</li>`);
    parts.push('</ul></header>');
    parts.push('<main>');
    for (const m of v.messages) {
        const cls = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : 'system');
        parts.push(`<article class="msg ${cls}">`);
        parts.push(`<header class="msg-head"><span class="who">${escapeHtml(m.label)}</span>${m.time ? `<span class="time">${escapeHtml(m.time)}</span>` : ''}</header>`);
        parts.push('<div class="msg-body">');
        for (const seg of m.segments) {
            if (seg.type === 'text') {
                let html = '';
                try { html = String(renderText(String(seg.content || '')) || ''); } catch (e) { html = miniMarkdown(seg.content); }
                parts.push(`<section class="seg-text">${html}</section>`);
            } else if (seg.type === 'loader') {
                parts.push(`<section class="seg-html"><iframe class="seg-iframe" src="${escapeAttr(seg.url || '')}" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe>`);
                parts.push(`<p class="seg-note">🌐 外链界面：断网时不会加载</p></section>`);
            } else {
                parts.push(`<section class="seg-html"><iframe class="seg-iframe" sandbox="allow-scripts" srcdoc="${escapeAttr(seg.content || '')}"></iframe></section>`);
            }
        }
        parts.push('</div></article>');
    }
    parts.push('</main>');
    if (opts.includeVars !== false && v.varsSnapshot) {
        parts.push(`<details class="vars"><summary>变量快照</summary><pre>${escapeHtml(v.varsSnapshot)}</pre></details>`);
    }
    parts.push(`<footer class="doc-foot">由「JSK 管理 · 测卡」导出 · ${escapeHtml(v.exportedAt)}</footer>`);
    parts.push('</body></html>');
    return parts.join('\n');
}

/** 导出模板样式（**固定模板**，不随面板 UI 演进 —— 规格 §五） */
export const EXPORT_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px; background: #fafafa; color: #1f2937;
  font: 14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif; }
.doc-head { max-width: 900px; margin: 0 auto 20px; }
.doc-head h1 { font-size: 20px; margin: 0 0 8px; }
.meta { list-style: none; padding: 0; margin: 0; color: #6b7280; font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
main { max-width: 900px; margin: 0 auto; }
.msg { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; margin: 0 0 14px; overflow: hidden; }
.msg.user { border-color: #bfdbfe; }
.msg.assistant { border-color: #ddd6fe; }
.msg-head { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px;
  background: #f3f4f6; border-bottom: 1px solid #e5e7eb; font-size: 12px; }
.msg.user .msg-head { background: #eff6ff; }
.msg.assistant .msg-head { background: #f5f3ff; }
.who { font-weight: 700; }
.time { color: #9ca3af; }
.msg-body { padding: 12px; }
.seg-text > :first-child { margin-top: 0; }
.seg-text > :last-child { margin-bottom: 0; }
.seg-text pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; overflow: auto; }
.seg-text code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.seg-html { margin: 10px 0; }
.seg-iframe { width: 100%; height: 420px; border: 1px dashed #d1d5db; border-radius: 8px; background: #fff; }
.seg-note { color: #9ca3af; font-size: 11px; margin: 4px 0 0; }
.vars { max-width: 900px; margin: 20px auto 0; font-size: 12px; }
.vars pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; overflow: auto; }
.doc-foot { max-width: 900px; margin: 24px auto 0; color: #9ca3af; font-size: 11px; text-align: center; }
@media (prefers-color-scheme: dark) {
  body { background: #0f172a; color: #e2e8f0; }
  .msg { background: #1e293b; border-color: #334155; }
  .msg-head { background: #334155; border-color: #475569; }
  .msg.user .msg-head, .msg.assistant .msg-head { background: #334155; }
  .seg-text pre, .vars pre { background: #0f172a; border-color: #334155; }
  .seg-iframe { border-color: #475569; background: #fff; }
}
`.trim();

/** 格式 → 文本（统一入口；未知格式退回 Markdown） */
export function buildSessionExport(session, format, opts = {}) {
    if (format === 'html') return buildSessionHtml(session, opts);
    if (format === 'txt') return buildSessionPlainText(session, opts);
    return buildSessionMarkdown(session, opts);
}

/**
 * 变量树 → yaml 文本（供导出的「变量快照」用；嵌套对象/数组展开为 `a.b[0].c: 值`）
 * @param {*} value
 * @param {string} [prefix]
 * @param {string[]} [out]
 */
export function varsToYaml(value, prefix = '', out = []) {
    if (value === null || value === undefined) {
        out.push(`${prefix || 'value'}: null`);
        return out.join('\n');
    }
    if (Array.isArray(value)) {
        if (!value.length) out.push(`${prefix || 'value'}: []`);
        else value.forEach((v, i) => varsToYaml(v, `${prefix}[${i}]`, out));
        return out.join('\n');
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) out.push(`${prefix || 'value'}: {}`);
        else for (const k of keys) varsToYaml(value[k], prefix ? `${prefix}.${k}` : k, out);
        return out.join('\n');
    }
    const isStr = typeof value === 'string';
    const needQuote = isStr && (value === '' || /[:#{}\[\],&*?|<>=!%@`"'\n]/.test(value) || /^\s|\s$/.test(value));
    out.push(`${prefix || 'value'}: ${isStr ? (needQuote ? JSON.stringify(value) : value) : String(value)}`);
    return out.join('\n');
}
