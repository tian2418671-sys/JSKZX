/**
 * 👀 手动操作用户会话 · 后台监控
 *
 * 作用：用户亲自操作软件时，在后台持续记录「可复盘」的证据：
 *   · **异常/告警**：`Runtime.exceptionThrown`（未捕获异常）、`Runtime.consoleAPICalled`（含 `[Vue 错误]` / `[Vue warn]`）、`Log.entryAdded`（error/warning）
 *   · **状态变化**：每 2 秒采样一次，只在**发生变化**时记录（视图模式 / 打开中的弹窗集合 / 当前卡 / toast / 新增日志行 / 质检步骤状态）
 *   · **定时截图**：每 30 秒一张（可关：SHOT=0），存到 SHOT_DIR，便于事后对照「你当时点了什么」
 *   · **断线重连**：app 崩溃/重启时记录时间点并持续尝试重连（最多等待 RECONNECT_MIN 分钟）
 *
 * 只读：不做任何点击、不改任何状态（截图与 DOM 采样都是只读操作）。
 * 用法：CDP_PORT=9375 node scripts/probes/_watch-manual-session.mjs
 * 输出：stdout（后台任务可读）+ 落盘 <SHOT_DIR>/session.log
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9375);
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'jsk-watch');
const SHOT = process.env.SHOT !== '0';
const SHOT_EVERY_MS = Number(process.env.SHOT_EVERY_MS || 30000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 2000);
const RECONNECT_MIN = Number(process.env.RECONNECT_MIN || 30);

fs.mkdirSync(SHOT_DIR, { recursive: true });
const LOG = path.join(SHOT_DIR, 'session.log');
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line) => { const s = `[${stamp()}] ${line}`; console.log(s); try { fs.appendFileSync(LOG, s + '\n', 'utf8'); } catch (e) { /* 忽略 */ } };

let ws = null, msgId = 0;
const pending = new Map();
let attached = false;
let lastShot = 0;
let shotNo = 0;
const errCount = { exception: 0, vueError: 0, warn: 0, console: 0 };

const KEYWORDS_ERR = /\[Vue 错误\]|Uncaught|TypeError|ReferenceError|Cannot read|is not defined|is not a function/i;
const BENIGN = /Electron Security Warning|DevTools|\[vite\] connect|favicon/i;

function sampleExpr() {
    return `(function(){
      try {
        var a = document.querySelector('#app');
        var app = a && a.__vue_app__;
        var c = app && ((app._context.provides.appCtx) || (app._container && app._container._vnode && app._container._vnode.component && app._container._vnode.component.provides && app._container._vnode.component.provides.appCtx));
        var t = document.body ? (document.body.innerText || '') : '';
        var modals = ['一键质检','整库冷备','启动自动任务','世界书合并 · 预览','智能版本查重中心','世界书智能版本对比中心','预设','内容查重','API 引擎','对比差异','文本查看','图片查看'].filter(function (k) { return t.indexOf(k) >= 0; });
        var logs = [];
        try { logs = ((c && c.editorLogs && c.editorLogs.value) || []).slice(0, 3).map(function (x) { return String(x.msg || ''); }); } catch (e) {}
        return JSON.stringify({
          mode: c && c.appMode ? c.appMode.value : '?',
          card: (c && c.cardData && c.cardData.value && c.cardData.value.data) ? String(c.cardData.value.data.name || '') : '',
          modals: modals,
          toasts: ((c && c.toasts && c.toasts.value) || []).map(function (x) { return String(x.message || '').slice(0, 60); }),
          logs: logs,
          qc: c && c.qcRunning ? String(c.qcRunning.value) : '?',
          scanning: c && c.isScanningDisk ? String(c.isScanningDisk.value) : '?'
        });
      } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
    })()`;
}

function onMessage(m) {
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    const { method, params } = m;
    if (method === 'Runtime.exceptionThrown') {
        errCount.exception++;
        const d = params.exceptionDetails || {};
        say(`‼️ 未捕获异常：${(d.exception && (d.exception.description || d.exception.value)) || d.text || '(无描述)'}`.slice(0, 400));
        return;
    }
    if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
        if (BENIGN.test(text)) return;
        if (params.type === 'error') {
            errCount.console++;
            say(`⛔ console.error：${text}`.slice(0, 400));
        } else if (params.type === 'warning') {
            if (KEYWORDS_ERR.test(text)) { errCount.vueError++; say(`⚠️ 控制台告警（可能是 Vue 错误）：${text}`.slice(0, 400)); }
            else { errCount.warn++; if (errCount.warn <= 40) say(`· 告警：${text}`.slice(0, 240)); }
        } else if (params.type === 'assert') {
            say(`❗ console.assert：${text}`.slice(0, 300));
        }
        return;
    }
    if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        if (e.level === 'error' && !BENIGN.test(String(e.text || ''))) { errCount.console++; say(`⛔ 日志错误：${e.text}`.slice(0, 400)); }
        return;
    }
}

const send = (me, pa, timeoutMs = 12000) => new Promise((res, rej) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 超时 ' + me)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id, method: me, params: pa }));
});

async function attach() {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = l.find((x) => x.type === 'page');
    if (!page) throw new Error('没有 page 目标');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('WS 打开失败')); });
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { /* 忽略 */ } };
    ws.onclose = () => { attached = false; say('🔌 CDP 连接断开（app 可能被关闭/重启）'); };
    await send('Runtime.enable', {});
    await send('Log.enable', {});
    await send('Page.enable', {});
    attached = true;
    say(`✅ 已连接监控：${page.title || '(无标题)'} · 截图每 ${SHOT ? SHOT_EVERY_MS / 1000 + 's' : '关闭'} · 采样每 ${SAMPLE_MS / 1000}s`);
    say(`📁 证据目录：${SHOT_DIR}`);
}

let lastState = '';
async function tick() {
    if (!attached) return;
    const r = await send('Runtime.evaluate', { expression: sampleExpr(), returnByValue: true, awaitPromise: true }, 8000).catch(() => null);
    const raw = r && r.result && r.result.result ? r.result.result.value : null;
    if (!raw) return;
    let st;
    try { st = JSON.parse(raw); } catch (e) { return; }
    const key = JSON.stringify(st);
    if (key !== lastState) {
        const prev = lastState ? JSON.parse(lastState) : {};
        const diff = [];
        if (prev.mode !== st.mode) diff.push(`视图 ${prev.mode} → ${st.mode}`);
        if (prev.card !== st.card) diff.push(`当前卡 ${prev.card || '(无)'} → ${st.card || '(无)'}`);
        if (JSON.stringify(prev.modals) !== JSON.stringify(st.modals)) diff.push(`弹窗 [${(prev.modals || []).join(',')}] → [${(st.modals || []).join(',')}]`);
        if (JSON.stringify(prev.toasts) !== JSON.stringify(st.toasts)) diff.push(`toast ${JSON.stringify(st.toasts)}`);
        if (prev.qc !== st.qc) diff.push(`质检运行=${st.qc}`);
        if (prev.scanning !== st.scanning) diff.push(`扫描中=${st.scanning}`);
        const newLogs = (st.logs || []).filter((x) => !(prev.logs || []).includes(x));
        if (newLogs.length) diff.push('新日志：' + newLogs.map((x) => x.slice(0, 80)).join(' | '));
        if (diff.length) say('🔎 ' + diff.join(' ｜ '));
        lastState = key;
    }
    if (SHOT && Date.now() - lastShot > SHOT_EVERY_MS) {
        lastShot = Date.now();
        shotNo++;
        try {
            const s = await send('Page.captureScreenshot', { format: 'png' }, 10000);
            const d = s && s.result && s.result.data;
            if (d) {
                const f = path.join(SHOT_DIR, `shot-${String(shotNo).padStart(3, '0')}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`);
                fs.writeFileSync(f, Buffer.from(d, 'base64'));
                if (shotNo % 5 === 0) say(`📷 已累计 ${shotNo} 张截图（最新 ${path.basename(f)}）`);
            }
        } catch (e) { /* 截图失败不致命 */ }
    }
}

// 主循环：连不上就等（用户可能还没打开 / 崩了重启中）
say(`👀 手动会话监控启动（端口 ${PORT}）—— 等待 app…`);
let waitedMin = 0;
while (waitedMin < RECONNECT_MIN) {
    if (!attached) {
        try { await attach(); waitedMin = 0; } catch (e) {
            waitedMin += 0.25;
            await new Promise((r) => setTimeout(r, 15000));
            if (waitedMin % 1 === 0) say(`… 仍在等待 app（已 ${waitedMin} 分钟）`);
            continue;
        }
    }
    try { await tick(); } catch (e) { /* 单次采样失败忽略 */ }
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
}
say(`⏹ 监控结束：异常 ${errCount.exception} · console.error ${errCount.console} · Vue 告警 ${errCount.vueError} · 其它告警 ${errCount.warn} · 截图 ${shotNo} 张 · 运行 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
process.exit(0);
