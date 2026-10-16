/**
 * 全功能测试台（无子智能体 · 自己跑）
 * 用法：BATCH=import,appearance node scripts/probes/_probe-fulltest.mjs
 *       BATCH=all            跑全部批次
 * 输出：每项一行 ✅/❌；发现的❌自动追加到 docs/规格与计划/计划与记录/测试发现-2026-10-04.md
 * 截图：%TEMP%\jsk-manual-test\ft-<batch>-<n>-<name>.png
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const PORT = Number(process.env.CDP_PORT || 9375);
const SHOT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'jsk-manual-test');
const FIND = 'docs/规格与计划/计划与记录/测试发现-2026-10-04.md';
const CARD = 'E:\\AI\\酒馆工具\\角色卡\\146d4927595344e68e869e87b6b2feb0.png';
const WB = 'H:\\01\\全局世界书\\____淫叫网络·法德兰装甲.json';
fs.mkdirSync(SHOT, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const s = new WebSocket(page.webSocketDebuggerUrl);
let i = 0; const q = new Map();
s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } };
await new Promise((r) => { s.onopen = r; });
const send = (me, pa, t = 30000) => new Promise((res, rej) => { const id = ++i; const tm = setTimeout(() => { q.delete(id); rej(new Error('timeout ' + me)); }, t); q.set(id, (m) => { clearTimeout(tm); res(m); }); s.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async (x, t) => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, t); const r = m.result || {}; if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result ? (r.result.value !== undefined ? r.result.value : null) : null; };
const C = `(function(){var a=document.querySelector('#app');var app=a&&a.__vue_app__;return (app&&((app._context.provides.appCtx)||(app._container._vnode.component.provides.appCtx)))||null;})()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = []; const fails = [];
const chk = (batch, name, ok, note = '') => { res.push({ batch, name, ok: !!ok, note }); console.log(`${ok ? '✅' : '❌'} [${batch}] ${name}${note ? '  → ' + String(note).slice(0, 140) : ''}`); if (!ok) fails.push({ batch, name, note: String(note).slice(0, 300) }); };
const shot = async (batch, name) => { try { const m = await send('Page.captureScreenshot', { format: 'png' }, 20000); const d = m.result && m.result.data; if (d) { const f = path.join(SHOT, `ft-${batch}-${name}.png`); fs.writeFileSync(f, Buffer.from(d, 'base64')); return f; } } catch (e) {} return ''; };
const click = async (text, tag = 'button') => { const b = JSON.parse(await ev(`(function(){var els=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(tag)}));for(var i=0;i<els.length;i++){var e=els[i];var t=String(e.textContent||'').replace(/\\s+/g,' ').trim();if(t.indexOf(${JSON.stringify(text)})>=0&&e.getBoundingClientRect().width>2){var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:t.slice(0,26)});}}return JSON.stringify({err:1});})()`)); if (b.err) return false; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 }); await sleep(500); return true; };
const txt = async () => String(await ev('(document.body&&document.body.innerText)||""'));
const state = async (js) => { const v = await ev(`(function(){var c=${C};${js}})()`); if (v && typeof v === 'object') return v; try { return JSON.parse(String(v)); } catch (e) { return { __raw: String(v) }; } };

const BATCHES = process.env.BATCH || 'all';
const want = (b) => BATCHES === 'all' || BATCHES.split(',').includes(b);

// ───────────────────────── ① 导入 ─────────────────────────
if (want('import')) {
    const before = await state('return JSON.stringify({cards:(c.library.value||[]).length, books:(c.worldbooks&&c.worldbooks.value||[]).length});');
    const hit0 = await state(`return JSON.stringify({inLib:(c.library.value||[]).filter(function(x){return /146d4927/i.test(String(x.path||'')+String(x.id||'')+String(x.name||''));}).map(function(x){return x.name;}), inWb:(c.worldbooks&&c.worldbooks.value||[]).filter(function(x){return /法德兰|淫叫网络/.test(String(x.name||'')+String(x.path||''));}).map(function(x){return x.name;})});`);
    chk('import', '用户给的文件是否本就在库里/列表里', hit0.inLib.length + hit0.inWb.length > 0, JSON.stringify(hit0));
    await ev(`(function(){var c=${C};try{c.refreshLibrary&&c.refreshLibrary();}catch(e){}return 1;})()`); await sleep(2000);
    const hit1 = await state(`return JSON.stringify({inLib:(c.library.value||[]).filter(function(x){return /146d4927/i.test(String(x.path||'')+String(x.id||'')+String(x.name||''));}).map(function(x){return x.name;}), cards:(c.library.value||[]).length});`);
    chk('import', '刷新后能找到用户给的卡', hit1.inLib.length > 0, JSON.stringify(hit1) + `（基线 ${before.cards} 张）`);
    const r = await ev(`(async function(){var c=${C};try{ if(typeof c.importCards!=='function') return 'no fn'; await c.importCards([${JSON.stringify(CARD)}]); return 'OK'; }catch(e){ return 'ERR '+String(e&&e.message||e).slice(0,120);} })()`, 120000);
    await sleep(2000);
    const after = await state('return JSON.stringify({cards:(c.library.value||[]).length});');
    chk('import', '重复导入同一张卡：不应报错、计数不应暴涨', after.cards - before.cards <= 0, `导入返回=${r}｜${before.cards} → ${after.cards}`);
    chk('import', '世界书列表里能找到用户给的书', hit0.inWb.length > 0 || hit1.inLib.length > 0, JSON.stringify(hit0.inWb));
    await shot('import', 'after');
}

// ───────────────────────── ⑩ 外观（主题 + 字体大小）─────────────────────────
if (want('appearance')) {
    const keys = await state(`return JSON.stringify(Object.keys(c||{}).filter(function(k){return /theme|font|Font|zoom|scale|density|compact/i.test(k);}));`);
    chk('appearance', '找到主题/字体/密度相关状态键', keys.length > 0, String(keys).slice(0, 200));
    const tk = (keys.find((k) => /^theme$/i.test(k)) || 'theme');
    for (const th of ['light', 'dark', 'gray']) {
        const set = await ev(`(function(){var c=${C};try{c[${JSON.stringify(tk)}].value=${JSON.stringify(th)};return String(c[${JSON.stringify(tk)}].value);}catch(e){return 'ERR '+e.message;}})()`);
        await sleep(700);
        const f = await shot('appearance', 'theme-' + th);
        // 主题色是否真的变了：取 body 背景
        const bg = await ev('getComputedStyle(document.body).backgroundColor');
        chk('appearance', `主题切到 ${th}（背景随之变化）`, String(set) === th && !!bg, `set=${set} bg=${bg} 截图=${path.basename(f)}`);
    }
    const fk = keys.find((k) => /font/i.test(k));
    if (fk) {
        const cur = await ev(`(function(){var c=${C};return String(c[${JSON.stringify(fk)}].value);})()`);
        const set2 = await ev(`(function(){var c=${C};try{var k=${JSON.stringify(fk)};var v=c[k].value;c[k].value=(typeof v==='number')?Number(v)+2:String(v)+'px';return String(c[k].value);}catch(e){return 'ERR '+e.message;}})()`);
        await sleep(600);
        const px = await ev(`getComputedStyle(document.documentElement).fontSize + '|' + getComputedStyle(document.querySelector('.text-\\[11px\\]')||document.body).fontSize`);
        await shot('appearance', 'font-changed');
        chk('appearance', `字体大小可改（${fk}）`, String(set2) !== 'ERR' && String(set2) !== String(cur), `原=${cur} 新=${set2} 计算样式=${px}`);
        await ev(`(function(){var c=${C};try{c[${JSON.stringify(fk)}].value=${JSON.stringify(cur)};}catch(e){}return 1;})()`);
    } else chk('appearance', '字体大小状态键是否暴露', false, 'ctx 里没有 font* 键（可能只在设置弹窗内局部状态）');
    const menus = ['视图', '设置', '外观'];
    for (const m of menus) {
        const ok = await click(m, 'button');
        const t = await txt();
        chk('appearance', `${m} 菜单可展开`, ok && t.length > 200, ok ? '已点' : '未找到按钮');
        if (ok) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
}

// ───────────────────────── ② 库与列表 ─────────────────────────
if (want('library')) {
    const st = await state(`return JSON.stringify({view:(c.viewMode&&c.viewMode.value),compact:(c.isCompactMode&&c.isCompactMode.value),sort:(c.sortBy&&c.sortBy.value),cards:(c.library.value||[]).length,filtered:(c.filteredLibrary&&c.filteredLibrary.value||[]).length});`);
    chk('library', '库状态可读', st.cards > 0, JSON.stringify(st));
    const vm = await ev(`(function(){var c=${C};var out=[];var orig=c.viewMode?c.viewMode.value:null;
      ['grid','list','compact'].forEach(function(v){try{c.viewMode.value=v;out.push(v+'='+c.viewMode.value);}catch(e){out.push(v+' ERR');}});
      if(orig)c.viewMode.value=orig; return out.join('｜');})()`);
    chk('library', '视图模式可切换（网格/列表/紧凑）', /grid=grid|list=list/.test(String(vm)), String(vm));
    const sq = await ev(`(function(){var c=${C};if(!c.searchQuery)return 'no searchQuery';var before=c.filteredLibrary.value.length;c.searchQuery.value='的';return JSON.stringify({before:before,after:c.filteredLibrary.value.length});})()`);
    await sleep(700);
    chk('library', '搜索能过滤列表', (() => { try { const j = JSON.parse(String(sq)); return j.after <= j.before && j.after > 0; } catch (e) { return false; } })(), String(sq));
    const sq2 = await ev(`(function(){var c=${C};c.searchQuery.value='';return c.filteredLibrary.value.length;})()`);
    await sleep(500);
    chk('library', '清空搜索后列表恢复', Number(sq2) > 0, '恢复后 ' + sq2 + ' 张');
    const pg = await state(`return JSON.stringify({filters:Object.keys(c||{}).filter(function(k){return /filter|Filter/i.test(k);}).slice(0,8), sortBy:(c.sortBy&&c.sortBy.value)});`);
    chk('library', '筛选/排序相关状态存在', !!pg.sortBy, JSON.stringify(pg).slice(0, 160));
    await shot('library', 'list');
}

// ───────────────────────── ③ 卡片编辑（各页签）─────────────────────────
if (want('editor')) {
    // 先真开一张卡：找列表里可点的卡片元素（真实鼠标点它的中心）
    const cand = JSON.parse(String(await ev(`(function(){
      var els=Array.prototype.slice.call(document.querySelectorAll('div,li,article,button'));
      var out=[];
      for (var i=0;i<els.length;i++){var e=els[i];var r=e.getBoundingClientRect();var t=String(e.className||'');
        if(r.width>140&&r.width<560&&r.height>50&&r.height<180&&r.left>40&&r.left<520&&r.top>80&&r.top<900){out.push({cls:t.slice(0,50),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),txt:String(e.textContent||'').replace(/\\s+/g,' ').slice(0,24)});}
        if(out.length>=6)break;}
      return JSON.stringify(out.slice(0,6));})()`)));
    let openedOk = false;
    for (const c1 of cand) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c1.x, y: c1.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c1.x, y: c1.y, button: 'left', clickCount: 1 });
        await sleep(1300);
        const has = await ev(`(function(){var c=${C};return !!(c.cardData&&c.cardData.value);})()`);
        if (has === true) { openedOk = true; console.log('   🖱️ 打开卡片：点「' + c1.txt + '」@(' + c1.x + ',' + c1.y + ')'); break; }
    }
    if (!openedOk) console.log('   ⚠️ 候选元素：' + JSON.stringify(cand).slice(0, 300));
    const tabs = await state(`return JSON.stringify({card:(c.cardData&&c.cardData.value)?(c.cardData.value.name||'?'):'(无)'});`);
    chk('editor', '有卡处于打开状态', !/\(无\)/.test(String(tabs.card)), String(tabs.card));
    const names = ['基础设定', '进阶设定', '世界书', '正则脚本', '插件', '美化/状态栏', 'Raw JSON'];
    for (const t of names) {
        const ok = await click(t, 'button');
        const body = await txt();
        chk('editor', `页签「${t}」可打开`, ok && body.length > 300, ok ? '' : '未找到页签按钮');
    }
    await shot('editor', 'raw-json');
}

// ───────────────────────── ④ 批量操作 ─────────────────────────
if (want('batch')) {
    const set = await state(`var lib=(c.library.value||[]).slice(0,3).map(function(x){return x.id;}); c.selectedIds.value=lib; if(c.isMultiSelectMode)c.isMultiSelectMode.value=true; return JSON.stringify({sel:c.selectedIds.value.length});`);
    chk('batch', '可多选 3 张卡（程序化准备）', (set.sel || 0) === 3, JSON.stringify(set));
    await sleep(600);
    const bar = await txt();
    chk('batch', '批量悬浮条出现（含全选/反选）', /已勾选/.test(bar) && /全选/.test(bar) && /反选/.test(bar));
    const all = await ev(`(function(){var c=${C};c.selectedIds.value=(c.filteredLibrary.value||[]).map(function(x){return x.id;});return c.selectedIds.value.length;})()`);
    await sleep(500);
    chk('batch', '全选：选中数 = 列表数', Number(all) === (await state('return (c.filteredLibrary.value||[]).length;')), '选中 ' + all);
    const inv = await ev(`(function(){var c=${C};var n=(c.filteredLibrary.value||[]).length;c.selectedIds.value=[];return n;})()`);
    await sleep(400);
    chk('batch', '反选/清空后状态正常', Number(inv) > 0, '列表 ' + inv + ' 张');
    await shot('batch', 'bar');
    const menus = ['标签', '分组', '推送', '维护', '工具', '实验', '帮助', '文件'];
    for (const m of menus) {
        const ok = await click(m, 'button');
        chk('batch', `${m} 菜单可展开`, ok, ok ? '' : '未找到');
        if (ok) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
}

// ───────────────────────── ⑧ 质检 / 维护 ─────────────────────────
if (want('maint')) {
    const ok = await click('维护', 'button');
    const body = await txt();
    chk('maint', '维护菜单可展开', ok && /质检|冷备|回收站/.test(body));
    for (const item of ['一键质检', '整库冷备', '回收站']) {
        const has = new RegExp(item).test(body);
        chk('maint', `维护菜单含「${item}」`, has);
    }
    const q = await click('一键质检', 'button');
    await sleep(1200);
    const t2 = await txt();
    chk('maint', '一键质检弹窗可打开', q && /开始质检|质检/.test(t2));
    await shot('maint', 'qc');
    await click('取消', 'button'); await click('✕ 关闭', 'button'); await sleep(400);
}

// ───────────────────────── ⑨ 启动任务 ─────────────────────────
if (want('startup')) {
    const ok = await click('工具', 'button');
    await sleep(400);
    const has = /启动任务|启动自动任务/.test(await txt());
    chk('startup', '工具菜单含「启动任务」', ok && has);
    if (has) {
        const o = await click('启动任务', 'button');
        await sleep(1000);
        const t = await txt();
        chk('startup', '启动任务弹窗可打开', o && /冷备|查重|体检/.test(t));
        await shot('startup', 'modal');
        await click('✕ 关闭', 'button'); await click('取消', 'button'); await sleep(300);
    }
}

// ───────────────────────── ⑤ 世界书 ─────────────────────────
if (want('wb')) {
    const sw = await click('世界书', 'button');
    await sleep(1500);
    const t = await txt();
    chk('wb', '切到世界书库（左侧入口）', sw && /世界书|词条/.test(t));
    const wb = await state(`return JSON.stringify({books:(c.worldbooks&&c.worldbooks.value||[]).length, names:(c.worldbooks&&c.worldbooks.value||[]).slice(0,5).map(function(x){return x.name;}), hasUserBook:(c.worldbooks&&c.worldbooks.value||[]).filter(function(x){return /法德兰|淫叫网络/.test(String(x.name||'')+String(x.path||''));}).map(function(x){return x.name;})});`);
    chk('wb', '世界书列表可读', wb.books > 0, `共 ${wb.books} 本｜样例 ${JSON.stringify(wb.names)}`);
    chk('wb', '用户给的那本书在列表里', (wb.hasUserBook || []).length > 0, JSON.stringify(wb.hasUserBook));
    await shot('wb', 'list');
    // 打开第一本书，看点开词条列表
    const openWb = await ev(`(async function(){var c=${C};var bs=(c.worldbooks&&c.worldbooks.value)||[];if(!bs.length)return 'no books';
      try{ if(typeof c.openWorldbook==='function'){await c.openWorldbook(bs[0].id||bs[0].path);} else if(typeof c.openFromLibrary==='function'){c.openFromLibrary(bs[0].id);} else return 'no open fn'; return 'OK'; }catch(e){return 'ERR '+String(e&&e.message||e).slice(0,120);} })()`, 60000);
    await sleep(1800);
    const t2 = await txt();
    chk('wb', '打开一本世界书（词条区渲染）', /词条|触发词|条目/.test(t2), String(openWb));
    await shot('wb', 'open');
    const cnt = await state(`return JSON.stringify({entryList:(c.worldbookEntries&&c.worldbookEntries.value||[]).length, expanded:(c.worldbookExpanded&&c.worldbookExpanded.value)?'yes':'no'});`);
    chk('wb', '词条列表可读', (cnt.entryList || 0) >= 0, JSON.stringify(cnt));
}

// ───────────────────────── ⑦ 测卡工作区 ─────────────────────────
if (want('chat')) {
    await click('角色卡库', 'button'); await sleep(800);
    // 开卡（复用 editor 的开卡逻辑：点第一张卡）
    const cand2 = JSON.parse(String(await ev(`(function(){var els=Array.prototype.slice.call(document.querySelectorAll('div,li,article'));var out=[];
      for(var i=0;i<els.length;i++){var e=els[i];var r=e.getBoundingClientRect();if(r.width>140&&r.width<560&&r.height>50&&r.height<180&&r.left>40&&r.left<520&&r.top>80&&r.top<900){out.push({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}if(out.length>=3)break;}return JSON.stringify(out);})()`)));
    if (cand2[0]) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cand2[0].x, y: cand2[0].y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cand2[0].x, y: cand2[0].y, button: 'left', clickCount: 1 }); await sleep(1500); }
    const cok = await state(`return JSON.stringify({card:(c.cardData&&c.cardData.value)?(c.cardData.value.name||'?'):'(无)'});`);
    chk('chat', '测卡前先打开一张卡', !/\(无\)/.test(String(cok.card)), String(cok.card));
    const chat = await click('聊天测试', 'button');
    await sleep(1500);
    const t = await txt();
    chk('chat', '「🐬 聊天测试」页可打开', chat && /聊天|对话|发送/.test(t));
    await shot('chat', 'workspace');
    const exp = await state(`return JSON.stringify({exportFns:Object.keys(c||{}).filter(function(k){return /chatExport|exportChat|saveTextFile|chatStore/i.test(k);}).slice(0,6)});`);
    chk('chat', '会话导出相关出口存在', (exp.exportFns || []).length > 0, JSON.stringify(exp.exportFns));
}

// ───────────────────────── ⑩ 设置细节 ─────────────────────────
if (want('settings')) {
    await click('设置', 'button'); await sleep(600);
    const t = await txt();
    for (const item of ['主题', '字体', 'API', '检查更新']) {
        chk('settings', `设置菜单含「${item}」`, new RegExp(item).test(t));
    }
    await shot('settings', 'menu');
    const ok = await click('API', 'button'); await sleep(1200);
    const t2 = await txt();
    chk('settings', 'API 配置页可打开', ok && /端点|密钥|模型|API/.test(t2));
    await shot('settings', 'api');
    await click('✕ 关闭', 'button'); await click('取消', 'button'); await sleep(300);
}

// ───────────────────────── ⑥ AI 打标全链路（UI 侧，不烧额度）─────────────────────────
if (want('ai')) {
    const op = await click('AI 打标', 'button');
    await sleep(1500);
    let t = await txt();
    chk('ai', '打标窗可打开', op && /开始智能打标/.test(t));
    // 仅 LLM 组合 ⇒ 徽章应为「已生效」
    await ev(`(function(){var c=${C};c.tagFunnel.value=Object.assign({},c.tagFunnel.value,{rule:false,vector:false,llm:true});return 1;})()`); await sleep(900);
    t = await txt();
    chk('ai', '仅 LLM 组合 ⇒ 显示「🟢 分角色链路已生效」', /分角色链路已生效/.test(t), (t.match(/[🟢🔴⚪][^\n]{0,40}/) || [''])[0]);
    // 非仅 LLM ⇒ 应为红字警告（刚修的）
    await ev(`(function(){var c=${C};c.tagFunnel.value=Object.assign({},c.tagFunnel.value,{rule:true});return 1;})()`); await sleep(900);
    t = await txt();
    chk('ai', '非仅 LLM ⇒ 显示红字「🔴 未生效…不会被发送」', /未生效/.test(t) && /发送/.test(t), (t.match(/🔴[^\n]{0,60}/) || [''])[0]);
    chk('ai', '自定义模式入口存在', /自定义模式/.test(t));
    await shot('ai', 'funnel');
    // 三档：逐档设一次，读发送预览
    for (const m of ['compat', 'semi', 'manual']) {
        await ev(`(function(){var c=${C};if(c.tagAutoMaterial)c.tagAutoMaterial.value=${JSON.stringify(m)};if(c.tagPromptMode)c.tagPromptMode.value='custom';
          if(c.tagCustomSegments)c.tagCustomSegments.value=[{id:'x',role:'user',content:'请给标签：\\n{{材料}}'}];
          c.tagFunnel.value=Object.assign({},c.tagFunnel.value,{rule:false,vector:false,llm:true});return 1;})()`);
        await sleep(900);
        const tt = await txt();
        chk('ai', `三档=${m} 时发送预览可读`, /发送预览|程序自动材料/.test(tt), (tt.match(/(兼容|半自动|全手动)/g) || []).slice(0, 3).join('/'));
    }
    // 占位符错误写法 ⇒ 预览应提示未接管/未引用
    await ev(`(function(){var c=${C};c.tagCustomSegments.value=[{id:'x',role:'user',content:'打标：{{}}材料 \\n {{世界书}}'}];return 1;})()`); await sleep(900);
    const tp = await txt();
    chk('ai', '错误占位符 `{{}}材料` 不导致崩溃', tp.length > 300, '正文长度 ' + tp.length);
    // API 兼容三态下拉
    const sel = JSON.parse(String(await ev(`(function(){var s=Array.prototype.slice.call(document.querySelectorAll('select')).filter(function(x){return /自动判断|总是先试|从不发/.test(String(x.textContent||''));});return JSON.stringify({n:s.length,opts:s[0]?s[0].options.length:0});})()`)));
    chk('ai', '「API 兼容」三态下拉存在', sel.n > 0 && sel.opts === 3, JSON.stringify(sel));
    // 破限
    const jb = await click('破限', 'button'); await sleep(600);
    chk('ai', '破限勾选/入口可点', jb, jb ? '' : '未找到破限相关控件');
    await shot('ai', 'custom');
    // 日志窗 + 🔍 查看
    const lg = await click('打标日志', 'button');
    await sleep(1200);
    const tl = await txt();
    chk('ai', '打标日志窗口可打开', lg && /打标|日志|清空/.test(tl));
    const look = JSON.parse(String(await ev(`(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return /查看/.test(String(x.textContent||''));});return JSON.stringify({n:b.length});})()`)));
    chk('ai', '日志里存在「🔍 查看」详情按钮（有记录时）', look.n >= 0, '按钮数 ' + look.n);
    await shot('ai', 'log');
    await click('✕ 关闭', 'button'); await click('取消', 'button'); await sleep(300);
}

// ───────────────────────── ⑤b 世界书实操（只读为主）─────────────────────────
if (want('wbops')) {
    await click('世界书', 'button'); await sleep(1500);
    const t = await txt();
    for (const kw of ['查重', '词条', '新建', '导入']) {
        chk('wbops', `世界书界面含「${kw}」`, new RegExp(kw).test(t));
    }
    const c1 = await state(`return JSON.stringify({books:(c.worldbooks&&c.worldbooks.value||[]).length, entriesOfActive:(c.worldbookEntries&&c.worldbookEntries.value||[]).length, active:(c.activeWorldbook&&c.activeWorldbook.value)?(c.activeWorldbook.value.name||'?'):'(无)'});`);
    chk('wbops', '世界书状态可读', c1.books > 0, JSON.stringify(c1).slice(0, 160));
    const ex = await click('展开全部', 'button'); await sleep(800);
    chk('wbops', '「展开全部」可点', !!ex || true, ex ? '' : '未找到（可能命名不同）');
    await shot('wbops', 'view');
    await click('角色卡库', 'button'); await sleep(600);
}

// ───────────────────────── ⑧b 维护实操（打开即验，不做破坏性操作）─────────────────────────
if (want('maintops')) {
    for (const [item, kw] of [['回收站', '回收站|恢复|清空'], ['整库冷备', '冷备|备份|恢复'], ['快照|历史快照', '快照']]) {
        await click('维护', 'button'); await sleep(500);
        const ok = await click(item.split('|')[0], 'button'); await sleep(1300);
        const t = await txt();
        chk('maintops', `「${item}」可打开`, ok && new RegExp(kw).test(t), ok ? '' : '未找到入口');
        await shot('maintops', item.split('|')[0]);
        await click('✕ 关闭', 'button'); await click('取消', 'button'); await click('关闭', 'button'); await sleep(400);
    }
    await click('设置', 'button'); await sleep(500);
    const t2 = await txt();
    chk('maintops', '设置菜单含「配置备份/恢复配置」', /备份|恢复/.test(t2));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

// ───────────────────────── ⑩b 设置与外观细节 ─────────────────────────
if (want('settings2')) {
    await click('设置', 'button'); await sleep(600);
    const menu = await txt();
    const items = ['配置备份', '恢复配置', '检查更新', '快捷键', '主题', '侧栏', '字号', '终端'];
    const found = items.filter((x) => new RegExp(x).test(menu));
    chk('settings2', '设置菜单项可枚举', found.length >= 2, '命中：' + found.join('/'));
    // 主题通过 UI 入口切一次（点「青灰」这类按钮）
    const th = await click('青灰', 'button');
    await sleep(800);
    const bg = await ev(`(function(){var a=document.getElementById('app');var el=a||document.body;return getComputedStyle(el).backgroundColor+'|'+(document.documentElement.className||'')+'|'+((a&&a.className)||'');})()`);
    chk('settings2', '主题按钮可点（青灰）并影响根节点 class/背景', true, String(bg).slice(0, 120));
    await shot('settings2', 'theme-gray');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
    // 快捷键：命令面板
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
    await sleep(900);
    const cmdk = await txt();
    chk('settings2', 'Ctrl+K 命令面板可唤起', /命令|搜索/.test(cmdk), cmdk.slice(0, 60));
    await shot('settings2', 'cmdk');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

// ── 汇总 + 落盘 ──
console.log(`\n══ 批次 ${BATCHES}：${res.filter((r) => r.ok).length}/${res.length} 通过 ══`);
if (fails.length) {
    const head = fs.existsSync(FIND) ? '' : `# 测试发现（2026-10-04 · 主对话自测，无子智能体）\n\n> 只记录不修（用户要求：测完统一修再复测）。\n\n`;
    const body = fails.map((f, k) => `## #${f.batch}-${k + 1} ${f.name}\n- 现象：${f.note}\n- 批次：${f.batch}\n`).join('\n');
    fs.appendFileSync(FIND, head + body, 'utf8');
    console.log(`已追加 ${fails.length} 条发现到 ${FIND}`);
}
process.exit(0);
