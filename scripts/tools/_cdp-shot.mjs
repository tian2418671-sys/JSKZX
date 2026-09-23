/**
 * CDP 截图小工具（dev 模式视觉核对用，P2 的「截图对照」防线；用后可删）
 * 用法：$env:CDP_PORT="9368"; $env:SHOT_OUT="C:\Temp\menu-view.png"; node scripts/tools/_cdp-shot.mjs
 *      可选 $env:EXPR 先执行一段准备脚本（如强制展开某个下拉菜单）
 */
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9338);
const OUT = process.env.SHOT_OUT || 'shot.png';
const EXPR = process.env.EXPR || '';
let sock; let msgId = 0; const pending = new Map();

async function getWs() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');
    return page.webSocketDebuggerUrl;
}
function connect(wsUrl) {
    return new Promise((res, rej) => {
        sock = new WebSocket(wsUrl);
        sock.onopen = res;
        sock.onerror = rej;
        sock.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id); pending.delete(m.id);
                m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
            }
        };
    });
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
(async () => {
    await connect(await getWs());
    await send('Runtime.enable');
    await send('Page.enable');
    if (EXPR) {
        const prep = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
        if (prep.exceptionDetails) {
            console.log('PREP_EXCEPTION:', prep.exceptionDetails.exception?.description || prep.exceptionDetails.text);
            process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ saved: OUT, bytes: fs.statSync(OUT).size }));
    process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
