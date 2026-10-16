/**
 * 阶段⑤⑥（世界书 + AI 打标全链路）实测公共库
 * 真实鼠标点按 + 截图（走 CDP Input 事件，命中测试真实）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PORT = Number(process.env.CDP_PORT || 9375);
export const SHOT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'jsk-manual-test');
fs.mkdirSync(SHOT, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(prefix = 'b56') {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可调试页面');
    const s = new WebSocket(page.webSocketDebuggerUrl);
    let i = 0; const q = new Map();
    s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
    await new Promise((r) => { s.onopen = r; });
    const send = (me, pa, t = 30000) => new Promise((res, rej) => { const id = ++i; const tm = setTimeout(() => { q.delete(id); rej(new Error('CDP 超时 ' + me)); }, t); q.set(id, (m) => { clearTimeout(tm); res(m); }); s.send(JSON.stringify({ id, method: me, params: pa })); });
    const ev = async (x, t) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, t).catch((e) => ({ __cdpErr: e.message })); const r = m.result || {}; if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result ? (r.result.value !== undefined ? r.result.value : null) : null; };
    let n = 0;
    const shot = async (name) => {
        n++;
        const f = path.join(SHOT, `${prefix}-${String(n).padStart(2, '0')}-${String(name).replace(/[\\/:*?"<>|]/g, '_')}.png`);
        for (let a = 0; a < 3; a++) {
            try { const m = await send('Page.captureScreenshot', { format: 'png' }, 20000); const d = m.result && m.result.data; if (d) { fs.writeFileSync(f, Buffer.from(d, 'base64')); console.log('   📷', f); return f; } } catch (e) { await sleep(700); }
        }
        console.log('   ⚠️ 截图失败:', name); return null;
    };
    const clickAt = async (x, y, wait = 420) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await sleep(40);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(wait);
    };
    const locate = async ({ text, tag = '', nth = 0, exact = false, scope = '', fallback = 'button,[role="button"],a,label,summary' }) => {
        const expr = `(function(){
          var tagSel = ${JSON.stringify(tag || fallback)};
          var want = ${JSON.stringify(text)};
          var exact = ${exact ? 'true' : 'false'};
          var nth = ${nth};
          var scopeSel = ${JSON.stringify(scope)};
          var root = scopeSel ? document.querySelector(scopeSel) : document;
          if (!root) return JSON.stringify({ err: 'scope 未找到: ' + scopeSel });
          var all = Array.prototype.slice.call(root.querySelectorAll(tagSel));
          var hits = all.filter(function (el) {
            var t = String(el.textContent || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
            if (!t) return false;
            var okText = exact ? (t === want) : (t.indexOf(want) >= 0);
            if (!okText) return false;
            var r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            var st = window.getComputedStyle(el);
            if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
            return true;
          });
          if (!hits.length) return JSON.stringify({ err: '未找到元素: ' + want, candidates: all.slice(0, 80).map(function(e){ return String(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,26); }).filter(Boolean) });
          var el = hits[Math.min(nth, hits.length - 1)];
          el.scrollIntoView({ block: 'center', inline: 'center' });
          var r2 = el.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2), w: Math.round(r2.width), h: Math.round(r2.height), tag: el.tagName, cls: String(el.className||'').slice(0,60), text: String(el.textContent || el.value || el.getAttribute('title') || '').replace(/\\s+/g,' ').trim().slice(0, 60), total: hits.length });
        })()`;
        const raw = await ev(expr);
        try { return JSON.parse(raw); } catch (e) { return { err: 'locate 解析失败: ' + String(raw).slice(0, 140) }; }
    };
    const clickText = async (text, opts = {}) => {
        const box = await locate(Object.assign({ text }, opts));
        if (box.err) { console.log(`   ⚠️ 点击「${text}」失败：${box.err}`); if (box.candidates) console.log('      候选：', box.candidates.slice(0, 20).join(' | ')); return { ok: false, err: box.err }; }
        await clickAt(box.x, box.y, opts.wait || 420);
        console.log(`   🖱️ 点击「${box.text}」 @(${box.x},${box.y})${box.total > 1 ? ' [共' + box.total + '个匹配,取第' + ((opts.nth || 0) + 1) + ']' : ''}`);
        return { ok: true, ...box };
    };
    const typeText = async (text, value) => {
        const box = await locate({ text, tag: 'input,textarea', fallback: 'input,textarea' });
        if (box.err) { console.log('   ⚠️ 输入框未找到：' + box.err); return false; }
        await clickAt(box.x, box.y, 150);
        // 全选清空
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await sleep(80);
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await sleep(80);
        for (const ch of String(value)) {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
            await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
            await sleep(12);
        }
        await sleep(250);
        return true;
    };
    const modalOpen = (kw) => ev(`(function(){ return (document.body.innerText||'').indexOf(${JSON.stringify(kw)})>=0; })()`);
    const bodyText = () => ev(`(function(){ return String(document.body.innerText||''); })()`);
    return { send, ev, shot, clickAt, locate, clickText, typeText, modalOpen, bodyText, done: () => process.exit(0) };
}

export const CTX = `(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;return (app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx)))||null;})()`;

export function reporter(title) {
    const rows = [];
    const step = (ok, name, detail = '') => { rows.push({ ok, name, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + String(detail).slice(0, 400) : ''}`); };
    const summary = () => {
        const pass = rows.filter((r) => r.ok).length;
        console.log(`\n═════ ${title}：${pass}/${rows.length} 通过 ═════`);
        rows.filter((r) => !r.ok).forEach((r) => console.log('  ❌ ' + r.name + '  ' + String(r.detail).slice(0, 200)));
        console.log('截图目录:', SHOT);
        return { pass, total: rows.length, rows };
    };
    return { step, summary, rows };
}
