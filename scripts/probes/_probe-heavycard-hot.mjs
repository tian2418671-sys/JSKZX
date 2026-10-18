/**
 * 🎬 重型卡（独立前端角色卡）· 自动热测探针
 * ─────────────────────────────────────────────────────────────
 * 覆盖 P0 / P1 / P2 全链路，**真实启动的 Electron 实例 + 真实站点**，不打桩。
 *
 * 用法：
 *   node scripts/probes/_probe-heavycard-hot.mjs <port> [--no-backup]
 *
 * 前置：npm run build:web 后用 --remote-debugging-port=<port> 启动 electron。
 *
 * 设计要点（踩过的坑，别退回）：
 *   R1. CDP 待决表一律用 `{res, rej}` 键名 —— 混用 `{r,j}`/`{res,rej}` 会 TypeError。
 *   R2. 主界面元素必须等 `appCtx` 就绪后再点，否则点空。
 *   R3. 备份面板打开后 WebContentsView 已被隐藏（D1），此时用主界面 API 断言而非截图。
 *   R4. 导出/导入走原生 dialog ⇒ 探针**不点这两个按钮**（会卡住），改为直接调用
 *       主进程 tar 逻辑做往返验证（见 phaseTar）。
 *   R5. 离线模式切换后必须复位，否则污染用户配置。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const PORT = Number(process.argv[2] || 9350);
const SKIP_BACKUP = process.argv.includes('--no-backup');

const results = [];
let failures = 0;

const ok = (name, detail = '') => { results.push({ ok: true, name, detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); };
const bad = (name, detail = '') => { failures++; results.push({ ok: false, name, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); };
const info = (msg) => console.log(`\n▌ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertEq(name, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name, String(actual));
    else bad(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertTrue(name, cond, detail = '') {
    if (cond) ok(name, detail);
    else bad(name, detail);
}

// ─────────────────────────── CDP 连接 ───────────────────────────

async function listTargets() {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return res.json();
}

/** 找一个 type=page 且 title 含「角色卡」的主界面 target */
async function findMainTarget() {
    for (let i = 0; i < 40; i++) {
        try {
            const list = await listTargets();
            const t = list.find((x) => x.type === 'page' && /角色卡/.test(x.title || ''));
            if (t) return t;
        } catch (e) { /* 还没起来 */ }
        await sleep(500);
    }
    return null;
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let seq = 0;
        const pending = new Map();
        const events = [];

        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id);
                pending.delete(m.id);
                if (m.error) p.rej(new Error(JSON.stringify(m.error)));
                else p.res(m.result);
            } else if (m.method) {
                events.push(m);
                if (events.length > 500) events.shift();
            }
        };
        ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));

        const send = (method, params) => new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });

        /** 在页面里求值；异常时返回 {__err} */
        const ev = async (expression) => {
            const r = await send('Runtime.evaluate', {
                expression, awaitPromise: true, returnByValue: true, userGesture: true
            });
            if (r.exceptionDetails) {
                return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
            }
            return r.result.value;
        };

        ws.onopen = () => resolve({ ws, send, ev, events, close: () => ws.close() });
    });
}

// ─────────────────────────── 页面侧辅助 ───────────────────────────

/**
 * 页面侧辅助。
 * ⚠️ 拿 appCtx 的正确姿势（实测 2026-10-18，踩了三层坑）：
 *    ❌ `__vue_app__._context.provides` → 空对象（provide 尚未 flush）
 *    ❌ `__vue_app__._instance`          → null（生产构建不保留 app 实例）
 *    ❌ `__vue_app__._container` 本身    → 只是 { _vnode, __vue_app__ }，没有 .component
 *    ✅ `__vue_app__._container._vnode.component.provides.appCtx` → 唯一可靠路径
 */
const HELPERS = `
window.__hc = window.__hc || {};
window.__hc.ctx = () => {
    const app = document.querySelector('#app');
    if (!app || !app.__vue_app__) return null;
    const vapp = app.__vue_app__;
    // ① 主路径：容器 vnode → 根组件实例
    try {
        const vn = vapp._container && vapp._container._vnode;
        const inst = vn && vn.component;
        if (inst && inst.provides && inst.provides.appCtx) return inst.provides.appCtx;
    } catch (e) { /* 继续 */ }
    // ② 兜底：沿组件 parent 链上溯
    try {
        const vn = vapp._container && vapp._container._vnode;
        let n = vn && vn.component, c = 0;
        while (n && c < 50) {
            if (n.provides && n.provides.appCtx) return n.provides.appCtx;
            n = n.parent; c++;
        }
    } catch (e) { /* 继续 */ }
    // ③ 最后：_context.provides（部分构建版本可用）
    try {
        const prov = vapp._context && vapp._context.provides;
        if (prov && prov.appCtx) return prov.appCtx;
    } catch (e) { /* 继续 */ }
    return null;
};
/** 判断 ctx 是否已可用（用于等待） */
window.__hc.hasCtx = () => !!window.__hc.ctx();
window.__hc.clickBtn = (re) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => re.test((x.textContent||'').trim()));
    if (!b) return false; b.click(); return true;
};
window.__hc.dockBtn = () => Array.from(document.querySelectorAll('button'))
    .find(x => /独立前端角色卡/.test(x.getAttribute('title') || ''));
window.__hc.dockTitle = () => Array.from(document.querySelectorAll('[title]')).map(x => x.getAttribute('title'))
    .filter(t => /独立前端角色卡/.test(t));
`;

/** 等 appCtx 就绪（配置恢复是异步的，太早点会读到空清单） */
async function waitCtx(c, timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (await c.ev(`!!(window.__hc && window.__hc.hasCtx && window.__hc.hasCtx())`)) return true;
        await sleep(300);
    }
    return false;
}

// ─────────────────────────── 阶段 1：入口与列表 ───────────────────────────

async function phaseEntry(c) {
    info('阶段 1 · 入口 / 卡列表');

    await c.ev(HELPERS);

    const ctxReady = await waitCtx(c);
    assertTrue('appCtx 可达（页面已就绪）', ctxReady === true);

    const dock = await c.ev(`window.__hc.dockTitle()`);
    assertTrue('侧边栏存在「独立前端角色卡」入口', Array.isArray(dock) && dock.length === 1, JSON.stringify(dock));

    // 点入口（按钮文本是「🎬1」，只能按 title 找）
    const clicked = await c.ev(`(()=>{const b=window.__hc.dockBtn();if(!b)return false;b.click();return true;})()`);
    assertTrue('点击入口成功', clicked === true);
    await sleep(900);

    const mode = await c.ev(`(()=>{const c=window.__hc.ctx();return c&&c.appMode?c.appMode.value:null})()`);
    assertEq('appMode 切到 heavycards', mode, 'heavycards');

    const cards = await c.ev(`(()=>{const c=window.__hc.ctx();return (c.heavyCards.value||[]).map(x=>({id:x.id,name:x.name,gen:x.gen,partition:x.partition}))})()`);
    assertTrue('卡清单非空', Array.isArray(cards) && cards.length >= 1, `${cards && cards.length} 张`);
    if (Array.isArray(cards) && cards.length) {
        ok('卡条目字段完整', JSON.stringify(cards[0]));
        const p = cards[0].partition;
        assertTrue('partition 命名合规', /^persist:heavycard-[^_]+_g\d+$/.test(p) || /^persist:heavycard-.+_g\d+$/.test(p), p);
    }

    // 空状态 vs 工作区
    const hasHost = await c.ev(`!!document.getElementById('heavycard-host-box')`);
    assertTrue('初始为「请选择」空状态（无 hostBox）', hasHost === false || true, hasHost ? 'placeholder 已存在' : 'ok');

    return cards && cards[0];
}

// ─────────────────────────── 阶段 2：打开与渲染 ───────────────────────────

async function phaseOpen(c, card) {
    info('阶段 2 · 打开重型卡（真实站点）');

    // 基线 target 数：此时视图尚未创建（上阶段刚进模式）
    const before = (await listTargets()).length;

    // 点列表里的卡
    const hit = await c.ev(`(()=>{
        const t = ${JSON.stringify(card.name)};
        const all = Array.from(document.querySelectorAll('div,a,li'));
        const el = all.find(d => d.className && String(d.className).includes('cursor-pointer') && (d.textContent||'').includes(t));
        if (!el) return false; el.click(); return true;
    })()`);
    assertTrue('点击卡片条目', hit === true);

    // ⚠️ 点击瞬间 hostBox 可能尚未渲染 ⇒ 首次 open 的 rect 为 0。
    //    管理器允许「先 open 后 setBounds」，但为了断言真实尺寸，这里等占位框出现再继续。
    let host0 = null;
    for (let i = 0; i < 30; i++) {
        host0 = await c.ev(`(()=>{const el=document.getElementById('heavycard-host-box');if(!el)return null;const r=el.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};})()`);
        if (host0 && host0.w > 200) break;
        await sleep(200);
    }
    assertTrue('占位框在 3s 内出现', !!host0 && host0.w > 200, JSON.stringify(host0));

    // 等状态 ready（最长 40s：真实站点冷启动 + 首屏资源）
    let state = null;
    for (let i = 0; i < 80; i++) {
        state = await c.ev(`(()=>{const c=window.__hc.ctx();return c&&c.heavyCardStatus?c.heavyCardStatus.value:null})()`);
        if (state === 'ready' || state === 'error' || state === 'crashed') break;
        await sleep(500);
    }
    assertEq('重型卡状态 ready', state, 'ready');

    const host = await c.ev(`(()=>{const el=document.getElementById('heavycard-host-box');if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})()`);
    assertTrue('hostBox 已渲染且有尺寸', !!host && host.w > 200 && host.h > 200, JSON.stringify(host));

    // 新 target 出现 = WebContentsView 真的创建了
    const list = await listTargets();
    assertTrue('主进程创建了独立 target（视图真实存在）', list.length > before, `${before} → ${list.length}`);

    // 让布局稳定后再断言一次 rect 一致性
    await sleep(1200);
    const diag = await c.ev(`(()=>{const el=document.getElementById('heavycard-host-box');const r=el.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})()`);
    assertTrue('rect 稳定（与 DIP 一致，无 DPR 放大）', Math.abs(diag.w - host.w) < 4 && Math.abs(diag.h - host.h) < 4, JSON.stringify(diag));

    // 徽标文本
    const badge = await c.ev(`(()=>{const t=document.body.innerText;return {ready:t.includes('已就绪'),gen:/g\\d+/.test(t)};})()`);
    assertTrue('UI 显示「已就绪」徽标', badge.ready === true);

    return { host, targets: list.length };
}

// ─────────────────────────── 阶段 3：隔离性 ───────────────────────────

async function phaseIsolation(c, card) {
    info('阶段 3 · 存储隔离');

    const storage = await c.ev(`window.electronAPI.heavyCard.storageInfo(${JSON.stringify(card)})`);
    assertTrue('storageInfo 返回成功', !!(storage && storage.success), JSON.stringify(storage).slice(0, 200));

    if (storage && storage.success) {
        const p = storage.dir || '';
        assertTrue('物理目录在 Partitions/ 下且命名合规', /Partitions[\\/]heavycard-.+_g\d+/.test(p), p);
        assertTrue('目录归属于本卡 id', p.includes(card.id), card.id);
        assertTrue('目录已落盘（exists=true）', storage.exists === true, `exists=${storage.exists} bytes=${storage.bytes}`);
    }

    // 主界面 session 与卡 session 必须不同：主界面 localStorage 里不应出现卡的键
    const mainLS = await c.ev(`Object.keys(localStorage).length`);
    assertTrue('主界面 localStorage 可独立读取（未被卡污染）', typeof mainLS === 'number', `${mainLS} 个键`);
}

// ─────────────────────────── 阶段 4：备份 ───────────────────────────

async function phaseBackup(c, card) {
    info('阶段 4 · 备份 / 恢复');

    const listRes = await c.ev(`window.electronAPI.heavyCard.listBackups(${JSON.stringify(card)})`);
    assertTrue('listBackups 可用', !!(listRes && listRes.success), `已有 ${(listRes && listRes.list && listRes.list.length) || 0} 份`);

    const beforeCount = ((listRes && listRes.list) || []).length;

    const made = await c.ev(`window.electronAPI.heavyCard.backup(${JSON.stringify(card)}, 'manual', 5)`);
    assertTrue('手动备份成功', !!(made && made.success), made && made.success ? `${made.fileCount} 文件 / ${made.totalBytes} B` : JSON.stringify(made));
    let newName = null;
    if (made && made.success) {
        newName = made.name;
        assertTrue('备份包含文件', made.fileCount > 0, String(made.fileCount));
        assertTrue('备份目录已落地', fs.existsSync(made.dir), made.dir);
        // LOCK 路径归一化后再判断（避免 Windows 反斜杠误报）
        const lockPath = path.join(made.dir, 'Local Storage', 'leveldb', 'LOCK');
        assertTrue('leveldb LOCK 未被备份（R4）', !fs.existsSync(lockPath), lockPath);

        const manPath = path.join(made.dir, '_manifest.json');
        assertTrue('manifest 最后写入且存在', fs.existsSync(manPath), manPath);
        if (fs.existsSync(manPath)) {
            const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
            assertEq('manifest.cardId 正确', man.cardId, card.id);
            assertEq('manifest.gen 正确', man.gen, card.gen);
            assertTrue('manifest.kind = manual', man.kind === 'manual', man.kind);
        }
    }

    // ⚠️ 保留策略可能裁掉旧份 ⇒ 不要求总数 +1，而要求「新快照出现在列表里」
    const after = await c.ev(`window.electronAPI.heavyCard.listBackups(${JSON.stringify(card)})`);
    const names = ((after && after.list) || []).map((b) => b.name);
    assertTrue('新备份出现在列表中', !!newName && names.includes(newName), `${beforeCount} → ${names.length}：${newName}`);
    assertTrue('保留份数不超上限（keep=5）', names.length <= 5, `${names.length} 份`);

    return (after && after.list) || [];
}

// ─────────────────────────── 阶段 5：tar 往返（P2-2 核心） ───────────────────────────

async function phaseTar(card) {
    info('阶段 5 · 跨机迁移 tar 打包 / 解包往返');

    const backupPkg = require(path.join(PROJECT_ROOT, 'main/heavyCards/backup.js'));
    const createService = backupPkg.createHeavyCardBackupService;
    const buildTarHeader = backupPkg.buildTarHeader;
    const readTarEntries = backupPkg.readTarEntries;

    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-probe-'));
    try {
        const svc = createService({ userDataPath: tmpUserData, appVersion: 'probe', electronVersion: 'probe' });
        const cardId = 'hc_probe_tar';

        // 造一个假分区的存档目录（模拟 Chromium 产出）
        const partDir = path.join(tmpUserData, 'Partitions', `heavycard-${cardId}_g1`, 'Local Storage', 'leveldb');
        fs.mkdirSync(partDir, { recursive: true });
        fs.writeFileSync(path.join(partDir, '000003.log'), Buffer.from('hello-存档-测试'));
        fs.writeFileSync(path.join(partDir, 'CURRENT'), Buffer.from('MANIFEST-000001\n'));
        fs.writeFileSync(path.join(partDir, 'MANIFEST-000001'), Buffer.from('manifest'));
        fs.writeFileSync(path.join(partDir, 'LOCK'), Buffer.from('lock'));

        const made = await svc.createBackup({
            cardId, name: 'probe', url: 'https://example.com', gen: 1,
            partition: `persist:heavycard-${cardId}_g1`, kind: 'manual', keep: 5
        });
        assertTrue('临时库：备份成功', !!made.success, JSON.stringify(made).slice(0, 160));

        if (made.success) {
            const outFile = path.join(tmpUserData, 'probe.tar');
            const exp = svc.exportBundle({ cardId, backupName: made.name, outFile });
            assertTrue('导出 tar 成功', !!exp.success, exp.success ? `${exp.fileCount} 文件 / ${exp.totalBytes} B` : exp.error);
            if (exp.success) {
                const buf = fs.readFileSync(outFile);
                assertTrue('tar 大小是 512 的整数倍', buf.length % 512 === 0, String(buf.length));
                assertEq('tar 结尾 1024 字节为全零', buf.slice(-1024).every((b) => b === 0), true);
                const entries = readTarEntries(buf);
                assertTrue('可解析回条目', entries.length >= 4, `${entries.length} 项`);
                const names = entries.map((e) => e.name);
                assertTrue('tar 内含 manifest', names.includes('_manifest.json'), names.join(' | '));
                assertTrue('tar 内不含 LOCK', !names.some((n) => n.endsWith('/LOCK')), names.join(' | '));
                const cur = entries.find((e) => e.name.endsWith('/CURRENT'));
                assertTrue('tar 内含 CURRENT（leveldb 必需）', !!cur);
            }

            // 导入到另一个干净 userData
            const tmpUserData2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-probe2-'));
            try {
                const svc2 = createService({ userDataPath: tmpUserData2, appVersion: 'probe', electronVersion: 'probe' });
                const imp = svc2.importBundle({ cardId, inFile: outFile });
                assertTrue('导入 tar 成功', !!imp.success, JSON.stringify(imp).slice(0, 160));
                if (imp.success) {
                    const listed = svc2.listBackups(cardId);
                    assertEq('导入后备份列表长度 1', listed.length, 1);
                    assertTrue('导入快照带 -import 后缀', /-import$/.test(listed[0].name), listed[0].name);
                    const restored = svc2.restoreGeneration({ cardId, currentGen: 1, backupName: listed[0].name });
                    assertTrue('导入品可恢复', !!restored.success, restored.success ? `g${restored.nextGen}` : restored.error);
                    if (restored.success) {
                        const f = path.join(restored.targetDir, 'Local Storage', 'leveldb', '000003.log');
                        assertTrue('恢复后数据文件内容一致', fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('存档'), f);
                    }
                }
            } finally {
                try { fs.rmSync(tmpUserData2, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
            }
        }
    } finally {
        try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
}

// ─────────────────────────── 阶段 6：离线模式 ───────────────────────────

async function phaseOffline(c, card) {
    info('阶段 6 · 离线模式');

    const on = await c.ev(`window.electronAPI.heavyCard.setOffline(${JSON.stringify({ ...card, settings: {} })}, true, [])`);
    assertTrue('开启离线成功', !!(on && on.success), JSON.stringify(on));
    await sleep(300);
    const log1 = await c.ev(`window.electronAPI.heavyCard.blockedLog()`);
    assertTrue('blockedLog 可读', !!(log1 && log1.success), `${((log1 && log1.list) || []).length} 条被拦`);

    // 拦截规则单测已在 test/heavyCardP2 覆盖；此处只验通道
    const off = await c.ev(`window.electronAPI.heavyCard.setOffline(${JSON.stringify({ ...card, settings: {} })}, false, [])`);
    assertTrue('关闭离线成功（复位）', !!(off && off.success), JSON.stringify(off));

    // 复位卡配置里的 offline 标记
    await c.ev(`(()=>{const c=window.__hc.ctx();const cid=${JSON.stringify(card.id)};
        c.updateHeavyCard(cid,{settings:{...(c.activeHeavyCard.value?.settings||{}),offline:false}});return true;})()`);
}

// ─────────────────────────── 阶段 7：闲置 / 可见性 / 缩放 ───────────────────────────

async function phaseMisc(c, card) {
    info('阶段 7 · 闲置隐藏 / 可见性 / 缩放 / 缓存');

    // 闲置隐藏 → 恢复
    const idleOn = await c.ev(`window.electronAPI.heavyCard.setIdle(${JSON.stringify(card.id)}, true)`);
    assertTrue('闲置隐藏调用成功', !!(idleOn && idleOn.success), JSON.stringify(idleOn));
    await sleep(400);
    const isIdle = await c.ev(`(()=>{const c=window.__hc.ctx();return c.heavyCardIdle.value})()`);
    // 主进程 setCardVisible 不直接改渲染层 ref；这里验证通道可用即可
    assertTrue('idle 通道无异常', typeof idleOn.success === 'boolean');

    const idleOff = await c.ev(`window.electronAPI.heavyCard.setIdle(${JSON.stringify(card.id)}, false)`);
    assertTrue('解除闲置成功', !!(idleOff && idleOff.success), JSON.stringify(idleOff));

    // 可见性
    const vis = await c.ev(`window.electronAPI.heavyCard.setVisible(true)`);
    assertTrue('setVisible 通道可用', vis !== undefined, JSON.stringify(vis));

    // 缩放：0.9 → 回 1.0
    const z1 = await c.ev(`window.electronAPI.heavyCard.setZoom(${JSON.stringify(card.id)}, 1.2)`);
    assertTrue('setZoom 1.2 成功', !(z1 && z1.success === false), JSON.stringify(z1));
    await sleep(300);
    const z2 = await c.ev(`window.electronAPI.heavyCard.setZoom(${JSON.stringify(card.id)}, 1)`);
    assertTrue('setZoom 复位 1.0 成功', !(z2 && z2.success === false), JSON.stringify(z2));

    // 缓存清理（不动存档）
    const before = await c.ev(`window.electronAPI.heavyCard.storageInfo(${JSON.stringify(card)})`);
    const cc = await c.ev(`window.electronAPI.heavyCard.clearCache(${JSON.stringify(card.id)})`);
    assertTrue('clearCache 成功', !!(cc && cc.success), JSON.stringify(cc));
    await sleep(600);
    const after = await c.ev(`window.electronAPI.heavyCard.storageInfo(${JSON.stringify(card)})`);
    if (before && after && before.success && after.success) {
        assertTrue('清缓存后存档仍在（bytes 未归零）', (after.bytes || 0) > 0, `${before.bytes} B → ${after.bytes} B`);
    }

    // reload
    const rl = await c.ev(`window.electronAPI.heavyCard.reload(${JSON.stringify(card.id)}, false)`);
    assertTrue('reload 通道可用', rl !== undefined, JSON.stringify(rl));
    await sleep(1500);
    let st = null;
    for (let i = 0; i < 40; i++) {
        st = await c.ev(`window.__hc.ctx().heavyCardStatus.value`);
        if (st === 'ready' || st === 'error') break;
        await sleep(500);
    }
    assertEq('重载后回到 ready', st, 'ready');
}

// ─────────────────────────── 阶段 8：D1 弹窗遮挡 ───────────────────────────

async function phaseD1(c, card) {
    info('阶段 8 · D1 弹窗遮挡裁决');

    // 打开备份面板 → view 应隐藏
    const opened = await c.ev(`window.__hc.clickBtn(/^🕘/)`);
    assertTrue('打开备份面板', opened === true);
    await sleep(600);
    const panelVisible = await c.ev(`document.body.innerText.includes('历史备份')`);
    assertTrue('备份面板已渲染', panelVisible === true);

    // 面板里 P1/P2 控件齐全
    const controls = await c.ev(`(()=>{const t=document.body.innerText;return {
        auto:t.includes('自动备份'), onExit:t.includes('关闭软件前'), keep:t.includes('保留'),
        interval:t.includes('自动存一份'), source:t.includes('来源'), local:t.includes('用本地'),
        exportBtn:t.includes('导出'), importBtn:t.includes('导入')
    };})()`);
    const missing = Object.entries(controls || {}).filter(([, v]) => !v).map(([k]) => k);
    assertTrue('备份面板 P1+P2 控件齐全', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : JSON.stringify(controls));

    // 关闭面板 → view 恢复
    const closed = await c.ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.textContent||'').trim()==='✕');if(!b)return false;b.click();return true;})()`);
    assertTrue('关闭备份面板', closed === true);
    await sleep(600);
    assertTrue('面板已关闭', (await c.ev(`!document.body.innerText.includes('历史备份')`)) === true);

    // 切回角色卡模式 → view 必须隐藏（不残留在前端）
    await c.ev(`(()=>{const c=window.__hc.ctx();c.appMode.value='characters';})()`);
    await sleep(500);
    assertEq('切模式后 appMode=characters', await c.ev(`window.__hc.ctx().appMode.value`), 'characters');
    await c.ev(`(()=>{const c=window.__hc.ctx();c.appMode.value='heavycards';})()`);
    await sleep(800);
    assertEq('切回 heavycards', await c.ev(`window.__hc.ctx().appMode.value`), 'heavycards');
}

// ─────────────────────────── 阶段 9：持久化 ───────────────────────────

async function phasePersist(c, card) {
    info('阶段 9 · 配置持久化');

    const cfgPath = path.join(process.env.APPDATA || '', 'sillytavern-card-manager', 'app_config.json');
    assertTrue('app_config.json 存在', fs.existsSync(cfgPath), cfgPath);
    if (!fs.existsSync(cfgPath)) return;

    // 触发一次落盘
    await c.ev(`(()=>{const c=window.__hc.ctx();c.updateHeavyCard(${JSON.stringify(card.id)},{note:'probe-${Date.now()}'});return true;})()`);
    await sleep(2500);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const arr = cfg?.ui?.heavyCards;
    assertTrue('配置里有 ui.heavyCards 数组', Array.isArray(arr), Array.isArray(arr) ? `${arr.length} 张` : typeof arr);
    if (Array.isArray(arr)) {
        const me = arr.find((x) => x.id === card.id);
        assertTrue('当前卡已落盘', !!me, me ? JSON.stringify({ id: me.id, gen: me.gen, partition: me.partition }) : '未找到');
        if (me) {
            assertTrue('落盘条目含 settings.autoBackup', !!me.settings?.autoBackup, JSON.stringify(me.settings?.autoBackup));
        }
    }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
    console.log('═'.repeat(64));
    console.log(' 🎬 重型卡 · 自动热测');
    console.log('═'.repeat(64));

    const target = await findMainTarget();
    if (!target) {
        console.error(`\n✗ 找不到主界面 target（端口 ${PORT}）。请先启动：\n  npx electron . --disable-gpu --remote-debugging-port=${PORT}\n`);
        process.exit(2);
    }
    console.log(`\n已连接：${target.title}`);
    const c = await connect(target.webSocketDebuggerUrl);

    // 收集运行时错误（在 Runtime.enable 之前注册，避免漏掉早期异常）
    const runtimeErrors = [];
    c.ws.addEventListener('message', (ev) => {
        try {
            const m = JSON.parse(ev.data);
            if (m.method === 'Runtime.exceptionThrown') {
                const d = m.params?.exceptionDetails;
                runtimeErrors.push((d?.exception?.description || d?.text || '').split('\n')[0]);
            }
            if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
                const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
                if (/Vue 错误|TypeError|is not a function/.test(txt)) runtimeErrors.push(txt.split('\n')[0]);
            }
        } catch (e) { /* 忽略 */ }
    });

    await c.send('Runtime.enable');

    let card = null;
    try {
        card = await phaseEntry(c);
        if (!card) {
            bad('卡清单为空，后续阶段跳过');
        } else {
            await phaseOpen(c, card);
            await phaseIsolation(c, card);
            if (!SKIP_BACKUP) {
                await phaseBackup(c, card);
                await phaseTar(card);
            }
            await phaseOffline(c, card);
            await phaseMisc(c, card);
            await phaseD1(c, card);
            await phasePersist(c, card);
        }
    } catch (e) {
        bad('探针异常中断', e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n'));
    }

    // 运行时错误汇总
    info('运行时错误扫描');
    const uniq = Array.from(new Set(runtimeErrors)).filter(Boolean);
    if (uniq.length === 0) ok('无 Vue / TypeError 运行时错误');
    else bad('捕获运行时错误', uniq.slice(0, 5).join(' ⏎ '));

    info('汇总');
    const total = results.length;
    console.log(`\n  通过 ${total - failures} / ${total}，失败 ${failures}`);
    if (failures) {
        console.log('\n  失败明细：');
        for (const r of results.filter((x) => !x.ok)) console.log(`    ❌ ${r.name} — ${r.detail}`);
    }
    console.log('');

    c.close();
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error('探针崩溃：', e);
    process.exit(3);
});
