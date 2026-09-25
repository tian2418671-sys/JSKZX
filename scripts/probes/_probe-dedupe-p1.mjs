#!/usr/bin/env node
/**
 * _probe-dedupe-p1.mjs —— v4-P1 查重引擎**运行时冒烟**探针（dev 模式 + CDP）
 *
 * 目的：验证四入口在真实应用运行时中可达、不崩、结果结构成型（算法正确性由 710 用例 + 真实库校准覆盖）。
 *
 * 用法（三个终端）：
 *   A: npx vite
 *   B: $env:VITE_DEV_SERVER_URL='http://localhost:5173'; npx electron . --remote-debugging-port=9337 --user-data-dir="$env:TEMP\jsk-dedupe-p1" --disable-gpu --enable-logging
 *   C: node scripts/probes/_probe-dedupe-p1.mjs
 */
const PORT = process.env.CDP_PORT || '9337';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { copyFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { inflateSync } from 'node:zlib';

const CARD_LIB = 'E:\\AI\\酒馆工具\\角色卡';
// ⚠️ PROFILE 必须与 Electron 启动参数 `--user-data-dir` 一致（成功用例要求清理库在 userData 白名单内）
const PROFILE = join(process.env.TEMP || '.', 'jsk-dedupe-p1c');
const CLEAN_DIR = join(PROFILE, 'clean-lib');                 // 白名单内（userData 子目录）
const OUTSIDE_DIR = join(process.env.TEMP || '.', 'jsk-dedupe-outside'); // 白名单外（DF-27 哨兵用例）

const walk = (dir, exts, out = []) => {
    let es = [];
    try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of es) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!/^\./.test(e.name)) walk(p, exts, out); }
        else if (exts.includes(extname(e.name).toLowerCase()) && !/\.tmp$/i.test(e.name)) out.push(p);
    }
    return out;
};

const parsePngCard = (buf) => {
    let off = 8;
    const chunks = {};
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        try {
            if (type === 'tEXt') {
                const nul = data.indexOf(0);
                chunks[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1);
            } else if (type === 'zTXt') {
                const nul = data.indexOf(0);
                chunks[data.toString('latin1', 0, nul)] = inflateSync(data.subarray(nul + 2)).toString('latin1');
            } else if (type === 'iTXt') {
                const nul = data.indexOf(0);
                const kw = data.toString('latin1', 0, nul);
                const compFlag = data[nul + 1];
                let p = data.indexOf(0, nul + 3) + 1;
                p = data.indexOf(0, p) + 1;
                let text = data.subarray(p);
                if (compFlag === 1) text = inflateSync(text);
                chunks[kw] = text.toString('utf8');
            }
        } catch { /* 块级容错 */ }
        off += 12 + len;
        if (type === 'IEND') break;
    }
    const raw = chunks.chara || chunks.ccv3;
    if (!raw) return null;
    try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return null; }
};

class Session {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map();
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
        };
    }
    send(method, params = {}) {
        return new Promise((res, rej) => {
            const id = ++this.id;
            this.pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expr) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).catch((e) => {
                // 「Promise was collected」：页面侧 GC/模态干扰的瞬态错误——重试即可
                if (/Promise was collected/.test(e.message) && attempt < 2) return null;
                throw e;
            });
            if (r === null) { await new Promise((res) => setTimeout(res, 150)); continue; }
            if (r.exceptionDetails) {
                throw new Error('页面异常：' + String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
            }
            return r.result && r.result.value;
        }
        throw new Error('eval 重试仍失败');
    }
}

async function findTarget() {
    for (let i = 0; i < 120; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
            const page = list.find((t) => t.type === 'page' && /5173|index\.html/.test(t.url || '')) || list.find((t) => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* 未就绪 */ }
        await sleep(500);
    }
    throw new Error('CDP 目标未就绪（Electron 是否带 --remote-debugging-port 启动？）');
}

const url = await findTarget();
const ws = new WebSocket(url);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const s = new Session(ws);

let ready = false;
for (let i = 0; i < 180; i++) { ready = await s.eval('!!window.__jskDiag'); if (ready) break; await sleep(500); }
if (!ready) { console.error('✖ window.__jskDiag 未就绪（须 dev 模式：import.meta.env.PROD=false）'); process.exit(1); }
console.log('✓ __jskDiag 就绪');

// 注入冒烟样本（内存态；不落盘）——同一内容 + 同 keys，预期命中 L1
const injected = await s.eval(`(() => {
    const arr = window.__jskDiag.lib();
    const mk = (id, name, pad) => ({
        id, path: 'C:/smoke/' + id + '.png', name,
        data: { description: '她行走于群山之间，记录旅途见闻与星光。'.repeat(pad), character_book: { entries: [{ key: ['冒烟甲', '冒烟乙'], content: '词条正文' }] } },
    });
    const before = arr.length;
    arr.push(mk('smoke_a', '冒烟样本甲', 3));
    arr.push(mk('smoke_b', '冒烟样本乙', 3));
    return arr.length - before;
})()`);
console.log('✓ 已注入冒烟样本:', injected);

const results = {};
let pass = true;
for (const kind of ['card', 'wb', 'preset', 'content']) {
    try {
        await s.eval(`window.__jskDiag.dedupe.run('${kind}')`);
        let st = null;
        for (let i = 0; i < 240; i++) { st = await s.eval('window.__jskDiag.dedupe.state()'); if (st && !st.scanning) break; await sleep(250); }
        const groups = await s.eval(`window.__jskDiag.dedupe.groups('${kind}')`);
        results[kind] = { state: st, groups };
        console.log(`[${kind}] groups=${JSON.stringify(groups)}`);
    } catch (e) {
        console.error(`✖ [${kind}] 入口异常：${e.message}`);
        pass = false;
    }
}

if (!(results.card && results.card.state.card >= 1)) { console.error('✖ card 入口未产出分组'); pass = false; }
const first = results.card && results.card.groups && results.card.groups[0];
if (first && !/参照|触发词|内容|名称/.test(String(first.firstBadge))) {
    console.error('✖ 推荐版徽标异常：', first.firstBadge);
    pass = false;
}
// 空库入口（wb/preset）应平稳收尾（不崩、不产生组）
if (results.wb && results.wb.state.scanning) { console.error('✖ wb 入口未收尾'); pass = false; }

// ── 差异窗口冒烟（P2 三分支，卡片分支实测）──
console.log('\n── 差异窗口 ──');
const diffRows = await s.eval('window.__jskDiag.dedupe.openDiff(0, 1)');
console.log('fieldResults 行数:', diffRows);
if (!(typeof diffRows === 'number' && diffRows >= 4)) {
    console.error('✖ 差异窗口未产出结构行：', diffRows);
    pass = false;
} else {
    console.log('✓ 差异窗口冒烟通过（卡片分支 fieldResults=' + diffRows + ' 行）');
}
await s.eval(`window.__jskDiag.diffClose ? window.__jskDiag.diffClose() : true`);

// ── 清理冒烟（隔离库；v4 §10 验收项） ─────────────────────────
// 做法：复制两张真卡到 TEMP → 注入（同内容副本，保证成组）→ resolve 清理 → 验证文件已入回收站且内存同步
console.log('\n── 清理冒烟（隔离库） ──');
rmSync(CLEAN_DIR, { recursive: true, force: true });
mkdirSync(CLEAN_DIR, { recursive: true });
let srcCard = null;
for (const f of walk(CARD_LIB, ['.png'])) {
    try {
        const st = statSync(f);
        if (st.size > 400 * 1024) continue;
        const buf = readFileSync(f);
        const parsed = parsePngCard(buf);
        if (parsed) { srcCard = { file: f, buf, parsed }; break; }
    } catch { /* 下一张 */ }
}
if (!srcCard) {
    console.error('✖ 未找到可用真卡（隔离库清理冒烟跳过）');
    pass = false;
} else {
    // 用例 A：白名单内（userData 子目录）→ 期望「移入回收站 + 内存同步移除」
    // 用例 B：白名单外（TEMP 根）→ 期望「显式失败 + 文件保留 + 内存保留」（DF-27 幽灵移除哨兵）
    const runCleanupCase = async (dir, names, expectTrashed) => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const pKeep = join(dir, 'keep.png');
        const pTrash = join(dir, 'trash.png');
        copyFileSync(srcCard.file, pKeep);
        copyFileSync(srcCard.file, pTrash);
        const dataLit = JSON.stringify({
            description: '清理冒烟样本内容文本，用于保证两张副本同内容成组。'.repeat(20),
            character_book: { entries: [{ key: ['清理冒烟键一', '清理冒烟键二'], content: '冒烟词条' }] },
        });
        const inj = await s.eval(`(() => {
            const arr = window.__jskDiag.lib();
            const data = ${dataLit};
            arr.push({ id: '${names[0]}_a', path: ${JSON.stringify(pKeep)}, name: ${JSON.stringify(names[0])}, data });
            arr.push({ id: '${names[0]}_b', path: ${JSON.stringify(pTrash)}, name: ${JSON.stringify(names[1])}, data });
            return 'ok';
        })()`);
        if (inj !== 'ok') { console.error('✖ 注入失败：', inj); return false; }
        await s.eval(`window.__jskDiag.dedupe.run('card')`);
        for (let i = 0; i < 240; i++) { const st = await s.eval('window.__jskDiag.dedupe.state()'); if (st && !st.scanning) break; await sleep(250); }
        await s.eval(`window.__jskProbe = { done: false, result: null };
            (async () => {
                try {
                    const kw = ${JSON.stringify(names[0].slice(0, 4))};
                    const idx = window.__jskDiag.dedupe.groups('card').findIndex(g => String(g.name || '').includes(kw));
                    if (idx < 0) { window.__jskProbe.result = 'no-group'; }
                    else await window.__jskDiag.dedupe.resolve(idx, ${JSON.stringify(pKeep)});
                    if (!window.__jskProbe.result) window.__jskProbe.result = 'done';
                } catch (e) { window.__jskProbe.result = 'err:' + e.message; }
                window.__jskProbe.done = true;
            })(); 'started'`);
        let probe = null;
        for (let i = 0; i < 120; i++) { probe = await s.eval('window.__jskProbe'); if (probe && probe.done) break; await sleep(250); }
        const gone = !existsSync(pTrash);
        const kept = existsSync(pKeep) || !gone; // keep 侧不应被清
        const inLib = await s.eval(`window.__jskDiag.lib().some(x => x.path === ${JSON.stringify(pTrash)})`);
        const okDone = probe && probe.result === 'done';
        if (expectTrashed) {
            const trashBin = (() => { try { return readdirSync(join(PROFILE, 'jsTavern_Trash')).length; } catch { return 0; } })();
            const ok = okDone && gone && kept && inLib === false && trashBin > 0;
            console.log(`[清理·白名单内] probe=${JSON.stringify(probe)} trashedGone=${gone} keepExists=${kept} stillInLib=${inLib} trashBin=${trashBin}`);
            if (!ok) { console.error('✖ 白名单内清理未通过'); return false; }
            console.log('✓ 白名单内清理通过（文件入回收站 + 内存同步 + 保留版完好）');
            return true;
        }
        const ok = okDone && !gone && inLib === true;
        console.log(`[清理·白名单外] probe=${JSON.stringify(probe)} fileKept=${!gone} stillInLib=${inLib}`);
        if (!ok) { console.error('✖ 白名单外守卫未通过（幽灵移除回归？）'); return false; }
        console.log('✓ 白名单外守卫通过（显式失败 + 文件保留 + 内存保留）');
        return true;
    };

    if (!(await runCleanupCase(CLEAN_DIR, ['清理冒烟甲', '清理冒烟乙'], true))) pass = false;
    if (!(await runCleanupCase(OUTSIDE_DIR, ['清理冒烟丙', '清理冒烟丁'], false))) pass = false;
    try { rmSync(CLEAN_DIR, { recursive: true, force: true }); rmSync(OUTSIDE_DIR, { recursive: true, force: true }); } catch { /* 收尾 */ }
}

console.log(pass ? '✅ P1 运行时冒烟通过（四入口可达、无异常、结构成型、隔离库清理）' : '❌ P1 运行时冒烟失败');
process.exit(pass ? 0 : 1);
