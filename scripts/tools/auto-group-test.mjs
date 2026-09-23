/**
 * 🗂️ 自动分组 端到端实测（CDP + 隔离库：真实物理移动 + 回滚）
 * ═════════════════════════════════════════════════════════════════
 * 覆盖方案 §六 专项验收的机器可执行部分：
 *   1  分组档案从 app_config.json 恢复 + saveProfiles 归一化落盘
 *   2  预览与执行一致性（预览说移 3 张 → 执行后恰好 3 张；跳过项不执行）
 *   4  失败隔离（本库不制造失败；失败清单结构在单测覆盖）
 *   5  回滚：卡片回原分组（走同一移动原语）
 *   6  安全默认：已手动分组的卡一张不动
 *   8  回滚变动检测：预先删除一张已移动卡 → 单独列出「已不存在」，不中断整批
 *   9  空分组（目标）自动重建：人外文件夹在预览阶段不存在 → 执行时自动创建
 *   12 边界：非法正则只跳过该条，不拖垮整表（扫描仍然可用）
 *   13 清理空分组（DF-16）：空文件夹 + 配置空组 → 删除；有卡分组不动；磁盘无卡片损失
 *   14 🤖 LLM 分辨（本地 mock 服务）：判定标准进提示词 / 只喂未命中卡 / 建议默认不勾 /
 *      重扫后缓存并回（0 新请求）/ 建议真实移动 + 回滚
 *
 * 用法（dev 实例如隔离 profile + 独立调试端口）：
 *   ① node scripts/tools/auto-group-test.mjs --prep      # 建隔离库（含中文分组文件夹）+ 写隔离 profile 配置
 *   ② 起实例：
 *      npm run build:web 可省（dev 走 vite）；启动 vite --port 5177；再
 *      $env:VITE_DEV_SERVER_URL='http://localhost:5177'
 *      npx electron . --disable-gpu --remote-debugging-port=9359 --user-data-dir="%TEMP%\jsk-ag-profile"
 *   ③ node scripts/tools/auto-group-test.mjs             # 本脚本自等实例就绪后驱动验收
 *   ④ node scripts/tools/auto-group-test.mjs --cleanup   # 删隔离库/profile
 *
 * 环境变量：AG_LIB（默认 I:\03\_ag-test）· AG_PROFILE（默认 %TEMP%\jsk-ag-profile）· CDP_PORT（默认 9359）
 *
 * ⚠️ 只在**隔离库**上做物理移动；绝不指向真实库（脚本末尾有断言防呆）。
 * ⚠️ 重跑前先强杀同 profile 残留实例（`Stop-Process -Force`）——旧实例关闭时 beforeunload 冲刷
 *    可能把旧配置回写到 `--prep` 之后（实测踩过，脚本开头有「环境校验」拦截）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const MODE = process.argv.includes('--prep') ? 'prep' : process.argv.includes('--cleanup') ? 'cleanup' : 'run';
const LIB = process.env.AG_LIB || 'I:\\03\\_ag-test';
const PROFILE = process.env.AG_PROFILE || path.join(os.tmpdir(), 'jsk-ag-profile');
const PORT = Number(process.env.CDP_PORT || 9359);
const CDP_LIST = `http://127.0.0.1:${PORT}/json/list`;

const PURE = '测试纯爱卡';
const HYPNO = '测试催眠卡';
const YOUKAI = '测试猫妖卡';
const OTHER = '无所属卡';
const GROUPED = '已在催眠的卡';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🤖 LLM 分辨步骤：本地 mock 服务（OpenAI 兼容 /chat/completions）
const MOCK_PORT = 9358;
let mockCalls = 0;
let mockLastBody = '';
let mockReplyContent = '';
function startMockServer() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                mockCalls++;
                mockLastBody = body;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: mockReplyContent || JSON.stringify({ assignments: [] }) } }]
                }));
            });
        });
        srv.listen(MOCK_PORT, '127.0.0.1', () => resolve(srv));
    });
}

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function card(name, tags) {
    return {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name, description: '自动分组 e2e 隔离测试卡（可整体删除）', tags, extensions: {} }
    };
}

// ==================== prep / cleanup ====================

function prep() {
    if (!/^[a-zA-Z]:\\/.test(LIB)) { console.error('AG_LIB 必须是绝对路径'); process.exit(2); }
    fs.rmSync(LIB, { recursive: true, force: true });
    fs.mkdirSync(path.join(LIB, '催眠'), { recursive: true });
    fs.mkdirSync(path.join(LIB, '纯爱'), { recursive: true });
    fs.mkdirSync(path.join(LIB, '空组A'), { recursive: true }); // DF-16：0 卡片的空文件夹（等步骤 9 清理）
    // 库根：3 张可移动 + 1 张不命中
    writeJson(path.join(LIB, `${PURE}.json`), card(PURE, ['纯爱']));
    writeJson(path.join(LIB, `${HYPNO}.json`), card(HYPNO, ['催眠']));
    writeJson(path.join(LIB, `${YOUKAI}.json`), card(YOUKAI, ['猫妖相关']));
    writeJson(path.join(LIB, `${OTHER}.json`), card(OTHER, ['无关标签']));
    // 已在「催眠」分组里的卡（命中「纯爱」规则 → 安全默认必须跳过）
    writeJson(path.join(LIB, '催眠', `${GROUPED}.json`), card(GROUPED, ['纯爱']));

    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.mkdirSync(PROFILE, { recursive: true });
    writeJson(path.join(PROFILE, 'tavern_manager_config.json'), { lastFolder: LIB });
    // 预置：自动打标/忽略标签开关都关（避免扫描期规则引擎干扰试验）；预置 2 条档案（验证恢复路径）
    writeJson(path.join(PROFILE, 'app_config.json'), {
        ui: { autoTagOnImport: false, sanitizeImportedTags: false, theme: 'dark' },
        customCategories: ['空组B'], // DF-16：0 卡片的配置分组（无文件夹，等步骤 9 清理）
        // 🤖 LLM 分辨步骤（步骤 10）：端点指向脚本内的本地 mock 服务
        api: { endpoint: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, key: '', model: 'mock-model', type: 'openai' },
        autoGroupProfiles: [
            { id: 'e2e_pure', group: '纯爱', enabled: true, match: { type: 'tag', pattern: '纯爱' } },
            { id: 'e2e_hypno', group: '催眠', enabled: true, match: { type: 'tag', pattern: '催眠' } }
        ]
    });
    console.log('prep ok');
    console.log('  lib     = ' + LIB);
    console.log('  profile = ' + PROFILE);
}

function cleanup() {
    fs.rmSync(LIB, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    console.log('cleanup ok');
}

// ==================== CDP harness ====================

let sock; let msgId = 0;
const pending = new Map();
const consoleErrors = [];

async function getWs() {
    const list = await (await fetch(CDP_LIST)).json();
    const page = list.find((t) => t.type === 'page' && /^(app:\/\/|http:\/\/localhost:5177)/.test(t.url || ''));
    if (!page) throw new Error('未找到 app:// 或 localhost:5177 target；可见: ' + list.map((t) => t.url).join(' | '));
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
                return;
            }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                consoleErrors.push((m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ').slice(0, 300));
            } else if (m.method === 'Runtime.exceptionThrown') {
                const d = m.params.exceptionDetails;
                consoleErrors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 300));
            }
        };
    });
}
async function connectWithRetry() {
    const t0 = Date.now();
    for (;;) {
        try { await connect(await getWs()); return; } catch (e) {
            if (Date.now() - t0 > 150000) throw e;
            await sleep(1000);
        }
    }
}
function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params })); });
}
async function run(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result && r.result.value;
}
async function waitFor(fn, timeoutMs, label) {
    const t0 = Date.now();
    for (;;) {
        try { if (await fn()) return; } catch (e) { /* 重试 */ }
        if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
        await sleep(500);
    }
}

let timeOrigin0 = null;
/** 页面内 JSON.stringify 后再取回：Vue 响应式代理经 CDP returnByValue 会序列化成 {}（实测踩过） */
async function json(expr) { return JSON.parse(await run(`JSON.stringify(${expr})`)); }
/** HMR 防呆：运行中页面被重载 → 断言语义作废，立即报错（而不是误报功能问题） */
async function ensureNoReload(label) {
    const t = await run(`String(performance.timeOrigin)`);
    if (timeOrigin0 === null) timeOrigin0 = t;
    else if (t !== timeOrigin0) throw new Error('页面在运行中被重载（HMR/刷新）→ 环境不稳，结果作废：' + label);
}

// ==================== 断言 ====================

const problems = [];
function check(name, cond, extra = '') {
    if (cond) console.log('  ✅ ' + name + (extra ? '  (' + extra + ')' : ''));
    else { console.log('  ❌ ' + name + (extra ? '  (' + extra + ')' : '')); problems.push(name + (extra ? ' — ' + extra : '')); }
}

async function main() {
    if (!/^[a-zA-Z]:\\/.test(LIB) || /角色色卡/.test(LIB)) throw new Error('防呆：不允许多物理库路径运行（AG_LIB=' + LIB + '）');
    await connectWithRetry();
    await send('Runtime.enable');
    await waitFor(() => run(`typeof window.__jskDiag === 'object' && !!window.__jskDiag.autoGroup`), 120000, 'diag 就绪');
    await waitFor(async () => (await run(`window.__jskDiag.lib().length`)) >= 5, 90000, '库加载（≥5 张）');

    // ⚠️ contextBridge 暴露的 electronAPI 是**冻结对象**，在页面里劫持 showMessage 无效（实测踩过）。
    //    因此执行/回滚统一走 dev 诊断钩子的 skipConfirm 参数（见 App.vue__jskDiag.autoGroup）；产品路径不受影响。

    await ensureNoReload('连接后');
    // 🧪 环境校验（防呆）：应用启动时必须加载到预置配置（含 空组B）——
    //    实测踩过：kill 终端后旧实例关闭前 beforeunload 冲刷写盘，可能把旧配置回写到 prep 之后 → 本套结果作废
    const cats0 = await run(`window.__jskDiag.cats()`);
    check('环境校验：预置分组已加载（含 空组B）', Array.isArray(cats0) && cats0.includes('空组B'), JSON.stringify(cats0));
    console.log('== 1) 分组档案恢复（app_config.json 预置 2 条）==');
    const p0 = await json(`window.__jskDiag.autoGroup.state().profiles.map(p => p.group)`);
    check('恢复 2 条档案', Array.isArray(p0) && p0.length === 2 && p0[0] === '纯爱' && p0[1] === '催眠', p0.join('、'));

    console.log('== 2) 保存规则（归一化 + 落盘）==');
    const SAVE3 = `[
        {id:'e2e_pure',group:'纯爱',enabled:true,match:{type:'tag',pattern:'纯爱'}},
        {id:'e2e_hypno',group:'催眠',enabled:true,match:{type:'tag',pattern:'催眠'}},
        {id:'e2e_youkai',group:'人外',enabled:true,match:{type:'name-keyword',pattern:'猫妖'}}
    ]`;
    const saved = await run(`(() => { window.__jskDiag.autoGroup.saveProfiles(${SAVE3}); return window.__jskDiag.autoGroup.state().profiles.length; })()`);
    check('保存后 3 条档案', saved === 3, 'profiles=' + saved);
    await sleep(800); // 等 500ms 防抖落盘
    // 容错重试：主进程原子写在极端拦截（EPERM）下可能超过单次检查窗口 → 最多再等 6s
    let cfgLen = -1;
    for (let i = 0; i < 12; i++) {
        try {
            const c = JSON.parse(fs.readFileSync(path.join(PROFILE, 'app_config.json'), 'utf8'));
            cfgLen = Array.isArray(c.autoGroupProfiles) ? c.autoGroupProfiles.length : -1;
            if (cfgLen === 3) break;
        } catch (e) { /* 半写/未写 → 重试 */ }
        await sleep(500);
    }
    check('已落盘 app_config.json（autoGroupProfiles=3）', cfgLen === 3, 'len=' + cfgLen);

    console.log('== 3) 预览（只读）==');
    const s1 = await json(`window.__jskDiag.autoGroup.scan(false)`);
    check('willMove = 3', !!(s1 && s1.counters && s1.counters.willMove === 3), JSON.stringify(s1 && s1.counters));
    const names = (s1.moves || []).map((m) => m.cardName).sort().join(',');
    check('移动集合正确', names === [HYPNO, PURE, YOUKAI].sort().join(','), names);
    const gs = (s1.skipped || []).find((x) => x.cardName === GROUPED);
    check('安全默认：已手动分组的卡被跳过', !!gs && /已手动分组/.test(gs.reason), gs && gs.reason);
    const tgt = (s1.targets || []).find((t) => t.name === '人外');
    check('人外 标记「将新建文件夹」', !!tgt && tgt.isNew === true);
    check('预览未动文件：人外/ 不存在', !fs.existsSync(path.join(LIB, '人外')));
    check('预览未动文件：纯爱卡仍在库根', fs.existsSync(path.join(LIB, `${PURE}.json`)));

    console.log('== 4) 边界：非法正则只跳过该条 ==');
    const sBad = await run(`(() => {
        window.__jskDiag.autoGroup.saveProfiles(${SAVE3.slice(0, -1)}, {id:'e2e_bad',group:'人外',enabled:true,match:{type:'name-regex',pattern:'([未闭合'}}]);
        const s = window.__jskDiag.autoGroup.scan(false);
        return s ? s.counters.willMove : -1;
    })()`);
    check('非法正则不影响整表（仍 3 张可移）', sBad === 3, 'willMove=' + sBad);
    await run(`(() => { window.__jskDiag.autoGroup.saveProfiles(${SAVE3}); return true; })()`); // 回到干净三条供执行
    const s2 = await json(`window.__jskDiag.autoGroup.scan(false)`);
    check('重扫仍 3 张（含人外）', s2.counters.willMove === 3);

    console.log('== 5) 执行（真实物理移动）==');
    await ensureNoReload('执行前');
    await run(`window.__jskDiag.autoGroup.execute(null)`);
    await waitFor(async () => (await run(`window.__jskDiag.autoGroup.state().exec.running`)) === false, 60000, '执行完成');
    const exec = await json(`window.__jskDiag.autoGroup.state().exec`);
    check('exec：moved=3 / failed=0', exec.moved === 3 && exec.failed === 0, JSON.stringify(exec));
    const lastRun = await json(`window.__jskDiag.autoGroup.state().lastRun`);
    check('日志记录 3 条', !!(lastRun && lastRun.entries && lastRun.entries.length === 3), 'entries=' + (lastRun && lastRun.entries ? lastRun.entries.length : 'null'));
    check('FS：纯爱卡进入 纯爱/', fs.existsSync(path.join(LIB, '纯爱', `${PURE}.json`)));
    check('FS：催眠卡进入 催眠/', fs.existsSync(path.join(LIB, '催眠', `${HYPNO}.json`)));
    check('FS：人外/ 自动创建且放入猫妖卡', fs.existsSync(path.join(LIB, '人外', `${YOUKAI}.json`)));
    check('FS：库根不再有纯爱卡', !fs.existsSync(path.join(LIB, `${PURE}.json`)));
    const libAfter = await run(`window.__jskDiag.lib().filter(c => ['${PURE}','${HYPNO}','${YOUKAI}'].includes(c.name)).map(c => ({ name: c.name, cat: c.category, sub: c.subFolder }))`);
    const catOf = (n) => (libAfter.find((c) => c.name === n) || {});
    check('内存：纯爱卡 category=纯爱', catOf(PURE).cat === '纯爱' && catOf(PURE).sub === '纯爱', JSON.stringify(catOf(PURE)));
    check('内存：猫妖卡 category=人外', catOf(YOUKAI).cat === '人外' && catOf(YOUKAI).sub === '人外', JSON.stringify(catOf(YOUKAI)));
    check('未命中卡仍在库根（未动）', fs.existsSync(path.join(LIB, `${OTHER}.json`)));
    check('已分组卡仍在 催眠/（未动）', fs.existsSync(path.join(LIB, '催眠', `${GROUPED}.json`)));

    console.log('== 6) 制造变动：删除一张已移动卡 ==');
    fs.unlinkSync(path.join(LIB, '催眠', `${HYPNO}.json`));
    await run(`window.__jskDiag.refresh()`);
    await waitFor(async () => (await run(`window.__jskDiag.lib().length`)) === 4, 30000, '重扫到 4 张');
    await ensureNoReload('刷新后');

    console.log('== 7) 回滚（逆序 + 变动检测）==');
    await run(`window.__jskDiag.autoGroup.rollback()`);
    await waitFor(async () => (await run(`window.__jskDiag.autoGroup.state().rollback.running`)) === false, 60000, '回滚完成');
    const rb = await json(`window.__jskDiag.autoGroup.state().rollback`);
    const lr2 = await json(`window.__jskDiag.autoGroup.state().lastRun`);
    check('rolled=2（已还原）', rb.rolled === 2, JSON.stringify({ rolled: rb.rolled, failed: rb.failed }));
    check('变动检测：1 张「已不存在」单独列出', rb.failed.length === 1 && /已不存在/.test(rb.failed[0].reason), JSON.stringify(rb.failed));
    check('全部解决 → 日志清空', lr2 === null);
    check('FS：纯爱卡回库根', fs.existsSync(path.join(LIB, `${PURE}.json`)));
    check('FS：猫妖卡回库根', fs.existsSync(path.join(LIB, `${YOUKAI}.json`)));
    check('FS：纯爱/ 已无纯爱卡', !fs.existsSync(path.join(LIB, '纯爱', `${PURE}.json`)));

    console.log('== 9) 清理空分组（DF-16，隔离库）==');
    // 此时：纯爱/(空) 人外/(空) 均为 0 卡片分组；配置内「空组B」也是 0 卡片；催眠/ 有卡绝不能动；
    // 空组A 是「不属于任何分组的孤儿空目录」→ 不在清理范围（保留）
    check('清理前：空文件夹存在（纯爱/人外）', ['纯爱', '人外'].every((g) => fs.existsSync(path.join(LIB, g))));
    await ensureNoReload('清理前');
    const cleanupRes = await run(`window.__jskDiag.autoGroup.cleanupGroups()`);
    const removed = (cleanupRes && cleanupRes.removedCustom) || [];
    check('自定义空组全部命中（含配置项 空组B）', ['纯爱', '人外', '空组B'].every((g) => removed.includes(g)), removed.join('、'));
    check('有卡分组不受影响（催眠 未清理）', !removed.includes('催眠'));
    check('分组空文件夹已物理删除', ['纯爱', '人外'].every((g) => !fs.existsSync(path.join(LIB, g))));
    check('孤儿空目录不在清理范围（空组A 保留）', fs.existsSync(path.join(LIB, '空组A')));
    check('非空分组保留：催眠/ 有卡的分组卡仍在', fs.existsSync(path.join(LIB, '催眠', `${GROUPED}.json`)));
    check('无卡片损失（库根 3 张都在）', [PURE, YOUKAI, OTHER].every((n) => fs.existsSync(path.join(LIB, `${n}.json`))));
    // 配置落盘：清理末尾显式冲刷 + 主进程原子写；容错重试（历史有过瞬时 rename 拦截）——最多等 6s
    let cfgPersisted = false;
    for (let i = 0; i < 12 && !cfgPersisted; i++) {
        await sleep(500);
        try {
            const c = JSON.parse(fs.readFileSync(path.join(PROFILE, 'app_config.json'), 'utf8'));
            cfgPersisted = !JSON.stringify(c).includes('空组B');
        } catch (e) { /* 半写/未写 → 重试 */ }
    }
    check('配置落盘：空组B 已移除', cfgPersisted);
    await run(`window.__jskDiag.refresh()`);
    await waitFor(async () => (await run(`window.__jskDiag.lib().length`)) === 4, 30000, '清理后重扫到 4 张');
    await ensureNoReload('清理后');
    check('清理后重扫正常（4 张）', (await run(`window.__jskDiag.lib().length`)) === 4);

    console.log('== 10) 🤖 LLM 分辨（本地 mock 服务）==');
    await startMockServer();
    // 1 条带「判定标准」的规则（匹配内容故意不可能命中 → 卡进入 LLM 候选）
    await run(`(() => { window.__jskDiag.autoGroup.saveProfiles([
        {id:'e2e_llm',group:'纯爱',enabled:true,match:{type:'tag',pattern:'zzz_never_match'},llmCriteria:'以恋爱推进为核心的卡'}
    ]); return true; })()`);
    mockCalls = 0;
    mockReplyContent = JSON.stringify({ assignments: [{ card: OTHER, group: '纯爱', confidence: 0.83, reason: '恋爱氛围' }] });
    const llmRes1 = await run(`window.__jskDiag.autoGroup.llm()`);
    check('LLM：1 次请求 / 建议 1 张 / 无异常', !!llmRes1 && llmRes1.requested === 1 && llmRes1.suggested === 1 && llmRes1.errors.length === 0, JSON.stringify(llmRes1));
    check('LLM：mock 收到 1 次调用', mockCalls === 1, 'calls=' + mockCalls);
    check('LLM：请求体含判定标准与卡信息（名称/简介）', /以恋爱推进为核心/.test(mockLastBody) && mockLastBody.includes(OTHER) && mockLastBody.includes('简介：'), mockLastBody.slice(0, 100));
    // 缓存：重扫（全新计划）后建议从缓存自动并回，且不产生新请求
    mockCalls = 0;
    const s10 = await json(`window.__jskDiag.autoGroup.scan(false)`);
    const llmMove = (s10.moves || []).find((m) => m.cardName === OTHER);
    check('LLM：建议进入计划（source=llm / 置信度 0.83 / 目标 纯爱）', !!llmMove && llmMove.source === 'llm' && llmMove.confidence === 0.83 && llmMove.to === '纯爱', JSON.stringify(llmMove));
    check('LLM：重扫后缓存并回 + 0 新请求', mockCalls === 0 && !!llmMove && llmMove.source === 'llm', 'calls=' + mockCalls);
    check('LLM：其余卡未被误移（willMove=1）', s10.counters.willMove === 1, JSON.stringify(s10.counters));
    // UI：🤖 建议默认不勾选（打开弹窗查 DOM）
    await run(`window.__jskDiag.autoGroup.open()`);
    await sleep(400);
    const chkState = await run(`(() => {
        const rows = [...document.querySelectorAll('table tbody tr')];
        const row = rows.find(tr => tr.textContent.includes(${JSON.stringify(OTHER)}));
        if (!row) return 'no-row';
        const cb = row.querySelector('input[type=checkbox]');
        return cb ? String(cb.checked) : 'no-cb';
    })()`);
    check('UI：🤖 建议默认不勾选', chkState === 'false', 'checked=' + chkState);
    await run(`window.__jskDiag.autoGroup.close()`);
    // 执行 + 回滚（显式 ids，走真实物理移动原语）
    const otherId = await run(`window.__jskDiag.lib().find(c => c.name === ${JSON.stringify(OTHER)}).id`);
    await run(`window.__jskDiag.autoGroup.execute([${JSON.stringify(otherId)}])`);
    check('LLM：真实物理移动成功（进入 纯爱/）', fs.existsSync(path.join(LIB, '纯爱', `${OTHER}.json`)));
    await run(`window.__jskDiag.autoGroup.rollback()`);
    check('LLM：回滚还原（回到库根）', fs.existsSync(path.join(LIB, `${OTHER}.json`)) && !fs.existsSync(path.join(LIB, '纯爱', `${OTHER}.json`)));

    console.log('== 8) 渲染层无报错 ==');
    const bad = consoleErrors.filter((e) => /\[Vue 错误\]|ReferenceError|TypeError|Cannot read|is not a function/.test(e));
    check('无 Vue / 运行时错误', bad.length === 0, bad.slice(0, 3).join(' | '));

    console.log('\n──────────────');
    console.log(problems.length ? `❌ ${problems.length} 项未通过：\n  ` + problems.join('\n  ') : '✅ 全部通过');
    process.exit(problems.length ? 1 : 0);
}

if (MODE === 'prep') { prep(); }
else if (MODE === 'cleanup') { cleanup(); }
else { main().catch((e) => { console.error('❌ 运行失败：', e.message); process.exit(1); }); }
