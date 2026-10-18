/**
 * 批量实机验证面板：卡名来自真实文件扫描（不依赖渲染层 data 是否已加载）
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:9380';
const LIB = 'E:\\AI\\酒馆工具\\角色卡';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCard(file) {
    const buf = fs.readFileSync(file);
    let off = 8, data = null;
    while (off < buf.length - 8) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (type === 'tEXt') {
            const chunk = buf.toString('utf8', off + 8, off + 8 + len);
            const z = chunk.indexOf('\0');
            if (chunk.slice(0, z) === 'chara') data = Buffer.from(chunk.slice(z + 1), 'base64').toString('utf8');
        }
        if (type === 'IEND') break;
        off += 12 + len;
        if (len > buf.length) break;
    }
    return data ? JSON.parse(data) : null;
}

const targets = [];
for (const f of fs.readdirSync(LIB).filter((x) => /\.png$/i.test(x))) {
    let card;
    try { card = readCard(path.join(LIB, f)); } catch { continue; }
    if (!card) continue;
    const d = card.data || card;
    const rs = (d.extensions && d.extensions.regex_scripts) || d.regex_scripts || [];
    const big = rs.filter((r) => String(r.replaceString || '').length > 20000);
    if (big.length) {
        targets.push({
            file: f,
            name: d.name || card.name || f.replace(/\.png$/i, ''),
            panelChars: big.reduce((s, r) => s + String(r.replaceString || '').length, 0)
        });
    }
}
targets.sort((a, b) => b.panelChars - a.panelChars);
console.log('有大型面板的卡:', targets.length);
targets.slice(0, 8).forEach((t) => console.log(`  · ${t.name}  (${Math.round(t.panelChars / 1024)}KB 面板)`));

const list = await (await fetch(`${BASE}/json/list`)).json();
const main = list.find((t) => t.type === 'page');
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0; const P = new Map();
const send = (m, p) => new Promise((r, j) => { const i = ++id; P.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
};
const C = `(()=>{const v=document.querySelector('#app').__vue_app__;return v._container._vnode.component.provides.appCtx})()`;
for (let i = 0; i < 40; i++) {
    const n = await ev(`(${C}).library.value?.length ?? -1`);
    if (typeof n === 'number' && n > 0) { console.log('卡片库已就绪:', n); break; }
    await sleep(1000);
}

const results = [];
for (const t of targets.slice(0, 6)) {
    const clicked = await ev(`(()=>{
      const nm=${JSON.stringify(t.name)};
      const els=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').trim()===nm && e.children.length<=3);
      if(!els.length) return 'not-found';
      let el=els[0], x=el;
      for(let i=0;i<6&&x;i++){ if(x.tagName==='BUTTON'||/cursor-pointer|group relative/.test(x.className||'')){el=x;break;} x=x.parentElement; }
      el.click(); return 'ok';
    })()`);
    await sleep(2500);
    await ev(`(()=>{ if(typeof (${C}).openChatTab==='function') (${C}).openChatTab(); })()`);
    await sleep(4000);

    const now = await (await fetch(`${BASE}/json/list`)).json();
    const fr = now.find((x) => x.type === 'iframe');
    let info = { ok: false, reason: 'no-iframe', appLen: -1, errs: [], txt: '' };
    if (fr) {
        const fws = new WebSocket(fr.webSocketDebuggerUrl);
        let fid = 0; const FP = new Map(); const evs = [];
        const fsend = (m, p) => new Promise((r, j) => { const i = ++fid; FP.set(i, { r, j }); fws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
        fws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && FP.has(m.id)) { const p = FP.get(m.id); FP.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); }
            else if (m.method) evs.push(m);
        };
        await new Promise((r) => { fws.onopen = r; });
        await fsend('Runtime.enable');
        await sleep(1500);
        const fEv = async (x) => { const r = await fsend('Runtime.evaluate', { expression: x, returnByValue: true }); return r.exceptionDetails ? { __err: r.exceptionDetails.text } : r.result.value; };
        const appLen = await fEv(`(()=>{const a=document.getElementById('app');return a?a.innerHTML.length:-1})()`);
        const errs = evs.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
            .map((e) => (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 150));
        const excs = evs.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => String(e.params.exceptionDetails.text || '').slice(0, 150));
        const txt = await fEv(`document.body?document.body.innerText.slice(0,200):''`);
        info = { ok: typeof appLen === 'number' && appLen > 20, appLen, errs: [...errs, ...excs], txt };
        fws.close();
    }
    results.push({ name: t.name, clicked, ...info });
    console.log(`\n[${t.name}] 点击=${clicked} #app=${info.appLen} ${info.ok ? '✅' : '❌'}`);
    if (info.errs && info.errs.length) info.errs.slice(0, 3).forEach((e) => console.log('   ⚠', e));
    if (info.txt) console.log('   正文:', JSON.stringify(String(info.txt).replace(/\s+/g, ' ').slice(0, 110)));
}

console.log('\n===== 汇总 =====');
const bad = results.filter((r) => !r.ok);
console.log(`通过 ${results.length - bad.length}/${results.length}`);
fs.writeFileSync(process.env.TEMP + '\\panel-batch.json', JSON.stringify(results, null, 1), 'utf8');
process.exit(0);
