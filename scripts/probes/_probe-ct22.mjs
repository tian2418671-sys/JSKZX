/**
 * CT-22 验证探针：连 CDP → 打开揽仙录 → 进测卡聊天 → 检查消息分段与 DOM
 */
const BASE = 'http://127.0.0.1:9380';

const list = await (await fetch(`${BASE}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('index.html')) || list.find(t => t.type === 'page');
if (!page) { console.log('没找到页面'); process.exit(1); }
console.log('页面:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await new Promise(res => { ws.onopen = res; });
await send('Runtime.enable');

const C = `(()=>{const v=document.querySelector('#app').__vue_app__;return v._container._vnode.component.provides.appCtx})()`;

console.log('appCtx 可用:', await ev(`!!(${C})`));
console.log('卡片总数:', await ev(`(${C}).cards.value.length`));

// 找揽仙录
const found = await ev(`(()=>{const c=(${C}).cards.value;const i=c.findIndex(x=>/揽仙录/.test(x.name||''));return i;})()`);
console.log('揽仙录索引:', found);

if (found >= 0) {
    await ev(`(${C}).selectCard((${C}).cards.value[${found}])`);
    await sleep(2500);
    console.log('已选卡:', await ev(`(${C}).selectedCard.value && (${C}).selectedCard.value.name`));

    // 切到测卡/聊天 tab
    console.log('可用视图:', await ev(`JSON.stringify((${C}).activeView.value)`));
    await ev(`(${C}).setView && (${C}).setView('chat')`);
    await sleep(3000);
    console.log('当前视图:', await ev(`JSON.stringify((${C}).activeView.value)`));

    const info = await ev(`(()=>{
        const c = ${C};
        const msgs = (c.chatMessages && c.chatMessages.value) || [];
        return JSON.stringify({
            msgCount: msgs.length,
            first: msgs[0] ? {
                role: msgs[0].role,
                contentLen: (msgs[0].content||'').length,
                swipes: (msgs[0].swipes||[]).map(s=>({len:s.length, head:s.slice(0,60)}))
            } : null
        });
    })()`);
    console.log('消息状态:', info);

    const dom = await ev(`(()=>{
        const bubbles = document.querySelectorAll('.seg-text, .seg-html');
        const arr = [];
        bubbles.forEach((el,i)=>{ if(i<6) arr.push({cls: el.className, len: (el.textContent||'').length, head: (el.textContent||'').slice(0,70)}); });
        return JSON.stringify({count: bubbles.length, sample: arr, hasReplaceCode: document.body.innerText.includes("replace(/\\\\s*")});
    })()`);
    console.log('DOM 渲染:', dom);

    const iframes = await ev(`(()=>{const f=document.querySelectorAll('iframe');return JSON.stringify([...f].map(x=>({cls:x.className, srcLen:(x.getAttribute('srcdoc')||x.getAttribute('src')||'').length})));})()`);
    console.log('iframe 段:', iframes);
}

await send('Runtime.evaluate', { expression: '1' });
console.log('\n=== 错误日志 ===');
ws.close();
process.exit(0);
